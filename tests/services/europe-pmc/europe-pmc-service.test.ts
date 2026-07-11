/**
 * @fileoverview Tests for EuropePmcService — preprint keyword search and
 * result normalization.
 * @module tests/services/europe-pmc/europe-pmc-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';

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

/** Make a fake response whose body is an HTML error page */
function makeHtmlResponse(html = '<html><body>Service Unavailable</body></html>'): Response {
  return {
    text: () => Promise.resolve(html),
    ok: false,
    status: 503,
  } as unknown as Response;
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

  it('throws serviceUnavailable when API returns HTML error page', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse());
    const ctx = createMockContext();
    await expect(service.search({ query: 'CRISPR' }, ctx)).rejects.toThrow();
  });

  it('throws serviceUnavailable when HTML starts with lowercase html tag', async () => {
    mockFetch.mockResolvedValue(makeHtmlResponse('<html><body>Rate limited</body></html>'));
    const ctx = createMockContext();
    await expect(service.search({ query: 'test' }, ctx)).rejects.toThrow();
  });

  it('propagates network errors from fetchWithTimeout', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    const ctx = createMockContext();
    await expect(service.search({ query: 'CRISPR' }, ctx)).rejects.toThrow('connection refused');
  });
});
