/**
 * @fileoverview biorxiv_search_preprints end to end against EuropePMC's
 * empty-body response (HTTP 200, `{"version":"6.9"}` only) and the HTTP 503 it
 * answers a malformed cursor with. Only
 * `globalThis.fetch` for the EuropePMC origin is faked — the real
 * `fetchWithTimeout`, `withRetry`, `EuropePmcService` classification, tool
 * handler, `format()`, and error envelope all run, so both client surfaces
 * (`structuredContent` and `content[]`) are asserted as a caller receives them.
 * bioRxiv enrichment is stubbed; it is not on the path under test.
 * @module tests/tools/biorxiv-search-preprints.empty-body.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivSearchPreprintsTool } from '@/mcp-server/tools/definitions/biorxiv-search-preprints.tool.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';
import { initEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

const REVISION: PreprintRevision = {
  doi: '10.1101/2024.01.15.575123',
  title: 'Axolotl limb regeneration requires macrophages',
  authors: 'Smith J',
  date: '2024-01-15',
  version: '1',
  category: 'Developmental Biology',
  server: 'biorxiv',
  abstract: 'An abstract for the linked record.',
};

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({ getDetails: () => Promise.resolve([REVISION]) }),
}));

const EMPTY_BODY = { version: '6.9' };

const POPULATED_BODY = {
  version: '6.9',
  hitCount: 2,
  resultList: {
    result: [
      {
        doi: '10.1101/2024.01.15.575123',
        title: 'Axolotl limb regeneration requires macrophages',
        authorString: 'Smith J',
        firstPublicationDate: '2024-01-15',
      },
    ],
  },
};

const http = createFetchMock();

function answerWith(...bodies: unknown[]): void {
  let call = 0;
  http.route({
    match: (request) => new URL(request.url).origin === new URL(BASE).origin,
    respond: () => {
      const body = bodies[Math.min(call, bodies.length - 1)];
      call++;
      return Response.json(body);
    },
  });
}

/** EuropePMC's outage answer — also what it sends for a malformed cursor (captured live). */
function outage(): Response {
  return Response.json(
    { errCode: 503, errMsg: 'Search service is temporarily unavailable. Please retry later.' },
    { status: 503 },
  );
}

/** Answer cursor-page requests with `cursorPage`, `cursorMark=*` requests with `firstPage`. */
function answerPages(
  cursorPage: (request: Request) => Response | Promise<Response>,
  firstPage: (request: Request) => Response | Promise<Response>,
): void {
  http.route({
    match: (request) => new URL(request.url).hostname === 'www.ebi.ac.uk',
    respond: (request) =>
      new URL(request.url).searchParams.get('cursorMark') === '*'
        ? firstPage(request)
        : cursorPage(request),
  });
}

/** The `cursorMark` of every EuropePMC request sent, in order. */
function sentPages(): (string | null)[] {
  return http.calls.map((call) => new URL(call.request.url).searchParams.get('cursorMark'));
}

/** Run the tool through its contract boundary while fake timers skip the backoff. */
async function run(input: Record<string, unknown>, signal?: AbortSignal) {
  const pending = runToolContract(biorxivSearchPreprintsTool, input as never, {
    context: { errors: biorxivSearchPreprintsTool.errors, ...(signal && { signal }) },
  });
  await vi.runAllTimersAsync();
  return pending;
}

function text(result: Awaited<ReturnType<typeof run>>): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function errorOf(result: Awaited<ReturnType<typeof run>>) {
  return (
    result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    }
  ).error;
}

