/**
 * @fileoverview biorxiv_list_published_versions tool — lists the preprints
 * that appeared as journal articles within a journal publication-date
 * interval, each as the crosswalk record biorxiv_get_published_version returns
 * for one DOI. The interval filters on the journal's publication date, so most
 * rows were posted as preprints months or years before it — the rows
 * biorxiv_list_recent, which filters on posting date, never reaches.
 *
 * Fans out to bioRxiv and medRxiv when server="both", with one input cursor
 * and per-server pagination state: the servers hold different row counts, so
 * one cursor can be inside one server's rows and past the end of the other's.
 * The API serves 100 rows a page and takes no size parameter, so each server
 * returns the first `limit` rows (default 25) of its page, sliced in the
 * service before rows are normalized, and nextCursor advances by the upstream
 * rows served; a limit above 100 serves the whole page and says so. Upstream
 * answers an empty interval and a cursor at or past the last row identically —
 * "no articles found", no total — so dates are validated before any call, a
 * zero-row page at cursor 0 reports total 0, and one at a later cursor is
 * flagged exhausted with no total rather than claiming the interval is empty.
 *
 * A server that did not answer is named in failed[] and the notice; when no
 * server answered the call raises a retryable error instead of an empty page.
 * Abstracts are about three quarters of a page and are omitted unless
 * include_abstract is true; nothing else in a record changes.
 * @module mcp-server/tools/definitions/biorxiv-list-published-versions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type {
  BiorxivServer,
  PublishedListingResult,
  PublishedVersion,
} from '@/services/biorxiv/types.js';
import {
  describeWait,
  escapeMarkdown,
  findRateLimit,
  isValidCalendarDate,
  startCallDeadline,
} from '@/services/shared.js';

const SERVERS = ['biorxiv', 'medrxiv'] as const;
const SERVER_LABEL = { biorxiv: 'bioRxiv', medrxiv: 'medRxiv' } as const;

/** Rows api.biorxiv.org serves per `/pubs` interval page — the most one call can return per server. */
const UPSTREAM_PAGE_ROWS = 100;

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Human-facing server names for a notice sentence: "bioRxiv and medRxiv". */
function serverLabels(servers: readonly BiorxivServer[]): string {
  return servers.map((s) => SERVER_LABEL[s]).join(' and ');
}

type Publication = PublishedVersion & { server: BiorxivServer };

// Upstream free text is escaped as it is interpolated so it renders literally —
// the abstract opens its own line, where `1. ` would start a list. DOIs stay
// raw because agents copy them back into calls.
function formatPublication(p: Publication): string {
  const lines: string[] = [];
  lines.push(`### ${p.preprintTitle ? escapeMarkdown(p.preprintTitle) : p.preprintDoi}`);
  lines.push(`**Preprint DOI:** ${p.preprintDoi}`);
  lines.push(`**Server:** ${p.server}`);
  if (p.publishedDoi) lines.push(`**Published DOI:** ${p.publishedDoi}`);
  if (p.publishedJournal) lines.push(`**Journal:** ${escapeMarkdown(p.publishedJournal)}`);
  if (p.publishedDate) lines.push(`**Published Date:** ${p.publishedDate}`);
  if (p.preprintDate) lines.push(`**Preprint Date:** ${p.preprintDate}`);
  if (p.preprintCategory) lines.push(`**Category:** ${escapeMarkdown(p.preprintCategory)}`);
  if (p.preprintAuthors) lines.push(`**Authors:** ${escapeMarkdown(p.preprintAuthors)}`);
  if (p.preprintAuthorCorresponding)
    lines.push(`**Corresponding Author:** ${escapeMarkdown(p.preprintAuthorCorresponding)}`);
  if (p.preprintAuthorCorrespondingInstitution)
    lines.push(`**Institution:** ${escapeMarkdown(p.preprintAuthorCorrespondingInstitution)}`);
  if (p.preprintAbstract) lines.push(`\n${escapeMarkdown(p.preprintAbstract)}`);
  return lines.join('\n');
}

