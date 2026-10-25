/**
 * @fileoverview Tests for EuropePmcService — preprint keyword search, result
 * normalization, and HTTP 429 classification.
 * @module tests/services/europe-pmc/europe-pmc-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import {
  CALL_BUDGET_MS,
  type CallDeadline,
  findRateLimit,
  startCallDeadline,
} from '@/services/shared.js';
import { type FetchCall, hungOrigin, settle, slowOrigin } from '../../helpers/call-budget.js';
import { EUROPE_PMC_RATE_LIMIT_BODY, europePmcRateLimitError } from '../../helpers/rate-limit.js';

const mockFetch = vi.fn();

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
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    mailto: 'test@example.com',
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

/** The URL the mocked fetch was called with on its first call. */
function firstCalledUrl(): string {
  const url = (mockFetch.mock.calls[0] as string[] | undefined)?.[0];
  if (url === undefined) throw new Error('EuropePMC fetch was never called.');
  return url;
}

function makeResponse(body: unknown): Response {
  return {
    text: () => Promise.resolve(JSON.stringify(body)),
    ok: true,
    status: 200,
  } as unknown as Response;
}

/**
 * Make a fake response whose body is an HTML error page. `ok`/`status` are
 * cosmetic here: the real `fetchWithTimeout` throws on non-2xx before the
 * service reads the body, so a response that reaches `detectHtmlError` is by
 * definition a 2xx one carrying an HTML error page.
 */
function makeHtmlResponse(html = '<html><body>Service Unavailable</body></html>'): Response {
  return {
    text: () => Promise.resolve(html),
    ok: true,
    status: 200,
  } as unknown as Response;
}

/**
 * McpError shaped like the one `fetchWithTimeout` throws on a non-2xx response:
 * canonical `status`/`body`, the legacy `statusCode`/`responseBody` aliases, and
 * `retryAfter` when the origin sent the header. The service never sees a
 * `Response` for a non-2xx — it sees this rejection, so a fixture that resolved
 * a `{ status: 429 }` response instead would leave the branch under test unrun.
 */
function httpError(status: number, retryAfter?: string): McpError {
  const code = status === 429 ? JsonRpcErrorCode.RateLimited : JsonRpcErrorCode.ServiceUnavailable;
  return new McpError(code, `Fetch failed for EuropePMC. Status: ${status}`, {
    status,
    statusText: 'Too Many Requests',
    body: EUROPE_PMC_RATE_LIMIT_BODY,
    statusCode: status,
    responseBody: EUROPE_PMC_RATE_LIMIT_BODY,
    ...(retryAfter !== undefined && { retryAfter }),
    errorSource: 'FetchHttpError',
  });
}

const MOCK_CONFIG = {} as AppConfig;
const MOCK_STORAGE = {} as StorageService;

