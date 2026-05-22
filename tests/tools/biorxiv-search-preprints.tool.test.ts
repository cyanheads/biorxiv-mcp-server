/**
 * @fileoverview Tests for biorxiv_search_preprints tool.
 * @module tests/tools/biorxiv-search-preprints.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivSearchPreprintsTool } from '@/mcp-server/tools/definitions/biorxiv-search-preprints.tool.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';
import type { EuropePmcResult } from '@/services/europe-pmc/types.js';

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
    mockEpmcSearch.mockResolvedValue([EPMC_RESULT]);
    mockGetDetails.mockResolvedValue([REVISION]);
  });

  it('returns enriched results for a keyword query', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(result.preprints[0]?.doi).toBe('10.1101/2024.01.15.575123');
    expect(result.preprints[0]?.enriched).toBe(true);
    expect(result.total_from_search).toBe(1);
    expect(result.partial_results).toBe(false);
  });

  it('returns empty results when EuropePMC finds nothing', async () => {
    mockEpmcSearch.mockResolvedValue([]);
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'xyzzy_no_match' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(0);
    expect(result.message).toBeDefined();
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
  });

  it('formats output with result count and enrichment status', () => {
    const output = {
      preprints: [
        {
          doi: '10.1101/2024.01.15.575123',
          title: 'CRISPR gene editing in neural circuits',
          enriched: true,
          revisionCount: 1,
        },
      ],
      total_from_search: 1,
      partial_results: false,
    };
    const blocks = biorxivSearchPreprintsTool.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.15.575123');
    expect(text).toContain('1 results');
  });
});
