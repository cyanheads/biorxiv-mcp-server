/**
 * @fileoverview End-to-end rate-limit test for biorxiv_search_preprints driving
 * the REAL EuropePmcService — the fetch is stubbed and `withRetry` is collapsed
 * to a single attempt so no test waits out a backoff; every line of
 * classification in between is the real one. The main tool suite mocks the
 * service away and drives a fixture, which cannot catch the service and the
 * tool disagreeing about what a 429 looks like; this suite closes that seam by
 * running a raw `fetchWithTimeout` 429 rejection through the service's
 * classification and out to the caller-visible error payload.
 * @module tests/tools/biorxiv-search-preprints.rate-limit.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivSearchPreprintsTool } from '@/mcp-server/tools/definitions/biorxiv-search-preprints.tool.js';
import { initEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import { EUROPE_PMC_RATE_LIMIT_BODY } from '../helpers/rate-limit.js';
import { recoveryHint, rejection } from '../helpers/rejection.js';

const mockFetch = vi.fn();

/**
 * Partial mock — everything except the fetch and retry primitives stays real, so
 * the framework's own utils imports keep working under the tool builder.
 */
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
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

/** Enrichment never runs — the search throws first — so a bare stub suffices. */
vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({ getDetails: vi.fn() }),
}));

/**
 * The rejection the real `fetchWithTimeout` produces for a non-2xx response.
 * A fixture resolving a `{ ok: false, status: 429 }` Response instead would be
 * inert — the service reads a rejection here, never a response.
 */
function httpError(status: number, retryAfter?: string): McpError {
  return new McpError(
    JsonRpcErrorCode.RateLimited,
    `Fetch failed for EuropePMC. Status: ${status}`,
    {
      status,
      statusText: 'Too Many Requests',
      body: EUROPE_PMC_RATE_LIMIT_BODY,
      statusCode: status,
      responseBody: EUROPE_PMC_RATE_LIMIT_BODY,
      ...(retryAfter !== undefined && { retryAfter }),
      errorSource: 'FetchHttpError',
    },
  );
}

describe('biorxivSearchPreprintsTool over the real EuropePmcService', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    initEuropePmcService({} as AppConfig, {} as StorageService);
  });

  it('surfaces an origin 429 to the caller as RateLimited with the origin wait', async () => {
    mockFetch.mockRejectedValue(httpError(429, '45'));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const err = await rejection(biorxivSearchPreprintsTool.handler(input, ctx));

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({
      reason: 'rate_limited',
      retryable: true,
      retryAfter: 45,
    });
    const hint = recoveryHint(err);
    expect(hint).toContain('45 seconds');
    expect(hint).toContain('biorxiv_list_recent');

    // Nothing from the upstream response body reaches the client surfaces.
    const serialized = JSON.stringify({ message: err.message, data: err.data });
    expect(serialized).not.toContain('429 Too Many Requests');
    expect(serialized).not.toContain('<html>');
    expect(err.data).not.toHaveProperty('body');
    expect(err.data).not.toHaveProperty('responseBody');
    expect(err.data).not.toHaveProperty('status');
    expect(err.data).not.toHaveProperty('statusCode');
  });

  it('reads an HTTP-date Retry-After through to the caller-visible wait', async () => {
    mockFetch.mockRejectedValue(httpError(429, new Date(Date.now() + 120_000).toUTCString()));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const err = await rejection(biorxivSearchPreprintsTool.handler(input, ctx));

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    const retryAfter = err.data?.retryAfter as number;
    expect(retryAfter).toBeGreaterThan(110);
    expect(retryAfter).toBeLessThanOrEqual(120);
    expect(recoveryHint(err)).toContain(`${retryAfter} seconds`);
  });

  it('falls back to a generic wait when the 429 carried no Retry-After', async () => {
    mockFetch.mockRejectedValue(httpError(429));
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const err = await rejection(biorxivSearchPreprintsTool.handler(input, ctx));

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data?.reason).toBe('rate_limited');
    expect(err.data?.retryAfter).toBeUndefined();
    expect(recoveryHint(err)).toContain('a minute or two');
  });

  it('leaves a non-429 origin failure as search_unavailable', async () => {
    mockFetch.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed for EuropePMC. Status: 503', {
        status: 503,
      }),
    );
    const ctx = createMockContext({ errors: biorxivSearchPreprintsTool.errors });
    const input = biorxivSearchPreprintsTool.input.parse({ query: 'CRISPR' });
    const err = await rejection(biorxivSearchPreprintsTool.handler(input, ctx));

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).toBe('search_unavailable');
    expect(err.data?.retryAfter).toBeUndefined();
  });
});
