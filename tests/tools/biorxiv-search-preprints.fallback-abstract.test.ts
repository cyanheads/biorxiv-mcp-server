/**
 * @fileoverview biorxiv_search_preprints abstracts on EuropePMC-fallback
 * records, end to end. The ranked search uses EuropePMC's `lite` result type,
 * which never carries `abstractText`, so a record that falls back to EuropePMC
 * metadata gets its abstract from one DOI-keyed `resultType=core` query. The
 * real `EuropePmcService` and `BiorxivApiService`, `fetchWithTimeout`,
 * `withRetry`, the tool handler, `format()`, enrichment, and output validation
 * all run; only `globalThis.fetch` is faked, with lite fixtures shaped like the
 * live responses (no `abstractText`).
 * @module tests/tools/biorxiv-search-preprints.fallback-abstract.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivSearchPreprintsTool } from '@/mcp-server/tools/definitions/biorxiv-search-preprints.tool.js';
import { initBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import { initEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

/** Held by api.biorxiv.org — enriched. */
const ENRICHED = '10.1101/2026.09.01.700001';
/** Not held by api.biorxiv.org — falls back with enrichment_error "not_found". */
const NOT_HELD = '10.1101/2026.09.01.700002';
/** api.biorxiv.org answers HTTP 500 — falls back with enrichment_error "service_error". */
const BROKEN = '10.1101/2026.09.01.700003';

const ENRICHED_ABSTRACT = 'Abstract from api.biorxiv.org.';

/** Core `abstractText` as EuropePMC sends it: structured-abstract headings as `<h4>`. */
const RAW_NOT_HELD_ABSTRACT =
  '<h4>Background</h4>  Filaments form. <h4>Results</h4>  A ∼10 nm pitch.';
const NOT_HELD_ABSTRACT = 'Background: Filaments form. Results: A ∼10 nm pitch.';
/** Markdown metacharacters that must reach content[] escaped and structuredContent raw. */
const BROKEN_ABSTRACT = 'Adenine base editors convert A*T to G*C (p<0.05).';
const BROKEN_ABSTRACT_ESCAPED = 'Adenine base editors convert A\\*T to G\\*C (p<0.05).';

const CORE_ABSTRACTS: Record<string, string> = {
  [NOT_HELD]: RAW_NOT_HELD_ABSTRACT,
  [BROKEN]: BROKEN_ABSTRACT,
};

function liteRecord(doi: string, title: string) {
  // The live lite shape: no abstractText, whatever `fields` asks for.
  return {
    id: `PPR${doi.slice(-6)}`,
    source: 'PPR',
    doi,
    title,
    authorString: 'Doe J, Roe R',
    firstPublicationDate: '2026-09-01',
    pubType: 'preprint',
  };
}

function liteBody(dois: string[]) {
  return {
    version: '6.9',
    hitCount: dois.length,
    resultList: { result: dois.map((doi, i) => liteRecord(doi, `Preprint ${i + 1}`)) },
  };
}

/** The DOIs a `DOI:"…" OR DOI:"…"` core query asks for. */
function requestedDois(url: URL): string[] {
  return [...(url.searchParams.get('query') ?? '').matchAll(/DOI:"([^"]+)"/g)].map(
    (m) => m[1] ?? '',
  );
}

function isCore(request: Request): boolean {
  return new URL(request.url).searchParams.get('resultType') === 'core';
}

const http = createFetchMock();

function routeBiorxiv(): void {
  http.route({
    match: (request) => new URL(request.url).hostname === 'api.biorxiv.org',
    respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.includes(BROKEN)) return new Response('upstream error', { status: 500 });
      const collection = path.includes(ENRICHED)
        ? [
            {
              doi: ENRICHED,
              title: 'Enriched preprint',
              authors: 'Doe, J.',
              date: '2026-09-01',
              version: '1',
              category: 'cell biology',
              server: 'bioRxiv',
              published: 'NA',
              abstract: ENRICHED_ABSTRACT,
              funder: [{ name: 'X', id: 'https://ror.org/016jc2h42', award: 'R01GM000001' }],
            },
          ]
        : [];
      return Response.json({ messages: [{ status: 'ok' }], collection });
    },
  });
}

