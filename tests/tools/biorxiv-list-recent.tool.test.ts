/**
 * @fileoverview Tests for biorxiv_list_recent tool.
 * @module tests/tools/biorxiv-list-recent.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

  // ── Happy path ──────────────────────────────────────────────────────────────

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

  it('returns medrxiv pagination when server="medrxiv"', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'medrxiv',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.pagination.medrxiv?.total).toBe(1);
    expect(result.pagination.biorxiv).toBeUndefined();
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

  it('includes nextCursor when more results exist beyond the page', async () => {
    mockGetListing.mockResolvedValue({
      preprints: Array.from({ length: 30 }, (_, i) => ({
        doi: `10.1101/2024.01.${String(i + 1).padStart(2, '0')}.000001`,
      })),
      pagination: { cursor: 0, total: 90 },
    });
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'biorxiv',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.pagination.biorxiv?.nextCursor).toBe(30);
  });

  it('omits nextCursor when on the last page', async () => {
    mockGetListing.mockResolvedValue({
      preprints: [PREPRINT],
      pagination: { cursor: 0, total: 1 },
    });
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'biorxiv',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.pagination.biorxiv?.nextCursor).toBeUndefined();
  });

  it('defaults server to "both" and cursor to 0 when omitted', () => {
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
    });
    expect(input.server).toBe('both');
    expect(input.cursor).toBe(0);
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('throws invalid_date_range when end_date before start_date', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-31',
      end_date: '2024-01-01',
    });
    await expect(biorxivListRecentTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range for malformed start_date', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: 'not-a-date',
      end_date: '2024-01-31',
    });
    await expect(biorxivListRecentTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range for malformed end_date', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: 'bad',
    });
    await expect(biorxivListRecentTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('allows same day for start_date and end_date', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-15',
      end_date: '2024-01-15',
      server: 'biorxiv',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.preprints).toBeDefined();
  });

  it('throws invalid_date_range for a calendar-impossible month (2024-13-01)', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-13-01',
      end_date: '2024-13-02',
    });
    await expect(biorxivListRecentTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range for a day-of-month overflow (2024-02-30)', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-02-30',
      end_date: '2024-03-05',
    });
    await expect(biorxivListRecentTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range for Feb 29 in a non-leap year (2023-02-29)', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2023-02-29',
      end_date: '2023-03-05',
    });
    await expect(biorxivListRecentTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('accepts a valid leap day (2024-02-29)', async () => {
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-02-29',
      end_date: '2024-02-29',
      server: 'biorxiv',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.preprints).toBeDefined();
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
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_category' },
    });
  });

  it('trims whitespace from category before validation', async () => {
    mockIsValidCategory.mockReturnValue(true);
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      category: '  Neuroscience  ',
      server: 'biorxiv',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    // After trim, category is passed as "Neuroscience" — should resolve fine
    expect(result.preprints).toBeDefined();
  });

  it('rejects negative cursor at schema parse time', () => {
    expect(() =>
      biorxivListRecentTool.input.parse({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
        cursor: -1,
      }),
    ).toThrow();
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it('enriches notice when zero results are returned', async () => {
    mockGetListing.mockResolvedValue({
      preprints: [],
      pagination: { cursor: 0, total: 0 },
    });
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'biorxiv',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
  });

  it('enriches cursor-overshoot notice when cursor > 0 and zero results', async () => {
    mockGetListing.mockResolvedValue({
      preprints: [],
      pagination: { cursor: 990, total: 30 },
    });
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'biorxiv',
      cursor: 990,
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/cursor/i);
  });

  it('marks a single-server cursor overshoot exhausted while keeping total in the payload', async () => {
    mockGetListing.mockResolvedValue({
      preprints: [],
      pagination: { cursor: 990, total: 0 },
    });
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'biorxiv',
      cursor: 990,
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.pagination.biorxiv?.exhausted).toBe(true);
    expect(result.pagination.biorxiv?.total).toBe(0);
  });

  it('marks the overshot server exhausted and notices it when the other still returns a page', async () => {
    mockGetListing.mockImplementation((server: string) =>
      server === 'biorxiv'
        ? Promise.resolve({
            preprints: Array.from({ length: 30 }, (_, i) => ({
              doi: `10.1101/2026.07.01.${String(i + 1).padStart(6, '0')}`,
            })),
            pagination: { cursor: 120, total: 232 },
          })
        : Promise.resolve({ preprints: [], pagination: { cursor: 120, total: 0 } }),
    );
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2026-07-01',
      end_date: '2026-07-01',
      server: 'both',
      cursor: 120,
    });
    const result = await biorxivListRecentTool.handler(input, ctx);

    expect(result.preprints).toHaveLength(30);
    expect(result.pagination.medrxiv?.exhausted).toBe(true);
    // #15 kept total in the payload for the empty case — it must still be present here
    expect(result.pagination.medrxiv?.total).toBe(0);
    expect(result.pagination.biorxiv?.exhausted).toBeUndefined();
    expect(result.pagination.biorxiv?.total).toBe(232);
    // An exhausted server answered — it is not a failed one
    expect(result.failed).toEqual([]);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/medRxiv/);
    expect(enrichment.notice).toMatch(/120/);
  });

  it('does not mark a server exhausted when an empty page comes back at cursor 0', async () => {
    mockGetListing.mockImplementation((server: string) =>
      server === 'biorxiv'
        ? Promise.resolve(LISTING_RESULT)
        : Promise.resolve({ preprints: [], pagination: { cursor: 0, total: 0 } }),
    );
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'both',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    expect(result.pagination.medrxiv?.exhausted).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('continues gracefully when one server fails in both mode, naming it as failed', async () => {
    mockGetListing.mockImplementation((_server: string) => {
      if (_server === 'biorxiv') return Promise.resolve(LISTING_RESULT);
      return Promise.reject(new Error('medRxiv down'));
    });
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'both',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);
    // bioRxiv results still returned even if medRxiv failed
    expect(result.preprints).toHaveLength(1);
    expect(result.pagination.biorxiv).toBeDefined();
    // The failed server has no pagination entry — without failed[] and the notice,
    // this response would be indistinguishable from a complete two-server result
    expect(result.pagination.medrxiv).toBeUndefined();
    expect(result.failed).toEqual([{ server: 'medrxiv', error: 'medRxiv down' }]);
    // A failed server is not an exhausted one
    expect(result.pagination.biorxiv?.exhausted).toBeUndefined();

    const notice = getEnrichment(ctx).notice;
    expect(notice).toMatch(/medRxiv did not answer/);
    expect(notice).toMatch(/partial/);
  });

  it('renders the failed server in content[] alongside the surviving pagination line', async () => {
    mockGetListing.mockImplementation((_server: string) =>
      _server === 'biorxiv'
        ? Promise.resolve(LISTING_RESULT)
        : Promise.reject(new Error('medRxiv down')),
    );
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'both',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);

    const text = (biorxivListRecentTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**bioRxiv:** page offset 0, total 1');
    expect(text).toContain('**medRxiv:** server did not answer');
    expect(text).toContain('medRxiv down');
    // The failed server must not read as an exhausted cursor
    expect(text).not.toContain('exhausted');
  });

  it('keeps the failed server in the notice when the surviving server returns nothing', async () => {
    mockGetListing.mockImplementation((_server: string) =>
      _server === 'biorxiv'
        ? Promise.reject(new Error('bioRxiv down'))
        : Promise.resolve({ preprints: [], pagination: { cursor: 0, total: 0 } }),
    );
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'both',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);

    expect(result.preprints).toHaveLength(0);
    expect(result.failed).toEqual([{ server: 'biorxiv', error: 'bioRxiv down' }]);
    // The zero-result guidance must not overwrite the partial-result qualification:
    // "nothing found" is not an established absence when a server never answered
    const notice = getEnrichment(ctx).notice;
    expect(notice).toMatch(/bioRxiv did not answer/);
    expect(notice).toMatch(/No preprints found/);
  });

  it('does not report an empty interval when neither server answered', async () => {
    mockGetListing.mockImplementation((server: string) =>
      Promise.reject(new Error(`${server} down`)),
    );
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'both',
    });
    const result = await biorxivListRecentTool.handler(input, ctx);

    expect(result.preprints).toHaveLength(0);
    expect(result.failed).toEqual([
      { server: 'biorxiv', error: 'biorxiv down' },
      { server: 'medrxiv', error: 'medrxiv down' },
    ]);
    // No server reported anything, so absence was never established
    const notice = getEnrichment(ctx).notice;
    expect(notice).toMatch(/not an empty interval/);
    expect(notice).not.toMatch(/No preprints found/);
  });

  // ── Category routing for server="both" ──────────────────────────────────────

  it('queries only the matching server for a server-exclusive category when server="both"', async () => {
    // Neuroscience exists only in the bioRxiv taxonomy
    mockIsValidCategory.mockImplementation((_cat: string, server: string) => server !== 'medrxiv');
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-15',
      end_date: '2024-01-15',
      server: 'both',
      category: 'Neuroscience',
    });
    mockGetListing.mockClear();
    const result = await biorxivListRecentTool.handler(input, ctx);
    // Only bioRxiv was queried — medRxiv (no matching category) is not called
    expect(mockGetListing).toHaveBeenCalledTimes(1);
    expect(mockGetListing).toHaveBeenCalledWith(
      'biorxiv',
      '2024-01-15',
      '2024-01-15',
      0,
      'Neuroscience',
      expect.anything(),
    );
    expect(result.pagination.biorxiv).toBeDefined();
    expect(result.pagination.medrxiv).toBeUndefined();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.categoryNote).toMatch(/only bioRxiv was queried/);
  });

  it('queries both servers for a category shared by both taxonomies when server="both"', async () => {
    // Epidemiology exists in both taxonomies — both remain valid
    mockIsValidCategory.mockReturnValue(true);
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-15',
      end_date: '2024-01-15',
      server: 'both',
      category: 'Epidemiology',
    });
    mockGetListing.mockClear();
    const result = await biorxivListRecentTool.handler(input, ctx);
    // Category is sent to BOTH servers (filtered on each), not dropped for either
    expect(mockGetListing).toHaveBeenCalledTimes(2);
    expect(mockGetListing).toHaveBeenCalledWith(
      'biorxiv',
      '2024-01-15',
      '2024-01-15',
      0,
      'Epidemiology',
      expect.anything(),
    );
    expect(mockGetListing).toHaveBeenCalledWith(
      'medrxiv',
      '2024-01-15',
      '2024-01-15',
      0,
      'Epidemiology',
      expect.anything(),
    );
    expect(result.pagination.biorxiv).toBeDefined();
    expect(result.pagination.medrxiv).toBeDefined();
    // No exclusivity note when the category is shared
    const enrichment = getEnrichment(ctx);
    expect(enrichment.categoryNote).toBeUndefined();
  });

  // ── format ──────────────────────────────────────────────────────────────────

  it('formats output with pagination state and preprint list', () => {
    const output = {
      preprints: [PREPRINT],
      pagination: { biorxiv: { cursor: 0, total: 1 } },
      failed: [],
    };
    const blocks = biorxivListRecentTool.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('bioRxiv');
    expect(text).toContain('Test Preprint');
  });

  it('formats medrxiv pagination block when present', () => {
    const output = {
      preprints: [{ ...PREPRINT, server: 'medrxiv' }],
      pagination: { medrxiv: { cursor: 0, total: 5, nextCursor: 30 } },
      failed: [],
    };
    const blocks = biorxivListRecentTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('medRxiv');
    expect(text).toContain('next cursor: 30');
  });

  it('renders an exhausted server distinctly from a genuine last page with results', () => {
    const lastPage = biorxivListRecentTool.format!({
      preprints: [PREPRINT],
      pagination: { biorxiv: { cursor: 30, total: 31 } },
      failed: [],
    });
    const lastPageText = (lastPage[0] as { text: string }).text;
    expect(lastPageText).toContain('(last page)');
    expect(lastPageText).not.toContain('exhausted');

    const overshot = biorxivListRecentTool.format!({
      preprints: [PREPRINT],
      pagination: {
        biorxiv: { cursor: 120, total: 232, nextCursor: 150 },
        medrxiv: { cursor: 120, total: 0, exhausted: true },
      },
      failed: [],
    });
    const overshotText = (overshot[0] as { text: string }).text;
    expect(overshotText).toContain('**bioRxiv:** page offset 120, total 232 — next cursor: 150');
    expect(overshotText).toMatch(/\*\*medRxiv:\*\* page offset 120, total 0 .*exhausted/);
    // The medRxiv line must not read as a genuine final page of results
    expect(overshotText).not.toContain('total 0 (last page)');
  });

  it('formats empty result set (no preprints section)', () => {
    const output = {
      preprints: [],
      pagination: { biorxiv: { cursor: 0, total: 0 } },
      failed: [],
    };
    const blocks = biorxivListRecentTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Contains pagination header but no preprint items
    expect(text).toContain('bioRxiv');
  });
});
