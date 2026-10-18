/**
 * @fileoverview Tests for biorxiv_get_preprint tool.
 * @module tests/tools/biorxiv-get-preprint.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetPreprintTool } from '@/mcp-server/tools/definitions/biorxiv-get-preprint.tool.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';
import { CALL_BUDGET_MS } from '@/services/shared.js';
import {
  answerAfter,
  type LegStub,
  neverAnswers,
  routeLegs,
  settle,
} from '../helpers/call-budget.js';
import { ESCAPED, IDENTIFIERS, UPSTREAM } from '../helpers/markdown-fixtures.js';
import {
  declaredRateLimitRecovery,
  RATE_LIMIT_RECOVERY_OPENING,
  rateLimitError,
} from '../helpers/rate-limit.js';
import { envelopeHint, recoveryHint, rejection } from '../helpers/rejection.js';

const mockGetDetails = vi.fn();

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({ getDetails: mockGetDetails }),
}));

const REVISION: PreprintRevision = {
  doi: '10.1101/2024.01.15.575123',
  title: 'Test Preprint Title',
  authors: 'Smith J, Jones A',
  date: '2024-01-15',
  version: '1',
  category: 'Neuroscience',
  server: 'biorxiv',
  abstract: 'This is the abstract.',
};

describe('biorxivGetPreprintTool', () => {
  beforeEach(() => {
    mockGetDetails.mockResolvedValue([REVISION]);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns revisions for a valid DOI', async () => {
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123'],
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(result.preprints[0]?.doi).toBe('10.1101/2024.01.15.575123');
    expect(result.preprints[0]?.revisions).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it('accepts the alternative 10.64898/ DOI prefix', async () => {
    const altRevision: PreprintRevision = { doi: '10.64898/2026.05.07.723463', title: 'Alt' };
    mockGetDetails.mockResolvedValue([altRevision]);
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.64898/2026.05.07.723463'],
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it('resolves multiple DOIs in one call and returns all', async () => {
    const second: PreprintRevision = { doi: '10.1101/2024.02.01.000002', title: 'Second' };
    mockGetDetails.mockImplementation((doi: string) =>
      doi === '10.1101/2024.01.15.575123' ? Promise.resolve([REVISION]) : Promise.resolve([second]),
    );
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123', '10.1101/2024.02.01.000002'],
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it('fans out both servers when server="both" and merges results', async () => {
    const bxRevision: PreprintRevision = { doi: '10.1101/2024.01.15.575123', server: 'biorxiv' };
    mockGetDetails.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv' ? Promise.resolve([bxRevision]) : Promise.resolve([]),
    );
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123'],
      server: 'both',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it('reports partial success with failed DOIs alongside successful ones', async () => {
    mockGetDetails.mockImplementation((doi: string) => {
      if (doi === '10.1101/2024.01.15.575123') return Promise.resolve([REVISION]);
      return Promise.resolve([]);
    });
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123', '10.1101/2024.01.01.000001'],
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
  });

  it('puts service-thrown errors into failed[] rather than aborting the batch', async () => {
    mockGetDetails.mockImplementation((doi: string) => {
      if (doi === '10.1101/2024.01.15.575123') return Promise.resolve([REVISION]);
      return Promise.reject(new Error('upstream timeout'));
    });
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123', '10.1101/2024.01.01.000001'],
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toContain('upstream timeout');
    expect(result.failed[0]?.reason).toBe('upstream_unavailable');
    expect(result.failed[0]?.retryable).toBe(true);
  });

  it('discriminates a not-found DOI from an upstream failure in the same batch', async () => {
    mockGetDetails.mockImplementation((doi: string) => {
      if (doi === '10.1101/2024.01.15.575123') return Promise.resolve([REVISION]);
      if (doi === '10.1101/2024.01.01.000001') return Promise.resolve([]);
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123', '10.1101/2024.01.01.000001', '10.1101/2024.02.02.000002'],
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    const byDoi = Object.fromEntries(result.failed.map((f) => [f.doi, f]));
    expect(byDoi['10.1101/2024.01.01.000001']).toMatchObject({
      reason: 'not_found',
      retryable: false,
    });
    expect(byDoi['10.1101/2024.02.02.000002']).toMatchObject({
      reason: 'upstream_unavailable',
      retryable: true,
    });
  });

  it('marks a DOI upstream_unavailable when one server fails and the other returns empty', async () => {
    // bioRxiv never answers; medRxiv answers empty for the first DOI and holds the second.
    // The first DOI is therefore not established as absent, even though a server replied.
    mockGetDetails.mockImplementation((doi: string, server: string) => {
      if (server === 'biorxiv') return Promise.reject(new Error('network error'));
      return doi === '10.1101/2024.02.02.000002'
        ? Promise.resolve([REVISION])
        : Promise.resolve([]);
    });
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123', '10.1101/2024.02.02.000002'],
      server: 'both',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      doi: '10.1101/2024.01.15.575123',
      reason: 'upstream_unavailable',
      retryable: true,
    });
    expect(result.failed[0]?.error).toContain('biorxiv');
  });

  it('reports not_found when every attempted server answered with an empty collection', async () => {
    // One DOI resolves so the handler returns instead of throwing the batch error
    mockGetDetails.mockImplementation((doi: string) =>
      doi === '10.1101/2024.01.15.575123' ? Promise.resolve([REVISION]) : Promise.resolve([]),
    );
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123', '10.1101/2024.01.01.000001'],
      server: 'both',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ reason: 'not_found', retryable: false });
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('throws invalid_doi_format for malformed DOI', async () => {
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({ dois: ['not-a-doi'] });
    await expect(biorxivGetPreprintTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_doi_format' },
    });
  });

  it('rejects empty dois array at schema parse time', () => {
    expect(() => biorxivGetPreprintTool.input.parse({ dois: [] })).toThrow();
  });

  it('accepts 200 dois entries and rejects a 201st at schema parse time', () => {
    const entries = (n: number) =>
      Array.from({ length: n }, (_, i) => `10.1101/2024.01.01.${String(i + 1).padStart(6, '0')}`);
    expect(biorxivGetPreprintTool.input.parse({ dois: entries(200) }).dois).toHaveLength(200);
    expect(() => biorxivGetPreprintTool.input.parse({ dois: entries(201) })).toThrow(/200/);
  });

  it('defaults server to "both" when omitted', () => {
    const input = biorxivGetPreprintTool.input.parse({ dois: ['10.1101/2024.01.15.575123'] });
    expect(input.server).toBe('both');
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('throws doi_not_found when all DOIs return empty collections', async () => {
    mockGetDetails.mockResolvedValue([]);
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({ dois: ['10.1101/2024.01.01.000001'] });
    await expect(biorxivGetPreprintTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found' },
    });
  });

  it('throws doi_not_found when both servers return empty collections for server="both"', async () => {
    mockGetDetails.mockResolvedValue([]);
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.01.000001'],
      server: 'both',
    });
    await expect(biorxivGetPreprintTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found' },
    });
  });

  it('throws retryable upstream_unavailable when all DOIs are service errors in both-server mode', async () => {
    mockGetDetails.mockRejectedValue(new Error('network error'));
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.01.000001'],
      server: 'both',
    });
    await expect(biorxivGetPreprintTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true },
    });
  });

  it('throws retryable upstream_unavailable when the lone server errors in single-server mode', async () => {
    mockGetDetails.mockRejectedValue(new Error('network error'));
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.01.000001'],
      server: 'biorxiv',
    });
    await expect(biorxivGetPreprintTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true },
    });
  });

  it('recovery hint for upstream_unavailable tells the caller to retry, not to verify the DOI', async () => {
    mockGetDetails.mockRejectedValue(new Error('network error'));
    const result = await runToolContract(
      biorxivGetPreprintTool,
      { dois: ['10.1101/2024.01.01.000001'], server: 'both' } as never,
      { context: { errors: biorxivGetPreprintTool.errors } },
    );
    expect(result.isError).toBe(true);
    expect(envelopeHint(result)).toMatch(/retry/i);
    expect(envelopeHint(result)).not.toMatch(/verify the doi/i);
  });

  it('throws upstream_unavailable when one DOI is a service error and the rest are not found', async () => {
    mockGetDetails.mockImplementation((doi: string) =>
      doi === '10.1101/2024.01.01.000001'
        ? Promise.resolve([])
        : Promise.reject(new Error('network error')),
    );
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.01.000001', '10.1101/2024.02.02.000002'],
      server: 'biorxiv',
    });
    await expect(biorxivGetPreprintTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true },
    });
  });

  // ── Rate limiting ───────────────────────────────────────────────────────────

  it('declares a rate_limited recovery that holds when the origin named no wait', () => {
    expect(declaredRateLimitRecovery(biorxivGetPreprintTool.errors)).toBe(
      `${RATE_LIMIT_RECOVERY_OPENING}retrying — every preprint metadata tool queries the same origin, so none of them will answer sooner.`,
    );
  });

  it('marks a rate-limited DOI rate_limited in failed[] and carries the wait, keeping the batch alive', async () => {
    mockGetDetails.mockImplementation((doi: string) =>
      doi === '10.1101/2024.01.15.575123'
        ? Promise.resolve([REVISION])
        : Promise.reject(rateLimitError(30)),
    );
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123', '10.1101/2024.01.01.000001'],
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);

    expect(result.preprints).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      doi: '10.1101/2024.01.01.000001',
      reason: 'rate_limited',
      retryable: true,
      retryAfter: 30,
    });

    // The wait has to reach content[] too — a format()-only client would
    // otherwise see a retryable failure with no interval attached to it.
    const text = (biorxivGetPreprintTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('rate_limited, retryable: true, retry after: 30s');
  });

  it('leaves a generic upstream failure classified upstream_unavailable with no wait', async () => {
    mockGetDetails.mockImplementation((doi: string) =>
      doi === '10.1101/2024.01.15.575123'
        ? Promise.resolve([REVISION])
        : Promise.reject(new Error('ECONNREFUSED')),
    );
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123', '10.1101/2024.01.01.000001'],
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.failed[0]?.reason).toBe('upstream_unavailable');
    expect(result.failed[0]?.retryAfter).toBeUndefined();
  });

  it('throws retryable rate_limited when every DOI was rate-limited', async () => {
    mockGetDetails.mockRejectedValue(rateLimitError(30));
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.01.000001'],
      server: 'both',
    });
    const err = await rejection(biorxivGetPreprintTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryable: true, retryAfter: 30 },
    });
    expect(recoveryHint(err)).toContain('30 seconds');
    expect(recoveryHint(err)).toContain('api.biorxiv.org');
  });

  it('prefers rate_limited over upstream_unavailable when the batch mixes the two', async () => {
    // Both say "retry"; only the rate limit says when, and retrying sooner would
    // land straight back inside the origin's limit.
    mockGetDetails.mockImplementation((doi: string) =>
      doi === '10.1101/2024.01.01.000001'
        ? Promise.reject(rateLimitError(45))
        : Promise.reject(new Error('ECONNREFUSED')),
    );
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.01.000001', '10.1101/2024.02.02.000002'],
      server: 'biorxiv',
    });
    const err = await rejection(biorxivGetPreprintTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: 45 },
    });
    // Both failures still reach the message, so the outage is not hidden
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).toContain('rate-limiting');
  });

  it('omits retryAfter when the rate limit carried no usable Retry-After', async () => {
    mockGetDetails.mockRejectedValue(rateLimitError());
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.01.000001'],
      server: 'biorxiv',
    });
    const err = await rejection(biorxivGetPreprintTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data?.retryAfter).toBeUndefined();
    expect(recoveryHint(err)).toContain('a minute or two');
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it('handles sparse upstream payload without fabricating data', async () => {
    const sparse: PreprintRevision = { doi: '10.1101/2024.01.15.575123' };
    mockGetDetails.mockResolvedValue([sparse]);
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({ dois: ['10.1101/2024.01.15.575123'] });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints[0]?.revisions[0]?.title).toBeUndefined();
    expect(result.preprints[0]?.revisions[0]?.abstract).toBeUndefined();
  });

  it('handles multiple revisions for same DOI and returns them all', async () => {
    const rev2: PreprintRevision = { ...REVISION, version: '2', date: '2024-03-01' };
    mockGetDetails.mockResolvedValue([REVISION, rev2]);
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    // Use explicit single server to avoid double fan-out in "both" mode
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123'],
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints[0]?.revisions).toHaveLength(2);
  });

  // ── Batch cap and remainder ─────────────────────────────────────────────────

  describe('batch cap and remainder', () => {
    /** `n` distinct bare DOIs, numbered from `from`. */
    const dois = (n: number, from = 1) =>
      Array.from(
        { length: n },
        (_, i) => `10.1101/2024.01.01.${String(from + i).padStart(6, '0')}`,
      );
    const FIRST_10 = dois(10);
    const [ELEVENTH] = dois(1, 11) as [string];

    /** bioRxiv holds every DOI; medRxiv answers with an empty collection. */
    const onBiorxiv = (doi: string, server: string) =>
      Promise.resolve(server === 'biorxiv' ? [{ doi, version: '1', server: 'biorxiv' }] : []);
    const entry = (doi: string) => ({
      doi,
      revisions: [{ doi, version: '1', server: 'biorxiv' }],
    });
    /** Every lookup made, as `server:doi`, sorted. */
    const lookups = () =>
      mockGetDetails.mock.calls.map(([doi, server]) => `${String(server)}:${String(doi)}`).sort();
    const bothServers = (list: string[]) =>
      list.flatMap((doi) => [`biorxiv:${doi}`, `medrxiv:${doi}`]).sort();

    async function contract(input: Record<string, unknown>) {
      const result = await runToolContract(biorxivGetPreprintTool, input as never, {
        context: { errors: biorxivGetPreprintTool.errors },
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      return { result, structured: result.structuredContent as Record<string, unknown>, text };
    }

    beforeEach(() => {
      mockGetDetails.mockReset();
      mockGetDetails.mockImplementation(onBiorxiv);
    });

    it('looks up the first 10 distinct DOIs and returns the 11th in unprocessed on both surfaces', async () => {
      const { result, structured, text } = await contract({
        dois: [...FIRST_10, ELEVENTH],
        server: 'both',
      });

      expect(result.isError).toBeFalsy();
      expect(mockGetDetails).toHaveBeenCalledTimes(20);
      expect(lookups()).toEqual(bothServers(FIRST_10));
      expect(structured.preprints).toEqual(FIRST_10.map(entry));
      expect(structured.failed).toEqual([]);
      expect(structured.unprocessed).toEqual([ELEVENTH]);
      expect(structured).toMatchObject({ truncated: true, shown: 10, cap: 10 });
      expect(structured.notice).toBe(
        'Looked up the first 10 distinct DOIs; 1 more is in unprocessed — pass unprocessed as dois in another call to continue.',
      );
      expect(text).toContain(`## Unprocessed DOIs (1)\n- ${ELEVENTH}`);
      expect(text).toContain(
        '> Looked up the first 10 distinct DOIs; 1 more is in unprocessed — pass unprocessed as dois in another call to continue.',
      );
    });

    it('10 distinct DOIs: unprocessed is empty and the rest of the output is unchanged', async () => {
      const { structured, text } = await contract({ dois: FIRST_10, server: 'both' });

      expect(mockGetDetails).toHaveBeenCalledTimes(20);
      expect(structured).toEqual({ preprints: FIRST_10.map(entry), failed: [], unprocessed: [] });
      expect(text).not.toContain('Unprocessed');
      expect(text).not.toContain('not looked up');
    });

    it('looks up 10 of 200 entries and returns the other 190 in input order', async () => {
      const all = dois(200);
      const { structured, text } = await contract({ dois: all, server: 'both' });

      expect(mockGetDetails).toHaveBeenCalledTimes(20);
      expect(structured.unprocessed).toEqual(all.slice(10));
      expect(structured).toMatchObject({ truncated: true, shown: 10, cap: 10 });
      // Every one of the 190, in input order, on the content surface too.
      const listed = all
        .slice(10)
        .map((doi) => `- ${doi}`)
        .join('\n');
      expect(text).toContain(`## Unprocessed DOIs (190)\n${listed}\n`);
    });

    it('rejects 201 entries with -32602, naming the 200 ceiling', async () => {
      const { result } = await contract({ dois: dois(201), server: 'both' });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: number; message: string } };
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain('<=200');
      expect(mockGetDetails).not.toHaveBeenCalled();
    });

    it('an invalid entry takes no place: "not-a-doi" plus 10 valid DOIs looks up all 10', async () => {
      const { structured } = await contract({ dois: ['not-a-doi', ...FIRST_10], server: 'both' });

      expect(lookups()).toEqual(bothServers(FIRST_10));
      expect(structured.preprints).toEqual(FIRST_10.map(entry));
      expect(structured.failed).toEqual([
        expect.objectContaining({ doi: 'not-a-doi', reason: 'invalid_doi_format' }),
      ]);
      expect(structured.unprocessed).toEqual([]);
    });

    it('an invalid entry past the cap goes to failed[], never unprocessed', async () => {
      const { structured } = await contract({
        dois: [...FIRST_10, 'not-a-doi', ELEVENTH],
        server: 'both',
      });

      expect(lookups()).toEqual(bothServers(FIRST_10));
      expect(structured.failed).toEqual([
        expect.objectContaining({ doi: 'not-a-doi', reason: 'invalid_doi_format' }),
      ]);
      expect(structured.unprocessed).toEqual([ELEVENTH]);
    });

    it('one DOI sent bare, as a doi.org URL, and with a v1 suffix is one lookup and one entry', async () => {
      const [doi] = FIRST_10 as [string];
      const { structured } = await contract({
        dois: [doi, `https://doi.org/${doi}`, `${doi}v1`],
        server: 'both',
      });

      expect(lookups()).toEqual(bothServers([doi]));
      expect(structured).toEqual({ preprints: [entry(doi)], failed: [], unprocessed: [] });
    });

    it('a repeated DOI takes no place under the cap', async () => {
      const repeats = FIRST_10.slice(0, 5).map((doi) => `doi:${doi}`);
      const { structured } = await contract({ dois: [...FIRST_10, ...repeats], server: 'both' });

      expect(mockGetDetails).toHaveBeenCalledTimes(20);
      expect(structured.preprints).toEqual(FIRST_10.map(entry));
      expect(structured.unprocessed).toEqual([]);
    });

    it('keeps preprints, failed, and unprocessed in input order on both surfaces when earlier lookups answer last', async () => {
      vi.useFakeTimers();
      try {
        const v = dois(12);
        const outcome = (doi: string, server: string) => {
          if (doi === v[1]) return Promise.resolve([]);
          if (doi === v[3]) return Promise.reject(new Error('ECONNREFUSED'));
          return onBiorxiv(doi, server);
        };
        // Each lookup answers 1 s later than the one after it, so completion order is input order reversed.
        mockGetDetails.mockImplementation((doi: string, server: string) =>
          answerAfter(1_000 * (12 - v.indexOf(doi)), undefined).then(() => outcome(doi, server)),
        );
        const input = [v[0], v[1], 'bad-doi', ...v.slice(2, 10), v[10], `doi:${v[0]}`, v[11]];
        const { value } = await settle(
          runToolContract(biorxivGetPreprintTool, { dois: input, server: 'both' } as never, {
            context: { errors: biorxivGetPreprintTool.errors },
          }),
        );
        const result = value as Awaited<ReturnType<typeof runToolContract>>;
        const structured = result.structuredContent as Record<string, { doi: string }[]>;
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

        const found = [v[0], v[2], ...v.slice(4, 10)];
        expect(structured.preprints?.map((p) => p.doi)).toEqual(found);
        expect(structured.failed?.map((f) => f.doi)).toEqual([v[1], 'bad-doi', v[3]]);
        expect(structured.failed).toMatchObject([
          { reason: 'not_found' },
          { reason: 'invalid_doi_format' },
          { reason: 'upstream_unavailable' },
        ]);
        expect(structured.unprocessed).toEqual([v[10], v[11]]);
        // content[] lists each section in the same input order.
        expect([...text.matchAll(/^### (.+)$/gm)].map(([, doi]) => doi)).toEqual(found);
        expect([...text.matchAll(/^- \*\*(.+?)\*\*:/gm)].map(([, doi]) => doi)).toEqual([
          v[1],
          'bad-doi',
          v[3],
        ]);
        expect(text).toContain(`## Unprocessed DOIs (2)\n- ${v[10]}\n- ${v[11]}\n`);
      } finally {
        vi.useRealTimers();
      }
    });

    it('11 DOIs whose first 10 are not found return 10 not_found entries and 1 unprocessed, not doi_not_found', async () => {
      mockGetDetails.mockResolvedValue([]);
      const { result, structured } = await contract({
        dois: [...FIRST_10, ELEVENTH],
        server: 'both',
      });

      expect(result.isError).toBeFalsy();
      expect(structured.preprints).toEqual([]);
      expect(structured.failed).toEqual(
        FIRST_10.map((doi) => ({
          doi,
          error: 'Not found on bioRxiv or medRxiv.',
          reason: 'not_found',
          retryable: false,
        })),
      );
      expect(structured.unprocessed).toEqual([ELEVENTH]);
      // A not_found entry will not change on retry, so the notice names none.
      expect(structured.notice).toBe(
        'Looked up the first 10 distinct DOIs; 1 more is in unprocessed — pass unprocessed as dois in another call to continue.',
      );
    });

    it('11 DOIs whose first 10 failed upstream return them retryable alongside the unprocessed one', async () => {
      mockGetDetails.mockRejectedValue(new Error('ECONNREFUSED'));
      const { result, structured, text } = await contract({
        dois: [...FIRST_10, ELEVENTH],
        server: 'both',
      });

      expect(result.isError).toBeFalsy();
      expect(structured.failed).toEqual(
        FIRST_10.map((doi) =>
          expect.objectContaining({ doi, reason: 'upstream_unavailable', retryable: true }),
        ),
      );
      expect(structured.unprocessed).toEqual([ELEVENTH]);
      // Following the remainder recipe alone would never retry these ten.
      const notice =
        'Looked up the first 10 distinct DOIs; 1 more is in unprocessed — pass unprocessed as dois in another call to continue. 10 failed[] entries are retryable — include their DOIs in a later call, after any retryAfter wait.';
      expect(structured.notice).toBe(notice);
      expect(text).toContain(`> ${notice}`);
    });

    it('names the retryable failed[] entries next to the remainder, counting only rate_limited and upstream_unavailable', async () => {
      const v = dois(12);
      mockGetDetails.mockImplementation((doi: string, server: string) => {
        if (doi === v[0]) return Promise.reject(rateLimitError(30));
        if (doi === v[1]) return Promise.reject(new Error('ECONNREFUSED'));
        if (doi === v[2]) return Promise.resolve([]);
        return onBiorxiv(doi, server);
      });
      const { structured, text } = await contract({ dois: [...v, 'not-a-doi'], server: 'both' });

      expect(structured.failed).toMatchObject([
        { doi: v[0], reason: 'rate_limited', retryable: true, retryAfter: 30 },
        { doi: v[1], reason: 'upstream_unavailable', retryable: true },
        { doi: v[2], reason: 'not_found', retryable: false },
        { doi: 'not-a-doi', reason: 'invalid_doi_format', retryable: false },
      ]);
      expect(structured.unprocessed).toEqual([v[10], v[11]]);
      const notice =
        'Looked up the first 10 distinct DOIs; 2 more are in unprocessed — pass unprocessed as dois in another call to continue. 2 failed[] entries are retryable — include their DOIs in a later call, after any retryAfter wait.';
      expect(structured.notice).toBe(notice);
      expect(text).toContain(`> ${notice}`);
    });

    it('names one retryable failed[] entry in the singular', async () => {
      mockGetDetails.mockImplementation((doi: string, server: string) =>
        doi === FIRST_10[4] ? Promise.reject(rateLimitError(5)) : onBiorxiv(doi, server),
      );
      const { structured, text } = await contract({
        dois: [...FIRST_10, ELEVENTH],
        server: 'both',
      });

      const notice =
        'Looked up the first 10 distinct DOIs; 1 more is in unprocessed — pass unprocessed as dois in another call to continue. 1 failed[] entry is retryable — include its DOI in a later call, after any retryAfter wait.';
      expect(structured.notice).toBe(notice);
      expect(text).toContain(`> ${notice}`);
    });

    it('more than 10 entries that are all invalid still raise invalid_doi_format', async () => {
      const bad = Array.from({ length: 12 }, (_, i) => `not-a-doi-${i}`);
      const err = await rejection(
        biorxivGetPreprintTool.handler(
          biorxivGetPreprintTool.input.parse({ dois: bad }),
          createMockContext({ errors: biorxivGetPreprintTool.errors }),
        ),
      );

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_doi_format' },
      });
      expect(mockGetDetails).not.toHaveBeenCalled();
    });

    it('many forms of one absent DOI are one lookup and still raise doi_not_found', async () => {
      mockGetDetails.mockResolvedValue([]);
      const [doi] = FIRST_10 as [string];
      const forms = Array.from({ length: 15 }, (_, i) => `${doi}v${i + 1}`);
      const err = await rejection(
        biorxivGetPreprintTool.handler(
          biorxivGetPreprintTool.input.parse({ dois: forms, server: 'both' }),
          createMockContext({ errors: biorxivGetPreprintTool.errors }),
        ),
      );

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'doi_not_found' },
      });
      expect(lookups()).toEqual(bothServers([doi]));
      // The DOI that was looked up, once and bare, never the 15 raw forms.
      expect(err.message).toBe(`None of the requested DOIs were found: ${doi}`);
    });

    describe('batch-level error messages', () => {
      /** `n` entries no DOI pattern matches. */
      const invalid = (n: number) =>
        Array.from({ length: n }, (_, i) => `https://example.org/not-a-doi-${i}`);

      it.each([
        [1, ''],
        [10, ''],
        [11, ', and 1 more'],
        [200, ', and 190 more'],
      ])(
        'invalid_doi_format for %i invalid entries names at most the first 10, then a count, on both surfaces',
        async (n, rest) => {
          const bad = invalid(n);
          const { result, text } = await contract({ dois: bad, server: 'both' });

          const message = `Invalid DOI format: ${bad.slice(0, 10).join(', ')}${rest}`;
          const { error } = result.structuredContent as {
            error: { code: number; message: string; data: { reason: string } };
          };
          expect(error).toMatchObject({
            code: JsonRpcErrorCode.ValidationError,
            message,
            data: { reason: 'invalid_doi_format' },
          });
          // The whole line, so a message that runs on past the expected end still fails.
          expect(text).toContain(`Error: ${message}\n`);
          if (n > 10) expect(text).not.toContain(bad[10]);
          expect(mockGetDetails).not.toHaveBeenCalled();
        },
      );

      it('doi_not_found names the DOIs looked up, bare, and the invalid entries apart from them', async () => {
        mockGetDetails.mockResolvedValue([]);
        const [a, b] = FIRST_10 as [string, string];
        const { result, text } = await contract({
          dois: [`https://doi.org/${a}`, 'not-a-doi', `${b}v2`],
          server: 'both',
        });

        const message = `None of the requested DOIs were found: ${a}, ${b}. Invalid DOI format: not-a-doi`;
        const { error } = result.structuredContent as {
          error: { code: number; message: string; data: { reason: string } };
        };
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.NotFound,
          message,
          data: { reason: 'doi_not_found' },
        });
        expect(text).toContain(`Error: ${message}\n`);
      });

      it('doi_not_found bounds the invalid entries it names the same way', async () => {
        mockGetDetails.mockResolvedValue([]);
        const [a] = FIRST_10 as [string];
        const bad = invalid(150);
        const { result } = await contract({ dois: [...bad, a], server: 'both' });

        const { error } = result.structuredContent as { error: { message: string } };
        expect(error.message).toBe(
          `None of the requested DOIs were found: ${a}. Invalid DOI format: ${bad.slice(0, 10).join(', ')}, and 140 more`,
        );
      });
    });

    it('lists unprocessed DOIs in content[] raw, never Markdown-escaped', async () => {
      const marked = ['10.1101/2024.*emph*.1', '10.1101/2024_under_score'];
      const { structured, text } = await contract({
        dois: [...FIRST_10, ...marked],
        server: 'both',
      });

      expect(structured.unprocessed).toEqual(marked);
      expect(text).toContain(`## Unprocessed DOIs (2)\n- ${marked[0]}\n- ${marked[1]}`);
      expect(text).not.toContain('\\*emph\\*');
      expect(text).not.toContain('\\_under\\_');
    });

    it('hands every lookup the one deadline, 50 s after the call started', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
        const startedAt = Date.now();
        await contract({ dois: FIRST_10, server: 'both' });

        expect(mockGetDetails.mock.calls.map((call) => call[2])).toEqual(
          Array.from({ length: 20 }, () => startedAt + 50_000),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a lookup the call deadline stopped as upstream_unavailable, never not_found', async () => {
      const [found, stopped] = FIRST_10 as [string, string];
      mockGetDetails.mockImplementation((doi: string, server: string) => {
        if (doi === found) return onBiorxiv(doi, server);
        return server === 'biorxiv'
          ? Promise.reject(
              new McpError(JsonRpcErrorCode.Timeout, 'Retry deadline exceeded.', {
                reason: 'retry_deadline_exceeded',
              }),
            )
          : Promise.resolve([]);
      });
      const { structured } = await contract({ dois: [found, stopped], server: 'both' });

      expect(structured.preprints).toEqual([entry(found)]);
      expect(structured.failed).toEqual([
        expect.objectContaining({ doi: stopped, reason: 'upstream_unavailable', retryable: true }),
      ]);
    });
  });

  // ── Cancellation ────────────────────────────────────────────────────────────

  describe('cancellation', () => {
    const SECOND = '10.1101/2024.02.01.000002';

    it('rethrows a cancellation rather than returning the DOIs that resolved first', async () => {
      const controller = new AbortController();
      const cancelled = new Error('cancelled by caller');
      mockGetDetails.mockImplementation((doi: string) => {
        if (doi === REVISION.doi) return Promise.resolve([REVISION]);
        controller.abort(cancelled);
        return Promise.reject(new Error('aborted'));
      });
      const ctx = createMockContext({
        errors: biorxivGetPreprintTool.errors,
        signal: controller.signal,
      });
      const input = biorxivGetPreprintTool.input.parse({ dois: [REVISION.doi, SECOND] });
      const err = await rejection(biorxivGetPreprintTool.handler(input, ctx));
      expect(err).toBe(cancelled);
    });

    it('settles a cancelled call as RequestCancelled even when DOIs are left in unprocessed', async () => {
      const controller = new AbortController();
      const dois = Array.from(
        { length: 11 },
        (_, i) => `10.1101/2024.03.01.${String(i + 1).padStart(6, '0')}`,
      );
      mockGetDetails.mockImplementation((doi: string) => {
        if (doi !== dois[9]) return Promise.resolve([{ doi, version: '1' }]);
        controller.abort(new Error('cancelled by caller'));
        return Promise.reject(new Error('aborted'));
      });
      const result = await runToolContract(biorxivGetPreprintTool, { dois } as never, {
        context: { errors: biorxivGetPreprintTool.errors, signal: controller.signal },
      });

      // The runner settles any throw after the abort as RequestCancelled, so the
      // message is what shows the caller's reason was rethrown, not a lookup failure.
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: { code: JsonRpcErrorCode.RequestCancelled, message: 'cancelled by caller' },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'Error: cancelled by caller' }]);
    });

    it('still reports a lookup that failed while the signal was live in failed[]', async () => {
      const controller = new AbortController();
      mockGetDetails.mockImplementation((doi: string) =>
        doi === REVISION.doi ? Promise.resolve([REVISION]) : Promise.reject(new Error('aborted')),
      );
      const ctx = createMockContext({
        errors: biorxivGetPreprintTool.errors,
        signal: controller.signal,
      });
      const input = biorxivGetPreprintTool.input.parse({
        dois: [REVISION.doi, SECOND],
        server: 'biorxiv',
      });
      const result = await biorxivGetPreprintTool.handler(input, ctx);

      expect(controller.signal.aborted).toBe(false);
      expect(result.preprints.map((p) => p.doi)).toEqual([REVISION.doi]);
      expect(result.failed).toEqual([
        expect.objectContaining({ doi: SECOND, reason: 'upstream_unavailable', retryable: true }),
      ]);
    });
  });

  // ── Per-DOI resolution across both servers ──────────────────────────────────

  describe('per-DOI resolution across both servers', () => {
    const [A, B, C] = [
      '10.1101/2024.05.01.000001',
      '10.1101/2024.05.02.000002',
      '10.1101/2024.05.03.000003',
    ] as const;
    /** The revisions `server` holds for `doi`. */
    const held = (doi: string, server: string) => [{ doi, version: '1', server }];
    /** A stubbed lookup that rejects with `error` once `ms` of (fake) time has passed. */
    const failAfter = (ms: number, error: unknown) =>
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(error), ms));
    /** What a lookup stopped by the call's budget reports. */
    const DEADLINE_MESSAGE = 'The lookup exceeded its 50000ms retry deadline after 4 attempts.';

    /** The leg signal each getDetails call was handed: by server, or by `server:doi`. */
    let legSignals: Record<string, AbortSignal | undefined>;

    /** A stubbed lookup, handed the signal it runs on and the deadline the handler passed. */
    type LookupStub = (signal: AbortSignal, deadline: number) => Promise<unknown>;
    /**
     * A lookup against an origin that never answers, stopped by the retry
     * ladder's expiry at the deadline the handler passed — so when it settles
     * shows what budget the handler gave it.
     */
    const outlastsBudget: LookupStub = (signal, deadline) =>
      neverAnswers(signal, deadline - Date.now());

    /**
     * Routes each getDetails call to the stub for its `server:doi` pair, recording
     * the leg signal it was handed and running the stub on the signal the service
     * itself would use — that one, or else `ctx.signal`.
     */
    const routeLookups = (stubs: Record<string, LookupStub>) =>
      mockGetDetails.mockImplementation(
        (
          doi: string,
          server: string,
          deadline: number,
          ctx: { signal: AbortSignal },
          signal?: AbortSignal,
        ) => {
          const key = `${server}:${doi}`;
          legSignals[key] = signal;
          const stub = stubs[key];
          if (!stub) throw new Error(`No stub for the ${key} lookup.`);
          return stub(signal ?? ctx.signal, deadline);
        },
      );
    /** The legs whose signal had aborted, as `server:doi` or server, sorted. */
    const abortedLegs = () =>
      Object.entries(legSignals)
        .filter(([, signal]) => signal?.aborted)
        .map(([leg]) => leg)
        .sort();

    const call = (
      input: Record<string, unknown>,
      ctx = createMockContext({ errors: biorxivGetPreprintTool.errors }),
    ) =>
      settle(
        Promise.resolve(
          biorxivGetPreprintTool.handler(biorxivGetPreprintTool.input.parse(input), ctx),
        ),
      );
    const contractCall = async (input: Record<string, unknown>, signal?: AbortSignal) => {
      const { value, elapsedMs } = await settle(
        runToolContract(biorxivGetPreprintTool, input as never, {
          context: { errors: biorxivGetPreprintTool.errors, ...(signal && { signal }) },
        }),
      );
      const result = value as Awaited<ReturnType<typeof runToolContract>>;
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      return { result, text, elapsedMs };
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
      mockGetDetails.mockReset();
      legSignals = {};
    });
    afterEach(() => vi.useRealTimers());

    describe.each<[string, LegStub]>([
      ['stalls', (signal) => neverAnswers(signal, CALL_BUDGET_MS)],
      ['answers empty a second later', () => answerAfter(2_000, [])],
      ['is rate-limited a second later', () => failAfter(2_000, rateLimitError(45))],
    ])('while the server that does not hold the DOI %s', (_how, otherLeg) => {
      it.each([
        ['biorxiv', 'medrxiv'],
        ['medrxiv', 'biorxiv'],
      ])('settles the DOI the moment %s, the server holding it, answers', async (holder, other) => {
        routeLegs(
          mockGetDetails,
          { [holder]: () => answerAfter(1_000, held(A, holder)), [other]: otherLeg },
          legSignals,
        );
        const { value, elapsedMs } = await call({ dois: [A], server: 'both' });

        expect(elapsedMs).toBe(1_000);
        expect(value).toEqual({
          preprints: [{ doi: A, revisions: held(A, holder) }],
          failed: [],
          unprocessed: [],
        });
        expect(mockGetDetails).toHaveBeenCalledTimes(2);
      });
    });

    it('aborts the lookup still running on the other server, never the one that answered or the caller', async () => {
      routeLegs(
        mockGetDetails,
        {
          biorxiv: () => answerAfter(1_000, held(A, 'biorxiv')),
          medrxiv: (signal) => neverAnswers(signal, CALL_BUDGET_MS),
        },
        legSignals,
      );
      const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
      await call({ dois: [A], server: 'both' }, ctx);

      expect(legSignals.medrxiv?.aborted).toBe(true);
      expect(legSignals.biorxiv?.aborted).toBe(false);
      expect(ctx.signal.aborted).toBe(false);
    });

    it('settles every found DOI on its own holding server while the other server stalls on all of them, on both surfaces', async () => {
      routeLookups({
        [`biorxiv:${A}`]: () => answerAfter(1_000, held(A, 'biorxiv')),
        [`medrxiv:${A}`]: (signal) => neverAnswers(signal, CALL_BUDGET_MS),
        [`biorxiv:${B}`]: () => answerAfter(2_000, held(B, 'biorxiv')),
        [`medrxiv:${B}`]: (signal) => neverAnswers(signal, CALL_BUDGET_MS),
        [`biorxiv:${C}`]: (signal) => neverAnswers(signal, CALL_BUDGET_MS),
        [`medrxiv:${C}`]: () => answerAfter(1_500, held(C, 'medrxiv')),
      });
      const { result, text, elapsedMs } = await contractCall({ dois: [A, B, C], server: 'both' });

      expect(elapsedMs).toBe(2_000);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        preprints: [
          { doi: A, revisions: held(A, 'biorxiv') },
          { doi: B, revisions: held(B, 'biorxiv') },
          { doi: C, revisions: held(C, 'medrxiv') },
        ],
        failed: [],
        unprocessed: [],
      });
      expect(text).toContain('## Preprints (3)');
      expect(text).toContain(`**DOI:** ${A}\n**Server:** biorxiv`);
      expect(text).toContain(`**DOI:** ${B}\n**Server:** biorxiv`);
      expect(text).toContain(`**DOI:** ${C}\n**Server:** medrxiv`);
      expect(text).not.toContain('Failed DOIs');
      // Each lookup on a server that does not hold its DOI was cut short; none that answered was.
      expect(abortedLegs()).toEqual([`biorxiv:${C}`, `medrxiv:${A}`, `medrxiv:${B}`]);
    });

    it('waits for the server holding the DOI exactly as long as before when it answers last', async () => {
      routeLegs(
        mockGetDetails,
        {
          biorxiv: () => answerAfter(3_000, held(A, 'biorxiv')),
          medrxiv: () => answerAfter(1_000, []),
        },
        legSignals,
      );
      const { value, elapsedMs } = await call({ dois: [A], server: 'both' });

      expect(elapsedMs).toBe(3_000);
      expect(value).toEqual({
        preprints: [{ doi: A, revisions: held(A, 'biorxiv') }],
        failed: [],
        unprocessed: [],
      });
      expect(mockGetDetails).toHaveBeenCalledTimes(2);
      // Both lookups had answered, so neither was cut short.
      expect(legSignals.biorxiv?.aborted).toBe(false);
      expect(legSignals.medrxiv?.aborted).toBe(false);
    });

    it('makes one lookup per DOI, settling when it answers, when the caller names one server', async () => {
      routeLegs(
        mockGetDetails,
        { medrxiv: () => answerAfter(1_000, held(A, 'medrxiv')) },
        legSignals,
      );
      const { value, elapsedMs } = await call({ dois: [A], server: 'medrxiv' });

      expect(elapsedMs).toBe(1_000);
      expect(mockGetDetails).toHaveBeenCalledTimes(1);
      expect(value).toEqual({
        preprints: [{ doi: A, revisions: held(A, 'medrxiv') }],
        failed: [],
        unprocessed: [],
      });
    });

    describe('when no server holds the DOI, classification reads both answers', () => {
      it.each<[string, LookupStub, LookupStub, number, Record<string, unknown>]>([
        [
          'both answered empty',
          () => answerAfter(1_000, []),
          () => answerAfter(3_000, []),
          3_000,
          {
            doi: B,
            error: 'Not found on bioRxiv or medRxiv.',
            reason: 'not_found',
            retryable: false,
          },
        ],
        [
          'one answered empty and the other ran out the call budget',
          () => answerAfter(1_000, []),
          outlastsBudget,
          50_000,
          {
            doi: B,
            error: `Lookup failed — medrxiv: ${DEADLINE_MESSAGE}`,
            reason: 'upstream_unavailable',
            retryable: true,
          },
        ],
        [
          'one answered empty and the other was rate-limited',
          () => answerAfter(1_000, []),
          () => failAfter(2_000, rateLimitError(30)),
          2_000,
          {
            doi: B,
            error: `Lookup failed — medrxiv: ${rateLimitError(30).message}`,
            reason: 'rate_limited',
            retryable: true,
            retryAfter: 30,
          },
        ],
        [
          'both failed, one of them rate-limited',
          () => failAfter(1_000, new Error('ECONNREFUSED')),
          () => failAfter(2_000, rateLimitError(30)),
          2_000,
          {
            doi: B,
            error: `Lookup failed — biorxiv: ECONNREFUSED; medrxiv: ${rateLimitError(30).message}`,
            reason: 'rate_limited',
            retryable: true,
            retryAfter: 30,
          },
        ],
      ])(
        'in failed[] when %s, on both surfaces',
        async (_case, biorxiv, medrxiv, settledAt, entry) => {
          routeLookups({
            [`biorxiv:${A}`]: () => answerAfter(500, held(A, 'biorxiv')),
            [`medrxiv:${A}`]: () => answerAfter(400, []),
            [`biorxiv:${B}`]: biorxiv,
            [`medrxiv:${B}`]: medrxiv,
          });
          const { result, text, elapsedMs } = await contractCall({ dois: [A, B], server: 'both' });

          expect(elapsedMs).toBe(settledAt);
          expect(result.structuredContent).toEqual({
            preprints: [{ doi: A, revisions: held(A, 'biorxiv') }],
            failed: [entry],
            unprocessed: [],
          });
          const wait = entry.retryAfter === undefined ? '' : `, retry after: ${entry.retryAfter}s`;
          expect(text).toContain(
            `- **${B}**: ${String(entry.error)} (${String(entry.reason)}, retryable: ${String(entry.retryable)}${wait})`,
          );
          // Without a hit every lookup counts, so none was cut short.
          expect(abortedLegs()).toEqual([]);
        },
      );

      it.each<[string, LookupStub, LookupStub, number, number, Record<string, unknown>]>([
        [
          'both answered empty',
          () => answerAfter(1_000, []),
          () => answerAfter(3_000, []),
          3_000,
          JsonRpcErrorCode.NotFound,
          { reason: 'doi_not_found' },
        ],
        [
          'one answered empty and the other ran out the call budget',
          () => answerAfter(1_000, []),
          outlastsBudget,
          50_000,
          JsonRpcErrorCode.ServiceUnavailable,
          { reason: 'upstream_unavailable', retryable: true },
        ],
        [
          'one answered empty and the other was rate-limited',
          () => answerAfter(1_000, []),
          () => failAfter(2_000, rateLimitError(30)),
          2_000,
          JsonRpcErrorCode.RateLimited,
          { reason: 'rate_limited', retryable: true, retryAfter: 30 },
        ],
      ])(
        'in the batch error when %s for the only DOI',
        async (_case, biorxiv, medrxiv, settledAt, code, data) => {
          routeLookups({ [`biorxiv:${B}`]: biorxiv, [`medrxiv:${B}`]: medrxiv });
          const { err, elapsedMs } = await call({ dois: [B], server: 'both' });

          expect(elapsedMs).toBe(settledAt);
          expect(err).toMatchObject({ code, data });
          expect(abortedLegs()).toEqual([]);
        },
      );
    });

    it('still settles a caller cancellation as RequestCancelled after one DOI resolved and another is pending', async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('cancelled by caller')), 5_000);
      routeLookups({
        [`biorxiv:${A}`]: () => answerAfter(1_000, held(A, 'biorxiv')),
        [`medrxiv:${A}`]: (signal) => neverAnswers(signal),
        [`biorxiv:${B}`]: (signal) => neverAnswers(signal),
        [`medrxiv:${B}`]: (signal) => neverAnswers(signal),
      });
      const { result, elapsedMs } = await contractCall(
        { dois: [A, B], server: 'both' },
        controller.signal,
      );

      expect(elapsedMs).toBe(5_000);
      expect(result.isError).toBe(true);
      // The caller's reason, never the pending lookup reported as an upstream failure.
      expect(result.structuredContent).toEqual({
        error: { code: JsonRpcErrorCode.RequestCancelled, message: 'cancelled by caller' },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'Error: cancelled by caller' }]);
    });

    it('stops every lookup still running when the caller cancels', async () => {
      const controller = new AbortController();
      const cancelled = new Error('cancelled by caller');
      setTimeout(() => controller.abort(cancelled), 5_000);
      routeLegs(
        mockGetDetails,
        { biorxiv: (signal) => neverAnswers(signal), medrxiv: (signal) => neverAnswers(signal) },
        legSignals,
      );
      const ctx = createMockContext({
        errors: biorxivGetPreprintTool.errors,
        signal: controller.signal,
      });
      const { err, elapsedMs } = await call({ dois: [A], server: 'both' }, ctx);

      expect(elapsedMs).toBe(5_000);
      expect(err).toBe(cancelled);
      expect(abortedLegs()).toEqual(['biorxiv', 'medrxiv']);
    });
  });

  // ── Security ────────────────────────────────────────────────────────────────

  it('puts injection-attempt DOI into failed[] without calling service', async () => {
    mockGetDetails.mockReset();
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    // Looks like a DOI but includes path traversal characters; starts with 10. so passes DOI_REGEX
    // but the intent is to verify the service never sees raw unsanitized values when all fail
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['not-a-doi; DROP TABLE preprints;--'],
    });
    await expect(biorxivGetPreprintTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_doi_format' },
    });
    expect(mockGetDetails).not.toHaveBeenCalled();
  });

  it('error message for invalid_doi_format does not expose env vars or secrets', async () => {
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({ dois: ['not-a-doi'] });
    const err = await rejection(biorxivGetPreprintTool.handler(input, ctx));
    const serialized = JSON.stringify(err);
    expect(serialized).not.toMatch(/password|secret|key|token|BIORXIV_MAILTO/i);
  });

  // ── format ──────────────────────────────────────────────────────────────────

  it('formats output with revision list and DOIs', () => {
    const output = {
      preprints: [{ doi: '10.1101/2024.01.15.575123', revisions: [REVISION] }],
      failed: [],
      unprocessed: [],
    };
    const blocks = biorxivGetPreprintTool.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.15.575123');
    expect(text).toContain('Test Preprint Title');
    expect(text).toContain('Revisions');
  });

  it('formats failed DOIs in output', () => {
    const output = {
      preprints: [],
      failed: [
        {
          doi: '10.1101/2024.01.01.000001',
          error: 'Not found on biorxiv.',
          reason: 'not_found' as const,
          retryable: false,
        },
      ],
      unprocessed: [],
    };
    const blocks = biorxivGetPreprintTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.01.000001');
    expect(text).toContain('Not found');
  });

  it('renders the failure reason and retryable flag for each failed DOI', () => {
    const output = {
      preprints: [],
      failed: [
        {
          doi: '10.1101/2024.01.01.000001',
          error: 'Not found on biorxiv.',
          reason: 'not_found' as const,
          retryable: false,
        },
        {
          doi: '10.1101/2024.02.02.000002',
          error: 'Lookup failed — biorxiv: network error',
          reason: 'upstream_unavailable' as const,
          retryable: true,
        },
      ],
      unprocessed: [],
    };
    const blocks = biorxivGetPreprintTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('not_found, retryable: false');
    expect(text).toContain('upstream_unavailable, retryable: true');
  });

  it('formats all optional revision fields when present', () => {
    const richRevision: PreprintRevision = {
      ...REVISION,
      type: 'new results',
      license: 'CC-BY 4.0',
      jatsxmlUrl: 'https://www.biorxiv.org/content/10.1101/2024.01.15.575123v1.xml',
      publishedJournalDoi: '10.1038/s41586-024-00001-0',
      awards: ['R01 GM134936'],
      authorCorresponding: 'Smith J',
      authorCorrespondingInstitution: 'MIT',
    };
    const output = {
      preprints: [{ doi: '10.1101/2024.01.15.575123', revisions: [richRevision] }],
      failed: [],
      unprocessed: [],
    };
    const blocks = biorxivGetPreprintTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CC-BY 4.0');
    expect(text).toContain('10.1038/s41586-024-00001-0');
    expect(text).toContain('**Awards:** R01 GM134936\n');
  });

  it('renders every revision-specific field in content[] for all revisions, not just the latest', () => {
    // Two revisions with DIVERGENT values per field (mirrors the live v1/v2 title
    // divergence on 10.1101/2023.09.16.558066). A latest-only header would drop v1's
    // distinct values, so asserting both sets present proves per-revision rendering.
    const v1: PreprintRevision = {
      doi: '10.1101/2023.09.16.558066',
      version: '1',
      date: '2023-09-16',
      title: 'Playing the long game: rational agents sacrifice immediate rewards',
      authors: 'Kao AB',
      authorCorresponding: 'Albert Kao',
      authorCorrespondingInstitution: 'Santa Fe Institute',
      category: 'Animal Behavior and Cognition',
      awards: ['IOS2402645'],
      server: 'biorxiv',
      abstract: 'Living in groups offers social animals collective wisdom.',
    };
    const v2: PreprintRevision = {
      doi: '10.1101/2023.09.16.558066',
      version: '2',
      date: '2024-02-01',
      title: 'Agents seeking long-term access to the wisdom of the crowd',
      authors: 'Kao AB, Smith J',
      authorCorresponding: 'Jane Smith',
      authorCorrespondingInstitution: 'MIT',
      category: 'Evolutionary Biology',
      awards: ['IOS2402645', 'MCB 2216742'],
      server: 'medrxiv',
      abstract: 'A revised analysis of collective decision-making.',
    };
    const output = {
      preprints: [{ doi: '10.1101/2023.09.16.558066', revisions: [v1, v2] }],
      failed: [],
      unprocessed: [],
    };
    const blocks = biorxivGetPreprintTool.format!(output);
    const text = (blocks[0] as { text: string }).text;

    // Both revisions' divergent titles must appear — not only the latest's.
    expect(text).toContain('Playing the long game: rational agents sacrifice immediate rewards');
    expect(text).toContain('Agents seeking long-term access to the wisdom of the crowd');
    // The other six previously-omitted per-revision fields, for both revisions.
    expect(text).toContain('Kao AB, Smith J');
    expect(text).toContain('Albert Kao');
    expect(text).toContain('Jane Smith');
    expect(text).toContain('Santa Fe Institute');
    expect(text).toContain('MIT');
    expect(text).toContain('Animal Behavior and Cognition');
    expect(text).toContain('Evolutionary Biology');
    expect(text).toContain('**Awards:** IOS2402645\n');
    expect(text).toContain('**Awards:** IOS2402645; MCB 2216742\n');
    expect(text).toContain('**Server:** biorxiv');
    expect(text).toContain('**Server:** medrxiv');
  });

  // ── Upstream Markdown ───────────────────────────────────────────────────────

  describe('upstream text with Markdown metacharacters', () => {
    const MARKDOWN_REVISION: PreprintRevision = {
      doi: IDENTIFIERS.doi,
      version: '1',
      date: '2026-07-03',
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
      mockGetDetails.mockResolvedValue([MARKDOWN_REVISION]);
      const result = await runToolContract(
        biorxivGetPreprintTool,
        { dois: [IDENTIFIERS.doi], server: 'biorxiv' },
        { context: { errors: biorxivGetPreprintTool.errors } },
      );
      const text = (result.content[0] as { text: string }).text;
      return { result, text };
    }

    it('carries upstream text unescaped in structuredContent', async () => {
      const { result } = await call();
      const revision = (
        result.structuredContent as { preprints: { revisions: PreprintRevision[] }[] }
      ).preprints[0]?.revisions[0];
      expect(revision).toMatchObject({
        title: UPSTREAM.title,
        abstract: UPSTREAM.abstract,
        authors: UPSTREAM.authors,
        license: UPSTREAM.license,
        awards: UPSTREAM.awards,
        jatsxmlUrl: IDENTIFIERS.jatsxmlUrl,
        publishedJournalDoi: IDENTIFIERS.publishedDoi,
      });
    });

    it('escapes every upstream field in content[] so it renders literally', async () => {
      const { text } = await call();
      expect(text).toContain(`### ${ESCAPED.title}\n`);
      expect(text).toContain(`**Title:** ${ESCAPED.title}\n`);
      expect(text).toContain(`**Type:** ${ESCAPED.type}\n`);
      expect(text).toContain(`**Category:** ${ESCAPED.category}\n`);
      expect(text).toContain(`**License:** ${ESCAPED.license}\n`);
      expect(text).toContain(`**Authors:** ${ESCAPED.authors}\n`);
      expect(text).toContain(`**Corresponding:** ${ESCAPED.authorCorresponding}\n`);
      expect(text).toContain(`**Institution:** ${ESCAPED.authorCorrespondingInstitution}\n`);
      expect(text).toContain(`**Awards:** ${ESCAPED.awards}\n`);
      expect(text).toContain(`**Abstract:** ${ESCAPED.abstract}`);
    });

    it('leaves the DOI, JATS URL, and journal DOI unescaped in content[]', async () => {
      const { text } = await call();
      expect(text).toContain(`**DOI:** ${IDENTIFIERS.doi}\n`);
      expect(text).toContain(`**JATS XML:** ${IDENTIFIERS.jatsxmlUrl}\n`);
      expect(text).toContain(`**Published Journal DOI:** ${IDENTIFIERS.publishedDoi}\n`);
    });

    it('falls back to the raw DOI as the heading when the title is absent', () => {
      const blocks = biorxivGetPreprintTool.format!({
        preprints: [{ doi: IDENTIFIERS.doi, revisions: [{ doi: IDENTIFIERS.doi }] }],
        failed: [],
        unprocessed: [],
      });
      expect((blocks[0] as { text: string }).text).toContain(`### ${IDENTIFIERS.doi}\n`);
    });
  });
});
