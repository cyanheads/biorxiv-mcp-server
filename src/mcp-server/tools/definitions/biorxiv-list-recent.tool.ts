/**
 * @fileoverview biorxiv_list_recent tool — lists preprints posted or revised
 * within a date interval. Fans out to both bioRxiv and medRxiv when
 * server="both". Category filtering is applied server-side via the ?category=
 * query param. Returns 30 results per page (API-fixed); use cursor to paginate.
 * When server="both", per-server pagination state is surfaced independently.
 * Large result sets spill to DataCanvas when CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/biorxiv-list-recent.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

type PreprintForFormat = {
  [K in keyof PreprintRevision]: K extends 'doi' ? string : PreprintRevision[K] | undefined;
};

function formatPreprint(p: PreprintForFormat): string {
  const lines: string[] = [];
  lines.push(`### ${p.title ?? p.doi}`);
  lines.push(`**DOI:** ${p.doi}`);
  if (p.date) lines.push(`**Date:** ${p.date}`);
  if (p.version) lines.push(`**Version:** ${p.version}`);
  if (p.type) lines.push(`**Type:** ${p.type}`);
  if (p.server) lines.push(`**Server:** ${p.server}`);
  if (p.category) lines.push(`**Category:** ${p.category}`);
  if (p.license) lines.push(`**License:** ${p.license}`);
  if (p.authors) lines.push(`**Authors:** ${p.authors}`);
  if (p.authorCorresponding) lines.push(`**Corresponding:** ${p.authorCorresponding}`);
  if (p.authorCorrespondingInstitution)
    lines.push(`**Institution:** ${p.authorCorrespondingInstitution}`);
  if (p.funder) lines.push(`**Funder:** ${p.funder}`);
  if (p.jatsxmlUrl) lines.push(`**JATS XML:** ${p.jatsxmlUrl}`);
  if (p.publishedJournalDoi) lines.push(`**Published DOI:** ${p.publishedJournalDoi}`);
  if (p.abstract) lines.push(`\n${p.abstract}`);
  return lines.join('\n');
}

export const biorxivListRecentTool = tool('biorxiv_list_recent', {
  title: 'List Recent Preprints',
  description:
    'List preprints posted or revised within a date interval, optionally scoped to one server or a subject category. Returns 30 preprints per page (fixed by the API); pass `cursor` as an integer offset (0, 30, 60, …) to step through additional pages. When server="both" (default), per-server pagination state is returned separately — use each server\'s `cursor` field for independent advancement. Category filtering is applied server-side; call biorxiv_list_categories for valid category strings.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    start_date: z.string().describe('Start of the date interval (YYYY-MM-DD).'),
    end_date: z.string().describe('End of the date interval (YYYY-MM-DD).'),
    server: z
      .enum(['biorxiv', 'medrxiv', 'both'])
      .default('both')
      .describe('Server to query. "both" fans out to bioRxiv and medRxiv in parallel.'),
    category: z
      .string()
      .optional()
      .describe(
        'Subject category filter applied server-side. Use biorxiv_list_categories for valid values.',
      ),
    cursor: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Integer page offset (0, 30, 60, …). Defaults to 0 (first page).'),
  }),

  output: z.object({
    preprints: z
      .array(
        z
          .object({
            doi: z.string().describe('Preprint DOI.'),
            title: z.string().optional().describe('Title of the preprint.'),
            authors: z.string().optional().describe('Author list.'),
            authorCorresponding: z.string().optional().describe('Corresponding author name.'),
            authorCorrespondingInstitution: z
              .string()
              .optional()
              .describe('Corresponding author institution.'),
            date: z.string().optional().describe('Posting or revision date (YYYY-MM-DD).'),
            version: z.string().optional().describe('Revision version number.'),
            type: z.string().optional().describe('Preprint type.'),
            license: z.string().optional().describe('License identifier.'),
            category: z.string().optional().describe('Subject category.'),
            jatsxmlUrl: z.string().optional().describe('URL to the JATS XML full-text.'),
            abstract: z.string().optional().describe('Abstract text.'),
            funder: z.string().optional().describe('Funder information.'),
            publishedJournalDoi: z
              .string()
              .optional()
              .describe('Published journal DOI when this preprint has been accepted.'),
            server: z.string().optional().describe('Source server (biorxiv or medrxiv).'),
          })
          .describe('A single preprint entry.'),
      )
      .describe('Preprints in the requested date interval.'),
    pagination: z
      .object({
        biorxiv: z
          .object({
            cursor: z.number().describe('Current cursor (offset used for this page).'),
            total: z.number().describe('Total preprints available on bioRxiv for these filters.'),
            nextCursor: z.number().optional().describe('Cursor value for the next page, if any.'),
          })
          .optional()
          .describe('bioRxiv pagination state. Present when server is "biorxiv" or "both".'),
        medrxiv: z
          .object({
            cursor: z.number().describe('Current cursor (offset used for this page).'),
            total: z.number().describe('Total preprints available on medRxiv for these filters.'),
            nextCursor: z.number().optional().describe('Cursor value for the next page, if any.'),
          })
          .optional()
          .describe('medRxiv pagination state. Present when server is "medrxiv" or "both".'),
      })
      .describe('Per-server pagination state. Advance each server independently.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas ID when result overflowed the inline preview budget. Use biorxiv_query_canvas to run SQL over the full result set.',
      ),
    message: z
      .string()
      .optional()
      .describe('Recovery hint when zero results are returned — echoes applied filters.'),
  }),

  errors: [
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'end_date is before start_date, or either date is malformed.',
      recovery: 'Provide valid YYYY-MM-DD dates where start_date is on or before end_date.',
    },
    {
      reason: 'invalid_category',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The supplied category string is not in the taxonomy.',
      recovery: 'Call biorxiv_list_categories to get valid category strings and retry.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_list_recent', {
      start_date: input.start_date,
      end_date: input.end_date,
      server: input.server,
      cursor: input.cursor,
      category: input.category,
    });

    // Validate dates
    if (!DATE_REGEX.test(input.start_date) || !DATE_REGEX.test(input.end_date)) {
      throw ctx.fail('invalid_date_range', 'Date must be in YYYY-MM-DD format.', {
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    if (input.start_date > input.end_date) {
      throw ctx.fail(
        'invalid_date_range',
        `start_date (${input.start_date}) must be on or before end_date (${input.end_date}).`,
        { ...ctx.recoveryFor('invalid_date_range') },
      );
    }

    // Validate category
    if (input.category?.trim()) {
      const service = getBiorxivApiService();
      if (!service.isValidCategory(input.category)) {
        throw ctx.fail('invalid_category', `Category "${input.category}" is not in the taxonomy.`, {
          ...ctx.recoveryFor('invalid_category'),
        });
      }
    }

    const service = getBiorxivApiService();
    const category = input.category?.trim() || undefined;

    type PaginationEntry = {
      cursor: number;
      total: number;
      nextCursor?: number;
    };

    const pagination: {
      biorxiv?: PaginationEntry;
      medrxiv?: PaginationEntry;
    } = {};

    let allPreprints: PreprintRevision[] = [];

    if (input.server === 'both') {
      const [bxResult, mxResult] = await Promise.allSettled([
        service.getListing(
          'biorxiv',
          input.start_date,
          input.end_date,
          input.cursor,
          category,
          ctx,
        ),
        service.getListing(
          'medrxiv',
          input.start_date,
          input.end_date,
          input.cursor,
          category,
          ctx,
        ),
      ]);

      if (bxResult.status === 'fulfilled') {
        const r = bxResult.value;
        const nextCursor =
          r.pagination.cursor + r.preprints.length < r.pagination.total
            ? r.pagination.cursor + 30
            : undefined;
        pagination.biorxiv = { ...r.pagination, ...(nextCursor !== undefined && { nextCursor }) };
        allPreprints.push(...r.preprints);
      } else {
        ctx.log.warning('bioRxiv listing failed', { error: String(bxResult.reason) });
      }

      if (mxResult.status === 'fulfilled') {
        const r = mxResult.value;
        const nextCursor =
          r.pagination.cursor + r.preprints.length < r.pagination.total
            ? r.pagination.cursor + 30
            : undefined;
        pagination.medrxiv = { ...r.pagination, ...(nextCursor !== undefined && { nextCursor }) };
        allPreprints.push(...r.preprints);
      } else {
        ctx.log.warning('medRxiv listing failed', { error: String(mxResult.reason) });
      }
    } else {
      const r = await service.getListing(
        input.server,
        input.start_date,
        input.end_date,
        input.cursor,
        category,
        ctx,
      );
      const nextCursor =
        r.pagination.cursor + r.preprints.length < r.pagination.total
          ? r.pagination.cursor + 30
          : undefined;
      pagination[input.server] = {
        ...r.pagination,
        ...(nextCursor !== undefined && { nextCursor }),
      };
      allPreprints = r.preprints;
    }

    if (allPreprints.length === 0) {
      const filterDesc = [
        `dates ${input.start_date}–${input.end_date}`,
        category ? `category "${category}"` : null,
        input.server !== 'both' ? `server "${input.server}"` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return {
        preprints: [],
        pagination,
        message: `No preprints found for ${filterDesc}. Try widening the date range or removing the category filter.`,
      };
    }

    // Spillover to DataCanvas if canvas is available and result is large
    const canvas = (ctx as { core?: { canvas?: object } }).core?.canvas as
      | import('@cyanheads/mcp-ts-core/canvas').DataCanvas
      | undefined;

    if (canvas && allPreprints.length > 50) {
      const instance = await canvas.acquire(undefined, ctx);
      async function* preprintRows(): AsyncIterable<Record<string, unknown>> {
        for (const p of allPreprints) {
          yield p as unknown as Record<string, unknown>;
        }
      }
      const spill = await spillover({
        canvas: instance,
        source: preprintRows(),
        previewChars: 80_000,
        caps: { maxRows: 5_000 },
        signal: ctx.signal,
      });

      if (spill.spilled) {
        return {
          preprints: spill.previewRows as unknown as PreprintRevision[],
          pagination,
          canvas_id: instance.canvasId,
        };
      }
    }

    return { preprints: allPreprints, pagination };
  },

  format: (result) => {
    const lines: string[] = [];

    // Pagination summary
    if (result.pagination.biorxiv) {
      const p = result.pagination.biorxiv;
      lines.push(
        `**bioRxiv:** page offset ${p.cursor}, total ${p.total}${p.nextCursor !== undefined ? ` — next cursor: ${p.nextCursor}` : ' (last page)'}`,
      );
    }
    if (result.pagination.medrxiv) {
      const p = result.pagination.medrxiv;
      lines.push(
        `**medRxiv:** page offset ${p.cursor}, total ${p.total}${p.nextCursor !== undefined ? ` — next cursor: ${p.nextCursor}` : ' (last page)'}`,
      );
    }

    if (result.canvas_id) {
      lines.push(
        `\n**DataCanvas ID:** \`${result.canvas_id}\` — run SQL queries on the full result set.`,
      );
    }

    if (result.message) {
      lines.push(`\n> ${result.message}`);
    }

    if (result.preprints.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push(`\n## Preprints (${result.preprints.length} shown)`);
    for (const p of result.preprints) {
      lines.push('');
      lines.push(formatPreprint(p));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
