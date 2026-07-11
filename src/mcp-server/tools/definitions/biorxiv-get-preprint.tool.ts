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
    'Fetch full metadata, abstract, all revision history, JATS XML full-text links, and published-journal DOI for one or more preprints by DOI. Each DOI returns all revisions in one response. When server="both" (default), each DOI is checked against both bioRxiv and medRxiv; the response includes which server the preprint was found on. Failed lookups are reported per-DOI rather than aborting the batch. DOIs must match the pattern 10.NNNN/…',
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
        'Verify the DOI exists on bioRxiv or medRxiv. Supported prefixes: 10.1101/ and 10.64898/.',
    },
    {
      reason: 'invalid_doi_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'One or more input DOIs do not match the 10.NNNN/ pattern.',
      recovery:
        'Correct the DOI format — bioRxiv DOIs start with 10.1101/ or 10.64898/ followed by the manuscript ID.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_get_preprint', {
      doiCount: input.dois.length,
      server: input.server,
    });

    const service = getBiorxivApiService();

    type PreprintResult = { doi: string; revisions: PreprintRevision[] };
    type FailedResult = { doi: string; error: string };

    const preprints: PreprintResult[] = [];
    const failed: FailedResult[] = [];

    // For each DOI, fan out across servers in parallel
    await Promise.all(
      input.dois.map(async (doi) => {
        // Route format-invalid DOIs to failed[] rather than aborting the batch
        if (!DOI_REGEX.test(doi)) {
          failed.push({
            doi,
            error: `Invalid DOI format — must match 10.NNNN/… (e.g. 10.1101/… or 10.64898/…).`,
          });
          return;
        }
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

    // All DOIs failed — pick the appropriate declared error
    if (preprints.length === 0 && failed.length === input.dois.length) {
      const allFormatErrors = failed.every((f) => f.error.startsWith('Invalid DOI format'));
      if (allFormatErrors) {
        throw ctx.fail('invalid_doi_format', `Invalid DOI format: ${input.dois.join(', ')}`, {
          ...ctx.recoveryFor('invalid_doi_format'),
        });
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
        lines.push(`- **${f.doi}**: ${f.error}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') || 'No results.' }];
  },
});
