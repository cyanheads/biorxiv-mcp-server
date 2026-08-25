/**
 * @fileoverview Tests for biorxiv_get_published_version tool.
 * @module tests/tools/biorxiv-get-published-version.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetPublishedVersionTool } from '@/mcp-server/tools/definitions/biorxiv-get-published-version.tool.js';
import type { PublishedVersion } from '@/services/biorxiv/types.js';
import { rateLimitError } from '../helpers/rate-limit.js';
import { recoveryHint, rejection } from '../helpers/rejection.js';

const mockGetPublishedVersion = vi.fn();

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({ getPublishedVersion: mockGetPublishedVersion }),
}));

const PUBLISHED: PublishedVersion = {
  preprintDoi: '10.1101/2024.01.15.575123',
  publishedDoi: '10.1038/s41586-024-00001-0',
  publishedJournal: 'Nature',
  publishedDate: '2024-06-01',
  preprintTitle: 'Test Preprint Title',
  preprintAuthors: 'Smith J, Jones A',
  preprintCategory: 'Neuroscience',
};

describe('biorxivGetPublishedVersionTool', () => {
  beforeEach(() => {
    mockGetPublishedVersion.mockResolvedValue(PUBLISHED);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns the published version record', async () => {
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.preprintDoi).toBe('10.1101/2024.01.15.575123');
    expect(result.publishedJournal).toBe('Nature');
  });

  it('routes to medrxiv server when specified', async () => {
    const mxPublished: PublishedVersion = {
      ...PUBLISHED,
      preprintDoi: '10.1101/2024.06.01.123456',
      publishedJournal: 'Lancet',
    };
    mockGetPublishedVersion.mockResolvedValue(mxPublished);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.06.01.123456',
      server: 'medrxiv',
    });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.publishedJournal).toBe('Lancet');
    // Verify medrxiv was passed to the service
    expect(mockGetPublishedVersion).toHaveBeenCalledWith(
      '10.1101/2024.06.01.123456',
      'medrxiv',
      expect.anything(),
    );
  });

  it('defaults server to "both" when omitted', () => {
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    expect(input.server).toBe('both');
  });

  it('resolves a medRxiv-only DOI when server is omitted, naming medrxiv as the answering server', async () => {
    const mxPublished: PublishedVersion = {
      ...PUBLISHED,
      preprintDoi: '10.1101/2024.11.21.24317726',
      publishedDoi: '10.1172/JCI192052',
      publishedJournal: 'Journal of Clinical Investigation',
    };
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      server === 'medrxiv' ? Promise.resolve(mxPublished) : Promise.resolve(undefined),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.11.21.24317726',
    });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.publishedDoi).toBe('10.1172/JCI192052');
    expect(result.server).toBe('medrxiv');
    expect(mockGetPublishedVersion).toHaveBeenCalledWith(
      '10.1101/2024.11.21.24317726',
      'biorxiv',
      expect.anything(),
    );
    expect(mockGetPublishedVersion).toHaveBeenCalledWith(
      '10.1101/2024.11.21.24317726',
      'medrxiv',
      expect.anything(),
    );
  });

  it('names biorxiv as the answering server when the DOI resolves there', async () => {
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv' ? Promise.resolve(PUBLISHED) : Promise.resolve(undefined),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.server).toBe('biorxiv');
  });

  it('accepts the alternative 10.64898/ DOI prefix', async () => {
    mockGetPublishedVersion.mockResolvedValue({
      ...PUBLISHED,
      preprintDoi: '10.64898/2026.05.07.723463',
    });
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.64898/2026.05.07.723463',
    });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.preprintDoi).toBe('10.64898/2026.05.07.723463');
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('throws invalid_doi_format for malformed DOI', async () => {
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: 'bad-doi' });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_doi_format' },
    });
  });

  it('throws invalid_doi_format for DOI without required prefix', async () => {
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    // A string starting with digits but missing the slash and subpath
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10notadoi' });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_doi_format' },
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('throws doi_not_found when preprint is not yet published', async () => {
    mockGetPublishedVersion.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.01.000001' });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found' },
    });
  });

  it('keeps doi_not_found when both servers answer with no record', async () => {
    mockGetPublishedVersion.mockReset();
    mockGetPublishedVersion.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'both',
    });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found' },
    });
    expect(mockGetPublishedVersion).toHaveBeenCalledTimes(2);
  });

  it('throws retryable upstream_unavailable instead of doi_not_found when both servers fail', async () => {
    const upstream = new Error('network error');
    mockGetPublishedVersion.mockRejectedValue(upstream);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'both',
    });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true },
    });
    // The upstream error is what a maintainer needs to diagnose the outage; the
    // wrapper carries it as `cause` rather than discarding it at the boundary.
    expect(err.cause).toBe(upstream);
  });

  it('throws retryable upstream_unavailable when the single requested server fails', async () => {
    mockGetPublishedVersion.mockRejectedValue(new Error('network error'));
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'biorxiv',
    });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true },
    });
  });

  it('still resolves when one server fails and the other holds the record', async () => {
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv'
        ? Promise.reject(new Error('network error'))
        : Promise.resolve({ ...PUBLISHED, publishedJournal: 'Lancet' }),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.publishedJournal).toBe('Lancet');
    expect(result.server).toBe('medrxiv');
  });

  it('doi_not_found recovery routes to the other server rather than asserting the preprint is unpublished', async () => {
    mockGetPublishedVersion.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'biorxiv',
    });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));
    expect(recoveryHint(err)).toMatch(/both/i);
    expect(recoveryHint(err)).not.toMatch(/has not been accepted/i);
  });

  it('throws retryable rate_limited with the origin wait when the lookup was rate-limited', async () => {
    const upstream = rateLimitError(30);
    mockGetPublishedVersion.mockRejectedValue(upstream);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'both',
    });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryable: true,
        retryAfter: 30,
        doi: '10.1101/2024.01.01.000001',
        servers: ['biorxiv', 'medrxiv'],
      },
    });
    expect(recoveryHint(err)).toContain('30 seconds');
    expect(err.cause).toBe(upstream);
  });

  it('prefers rate_limited over upstream_unavailable when only one server was rate-limited', async () => {
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      Promise.reject(server === 'biorxiv' ? rateLimitError(45) : new Error('network error')),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'both',
    });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: 45 },
    });
    expect(err.message).toContain('network error');
  });

  it('still resolves when one server is rate-limited and the other holds the record', async () => {
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv' ? Promise.reject(rateLimitError(30)) : Promise.resolve(PUBLISHED),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.15.575123',
    });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.server).toBe('medrxiv');
  });

  it('doi_not_found error does not leak internal details', async () => {
    mockGetPublishedVersion.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.01.000001' });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));
    const serialized = JSON.stringify(err);
    expect(serialized).not.toMatch(/password|secret|key|token|BIORXIV_MAILTO/i);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it('handles sparse published record — only preprintDoi present', async () => {
    const sparse: PublishedVersion = { preprintDoi: '10.1101/2024.01.15.575123' };
    mockGetPublishedVersion.mockResolvedValue(sparse);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.preprintDoi).toBe('10.1101/2024.01.15.575123');
    expect(result.publishedJournal).toBeUndefined();
    expect(result.publishedDoi).toBeUndefined();
  });

  // ── format ──────────────────────────────────────────────────────────────────

  it('formats output with journal and crosswalk fields', () => {
    const blocks = biorxivGetPublishedVersionTool.format!({ ...PUBLISHED, server: 'biorxiv' });
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.15.575123');
    expect(text).toContain('Nature');
    expect(text).toContain('10.1038/s41586-024-00001-0');
  });

  it('renders the answering server so a both-server caller knows which one resolved', () => {
    const blocks = biorxivGetPublishedVersionTool.format!({ ...PUBLISHED, server: 'medrxiv' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('medrxiv');
  });

  it('formats full crosswalk record including all optional fields', () => {
    const full: PublishedVersion & { server: 'biorxiv' } = {
      ...PUBLISHED,
      server: 'biorxiv',
      preprintDate: '2024-01-15',
      preprintAbstract: 'The full abstract text here.',
      preprintAuthorCorresponding: 'Smith J',
      preprintAuthorCorrespondingInstitution: 'MIT',
    };
    const blocks = biorxivGetPublishedVersionTool.format!(full);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('MIT');
    expect(text).toContain('full abstract text');
    expect(text).toContain('Smith J');
  });

  it('formats sparse published record without fabricating absent fields', () => {
    const sparse: PublishedVersion & { server: 'biorxiv' } = {
      preprintDoi: '10.1101/2024.01.15.575123',
      server: 'biorxiv',
    };
    const blocks = biorxivGetPublishedVersionTool.format!(sparse);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.15.575123');
    // Should not contain any fabricated placeholders
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});
