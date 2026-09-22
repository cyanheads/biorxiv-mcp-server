/**
 * @fileoverview biorxiv_list_recent category filtering end to end — the input
 * spelling the tool accepts, the spelling it sends api.biorxiv.org, and the
 * guard against a filter the API silently ignored. The real
 * `BiorxivApiService`, `fetchWithTimeout`, `withRetry`, tool handler, `format()`,
 * and error envelope all run; only `globalThis.fetch` is faked, answering with
 * the listing envelope the live API returns — including `messages[0].category`,
 * which echoes the applied filter, or `"all"` when the API did not apply one.
 * @module tests/tools/biorxiv-list-recent.category.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivListCategoriesTool } from '@/mcp-server/tools/definitions/biorxiv-list-categories.tool.js';
import { biorxivListRecentTool } from '@/mcp-server/tools/definitions/biorxiv-list-recent.tool.js';
import { initBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

type Server = 'biorxiv' | 'medrxiv';

/**
 * What one server answers: `category` is the echo the API puts in
 * `messages[0].category` — the applied filter, or `"all"` when it applied none.
 * `status` answers with that HTTP status instead of a listing.
 */
type Leg = { category: string; records?: number; total?: number } | { status: number };

const http = createFetchMock();

/** Route both servers' listing endpoints to the given per-server answers. */
function answer(legs: Partial<Record<Server, Leg>>): void {
  http.route({
    match: (request) => new URL(request.url).hostname === 'api.biorxiv.org',
    respond: (request) => {
      const server = new URL(request.url).pathname.split('/')[2] as Server;
      const leg = legs[server];
      if (!leg) throw new Error(`unexpected request to ${server}: ${request.url}`);
      if ('status' in leg) return new Response('upstream error', { status: leg.status });
      const records = leg.records ?? 2;
      const echoed = leg.category;
      return Response.json({
        messages: [
          {
            status: 'ok',
            category: echoed,
            cursor: 0,
            count: records,
            total: String(leg.total ?? records),
          },
        ],
        collection: Array.from({ length: records }, (_, i) => ({
          doi: `10.64898/2026.02.0${i + 1}.${server === 'biorxiv' ? '70000' : '2600'}${i}`,
          title: `${server} record ${i + 1}`,
          date: '2026-02-01',
          version: '1',
          category: echoed === 'all' ? 'unrelated field' : echoed,
          server: server === 'biorxiv' ? 'bioRxiv' : 'medRxiv',
          published: 'NA',
        })),
      });
    },
  });
}

/** Category query each server received, keyed by server. */
function sentCategories(): Partial<Record<Server, string | null>> {
  const sent: Partial<Record<Server, string | null>> = {};
  for (const { request } of http.calls) {
    const url = new URL(request.url);
    sent[url.pathname.split('/')[2] as Server] = url.searchParams.get('category');
  }
  return sent;
}

async function run(input: Record<string, unknown>) {
  const pending = runToolContract(
    biorxivListRecentTool,
    { start_date: '2026-01-01', end_date: '2026-09-01', ...input } as never,
    { context: { errors: biorxivListRecentTool.errors } },
  );
  await vi.runAllTimersAsync();
  return pending;
}

function text(result: Awaited<ReturnType<typeof run>>): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function structured(result: Awaited<ReturnType<typeof run>>) {
  return result.structuredContent as {
    preprints: { doi: string; category?: string }[];
    pagination: Partial<Record<Server, { total: number }>>;
    failed: { server: Server }[];
    notice?: string;
    categoryNote?: string;
    error?: { code: number; message: string; data: Record<string, unknown> };
  };
}

