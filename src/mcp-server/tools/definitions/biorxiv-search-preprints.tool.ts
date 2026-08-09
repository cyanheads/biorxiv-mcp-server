/**
 * @fileoverview biorxiv_search_preprints tool — keyword search for preprints
 * using EuropePMC for relevance ranking, then enriching matching DOIs with
 * full bioRxiv/medRxiv metadata from the details endpoint. When server is
 * explicit ("biorxiv" or "medrxiv"), enrichment routes to that server directly.
 * When server="both", the 10.1101/ prefix is used as a routing hint but is not
 * treated as definitive — both bioRxiv and medRxiv share this prefix.
 *
 * Enrichment carries every latest-revision field biorxiv_get_preprint exposes,
 * so the same DOI does not describe less through search than through lookup.
 * Every enrichment failure degrades to EuropePMC-only metadata rather than
 * failing the search, including an origin rate limit (HTTP 429) — which gets
 * its own enrichment_error value so a caller can tell a wait-and-retry from a
 * generic upstream error without parsing prose.
 * @module mcp-server/tools/definitions/biorxiv-search-preprints.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';
import { getEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import type { EuropePmcSearchResult } from '@/services/europe-pmc/types.js';
import { findRateLimit, isValidCalendarDate } from '@/services/shared.js';

const BIORXIV_DOI_PREFIXES = ['10.1101/', '10.64898/'];

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

type EnrichmentError = 'service_error' | 'not_found' | 'rate_limited';

type EnrichedPreprint = {
  doi: string;
  title?: string | undefined;
  authors?: string | undefined;
  authorCorresponding?: string | undefined;
  authorCorrespondingInstitution?: string | undefined;
  date?: string | undefined;
  version?: string | undefined;
  type?: string | undefined;
  license?: string | undefined;
  category?: string | undefined;
  server?: string | undefined;
  jatsxmlUrl?: string | undefined;
  funder?: string | undefined;
  publishedJournalDoi?: string | undefined;
  abstract?: string | undefined;
  enriched: boolean;
  enrichment_error?: EnrichmentError | undefined;
  revisionCount?: number | undefined;
};

const ENRICHMENT_ERROR_NOTES: Record<EnrichmentError, string> = {
  service_error: 'bioRxiv enrichment failed (service error — retry may help).',
  rate_limited:
    'bioRxiv enrichment was rate-limited by api.biorxiv.org (HTTP 429) — wait and retry to enrich this record.',
  not_found: 'DOI not indexed on target server — EuropePMC metadata shown.',
};

function formatResult(p: EnrichedPreprint): string {
  const lines: string[] = [];

  lines.push(`### ${p.title ?? p.doi}`);
  lines.push(`**DOI:** ${p.doi}`);

  if (p.enriched) {
    if (p.server) lines.push(`**Server:** ${p.server}`);
    if (p.type) lines.push(`**Type:** ${p.type}`);
    if (p.category) lines.push(`**Category:** ${p.category}`);
    if (p.license) lines.push(`**License:** ${p.license}`);
    if (p.date) lines.push(`**Date:** ${p.date}`);
    if (p.version) lines.push(`**Version:** ${p.version}`);
    if (p.authors) lines.push(`**Authors:** ${p.authors}`);
    if (p.authorCorresponding) lines.push(`**Corresponding:** ${p.authorCorresponding}`);
    if (p.authorCorrespondingInstitution)
      lines.push(`**Institution:** ${p.authorCorrespondingInstitution}`);
    if (p.funder) lines.push(`**Funder:** ${p.funder}`);
    if (p.publishedJournalDoi) lines.push(`**Published DOI:** ${p.publishedJournalDoi}`);
    if (p.jatsxmlUrl) lines.push(`**JATS XML:** ${p.jatsxmlUrl}`);
    if (p.abstract) lines.push(`\n**Abstract:** ${p.abstract}`);
    if (p.revisionCount !== undefined && p.revisionCount > 1)
      lines.push(`\n*${p.revisionCount} revisions — latest shown.*`);
  } else {
    // EuropePMC-only fallback when bioRxiv enrichment failed
    if (p.authors) lines.push(`**Authors:** ${p.authors}`);
    if (p.date) lines.push(`**Date:** ${p.date}`);
    if (p.abstract) lines.push(`\n**Abstract:** ${p.abstract}`);
    lines.push(`\n*${ENRICHMENT_ERROR_NOTES[p.enrichment_error ?? 'not_found']}*`);
  }

  return lines.join('\n');
}

export const biorxivSearchPreprintsTool = tool('biorxiv_search_preprints', {
  title: 'Search Preprints by Keyword',
  description:
    'Search preprints by keyword and/or author using EuropePMC for relevance ranking, then enrich matching DOIs with full bioRxiv/medRxiv metadata. Provide a keyword query, an author name, or both — author maps to an EuropePMC AUTH: field query and is ANDed with the keyword query. Covers both servers by default. EuropePMC indexes new preprints within 1–2 days of posting; for preprints posted within the last day, prefer biorxiv_list_recent.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z
    .object({
      query: z
        .string()
        .optional()
        .describe(
          'Keyword search query. Optional when author is provided — supply at least one of query or author.',
        ),
      author: z
        .string()
        .optional()
        .describe(
          'Author name to filter by, mapped to an EuropePMC AUTH:"…" field query and ANDed with the keyword query. Optional when query is provided (e.g. "Jennifer Doudna").',
        ),
      server: z
        .enum(['biorxiv', 'medrxiv', 'both'])
        .default('both')
        .describe('Server scope for enrichment. "both" checks all matching DOIs on both servers.'),
      date_from: z
        .string()
        .optional()
        .describe('Earliest first-publication date filter (YYYY-MM-DD).'),
      date_to: z.string().optional().describe('Latest first-publication date filter (YYYY-MM-DD).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe('Maximum results to return (1–100). Defaults to 25.'),
      cursor_mark: z
        .string()
        .optional()
        .describe(
          'Opaque page token for ranked EuropePMC results. Omit for the first page; pass the nextCursorMark returned by a prior call to fetch the next page. Pages through the same ranked list rather than raising limit.',
        ),
    })
    .refine((v) => Boolean(v.query?.trim()) || Boolean(v.author?.trim()), {
      message: 'Provide at least one of query or author (with non-whitespace content).',
    }),

  output: z.object({
    preprints: z
      .array(
        z
          .object({
            doi: z.string().describe('Preprint DOI.'),
            title: z.string().optional().describe('Preprint title.'),
            authors: z.string().optional().describe('Author list.'),
            authorCorresponding: z.string().optional().describe('Corresponding author.'),
            authorCorrespondingInstitution: z
              .string()
              .optional()
              .describe('Corresponding author institution.'),
            date: z.string().optional().describe('Posting or revision date.'),
            version: z.string().optional().describe('Latest revision version.'),
            type: z.string().optional().describe('Preprint type.'),
            license: z.string().optional().describe('License identifier.'),
            category: z.string().optional().describe('Subject category.'),
            server: z.string().optional().describe('Source server (biorxiv or medrxiv).'),
            jatsxmlUrl: z.string().optional().describe('URL to the JATS XML full-text.'),
            funder: z.string().optional().describe('Funder information.'),
            publishedJournalDoi: z
              .string()
              .optional()
              .describe('Published journal DOI when accepted.'),
            abstract: z.string().optional().describe('Abstract text.'),
            enriched: z
              .boolean()
              .describe(
                'True when full bioRxiv metadata was available; false for EuropePMC-only fallback.',
              ),
            enrichment_error: z
              .enum(['service_error', 'not_found', 'rate_limited'])
              .optional()
              .describe(
                'Reason enrichment was unavailable: "service_error" (transient — retry may help), "rate_limited" (api.biorxiv.org returned HTTP 429 — wait before retrying, and expect the other preprint metadata tools to be limited too), or "not_found" (DOI not indexed on target server — EuropePMC fallback is authoritative). Only present when enriched is false.',
              ),
            revisionCount: z
              .number()
              .optional()
              .describe('Total revision count when enriched from bioRxiv.'),
          })
          .describe('A single search result.'),
      )
      .describe('Search results, ranked by EuropePMC relevance.'),
    partial_results: z
      .boolean()
      .describe(
        'True when one or more DOIs failed bioRxiv enrichment and fell back to EuropePMC metadata.',
      ),
  }),

  // Agent-facing context on the success path — the upstream grand total, the echo
  // of the query parameters as sent, and recovery guidance for zero results.
  // Populated via ctx.enrich so it reaches both structuredContent and content[];
  // never rides in the domain return.
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total preprints matching the query in EuropePMC (hitCount) — the true upstream grand total, not the number of results returned.',
      ),
    nextCursorMark: z
      .string()
      .optional()
      .describe(
        'Opaque token for the next page of ranked results. Present only when more results exist beyond this page; pass it back as cursor_mark. Absent on the last page.',
      ),
    queryEcho: z
      .object({
        query: z.string().optional().describe('The keyword query sent to EuropePMC, if any.'),
        author: z
          .string()
          .optional()
          .describe('The author filter applied as an AUTH: clause, if any.'),
        server: z.string().describe('Server scope used for enrichment.'),
        date_from: z.string().optional().describe('date_from filter applied, if any.'),
        date_to: z.string().optional().describe('date_to filter applied, if any.'),
        cursor_mark: z.string().optional().describe('cursor_mark page token applied, if any.'),
        limit: z.number().describe('Maximum results requested.'),
      })
      .describe(
        'Echo of the parameters used to produce this result set — lets callers verify what was sent.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when zero results are returned — echoes query and suggests how to broaden.',
      ),
  },

  // content[] trailer rendering for structured enrichment fields. Scalar/notice kinds
  // (totalCount, notice) render automatically. queryEcho is a structured object that
  // needs a render function to produce a single compact line.
  enrichmentTrailer: {
    queryEcho: {
      render: (echo: {
        query?: string;
        author?: string;
        server: string;
        date_from?: string;
        limit: number;
        date_to?: string;
        cursor_mark?: string;
      }) => {
        const parts = [
          ...(echo.query ? [`Query: ${echo.query}`] : []),
          ...(echo.author ? [`author=${echo.author}`] : []),
          `server=${echo.server}`,
          ...(echo.date_from ? [`from=${echo.date_from}`] : []),
          ...(echo.date_to ? [`to=${echo.date_to}`] : []),
          ...(echo.cursor_mark ? [`cursor=${echo.cursor_mark}`] : []),
          `limit=${echo.limit}`,
        ];
        return parts.join(' · ');
      },
    },
  },

  errors: [
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date_from or date_to is malformed, or date_from is after date_to.',
      recovery: 'Provide valid YYYY-MM-DD dates where date_from is on or before date_to.',
    },
    {
      reason: 'search_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'EuropePMC search endpoint is unreachable or returns a server error.',
      recovery:
        'EuropePMC may be temporarily unavailable. Retry after a short delay or use biorxiv_list_recent with a date range instead.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_search_preprints', {
      query: input.query,
      author: input.author,
      server: input.server,
      limit: input.limit,
    });

    // Validate date inputs before calling EuropePMC: shape first, then
    // real-calendar-date (rejects overflow days like 2024-02-30 that the shape
    // regex accepts but no calendar holds), then range.
    if (input.date_from && !DATE_REGEX.test(input.date_from)) {
      throw ctx.fail('invalid_date_range', 'date_from must be in YYYY-MM-DD format.', {
        date_from: input.date_from,
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    if (input.date_from && !isValidCalendarDate(input.date_from)) {
      throw ctx.fail('invalid_date_range', 'date_from is not a real calendar date (YYYY-MM-DD).', {
        date_from: input.date_from,
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    if (input.date_to && !DATE_REGEX.test(input.date_to)) {
      throw ctx.fail('invalid_date_range', 'date_to must be in YYYY-MM-DD format.', {
        date_to: input.date_to,
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    if (input.date_to && !isValidCalendarDate(input.date_to)) {
      throw ctx.fail('invalid_date_range', 'date_to is not a real calendar date (YYYY-MM-DD).', {
        date_to: input.date_to,
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    if (input.date_from && input.date_to && input.date_from > input.date_to) {
      throw ctx.fail(
        'invalid_date_range',
        `date_from (${input.date_from}) must be on or before date_to (${input.date_to}).`,
        {
          date_from: input.date_from,
          date_to: input.date_to,
          ...ctx.recoveryFor('invalid_date_range'),
        },
      );
    }

    const epmc = getEuropePmcService();
    const biorxiv = getBiorxivApiService();

    // Step 1: EuropePMC relevance search
    let epmcSearchResult: EuropePmcSearchResult;
    try {
      epmcSearchResult = await epmc.search(
        {
          query: input.query,
          author: input.author,
          dateFrom: input.date_from,
          dateTo: input.date_to,
          limit: input.limit,
          server: input.server,
          cursorMark: input.cursor_mark,
        },
        ctx,
      );
    } catch (err) {
      throw ctx.fail(
        'search_unavailable',
        `EuropePMC search failed: ${err instanceof Error ? err.message : String(err)}`,
        { ...ctx.recoveryFor('search_unavailable') },
        { cause: err instanceof Error ? err : new Error(String(err)) },
      );
    }

    const { hitCount, results: epmcResults, nextCursorMark } = epmcSearchResult;

    const queryEcho = {
      ...(input.query && { query: input.query }),
      ...(input.author && { author: input.author }),
      server: input.server,
      ...(input.date_from && { date_from: input.date_from }),
      ...(input.date_to && { date_to: input.date_to }),
      ...(input.cursor_mark && { cursor_mark: input.cursor_mark }),
      limit: input.limit,
    };

    if (epmcResults.length === 0) {
      ctx.enrich.total(hitCount);
      ctx.enrich({ queryEcho, ...(nextCursorMark && { nextCursorMark }) });
      const criteria =
        [
          ...(input.query ? [`"${input.query}"`] : []),
          ...(input.author ? [`author "${input.author}"`] : []),
        ].join(' and ') || 'the given criteria';
      ctx.enrich.notice(
        `No preprints matched ${criteria}${input.date_from || input.date_to ? ` in the specified date range` : ''}. Try broader search terms${input.author ? ', a different author spelling,' : ''} or a wider date range.`,
      );
      return {
        preprints: [],
        partial_results: false,
      };
    }

    // Step 2: Enrich each DOI via bioRxiv API in parallel
    let hasPartial = false;

    const enriched = await Promise.all(
      epmcResults.map(async (epResult): Promise<EnrichedPreprint> => {
        const doi = epResult.doi;
        const isBiorxivDoi = BIORXIV_DOI_PREFIXES.some((p) => doi.startsWith(p));

        // Determine which server(s) to enrich against
        let revisions: PreprintRevision[] = [];
        // Every rejection from whichever enrichment path ran. A DOI that came back
        // empty from one server while the other never answered is not "not indexed"
        // — that is an absence neither server established.
        const rejections: unknown[] = [];

        try {
          if (input.server === 'biorxiv') {
            revisions = await biorxiv.getDetails(doi, 'biorxiv', ctx);
          } else if (input.server === 'medrxiv') {
            // DOI prefix is not a reliable discriminator — both servers share 10.1101/.
            revisions = await biorxiv.getDetails(doi, 'medrxiv', ctx);
          } else {
            // server='both': use DOI prefix as a hint to avoid a redundant call,
            // but fall back to trying both when the prefix is ambiguous.
            if (isBiorxivDoi) {
              revisions = await biorxiv.getDetails(doi, 'biorxiv', ctx);
              // If bioRxiv returned nothing, this DOI may actually live on medRxiv.
              if (revisions.length === 0) {
                revisions = await biorxiv.getDetails(doi, 'medrxiv', ctx);
              }
            } else {
              const [bxR, mxR] = await Promise.allSettled([
                biorxiv.getDetails(doi, 'biorxiv', ctx),
                biorxiv.getDetails(doi, 'medrxiv', ctx),
              ]);
              if (bxR.status === 'fulfilled') revisions.push(...bxR.value);
              else rejections.push(bxR.reason);
              if (mxR.status === 'fulfilled') revisions.push(...mxR.value);
              else rejections.push(mxR.reason);
            }
          }
        } catch (err) {
          rejections.push(err);
        }

        const latest = revisions.at(-1);
        if (!latest) {
          hasPartial = true;
          // A rate limit still degrades to EuropePMC metadata like every other
          // enrichment failure — it is only labelled apart, so the caller knows a
          // wait (not a different query) is what makes the retry succeed.
          const enrichmentError: EnrichmentError =
            rejections.length === 0
              ? 'not_found'
              : findRateLimit(rejections)
                ? 'rate_limited'
                : 'service_error';
          return {
            doi,
            ...(epResult.title && { title: epResult.title }),
            ...(epResult.authors && { authors: epResult.authors }),
            ...(epResult.publishedDate && { date: epResult.publishedDate }),
            ...(epResult.abstract && { abstract: epResult.abstract }),
            enriched: false,
            enrichment_error: enrichmentError,
          };
        }
        return {
          doi,
          ...(latest.title && { title: latest.title }),
          ...(latest.authors && { authors: latest.authors }),
          ...(latest.authorCorresponding && { authorCorresponding: latest.authorCorresponding }),
          ...(latest.authorCorrespondingInstitution && {
            authorCorrespondingInstitution: latest.authorCorrespondingInstitution,
          }),
          ...(latest.date && { date: latest.date }),
          ...(latest.version && { version: latest.version }),
          ...(latest.type && { type: latest.type }),
          ...(latest.license && { license: latest.license }),
          ...(latest.category && { category: latest.category }),
          ...(latest.server && { server: latest.server }),
          ...(latest.jatsxmlUrl && { jatsxmlUrl: latest.jatsxmlUrl }),
          ...(latest.funder && { funder: latest.funder }),
          ...(latest.publishedJournalDoi && { publishedJournalDoi: latest.publishedJournalDoi }),
          ...(latest.abstract && { abstract: latest.abstract }),
          enriched: true,
          revisionCount: revisions.length,
        };
      }),
    );

    ctx.enrich.total(hitCount);
    ctx.enrich({ queryEcho, ...(nextCursorMark && { nextCursorMark }) });

    return {
      preprints: enriched,
      partial_results: hasPartial,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`**${result.preprints.length} results**`);
    if (result.partial_results) {
      lines.push(
        '> Some results show EuropePMC metadata only — see enrichment_error per result for details.',
      );
    }

    for (const p of result.preprints) {
      lines.push('');
      lines.push(formatResult(p));
      lines.push(
        `*Enriched: ${p.enriched ? 'yes' : 'no (EuropePMC fallback)'}${p.enrichment_error ? ` · enrichment_error: ${p.enrichment_error}` : ''}*`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') || 'No results.' }];
  },
});
