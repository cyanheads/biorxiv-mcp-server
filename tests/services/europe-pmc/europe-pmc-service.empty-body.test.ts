/**
 * @fileoverview EuropePmcService against EuropePMC's empty-body response — HTTP
 * 200 carrying only `{"version":"6.9"}`, no `resultList` and no `hitCount`. The
 * body arrives intermittently for valid first-page and cursor-page requests, and
 * on every attempt for a malformed `cursorMark`. Only `globalThis.fetch` is faked
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
    const result = await settle(service.search({ query: 'xyzzy' }, createMockContext()));
    expect(result).toEqual({ status: 'fulfilled', value: { hitCount: 0, results: [] } });
    expect(http.calls).toHaveLength(1);
  });

  it('returns a populated page after one request', async () => {
    answerWith(POPULATED_BODY);
    const result = await settle(service.search({ query: 'CRISPR' }, createMockContext()));
    expect(result.status).toBe('fulfilled');
    expect(result.status === 'fulfilled' && result.value.results).toHaveLength(1);
    expect(http.calls).toHaveLength(1);
  });

  // ── #47: intermittent empty body on a valid request ───────────────────────

  it('retries a single empty body on a first-page request and returns the real page', async () => {
    answerWith(EMPTY_BODY, POPULATED_BODY);
    const result = await settle(service.search({ query: 'CRISPR' }, createMockContext()));
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
    const result = await settle(service.search({ query: 'CRISPR' }, createMockContext()));
    expect(result).toMatchObject({ status: 'fulfilled', value: { hitCount: 11054 } });
    expect(http.calls).toHaveLength(4);
  });

  it('retries an intermittent empty body on a valid cursor page the same way', async () => {
    answerWith(EMPTY_BODY, EMPTY_BODY, POPULATED_BODY);
    const result = await settle(
      service.search(
        { query: 'CRISPR', cursorMark: 'AoIIQGldFig1NjAxNTg1MA==' },
        createMockContext(),
      ),
    );
    expect(result).toMatchObject({ status: 'fulfilled', value: { hitCount: 11054 } });
    expect(http.calls).toHaveLength(3);
  });

  it('raises ServiceUnavailable when a first-page empty body persists through every attempt', async () => {
    answerWith(EMPTY_BODY);
    const result = await settle(service.search({ query: 'CRISPR' }, createMockContext()));
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
      service.search({ query: 'CRISPR', cursorMark: '*' }, createMockContext()),
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
      service.search({ query: 'CRISPR', cursorMark: '' }, createMockContext()),
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
      service.search({ query: 'CRISPR', cursorMark: '  ' }, createMockContext()),
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
        createMockContext(),
      ),
    );
    expect(result.status).toBe('fulfilled');
    const sent = new URL(http.calls[0]?.request.url ?? '').searchParams.get('cursorMark');
    expect(sent).toBe('AoIIQGldFig1NjAxNTg1MA==');
  });

  // ── #43: malformed cursor — empty body on every attempt ───────────────────

  it('classifies a persisting empty body on a supplied cursor as invalid_cursor_mark', async () => {
    answerWith(EMPTY_BODY);
    const result = await settle(
      service.search({ query: 'crispr', cursorMark: 'garbage!!!' }, createMockContext()),
    );
    expect(result.status).toBe('rejected');
    const err = (result as PromiseRejectedResult).reason;
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_cursor_mark', cursor_mark: 'garbage!!!', retryAttempts: 4 },
    });
    expect(err.message).toContain('cursor_mark');
    expect(err.message).not.toContain('failed after');
    // The full retry budget is spent — a valid cursor also draws the empty
    // body intermittently, so a shorter ladder would misreport it as invalid.
    expect(http.calls).toHaveLength(4);
    const sent = new URL(http.calls[0]?.request.url ?? '').searchParams.get('cursorMark');
    expect(sent).toBe('garbage!!!');
  });
});
