/**
 * @fileoverview Tests for biorxiv_get_published_version tool.
 * @module tests/tools/biorxiv-get-published-version.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetPublishedVersionTool } from '@/mcp-server/tools/definitions/biorxiv-get-published-version.tool.js';
import type { PublishedVersion } from '@/services/biorxiv/types.js';

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

  it('defaults server to biorxiv when omitted', () => {
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    expect(input.server).toBe('biorxiv');
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

  it('doi_not_found error does not leak internal details', async () => {
    mockGetPublishedVersion.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.01.000001' });
    const err = await biorxivGetPublishedVersionTool.handler(input, ctx).catch((e) => e);
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
    const blocks = biorxivGetPublishedVersionTool.format!(PUBLISHED);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.15.575123');
    expect(text).toContain('Nature');
    expect(text).toContain('10.1038/s41586-024-00001-0');
  });

  it('formats full crosswalk record including all optional fields', () => {
    const full: PublishedVersion = {
      ...PUBLISHED,
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
    const sparse: PublishedVersion = { preprintDoi: '10.1101/2024.01.15.575123' };
    const blocks = biorxivGetPublishedVersionTool.format!(sparse);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.15.575123');
    // Should not contain any fabricated placeholders
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});
