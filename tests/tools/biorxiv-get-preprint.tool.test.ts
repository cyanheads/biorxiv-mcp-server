/**
 * @fileoverview Tests for biorxiv_get_preprint tool.
 * @module tests/tools/biorxiv-get-preprint.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetPreprintTool } from '@/mcp-server/tools/definitions/biorxiv-get-preprint.tool.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';

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

  it('throws invalid_doi_format for malformed DOI', async () => {
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({ dois: ['not-a-doi'] });
    await expect(biorxivGetPreprintTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_doi_format' },
    });
  });

  it('throws doi_not_found when all DOIs return empty collections', async () => {
    mockGetDetails.mockResolvedValue([]);
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({ dois: ['10.1101/2024.01.01.000001'] });
    await expect(biorxivGetPreprintTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found' },
    });
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

  it('handles sparse upstream payload without fabricating data', async () => {
    const sparse: PreprintRevision = { doi: '10.1101/2024.01.15.575123' };
    mockGetDetails.mockResolvedValue([sparse]);
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({ dois: ['10.1101/2024.01.15.575123'] });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.preprints[0]?.revisions[0]?.title).toBeUndefined();
    expect(result.preprints[0]?.revisions[0]?.abstract).toBeUndefined();
  });

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
});
