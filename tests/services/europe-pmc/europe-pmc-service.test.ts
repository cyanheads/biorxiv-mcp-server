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

const MOCK_CONFIG = {} as AppConfig;
const MOCK_STORAGE = {} as StorageService;

describe('EuropePmcService', () => {
  let service: EuropePmcService;

  beforeEach(() => {
    service = new EuropePmcService(MOCK_CONFIG, MOCK_STORAGE);
    mockFetch.mockReset();
  });

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
});
