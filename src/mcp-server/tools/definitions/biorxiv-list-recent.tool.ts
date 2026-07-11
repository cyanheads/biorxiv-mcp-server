/**
 * @fileoverview biorxiv_list_recent tool — lists preprints posted or revised
 * within a date interval. Fans out to both bioRxiv and medRxiv when
 * server="both". Category filtering is applied server-side via the ?category=
 * query param. Returns 30 results per page (API-fixed); use cursor to paginate.
 * When server="both", per-server pagination state is surfaced independently.
 * @module mcp-server/tools/definitions/biorxiv-list-recent.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type { BiorxivServer, PreprintRevision } from '@/services/biorxiv/types.js';
import { isValidCalendarDate } from '@/services/shared.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function formatPreprint(p: PreprintRevision): string {
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
    'List preprints posted or revised within a date interval, optionally scoped to one server or a subject category. Returns 30 preprints per page (fixed by the API); pass `cursor` as an integer offset (0, 30, 60, …) to step through additional pages. When server="both" (default), per-server pagination state is returned separately — use each server\'s `cursor` field for independent advancement. Call biorxiv_list_categories for valid category strings.',
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
      .describe('Subject category filter. Use biorxiv_list_categories for valid values.'),
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
  }),

  // Agent-facing context on the success path — recovery guidance for empty results and
  // per-server taxonomy routing notes. Populated via ctx.enrich so it reaches both
  // structuredContent and content[]; never rides in the domain return.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when zero results are returned — echoes applied filters and suggests how to broaden.',
      ),
    categoryNote: z
      .string()
      .optional()
      .describe(
        'Present when server="both" and the category exists in only one server\'s taxonomy. Explains which server was queried and why the other was excluded.',
      ),
  },

  errors: [
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'end_date is before start_date, or either date is malformed.',
      recovery: 'Provide valid YYYY-MM-DD dates where start_date is on or before end_date.',
    },
    {
      reason: 'invalid_category',
      code: JsonRpcErrorCode.ValidationError,
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

    // Validate dates: shape first, then real-calendar-date (rejects overflow days
    // like 2024-02-30 that the shape regex accepts but no calendar holds), then range.
    if (!DATE_REGEX.test(input.start_date) || !DATE_REGEX.test(input.end_date)) {
      throw ctx.fail('invalid_date_range', 'Date must be in YYYY-MM-DD format.', {
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    if (!isValidCalendarDate(input.start_date) || !isValidCalendarDate(input.end_date)) {
      throw ctx.fail('invalid_date_range', 'Date must be a real calendar date (YYYY-MM-DD).', {
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

    // Validate category — trim before checking, and validate against the target server(s)
    const trimmedCategory = input.category?.trim();
    if (trimmedCategory) {
      const service = getBiorxivApiService();
      if (!service.isValidCategory(trimmedCategory, input.server)) {
        const serverLabel = input.server === 'both' ? 'bioRxiv or medRxiv' : input.server;
        throw ctx.fail(
          'invalid_category',
          `Category "${trimmedCategory}" is not valid for ${serverLabel}.`,
          { ...ctx.recoveryFor('invalid_category') },
        );
      }
    }

    const service = getBiorxivApiService();
    const category = trimmedCategory || undefined;

    type PaginationEntry = {
      cursor: number;
      total: number;
      nextCursor?: number;
    };

    const pagination: {
      biorxiv?: PaginationEntry;
      medrxiv?: PaginationEntry;
    } = {};

    function toPaginationEntry(r: {
      pagination: { cursor: number; total: number };
      preprints: PreprintRevision[];
    }): PaginationEntry {
      const nextCursor =
        r.pagination.cursor + r.preprints.length < r.pagination.total
          ? r.pagination.cursor + 30
          : undefined;
      return { ...r.pagination, ...(nextCursor !== undefined && { nextCursor }) };
    }

    let allPreprints: PreprintRevision[] = [];

    // When server="both" and a category is given, check membership per-server once.
    // A category that exists in only one taxonomy (inBx !== inMx) collapses the
    // request onto that server alone — querying the other would return an
    // unfiltered page mixed in with the filtered one under a filtered-looking
    // request. Shared categories (Epidemiology, Pathology) and no-category
    // requests still fan out to both servers.
    const inBx =
      input.server === 'both' && !!category && service.isValidCategory(category, 'biorxiv');
    const inMx =
      input.server === 'both' && !!category && service.isValidCategory(category, 'medrxiv');
    const exclusiveServer: BiorxivServer | undefined =
      inBx === inMx ? undefined : inBx ? 'biorxiv' : 'medrxiv';

    if (input.server === 'both' && category && exclusiveServer) {
      ctx.enrich({
        categoryNote:
          exclusiveServer === 'biorxiv'
            ? `Category "${category}" is specific to bioRxiv — only bioRxiv was queried. medRxiv was not included because its taxonomy has no such category.`
            : `Category "${category}" is specific to medRxiv — only medRxiv was queried. bioRxiv was not included because its taxonomy has no such category.`,
      });
    }

    if (exclusiveServer) {
      // "both" request with a server-exclusive category → query only the owning
      // server, so the page never mixes filtered with unfiltered records.
      const r = await service.getListing(
        exclusiveServer,
        input.start_date,
        input.end_date,
        input.cursor,
        category,
        ctx,
      );
      pagination[exclusiveServer] = toPaginationEntry(r);
      allPreprints = r.preprints;
    } else if (input.server === 'both') {
      // Fan out to both servers. Any category here is shared by both taxonomies,
      // so it applies to each; with no category both return unfiltered pages.
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
        pagination.biorxiv = toPaginationEntry(bxResult.value);
        allPreprints.push(...bxResult.value.preprints);
      } else {
        ctx.log.warning('bioRxiv listing failed', { error: String(bxResult.reason) });
      }

      if (mxResult.status === 'fulfilled') {
        pagination.medrxiv = toPaginationEntry(mxResult.value);
        allPreprints.push(...mxResult.value.preprints);
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
      pagination[input.server] = toPaginationEntry(r);
      allPreprints = r.preprints;
    }

    if (allPreprints.length === 0) {
      // Detect cursor-overshoot: cursor > 0 but zero results — filters are fine, cursor is past the end
      if (input.cursor > 0) {
        ctx.enrich.notice(
          `Cursor ${input.cursor} is past the last available page for this date/filter combination. Set cursor to a lower offset.`,
        );
        return { preprints: [], pagination };
      }
      const filterDesc = [
        `dates ${input.start_date}–${input.end_date}`,
        category ? `category "${category}"` : null,
        input.server !== 'both' ? `server "${input.server}"` : null,
      ]
        .filter(Boolean)
        .join(', ');
      ctx.enrich.notice(
        `No preprints found for ${filterDesc}. Try widening the date range or removing the category filter.`,
      );
      return { preprints: [], pagination };
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

    if (result.preprints.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push(`\n## Preprints (${result.preprints.length} shown)`);
    for (const p of result.preprints) {
      lines.push('');
      lines.push(formatPreprint(p as PreprintRevision));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
