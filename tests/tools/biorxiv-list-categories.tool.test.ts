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

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns the category taxonomy', async () => {
    const ctx = createMockContext();
    const input = biorxivListCategoriesTool.input.parse({});
    const result = await biorxivListCategoriesTool.handler(input, ctx);
    expect(result).toEqual(CATEGORIES);
    expect(result.biorxiv).toContain('Neuroscience');
    expect(result.medrxiv).toContain('Cardiology');
  });

  it('returns both biorxiv and medrxiv arrays', async () => {
    const ctx = createMockContext();
    const input = biorxivListCategoriesTool.input.parse({});
    const result = await biorxivListCategoriesTool.handler(input, ctx);
    expect(Array.isArray(result.biorxiv)).toBe(true);
    expect(Array.isArray(result.medrxiv)).toBe(true);
    expect(result.biorxiv.length).toBeGreaterThan(0);
    expect(result.medrxiv.length).toBeGreaterThan(0);
  });

  it('is idempotent across multiple calls', async () => {
    const ctx = createMockContext();
    const input = biorxivListCategoriesTool.input.parse({});
    const first = await biorxivListCategoriesTool.handler(input, ctx);
    const second = await biorxivListCategoriesTool.handler(input, ctx);
    expect(first).toEqual(second);
  });

  // ── format ──────────────────────────────────────────────────────────────────

  it('formats output with both server sections', () => {
    const blocks = biorxivListCategoriesTool.format!(CATEGORIES);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('bioRxiv Categories');
    expect(text).toContain('medRxiv Categories');
    expect(text).toContain('Neuroscience');
    expect(text).toContain('Cardiology');
  });

  it('format includes category counts in headers', () => {
    const blocks = biorxivListCategoriesTool.format!(CATEGORIES);
    const text = (blocks[0] as { text: string }).text;
    // Should show (3) and (2) counts from CATEGORIES fixture
    expect(text).toContain('(3)');
    expect(text).toContain('(2)');
  });

  it('format includes all category entries as list items', () => {
    const blocks = biorxivListCategoriesTool.format!(CATEGORIES);
    const text = (blocks[0] as { text: string }).text;
    for (const cat of [...CATEGORIES.biorxiv, ...CATEGORIES.medrxiv]) {
      expect(text).toContain(cat);
    }
  });
});
