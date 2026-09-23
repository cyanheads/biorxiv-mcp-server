/**
 * @fileoverview Tests for biorxiv_get_preprint tool.
 * @module tests/tools/biorxiv-get-preprint.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetPreprintTool } from '@/mcp-server/tools/definitions/biorxiv-get-preprint.tool.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';
import { ESCAPED, IDENTIFIERS, UPSTREAM } from '../helpers/markdown-fixtures.js';
import { rateLimitError } from '../helpers/rate-limit.js';
import { recoveryHint, rejection } from '../helpers/rejection.js';

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

  it('rejects dois array longer than 10 at schema parse time', () => {
    const tooMany = Array.from(
      { length: 11 },
      (_, i) => `10.1101/2024.01.${String(i + 1).padStart(2, '0')}.000001`,
    );
    expect(() => biorxivGetPreprintTool.input.parse({ dois: tooMany })).toThrow();
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
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.01.000001'],
      server: 'both',
    });
    const err = await rejection(biorxivGetPreprintTool.handler(input, ctx));
    expect(recoveryHint(err)).toMatch(/retry/i);
    expect(recoveryHint(err)).not.toMatch(/verify the doi/i);
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
      });
      expect((blocks[0] as { text: string }).text).toContain(`### ${IDENTIFIERS.doi}\n`);
    });
  });
});
