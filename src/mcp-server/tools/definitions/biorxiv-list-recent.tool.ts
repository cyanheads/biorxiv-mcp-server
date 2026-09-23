/**
 * @fileoverview biorxiv_list_recent tool — lists preprints posted or revised
 * within a date interval. Fans out to both bioRxiv and medRxiv when
 * server="both". Category filtering is applied server-side via the ?category=
 * query param, in the API's lowercase spelling. The API answers a category it
 * does not filter on with its unfiltered listing (echoing category "all"), so
 * such a leg is dropped with a notice, and a call left with no filtered page
 * raises invalid_category. A funder filter (a ROR ID, normalized and
 * checksum-validated before any call) is sent alongside category; only bioRxiv
 * records carry funder data, so it narrows server="both" to bioRxiv with a
 * notice and is rejected with server="medrxiv". An ID the API holds no funder
 * record for raises invalid_funder rather than reading as an empty page.
 * Returns 30 results per page (API-fixed); use cursor to paginate. Abstracts
 * are about three quarters of a page and a listing is read for its titles and
 * metadata, so they are omitted unless include_abstract is true; nothing else
 * in a record changes.
 * When server="both", per-server pagination state is surfaced independently,
 * including per-server cursor exhaustion: the two servers hold different result
 * counts, so one cursor can be valid for one and past the end for the other.
 * The API reports total 0 for an out-of-range cursor, so an exhausted entry is
 * flagged rather than left to read as "this server has nothing in the interval".
 * A server that never answered is a separate condition: it has no pagination
 * state at all, so it is named in failed[] and in the notice rather than
 * dropped, which would leave a partial result reading as a complete one.
 * When NO server answered there is nothing to qualify — an empty page is a
 * claim about what the servers reported, and none of them reported — so the
 * call raises a retryable error instead of returning an empty success, which a
 * caller branching on success-vs-error cannot tell from an empty interval.
 * @module mcp-server/tools/definitions/biorxiv-list-recent.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type { BiorxivServer, PreprintRevision, ServerParam } from '@/services/biorxiv/types.js';
import {
  describeWait,
  escapeMarkdown,
  findRateLimit,
  isValidCalendarDate,
  normalizeRorId,
} from '@/services/shared.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const SERVERS = ['biorxiv', 'medrxiv'] as const;
const SERVER_LABEL = { biorxiv: 'bioRxiv', medrxiv: 'medRxiv' } as const;

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Human-facing server names for a notice sentence: "bioRxiv and medRxiv". */
function serverLabels(servers: readonly BiorxivServer[]): string {
  return servers.map((s) => SERVER_LABEL[s]).join(' and ');
}

// Upstream free text is escaped as it is interpolated so it renders literally —
// the abstract opens its own line, where `1. ` would start a list. DOIs and
// URLs stay raw because agents copy them back into calls.
function formatPreprint(p: PreprintRevision): string {
  const lines: string[] = [];
  lines.push(`### ${p.title ? escapeMarkdown(p.title) : p.doi}`);
  lines.push(`**DOI:** ${p.doi}`);
  if (p.date) lines.push(`**Date:** ${p.date}`);
  if (p.version) lines.push(`**Version:** ${p.version}`);
  if (p.type) lines.push(`**Type:** ${escapeMarkdown(p.type)}`);
  if (p.server) lines.push(`**Server:** ${p.server}`);
  if (p.category) lines.push(`**Category:** ${escapeMarkdown(p.category)}`);
  if (p.license) lines.push(`**License:** ${escapeMarkdown(p.license)}`);
  if (p.authors) lines.push(`**Authors:** ${escapeMarkdown(p.authors)}`);
  if (p.authorCorresponding)
    lines.push(`**Corresponding:** ${escapeMarkdown(p.authorCorresponding)}`);
  if (p.authorCorrespondingInstitution)
    lines.push(`**Institution:** ${escapeMarkdown(p.authorCorrespondingInstitution)}`);
  if (p.awards) lines.push(`**Awards:** ${escapeMarkdown(p.awards.join('; '))}`);
  if (p.jatsxmlUrl) lines.push(`**JATS XML:** ${p.jatsxmlUrl}`);
  if (p.publishedJournalDoi) lines.push(`**Published DOI:** ${p.publishedJournalDoi}`);
  if (p.abstract) lines.push(`\n${escapeMarkdown(p.abstract)}`);
  return lines.join('\n');
}

