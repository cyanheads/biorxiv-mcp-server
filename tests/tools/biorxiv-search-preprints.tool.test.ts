/**
 * @fileoverview Tests for biorxiv_search_preprints tool.
 * @module tests/tools/biorxiv-search-preprints.tool.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivSearchPreprintsTool } from '@/mcp-server/tools/definitions/biorxiv-search-preprints.tool.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';
import type { EuropePmcResult, EuropePmcSearchResult } from '@/services/europe-pmc/types.js';
import { europePmcRateLimitError, rateLimitError } from '../helpers/rate-limit.js';

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

/** Build an EuropePmcSearchResult with a given hitCount, result set, and optional next-page cursor */
function epmcSearchResult(
  hitCount: number,
  results: EuropePmcResult[],
  nextCursorMark?: string,
): EuropePmcSearchResult {
  return { hitCount, results, ...(nextCursorMark && { nextCursorMark }) };
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

/**
 * A revision carrying every latest-revision metadata field the details endpoint
 * exposes. Field values mirror the live v2 record for 10.64898/2026.01.24.701325,
 * whose upstream payload populates all four of the fields search used to drop
 * (`funder` arrives as an array upstream and is joined by the service).
 */
const RICH_REVISION: PreprintRevision = {
  ...REVISION,
  type: 'new results',
  license: 'cc_no',
  authorCorresponding: 'Qun Lu',
  authorCorrespondingInstitution: 'University of South Carolina',
  funder:
    "NIH Director's Transformative Research Award; Smart State Center for Economic Excellence of South Carolina",
  jatsxmlUrl: 'https://www.biorxiv.org/content/early/2026/07/01/2026.01.24.701325.source.xml',
  publishedJournalDoi: '10.1038/s41586-026-00001-0',
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

  // ── Author filter ─────────────────────────────────────────────────────────────

  it('threads author into the EuropePMC service call', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      author: 'Doudna J',
    });
    await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(mockEpmcSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'CRISPR', author: 'Doudna J' }),
      expect.anything(),
    );
  });

  it('accepts an author-only search with no keyword query', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ author: 'Doudna J' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(mockEpmcSearch).toHaveBeenCalledWith(
      expect.objectContaining({ author: 'Doudna J' }),
      expect.anything(),
    );
    const enrichment = getEnrichment(ctx);
    expect(enrichment.queryEcho).toMatchObject({ author: 'Doudna J' });
    expect(enrichment.queryEcho).not.toHaveProperty('query');
  });

  it('echoes both query and author in queryEcho', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR', author: 'Doudna J' });
    await biorxivSearchPreprintsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.queryEcho).toMatchObject({ query: 'CRISPR', author: 'Doudna J' });
  });

  it('rejects a request with neither query nor author at schema parse time', () => {
    expect(() => biorxivSearchPreprintsTool.input.parse({ server: 'biorxiv' })).toThrow();
  });

  it('rejects a whitespace-only author with no query at schema parse time', () => {
    expect(() => biorxivSearchPreprintsTool.input.parse({ author: '   ' })).toThrow();
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

  it('throws invalid_date_range for a calendar-impossible month in date_from', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      date_from: '2024-13-01',
    });
    await expect(biorxivSearchPreprintsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range for a day-of-month overflow in date_from (2024-02-30)', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      date_from: '2024-02-30',
    });
    await expect(biorxivSearchPreprintsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range for Feb 29 in a non-leap year (date_to)', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      date_to: '2023-02-29',
    });
    await expect(biorxivSearchPreprintsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('accepts a valid leap day (2024-02-29)', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      date_from: '2024-02-29',
      date_to: '2024-02-29',
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

  it('throws rate_limited, not search_unavailable, when EuropePMC returns 429', async () => {
    mockEpmcSearch.mockRejectedValue(europePmcRateLimitError(45));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const err = await biorxivSearchPreprintsTool.handler(input, ctx).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryable: true, retryAfter: 45 },
    });
  });

  it('names the wait and a still-answering origin in the rate_limited recovery hint', async () => {
    mockEpmcSearch.mockRejectedValue(europePmcRateLimitError(45));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const err = (await biorxivSearchPreprintsTool
      .handler(input, ctx)
      .catch((e: unknown) => e)) as McpError;

    const hint = (err.data?.recovery as { hint?: string } | undefined)?.hint ?? '';
    expect(hint).toContain('45 seconds');
    // The fallback must be a different origin — pointing back at EuropePMC
    // would send the caller straight into the same limit.
    expect(hint).toContain('biorxiv_list_recent');
    expect(hint).toContain('api.biorxiv.org');
  });

  it('renders a generic wait when the 429 carried no usable Retry-After', async () => {
    mockEpmcSearch.mockRejectedValue(europePmcRateLimitError());
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const err = (await biorxivSearchPreprintsTool
      .handler(input, ctx)
      .catch((e: unknown) => e)) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data?.reason).toBe('rate_limited');
    expect(err.data?.retryAfter).toBeUndefined();
    expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toContain(
      'a minute or two',
    );
  });

  it('keeps the upstream 429 response body out of the rate_limited payload', async () => {
    mockEpmcSearch.mockRejectedValue(europePmcRateLimitError(45));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const err = (await biorxivSearchPreprintsTool
      .handler(input, ctx)
      .catch((e: unknown) => e)) as McpError;

    const data = err.data ?? {};
    expect(JSON.stringify(data)).not.toContain('429 Too Many Requests');
    expect(JSON.stringify(data)).not.toContain('<html>');
    expect(data).not.toHaveProperty('body');
    expect(data).not.toHaveProperty('responseBody');
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('statusCode');
  });

  it('still raises search_unavailable for a non-429 EuropePMC failure', async () => {
    mockEpmcSearch.mockRejectedValue(new Error('Fetch failed for EuropePMC. Status: 503'));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const err = (await biorxivSearchPreprintsTool
      .handler(input, ctx)
      .catch((e: unknown) => e)) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).toBe('search_unavailable');
    expect(err.data?.retryAfter).toBeUndefined();
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

  it('labels a rate-limited enrichment rate_limited while still degrading to EuropePMC metadata', async () => {
    mockGetDetails.mockRejectedValue(rateLimitError(30));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);

    expect(result.partial_results).toBe(true);
    expect(result.preprints[0]).toMatchObject({
      enriched: false,
      enrichment_error: 'rate_limited',
      // EuropePMC metadata still stands in, exactly as for any other failure
      title: 'CRISPR gene editing in neural circuits',
      authors: 'Smith J, Jones A',
    });

    const text = (biorxivSearchPreprintsTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('enrichment_error: rate_limited');
    expect(text).toContain('rate-limited by api.biorxiv.org');
  });

  it('labels a rate-limited both-server enrichment rate_limited, not service_error', async () => {
    // Non-biorxiv DOI prefix routes through the Promise.allSettled branch
    mockEpmcSearch.mockResolvedValue(
      epmcSearchResult(1, [{ doi: '10.5678/some.other.preprint', title: 'Some other preprint' }]),
    );
    mockGetDetails.mockRejectedValue(rateLimitError(30));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'test' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints[0]?.enrichment_error).toBe('rate_limited');
  });

  it('does not report not_found when one server came back empty and the other never answered', async () => {
    // "Not indexed on the target server" is a claim about what the servers
    // reported, and only one of them reported.
    mockEpmcSearch.mockResolvedValue(
      epmcSearchResult(1, [{ doi: '10.5678/some.other.preprint', title: 'Some other preprint' }]),
    );
    mockGetDetails.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv' ? Promise.resolve([]) : Promise.reject(new Error('medrxiv down')),
    );
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'test' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints[0]).toMatchObject({
      enriched: false,
      enrichment_error: 'service_error',
    });
  });

  it('labels that same half-answered case rate_limited when the silent server was 429ed', async () => {
    mockEpmcSearch.mockResolvedValue(
      epmcSearchResult(1, [{ doi: '10.5678/some.other.preprint', title: 'Some other preprint' }]),
    );
    mockGetDetails.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv' ? Promise.resolve([]) : Promise.reject(rateLimitError(30)),
    );
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'test' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints[0]?.enrichment_error).toBe('rate_limited');
  });

  it('still reports not_found when every attempted server answered with nothing', async () => {
    mockGetDetails.mockResolvedValue([]);
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(result.preprints[0]).toMatchObject({
      enriched: false,
      enrichment_error: 'not_found',
    });
  });

  // ── Enrichment completeness ─────────────────────────────────────────────────

  it('carries every latest-revision metadata field into structuredContent and content[]', async () => {
    // The same DOI must not describe less through search than through
    // biorxiv_get_preprint — these four were dropped by the enriched projection.
    mockGetDetails.mockResolvedValue([RICH_REVISION]);
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR', server: 'biorxiv' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);

    expect(result.preprints[0]).toMatchObject({
      enriched: true,
      type: 'new results',
      license: 'cc_no',
      authorCorrespondingInstitution: 'University of South Carolina',
      funder:
        "NIH Director's Transformative Research Award; Smart State Center for Economic Excellence of South Carolina",
    });

    const text = (biorxivSearchPreprintsTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Type:** new results');
    expect(text).toContain('**License:** cc_no');
    expect(text).toContain('**Institution:** University of South Carolina');
    expect(text).toContain("**Funder:** NIH Director's Transformative Research Award");
  });

  it('leaves the new metadata fields absent when the revision does not carry them', async () => {
    mockGetDetails.mockResolvedValue([REVISION]);
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR', server: 'biorxiv' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);

    expect(result.preprints[0]?.type).toBeUndefined();
    expect(result.preprints[0]?.license).toBeUndefined();
    expect(result.preprints[0]?.funder).toBeUndefined();
    expect(result.preprints[0]?.authorCorrespondingInstitution).toBeUndefined();

    const text = (biorxivSearchPreprintsTool.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('**Type:**');
    expect(text).not.toContain('**Funder:**');
    expect(text).not.toContain('undefined');
  });

  it('validates the enriched result against the declared output schema', async () => {
    // The four added fields have to be in the Zod output too, not just the
    // handler's return type — structuredContent is validated against it.
    mockGetDetails.mockResolvedValue([RICH_REVISION]);
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR', server: 'biorxiv' });
    const result = await biorxivSearchPreprintsTool.handler(input, ctx);

    const parsed = biorxivSearchPreprintsTool.output.parse(result);
    expect(parsed.preprints[0]).toMatchObject({
      type: 'new results',
      license: 'cc_no',
      authorCorrespondingInstitution: 'University of South Carolina',
    });
    expect(parsed.preprints[0]?.funder).toContain('Smart State Center');
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

  // ── Cursor pagination ─────────────────────────────────────────────────────────

  it('threads cursor_mark input into the EuropePMC service call', async () => {
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      cursor_mark: 'AoJpage2',
    });
    await biorxivSearchPreprintsTool.handler(input, ctx);
    expect(mockEpmcSearch).toHaveBeenCalledWith(
      expect.objectContaining({ cursorMark: 'AoJpage2' }),
      expect.anything(),
    );
  });

  it('surfaces nextCursorMark and echoes cursor_mark when more pages exist', async () => {
    mockEpmcSearch.mockResolvedValue(epmcSearchResult(500, [EPMC_RESULT], 'AoJnextpage'));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({
      query: 'CRISPR',
      cursor_mark: 'AoJpage1',
    });
    await biorxivSearchPreprintsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.nextCursorMark).toBe('AoJnextpage');
    expect(enrichment.queryEcho).toMatchObject({ cursor_mark: 'AoJpage1' });
  });

  it('omits nextCursorMark and cursor_mark echo on the last page', async () => {
    // Default beforeEach mock returns no nextCursorMark → last page
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    await biorxivSearchPreprintsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.nextCursorMark).toBeUndefined();
    expect(enrichment.queryEcho).not.toHaveProperty('cursor_mark');
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
