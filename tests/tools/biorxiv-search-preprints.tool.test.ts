/**
 * @fileoverview Tests for biorxiv_search_preprints tool.
 * @module tests/tools/biorxiv-search-preprints.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivSearchPreprintsTool } from '@/mcp-server/tools/definitions/biorxiv-search-preprints.tool.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';
import type { EuropePmcResult, EuropePmcSearchResult } from '@/services/europe-pmc/types.js';

const mockEpmcSearch = vi.fn();
const mockGetDetails = vi.fn();

vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => ({ search: mockEpmcSearch }),
}));

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({ getDetails: mockGetDetails }),
}));

const EPMC_RESULT: EuropePmcResult = {
  doi: '10.1101/2024.01.15.575123',
  title: 'CRISPR gene editing in neural circuits',
  authors: 'Smith J, Jones A',
  publishedDate: '2024-01-15',
  abstract: 'A study on CRISPR applications.',
};

/** Helper: build an EuropePmcSearchResult with a given hitCount and result set */
function epmcSearchResult(hitCount: number, results: EuropePmcResult[]): EuropePmcSearchResult {
  return { hitCount, results };
}

const REVISION: PreprintRevision = {
  doi: '10.1101/2024.01.15.575123',
  title: 'CRISPR gene editing in neural circuits',
  authors: 'Smith J, Jones A',
  date: '2024-01-15',
  version: '1',
  category: 'Neuroscience',
  server: 'biorxiv',
  abstract: 'A study on CRISPR applications.',
};

describe('biorxivSearchPreprintsTool', () => {
  beforeEach(() => {
    // hitCount > results.length to verify the true total threads through correctly
    mockEpmcSearch.mockResolvedValue(epmcSearchResult(1234, [EPMC_RESULT]));
    mockGetDetails.mockResolvedValue([REVISION]);
  });

  it('returns enriched results for a keyword query', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(result.preprints[0]?.doi).toBe('10.1101/2024.01.15.575123');
    expect(result.preprints[0]?.enriched).toBe(true);
    expect(result.partial_results).toBe(false);
    // totalFound must carry the upstream hitCount, not the returned count
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalFound).toBe(1234);
  });

  it('surfaces true hitCount and query echo in enrichment', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      server: 'biorxiv',
      limit: 10,
    });
    await biorxivSearchPreprintsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalFound).toBe(1234);
    expect(enrichment.queryEcho).toMatchObject({
      query: 'CRISPR',
      server: 'biorxiv',
      limit: 10,
    });
  });

  it('returns empty results when EuropePMC finds nothing', async () => {
    mockEpmcSearch.mockResolvedValue(epmcSearchResult(0, []));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'xyzzy_no_match' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalFound).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('throws search_unavailable when EuropePMC call throws', async () => {
    mockEpmcSearch.mockRejectedValue(new Error('Network error'));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    await expect(biorxivSearchPreprintsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('marks partial_results=true when bioRxiv enrichment fails', async () => {
    mockGetDetails.mockResolvedValue([]);
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.partial_results).toBe(true);
    expect(result.preprints[0]?.enriched).toBe(false);
    // hitCount still threads through even when enrichment fails
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalFound).toBe(1234);
  });

  it('formats output with result count and preprint list', () => {
    const output = {
      preprints: [
        {
          doi: '10.1101/2024.01.15.575123',
          title: 'CRISPR gene editing in neural circuits',
          enriched: true,
          revisionCount: 1,
        },
      ],
      partial_results: false,
    };
    const blocks = biorxivSearchPreprintsTool.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.15.575123');
    expect(text).toContain('1 results');
  });
});
