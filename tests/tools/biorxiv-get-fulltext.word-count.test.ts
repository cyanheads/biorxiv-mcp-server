/**
 * @fileoverview biorxiv_get_fulltext `wordCount` against the Markdown the tool
 * pages over. The real `BiorxivFullTextService`, `fetchWithTimeout`,
 * `withRetry`, and `htmlExtractor` (defuddle + linkedom) run; only
 * `globalThis.fetch` for the article host is faked, serving Highwire-shaped
 * article pages, and version resolution on api.biorxiv.org is stubbed. The
 * extractor's own word count is measured on its intermediate HTML, not on the
 * Markdown the tool serves, so `wordCount` must be derived from the served text.
 * @module tests/tools/biorxiv-get-fulltext.word-count.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { htmlExtractor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetFulltextTool } from '@/mcp-server/tools/definitions/biorxiv-get-fulltext.tool.js';
import { initBiorxivFullTextService } from '@/services/biorxiv-fulltext/biorxiv-fulltext-service.js';

const WEB_BASE = 'https://www.medrxiv.org';
const DOI = '10.64898/2026.05.05.26351600';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
    biorxivWebBaseUrl: 'https://www.biorxiv.org',
    medrxivWebBaseUrl: 'https://www.medrxiv.org',
  }),
}));

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({
    getDetails: (_doi: string, server: string) =>
      Promise.resolve(
        server === 'medrxiv' ? [{ doi: '10.64898/2026.05.05.26351600', version: '1', server }] : [],
      ),
  }),
}));

/** Wrap an article body in the Highwire page chrome the service extracts from. */
function highwirePage(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><title>${title} | medRxiv</title></head><body>
<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/submit">Submit a manuscript</a></nav></header>
<div class="article fulltext-view">${body}</div>
<footer><p>medRxiv is operated by openRxiv.</p></footer></body></html>`;
}

/**
 * A long research article: headings, bulleted findings, a results table, and a
 * linked reference list — the Markdown constructs whose syntax and URLs the
 * extractor's HTML-text word count never sees.
 */
function largeArticle(): string {
  const sentence =
    'Long-read nanopore sequencing resolved the allelic configuration of co-occurring variants in tumor suppressor genes across the cohort.';
  const sections: string[] = [
    '<h1>Long-Read Haplotype Phasing Resolves Allelic Configuration</h1>',
    `<div class="section abstract"><h2>Abstract</h2><p>${sentence.repeat(6)}</p></div>`,
  ];
  for (let s = 1; s <= 28; s++) {
    const paragraphs = Array.from(
      { length: 5 },
      (_, p) => `<p>Section ${s} paragraph ${p + 1}. ${`${sentence} `.repeat(5)}</p>`,
    ).join('');
    const findings = Array.from(
      { length: 3 },
      (_, i) =>
        `<li>Finding ${s}.${i + 1}: trans configuration confirmed in patient ${s * 10 + i}.</li>`,
    ).join('');
    sections.push(
      `<div class="section"><h2>Section ${s}</h2>${paragraphs}<ul>${findings}</ul></div>`,
    );
  }
  sections.push(
    '<table><thead><tr><th>Gene</th><th>Cases</th><th>Configuration</th></tr></thead><tbody>' +
      Array.from(
        { length: 12 },
        (_, i) => `<tr><td>GENE${i}</td><td>${i + 3}</td><td>trans</td></tr>`,
      ).join('') +
      '</tbody></table>',
  );
  const refs = Array.from(
    { length: 80 },
    (_, i) =>
      `<li>Author ${i} et al. A study of haplotype phasing number ${i}. <a href="https://doi.org/10.1000/example.${i}">https://doi.org/10.1000/example.${i}</a></li>`,
  ).join('');
  sections.push(`<div class="section ref-list"><h2>References</h2><ol>${refs}</ol></div>`);
  return highwirePage('Long-Read Haplotype Phasing', sections.join('\n'));
}

/** A short body — a heading and a two-item list, a dozen words in all. */
const SPARSE_ARTICLE = highwirePage(
  'Brief communication',
  '<h2>Summary</h2><ul><li>Macrophages drive limb regeneration.</li><li>Depletion blocks it.</li></ul>',
);

const http = createFetchMock();

function serveArticle(html: string): void {
  http.route({
    match: (request) => new URL(request.url).origin === new URL(WEB_BASE).origin,
    respond: () => new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
}

const tokens = (text: string): number => text.split(/\s+/).filter(Boolean).length;

describe('biorxiv_get_fulltext wordCount', () => {
  beforeEach(() => {
    http.reset();
    http.install();
    initBiorxivFullTextService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    http.restore();
  });

  it('counts the words of a sparse article from the served Markdown', async () => {
    serveArticle(SPARSE_ARTICLE);
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: DOI });
    const result = await biorxivGetFulltextTool.handler(input, ctx);

    expect(result.hasMore).toBe(false);
    expect(result.wordCount).toBe(tokens(result.content));
    expect(result.content).toContain('Macrophages drive limb regeneration.');
  });

  it('matches the words across every page of a large article, on every page', async () => {
    const html = largeArticle();
    serveArticle(html);
    // The measurement the tool used to pass through, taken on the same page.
    const extractorFigure = (
      await htmlExtractor.extract(html, {
        url: `${WEB_BASE}/content/${DOI}v1.full`,
        format: 'markdown',
        contentSelector: '.fulltext-view',
      })
    ).wordCount;

    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const pages: string[] = [];
    const reported = new Set<number>();
    let offset = 0;
    let totalChars = Number.POSITIVE_INFINITY;
    // Bounded walk: the article is ~140k chars, so 2,000-char pages end well inside 200.
    for (let page = 0; page < 200 && offset < totalChars; page++) {
      const input = biorxivGetFulltextTool.input.parse({ doi: DOI, offset, limit: 2000 });
      const result = await biorxivGetFulltextTool.handler(input, ctx);
      pages.push(result.content);
      reported.add(result.wordCount);
      totalChars = result.totalChars;
      offset = result.offset + result.length;
      if (!result.hasMore) break;
    }

    const served = pages.join('');
    expect(served.length).toBe(totalChars);
    expect(pages.length).toBeGreaterThan(40);
    // One article, one count — every chunk reports the same full-article figure.
    expect(reported.size).toBe(1);
    const [wordCount] = [...reported];
    expect(wordCount).toBe(tokens(served));
    expect(wordCount).toBeGreaterThan(13_000);
    // The extractor counts its HTML's text nodes, not the Markdown it serves —
    // passing that figure through left wordCount disagreeing with content.
    expect(extractorFigure).not.toBe(wordCount);
    // One origin fetch for the whole walk — the cache serves every later page.
    expect(http.calls).toHaveLength(1);
  });

  it('carries the same wordCount on structuredContent and content[]', async () => {
    serveArticle(largeArticle());
    const result = await runToolContract(
      biorxivGetFulltextTool,
      { doi: DOI, limit: 5000 },
      { context: { errors: biorxivGetFulltextTool.errors } },
    );
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { wordCount: number; hasMore: boolean };
    expect(structured.hasMore).toBe(true);
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(`**Full-article word count:** ${structured.wordCount}`);
    expect(biorxivGetFulltextTool.output.parse(structured).wordCount).toBe(structured.wordCount);
  });
});
