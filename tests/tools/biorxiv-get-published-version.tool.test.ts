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

  it('returns the published version record', async () => {
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.preprintDoi).toBe('10.1101/2024.01.15.575123');
    expect(result.publishedJournal).toBe('Nature');
  });

  it('throws invalid_doi_format for malformed DOI', async () => {
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: 'bad-doi' });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_doi_format' },
    });
  });

  it('throws doi_not_found when preprint is not yet published', async () => {
    mockGetPublishedVersion.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.01.000001' });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found' },
    });
  });

  it('formats output with journal and crosswalk fields', () => {
    const blocks = biorxivGetPublishedVersionTool.format!(PUBLISHED);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.15.575123');
    expect(text).toContain('Nature');
    expect(text).toContain('10.1038/s41586-024-00001-0');
  });
});
