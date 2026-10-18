/**
 * @fileoverview Tests for biorxiv_get_fulltext tool — both-server DOI resolution,
 * version resolution, the typed error contract (including rate_limited and
 * upstream_unavailable), offset/limit chunking, omitted tables on every chunk,
 * and format rendering.
 * @module tests/tools/biorxiv-get-fulltext.tool.test
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetFulltextTool } from '@/mcp-server/tools/definitions/biorxiv-get-fulltext.tool.js';
import type { FullTextFetchResult } from '@/services/biorxiv-fulltext/biorxiv-fulltext-service.js';
import { CALL_BUDGET_MS, type CallDeadline, retryWithinBudget } from '@/services/shared.js';
import {
  answerAfter,
  budgetStep,
  hungOrigin,
  neverAnswers,
  routeLegs,
  settle,
} from '../helpers/call-budget.js';
import { ESCAPED, UPSTREAM } from '../helpers/markdown-fixtures.js';
import {
  declaredRateLimitRecovery,
  RATE_LIMIT_RECOVERY_OPENING,
  rateLimitError,
} from '../helpers/rate-limit.js';
import { envelopeHint, recoveryHint, rejection } from '../helpers/rejection.js';

const mockGetDetails = vi.fn();
const mockFetchFullText = vi.fn();

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({ getDetails: mockGetDetails }),
}));

vi.mock('@/services/biorxiv-fulltext/biorxiv-fulltext-service.js', () => ({
  getBiorxivFullTextService: () => ({ fetchFullText: mockFetchFullText }),
}));

const DOI = '10.1101/2024.05.28.596311';
const SOURCE_URL = `https://www.biorxiv.org/content/${DOI}v2.full`;

function articleResult(markdown: string): FullTextFetchResult {
  return {
    kind: 'article',
    markdown,
    title: 'Bilateral integration in somatosensory cortex',
    sourceUrl: SOURCE_URL,
  };
}

/** Twenty whitespace-delimited words, 160 characters. */
const TWENTY_WORDS =
  'Macrophages drive limb regeneration in axolotls and their depletion blocks blastema formation entirely while fibroblasts persist unchanged throughout the wound.';

