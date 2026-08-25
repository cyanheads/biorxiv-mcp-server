/**
 * @fileoverview Tests for BiorxivFullTextService — full-text HTML fetch, Markdown
 * extraction, challenge/block detection, 429 rate-limit classification,
 * unavailable-vs-transient classification, and the per-version ctx.state cache.
 * @module tests/services/biorxiv-fulltext/biorxiv-fulltext-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BiorxivFullTextService } from '@/services/biorxiv-fulltext/biorxiv-fulltext-service.js';

const mockFetch = vi.fn();
const mockExtract = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetch(...args),
  withRetry: async (fn: () => Promise<unknown>) => fn(),
  htmlExtractor: { extract: (...args: unknown[]) => mockExtract(...args) },
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    mailto: 'test@example.com',
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
    biorxivWebBaseUrl: 'https://www.biorxiv.org',
    medrxivWebBaseUrl: 'https://www.medrxiv.org',
  }),
}));

function makeHtmlResponse(html: string): Response {
  return { text: () => Promise.resolve(html), ok: true, status: 200 } as unknown as Response;
}

const BLOCK_PAGE_HTML =
  '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>cf-error-details</body></html>';

/**
 * McpError shaped like fetchWithTimeout's non-2xx throw: canonical `status`/`body`
 * plus the legacy `statusCode`/`responseBody` aliases, and `retryAfter` when the
 * origin sent the header.
 */
function httpError(status: number, retryAfter?: string): McpError {
  const code =
    status === 403
      ? JsonRpcErrorCode.Forbidden
      : status === 404
        ? JsonRpcErrorCode.NotFound
        : status === 429
          ? JsonRpcErrorCode.RateLimited
          : JsonRpcErrorCode.ServiceUnavailable;
  return new McpError(code, `Fetch failed. Status: ${status}`, {
    status,
    statusCode: status,
    statusText: 'Too Many Requests',
    body: BLOCK_PAGE_HTML,
    responseBody: BLOCK_PAGE_HTML,
    ...(retryAfter !== undefined && { retryAfter }),
  });
}

const ARTICLE_HTML =
  '<html><body><div class="article fulltext-view">real content</div></body></html>';
const MOCK_CONFIG = {} as AppConfig;
const MOCK_STORAGE = {} as StorageService;
const DOI = '10.1101/2024.05.28.596311';

/**
 * Context whose `ctx.state` runs through the real `StorageService` over an
 * in-memory provider, so cache keys face the same validation
 * (`[a-zA-Z0-9_.\-/]`, no `..`) and TTL handling a deployed server applies.
 */
const tenantCtx = () => createMockContext({ tenantId: 'test-tenant' });

/**
 * Context resolving no tenant — an HTTP request under a JWT whose token carries
 * no `tid` claim. `createMockContext` defaults `tenantId` to `'default'`, so the
 * uncached branch has to be produced explicitly.
 */
const tenantlessCtx = (): Context => ({ ...createMockContext(), tenantId: undefined });

