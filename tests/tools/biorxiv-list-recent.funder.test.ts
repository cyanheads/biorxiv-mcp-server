/**
 * @fileoverview biorxiv_list_recent funder filtering end to end — the ROR ID
 * forms the tool accepts, the query it sends api.biorxiv.org, its bioRxiv-only
 * scope, and the API's "funder value not found" answer. The real
 * `BiorxivApiService`, `fetchWithTimeout`, `withRetry`, tool handler, `format()`,
 * and error envelope all run; only `globalThis.fetch` is faked, answering with
 * the listing envelopes the live API returns for these queries.
 * @module tests/tools/biorxiv-list-recent.funder.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivListRecentTool } from '@/mcp-server/tools/definitions/biorxiv-list-recent.tool.js';
import { initBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

type Server = 'biorxiv' | 'medrxiv';

const NSF = '021nxhr62';
/** The live `messages[0].funder` echo for an NSF-filtered page. */
const NSF_ECHO = 'National Science Foundation : https://ror.org/021nxhr62';

/** A live NSF-filtered record: the funder array names a hospital, the award is NSF's. */
const NSF_RECORD = {
  doi: '10.1101/2026.08.04.000001',
  title: 'Root hair growth under phosphate limitation',
  date: '2026-08-04',
  version: '1',
  category: 'plant biology',
  server: 'bioRxiv',
  published: 'NA',
  funder: [
    {
      name: 'Mitsubishi Kyoto Hospital',
      id: 'https://ror.org/053658081',
      'id-type': 'ROR',
      award: 'IOS2402645',
    },
  ],
};

/**
 * What one server answers. `messages` is `messages[0]` as the live API sends it;
 * `records` is the collection size (default: one NSF record when the status is
 * ok, none otherwise).
 */
type Leg = { messages: Record<string, unknown>; records?: number };

const LIVE = {
  nsf: { status: 'ok', category: 'all', funder: NSF_ECHO, cursor: 0, count: 12, total: '12' },
  nsfNeuro: {
    status: 'ok',
    category: 'neuroscience',
    funder: NSF_ECHO,
    cursor: 0,
    count: 4,
    total: '4',
  },
  // The funder applied, the category did not: the funder's unfiltered-by-category page.
  nsfIgnoredCategory: {
    status: 'ok',
    category: 'all',
    funder: NSF_ECHO,
    cursor: 0,
    count: 12,
    total: '12',
  },
  notFound: { status: 'funder value not found' },
  noPosts: { status: 'no posts found' },
  unfiltered: { status: 'ok', category: 'all', funder: 'all', cursor: 0, count: 2, total: '5906' },
} as const;

const http = createFetchMock();

function answer(legs: Partial<Record<Server, Leg>>): void {
  http.route({
    match: (request) => new URL(request.url).hostname === 'api.biorxiv.org',
    respond: (request) => {
      const server = new URL(request.url).pathname.split('/')[2] as Server;
      const leg = legs[server];
      if (!leg) throw new Error(`unexpected request to ${server}: ${request.url}`);
      const records = leg.records ?? (leg.messages.status === 'ok' ? 1 : 0);
      return Response.json({
        messages: [leg.messages],
        ...(records > 0 && {
          collection: Array.from({ length: records }, (_, i) => ({
            ...NSF_RECORD,
            doi: `10.1101/2026.08.04.00000${i + 1}`,
          })),
        }),
      });
    },
  });
}

/** Query parameters each server received, keyed by server. */
function sent(): Partial<Record<Server, Record<string, string>>> {
  const out: Partial<Record<Server, Record<string, string>>> = {};
  for (const { request } of http.calls) {
    const url = new URL(request.url);
    out[url.pathname.split('/')[2] as Server] = Object.fromEntries(url.searchParams);
  }
  return out;
}

async function run(input: Record<string, unknown>) {
  const pending = runToolContract(
    biorxivListRecentTool,
    { start_date: '2026-08-01', end_date: '2026-08-31', ...input } as never,
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
    preprints: { doi: string; awards?: string[]; funder?: unknown }[];
    pagination: Partial<Record<Server, { cursor: number; total: number; exhausted?: boolean }>>;
    failed: { server: Server }[];
    notice?: string;
    categoryNote?: string;
    error?: { code: number; message: string; data: Record<string, unknown> };
  };
}

function hint(result: Awaited<ReturnType<typeof run>>): string {
  return (structured(result).error?.data.recovery as { hint?: string } | undefined)?.hint ?? '';
}