export const biorxivListRecentTool = tool('biorxiv_list_recent', {
  title: 'List Recent Preprints',
  description:
    'List preprints posted or revised within a date interval, optionally scoped to one server or a subject category. Returns 30 preprints per page (fixed by the API); pass `cursor` as an integer offset (0, 30, 60, …) to step through additional pages. Abstracts are omitted by default to keep the page small — pass include_abstract: true for the whole page, or call biorxiv_get_preprint (up to 10 DOIs per call) for a few. When server="both" (default), per-server pagination state is returned separately — use each server\'s `cursor` field for independent advancement. One server failing under server="both" does not abort the call: the other server\'s page is still returned and the failed one is named in `failed[]`, marking the result set as partial rather than complete. Every attempted server failing is a different case and does abort the call, with a retryable upstream_unavailable (or rate_limited) error — an empty page would otherwise be indistinguishable from an interval that genuinely holds nothing. Call biorxiv_list_categories for valid category strings; a server that answers a category filter with its unfiltered listing is left out with a notice, and invalid_category is raised when no server applied it. `funder` limits the listing to bioRxiv preprints funded by that organization, given its ROR ID; an ID api.biorxiv.org has no funder record for raises invalid_funder rather than returning an empty page.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  // biorxiv_search_preprints spells its date bounds date_from / date_to.
  inputAliases: { date_from: 'start_date', date_to: 'end_date' },

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
        'Subject category filter, matched case-insensitively with "_" and "-" read as a space — "Cell Biology", "cell biology", "cell_biology", and "cell-biology" are the same filter. Use biorxiv_list_categories for valid values.',
      ),
    funder: z
      .string()
      .optional()
      .describe(
        'Funder filter: the funder\'s ROR ID, bare ("021nxhr62" for the US National Science Foundation) or as a URL ("https://ror.org/021nxhr62"). bioRxiv only — medRxiv records carry no funder data, so server="both" queries bioRxiv alone and server="medrxiv" is rejected. Combines with category. Look the ID up by name at ror.org.',
      ),
    cursor: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Integer page offset (0, 30, 60, …). Defaults to 0 (first page).'),
    include_abstract: z
      .boolean()
      .default(false)
      .describe(
        "Include each preprint's abstract. Defaults to false: abstracts make up about three quarters of a page, and every other field is returned either way.",
      ),
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
            abstract: z
              .string()
              .optional()
              .describe('Abstract text. Present only when include_abstract is true.'),
            awards: z
              .array(z.string().describe('One award value as upstream records it.'))
              .optional()
              .describe(
                'Grant award numbers from the funding statement, verbatim and deduplicated — one value can hold several grants run together without a separator. Absent when none. Funder names are not included: api.biorxiv.org attributes them to unrelated organizations.',
              ),
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
            exhausted: z
              .boolean()
              .optional()
              .describe(
                'True when this cursor is past bioRxiv\'s last page: no records came back at a non-zero cursor. The API reports total 0 for an out-of-range cursor, so "total" is not the interval total here — step back to a lower cursor to read it.',
              ),
          })
          .optional()
          .describe('bioRxiv pagination state. Present when server is "biorxiv" or "both".'),
        medrxiv: z
          .object({
            cursor: z.number().describe('Current cursor (offset used for this page).'),
            total: z.number().describe('Total preprints available on medRxiv for these filters.'),
            nextCursor: z.number().optional().describe('Cursor value for the next page, if any.'),
            exhausted: z
              .boolean()
              .optional()
              .describe(
                'True when this cursor is past medRxiv\'s last page: no records came back at a non-zero cursor. The API reports total 0 for an out-of-range cursor, so "total" is not the interval total here — step back to a lower cursor to read it.',
              ),
          })
          .optional()
          .describe(
            'medRxiv pagination state. Present when server is "medrxiv" or "both", except under a funder filter, which queries bioRxiv only.',
          ),
      })
      .describe('Per-server pagination state. Advance each server independently.'),
    failed: z
      .array(
        z
          .object({
            server: z.enum(['biorxiv', 'medrxiv']).describe('Server whose listing request failed.'),
            error: z.string().describe('What went wrong on that server.'),
          })
          .describe('A server that did not answer.'),
      )
      .describe(
        'Servers that did not answer, so their records are missing from "preprints" and they have no "pagination" entry. Non-empty means this result set is partial — retry to include them. Only populated when server="both", and never holding every attempted server: when none answered, the call fails with upstream_unavailable or rate_limited instead of returning a page. A single-server failure likewise surfaces as a tool error. Distinct from an exhausted pagination entry, where the server answered.',
      ),
  }),

  // Agent-facing context on the success path — recovery guidance for empty results and
  // per-server taxonomy routing notes. Populated via ctx.enrich so it reaches both
  // structuredContent and content[]; never rides in the domain return.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on how to read this result set: which servers did not answer, which ignored the category filter (their unfiltered records are left out), that a funder filter limited server="both" to bioRxiv, which cursors are past the end, and — when nothing came back — the applied filters and how to broaden them. All applicable qualifications are composed into one string.',
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
      when: "The category is not in the requested server's taxonomy, or api.biorxiv.org ignored it and returned the unfiltered listing on every server that answered.",
      recovery: 'Call biorxiv_list_categories to get valid category strings and retry.',
    },
    {
      reason: 'invalid_funder',
      code: JsonRpcErrorCode.ValidationError,
      when: 'funder is not a well-formed ROR ID (pattern or checksum), is combined with server="medrxiv", or is a ROR ID api.biorxiv.org has no funder record for.',
      recovery:
        'Look up the funder by name at ror.org and pass its ROR ID, bare (021nxhr62) or as https://ror.org/021nxhr62, with server "biorxiv" or "both".',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'Every attempted server failed against api.biorxiv.org, so no page was retrieved and an empty interval could not be established.',
      recovery:
        'Retry the request after a short delay — the interval may well hold preprints; api.biorxiv.org did not answer.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      when: 'Every attempted server failed and at least one was rejected with HTTP 429 by api.biorxiv.org.',
      recovery:
        'Wait the retryAfter seconds before retrying — every preprint metadata tool queries the same origin, so none of them will answer sooner.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_list_recent', {
      start_date: input.start_date,
      end_date: input.end_date,
      server: input.server,
      cursor: input.cursor,
      category: input.category,
      funder: input.funder,
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

    // Validate funder before any call. The API takes only the bare 9-character ROR
    // ID, and a mistyped one fails its checksum here rather than upstream.
    const funderInput = input.funder?.trim();
    const funder = funderInput ? normalizeRorId(funderInput) : undefined;
    if (funderInput && !funder) {
      throw ctx.fail(
        'invalid_funder',
        `"${funderInput}" is not a valid ROR ID — expected 9 characters: 0, six letters or digits, and two checksum digits (e.g. 021nxhr62), bare or after https://ror.org/.`,
        { funder: funderInput, ...ctx.recoveryFor('invalid_funder') },
      );
    }
    if (funder && input.server === 'medrxiv') {
      throw ctx.fail(
        'invalid_funder',
        'The funder filter applies to bioRxiv only — medRxiv records carry no funder data, so a medRxiv funder listing is always empty.',
        {
          funder,
          recovery: {
            hint: 'Set server to "biorxiv" or "both" (which queries bioRxiv alone under a funder filter), or omit funder to list medRxiv.',
          },
        },
      );
    }
    // Only bioRxiv carries funder data, so a funder filter narrows "both" to bioRxiv.
    const target: ServerParam = funder && input.server === 'both' ? 'biorxiv' : input.server;

    // Validate category — trim before checking, and validate against the target server(s)
    const service = getBiorxivApiService();
    const category = input.category?.trim() || undefined;
    if (category && !service.isValidCategory(category, target)) {
      const serverLabel = target === 'both' ? 'bioRxiv or medRxiv' : target;
      const scope = target === input.server ? '' : ' (a funder filter queries bioRxiv only)';
      throw ctx.fail(
        'invalid_category',
        `Category "${category}" is not valid for ${serverLabel}${scope}.`,
        { ...ctx.recoveryFor('invalid_category') },
      );
    }
    const filters = { category, funder };

    type PaginationEntry = {
      cursor: number;
      total: number;
      nextCursor?: number;
      exhausted?: boolean;
    };

    const pagination: {
      biorxiv?: PaginationEntry;
      medrxiv?: PaginationEntry;
    } = {};

    const failed: { server: BiorxivServer; error: string }[] = [];
    // Raw rejection values alongside failed[], so the all-failed branch can tell
    // a rate limit from a generic outage and preserve the original as `cause`.
    const rejections: unknown[] = [];

    // ctx.enrich.notice is last-wins, so every qualification that applies to this
    // result set is collected here and flushed as one string before returning.
    const notices: string[] = [];

    // The absent medRxiv entry needs the same explanation a server-exclusive
    // category gets, or it reads as medRxiv having been skipped by accident.
    if (target !== input.server) {
      notices.push(
        'The funder filter applies to bioRxiv only — medRxiv records carry no funder data — so only bioRxiv was queried and there is no medRxiv pagination entry.',
      );
    }

    function toPaginationEntry(r: {
      pagination: { cursor: number; total: number };
      preprints: PreprintRevision[];
    }): PaginationEntry {
      const nextCursor =
        r.pagination.cursor + r.preprints.length < r.pagination.total
          ? r.pagination.cursor + 30
          : undefined;
      // Zero records at a non-zero cursor means the cursor overshot this server's
      // last page; the API's total 0 for that request is an artifact, not a count.
      const exhausted = r.preprints.length === 0 && r.pagination.cursor > 0;
      return {
        ...r.pagination,
        ...(nextCursor !== undefined && { nextCursor }),
        ...(exhausted && { exhausted }),
      };
    }

    let allPreprints: PreprintRevision[] = [];

    // The API answers a category it does not filter on with its unfiltered
    // listing, echoing category "all". That page is never returned as filtered:
    // a leg that did so is dropped, and a call left with no filtered page fails.
    const ignoredCategory = (servers: BiorxivServer[]) =>
      ctx.fail(
        'invalid_category',
        `api.biorxiv.org ignored category "${category}" on ${serverLabels(servers)} and returned its unfiltered listing, so no filtered page is available.`,
        {
          category,
          servers,
          recovery: {
            hint: `Omit category to page the unfiltered listing, or pick a different category from biorxiv_list_categories — api.biorxiv.org is not filtering on "${category}".`,
          },
        },
      );

    // When server="both" and a category is given, check membership per-server once.
    // A category that exists in only one taxonomy (inBx !== inMx) collapses the
    // request onto that server alone — querying the other would return an
    // unfiltered page mixed in with the filtered one under a filtered-looking
    // request. Shared categories (Pathology) and no-category requests still fan
    // out to both servers.
    const inBx = target === 'both' && !!category && service.isValidCategory(category, 'biorxiv');
    const inMx = target === 'both' && !!category && service.isValidCategory(category, 'medrxiv');
    const exclusiveServer: BiorxivServer | undefined =
      inBx === inMx ? undefined : inBx ? 'biorxiv' : 'medrxiv';

    if (target === 'both' && category && exclusiveServer) {
      ctx.enrich({
        categoryNote:
          exclusiveServer === 'biorxiv'
            ? `Category "${category}" is specific to bioRxiv — only bioRxiv was queried. medRxiv was not included because its taxonomy has no such category.`
            : `Category "${category}" is specific to medRxiv — only medRxiv was queried. bioRxiv was not included because its taxonomy has no such category.`,
      });
    }

    // One leg: an explicit server, or a "both" request collapsed onto bioRxiv by a
    // funder filter or onto the server owning a server-exclusive category.
    const singleServer = exclusiveServer ?? (target === 'both' ? undefined : target);

    if (singleServer) {
      const r = await service.getListing(
        singleServer,
        input.start_date,
        input.end_date,
        input.cursor,
        filters,
        ctx,
      );
      // No funder record means no filter was applied at all — the empty page
      // says nothing about what the funder posted.
      if (r.funderNotFound) {
        throw ctx.fail(
          'invalid_funder',
          `api.biorxiv.org has no funder record for ROR ID ${funder}, so it cannot filter on it — this is not an empty result.`,
          {
            funder,
            recovery: {
              hint: `Confirm the ROR ID at ror.org and that it names the funding body itself. For a parent organization, try the ROR ID of the member institute that made the award, which api.biorxiv.org may hold on record instead.`,
            },
          },
        );
      }
      if (r.categoryIgnored) throw ignoredCategory([singleServer]);
      pagination[singleServer] = toPaginationEntry(r);
      allPreprints = r.preprints;
    } else {
      // Fan out to both servers. Any category here is shared by both taxonomies,
      // so it applies to each; with no category both return unfiltered pages.
      // A funder filter never reaches this branch — it narrows the call to bioRxiv.
      const settled = await Promise.allSettled(
        SERVERS.map((server) =>
          service.getListing(server, input.start_date, input.end_date, input.cursor, filters, ctx),
        ),
      );

      // Servers that answered but ignored the category filter — their pages are
      // unfiltered, so they are left out rather than mixed in with filtered ones.
      const ignored: BiorxivServer[] = [];
      for (const [i, result] of settled.entries()) {
        const server = SERVERS[i] as BiorxivServer;
        if (result.status === 'rejected') {
          ctx.log.warning(`${SERVER_LABEL[server]} listing failed`, {
            error: String(result.reason),
          });
          failed.push({ server, error: errorMessage(result.reason) });
          rejections.push(result.reason);
        } else if (result.value.categoryIgnored) {
          ctx.log.warning(`${SERVER_LABEL[server]} ignored the category filter`, { category });
          ignored.push(server);
        } else {
          pagination[server] = toPaginationEntry(result.value);
          allPreprints.push(...result.value.preprints);
        }
      }

      // Every server that answered ignored the filter: there is no filtered page
      // to return, and retrying will not produce one.
      if (ignored.length === SERVERS.length) throw ignoredCategory(ignored);

      // Nothing usable came back and at least one server never answered. An
      // empty page here is not a result — it is the absence of one — and a
      // caller branching on success-vs-error cannot tell the two apart from a
      // notice string. Raise the same retryable error the other DOI-resolving
      // tools raise for their own nothing-answered case: the server that failed
      // may still return a filtered page on retry.
      if (failed.length + ignored.length === SERVERS.length) {
        const detail = [
          ...failed.map((f) => `${SERVER_LABEL[f.server]}: ${f.error}`),
          ...ignored.map((s) => `${SERVER_LABEL[s]} ignored the category filter "${category}"`),
        ].join('; ');
        const message =
          ignored.length === 0
            ? `Neither bioRxiv nor medRxiv answered — ${detail}`
            : `No server returned a usable page — ${detail}`;
        const servers = failed.map((f) => f.server);
        // A rate limit outranks a generic outage: both say "retry", but only one
        // says when, and retrying sooner would land inside the same limit.
        const rateLimit = findRateLimit(rejections);
        if (rateLimit) {
          const wait = describeWait(rateLimit.retryAfter);
          throw ctx.fail(
            'rate_limited',
            message,
            {
              servers,
              ...(rateLimit.retryAfter !== undefined && { retryAfter: rateLimit.retryAfter }),
              recovery: {
                hint: `Wait ${wait} before retrying — api.biorxiv.org is rate-limiting this host, and every preprint metadata tool queries the same origin.`,
              },
            },
            { cause: rejections[0] },
          );
        }
        throw ctx.fail(
          'upstream_unavailable',
          message,
          { servers, ...ctx.recoveryFor('upstream_unavailable') },
          { cause: rejections[0] },
        );
      }

      // A server that never answered contributes no pagination entry, so nothing
      // else in the response distinguishes "that server had no preprints" from
      // "that server was never heard from". This is the qualification that changes
      // how every other number here reads, so it leads the notice.
      if (failed.length > 0) {
        const labels = serverLabels(failed.map((f) => f.server));
        notices.push(
          `${labels} did not answer, so this result set is partial — it holds no ${labels} records. See failed[] for the error and retry to include them.`,
        );
      }

      // An ignored filter answered, so it is not in failed[] and a retry will not
      // change it — but its absent pagination entry needs the same explanation.
      if (ignored.length > 0) {
        const labels = serverLabels(ignored);
        notices.push(
          `${labels} ignored the category filter "${category}" and returned its unfiltered listing, so its records were left out — only the filtered results are shown.`,
        );
      }

      // One server's cursor overshot while the other still returned records. The
      // fully-empty branch below does not fire, so without this nothing qualifies
      // the exhausted server's total 0 — it reads as "no preprints in the interval".
      const exhaustedServers = SERVERS.filter((s) => pagination[s]?.exhausted);
      if (exhaustedServers.length > 0 && allPreprints.length > 0) {
        notices.push(
          `Cursor ${input.cursor} is past the last available page on ${serverLabels(exhaustedServers)} — that entry is marked exhausted and its total of 0 is an out-of-range artifact, not the interval total. Lower the cursor to page that server.`,
        );
      }
    }

    // "Nothing here" is a claim about what the servers reported, and by this point
    // one has: every branch above either records a pagination entry or throws.
    if (allPreprints.length === 0) {
      // Detect cursor-overshoot: cursor > 0 but zero results — filters are fine, cursor is past the end
      if (input.cursor > 0) {
        notices.push(
          `Cursor ${input.cursor} is past the last available page for this date/filter combination. Set cursor to a lower offset.`,
        );
      } else {
        const filterDesc = [
          `dates ${input.start_date}–${input.end_date}`,
          category ? `category "${category}"` : null,
          funder ? `funder ${funder}` : null,
          target !== 'both' ? `server "${target}"` : null,
        ]
          .filter(Boolean)
          .join(', ');
        const removable = [category && 'category', funder && 'funder'].filter(Boolean).join(' or ');
        notices.push(
          `No preprints found for ${filterDesc}. Try widening the date range${removable ? ` or removing the ${removable} filter` : ''}.`,
        );
      }
    }

    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    const preprints = input.include_abstract
      ? allPreprints
      : allPreprints.map(({ abstract: _abstract, ...rest }) => rest);
    return { preprints, pagination, failed };
  },

  format: (result) => {
    const lines: string[] = [];

    // Pagination summary
    for (const server of SERVERS) {
      const p = result.pagination[server];
      if (!p) continue;
      let line = `**${SERVER_LABEL[server]}:** page offset ${p.cursor}, total ${p.total}`;
      if (p.nextCursor !== undefined) line += ` — next cursor: ${p.nextCursor}`;
      else if (!p.exhausted) line += ' (last page)';
      if (p.exhausted)
        line +=
          ' — cursor exhausted: past the last available page, no records at this offset (the total shown is an out-of-range artifact, not the interval total)';
      lines.push(line);
    }

    // A failed server has no pagination line of its own, so it is listed here to
    // keep the per-server summary complete — its silent absence is what makes a
    // partial result look complete.
    for (const f of result.failed) {
      lines.push(
        `**${SERVER_LABEL[f.server]}:** server did not answer — no records from it are included (${f.error})`,
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
