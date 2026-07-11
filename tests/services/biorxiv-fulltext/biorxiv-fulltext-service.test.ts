/**
 * @fileoverview Tests for BiorxivFullTextService — full-text HTML fetch, Markdown
 * extraction, challenge/block detection, and unavailable-vs-transient classification.
 * @module tests/services/biorxiv-fulltext/biorxiv-fulltext-service.test
 */

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

/** McpError shaped like fetchWithTimeout's non-2xx throw (carries data.statusCode). */
function httpError(status: number): McpError {
  const code =
    status === 403
      ? JsonRpcErrorCode.Forbidden
      : status === 404
        ? JsonRpcErrorCode.NotFound
        : JsonRpcErrorCode.ServiceUnavailable;
  return new McpError(code, `Fetch failed. Status: ${status}`, { statusCode: status });
}

const ARTICLE_HTML =
  '<html><body><div class="article fulltext-view">real content</div></body></html>';
const MOCK_CONFIG = {} as AppConfig;
const MOCK_STORAGE = {} as StorageService;

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
    const ctx = createMockContext();
    const result = await service.fetchFullText('biorxiv', '10.1101/2024.05.28.596311', '1', ctx);
    expect(result.kind).toBe('article');
    if (result.kind === 'article') {
      expect(result.markdown).toContain('Body paragraph.');
      expect(result.title).toBe('A Preprint Title');
      expect(result.wordCount).toBe(1234);
      expect(result.sourceUrl).toBe(
        'https://www.biorxiv.org/content/10.1101/2024.05.28.596311v1.full',
      );
    }
  });

  it('builds the URL with the resolved version and the correct server host', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: 'text' });
    const ctx = createMockContext();
    await service.fetchFullText('medrxiv', '10.1101/2024.05.31.24308283', '3', ctx);
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toBe('https://www.medrxiv.org/content/10.1101/2024.05.31.24308283v3.full');
  });

  it('passes the fulltext-view content selector to the extractor', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: 'text' });
    const ctx = createMockContext();
    await service.fetchFullText('biorxiv', '10.1101/2024.05.28.596311', '1', ctx);
    const opts = (mockExtract.mock.calls[0] as [string, { contentSelector?: string }])[1];
    expect(opts.contentSelector).toBe('.fulltext-view');
    expect(opts).toMatchObject({ format: 'markdown' });
  });

  it('returns unavailable/empty when extraction yields no text (PDF-only preprint)', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: '   \n  ' });
    const ctx = createMockContext();
    const result = await service.fetchFullText('biorxiv', '10.1101/2024.05.28.596311', '1', ctx);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('empty');
  });

  it('returns unavailable/blocked for a Cloudflare challenge page served with 200', async () => {
    mockFetch.mockResolvedValue(
      makeHtmlResponse(
        '<html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>',
      ),
    );
    const ctx = createMockContext();
    const result = await service.fetchFullText('medrxiv', '10.1101/2024.05.31.24308283', '1', ctx);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('blocked');
    // Extraction must never run on a challenge page
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('returns unavailable/blocked for a 403 (medRxiv Cloudflare block)', async () => {
    mockFetch.mockRejectedValue(httpError(403));
    const ctx = createMockContext();
    const result = await service.fetchFullText('medrxiv', '10.1101/2024.05.31.24308283', '1', ctx);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('blocked');
      expect(result.detail).toContain('403');
    }
  });

  it('returns unavailable/blocked for a 404 (no rendered page for this version)', async () => {
    mockFetch.mockRejectedValue(httpError(404));
    const ctx = createMockContext();
    const result = await service.fetchFullText('biorxiv', '10.1101/2024.05.28.596311', '9', ctx);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('blocked');
  });

  it('bubbles transient 5xx as an error rather than classifying it unavailable', async () => {
    mockFetch.mockRejectedValue(httpError(503));
    const ctx = createMockContext();
    await expect(
      service.fetchFullText('biorxiv', '10.1101/2024.05.28.596311', '1', ctx),
    ).rejects.toThrow();
  });

  it('bubbles a network error (no statusCode) rather than classifying it unavailable', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    const ctx = createMockContext();
    await expect(
      service.fetchFullText('biorxiv', '10.1101/2024.05.28.596311', '1', ctx),
    ).rejects.toThrow('connection refused');
  });

  it('omits title and wordCount when the extractor does not report them', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: 'body only' });
    const ctx = createMockContext();
    const result = await service.fetchFullText('biorxiv', '10.1101/2024.05.28.596311', '1', ctx);
    expect(result.kind).toBe('article');
    if (result.kind === 'article') {
      expect(result.title).toBeUndefined();
      expect(result.wordCount).toBeUndefined();
    }
  });
});
