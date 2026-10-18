/**
 * @fileoverview Tests for BiorxivFullTextService — full-text HTML fetch, Markdown
 * extraction, challenge/block detection, 429 rate-limit classification,
 * unavailable-vs-transient classification, and the per-version ctx.state cache.
 * Extraction on trimmed Highwire article pages runs the real htmlExtractor, so
 * citation labels, reference text, and omitted tables are asserted on what
 * defuddle actually returns.
 * @module tests/services/biorxiv-fulltext/biorxiv-fulltext-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BiorxivFullTextService } from '@/services/biorxiv-fulltext/biorxiv-fulltext-service.js';
import { CALL_BUDGET_MS, type CallDeadline, startCallDeadline } from '@/services/shared.js';
import { type FetchCall, hungOrigin, settle, slowOrigin } from '../../helpers/call-budget.js';
import {
  authorYearVariant,
  BIORXIV_015347,
  BIORXIV_596311,
  HIGHWIRE_FIXTURES,
  type HighwireFixture,
  MEDRXIV_20062463,
} from '../../helpers/highwire-fixtures.js';

const mockFetch = vi.fn();
const mockExtract = vi.fn();

type RetryFn = (
  fn: (attempt: { signal: AbortSignal; remainingMs: number }) => Promise<unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

/**
 * withRetry runs the operation once, handing it the attempt a single
 * unbounded try would get; a test that needs the real retry ladder sets `impl`.
 */
const retry = vi.hoisted(() => ({ impl: undefined as RetryFn | undefined }));

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetch(...args),
  withRetry: ((fn, options) =>
    retry.impl
      ? retry.impl(fn, options)
      : fn({
          signal: options?.signal ?? new AbortController().signal,
          remainingMs: Number.POSITIVE_INFINITY,
        })) satisfies RetryFn,
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

/**
 * Markdown read as the text it renders: backslash escapes dropped, each link
 * reduced to its text (a URL may hold one level of parentheses), whitespace
 * collapsed.
 */
