/**
 * @fileoverview Tests for biorxiv_list_recent tool.
 * @module tests/tools/biorxiv-list-recent.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivListRecentTool } from '@/mcp-server/tools/definitions/biorxiv-list-recent.tool.js';
import type { ListingResult, PreprintRevision } from '@/services/biorxiv/types.js';

const mockGetListing = vi.fn();
const mockIsValidCategory = vi.fn();

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({
    getListing: mockGetListing,
    isValidCategory: mockIsValidCategory,
  }),
}));

const PREPRINT: PreprintRevision = {
  doi: '10.1101/2024.01.15.575123',
  title: 'Test Preprint',
  date: '2024-01-15',
  server: 'biorxiv',
};

const LISTING_RESULT: ListingResult = {
  preprints: [PREPRINT],
  pagination: { cursor: 0, total: 1 },
};

describe('biorxivListRecentTool', () => {
  beforeEach(() => {
    mockGetListing.mockResolvedValue(LISTING_RESULT);
    mockIsValidCategory.mockReturnValue(true);
  });

  it('returns preprints and pagination for a valid date range', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'biorxiv',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(result.pagination.biorxiv?.total).toBe(1);
  });

  it('throws invalid_date_range when end_date before start_date', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-31',
      end_date: '2024-01-01',
    });
    await expect(biorxivListRecentTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range for malformed dates', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: 'not-a-date',
      end_date: '2024-01-31',
    });
    await expect(biorxivListRecentTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_category for unknown category', async () => {
    mockIsValidCategory.mockReturnValue(false);
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      category: 'FakeCategory',
    });
    await expect(biorxivListRecentTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_category' },
    });
  });

  it('returns per-server pagination when server="both"', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'both',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.pagination.biorxiv).toBeDefined();
    expect(result.pagination.medrxiv).toBeDefined();
  });

  it('formats output with pagination state and preprint list', () => {
    const output = {
      preprints: [PREPRINT],
      pagination: { biorxiv: { cursor: 0, total: 1 } },
    };
    const blocks = biorxivListRecentTool.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('bioRxiv');
    expect(text).toContain('Test Preprint');
  });
});
