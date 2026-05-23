/**
 * @fileoverview biorxiv_get_published_version tool — resolves a preprint DOI
 * to its full journal publication record using the /pubs endpoint. Use when
 * you need richer crosswalk metadata than biorxiv_get_preprint provides
 * (journal name, published date, full abstract, corresponding author details).
 * @module mcp-server/tools/definitions/biorxiv-get-published-version.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';

const DOI_REGEX = /^10\.\d{4,}\//;

export const biorxivGetPublishedVersionTool = tool('biorxiv_get_published_version', {
  title: 'Get Published Journal Version',
  description:
    "Resolve a preprint DOI to its full journal publication record — journal DOI, journal name, published date, and corresponding author details. Use when the preprint's `published` field from biorxiv_get_preprint is non-null and you need the full crosswalk metadata. Returns a not-found error when the preprint is not yet published. Check biorxiv_get_preprint first to confirm the published field is populated.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    doi: z
      .string()
      .describe(
        'Preprint DOI to resolve (e.g. 10.1101/2024.01.15.575123 or 10.64898/2026.05.07.723463).',
      ),
    server: z
      .enum(['biorxiv', 'medrxiv'])
      .default('biorxiv')
      .describe('Server the preprint was posted on. Defaults to biorxiv.'),
  }),

  output: z.object({
    preprintDoi: z.string().describe('The preprint DOI that was resolved.'),
    publishedDoi: z.string().optional().describe('The journal publication DOI.'),
    publishedJournal: z.string().optional().describe('Name of the publishing journal.'),
    publishedDate: z.string().optional().describe('Journal publication date (YYYY-MM-DD).'),
    preprintTitle: z.string().optional().describe('Title of the preprint.'),
    preprintAuthors: z.string().optional().describe('Preprint author list.'),
    preprintCategory: z.string().optional().describe('Subject category.'),
    preprintDate: z.string().optional().describe('Date the preprint was first posted.'),
    preprintAbstract: z.string().optional().describe('Preprint abstract.'),
    preprintAuthorCorresponding: z.string().optional().describe('Corresponding author name.'),
    preprintAuthorCorrespondingInstitution: z
      .string()
      .optional()
      .describe('Corresponding author institution.'),
  }),

  errors: [
    {
      reason: 'doi_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Crosswalk endpoint returns empty collection — preprint may not be published yet.',
      recovery:
        'Use biorxiv_get_preprint to check the published field. If it shows NA, the preprint is not yet published.',
    },
    {
      reason: 'invalid_doi_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The input DOI does not match the 10.NNNN/ pattern.',
      recovery:
        'Correct the DOI format — bioRxiv DOIs start with 10.1101/ or 10.64898/ followed by the manuscript ID.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_get_published_version', {
      doi: input.doi,
      server: input.server,
    });

    if (!DOI_REGEX.test(input.doi)) {
      throw ctx.fail('invalid_doi_format', `Invalid DOI format: ${input.doi}`, {
        ...ctx.recoveryFor('invalid_doi_format'),
      });
    }

    const service = getBiorxivApiService();
    const result = await service.getPublishedVersion(input.doi, input.server, ctx);

    if (!result) {
      throw ctx.fail(
        'doi_not_found',
        `No published version found for ${input.doi} on ${input.server}.`,
        { doi: input.doi, server: input.server, ...ctx.recoveryFor('doi_not_found') },
      );
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Published Version`);
    lines.push(`**Preprint DOI:** ${result.preprintDoi}`);
    if (result.publishedDoi) lines.push(`**Published DOI:** ${result.publishedDoi}`);
    if (result.publishedJournal) lines.push(`**Journal:** ${result.publishedJournal}`);
    if (result.publishedDate) lines.push(`**Published Date:** ${result.publishedDate}`);
    if (result.preprintTitle) lines.push(`\n**Title:** ${result.preprintTitle}`);
    if (result.preprintAuthors) lines.push(`**Authors:** ${result.preprintAuthors}`);
    if (result.preprintCategory) lines.push(`**Category:** ${result.preprintCategory}`);
    if (result.preprintDate) lines.push(`**Preprint Date:** ${result.preprintDate}`);
    if (result.preprintAuthorCorresponding)
      lines.push(`**Corresponding Author:** ${result.preprintAuthorCorresponding}`);
    if (result.preprintAuthorCorrespondingInstitution)
      lines.push(`**Institution:** ${result.preprintAuthorCorrespondingInstitution}`);
    if (result.preprintAbstract) lines.push(`\n**Abstract:**\n${result.preprintAbstract}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
