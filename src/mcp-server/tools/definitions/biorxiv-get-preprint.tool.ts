/**
 * @fileoverview biorxiv_get_preprint tool — fetches full metadata, abstract,
 * all revision history, and published-journal DOI for one or more preprints
 * by DOI. Each DOI call returns all revisions in a single response. When
 * server="both", each DOI fans out across bioRxiv and medRxiv in parallel;
 * per-DOI failures are reported in failed[] rather than aborting the batch.
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
import { describeWait, findRateLimit } from '@/services/shared.js';

const DOI_REGEX = /^10\.\d{4,}\//;

function formatRevision(r: PreprintRevision): string {
  const lines: string[] = [];
  lines.push(`#### v${r.version ?? '?'} — ${r.date ?? 'unknown date'}`);
  if (r.title) lines.push(`**Title:** ${r.title}`);
  lines.push(`**DOI:** ${r.doi}`);
  if (r.server) lines.push(`**Server:** ${r.server}`);
  if (r.type) lines.push(`**Type:** ${r.type}`);
  if (r.category) lines.push(`**Category:** ${r.category}`);
  if (r.license) lines.push(`**License:** ${r.license}`);
  if (r.authors) lines.push(`**Authors:** ${r.authors}`);
  if (r.authorCorresponding) lines.push(`**Corresponding:** ${r.authorCorresponding}`);
  if (r.authorCorrespondingInstitution)
    lines.push(`**Institution:** ${r.authorCorrespondingInstitution}`);
  if (r.funder) lines.push(`**Funder:** ${r.funder}`);
  if (r.jatsxmlUrl) lines.push(`**JATS XML:** ${r.jatsxmlUrl}`);
  if (r.publishedJournalDoi) lines.push(`**Published Journal DOI:** ${r.publishedJournalDoi}`);
  if (r.abstract) lines.push(`\n**Abstract:** ${r.abstract}`);
  return lines.join('\n');
}

function formatPreprint(doi: string, revisions: PreprintRevision[]): string {
  if (revisions.length === 0) return '';
  const latest = revisions[revisions.length - 1];
  const lines: string[] = [];
  // Header carries only the preprint-level identity; every metadata field —
  // including revision-specific titles and authors — is rendered per-revision
  // by formatRevision() so content[] matches structuredContent for all revisions.
  lines.push(`### ${latest?.title ?? doi}`);
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
  funder: z.string().optional().describe('Funder information.'),
  publishedJournalDoi: z.string().optional().describe('Published journal DOI when accepted.'),
  server: z.string().optional().describe('Source server (biorxiv or medrxiv).'),
});

export const biorxivGetPreprintTool = tool('biorxiv_get_preprint', {
  title: 'Get Preprint by DOI',
  description:
    'Fetch full metadata, abstract, all revision history, JATS XML full-text links, and published-journal DOI for one or more preprints by DOI. Each DOI returns all revisions in one response. When server="both" (default), each DOI is checked against both bioRxiv and medRxiv; the response includes which server the preprint was found on. Failed lookups are reported per-DOI in failed[] rather than aborting the batch, each carrying a reason (not_found, invalid_doi_format, upstream_unavailable, rate_limited) and a retryable flag; a rate_limited entry also carries the wait in seconds the origin asked for. DOIs must match the pattern 10.NNNN/…',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    dois: z
      .array(
        z
          .string()
          .describe('Preprint DOI (e.g. 10.1101/2024.01.15.575123 or 10.64898/2026.05.07.723463).'),
      )
      .min(1)
      .max(10)
      .describe('One or more preprint DOIs to look up (max 10).'),
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
            doi: z.string().describe('The requested DOI.'),
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
            doi: z.string().describe('DOI that failed to resolve.'),
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
  }),

  errors: [
    {
      reason: 'doi_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ALL requested DOIs resolve to empty collections on all requested servers, with every server answering.',
      recovery:
        'Verify the DOI exists on bioRxiv or medRxiv. Supported prefixes: 10.1101/ and 10.64898/.',
    },
    {
      reason: 'invalid_doi_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'One or more input DOIs do not match the 10.NNNN/ pattern.',
      recovery:
        'Correct the DOI format — bioRxiv DOIs start with 10.1101/ or 10.64898/ followed by the manuscript ID.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'No DOI resolved and at least one lookup failed against api.biorxiv.org, so absence could not be established for any requested DOI.',
      recovery:
        'Retry the request after a short delay — the DOIs may well exist; api.biorxiv.org did not answer.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      when: 'No DOI resolved and at least one lookup was rejected with HTTP 429 by api.biorxiv.org.',
      recovery:
        'Wait the retryAfter seconds before retrying — every preprint metadata tool queries the same origin, so none of them will answer sooner.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_get_preprint', {
      doiCount: input.dois.length,
      server: input.server,
    });

    const service = getBiorxivApiService();

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

    const preprints: PreprintResult[] = [];
    const failed: FailedResult[] = [];
    // Raw rejection values across every DOI, kept so the batch-level throw can
    // classify the failure the same way the per-DOI entries were classified.
    const rejectionErrors: unknown[] = [];
    const servers: BiorxivServer[] =
      input.server === 'both' ? ['biorxiv', 'medrxiv'] : [input.server];

    // For each DOI, fan out across servers in parallel
    await Promise.all(
      input.dois.map(async (doi) => {
        // Route format-invalid DOIs to failed[] rather than aborting the batch
        if (!DOI_REGEX.test(doi)) {
          failed.push({
            doi,
            error: `Invalid DOI format — must match 10.NNNN/… (e.g. 10.1101/… or 10.64898/…).`,
            reason: 'invalid_doi_format',
            retryable: false,
          });
          return;
        }

        const settled = await Promise.allSettled(
          servers.map((server) => service.getDetails(doi, server, ctx)),
        );
        const revisions = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
        if (revisions.length > 0) {
          preprints.push({ doi, revisions });
          return;
        }

        // No revisions. "Not found" is a claim about what the servers reported, so it
        // requires every attempted server to have answered — a server that failed
        // leaves absence unestablished and the DOI retryable.
        const rejections = settled.flatMap((r, i) =>
          r.status === 'rejected'
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
          failed.push({
            doi,
            error: `Lookup failed — ${detail}`,
            reason: rateLimit ? 'rate_limited' : 'upstream_unavailable',
            retryable: true,
            ...(rateLimit?.retryAfter !== undefined && { retryAfter: rateLimit.retryAfter }),
          });
          return;
        }

        failed.push({
          doi,
          error:
            input.server === 'both'
              ? 'Not found on bioRxiv or medRxiv.'
              : `Not found on ${input.server}.`,
          reason: 'not_found',
          retryable: false,
        });
      }),
    );

    // All DOIs failed — pick the appropriate declared error
    if (preprints.length === 0 && failed.length === input.dois.length) {
      if (failed.every((f) => f.reason === 'invalid_doi_format')) {
        throw ctx.fail('invalid_doi_format', `Invalid DOI format: ${input.dois.join(', ')}`, {
          ...ctx.recoveryFor('invalid_doi_format'),
        });
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
          { ...ctx.recoveryFor('upstream_unavailable') },
        );
      }
      throw ctx.fail(
        'doi_not_found',
        `None of the requested DOIs were found: ${input.dois.join(', ')}`,
        { ...ctx.recoveryFor('doi_not_found') },
      );
    }

    return { preprints, failed };
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

    return [{ type: 'text', text: lines.join('\n') || 'No results.' }];
  },
});