const paginationEntry = (label: string) =>
  z
    .object({
      cursor: z.number().describe('Cursor (row offset) this page was requested at.'),
      total: z
        .number()
        .optional()
        .describe(
          `Journal publications on ${label} in the interval. Absent only when the entry is exhausted: ${label} reports no total for a cursor past its last row.`,
        ),
      nextCursor: z
        .number()
        .optional()
        .describe(
          `Cursor for the next page, when rows remain on ${label} past this one: this page's cursor plus the rows it served. Pass it as cursor to continue, at any limit.`,
        ),
      exhausted: z
        .boolean()
        .optional()
        .describe(
          `True when the cursor is at or past ${label}'s last row: no rows came back at a non-zero cursor. Lower the cursor to page ${label}.`,
        ),
    })
    .optional()
    .describe(`${label} pagination state. Present when ${label} was queried and answered.`);

export const biorxivListPublishedVersionsTool = tool('biorxiv_list_published_versions', {
  title: 'List Published Journal Versions',
  description:
    'List preprints that appeared as journal articles within a journal publication-date interval, each with its journal DOI, journal name, publication date, and preprint metadata — the same record biorxiv_get_published_version returns for one DOI. The dates filter on journal publication, not preprint posting, so most rows were posted months or years earlier; use biorxiv_list_recent for preprints posted in an interval. Returns `limit` publications per server (default 25, up to 100 — the page api.biorxiv.org serves; a larger limit returns 100 and says so). Continue at the `nextCursor` a page returns rather than stepping `cursor` by a fixed amount; `limit: 100` walks an interval in the fewest calls. When server="both" (default), per-server pagination state is returned separately, since one cursor can be past the end of one server and inside the other — to continue a single server, pass its `nextCursor` with `server` set to that server. One server failing under server="both" does not abort the call: the other server\'s page is still returned and the failed one is named in `failed[]`. Every attempted server failing raises a retryable upstream_unavailable (or rate_limited) error rather than an empty page. Abstracts are omitted by default to keep the page small — pass include_abstract: true for the whole page. Every preprintDoi, 10.1101/ and 10.64898/ alike, is accepted by biorxiv_get_preprint and the other DOI tools.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  // biorxiv_search_preprints spells its date bounds date_from / date_to.
  inputAliases: { date_from: 'start_date', date_to: 'end_date' },

  input: z.object({
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Start of the journal publication-date interval (YYYY-MM-DD), inclusive.'),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('End of the journal publication-date interval (YYYY-MM-DD), inclusive.'),
    server: z
      .enum(['biorxiv', 'medrxiv', 'both'])
      .default('both')
      .describe(
        'Preprint server to list. "both" lists bioRxiv and medRxiv in parallel; their rows do not overlap.',
      ),
    cursor: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Integer row offset, applied to each queried server. Defaults to 0 (first page). To continue, pass the nextCursor the previous page returned for that server — it advances by the rows actually served.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(25)
      .describe(
        'Rows to return per queried server, starting at cursor. Defaults to 25. Up to 100, the page api.biorxiv.org serves: a larger value returns 100 rows per server and says so in the notice. limit: 100 walks an interval in the fewest calls.',
      ),
    include_abstract: z
      .boolean()
      .default(false)
      .describe(
        "Include each preprint's abstract. Defaults to false: abstracts make up about three quarters of a page, and every other field is returned either way.",
      ),
  }),

  output: z.object({
    publications: z
      .array(
        z
          .object({
            server: z
              .enum(['biorxiv', 'medrxiv'])
              .describe('Preprint server that listed this publication.'),
            preprintDoi: z
              .string()
              .describe('Preprint DOI — input to biorxiv_get_preprint and the other DOI tools.'),
            publishedDoi: z.string().optional().describe('Journal article DOI.'),
            publishedJournal: z.string().optional().describe('Name of the publishing journal.'),
            publishedDate: z
              .string()
              .optional()
              .describe('Journal publication date (YYYY-MM-DD), within the requested interval.'),
            preprintDate: z
              .string()
              .optional()
              .describe(
                'Preprint posting date (YYYY-MM-DD) as this row records it — the first posting for most preprints. medRxiv lists some 10.64898/ preprints on two rows that differ in this date, and sometimes in title or authors; both rows are returned. Not derivable from the DOI.',
              ),
            preprintTitle: z.string().optional().describe('Title of the preprint.'),
            preprintAuthors: z.string().optional().describe('Preprint author list.'),
            preprintCategory: z.string().optional().describe('Subject category.'),
            preprintAuthorCorresponding: z
              .string()
              .optional()
              .describe('Corresponding author name.'),
            preprintAuthorCorrespondingInstitution: z
              .string()
              .optional()
              .describe('Corresponding author institution.'),
            preprintAbstract: z
              .string()
              .optional()
              .describe('Preprint abstract. Present only when include_abstract is true.'),
          })
          .describe('One preprint and the journal article it became.'),
      )
      .describe(
        'Publications in the interval, in upstream order: bioRxiv rows first, then medRxiv rows.',
      ),
    pagination: z
      .object({
        biorxiv: paginationEntry('bioRxiv'),
        medrxiv: paginationEntry('medRxiv'),
      })
      .describe('Per-server pagination state. Advance each server independently.'),
    failed: z
      .array(
        z
          .object({
            server: z.enum(['biorxiv', 'medrxiv']).describe('Server whose request failed.'),
            error: z.string().describe('What went wrong on that server.'),
          })
          .describe('A server that did not answer.'),
      )
      .describe(
        'Servers that did not answer, so their rows are missing from "publications" and they have no "pagination" entry. Non-empty means this result set is partial — retry to include them. Only populated under server="both", and never holding every attempted server: when none answered, the call fails with upstream_unavailable or rate_limited instead. Distinct from an exhausted pagination entry, where the server answered.',
      ),
  }),

  // Agent-facing context on the success path. Populated via ctx.enrich so it
  // reaches both structuredContent and content[]; never rides in the domain return.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on how to read this result set: which servers did not answer, a limit above the 100-row page, which cursors are past the end, which servers have rows past this page, and — when nothing came back — the interval and how to broaden it. All applicable qualifications are composed into one string.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        "True when at least one server has rows past this page — continue at that server's nextCursor. Absent when every server queried is on its last page.",
      ),
    shown: z
      .number()
      .optional()
      .describe('Publications on this page, across every server queried. Set with truncated.'),
    cap: z
      .number()
      .optional()
      .describe(
        'Most publications this page can hold: rows per server (limit, or 100 when limit asked for more) times the servers queried. Set with truncated.',
      ),
  },

  errors: [
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date or end_date is not a real calendar date (2024-02-30, 2024-13-01), or end_date is before start_date.',
      recovery:
        'Provide valid YYYY-MM-DD journal publication dates where start_date is on or before end_date.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'Every attempted server failed against api.biorxiv.org, so no page was retrieved and an empty interval could not be established.',
      recovery:
        'Retry the request after a short delay — the interval may well hold publications; api.biorxiv.org did not answer.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      when: 'Every attempted server failed and at least one was rejected with HTTP 429 by api.biorxiv.org.',
      recovery:
        'Wait the retryAfter seconds when present, otherwise a minute or two, before retrying — every preprint metadata tool queries the same origin, so none of them will answer sooner.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_list_published_versions', {
      start_date: input.start_date,
      end_date: input.end_date,
      server: input.server,
      cursor: input.cursor,
      limit: input.limit,
    });

    // Upstream answers a malformed or inverted interval with HTTP 200 and an
    // empty page. The schema holds both bounds to YYYY-MM-DD; what it cannot
    // see is a real calendar date (2024-02-30 has the shape) or the order.
    if (!isValidCalendarDate(input.start_date) || !isValidCalendarDate(input.end_date)) {
      throw ctx.fail('invalid_date_range', 'Date must be a real calendar date (YYYY-MM-DD).');
    }
    if (input.start_date > input.end_date) {
      throw ctx.fail(
        'invalid_date_range',
        `start_date (${input.start_date}) must be on or before end_date (${input.end_date}).`,
      );
    }

    const service = getBiorxivApiService();
    const deadline = startCallDeadline();
    const servers: readonly BiorxivServer[] = input.server === 'both' ? SERVERS : [input.server];
    const limit = Math.min(input.limit, UPSTREAM_PAGE_ROWS);
    const settled = await Promise.allSettled(
      servers.map((server) =>
        service.getPublishedListing(
          server,
          input.start_date,
          input.end_date,
          input.cursor,
          limit,
          deadline,
          ctx,
        ),
      ),
    );
    // A cancelled call is not a partial result, whichever leg the abort reached first.
    ctx.signal.throwIfAborted();

    type PaginationEntry = {
      cursor: number;
      total?: number;
      nextCursor?: number;
      exhausted?: true;
    };
    const pagination: Partial<Record<BiorxivServer, PaginationEntry>> = {};
    const failed: { server: BiorxivServer; error: string }[] = [];
    const rejections: unknown[] = [];
    let publications: Publication[] = [];

    // Counted in upstream rows, never the normalized ones: the service drops a
    // row naming no preprint, and the next page still starts past it. Zero rows
    // at a non-zero cursor means the cursor reached this server's end, where
    // upstream reports no total; at cursor 0 the interval is empty.
    let upstreamRows = 0;
    function toPaginationEntry({ pagination: p, rowCount }: PublishedListingResult) {
      upstreamRows += rowCount;
      if (rowCount === 0) {
        return p.cursor > 0 ? { cursor: p.cursor, exhausted: true as const } : { ...p, total: 0 };
      }
      const next = p.cursor + rowCount;
      return { ...p, ...(p.total !== undefined && next < p.total && { nextCursor: next }) };
    }

    for (const [i, result] of settled.entries()) {
      const server = servers[i] as BiorxivServer;
      if (result.status === 'rejected') {
        ctx.log.warning(`${SERVER_LABEL[server]} publication listing failed`, {
          error: String(result.reason),
        });
        failed.push({ server, error: errorMessage(result.reason) });
        rejections.push(result.reason);
        continue;
      }
      pagination[server] = toPaginationEntry(result.value);
      publications.push(...result.value.publications.map((p) => ({ ...p, server })));
    }

    // Nothing answered: an empty page here would be indistinguishable from an
    // interval that holds no publications.
    if (failed.length === servers.length) {
      const message =
        servers.length > 1
          ? `Neither bioRxiv nor medRxiv answered — ${failed.map((f) => `${SERVER_LABEL[f.server]}: ${f.error}`).join('; ')}`
          : `${SERVER_LABEL[failed[0]?.server as BiorxivServer]} did not answer — ${failed[0]?.error}`;
      const failedServers = failed.map((f) => f.server);
      // A rate limit outranks a generic outage: only it says when to retry.
      const rateLimit = findRateLimit(rejections);
      if (rateLimit) {
        throw ctx.fail(
          'rate_limited',
          message,
          {
            servers: failedServers,
            ...(rateLimit.retryAfter !== undefined && { retryAfter: rateLimit.retryAfter }),
            recovery: {
              hint: `Wait ${describeWait(rateLimit.retryAfter)} before retrying — api.biorxiv.org is rate-limiting this host, and every preprint metadata tool queries the same origin.`,
            },
          },
          { cause: rejections[0] },
        );
      }
      throw ctx.fail(
        'upstream_unavailable',
        message,
        { servers: failedServers },
        { cause: rejections[0] },
      );
    }

    // ctx.enrich.notice is last-wins, so every qualification is collected first.
    const notices: string[] = [];
    if (failed.length > 0) {
      const labels = serverLabels(failed.map((f) => f.server));
      notices.push(
        `${labels} did not answer, so this result set is partial — it holds no ${labels} publications. See failed[] for the error and retry to include them.`,
      );
    }
    if (input.limit > UPSTREAM_PAGE_ROWS) {
      notices.push(
        `A limit of ${input.limit} is above the ${UPSTREAM_PAGE_ROWS}-row page api.biorxiv.org serves, so this page holds up to ${UPSTREAM_PAGE_ROWS} rows per server.`,
      );
    }

    const exhausted = SERVERS.filter((s) => pagination[s]?.exhausted);
    if (upstreamRows === 0) {
      notices.push(
        input.cursor > 0
          ? `Cursor ${input.cursor} is at or past the last row for this interval${failed.length > 0 ? ' on the servers that answered' : ''}. Set cursor to a lower offset.`
          : `No journal publications found for publication dates ${input.start_date}–${input.end_date}${input.server === 'both' ? '' : ` on ${SERVER_LABEL[input.server]}`}. Try widening the date range, or use biorxiv_list_recent to list preprints by posting date instead.`,
      );
    } else if (exhausted.length > 0) {
      notices.push(
        `Cursor ${input.cursor} is at or past the last row on ${serverLabels(exhausted)} — that entry is marked exhausted and carries no total. Lower the cursor to page that server.`,
      );
    }

    const continuing = SERVERS.filter((s) => pagination[s]?.nextCursor !== undefined);
    if (continuing.length > 0) {
      const where = continuing
        .map((s) => `${SERVER_LABEL[s]} (next cursor ${pagination[s]?.nextCursor})`)
        .join(' and ');
      // Kept at "both", a server already on its last page is re-requested on every
      // later page. A failed server is the exception: retrying "both" includes it.
      const [only] = continuing;
      const how =
        servers.length > 1 && failed.length === 0 && continuing.length === 1
          ? `pass that nextCursor as cursor with server set to "${only}" to continue it`
          : "pass a server's nextCursor as cursor to continue it";
      notices.push(`More rows remain past this page on ${where} — ${how}.`);
      // truncated() writes the notice too, so it carries the composed string.
      ctx.enrich.truncated({
        shown: publications.length,
        cap: limit * servers.length,
        guidance: notices.join(' '),
      });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    if (!input.include_abstract) {
      publications = publications.map(({ preprintAbstract: _abstract, ...rest }) => rest);
    }
    return { publications, pagination, failed };
  },

  format: (result) => {
    const lines: string[] = [];

    for (const server of SERVERS) {
      const p = result.pagination[server];
      if (!p) continue;
      let line = `**${SERVER_LABEL[server]}:** page offset ${p.cursor}`;
      if (p.total !== undefined) line += `, total ${p.total}`;
      if (p.nextCursor !== undefined) line += ` — next cursor: ${p.nextCursor}`;
      if (p.exhausted)
        line +=
          ' — cursor exhausted: at or past the last row, so no rows and no total at this offset';
      if (p.nextCursor === undefined && !p.exhausted) line += ' (last page)';
      lines.push(line);
    }

    // A failed server has no pagination line of its own; its silent absence is
    // what would make a partial result look complete.
    for (const f of result.failed) {
      lines.push(
        `**${SERVER_LABEL[f.server]}:** server did not answer — no publications from it are included (${f.error})`,
      );
    }

    if (result.publications.length > 0) {
      lines.push(`\n## Journal publications (${result.publications.length} shown)`);
      for (const p of result.publications) {
        lines.push('');
        lines.push(formatPublication(p as Publication));
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
