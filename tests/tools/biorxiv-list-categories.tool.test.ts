/**
 * @fileoverview Tests for biorxiv_list_categories tool.
 * @module tests/tools/biorxiv-list-categories.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivListCategoriesTool } from '@/mcp-server/tools/definitions/biorxiv-list-categories.tool.js';

const mockGetCategories = vi.fn();

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({ getCategories: mockGetCategories }),
}));

const CATEGORIES = {
  biorxiv: ['Neuroscience', 'Genetics', 'Cell Biology'],
  medrxiv: ['Cardiology', 'Infectious Diseases'],
};

describe('biorxivListCategoriesTool', () => {
  beforeEach(() => {
    mockGetCategories.mockReturnValue(CATEGORIES);
  });

  it('returns the category taxonomy', async () => {
    const ctx = createMockContext();
    const input = biorxivListCategoriesTool.input.parse({});
    const result = await biorxivListCategoriesTool.handler(input, ctx);
    expect(result).toEqual(CATEGORIES);
    expect(result.biorxiv).toContain('Neuroscience');
    expect(result.medrxiv).toContain('Cardiology');
  });

  it('formats output with both server sections', () => {
    const blocks = biorxivListCategoriesTool.format!(CATEGORIES);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('bioRxiv Categories');
    expect(text).toContain('medRxiv Categories');
    expect(text).toContain('Neuroscience');
    expect(text).toContain('Cardiology');
  });
});
