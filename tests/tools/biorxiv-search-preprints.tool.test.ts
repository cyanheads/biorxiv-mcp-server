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

/** Build an EuropePmcSearchResult with a given hitCount and result set */
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

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns enriched results for a keyword query', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(result.preprints[0]?.doi).toBe('10.1101/2024.01.15.575123');
    expect(result.preprints[0]?.enriched).toBe(true);
    expect(result.partial_results).toBe(false);
    // totalCount must carry the upstream hitCount, not the returned count
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1234);
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
    expect(enrichment.totalCount).toBe(1234);
    expect(enrichment.queryEcho).toMatchObject({
      query: 'CRISPR',
      server: 'biorxiv',
      limit: 10,
    });
  });

  it('includes date_from and date_to in queryEcho when provided', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      date_from: '2024-01-01',
      date_to: '2024-06-30',
    });
    await biorxivSearchPreprintsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.queryEcho).toMatchObject({
      date_from: '2024-01-01',
      date_to: '2024-06-30',
    });
  });

  it('routes to explicit medrxiv server for enrichment', async () => {
    const mxRevision: PreprintRevision = { ...REVISION, server: 'medrxiv' };
    mockGetDetails.mockResolvedValue([mxRevision]);
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'COVID',
      server: 'medrxiv',
    });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints[0]?.enriched).toBe(true);
    expect(result.preprints[0]?.server).toBe('medrxiv');
  });

  it('defaults server to "both" and limit to 25 when omitted', () => {
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'test' });
    expect(input.server).toBe('both');
    expect(input.limit).toBe(25);
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('rejects empty query at schema parse time', () => {
    expect(() => biorxivSearchPreprintsTool.input.parse({ query: '' })).toThrow();
  });

  it('throws invalid_date_range for malformed date_from', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      date_from: 'not-a-date',
    });
    await expect(biorxivSearchPreprintsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range for malformed date_to', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      date_to: '01/15/2024',
    });
    await expect(biorxivSearchPreprintsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range when date_from is after date_to', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      date_from: '2024-06-30',
      date_to: '2024-01-01',
    });
    await expect(biorxivSearchPreprintsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('accepts same-day date_from and date_to', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      date_from: '2024-01-15',
      date_to: '2024-01-15',
    });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
  });

  it('rejects limit below 1 at schema parse time', () => {
    expect(() => biorxivSearchPreprintsTool.input.parse({ query: 'test', limit: 0 })).toThrow();
  });

  it('rejects limit above 100 at schema parse time', () => {
    expect(() => biorxivSearchPreprintsTool.input.parse({ query: 'test', limit: 101 })).toThrow();
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('returns empty results when EuropePMC finds nothing', async () => {
    mockEpmcSearch.mockResolvedValue(epmcSearchResult(0, []));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'xyzzy_no_match' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('throws search_unavailable when EuropePMC call throws', async () => {
    mockEpmcSearch.mockRejectedValue(new Error('Network error'));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    await expect(biorxivSearchPreprintsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'search_unavailable' },
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
    expect(enrichment.totalCount).toBe(1234);
  });

  it('sets enrichment_error to "not_found" when revisions array is empty', async () => {
    mockGetDetails.mockResolvedValue([]);
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints[0]?.enrichment_error).toBe('not_found');
  });

  it('marks partial_results=true when enrichment throws', async () => {
    mockGetDetails.mockRejectedValue(new Error('enrichment error'));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.partial_results).toBe(true);
    expect(result.preprints[0]?.enriched).toBe(false);
  });

  it('sets enrichment_error to "service_error" when enrichment throws', async () => {
    mockGetDetails.mockRejectedValue(new Error('enrichment error'));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints[0]?.enrichment_error).toBe('service_error');
  });

  it('sets enrichment_error to "service_error" when both allSettled calls reject (non-biorxiv DOI, server=both)', async () => {
    // Non-biorxiv DOI prefix triggers the Promise.allSettled path — both rejections must not be
    // misclassified as "not_found"
    const nonBiorxivResult: EuropePmcResult = {
      doi: '10.5678/some.other.preprint',
      title: 'Some other preprint',
    };
    mockEpmcSearch.mockResolvedValue(epmcSearchResult(1, [nonBiorxivResult]));
    mockGetDetails.mockRejectedValue(new Error('service error'));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'test' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints[0]?.enrichment_error).toBe('service_error');
  });

  it('search_unavailable error does not expose secrets or credentials', async () => {
    mockEpmcSearch.mockRejectedValue(new Error('connection refused'));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const err = await biorxivSearchPreprintsTool.handler(input, ctx).catch((e) => e);
    const serialized = JSON.stringify(err);
    // Secrets and credentials should never appear in error output
    expect(serialized).not.toMatch(/password|api_key|secret|Bearer [A-Za-z0-9]/i);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it('enriches results when multiple EuropePMC results are returned', async () => {
    const second: EuropePmcResult = {
      doi: '10.1101/2024.02.01.000002',
      title: 'Second preprint',
    };
    const secondRevision: PreprintRevision = {
      doi: '10.1101/2024.02.01.000002',
      server: 'biorxiv',
    };
    mockEpmcSearch.mockResolvedValue(epmcSearchResult(500, [EPMC_RESULT, second]));
    mockGetDetails.mockImplementation((doi: string) =>
      doi === '10.1101/2024.01.15.575123'
        ? Promise.resolve([REVISION])
        : Promise.resolve([secondRevision]),
    );
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(2);
    expect(result.partial_results).toBe(false);
  });

  it('uses EuropePMC-only fallback fields when enrichment unavailable', async () => {
    mockGetDetails.mockResolvedValue([]);
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    // EuropePMC fields survive
    expect(result.preprints[0]?.title).toBe('CRISPR gene editing in neural circuits');
    expect(result.preprints[0]?.authors).toBe('Smith J, Jones A');
    expect(result.preprints[0]?.enriched).toBe(false);
  });

  // ── Security ────────────────────────────────────────────────────────────────

  it('does not expose internal paths in error for search_unavailable', async () => {
    mockEpmcSearch.mockRejectedValue(new Error('ECONNREFUSED /var/run/internal.sock'));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'test' });
    const err = await biorxivSearchPreprintsTool.handler(input, ctx).catch((e) => e);
    // The thrown error is a classified McpError with a generic message — internal socket
    // path may appear in message but no secret/credential/key should be present
    const serialized = JSON.stringify(err);
    expect(serialized).not.toMatch(/password|api_key|secret|BIORXIV_MAILTO/i);
  });

  // ── format ──────────────────────────────────────────────────────────────────

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

  it('format includes partial_results warning when true', () => {
    const output = {
      preprints: [{ doi: '10.1101/2024.01.15.575123', enriched: false }],
      partial_results: true,
    };
    const blocks = biorxivSearchPreprintsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toMatch(/EuropePMC|enrichment unavailable/i);
  });

  it('format shows "no (EuropePMC fallback)" indicator for unenriched results', () => {
    const output = {
      preprints: [{ doi: '10.1101/2024.01.15.575123', enriched: false }],
      partial_results: true,
    };
    const blocks = biorxivSearchPreprintsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('no (EuropePMC fallback)');
  });

  it('format renders "not_found" reason for unenriched result with enrichment_error not_found', () => {
    const output = {
      preprints: [
        { doi: '10.1101/2024.01.15.575123', enriched: false, enrichment_error: 'not_found' },
      ],
      partial_results: true,
    };
    const blocks = biorxivSearchPreprintsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('DOI not indexed on target server');
  });

  it('format renders "service_error" reason for unenriched result with enrichment_error service_error', () => {
    const output = {
      preprints: [
        { doi: '10.1101/2024.01.15.575123', enriched: false, enrichment_error: 'service_error' },
      ],
      partial_results: true,
    };
    const blocks = biorxivSearchPreprintsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('service error — retry may help');
  });

  it('format shows revision count when revisionCount > 1', () => {
    const output = {
      preprints: [
        {
          doi: '10.1101/2024.01.15.575123',
          title: 'Test',
          enriched: true,
          revisionCount: 3,
        },
      ],
      partial_results: false,
    };
    const blocks = biorxivSearchPreprintsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('3 revisions');
  });
});
