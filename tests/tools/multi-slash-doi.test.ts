/**
 * @fileoverview A DOI with a second slash, end to end on every tool that looks
 * one up through `/details` — biorxiv_get_preprint, biorxiv_get_fulltext,
 * biorxiv_get_published_version, and biorxiv_search_preprints enrichment. No
 * preprint DOI carries a second slash, so each must read such a DOI as absent:
 * sent raw, api.biorxiv.org answers an Apache 404 indistinguishable from a
 * missing route, while every slash after the first sent as `%252F` reaches the
 * API whole and draws HTTP 200 with an empty collection. A 404 on the encoded
 * key still fails the lookup. The real `BiorxivApiService`, `fetchWithTimeout`,
 * `withRetry`, tool handlers, `format()`, and error envelopes all run; only
 * `globalThis.fetch` is faked, with the live API's answers.
 * @module tests/tools/multi-slash-doi.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetFulltextTool } from '@/mcp-server/tools/definitions/biorxiv-get-fulltext.tool.js';
import { biorxivGetPreprintTool } from '@/mcp-server/tools/definitions/biorxiv-get-preprint.tool.js';
import { biorxivGetPublishedVersionTool } from '@/mcp-server/tools/definitions/biorxiv-get-published-version.tool.js';
import { biorxivSearchPreprintsTool } from '@/mcp-server/tools/definitions/biorxiv-search-preprints.tool.js';
import { initBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import { initEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

const MULTI = '10.1101/abc/def';
const HELD = '10.1101/2020.03.21.990770';

/** The Apache page api.biorxiv.org serves for a raw multi-slash DOI and for a missing route alike. */
const APACHE_404 =
  '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n</body></html>\n';

/** Live answers for {@link MULTI} with each later slash sent as `%252F`. */
const LIVE: Record<string, unknown> = {
  '/details/biorxiv/10.1101/abc%252Fdef/0/json': {
    messages: [{ status: 'DOI not recognizable' }],
    collection: [],
  },
  '/details/medrxiv/10.1101/abc%252Fdef/0/json': {
    messages: [{ status: 'DOI not recognizable' }],
    collection: [],
  },
  '/pubs/biorxiv/10.1101/abc%252Fdef/json': {
    messages: [{ status: 'DOI 10.1101/abc/def not recognizable' }],
    collection: [],
  },
  '/pubs/medrxiv/10.1101/abc%252Fdef/json': {
    messages: [{ status: 'DOI 10.1101/abc/def not recognizable' }],
    collection: [],
  },
  [`/details/biorxiv/${HELD}/0/json`]: {
    messages: [{ status: 'ok' }],
    collection: [
      {
        doi: HELD,
        title: 'Potent human neutralizing antibodies elicited by SARS-CoV-2 infection',
        authors: 'Ju, B.; Zhang, Q.',
        date: '2020-03-26',
        version: '1',
        category: 'immunology',
        server: 'bioRxiv',
        published: '10.1038/s41586-020-2380-z',
      },
    ],
  },
  [`/details/medrxiv/${HELD}/0/json`]: { messages: [{ status: 'no posts found' }], collection: [] },
};

const http = createFetchMock();

/**
 * Answer api.biorxiv.org from `routes` — a status number answers that status
 * with the Apache page — and any other path with the Apache 404, as the live
 * origin does for a raw multi-slash DOI. A request to any other origin, an
 * article page included, is recorded and answered 404.
 */
function answer(routes: Record<string, unknown>): void {
  http.route({
    match: (request) => new URL(request.url).hostname === 'api.biorxiv.org',
    respond: (request) => {
      const body = routes[new URL(request.url).pathname];
      if (body === undefined || typeof body === 'number') {
        return new Response(APACHE_404, {
          status: typeof body === 'number' ? body : 404,
          headers: { 'Content-Type': 'text/html; charset=iso-8859-1' },
        });
      }
      return Response.json(body);
    },
  });
  http.route({
    match: (request) => new URL(request.url).hostname === 'www.ebi.ac.uk',
    respond: () =>
      Response.json({
        version: '6.9',
        hitCount: 2,
        resultList: {
          result: [
            { doi: MULTI, title: 'A record with a malformed DOI', authorString: 'Roe R' },
            { doi: HELD, title: 'Potent human neutralizing antibodies', authorString: 'Ju B' },
          ],
        },
      }),
  });
  http.route({ match: () => true, respond: () => new Response('Not Found', { status: 404 }) });
}

const paths = () => http.calls.map(({ request }) => new URL(request.url).pathname);

async function run<T extends Parameters<typeof runToolContract>[0]>(
  definition: T,
  input: Record<string, unknown>,
) {
  const pending = runToolContract(definition, input as never, {
    context: { errors: definition.errors },
  });
  await vi.runAllTimersAsync();
  const result = await pending;
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const structured = result.structuredContent as Record<string, unknown> & {
    error?: { code: number; message: string; data: Record<string, unknown> };
  };
  return { result, text, structured };
}