function markdownAsText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ');
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
    retry.impl = undefined;
  });

  it('returns extracted Markdown for a successful fetch', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({
      content: '# Title\n\nBody paragraph.',
      title: 'A Preprint Title',
      wordCount: 1234,
    });
    const result = await service.fetchFullText(
      'biorxiv',
      DOI,
      '1',
      startCallDeadline(),
      tenantCtx(),
    );
    expect(result.kind).toBe('article');
    if (result.kind === 'article') {
      expect(result.markdown).toContain('Body paragraph.');
      expect(result.title).toBe('A Preprint Title');
      // The extractor's figure measures its HTML, not this Markdown — the tool
      // counts the Markdown it pages over instead.
      expect(result).not.toHaveProperty('wordCount');
      expect(result.sourceUrl).toBe(`https://www.biorxiv.org/content/${DOI}v1.full`);
    }
  });

  it('builds the URL with the resolved version and the correct server host', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: 'text' });
    await service.fetchFullText(
      'medrxiv',
      '10.1101/2024.05.31.24308283',
      '3',
      startCallDeadline(),
      tenantCtx(),
    );
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toBe('https://www.medrxiv.org/content/10.1101/2024.05.31.24308283v3.full');
  });

  it('passes the fulltext-view content selector to the extractor', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: 'text' });
    await service.fetchFullText('biorxiv', DOI, '1', startCallDeadline(), tenantCtx());
    const opts = (mockExtract.mock.calls[0] as [string, { contentSelector?: string }])[1];
    expect(opts.contentSelector).toBe('.fulltext-view');
    expect(opts).toMatchObject({ format: 'markdown' });
  });

  it('returns unavailable/empty when extraction yields no text (PDF-only preprint)', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: '   \n  ' });
    const result = await service.fetchFullText(
      'biorxiv',
      DOI,
      '1',
      startCallDeadline(),
      tenantCtx(),
    );
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('empty');
  });

  it('returns unavailable/blocked for a Cloudflare challenge page served with 200', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(BLOCK_PAGE_HTML));
    const result = await service.fetchFullText(
      'medrxiv',
      '10.1101/2024.05.31.24308283',
      '1',
      startCallDeadline(),
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
      startCallDeadline(),
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
    const result = await service.fetchFullText(
      'biorxiv',
      DOI,
      '9',
      startCallDeadline(),
      tenantCtx(),
    );
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('blocked');
  });

  it('bubbles transient 5xx as an error rather than classifying it unavailable', async () => {
    mockFetch.mockRejectedValue(httpError(503));
    await expect(
      service.fetchFullText('biorxiv', DOI, '1', startCallDeadline(), tenantCtx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('bubbles a network error (no status) rather than classifying it unavailable', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    await expect(
      service.fetchFullText('biorxiv', DOI, '1', startCallDeadline(), tenantCtx()),
    ).rejects.toThrow('connection refused');
  });

  it('omits title when the extractor does not report one', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: 'body only' });
    const result = await service.fetchFullText(
      'biorxiv',
      DOI,
      '1',
      startCallDeadline(),
      tenantCtx(),
    );
    expect(result.kind).toBe('article');
    if (result.kind === 'article') expect(result.title).toBeUndefined();
  });

  it('caches under the v3 key generation, never reading a v1 or v2 entry back', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
    mockExtract.mockResolvedValue({ content: 'Fresh extraction.' });
    const ctx = tenantCtx();
    const stale = {
      markdown: 'Stale body from an older build.',
      wordCount: 113,
      sourceUrl: `https://www.biorxiv.org/content/${DOI}v1.full`,
    };
    await ctx.state.set(`fulltext/v1/biorxiv/${DOI}/1`, stale);
    await ctx.state.set(`fulltext/v2/biorxiv/${DOI}/1`, stale);

    const result = await service.fetchFullText('biorxiv', DOI, '1', startCallDeadline(), ctx);
    expect(result.kind === 'article' && result.markdown).toBe('Fresh extraction.');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await ctx.state.get(`fulltext/v3/biorxiv/${DOI}/1`)).toMatchObject({
      markdown: 'Fresh extraction.',
    });
  });

  // ── Extraction on Highwire article pages ─────────────────────────────────────

  // The real extractor is CPU-bound: one page has taken 6.4 s under machine load.
  describe('extraction on Highwire article pages (real extractor)', { timeout: 30_000 }, () => {
    /** The article result for one fixture page, run through the real htmlExtractor. */
    async function extract(fixture: HighwireFixture, ctx = tenantCtx()) {
      mockFetch.mockResolvedValue(makeHtmlResponse(fixture.html));
      const result = await service.fetchFullText(
        fixture.server,
        fixture.doi,
        fixture.version,
        startCallDeadline(),
        ctx,
      );
      if (result.kind !== 'article') throw new Error(`Expected an article, got ${result.reason}`);
      return result;
    }

    beforeEach(async () => {
      const { htmlExtractor } = await vi.importActual<
        typeof import('@cyanheads/mcp-ts-core/utils')
      >('@cyanheads/mcp-ts-core/utils');
      mockExtract.mockImplementation((html: string, options: object) =>
        htmlExtractor.extract(html, options),
      );
    });

    describe.each(HIGHWIRE_FIXTURES.map((f) => [f.sourceUrl, f] as const))(
      '%s',
      (_url, fixture) => {
        it('keeps every inline citation, figure, and table label as the page prints it', async () => {
          const { markdown } = await extract(fixture);
          for (const label of fixture.labels) expect(markdown).toContain(label);
          // What the stripped labels used to leave behind: empty parentheses, a
          // bare dash between markers, and footnote syntax renumbering them.
          expect(markdown).not.toMatch(/\(\s*[*;,\s–-]*\)/);
          expect(markdown).not.toMatch(/<sup>\s*[–,]*\s*<\/sup>/);
          expect(markdown).not.toContain('[^');
        });

        it('keeps the whole bibliographic text of every reference entry on the page', async () => {
          const { markdown } = await extract(fixture);
          // Read off the page itself, so every entry is checked, authors to pages.
          const entries = [...parseHTML(fixture.html).document.querySelectorAll('div.ref-list li')]
            .map((li) => li.querySelector('.cit-metadata')?.textContent ?? '')
            .map((text) => text.replace(/\s+/g, ' ').trim());
          expect(entries).toHaveLength(fixture.referenceTitles.length);
          const text = markdownAsText(markdown);
          for (const entry of entries) expect(text).toContain(entry);
          expect(markdown).not.toContain('↵');
        });

        it('names each table the page carries without cells, with its absolute popup URL', async () => {
          const result = await extract(fixture);
          if (fixture.tables.length === 0) {
            expect(result).not.toHaveProperty('omittedTables');
          } else {
            expect(result.omittedTables).toEqual(fixture.tables);
          }
          // The callout chrome that stood in for the cells is gone from the text;
          // each table's caption stays where the table sat.
          expect(result.markdown).not.toMatch(/View this table|View popup|View inline|powerpoint/i);
          for (const { label } of fixture.tables) expect(result.markdown).toContain(label);
        });
      },
    );

    // Only these two pages carry `.cit-extra` link-outs to drop.
    it.each([BIORXIV_015347, BIORXIV_596311].map((f) => [f.sourceUrl, f] as const))(
      'drops the broken OpenURL link-outs and keeps each reference DOI as a doi.org link: %s',
      async (_url, fixture) => {
        const { markdown } = await extract(fixture);
        expect(markdown).not.toMatch(/openurl|OpenUrl|PubMed\]|Web of Science/i);
        for (const doi of fixture.referenceDois) {
          expect(markdown).toContain(`[${doi}](https://doi.org/${doi})`);
        }
      },
    );

    it('keeps author-year citation labels, which carry no number to renumber', async () => {
      const fixture = authorYearVariant();
      const { markdown } = await extract(fixture);
      for (const label of fixture.authorYearLabels) expect(markdown).toContain(label);
      expect(markdown).not.toMatch(/\(\s*[*;,\s–-]*\)/);
      expect(markdown).not.toContain('[^');
    });

    it('does not list a table whose cells the page does carry', async () => {
      const withCells = {
        ...BIORXIV_015347,
        html: BIORXIV_015347.html.replace(
          '<div class="table-caption">',
          '<table><tr><th>Animal</th><th>Seroconverted</th></tr><tr><td>Dog</td><td>2/4</td></tr></table><div class="table-caption">',
        ),
      };
      const result = await extract(withCells);
      expect(result).not.toHaveProperty('omittedTables');
      expect(result.markdown).toContain('Seroconverted');
      expect(result.markdown).not.toMatch(/View this table|View popup|View inline|powerpoint/i);
    });

    it.each([
      [
        'its id',
        (html: string) => html.replace('<span class="table-label">Table 1.</span>', ''),
        'T1',
      ],
      [
        'a neutral label when it has no id either',
        (html: string) =>
          html
            .replace('<span class="table-label">Table 1.</span>', '')
            .replace('<div id="T1" class="table pos-float">', '<div class="table pos-float">'),
        'Unlabelled table',
      ],
    ])('lists a cell-less table with no printed label under %s', async (_how, strip, label) => {
      const result = await extract({ ...BIORXIV_015347, html: strip(BIORXIV_015347.html) });
      expect(result.omittedTables).toEqual([{ label, url: BIORXIV_015347.tables[0]?.url }]);
      expect(result.markdown).not.toMatch(/View this table|View popup|View inline|powerpoint/i);
      expect(result.markdown).toContain('Susceptibility of dogs, pigs, chickens, and ducks');
    });

    it('reads a link-out or table popup href that does not parse as a URL as no link', async () => {
      const malformed = BIORXIV_015347.html
        .replace(/href="\/lookup\/external-ref\?access_num=10\.1056[^"]*"/, 'href="http://["')
        .replace(/href="\/highwire\/markup\/1231680\/expansion\?width[^"]*"/, 'href="http://["');
      expect(malformed.match(/href="http:\/\/\["/g)).toHaveLength(2);
      const result = await extract({ ...BIORXIV_015347, html: malformed });
      expect(result.markdown).not.toContain('10.1056/NEJMoa2001017');
      expect(result.markdown).toContain(
        '[10.1038/s41586-020-2012-7](https://doi.org/10.1038/s41586-020-2012-7)',
      );
      expect(result).not.toHaveProperty('omittedTables');
      expect(result.markdown).toContain('Susceptibility of dogs, pigs, chickens, and ducks');
    });

    it('extracts a page with no .fulltext-view container unchanged in kind', async () => {
      const result = await extract({
        ...BIORXIV_596311,
        html: '<!DOCTYPE html><html><head><title>Plain page</title></head><body><article><h1>Plain page</h1><p>Macrophages drive limb regeneration in axolotls, and their depletion blocks blastema formation entirely.</p></article></body></html>',
      });
      expect(result.markdown).toContain('Macrophages drive limb regeneration');
      expect(result).not.toHaveProperty('omittedTables');
    });

    it('serves the omitted tables back from the cache with the article', async () => {
      const ctx = tenantCtx();
      const first = await extract(MEDRXIV_20062463, ctx);
      const second = await extract(MEDRXIV_20062463, ctx);
      expect(second).toEqual(first);
      expect(second.omittedTables).toEqual(MEDRXIV_20062463.tables);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ── Rate limiting (429) ──────────────────────────────────────────────────────

  describe('origin rate limiting', () => {
    it('classifies a 429 as unavailable/rate_limited carrying the parsed Retry-After', async () => {
      mockFetch.mockRejectedValue(httpError(429, '94'));
      const result = await service.fetchFullText(
        'biorxiv',
        DOI,
        '1',
        startCallDeadline(),
        tenantCtx(),
      );
      expect(result.kind).toBe('unavailable');
      if (result.kind === 'unavailable') {
        expect(result.reason).toBe('rate_limited');
        expect(result.retryAfter).toBe(94);
        expect(result.detail).toContain('94');
      }
    });

    it('converts an HTTP-date Retry-After to a wait in seconds', async () => {
      mockFetch.mockRejectedValue(httpError(429, new Date(Date.now() + 120_000).toUTCString()));
      const result = await service.fetchFullText(
        'biorxiv',
        DOI,
        '1',
        startCallDeadline(),
        tenantCtx(),
      );
      expect(result.kind).toBe('unavailable');
      if (result.kind === 'unavailable') {
        expect(result.retryAfter).toBeGreaterThan(110);
        expect(result.retryAfter).toBeLessThanOrEqual(120);
        expect(result.detail).toMatch(/asked for a \d+-second wait/);
      }
    });

    it('drops an unparseable Retry-After rather than echoing it as a second count', async () => {
      mockFetch.mockRejectedValue(httpError(429, 'soon'));
      const result = await service.fetchFullText(
        'biorxiv',
        DOI,
        '1',
        startCallDeadline(),
        tenantCtx(),
      );
      expect(result.kind).toBe('unavailable');
      if (result.kind === 'unavailable') {
        expect(result.reason).toBe('rate_limited');
        expect(result.retryAfter).toBeUndefined();
        expect(result.detail).not.toContain('soon');
      }
    });

    it('treats Retry-After: 0 exactly like a 429 with no header', async () => {
      mockFetch.mockRejectedValue(httpError(429, '0'));
      const zero = await service.fetchFullText(
        'biorxiv',
        DOI,
        '1',
        startCallDeadline(),
        tenantCtx(),
      );
      mockFetch.mockRejectedValue(httpError(429));
      const none = await service.fetchFullText(
        'biorxiv',
        DOI,
        '1',
        startCallDeadline(),
        tenantCtx(),
      );

      expect(zero).toEqual(none);
      expect(zero).not.toHaveProperty('retryAfter');
      expect(JSON.stringify(zero)).not.toContain('0-second');
    });

    it('keeps the origin block-page HTML out of the returned result', async () => {
      mockFetch.mockRejectedValue(httpError(429, '94'));
      const result = await service.fetchFullText(
        'biorxiv',
        DOI,
        '1',
        startCallDeadline(),
        tenantCtx(),
      );
      expect(JSON.stringify(result)).not.toMatch(/Cloudflare|DOCTYPE|cf-error-details/i);
    });

    it('classifies a 429 with no Retry-After header and leaves retryAfter absent', async () => {
      mockFetch.mockRejectedValue(httpError(429));
      const result = await service.fetchFullText(
        'biorxiv',
        DOI,
        '1',
        startCallDeadline(),
        tenantCtx(),
      );
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
      });
    });

    it('serves a repeat lookup for the same server/DOI/version without touching the origin', async () => {
      const ctx = tenantCtx();
      const first = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      const second = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);

      expect(second).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockExtract).toHaveBeenCalledTimes(1);
    });

    it('serves a cached article on a call whose budget is already spent, without a request', async () => {
      const ctx = tenantCtx();
      const first = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      const spent = Date.now() as CallDeadline;
      const second = await service.fetchFullText('biorxiv', DOI, '2', spent, ctx);

      expect(second).toEqual(first);
      expect(second.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('refetches when the version differs — a new revision is a new key', async () => {
      const ctx = tenantCtx();
      await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      await service.fetchFullText('biorxiv', DOI, '3', startCallDeadline(), ctx);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('refetches when the server differs — the key is per-origin', async () => {
      const ctx = tenantCtx();
      await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      await service.fetchFullText('medrxiv', DOI, '2', startCallDeadline(), ctx);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not cache a blocked result — the next call retries the origin', async () => {
      const ctx = tenantCtx();
      mockFetch.mockRejectedValueOnce(httpError(403));
      const blocked = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      expect(blocked.kind).toBe('unavailable');

      const retried = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      expect(retried.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not cache a rate-limited result — the next call retries the origin', async () => {
      const ctx = tenantCtx();
      mockFetch.mockRejectedValueOnce(httpError(429, '94'));
      const limited = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      expect(limited.kind).toBe('unavailable');

      const retried = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      expect(retried.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not cache an empty extraction — the next call retries the origin', async () => {
      const ctx = tenantCtx();
      mockExtract.mockResolvedValueOnce({ content: '  ' });
      const empty = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      expect(empty.kind).toBe('unavailable');

      const retried = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      expect(retried.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('hits the cache through the real StorageService, which validates the key', async () => {
      const ctx = tenantCtx();
      const first = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      const second = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);

      expect(first.kind).toBe('article');
      expect(second).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockExtract).toHaveBeenCalledTimes(1);
    });

    it('refetches once the cached extraction has outlived its TTL', async () => {
      const ctx = tenantCtx();
      vi.useFakeTimers();
      try {
        await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
        vi.advanceTimersByTime(3_601_000);
        await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      } finally {
        vi.useRealTimers();
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('still returns the article when the storage backend refuses the write', async () => {
      const ctx = tenantCtx();
      ctx.state.set = () => Promise.reject(new Error('storage capacity exceeded'));
      const result = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      expect(result.kind).toBe('article');
      if (result.kind === 'article') expect(result.markdown).toBe('Cached article body.');
    });

    it('falls through to the origin when the storage backend refuses the read', async () => {
      const ctx = tenantCtx();
      ctx.state.get = () => Promise.reject(new Error('storage unreachable'));
      const result = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      expect(result.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('still returns full text for a tenant-less caller, uncached', async () => {
      const ctx = tenantlessCtx();
      const first = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      const second = await service.fetchFullText('biorxiv', DOI, '2', startCallDeadline(), ctx);
      expect(first.kind).toBe('article');
      expect(second.kind).toBe('article');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── The call budget ─────────────────────────────────────────────────────────

  describe('call budget', () => {
    const fetchPage = (ctx: Context, deadline = startCallDeadline()) =>
      service.fetchFullText('biorxiv', DOI, '1', deadline, ctx);

    beforeEach(() => {
      mockExtract.mockResolvedValue({ content: 'Body paragraph.' });
    });

    it('bounds an attempt at 30 s while the budget leaves more, on the attempt signal', async () => {
      const attempt = new AbortController();
      retry.impl = (fn) => fn({ signal: attempt.signal, remainingMs: Number.POSITIVE_INFINITY });
      mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
      const ctx = tenantCtx();
      await fetchPage(ctx);
      const [, timeoutMs, , options] = mockFetch.mock.calls[0] as FetchCall;
      expect(timeoutMs).toBe(30_000);
      expect(options.signal).toBe(attempt.signal);
      expect(options.signal).not.toBe(ctx.signal);
    });

    it('bounds an attempt at what the budget has left once that is under 30 s', async () => {
      retry.impl = (fn) => fn({ signal: new AbortController().signal, remainingMs: 7_000 });
      mockFetch.mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
      await fetchPage(tenantCtx());
      expect((mockFetch.mock.calls[0] as FetchCall)[1]).toBe(7_000);
    });

    describe('against an origin that never answers', () => {
      let origin: ReturnType<typeof hungOrigin>;

      beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
        const { withRetry } = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
          '@cyanheads/mcp-ts-core/utils',
        );
        retry.impl = withRetry as RetryFn;
        origin = hungOrigin();
        mockFetch.mockImplementation(origin.fetch);
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('settles inside the 50 s call budget, under a client 60 s request timeout', async () => {
        const deadline = startCallDeadline();
        const ctx = tenantCtx();
        const { err, elapsedMs } = await settle(fetchPage(ctx, deadline));

        expect(err).toBeInstanceOf(McpError);
        expect(err.code).toBe(JsonRpcErrorCode.Timeout);
        expect(err.data?.reason).toBe('retry_deadline_exceeded');
        expect(elapsedMs).toBeLessThanOrEqual(CALL_BUDGET_MS);
        // Four unbounded 30 s attempts plus backoff would run past two minutes.
        expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
        for (const [i, [, timeoutMs, , options]] of (
          mockFetch.mock.calls as FetchCall[]
        ).entries()) {
          expect(timeoutMs).toBeLessThanOrEqual(deadline - (origin.startedAt[i] as number));
          expect(options.signal).not.toBe(ctx.signal);
        }
      });

      it('spends only what version resolution left of the budget', async () => {
        const deadline = (Date.now() + 10_000) as CallDeadline;
        const { err, elapsedMs } = await settle(fetchPage(tenantCtx(), deadline));
        expect(err.data?.reason).toBe('retry_deadline_exceeded');
        expect(elapsedMs).toBeLessThanOrEqual(10_000);
      });

      it('keeps a caller cancellation a cancellation, never relabelled as the deadline', async () => {
        const caller = new AbortController();
        setTimeout(() => caller.abort(), 10_000);
        const ctx = createMockContext({ tenantId: 'test-tenant', signal: caller.signal });
        const { err, elapsedMs } = await settle(fetchPage(ctx, startCallDeadline()));
        expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(err.data?.reason).toBeUndefined();
        expect(elapsedMs).toBe(10_000);
      });

      it('returns rate_limited at once on a Retry-After longer than the budget leaves', async () => {
        mockFetch.mockRejectedValue(httpError(429, '30'));
        const deadline = (Date.now() + 10_000) as CallDeadline;
        const { value, elapsedMs } = await settle(fetchPage(tenantCtx(), deadline));
        expect(value).toMatchObject({
          kind: 'unavailable',
          reason: 'rate_limited',
          retryAfter: 30,
        });
        expect(elapsedMs).toBe(0);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('keeps a 429 the budget ran out after as rate_limited, never an expiry', async () => {
        // Every attempt answers 429 with no Retry-After, 16 s late: the third lands
        // at 49.1–49.9 s, with less left than the 1.5–2.5 s backoff before a fourth.
        mockFetch.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(httpError(429)), 16_000);
            }),
        );
        const { value, elapsedMs } = await settle(fetchPage(tenantCtx()));
        expect(value).toEqual({
          kind: 'unavailable',
          reason: 'rate_limited',
          detail: 'The full-text origin is rate-limiting this host (HTTP 429).',
          sourceUrl: `https://www.biorxiv.org/content/${DOI}v1.full`,
        });
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(elapsedMs).toBeLessThanOrEqual(CALL_BUDGET_MS);
      });

      it.each([
        [
          'no Retry-After',
          undefined,
          {},
          'The full-text origin is rate-limiting this host (HTTP 429).',
        ],
        [
          'a Retry-After',
          '2',
          { retryAfter: 2 },
          'The full-text origin is rate-limiting this host (HTTP 429) and asked for a 2-second wait before the next request.',
        ],
      ])(
        'keeps slow 429s with %s rate_limited when the budget cuts a later attempt short',
        async (_label, retryAfter, wait, detail) => {
          // Every attempt answers 429 13.5 s in, inside the 30 s attempt timeout.
          // The fourth starts 43.1–46.5 s in and is still waiting at 50 s.
          mockFetch.mockImplementation(slowOrigin(13_500, () => httpError(429, retryAfter)).fetch);
          const { value, elapsedMs } = await settle(fetchPage(tenantCtx()));
          expect(value).toEqual({
            kind: 'unavailable',
            reason: 'rate_limited',
            detail,
            ...wait,
            sourceUrl: `https://www.biorxiv.org/content/${DOI}v1.full`,
          });
          expect(mockFetch).toHaveBeenCalledTimes(4);
          expect(elapsedMs).toBe(CALL_BUDGET_MS);
        },
      );

      it('reports a budget already spent as the call running out of time, without a request', async () => {
        const spent = Date.now() as CallDeadline;
        const { err, elapsedMs } = await settle(fetchPage(tenantCtx(), spent));
        expect(err.code).toBe(JsonRpcErrorCode.Timeout);
        expect(err.data?.reason).toBe('retry_deadline_exceeded');
        expect(err.message).toContain("the call's 50 s time budget had run out");
        expect(err.message).not.toMatch(/\b0ms\b/);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(elapsedMs).toBe(0);
      });

      it('makes the same attempts and returns the same article against a healthy origin', async () => {
        mockFetch.mockReset().mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
        const direct = await fetchPage(tenantlessCtx());

        mockFetch
          .mockReset()
          .mockRejectedValueOnce(httpError(503))
          .mockResolvedValue(makeHtmlResponse(ARTICLE_HTML));
        const { value, elapsedMs } = await settle(fetchPage(tenantlessCtx()));
        expect(value).toEqual(direct);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        // One 503, one 500 ms backoff (±25 % jitter), the full 30 s timeout each time.
        expect(elapsedMs).toBeLessThanOrEqual(625);
        for (const [, timeoutMs] of mockFetch.mock.calls as FetchCall[]) {
          expect(timeoutMs).toBe(30_000);
        }
      });
    });
  });
});
