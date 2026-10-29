/**
 * @fileoverview Tests for biorxiv_list_recent tool.
 * @module tests/tools/biorxiv-list-recent.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivListRecentTool } from '@/mcp-server/tools/definitions/biorxiv-list-recent.tool.js';
import type { ListingResult, PreprintRevision } from '@/services/biorxiv/types.js';
import { ESCAPED, IDENTIFIERS, UPSTREAM } from '../helpers/markdown-fixtures.js';
import {
  declaredRateLimitRecovery,
  RATE_LIMIT_RECOVERY_OPENING,
  rateLimitError,
} from '../helpers/rate-limit.js';
import { envelopeHint, recoveryHint, rejection } from '../helpers/rejection.js';

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
    mockGetListing.mockClear();
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

  it('accepts date_from / date_to, the date-bound spelling biorxiv_search_preprints uses', async () => {
    const result = await runToolContract(
      biorxivListRecentTool,
      { date_from: '2024-01-01', date_to: '2024-01-31', server: 'biorxiv' } as never,
      { context: { errors: biorxivListRecentTool.errors } },
    );
    expect(result.isError).toBeFalsy();
    expect(mockGetListing).toHaveBeenCalledWith(
      'biorxiv',
      '2024-01-01',
      '2024-01-31',
      0,
      {},
      expect.any(Number),
      expect.anything(),
    );
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

  // A malformed date fails at the schema, as on biorxiv_search_preprints and
  // biorxiv_list_published_versions; invalid_date_range keeps calendar and order.
  describe.each(['start_date', 'end_date'] as const)('a malformed %s', (bound) => {
    it.each(['2025-3-4', '7d', 'not-a-date', '', ' 2024-01-01', '2024-01-01T00:00:00Z'])(
      'rejects %j at the schema as -32602 naming the field, before any upstream call',
      async (value) => {
        const result = await runToolContract(
          biorxivListRecentTool,
          { start_date: '2024-01-01', end_date: '2024-01-31', [bound]: value } as never,
          { context: { errors: biorxivListRecentTool.errors } },
        );
        expect(result.isError).toBe(true);
        const error = (result.structuredContent as { error: { code: number; message: string } })
          .error;
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.message).toContain(bound);
        expect(mockGetListing).not.toHaveBeenCalled();
      },
    );

    it('carries a hint naming the YYYY-MM-DD form, not the raw pattern', async () => {
      const result = await runToolContract(
        biorxivListRecentTool,
        { start_date: '2024-01-01', end_date: '2024-01-31', [bound]: '2025-3-4' } as never,
        { context: { errors: biorxivListRecentTool.errors } },
      );
      const hint = envelopeHint(result);
      expect(hint).toContain('YYYY-MM-DD');
      expect(hint).not.toContain('\\d');
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain('YYYY-MM-DD');
      expect(text).not.toContain('\\d');
    });
  });

  it.each([
    ['date_from', 'start_date'],
    ['date_to', 'end_date'],
  ] as const)(
    'rejects a malformed %s alias at the schema as its %s target',
    async (alias, target) => {
      const result = await runToolContract(
        biorxivListRecentTool,
        { date_from: '2024-01-01', date_to: '2024-01-31', [alias]: '2025-3-4' } as never,
        { context: { errors: biorxivListRecentTool.errors } },
      );
      const error = (result.structuredContent as { error: { code: number; message: string } })
        .error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain(target);
      expect(mockGetListing).not.toHaveBeenCalled();
    },
  );

  it('advertises the YYYY-MM-DD pattern on both required date bounds in tools/list', () => {
    const schema = z.toJSONSchema(biorxivListRecentTool.input, { io: 'input' }) as {
      properties: Record<string, { type?: string; pattern?: string }>;
      required?: string[];
    };
    for (const bound of ['start_date', 'end_date']) {
      expect(schema.properties[bound]).toMatchObject({
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      });
      expect(schema.required).toContain(bound);
    }
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

  it('throws retryable upstream_unavailable when neither server answered, not an empty success', async () => {
    // An empty page here would be indistinguishable from an interval that holds
    // nothing, for a caller that branches on success-vs-error rather than prose.
    const bxDown = new Error('biorxiv down');
    mockGetListing.mockImplementation((server: string) =>
      Promise.reject(server === 'biorxiv' ? bxDown : new Error('medrxiv down')),
    );
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'both',
    });
    const err = await rejection(biorxivListRecentTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true, servers: ['biorxiv', 'medrxiv'] },
    });
    // Both underlying failures reach the message, and the first is kept as cause
    expect(err.message).toContain('biorxiv down');
    expect(err.message).toContain('medrxiv down');
    expect(err.cause).toBe(bxDown);
    // The empty-interval guidance must not ride along on the failure
    expect(JSON.stringify(err.data)).not.toMatch(/No preprints found/);

    // The contract hint the client receives says to retry
    const result = await runToolContract(
      biorxivListRecentTool,
      { start_date: '2024-01-01', end_date: '2024-01-31', server: 'both' } as never,
      { context: { errors: biorxivListRecentTool.errors } },
    );
    expect(envelopeHint(result)).toMatch(/retry/i);
  });

  it('declares a rate_limited recovery that holds when the origin named no wait', () => {
    expect(declaredRateLimitRecovery(biorxivListRecentTool.errors)).toBe(
      `${RATE_LIMIT_RECOVERY_OPENING}retrying — every preprint metadata tool queries the same origin, so none of them will answer sooner.`,
    );
  });

  it('throws rate_limited instead of upstream_unavailable when one of the two failures is a 429', async () => {
    // Both mean "retry", but only the rate limit says when — and retrying sooner
    // than the origin asked would land straight back inside the same limit.
    mockGetListing.mockImplementation((server: string) =>
      Promise.reject(server === 'biorxiv' ? rateLimitError(45) : new Error('medrxiv down')),
    );
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'both',
    });
    const err = await rejection(biorxivListRecentTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryable: true, retryAfter: 45 },
    });
    expect(recoveryHint(err)).toContain('45 seconds');
  });

  it('carries the longer of two 429 waits so the retry clears both origins', async () => {
    mockGetListing.mockImplementation((server: string) =>
      Promise.reject(rateLimitError(server === 'biorxiv' ? 15 : 90)),
    );
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'both',
    });
    const err = await rejection(biorxivListRecentTool.handler(input, ctx));
    expect(err.data?.retryAfter).toBe(90);
  });

  it('surfaces a single-server 429 as a retryable rate_limited tool error', async () => {
    mockGetListing.mockRejectedValue(rateLimitError(30));
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'biorxiv',
    });
    const err = await rejection(biorxivListRecentTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryable: true, retryAfter: 30 },
    });
  });

  it('names the server and the wait on a single-server 429, as the two-server failure does', async () => {
    const upstream = rateLimitError(30);
    mockGetListing.mockRejectedValue(upstream);
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'biorxiv',
    });
    const err = await rejection(biorxivListRecentTool.handler(input, ctx));

    expect(err.data).toMatchObject({ servers: ['biorxiv'] });
    expect(err.message).toBe(`bioRxiv did not answer — ${upstream.message}`);
    expect(err.cause).toBe(upstream);
    expect(recoveryHint(err)).toBe(
      'Wait 30 seconds before retrying — api.biorxiv.org is rate-limiting this host, and every preprint metadata tool queries the same origin.',
    );
  });

  it('fails a single-server listing that outlasts the call budget as retryable upstream_unavailable, never a bare Timeout', async () => {
    const expiry = new McpError(
      JsonRpcErrorCode.Timeout,
      'BiorxivApiService.getListing exceeded its 50000ms retry deadline after 3 attempts.',
      { reason: 'retry_deadline_exceeded', deadlineMs: 50_000, retryAttempts: 3 },
    );
    mockGetListing.mockRejectedValue(expiry);
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-01',
      end_date: '2024-01-31',
      server: 'medrxiv',
    });
    const err = await rejection(biorxivListRecentTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true, servers: ['medrxiv'] },
    });
    expect(err.message).toBe(`medRxiv did not answer — ${expiry.message}`);
    expect(err.cause).toBe(expiry);
  });

  it('carries a failed leg of a "both" request collapsed onto one server on both client surfaces', async () => {
    // Neuroscience exists only in the bioRxiv taxonomy, so only bioRxiv is queried.
    mockIsValidCategory.mockImplementation((_cat: string, server: string) => server !== 'medrxiv');
    mockGetListing.mockRejectedValue(new Error('fetch failed'));
    const result = await runToolContract(
      biorxivListRecentTool,
      {
        start_date: '2024-01-15',
        end_date: '2024-01-15',
        server: 'both',
        category: 'Neuroscience',
      } as never,
      { context: { errors: biorxivListRecentTool.errors } },
    );

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    };
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_unavailable',
      retryable: true,
      servers: ['biorxiv'],
    });
    expect(error.message).toBe('bioRxiv did not answer — fetch failed');
    expect(envelopeHint(result)).toBe(
      'Retry the request after a short delay — the interval may well hold preprints; api.biorxiv.org did not answer.',
    );
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('bioRxiv did not answer — fetch failed');
    expect(text).toContain('Retry the request after a short delay');
    expect(text).toContain('upstream_unavailable');
  });

  it('keeps a caller cancellation of a single-server listing a cancellation, never a degraded page', async () => {
    const controller = new AbortController();
    mockGetListing.mockImplementation(() => {
      controller.abort(new Error('cancelled by caller'));
      return Promise.reject(new Error('aborted'));
    });
    const result = await runToolContract(
      biorxivListRecentTool,
      { start_date: '2024-01-01', end_date: '2024-01-31', server: 'biorxiv' } as never,
      { context: { errors: biorxivListRecentTool.errors, signal: controller.signal } },
    );

    // The runner settles any throw after the abort as RequestCancelled, so the
    // message is what shows the caller's reason was rethrown, not a server outage.
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: JsonRpcErrorCode.RequestCancelled, message: 'cancelled by caller' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Error: cancelled by caller' }]);
    expect(mockGetListing).toHaveBeenCalledTimes(1);
  });

  describe('cancellation under server="both"', () => {
    const WEEK = { start_date: '2024-01-01', end_date: '2024-01-07', server: 'both' };

    /** bioRxiv answers; the medRxiv leg runs `medrxiv`. */
    const legs = (medrxiv: () => Promise<never>) =>
      mockGetListing.mockImplementation((server: string) =>
        server === 'biorxiv' ? Promise.resolve(LISTING_RESULT) : medrxiv(),
      );

    it('rethrows a cancellation rather than returning the leg that finished first', async () => {
      const controller = new AbortController();
      const cancelled = new Error('cancelled by caller');
      legs(() => {
        controller.abort(cancelled);
        return Promise.reject(new Error('aborted'));
      });
      const ctx = createMockContext({
        errors: biorxivListRecentTool.errors,
        signal: controller.signal,
      });
      const err = await rejection(
        biorxivListRecentTool.handler(biorxivListRecentTool.input.parse(WEEK), ctx),
      );
      expect(err).toBe(cancelled);
    });

    it('settles the cancelled call as RequestCancelled, never a partial success', async () => {
      const controller = new AbortController();
      legs(() => {
        controller.abort(new Error('cancelled by caller'));
        return Promise.reject(new Error('aborted'));
      });
      const result = await runToolContract(biorxivListRecentTool, WEEK as never, {
        context: { errors: biorxivListRecentTool.errors, signal: controller.signal },
      });

      // The runner settles any throw after the abort as RequestCancelled, so the
      // message is what shows the caller's reason was rethrown, not a server outage.
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: { code: JsonRpcErrorCode.RequestCancelled, message: 'cancelled by caller' },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'Error: cancelled by caller' }]);
    });

    it('still returns the answering page with the other leg in failed[] while the signal is live', async () => {
      const controller = new AbortController();
      legs(() => Promise.reject(new Error('fetch failed')));
      const ctx = createMockContext({
        errors: biorxivListRecentTool.errors,
        signal: controller.signal,
      });
      const result = await biorxivListRecentTool.handler(
        biorxivListRecentTool.input.parse(WEEK),
        ctx,
      );

      expect(controller.signal.aborted).toBe(false);
      expect(result.preprints).toEqual([PREPRINT]);
      expect(result.failed).toEqual([{ server: 'medrxiv', error: 'fetch failed' }]);
    });
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
      { category: 'Neuroscience' },
      expect.any(Number),
      expect.anything(),
    );
    expect(result.pagination.biorxiv).toBeDefined();
    expect(result.pagination.medrxiv).toBeUndefined();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.categoryNote).toMatch(/only bioRxiv was queried/);
  });

  it('queries both servers for a category shared by both taxonomies when server="both"', async () => {
    // Pathology exists in both taxonomies — both remain valid
    mockIsValidCategory.mockReturnValue(true);
    const ctx = createMockContext({ errors: biorxivListRecentTool.errors });
    const input = biorxivListRecentTool.input.parse({
      start_date: '2024-01-15',
      end_date: '2024-01-15',
      server: 'both',
      category: 'Pathology',
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
      { category: 'Pathology' },
      expect.any(Number),
      expect.anything(),
    );
    expect(mockGetListing).toHaveBeenCalledWith(
      'medrxiv',
      '2024-01-15',
      '2024-01-15',
      0,
      { category: 'Pathology' },
      expect.any(Number),
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
      preprints: [{ ...PREPRINT, server: 'medrxiv' as const }],
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

  // ── newPreprints ────────────────────────────────────────────────────────────

  describe('newPreprints', () => {
    const rows = (server: 'biorxiv' | 'medrxiv', n: number): PreprintRevision[] =>
      Array.from({ length: n }, (_, i) => ({
        doi: `10.1101/2026.10.01.${server === 'biorxiv' ? '7' : '2'}${String(i).padStart(5, '0')}`,
        server,
      }));

    async function call(args: Record<string, unknown>) {
      const result = await runToolContract(
        biorxivListRecentTool,
        { start_date: '2026-10-01', end_date: '2026-10-07', ...args } as never,
        { context: { errors: biorxivListRecentTool.errors } },
      );
      const structured = result.structuredContent as {
        pagination: Record<string, unknown>;
        failed: unknown[];
        notice?: string;
      };
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      return { result, structured, lines: text.split('\n') };
    }

    it('carries each server its own count under server="both", never summed', async () => {
      mockGetListing.mockImplementation((server: 'biorxiv' | 'medrxiv') =>
        Promise.resolve(
          server === 'biorxiv'
            ? {
                preprints: rows('biorxiv', 30),
                pagination: { cursor: 0, total: 1460, newPreprints: 1092 },
              }
            : {
                preprints: rows('medrxiv', 30),
                pagination: { cursor: 0, total: 118, newPreprints: 99 },
              },
        ),
      );
      const { result, structured, lines } = await call({ server: 'both' });
      expect(result.isError).toBeFalsy();
      expect(structured.pagination).toEqual({
        biorxiv: { cursor: 0, total: 1460, newPreprints: 1092, nextCursor: 30 },
        medrxiv: { cursor: 0, total: 118, newPreprints: 99, nextCursor: 30 },
      });
      expect(lines).toContain(
        '**bioRxiv:** page offset 0, total 1460, 1092 new preprints — next cursor: 30',
      );
      expect(lines).toContain(
        '**medRxiv:** page offset 0, total 118, 99 new preprints — next cursor: 30',
      );
      expect(lines.join('\n')).not.toContain('1191');
    });

    it('reports a count of 0 rather than dropping it', async () => {
      mockGetListing.mockResolvedValue({
        preprints: rows('biorxiv', 9),
        pagination: { cursor: 0, total: 9, newPreprints: 0 },
      });
      const { structured, lines } = await call({ server: 'biorxiv' });
      expect(structured.pagination).toEqual({ biorxiv: { cursor: 0, total: 9, newPreprints: 0 } });
      expect(lines).toContain('**bioRxiv:** page offset 0, total 9, 0 new preprints (last page)');
    });

    it('names a single new preprint in the singular', async () => {
      mockGetListing.mockResolvedValue({
        preprints: rows('medrxiv', 2),
        pagination: { cursor: 0, total: 2, newPreprints: 1 },
      });
      const { lines } = await call({ server: 'medrxiv' });
      expect(lines).toContain('**medRxiv:** page offset 0, total 2, 1 new preprint (last page)');
    });

    it('omits the field and the phrase when upstream reports no count', async () => {
      mockGetListing.mockResolvedValue({
        preprints: rows('biorxiv', 1),
        pagination: { cursor: 0, total: 1 },
      });
      const { structured, lines } = await call({ server: 'biorxiv' });
      expect(structured.pagination).toEqual({ biorxiv: { cursor: 0, total: 1 } });
      expect(lines).toContain('**bioRxiv:** page offset 0, total 1 (last page)');
    });

    it('leaves an exhausted entry without a count beside a server that has one', async () => {
      mockGetListing.mockImplementation((server: 'biorxiv' | 'medrxiv') =>
        Promise.resolve(
          server === 'biorxiv'
            ? {
                preprints: rows('biorxiv', 1),
                pagination: { cursor: 30, total: 31, newPreprints: 20 },
              }
            : { preprints: [], pagination: { cursor: 30, total: 0 } },
        ),
      );
      const { structured, lines } = await call({ server: 'both', cursor: 30 });
      expect(structured.pagination).toEqual({
        biorxiv: { cursor: 30, total: 31, newPreprints: 20 },
        medrxiv: { cursor: 30, total: 0, exhausted: true },
      });
      expect(lines).toContain(
        '**bioRxiv:** page offset 30, total 31, 20 new preprints (last page)',
      );
      expect(lines).toContain(
        '**medRxiv:** page offset 30, total 0 — cursor exhausted: past the last available page, no records at this offset (the total shown is an out-of-range artifact, not the interval total)',
      );
      expect(structured.notice).toMatch(/Cursor 30 is past the last available page on medRxiv/);
    });

    it('keeps the surviving server its count when the other fails', async () => {
      mockGetListing.mockImplementation((server: 'biorxiv' | 'medrxiv') =>
        server === 'biorxiv'
          ? Promise.reject(new Error('bioRxiv down'))
          : Promise.resolve({
              preprints: rows('medrxiv', 2),
              pagination: { cursor: 0, total: 2, newPreprints: 2 },
            }),
      );
      const { structured, lines } = await call({ server: 'both' });
      expect(structured.failed).toEqual([{ server: 'biorxiv', error: 'bioRxiv down' }]);
      expect(structured.pagination).toEqual({ medrxiv: { cursor: 0, total: 2, newPreprints: 2 } });
      expect(lines).toContain('**medRxiv:** page offset 0, total 2, 2 new preprints (last page)');
      expect(lines).toContain(
        '**bioRxiv:** server did not answer — no records from it are included (bioRxiv down)',
      );
    });

    it('leaves an empty window at cursor 0 without a count', async () => {
      mockGetListing.mockResolvedValue({ preprints: [], pagination: { cursor: 0, total: 0 } });
      const { structured, lines } = await call({ server: 'medrxiv' });
      expect(structured.pagination).toEqual({ medrxiv: { cursor: 0, total: 0 } });
      expect(lines).toContain('**medRxiv:** page offset 0, total 0 (last page)');
    });

    it('declares the field as an optional integer on both server entries', () => {
      const output = (entry: Record<string, unknown>) => ({
        preprints: [],
        pagination: { biorxiv: entry, medrxiv: entry },
        failed: [],
      });
      expect(
        biorxivListRecentTool.output.parse(output({ cursor: 0, total: 9, newPreprints: 0 })),
      ).toEqual(output({ cursor: 0, total: 9, newPreprints: 0 }));
      expect(() =>
        biorxivListRecentTool.output.parse(output({ cursor: 0, total: 9, newPreprints: 1.5 })),
      ).toThrow();
      expect(() =>
        biorxivListRecentTool.output.parse(output({ cursor: 0, total: 9 })),
      ).not.toThrow();
    });
  });

  // ── include_abstract ────────────────────────────────────────────────────────

  describe('include_abstract', () => {
    /** A record carrying every output field, so a projection that drops more than the abstract shows. */
    const FULL: PreprintRevision = {
      doi: '10.1101/2026.09.01.700001',
      title: 'Kinetochore assembly in human cells',
      authors: 'Doe, J.; Roe, R.',
      authorCorresponding: 'Jane Doe',
      authorCorrespondingInstitution: 'University of Somewhere',
      date: '2026-09-01',
      version: '2',
      type: 'new results',
      license: 'cc_by',
      category: 'cell biology',
      jatsxmlUrl: 'https://www.biorxiv.org/content/early/2026/09/01/2026.09.01.700001.source.xml',
      abstract: 'Kinetochores assemble on centromeric chromatin.',
      awards: ['R35GM134936'],
      publishedJournalDoi: '10.1038/s41586-026-00002-0',
      server: 'biorxiv',
    };
    const { abstract: _abstract, ...WITHOUT_ABSTRACT } = FULL;
    const MEDRXIV: PreprintRevision = {
      doi: '10.1101/2026.09.01.26300001',
      title: 'Cohort outcomes',
      abstract: 'A medRxiv abstract.',
      server: 'medrxiv',
    };

    async function call(args: Record<string, unknown>) {
      const result = await runToolContract(
        biorxivListRecentTool,
        { start_date: '2026-09-01', end_date: '2026-09-02', ...args } as never,
        { context: { errors: biorxivListRecentTool.errors } },
      );
      const structured = result.structuredContent as {
        preprints: Record<string, unknown>[];
        pagination: Record<string, unknown>;
        failed: unknown[];
        notice?: string;
      };
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      return { result, structured, text };
    }

    it('defaults to false', () => {
      const input = biorxivListRecentTool.input.parse({
        start_date: '2026-09-01',
        end_date: '2026-09-02',
      });
      expect(input.include_abstract).toBe(false);
    });

    it('omits the abstract by default on both surfaces and keeps every other field', async () => {
      mockGetListing.mockResolvedValue({ preprints: [FULL], pagination: { cursor: 0, total: 1 } });
      const { result, structured, text } = await call({ server: 'biorxiv' });

      expect(result.isError).toBeFalsy();
      expect(structured.preprints).toEqual([WITHOUT_ABSTRACT]);
      expect(text).not.toContain(FULL.abstract);
      for (const line of [
        `### ${FULL.title}`,
        `**DOI:** ${FULL.doi}`,
        '**Date:** 2026-09-01',
        '**Version:** 2',
        '**Type:** new results',
        '**Server:** biorxiv',
        '**Category:** cell biology',
        '**License:** cc_by',
        '**Authors:** Doe, J.; Roe, R.',
        '**Corresponding:** Jane Doe',
        '**Institution:** University of Somewhere',
        '**Awards:** R35GM134936',
        `**JATS XML:** ${FULL.jatsxmlUrl}`,
        `**Published DOI:** ${FULL.publishedJournalDoi}`,
      ]) {
        expect(text).toContain(line);
      }
    });

    it('true returns every record in full, the abstract on both surfaces', async () => {
      mockGetListing.mockResolvedValue({ preprints: [FULL], pagination: { cursor: 0, total: 1 } });
      const { structured, text } = await call({ server: 'biorxiv', include_abstract: true });
      expect(structured.preprints).toEqual([FULL]);
      expect(text).toContain(`\n\n${FULL.abstract}`);
    });

    it('describes the abstract as the latest-revision abstract in tools/list', () => {
      const schema = z.toJSONSchema(biorxivListRecentTool.output, {
        io: 'output',
      }) as unknown as {
        properties: {
          preprints: { items: { properties: Record<string, { description?: string }> } };
        };
      };
      const { abstract } = schema.properties.preprints.items.properties;
      expect(abstract?.description).toMatch(/latest-revision abstract/);
      expect(abstract?.description).toMatch(/include_abstract/);
    });

    it('types preprints[].server as the lowercase server enum, always present', () => {
      const output = (server?: string) => ({
        preprints: [{ doi: FULL.doi, server }],
        pagination: {},
        failed: [],
      });
      expect(() => biorxivListRecentTool.output.parse(output('biorxiv'))).not.toThrow();
      expect(() => biorxivListRecentTool.output.parse(output('medRxiv'))).toThrow();
      expect(() => biorxivListRecentTool.output.parse(output())).toThrow();
    });

    it('omits abstracts from both servers on a two-server page', async () => {
      mockGetListing.mockImplementation((server: string) =>
        Promise.resolve({
          preprints: [server === 'biorxiv' ? FULL : MEDRXIV],
          pagination: { cursor: 0, total: 1 },
        }),
      );
      const { structured, text } = await call({ server: 'both' });
      expect(structured.preprints.map((p) => p.doi)).toEqual([FULL.doi, MEDRXIV.doi]);
      for (const p of structured.preprints) expect(p).not.toHaveProperty('abstract');
      expect(text).not.toContain(FULL.abstract);
      expect(text).not.toContain(MEDRXIV.abstract);
    });

    it.each([false, true])(
      'keeps a partial failed[] result the same (include_abstract %s)',
      async (include_abstract) => {
        mockGetListing.mockImplementation((server: string) =>
          server === 'biorxiv'
            ? Promise.resolve({ preprints: [FULL], pagination: { cursor: 0, total: 1 } })
            : Promise.reject(new Error('medRxiv down')),
        );
        const { result, structured, text } = await call({ server: 'both', include_abstract });
        expect(result.isError).toBeFalsy();
        expect(structured.failed).toEqual([{ server: 'medrxiv', error: 'medRxiv down' }]);
        expect(structured.pagination).toEqual({ biorxiv: { cursor: 0, total: 1 } });
        expect(structured.notice).toMatch(/medRxiv did not answer/);
        expect(structured.preprints).toEqual([include_abstract ? FULL : WITHOUT_ABSTRACT]);
        expect(text).toContain('**medRxiv:** server did not answer');
      },
    );

    it.each([false, true])(
      'keeps an exhausted cursor the same (include_abstract %s)',
      async (include_abstract) => {
        mockGetListing.mockImplementation((server: string) =>
          Promise.resolve(
            server === 'biorxiv'
              ? { preprints: [FULL], pagination: { cursor: 30, total: 31 } }
              : { preprints: [], pagination: { cursor: 30, total: 0 } },
          ),
        );
        const { structured, text } = await call({ server: 'both', cursor: 30, include_abstract });
        expect(structured.pagination).toEqual({
          biorxiv: { cursor: 30, total: 31 },
          medrxiv: { cursor: 30, total: 0, exhausted: true },
        });
        expect(structured.notice).toMatch(/Cursor 30 is past the last available page on medRxiv/);
        expect(text).toContain('cursor exhausted');
      },
    );

    it.each([false, true])(
      'keeps an empty result the same (include_abstract %s)',
      async (include_abstract) => {
        mockGetListing.mockResolvedValue({ preprints: [], pagination: { cursor: 0, total: 0 } });
        const { result, structured } = await call({ server: 'biorxiv', include_abstract });
        expect(result.isError).toBeFalsy();
        expect(structured.preprints).toEqual([]);
        expect(structured.notice).toMatch(/No preprints found for dates 2026-09-01–2026-09-02/);
      },
    );
  });

  // ── Upstream Markdown ───────────────────────────────────────────────────────

  describe('upstream text with Markdown metacharacters', () => {
    const MARKDOWN_PREPRINT: PreprintRevision = {
      doi: IDENTIFIERS.doi,
      date: '2026-07-03',
      version: '1',
      server: 'biorxiv',
      title: UPSTREAM.title,
      abstract: UPSTREAM.abstract,
      authors: UPSTREAM.authors,
      authorCorresponding: UPSTREAM.authorCorresponding,
      authorCorrespondingInstitution: UPSTREAM.authorCorrespondingInstitution,
      awards: UPSTREAM.awards,
      category: UPSTREAM.category,
      license: UPSTREAM.license,
      type: UPSTREAM.type,
      jatsxmlUrl: IDENTIFIERS.jatsxmlUrl,
      publishedJournalDoi: IDENTIFIERS.publishedDoi,
    };

    async function call() {
      mockGetListing.mockResolvedValue({
        preprints: [MARKDOWN_PREPRINT],
        pagination: { cursor: 0, total: 1 },
      });
      const result = await runToolContract(
        biorxivListRecentTool,
        {
          start_date: '2026-07-01',
          end_date: '2026-07-03',
          server: 'biorxiv',
          include_abstract: true,
        } as never,
        { context: { errors: biorxivListRecentTool.errors } },
      );
      return { result, text: (result.content[0] as { text: string }).text };
    }

    it('carries upstream text unescaped in structuredContent', async () => {
      const { result } = await call();
      expect(
        (result.structuredContent as { preprints: PreprintRevision[] }).preprints[0],
      ).toMatchObject({
        title: UPSTREAM.title,
        abstract: UPSTREAM.abstract,
        authors: UPSTREAM.authors,
        awards: UPSTREAM.awards,
        jatsxmlUrl: IDENTIFIERS.jatsxmlUrl,
        publishedJournalDoi: IDENTIFIERS.publishedDoi,
      });
    });

    it('escapes every upstream field in content[], the line-initial abstract included', async () => {
      const { text } = await call();
      expect(text).toContain(`### ${ESCAPED.title}\n`);
      expect(text).toContain(`**Type:** ${ESCAPED.type}\n`);
      expect(text).toContain(`**Category:** ${ESCAPED.category}\n`);
      expect(text).toContain(`**License:** ${ESCAPED.license}\n`);
      expect(text).toContain(`**Authors:** ${ESCAPED.authors}\n`);
      expect(text).toContain(`**Corresponding:** ${ESCAPED.authorCorresponding}\n`);
      expect(text).toContain(`**Institution:** ${ESCAPED.authorCorrespondingInstitution}\n`);
      expect(text).toContain(`**Awards:** ${ESCAPED.awards}\n`);
      // The abstract opens its own line, where an unescaped `1. ` starts an ordered list.
      expect(text).toContain(`\n\n${ESCAPED.abstract}`);
      expect(text).not.toMatch(/^1\. /m);
    });

    it('leaves the DOI, JATS URL, and journal DOI unescaped in content[]', async () => {
      const { text } = await call();
      expect(text).toContain(`**DOI:** ${IDENTIFIERS.doi}\n`);
      expect(text).toContain(`**JATS XML:** ${IDENTIFIERS.jatsxmlUrl}\n`);
      expect(text).toContain(`**Published DOI:** ${IDENTIFIERS.publishedDoi}\n`);
    });
  });

  // ── Caller category in notices ──────────────────────────────────────────────

  describe('the caller category echoed into a notice', () => {
    /**
     * A category the validator accepts (it drops `_` and the spaces around the
     * name) that renders as emphasis unescaped.
     */
    const EMPHASIZED = '_Pathology_';

    async function lines(args: Record<string, unknown>) {
      const result = await runToolContract(
        biorxivListRecentTool,
        { start_date: '2026-09-01', end_date: '2026-09-02', ...args } as never,
        { context: { errors: biorxivListRecentTool.errors } },
      );
      return result.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')
        .split('\n');
    }

    it.each([
      [EMPHASIZED, '"\\_Pathology\\_"'],
      ['Pathology', '"Pathology"'],
    ])(
      'renders the ignored category %s as %s in the ignored-filter notice',
      async (category, quoted) => {
        mockGetListing.mockImplementation((server: string) =>
          Promise.resolve(
            server === 'biorxiv'
              ? { preprints: [], pagination: { cursor: 0, total: 0 }, categoryIgnored: true }
              : { ...LISTING_RESULT, preprints: [{ ...PREPRINT, server: 'medrxiv' }] },
          ),
        );

        expect(await lines({ server: 'both', category })).toContain(
          `> bioRxiv ignored the category filter ${quoted} and returned its unfiltered listing, so its records were left out — only the filtered results are shown.`,
        );
      },
    );

    it.each([
      [EMPHASIZED, '"\\_Pathology\\_"'],
      ['Pathology', '"Pathology"'],
    ])(
      'renders the category %s as %s in the no-results filter description',
      async (category, quoted) => {
        mockGetListing.mockResolvedValue({ preprints: [], pagination: { cursor: 0, total: 0 } });

        expect(await lines({ server: 'biorxiv', category })).toContain(
          `> No preprints found for dates 2026-09-01–2026-09-02, category ${quoted}, server "biorxiv". Try widening the date range or removing the category filter.`,
        );
      },
    );
  });
});