/** Lite search answers `liteDois`; the core lookup answers with `core`. */
function routeEuropePmc(liteDois: string[], core?: (request: Request) => Response): void {
  http.route({
    match: (request) => new URL(request.url).hostname === 'www.ebi.ac.uk' && isCore(request),
    respond:
      core ??
      ((request) => {
        const result = requestedDois(new URL(request.url))
          .filter((doi) => CORE_ABSTRACTS[doi])
          .map((doi) => ({ ...liteRecord(doi, 'core'), abstractText: CORE_ABSTRACTS[doi] }));
        return Response.json({ version: '6.9', hitCount: result.length, resultList: { result } });
      }),
  });
  http.route({
    match: (request) => new URL(request.url).hostname === 'www.ebi.ac.uk',
    respond: () => Response.json(liteBody(liteDois)),
  });
}

async function run(input: Record<string, unknown>) {
  const pending = runToolContract(biorxivSearchPreprintsTool, input as never, {
    context: { errors: biorxivSearchPreprintsTool.errors },
  });
  await vi.runAllTimersAsync();
  const result = await pending;
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const structured = result.structuredContent as {
    preprints: Record<string, unknown>[];
    partial_results: boolean;
    notice?: string;
  };
  const byDoi = (doi: string) => structured.preprints.find((p) => p.doi === doi) ?? {};
  return { result, text, structured, byDoi };
}

function coreCalls() {
  return http.calls.filter((c) => isCore(c.request)).map((c) => new URL(c.request.url));
}

