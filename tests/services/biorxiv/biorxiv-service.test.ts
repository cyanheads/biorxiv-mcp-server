/**
 * @fileoverview Tests for BiorxivApiService — details, listing, and crosswalk
 * endpoints with normalization and partial-failure handling.
 * @module tests/services/biorxiv/biorxiv-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';

// Stub out fetchWithTimeout and withRetry so no real HTTP calls are made
const mockFetch = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetch(...args),
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}));

// Stub server config to avoid env var requirements
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

describe('BiorxivApiService', () => {
  let service: BiorxivApiService;

  beforeEach(() => {
    service = new BiorxivApiService(MOCK_CONFIG, MOCK_STORAGE);
    mockFetch.mockReset();
  });

  describe('getDetails', () => {
    it('returns normalized revisions for a DOI', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              doi: '10.1101/2024.01.15.575123',
              title: 'Test Preprint',
              authors: 'Smith J',
              abstract: 'A test abstract.',
              version: '1',
              server: 'biorxiv',
              published: 'NA',
            },
          ],
        }),
      );

      const ctx = createMockContext();
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.doi).toBe('10.1101/2024.01.15.575123');
      expect(revisions[0]?.title).toBe('Test Preprint');
      // "NA" published should be normalized to absent
      expect(revisions[0]?.publishedJournalDoi).toBeUndefined();
    });

    it('returns empty array when DOI not found', async () => {
      mockFetch.mockResolvedValue(makeResponse({ collection: [] }));
      const ctx = createMockContext();
      const revisions = await service.getDetails('10.1101/2024.01.01.000001', 'biorxiv', ctx);
      expect(revisions).toHaveLength(0);
    });

    it('handles sparse upstream payload — omitted optional fields stay absent', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [{ doi: '10.1101/2024.01.15.575123' }],
        }),
      );
      const ctx = createMockContext();
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(revisions[0]?.title).toBeUndefined();
      expect(revisions[0]?.abstract).toBeUndefined();
      expect(revisions[0]?.authors).toBeUndefined();
    });
  });

  describe('getListing', () => {
    it('returns preprints and pagination from listing endpoint', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ total: 100, cursor: 0 }],
          collection: [{ doi: '10.1101/2024.01.15.575123', title: 'Test', date: '2024-01-15' }],
        }),
      );

      const ctx = createMockContext();
      const result = await service.getListing(
        'biorxiv',
        '2024-01-01',
        '2024-01-31',
        0,
        undefined,
        ctx,
      );
      expect(result.preprints).toHaveLength(1);
      expect(result.pagination.total).toBe(100);
      expect(result.pagination.cursor).toBe(0);
    });
  });

  describe('getPublishedVersion', () => {
    it('returns the crosswalk record when found', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              preprint_doi: '10.1101/2024.01.15.575123',
              published_doi: '10.1038/s41586-024-00001-0',
              published_journal: 'Nature',
              published_date: '2024-06-01',
            },
          ],
        }),
      );

      const ctx = createMockContext();
      const result = await service.getPublishedVersion('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(result?.preprintDoi).toBe('10.1101/2024.01.15.575123');
      expect(result?.publishedJournal).toBe('Nature');
    });

    it('returns undefined when preprint is not yet published', async () => {
      mockFetch.mockResolvedValue(makeResponse({ collection: [] }));
      const ctx = createMockContext();
      const result = await service.getPublishedVersion('10.1101/2024.01.01.000001', 'biorxiv', ctx);
      expect(result).toBeUndefined();
    });
  });

  describe('getCategories / isValidCategory', () => {
    it('returns a non-empty taxonomy for both servers', () => {
      const taxonomy = service.getCategories();
      expect(taxonomy.biorxiv.length).toBeGreaterThan(0);
      expect(taxonomy.medrxiv.length).toBeGreaterThan(0);
    });

    it('validates known categories as true and unknown as false', () => {
      expect(service.isValidCategory('Neuroscience')).toBe(true);
      expect(service.isValidCategory('FakeCategory')).toBe(false);
    });
  });
});
