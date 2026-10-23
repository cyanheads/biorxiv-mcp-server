/**
 * @fileoverview EuropePmcService against EuropePMC's empty-body response — HTTP
 * 200 carrying only `{"version":"6.9"}`, no `resultList` and no `hitCount`. The
 * body arrives intermittently for valid first-page and cursor-page requests. A
 * malformed `cursorMark` draws it, or now HTTP 503, on every attempt, and is
 * told from an outage by one first-page request. Only `globalThis.fetch` is faked
 * here: the real `fetchWithTimeout` and the real `withRetry` run, so attempt
 * counts and the post-retry classification are the production ones. Fake timers
 * collapse the retry backoff without changing how many attempts are made.
 * @module tests/services/europe-pmc/europe-pmc-service.empty-body.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import { type CallDeadline, startCallDeadline } from '@/services/shared.js';

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

/** The exact body EuropePMC returns in both failure modes (captured live). */
const EMPTY_BODY = { version: '6.9' };

/** A populated first page, trimmed from a live capture of the same query. */
const POPULATED_BODY = {
  version: '6.9',
  hitCount: 11054,
  nextCursorMark: 'AoIIQGldFig1NjAxNTg1MA==',
  request: { queryString: 'CRISPR', cursorMark: '*', pageSize: 2 },
  resultList: {
    result: [
      {
        doi: '10.1101/2024.01.15.575123',
        title: 'CRISPR gene editing study',
        authorString: 'Smith J',
        firstPublicationDate: '2024-01-15',
      },
    ],
  },
};

/** A genuine zero-hit answer — `resultList` present and empty (captured live). */
const ZERO_HIT_BODY = {
  version: '6.9',
  hitCount: 0,
  request: { queryString: 'xyzzyqqqnomatchterm123', cursorMark: '*', pageSize: 5 },
  resultList: { result: [] },
};

const http = createFetchMock();

/** Answer successive EuropePMC requests with `bodies` in order; the last one repeats. */
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

/** One EuropePMC answer, built per request. */
type Answer = (request: Request) => Response | Promise<Response>;

const ok =
  (body: unknown): Answer =>
  () =>
    Response.json(body);

/** EuropePMC's outage answer — the same body for a malformed cursor (captured live). */
function outage(code: number): Response {
  return Response.json(
    { errCode: code, errMsg: 'Search service is temporarily unavailable. Please retry later.' },
    { status: code },
  );
}

const status =
  (code: number): Answer =>
  () =>
    outage(code);

const html: Answer = () =>
  new Response('<!DOCTYPE html><html><body>Bad Gateway</body></html>', {
    headers: { 'Content-Type': 'text/html' },
  });

const networkError: Answer = () => Promise.reject(new TypeError('fetch failed'));

/** Never answers; rejects once the request's signal aborts (timeout, deadline, or caller). */
const hangUntilAborted: Answer = (request) =>
  new Promise((_resolve, reject) => {
    if (request.signal.aborted) reject(request.signal.reason);
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });

/**
 * Route EuropePMC requests by page: `cursorPage` answers every request carrying
 * a cursor other than `*`, `firstPage` every `*` request — each in order, its
 * last answer repeating.
 */
function answerPages(cursorPage: Answer[], firstPage: Answer[] = []): void {
  const served = { cursor: 0, first: 0 };
  http.route({
    match: (request) => new URL(request.url).hostname === 'www.ebi.ac.uk',
    respond: (request) => {
      const isFirst = new URL(request.url).searchParams.get('cursorMark') === '*';
      const answers = isFirst ? firstPage : cursorPage;
      const n = isFirst ? served.first++ : served.cursor++;
      const answer = answers[Math.min(n, answers.length - 1)];
      if (!answer) throw new Error(`No ${isFirst ? 'first-page' : 'cursor-page'} answer routed`);
      return answer(request);
    },
  });
}

/** The `cursorMark` of every request sent, in order. */
function sentPages(): (string | null)[] {
  return http.calls.map((call) => new URL(call.request.url).searchParams.get('cursorMark'));
}

/** Run a search to settlement while fake timers fast-forward the retry backoff. */
async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const settled = Promise.allSettled([promise]);
  await vi.runAllTimersAsync();
  const [result] = await settled;
  return result as PromiseSettledResult<T>;
}

