/**
 * @fileoverview Tests for biorxiv_get_fulltext tool — both-server DOI resolution,
 * version resolution, the typed error contract (including rate_limited and
 * upstream_unavailable), offset/limit chunking, and format rendering.
 * @module tests/tools/biorxiv-get-fulltext.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetFulltextTool } from '@/mcp-server/tools/definitions/biorxiv-get-fulltext.tool.js';
import type { FullTextFetchResult } from '@/services/biorxiv-fulltext/biorxiv-fulltext-service.js';

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
    wordCount: 8000,
    sourceUrl: SOURCE_URL,
  };
}

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
    expect(result.wordCount).toBe(8000);
    // fetchFullText receives the resolved version
    expect(mockFetchFullText).toHaveBeenCalledWith('biorxiv', DOI, '2', expect.anything());
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
    expect(mockGetDetails).toHaveBeenCalledWith(DOI, 'biorxiv', expect.anything());
    expect(mockGetDetails).toHaveBeenCalledWith(DOI, 'medrxiv', expect.anything());
    expect(result.server).toBe('biorxiv');
    expect(mockFetchFullText).toHaveBeenCalledWith('biorxiv', DOI, '2', expect.anything());
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
    expect(mockFetchFullText).toHaveBeenCalledWith('medrxiv', DOI, '3', expect.anything());
  });

  it('resolves against one server only when the caller scopes the request', async () => {
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI, server: 'medrxiv' });
    const result = await biorxivGetFulltextTool.handler(input, ctx);

    expect(mockGetDetails).toHaveBeenCalledTimes(1);
    expect(mockGetDetails).toHaveBeenCalledWith(DOI, 'medrxiv', expect.anything());
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
    expect(mockFetchFullText).toHaveBeenCalledWith('medrxiv', DOI, '1', expect.anything());
  });

  it('falls back to version "1" when the latest revision lacks a version field', async () => {
    mockGetDetails.mockResolvedValue([{ doi: DOI, server: 'biorxiv' }]);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const result = await biorxivGetFulltextTool.handler(input, ctx);
    expect(result.version).toBe('1');
    expect(mockFetchFullText).toHaveBeenCalledWith('biorxiv', DOI, '1', expect.anything());
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
    const err = await biorxivGetFulltextTool.handler(input, ctx).catch((e) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true, servers: ['biorxiv', 'medrxiv'] },
    });
    expect((err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint).toContain(
      'Retry',
    );
    expect(err.cause).toBeInstanceOf(Error);
    expect(mockFetchFullText).not.toHaveBeenCalled();
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
    const err = await biorxivGetFulltextTool.handler(input, ctx).catch((e) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryable: true, retryAfter: 94 },
    });
    const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
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
    const err = await biorxivGetFulltextTool.handler(input, ctx).catch((e) => e);

    expect(err).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    expect((err as { data: { retryAfter?: number } }).data.retryAfter).toBeUndefined();
    expect((err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint).toContain(
      'biorxiv_get_preprint',
    );
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
    const err = await biorxivGetFulltextTool.handler(input, ctx).catch((e) => e);
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
      wordCount: 8000,
      sourceUrl: SOURCE_URL,
      offset: 0,
      length: 17,
      totalChars: 17,
      remainingChars: 0,
      hasMore: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(DOI);
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
});
