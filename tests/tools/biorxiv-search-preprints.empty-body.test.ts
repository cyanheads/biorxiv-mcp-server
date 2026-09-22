/**
 * @fileoverview biorxiv_search_preprints end to end against EuropePMC's
 * empty-body response (HTTP 200, `{"version":"6.9"}` only). Only
 * `globalThis.fetch` for the EuropePMC origin is faked — the real
 * `fetchWithTimeout`, `withRetry`, `EuropePmcService` classification, tool
 * handler, `format()`, and error envelope all run, so both client surfaces
 * (`structuredContent` and `content[]`) are asserted as a caller receives them.
 * bioRxiv enrichment is stubbed; it is not on the path under test.
 * @module tests/tools/biorxiv-search-preprints.empty-body.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivSearchPreprintsTool } from '@/mcp-server/tools/definitions/biorxiv-search-preprints.tool.js';
import type { PreprintRevision } from '@/services/biorxiv/types.js';
import { initEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

const REVISION: PreprintRevision = {
  doi: '10.1101/2024.01.15.575123',
  title: 'Axolotl limb regeneration requires macrophages',
  authors: 'Smith J',
  date: '2024-01-15',
  version: '1',
  category: 'Developmental Biology',
  server: 'biorxiv',
};

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({ getDetails: () => Promise.resolve([REVISION]) }),
}));

const EMPTY_BODY = { version: '6.9' };

const POPULATED_BODY = {
  version: '6.9',
  hitCount: 2,
  resultList: {
    result: [
      {
        doi: '10.1101/2024.01.15.575123',
        title: 'Axolotl limb regeneration requires macrophages',
        authorString: 'Smith J',
        firstPublicationDate: '2024-01-15',
      },
    ],
  },
};

const http = createFetchMock();

function answerWith(...bodies: unknown[]): void {
  let call = 0;
  http.route({
    match: (request) => new URL(request.url).origin === new URL(BASE).origin,
    respond: () => {
      const body = bodies[Math.min(call, bodies.length - 1)];
      call++;
      return Response.json(body);
    },
  });
}

/** Run the tool through its contract boundary while fake timers skip the backoff. */
async function run(input: Record<string, unknown>) {
  const pending = runToolContract(biorxivSearchPreprintsTool, input as never, {
    context: { errors: biorxivSearchPreprintsTool.errors },
  });
  await vi.runAllTimersAsync();
  return pending;
}

function text(result: Awaited<ReturnType<typeof run>>): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function errorOf(result: Awaited<ReturnType<typeof run>>) {
  return (
    result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    }
  ).error;
}

describe('biorxiv_search_preprints — EuropePMC empty-body responses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    http.reset();
    http.install();
    initEuropePmcService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it('retries one empty body transparently — both surfaces carry the real results (#47)', async () => {
    answerWith(EMPTY_BODY, POPULATED_BODY);
    const result = await run({ query: 'axolotl limb regeneration macrophage', limit: 3 });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ totalCount: 2, partial_results: false });
    expect(structured.notice).toBeUndefined();
    expect((structured.preprints as unknown[]).length).toBe(1);
    const rendered = text(result);
    expect(rendered).toContain('10.1101/2024.01.15.575123');
    expect(rendered).not.toContain('No preprints matched');
    expect(http.calls).toHaveLength(2);
  });

  it('raises search_unavailable when the first-page empty body persists (#47)', async () => {
    answerWith(EMPTY_BODY);
    const result = await run({ query: 'axolotl limb regeneration macrophage' });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data.reason).toBe('search_unavailable');
    expect(error.message).toContain('no result list');
    expect(error.message).not.toContain('failed after');
    const hint = (error.data.recovery as { hint: string }).hint;
    // The request already ran from the first page — restarting from "*" is not
    // a next step here.
    expect(hint).not.toContain('*');
    expect(hint).not.toMatch(/cursor/i);
    const rendered = text(result);
    expect(rendered).toContain('no result list');
    expect(rendered).toContain('(reason search_unavailable)');
    expect(rendered).not.toContain('totalCount');
    expect(http.calls).toHaveLength(4);
  });

  it('raises invalid_cursor_mark for a cursor EuropePMC never recognizes (#43)', async () => {
    answerWith(EMPTY_BODY);
    const result = await run({ query: 'crispr', cursor_mark: 'garbage!!!' });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_cursor_mark',
      cursor_mark: 'garbage!!!',
      retryable: false,
    });
    expect(error.message).toContain('cursor_mark');
    expect(error.message).not.toContain('failed after');
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toContain('nextCursorMark');
    expect(hint).toContain('"*"');
    const rendered = text(result);
    expect(rendered).toContain('Recovery:');
    expect(rendered).toContain('nextCursorMark');
    expect(rendered).toContain('(reason invalid_cursor_mark · not retryable)');
    expect(http.calls).toHaveLength(4);
  });

  it('treats cursor_mark "*" as a first page — search_unavailable, never invalid_cursor_mark', async () => {
    answerWith(EMPTY_BODY);
    const result = await run({ query: 'crispr', cursor_mark: '*' });
    expect(errorOf(result).data.reason).toBe('search_unavailable');
  });

  it('leaves a valid cursor page unaffected when the empty body is intermittent (#43)', async () => {
    answerWith(EMPTY_BODY, EMPTY_BODY, POPULATED_BODY);
    const result = await run({ query: 'crispr', cursor_mark: 'AoIIQGlbEyg1NjAxNTg1MA==' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      queryEcho: { cursor_mark: 'AoIIQGlbEyg1NjAxNTg1MA==' },
    });
    expect(http.calls).toHaveLength(3);
  });

  // ── Cursor past the last match ─────────────────────────────────────────────

  /** Live shape of the page after the last match: `resultList` present and empty, real hitCount. */
  const PAST_END_BODY = { version: '6.9', hitCount: 2, resultList: { result: [] } };

  it('reports a cursor page past the last match as the end of the list on both surfaces', async () => {
    answerWith(PAST_END_BODY);
    const result = await run({ query: 'axolotl', cursor_mark: 'AoIIQFYMBSg1MDEzMjA1OA==' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ preprints: [], partial_results: false, totalCount: 2 });
    expect(structured.nextCursorMark).toBeUndefined();
    expect(structured.notice).toContain('all 2 matches were on earlier pages');
    const rendered = text(result);
    expect(rendered).toContain('all 2 matches were on earlier pages');
    expect(rendered).not.toContain('No preprints matched');
    expect(rendered).not.toContain('Try broader search terms');
    expect(http.calls).toHaveLength(1);
  });

  it('keeps the broaden-your-search notice for a first page with no matches', async () => {
    answerWith({ version: '6.9', hitCount: 0, resultList: { result: [] } });
    const result = await run({ query: 'xyzzyqqqnomatchterm123', cursor_mark: '*' });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.notice).toContain('No preprints matched');
    expect(text(result)).toContain('Try broader search terms');
  });

  it('reads a whitespace-only cursor_mark as the first page and does not echo it', async () => {
    answerWith(POPULATED_BODY);
    const result = await run({ query: 'axolotl', cursor_mark: '   ' });
    expect(result.isError).toBeFalsy();
    const echo = (result.structuredContent as { queryEcho: Record<string, unknown> }).queryEcho;
    expect(echo.cursor_mark).toBeUndefined();
    expect(text(result)).not.toContain('cursor=');
    const sent = new URL(http.calls[0]?.request.url ?? '').searchParams.get('cursorMark');
    expect(sent).toBe('*');
  });
});