describe('biorxivGetFulltextTool', () => {
  beforeEach(() => {
    mockGetDetails.mockReset();
    mockFetchFullText.mockReset();
    mockGetDetails.mockResolvedValue([
      { doi: DOI, version: '1', server: 'biorxiv' },
      { doi: DOI, version: '2', server: 'biorxiv' },
    ]);
    mockFetchFullText.mockResolvedValue(articleResult('A'.repeat(100)));
  });

  // ── Happy path + version resolution ──────────────────────────────────────────

  it('returns extracted full text and resolves the latest version for the URL', async () => {
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const result = await biorxivGetFulltextTool.handler(input, ctx);

    expect(result.doi).toBe(DOI);
    expect(result.server).toBe('biorxiv');
    expect(result.version).toBe('2'); // latest revision
    expect(result.contentFormat).toBe('html-markdown');
    expect(result.content).toHaveLength(100);
    expect(result.totalChars).toBe(100);
    expect(result.hasMore).toBe(false);
    // One unbroken run of characters is one whitespace-delimited word.
    expect(result.wordCount).toBe(1);
    // fetchFullText receives the resolved version
    expect(mockFetchFullText).toHaveBeenCalledWith(
      'biorxiv',
      DOI,
      '2',
      expect.any(Number),
      expect.anything(),
    );
  });

  it('defaults server to both, offset to 0, limit to 20000', () => {
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    expect(input.server).toBe('both');
    expect(input.offset).toBe(0);
    expect(input.limit).toBe(20000);
  });

  // ── Both-server DOI resolution ───────────────────────────────────────────────

  it('resolves the DOI against both servers by default and prefers bioRxiv on a tie', async () => {
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const result = await biorxivGetFulltextTool.handler(input, ctx);

    expect(mockGetDetails).toHaveBeenCalledTimes(2);
    expect(mockGetDetails).toHaveBeenCalledWith(
      DOI,
      'biorxiv',
      expect.any(Number),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(mockGetDetails).toHaveBeenCalledWith(
      DOI,
      'medrxiv',
      expect.any(Number),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(result.server).toBe('biorxiv');
    expect(mockFetchFullText).toHaveBeenCalledWith(
      'biorxiv',
      DOI,
      '2',
      expect.any(Number),
      expect.anything(),
    );
  });

  it('fetches from medRxiv when only medRxiv resolves the DOI', async () => {
    mockGetDetails.mockImplementation((_doi: string, server: string) =>
      Promise.resolve(server === 'medrxiv' ? [{ doi: DOI, version: '3', server: 'medrxiv' }] : []),
    );
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const result = await biorxivGetFulltextTool.handler(input, ctx);

    expect(result.server).toBe('medrxiv');
    expect(result.version).toBe('3');
    expect(mockFetchFullText).toHaveBeenCalledWith(
      'medrxiv',
      DOI,
      '3',
      expect.any(Number),
      expect.anything(),
    );
  });

  it('resolves against one server only when the caller scopes the request', async () => {
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI, server: 'medrxiv' });
    const result = await biorxivGetFulltextTool.handler(input, ctx);

    expect(mockGetDetails).toHaveBeenCalledTimes(1);
    expect(mockGetDetails).toHaveBeenCalledWith(
      DOI,
      'medrxiv',
      expect.any(Number),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(result.server).toBe('medrxiv');
  });

  it('serves the article from the server that answered when the other one fails', async () => {
    mockGetDetails.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv'
        ? Promise.reject(new Error('api.biorxiv.org unreachable'))
        : Promise.resolve([{ doi: DOI, version: '1', server: 'medrxiv' }]),
    );
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const result = await biorxivGetFulltextTool.handler(input, ctx);

    expect(result.server).toBe('medrxiv');
    expect(mockFetchFullText).toHaveBeenCalledWith(
      'medrxiv',
      DOI,
      '1',
      expect.any(Number),
      expect.anything(),
    );
  });

  describe('cancellation', () => {
    let controller: AbortController;
    let cancelled: Error;
    const ctx = () =>
      createMockContext({ errors: biorxivGetFulltextTool.errors, signal: controller.signal });

    beforeEach(() => {
      controller = new AbortController();
      cancelled = new Error('cancelled by caller');
    });

    it('rethrows a cancellation rather than resolving from the leg that finished first', async () => {
      mockGetDetails.mockImplementation((_doi: string, server: string) => {
        if (server === 'biorxiv') return Promise.resolve([{ doi: DOI, version: '1' }]);
        controller.abort(cancelled);
        return Promise.reject(new Error('aborted'));
      });
      const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
      expect(await rejection(biorxivGetFulltextTool.handler(input, ctx()))).toBe(cancelled);
      expect(mockFetchFullText).not.toHaveBeenCalled();
    });

    it('rethrows a cancellation rather than returning an article that settled after it', async () => {
      // A cached article answers whether or not the caller is still there.
      mockFetchFullText.mockImplementation(() => {
        controller.abort(cancelled);
        return Promise.resolve(articleResult('A'.repeat(100)));
      });
      const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
      expect(await rejection(biorxivGetFulltextTool.handler(input, ctx()))).toBe(cancelled);
    });

    it('settles a call cancelled during the article fetch as RequestCancelled', async () => {
      mockFetchFullText.mockImplementation(() => {
        controller.abort(cancelled);
        return Promise.resolve(articleResult('A'.repeat(100)));
      });
      const result = await runToolContract(biorxivGetFulltextTool, { doi: DOI } as never, {
        context: { errors: biorxivGetFulltextTool.errors, signal: controller.signal },
      });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: number } };
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    });

    describe.each([
      [
        'the RequestCancelled an aborted request throws',
        () =>
          new McpError(JsonRpcErrorCode.RequestCancelled, 'aborted', {
            errorSource: 'FetchAborted',
          }),
      ],
      [
        // withRetry rethrows an attempt's own error once the caller's signal has aborted.
        'a 503 that arrived as the caller cancelled',
        () =>
          new McpError(
            JsonRpcErrorCode.ServiceUnavailable,
            `Fetch failed for ${SOURCE_URL}. Status: 503`,
            { status: 503 },
          ),
      ],
    ])('an article fetch that rejects with %s after the caller cancelled', (_label, thrown) => {
      beforeEach(() => {
        mockFetchFullText.mockImplementation(() => {
          controller.abort(cancelled);
          return Promise.reject(thrown());
        });
      });

      it('rethrows the cancellation rather than an upstream_unavailable wrapping it', async () => {
        const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
        expect(await rejection(biorxivGetFulltextTool.handler(input, ctx()))).toBe(cancelled);
      });

      it("settles as RequestCancelled with the caller's reason, never a claim that the article page did not answer", async () => {
        const result = await runToolContract(biorxivGetFulltextTool, { doi: DOI } as never, {
          context: { errors: biorxivGetFulltextTool.errors, signal: controller.signal },
        });

        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as { error: { code: number; message: string } };
        expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(error.message).toBe('cancelled by caller');
        const text = (result.content as { text: string }[])[0]?.text ?? '';
        expect(text).toContain('cancelled by caller');
        expect(text).not.toContain('did not answer');
      });
    });

    it('still serves the article from the answering server when the other leg fails while the signal is live', async () => {
      mockGetDetails.mockImplementation((_doi: string, server: string) =>
        server === 'biorxiv'
          ? Promise.resolve([{ doi: DOI, version: '1' }])
          : Promise.reject(new Error('aborted')),
      );
      const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
      const result = await biorxivGetFulltextTool.handler(input, ctx());

      expect(result).toMatchObject({ server: 'biorxiv', version: '1', totalChars: 100 });
    });
  });

  it('falls back to version "1" when the latest revision lacks a version field', async () => {
    mockGetDetails.mockResolvedValue([{ doi: DOI, server: 'biorxiv' }]);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const result = await biorxivGetFulltextTool.handler(input, ctx);
    expect(result.version).toBe('1');
    expect(mockFetchFullText).toHaveBeenCalledWith(
      'biorxiv',
      DOI,
      '1',
      expect.any(Number),
      expect.anything(),
    );
  });

  // ── Chunking ─────────────────────────────────────────────────────────────────

  it('chunks by offset and limit and reports paging state', async () => {
    mockFetchFullText.mockResolvedValue(articleResult('B'.repeat(100)));
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI, offset: 0, limit: 30 });
    const result = await biorxivGetFulltextTool.handler(input, ctx);
    expect(result.offset).toBe(0);
    expect(result.length).toBe(30);
    expect(result.totalChars).toBe(100);
    expect(result.remainingChars).toBe(70);
    expect(result.hasMore).toBe(true);
    // Truncation disclosed on the enrichment channel too
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(30);
    expect(enrichment.cap).toBe(30);
    // The notice names every argument the next call needs, as format() does.
    expect(enrichment.notice).toContain(`doi=${DOI}, version=2, offset=30`);
  });

  it('reads a middle chunk and reaches the end on the final call', async () => {
    mockFetchFullText.mockResolvedValue(articleResult('C'.repeat(100)));
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI, offset: 90, limit: 30 });
    const result = await biorxivGetFulltextTool.handler(input, ctx);
    expect(result.offset).toBe(90);
    expect(result.length).toBe(10);
    expect(result.remainingChars).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  // ── wordCount ────────────────────────────────────────────────────────────────

  it('derives wordCount from the Markdown it pages over, ignoring any figure riding in with it', async () => {
    const markdown = '# Results\n\nMacrophages drive limb regeneration in axolotls.';
    // An extractor figure (or one read back from an older cache entry) must not
    // override the count of the text actually served.
    mockFetchFullText.mockResolvedValue({ ...articleResult(markdown), wordCount: 113 });
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const result = await biorxivGetFulltextTool.handler(input, ctx);
    expect(result.content).toBe(markdown);
    expect(result.wordCount).toBe(8);
  });

  it('reports the full-article wordCount on a middle chunk, not the chunk count', async () => {
    mockFetchFullText.mockResolvedValue(articleResult(TWENTY_WORDS));
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI, offset: 40, limit: 30 });
    const result = await biorxivGetFulltextTool.handler(input, ctx);
    expect(result.length).toBe(30);
    expect(result.hasMore).toBe(true);
    expect(result.wordCount).toBe(20);
    expect(biorxivGetFulltextTool.output.parse(result).wordCount).toBe(20);
  });

  // ── limit (no ceiling) ───────────────────────────────────────────────────────

  it('accepts a limit above 50,000 and returns the rest of the text when it runs past the end', async () => {
    mockFetchFullText.mockResolvedValue(articleResult('E'.repeat(70_000)));
    const result = await runToolContract(
      biorxivGetFulltextTool,
      { doi: DOI, offset: 5_000, limit: 60_000 } as never,
      { context: { errors: biorxivGetFulltextTool.errors } },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      offset: 5_000,
      length: 60_000,
      totalChars: 70_000,
      remainingChars: 5_000,
      hasMore: true,
    });

    const rest = await runToolContract(
      biorxivGetFulltextTool,
      { doi: DOI, offset: 65_000, limit: 1_000_000 } as never,
      { context: { errors: biorxivGetFulltextTool.errors } },
    );
    expect(rest.isError).toBeFalsy();
    expect(rest.structuredContent).toMatchObject({
      length: 5_000,
      remainingChars: 0,
      hasMore: false,
    });
    expect(rest.structuredContent).not.toHaveProperty('truncated');
  });

  it('advertises no ceiling on limit in tools/list beyond the safe-integer bound', () => {
    const schema = z.toJSONSchema(biorxivGetFulltextTool.input, { io: 'input' }) as {
      properties: Record<string, { maximum?: number; minimum?: number }>;
    };
    // `.int()` always emits the safe-integer bound; nothing lower may appear.
    expect(schema.properties.limit).toMatchObject({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });

  // ── Omitted tables ───────────────────────────────────────────────────────────

  describe('tables the page carries no cells for', () => {
    const TABLES = [
      {
        label: 'Table 1',
        url: 'https://www.medrxiv.org/highwire/markup/160719/expansion?width=1000&height=500&iframe=true',
      },
      {
        label: 'Table S2*',
        url: 'https://www.medrxiv.org/highwire/markup/160732/expansion?width=1000&height=500&iframe=true',
      },
    ];

    async function chunk(offset: number, limit: number) {
      const result = await runToolContract(
        biorxivGetFulltextTool,
        { doi: DOI, offset, limit } as never,
        { context: { errors: biorxivGetFulltextTool.errors } },
      );
      return {
        structured: result.structuredContent as Record<string, unknown>,
        text: (result.content[0] as { text: string }).text,
      };
    }

    beforeEach(() => {
      mockFetchFullText.mockResolvedValue({
        kind: 'article',
        markdown: TWENTY_WORDS,
        sourceUrl: SOURCE_URL,
        omittedTables: TABLES,
      } satisfies FullTextFetchResult);
    });

    it.each([
      ['first', 0],
      ['middle', 60],
      ['last', 140],
    ])('names every omitted table on both surfaces of the %s chunk', async (_which, offset) => {
      const { structured, text } = await chunk(offset, 50);
      expect(structured.omittedTables).toEqual(TABLES);
      for (const { url } of TABLES) expect(text).toContain(url);
      expect(text).toContain('Table 1');
      // The label is upstream text, escaped like every other upstream field.
      expect(text).toContain('Table S2\\*:');
      expect(text).toMatch(/2 tables/i);
    });

    it('says on the final chunk that the text ends without those cells', async () => {
      const { structured, text } = await chunk(140, 50);
      expect(structured.hasMore).toBe(false);
      expect(text).toMatch(/End of extracted text.*table cells listed above are not included/is);
    });

    it('leaves the field and the notice out for an article with no omitted tables', async () => {
      mockFetchFullText.mockResolvedValue(articleResult(TWENTY_WORDS));
      const { structured, text } = await chunk(0, 50);
      expect(structured).not.toHaveProperty('omittedTables');
      expect(text).not.toMatch(/tables? not included|omitted/i);
    });
  });

  it('throws offset_out_of_range when offset is past the end', async () => {
    mockFetchFullText.mockResolvedValue(articleResult('D'.repeat(50)));
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI, offset: 100 });
    await expect(biorxivGetFulltextTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'offset_out_of_range' },
    });
  });

  // ── Error contract ───────────────────────────────────────────────────────────

  it('throws invalid_doi_format for a malformed DOI', async () => {
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: 'not-a-doi' });
    await expect(biorxivGetFulltextTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_doi_format' },
    });
    expect(mockGetDetails).not.toHaveBeenCalled();
  });

  it('throws doi_not_found when every attempted server answers empty', async () => {
    mockGetDetails.mockResolvedValue([]);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    await expect(biorxivGetFulltextTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found', servers: ['biorxiv', 'medrxiv'] },
    });
    expect(mockFetchFullText).not.toHaveBeenCalled();
  });

  it('throws retryable upstream_unavailable when every lookup fails, not doi_not_found', async () => {
    mockGetDetails.mockRejectedValue(new Error('api.biorxiv.org unreachable'));
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true, servers: ['biorxiv', 'medrxiv'] },
    });
    expect(err.cause).toBeInstanceOf(Error);
    expect(mockFetchFullText).not.toHaveBeenCalled();

    const result = await runToolContract(biorxivGetFulltextTool, { doi: DOI } as never, {
      context: { errors: biorxivGetFulltextTool.errors },
    });
    // The resolution message names servers on api.biorxiv.org, never a page origin.
    expect(envelopeHint(result)).toBe(
      'Retry the request after a short delay — the preprint may well exist; api.biorxiv.org did not answer the version lookup.',
    );
  });

  describe('an article fetch that fails for a reason other than the page not answering', () => {
    it.each([
      [
        'an origin 400',
        new McpError(
          JsonRpcErrorCode.InvalidParams,
          `Fetch failed for ${SOURCE_URL}. Status: 400`,
          { status: 400, retryable: false },
        ),
      ],
      [
        'an extractor rejection',
        new McpError(JsonRpcErrorCode.ValidationError, 'HTML extraction failed.', {
          reason: 'html_extract_failed',
        }),
      ],
      ['a programmer error', new TypeError('Cannot read properties of undefined')],
    ])('keeps %s as it was thrown, never a retryable "did not answer"', async (_label, thrown) => {
      mockFetchFullText.mockRejectedValue(thrown);
      const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
      const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
      expect(await rejection(biorxivGetFulltextTool.handler(input, ctx))).toBe(thrown);
    });

    it('still reports a 503 from the article page as retryable upstream_unavailable', async () => {
      const upstream = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Fetch failed for ${SOURCE_URL}. Status: 503 (failed after 4 attempts)`,
        { status: 503 },
      );
      mockFetchFullText.mockRejectedValue(upstream);
      const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
      const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
      const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true, server: 'biorxiv' },
      });
      expect(err.cause).toBe(upstream);
    });
  });

  // ── One budget across the chain ─────────────────────────────────────────────

  describe('call budget', () => {
    /** What fetchFullText throws when the article page outlasts the call's budget. */
    const pageExpiry = () =>
      new McpError(
        JsonRpcErrorCode.Timeout,
        'BiorxivFullTextService.fetchFullText exceeded its 30000ms retry deadline after 2 attempts.',
        { reason: 'retry_deadline_exceeded', deadlineMs: 30_000, retryAttempts: 2 },
      );

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('hands the article page what version resolution left of one 50 s budget', async () => {
      const remaining: number[] = [];
      mockGetDetails.mockImplementation(
        budgetStep(remaining, 20_000, [{ doi: DOI, version: '2', server: 'biorxiv' }]),
      );
      mockFetchFullText.mockImplementation(
        budgetStep(remaining, 0, articleResult('A'.repeat(100))),
      );
      const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
      const input = biorxivGetFulltextTool.input.parse({ doi: DOI, server: 'biorxiv' });
      const result = await biorxivGetFulltextTool.handler(input, ctx);

      expect(result.totalChars).toBe(100);
      expect(remaining).toEqual([CALL_BUDGET_MS, 30_000]);
    });

    it('fails an article page that outlasts the budget as retryable upstream_unavailable, never a bare Timeout', async () => {
      const upstream = pageExpiry();
      mockFetchFullText.mockRejectedValue(upstream);
      const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
      const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
      const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'upstream_unavailable',
          retryable: true,
          doi: DOI,
          server: 'biorxiv',
          version: '2',
        },
      });
      expect(err.message).toContain('exceeded its 30000ms retry deadline');
      expect(err.cause).toBe(upstream);
      // Resolution answered, so the metadata fallback still works.
      expect(recoveryHint(err)).toContain('www.biorxiv.org');
      expect(recoveryHint(err)).toContain('biorxiv_get_preprint');
    });

    it('carries the article-page failure on both client surfaces', async () => {
      mockFetchFullText.mockRejectedValue(pageExpiry());
      const result = await runToolContract(biorxivGetFulltextTool, { doi: DOI } as never, {
        context: { errors: biorxivGetFulltextTool.errors },
      });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { code: number; data: { reason?: string; retryable?: boolean } };
      };
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
      const text = (result.content as { text: string }[])[0]?.text ?? '';
      expect(text).toContain('exceeded its 30000ms retry deadline');
      expect(text).toContain('biorxiv_get_preprint');
      expect(text).toContain('(reason upstream_unavailable · retryable)');
    });
  });

  // ── Version resolution across both servers ─────────────────────────────────

  describe('version resolution across both servers', () => {
    const REVISIONS = [
      { doi: DOI, version: '1' },
      { doi: DOI, version: '2' },
    ];
    /** Whether the other server's lookup goes unanswered, as the message names it. */
    const OTHER_UNANSWERED = ' (medrxiv did not answer)';
    /** The page cut off by the budget after biorxiv answered 49.5 s in. */
    const pageCutMessage = (other = OTHER_UNANSWERED) =>
      `Version lookup for ${DOI} used 49.5 s of the call's 50 s time budget before biorxiv resolved the DOI${other}, so the biorxiv article page got only the remaining 500 ms and had not answered when the budget ran out.`;
    /** The page never requested after biorxiv answered as the budget ran out. */
    const neverRequestedMessage = (other = OTHER_UNANSWERED) =>
      `Version lookup for ${DOI} used the call's whole 50 s time budget before biorxiv resolved the DOI${other}, so the biorxiv article page was never requested.`;
    const BUDGET_HINT =
      'Call biorxiv_get_fulltext again with server="biorxiv" — the preprint is on biorxiv, so the retry spends the call\'s whole time budget there: the version lookup, then the article page.';

    /** The leg signal each getDetails call was handed, by server. */
    let legSignals: Record<string, AbortSignal | undefined>;
    /** When each article-page request went out, in ms after the call started. */
    let pageRequestedAt: number[];
    /** When each request of a {@link servicePage} went out, in ms after the call started. */
    let pageAttemptsAt: number[];

    /**
     * The article page as BiorxivFullTextService fetches it: from the cache when
     * `cached` is set, else on the real retry ladder over what is left of the
     * call's deadline. Each request is still waiting when the budget cuts it off,
     * unless `answerMs` passes first: then it answers the article, or rejects
     * with `fails()`.
     */
    const servicePage = (page: { cached?: boolean; answerMs?: number; fails?: () => unknown }) => {
      const origin = hungOrigin();
      const startedAt = Date.now();
      mockFetchFullText.mockImplementation(
        (_server: string, _doi: string, _version: string, deadline: CallDeadline, ctx: Context) => {
          if (page.cached) return Promise.resolve(articleResult('A'.repeat(100)));
          return retryWithinBudget(
            ({ signal, remainingMs }) => {
              pageAttemptsAt.push(Date.now() - startedAt);
              const request = origin.fetch(SOURCE_URL, Math.min(30_000, remainingMs), ctx, {
                signal,
              });
              if (page.answerMs === undefined) return request;
              const answer = new Promise((resolve, reject) =>
                setTimeout(
                  () =>
                    page.fails ? reject(page.fails()) : resolve(articleResult('A'.repeat(100))),
                  page.answerMs,
                ),
              );
              return Promise.race([answer, request]);
            },
            {
              operation: 'BiorxivFullTextService.fetchFullText',
              context: ctx,
              baseDelayMs: 500,
              signal: ctx.signal,
              deadline,
            },
          );
        },
      );
    };

    const call = (input: Record<string, unknown> = { doi: DOI }) =>
      settle(
        Promise.resolve(
          biorxivGetFulltextTool.handler(
            biorxivGetFulltextTool.input.parse(input),
            createMockContext({ errors: biorxivGetFulltextTool.errors }),
          ),
        ),
      );
    const contractCall = (signal?: AbortSignal) =>
      settle(
        runToolContract(biorxivGetFulltextTool, { doi: DOI } as never, {
          context: { errors: biorxivGetFulltextTool.errors, ...(signal && { signal }) },
        }),
      );

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
      legSignals = {};
      pageRequestedAt = [];
      pageAttemptsAt = [];
      const startedAt = Date.now();
      mockFetchFullText.mockImplementation(() => {
        pageRequestedAt.push(Date.now() - startedAt);
        return Promise.resolve(articleResult('A'.repeat(100)));
      });
    });
    afterEach(() => vi.useRealTimers());

    it.each([
      ['biorxiv', 'medrxiv'],
      ['medrxiv', 'biorxiv'],
    ])(
      'requests the article page the moment %s, the server holding the DOI, answers',
      async (holder, other) => {
        routeLegs(
          mockGetDetails,
          {
            [holder]: () => answerAfter(1_000, REVISIONS),
            [other]: (signal) => neverAnswers(signal, CALL_BUDGET_MS),
          },
          legSignals,
        );
        const { value, elapsedMs } = await call();

        expect(pageRequestedAt).toEqual([1_000]);
        expect(elapsedMs).toBe(1_000);
        expect(value).toMatchObject({ server: holder, version: '2', totalChars: 100 });
        expect(mockFetchFullText).toHaveBeenCalledWith(
          holder,
          DOI,
          '2',
          expect.any(Number),
          expect.anything(),
        );
      },
    );

    it('aborts the lookup still running on the other server, and only that one', async () => {
      routeLegs(
        mockGetDetails,
        {
          biorxiv: () => answerAfter(1_000, REVISIONS),
          medrxiv: (signal) => neverAnswers(signal, CALL_BUDGET_MS),
        },
        legSignals,
      );
      await call();

      expect(legSignals.medrxiv?.aborted).toBe(true);
      expect(legSignals.biorxiv?.aborted).toBe(false);
    });

    it('waits for the server holding the DOI exactly as long as before when it answers last', async () => {
      routeLegs(
        mockGetDetails,
        {
          biorxiv: () => answerAfter(3_000, REVISIONS),
          medrxiv: () => answerAfter(1_000, []),
        },
        legSignals,
      );
      const { value, elapsedMs } = await call();

      expect(pageRequestedAt).toEqual([3_000]);
      expect(elapsedMs).toBe(3_000);
      expect(value).toMatchObject({ server: 'biorxiv', version: '2' });
      // Every lookup had answered, so none was cut short.
      expect(legSignals.medrxiv?.aborted).not.toBe(true);
    });

    it('reads a metadata 429 only from a lookup that had answered when resolution ended', async () => {
      routeLegs(
        mockGetDetails,
        {
          biorxiv: () => answerAfter(1_000, REVISIONS),
          // The 429 this lookup would have reported a second after resolution ended.
          medrxiv: () =>
            new Promise((_resolve, reject) => setTimeout(() => reject(rateLimitError(45)), 2_000)),
        },
        legSignals,
      );
      mockFetchFullText.mockImplementation(() =>
        answerAfter(1_500, {
          kind: 'unavailable',
          reason: 'rate_limited',
          detail: 'The full-text origin is rate-limiting this host (HTTP 429).',
          retryAfter: 20,
          sourceUrl: SOURCE_URL,
        } satisfies FullTextFetchResult),
      );
      const { err, elapsedMs } = await call();

      expect(elapsedMs).toBe(2_500);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'rate_limited', retryAfter: 20 },
      });
      expect(recoveryHint(err)).toContain(
        'api.biorxiv.org answered this call, so biorxiv_get_preprint still serves',
      );
    });

    describe('when version resolution leaves the article page little or none of the budget', () => {
      /** The other server's lookup, and how the message names it. */
      const OTHER_SERVER: [string, (signal: AbortSignal) => Promise<unknown>, string][] = [
        ['never answered', (signal) => neverAnswers(signal, CALL_BUDGET_MS), OTHER_UNANSWERED],
        [
          'failed',
          () =>
            new Promise((_resolve, reject) =>
              setTimeout(() => reject(new Error('api.biorxiv.org unreachable')), 1_000),
            ),
          OTHER_UNANSWERED,
        ],
        ['answered that it does not hold the DOI', () => answerAfter(1_000, []), ''],
      ];
      const PAGE_HINT =
        'Retry after a short delay — the www.biorxiv.org article page did not answer. api.biorxiv.org resolved this preprint, so biorxiv_get_preprint still serves its title, abstract, and metadata meanwhile.';
      const UPSTREAM_UNAVAILABLE = {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'upstream_unavailable',
          retryable: true,
          doi: DOI,
          server: 'biorxiv',
          version: '2',
        },
      };
      /** bioRxiv holds the DOI and answers `answerMs` in; medRxiv runs `medrxiv`. */
      const holderAnswersAt = (
        answerMs: number,
        medrxiv: (signal: AbortSignal) => Promise<unknown> = (signal) =>
          neverAnswers(signal, CALL_BUDGET_MS),
      ) =>
        routeLegs(
          mockGetDetails,
          { biorxiv: () => answerAfter(answerMs, REVISIONS), medrxiv },
          legSignals,
        );

      it('requests the article page with whatever budget is left, and serves it when it answers in time', async () => {
        holderAnswersAt(CALL_BUDGET_MS - 1_000);
        servicePage({ answerMs: 800 });
        const { value, elapsedMs } = await call();

        expect(pageAttemptsAt).toEqual([CALL_BUDGET_MS - 1_000]);
        expect(elapsedMs).toBe(CALL_BUDGET_MS - 200);
        expect(value).toMatchObject({ server: 'biorxiv', version: '2', totalChars: 100 });
      });

      it.each(OTHER_SERVER)(
        'names the slow lookup when the budget cuts the page off and the other server %s, and sends the retry to the holding server',
        async (_how, medrxiv, other) => {
          holderAnswersAt(CALL_BUDGET_MS - 500, medrxiv);
          servicePage({ answerMs: 800 });
          const { err, elapsedMs } = await call();

          expect(pageAttemptsAt).toEqual([CALL_BUDGET_MS - 500]);
          expect(elapsedMs).toBe(CALL_BUDGET_MS);
          expect(err).toMatchObject(UPSTREAM_UNAVAILABLE);
          expect(err.message).toBe(pageCutMessage(other));
          expect(recoveryHint(err)).toBe(BUDGET_HINT);
          expect(err.cause).toMatchObject({
            code: JsonRpcErrorCode.Timeout,
            message:
              'BiorxivFullTextService.fetchFullText exceeded its 500ms retry deadline after 1 attempt.',
            data: { reason: 'retry_deadline_exceeded', retryAttempts: 1 },
          });
        },
      );

      it.each(OTHER_SERVER)(
        'names the slow lookup when no budget is left and nothing is cached and the other server %s, without requesting the page',
        async (_how, medrxiv, other) => {
          holderAnswersAt(CALL_BUDGET_MS, medrxiv);
          servicePage({ answerMs: 800 });
          const { err, elapsedMs } = await call();

          expect(mockFetchFullText).toHaveBeenCalledTimes(1);
          expect(pageAttemptsAt).toEqual([]);
          expect(elapsedMs).toBe(CALL_BUDGET_MS);
          expect(err).toMatchObject(UPSTREAM_UNAVAILABLE);
          expect(err.message).toBe(neverRequestedMessage(other));
          expect(recoveryHint(err)).toBe(BUDGET_HINT);
        },
      );

      it('serves a cached article even with no budget left', async () => {
        holderAnswersAt(CALL_BUDGET_MS);
        servicePage({ cached: true });
        const { value, elapsedMs } = await call();

        expect(pageAttemptsAt).toEqual([]);
        expect(elapsedMs).toBe(CALL_BUDGET_MS);
        expect(value).toMatchObject({ server: 'biorxiv', version: '2', totalChars: 100 });
      });

      it.each([
        ['cut off by the budget', 500, pageCutMessage()],
        ['never requested', 0, neverRequestedMessage()],
      ])(
        'carries the slow lookup on both client surfaces when the page was %s',
        async (_how, leftMs, message) => {
          holderAnswersAt(CALL_BUDGET_MS - leftMs);
          servicePage({ answerMs: 800 });
          const result = (await contractCall()).value as Awaited<
            ReturnType<typeof runToolContract>
          >;

          expect(result.isError).toBe(true);
          const { error } = result.structuredContent as {
            error: { code: number; message: string; data: Record<string, unknown> };
          };
          expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
          expect(error.message).toBe(message);
          expect(error.data).toMatchObject({
            reason: 'upstream_unavailable',
            retryable: true,
            doi: DOI,
            server: 'biorxiv',
            version: '2',
          });
          expect(envelopeHint(result)).toBe(BUDGET_HINT);
          const text = (result.content as { text: string }[])[0]?.text ?? '';
          expect(text).toContain(message);
          expect(text).toContain(BUDGET_HINT);
          expect(text).toContain('(reason upstream_unavailable · retryable)');
          expect(text).not.toContain('did not answer —');
        },
      );

      it.each([
        ['cut off by the budget', 500, pageCutMessage('')],
        ['never requested', 0, neverRequestedMessage('')],
      ])(
        'words the failure for a caller who scoped resolution to one server, the page %s',
        async (_how, leftMs, message) => {
          routeLegs(
            mockGetDetails,
            { biorxiv: () => answerAfter(CALL_BUDGET_MS - leftMs, REVISIONS) },
            legSignals,
          );
          servicePage({ answerMs: 800 });
          const { err } = await call({ doi: DOI, server: 'biorxiv' });

          expect(mockGetDetails).toHaveBeenCalledTimes(1);
          expect(err).toMatchObject(UPSTREAM_UNAVAILABLE);
          expect(err.message).toBe(message);
          expect(recoveryHint(err)).toBe(BUDGET_HINT);
        },
      );

      it.each([
        [
          'exactly half of it, the page as long as the lookup',
          CALL_BUDGET_MS / 2,
          `The biorxiv article page for ${DOI} v2 did not answer — BiorxivFullTextService.fetchFullText exceeded its 25000ms retry deadline after 1 attempt.`,
          PAGE_HINT,
        ],
        [
          'one millisecond past half of it',
          CALL_BUDGET_MS / 2 + 1,
          `Version lookup for ${DOI} used 25.0 s of the call's 50 s time budget before biorxiv resolved the DOI${OTHER_UNANSWERED}, so the biorxiv article page got only the remaining 25.0 s and had not answered when the budget ran out.`,
          BUDGET_HINT,
        ],
      ])(
        'blames the lookup for a page that never answered only when the lookup used most of the budget — %s',
        async (_how, holderMs, message, hint) => {
          holderAnswersAt(holderMs);
          servicePage({});
          const { err, elapsedMs } = await call();

          expect(pageAttemptsAt).toEqual([holderMs]);
          expect(elapsedMs).toBe(CALL_BUDGET_MS);
          expect(err).toMatchObject(UPSTREAM_UNAVAILABLE);
          expect(err.message).toBe(message);
          expect(recoveryHint(err)).toBe(hint);
        },
      );

      it('keeps a page that failed on its own inside a short remainder a failure of the page', async () => {
        holderAnswersAt(CALL_BUDGET_MS - 500);
        const outage = new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `Fetch failed for ${SOURCE_URL}. Status: 503`,
          { status: 503 },
        );
        // A 503 400 ms in leaves 100 ms, less than the 375–625 ms backoff before a retry.
        servicePage({ answerMs: 400, fails: () => outage });
        const { err } = await call();

        expect(pageAttemptsAt).toEqual([CALL_BUDGET_MS - 500]);
        expect(err).toMatchObject(UPSTREAM_UNAVAILABLE);
        expect(err.message).toBe(
          `The biorxiv article page for ${DOI} v2 did not answer — BiorxivFullTextService.fetchFullText exceeded its 500ms retry deadline after 1 attempt.`,
        );
        expect(recoveryHint(err)).toBe(PAGE_HINT);
        expect((err.cause as McpError).cause).toBe(outage);
      });

      it('still requests the article page with 1 ms of the budget left', async () => {
        routeLegs(
          mockGetDetails,
          {
            biorxiv: () => answerAfter(CALL_BUDGET_MS - 1, REVISIONS),
            medrxiv: (signal) => neverAnswers(signal, CALL_BUDGET_MS),
          },
          legSignals,
        );
        const { value } = await call();

        expect(pageRequestedAt).toEqual([CALL_BUDGET_MS - 1]);
        expect(value).toMatchObject({ server: 'biorxiv', version: '2', totalChars: 100 });
      });
    });

    it('still settles a caller cancellation during resolution as RequestCancelled, never a failed lookup', async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('cancelled by caller')), 5_000);
      routeLegs(
        mockGetDetails,
        { biorxiv: (signal) => neverAnswers(signal), medrxiv: (signal) => neverAnswers(signal) },
        legSignals,
      );
      const { value, elapsedMs } = await contractCall(controller.signal);
      const result = value as Awaited<ReturnType<typeof runToolContract>>;

      expect(elapsedMs).toBe(5_000);
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: number; message: string } };
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      // Both lookups rejected only because the caller left: neither failed.
      expect(error.message).toBe('cancelled by caller');
      const text = (result.content as { text: string }[])[0]?.text ?? '';
      expect(text).not.toContain('Version lookup');
      expect(mockFetchFullText).not.toHaveBeenCalled();
    });
  });

  it('declares a rate_limited recovery that holds when the origin named no wait', () => {
    expect(declaredRateLimitRecovery(biorxivGetFulltextTool.errors)).toBe(
      `${RATE_LIMIT_RECOVERY_OPENING}calling again; the recovery hint names which origins are limiting and what still works meanwhile.`,
    );
  });

  it('throws retryable rate_limited with the origin Retry-After wait and the metadata fallback', async () => {
    mockFetchFullText.mockResolvedValue({
      kind: 'unavailable',
      reason: 'rate_limited',
      detail:
        'The full-text origin is rate-limiting this host (HTTP 429) and asked for a 94-second wait before the next request.',
      retryAfter: 94,
      sourceUrl: SOURCE_URL,
    } satisfies FullTextFetchResult);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryable: true, retryAfter: 94 },
    });
    const hint = recoveryHint(err);
    expect(hint).toContain('94 seconds');
    expect(hint).toContain('biorxiv_get_preprint');
    expect(JSON.stringify(err)).not.toMatch(/Cloudflare|DOCTYPE/i);
  });

  it('falls back to a generic wait in the rate_limited hint when the origin sent no Retry-After', async () => {
    mockFetchFullText.mockResolvedValue({
      kind: 'unavailable',
      reason: 'rate_limited',
      detail: 'The full-text origin is rate-limiting this host (HTTP 429).',
      sourceUrl: SOURCE_URL,
    } satisfies FullTextFetchResult);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));

    expect(err).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    expect(err.data?.retryAfter).toBeUndefined();
    expect(recoveryHint(err)).toContain('biorxiv_get_preprint');
  });

  it('throws rate_limited when the metadata origin rate-limits version resolution', async () => {
    const upstream = rateLimitError(30);
    mockGetDetails.mockRejectedValue(upstream);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryable: true,
        retryAfter: 30,
        servers: ['biorxiv', 'medrxiv'],
      },
    });
    expect(err.cause).toBe(upstream);
    expect(mockFetchFullText).not.toHaveBeenCalled();
  });

  it('names api.biorxiv.org in the resolution rate-limit hint and withholds the metadata fallback', async () => {
    // biorxiv_get_preprint queries the same origin, so recommending it here — as
    // the article-page rate limit does — would send the caller into the limit.
    mockGetDetails.mockRejectedValue(rateLimitError(30));
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));

    const hint = recoveryHint(err);
    expect(hint).toContain('30 seconds');
    expect(hint).toContain('api.biorxiv.org');
    expect(hint).toMatch(/same origin/i);
    expect(hint).not.toContain('article-page');
  });

  it('names the article-page origin in the full-text rate-limit hint and keeps the metadata fallback', async () => {
    mockFetchFullText.mockResolvedValue({
      kind: 'unavailable',
      reason: 'rate_limited',
      detail: 'The full-text origin is rate-limiting this host (HTTP 429).',
      retryAfter: 94,
      sourceUrl: SOURCE_URL,
    } satisfies FullTextFetchResult);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));

    const hint = recoveryHint(err);
    expect(hint).toContain('94 seconds');
    expect(hint).toContain('article-page origin');
    expect(hint).toContain('biorxiv_get_preprint');
    // Same reason, two origins — the payloads stay structurally distinguishable
    expect(err.data?.sourceUrl).toBe(SOURCE_URL);
    expect(err.data?.servers).toBeUndefined();
  });

  it('withholds the metadata fallback when the surviving server masked a resolution 429', async () => {
    // One server answering resolution does not mean api.biorxiv.org let the other
    // one through. Recommending biorxiv_get_preprint here would send the caller
    // straight back into the metadata origin's limit.
    mockGetDetails.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv'
        ? Promise.reject(rateLimitError(45))
        : Promise.resolve([{ doi: DOI, version: '2', server: 'medrxiv' }]),
    );
    mockFetchFullText.mockResolvedValue({
      kind: 'unavailable',
      reason: 'rate_limited',
      detail: 'The full-text origin is rate-limiting this host (HTTP 429).',
      retryAfter: 20,
      sourceUrl: SOURCE_URL,
    } satisfies FullTextFetchResult);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI, server: 'both' });
    const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));

    // A retry re-runs resolution, so the wait has to clear the longer of the two.
    expect(err.data?.retryAfter).toBe(45);
    const hint = recoveryHint(err);
    expect(hint).toContain('45 seconds');
    expect(hint).toContain('api.biorxiv.org');
    expect(hint).toMatch(/not answer sooner/i);
    expect(hint).not.toMatch(/unaffected|still serves/i);
  });

  it('throws fulltext_unavailable when the page is blocked or PDF-only', async () => {
    mockFetchFullText.mockResolvedValue({
      kind: 'unavailable',
      reason: 'blocked',
      detail: 'The full-text HTML page is not accessible (HTTP 403).',
      sourceUrl: SOURCE_URL,
    } satisfies FullTextFetchResult);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI, server: 'medrxiv' });
    await expect(biorxivGetFulltextTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'fulltext_unavailable' },
    });
  });

  it('does not leak secrets in the fulltext_unavailable error', async () => {
    mockFetchFullText.mockResolvedValue({
      kind: 'unavailable',
      reason: 'empty',
      detail: 'No extractable text.',
      sourceUrl: SOURCE_URL,
    } satisfies FullTextFetchResult);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));
    expect(JSON.stringify(err)).not.toMatch(/password|secret|token|BIORXIV_MAILTO/i);
  });

  // ── format ───────────────────────────────────────────────────────────────────

  it('formats output with identity, paging state, caveat, and content', () => {
    const blocks = biorxivGetFulltextTool.format!({
      doi: DOI,
      server: 'biorxiv',
      version: '2',
      title: 'A Title',
      content: 'The article body.',
      contentFormat: 'html-markdown',
      wordCount: 3,
      sourceUrl: SOURCE_URL,
      offset: 0,
      length: 17,
      totalChars: 17,
      remainingChars: 0,
      hasMore: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(DOI);
    expect(text).toContain('**Full-article word count:** 3');
    // The server that answered the DOI resolution reaches the content[] surface too
    expect(text).toContain('**Server:** biorxiv');
    expect(text).toContain('A Title');
    expect(text).toContain('The article body.');
    expect(text).toContain(SOURCE_URL);
    expect(text).toContain('html-markdown');
    expect(text).toContain('not JATS');
    expect(text).toContain('End of extracted text');
  });

  it('format prompts the next call when more text remains', () => {
    const blocks = biorxivGetFulltextTool.format!({
      doi: DOI,
      server: 'biorxiv',
      version: '1',
      content: 'chunk one',
      contentFormat: 'html-markdown',
      wordCount: 7,
      sourceUrl: SOURCE_URL,
      offset: 0,
      length: 9,
      totalChars: 40,
      remainingChars: 31,
      hasMore: true,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('offset=9');
    expect(text).not.toContain('undefined');
  });

  it('escapes the page title in content[] but never the extracted Markdown or source URL', async () => {
    const markdown = '## Results\n\nWe edit *A•T* pairs with `ABE8e` — see [Figure 1](#F1).';
    const sourceUrl = `https://www.biorxiv.org/content/${DOI}v2.full?utm_source=x_y`;
    mockFetchFullText.mockResolvedValue({
      kind: 'article',
      markdown,
      title: UPSTREAM.title,
      sourceUrl,
    } satisfies FullTextFetchResult);

    const result = await runToolContract(
      biorxivGetFulltextTool,
      { doi: DOI },
      { context: { errors: biorxivGetFulltextTool.errors } },
    );
    const text = (result.content[0] as { text: string }).text;

    expect(result.structuredContent).toMatchObject({
      title: UPSTREAM.title,
      content: markdown,
      sourceUrl,
    });
    expect(text).toContain(`## ${ESCAPED.title}\n`);
    expect(text).toContain(`\n${markdown}\n`);
    expect(text).toContain(`**Source:** ${sourceUrl}\n`);
  });
});