describe('biorxiv_search_preprints — EuropePMC empty-body responses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    http.reset();
    http.install();
    initEuropePmcService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it.each([
    'Jennifer Doudna',
    "O'Neill M",
    'St. John T',
    'Research Group, Inc.',
    'Genome Consortium, Europe',
    'Doudna Jennifer A.',
    'Doudna, Jennifer A.',
    'de la Cruz J.',
  ])('preserves an exact author filter on a cursor page: %s', async (author) => {
    answerWith({ hitCount: 0, resultList: { result: [] } });
    const result = await run({ author, cursor_mark: 'existing' });
    expect(http.calls).toHaveLength(1);
    const params = new URL(http.calls[0]!.request.url).searchParams;
    expect(params.get('query')).toContain(`AUTH:"${author}"`);
    expect(params.get('cursorMark')).toBe('existing');
    expect(result.structuredContent).toMatchObject({ queryEcho: { author } });
  });

  it.each([
    ['Bucher, G.', 'Bucher G'],
    ['Doudna, J.A.', 'Doudna JA'],
    ['Doudna, J. A.', 'Doudna JA'],
    ['Doudna, Jennifer', 'Doudna Jennifer'],
    ["O'Neill, M.", "O'Neill M"],
    ['St. John, T.', 'St. John T'],
    ['de la Cruz, J.', 'de la Cruz J'],
    ['Doudna J.', 'Doudna J'],
    ['García-López, Á.', 'García-López Á'],
  ])(
    'sends the citation-form author %s as %s on first and later pages',
    async (author, expected) => {
      answerWith({ hitCount: 0, resultList: { result: [] } });
      for (const cursor_mark of ['*', 'existing']) {
        const result = await run({ author, cursor_mark });
        expect(result.structuredContent).toMatchObject({ queryEcho: { author: expected } });
        expect(text(result)).toContain(`author=${expected}`);
      }
      expect(http.calls.map((call) => new URL(call.request.url).searchParams.get('query'))).toEqual(
        [
          `AUTH:"${expected}" AND (PUBLISHER:bioRxiv OR PUBLISHER:medRxiv)`,
          `AUTH:"${expected}" AND (PUBLISHER:bioRxiv OR PUBLISHER:medRxiv)`,
        ],
      );
      expect(sentPages()).toEqual(['*', 'existing']);
    },
  );

  it('ends a cursor walk after a short raw page, preserving a full no-DOI page', async () => {
    const noDoi = { title: 'Unlinked record' };
    const row = POPULATED_BODY.resultList.result[0];
    answerWith(
      { hitCount: 3, nextCursorMark: 'second', resultList: { result: [noDoi, noDoi] } },
      { hitCount: 3, nextCursorMark: 'extra', resultList: { result: [row] } },
    );
    const first = await run({ query: 'axolotl', limit: 2 });
    expect(first.structuredContent).toMatchObject({
      preprints: [],
      nextCursorMark: 'second',
      notice: expect.stringContaining('none had a DOI'),
    });
    expect(text(first)).toContain('second');
    expect(text(first)).not.toContain('all 3 matches were on earlier pages');
    const second = await run({ query: 'axolotl', limit: 2, cursor_mark: 'second' });
    expect(second.structuredContent).toMatchObject({
      preprints: [expect.objectContaining({ doi: row?.doi })],
    });
    expect(second.structuredContent).not.toHaveProperty('nextCursorMark');
    expect(text(second)).not.toContain('extra');
    expect(sentPages()).toEqual(['*', 'second']);
  });

  it('keeps the past-end notice when a full final page carried a cursor', async () => {
    answerWith(
      { ...POPULATED_BODY, hitCount: 1, nextCursorMark: 'final' },
      { hitCount: 1, resultList: { result: [] } },
    );
    const full = await run({ query: 'axolotl', limit: 1 });
    expect(full.structuredContent).toHaveProperty('nextCursorMark', 'final');
    const end = await run({ query: 'axolotl', limit: 1, cursor_mark: 'final' });
    expect(end.structuredContent).toHaveProperty(
      'notice',
      expect.stringContaining('all 1 matches'),
    );
    expect(text(end)).toContain('all 1 matches');
  });

  it.each([99, 100])(
    'checks %i raw rows against the effective cap when limit exceeds 100',
    async (rowCount) => {
      answerWith({
        hitCount: 300,
        nextCursorMark: 'next',
        resultList: {
          result: Array.from({ length: rowCount }, () => ({ title: 'Unlinked record' })),
        },
      });
      const result = await run({ query: 'axolotl', limit: 250, cursor_mark: 'current' });
      expect(result.structuredContent).toMatchObject({ queryEcho: { limit: 100 }, preprints: [] });
      const pageSize = new URL(http.calls[0]!.request.url).searchParams.get('pageSize');
      expect(pageSize).toBe('100');
      if (rowCount === 100) {
        expect(result.structuredContent).toHaveProperty('nextCursorMark', 'next');
        expect(text(result)).toContain('Pass nextCursorMark as cursor_mark');
      } else {
        expect(result.structuredContent).not.toHaveProperty('nextCursorMark');
        expect(text(result)).not.toContain('Pass nextCursorMark as cursor_mark');
      }
      expect(text(result)).not.toContain('were on earlier pages');
    },
  );

  it('uses 10 as the omitted limit while retaining abstracts, and passes through 25 explicitly', async () => {
    answerWith(POPULATED_BODY);
    for (const limit of [undefined, 25]) {
      const result = await run({ query: 'axolotl', ...(limit && { limit }) });
      expect(result.structuredContent).toMatchObject({
        queryEcho: { limit: limit ?? 10 },
        preprints: [expect.objectContaining({ abstract: REVISION.abstract })],
      });
      expect(text(result)).toContain(`limit=${limit ?? 10}`);
      expect(text(result)).toContain('An abstract for the linked record.');
    }
    expect(
      http.calls.map((call) => new URL(call.request.url).searchParams.get('pageSize')),
    ).toEqual(['10', '25']);
  });

  it('adds a syntax hint only for a reported zero-hit response', async () => {
    const emptyList = { result: [] };
    answerWith(
      { hitCount: 0, resultList: emptyList },
      { resultList: emptyList },
      { hitCount: 2, resultList: { result: [{ title: 'Unlinked record' }] } },
      { hitCount: 0, resultList: emptyList },
    );
    const malformed = 'axolotl OR';
    const hinted = await run({ query: malformed });
    expect(hinted.structuredContent).toHaveProperty(
      'notice',
      expect.stringContaining('Try axolotl'),
    );
    expect(text(hinted)).toContain('The OR operator');
    expect(text(hinted)).toContain('Try axolotl');
    expect(text(hinted)).not.toContain('Try broader search terms');
    const derived = await run({ query: malformed });
    expect(text(derived)).toContain('Try broader search terms');
    const noDoi = await run({ query: malformed });
    expect(text(noDoi)).not.toMatch(/operator|operand/i);
    const valid = await run({ query: 'NOT axolotl' });
    expect(valid.structuredContent).toHaveProperty(
      'notice',
      expect.stringContaining('Try broader search terms'),
    );
    expect(text(valid)).toContain('Try broader search terms');
    expect(http.calls).toHaveLength(4);
  });

  it.each([
    ['TITLE:*fruit', String.raw`TITLE:\*fruit`],
    [String.raw`fruit\)`, String.raw`fruit\\)`],
  ])('keeps the advised repair copyable for %s', async (repair, markdownRepair) => {
    const query = `${repair} OR`;
    answerWith({ hitCount: 0, resultList: { result: [] } });
    const result = await run({ query });

    const diagnosis = 'The OR operator needs a search operand.';
    expect(result.structuredContent).toHaveProperty(
      'notice',
      `No preprints matched "${query}". ${diagnosis} Try ${repair}`,
    );
    expect(text(result)).toContain(
      `\n> No preprints matched "${markdownRepair} OR". ${diagnosis} Try ${markdownRepair}`,
    );
    expect(new URL(http.calls[0]!.request.url).searchParams.get('query')).toBe(
      `(${query}) AND (PUBLISHER:bioRxiv OR PUBLISHER:medRxiv)`,
    );
  });

  it('keeps every line of a multiline repair inside the notice', async () => {
    const query = 'TITLE:"fruit\nfly';
    answerWith({ hitCount: 0, resultList: { result: [] } });
    const result = await run({ query });

    expect(result.structuredContent).toHaveProperty(
      'notice',
      'No preprints matched "TITLE:"fruit\nfly". The quoted phrase is missing its closing quote. Try TITLE:"fruit\nfly"',
    );
    expect(text(result)).toContain(
      [
        '> No preprints matched "TITLE:"fruit\\',
        '> fly". The quoted phrase is missing its closing quote. Try TITLE:"fruit\\',
        '> fly"',
      ].join('\n'),
    );
  });

  it('retries one empty body transparently — both surfaces carry the real results (#47)', async () => {
    answerWith(EMPTY_BODY, POPULATED_BODY);
    const result = await run({ query: 'axolotl limb regeneration macrophage', limit: 3 });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ totalCount: 2, partial_results: false });
    expect(structured.notice).toBeUndefined();
    expect((structured.preprints as unknown[]).length).toBe(1);
    const rendered = text(result);
    expect(rendered).toContain('10.1101/2024.01.15.575123');
    expect(rendered).not.toContain('No preprints matched');
    expect(http.calls).toHaveLength(2);
  });

  it('raises search_unavailable when the first-page empty body persists (#47)', async () => {
    answerWith(EMPTY_BODY);
    const result = await run({ query: 'axolotl OR' });
    expect(text(result)).not.toContain('The OR operator');

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data.reason).toBe('search_unavailable');
    expect(error.message).toContain('no result list');
    expect(error.message).not.toContain('failed after');
    const hint = (error.data.recovery as { hint: string }).hint;
    // The request already ran from the first page — restarting from "*" is not
    // a next step here.
    expect(hint).not.toContain('*');
    expect(hint).not.toMatch(/cursor/i);
    const rendered = text(result);
    expect(rendered).toContain('no result list');
    expect(rendered).toContain('(reason search_unavailable)');
    expect(rendered).not.toContain('totalCount');
    expect(http.calls).toHaveLength(4);
  });

  it('raises invalid_cursor_mark for a cursor EuropePMC never recognizes (#43)', async () => {
    answerPages(
      () => Response.json(EMPTY_BODY),
      () => Response.json(POPULATED_BODY),
    );
    const result = await run({ query: 'crispr', cursor_mark: 'garbage!!!' });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_cursor_mark',
      cursor_mark: 'garbage!!!',
      retryable: false,
    });
    expect(error.message).toContain('cursor_mark');
    expect(error.message).not.toContain('failed after');
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toContain('nextCursorMark');
    expect(hint).toContain('"*"');
    const rendered = text(result);
    expect(rendered).toContain('Recovery:');
    expect(rendered).toContain('nextCursorMark');
    expect(rendered).toContain('(reason invalid_cursor_mark · not retryable)');
    expect(sentPages()).toEqual(['garbage!!!', 'garbage!!!', 'garbage!!!', 'garbage!!!', '*']);
  });

  it('raises search_unavailable when the empty body persists on the first page too', async () => {
    answerPages(
      () => Response.json(EMPTY_BODY),
      () => Response.json(EMPTY_BODY),
    );
    const result = await run({ query: 'crispr', cursor_mark: 'garbage!!!' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data.reason).toBe('search_unavailable');
    expect(error.message).toContain('no result list');
    expect(text(result)).toContain('(reason search_unavailable)');
    expect(sentPages()).toEqual(['garbage!!!', 'garbage!!!', 'garbage!!!', 'garbage!!!', '*']);
  });

  // ── #72: a malformed cursor answered HTTP 503 ──────────────────────────────

  it('raises invalid_cursor_mark for a cursor answered HTTP 503 while the first page answers', async () => {
    answerPages(outage, () => Response.json(POPULATED_BODY));
    const result = await run({ query: 'CRISPR', cursor_mark: 'garbage' });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_cursor_mark',
      cursor_mark: 'garbage',
      retryable: false,
    });
    expect(error.message).toContain('cursor_mark');
    expect(error.message).toContain('HTTP 503');
    expect(error.message).not.toContain('failed after');
    expect((error.data.recovery as { hint: string }).hint).toContain('nextCursorMark');
    const rendered = text(result);
    expect(rendered).toContain('HTTP 503');
    expect(rendered).toContain('nextCursorMark');
    expect(rendered).toContain('(reason invalid_cursor_mark · not retryable)');
    expect(rendered).not.toContain('search_unavailable');
    expect(sentPages()).toEqual(['garbage', 'garbage', 'garbage', 'garbage', '*']);
  });

  it('keeps search_unavailable for a cursor answered HTTP 503 when the first page fails too', async () => {
    answerPages(outage, outage);
    const result = await run({ query: 'CRISPR', cursor_mark: 'garbage' });

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data.reason).toBe('search_unavailable');
    expect(error.message).toContain('Status: 503');
    const rendered = text(result);
    expect(rendered).toContain('Status: 503');
    expect(rendered).toContain('(reason search_unavailable)');
    expect(rendered).toContain('biorxiv_list_recent');
    expect(sentPages()).toEqual(['garbage', 'garbage', 'garbage', 'garbage', '*']);
  });

  it('keeps search_unavailable for a first page answered HTTP 503, with no extra request', async () => {
    answerPages(outage, outage);
    const result = await run({ query: 'CRISPR' });
    expect(errorOf(result).data.reason).toBe('search_unavailable');
    expect(text(result)).toContain('(reason search_unavailable)');
    expect(sentPages()).toEqual(['*', '*', '*', '*']);
  });

  it('reports a cancellation during the first-page request as a cancellation on both surfaces', async () => {
    const caller = new AbortController();
    answerPages(outage, (request) => {
      caller.abort(new Error('cancelled by caller'));
      return new Promise((_resolve, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        request.signal.addEventListener('abort', () => reject(request.signal.reason));
      });
    });
    const result = await run({ query: 'CRISPR', cursor_mark: 'garbage' }, caller.signal);

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data?.reason).toBeUndefined();
    expect(error.message).toContain('was aborted');
    const rendered = text(result);
    expect(rendered).toContain('was aborted');
    expect(rendered).not.toContain('search_unavailable');
    expect(rendered).not.toContain('invalid_cursor_mark');
    expect(sentPages()).toHaveLength(5);
  });

  it('treats cursor_mark "*" as a first page — search_unavailable, never invalid_cursor_mark', async () => {
    answerWith(EMPTY_BODY);
    const result = await run({ query: 'crispr', cursor_mark: '*' });
    expect(errorOf(result).data.reason).toBe('search_unavailable');
  });

  it('leaves a valid cursor page unaffected when the empty body is intermittent (#43)', async () => {
    answerWith(EMPTY_BODY, EMPTY_BODY, POPULATED_BODY);
    const result = await run({ query: 'crispr', cursor_mark: 'AoIIQGlbEyg1NjAxNTg1MA==' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      queryEcho: { cursor_mark: 'AoIIQGlbEyg1NjAxNTg1MA==' },
    });
    expect(http.calls).toHaveLength(3);
  });

  // ── Cursor past the last match ─────────────────────────────────────────────

  /** Live shape of the page after the last match: `resultList` present and empty, real hitCount. */
  const PAST_END_BODY = { version: '6.9', hitCount: 2, resultList: { result: [] } };

  it('reports a cursor page past the last match as the end of the list on both surfaces', async () => {
    answerWith(PAST_END_BODY);
    const result = await run({ query: 'axolotl', cursor_mark: 'AoIIQFYMBSg1MDEzMjA1OA==' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ preprints: [], partial_results: false, totalCount: 2 });
    expect(structured.nextCursorMark).toBeUndefined();
    expect(structured.notice).toContain('all 2 matches were on earlier pages');
    const rendered = text(result);
    expect(rendered).toContain('all 2 matches were on earlier pages');
    expect(rendered).not.toContain('No preprints matched');
    expect(rendered).not.toContain('Try broader search terms');
    expect(http.calls).toHaveLength(1);
  });

  it('keeps the broaden-your-search notice for a first page with no matches', async () => {
    answerWith({ version: '6.9', hitCount: 0, resultList: { result: [] } });
    const result = await run({ query: 'xyzzyqqqnomatchterm123', cursor_mark: '*' });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.notice).toContain('No preprints matched');
    expect(text(result)).toContain('Try broader search terms');
  });

  it('reads a whitespace-only cursor_mark as the first page and does not echo it', async () => {
    answerWith(POPULATED_BODY);
    const result = await run({ query: 'axolotl', cursor_mark: '   ' });
    expect(result.isError).toBeFalsy();
    const echo = (result.structuredContent as { queryEcho: Record<string, unknown> }).queryEcho;
    expect(echo.cursor_mark).toBeUndefined();
    expect(text(result)).not.toContain('cursor=');
    const sent = new URL(http.calls[0]?.request.url ?? '').searchParams.get('cursorMark');
    expect(sent).toBe('*');
  });
});
