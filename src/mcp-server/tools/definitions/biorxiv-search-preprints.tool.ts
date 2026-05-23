/**
 * @fileoverview biorxiv_search_preprints tool — keyword search for preprints
 * using EuropePMC for relevance ranking, then enriching matching DOIs with
 * full bioRxiv/medRxiv metadata from the details endpoint. The 10.1101/ prefix
 * identifies bioRxiv DOIs; DOIs without that prefix may be medRxiv or other
 * preprint sources and are enriched via both servers when server="both".
 * @module mcp-server/tools/definitions/biorxiv-search-preprints.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';
import { getEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import type { EuropePmcResult } from '@/services/europe-pmc/types.js';

const BIORXIV_DOI_PREFIXES = ['10.1101/', '10.64898/'];

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function formatResult(
  doi: string,
  revisions: PreprintRevision[],
  epmc?: { title?: string; authors?: string; publishedDate?: string; abstract?: string },
): string {
  const latest = revisions[revisions.length - 1];
  const lines: string[] = [];

  // Use bioRxiv metadata when available; fall back to EuropePMC
  const title = latest?.title ?? epmc?.title ?? doi;
  lines.push(`### ${title}`);
  lines.push(`**DOI:** ${doi}`);

  if (latest) {
    if (latest.server) lines.push(`**Server:** ${latest.server}`);
    if (latest.category) lines.push(`**Category:** ${latest.category}`);
    if (latest.date) lines.push(`**Date:** ${latest.date}`);
    if (latest.version) lines.push(`**Version:** ${latest.version}`);
    if (latest.authors) lines.push(`**Authors:** ${latest.authors}`);
    if (latest.authorCorresponding) lines.push(`**Corresponding:** ${latest.authorCorresponding}`);
    if (latest.publishedJournalDoi) lines.push(`**Published DOI:** ${latest.publishedJournalDoi}`);
    if (latest.jatsxmlUrl) lines.push(`**JATS XML:** ${latest.jatsxmlUrl}`);
    if (latest.abstract) lines.push(`\n**Abstract:** ${latest.abstract}`);
    if (revisions.length > 1) lines.push(`\n*${revisions.length} revisions — latest shown.*`);
  } else if (epmc) {
    // EuropePMC-only fallback when bioRxiv enrichment failed
    if (epmc.authors) lines.push(`**Authors:** ${epmc.authors}`);
    if (epmc.publishedDate) lines.push(`**Date:** ${epmc.publishedDate}`);
    if (epmc.abstract) lines.push(`\n**Abstract:** ${epmc.abstract}`);
    lines.push(`\n*Metadata from EuropePMC only — bioRxiv enrichment unavailable.*`);
  }

  return lines.join('\n');
}

export const biorxivSearchPreprintsTool = tool('biorxiv_search_preprints', {
  title: 'Search Preprints by Keyword',
  description:
    "Search preprints by keyword using EuropePMC for relevance ranking, then enrich matching DOIs with full bioRxiv/medRxiv metadata. Covers both servers by default. EuropePMC indexes new preprints within 1–2 days of posting; for preprints posted within the last day, prefer biorxiv_list_recent. The search backend is EuropePMC — bioRxiv's native search endpoint is not used.",
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z.string().min(1).describe('Keyword search query.'),
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
            date: z.string().optional().describe('Posting or revision date.'),
            version: z.string().optional().describe('Latest revision version.'),
            category: z.string().optional().describe('Subject category.'),
            server: z.string().optional().describe('Source server (biorxiv or medrxiv).'),
            jatsxmlUrl: z.string().optional().describe('URL to the JATS XML full-text.'),
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
            revisionCount: z
              .number()
              .optional()
              .describe('Total revision count when enriched from bioRxiv.'),
          })
          .describe('A single search result.'),
      )
      .describe('Search results, ranked by EuropePMC relevance.'),
    total_from_search: z
      .number()
      .describe('Number of DOIs returned by EuropePMC before enrichment filtering.'),
    partial_results: z
      .boolean()
      .describe(
        'True when one or more DOIs failed bioRxiv enrichment and fell back to EuropePMC metadata.',
      ),
    message: z.string().optional().describe('Recovery hint when zero results are returned.'),
  }),

  errors: [
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
      server: input.server,
      limit: input.limit,
    });

    // Validate date inputs before calling EuropePMC
    if (input.date_from && !DATE_REGEX.test(input.date_from)) {
      throw validationError('date_from must be in YYYY-MM-DD format.', {
        date_from: input.date_from,
      });
    }
    if (input.date_to && !DATE_REGEX.test(input.date_to)) {
      throw validationError('date_to must be in YYYY-MM-DD format.', { date_to: input.date_to });
    }
    if (input.date_from && input.date_to && input.date_from > input.date_to) {
      throw validationError(
        `date_from (${input.date_from}) must be on or before date_to (${input.date_to}).`,
        { date_from: input.date_from, date_to: input.date_to },
      );
    }

    const epmc = getEuropePmcService();
    const biorxiv = getBiorxivApiService();

    // Step 1: EuropePMC relevance search
    let epmcResults: EuropePmcResult[];
    try {
      epmcResults = await epmc.search(
        {
          query: input.query,
          dateFrom: input.date_from,
          dateTo: input.date_to,
          limit: input.limit,
          server: input.server,
        },
        ctx,
      );
    } catch (err) {
      throw serviceUnavailable(
        `EuropePMC search failed: ${err instanceof Error ? err.message : String(err)}`,
        { reason: 'search_unavailable', ...ctx.recoveryFor('search_unavailable') },
        { cause: err },
      );
    }

    if (epmcResults.length === 0) {
      return {
        preprints: [],
        total_from_search: 0,
        partial_results: false,
        message: `No preprints matched "${input.query}"${input.date_from || input.date_to ? ` in the specified date range` : ''}. Try broader search terms or a wider date range.`,
      };
    }

    const totalFromSearch = epmcResults.length;

    // Step 2: Enrich each DOI via bioRxiv API in parallel
    type EnrichedPreprint = {
      doi: string;
      title?: string;
      authors?: string;
      authorCorresponding?: string;
      date?: string;
      version?: string;
      category?: string;
      server?: string;
      jatsxmlUrl?: string;
      publishedJournalDoi?: string;
      abstract?: string;
      enriched: boolean;
      revisionCount?: number;
    };

    let hasPartial = false;

    const enriched = await Promise.all(
      epmcResults.map(async (epResult): Promise<EnrichedPreprint> => {
        const doi = epResult.doi;
        const isBiorxivDoi = BIORXIV_DOI_PREFIXES.some((p) => doi.startsWith(p));

        // Determine which server(s) to enrich against
        let revisions: PreprintRevision[] = [];
        let enrichmentFailed = false;

        try {
          if (input.server === 'biorxiv' || isBiorxivDoi) {
            revisions = await biorxiv.getDetails(doi, 'biorxiv', ctx);
          } else if (input.server === 'medrxiv') {
            revisions = await biorxiv.getDetails(doi, 'medrxiv', ctx);
          } else {
            // both: try biorxiv first (identified by prefix), then medrxiv
            if (isBiorxivDoi) {
              revisions = await biorxiv.getDetails(doi, 'biorxiv', ctx);
            } else {
              const [bxR, mxR] = await Promise.allSettled([
                biorxiv.getDetails(doi, 'biorxiv', ctx),
                biorxiv.getDetails(doi, 'medrxiv', ctx),
              ]);
              if (bxR.status === 'fulfilled') revisions.push(...bxR.value);
              if (mxR.status === 'fulfilled') revisions.push(...mxR.value);
            }
          }
        } catch {
          enrichmentFailed = true;
        }

        if (enrichmentFailed || revisions.length === 0) {
          hasPartial = true;
          return {
            doi,
            ...(epResult.title && { title: epResult.title }),
            ...(epResult.authors && { authors: epResult.authors }),
            ...(epResult.publishedDate && { date: epResult.publishedDate }),
            ...(epResult.abstract && { abstract: epResult.abstract }),
            enriched: false,
          };
        }

        const latest = revisions[revisions.length - 1]!;
        return {
          doi,
          ...(latest.title && { title: latest.title }),
          ...(latest.authors && { authors: latest.authors }),
          ...(latest.authorCorresponding && { authorCorresponding: latest.authorCorresponding }),
          ...(latest.date && { date: latest.date }),
          ...(latest.version && { version: latest.version }),
          ...(latest.category && { category: latest.category }),
          ...(latest.server && { server: latest.server }),
          ...(latest.jatsxmlUrl && { jatsxmlUrl: latest.jatsxmlUrl }),
          ...(latest.publishedJournalDoi && { publishedJournalDoi: latest.publishedJournalDoi }),
          ...(latest.abstract && { abstract: latest.abstract }),
          enriched: true,
          revisionCount: revisions.length,
        };
      }),
    );

    return {
      preprints: enriched,
      total_from_search: totalFromSearch,
      partial_results: hasPartial,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(
      `**${result.preprints.length} results** (from ${result.total_from_search} EuropePMC matches)`,
    );
    if (result.partial_results) {
      lines.push(
        '> Some results show EuropePMC metadata only — bioRxiv enrichment was unavailable.',
      );
    }

    if (result.message) {
      lines.push(`\n> ${result.message}`);
    }

    for (const p of result.preprints) {
      lines.push('');
      const revisions: PreprintRevision[] = p.enriched
        ? [
            {
              doi: p.doi,
              ...(p.title && { title: p.title }),
              ...(p.authors && { authors: p.authors }),
              ...(p.authorCorresponding && { authorCorresponding: p.authorCorresponding }),
              ...(p.date && { date: p.date }),
              ...(p.version && { version: p.version }),
              ...(p.category && { category: p.category }),
              ...(p.server && { server: p.server }),
              ...(p.jatsxmlUrl && { jatsxmlUrl: p.jatsxmlUrl }),
              ...(p.publishedJournalDoi && { publishedJournalDoi: p.publishedJournalDoi }),
              ...(p.abstract && { abstract: p.abstract }),
            } satisfies PreprintRevision,
          ]
        : [];

      const epmc = !p.enriched
        ? {
            ...(p.title && { title: p.title }),
            ...(p.authors && { authors: p.authors }),
            ...(p.date && { publishedDate: p.date }),
            ...(p.abstract && { abstract: p.abstract }),
          }
        : undefined;

      lines.push(formatResult(p.doi, revisions, epmc));

      lines.push(`*Enriched: ${p.enriched ? 'yes' : 'no (EuropePMC fallback)'}*`);
      if (p.enriched && p.revisionCount !== undefined) {
        lines.push(`*Revisions: ${p.revisionCount}*`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') || 'No results.' }];
  },
});
