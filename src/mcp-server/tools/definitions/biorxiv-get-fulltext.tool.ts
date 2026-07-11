/**
 * @fileoverview biorxiv_get_fulltext tool — retrieves a preprint's full text by
 * fetching its rendered HTML page (`www.{server}.org/content/{doi}v{N}.full`) and
 * extracting readable Markdown. The latest version is resolved via the details
 * API first (for the URL version and clean not-found handling), then the HTML is
 * fetched and run through the framework extractor. Long articles are paged with
 * offset/limit character chunking. Full text is best-effort HTML→Markdown, not
 * structured JATS; preprints that are PDF-only or whose page is blocked return a
 * typed `fulltext_unavailable` error routing to biorxiv_get_preprint.
 * @module mcp-server/tools/definitions/biorxiv-get-fulltext.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import { getBiorxivFullTextService } from '@/services/biorxiv-fulltext/biorxiv-fulltext-service.js';

const DOI_REGEX = /^10\.\d{4,}\//;

export const biorxivGetFulltextTool = tool('biorxiv_get_fulltext', {
  title: 'Get Preprint Full Text',
  description:
    "Retrieve a preprint's full text as best-effort Markdown, extracted from its rendered HTML article page. Resolves the latest version via the details API, then fetches and extracts the body — abstract, sections, and references. This is HTML-to-Markdown extraction, not structured JATS: section structure is approximate and not guaranteed. Long articles exceed a single response, so use offset and limit to page through them (the response reports totalChars, remainingChars, and hasMore). Not every preprint has an extractable HTML page — some are PDF-only and some origins block programmatic access — in which case a fulltext_unavailable error routes you to biorxiv_get_preprint for the title, abstract, and metadata. For a preprint that has been published in a journal, the journal's version may have richer full text elsewhere.",
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    doi: z
      .string()
      .describe(
        'Preprint DOI (e.g. 10.1101/2024.05.28.596311 or 10.64898/2026.05.07.723463). The latest version is resolved automatically.',
      ),
    server: z
      .enum(['biorxiv', 'medrxiv'])
      .default('biorxiv')
      .describe('Server the preprint was posted on. Defaults to biorxiv.'),
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
      when: 'The DOI resolves to no preprint on the requested server.',
      recovery:
        'Find the correct DOI and server with biorxiv_search_preprints, or retry with the other server value.',
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
    // Transient failures here bubble as ServiceUnavailable.
    const revisions = await getBiorxivApiService().getDetails(input.doi, input.server, ctx);
    const latest = revisions.at(-1);
    if (!latest) {
      throw ctx.fail('doi_not_found', `No preprint found for ${input.doi} on ${input.server}.`, {
        doi: input.doi,
        server: input.server,
        ...ctx.recoveryFor('doi_not_found'),
      });
    }
    const version = latest.version ?? '1';

    const result = await getBiorxivFullTextService().fetchFullText(
      input.server,
      input.doi,
      version,
      ctx,
    );
    if (result.kind === 'unavailable') {
      throw ctx.fail('fulltext_unavailable', result.detail, {
        doi: input.doi,
        server: input.server,
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
      server: input.server,
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
