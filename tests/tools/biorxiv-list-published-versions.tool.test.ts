/**
 * @fileoverview Tests for biorxiv_list_published_versions — publication-date
 * interval listing, per-server pagination, past-the-end cursors, partial and
 * total upstream failure, include_abstract, the publisher filter, and both
 * client surfaces.
 * @module tests/tools/biorxiv-list-published-versions.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivListPublishedVersionsTool as listTool } from '@/mcp-server/tools/definitions/biorxiv-list-published-versions.tool.js';
import type { PublishedListingResult, PublishedVersion } from '@/services/biorxiv/types.js';
import { ESCAPED, IDENTIFIERS, UPSTREAM } from '../helpers/markdown-fixtures.js';
import {
  NO_ARTICLES,
  PUBLISHED_64898,
  PUBLISHER_ELIFE_ROWS,
  PUBLISHER_NO_ARTICLES,
  PUBLISHER_NOT_RECOGNIZED,
  PUBS_ROW_64898,
} from '../helpers/pubs-fixtures.js';
import {
  declaredRateLimitRecovery,
  RATE_LIMIT_RECOVERY_OPENING,
  rateLimitError,
} from '../helpers/rate-limit.js';
import { envelopeHint, recoveryHint, rejection } from '../helpers/rejection.js';

const mockGetPublishedListing = vi.fn();

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({ getPublishedListing: mockGetPublishedListing }),
}));

const WEEK = { start_date: '2026-09-01', end_date: '2026-09-07' };

/** A `10.1101/` publication on medRxiv. */
const MEDRXIV_PUB: PublishedVersion = {
  preprintDoi: '10.1101/2025.08.19.25333983',
  publishedDoi: '10.3389/fdgth.2026.1823218',
  publishedJournal: 'Frontiers in Digital Health',
  publishedDate: '2026-09-03',
  preprintTitle: 'A pilot comparison of remote versus in-clinic digital cognitive assessments',
  preprintDate: '2025-08-21',
  preprintAbstract: 'Improved methods of cognitive testing are urgently needed.',
};

/** `n` distinct bioRxiv publications, for full pages. */
function rows(n: number, from = 0): PublishedVersion[] {
  return Array.from({ length: n }, (_, i) => ({
    preprintDoi: `10.64898/2026.01.01.${String(700000 + from + i)}`,
    publishedDate: '2026-09-02',
  }));
}

function page(
  publications: PublishedVersion[],
  cursor: number,
  total?: number,
): PublishedListingResult {
  return {
    publications,
    pagination: { cursor, ...(total !== undefined && { total }) },
    rowCount: publications.length,
  };
}

/** Upstream answer to a cursor at or past the end, and to an empty interval: no rows, no total. */
const empty = (cursor: number) => page([], cursor);

