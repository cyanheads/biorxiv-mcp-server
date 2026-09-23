/**
 * @fileoverview biorxiv_get_published_version tool — resolves a preprint DOI
 * to its full journal publication record using the /pubs endpoint. Use when
 * you need richer crosswalk metadata than biorxiv_get_preprint provides
 * (journal name, published date, full abstract, corresponding author details).
 * bioRxiv and medRxiv share their DOI prefixes, so the DOI alone does not
 * identify the server: the default server="both" resolves against both in
 * parallel and the output names the server that answered.
 *
 * `/pubs` keyed by preprint DOI never parses a `10.64898/` DOI, so when it
 * answers empty everywhere the preprint's `/details` record supplies the journal
 * DOI, and `/pubs` keyed by that journal DOI supplies the full record. When that
 * reverse lookup finds nothing too, or fails, the
 * journal DOI is returned alone with a notice — the journal name and date come
 * only from the crosswalk and are never filled in from elsewhere. Not-found is
 * reported only when every attempted server answered and the preprint lists no
 * journal version, or no server holds it at all. A lookup
 * the origin rate-limited (HTTP 429) raises a retryable `rate_limited` error
 * carrying the origin's Retry-After wait rather than the generic
 * upstream-unavailable one, which carries no wait at all.
 * @module mcp-server/tools/definitions/biorxiv-get-published-version.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type { BiorxivServer } from '@/services/biorxiv/types.js';
import { describeWait, escapeMarkdown, findRateLimit, normalizeDoi } from '@/services/shared.js';

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export const biorxivGetPublishedVersionTool = tool('biorxiv_get_published_version', {
  title: 'Get Published Journal Version',
  description:
    'Resolve a preprint DOI to its full journal publication record — journal DOI, journal name, published date, and corresponding author details. Use when the preprint\'s `publishedJournalDoi` field from biorxiv_get_preprint is present and you need the full crosswalk metadata. bioRxiv and medRxiv share their DOI prefixes, so server="both" (the default) checks both in parallel and the response reports which server answered. Works for 10.1101/ and 10.64898/ DOIs alike; when the crosswalk holds no record for a published preprint, the journal DOI still comes back from the preprint\'s own record, without journal name or date, and a notice says so. Returns a not-found error only when no server holds the preprint or it lists no journal version at all.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    doi: z
      .string()
      .describe(
        'Preprint DOI to resolve (e.g. 10.1101/2024.01.15.575123 or 10.64898/2026.05.07.723463). A doi.org or biorxiv.org/medrxiv.org article URL, a doi: prefix, or a vN / .full suffix is accepted and stripped to the bare DOI.',
      ),
    server: z
      .enum(['biorxiv', 'medrxiv', 'both'])
      .default('both')
      .describe(
        'Server the preprint was posted on. "both" (default) checks bioRxiv and medRxiv in parallel — use it when the DOI alone does not tell you which server holds the preprint.',
      ),
  }),

  output: z.object({
    preprintDoi: z.string().describe('The preprint DOI that was resolved, in bare form.'),
    server: z
      .enum(['biorxiv', 'medrxiv'])
      .describe('The server that returned this published record — never "both".'),
    publishedDoi: z.string().optional().describe('The journal publication DOI.'),
    publishedJournal: z
      .string()
      .optional()
      .describe(
        'Name of the publishing journal. Absent when the crosswalk holds no record for this preprint — see notice.',
      ),
    publishedDate: z
      .string()
      .optional()
      .describe(
        'Journal publication date (YYYY-MM-DD). Absent when the crosswalk holds no record for this preprint — see notice.',
      ),
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

  // Qualifies a record the crosswalk could not supply in full. Populated via
  // ctx.enrich so it reaches both structuredContent and content[].
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        "Present when publishedDoi came from the preprint's own record because the crosswalk had none: says why publishedJournal and publishedDate are absent.",
      ),
  },

  errors: [
    {
      reason: 'doi_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No attempted server holds the preprint, or neither the crosswalk nor its preprint record lists a journal version.',
      recovery:
        'Retry with server="both" if you scoped to one server; otherwise no journal version is recorded for this preprint yet — confirm the DOI with biorxiv_get_preprint or check again later.',
    },
    {
      reason: 'invalid_doi_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The input DOI does not match the 10.NNNN/ pattern, even after URL, doi:, and suffix stripping.',
      recovery:
        'Correct the DOI format — bioRxiv DOIs start with 10.1101/ or 10.64898/ followed by the manuscript ID.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'No published record was established and at least one crosswalk or preprint lookup failed against api.biorxiv.org.',
      recovery:
        'Retry the request after a short delay — a published version may well exist; api.biorxiv.org did not answer.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      when: 'No published record was established and at least one crosswalk or preprint lookup was rejected with HTTP 429 by api.biorxiv.org.',
      recovery:
        'Wait the retryAfter seconds before retrying — every preprint metadata tool queries the same origin, so none of them will answer sooner.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_get_published_version', {
      doi: input.doi,
      server: input.server,
    });

    const doi = normalizeDoi(input.doi)?.doi;
    if (!doi) {
      throw ctx.fail('invalid_doi_format', `Invalid DOI format: ${input.doi}`, {
        ...ctx.recoveryFor('invalid_doi_format'),
      });
    }

    const service = getBiorxivApiService();
    const servers: BiorxivServer[] =
      input.server === 'both' ? ['biorxiv', 'medrxiv'] : [input.server];

    /**
     * "Not published" and "not found" are claims about what the servers
     * reported, so a lookup that never answered leaves them unestablished and
     * the call retryable. A rate limit outranks a generic upstream failure: both
     * say "retry", but only one says when, and retrying sooner would land
     * inside the same limit.
     */
    const lookupFailure = (
      lookup: string,
      settled: PromiseSettledResult<unknown>[],
    ): McpError | undefined => {
      const rejections = settled.flatMap((r, i) =>
        r.status === 'rejected' ? [{ server: servers[i] as BiorxivServer, error: r.reason }] : [],
      );
      if (rejections.length === 0) return;
      const detail = rejections.map((f) => `${f.server}: ${errorMessage(f.error)}`).join('; ');
      const failedServers = rejections.map((f) => f.server);
      const rateLimit = findRateLimit(rejections.map((f) => f.error));
      if (rateLimit) {
        const wait = describeWait(rateLimit.retryAfter);
        return ctx.fail(
          'rate_limited',
          `${lookup} for ${doi} failed — ${detail}`,
          {
            doi,
            servers: failedServers,
            ...(rateLimit.retryAfter !== undefined && { retryAfter: rateLimit.retryAfter }),
            recovery: {
              hint: `Wait ${wait} before retrying — api.biorxiv.org is rate-limiting this host, and every preprint metadata tool queries the same origin.`,
            },
          },
          { cause: rejections[0]?.error },
        );
      }
      return ctx.fail(
        'upstream_unavailable',
        `${lookup} for ${doi} failed — ${detail}`,
        { doi, servers: failedServers, ...ctx.recoveryFor('upstream_unavailable') },
        { cause: rejections[0]?.error },
      );
    };

    // 1. The crosswalk keyed by preprint DOI — resolves 10.1101/ DOIs directly.
    const crosswalk = await Promise.allSettled(
      servers.map((server) => service.getPublishedVersion(doi, server, ctx)),
    );
    for (const [i, result] of crosswalk.entries()) {
      if (result.status === 'fulfilled' && result.value) {
        return { ...result.value, server: servers[i] as BiorxivServer };
      }
    }
    const crosswalkFailure = lookupFailure('Crosswalk lookup', crosswalk);
    if (crosswalkFailure) throw crosswalkFailure;

    // 2. The crosswalk answered empty everywhere, which is also its answer for
    // every 10.64898/ DOI — the path form never parses one. The preprint's own
    // /details record names its journal DOI whichever prefix it carries.
    const details = await Promise.allSettled(
      servers.map((server) => service.getDetails(doi, server, ctx)),
    );
    const heldAt = details.findIndex((r) => r.status === 'fulfilled' && r.value.length > 0);
    const held = details[heldAt];
    if (held?.status !== 'fulfilled') {
      const detailsFailure = lookupFailure('Preprint lookup', details);
      if (detailsFailure) throw detailsFailure;
      // No preprint at all: the contract hint's "no journal version yet — check
      // again later" would send the caller to wait on a DOI that does not exist.
      throw ctx.fail('doi_not_found', `No preprint found for ${doi} on ${servers.join(' or ')}.`, {
        doi,
        servers,
        recovery: {
          hint: 'Retry with server="both" if you scoped to one server; otherwise the DOI is wrong — find the right one with biorxiv_search_preprints.',
        },
      });
    }
    const server = servers[heldAt] as BiorxivServer;
    const revisions = held.value;
    const publishedDoi = revisions.findLast((r) => r.publishedJournalDoi)?.publishedJournalDoi;
    if (!publishedDoi) {
      throw ctx.fail(
        'doi_not_found',
        `${doi} has no published journal version: neither the crosswalk nor its ${server} preprint record lists one.`,
        { doi, servers, ...ctx.recoveryFor('doi_not_found') },
      );
    }

    // 3. The crosswalk keyed the other way, by that journal DOI — the full
    // record, journal name and date included, whenever the API can parse the key.
    const [byJournal] = await Promise.allSettled([
      service.getPublishedVersionByJournalDoi(publishedDoi, doi, server, ctx),
    ]);
    if (byJournal?.status === 'fulfilled' && byJournal.value) {
      return { ...byJournal.value, server };
    }

    // 4. Only the journal DOI is established. The journal name and publication
    // date come from the crosswalk alone, so they stay absent — never inferred.
    ctx.enrich.notice(
      byJournal?.status === 'rejected'
        ? `The crosswalk lookup by journal DOI ${publishedDoi} failed (${errorMessage(byJournal.reason)}), so publishedDoi comes from the preprint's own record and the journal name and publication date are absent. Retry to fill them in.`
        : `The crosswalk holds no record for ${doi} under its preprint DOI or its journal DOI ${publishedDoi}, so publishedDoi comes from the preprint's own record and the journal name and publication date — which only the crosswalk supplies — are absent. Resolve ${publishedDoi} at doi.org for the journal details.`,
    );
    const first = revisions[0];
    const latest = revisions.at(-1);
    return {
      preprintDoi: doi,
      server,
      publishedDoi,
      ...(latest?.title && { preprintTitle: latest.title }),
      ...(latest?.authors && { preprintAuthors: latest.authors }),
      ...(latest?.category && { preprintCategory: latest.category }),
      ...(first?.date && { preprintDate: first.date }),
      ...(latest?.abstract && { preprintAbstract: latest.abstract }),
      ...(latest?.authorCorresponding && {
        preprintAuthorCorresponding: latest.authorCorresponding,
      }),
      ...(latest?.authorCorrespondingInstitution && {
        preprintAuthorCorrespondingInstitution: latest.authorCorrespondingInstitution,
      }),
    };
  },

  // Upstream free text is escaped as it is interpolated so it renders literally —
  // the abstract opens its own line, where `1. ` would start a list. DOIs stay
  // raw because agents copy them back into calls.
  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Published Version`);
    lines.push(`**Preprint DOI:** ${result.preprintDoi}`);
    lines.push(`**Resolved on server:** ${result.server}`);
    if (result.publishedDoi) lines.push(`**Published DOI:** ${result.publishedDoi}`);
    if (result.publishedJournal)
      lines.push(`**Journal:** ${escapeMarkdown(result.publishedJournal)}`);
    if (result.publishedDate) lines.push(`**Published Date:** ${result.publishedDate}`);
    if (result.preprintTitle) lines.push(`\n**Title:** ${escapeMarkdown(result.preprintTitle)}`);
    if (result.preprintAuthors)
      lines.push(`**Authors:** ${escapeMarkdown(result.preprintAuthors)}`);
    if (result.preprintCategory)
      lines.push(`**Category:** ${escapeMarkdown(result.preprintCategory)}`);
    if (result.preprintDate) lines.push(`**Preprint Date:** ${result.preprintDate}`);
    if (result.preprintAuthorCorresponding)
      lines.push(`**Corresponding Author:** ${escapeMarkdown(result.preprintAuthorCorresponding)}`);
    if (result.preprintAuthorCorrespondingInstitution)
      lines.push(
        `**Institution:** ${escapeMarkdown(result.preprintAuthorCorrespondingInstitution)}`,
      );
    if (result.preprintAbstract)
      lines.push(`\n**Abstract:**\n${escapeMarkdown(result.preprintAbstract)}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
