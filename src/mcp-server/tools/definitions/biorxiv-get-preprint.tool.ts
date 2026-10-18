/**
 * @fileoverview biorxiv_get_preprint tool — fetches full metadata, abstract,
 * all revision history, and published-journal DOI for one or more preprints
 * by DOI. Each input is reduced to its bare DOI first (normalizeDoi strips
 * resolver and article URLs, `doi:`, and version / `.full` suffixes), and each
 * DOI call returns all revisions in a single response. Every entry is
 * classified before any request: an unparseable one goes to failed[], a repeat
 * of a DOI already seen is dropped, and only the first 10 distinct DOIs are
 * looked up — the rest are returned in unprocessed[], never fetched, so a call
 * stays one parallel round under the call's single deadline. When
 * server="both", each DOI fans out across bioRxiv and medRxiv in parallel and
 * settles the moment the server holding it answers, cutting the other lookup
 * short; per-DOI failures are reported in failed[] rather than aborting the batch.
 * All three lists follow input order, whichever lookup answers first.
 * A DOI is only reported as not found when every attempted server answered
 * with an empty collection — if a server never answered, the DOI is reported
 * as upstream-unavailable and retryable, on both the per-DOI and batch surfaces.
 * A lookup the origin rate-limited (HTTP 429) is separated from a generic
 * upstream failure and carries the origin's Retry-After wait, because that wait
 * is the one thing that tells a caller when a retry can succeed.
 * @module mcp-server/tools/definitions/biorxiv-get-preprint.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type { BiorxivServer, PreprintRevision } from '@/services/biorxiv/types.js';
import {
  describeWait,
  escapeMarkdown,
  findRateLimit,
  firstHit,
  normalizeDoi,
  startCallDeadline,
} from '@/services/shared.js';

// Upstream free text is escaped as it is interpolated so it renders literally;
// DOIs and URLs stay raw because agents copy them back into calls.
function formatRevision(r: PreprintRevision): string {
  const lines: string[] = [];
  lines.push(`#### v${r.version ?? '?'} — ${r.date ?? 'unknown date'}`);
  if (r.title) lines.push(`**Title:** ${escapeMarkdown(r.title)}`);
  lines.push(`**DOI:** ${r.doi}`);
  if (r.server) lines.push(`**Server:** ${r.server}`);
  if (r.type) lines.push(`**Type:** ${escapeMarkdown(r.type)}`);
  if (r.category) lines.push(`**Category:** ${escapeMarkdown(r.category)}`);
  if (r.license) lines.push(`**License:** ${escapeMarkdown(r.license)}`);
  if (r.authors) lines.push(`**Authors:** ${escapeMarkdown(r.authors)}`);
  if (r.authorCorresponding)
    lines.push(`**Corresponding:** ${escapeMarkdown(r.authorCorresponding)}`);
  if (r.authorCorrespondingInstitution)
    lines.push(`**Institution:** ${escapeMarkdown(r.authorCorrespondingInstitution)}`);
  if (r.awards) lines.push(`**Awards:** ${escapeMarkdown(r.awards.join('; '))}`);
  if (r.jatsxmlUrl) lines.push(`**JATS XML:** ${r.jatsxmlUrl}`);
  if (r.publishedJournalDoi) lines.push(`**Published Journal DOI:** ${r.publishedJournalDoi}`);
  if (r.abstract) lines.push(`\n**Abstract:** ${escapeMarkdown(r.abstract)}`);
  return lines.join('\n');
}

function formatPreprint(doi: string, revisions: PreprintRevision[]): string {
  if (revisions.length === 0) return '';
  const latest = revisions[revisions.length - 1];
  const lines: string[] = [];
  // Header carries only the preprint-level identity; every metadata field —
  // including revision-specific titles and authors — is rendered per-revision
  // by formatRevision() so content[] matches structuredContent for all revisions.
  lines.push(`### ${latest?.title ? escapeMarkdown(latest.title) : doi}`);
  lines.push(`**DOI:** ${doi}`);
  lines.push(`\n#### Revisions (${revisions.length} total)`);
  for (const rev of revisions) {
    lines.push('');
    lines.push(formatRevision(rev));
  }
  return lines.join('\n');
}

const RevisionSchema = z.object({
  doi: z.string().describe('Preprint DOI.'),
  title: z.string().optional().describe('Title.'),
  authors: z.string().optional().describe('Author list.'),
  authorCorresponding: z.string().optional().describe('Corresponding author name.'),
  authorCorrespondingInstitution: z
    .string()
    .optional()
    .describe('Corresponding author institution.'),
  date: z.string().optional().describe('Revision date (YYYY-MM-DD).'),
  version: z.string().optional().describe('Revision version number.'),
  type: z.string().optional().describe('Preprint type.'),
  license: z.string().optional().describe('License identifier.'),
  category: z.string().optional().describe('Subject category.'),
  jatsxmlUrl: z.string().optional().describe('URL to the JATS XML full-text.'),
  abstract: z.string().optional().describe('Abstract text.'),
  awards: z
    .array(z.string().describe('One award value as upstream records it.'))
    .optional()
    .describe(
      'Grant award numbers from the funding statement, verbatim and deduplicated — one value can hold several grants run together without a separator. Absent when none. Funder names are not included: api.biorxiv.org attributes them to unrelated organizations.',
    ),
  publishedJournalDoi: z.string().optional().describe('Published journal DOI when accepted.'),
  server: z.string().optional().describe('Source server (biorxiv or medrxiv).'),
});

/** Distinct DOIs one call looks up; the rest are returned in `unprocessed`. */
const MAX_LOOKUPS = 10;