describe('a DOI with a second slash reads as absent, never as an outage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    http.reset();
    http.install();
    initBiorxivApiService({} as AppConfig, {} as StorageService);
    initEuropePmcService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it('biorxiv_get_preprint: alone in the call it raises doi_not_found, not retryable', async () => {
    answer(LIVE);
    const { result, text, structured } = await run(biorxivGetPreprintTool, { dois: [MULTI] });

    expect(result.isError).toBe(true);
    expect(structured.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found' },
    });
    expect(structured.error?.data).not.toHaveProperty('retryable');
    expect(text).toContain('(reason doi_not_found');
    expect(text).not.toContain('upstream_unavailable');
    expect(paths().sort()).toEqual([
      '/details/biorxiv/10.1101/abc%252Fdef/0/json',
      '/details/medrxiv/10.1101/abc%252Fdef/0/json',
    ]);
  });

  it('biorxiv_get_preprint: batched, its failed[] entry is not_found with retryable false on both surfaces', async () => {
    answer(LIVE);
    const { result, text, structured } = await run(biorxivGetPreprintTool, {
      dois: [MULTI, HELD],
    });

    expect(result.isError).toBeFalsy();
    expect(structured.failed).toEqual([
      expect.objectContaining({ doi: MULTI, reason: 'not_found', retryable: false }),
    ]);
    expect(structured.preprints).toEqual([expect.objectContaining({ doi: HELD })]);
    expect(text).toContain(MULTI);
    expect(text).toContain('not_found, retryable: false');
    expect(text).not.toContain('upstream_unavailable');
  });

  it('biorxiv_get_fulltext raises doi_not_found', async () => {
    answer(LIVE);
    const { result, text, structured } = await run(biorxivGetFulltextTool, { doi: MULTI });

    expect(result.isError).toBe(true);
    expect(structured.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found' },
    });
    expect(text).toContain('(reason doi_not_found');
    // Resolution ended at /details; no article page was requested.
    expect(http.calls.map(({ request }) => request.url).sort()).toEqual([
      'https://api.biorxiv.org/details/biorxiv/10.1101/abc%252Fdef/0/json',
      'https://api.biorxiv.org/details/medrxiv/10.1101/abc%252Fdef/0/json',
    ]);
  });

  it('biorxiv_get_published_version raises doi_not_found', async () => {
    answer(LIVE);
    const { result, text, structured } = await run(biorxivGetPublishedVersionTool, {
      doi: MULTI,
    });

    expect(result.isError).toBe(true);
    expect(structured.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found', doi: MULTI },
    });
    expect(text).toContain('(reason doi_not_found');
    expect(paths().sort()).toEqual([
      '/details/biorxiv/10.1101/abc%252Fdef/0/json',
      '/details/medrxiv/10.1101/abc%252Fdef/0/json',
      '/pubs/biorxiv/10.1101/abc%252Fdef/json',
      '/pubs/medrxiv/10.1101/abc%252Fdef/json',
    ]);
  });

  it('biorxiv_search_preprints enrichment marks the record not_found, not service_error', async () => {
    answer(LIVE);
    const { result, text, structured } = await run(biorxivSearchPreprintsTool, {
      query: 'neutralizing antibodies',
    });

    expect(result.isError).toBeFalsy();
    const preprints = structured.preprints as Record<string, unknown>[];
    expect(preprints.find((p) => p.doi === MULTI)).toMatchObject({
      enriched: false,
      enrichment_error: 'not_found',
    });
    expect(preprints.find((p) => p.doi === HELD)).toMatchObject({ enriched: true });
    expect(text).toContain('enrichment_error: not_found');
    expect(text).not.toContain('enrichment_error: service_error');
  });

  describe('an HTTP 404 from /details still fails the lookup', () => {
    /** The live answers, with the encoded /details key 404ing as a removed route would. */
    const BROKEN_ROUTE = {
      ...LIVE,
      '/details/biorxiv/10.1101/abc%252Fdef/0/json': 404,
      '/details/medrxiv/10.1101/abc%252Fdef/0/json': 404,
    };

    it('biorxiv_get_preprint raises retryable upstream_unavailable', async () => {
      answer(BROKEN_ROUTE);
      const { text, structured } = await run(biorxivGetPreprintTool, { dois: [MULTI] });

      expect(structured.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true },
      });
      expect(structured.error?.message).toContain('404');
      expect(text).toContain('upstream_unavailable');
    });

    it('biorxiv_get_preprint batched marks the entry upstream_unavailable, retryable', async () => {
      answer(BROKEN_ROUTE);
      const { structured } = await run(biorxivGetPreprintTool, { dois: [MULTI, HELD] });

      expect(structured.failed).toEqual([
        expect.objectContaining({ doi: MULTI, reason: 'upstream_unavailable', retryable: true }),
      ]);
    });

    it('biorxiv_get_fulltext raises retryable upstream_unavailable', async () => {
      answer(BROKEN_ROUTE);
      const { structured } = await run(biorxivGetFulltextTool, { doi: MULTI });

      expect(structured.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true },
      });
    });

    it('biorxiv_get_published_version raises retryable upstream_unavailable', async () => {
      answer(BROKEN_ROUTE);
      const { structured } = await run(biorxivGetPublishedVersionTool, { doi: MULTI });

      expect(structured.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true },
      });
    });

    it('biorxiv_search_preprints enrichment marks the record service_error', async () => {
      answer(BROKEN_ROUTE);
      const { structured } = await run(biorxivSearchPreprintsTool, {
        query: 'neutralizing antibodies',
      });

      const preprints = structured.preprints as Record<string, unknown>[];
      expect(preprints.find((p) => p.doi === MULTI)).toMatchObject({
        enrichment_error: 'service_error',
      });
    });
  });
});
