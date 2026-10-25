/**
 * @fileoverview Tests for BiorxivFullTextService — full-text HTML fetch, Markdown
 * extraction, challenge/block detection, 429 rate-limit classification,
 * unavailable-vs-transient classification, and the per-version ctx.state cache.
 * Extraction on trimmed Highwire article pages runs the real htmlExtractor, so
 * citation labels, reference text, figures, display formulas, and omitted
 * tables are asserted on what defuddle actually returns.
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
  BIORXIV_336701,
  BIORXIV_596311,
  BIORXIV_627082,
  BIORXIV_736286,
  BIORXIV_736350,
  EDITOR_LIST,
  HIGHWIRE_FIXTURES,
  type HighwireFixture,
  MEDRXIV_20062463,
  MEDRXIV_26361261,
  MEDRXIV_26361515,
  MEDRXIV_26365491,
  withEditorList,
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

  it('caches under the v5 key generation, never reading a v1, v2, v3, or v4 entry back', async () => {
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
    // v3 and v4 entries have the current shape but Markdown rendered before
    // figures and reference numbers were reshaped (v3), or before short sections
    // headed with a navigation word and nested reference lists were kept (v4).
    for (const generation of ['v3', 'v4']) {
      await ctx.state.set(`fulltext/${generation}/biorxiv/${DOI}/1`, {
        markdown: 'Stale body from an older build.',
        sourceUrl: `https://www.biorxiv.org/content/${DOI}v1.full`,
      });
    }

    const result = await service.fetchFullText('biorxiv', DOI, '1', startCallDeadline(), ctx);
    expect(result.kind === 'article' && result.markdown).toBe('Fresh extraction.');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await ctx.state.get(`fulltext/v5/biorxiv/${DOI}/1`)).toMatchObject({
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

    /** The real extractor, for a test that extracts a page the service did not hand it. */
    let realExtractor: typeof import('@cyanheads/mcp-ts-core/utils')['htmlExtractor'];

    beforeEach(async () => {
      ({ htmlExtractor: realExtractor } = await vi.importActual<
        typeof import('@cyanheads/mcp-ts-core/utils')
      >('@cyanheads/mcp-ts-core/utils'));
      mockExtract.mockImplementation((html: string, options: object) =>
        realExtractor.extract(html, options),
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

        it('renders each figure image once, in its own block under its printed label, and its caption once', async () => {
          const { markdown } = await extract(fixture);
          const blocks = markdown.split('\n\n');
          for (const { alt, src, caption } of fixture.figures) {
            expect(blocks).toContain(`![${alt}](${src})`);
            if (caption) expect(markdown.split(caption)).toHaveLength(2);
          }
          expect(markdown.match(/!\[/g) ?? []).toHaveLength(
            fixture.figures.length + fixture.formulas.length,
          );
          // What the image link's caption-bearing title left behind, and its chrome.
          expect(markdown).not.toMatch(/"\)$/m);
          expect(markdown).not.toMatch(/Download figure|Open in new tab/);
          expect(markdown).not.toMatch(/&(?:gt|lt|amp);/);
        });

        it('renders each display formula as an image block of its own, with no caption text', async () => {
          const { markdown } = await extract(fixture);
          const blocks = markdown.split('\n\n');
          for (const src of fixture.formulas) expect(blocks).toContain(`![](${src})`);
          // The formula image's alt, which the extractor read as a figure caption.
          expect(markdown).not.toContain('Embedded Image');
        });

        it('numbers each reference entry once, with the number the page prints', async () => {
          const { markdown } = await extract(fixture);
          const references = markdown.slice(Math.max(0, markdown.search(/^## .*Reference/m)));
          expect(references.match(/^(?:\d+\.|- \S+)/gm) ?? []).toEqual(fixture.referenceMarkers);
          // A list number followed by the printed label: `1. 1.`, `1. (1).`, `1. \[1\].`, `1. 53.`
          expect(markdown).not.toMatch(/^\d+\. +\\?[([]?\d+\\?[)\]]?\.(?:\s|$)/m);
        });
      },
    );

    it('splits nothing onto a paragraph or heading: the body text before a figure ends its block', async () => {
      const repro2 = (await extract(BIORXIV_627082)).markdown;
      expect(repro2).toContain(
        'wildfire perimeters constitute less area than that which occurred with prescribed burning.\n\n',
      );
      expect(repro2).toContain('\n\n## Supplementary figures\n\n');
      const repro1 = (await extract(BIORXIV_736350)).markdown;
      expect(repro1).toContain('in living cells (Figure 2A).\n\n');
      const gluedOnto015347 = (await extract(BIORXIV_015347)).markdown;
      expect(gluedOnto015347).toContain(
        'but its replication in other organs is undetectable.\n\n![Figure S2]',
      );
    });

    it('sets each display formula between the intact text around it, in page order', async () => {
      const { markdown } = await extract(MEDRXIV_26361515);
      const blocks = markdown.split('\n\n');
      const [adq, estimate, effect] = MEDRXIV_26361515.formulas;
      const adqAt = blocks.indexOf('From this, ADQ usage is calculated as:');
      expect(adqAt).toBeGreaterThan(-1);
      expect(blocks.slice(adqAt + 1, adqAt + 3)).toEqual([
        `![](${adq})`,
        'By estimating ADQ usage, we account for changes in the strength of prescribed drugs, not just their volume, providing a more comprehensive view of prescribing trends.',
      ]);
      // Two formulas in one paragraph: the second used to be glued onto the text before it.
      const givenAt = blocks.findIndex((block) =>
        block.endsWith('for treated units post-treatment are given by:'),
      );
      expect(blocks[givenAt]).toMatch(/^Since \*λ<sub>i<\/sub>\* and \*f<sub>t<\/sub>\*/);
      expect(blocks.slice(givenAt + 1, givenAt + 5)).toEqual([
        `![](${estimate})`,
        'The treatment effect is then computed as:',
        `![](${effect})`,
        '## References',
      ]);
    });

    it('keeps formulas that follow one another with nothing between, each as its own image', async () => {
      const [adq = ''] = MEDRXIV_26361515.formulas;
      const span =
        /<span class="disp-formula" id="disp-formula-1">[\s\S]*?<\/noscript><\/span>\s*<\/span>/.exec(
          MEDRXIV_26361515.html,
        )?.[0] ?? '';
      expect(span).toContain('graphic-3.gif');
      const formula = (n: number) => span.replaceAll('graphic-3.gif', `graphic-${n}.gif`);
      // Consecutive equations, each in a paragraph holding nothing else.
      const html = MEDRXIV_26361515.html.replace(
        'prescribing trends.</p>',
        `prescribing trends.</p><p id="p-29">\n${formula(4)}\n</p><p id="p-30">\n${formula(5)}\n</p>`,
      );
      const { markdown } = await extract({ ...MEDRXIV_26361515, html });
      const blocks = markdown.split('\n\n');
      const at = blocks.indexOf(`![](${adq})`);
      expect(at).toBeGreaterThan(-1);
      expect(blocks.slice(at + 2, at + 5)).toEqual([
        `![](${adq.replace('graphic-3', 'graphic-4')})`,
        `![](${adq.replace('graphic-3', 'graphic-5')})`,
        '## 3 Results',
      ]);
    });

    it('leaves a display formula whose only source is a placeholder in its paragraph', async () => {
      const span =
        /<span class="disp-formula" id="disp-formula-1">[\s\S]*?<\/noscript><\/span>\s*<\/span>/.exec(
          MEDRXIV_26361515.html,
        )?.[0] ?? '';
      const placeholderOnly = span
        .replace(/ data-src="[^"]*"/, '')
        .replace(/<noscript>[\s\S]*?<\/noscript>/, '');
      expect(placeholderOnly).toContain('src="data:image/gif');
      expect(placeholderOnly).not.toContain('graphic-3.gif');
      const html = MEDRXIV_26361515.html.replace(span, placeholderOnly);
      expect(html).not.toBe(MEDRXIV_26361515.html);
      const { markdown } = await extract({ ...MEDRXIV_26361515, html });
      expect(markdown).not.toContain('data:image');
      expect(markdown.split('\n\n')).toContainEqual(
        expect.stringMatching(
          /^From this, ADQ usage is calculated as:\s+By estimating ADQ usage, /,
        ),
      );
    });

    describe('inline formulas', () => {
      const src = (n: number) =>
        `https://www.medrxiv.org/sites/default/files/highwire/medrxiv/early/2026/09/01/2026.08.27.26361515/embed/inline-graphic-${n}.gif`;
      /** The page's lazy-loaded inline formula: a `data:` placeholder, `data-src`, and a `<noscript>` copy. */
      const lazy = (n: number) =>
        `<span class="inline-formula" id="inline-formula-${n}"><span class="highwire-responsive-lazyload"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" class="highwire-embed lazyload" alt="Embedded Image" data-src="${src(n)}"/><noscript><img class="highwire-embed" alt="Embedded Image" src="${src(n)}"/></noscript></span></span>`;
      const plain = (n: number) =>
        `<span class="inline-formula" id="inline-formula-${n}"><img src="${src(n)}" class="highwire-embed" alt="Embedded Image"/></span>`;
      const withSentence = (sentence: string) => {
        const html = MEDRXIV_26361515.html.replace('compiled using ArcGIS.', sentence);
        expect(html).not.toBe(MEDRXIV_26361515.html);
        return { ...MEDRXIV_26361515, html };
      };

      it.each([
        ['lazy-loaded', lazy],
        ['with a plain src', plain],
      ])(
        'sets a %s inline formula inside its sentence, with no caption text',
        async (_shape, formula) => {
          const { markdown } = await extract(
            withSentence(`compiled using ArcGIS with probability ${formula(1)} if we assume it.`),
          );
          expect(markdown).toContain(
            `compiled using ArcGIS with probability ![](${src(1)}) if we assume it.`,
          );
          expect(markdown).not.toContain('Embedded Image');
        },
      );

      it('keeps several inline formulas in one sentence in page order', async () => {
        const { markdown } = await extract(
          withSentence(
            `compiled using ArcGIS ${lazy(1)} and ${lazy(2)}, then ${lazy(3)} at scale.`,
          ),
        );
        expect(markdown).toContain(
          `compiled using ArcGIS ![](${src(1)}) and ![](${src(2)}), then ![](${src(3)}) at scale.`,
        );
        expect(markdown).not.toContain('Embedded Image');
      });

      it('handles an inline formula nested in another as part of the outer one', async () => {
        const nested = `<span class="inline-formula" id="inline-formula-1"><img data-src="${src(1)}" alt="Embedded Image"/>${plain(2)}</span>`;
        const { markdown } = await extract(
          withSentence(`compiled using ArcGIS ${nested} at scale.`),
        );
        expect(markdown).toContain(`compiled using ArcGIS ![](${src(1)}) at scale.`);
        expect(markdown).not.toContain('Embedded Image');
      });

      it('leaves an inline formula with no image source as the page has it', async () => {
        const { markdown } = await extract(
          withSentence(
            'compiled using ArcGIS <span class="inline-formula" id="inline-formula-1"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="x"/></span> at scale.',
          ),
        );
        // The placeholder renders as nothing: the sentence closes up around it.
        expect(markdown).toContain('compiled using ArcGIS at scale.\n\n');
        expect(markdown).not.toContain('data:image');
      });
    });

    it('numbers a reference list from its first printed label, whatever form the label takes', async () => {
      const methods = (await extract(BIORXIV_627082)).markdown;
      expect(methods).toContain(
        '53. Eidenshink, J. et al. A Project for Monitoring Trends in Burn Severity. Fire Ecol. 3, 3–21 (2007).',
      );
      expect(methods).toContain('1. K. T. Davis, et al., Reduced fire severity');
      expect((await extract(BIORXIV_736350)).markdown).toContain(
        '1. Porto, E. M. Komor, A. C. In the Business of Base Editors',
      );
      expect((await extract(MEDRXIV_26361515)).markdown).toContain(
        '1. Yanhui Jia et al. ‘Effect of Air Pollution on Heart Failure',
      );
    });

    it.each([
      [
        'a label that is not one integer',
        (html: string) => html.replace('>2.</span>', '>2a.</span>'),
        ['- 1.', '- 2a.', '- 3.', '- 4.'],
      ],
      [
        'an entry with no label',
        (html: string) => html.replace('<span class="ref-label">2.</span>', ''),
        ['- 1.', '- Knutsen,', '- 3.', '- 4.'],
      ],
    ])('keeps the printed labels of a list with %s, unordered', async (_how, edit, markers) => {
      const html = edit(BIORXIV_596311.html);
      expect(html).not.toBe(BIORXIV_596311.html);
      const { markdown } = await extract({ ...BIORXIV_596311, html });
      const references = markdown.slice(markdown.search(/^## .*Reference/m));
      expect(references.match(/^(?:\d+\.|- \S+)/gm)).toEqual(markers);
      const text = markdownAsText(markdown);
      for (const title of BIORXIV_596311.referenceTitles) expect(text).toContain(title);
    });

    it('keeps every image of a figure that prints no label, each under its own position', async () => {
      const html = MEDRXIV_26361261.html.replace('<span class="fig-label">Fig. S16.</span>', '');
      expect(html).not.toBe(MEDRXIV_26361261.html);
      const { markdown } = await extract({ ...MEDRXIV_26361261, html });
      const blocks = markdown.split('\n\n');
      for (const [i, { src }] of MEDRXIV_26361261.figures.entries()) {
        expect(blocks).toContain(`![(${i + 1} of 2)](${src})`);
      }
    });

    it('takes a figure image the page serves without lazy loading from its src', async () => {
      const [figure] = BIORXIV_736350.figures;
      const html = BIORXIV_736350.html.replace(
        /src="data:image\/gif;base64,[^"]*" data-src="([^"]*)"/,
        'src="$1"',
      );
      expect(html).not.toBe(BIORXIV_736350.html);
      const { markdown } = await extract({ ...BIORXIV_736350, html });
      expect(markdown.split('\n\n')).toContain(`![Figure 2](${figure?.src})`);
      expect(markdown.split(figure?.caption ?? '')).toHaveLength(2);
    });

    it('leaves a figure image whose only source is a placeholder to the extractor', async () => {
      const html = BIORXIV_736350.html
        .replace(/ data-src="[^"]*"/, '')
        .replace(/<noscript>.*?<\/noscript>/, '');
      expect(html).not.toBe(BIORXIV_736350.html);
      const { markdown } = await extract({ ...BIORXIV_736350, html });
      // No image block: the paragraph before the figure runs straight into its caption.
      expect(markdown).not.toContain('![Figure 2]');
      expect(markdown).not.toContain('data:image');
      expect(markdown).toContain(
        'in living cells (Figure 2A).\n\nFigure 2. TadA8e-L68-sfGFP is a fluorescent base editor',
      );
      // The figure's links still go.
      expect(markdown).not.toMatch(/Download figure|Open in new tab/);
    });

    // The extractor re-serializes kept HTML, writing the page's `&lt;` as `&#60;`.
    it('keeps an escaped `<` in inline HTML escaped', async () => {
      const { markdown } = await extract(BIORXIV_336701);
      expect(markdown).toContain('(n = 6<sub>&#60;50x</sub>, n = 1<sub>relative</sub>');
      expect(markdown).toContain('(n = 16<sub>&#60;50x</sub>, n = 4<sub>relatives</sub>');
      expect(markdown).not.toContain('<sub><50x');
    });

    // The pages whose `.cit-extra` blocks hold link-outs to drop. medRxiv 26361515
    // also has them, but one of its references cites an `/openurl/` URL in its text.
    it.each(
      [BIORXIV_015347, BIORXIV_596311, BIORXIV_627082, BIORXIV_736350].map(
        (f) => [f.sourceUrl, f] as const,
      ),
    )(
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

    it('hands a page with no .fulltext-view container to the extractor byte for byte', async () => {
      const html =
        '<!DOCTYPE html><html><head><title>Plain page</title></head><body><article><div class="section"><h2>Related work</h2><p>Macrophages drive limb regeneration in axolotls, and their depletion blocks blastema formation entirely.</p></div><div class="ref-list"><ol class="cit-list"><li><span class="ref-label">1.</span><div class="cit-metadata"><ol><li>A. Rich, and</li><li>N. Davidson</li></ol>Adam, G. Reduction of dimensionality.</div></li></ol></div></article></body></html>';
      await extract({ ...BIORXIV_596311, html });
      expect(mockExtract.mock.calls[0]?.[0]).toBe(html);
    });

    // ── Blocks Defuddle's low-score removal reads as navigation ──

    /** A page whose article container holds `body`. */
    const articlePage = (body: string) =>
      `<!DOCTYPE html><html><head><title>Synthetic | bioRxiv</title></head><body><div class="article fulltext-view">${body}</div></body></html>`;
    const PROSE =
      'Body text long enough to read as an article paragraph, citing earlier work and adding more words so the page clears every length threshold the extractor applies.';

    /**
     * Section 3.2 of {@link MEDRXIV_26365491} as Markdown blocks under `heading`,
     * through the heading after it, with each paragraph read off the page.
     */
    function section32Blocks(heading: string): string[] {
      const { document } = parseHTML(MEDRXIV_26365491.html);
      const text = (id: string) =>
        document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const [figure] = MEDRXIV_26365491.figures;
      return [
        `### ${heading}`,
        text('p-33'),
        `![${figure?.alt}](${figure?.src})`,
        'Figure 3:',
        text('p-34'),
        text('p-35'),
        '### 3.3 Fitting to synthetic target trajectories',
      ];
    }

    it('keeps a short section whose heading holds a navigation word, with its figure and caption', async () => {
      const heading = '3.2 Effect of suppressing the vaccination-related input';
      // What the low-score removal tests: a block under 200 words under a heading
      // holding one of its navigation words (`related`).
      const section = parseHTML(MEDRXIV_26365491.html).document.getElementById('sec-7');
      expect(section?.textContent?.trim().split(/\s+/).length).toBeLessThan(200);
      const { markdown } = await extract(MEDRXIV_26365491);
      const blocks = markdown.split('\n\n');
      const at = blocks.indexOf(`### ${heading}`);
      expect(blocks.slice(at, at + 7)).toEqual(section32Blocks(heading));
      expect(blocks[at - 2]).toBe('### 3.1 Reproduction of the reference epidemic trajectory');
      expect(markdown).not.toContain('role=');
    });

    it.each(['Related work', 'Sex-related differences', 'Immune responses to vaccination'])(
      'keeps a subsection under 200 words whole under the heading %s',
      async (heading) => {
        const html = MEDRXIV_26365491.html.replace(
          '<h3>3.2 Effect of suppressing the vaccination-related input</h3>',
          `<h3>${heading}</h3>`,
        );
        expect(html).not.toBe(MEDRXIV_26365491.html);
        const blocks = (await extract({ ...MEDRXIV_26365491, html })).markdown.split('\n\n');
        const at = blocks.indexOf(`### ${heading}`);
        expect(blocks.slice(at, at + 7)).toEqual(section32Blocks(heading));
      },
    );

    it('keeps a short section whole when only a subsection heading holds the navigation word', async () => {
      const html = articlePage(
        `<div class="section" id="sec-1"><h2>Introduction</h2><p>${PROSE}</p><p>${PROSE}</p></div><div class="section" id="sec-2"><h2>Background</h2><div class="subsection" id="sec-3"><h3>Related work</h3><p>Earlier studies measured regeneration in two species and found the same timing in both.</p></div><div class="subsection" id="sec-4"><h3>Aims</h3><p>We test whether macrophage depletion delays blastema formation in axolotls.</p></div></div>`,
      );
      const blocks = (await extract({ ...BIORXIV_596311, html })).markdown.split('\n\n');
      expect(blocks.slice(blocks.indexOf('## Background'))).toEqual([
        '## Background',
        '### Related work',
        'Earlier studies measured regeneration in two species and found the same timing in both.',
        '### Aims',
        'We test whether macrophage depletion delays blastema formation in axolotls.',
      ]);
    });

    it('keeps a short figure caption that holds a navigation word', async () => {
      const html = articlePage(
        `<div class="section" id="sec-1"><h2>Results</h2><p>${PROSE}</p><div id="F1" class="fig pos-float type-figure odd"><div class="highwire-figure"><div class="fig-inline-img-wrapper"><div class="fig-inline-img"><img data-src="https://www.biorxiv.org/F1.medium.gif" alt="Share of cases by region"></div></div></div><div class="fig-caption"><span class="fig-label">Figure 1.</span> <p id="p-4" class="first-child">Share of cases by region</p></div></div><p>${PROSE}</p></div>`,
      );
      const blocks = (await extract({ ...BIORXIV_596311, html })).markdown.split('\n\n');
      const at = blocks.indexOf('![Figure 1](https://www.biorxiv.org/F1.medium.gif)');
      expect(blocks.slice(at, at + 4)).toEqual([
        '![Figure 1](https://www.biorxiv.org/F1.medium.gif)',
        'Figure 1.',
        'Share of cases by region',
        PROSE,
      ]);
    });

    // The scorer skips table cells, and a marked block there would stay a
    // `<div>` in a table the extractor writes as HTML.
    it('leaves the blocks in a table cell unmarked, so a table written as HTML keeps its paragraphs', async () => {
      const html = articlePage(
        `<div class="section" id="sec-1"><h2>Results</h2><p>${PROSE}</p><div class="table"><table><tr><th rowspan="2">Group</th><th>A</th></tr><tr><td><div class="cell-note">Value one, noted.</div></td></tr><tr><td colspan="2"><div>Spanning cell text.</div></td></tr></table></div></div>`,
      );
      const { markdown } = await extract({ ...BIORXIV_596311, html });
      expect(markdown.split('\n\n')).toContain(
        '<table><tbody><tr><th rowspan="2">Group</th><th>A</th></tr><tr><td><p>Value one, noted.</p></td></tr><tr><td colspan="2"><p>Spanning cell text.</p></td></tr></tbody></table>',
      );
      expect(markdown).not.toContain('role=');
    });

    // The scorer does reach a block in a table caption, but a marked block there
    // would stay a `<div>` in a table the extractor writes as HTML.
    it('leaves the blocks in a table caption unmarked, so a table written as HTML keeps its paragraphs', async () => {
      const html = articlePage(
        `<div class="section" id="sec-1"><h2>Results</h2><p>${PROSE}</p><div class="table"><table><caption><div class="caption-note">Counts by group, noted.</div></caption><tr><th rowspan="2">Group</th><th>A</th></tr><tr><td>Value one</td></tr></table></div></div>`,
      );
      const { markdown } = await extract({ ...BIORXIV_596311, html });
      expect(markdown).toContain('<table><caption><p>Counts by group, noted.</p></caption>');
      expect(markdown).not.toContain('role=');
    });

    // On these pages the low-score removal takes nothing from the container, so
    // the content marker must change no byte of the Markdown.
    it.each(
      [...HIGHWIRE_FIXTURES.filter((f) => f !== MEDRXIV_26365491), BIORXIV_336701].map(
        (f) => [f.sourceUrl, f] as const,
      ),
    )('renders %s exactly as it does without the content marker', async (_url, fixture) => {
      const { markdown } = await extract(fixture);
      const [reshaped, options] = mockExtract.mock.calls[0] as [string, object];
      expect(reshaped).toContain(' role="article"');
      const unmarked = await realExtractor.extract(
        reshaped.replaceAll(' role="article"', ''),
        options,
      );
      expect(markdown).toBe(unmarked.content.trim());
      expect(markdown).not.toContain('role=');
    });

    describe('a list nested in a reference entry', () => {
      const ENTRY_2 =
        'G. G. Ice, D. G. Neary, P. W. Adams, Effects of Wildfire on Soils and Watershed Processes. J. For. 102, 16–20 (2004).';
      const ENTRY_55 =
        'Brown, J. F. et al. Lessons learned implementing an operational continuous United States national land change monitoring capability: The Land Change Monitoring, Assessment, and Projection (LCMAP) approach. Remote Sens. Environ. 238, 111356 (2020).';

      /** The Markdown lines of `fixture` that differ from those of {@link BIORXIV_627082}, which has as many. */
      async function changedLines(fixture: HighwireFixture): Promise<string[]> {
        const base = (await extract(BIORXIV_627082)).markdown.split('\n');
        const lines = (await extract(fixture)).markdown.split('\n');
        expect(lines).toHaveLength(base.length);
        return lines.filter((line, i) => line !== base[i]);
      }

      it.each([
        ['mid-list', '2.', `2. A. Rich, and N. Davidson ${ENTRY_2}`],
        [
          'in the last entry, within 500 characters of the end of the article text',
          '55.',
          `55. A. Rich, and N. Davidson ${ENTRY_55}`,
        ],
      ])('sets the editors inline in page order, %s', async (_where, label, line) => {
        expect(await changedLines(withEditorList(BIORXIV_627082, label))).toEqual([line]);
      });

      it('sets a list inside the citation text where it stands', async () => {
        const html = BIORXIV_627082.html.replace(
          'Effects of Wildfire on Soils and Watershed Processes</span>.',
          `Effects of Wildfire on Soils and Watershed Processes</span>. In:${EDITOR_LIST}(eds.)`,
        );
        expect(html).not.toBe(BIORXIV_627082.html);
        expect(await changedLines({ ...BIORXIV_627082, html })).toEqual([
          '2. G. G. Ice, D. G. Neary, P. W. Adams, Effects of Wildfire on Soils and Watershed Processes. In: A. Rich, and N. Davidson (eds.) J. For. 102, 16–20 (2004).',
        ]);
      });

      it('sets a list nested a level deeper inline, every item in page order', async () => {
        const nested =
          '<ul><li>A. Rich,<ol><li>N. Davidson, and</li><li>B. Pullman</li></ol></li><li><em>C. Ford</em></li></ul>';
        expect(await changedLines(withEditorList(BIORXIV_627082, '2.', nested))).toEqual([
          `2. A. Rich, N. Davidson, and B. Pullman *C. Ford* ${ENTRY_2}`,
        ]);
      });

      // Highwire repeats an edited volume's editors in an `ol.duplicate` ahead of
      // the citation that already names them.
      describe('marked duplicate', () => {
        const REF_7_CITATION =
          'Adam, G., and M. Delbrück, 1968. Reduction of dimensionality in biological diffusion processes. In A. Rich, and N. Davidson, editors, Structural Chemistry and Molecular Biology, W. H. Freeman, San Francisco, 198–215.';
        const DUPLICATE_LIST = EDITOR_LIST.replace('cit-ed-list', 'duplicate');
        /** The editors' list items as the real page prints them. */
        const RICH_ITEM =
          '<li><span class="cit-ed"> <span class="cit-name-given-names">A.</span> <span class="cit-name-surname">Rich</span></span>, and </li>';
        const DAVIDSON_ITEM =
          '<li><span class="cit-ed"> <span class="cit-name-given-names">N.</span> <span class="cit-name-surname">Davidson</span></span></li>';

        /** The Markdown line of reference 7 on {@link BIORXIV_736286} with `html`, and the line after it. */
        async function ref7(html = BIORXIV_736286.html): Promise<string[]> {
          const lines = (await extract({ ...BIORXIV_736286, html })).markdown.split('\n');
          const at = lines.findIndex((line) => line.startsWith('7. '));
          return lines.slice(at, at + 2);
        }

        /** {@link BIORXIV_736286} with `from` replaced once by `to`. */
        function edited(from: string, to: string): string {
          expect(BIORXIV_736286.html.split(from)).toHaveLength(2);
          return BIORXIV_736286.html.replace(from, to);
        }

        it('drops the editors of reference 7 on the real page, which its citation names, leaving one line that opens with the authors', async () => {
          const { markdown } = await extract(BIORXIV_736286);
          const [line, next] = await ref7();
          expect(line).toBe(`7. ${REF_7_CITATION}`);
          expect(next).toMatch(/^8\. Heller, K\. J\., and V\. Braun, 1979\. /);
          expect(markdown.split('A. Rich')).toHaveLength(2);
          expect(markdown.split('N. Davidson')).toHaveLength(2);
        });

        it('drops it when the citation separates the names differently from the list items', async () => {
          const html = edited(
            '<span class="cit-name-surname">Rich</span></span>, and <span class="cit-ed">',
            '<span class="cit-name-surname">Rich</span></span> &amp; <span class="cit-ed">',
          );
          expect((await ref7(html))[0]).toBe(
            `7. ${REF_7_CITATION.replace('A. Rich, and N.', 'A. Rich & N.')}`,
          );
        });

        it.each([
          [
            'one of its names is absent from the rest of the entry',
            DAVIDSON_ITEM,
            DAVIDSON_ITEM.replace('Davidson', 'Davis'),
            `7. A. Rich, and N. Davis ${REF_7_CITATION}`,
          ],
          [
            'the rest of the entry gives its names in another order',
            `${RICH_ITEM}${DAVIDSON_ITEM}`,
            `${DAVIDSON_ITEM}${RICH_ITEM}`,
            `7. N. Davidson A. Rich, and ${REF_7_CITATION}`,
          ],
          [
            'a name is only the start of a longer one in the rest of the entry',
            DAVIDSON_ITEM,
            DAVIDSON_ITEM.replace('Davidson', 'David'),
            `7. A. Rich, and N. David ${REF_7_CITATION}`,
          ],
          [
            'it holds an element other than a list item',
            DAVIDSON_ITEM,
            `${DAVIDSON_ITEM}<span class="cit-ed">X. Extra</span>`,
            `7. A. Rich, and N. Davidson X. Extra ${REF_7_CITATION}`,
          ],
          [
            'it holds text outside its list items',
            '<ol class="duplicate">',
            '<ol class="duplicate">Eds. Q. Quill: ',
            `7. Eds. Q. Quill: A. Rich, and N. Davidson ${REF_7_CITATION}`,
          ],
        ])('sets it inline, losing no text, when %s', async (_case, from, to, line) => {
          expect((await ref7(edited(from, to)))[0]).toBe(line);
        });

        it('sets it inline when only another list nested in the entry names the same people', async () => {
          const twice = withEditorList(BIORXIV_627082, '2.', DUPLICATE_LIST + DUPLICATE_LIST);
          expect(await changedLines(twice)).toEqual([
            `2. A. Rich, and N. Davidson A. Rich, and N. Davidson ${ENTRY_2}`,
          ]);
        });
      });
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

  // ── Page reshaping cost ──────────────────────────────────────────────────────

  /**
   * The page passes read printed labels and walk the page's markup, and each
   * scales linearly with input size: label and paragraph text as one long line
   * ending in a break and as breaks throughout, a numeric label that never
   * closes, a paragraph of many formulas, and every element a pass queries the
   * subtree of — citation anchors, inline and display formulas, figures and their image holders,
   * reference lists and their link-out blocks, tables, lists in reference
   * entries, and the block elements and table cells the content marker walks —
   * nested in one another; and the item names of a duplicate list searched for
   * in its entry, past fragments of longer names.
   * Thread CPU time, never wall clock; the extractor is stubbed so only the page
   * pass is measured.
   */
  describe('page reshaping cost', { timeout: 60_000 }, () => {
    const page = (body: string) =>
      `<html><body><div class="article fulltext-view">${body}</div></body></html>`;
    const refList = (items: string) =>
      `<div class="ref-list"><ol class="cit-list">${items}</ol></div>`;
    const figure = (label: string) =>
      `<div class="fig"><div class="fig-inline-img"><img data-src="https://example.org/F1.gif"></div><div class="fig-caption"><span class="fig-label">${label}</span></div></div>`;
    const formula =
      '<span class="disp-formula"><img data-src="https://example.org/graphic-1.gif"></span>';
    const table = (label: string) =>
      `<div class="table"><div class="table-caption"><span class="table-label">${label}</span></div><ul class="table-callout-links"><li><a class="table-expand-popup" href="/T1.expansion.html">View popup</a></li></ul></div>`;

    /** Builds a page of roughly `size` characters from one repeating shape. */
    const SHAPES: [string, (size: number) => string][] = [
      [
        'a reference label on one long line ending in a break',
        (n) => refList(`<li><span class="ref-label">${'§1 x'.repeat(n / 4)}\ny</span>Entry.</li>`),
      ],
      [
        'a reference label of breaks throughout',
        (n) => refList(`<li><span class="ref-label">${'  \r\n'.repeat(n / 4)}</span>Entry.</li>`),
      ],
      [
        'a bracketed reference number that never closes',
        (n) => refList(`<li><span class="ref-label">[${'1'.repeat(n)}x</span>Entry.</li>`),
      ],
      [
        'a figure label on one long line ending in a break',
        (n) => figure(`${'§1 x'.repeat(n / 4)}\ny`),
      ],
      ['a figure label of breaks throughout', (n) => figure('  \r\n'.repeat(n / 4))],
      [
        'figures nested in figures',
        (n) => '<div class="fig"><span class="fig-label">Fig. 1.</span>'.repeat(n / 54),
      ],
      [
        'image holders nested in one figure',
        (n) =>
          `<div class="fig">${'<div class="fig-inline-img"><img data-src="a.gif">'.repeat(n / 50)}</div>`,
      ],
      [
        'reference lists nested in reference entries',
        (n) =>
          '<div class="ref-list"><ol class="cit-list"><li><span class="ref-label">1.</span>'.repeat(
            n / 80,
          ),
      ],
      [
        'display formulas nested in display formulas',
        (n) => `${'<span class="disp-formula">'.repeat(n / 28)}<img data-src="a.gif">`,
      ],
      [
        'inline formulas nested in inline formulas',
        (n) => `${'<span class="inline-formula">'.repeat(n / 30)}<img data-src="a.gif">`,
      ],
      [
        'inline formulas throughout one paragraph',
        (n) =>
          `<p>${'Text <span class="inline-formula"><img data-src="a.gif"></span> '.repeat(n / 66)}</p>`,
      ],
      [
        'display formulas throughout one paragraph',
        (n) => `<p>${`Text. ${formula}`.repeat(n / 90)}</p>`,
      ],
      [
        'unclosed paragraphs, each holding a display formula',
        (n) => `<p>Text. ${formula}`.repeat(n / 93),
      ],
      [
        'a display formula after one long line ending in a break',
        (n) => `<p>${'§1 x'.repeat(n / 4)}\ny${formula}</p>`,
      ],
      [
        'a display formula before breaks throughout',
        (n) => `<p>${formula}${'  \r\n'.repeat(n / 4)}</p>`,
      ],
      [
        'citation anchors nested in citation anchors',
        (n) => '<a class="xref-bibr" href="#ref-1">1'.repeat(n / 34),
      ],
      [
        'image holders with no image nested in one figure',
        (n) => `<div class="fig">${'<div class="fig-inline-img">'.repeat(n / 28)}</div>`,
      ],
      [
        'reference link-out blocks nested in one another',
        (n) => `<div class="ref-list">${'<div class="cit-extra">'.repeat(n / 23)}</div>`,
      ],
      [
        'tables nested in tables',
        (n) =>
          '<div class="table"><a class="table-expand-popup" href="/T1.expansion.html">View popup</a><span class="table-label">Table 1.</span>'.repeat(
            n / 117,
          ),
      ],
      [
        'a table label on one long line ending in a break',
        (n) => table(`${'§1 x'.repeat(n / 4)}\ny`),
      ],
      ['a table label of breaks throughout', (n) => table('  \r\n'.repeat(n / 4))],
      [
        'many consecutive reference entries',
        (n) =>
          refList(
            Array.from(
              { length: n / 40 },
              (_, i) => `<li><span class="ref-label">${i + 1}.</span>Entry.</li>`,
            ).join(''),
          ),
      ],
      [
        'many items of one list in a reference entry',
        (n) =>
          refList(
            `<li><span class="ref-label">1.</span><ol>${'<li>A. Editor, and</li>'.repeat(n / 22)}</ol>Entry.</li>`,
          ),
      ],
      [
        'a duplicate list item and its entry on one long line ending in a break',
        (n) =>
          refList(
            `<li><span class="ref-label">1.</span><ol class="duplicate"><li>${'§1 x'.repeat(n / 8)}\ny</li></ol>${'§1 x'.repeat(n / 8)}\nz</li>`,
          ),
      ],
      [
        'a duplicate list item and its entry of breaks throughout',
        (n) =>
          refList(
            `<li><span class="ref-label">1.</span><ol class="duplicate"><li>${'  \r\n'.repeat(n / 8)}</li></ol>${'  \r\n'.repeat(n / 8)}</li>`,
          ),
      ],
      [
        'a duplicate list item of separators throughout',
        (n) =>
          refList(
            `<li><span class="ref-label">1.</span><ol class="duplicate"><li>A.${', and'.repeat(n / 5)}</li></ol>A. Editor.</li>`,
          ),
      ],
      [
        'many items of a duplicate list, each named late in a long entry',
        (n) =>
          refList(
            `<li><span class="ref-label">1.</span><ol class="duplicate">${'<li>A. Editor, and</li>'.repeat(n / 44)}</ol>${'x '.repeat(n / 4)}${'A. Editor, and '.repeat(n / 30)}</li>`,
          ),
      ],
      [
        'many items of a duplicate list, each named past fragments of a longer name',
        (n) =>
          refList(
            `<li><span class="ref-label">1.</span><ol class="duplicate">${'<li>A. Editor, and</li>'.repeat(n / 44)}</ol>${'A. Editors '.repeat(n / 22)}${'A. Editor, and '.repeat(n / 30)}</li>`,
          ),
      ],
      // The nested shapes below run about as deep as those above: linkedom's own
      // parse slows superlinearly on far deeper nesting, before any pass runs.
      [
        'lists nested in lists in one reference entry',
        (n) =>
          refList(
            `<li><span class="ref-label">1.</span>${'<ol><li>A. Editor, with an affiliation line long enough to keep nesting shallow, and'.repeat(n / 87)}`,
          ),
      ],
      [
        'sections headed with a navigation word nested in one another',
        (n) => '<div class="section"><h3>Related work</h3><p>Text.</p>'.repeat(n / 52),
      ],
      [
        'block elements nested in table cells',
        (n) =>
          '<table><tr><td><div class="cell">Cell text, noted here for the record in this table.'.repeat(
            n / 240,
          ),
      ],
    ];

    it.each(SHAPES)('stays linear in page size on %s', async (_shape, build) => {
      mockExtract.mockResolvedValue({ content: 'Article body.' });
      const cpuMs: number[] = [];
      for (let size = 5_000; size <= 320_000; size *= 2) {
        const html = page(build(size));
        // The least of three runs, so one run slowed by a collection or a
        // loaded machine does not read as growth.
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 3; run++) {
          mockFetch.mockResolvedValue(makeHtmlResponse(html));
          const before = process.threadCpuUsage();
          const result = await service.fetchFullText(
            'biorxiv',
            DOI,
            '1',
            startCallDeadline(),
            tenantlessCtx(),
          );
          const used = process.threadCpuUsage(before);
          expect(result.kind).toBe('article');
          best = Math.min(best, (used.user + used.system) / 1000);
        }
        cpuMs.push(best);
        expect(best).toBeLessThan(2_000);
      }
      expect(cpuMs).toHaveLength(7);
      expect((cpuMs.at(-1) ?? 0) / Math.max(cpuMs[0] ?? 0, 0.05)).toBeLessThan(256);
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

      it('backs off on a 429 with Retry-After: 0 as on one with no header, never re-sending at once', async () => {
        const startedAt: number[] = [];
        mockFetch.mockImplementation(() => {
          startedAt.push(Date.now());
          return Promise.reject(httpError(429, '0'));
        });
        const { value } = await settle(fetchPage(tenantCtx(), startCallDeadline()));

        // 500 ms base, ±25% jitter: waits of 375–625, 750–1250, 1500–2500 ms.
        const gaps = startedAt.slice(1).map((t, i) => t - (startedAt[i] as number));
        expect(gaps).toHaveLength(3);
        for (const [i, gap] of gaps.entries()) {
          expect(gap).toBeGreaterThanOrEqual(375 * 2 ** i);
          expect(gap).toBeLessThanOrEqual(625 * 2 ** i);
        }
        expect(value).toEqual({
          kind: 'unavailable',
          reason: 'rate_limited',
          detail: 'The full-text origin is rate-limiting this host (HTTP 429).',
          sourceUrl: `https://www.biorxiv.org/content/${DOI}v1.full`,
        });
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