describe('EuropePmcService', () => {
  let service: EuropePmcService;

  beforeEach(() => {
    service = new EuropePmcService(MOCK_CONFIG, MOCK_STORAGE);
    mockFetch.mockReset();
    retry.impl = undefined;
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns normalized results from a search query', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        hitCount: 42,
        resultList: {
          result: [
            {
              doi: '10.1101/2024.01.15.575123',
              title: 'CRISPR gene editing study',
              authorString: 'Smith J, Jones A',
              firstPublicationDate: '2024-01-15',
            },
          ],
        },
      }),
    );

    const ctx = createMockContext();
    const { hitCount, results } = await service.search(
      { query: 'CRISPR' },
      startCallDeadline(),
      ctx,
    );
    expect(hitCount).toBe(42);
    expect(results).toHaveLength(1);
    expect(results[0]?.doi).toBe('10.1101/2024.01.15.575123');
    expect(results[0]?.title).toBe('CRISPR gene editing study');
    expect(results[0]?.authors).toBe('Smith J, Jones A');
  });

  it('maps authorString to authors and firstPublicationDate to publishedDate', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        hitCount: 1,
        resultList: {
          result: [
            {
              doi: '10.1101/2024.01.15.575123',
              authorString: 'Doe J',
              firstPublicationDate: '2024-01-15',
            },
          ],
        },
      }),
    );
    const ctx = createMockContext();
    const { results } = await service.search({ query: 'test' }, startCallDeadline(), ctx);
    expect(results[0]?.authors).toBe('Doe J');
    expect(results[0]?.publishedDate).toBe('2024-01-15');
    expect(results[0]).not.toHaveProperty('abstract');
  });

  it('requests the lite result type, which carries no abstract', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'CRISPR' }, startCallDeadline(), ctx);
    const params = new URL(firstCalledUrl()).searchParams;
    expect(params.get('resulttype')).toBe('lite');
    // EuropePMC ignores `fields`; asking lite for abstractText through it never worked.
    expect(params.has('fields')).toBe(false);
  });

  it('skips results without a DOI', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        hitCount: 1,
        resultList: {
          result: [
            { title: 'No DOI result' },
            { doi: '10.1101/2024.01.15.575123', title: 'Has DOI' },
          ],
        },
      }),
    );

    const ctx = createMockContext();
    const { results } = await service.search({ query: 'test' }, startCallDeadline(), ctx);
    expect(results).toHaveLength(1);
    expect(results[0]?.doi).toBe('10.1101/2024.01.15.575123');
  });

  it('returns empty array when resultList is empty', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    const { hitCount, results } = await service.search(
      { query: 'xyzzy' },
      startCallDeadline(),
      ctx,
    );
    expect(hitCount).toBe(0);
    expect(results).toHaveLength(0);
  });

  it('falls back to results.length when hitCount is absent', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        resultList: {
          result: [{ doi: '10.1101/2024.01.15.575123' }],
        },
      }),
    );
    const ctx = createMockContext();
    const { hitCount, results } = await service.search(
      { query: 'CRISPR' },
      startCallDeadline(),
      ctx,
    );
    // No hitCount in response — falls back to results.length
    expect(hitCount).toBe(1);
    expect(results).toHaveLength(1);
  });

  it('handles sparse upstream payload — absent optional fields stay absent', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        hitCount: 1,
        resultList: {
          result: [{ doi: '10.1101/2024.01.15.575123' }],
        },
      }),
    );
    const ctx = createMockContext();
    const { results } = await service.search({ query: 'CRISPR' }, startCallDeadline(), ctx);
    expect(results[0]?.title).toBeUndefined();
    expect(results[0]?.authors).toBeUndefined();
  });

  it('normalizes HTML markup out of the title', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        hitCount: 1,
        resultList: {
          result: [
            {
              doi: '10.1101/2024.01.15.575123',
              title: 'Synergistic CRISPR-Cas Antimicrobials in  <i>Staphylococcus aureus</i>',
              authorString: 'Smith J',
              firstPublicationDate: '2024-01-15',
            },
          ],
        },
      }),
    );
    const ctx = createMockContext();
    const { results } = await service.search({ query: 'CRISPR' }, startCallDeadline(), ctx);
    expect(results[0]?.title).toBe(
      'Synergistic CRISPR-Cas Antimicrobials in Staphylococcus aureus',
    );
    expect(results[0]?.title).not.toContain('<i>');
  });

  it('resolves Highwire placeholders in the title, leaving authors raw', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        hitCount: 1,
        resultList: {
          result: [
            {
              doi: '10.1101/2024.05.06.592824',
              title: 'Rad51 filaments at 2.35 [A] with {beta}-strand swaps',
              authorString: 'O`Toole P, Mu_ller M',
              firstPublicationDate: '2024-05-06',
            },
          ],
        },
      }),
    );
    const ctx = createMockContext();
    const { results } = await service.search({ query: 'Rad51' }, startCallDeadline(), ctx);
    // `[A]` is Å here, but single-letter brackets are also concentration notation.
    expect(results[0]?.title).toBe('Rad51 filaments at 2.35 [A] with β-strand swaps');
    expect(results[0]?.authors).toBe('O`Toole P, Mu_ller M');
  });

  // ── URL construction ────────────────────────────────────────────────────────

  it('appends PUBLISHER:bioRxiv filter when server=biorxiv', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'CRISPR', server: 'biorxiv' }, startCallDeadline(), ctx);
    const calledUrl = firstCalledUrl();
    expect(decodeURIComponent(calledUrl).replace(/\+/g, ' ')).toContain('PUBLISHER:bioRxiv');
  });

  it('appends PUBLISHER:medRxiv filter when server=medrxiv', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'COVID', server: 'medrxiv' }, startCallDeadline(), ctx);
    const calledUrl = firstCalledUrl();
    expect(decodeURIComponent(calledUrl).replace(/\+/g, ' ')).toContain('PUBLISHER:medRxiv');
  });

  it('appends both publisher OR filter when server=both', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'test', server: 'both' }, startCallDeadline(), ctx);
    const calledUrl = firstCalledUrl();
    const decoded = decodeURIComponent(calledUrl).replace(/\+/g, ' ');
    expect(decoded).toContain('PUBLISHER:bioRxiv');
    expect(decoded).toContain('PUBLISHER:medRxiv');
  });

  it('includes date range in query when dateFrom and dateTo are provided', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search(
      { query: 'test', dateFrom: '2024-01-01', dateTo: '2024-06-30' },
      startCallDeadline(),
      ctx,
    );
    const calledUrl = firstCalledUrl();
    // URLSearchParams encodes spaces as '+' — normalise before asserting
    const decoded = decodeURIComponent(calledUrl).replace(/\+/g, ' ');
    expect(decoded).toContain('FIRST_PDATE:[2024-01-01 TO 2024-06-30]');
  });

  it('uses default sentinel dates when only dateFrom is provided', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'test', dateFrom: '2024-01-01' }, startCallDeadline(), ctx);
    const calledUrl = firstCalledUrl();
    const decoded = decodeURIComponent(calledUrl).replace(/\+/g, ' ');
    expect(decoded).toContain('FIRST_PDATE:[2024-01-01 TO');
  });

  it('reads a blank dateFrom as absent, keeping the sentinel lower bound', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search(
      { query: 'test', dateFrom: '', dateTo: '2024-06-30' },
      startCallDeadline(),
      ctx,
    );
    const decoded = decodeURIComponent(firstCalledUrl()).replace(/\+/g, ' ');
    expect(decoded).toContain('FIRST_PDATE:[1900-01-01 TO 2024-06-30]');
  });

  it('reads a blank dateTo as absent, keeping the sentinel upper bound', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search(
      { query: 'test', dateFrom: '2024-01-01', dateTo: '' },
      startCallDeadline(),
      ctx,
    );
    const decoded = decodeURIComponent(firstCalledUrl()).replace(/\+/g, ' ');
    expect(decoded).toContain('FIRST_PDATE:[2024-01-01 TO 9999-12-31]');
  });

  it('caps pageSize at 100 even when limit exceeds 100', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'test', limit: 999 }, startCallDeadline(), ctx);
    const calledUrl = firstCalledUrl();
    expect(calledUrl).toContain('pageSize=100');
  });

  it('uses default pageSize of 25 when limit is omitted', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'test' }, startCallDeadline(), ctx);
    const calledUrl = firstCalledUrl();
    expect(calledUrl).toContain('pageSize=25');
  });

  // ── Author filter ─────────────────────────────────────────────────────────────

  it('maps author to an AUTH: field clause in the query', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'CRISPR', author: 'Jennifer Doudna' }, startCallDeadline(), ctx);
    const decoded = decodeURIComponent(firstCalledUrl()).replace(/\+/g, ' ');
    expect(decoded).toContain('CRISPR AND AUTH:"Jennifer Doudna"');
  });

  it('supports an author-only search when query is omitted', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ author: 'Doudna J' }, startCallDeadline(), ctx);
    const decoded = decodeURIComponent(firstCalledUrl()).replace(/\+/g, ' ');
    expect(decoded).toContain('AUTH:"Doudna J"');
    // No stray leading " AND " when there is no keyword query
    expect(decoded).not.toContain(' AND AUTH:"Doudna J"');
  });

  it('strips embedded double-quotes from the author to keep the AUTH phrase intact', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ author: 'Sm"ith' }, startCallDeadline(), ctx);
    const decoded = decodeURIComponent(firstCalledUrl()).replace(/\+/g, ' ');
    expect(decoded).toContain('AUTH:"Smith"');
  });

  // ── Cursor pagination ─────────────────────────────────────────────────────────

  it('sends cursorMark=* on the first page when no cursor is supplied', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'CRISPR' }, startCallDeadline(), ctx);
    const calledUrl = firstCalledUrl();
    expect(decodeURIComponent(calledUrl)).toContain('cursorMark=*');
  });

  it('threads a supplied cursorMark into the request URL', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'CRISPR', cursorMark: 'AoJ8y7Wd0S8' }, startCallDeadline(), ctx);
    const calledUrl = firstCalledUrl();
    expect(decodeURIComponent(calledUrl)).toContain('cursorMark=AoJ8y7Wd0S8');
  });

  it('returns nextCursorMark when the upstream response includes one', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        hitCount: 500,
        nextCursorMark: 'AoJnextpage',
        resultList: { result: [{ doi: '10.1101/2024.01.15.575123' }] },
      }),
    );
    const ctx = createMockContext();
    const result = await service.search({ query: 'CRISPR' }, startCallDeadline(), ctx);
    expect(result.nextCursorMark).toBe('AoJnextpage');
  });

  it('omits nextCursorMark on the last page when upstream drops the field', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        hitCount: 1,
        resultList: { result: [{ doi: '10.1101/2024.01.15.575123' }] },
      }),
    );
    const ctx = createMockContext();
    const result = await service.search({ query: 'CRISPR' }, startCallDeadline(), ctx);
    expect(result.nextCursorMark).toBeUndefined();
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  // A bare `.rejects.toThrow()` here would also pass on the JSON parse error an
  // absent guard produces, so both cases assert the classified code instead.
  it('throws serviceUnavailable when API returns HTML error page', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse());
    const ctx = createMockContext();
    const err = await service
      .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
      .catch((e: unknown) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).message).toContain('EuropePMC returned HTML instead of JSON');
  });

  it('throws serviceUnavailable when HTML starts with lowercase html tag', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse('<html><body>Rate limited</body></html>'));
    const ctx = createMockContext();
    const err = await service
      .search({ query: 'test' }, startCallDeadline(), ctx)
      .catch((e: unknown) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('propagates network errors from fetchWithTimeout', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    const ctx = createMockContext();
    await expect(service.search({ query: 'CRISPR' }, startCallDeadline(), ctx)).rejects.toThrow(
      'connection refused',
    );
  });

  // ── HTTP 429 classification ─────────────────────────────────────────────────

  describe('rate-limit classification', () => {
    it('classifies a 429 as rate_limited carrying the parsed Retry-After', async () => {
      mockFetch.mockRejectedValue(httpError(429, '45'));
      const ctx = createMockContext();
      const err = await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
      expect((err as McpError).data).toMatchObject({
        reason: 'rate_limited',
        retryable: true,
        retryAfter: 45,
      });
    });

    it('keeps the upstream 429 body out of the caller-visible payload', async () => {
      mockFetch.mockRejectedValue(httpError(429, '45'));
      const ctx = createMockContext();
      const err = await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e);

      const data = (err as McpError).data ?? {};
      expect(JSON.stringify(data)).not.toContain('429 Too Many Requests');
      expect(data).not.toHaveProperty('body');
      expect(data).not.toHaveProperty('responseBody');
      expect(data).not.toHaveProperty('statusCode');
      expect(data).not.toHaveProperty('status');
      expect((err as McpError).message).not.toContain('<html>');
    });

    it('passes 429 as an expected status so it logs at debug', async () => {
      mockFetch.mockRejectedValue(httpError(429, '45'));
      const ctx = createMockContext();
      await service.search({ query: 'CRISPR' }, startCallDeadline(), ctx).catch(() => undefined);

      const options = (mockFetch.mock.calls[0] as unknown[])[3] as { expectedStatuses?: number[] };
      expect(options.expectedStatuses).toEqual([429]);
    });

    it('reads an HTTP-date Retry-After as a wait in seconds', async () => {
      mockFetch.mockRejectedValue(httpError(429, new Date(Date.now() + 120_000).toUTCString()));
      const ctx = createMockContext();
      const err = await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e);
      const retryAfter = (err as McpError).data?.retryAfter as number;
      expect(retryAfter).toBeGreaterThan(110);
      expect(retryAfter).toBeLessThanOrEqual(120);
    });

    it('leaves retryAfter absent when the origin sent no Retry-After header', async () => {
      mockFetch.mockRejectedValue(httpError(429));
      const ctx = createMockContext();
      const err = await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
      expect((err as McpError).data?.retryAfter).toBeUndefined();
      expect((err as McpError).data?.reason).toBe('rate_limited');
    });

    it('treats Retry-After: 0 exactly like a 429 with no header', async () => {
      const ctx = createMockContext();
      mockFetch.mockRejectedValue(httpError(429, '0'));
      const zero = (await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e)) as McpError;
      mockFetch.mockRejectedValue(httpError(429));
      const none = (await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(zero.message).toBe(none.message);
      expect(zero.data).toEqual(none.data);
      expect(zero.data).not.toHaveProperty('retryAfter');
      expect(zero.message).not.toContain('0-second');
      expect(zero.data?.recovery).toMatchObject({
        hint: expect.stringContaining('a minute or two'),
      });
    });

    it('leaves retryAfter absent when the Retry-After header is unparseable', async () => {
      mockFetch.mockRejectedValue(httpError(429, 'soon'));
      const ctx = createMockContext();
      const err = await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e);
      expect((err as McpError).data?.reason).toBe('rate_limited');
      expect((err as McpError).data?.retryAfter).toBeUndefined();
    });

    it('names the wait in a recovery hint the caller can act on', async () => {
      mockFetch.mockRejectedValue(httpError(429, '45'));
      const ctx = createMockContext();
      const err = await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e);
      const hint = ((err as McpError).data?.recovery as { hint?: string } | undefined)?.hint ?? '';
      expect(hint).toContain('45 seconds');
      expect(hint).toContain('EuropePMC');
    });

    it('preserves the upstream rejection as cause for diagnosis', async () => {
      const upstream = httpError(429, '45');
      mockFetch.mockRejectedValue(upstream);
      const ctx = createMockContext();
      const err = await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e);
      expect((err as Error).cause).toBe(upstream);
    });

    it('leaves a non-429 upstream failure untouched for the framework to classify', async () => {
      const upstream = httpError(503);
      mockFetch.mockRejectedValue(upstream);
      const ctx = createMockContext();
      const err = await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e);
      expect(err).toBe(upstream);
    });

    it('throws a rejection findRateLimit recognizes — the seam the tool branches on', async () => {
      mockFetch.mockRejectedValue(httpError(429, '45'));
      const ctx = createMockContext();
      const err = await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e);
      expect(findRateLimit([err])).toEqual({ retryAfter: 45 });
    });

    it('throws the shape the shared tool-test fixture stands in for', async () => {
      // biorxiv_search_preprints' suite mocks this service away and drives
      // `europePmcRateLimitError()` instead. If the real throw and that fixture
      // drift apart, that suite keeps passing while the tool mis-branches in
      // production.
      mockFetch.mockRejectedValue(httpError(429, '45'));
      const ctx = createMockContext();
      const err = (await service
        .search({ query: 'CRISPR' }, startCallDeadline(), ctx)
        .catch((e: unknown) => e)) as McpError;
      const fixture = europePmcRateLimitError(45);
      const contractFields = (e: McpError) => ({
        code: e.code,
        reason: e.data?.reason,
        retryable: e.data?.retryable,
        retryAfter: e.data?.retryAfter,
      });
      expect(contractFields(err)).toEqual(contractFields(fixture));
    });
  });

  // ── Abstract lookup (resultType=core) ───────────────────────────────────────

  describe('getAbstracts', () => {
    const A = '10.1101/2024.01.15.575123';
    const B = '10.64898/2026.09.10.750574';

    function coreBody(records: { doi?: string; abstractText?: string }[]) {
      return { version: '6.9', hitCount: records.length, resultList: { result: records } };
    }

    it('sends one core query keyed by the DOIs, preprints only, with a page sized to them', async () => {
      mockFetch.mockResolvedValue(makeResponse(coreBody([])));
      const ctx = createMockContext();
      await service.getAbstracts([A, B], startCallDeadline(), ctx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const params = new URL(firstCalledUrl()).searchParams;
      expect(params.get('resultType')).toBe('core');
      expect(params.get('query')).toBe(`(DOI:"${A}" OR DOI:"${B}") AND SRC:PPR`);
      expect(params.get('pageSize')).toBe('2');
      expect(params.get('format')).toBe('json');
    });

    it('deduplicates DOIs case-insensitively and strips quotes that would end the phrase', async () => {
      mockFetch.mockResolvedValue(makeResponse(coreBody([])));
      const ctx = createMockContext();
      await service.getAbstracts([A, A.toUpperCase(), '10.5555/odd"doi'], startCallDeadline(), ctx);

      const params = new URL(firstCalledUrl()).searchParams;
      expect(params.get('query')).toBe(`(DOI:"${A}" OR DOI:"10.5555/odddoi") AND SRC:PPR`);
      expect(params.get('pageSize')).toBe('2');
    });

    it('returns normalized abstracts keyed by lowercase DOI, leaving DOIs without one absent', async () => {
      mockFetch.mockResolvedValue(
        makeResponse(
          coreBody([
            {
              doi: A.toUpperCase(),
              abstractText: 'AO_SCPLOWBSTRACTC_SCPLOWMultidrug-resistant pathogens pose a threat.',
            },
            { doi: B, abstractText: 'BackgroundFilaments form.\n\nResultsA [~]10 nm pitch.' },
            { doi: '10.1101/2024.01.15.000009' },
            { abstractText: 'No DOI on this record.' },
          ]),
        ),
      );
      const ctx = createMockContext();
      const abstracts = await service.getAbstracts(
        [A, B, '10.1101/2024.01.15.000009'],
        startCallDeadline(),
        ctx,
      );

      expect(Object.fromEntries(abstracts)).toEqual({
        [A]: 'Multidrug-resistant pathogens pose a threat.',
        [B]: 'Background: Filaments form. Results: A ∼10 nm pitch.',
      });
    });

    it('renders the <h4> headings core abstracts carry as "Heading: ", like a bioRxiv abstract', async () => {
      // Live core shape: EuropePMC marks structured-abstract headings up as <h4>.
      mockFetch.mockResolvedValue(
        makeResponse(
          coreBody([
            {
              doi: A,
              abstractText:
                '<h4>Background</h4>  Auditory responses are standardized. <h4>Methods</h4>  We built a <i>rule-based</i> framework (p<0.05).',
            },
          ]),
        ),
      );
      const ctx = createMockContext();
      const abstracts = await service.getAbstracts([A], startCallDeadline(), ctx);
      expect(abstracts.get(A)).toBe(
        'Background: Auditory responses are standardized. Methods: We built a rule-based framework (p<0.05).',
      );
    });

    it('keeps the first abstract when EuropePMC returns a DOI twice', async () => {
      mockFetch.mockResolvedValue(
        makeResponse(
          coreBody([
            { doi: A, abstractText: 'First.' },
            { doi: A, abstractText: 'Second.' },
          ]),
        ),
      );
      const ctx = createMockContext();
      const abstracts = await service.getAbstracts([A], startCallDeadline(), ctx);
      expect(abstracts.get(A)).toBe('First.');
    });

    it('throws ServiceUnavailable for a body with no result list rather than reading it as no abstracts', async () => {
      mockFetch.mockResolvedValue(makeResponse({ version: '6.9' }));
      const ctx = createMockContext();
      const err = await service
        .getAbstracts([A], startCallDeadline(), ctx)
        .catch((e: unknown) => e);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).data?.reason).toBe('empty_response_body');
    });

    it('throws ServiceUnavailable for an HTML error page', async () => {
      mockFetch.mockResolvedValue(makeHtmlResponse());
      const ctx = createMockContext();
      const err = await service
        .getAbstracts([A], startCallDeadline(), ctx)
        .catch((e: unknown) => e);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('classifies a 429 as rate_limited with the parsed Retry-After and no upstream body', async () => {
      mockFetch.mockRejectedValue(httpError(429, '45'));
      const ctx = createMockContext();
      const err = await service
        .getAbstracts([A], startCallDeadline(), ctx)
        .catch((e: unknown) => e);
      expect(findRateLimit([err])).toEqual({ retryAfter: 45 });
      expect(JSON.stringify((err as McpError).data)).not.toContain('429 Too Many Requests');
    });
  });

  // ── The call budget ─────────────────────────────────────────────────────────

  describe('call budget', () => {
    type Ctx = ReturnType<typeof createMockContext>;
    /** Every call EuropePmcService makes, by name. The deadline defaults to a fresh call budget. */
    const EPMC_CALLS = {
      search: (s: EuropePmcService, ctx: Ctx, deadline = startCallDeadline()) =>
        s.search({ query: 'crispr' }, deadline, ctx),
      getAbstracts: (s: EuropePmcService, ctx: Ctx, deadline = startCallDeadline()) =>
        s.getAbstracts(['10.1101/2024.01.15.575123'], deadline, ctx),
    } as const;
    const okBody = { version: '6.9', hitCount: 0, resultList: { result: [] } };

    it.each(Object.entries(EPMC_CALLS))(
      '%s bounds an attempt at 20 s while the budget leaves more, on the attempt signal',
      async (_name, call) => {
        const attempt = new AbortController();
        retry.impl = (fn) => fn({ signal: attempt.signal, remainingMs: Number.POSITIVE_INFINITY });
        mockFetch.mockResolvedValue(makeResponse(okBody));
        const ctx = createMockContext();
        await call(service, ctx);
        const [, timeoutMs, , options] = mockFetch.mock.calls[0] as FetchCall;
        expect(timeoutMs).toBe(20_000);
        expect(options.signal).toBe(attempt.signal);
        expect(options.signal).not.toBe(ctx.signal);
      },
    );

    it.each(Object.entries(EPMC_CALLS))(
      '%s bounds an attempt at what the budget has left once that is under 20 s',
      async (_name, call) => {
        retry.impl = (fn) => fn({ signal: new AbortController().signal, remainingMs: 7_000 });
        mockFetch.mockResolvedValue(makeResponse(okBody));
        await call(service, createMockContext());
        expect((mockFetch.mock.calls[0] as FetchCall)[1]).toBe(7_000);
      },
    );

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

      it.each(Object.entries(EPMC_CALLS))(
        '%s settles inside the 50 s call budget, under a client 60 s request timeout',
        async (_name, call) => {
          const deadline = startCallDeadline();
          const ctx = createMockContext();
          const { err, elapsedMs } = await settle(call(service, ctx, deadline));

          expect(err).toBeInstanceOf(McpError);
          expect(err.code).toBe(JsonRpcErrorCode.Timeout);
          expect(err.data?.reason).toBe('retry_deadline_exceeded');
          expect(elapsedMs).toBeLessThanOrEqual(CALL_BUDGET_MS);
          expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
          for (const [i, [, timeoutMs, , options]] of (
            mockFetch.mock.calls as FetchCall[]
          ).entries()) {
            expect(timeoutMs).toBeLessThanOrEqual(deadline - (origin.startedAt[i] as number));
            expect(options.signal).not.toBe(ctx.signal);
          }
        },
      );

      it.each(Object.entries(EPMC_CALLS))(
        '%s spends only what is left of a budget an earlier request already drew on',
        async (_name, call) => {
          const deadline = (Date.now() + 10_000) as CallDeadline;
          const { err, elapsedMs } = await settle(call(service, createMockContext(), deadline));
          expect(err.data?.reason).toBe('retry_deadline_exceeded');
          expect(elapsedMs).toBeLessThanOrEqual(10_000);
        },
      );

      it.each(Object.entries(EPMC_CALLS))(
        '%s keeps a caller cancellation a cancellation, never relabelled as the deadline',
        async (_name, call) => {
          const caller = new AbortController();
          setTimeout(() => caller.abort(), 10_000);
          const ctx = createMockContext({ signal: caller.signal });
          const { err, elapsedMs } = await settle(call(service, ctx, startCallDeadline()));
          expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
          expect(err.data?.reason).toBeUndefined();
          expect(elapsedMs).toBe(10_000);
        },
      );

      it.each(Object.entries(EPMC_CALLS))(
        '%s fails fast as rate_limited on a Retry-After longer than the budget leaves',
        async (_name, call) => {
          mockFetch.mockRejectedValue(httpError(429, '30'));
          const deadline = (Date.now() + 10_000) as CallDeadline;
          const { err, elapsedMs } = await settle(call(service, createMockContext(), deadline));
          expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
          expect(err.data).toMatchObject({ reason: 'rate_limited', retryAfter: 30 });
          expect(elapsedMs).toBe(0);
          expect(mockFetch).toHaveBeenCalledTimes(1);
        },
      );

      // Wiring only: retryWithinBudget's own tests table every unusable Retry-After
      // shape, and both calls run on it, so one call proves the origin's 429 reaches
      // the ladder in the shape it reads.
      it('backs off on a 429 with Retry-After: 0 as on one with no header, never re-sending at once', async () => {
        const startedAt: number[] = [];
        mockFetch.mockImplementation(() => {
          startedAt.push(Date.now());
          return Promise.reject(httpError(429, '0'));
        });
        const { err } = await settle(EPMC_CALLS.search(service, createMockContext()));

        // 300 ms base, ±25% jitter: waits of 225–375, 450–750, 900–1500 ms.
        const gaps = startedAt.slice(1).map((t, i) => t - (startedAt[i] as number));
        expect(gaps).toHaveLength(3);
        for (const [i, gap] of gaps.entries()) {
          expect(gap).toBeGreaterThanOrEqual(225 * 2 ** i);
          expect(gap).toBeLessThanOrEqual(375 * 2 ** i);
        }
        expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(err.message).toBe('EuropePMC is rate-limiting this host (HTTP 429).');
        expect(err.data).toEqual({
          reason: 'rate_limited',
          retryable: true,
          recovery: expect.any(Object),
        });
      });

      it.each(Object.entries(EPMC_CALLS))(
        '%s keeps a 429 the budget ran out after as rate_limited, never an expiry',
        async (_name, call) => {
          // Every attempt answers 429 with no Retry-After, 16.2 s late: the third
          // lands at 49.3–49.7 s, with less left than the 0.9–1.5 s backoff before a fourth.
          mockFetch.mockImplementation(
            () =>
              new Promise((_resolve, reject) => {
                setTimeout(() => reject(httpError(429)), 16_200);
              }),
          );
          const { err, elapsedMs } = await settle(call(service, createMockContext()));
          expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
          expect(err.data).toMatchObject({ reason: 'rate_limited', retryable: true });
          expect(err.message).toContain('EuropePMC is rate-limiting this host');
          expect(mockFetch).toHaveBeenCalledTimes(3);
          expect(elapsedMs).toBeLessThanOrEqual(CALL_BUDGET_MS);
        },
      );

      describe.each([
        [
          'no Retry-After',
          undefined,
          { reason: 'rate_limited', retryable: true },
          'EuropePMC is rate-limiting this host (HTTP 429).',
        ],
        [
          'a Retry-After',
          '2',
          { reason: 'rate_limited', retryable: true, retryAfter: 2 },
          'EuropePMC is rate-limiting this host (HTTP 429) and asked for a 2-second wait before the next request.',
        ],
      ])('against slow 429s with %s', (_label, retryAfter, data, message) => {
        it.each(Object.entries(EPMC_CALLS))(
          '%s stays rate_limited when the budget cuts a later attempt short',
          async (_name, call) => {
            // Every attempt answers 429 13.5 s in, inside the 20 s attempt timeout.
            // The fourth starts 42.1–46.5 s in and is still waiting at 50 s.
            mockFetch.mockImplementation(
              slowOrigin(13_500, () => httpError(429, retryAfter)).fetch,
            );
            const { err, elapsedMs } = await settle(call(service, createMockContext()));
            expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
            expect(err.data).toEqual({ ...data, recovery: expect.any(Object) });
            expect(err.message).toBe(message);
            expect(mockFetch).toHaveBeenCalledTimes(4);
            expect(elapsedMs).toBe(CALL_BUDGET_MS);
          },
        );
      });

      it.each(Object.entries(EPMC_CALLS))(
        '%s reports a budget already spent as the call running out of time, without a request',
        async (_name, call) => {
          const spent = Date.now() as CallDeadline;
          const { err, elapsedMs } = await settle(call(service, createMockContext(), spent));
          expect(err.code).toBe(JsonRpcErrorCode.Timeout);
          expect(err.data?.reason).toBe('retry_deadline_exceeded');
          expect(err.message).toContain("the call's 50 s time budget had run out");
          expect(err.message).not.toMatch(/\b0ms\b/);
          expect(mockFetch).not.toHaveBeenCalled();
          expect(elapsedMs).toBe(0);
        },
      );

      /** A populated page, and what each call parses it into. */
      const healthyBody = {
        version: '6.9',
        hitCount: 1,
        resultList: {
          result: [
            {
              doi: '10.1101/2024.01.15.575123',
              title: 'Healthy origin',
              abstractText: 'An abstract.',
            },
          ],
        },
      };
      const HEALTHY_RESULT: Record<keyof typeof EPMC_CALLS, unknown> = {
        search: {
          hitCount: 1,
          results: [{ doi: '10.1101/2024.01.15.575123', title: 'Healthy origin' }],
        },
        getAbstracts: new Map([['10.1101/2024.01.15.575123', 'An abstract.']]),
      };

      it.each(Object.entries(EPMC_CALLS))(
        '%s makes the same attempts and returns the same result against a healthy origin',
        async (name, call) => {
          mockFetch.mockReset().mockResolvedValue(makeResponse(healthyBody));
          const direct = await call(service, createMockContext());
          expect(direct).toEqual(HEALTHY_RESULT[name as keyof typeof EPMC_CALLS]);

          mockFetch
            .mockReset()
            .mockRejectedValueOnce(httpError(503))
            .mockResolvedValue(makeResponse(healthyBody));
          const { value, elapsedMs } = await settle(call(service, createMockContext()));
          expect(value).toEqual(direct);
          expect(mockFetch).toHaveBeenCalledTimes(2);
          // One 503, one 300 ms backoff (±25 % jitter), the full 20 s timeout each time.
          expect(elapsedMs).toBeLessThanOrEqual(375);
          for (const [, timeoutMs] of mockFetch.mock.calls as FetchCall[]) {
            expect(timeoutMs).toBe(20_000);
          }
        },
      );

      it.each([
        ['a cursor page', 'AoJbogus'],
        ['a first page', '*'],
      ])(
        'reports %s the budget cut short as an expiry, never as an empty body that outlasted the ladder',
        async (_label, cursorMark) => {
          // Every attempt answers the empty body a malformed cursor draws 16.2 s
          // in, inside its 20 s timeout: the third lands at 49.3–49.7 s, with
          // less left than the 0.9–1.5 s backoff before a fourth. Three empty
          // bodies are not the full ladder, so they establish nothing about the
          // cursor or EuropePMC.
          mockFetch.mockImplementation((...args: FetchCall) =>
            Promise.race([
              new Promise((resolve) =>
                setTimeout(() => resolve(makeResponse({ version: '6.9' })), 16_200),
              ),
              origin.fetch(...args),
            ]),
          );
          const { err, elapsedMs } = await settle(
            service.search(
              { query: 'crispr', cursorMark },
              startCallDeadline(),
              createMockContext(),
            ),
          );
          expect(err.code).toBe(JsonRpcErrorCode.Timeout);
          expect(err.data).toMatchObject({ reason: 'retry_deadline_exceeded', retryAttempts: 3 });
          expect(mockFetch).toHaveBeenCalledTimes(3);
          expect(elapsedMs).toBeLessThanOrEqual(CALL_BUDGET_MS);
        },
      );
    });
  });
});
