/**
 * @fileoverview biorxiv_get_preprint tool — fetches full metadata, abstract,
 * all revision history, and published-journal DOI for one or more preprints
 * by DOI. Each DOI call returns all revisions in a single response. When
 * server="both", each DOI fans out across bioRxiv and medRxiv in parallel;
 * per-DOI failures are reported in failed[] rather than aborting the batch.
 * @module mcp-server/tools/definitions/biorxiv-get-preprint.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';

const DOI_REGEX = /^10\.\d{4,}\//;

function formatRevision(r: PreprintRevision): string {
  const lines: string[] = [];
  lines.push(`#### v${r.version ?? '?'} — ${r.date ?? 'unknown date'}`);
  lines.push(`**DOI:** ${r.doi}`);
  if (r.type) lines.push(`**Type:** ${r.type}`);
  if (r.license) lines.push(`**License:** ${r.license}`);
  if (r.jatsxmlUrl) lines.push(`**JATS XML:** ${r.jatsxmlUrl}`);
  if (r.publishedJournalDoi) lines.push(`**Published Journal DOI:** ${r.publishedJournalDoi}`);
  if (r.abstract) lines.push(`\n**Abstract:** ${r.abstract}`);
  return lines.join('\n');
}

function formatPreprint(doi: string, revisions: PreprintRevision[]): string {
  if (revisions.length === 0) return '';
  const latest = revisions[revisions.length - 1];
  const lines: string[] = [];
  lines.push(`### ${latest?.title ?? doi}`);
  lines.push(`**DOI:** ${doi}`);
  if (latest?.server) lines.push(`**Server:** ${latest.server}`);
  if (latest?.category) lines.push(`**Category:** ${latest.category}`);
  if (latest?.authors) lines.push(`**Authors:** ${latest.authors}`);
  if (latest?.authorCorresponding) lines.push(`**Corresponding:** ${latest.authorCorresponding}`);
  if (latest?.authorCorrespondingInstitution)
    lines.push(`**Institution:** ${latest.authorCorrespondingInstitution}`);
  if (latest?.funder) lines.push(`**Funder:** ${latest.funder}`);
  if (latest?.publishedJournalDoi)
    lines.push(`**Published Journal DOI:** ${latest.publishedJournalDoi}`);
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
    'Fetch full metadata, abstract, all revision history, full-text/PDF links, and published-journal DOI for one or more preprints by DOI. Each DOI returns all revisions in one response. When server="both" (default), each DOI is checked against both bioRxiv and medRxiv; the response includes which server the preprint was found on. Per-DOI failures are surfaced in failed[] rather than aborting the batch. DOIs must match the pattern 10.NNNN/…',
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
          })
          .describe('A DOI that failed to resolve.'),
      )
      .describe('DOIs that could not be resolved, with per-DOI error details.'),
  }),

  errors: [
    {
      reason: 'doi_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ALL requested DOIs resolve to empty collections on all requested servers.',
      recovery:
        'Verify the DOI format (must start with 10.1101/) and check it exists on bioRxiv or medRxiv.',
    },
    {
      reason: 'invalid_doi_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'One or more input DOIs do not match the 10.NNNN/ pattern.',
      recovery:
        'Correct the DOI format — bioRxiv DOIs start with 10.1101/ followed by the manuscript ID.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_get_preprint', {
      doiCount: input.dois.length,
      server: input.server,
    });

    // Validate all DOIs up front
    const badDois = input.dois.filter((d) => !DOI_REGEX.test(d));
    if (badDois.length > 0) {
      throw ctx.fail('invalid_doi_format', `Invalid DOI format: ${badDois.join(', ')}`, {
        badDois,
        ...ctx.recoveryFor('invalid_doi_format'),
      });
    }

    const service = getBiorxivApiService();

    type PreprintResult = { doi: string; revisions: PreprintRevision[] };
    type FailedResult = { doi: string; error: string };

    const preprints: PreprintResult[] = [];
    const failed: FailedResult[] = [];

    // For each DOI, fan out across servers in parallel
    await Promise.all(
      input.dois.map(async (doi) => {
        try {
          let revisions: PreprintRevision[] = [];

          if (input.server === 'both') {
            const [bxResult, mxResult] = await Promise.allSettled([
              service.getDetails(doi, 'biorxiv', ctx),
              service.getDetails(doi, 'medrxiv', ctx),
            ]);
            if (bxResult.status === 'fulfilled') revisions.push(...bxResult.value);
            if (mxResult.status === 'fulfilled') revisions.push(...mxResult.value);

            // If both failed, surface the error
            if (bxResult.status === 'rejected' && mxResult.status === 'rejected') {
              throw bxResult.reason instanceof Error
                ? bxResult.reason
                : new Error(String(bxResult.reason));
            }
          } else {
            revisions = await service.getDetails(doi, input.server, ctx);
          }

          if (revisions.length > 0) {
            preprints.push({ doi, revisions });
          } else if (input.server !== 'both') {
            failed.push({ doi, error: `Not found on ${input.server}.` });
          } else {
            failed.push({ doi, error: 'Not found on bioRxiv or medRxiv.' });
          }
        } catch (err) {
          failed.push({
            doi,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    // All DOIs failed → throw declared error
    if (preprints.length === 0 && failed.length === input.dois.length) {
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
        lines.push(`- **${f.doi}**: ${f.error}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') || 'No results.' }];
  },
});