describe('biorxiv_search_preprints — abstracts on EuropePMC-fallback records', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    http.reset();
    http.install();
    routeBiorxiv();
    initBiorxivApiService({} as AppConfig, {} as StorageService);
    initEuropePmcService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it('attaches normalized abstracts to fallback records from one core query keyed by their DOIs', async () => {
    routeEuropePmc([ENRICHED, NOT_HELD, BROKEN]);
    const { result, text, structured, byDoi } = await run({
      query: 'filaments',
      server: 'biorxiv',
    });

    expect(result.isError).toBeFalsy();
    expect(byDoi(ENRICHED)).toMatchObject({ enriched: true, abstract: ENRICHED_ABSTRACT });
    expect(byDoi(NOT_HELD)).toMatchObject({
      enriched: false,
      enrichment_error: 'not_found',
      abstract: NOT_HELD_ABSTRACT,
    });
    expect(byDoi(BROKEN)).toMatchObject({
      enriched: false,
      enrichment_error: 'service_error',
      abstract: BROKEN_ABSTRACT,
    });
    expect(structured.notice).toBeUndefined();

    expect(text).toContain(`**Abstract:** ${ENRICHED_ABSTRACT}`);
    expect(text).toContain(`**Abstract:** ${NOT_HELD_ABSTRACT}`);
    expect(text).toContain(`**Abstract:** ${BROKEN_ABSTRACT_ESCAPED}`);

    // One core request, bounded to the two fallback DOIs — never the enriched one.
    const core = coreCalls();
    expect(core).toHaveLength(1);
    const [url] = core;
    expect(requestedDois(url as URL).sort()).toEqual([NOT_HELD, BROKEN]);
    expect(url?.searchParams.get('pageSize')).toBe('2');
    expect(url?.searchParams.get('query')).toContain('SRC:PPR');
    // The ranked search itself stays lite.
    const lite = http.calls.filter(
      (c) => new URL(c.request.url).hostname === 'www.ebi.ac.uk' && !isCore(c.request),
    );
    expect(lite).toHaveLength(1);
    expect(new URL(lite[0]?.request.url ?? '').searchParams.get('resulttype')).toBe('lite');
  });

  it('makes no core request when every record is enriched', async () => {
    routeEuropePmc([ENRICHED]);
    const { byDoi } = await run({ query: 'filaments', server: 'biorxiv' });
    expect(byDoi(ENRICHED)).toMatchObject({ enriched: true, abstract: ENRICHED_ABSTRACT });
    expect(coreCalls()).toHaveLength(0);
  });

  it('makes no core request when include_abstract is false, and drops every abstract', async () => {
    routeEuropePmc([ENRICHED, NOT_HELD]);
    const { result, text, structured, byDoi } = await run({
      query: 'filaments',
      server: 'biorxiv',
      include_abstract: false,
    });

    expect(result.isError).toBeFalsy();
    expect(coreCalls()).toHaveLength(0);
    for (const p of structured.preprints) expect(p).not.toHaveProperty('abstract');
    expect(text).not.toContain('**Abstract:**');
    // Every other field stays, on both surfaces.
    expect(byDoi(ENRICHED)).toMatchObject({
      enriched: true,
      title: 'Enriched preprint',
      awards: ['R01GM000001'],
      category: 'cell biology',
    });
    expect(byDoi(NOT_HELD)).toMatchObject({
      enriched: false,
      enrichment_error: 'not_found',
      title: 'Preprint 2',
      authors: 'Doe J, Roe R',
      date: '2026-09-01',
    });
    expect(text).toContain('**Awards:** R01GM000001');
    expect(text).toContain('**Authors:** Doe J, Roe R');
    expect(text).toContain('enrichment_error: not_found');
    expect(structured.notice).toBeUndefined();
  });

  it('leaves a fallback record without an abstract, and says nothing, when EuropePMC holds none', async () => {
    const unknown = '10.1101/2026.09.01.700004';
    routeEuropePmc([NOT_HELD, unknown]);
    const { structured, byDoi } = await run({ query: 'filaments', server: 'biorxiv' });

    expect(byDoi(NOT_HELD)).toMatchObject({ abstract: NOT_HELD_ABSTRACT });
    expect(byDoi(unknown)).toMatchObject({ enriched: false });
    expect(byDoi(unknown)).not.toHaveProperty('abstract');
    expect(structured.notice).toBeUndefined();
    expect(coreCalls()).toHaveLength(1);
  });

  it('returns fallback records without abstracts and a notice on both surfaces when the core request fails', async () => {
    routeEuropePmc([ENRICHED, NOT_HELD, BROKEN], () => new Response('down', { status: 503 }));
    const { result, text, structured, byDoi } = await run({
      query: 'filaments',
      server: 'biorxiv',
    });

    expect(result.isError).toBeFalsy();
    expect(byDoi(ENRICHED)).toMatchObject({ enriched: true, abstract: ENRICHED_ABSTRACT });
    expect(byDoi(NOT_HELD)).toMatchObject({ enriched: false, title: 'Preprint 2' });
    expect(byDoi(NOT_HELD)).not.toHaveProperty('abstract');
    expect(byDoi(BROKEN)).not.toHaveProperty('abstract');
    expect(structured.partial_results).toBe(true);

    expect(structured.notice).toContain('2 results shown with EuropePMC metadata only');
    expect(structured.notice).toContain('retry the search');
    expect(text).toContain('2 results shown with EuropePMC metadata only');
    expect(text).toContain(`**Abstract:** ${ENRICHED_ABSTRACT}`);
    expect(text.match(/\*\*Abstract:\*\*/g)).toHaveLength(1);
    // Retried like every other EuropePMC call before giving up.
    expect(coreCalls().length).toBeGreaterThan(1);
  });

  it('names the wait in the notice when EuropePMC rate-limits the core request', async () => {
    routeEuropePmc(
      [NOT_HELD],
      () => new Response('slow down', { status: 429, headers: { 'Retry-After': '600' } }),
    );
    const { result, text, structured, byDoi } = await run({
      query: 'filaments',
      server: 'biorxiv',
    });

    expect(result.isError).toBeFalsy();
    expect(byDoi(NOT_HELD)).not.toHaveProperty('abstract');
    expect(structured.notice).toContain('rate-limiting');
    expect(structured.notice).toContain('600 seconds');
    expect(text).toContain('600 seconds');
    expect(text).not.toContain('slow down');
  });
});