/** Route the service mock per server. */
function perServer(
  answers: Record<'biorxiv' | 'medrxiv', PublishedListingResult | Error>,
): (server: 'biorxiv' | 'medrxiv') => Promise<PublishedListingResult> {
  return (server) => {
    const answer = answers[server];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
}

async function call(args: Record<string, unknown>) {
  const result = await runToolContract(listTool, { ...WEEK, ...args } as never, {
    context: { errors: listTool.errors },
  });
  const structured = result.structuredContent as {
    publications: Record<string, unknown>[];
    pagination: Record<string, Record<string, unknown>>;
    failed: { server: string; error: string }[];
    notice?: string;
  };
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return { result, structured, text };
}

describe('biorxivListPublishedVersionsTool', () => {
  beforeEach(() => {
    mockGetPublishedListing.mockReset();
    mockGetPublishedListing.mockResolvedValue(page([PUBLISHED_64898], 0, 1));
  });

  // ── Input ───────────────────────────────────────────────────────────────────

  it('defaults server to "both", cursor to 0, limit to 25, and include_abstract to false', () => {
    const input = listTool.input.parse(WEEK);
    expect(input).toEqual({
      ...WEEK,
      server: 'both',
      cursor: 0,
      limit: 25,
      include_abstract: false,
    });
  });

  it('accepts date_from / date_to, the date-bound spelling biorxiv_search_preprints uses', async () => {
    const aliased = await runToolContract(
      listTool,
      { date_from: '2026-09-01', date_to: '2026-09-07', server: 'biorxiv' } as never,
      { context: { errors: listTool.errors } },
    );
    expect(aliased.isError).toBeFalsy();
    expect(mockGetPublishedListing).toHaveBeenCalledWith(
      'biorxiv',
      '2026-09-01',
      '2026-09-07',
      0,
      25,
      expect.any(Number),
      expect.anything(),
    );
  });

  it('rejects a negative cursor at schema parse time', () => {
    expect(() => listTool.input.parse({ ...WEEK, cursor: -100 })).toThrow();
  });

  // Upstream answers each of these with HTTP 200 and an empty page, which would
  // read as "nothing was published", so none of them may reach it.
  describe.each(['start_date', 'end_date'] as const)('a malformed %s', (bound) => {
    it.each(['2026-9-1', 'abc', '', '   ', ' 2026-09-01', '2026-09-01T00:00:00Z', '09/01/2026'])(
      'rejects %j at the schema as -32602 naming the field, before any upstream call',
      async (value) => {
        const { result } = await call({ server: 'biorxiv', [bound]: value });
        expect(result.isError).toBe(true);
        const error = (result.structuredContent as { error: { code: number; message: string } })
          .error;
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.message).toContain(bound);
        expect(mockGetPublishedListing).not.toHaveBeenCalled();
      },
    );

    it('carries a hint naming the YYYY-MM-DD form, not the raw pattern', async () => {
      const { result, text } = await call({ server: 'biorxiv', [bound]: '2026-9-1' });
      expect(envelopeHint(result)).toContain('YYYY-MM-DD');
      expect(envelopeHint(result)).not.toContain('\\d');
      expect(text).toContain('YYYY-MM-DD');
      expect(text).not.toContain('\\d');
    });
  });

  it('rejects a malformed date_from alias at the schema as its start_date target', async () => {
    const result = await runToolContract(
      listTool,
      { date_from: '2026-9-1', date_to: '2026-09-07', server: 'biorxiv' } as never,
      { context: { errors: listTool.errors } },
    );
    const error = (result.structuredContent as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.message).toContain('start_date');
    expect(mockGetPublishedListing).not.toHaveBeenCalled();
  });

  it('advertises the YYYY-MM-DD pattern on both required date bounds in tools/list', () => {
    const schema = z.toJSONSchema(listTool.input, { io: 'input' }) as {
      properties: Record<string, { type?: string; pattern?: string }>;
      required?: string[];
    };
    for (const bound of ['start_date', 'end_date']) {
      expect(schema.properties[bound]).toMatchObject({
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      });
      expect(schema.required).toContain(bound);
    }
  });

  it.each([
    ['a calendar-impossible month', { start_date: '2026-13-01' }],
    ['a day-of-month overflow', { end_date: '2026-02-30' }],
    ['Feb 29 in a non-leap year', { start_date: '2025-02-29' }],
    ['an inverted interval', { start_date: '2026-09-07', end_date: '2026-09-01' }],
  ])('fails invalid_date_range before any upstream call for %s', async (_label, dates) => {
    const ctx = createMockContext({ errors: listTool.errors });
    const input = listTool.input.parse({ ...WEEK, ...dates });
    const err = await rejection(listTool.handler(input, ctx));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
    expect(mockGetPublishedListing).not.toHaveBeenCalled();
  });

  it('accepts a single day and a valid leap day', async () => {
    for (const day of ['2026-09-07', '2024-02-29']) {
      const { result } = await call({ start_date: day, end_date: day, server: 'biorxiv' });
      expect(result.isError).toBeFalsy();
    }
  });

  // ── Pagination ──────────────────────────────────────────────────────────────

  it('queries both servers by default and names each row by the server that listed it', async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({
        biorxiv: page([PUBLISHED_64898], 0, 1),
        medrxiv: page([MEDRXIV_PUB], 0, 1),
      }),
    );
    const { structured } = await call({});
    expect(mockGetPublishedListing).toHaveBeenCalledTimes(2);
    expect(structured.publications.map((p) => [p.server, p.preprintDoi])).toEqual([
      ['biorxiv', PUBLISHED_64898.preprintDoi],
      ['medrxiv', MEDRXIV_PUB.preprintDoi],
    ]);
    expect(structured.pagination).toEqual({
      biorxiv: { cursor: 0, total: 1 },
      medrxiv: { cursor: 0, total: 1 },
    });
    expect(structured.failed).toEqual([]);
  });

  it('queries one server when asked, with no entry for the other', async () => {
    const { structured } = await call({ server: 'medrxiv' });
    expect(mockGetPublishedListing).toHaveBeenCalledTimes(1);
    expect(mockGetPublishedListing.mock.calls[0]?.[0]).toBe('medrxiv');
    expect(structured.pagination).toEqual({ medrxiv: { cursor: 0, total: 1 } });
    expect(structured.publications[0]?.server).toBe('medrxiv');
  });

  it('offers the next cursor until the last page, which says so', async () => {
    mockGetPublishedListing.mockResolvedValueOnce(page(rows(100), 0, 449));
    const first = await call({ server: 'biorxiv', limit: 100 });
    expect(first.structured.pagination.biorxiv).toEqual({ cursor: 0, total: 449, nextCursor: 100 });
    expect(first.text).toContain('**bioRxiv:** page offset 0, total 449 — next cursor: 100');

    // Live: cursor 400 holds the last 49 of 449 rows.
    mockGetPublishedListing.mockResolvedValueOnce(page(rows(49, 400), 400, 449));
    const last = await call({ server: 'biorxiv', cursor: 400, limit: 100 });
    expect(last.structured.pagination.biorxiv).toEqual({ cursor: 400, total: 449 });
    expect(last.text).toContain('**bioRxiv:** page offset 400, total 449 (last page)');
  });

  it('continues from an arbitrary offset by the rows actually returned', async () => {
    // Live: cursor 5 returns rows 5..104; the next unread row is 105.
    mockGetPublishedListing.mockResolvedValue(page(rows(100, 5), 5, 449));
    const { structured } = await call({ server: 'biorxiv', cursor: 5, limit: 100 });
    expect(structured.pagination.biorxiv?.nextCursor).toBe(105);
  });

  it("at cursor 100 returns medRxiv's last 3 rows with no next cursor while bioRxiv continues", async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({
        biorxiv: page(rows(100, 100), 100, 449),
        medrxiv: page([MEDRXIV_PUB, ...rows(2, 900)], 100, 103),
      }),
    );
    const { structured, text } = await call({ cursor: 100, limit: 100 });
    expect(structured.pagination).toEqual({
      biorxiv: { cursor: 100, total: 449, nextCursor: 200 },
      medrxiv: { cursor: 100, total: 103 },
    });
    expect(structured.publications.filter((p) => p.server === 'medrxiv')).toHaveLength(3);
    // The only qualification is the one server with rows left past this page,
    // and continuing it alone keeps the finished server out of the next call.
    expect(structured.notice).toBe(
      'More rows remain past this page on bioRxiv (next cursor 200) — pass that nextCursor as cursor with server set to "biorxiv" to continue it.',
    );
    expect(text).toContain('**medRxiv:** page offset 100, total 103 (last page)');
  });

  it('names medRxiv as the server to pass when it is the one server still continuing', async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({
        biorxiv: page(rows(3, 100), 100, 103),
        medrxiv: page(rows(25, 500), 100, 449),
      }),
    );
    const { structured, text } = await call({ cursor: 100 });
    const notice =
      'More rows remain past this page on medRxiv (next cursor 125) — pass that nextCursor as cursor with server set to "medrxiv" to continue it.';
    expect(structured).toMatchObject({ truncated: true, shown: 28, cap: 50, notice });
    expect(text).toContain(`> ${notice}`);
  });

  // The real service runs here, so its normalization (which drops a row naming
  // no preprint) sits between the upstream page and the cursor arithmetic.
  describe('a page holding a row with no preprint DOI', () => {
    const http = createFetchMock();
    const PATH = '/pubs/biorxiv/2026-09-01/2026-09-07';

    function upstream(cursor: number, collection: object[], total: string): void {
      http.route({
        match: (request) => new URL(request.url).pathname === `${PATH}/${cursor}/json`,
        respond: () =>
          Response.json({
            messages: [{ status: 'ok', cursor: String(cursor), count: collection.length, total }],
            collection,
          }),
      });
    }

    beforeEach(async () => {
      http.reset();
      http.install();
      const { BiorxivApiService } = await vi.importActual<
        typeof import('@/services/biorxiv/biorxiv-service.js')
      >('@/services/biorxiv/biorxiv-service.js');
      const real = new BiorxivApiService({} as AppConfig, {} as StorageService);
      mockGetPublishedListing.mockImplementation(real.getPublishedListing.bind(real));
    });

    afterEach(() => http.restore());

    it('advances the cursor past every upstream row, the dropped one included', async () => {
      const raw = Array.from({ length: 100 }, (_, i) => ({
        ...PUBS_ROW_64898,
        preprint_doi: `10.64898/2026.01.01.${700100 + i}`,
      }));
      const { preprint_doi: _dropped, ...noPreprint } = PUBS_ROW_64898;
      raw[42] = { ...noPreprint, preprint_doi: '' };
      upstream(100, raw, '449');

      const { structured, text } = await call({ server: 'biorxiv', cursor: 100, limit: 100 });
      expect(structured.publications).toHaveLength(99);
      expect(structured.pagination.biorxiv).toEqual({ cursor: 100, total: 449, nextCursor: 200 });
      expect(text).toContain('**bioRxiv:** page offset 100, total 449 — next cursor: 200');
    });

    it('advances a 25-row slice past every row it served, the dropped one included', async () => {
      const raw = Array.from({ length: 100 }, (_, i) => ({
        ...PUBS_ROW_64898,
        preprint_doi: `10.64898/2026.01.01.${700100 + i}`,
      }));
      const { preprint_doi: _dropped, ...noPreprint } = PUBS_ROW_64898;
      raw[10] = { ...noPreprint, preprint_doi: '' };
      upstream(100, raw, '449');

      const { structured, text } = await call({ server: 'biorxiv', cursor: 100, limit: 25 });
      expect(structured.publications.map((p) => p.preprintDoi)).toEqual(
        raw
          .slice(0, 25)
          .filter((_, i) => i !== 10)
          .map((r) => r.preprint_doi),
      );
      expect(structured.pagination.biorxiv).toEqual({ cursor: 100, total: 449, nextCursor: 125 });
      expect(structured).toMatchObject({ truncated: true, shown: 24, cap: 25 });
      expect(text).toContain('**bioRxiv:** page offset 100, total 449 — next cursor: 125');
    });

    it('reads a page whose only row was dropped as answered, not as past the end', async () => {
      const { preprint_doi: _dropped, ...noPreprint } = PUBS_ROW_64898;
      upstream(400, [noPreprint], '401');

      const { structured, text } = await call({ server: 'biorxiv', cursor: 400 });
      expect(structured.publications).toEqual([]);
      expect(structured.pagination.biorxiv).toEqual({ cursor: 400, total: 401 });
      expect(structured.notice ?? '').not.toMatch(/past the last row/);
      expect(text).toContain('**bioRxiv:** page offset 400, total 401 (last page)');
    });
  });

  it('marks the server a cursor overshot as exhausted, with no total, and says so', async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({ biorxiv: page(rows(100, 200), 200, 449), medrxiv: empty(200) }),
    );
    const { structured, text } = await call({ cursor: 200 });
    expect(structured.pagination.medrxiv).toEqual({ cursor: 200, exhausted: true });
    expect(structured.pagination.medrxiv).not.toHaveProperty('total');
    expect(structured.notice).toMatch(/Cursor 200 is at or past the last row on medRxiv/);
    expect(text).toContain('**medRxiv:** page offset 200 — cursor exhausted');
    expect(text).not.toMatch(/medRxiv:\*\* page offset 200.*\(last page\)/);
  });

  it('at cursor 500 marks both servers exhausted with no total, as a success', async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({ biorxiv: empty(500), medrxiv: empty(500) }),
    );
    const { result, structured, text } = await call({ cursor: 500 });
    expect(result.isError).toBeFalsy();
    expect(structured.publications).toEqual([]);
    expect(structured.pagination).toEqual({
      biorxiv: { cursor: 500, exhausted: true },
      medrxiv: { cursor: 500, exhausted: true },
    });
    expect(structured.notice).toMatch(/Cursor 500 is at or past the last row/);
    expect(structured.notice).not.toMatch(/No journal publications found/);
    expect(text).not.toContain('## Journal publications');
  });

  it('reports total 0 for an empty interval at cursor 0, with a route to the posting-date listing', async () => {
    mockGetPublishedListing.mockResolvedValue(empty(0));
    const { result, structured, text } = await call({ server: 'biorxiv' });
    expect(result.isError).toBeFalsy();
    expect(structured.pagination).toEqual({ biorxiv: { cursor: 0, total: 0 } });
    expect(structured.notice).toBe(
      'No journal publications found for publication dates 2026-09-01–2026-09-07 on bioRxiv. Try widening the date range, or use biorxiv_list_recent to list preprints by posting date instead.',
    );
    expect(text).toContain('**bioRxiv:** page offset 0, total 0 (last page)');
  });

  // ── limit ───────────────────────────────────────────────────────────────────

  /**
   * The real service runs against a fake `/pubs` interval shaped like the week
   * 2026-09-01..07 (bioRxiv 449 rows, medRxiv 103; 2026-10-01..07 holds none).
   * Like the live API it serves the 100 rows from any cursor offset, takes no
   * page-size parameter, and answers a cursor at or past the end with "no
   * articles found" and no total.
   */
  describe('limit', () => {
    const http = createFetchMock();
    const PUBS = /^\/pubs\/(biorxiv|medrxiv)\/(\d{4}-\d{2}-\d{2})\/\d{4}-\d{2}-\d{2}\/(\d+)\/json$/;
    const ROWS = { biorxiv: 449, medrxiv: 103 } as const;
    type Server = keyof typeof ROWS;

    /** Row `i` of a server's interval, in upstream order. */
    const doi = (server: Server, i: number) =>
      `10.64898/2026.0${server === 'biorxiv' ? 1 : 2}.01.${800000 + i}`;
    const dois = (server: Server, from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => doi(server, from + i));
    const served = (structured: { publications: Record<string, unknown>[] }, server: Server) =>
      structured.publications.filter((p) => p.server === server).map((p) => p.preprintDoi);
    const requested = () => http.calls.map((c) => new URL(c.request.url).pathname).sort();

    beforeEach(async () => {
      http.reset();
      http.route({
        match: (request) => PUBS.test(new URL(request.url).pathname),
        respond: (request) => {
          const [, server, start, at] = PUBS.exec(new URL(request.url).pathname) as string[];
          const total = start === '2026-09-01' ? ROWS[server as Server] : 0;
          const cursor = Number(at);
          if (cursor >= total) return Response.json({ messages: [NO_ARTICLES], collection: [] });
          const collection = dois(server as Server, cursor, Math.min(cursor + 100, total)).map(
            (preprint_doi) => ({ ...PUBS_ROW_64898, preprint_doi }),
          );
          return Response.json({
            messages: [{ status: 'ok', cursor, count: collection.length, total: String(total) }],
            collection,
          });
        },
      });
      http.install();
      const { BiorxivApiService } = await vi.importActual<
        typeof import('@/services/biorxiv/biorxiv-service.js')
      >('@/services/biorxiv/biorxiv-service.js');
      const real = new BiorxivApiService({} as AppConfig, {} as StorageService);
      mockGetPublishedListing.mockImplementation(real.getPublishedListing.bind(real));
    });

    afterEach(() => http.restore());

    it('serves 25 rows per server by default in one upstream request each, continuing at 25', async () => {
      const { structured, text } = await call({});
      expect(requested()).toEqual([
        '/pubs/biorxiv/2026-09-01/2026-09-07/0/json',
        '/pubs/medrxiv/2026-09-01/2026-09-07/0/json',
      ]);
      expect(served(structured, 'biorxiv')).toEqual(dois('biorxiv', 0, 25));
      expect(served(structured, 'medrxiv')).toEqual(dois('medrxiv', 0, 25));
      expect(structured.pagination).toEqual({
        biorxiv: { cursor: 0, total: 449, nextCursor: 25 },
        medrxiv: { cursor: 0, total: 103, nextCursor: 25 },
      });
      // Both servers continue at one cursor, so either nextCursor continues both.
      const notice =
        "More rows remain past this page on bioRxiv (next cursor 25) and medRxiv (next cursor 25) — pass a server's nextCursor as cursor to continue it.";
      // cap is the most the page can hold: 25 rows per server × 2 servers.
      expect(structured).toMatchObject({ truncated: true, shown: 50, cap: 50, notice });
      expect(text).toContain('**bioRxiv:** page offset 0, total 449 — next cursor: 25');
      expect(text).toContain('**medRxiv:** page offset 0, total 103 — next cursor: 25');
      expect(text).toContain('## Journal publications (50 shown)');
      expect(text).toContain(notice);
      expect(text).toContain('**truncated:** true\n**shown:** 50\n**cap:** 50\n');
    });

    it('caps one server at limit rows, and keeps the general continuation wording', async () => {
      const { structured, text } = await call({ server: 'medrxiv' });
      const notice =
        "More rows remain past this page on medRxiv (next cursor 25) — pass a server's nextCursor as cursor to continue it.";
      expect(structured).toMatchObject({ truncated: true, shown: 25, cap: 25, notice });
      expect(text).toContain('**truncated:** true\n**shown:** 25\n**cap:** 25\n');
    });

    it('under "both" past medRxiv\'s last row, names bioRxiv as the server to pass, on both surfaces', async () => {
      const { structured, text } = await call({ cursor: 125 });
      expect(served(structured, 'biorxiv')).toEqual(dois('biorxiv', 125, 150));
      expect(structured.pagination).toEqual({
        biorxiv: { cursor: 125, total: 449, nextCursor: 150 },
        medrxiv: { cursor: 125, exhausted: true },
      });
      const notice =
        'Cursor 125 is at or past the last row on medRxiv — that entry is marked exhausted and carries no total. Lower the cursor to page that server. More rows remain past this page on bioRxiv (next cursor 150) — pass that nextCursor as cursor with server set to "biorxiv" to continue it.';
      expect(structured).toMatchObject({ truncated: true, shown: 25, cap: 50, notice });
      expect(text).toContain(`> ${notice}`);
      expect(text).toContain('**truncated:** true\n**shown:** 25\n**cap:** 50\n');
    });

    it('a "both" walk that follows the notice requests medRxiv only for its own 5 pages', async () => {
      const seen: Record<Server, unknown[]> = { biorxiv: [], medrxiv: [] };
      let args: { server: 'both' | Server; cursor: number } = { server: 'both', cursor: 0 };
      let calls = 0;
      while (calls < 40) {
        calls += 1;
        const { structured } = await call({ ...args, limit: 25 });
        seen.biorxiv.push(...served(structured, 'biorxiv'));
        seen.medrxiv.push(...served(structured, 'medrxiv'));
        const named = /with server set to "(biorxiv|medrxiv)"/.exec(structured.notice ?? '');
        const server = (named?.[1] as Server | undefined) ?? args.server;
        const next =
          server === 'both'
            ? (structured.pagination.biorxiv?.nextCursor ??
              structured.pagination.medrxiv?.nextCursor)
            : structured.pagination[server]?.nextCursor;
        if (next === undefined) break;
        args = { server, cursor: next as number };
      }
      const requestsTo = (server: Server) =>
        http.calls.filter((c) => new URL(c.request.url).pathname.startsWith(`/pubs/${server}/`))
          .length;

      expect(calls).toBe(18);
      expect(requestsTo('biorxiv')).toBe(18);
      expect(requestsTo('medrxiv')).toBe(5);
      expect(seen.biorxiv).toEqual(dois('biorxiv', 0, 449));
      expect(seen.medrxiv).toEqual(dois('medrxiv', 0, 103));
    });

    it('limit 100 returns the rows and pagination of the whole 100-row page', async () => {
      const { structured } = await call({ limit: 100 });
      expect(served(structured, 'biorxiv')).toEqual(dois('biorxiv', 0, 100));
      expect(served(structured, 'medrxiv')).toEqual(dois('medrxiv', 0, 100));
      expect(structured.pagination).toEqual({
        biorxiv: { cursor: 0, total: 449, nextCursor: 100 },
        medrxiv: { cursor: 0, total: 103, nextCursor: 100 },
      });
    });

    it.each([101, 250, 1000])(
      'limit %i serves the 100-row page per server and names it in the notice',
      async (limit) => {
        const { result, structured, text } = await call({ limit });
        expect(result.isError).toBeFalsy();
        expect(requested()).toHaveLength(2);
        expect(served(structured, 'biorxiv')).toEqual(dois('biorxiv', 0, 100));
        expect(served(structured, 'medrxiv')).toEqual(dois('medrxiv', 0, 100));
        expect(structured.pagination).toEqual({
          biorxiv: { cursor: 0, total: 449, nextCursor: 100 },
          medrxiv: { cursor: 0, total: 103, nextCursor: 100 },
        });
        const notice = `A limit of ${limit} is above the 100-row page api.biorxiv.org serves, so this page holds up to 100 rows per server. More rows remain past this page on bioRxiv (next cursor 100) and medRxiv (next cursor 100) — pass a server's nextCursor as cursor to continue it.`;
        // The clamped page size, never the requested limit, times 2 servers.
        expect(structured).toMatchObject({ truncated: true, shown: 200, cap: 200, notice });
        expect(text).toContain(notice);
        // Whole lines: "**cap:** 2000", a cap computed from limit 1000, still contains "**cap:** 200".
        expect(text).toContain('**truncated:** true\n**shown:** 200\n**cap:** 200\n');
      },
    );

    it('limit 100 names no 100-row page, since nothing was capped', async () => {
      const { structured } = await call({ limit: 100 });
      expect(structured.notice).not.toMatch(/100-row page/);
      expect(structured).toMatchObject({ shown: 200, cap: 200 });
    });

    it.each([0, 1001, -25, 2.5])(
      'rejects limit %j at the schema as -32602 naming the field, before any upstream call',
      async (limit) => {
        const { result } = await call({ limit });
        const error = (result.structuredContent as { error: { code: number; message: string } })
          .error;
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.message).toContain('limit');
        expect(http.calls).toHaveLength(0);
      },
    );

    it('limit 1, the floor, serves one row per server and continues at cursor 1, on both surfaces', async () => {
      const { result, structured, text } = await call({ limit: 1 });
      expect(result.isError).toBeFalsy();
      expect(served(structured, 'biorxiv')).toEqual(dois('biorxiv', 0, 1));
      expect(served(structured, 'medrxiv')).toEqual(dois('medrxiv', 0, 1));
      expect(structured.pagination).toEqual({
        biorxiv: { cursor: 0, total: 449, nextCursor: 1 },
        medrxiv: { cursor: 0, total: 103, nextCursor: 1 },
      });
      expect(structured).toMatchObject({ truncated: true, shown: 2, cap: 2 });
      expect(text).toContain('**bioRxiv:** page offset 0, total 449 — next cursor: 1\n');
      expect(text).toContain('**medRxiv:** page offset 0, total 103 — next cursor: 1\n');
      expect(text).toContain('**truncated:** true\n**shown:** 2\n**cap:** 2\n');
    });

    it('walks bioRxiv at limit 25 in 18 calls, every row once, the last at cursor 425', async () => {
      const cursors: number[] = [];
      const seen: unknown[] = [];
      let cursor: number | undefined = 0;
      let last: Awaited<ReturnType<typeof call>> | undefined;
      while (cursor !== undefined && cursors.length < 30) {
        cursors.push(cursor);
        last = await call({ server: 'biorxiv', cursor, limit: 25 });
        seen.push(...served(last.structured, 'biorxiv'));
        cursor = last.structured.pagination.biorxiv?.nextCursor as number | undefined;
      }
      expect(cursors).toEqual(Array.from({ length: 18 }, (_, i) => i * 25));
      expect(http.calls).toHaveLength(18);
      expect(seen).toEqual(dois('biorxiv', 0, 449));
      expect(new Set(seen).size).toBe(449);
      expect(served(last?.structured ?? { publications: [] }, 'biorxiv')).toHaveLength(24);
      expect(last?.structured.pagination.biorxiv).toEqual({ cursor: 425, total: 449 });
      expect(last?.structured).not.toHaveProperty('truncated');
      expect(last?.structured).not.toHaveProperty('notice');
      expect(last?.text).toContain('**bioRxiv:** page offset 425, total 449 (last page)');
    });

    it('continues a walk started at cursor 37 at 62, 87, 112', async () => {
      const cursors: number[] = [];
      let cursor = 37;
      for (let i = 0; i < 3; i++) {
        const { structured } = await call({ server: 'biorxiv', cursor, limit: 25 });
        expect(served(structured, 'biorxiv')).toEqual(dois('biorxiv', cursor, cursor + 25));
        cursor = structured.pagination.biorxiv?.nextCursor as number;
        cursors.push(cursor);
      }
      expect(cursors).toEqual([62, 87, 112]);
    });

    it("at cursor 100 returns medRxiv's last 3 rows with no next cursor and bioRxiv's 25 continuing at 125", async () => {
      const { structured, text } = await call({ cursor: 100, limit: 25 });
      expect(served(structured, 'biorxiv')).toEqual(dois('biorxiv', 100, 125));
      expect(served(structured, 'medrxiv')).toEqual(dois('medrxiv', 100, 103));
      expect(structured.pagination).toEqual({
        biorxiv: { cursor: 100, total: 449, nextCursor: 125 },
        medrxiv: { cursor: 100, total: 103 },
      });
      expect(structured).toMatchObject({ truncated: true, shown: 28, cap: 50 });
      expect(text).toContain('**medRxiv:** page offset 100, total 103 (last page)');
      expect(text).toContain('**bioRxiv:** page offset 100, total 449 — next cursor: 125');
    });

    it.each([
      [
        449,
        { biorxiv: { cursor: 449, exhausted: true }, medrxiv: { cursor: 449, exhausted: true } },
      ],
      [
        103,
        {
          biorxiv: { cursor: 103, total: 449, nextCursor: 128 },
          medrxiv: { cursor: 103, exhausted: true },
        },
      ],
    ])(
      'marks a cursor at %i exhausted, with no total, on the server it reached the end of',
      async (cursor, pagination) => {
        const { result, structured } = await call({ cursor, limit: 25 });
        expect(result.isError).toBeFalsy();
        expect(structured.pagination).toEqual(pagination);
        expect(structured.notice).toMatch(
          new RegExp(`Cursor ${cursor} is at or past the last row`),
        );
      },
    );

    it('reports total 0 for an empty interval at cursor 0, with no truncation', async () => {
      const { structured } = await call({
        start_date: '2026-10-01',
        end_date: '2026-10-07',
        server: 'biorxiv',
      });
      expect(structured.pagination).toEqual({ biorxiv: { cursor: 0, total: 0 } });
      expect(structured).not.toHaveProperty('truncated');
      expect(structured.notice).toMatch(/^No journal publications found for publication dates/);
    });

    it.each([5, 250])('include_abstract removes only the abstract at limit %i', async (limit) => {
      const shown = Math.min(limit, 100);
      const withAbstracts = await call({ server: 'biorxiv', limit, include_abstract: true });
      expect(withAbstracts.structured.publications).toHaveLength(shown);
      for (const p of withAbstracts.structured.publications) {
        expect(p.preprintAbstract).toBe(PUBS_ROW_64898.preprint_abstract);
      }
      const without = await call({ server: 'biorxiv', limit });
      expect(served(without.structured, 'biorxiv')).toEqual(
        served(withAbstracts.structured, 'biorxiv'),
      );
      for (const p of without.structured.publications)
        expect(p).not.toHaveProperty('preprintAbstract');
      expect(without.text).not.toContain(PUBS_ROW_64898.preprint_abstract);
    });
  });

  it('keeps a failed server in failed[] at any limit, ahead of the truncation notice', async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({ biorxiv: new Error('bioRxiv down'), medrxiv: page(rows(5), 0, 103) }),
    );
    const { result, structured } = await call({ limit: 5 });
    expect(result.isError).toBeFalsy();
    expect(mockGetPublishedListing).toHaveBeenCalledWith(
      'medrxiv',
      '2026-09-01',
      '2026-09-07',
      0,
      5,
      expect.any(Number),
      expect.anything(),
    );
    expect(structured.failed).toEqual([{ server: 'biorxiv', error: 'bioRxiv down' }]);
    expect(structured.pagination).toEqual({ medrxiv: { cursor: 0, total: 103, nextCursor: 5 } });
    // Both servers were queried, so the page could have held 5 rows from each.
    expect(structured).toMatchObject({ truncated: true, shown: 5, cap: 10 });
    // A failed server keeps the general wording: retrying "both" is how it gets included.
    expect(structured.notice).toBe(
      "bioRxiv did not answer, so this result set is partial — it holds no bioRxiv publications. See failed[] for the error and retry to include them. More rows remain past this page on medRxiv (next cursor 5) — pass a server's nextCursor as cursor to continue it.",
    );
  });

  // ── Upstream failure ────────────────────────────────────────────────────────

  it('returns the answering server and names the failed one in failed[] and the notice', async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({ biorxiv: new Error('bioRxiv down'), medrxiv: page([MEDRXIV_PUB], 0, 1) }),
    );
    const { result, structured, text } = await call({});
    expect(result.isError).toBeFalsy();
    expect(structured.failed).toEqual([{ server: 'biorxiv', error: 'bioRxiv down' }]);
    expect(structured.pagination).toEqual({ medrxiv: { cursor: 0, total: 1 } });
    expect(structured.notice).toMatch(/bioRxiv did not answer, so this result set is partial/);
    expect(text).toContain(
      '**bioRxiv:** server did not answer — no publications from it are included (bioRxiv down)',
    );
  });

  it('keeps the partial qualification when the answering server is empty too', async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({ biorxiv: empty(0), medrxiv: new Error('medRxiv down') }),
    );
    const { structured } = await call({});
    expect(structured.notice).toMatch(/medRxiv did not answer/);
    expect(structured.notice).toMatch(/No journal publications found/);
  });

  it('raises retryable upstream_unavailable when neither server answered', async () => {
    const bxDown = new Error('biorxiv down');
    mockGetPublishedListing.mockImplementation(
      perServer({ biorxiv: bxDown, medrxiv: new Error('medrxiv down') }),
    );
    const ctx = createMockContext({ errors: listTool.errors });
    const err = await rejection(listTool.handler(listTool.input.parse(WEEK), ctx));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true, servers: ['biorxiv', 'medrxiv'] },
    });
    expect(err.message).toContain('biorxiv down');
    expect(err.message).toContain('medrxiv down');
    expect(err.cause).toBe(bxDown);

    const { result } = await call({});
    expect(result.isError).toBe(true);
    expect(envelopeHint(result)).toMatch(/retry/i);
  });

  it('raises upstream_unavailable, not an empty page, when the one requested server fails', async () => {
    mockGetPublishedListing.mockRejectedValue(new Error('timeout'));
    const ctx = createMockContext({ errors: listTool.errors });
    const err = await rejection(
      listTool.handler(listTool.input.parse({ ...WEEK, server: 'medrxiv' }), ctx),
    );
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', servers: ['medrxiv'] },
    });
    expect(err.message).toBe('medRxiv did not answer — timeout');
  });

  it('declares a rate_limited recovery that holds when the origin named no wait', () => {
    expect(declaredRateLimitRecovery(listTool.errors)).toBe(
      `${RATE_LIMIT_RECOVERY_OPENING}retrying — every preprint metadata tool queries the same origin, so none of them will answer sooner.`,
    );
  });

  it('raises rate_limited with the longer wait when a failure is a 429', async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({ biorxiv: rateLimitError(15), medrxiv: rateLimitError(90) }),
    );
    const ctx = createMockContext({ errors: listTool.errors });
    const err = await rejection(listTool.handler(listTool.input.parse(WEEK), ctx));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryable: true, retryAfter: 90 },
    });
    expect(recoveryHint(err)).toContain('90 seconds');
  });

  it('prefers rate_limited over upstream_unavailable when only one failure is a 429', async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({ biorxiv: new Error('down'), medrxiv: rateLimitError() }),
    );
    const ctx = createMockContext({ errors: listTool.errors });
    const err = await rejection(listTool.handler(listTool.input.parse(WEEK), ctx));
    expect(err.data?.reason).toBe('rate_limited');
    expect(err.data).not.toHaveProperty('retryAfter');
    expect(recoveryHint(err)).toContain('a minute or two');
  });

  it('rethrows a cancellation rather than returning the leg that finished first', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled by caller');
    mockGetPublishedListing.mockImplementation((server: string) => {
      if (server === 'biorxiv') return Promise.resolve(page([PUBLISHED_64898], 0, 1));
      controller.abort(cancelled);
      return Promise.reject(new Error('aborted'));
    });
    const ctx = createMockContext({ errors: listTool.errors, signal: controller.signal });
    const err = await rejection(listTool.handler(listTool.input.parse(WEEK), ctx));
    expect(err).toBe(cancelled);
  });

  // ── include_abstract ────────────────────────────────────────────────────────

  describe('include_abstract', () => {
    const { preprintAbstract: _abstract, ...WITHOUT_ABSTRACT } = PUBLISHED_64898;

    it('omits the abstract by default on both surfaces and keeps every other field', async () => {
      const { structured, text } = await call({ server: 'biorxiv' });
      expect(structured.publications).toEqual([{ ...WITHOUT_ABSTRACT, server: 'biorxiv' }]);
      expect(text).not.toContain(PUBLISHED_64898.preprintAbstract);
      for (const line of [
        `### ${PUBLISHED_64898.preprintTitle}`,
        `**Preprint DOI:** ${PUBLISHED_64898.preprintDoi}`,
        '**Server:** biorxiv',
        `**Published DOI:** ${PUBLISHED_64898.publishedDoi}`,
        '**Journal:** Nature Communications',
        '**Published Date:** 2026-09-02',
        '**Preprint Date:** 2026-01-10',
        '**Category:** genetics',
        `**Authors:** ${PUBLISHED_64898.preprintAuthors}`,
        '**Corresponding Author:** Anne C. Ferguson-Smith',
        '**Institution:** Department of Genetics, University of Cambridge',
      ]) {
        expect(text).toContain(line);
      }
    });

    it('true returns every record in full, the abstract on both surfaces', async () => {
      const { structured, text } = await call({ server: 'biorxiv', include_abstract: true });
      expect(structured.publications).toEqual([{ ...PUBLISHED_64898, server: 'biorxiv' }]);
      expect(text).toContain(`\n\n${PUBLISHED_64898.preprintAbstract}`);
    });

    it('omits abstracts from both servers on a two-server page', async () => {
      mockGetPublishedListing.mockImplementation(
        perServer({ biorxiv: page([PUBLISHED_64898], 0, 1), medrxiv: page([MEDRXIV_PUB], 0, 1) }),
      );
      const { structured, text } = await call({});
      for (const p of structured.publications) expect(p).not.toHaveProperty('preprintAbstract');
      expect(text).not.toContain(PUBLISHED_64898.preprintAbstract);
      expect(text).not.toContain(MEDRXIV_PUB.preprintAbstract);
    });
  });

  // ── Records and rendering ───────────────────────────────────────────────────

  it('renders a sparse record without inventing the fields it lacks', async () => {
    mockGetPublishedListing.mockResolvedValue(
      page([{ preprintDoi: '10.1101/2025.01.01.000001' }], 0, 1),
    );
    const { structured, text } = await call({ server: 'biorxiv' });
    expect(structured.publications).toEqual([
      { preprintDoi: '10.1101/2025.01.01.000001', server: 'biorxiv' },
    ]);
    expect(text).toContain('### 10.1101/2025.01.01.000001');
    expect(text).not.toContain('**Journal:**');
    expect(text).not.toContain('**Published Date:**');
  });

  describe('upstream text with Markdown metacharacters', () => {
    const MARKDOWN_PUB: PublishedVersion = {
      preprintDoi: IDENTIFIERS.doi,
      publishedDoi: IDENTIFIERS.publishedDoi,
      publishedJournal: UPSTREAM.journal,
      publishedDate: '2026-09-04',
      preprintDate: '2026-07-03',
      preprintTitle: UPSTREAM.title,
      preprintAuthors: UPSTREAM.authors,
      preprintCategory: UPSTREAM.category,
      preprintAbstract: UPSTREAM.abstract,
      preprintAuthorCorresponding: UPSTREAM.authorCorresponding,
      preprintAuthorCorrespondingInstitution: UPSTREAM.authorCorrespondingInstitution,
    };

    beforeEach(() => {
      mockGetPublishedListing.mockResolvedValue(page([MARKDOWN_PUB], 0, 1));
    });

    it('carries upstream text unescaped in structuredContent', async () => {
      const { structured } = await call({ server: 'biorxiv', include_abstract: true });
      expect(structured.publications[0]).toEqual({ ...MARKDOWN_PUB, server: 'biorxiv' });
    });

    it('escapes every upstream text field in content[] and leaves both DOIs raw', async () => {
      const { text } = await call({ server: 'biorxiv', include_abstract: true });
      expect(text).toContain(`### ${ESCAPED.title}\n`);
      expect(text).toContain(`**Journal:** ${ESCAPED.journal}\n`);
      expect(text).toContain(`**Category:** ${ESCAPED.category}\n`);
      expect(text).toContain(`**Authors:** ${ESCAPED.authors}\n`);
      expect(text).toContain(`**Corresponding Author:** ${ESCAPED.authorCorresponding}\n`);
      expect(text).toContain(`**Institution:** ${ESCAPED.authorCorrespondingInstitution}\n`);
      expect(text).toContain(`\n\n${ESCAPED.abstract}`);
      expect(text).not.toMatch(/^1\. /m);
      expect(text).toContain(`**Preprint DOI:** ${IDENTIFIERS.doi}\n`);
      expect(text).toContain(`**Published DOI:** ${IDENTIFIERS.publishedDoi}\n`);
    });
  });

  it('carries the notice on both surfaces through enrichment', async () => {
    mockGetPublishedListing.mockResolvedValue(empty(0));
    const ctx = createMockContext({ errors: listTool.errors });
    await listTool.handler(listTool.input.parse({ ...WEEK, server: 'biorxiv' }), ctx);
    expect(getEnrichment(ctx).notice).toMatch(/No journal publications found/);

    const { text } = await call({ server: 'biorxiv' });
    expect(text).toContain('No journal publications found');
  });

  // ── publisher ───────────────────────────────────────────────────────────────

  describe('publisher', () => {
    const NARROWED =
      'The publisher filter applies to bioRxiv only — api.biorxiv.org has no medRxiv publisher listing — so only bioRxiv was queried and there is no medRxiv pagination entry.';
    const FIELDS_ABSENT =
      'Rows listed by publisher carry no journal name, authors, corresponding author, or abstract — pass a preprintDoi to biorxiv_get_published_version for its full record.';

    it.each(['10.7554', '10.1016', '10.15252', '10.123456'])(
      'accepts the bare prefix %s',
      (publisher) => {
        expect(listTool.input.parse({ ...WEEK, publisher }).publisher).toBe(publisher);
      },
    );

    it.each(['10.7554/eLife.109354', '10.755', '10.1', 'eLife', '10.7554/', 'doi:10.7554'])(
      'rejects %j at the schema as -32602 naming the field, before any upstream call',
      async (publisher) => {
        const { result } = await call({ server: 'biorxiv', publisher });
        expect(result.isError).toBe(true);
        const error = (result.structuredContent as { error: { code: number; message: string } })
          .error;
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.message).toContain('publisher');
        expect(mockGetPublishedListing).not.toHaveBeenCalled();
      },
    );

    it('carries a hint naming the DOI-prefix form, not the raw pattern', async () => {
      const { result, text } = await call({ server: 'biorxiv', publisher: '10.7554/eLife.109354' });
      expect(envelopeHint(result)).toContain('10.7554');
      expect(envelopeHint(result)).not.toContain('\\d');
      expect(text).toContain('10.7554');
      expect(text).not.toContain('\\d');
    });

    describe('the publisher check runs in linear time', () => {
      /** Thread CPU microseconds one input parse takes, the least of three runs. */
      function cpuMicros(publisher: string): number {
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 3; run++) {
          const start = process.threadCpuUsage();
          listTool.input.safeParse({ ...WEEK, publisher });
          const spent = process.threadCpuUsage(start);
          best = Math.min(best, spent.user + spent.system);
        }
        return best;
      }

      /** `head`, then the unit repeated to `chars` characters, then the tail. */
      const build = (head: string, unit: string, chars: number, tail = '') =>
        head + unit.repeat(Math.ceil(chars / unit.length)) + tail;

      it.each([
        ['a long line ending in a break', '', '§1 x', '\ny'],
        ['breaks throughout', '', '  \r\n', ''],
        ['a prefix whose digits never end', '10.', '1', 'x'],
        ['a repeated prefix opener', '', '10.', ''],
        ['digits padded by whitespace', ' \t', '7', ' \n'],
      ])('%s: 5k → 320k characters', (_shape, head, unit, tail) => {
        const timings: number[] = [];
        for (let chars = 5_000; chars <= 320_000; chars *= 2) {
          const micros = cpuMicros(build(head, unit, chars, tail));
          expect(micros).toBeLessThan(250_000);
          timings.push(micros);
        }
        const first = Math.max(timings[0] ?? 1, 1);
        const last = timings.at(-1) ?? 0;
        expect(last / first).toBeLessThan(256);
      });
    });

    it('advertises the prefix pattern in tools/list and leaves publisher optional', () => {
      const schema = z.toJSONSchema(listTool.input, { io: 'input' }) as {
        properties: Record<string, { type?: string; pattern?: string }>;
        required?: string[];
      };
      expect(schema.properties.publisher).toMatchObject({
        type: 'string',
        pattern: '^10\\.\\d{4,}$',
      });
      expect(schema.required).not.toContain('publisher');
    });

    // Regression: a call without publisher is the call it was before the input existed.
    it('without publisher, queries /pubs on each requested server with the same arguments as before', async () => {
      await call({});
      await call({ server: 'medrxiv', cursor: 100, limit: 50 });
      expect(mockGetPublishedListing.mock.calls).toEqual([
        ['biorxiv', '2026-09-01', '2026-09-07', 0, 25, expect.any(Number), expect.anything()],
        ['medrxiv', '2026-09-01', '2026-09-07', 0, 25, expect.any(Number), expect.anything()],
        ['medrxiv', '2026-09-01', '2026-09-07', 100, 50, expect.any(Number), expect.anything()],
      ]);
    });

    it.each(['', '   ', '\t\n'])(
      'reads a blank publisher %j as omitted — the same calls and result as no publisher',
      async (publisher) => {
        mockGetPublishedListing.mockImplementation(
          perServer({ biorxiv: page([PUBLISHED_64898], 0, 1), medrxiv: page([MEDRXIV_PUB], 0, 1) }),
        );
        const omitted = await call({});
        const blank = await call({ publisher });
        expect(blank.result.isError).toBeFalsy();
        // Each call carries its own deadline and context; every other argument matches.
        const sameArgs = (server: string) => [
          server,
          '2026-09-01',
          '2026-09-07',
          0,
          25,
          expect.any(Number),
          expect.anything(),
        ];
        expect(mockGetPublishedListing.mock.calls).toEqual([
          sameArgs('biorxiv'),
          sameArgs('medrxiv'),
          sameArgs('biorxiv'),
          sameArgs('medrxiv'),
        ]);
        expect(blank.structured).toEqual(omitted.structured);
        expect(blank.text).toBe(omitted.text);
      },
    );

    it('rejects publisher with server "medrxiv" as invalid_publisher before any request', async () => {
      const ctx = createMockContext({ errors: listTool.errors });
      const err = await rejection(
        listTool.handler(
          listTool.input.parse({ ...WEEK, server: 'medrxiv', publisher: '10.7554' }),
          ctx,
        ),
      );
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_publisher', publisher: '10.7554' },
      });
      expect(err.message).toMatch(/bioRxiv only/);
      expect(recoveryHint(err)).toMatch(/"biorxiv" or "both"/);
      expect(mockGetPublishedListing).not.toHaveBeenCalled();

      const { result, text } = await call({ server: 'medrxiv', publisher: '10.7554' });
      expect(result.isError).toBe(true);
      expect(text).toContain('invalid_publisher');
      // The declared recovery also names "biorxiv" or "both"; only the throw's own hint reads this way.
      const hint =
        'Set server to "biorxiv" or "both" (which queries bioRxiv alone under a publisher filter), or omit publisher to list medRxiv.';
      expect(envelopeHint(result)).toBe(hint);
      expect(text).toContain(hint);
      expect(mockGetPublishedListing).not.toHaveBeenCalled();
    });

    /**
     * The real service against a fake bioRxiv `/publisher` endpoint shaped like
     * the live one: 100 rows a page from any cursor offset, `total` as a
     * number, "no articles found" with no total past the end or for a prefix
     * with no rows, and "publisher string not recognized" for a prefix it
     * cannot parse. A catch-all route records any other request, `/pubs` included.
     */
    describe('against the publisher endpoint', () => {
      const http = createFetchMock();
      const PUBLISHER = /^\/publisher\/([^/]+)\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}\/(\d+)$/;
      const OCT = { start_date: '2026-10-01', end_date: '2026-10-02' };
      /** 401 synthetic `10.1016` rows, like Elsevier's 2026-09-01..10-07. */
      const ELSEVIER = Array.from({ length: 401 }, (_, i) => ({
        ...PUBLISHER_ELIFE_ROWS[0],
        biorxiv_doi: `10.64898/2026.02.01.${800000 + i}`,
        published_doi: `10.1016/j.example.2026.${i}`,
      }));
      const ROWS: Record<string, readonly object[]> = {
        '10.7554': PUBLISHER_ELIFE_ROWS,
        '10.1016': ELSEVIER,
        '10.9999': [],
      };
      const requested = () => http.calls.map((c) => new URL(c.request.url).pathname);

      beforeEach(async () => {
        http.reset();
        http.route(
          {
            match: (request) => PUBLISHER.test(new URL(request.url).pathname),
            respond: (request) => {
              const [, prefix = '', at] = PUBLISHER.exec(new URL(request.url).pathname) as string[];
              // No pattern-valid prefix drew this status live; the fake gives it to
              // every prefix it does not hold, so the mapping is reachable.
              const all = ROWS[prefix];
              if (!all)
                return Response.json({ messages: [PUBLISHER_NOT_RECOGNIZED], collection: [] });
              const cursor = Number(at);
              const collection = all.slice(cursor, cursor + 100);
              if (collection.length === 0) {
                return Response.json({ messages: [PUBLISHER_NO_ARTICLES], collection: [] });
              }
              return Response.json({
                messages: [
                  {
                    status: 'ok',
                    interval: '2026-10-01:2026-10-02',
                    cursor: cursor === 0 ? 0 : String(cursor),
                    count: collection.length,
                    total: all.length,
                  },
                ],
                collection,
              });
            },
          },
          { match: () => true, respond: () => new Response('Not Found', { status: 404 }) },
        );
        http.install();
        const { BiorxivApiService } = await vi.importActual<
          typeof import('@/services/biorxiv/biorxiv-service.js')
        >('@/services/biorxiv/biorxiv-service.js');
        const real = new BiorxivApiService({} as AppConfig, {} as StorageService);
        mockGetPublishedListing.mockImplementation(real.getPublishedListing.bind(real));
      });

      afterEach(() => http.restore());

      it('under "both", lists exactly bioRxiv\'s 10.7554 rows from /publisher alone and says why medRxiv is absent', async () => {
        const { result, structured, text } = await call({ ...OCT, publisher: '10.7554' });
        expect(result.isError).toBeFalsy();
        expect(requested()).toEqual(['/publisher/10.7554/2026-10-01/2026-10-02/0']);
        expect(
          structured.publications.map((p) => [p.server, p.preprintDoi, p.publishedDoi]),
        ).toEqual(PUBLISHER_ELIFE_ROWS.map((r) => ['biorxiv', r.biorxiv_doi, r.published_doi]));
        expect(structured.pagination).toEqual({ biorxiv: { cursor: 0, total: 5 } });
        expect(structured.notice).toBe(`${NARROWED} ${FIELDS_ABSENT}`);
        expect(text).toContain(`${NARROWED} ${FIELDS_ABSENT}`);
        expect(text).toContain('**bioRxiv:** page offset 0, total 5 (last page)');
        expect(text).not.toContain('**medRxiv:**');
      });

      it('with server "biorxiv", queries the same endpoint and does not call it narrowed', async () => {
        const { structured } = await call({ ...OCT, server: 'biorxiv', publisher: '10.7554' });
        expect(requested()).toEqual(['/publisher/10.7554/2026-10-01/2026-10-02/0']);
        expect(structured.publications).toHaveLength(5);
        expect(structured.notice).toBe(FIELDS_ABSENT);
      });

      it('carries no journal name, authors, corresponding author, or abstract — include_abstract adds none — on either surface', async () => {
        const { structured, text } = await call({
          ...OCT,
          server: 'biorxiv',
          publisher: '10.7554',
          include_abstract: true,
        });
        for (const p of structured.publications) {
          expect(Object.keys(p).sort()).toEqual([
            'preprintCategory',
            'preprintDate',
            'preprintDoi',
            'preprintTitle',
            'publishedDate',
            'publishedDoi',
            'server',
          ]);
        }
        for (const absent of [
          '**Journal:**',
          '**Authors:**',
          '**Corresponding Author:**',
          '**Institution:**',
        ]) {
          expect(text).not.toContain(absent);
        }
        for (const line of [
          '### Sex-biased expression of enteroendocrine cell-derived hormones contributes to higher fat storage in Drosophila females',
          '**Preprint DOI:** 10.1101/2025.09.09.675263',
          '**Server:** biorxiv',
          '**Published DOI:** 10.7554/eLife.109426.3',
          '**Published Date:** 2026-10-01',
          '**Preprint Date:** 2025-09-12',
          '**Category:** physiology',
        ]) {
          expect(text).toContain(line);
        }
        expect(text).toContain(FIELDS_ABSENT);
      });

      it('continues a prefix past 100 rows at nextCursor, ends on its last page, and marks a cursor past it exhausted with no total', async () => {
        const first = await call({ ...OCT, server: 'biorxiv', publisher: '10.1016', limit: 100 });
        expect(first.structured.pagination).toEqual({
          biorxiv: { cursor: 0, total: 401, nextCursor: 100 },
        });
        expect(first.structured).toMatchObject({ truncated: true, shown: 100, cap: 100 });
        expect(first.text).toContain('**bioRxiv:** page offset 0, total 401 — next cursor: 100');

        const second = await call({
          ...OCT,
          server: 'biorxiv',
          publisher: '10.1016',
          limit: 100,
          cursor: 100,
        });
        expect(second.structured.publications.map((p) => p.preprintDoi)).toEqual(
          ELSEVIER.slice(100, 200).map((r) => r.biorxiv_doi),
        );
        expect(second.structured.pagination.biorxiv).toEqual({
          cursor: 100,
          total: 401,
          nextCursor: 200,
        });

        const last = await call({ ...OCT, server: 'biorxiv', publisher: '10.1016', cursor: 400 });
        expect(last.structured.pagination.biorxiv).toEqual({ cursor: 400, total: 401 });
        expect(last.text).toContain('**bioRxiv:** page offset 400, total 401 (last page)');

        const past = await call({ ...OCT, publisher: '10.1016', cursor: 500 });
        expect(past.result.isError).toBeFalsy();
        expect(past.structured.pagination).toEqual({ biorxiv: { cursor: 500, exhausted: true } });
        expect(past.structured.notice).toMatch(/Cursor 500 is at or past the last row/);
        expect(past.structured.notice).not.toMatch(/No journal publications found/);

        expect(requested()).toEqual([
          '/publisher/10.1016/2026-10-01/2026-10-02/0',
          '/publisher/10.1016/2026-10-01/2026-10-02/100',
          '/publisher/10.1016/2026-10-01/2026-10-02/400',
          '/publisher/10.1016/2026-10-01/2026-10-02/500',
        ]);
      });

      it('reports total 0 and the empty-interval notice, naming the publisher, for a prefix with no rows', async () => {
        const { result, structured, text } = await call({ ...OCT, publisher: '10.9999' });
        expect(result.isError).toBeFalsy();
        expect(structured.publications).toEqual([]);
        expect(structured.pagination).toEqual({ biorxiv: { cursor: 0, total: 0 } });
        const empty =
          "No journal publications found for publication dates 2026-10-01–2026-10-02 on bioRxiv under publisher prefix 10.9999. Try widening the date range, or check the prefix against one of the publisher's journal DOIs — the part before the slash.";
        expect(structured.notice).toBe(`${NARROWED} ${empty}`);
        expect(text).toContain(empty);
        expect(text).toContain('**bioRxiv:** page offset 0, total 0 (last page)');
      });

      it('raises invalid_publisher, never an empty page, when upstream does not recognize the prefix', async () => {
        const ctx = createMockContext({ errors: listTool.errors });
        const err = await rejection(
          listTool.handler(listTool.input.parse({ ...OCT, publisher: '10.123456' }), ctx),
        );
        expect(err).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_publisher', publisher: '10.123456' },
        });
        expect(err.message).toContain('10.123456');
        expect(err.message).toMatch(/not an empty result/);

        const { result, text } = await call({ ...OCT, server: 'biorxiv', publisher: '10.123456' });
        expect(result.isError).toBe(true);
        expect(text).toContain('invalid_publisher');
        expect(envelopeHint(result)).toMatch(/part of a journal DOI before the slash/);
        expect(requested()).toEqual([
          '/publisher/10.123456/2026-10-01/2026-10-02/0',
          '/publisher/10.123456/2026-10-01/2026-10-02/0',
        ]);
      });
    });
  });
});