/** Entries a batch-level error message names before counting the rest. */
const MAX_ECHOED = 10;

/** The first MAX_ECHOED entries, then a count of the rest — a 200-entry batch stays one short line. */
function echoEntries(entries: readonly string[]): string {
  const rest = entries.length - MAX_ECHOED;
  const named = entries.slice(0, MAX_ECHOED).join(', ');
  return rest > 0 ? `${named}, and ${rest} more` : named;
}

export const biorxivGetPreprintTool = tool('biorxiv_get_preprint', {
  title: 'Get Preprint by DOI',
  description:
    'Fetch full metadata, abstract, all revision history, JATS XML full-text links, and published-journal DOI for one or more preprints by DOI. Each DOI returns all revisions in one response. Each call looks up the first 10 distinct DOIs and returns the rest, never looked up, in unprocessed[] — pass that list as dois in another call to continue; a repeated DOI is looked up once and an unparseable entry is reported in failed[], so neither counts toward the 10. When server="both" (default), each DOI is checked against both bioRxiv and medRxiv; the response includes which server the preprint was found on. Failed lookups are reported per-DOI in failed[] rather than aborting the batch, each carrying a reason (not_found, invalid_doi_format, upstream_unavailable, rate_limited) and a retryable flag; a rate_limited entry also carries the wait in seconds the origin asked for. preprints[], failed[], and unprocessed[] follow input order. DOIs must match the pattern 10.NNNN/…; a doi.org or article URL, a doi: label, and a trailing vN / .full suffix are stripped first, and results report the bare DOI.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    dois: z
      .array(
        z
          .string()
          .describe(
            'Preprint DOI (e.g. 10.1101/2024.01.15.575123 or 10.64898/2026.05.07.723463). A doi.org or biorxiv.org/medrxiv.org article URL, a doi: prefix, or a vN / .full suffix is accepted and stripped to the bare DOI; every revision is returned either way.',
          ),
      )
      .min(1)
      .max(200)
      .describe(
        'Preprint DOIs to look up, up to 200 entries. The first 10 distinct DOIs are looked up; the rest are returned in unprocessed.',
      ),
    server: z
      .enum(['biorxiv', 'medrxiv', 'both'])
      .default('both')
      .describe('Server to query. "both" checks bioRxiv and medRxiv in parallel for each DOI.'),
  }),

  output: z.object({
    preprints: z
      .array(
        z
          .object({
            doi: z
              .string()
              .describe(
                'The requested DOI in bare form (any URL, doi: prefix, or suffix removed).',
              ),
            revisions: z
              .array(RevisionSchema.describe('A single preprint revision.'))
              .describe('All revisions for this preprint, earliest first.'),
          })
          .describe('A preprint and all its revisions.'),
      )
      .describe('Successfully resolved preprints with their full revision history.'),
    failed: z
      .array(
        z
          .object({
            doi: z
              .string()
              .describe(
                'DOI that failed to resolve — in bare form, or exactly as sent for invalid_doi_format.',
              ),
            error: z.string().describe('Error description.'),
            reason: z
              .enum(['not_found', 'invalid_doi_format', 'upstream_unavailable', 'rate_limited'])
              .describe(
                'Why this DOI failed: not_found (every attempted server answered with an empty collection), invalid_doi_format (the DOI does not match 10.NNNN/…), upstream_unavailable (a server never answered, so absence could not be established), or rate_limited (api.biorxiv.org returned HTTP 429 — the same as upstream_unavailable except that the origin named a wait).',
              ),
            retryable: z
              .boolean()
              .describe(
                'True when retrying this DOI may succeed — set for upstream_unavailable and rate_limited. A not_found or invalid_doi_format entry will not change on retry.',
              ),
            retryAfter: z
              .number()
              .optional()
              .describe(
                'Seconds api.biorxiv.org asked the caller to wait before the next request. Present only on a rate_limited entry whose response carried a usable Retry-After header.',
              ),
          })
          .describe('A DOI that failed to resolve.'),
      )
      .describe('DOIs that could not be resolved, with per-DOI error details.'),
    unprocessed: z
      .array(z.string().describe('A bare DOI that was not looked up.'))
      .describe(
        'Valid, distinct DOIs past the first 10, in input order — not looked up, so neither found nor failed. Pass this list as dois in another call to continue. Empty when every DOI was looked up.',
      ),
  }),

  // Disclosure of the per-call lookup cap, set only when DOIs were left in
  // unprocessed — optional so a call that looked up everything carries none.
  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when DOIs past the first 10 were left in unprocessed.'),
    shown: z.number().optional().describe('Distinct DOIs looked up in this call.'),
    cap: z.number().optional().describe('The most distinct DOIs one call looks up.'),
    notice: z
      .string()
      .optional()
      .describe(
        'How to look up the DOIs left in unprocessed, and how many failed[] entries are retryable alongside them.',
      ),
  },

  errors: [
    {
      reason: 'doi_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Every DOI looked up resolves to empty collections on all requested servers, with every server answering, and no DOI was left in unprocessed.',
      recovery:
        'Verify the DOI exists on bioRxiv or medRxiv. Supported prefixes: 10.1101/ and 10.64898/.',
    },
    {
      reason: 'invalid_doi_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Every input entry fails to match the 10.NNNN/ pattern, even after URL, doi:, and suffix stripping.',
      recovery:
        'Correct the DOI format — bioRxiv DOIs start with 10.1101/ or 10.64898/ followed by the manuscript ID.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'No DOI resolved, none was left in unprocessed, and at least one lookup failed against api.biorxiv.org, so absence could not be established for any requested DOI.',
      recovery:
        'Retry the request after a short delay — the DOIs may well exist; api.biorxiv.org did not answer.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      when: 'No DOI resolved, none was left in unprocessed, and at least one lookup was rejected with HTTP 429 by api.biorxiv.org.',
      recovery:
        'Wait the retryAfter seconds when present, otherwise a minute or two, before retrying — every preprint metadata tool queries the same origin, so none of them will answer sooner.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_get_preprint', {
      doiCount: input.dois.length,
      server: input.server,
    });

    const service = getBiorxivApiService();
    const deadline = startCallDeadline();

    type PreprintResult = { doi: string; revisions: PreprintRevision[] };
    type FailureReason =
      | 'not_found'
      | 'invalid_doi_format'
      | 'upstream_unavailable'
      | 'rate_limited';
    type FailedResult = {
      doi: string;
      error: string;
      reason: FailureReason;
      retryable: boolean;
      retryAfter?: number;
    };

    // Raw rejection values across every DOI, kept so the batch-level throw can
    // classify the failure the same way the per-DOI entries were classified.
    const rejectionErrors: unknown[] = [];
    const servers: BiorxivServer[] =
      input.server === 'both' ? ['biorxiv', 'medrxiv'] : [input.server];

    // One DOI across the requested servers, in parallel, settled into its entry.
    // A DOI lives on one server, so the lookup ends the moment that server returns
    // its revisions and the other leg is cut short — a stalled server that does
    // not hold the DOI never holds up a DOI the other server found.
    const lookUp = async (doi: string): Promise<PreprintResult | FailedResult> => {
      const { hit, outcomes } = await firstHit(
        servers.map(
          (server) => (signal: AbortSignal) =>
            service.getDetails(doi, server, deadline, ctx, signal),
        ),
        (revisions) => revisions.length > 0,
        ctx.signal,
      );
      if (hit) return { doi, revisions: hit.value };

      // No server held the DOI, so every lookup had answered or failed. "Not
      // found" is a claim about what the servers reported, so it requires every
      // attempted server to have answered — a server that failed leaves absence
      // unestablished and the DOI retryable.
      const rejections = outcomes.flatMap((r, i) =>
        r?.status === 'rejected'
          ? [{ server: servers[i] as BiorxivServer, error: r.reason as unknown }]
          : [],
      );
      if (rejections.length > 0) {
        const errors = rejections.map((f) => f.error);
        rejectionErrors.push(...errors);
        // A 429 is an upstream failure that named a wait. Splitting it out is
        // what lets the caller act on the wait instead of guessing one.
        const rateLimit = findRateLimit(errors);
        const detail = rejections
          .map(
            (f) => `${f.server}: ${f.error instanceof Error ? f.error.message : String(f.error)}`,
          )
          .join('; ');
        return {
          doi,
          error: `Lookup failed — ${detail}`,
          reason: rateLimit ? 'rate_limited' : 'upstream_unavailable',
          retryable: true,
          ...(rateLimit?.retryAfter !== undefined && { retryAfter: rateLimit.retryAfter }),
        };
      }

      return {
        doi,
        error:
          input.server === 'both'
            ? 'Not found on bioRxiv or medRxiv.'
            : `Not found on ${input.server}.`,
        reason: 'not_found',
        retryable: false,
      };
    };

    // Every entry is classified before any request. An unparseable entry fails in
    // its place, under the text the caller sent — there is no bare DOI to report;
    // a repeat of a DOI already seen takes no place; and only the first
    // MAX_LOOKUPS distinct DOIs are looked up. The rest are returned, never
    // fetched here, so the call stays one parallel round under one deadline.
    const entries: (FailedResult | Promise<PreprintResult | FailedResult>)[] = [];
    const seen = new Set<string>();
    const unprocessed: string[] = [];
    for (const raw of input.dois) {
      const doi = normalizeDoi(raw)?.doi;
      if (!doi) {
        entries.push({
          doi: raw,
          error: `Invalid DOI format — must match 10.NNNN/… (e.g. 10.1101/… or 10.64898/…).`,
          reason: 'invalid_doi_format',
          retryable: false,
        });
      } else if (!seen.has(doi)) {
        seen.add(doi);
        if (seen.size > MAX_LOOKUPS) unprocessed.push(doi);
        else entries.push(lookUp(doi));
      }
    }

    // Awaited in input order, so neither list follows the order lookups answer in.
    const settledEntries = await Promise.all(entries);
    // A cancelled call is not a partial result, whatever the lookups that finished
    // first or the DOIs left in unprocessed.
    ctx.signal.throwIfAborted();

    const preprints: PreprintResult[] = [];
    const failed: FailedResult[] = [];
    for (const entry of settledEntries) {
      if ('revisions' in entry) preprints.push(entry);
      else failed.push(entry);
    }

    // A batch-level error speaks for every requested DOI, so it applies only when
    // nothing resolved and no DOI was left unlooked-up.
    if (preprints.length === 0 && unprocessed.length === 0) {
      if (failed.every((f) => f.reason === 'invalid_doi_format')) {
        throw ctx.fail('invalid_doi_format', `Invalid DOI format: ${echoEntries(input.dois)}`);
      }
      // A rate limit outranks a generic upstream failure here: both say "retry",
      // but only one says when, and retrying sooner than the origin asked would
      // land back inside the same limit.
      const rateLimit = findRateLimit(rejectionErrors);
      if (rateLimit) {
        const limited = failed.filter(
          (f) => f.reason === 'rate_limited' || f.reason === 'upstream_unavailable',
        );
        const wait = describeWait(rateLimit.retryAfter);
        throw ctx.fail(
          'rate_limited',
          `No DOI could be resolved — ${limited.map((f) => `${f.doi}: ${f.error}`).join('; ')}`,
          {
            ...(rateLimit.retryAfter !== undefined && { retryAfter: rateLimit.retryAfter }),
            recovery: {
              hint: `Wait ${wait} before retrying — api.biorxiv.org is rate-limiting this host, and every preprint metadata tool queries the same origin.`,
            },
          },
        );
      }
      const unavailable = failed.filter((f) => f.reason === 'upstream_unavailable');
      if (unavailable.length > 0) {
        throw ctx.fail(
          'upstream_unavailable',
          `No DOI could be resolved — ${unavailable.map((f) => `${f.doi}: ${f.error}`).join('; ')}`,
        );
      }
      // The error replaces failed[], so an invalid entry beside the absent DOIs
      // is named apart from them rather than reported as not found.
      const dois = (reason: FailureReason) =>
        failed.flatMap((f) => (f.reason === reason ? [f.doi] : []));
      const invalid = dois('invalid_doi_format');
      throw ctx.fail(
        'doi_not_found',
        `None of the requested DOIs were found: ${dois('not_found').join(', ')}${invalid.length > 0 ? `. Invalid DOI format: ${echoEntries(invalid)}` : ''}`,
      );
    }

    if (unprocessed.length > 0) {
      // The remainder recipe alone never retries a lookup that failed transiently.
      const retryable = failed.filter((f) => f.retryable).length;
      const retry =
        retryable === 0
          ? ''
          : ` ${retryable} failed[] ${retryable === 1 ? 'entry is retryable — include its DOI' : 'entries are retryable — include their DOIs'} in a later call, after any retryAfter wait.`;
      ctx.enrich.truncated({
        shown: MAX_LOOKUPS,
        cap: MAX_LOOKUPS,
        guidance: `Looked up the first ${MAX_LOOKUPS} distinct DOIs; ${unprocessed.length} more ${unprocessed.length === 1 ? 'is' : 'are'} in unprocessed — pass unprocessed as dois in another call to continue.${retry}`,
      });
    }

    return { preprints, failed, unprocessed };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.preprints.length > 0) {
      lines.push(`## Preprints (${result.preprints.length})`);
      for (const p of result.preprints) {
        lines.push('');
        lines.push(formatPreprint(p.doi, p.revisions as PreprintRevision[]));
      }
    }

    if (result.failed.length > 0) {
      lines.push('\n## Failed DOIs');
      for (const f of result.failed) {
        const wait = f.retryAfter === undefined ? '' : `, retry after: ${f.retryAfter}s`;
        lines.push(`- **${f.doi}**: ${f.error} (${f.reason}, retryable: ${f.retryable}${wait})`);
      }
    }

    if (result.unprocessed.length > 0) {
      lines.push(`\n## Unprocessed DOIs (${result.unprocessed.length})`);
      for (const doi of result.unprocessed) lines.push(`- ${doi}`);
    }

    return [{ type: 'text', text: lines.join('\n') || 'No results.' }];
  },
});