describe('biorxiv_list_recent — category filtering against the live listing envelope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    http.reset();
    http.install();
    initBiorxivApiService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  // ── API spelling (#45) ─────────────────────────────────────────────────────

  it('sends HIV/AIDS as "hiv aids" and returns the filtered medRxiv page (#45)', async () => {
    answer({ medrxiv: { category: 'hiv aids', records: 3, total: 177 } });
    const result = await run({ server: 'medrxiv', category: 'HIV/AIDS' });

    expect(result.isError).toBeFalsy();
    expect(sentCategories()).toEqual({ medrxiv: 'hiv aids' });
    const out = structured(result);
    expect(out.pagination.medrxiv?.total).toBe(177);
    expect(out.preprints.every((p) => p.category === 'hiv aids')).toBe(true);
    expect(out.notice).toBeUndefined();
    const rendered = text(result);
    expect(rendered).toContain('**medRxiv:** page offset 0, total 177');
    expect(rendered).toContain('**Category:** hiv aids');
  });

  // ── Input spelling (#50) ────────────────────────────────────────────────────

  it.each(['Cell Biology', 'cell biology', 'CELL_BIOLOGY', 'cell_biology', 'cell-biology'])(
    'accepts %j and sends the API spelling (#50)',
    async (category) => {
      answer({ biorxiv: { category: 'cell biology', total: 2847 } });
      const result = await run({ server: 'biorxiv', category });

      expect(result.isError).toBeFalsy();
      expect(sentCategories()).toEqual({ biorxiv: 'cell biology' });
      expect(structured(result).pagination.biorxiv?.total).toBe(2847);
    },
  );

  it('accepts the spelling records echo back, so a category can be reused from a result (#50)', async () => {
    answer({ medrxiv: { category: 'hiv aids' } });
    const result = await run({ server: 'both', category: 'hiv aids' });
    expect(result.isError).toBeFalsy();
    // medRxiv-exclusive, so only medRxiv is queried
    expect(sentCategories()).toEqual({ medrxiv: 'hiv aids' });
    expect(structured(result).categoryNote).toMatch(/only medRxiv was queried/);
  });

  it("accepts the websites' collection slug for a slash-named category", async () => {
    answer({ medrxiv: { category: 'hiv aids', total: 177 } });
    const result = await run({ server: 'medrxiv', category: 'hiv-aids' });
    expect(result.isError).toBeFalsy();
    expect(sentCategories()).toEqual({ medrxiv: 'hiv aids' });
    expect(structured(result).pagination.medrxiv?.total).toBe(177);
  });

  // ── Taxonomy trim (#45) ─────────────────────────────────────────────────────

  it('routes Epidemiology under server="both" to medRxiv alone (#45)', async () => {
    answer({ medrxiv: { category: 'epidemiology', total: 900 } });
    const result = await run({ server: 'both', category: 'Epidemiology' });

    expect(result.isError).toBeFalsy();
    expect(sentCategories()).toEqual({ medrxiv: 'epidemiology' });
    const out = structured(result);
    expect(out.pagination.biorxiv).toBeUndefined();
    expect(out.categoryNote).toMatch(/specific to medRxiv/);
    expect(text(result)).toMatch(/specific to medRxiv/);
  });

  it.each([
    ['Epidemiology', 'biorxiv'],
    ['Clinical Trials', 'biorxiv'],
    ['Clinical Trials', 'both'],
    ['Vascular Medicine', 'medrxiv'],
    ['Vascular Medicine', 'both'],
  ])(
    'rejects %s on server=%s as invalid_category before any request (#45)',
    async (category, server) => {
      const result = await run({ server, category });

      expect(result.isError).toBe(true);
      expect(structured(result).error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_category' },
      });
      expect(http.calls).toHaveLength(0);
    },
  );

  it('stops advertising the categories the API cannot filter on (#45)', async () => {
    const result = await runToolContract(biorxivListCategoriesTool, {});
    const out = result.structuredContent as { biorxiv: string[]; medrxiv: string[] };
    expect(out.biorxiv).not.toContain('Epidemiology');
    expect(out.biorxiv).not.toContain('Clinical Trials');
    expect(out.medrxiv).not.toContain('Vascular Medicine');
    const rendered = text(result as never);
    expect(rendered).toContain('## bioRxiv Categories (25)');
    expect(rendered).toContain('## medRxiv Categories (51)');
    expect(rendered).not.toContain('Vascular Medicine');
  });

  it('still queries both servers for a shared category (#45 regression guard)', async () => {
    answer({
      biorxiv: { category: 'pathology', total: 400 },
      medrxiv: { category: 'pathology', total: 250 },
    });
    const result = await run({ server: 'both', category: 'Pathology' });

    expect(result.isError).toBeFalsy();
    expect(sentCategories()).toEqual({ biorxiv: 'pathology', medrxiv: 'pathology' });
    const out = structured(result);
    expect(out.pagination).toMatchObject({ biorxiv: { total: 400 }, medrxiv: { total: 250 } });
    expect(out.preprints).toHaveLength(4);
    expect(out.categoryNote).toBeUndefined();
    expect(out.notice).toBeUndefined();
  });

  // ── Ignored-filter guard (#45) ──────────────────────────────────────────────

  it('fails a single-server call with invalid_category when the API ignores the filter (#45)', async () => {
    answer({ biorxiv: { category: 'all', records: 30, total: 49190 } });
    const result = await run({ server: 'biorxiv', category: 'Neuroscience' });

    expect(result.isError).toBe(true);
    const error = structured(result).error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_category', category: 'Neuroscience', servers: ['biorxiv'] },
    });
    expect(error?.message).toContain('Neuroscience');
    expect(error?.message).toMatch(/unfiltered/);
    const hint = (error?.data.recovery as { hint?: string } | undefined)?.hint ?? '';
    expect(hint).toMatch(/omit category/i);
    const rendered = text(result);
    expect(rendered).toContain('Recovery:');
    expect(rendered).toContain('(reason invalid_category)');
    // None of the unfiltered page reaches the caller
    expect(rendered).not.toContain('record 1');
  });

  it('fails the collapsed single-server leg of a "both" call the same way (#45)', async () => {
    answer({ medrxiv: { category: 'all', records: 30, total: 13507 } });
    const result = await run({ server: 'both', category: 'Nephrology' });

    expect(result.isError).toBe(true);
    expect(structured(result).error?.data).toMatchObject({
      reason: 'invalid_category',
      servers: ['medrxiv'],
    });
  });

  it('drops an ignored leg from a "both" fan-out with a notice, keeping the filtered one (#45)', async () => {
    answer({
      biorxiv: { category: 'all', records: 30, total: 49190 },
      medrxiv: { category: 'pathology', records: 2, total: 250 },
    });
    const result = await run({ server: 'both', category: 'Pathology' });

    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.pagination.biorxiv).toBeUndefined();
    expect(out.pagination.medrxiv?.total).toBe(250);
    expect(out.preprints).toHaveLength(2);
    expect(out.preprints.every((p) => p.category === 'pathology')).toBe(true);
    // An ignored filter is not a failed server — retrying will not bring it back
    expect(out.failed).toEqual([]);
    expect(out.notice).toMatch(/bioRxiv ignored the category filter "Pathology"/);
    const rendered = text(result);
    expect(rendered).toMatch(/bioRxiv ignored the category filter "Pathology"/);
    expect(rendered).not.toContain('**bioRxiv:** page offset');
    expect(rendered).not.toContain('unrelated field');
  });

  it('fails with invalid_category when every fan-out leg ignored the filter (#45)', async () => {
    answer({
      biorxiv: { category: 'all', records: 30, total: 49190 },
      medrxiv: { category: 'all', records: 30, total: 13507 },
    });
    const result = await run({ server: 'both', category: 'Pathology' });

    expect(result.isError).toBe(true);
    expect(structured(result).error?.data).toMatchObject({
      reason: 'invalid_category',
      servers: ['biorxiv', 'medrxiv'],
    });
    expect(text(result)).toMatch(/bioRxiv and medRxiv/);
  });

  it('reports a retryable failure, not invalid_category, when one leg failed and the other ignored the filter', async () => {
    // The failed leg never answered, so whether its filter works is unknown — a
    // retry can still produce a filtered page.
    answer({ biorxiv: { category: 'all', records: 30 }, medrxiv: { status: 503 } });
    const result = await run({ server: 'both', category: 'Pathology' });

    expect(result.isError).toBe(true);
    const error = structured(result).error;
    expect(error?.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
    expect(error?.message).toMatch(/bioRxiv ignored the category filter "Pathology"/);
    expect(error?.message).toMatch(/medRxiv/);
  });

  it('leaves a request with no category alone even though its echo reads "all"', async () => {
    answer({
      biorxiv: { category: 'all', records: 2, total: 318 },
      medrxiv: { category: 'all', records: 2, total: 95 },
    });
    const result = await run({ server: 'both' });

    expect(result.isError).toBeFalsy();
    expect(sentCategories()).toEqual({ biorxiv: null, medrxiv: null });
    const out = structured(result);
    expect(out.preprints).toHaveLength(4);
    expect(out.notice).toBeUndefined();
  });
});