describe('biorxiv_list_recent — funder filter against the live listing envelope', () => {
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

  // ── Accepted forms ──────────────────────────────────────────────────────────

  it.each([
    NSF,
    'https://ror.org/021nxhr62',
    'https://ror.org/021nxhr62/',
    'ror.org/021nxhr62',
    '021NXHR62',
    '  021nxhr62 ',
  ])('sends %j as ?funder=021nxhr62', async (funder) => {
    answer({ biorxiv: { messages: LIVE.nsf } });
    const result = await run({ server: 'biorxiv', funder });

    expect(result.isError).toBeFalsy();
    expect(sent()).toEqual({ biorxiv: { funder: NSF } });
    expect(http.calls[0]?.request.url).toMatch(/\/0\/json\?funder=021nxhr62$/);
  });

  it('returns the filtered page on both surfaces, with awards and no funder name', async () => {
    answer({ biorxiv: { messages: LIVE.nsf } });
    const result = await run({ server: 'biorxiv', funder: NSF });

    const out = structured(result);
    expect(out.pagination.biorxiv).toMatchObject({ cursor: 0, total: 12 });
    expect(out.preprints[0]?.awards).toEqual(['IOS2402645']);
    expect(out.preprints[0]).not.toHaveProperty('funder');
    expect(out.notice).toBeUndefined();
    const rendered = text(result);
    expect(rendered).toContain('**bioRxiv:** page offset 0, total 12');
    expect(rendered).toMatch(/^\*\*Awards:\*\* IOS2402645$/m);
    expect(rendered).not.toContain('Mitsubishi');
    expect(JSON.stringify(result.structuredContent)).not.toContain('Mitsubishi');
  });

  // ── Local validation ────────────────────────────────────────────────────────

  it.each([
    ['021nxhr6', 'too short'],
    ['021nxhr63', 'bad checksum'],
    ['0zzzzzz99', 'bad checksum'],
    ['https://ror.org/021nxhr63', 'URL form, bad checksum'],
    ['National Science Foundation', 'a name, not an ID'],
  ])('rejects %j (%s) as invalid_funder before any request', async (funder) => {
    const result = await run({ server: 'biorxiv', funder });

    expect(result.isError).toBe(true);
    const error = structured(result).error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_funder', funder },
    });
    expect(error?.message).toMatch(/not a valid ROR ID/);
    expect(hint(result)).toMatch(/ror\.org/);
    const rendered = text(result);
    expect(rendered).toContain('Recovery:');
    expect(rendered).toContain('(reason invalid_funder)');
    expect(http.calls).toHaveLength(0);
  });

  it('rejects server="medrxiv" with a funder before any request', async () => {
    const result = await run({ server: 'medrxiv', funder: NSF });

    expect(result.isError).toBe(true);
    const error = structured(result).error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_funder', funder: NSF },
    });
    expect(error?.message).toMatch(/bioRxiv only/);
    expect(hint(result)).toMatch(/server to "biorxiv" or "both"/);
    expect(text(result)).toContain('(reason invalid_funder)');
    expect(http.calls).toHaveLength(0);
  });

  it('treats a blank funder as absent', async () => {
    answer({ biorxiv: { messages: LIVE.unfiltered }, medrxiv: { messages: LIVE.unfiltered } });
    const result = await run({ server: 'both', funder: '  ' });

    expect(result.isError).toBeFalsy();
    expect(sent()).toEqual({ biorxiv: {}, medrxiv: {} });
    expect(structured(result).notice).toBeUndefined();
  });

  // ── server="both" ───────────────────────────────────────────────────────────

  it('queries bioRxiv alone under server="both", with no medRxiv entry and a notice saying why', async () => {
    answer({ biorxiv: { messages: LIVE.nsf } });
    const result = await run({ server: 'both', funder: NSF });

    expect(result.isError).toBeFalsy();
    expect(sent()).toEqual({ biorxiv: { funder: NSF } });
    const out = structured(result);
    expect(out.pagination.biorxiv?.total).toBe(12);
    expect(out.pagination).not.toHaveProperty('medrxiv');
    expect(out.failed).toEqual([]);
    expect(out.notice).toMatch(/funder filter applies to bioRxiv only/);
    expect(out.notice).toMatch(/no medRxiv pagination entry/);
    const rendered = text(result);
    expect(rendered).toMatch(/funder filter applies to bioRxiv only/);
    expect(rendered).not.toContain('**medRxiv:**');
  });

  it('rejects a medRxiv-only category under server="both" + funder, naming the bioRxiv scope', async () => {
    const result = await run({ server: 'both', funder: NSF, category: 'Epidemiology' });

    expect(result.isError).toBe(true);
    const error = structured(result).error;
    expect(error?.data).toMatchObject({ reason: 'invalid_category' });
    expect(error?.message).toContain(
      'not valid for biorxiv (a funder filter queries bioRxiv only)',
    );
    expect(http.calls).toHaveLength(0);
  });

  // ── With category ───────────────────────────────────────────────────────────

  it('sends category and funder together and returns the doubly filtered page', async () => {
    answer({ biorxiv: { messages: LIVE.nsfNeuro, records: 4 } });
    const result = await run({ server: 'biorxiv', funder: NSF, category: 'Neuroscience' });

    expect(result.isError).toBeFalsy();
    expect(sent()).toEqual({ biorxiv: { category: 'neuroscience', funder: NSF } });
    expect(structured(result).pagination.biorxiv?.total).toBe(4);
    expect(structured(result).preprints).toHaveLength(4);
  });

  it('shares a "both" call\'s bioRxiv category with the funder, without a category note', async () => {
    answer({ biorxiv: { messages: LIVE.nsfNeuro, records: 4 } });
    const result = await run({ server: 'both', funder: NSF, category: 'Neuroscience' });

    expect(result.isError).toBeFalsy();
    expect(sent()).toEqual({ biorxiv: { category: 'neuroscience', funder: NSF } });
    const out = structured(result);
    expect(out.categoryNote).toBeUndefined();
    expect(out.notice).toMatch(/bioRxiv only/);
  });

  it('keeps the ignored-category guard: a funder page echoing category "all" raises invalid_category', async () => {
    answer({ biorxiv: { messages: LIVE.nsfIgnoredCategory, records: 12 } });
    const result = await run({ server: 'biorxiv', funder: NSF, category: 'Neuroscience' });

    expect(result.isError).toBe(true);
    expect(structured(result).error?.data).toMatchObject({
      reason: 'invalid_category',
      servers: ['biorxiv'],
    });
    expect(text(result)).not.toContain('IOS2402645');
  });

  // ── Upstream answers ────────────────────────────────────────────────────────

  it('raises invalid_funder on "funder value not found", never an empty page', async () => {
    answer({ biorxiv: { messages: LIVE.notFound } });
    const result = await run({ server: 'biorxiv', funder: '016jc2h42' });

    expect(result.isError).toBe(true);
    const error = structured(result).error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_funder', funder: '016jc2h42' },
    });
    expect(error?.message).toContain('no funder record for ROR ID 016jc2h42');
    expect(hint(result)).toMatch(/ror\.org/);
    expect(hint(result)).toMatch(/member institute/);
    const rendered = text(result);
    expect(rendered).toContain('(reason invalid_funder)');
    expect(rendered).not.toMatch(/No preprints found/);
    expect(result.structuredContent).not.toHaveProperty('preprints');
  });

  it('raises invalid_funder on "funder value not found" under server="both" too', async () => {
    answer({ biorxiv: { messages: LIVE.notFound } });
    const result = await run({ server: 'both', funder: '016jc2h42', category: 'Neuroscience' });

    expect(result.isError).toBe(true);
    expect(structured(result).error?.data).toMatchObject({ reason: 'invalid_funder' });
    expect(sent()).toEqual({ biorxiv: { category: 'neuroscience', funder: '016jc2h42' } });
  });

  it('names the funder among the applied filters when a known funder has no posts', async () => {
    answer({ biorxiv: { messages: LIVE.noPosts } });
    const result = await run({ server: 'biorxiv', funder: NSF, category: 'Paleontology' });

    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.preprints).toEqual([]);
    expect(out.notice).toBe(
      'No preprints found for dates 2026-08-01–2026-08-31, category "Paleontology", funder 021nxhr62, server "biorxiv". Try widening the date range or removing the category or funder filter.',
    );
    expect(text(result)).toContain('funder 021nxhr62');
  });

  it('composes the bioRxiv-only notice with the zero-result notice under server="both"', async () => {
    answer({ biorxiv: { messages: LIVE.noPosts } });
    const result = await run({ server: 'both', funder: NSF });

    const notice = structured(result).notice ?? '';
    expect(notice).toMatch(/^The funder filter applies to bioRxiv only/);
    expect(notice).toMatch(/No preprints found for .*funder 021nxhr62, server "biorxiv"\./);
    expect(notice).toMatch(/removing the funder filter\.$/);
  });

  it('marks a cursor past the funder page as exhausted, not as a missing funder', async () => {
    answer({ biorxiv: { messages: LIVE.noPosts } });
    const result = await run({ server: 'biorxiv', funder: NSF, cursor: 30 });

    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.pagination.biorxiv).toMatchObject({ cursor: 30, exhausted: true });
    expect(out.notice).toMatch(/Cursor 30 is past the last available page/);
  });
});
