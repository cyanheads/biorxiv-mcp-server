/**
 * @fileoverview biorxiv_list_categories tool — returns the static subject
 * category taxonomy for bioRxiv and medRxiv. These strings are the valid values
 * for the `category` filter parameter in biorxiv_list_recent. No API call is
 * made; the taxonomy is maintained as a hardcoded list in BiorxivApiService.
 * @module mcp-server/tools/definitions/biorxiv-list-categories.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';

export const biorxivListCategoriesTool = tool('biorxiv_list_categories', {
  title: 'List bioRxiv/medRxiv Categories',
  description:
    'List valid subject category strings for bioRxiv and medRxiv. Use these strings as the `category` filter in biorxiv_list_recent to narrow results to a specific field. The taxonomy is static and maintained in-server; run this tool before filtering to get the current valid values.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({}),

  output: z.object({
    biorxiv: z
      .array(z.string().describe('Subject category name'))
      .describe('bioRxiv subject categories'),
    medrxiv: z
      .array(z.string().describe('Subject category name'))
      .describe('medRxiv subject categories'),
  }),

  handler(_input, ctx) {
    ctx.log.info('Executing biorxiv_list_categories');
    return getBiorxivApiService().getCategories();
  },

  format: (result) => [
    {
      type: 'text',
      text: [
        `## bioRxiv Categories (${result.biorxiv.length})`,
        result.biorxiv.map((c) => `- ${c}`).join('\n'),
        '',
        `## medRxiv Categories (${result.medrxiv.length})`,
        result.medrxiv.map((c) => `- ${c}`).join('\n'),
      ].join('\n'),
    },
  ],
});