describe('BiorxivFullTextService', () => {
  let service: BiorxivFullTextService;

  beforeEach(() => {
    service = new BiorxivFullTextService(MOCK_CONFIG, MOCK_STORAGE);
    mockFetch.mockReset();
    mockExtract.mockReset();
  });

  it('returns extracted Markdown for a successful fetch', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({
      content: '# Title\n\nBody paragraph.',
      title: 'A Preprint Title',
      wordCount: 1234,
    });
    const result = await service.fetchFullText('biorxiv', DOI, '1', tenantCtx());
    expect(result.kind).toBe('article');
    if (result.kind === 'article') {
      expect(result.markdown).toContain('Body paragraph.');
      expect(result.title).toBe('A Preprint Title');
      expect(result.wordCount).toBe(1234);
      expect(result.sourceUrl).toBe(`https://www.biorxiv.org/content/${DOI}v1.full`);
    }
  });

  it('builds the URL with the resolved version and the correct server host', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: 'text' });
    await service.fetchFullText('medrxiv', '10.1101/2024.05.31.24308283', '3', tenantCtx());
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toBe('https://www.medrxiv.org/content/10.1101/2024.05.31.24308283v3.full');
  });

  it('passes the fulltext-view content selector to the extractor', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: 'text' });
    await service.fetchFullText('biorxiv', DOI, '1', tenantCtx());
    const opts = (mockExtract.mock.calls[0] as [string, { contentSelector?: string }])[1];
    expect(opts.contentSelector).toBe('.fulltext-view');
    expect(opts).toMatchObject({ format: 'markdown' });
  });

  it('returns unavailable/empty when extraction yields no text (PDF-only preprint)', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: '   \n  ' });
    const result = await service.fetchFullText('biorxiv', DOI, '1', tenantCtx());
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('empty');
  });

  it('returns unavailable/blocked for a Cloudflare challenge page served with 200', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(BLOCK_PAGE_HTML));
    const result = await service.fetchFullText(
      'medrxiv',
      '10.1101/2024.05.31.24308283',
      '1',
      tenantCtx(),
    );
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('blocked');
    // Extraction must never run on a challenge page
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('returns unavailable/blocked for a 403 (medRxiv Cloudflare block)', async () => {
    mockFetch.mockRejectedValue(httpError(403));
    const result = await service.fetchFullText(
      'medrxiv',
      '10.1101/2024.05.31.24308283',
      '1',
      tenantCtx(),
    );
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('blocked');
      expect(result.detail).toContain('403');
    }
  });

  it('returns unavailable/blocked for a 404 (no rendered page for this version)', async () => {
    mockFetch.mockRejectedValue(httpError(404));
    const result = await service.fetchFullText('biorxiv', DOI, '9', tenantCtx());
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('blocked');
  });

  it('bubbles transient 5xx as an error rather than classifying it unavailable', async () => {
    mockFetch.mockRejectedValue(httpError(503));
    await expect(service.fetchFullText('biorxiv', DOI, '1', tenantCtx())).rejects.toThrow();
  });

  it('bubbles a network error (no status) rather than classifying it unavailable', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    await expect(service.fetchFullText('biorxiv', DOI, '1', tenantCtx())).rejects.toThrow(
      'connection refused',
    );
  });

  it('omits title and wordCount when the extractor does not report them', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: 'body only' });
    const result = await service.fetchFullText('biorxiv', DOI, '1', tenantCtx());
    expect(result.kind).toBe('article');
    if (result.kind === 'article') {
      expect(result.title).toBeUndefined();
      expect(result.wordCount).toBeUndefined();
    }
  });

  // ── Rate limiting (429) ──────────────────────────────────────────────────────

  describe('origin rate limiting', () => {
    it('classifies a 429 as unavailable/rate_limited carrying the parsed Retry-After', async () => {
      mockFetch.mockRejectedValue(httpError(429, '94'));
      const result = await service.fetchFullText('biorxiv', DOI, '1', tenantCtx());
      expect(result.kind).toBe('unavailable');
      if (result.kind === 'unavailable') {
        expect(result.reason).toBe('rate_limited');
        expect(result.retryAfter).toBe(94);
        expect(result.detail).toContain('94');
      }
    });

    it('converts an HTTP-date Retry-After to a wait in seconds', async () => {
      mockFetch.mockRejectedValue(httpError(429, new Date(Date.now() + 120_000).toUTCString()));
      const result = await service.fetchFullText('biorxiv', DOI, '1', tenantCtx());
      expect(result.kind).toBe('unavailable');
      if (result.kind === 'unavailable') {
        expect(result.retryAfter).toBeGreaterThan(110);
        expect(result.retryAfter).toBeLessThanOrEqual(120);
        expect(result.detail).toMatch(/asked for a \d+-second wait/);
      }
    });

    it('drops an unparseable Retry-After rather than echoing it as a second count', async () => {
      mockFetch.mockRejectedValue(httpError(429, 'soon'));
      const result = await service.fetchFullText('biorxiv', DOI, '1', tenantCtx());
      expect(result.kind).toBe('unavailable');
      if (result.kind === 'unavailable') {
        expect(result.reason).toBe('rate_limited');
        expect(result.retryAfter).toBeUndefined();
        expect(result.detail).not.toContain('soon');
      }
    });

    it('keeps the origin block-page HTML out of the returned result', async () => {
      mockFetch.mockRejectedValue(httpError(429, '94'));
      const result = await service.fetchFullText('biorxiv', DOI, '1', tenantCtx());
      expect(JSON.stringify(result)).not.toMatch(/Cloudflare|DOCTYPE|cf-error-details/i);
    });

    it('classifies a 429 with no Retry-After header and leaves retryAfter absent', async () => {
      mockFetch.mockRejectedValue(httpError(429));
      const result = await service.fetchFullText('biorxiv', DOI, '1', tenantCtx());
      expect(result.kind).toBe('unavailable');
      if (result.kind === 'unavailable') {
        expect(result.reason).toBe('rate_limited');
        expect(result.retryAfter).toBeUndefined();
      }
    });
  });

  // ── ctx.state cache ──────────────────────────────────────────────────────────

  describe('extraction cache', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
      mockExtract.mockResolvedValue({
        content: 'Cached article body.',
        title: 'A Preprint Title',
        wordCount: 42,
      });
    });

    it('serves a repeat lookup for the same server/DOI/version without touching the origin', async () => {
      const ctx = tenantCtx();
      const first = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      const second = await service.fetchFullText('biorxiv', DOI, '2', ctx);

      expect(second).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockExtract).toHaveBeenCalledTimes(1);
    });

    it('refetches when the version differs — a new revision is a new key', async () => {
      const ctx = tenantCtx();
      await service.fetchFullText('biorxiv', DOI, '2', ctx);
      await service.fetchFullText('biorxiv', DOI, '3', ctx);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('refetches when the server differs — the key is per-origin', async () => {
      const ctx = tenantCtx();
      await service.fetchFullText('biorxiv', DOI, '2', ctx);
      await service.fetchFullText('medrxiv', DOI, '2', ctx);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not cache a blocked result — the next call retries the origin', async () => {
      const ctx = tenantCtx();
      mockFetch.mockRejectedValueOnce(httpError(403));
      const blocked = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      expect(blocked.kind).toBe('unavailable');

      const retried = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      expect(retried.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not cache a rate-limited result — the next call retries the origin', async () => {
      const ctx = tenantCtx();
      mockFetch.mockRejectedValueOnce(httpError(429, '94'));
      const limited = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      expect(limited.kind).toBe('unavailable');

      const retried = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      expect(retried.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not cache an empty extraction — the next call retries the origin', async () => {
      const ctx = tenantCtx();
      mockExtract.mockResolvedValueOnce({ content: '  ' });
      const empty = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      expect(empty.kind).toBe('unavailable');

      const retried = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      expect(retried.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('hits the cache through the real StorageService, which validates the key', async () => {
      const ctx = tenantCtx();
      const first = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      const second = await service.fetchFullText('biorxiv', DOI, '2', ctx);

      expect(first.kind).toBe('article');
      expect(second).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockExtract).toHaveBeenCalledTimes(1);
    });

    it('refetches once the cached extraction has outlived its TTL', async () => {
      const ctx = tenantCtx();
      vi.useFakeTimers();
      try {
        await service.fetchFullText('biorxiv', DOI, '2', ctx);
        vi.advanceTimersByTime(3_601_000);
        await service.fetchFullText('biorxiv', DOI, '2', ctx);
      } finally {
        vi.useRealTimers();
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('still returns the article when the storage backend refuses the write', async () => {
      const ctx = tenantCtx();
      ctx.state.set = () => Promise.reject(new Error('storage capacity exceeded'));
      const result = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      expect(result.kind).toBe('article');
      if (result.kind === 'article') expect(result.markdown).toBe('Cached article body.');
    });

    it('falls through to the origin when the storage backend refuses the read', async () => {
      const ctx = tenantCtx();
      ctx.state.get = () => Promise.reject(new Error('storage unreachable'));
      const result = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      expect(result.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('still returns full text for a tenant-less caller, uncached', async () => {
      const ctx = tenantlessCtx();
      const first = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      const second = await service.fetchFullText('biorxiv', DOI, '2', ctx);
      expect(first.kind).toBe('article');
      expect(second.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