describe('EuropePmcService — empty-body responses', () => {
  let service: EuropePmcService;

  beforeEach(() => {
    vi.useFakeTimers();
    http.reset();
    http.install();
    service = new EuropePmcService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  // ── Characterization: shapes the fix must leave alone ─────────────────────

  it('returns a genuine zero-hit page after one request', async () => {
    answerWith(ZERO_HIT_BODY);
    const result = await settle(
      service.search({ query: 'xyzzy' }, startCallDeadline(), createMockContext()),
    );
    expect(result).toEqual({ status: 'fulfilled', value: { hitCount: 0, results: [] } });
    expect(http.calls).toHaveLength(1);
  });

  it('returns a populated page after one request', async () => {
    answerWith(POPULATED_BODY);
    const result = await settle(
      service.search({ query: 'CRISPR' }, startCallDeadline(), createMockContext()),
    );
    expect(result.status).toBe('fulfilled');
    expect(result.status === 'fulfilled' && result.value.results).toHaveLength(1);
    expect(http.calls).toHaveLength(1);
  });

  // ── #47: intermittent empty body on a valid request ───────────────────────

  it('retries a single empty body on a first-page request and returns the real page', async () => {
    answerWith(EMPTY_BODY, POPULATED_BODY);
    const result = await settle(
      service.search({ query: 'CRISPR' }, startCallDeadline(), createMockContext()),
    );
    expect(result).toMatchObject({
      status: 'fulfilled',
      value: { hitCount: 11054, nextCursorMark: 'AoIIQGldFig1NjAxNTg1MA==' },
    });
    expect(result.status === 'fulfilled' && result.value.results[0]?.doi).toBe(
      '10.1101/2024.01.15.575123',
    );
    expect(http.calls).toHaveLength(2);
  });

  it('keeps retrying through three empty bodies and succeeds on the last attempt', async () => {
    answerWith(EMPTY_BODY, EMPTY_BODY, EMPTY_BODY, POPULATED_BODY);
    const result = await settle(
      service.search({ query: 'CRISPR' }, startCallDeadline(), createMockContext()),
    );
    expect(result).toMatchObject({ status: 'fulfilled', value: { hitCount: 11054 } });
    expect(http.calls).toHaveLength(4);
  });

  it('retries an intermittent empty body on a valid cursor page the same way', async () => {
    answerWith(EMPTY_BODY, EMPTY_BODY, POPULATED_BODY);
    const result = await settle(
      service.search(
        { query: 'CRISPR', cursorMark: 'AoIIQGldFig1NjAxNTg1MA==' },
        startCallDeadline(),
        createMockContext(),
      ),
    );
    expect(result).toMatchObject({ status: 'fulfilled', value: { hitCount: 11054 } });
    expect(http.calls).toHaveLength(3);
  });

  it('raises ServiceUnavailable when a first-page empty body persists through every attempt', async () => {
    answerWith(EMPTY_BODY);
    const result = await settle(
      service.search({ query: 'CRISPR' }, startCallDeadline(), createMockContext()),
    );
    expect(result.status).toBe('rejected');
    const err = (result as PromiseRejectedResult).reason;
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'empty_response_body', retryAttempts: 4 },
    });
    expect(err.message).toContain('no result list');
    // The service states the attempt count itself — the framework's suffix
    // would otherwise leak into the tool's caller-facing message.
    expect(err.message).not.toContain('failed after');
    expect(http.calls).toHaveLength(4);
  });

  it('treats an explicit "*" cursor as a first page, not a bad cursor', async () => {
    answerWith(EMPTY_BODY);
    const result = await settle(
      service.search(
        { query: 'CRISPR', cursorMark: '*' },
        startCallDeadline(),
        createMockContext(),
      ),
    );
    const err = (result as PromiseRejectedResult).reason;
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'empty_response_body' },
    });
    expect(http.calls).toHaveLength(4);
  });

  it('treats a blank cursor from a form client as a first page', async () => {
    answerWith(EMPTY_BODY);
    const result = await settle(
      service.search({ query: 'CRISPR', cursorMark: '' }, startCallDeadline(), createMockContext()),
    );
    expect((result as PromiseRejectedResult).reason).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'empty_response_body' },
    });
    const sent = new URL(http.calls[0]?.request.url ?? '').searchParams.get('cursorMark');
    expect(sent).toBe('*');
  });

  it('treats a whitespace-only cursor as a first page, never invalid_cursor_mark', async () => {
    answerWith(EMPTY_BODY);
    const result = await settle(
      service.search(
        { query: 'CRISPR', cursorMark: '  ' },
        startCallDeadline(),
        createMockContext(),
      ),
    );
    expect((result as PromiseRejectedResult).reason).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'empty_response_body' },
    });
    const sent = new URL(http.calls[0]?.request.url ?? '').searchParams.get('cursorMark');
    expect(sent).toBe('*');
  });

  it('sends a pasted cursor without the whitespace around it', async () => {
    answerWith(POPULATED_BODY);
    const result = await settle(
      service.search(
        { query: 'CRISPR', cursorMark: ' AoIIQGldFig1NjAxNTg1MA==\n' },
        startCallDeadline(),
        createMockContext(),
      ),
    );
    expect(result.status).toBe('fulfilled');
    const sent = new URL(http.calls[0]?.request.url ?? '').searchParams.get('cursorMark');
    expect(sent).toBe('AoIIQGldFig1NjAxNTg1MA==');
  });

  // ── #43: malformed cursor — empty body on every attempt ───────────────────

  it('classifies a persisting empty body on a supplied cursor as invalid_cursor_mark', async () => {
    answerPages([ok(EMPTY_BODY)], [ok(POPULATED_BODY)]);
    const result = await settle(
      service.search(
        { query: 'crispr', cursorMark: 'garbage!!!' },
        startCallDeadline(),
        createMockContext(),
      ),
    );
    expect(result.status).toBe('rejected');
    const err = (result as PromiseRejectedResult).reason;
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_cursor_mark', cursor_mark: 'garbage!!!', retryAttempts: 4 },
    });
    expect(err.message).toContain('cursor_mark');
    expect(err.message).toContain('no result list');
    expect(err.message).not.toContain('failed after');
    // The full retry budget is spent — a valid cursor also draws the empty
    // body intermittently, so a shorter ladder would misreport it as invalid —
    // then one first-page request shows the query itself answers.
    expect(sentPages()).toEqual(['garbage!!!', 'garbage!!!', 'garbage!!!', 'garbage!!!', '*']);
  });

  it('raises the empty-body ServiceUnavailable when the first page of the same query fails too', async () => {
    answerPages([ok(EMPTY_BODY)], [ok(EMPTY_BODY)]);
    const result = await settle(
      service.search(
        { query: 'crispr', cursorMark: 'garbage!!!' },
        startCallDeadline(),
        createMockContext(),
      ),
    );
    const err = (result as PromiseRejectedResult).reason;
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'empty_response_body', retryAttempts: 4 },
    });
    expect(err.message).not.toContain('failed after');
    expect(sentPages()).toEqual(['garbage!!!', 'garbage!!!', 'garbage!!!', 'garbage!!!', '*']);
  });

  // ── #72: malformed cursor — HTTP 503 on every attempt ─────────────────────

  describe('a cursor page answered HTTP 503 on every attempt', () => {
    it('raises invalid_cursor_mark when the first page of the same query answers', async () => {
      answerPages([status(503)], [ok(POPULATED_BODY)]);
      const result = await settle(
        service.search(
          { query: 'crispr', author: 'Doudna', server: 'biorxiv', cursorMark: 'garbage' },
          startCallDeadline(),
          createMockContext(),
        ),
      );
      const err = (result as PromiseRejectedResult).reason;
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_cursor_mark', cursor_mark: 'garbage', retryAttempts: 4 },
      });
      expect(err.message).toContain('cursor_mark');
      expect(err.message).toContain('HTTP 503');
      expect(err.message).not.toContain('failed after');
      expect(sentPages()).toEqual(['garbage', 'garbage', 'garbage', 'garbage', '*']);

      // The extra request is the same query, one row, at the first page.
      const [cursorRequest, firstPageRequest] = [http.calls[0], http.calls[4]].map(
        (call) => new URL(call?.request.url ?? ''),
      );
      expect(firstPageRequest?.searchParams.get('pageSize')).toBe('1');
      expect(firstPageRequest?.searchParams.get('query')).toBe(
        cursorRequest?.searchParams.get('query'),
      );
      expect(firstPageRequest?.searchParams.get('filter')).toBe('source:PPR');
      expect(firstPageRequest?.searchParams.get('resulttype')).toBe('lite');
    });

    it.each([
      ['HTTP 503', status(503)],
      ['HTTP 500', status(500)],
      ['the empty body', ok(EMPTY_BODY)],
      ['HTTP 429', status(429)],
      ['an HTML error page', html],
      ['a network error', networkError],
    ])(
      "keeps the cursor page's HTTP 503 when the first page answers %s",
      async (_label, firstPage) => {
        answerPages([status(503)], [firstPage]);
        const result = await settle(
          service.search(
            { query: 'crispr', cursorMark: 'garbage' },
            startCallDeadline(),
            createMockContext(),
          ),
        );
        const err = (result as PromiseRejectedResult).reason;
        expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.data).toMatchObject({ status: 503, retryAttempts: 4 });
        expect(err.data.reason).not.toBe('invalid_cursor_mark');
        // One unretried request — never a second ladder against an origin in outage.
        expect(sentPages()).toEqual(['garbage', 'garbage', 'garbage', 'garbage', '*']);
      },
    );

    it('pages normally when an issued token draws one transient 503', async () => {
      answerPages([status(503), ok(POPULATED_BODY)]);
      const result = await settle(
        service.search(
          { query: 'crispr', cursorMark: 'AoIIQGldFig1NjAxNTg1MA==' },
          startCallDeadline(),
          createMockContext(),
        ),
      );
      expect(result).toMatchObject({ status: 'fulfilled', value: { hitCount: 11054 } });
      expect(sentPages()).toEqual(['AoIIQGldFig1NjAxNTg1MA==', 'AoIIQGldFig1NjAxNTg1MA==']);
    });

    it('skips the first-page request when no budget is left after the ladder', async () => {
      const deadline = (Date.now() + 10_000) as CallDeadline;
      let cursorCalls = 0;
      answerPages(
        [
          () => {
            // The fourth attempt lands as the budget runs out: the ladder is
            // exhausted, not cut short, and nothing is left for another request.
            if (++cursorCalls === 4) vi.setSystemTime(deadline);
            return outage(503);
          },
        ],
        [ok(POPULATED_BODY)],
      );
      const result = await settle(
        service.search({ query: 'crispr', cursorMark: 'garbage' }, deadline, createMockContext()),
      );
      const err = (result as PromiseRejectedResult).reason;
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ status: 503, retryAttempts: 4 });
      expect(sentPages()).toEqual(['garbage', 'garbage', 'garbage', 'garbage']);
    });

    it('gives the first-page request at most 20 s', async () => {
      answerPages([status(503)], [hangUntilAborted]);
      const startedAt = Date.now();
      const result = await settle(
        service.search(
          { query: 'crispr', cursorMark: 'garbage' },
          startCallDeadline(),
          createMockContext(),
        ),
      );
      const err = (result as PromiseRejectedResult).reason;
      expect(err.data).toMatchObject({ status: 503, retryAttempts: 4 });
      // Three backoffs of 300/600/1200 ms (±25 %), then the 20 s cap.
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(20_000 + 1575);
      expect(elapsedMs).toBeLessThanOrEqual(20_000 + 2625);
      expect(sentPages()).toHaveLength(5);
    });

    it('gives the first-page request only what is left of the call budget when that is less', async () => {
      answerPages([status(503)], [hangUntilAborted]);
      const deadline = (Date.now() + 8_000) as CallDeadline;
      const result = await settle(
        service.search({ query: 'crispr', cursorMark: 'garbage' }, deadline, createMockContext()),
      );
      const err = (result as PromiseRejectedResult).reason;
      expect(err.data).toMatchObject({ status: 503, retryAttempts: 4 });
      expect(Date.now()).toBe(deadline);
      expect(sentPages()).toHaveLength(5);
    });

    it('keeps a caller cancellation during the first-page request a cancellation', async () => {
      const caller = new AbortController();
      answerPages(
        [status(503)],
        [
          (request) => {
            caller.abort(new Error('cancelled by caller'));
            return hangUntilAborted(request);
          },
        ],
      );
      const result = await settle(
        service.search(
          { query: 'crispr', cursorMark: 'garbage' },
          startCallDeadline(),
          createMockContext({ signal: caller.signal }),
        ),
      );
      const err = (result as PromiseRejectedResult).reason;
      expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
      // `fetchWithTimeout`'s cancellation, untouched — not the ladder's 503.
      expect(err.message).toContain('was aborted');
      expect(err.data?.status).toBeUndefined();
      expect(err.data?.reason).toBeUndefined();
      expect(sentPages()).toHaveLength(5);
    });
  });

  // ── Failures that never send the first-page request ───────────────────────

  it.each([
    ['no cursor', undefined],
    ['"*"', '*'],
    ['a blank cursor', '  '],
  ])(
    'a first page with %s answered HTTP 503 on every attempt stays a 503 after 4 requests',
    async (_label, cursorMark) => {
      answerPages([status(503)], [status(503)]);
      const result = await settle(
        service.search({ query: 'crispr', cursorMark }, startCallDeadline(), createMockContext()),
      );
      const err = (result as PromiseRejectedResult).reason;
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ status: 503, retryAttempts: 4 });
      expect(sentPages()).toEqual(['*', '*', '*', '*']);
    },
  );

  it.each([
    ['HTTP 500', status(500), JsonRpcErrorCode.ServiceUnavailable],
    ['HTTP 502', status(502), JsonRpcErrorCode.ServiceUnavailable],
    ['a network error', networkError, JsonRpcErrorCode.ServiceUnavailable],
    ['HTTP 429', status(429), JsonRpcErrorCode.RateLimited],
  ])(
    'a cursor page failing with %s on every attempt never sends the first-page request',
    async (_label, answer, code) => {
      answerPages([answer], [ok(POPULATED_BODY)]);
      const result = await settle(
        service.search(
          { query: 'crispr', cursorMark: 'garbage' },
          startCallDeadline(),
          createMockContext(),
        ),
      );
      const err = (result as PromiseRejectedResult).reason;
      expect(err.code).toBe(code);
      expect(err.data?.reason).not.toBe('invalid_cursor_mark');
      expect(sentPages()).toEqual(['garbage', 'garbage', 'garbage', 'garbage']);
    },
  );

  it.each([
    ['500, 500, 500, 503', [status(500), status(500), status(500), status(503)]],
    ['503, 500, 503, 503', [status(503), status(500), status(503), status(503)]],
    ['503, 503, 503, then a network error', [status(503), status(503), status(503), networkError]],
  ])(
    'a cursor-page ladder of %s keeps its own failure and never sends the first-page request',
    async (_label, ladder) => {
      answerPages(ladder, [ok(POPULATED_BODY)]);
      const result = await settle(
        service.search(
          { query: 'crispr', cursorMark: 'garbage' },
          startCallDeadline(),
          createMockContext(),
        ),
      );
      const err = (result as PromiseRejectedResult).reason;
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data?.reason).not.toBe('invalid_cursor_mark');
      expect(err.data?.retryAttempts).toBe(4);
      expect(err.message).not.toContain('did not recognize');
      expect(sentPages()).toEqual(['garbage', 'garbage', 'garbage', 'garbage']);
    },
  );

  it('a ladder of 500s ending on a 503 reports that 503, not invalid_cursor_mark', async () => {
    answerPages([status(500), status(500), status(500), status(503)], [ok(POPULATED_BODY)]);
    const result = await settle(
      service.search(
        { query: 'crispr', cursorMark: 'garbage' },
        startCallDeadline(),
        createMockContext(),
      ),
    );
    const err = (result as PromiseRejectedResult).reason;
    expect(err.data).toMatchObject({ status: 503, retryAttempts: 4 });
  });

  it('names both answers when every attempt failed token-shaped but not alike', async () => {
    answerPages([ok(EMPTY_BODY), status(503)], [ok(POPULATED_BODY)]);
    const result = await settle(
      service.search(
        { query: 'crispr', cursorMark: 'garbage' },
        startCallDeadline(),
        createMockContext(),
      ),
    );
    const err = (result as PromiseRejectedResult).reason;
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_cursor_mark', cursor_mark: 'garbage', retryAttempts: 4 },
    });
    expect(err.message).toContain(
      '4 consecutive attempts came back with no result list or failed with HTTP 503',
    );
    expect(sentPages()).toEqual(['garbage', 'garbage', 'garbage', 'garbage', '*']);
  });

  it.each([
    ['HTTP 503', status(503)],
    ['the empty body', ok(EMPTY_BODY)],
  ])(
    'a cursor-page ladder the budget cuts short on %s stays an expiry, with no first-page request',
    async (_label, answer) => {
      answerPages([answer], [ok(POPULATED_BODY)]);
      // Backoffs of 300 and 600 ms (±25 %) fit in 1.5 s; the third, 900–1500 ms, does not.
      const deadline = (Date.now() + 1_500) as CallDeadline;
      const result = await settle(
        service.search({ query: 'crispr', cursorMark: 'garbage' }, deadline, createMockContext()),
      );
      const err = (result as PromiseRejectedResult).reason;
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data).toMatchObject({ reason: 'retry_deadline_exceeded', retryAttempts: 3 });
      expect(sentPages()).toEqual(['garbage', 'garbage', 'garbage']);
    },
  );
});
