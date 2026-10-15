/**
 * @fileoverview Tests for biorxiv_list_published_versions — publication-date
 * interval listing, per-server pagination, past-the-end cursors, partial and
 * total upstream failure, include_abstract, and both client surfaces.
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
import { PUBLISHED_64898, PUBS_ROW_64898 } from '../helpers/pubs-fixtures.js';
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

  it('defaults server to "both", cursor to 0, and include_abstract to false', () => {
    const input = listTool.input.parse(WEEK);
    expect(input).toEqual({ ...WEEK, server: 'both', cursor: 0, include_abstract: false });
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
    const first = await call({ server: 'biorxiv' });
    expect(first.structured.pagination.biorxiv).toEqual({ cursor: 0, total: 449, nextCursor: 100 });
    expect(first.text).toContain('**bioRxiv:** page offset 0, total 449 — next cursor: 100');

    // Live: cursor 400 holds the last 49 of 449 rows.
    mockGetPublishedListing.mockResolvedValueOnce(page(rows(49, 400), 400, 449));
    const last = await call({ server: 'biorxiv', cursor: 400 });
    expect(last.structured.pagination.biorxiv).toEqual({ cursor: 400, total: 449 });
    expect(last.text).toContain('**bioRxiv:** page offset 400, total 449 (last page)');
  });

  it('continues from an arbitrary offset by the rows actually returned', async () => {
    // Live: cursor 5 returns rows 5..104; the next unread row is 105.
    mockGetPublishedListing.mockResolvedValue(page(rows(100, 5), 5, 449));
    const { structured } = await call({ server: 'biorxiv', cursor: 5 });
    expect(structured.pagination.biorxiv?.nextCursor).toBe(105);
  });

  it("at cursor 100 returns medRxiv's last 3 rows with no next cursor while bioRxiv continues", async () => {
    mockGetPublishedListing.mockImplementation(
      perServer({
        biorxiv: page(rows(100, 100), 100, 449),
        medrxiv: page([MEDRXIV_PUB, ...rows(2, 900)], 100, 103),
      }),
    );
    const { structured, text } = await call({ cursor: 100 });
    expect(structured.pagination).toEqual({
      biorxiv: { cursor: 100, total: 449, nextCursor: 200 },
      medrxiv: { cursor: 100, total: 103 },
    });
    expect(structured.publications.filter((p) => p.server === 'medrxiv')).toHaveLength(3);
    expect(structured.notice).toBeUndefined();
    expect(text).toContain('**medRxiv:** page offset 100, total 103 (last page)');
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

      const { structured, text } = await call({ server: 'biorxiv', cursor: 100 });
      expect(structured.publications).toHaveLength(99);
      expect(structured.pagination.biorxiv).toEqual({ cursor: 100, total: 449, nextCursor: 200 });
      expect(text).toContain('**bioRxiv:** page offset 100, total 449 — next cursor: 200');
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
});
