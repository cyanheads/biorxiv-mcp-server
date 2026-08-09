/**
 * @fileoverview Tests for EuropePmcService — preprint keyword search, result
 * normalization, and HTTP 429 classification.
 * @module tests/services/europe-pmc/europe-pmc-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import { findRateLimit } from '@/services/shared.js';
import { EUROPE_PMC_RATE_LIMIT_BODY, europePmcRateLimitError } from '../../helpers/rate-limit.js';

const mockFetch = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetch(...args),
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    mailto: 'test@example.com',
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

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
              abstractText: 'We studied CRISPR applications.',
            },
          ],
        },
      }),
    );

    const ctx = createMockContext();
    const { hitCount, results } = await service.search({ query: 'CRISPR' }, ctx);
    expect(hitCount).toBe(42);
    expect(results).toHaveLength(1);
    expect(results[0]?.doi).toBe('10.1101/2024.01.15.575123');
    expect(results[0]?.title).toBe('CRISPR gene editing study');
    expect(results[0]?.authors).toBe('Smith J, Jones A');
  });

  it('maps authorString to authors and abstractText to abstract', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        hitCount: 1,
        resultList: {
          result: [
            {
              doi: '10.1101/2024.01.15.575123',
              authorString: 'Doe J',
              abstractText: 'Abstract content.',
              firstPublicationDate: '2024-01-15',
            },
          ],
        },
      }),
    );
    const ctx = createMockContext();
    const { results } = await service.search({ query: 'test' }, ctx);
    expect(results[0]?.authors).toBe('Doe J');
    expect(results[0]?.abstract).toBe('Abstract content.');
    expect(results[0]?.publishedDate).toBe('2024-01-15');
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
    const { results } = await service.search({ query: 'test' }, ctx);
    expect(results).toHaveLength(1);
    expect(results[0]?.doi).toBe('10.1101/2024.01.15.575123');
  });

  it('returns empty array when resultList is empty', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    const { hitCount, results } = await service.search({ query: 'xyzzy' }, ctx);
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
    const { hitCount, results } = await service.search({ query: 'CRISPR' }, ctx);
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
    const { results } = await service.search({ query: 'CRISPR' }, ctx);
    expect(results[0]?.title).toBeUndefined();
    expect(results[0]?.authors).toBeUndefined();
    expect(results[0]?.abstract).toBeUndefined();
  });

  it('normalizes HTML and sentinel markup out of title and abstract', async () => {
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
              abstractText: 'AO_SCPLOWBSTRACTC_SCPLOWMultidrug-resistant pathogens pose a threat.',
            },
          ],
        },
      }),
    );
    const ctx = createMockContext();
    const { results } = await service.search({ query: 'CRISPR' }, ctx);
    expect(results[0]?.title).toBe(
      'Synergistic CRISPR-Cas Antimicrobials in Staphylococcus aureus',
    );
    expect(results[0]?.abstract).toBe('Multidrug-resistant pathogens pose a threat.');
    expect(results[0]?.title).not.toContain('<i>');
  });

  // ── URL construction ────────────────────────────────────────────────────────

  it('appends PUBLISHER:bioRxiv filter when server=biorxiv', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'CRISPR', server: 'biorxiv' }, ctx);
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(decodeURIComponent(calledUrl).replace(/\+/g, ' ')).toContain('PUBLISHER:bioRxiv');
  });

  it('appends PUBLISHER:medRxiv filter when server=medrxiv', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'COVID', server: 'medrxiv' }, ctx);
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(decodeURIComponent(calledUrl).replace(/\+/g, ' ')).toContain('PUBLISHER:medRxiv');
  });

  it('appends both publisher OR filter when server=both', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'test', server: 'both' }, ctx);
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    const decoded = decodeURIComponent(calledUrl).replace(/\+/g, ' ');
    expect(decoded).toContain('PUBLISHER:bioRxiv');
    expect(decoded).toContain('PUBLISHER:medRxiv');
  });

  it('includes date range in query when dateFrom and dateTo are provided', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'test', dateFrom: '2024-01-01', dateTo: '2024-06-30' }, ctx);
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    // URLSearchParams encodes spaces as '+' — normalise before asserting
    const decoded = decodeURIComponent(calledUrl).replace(/\+/g, ' ');
    expect(decoded).toContain('FIRST_PDATE:[2024-01-01 TO 2024-06-30]');
  });

  it('uses default sentinel dates when only dateFrom is provided', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'test', dateFrom: '2024-01-01' }, ctx);
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    const decoded = decodeURIComponent(calledUrl).replace(/\+/g, ' ');
    expect(decoded).toContain('FIRST_PDATE:[2024-01-01 TO');
  });

  it('caps pageSize at 100 even when limit exceeds 100', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'test', limit: 999 }, ctx);
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('pageSize=100');
  });

  it('uses default pageSize of 25 when limit is omitted', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'test' }, ctx);
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('pageSize=25');
  });

  // ── Author filter ─────────────────────────────────────────────────────────────

  it('maps author to an AUTH: field clause in the query', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'CRISPR', author: 'Jennifer Doudna' }, ctx);
    const decoded = decodeURIComponent((mockFetch.mock.calls[0] as string[])[0]).replace(
      /\+/g,
      ' ',
    );
    expect(decoded).toContain('CRISPR AND AUTH:"Jennifer Doudna"');
  });

  it('supports an author-only search when query is omitted', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ author: 'Doudna J' }, ctx);
    const decoded = decodeURIComponent((mockFetch.mock.calls[0] as string[])[0]).replace(
      /\+/g,
      ' ',
    );
    expect(decoded).toContain('AUTH:"Doudna J"');
    // No stray leading " AND " when there is no keyword query
    expect(decoded).not.toContain(' AND AUTH:"Doudna J"');
  });

  it('strips embedded double-quotes from the author to keep the AUTH phrase intact', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ author: 'Sm"ith' }, ctx);
    const decoded = decodeURIComponent((mockFetch.mock.calls[0] as string[])[0]).replace(
      /\+/g,
      ' ',
    );
    expect(decoded).toContain('AUTH:"Smith"');
  });

  // ── Cursor pagination ─────────────────────────────────────────────────────────

  it('sends cursorMark=* on the first page when no cursor is supplied', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'CRISPR' }, ctx);
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(decodeURIComponent(calledUrl)).toContain('cursorMark=*');
  });

  it('threads a supplied cursorMark into the request URL', async () => {
    mockFetch.mockResolvedValue(makeResponse({ hitCount: 0, resultList: { result: [] } }));
    const ctx = createMockContext();
    await service.search({ query: 'CRISPR', cursorMark: 'AoJ8y7Wd0S8' }, ctx);
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
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
    const result = await service.search({ query: 'CRISPR' }, ctx);
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
    const result = await service.search({ query: 'CRISPR' }, ctx);
    expect(result.nextCursorMark).toBeUndefined();
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  // A bare `.rejects.toThrow()` here would also pass on the JSON parse error an
  // absent guard produces, so both cases assert the classified code instead.
  it('throws serviceUnavailable when API returns HTML error page', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse());
    const ctx = createMockContext();
    const err = await service.search({ query: 'CRISPR' }, ctx).catch((e: unknown) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).message).toContain('EuropePMC returned HTML instead of JSON');
  });

  it('throws serviceUnavailable when HTML starts with lowercase html tag', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse('<html><body>Rate limited</body></html>'));
    const ctx = createMockContext();
    const err = await service.search({ query: 'test' }, ctx).catch((e: unknown) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('propagates network errors from fetchWithTimeout', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    const ctx = createMockContext();
    await expect(service.search({ query: 'CRISPR' }, ctx)).rejects.toThrow('connection refused');
  });

  // ── HTTP 429 classification ─────────────────────────────────────────────────

  describe('rate-limit classification', () => {
    it('classifies a 429 as rate_limited carrying the parsed Retry-After', async () => {
      mockFetch.mockRejectedValue(httpError(429, '45'));
      const ctx = createMockContext();
      const err = await service.search({ query: 'CRISPR' }, ctx).catch((e: unknown) => e);

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
      const err = await service.search({ query: 'CRISPR' }, ctx).catch((e: unknown) => e);

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
      await service.search({ query: 'CRISPR' }, ctx).catch(() => undefined);

      const options = (mockFetch.mock.calls[0] as unknown[])[3] as { expectedStatuses?: number[] };
      expect(options.expectedStatuses).toEqual([429]);
    });

    it('reads an HTTP-date Retry-After as a wait in seconds', async () => {
      mockFetch.mockRejectedValue(httpError(429, new Date(Date.now() + 120_000).toUTCString()));
      const ctx = createMockContext();
      const err = await service.search({ query: 'CRISPR' }, ctx).catch((e: unknown) => e);
      const retryAfter = (err as McpError).data?.retryAfter as number;
      expect(retryAfter).toBeGreaterThan(110);
      expect(retryAfter).toBeLessThanOrEqual(120);
    });

    it('leaves retryAfter absent when the origin sent no Retry-After header', async () => {
      mockFetch.mockRejectedValue(httpError(429));
      const ctx = createMockContext();
      const err = await service.search({ query: 'CRISPR' }, ctx).catch((e: unknown) => e);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
      expect((err as McpError).data?.retryAfter).toBeUndefined();
      expect((err as McpError).data?.reason).toBe('rate_limited');
    });

    it('leaves retryAfter absent when the Retry-After header is unparseable', async () => {
      mockFetch.mockRejectedValue(httpError(429, 'soon'));
      const ctx = createMockContext();
      const err = await service.search({ query: 'CRISPR' }, ctx).catch((e: unknown) => e);
      expect((err as McpError).data?.reason).toBe('rate_limited');
      expect((err as McpError).data?.retryAfter).toBeUndefined();
    });

    it('names the wait in a recovery hint the caller can act on', async () => {
      mockFetch.mockRejectedValue(httpError(429, '45'));
      const ctx = createMockContext();
      const err = await service.search({ query: 'CRISPR' }, ctx).catch((e: unknown) => e);
      const hint = ((err as McpError).data?.recovery as { hint?: string } | undefined)?.hint ?? '';
      expect(hint).toContain('45 seconds');
      expect(hint).toContain('EuropePMC');
    });

    it('preserves the upstream rejection as cause for diagnosis', async () => {
      const upstream = httpError(429, '45');
      mockFetch.mockRejectedValue(upstream);
      const ctx = createMockContext();
      const err = await service.search({ query: 'CRISPR' }, ctx).catch((e: unknown) => e);
      expect((err as Error).cause).toBe(upstream);
    });

    it('leaves a non-429 upstream failure untouched for the framework to classify', async () => {
      const upstream = httpError(503);
      mockFetch.mockRejectedValue(upstream);
      const ctx = createMockContext();
      const err = await service.search({ query: 'CRISPR' }, ctx).catch((e: unknown) => e);
      expect(err).toBe(upstream);
    });

    it('throws a rejection findRateLimit recognizes — the seam the tool branches on', async () => {
      mockFetch.mockRejectedValue(httpError(429, '45'));
      const ctx = createMockContext();
      const err = await service.search({ query: 'CRISPR' }, ctx).catch((e: unknown) => e);
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
        .search({ query: 'CRISPR' }, ctx)
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
});
