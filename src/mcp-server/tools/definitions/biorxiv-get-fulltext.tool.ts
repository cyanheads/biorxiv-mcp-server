/**
 * @fileoverview biorxiv_get_fulltext tool — retrieves a preprint's full text by
 * fetching its rendered HTML page (`www.{server}.org/content/{doi}v{N}.full`) and
 * extracting readable Markdown. The latest version is resolved via the details
 * API first (for the URL version and clean not-found handling), then the HTML is
 * fetched and run through the framework extractor. bioRxiv and medRxiv share the
 * 10.1101/ DOI prefix, so the default server="both" resolves the DOI against both
 * in parallel; the fan-out is narrower than biorxiv_get_published_version's — only
 * the resolution step fans out, and the full-text fetch targets the single server
 * that answered. Long articles are paged with offset/limit character chunking.
 * Full text is best-effort HTML→Markdown, not structured JATS; preprints that are
 * PDF-only or whose page is blocked return a typed `fulltext_unavailable` error
 * routing to biorxiv_get_preprint, while an origin rate limit (HTTP 429) routes to
 * a retryable `rate_limited` error carrying the origin's Retry-After wait.
 * @module mcp-server/tools/definitions/biorxiv-get-fulltext.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import type { BiorxivServer } from '@/services/biorxiv/types.js';
import { getBiorxivFullTextService } from '@/services/biorxiv-fulltext/biorxiv-fulltext-service.js';

const DOI_REGEX = /^10\.\d{4,}\//;

export const biorxivGetFulltextTool = tool('biorxiv_get_fulltext', {
  title: 'Get Preprint Full Text',
  description:
    'Retrieve a preprint\'s full text as best-effort Markdown, extracted from its rendered HTML article page. Resolves the latest version via the details API, then fetches and extracts the body — abstract, sections, and references. bioRxiv and medRxiv share the 10.1101/ DOI prefix, so server="both" (the default) resolves the DOI against both in parallel and the response reports which server answered. This is HTML-to-Markdown extraction, not structured JATS: section structure is approximate and not guaranteed. Long articles exceed a single response, so use offset and limit to page through them (the response reports totalChars, remainingChars, and hasMore); paging is cheap because the extracted article is cached per version for an hour after the first read, so only the first chunk pays for a fetch. Not every preprint has an extractable HTML page — some are PDF-only and some origins block programmatic access — in which case a fulltext_unavailable error routes you to biorxiv_get_preprint for the title, abstract, and metadata. For a preprint that has been published in a journal, the journal\'s version may have richer full text elsewhere.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    doi: z
      .string()
      .describe(
        'Preprint DOI (e.g. 10.1101/2024.05.28.596311 or 10.64898/2026.05.07.723463). The latest version is resolved automatically.',
      ),
    server: z
      .enum(['biorxiv', 'medrxiv', 'both'])
      .default('both')
      .describe(
        'Server the preprint was posted on. "both" (default) checks bioRxiv and medRxiv in parallel to resolve the DOI — the full-text fetch itself only ever targets whichever server resolved, and the output server field names it.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Character offset into the full extracted text at which to start reading. 0 returns the beginning. To read the next chunk, use offset = prior_offset + prior_length (the length field from the previous response).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50000)
      .default(20000)
      .describe(
        'Maximum number of characters to return in this chunk. Default 20,000; increase toward 50,000 for large context windows. Check the length field for the actual count returned.',
      ),
  }),

  output: z.object({
    doi: z.string().describe('The resolved preprint DOI.'),
    server: z.enum(['biorxiv', 'medrxiv']).describe('Server the preprint was resolved on.'),
    version: z
      .string()
      .describe('Preprint version whose full text was retrieved (the latest revision).'),
    title: z
      .string()
      .optional()
      .describe('Article title detected during extraction. Absent when the page exposed none.'),
    content: z
      .string()
      .describe(
        'The requested chunk of full text as best-effort Markdown extracted from the rendered HTML page. Section structure is approximate — this is not JATS.',
      ),
    contentFormat: z
      .literal('html-markdown')
      .describe(
        'How content was produced: Markdown extracted from the rendered HTML article page (constant).',
      ),
    wordCount: z
      .number()
      .optional()
      .describe(
        'Approximate word count of the FULL extracted article as reported by the extractor (not just the returned chunk). Absent when the extractor reported none.',
      ),
    sourceUrl: z.string().describe('The full-text HTML page the content was extracted from.'),
    offset: z
      .number()
      .describe('Character offset into the full extracted text where this chunk begins.'),
    length: z.number().describe('Number of characters returned in this chunk.'),
    totalChars: z
      .number()
      .describe(
        'Total characters in the full extracted text. Use with offset and length to page through long articles.',
      ),
    remainingChars: z
      .number()
      .describe(
        'Characters remaining after this chunk (totalChars - offset - length). 0 means this chunk reaches the end.',
      ),
    hasMore: z
      .boolean()
      .describe(
        'True when more text follows this chunk. When true, call again with offset = offset + length.',
      ),
  }),

  // Truncation disclosure on the enrichment channel (the framework capped-list
  // convention) alongside the gutenberg-style paging fields in output. Populated
  // via ctx.enrich.truncated only when the chunk was capped — optional so the
  // final-chunk path leaves them absent.
  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when this chunk was capped by limit and more text remains.'),
    shown: z.number().optional().describe('Characters returned in this chunk.'),
    cap: z.number().optional().describe('The limit (max characters) applied to this chunk.'),
    notice: z
      .string()
      .optional()
      .describe('Paging guidance when the content was truncated — how to fetch the next chunk.'),
  },

  errors: [
    {
      reason: 'invalid_doi_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The input DOI does not match the 10.NNNN/ pattern.',
      recovery:
        'Correct the DOI format — bioRxiv/medRxiv DOIs start with 10.1101/ or 10.64898/ followed by the manuscript ID.',
    },
    {
      reason: 'doi_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The DOI resolves to an empty collection on every attempted server.',
      recovery:
        'Retry with server="both" if you scoped to one server, or find the correct DOI with biorxiv_search_preprints.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'No attempted server resolved the DOI and at least one lookup failed against api.biorxiv.org.',
      recovery:
        'Retry the request after a short delay — the preprint may well exist; api.biorxiv.org did not answer.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      when: 'The full-text origin (www.biorxiv.org / www.medrxiv.org) returned HTTP 429 for this host.',
      recovery:
        'Wait the retryAfter seconds before calling again, and use biorxiv_get_preprint for the title, abstract, and metadata in the meantime.',
    },
    {
      reason: 'fulltext_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'The preprint exists but its full-text HTML page is blocked, missing, or yields no extractable text (PDF-only).',
      recovery:
        'Use biorxiv_get_preprint for the title, abstract, and metadata — a readable full-text page is not available for this preprint.',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset is greater than or equal to the total character length of the extracted text.',
      recovery:
        "Use an offset below totalChars — a prior response's remainingChars shows how much text is left.",
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing biorxiv_get_fulltext', {
      doi: input.doi,
      server: input.server,
      offset: input.offset,
      limit: input.limit,
    });

    if (!DOI_REGEX.test(input.doi)) {
      throw ctx.fail('invalid_doi_format', `Invalid DOI format: ${input.doi}`, {
        ...ctx.recoveryFor('invalid_doi_format'),
      });
    }

    // Resolve the preprint and its latest version via the JSON details API — this
    // provides the version for the full-text URL and clean not-found handling.
    // Only this step fans out; the full-text fetch targets the server that answered.
    const service = getBiorxivApiService();
    const servers: BiorxivServer[] =
      input.server === 'both' ? ['biorxiv', 'medrxiv'] : [input.server];
    const settled = await Promise.allSettled(
      servers.map((server) => service.getDetails(input.doi, server, ctx)),
    );

    let resolved: { server: BiorxivServer; version: string } | undefined;
    for (const [i, settledResult] of settled.entries()) {
      if (settledResult.status === 'fulfilled' && settledResult.value.length > 0) {
        resolved = {
          server: servers[i] as BiorxivServer,
          version: settledResult.value.at(-1)?.version ?? '1',
        };
        break;
      }
    }

    if (!resolved) {
      // "Not found" is a claim about what the servers reported, so a server that
      // never answered leaves absence unestablished — and retryable.
      const rejections = settled.flatMap((r, i) =>
        r.status === 'rejected' ? [{ server: servers[i] as BiorxivServer, error: r.reason }] : [],
      );
      if (rejections.length > 0) {
        const detail = rejections
          .map(
            (f) => `${f.server}: ${f.error instanceof Error ? f.error.message : String(f.error)}`,
          )
          .join('; ');
        throw ctx.fail(
          'upstream_unavailable',
          `Version lookup for ${input.doi} failed — ${detail}`,
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
        `No preprint found for ${input.doi} on ${servers.join(' or ')}.`,
        { doi: input.doi, servers, ...ctx.recoveryFor('doi_not_found') },
      );
    }

    const { server, version } = resolved;
    const result = await getBiorxivFullTextService().fetchFullText(server, input.doi, version, ctx);
    if (result.kind === 'unavailable') {
      if (result.reason === 'rate_limited') {
        // Dynamic recovery — the origin's own wait is more actionable than the
        // contract's static hint. The block-page HTML never leaves the service.
        const wait =
          result.retryAfter === undefined ? 'a minute or two' : `${result.retryAfter} seconds`;
        throw ctx.fail('rate_limited', result.detail, {
          doi: input.doi,
          server,
          version,
          sourceUrl: result.sourceUrl,
          ...(result.retryAfter !== undefined && { retryAfter: result.retryAfter }),
          recovery: {
            hint: `Wait ${wait} before calling biorxiv_get_fulltext again for this origin, and use biorxiv_get_preprint for the title, abstract, and metadata in the meantime.`,
          },
        });
      }
      throw ctx.fail('fulltext_unavailable', result.detail, {
        doi: input.doi,
        server,
        version,
        sourceUrl: result.sourceUrl,
        ...ctx.recoveryFor('fulltext_unavailable'),
      });
    }

    const totalChars = result.markdown.length;
    if (input.offset >= totalChars) {
      throw ctx.fail(
        'offset_out_of_range',
        `Offset ${input.offset} is past the end of the text (totalChars: ${totalChars}).`,
        { offset: input.offset, totalChars, ...ctx.recoveryFor('offset_out_of_range') },
      );
    }

    const end = Math.min(input.offset + input.limit, totalChars);
    const content = result.markdown.slice(input.offset, end);
    const length = content.length;
    const remainingChars = totalChars - end;
    const hasMore = remainingChars > 0;

    if (hasMore) {
      ctx.enrich.truncated({
        shown: length,
        cap: input.limit,
        guidance: `Full text truncated at the ${input.limit}-character limit. Call biorxiv_get_fulltext again with offset=${end} to read the next chunk.`,
      });
    }

    return {
      doi: input.doi,
      server,
      version,
      ...(result.title && { title: result.title }),
      content,
      contentFormat: 'html-markdown' as const,
      ...(result.wordCount !== undefined && { wordCount: result.wordCount }),
      sourceUrl: result.sourceUrl,
      offset: input.offset,
      length,
      totalChars,
      remainingChars,
      hasMore,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.title ?? result.doi}`);
    lines.push(
      `**DOI:** ${result.doi} | **Server:** ${result.server} | **Version:** v${result.version}`,
    );
    const end = result.offset + result.length;
    lines.push(
      `**Characters ${result.offset.toLocaleString()}–${(end - 1).toLocaleString()} of ${result.totalChars.toLocaleString()}** | Length: ${result.length.toLocaleString()} | Remaining: ${result.remainingChars.toLocaleString()} | hasMore: ${result.hasMore}`,
    );
    if (result.wordCount !== undefined)
      lines.push(`**Full-article word count:** ${result.wordCount}`);
    lines.push(`**Source:** ${result.sourceUrl}`);
    lines.push(`**Format:** ${result.contentFormat}`);
    lines.push(
      '\n> Extracted from the rendered HTML page — section structure is best-effort and not guaranteed (this is not JATS). Treat headings and reference formatting as approximate.',
    );
    lines.push('\n---\n');
    lines.push(result.content);
    if (result.hasMore) {
      lines.push(
        `\n---\n_Call biorxiv_get_fulltext again with doi=${result.doi}, offset=${end} to read the next chunk._`,
      );
    } else {
      lines.push('\n---\n_End of extracted text._');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
