/**
 * @fileoverview biorxiv_get_published_version tool — resolves a preprint DOI
 * to its full journal publication record using the /pubs endpoint. Use when
 * you need richer crosswalk metadata than biorxiv_get_preprint provides
 * (journal name, published date, full abstract, corresponding author details).
 * bioRxiv and medRxiv share the 10.1101/ DOI prefix, so the DOI alone does not
 * identify the server: the default server="both" resolves against both in
 * parallel and the output names the server that answered. Not-found is reported
 * only when every attempted server answered with an empty collection. A lookup
 * the origin rate-limited (HTTP 429) raises a retryable `rate_limited` error
 * carrying the origin's Retry-After wait rather than the generic
 * upstream-unavailable one, which carries no wait at all.
 * @module mcp-server/tools/definitions/biorxiv-get-published-version.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type { BiorxivServer } from '@/services/biorxiv/types.js';
import { describeWait, findRateLimit } from '@/services/shared.js';

const DOI_REGEX = /^10\.\d{4,}\//;

export const biorxivGetPublishedVersionTool = tool('biorxiv_get_published_version', {
  title: 'Get Published Journal Version',
  description:
    'Resolve a preprint DOI to its full journal publication record — journal DOI, journal name, published date, and corresponding author details. Use when the preprint\'s `publishedJournalDoi` field from biorxiv_get_preprint is present and you need the full crosswalk metadata. bioRxiv and medRxiv share the 10.1101/ DOI prefix, so server="both" (the default) checks both in parallel and the response reports which server answered. Returns a not-found error when no attempted server holds a published record — check biorxiv_get_preprint if you need to confirm the preprint is published at all.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    doi: z
      .string()
      .describe(
        'Preprint DOI to resolve (e.g. 10.1101/2024.01.15.575123 or 10.64898/2026.05.07.723463).',
      ),
    server: z
      .enum(['biorxiv', 'medrxiv', 'both'])
      .default('both')
      .describe(
        'Server the preprint was posted on. "both" (default) checks bioRxiv and medRxiv in parallel — use it when the DOI alone does not tell you which server holds the preprint.',
      ),
  }),

  output: z.object({
    preprintDoi: z.string().describe('The preprint DOI that was resolved.'),
    server: z
      .enum(['biorxiv', 'medrxiv'])
      .describe('The server that returned this published record — never "both".'),
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
      when: 'Crosswalk endpoint returns an empty collection on every attempted server.',
      recovery:
        'Retry with server="both" if you scoped to one server, or check publishedJournalDoi in biorxiv_get_preprint — when it is absent the preprint has no journal version yet.',
    },
    {
      reason: 'invalid_doi_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The input DOI does not match the 10.NNNN/ pattern.',
      recovery:
        'Correct the DOI format — bioRxiv DOIs start with 10.1101/ or 10.64898/ followed by the manuscript ID.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'No attempted server returned a record and at least one lookup failed against api.biorxiv.org.',
      recovery:
        'Retry the request after a short delay — a published version may well exist; api.biorxiv.org did not answer.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      when: 'No attempted server returned a record and at least one lookup was rejected with HTTP 429 by api.biorxiv.org.',
      recovery:
        'Wait the retryAfter seconds before retrying — every preprint metadata tool queries the same origin, so none of them will answer sooner.',
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
    const servers: BiorxivServer[] =
      input.server === 'both' ? ['biorxiv', 'medrxiv'] : [input.server];

    const settled = await Promise.allSettled(
      servers.map((server) => service.getPublishedVersion(input.doi, server, ctx)),
    );

    for (const [i, settledResult] of settled.entries()) {
      if (settledResult.status === 'fulfilled' && settledResult.value) {
        return { ...settledResult.value, server: servers[i] as BiorxivServer };
      }
    }

    // Nothing resolved. "Not published" is a claim about what the crosswalk endpoint
    // reported, so a server that never answered leaves it unestablished and retryable.
    const rejections = settled.flatMap((r, i) =>
      r.status === 'rejected' ? [{ server: servers[i] as BiorxivServer, error: r.reason }] : [],
    );
    if (rejections.length > 0) {
      const detail = rejections
        .map((f) => `${f.server}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
        .join('; ');
      // A rate limit outranks a generic upstream failure: both say "retry", but
      // only one says when, and retrying sooner would land inside the same limit.
      const rateLimit = findRateLimit(rejections.map((f) => f.error));
      if (rateLimit) {
        const wait = describeWait(rateLimit.retryAfter);
        throw ctx.fail(
          'rate_limited',
          `Crosswalk lookup for ${input.doi} failed — ${detail}`,
          {
            doi: input.doi,
            servers: rejections.map((f) => f.server),
            ...(rateLimit.retryAfter !== undefined && { retryAfter: rateLimit.retryAfter }),
            recovery: {
              hint: `Wait ${wait} before retrying — api.biorxiv.org is rate-limiting this host, and every preprint metadata tool queries the same origin.`,
            },
          },
          { cause: rejections[0]?.error },
        );
      }
      throw ctx.fail(
        'upstream_unavailable',
        `Crosswalk lookup for ${input.doi} failed — ${detail}`,
        {
          doi: input.doi,
          servers: rejections.map((f) => f.server),
          ...ctx.recoveryFor('upstream_unavailable'),
        },
        { cause: rejections[0]?.error },
      );
    }

    throw ctx.fail(
      'doi_not_found',
      `No published version found for ${input.doi} on ${servers.join(' or ')}.`,
      { doi: input.doi, servers, ...ctx.recoveryFor('doi_not_found') },
    );
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Published Version`);
    lines.push(`**Preprint DOI:** ${result.preprintDoi}`);
    lines.push(`**Resolved on server:** ${result.server}`);
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
