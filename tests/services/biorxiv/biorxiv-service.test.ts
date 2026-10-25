/**
 * @fileoverview Tests for BiorxivApiService — details, listing, and crosswalk
 * endpoints with normalization, partial-failure handling, and HTTP 429
 * classification.
 * @module tests/services/biorxiv/biorxiv-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import {
  CALL_BUDGET_MS,
  type CallDeadline,
  findRateLimit,
  startCallDeadline,
} from '@/services/shared.js';
import { type FetchCall, hungOrigin, settle, slowOrigin } from '../../helpers/call-budget.js';
import {
  MEDRXIV_C100_ROWS,
  NO_ARTICLES,
  PUBLISHED_64898,
  PUBLISHER_ELIFE_ROWS,
  PUBLISHER_NO_ARTICLES,
  PUBLISHER_NOT_RECOGNIZED,
  PUBS_ROW_1101,
  PUBS_ROW_64898,
} from '../../helpers/pubs-fixtures.js';
import { rateLimitError } from '../../helpers/rate-limit.js';

// Stub out fetchWithTimeout and withRetry so no real HTTP calls are made
const mockFetch = vi.fn();

type RetryFn = (
  fn: (attempt: { signal: AbortSignal; remainingMs: number }) => Promise<unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

/**
 * withRetry runs the operation once, handing it the attempt a single
 * unbounded try would get; a test that needs the real retry ladder sets `impl`.
 */
const retry = vi.hoisted(() => ({ impl: undefined as RetryFn | undefined }));

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetch(...args),
  withRetry: ((fn, options) =>
    retry.impl
      ? retry.impl(fn, options)
      : fn({
          signal: options?.signal ?? new AbortController().signal,
          remainingMs: Number.POSITIVE_INFINITY,
        })) satisfies RetryFn,
}));

// Stub server config to avoid env var requirements
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    mailto: 'test@example.com',
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

function makeResponse(body: unknown): Response {
  return {
    text: () => Promise.resolve(JSON.stringify(body)),
    ok: true,
    status: 200,
  } as unknown as Response;
}

/**
 * Make a fake response whose body is an HTML error page. `ok`/`status` are
 * cosmetic here: the real `fetchWithTimeout` throws on non-2xx before the
 * service reads the body, so a response that reaches `detectHtmlError` is by
 * definition a 2xx one carrying an HTML error page.
 */
function makeHtmlResponse(html = '<!DOCTYPE html><html><body>Error</body></html>'): Response {
  return {
    text: () => Promise.resolve(html),
    ok: true,
    status: 200,
  } as unknown as Response;
}

/** The upstream 429 body — must never reach the caller-visible error payload. */
const RATE_LIMIT_BODY = '<html><body>429 Too Many Requests — api.biorxiv.org</body></html>';

/**
 * McpError shaped like the one `fetchWithTimeout` throws on a non-2xx response:
 * canonical `status`/`body`, the legacy `statusCode`/`responseBody` aliases, and
 * `retryAfter` when the origin sent the header. The service never sees a
 * `Response` for a non-2xx — it sees this rejection.
 */
function httpError(status: number, retryAfter?: string): McpError {
  const code = status === 429 ? JsonRpcErrorCode.RateLimited : JsonRpcErrorCode.ServiceUnavailable;
  return new McpError(code, `Fetch failed for api.biorxiv.org. Status: ${status}`, {
    status,
    statusText: 'Too Many Requests',
    body: RATE_LIMIT_BODY,
    statusCode: status,
    responseBody: RATE_LIMIT_BODY,
    ...(retryAfter !== undefined && { retryAfter }),
    errorSource: 'FetchHttpError',
  });
}

type Ctx = ReturnType<typeof createMockContext>;

/**
 * Every call BiorxivApiService makes against api.biorxiv.org, by name. The
 * deadline defaults to a fresh call budget.
 */
const API_CALLS = {
  getDetails: (s: BiorxivApiService, ctx: Ctx, deadline = startCallDeadline()) =>
    s.getDetails('10.1101/2024.01.15.575123', 'biorxiv', deadline, ctx),
  getListing: (s: BiorxivApiService, ctx: Ctx, deadline = startCallDeadline()) =>
    s.getListing('biorxiv', '2024-01-01', '2024-01-31', 0, {}, deadline, ctx),
  getPublishedListing: (s: BiorxivApiService, ctx: Ctx, deadline = startCallDeadline()) =>
    s.getPublishedListing('biorxiv', '2026-09-01', '2026-09-07', 0, 25, deadline, ctx),
  getPublishedVersion: (s: BiorxivApiService, ctx: Ctx, deadline = startCallDeadline()) =>
    s.getPublishedVersion('10.1101/2024.01.15.575123', 'biorxiv', deadline, ctx),
  getPublishedVersionByJournalDoi: (
    s: BiorxivApiService,
    ctx: Ctx,
    deadline = startCallDeadline(),
  ) =>
    s.getPublishedVersionByJournalDoi(
      '10.1017/S0033291726104693',
      '10.64898/2026.01.07.26343585',
      'medrxiv',
      deadline,
      ctx,
    ),
} as const;

/** The timeout each call gives one attempt while the call budget leaves more. */
const ATTEMPT_TIMEOUT_MS: Record<keyof typeof API_CALLS, number> = {
  getDetails: 15_000,
  getListing: 20_000,
  getPublishedListing: 20_000,
  getPublishedVersion: 15_000,
  getPublishedVersionByJournalDoi: 15_000,
};

const MOCK_CONFIG = {} as AppConfig;
const MOCK_STORAGE = {} as StorageService;

describe('BiorxivApiService', () => {
  let service: BiorxivApiService;

  beforeEach(() => {
    service = new BiorxivApiService(MOCK_CONFIG, MOCK_STORAGE);
    mockFetch.mockReset();
    retry.impl = undefined;
  });

  // ── getDetails ──────────────────────────────────────────────────────────────

  describe('getDetails', () => {
    it('returns normalized revisions for a DOI', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              doi: '10.1101/2024.01.15.575123',
              title: 'Test Preprint',
              authors: 'Smith J',
              abstract: 'A test abstract.',
              version: '1',
              server: 'biorxiv',
              published: 'NA',
            },
          ],
        }),
      );

      const ctx = createMockContext();
      const revisions = await service.getDetails(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.doi).toBe('10.1101/2024.01.15.575123');
      expect(revisions[0]?.title).toBe('Test Preprint');
      // "NA" published should be normalized to absent
      expect(revisions[0]?.publishedJournalDoi).toBeUndefined();
    });

    it('returns empty array when DOI not found', async () => {
      mockFetch.mockResolvedValue(makeResponse({ collection: [] }));
      const ctx = createMockContext();
      const revisions = await service.getDetails(
        '10.1101/2024.01.01.000001',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(revisions).toHaveLength(0);
    });

    it('handles sparse upstream payload — omitted optional fields stay absent', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [{ doi: '10.1101/2024.01.15.575123' }],
        }),
      );
      const ctx = createMockContext();
      const revisions = await service.getDetails(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(revisions[0]?.title).toBeUndefined();
      expect(revisions[0]?.abstract).toBeUndefined();
      expect(revisions[0]?.authors).toBeUndefined();
    });

    // Upstream funder names and ROR IDs are misattributed (the funder is replaced
    // by an unrelated organization while the award stays), so only awards survive.
    describe('funder array', () => {
      const detailsWith = async (funder: unknown) => {
        mockFetch.mockResolvedValue(
          makeResponse({ collection: [{ doi: '10.1101/2025.06.23.661133', funder }] }),
        );
        return (
          await service.getDetails(
            '10.1101/2025.06.23.661133',
            'biorxiv',
            startCallDeadline(),
            createMockContext(),
          )
        )[0];
      };

      it('keeps the award and drops the misattributed name and ROR ID (live record shape)', async () => {
        const revision = await detailsWith([
          {
            name: 'Sint Lucas Andreas Hospital',
            id: 'https://ror.org/016jc2h42',
            'id-type': 'ROR',
            award: 'R35GM134936R01CA260414K99GM155323',
          },
        ]);
        // Several grants run together upstream with no separator — never split.
        expect(revision?.awards).toEqual(['R35GM134936R01CA260414K99GM155323']);
        expect(revision).not.toHaveProperty('funder');
        const serialized = JSON.stringify(revision);
        expect(serialized).not.toContain('Sint Lucas');
        expect(serialized).not.toContain('016jc2h42');
      });

      it('keeps awards verbatim, in order, deduplicated, dropping empty and N/A placeholders', async () => {
        const revision = await detailsWith([
          { name: 'Rotunda Hospital', award: 'CC2102' },
          { name: 'Rotunda Hospital', award: 'CC2102' },
          { name: 'Gwent Group (United Kingdom)', award: "EP/X038882/1 'InnovaTEbehaviour'" },
          { name: 'Sioux Valley Hospital', award: '' },
          { name: 'Royal Hallamshire Hospital', award: '   ' },
          { name: 'Long Beach Animal Hospital', award: 'N/A' },
          { name: 'Critical Path Institute' },
          { name: 'Cystic Fibrosis Research Foundation', award: ' UK Program MC_UU_00030/7 ' },
          { name: 'Somerset Medical Center', award: 'CC2102' },
        ]);
        expect(revision?.awards).toEqual([
          'CC2102',
          "EP/X038882/1 'InnovaTEbehaviour'",
          'UK Program MC_UU_00030/7',
        ]);
      });

      it.each([
        ['funder "NA"', 'NA'],
        ['no funder field', undefined],
        ['an empty funder array', []],
        [
          'entries with no usable award',
          [{ name: 'Rize Devlet Hastanesi', award: '' }, { name: 'X' }],
        ],
      ])('carries no awards field for %s', async (_label, funder) => {
        const revision = await detailsWith(funder);
        expect(revision).not.toHaveProperty('awards');
        expect(revision).not.toHaveProperty('funder');
      });
    });

    it('preserves non-NA published journal DOI', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              doi: '10.1101/2024.01.15.575123',
              published: '10.1038/s41586-024-00001-0',
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const revisions = await service.getDetails(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(revisions[0]?.publishedJournalDoi).toBe('10.1038/s41586-024-00001-0');
    });

    it('maps jatsxml field to jatsxmlUrl', async () => {
      const jatsUrl = 'https://www.biorxiv.org/content/10.1101/2024.01.15.575123v1.xml';
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [{ doi: '10.1101/2024.01.15.575123', jatsxml: jatsUrl }],
        }),
      );
      const ctx = createMockContext();
      const revisions = await service.getDetails(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(revisions[0]?.jatsxmlUrl).toBe(jatsUrl);
    });

    it('maps author_corresponding fields to camelCase', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              doi: '10.1101/2024.01.15.575123',
              author_corresponding: 'Smith J',
              author_corresponding_institution: 'MIT',
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const revisions = await service.getDetails(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(revisions[0]?.authorCorresponding).toBe('Smith J');
      expect(revisions[0]?.authorCorrespondingInstitution).toBe('MIT');
    });

    it('throws serviceUnavailable when API returns HTML error page', async () => {
      mockFetch.mockResolvedValue(makeHtmlResponse());
      const ctx = createMockContext();
      await expect(
        service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', startCallDeadline(), ctx),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    });

    it('returns all revisions when collection has multiple entries', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            { doi: '10.1101/2024.01.15.575123', version: '1' },
            { doi: '10.1101/2024.01.15.575123', version: '2' },
          ],
        }),
      );
      const ctx = createMockContext();
      const revisions = await service.getDetails(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(revisions).toHaveLength(2);
    });

    it('normalizes Highwire/JATS markup out of title and abstract', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              doi: '10.1101/2024.01.15.575123',
              title: 'Editing <i>Staphylococcus aureus</i> genomes',
              abstract:
                'AO_SCPLOWBSTRACTC_SCPLOWWe report a method. O_FIG O_LINKSMALLFIG SRC="FIGDIR/small/x.gif" ALT="Figure 1">View larger version:org.highwire.dtl.DTLVardef@130b9ee M_FIG C_FIG',
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const revisions = await service.getDetails(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(revisions[0]?.title).toBe('Editing Staphylococcus aureus genomes');
      expect(revisions[0]?.abstract).toBe('We report a method.');
      expect(revisions[0]?.abstract).not.toMatch(/O_FIG|C_FIG|SRC=|org\.highwire|SCPLOW/);
    });

    it('resolves placeholders, headings, and list markers in title and abstract, leaving other fields raw', async () => {
      // Live shape: 10.64898/2026.08.30.26361755 (trimmed), plus the one title in
      // the corpus that carries a placeholder.
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              doi: '10.64898/2026.08.30.26361755',
              title: '{Phi}Xacm4-11 infection dynamics',
              authors: 'O`Toole, P.; Mu_ller, M.',
              abstract:
                'Structured abstractO_ST_ABSBackgroundC_ST_ABSPro-inflammatory diets threaten health.\n\nMethodsWe held energy within {+/-}3% and protein [&ge;]98% of baseline.\n\nResultssDII was weakly associated with GHG (Spearman {rho}=0.14).\n\nKey messagesO_LIFootprints are decoupled (|{rho}|[&le;]0.30).\nC_LIO_LIThe reduction is small ([~]1.1%).\nC_LI',
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const [revision] = await service.getDetails(
        '10.64898/2026.08.30.26361755',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(revision?.title).toBe('ΦXacm4-11 infection dynamics');
      expect(revision?.abstract).toBe(
        'Structured abstract Background: Pro-inflammatory diets threaten health. Methods: We held energy within ±3% and protein ≥98% of baseline. Results: sDII was weakly associated with GHG (Spearman ρ=0.14). Key messages: • Footprints are decoupled (|ρ|≤0.30). • The reduction is small (∼1.1%).',
      );
      expect(revision?.authors).toBe('O`Toole, P.; Mu_ller, M.');
    });

    it('reads literal backslash-n paragraph breaks in an older abstract as line breaks', async () => {
      // Live shape: 10.1101/049882 — `\n` written as two characters, no real newline.
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              doi: '10.1101/049882',
              version: '1',
              abstract: String.raw`BackgroundDilp8 inhibits ecdysone synthesis.\n\nResultsOver-expression of Ras caused death.\n\nConclusionsA novel checkpoint.`,
            },
          ],
        }),
      );
      const [revision] = await service.getDetails(
        '10.1101/049882',
        'biorxiv',
        startCallDeadline(),
        createMockContext(),
      );
      expect(revision?.abstract).toBe(
        'Background: Dilp8 inhibits ecdysone synthesis. Results: Over-expression of Ras caused death. Conclusions: A novel checkpoint.',
      );
    });

    // Upstream repeats the latest revision's abstract on every revision, while
    // title, authors, and date stay per-revision.
    describe('abstract on the latest revision only', () => {
      const DOI = '10.1101/049882';
      const details = async (collection: Record<string, unknown>[]) => {
        mockFetch.mockResolvedValue(makeResponse({ collection }));
        return service.getDetails(DOI, 'biorxiv', startCallDeadline(), createMockContext());
      };

      it('keeps the abstract on the highest version and drops it from every earlier one', async () => {
        const revisions = await details([
          { doi: DOI, version: '1', title: 'First title', abstract: 'Latest abstract.' },
          { doi: DOI, version: '2', title: 'Second title', abstract: 'Latest abstract.' },
          { doi: DOI, version: '3', title: 'Third title', abstract: 'Latest abstract.' },
        ]);
        expect(revisions.map((r) => r.abstract)).toEqual([
          undefined,
          undefined,
          'Latest abstract.',
        ]);
        expect(revisions.map((r) => r.title)).toEqual([
          'First title',
          'Second title',
          'Third title',
        ]);
        expect(revisions.filter((r) => 'abstract' in r)).toHaveLength(1);
      });

      it('returns revisions in ascending version order, the abstract on the last', async () => {
        const revisions = await details([
          { doi: DOI, version: '2', title: 'v2', abstract: 'Latest abstract.' },
          { doi: DOI, version: '10', title: 'v10', abstract: 'Latest abstract.' },
          { doi: DOI, version: '9', title: 'v9', abstract: 'Latest abstract.' },
        ]);
        expect(revisions.map((r) => r.version)).toEqual(['2', '9', '10']);
        // Each row keeps its own metadata through the reorder.
        expect(revisions.map((r) => r.title)).toEqual(['v2', 'v9', 'v10']);
        expect(revisions.map((r) => r.abstract)).toEqual([
          undefined,
          undefined,
          'Latest abstract.',
        ]);
      });

      it('orders rows without a version number first, in their listed order', async () => {
        const revisions = await details([
          { doi: DOI, version: '3', title: 'v3', abstract: 'Latest abstract.' },
          { doi: DOI, title: 'unnumbered A', abstract: 'Latest abstract.' },
          { doi: DOI, version: '1', title: 'v1', abstract: 'Latest abstract.' },
          { doi: DOI, version: 'x', title: 'unnumbered B', abstract: 'Latest abstract.' },
        ]);
        expect(revisions.map((r) => r.title)).toEqual(['unnumbered A', 'unnumbered B', 'v1', 'v3']);
        expect(revisions.at(-1)?.abstract).toBe('Latest abstract.');
        expect(revisions.filter((r) => 'abstract' in r)).toHaveLength(1);
      });

      it('keeps the last revision listed when none carries a version number', async () => {
        const revisions = await details([
          { doi: DOI, abstract: 'Latest abstract.' },
          { doi: DOI, abstract: 'Latest abstract.' },
        ]);
        expect(revisions.map((r) => r.abstract)).toEqual([undefined, 'Latest abstract.']);
      });

      it('leaves a single-revision preprint its abstract', async () => {
        const [revision] = await details([
          { doi: DOI, version: '1', abstract: 'The only abstract.' },
        ]);
        expect(revision?.abstract).toBe('The only abstract.');
      });
    });

    describe('server', () => {
      it.each([
        ['biorxiv', 'bioRxiv'],
        ['medrxiv', 'medRxiv'],
      ] as const)(
        'is the queried server %s in lowercase, not the upstream spelling %s',
        async (server, upstream) => {
          mockFetch.mockResolvedValue(
            makeResponse({
              collection: [
                { doi: '10.1101/2020.03.21.990770', version: '1', server: upstream },
                { doi: '10.1101/2020.03.21.990770', version: '2' },
              ],
            }),
          );
          const revisions = await service.getDetails(
            '10.1101/2020.03.21.990770',
            server,
            startCallDeadline(),
            createMockContext(),
          );
          expect(revisions.map((r) => r.server)).toEqual([server, server]);
        },
      );
    });

    describe('DOI path key', () => {
      const calledUrl = () => (mockFetch.mock.calls[0] as string[])[0];

      it.each([
        ['10.1101/2020.03.21.990770', 'biorxiv'],
        ['10.1101/339853', 'medrxiv'],
        ['10.64898/2026.05.07.723463', 'medrxiv'],
      ] as const)(
        'keys a single-slash DOI %s on %s exactly as it is written',
        async (doi, server) => {
          mockFetch.mockResolvedValue(makeResponse({ collection: [] }));
          await service.getDetails(doi, server, startCallDeadline(), createMockContext());
          expect(calledUrl()).toBe(`https://api.biorxiv.org/details/${server}/${doi}/0/json`);
        },
      );

      it('double-encodes every slash after the first, so a multi-slash DOI arrives whole', async () => {
        // Live: sent raw, /details/biorxiv/10.1101/abc/def/0/json is an Apache 404;
        // %252F reaches the API whole and draws 200 "DOI not recognizable".
        mockFetch.mockResolvedValue(
          makeResponse({ messages: [{ status: 'DOI not recognizable' }], collection: [] }),
        );
        const revisions = await service.getDetails(
          '10.1101/abc/def/ghi',
          'biorxiv',
          startCallDeadline(),
          createMockContext(),
        );
        expect(calledUrl()).toBe(
          'https://api.biorxiv.org/details/biorxiv/10.1101/abc%252Fdef%252Fghi/0/json',
        );
        expect(revisions).toEqual([]);
      });

      it('still rejects on an HTTP 404 — a broken route is never read as an absent DOI', async () => {
        const notFound = new McpError(
          JsonRpcErrorCode.NotFound,
          'Fetch failed for https://api.biorxiv.org/details/…. Status: 404',
          { status: 404, statusText: 'Not Found', errorSource: 'FetchHttpError' },
        );
        mockFetch.mockRejectedValue(notFound);
        const err = await service
          .getDetails('10.1101/abc/def', 'biorxiv', startCallDeadline(), createMockContext())
          .catch((e: unknown) => e);
        expect(err).toBe(notFound);
      });
    });
  });

  // ── getListing ──────────────────────────────────────────────────────────────

  describe('getListing', () => {
    it('returns preprints and pagination from listing endpoint', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ total: 100, cursor: 0 }],
          collection: [{ doi: '10.1101/2024.01.15.575123', title: 'Test', date: '2024-01-15' }],
        }),
      );

      const ctx = createMockContext();
      const result = await service.getListing(
        'biorxiv',
        '2024-01-01',
        '2024-01-31',
        0,
        {},
        startCallDeadline(),
        ctx,
      );
      expect(result.preprints).toHaveLength(1);
      expect(result.pagination.total).toBe(100);
      expect(result.pagination.cursor).toBe(0);
    });

    it('parses string total from messages array', async () => {
      // The bioRxiv API returns total as a string, not a number
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ total: '915', cursor: '0' }],
          collection: [{ doi: '10.1101/2024.01.15.575123' }],
        }),
      );
      const ctx = createMockContext();
      const result = await service.getListing(
        'biorxiv',
        '2024-01-01',
        '2024-01-31',
        0,
        {},
        startCallDeadline(),
        ctx,
      );
      expect(result.pagination.total).toBe(915);
    });

    it('defaults total to 0 when messages is absent', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [{ doi: '10.1101/2024.01.15.575123' }],
        }),
      );
      const ctx = createMockContext();
      const result = await service.getListing(
        'biorxiv',
        '2024-01-01',
        '2024-01-31',
        0,
        {},
        startCallDeadline(),
        ctx,
      );
      expect(result.pagination.total).toBe(0);
    });

    it('returns empty preprints when collection is absent', async () => {
      mockFetch.mockResolvedValue(makeResponse({ messages: [{ total: 0, cursor: 0 }] }));
      const ctx = createMockContext();
      const result = await service.getListing(
        'biorxiv',
        '2024-01-01',
        '2024-01-31',
        0,
        {},
        startCallDeadline(),
        ctx,
      );
      expect(result.preprints).toHaveLength(0);
    });

    it('passes cursor offset to the URL', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ messages: [{ total: 30, cursor: 30 }], collection: [] }),
      );
      const ctx = createMockContext();
      await service.getListing(
        'biorxiv',
        '2024-01-01',
        '2024-01-31',
        30,
        {},
        startCallDeadline(),
        ctx,
      );
      // URL should contain the offset
      const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
      expect(calledUrl).toContain('/30/');
    });

    it('appends category query param to URL when provided', async () => {
      mockFetch.mockResolvedValue(makeResponse({ messages: [{ total: 5 }], collection: [] }));
      const ctx = createMockContext();
      await service.getListing(
        'biorxiv',
        '2024-01-01',
        '2024-01-31',
        0,
        { category: 'Neuroscience' },
        startCallDeadline(),
        ctx,
      );
      const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
      expect(calledUrl).toContain('category=neuroscience');
    });

    it('keeps every row its abstract and sets its server from the queried server', async () => {
      // Live shape: the 2025-03-04 medRxiv listing — a superseded v2 row beside a v1 row,
      // each carrying its preprint's latest abstract and upstream's "medRxiv".
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ total: 2, cursor: 0 }],
          collection: [
            { doi: '10.1101/2024.04.22.24306196', version: '2', abstract: 'A.', server: 'medRxiv' },
            { doi: '10.1101/2025.03.03.25323100', version: '1', abstract: 'B.', server: 'medRxiv' },
          ],
        }),
      );
      const result = await service.getListing(
        'medrxiv',
        '2025-03-04',
        '2025-03-04',
        0,
        {},
        startCallDeadline(),
        createMockContext(),
      );
      expect(result.preprints.map((p) => p.abstract)).toEqual(['A.', 'B.']);
      expect(result.preprints.map((p) => p.server)).toEqual(['medrxiv', 'medrxiv']);
    });

    it('throws serviceUnavailable when API returns HTML error page', async () => {
      mockFetch.mockResolvedValue(makeHtmlResponse());
      const ctx = createMockContext();
      await expect(
        service.getListing('biorxiv', '2024-01-01', '2024-01-31', 0, {}, startCallDeadline(), ctx),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    });
  });

  // ── getPublishedVersion ─────────────────────────────────────────────────────

  describe('getPublishedVersion', () => {
    it('returns the crosswalk record when found', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              preprint_doi: '10.1101/2024.01.15.575123',
              published_doi: '10.1038/s41586-024-00001-0',
              published_journal: 'Nature',
              published_date: '2024-06-01',
            },
          ],
        }),
      );

      const ctx = createMockContext();
      const result = await service.getPublishedVersion(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(result?.preprintDoi).toBe('10.1101/2024.01.15.575123');
      expect(result?.publishedJournal).toBe('Nature');
    });

    it('returns undefined when preprint is not yet published', async () => {
      mockFetch.mockResolvedValue(makeResponse({ collection: [] }));
      const ctx = createMockContext();
      const result = await service.getPublishedVersion(
        '10.1101/2024.01.01.000001',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined when collection record lacks preprint_doi', async () => {
      mockFetch.mockResolvedValue(makeResponse({ collection: [{ published_doi: '10.1038/xxx' }] }));
      const ctx = createMockContext();
      const result = await service.getPublishedVersion(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(result).toBeUndefined();
    });

    it('maps all optional crosswalk fields when present', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              preprint_doi: '10.1101/2024.01.15.575123',
              preprint_title: 'Test Title',
              preprint_authors: 'Smith J',
              preprint_category: 'Neuroscience',
              preprint_date: '2024-01-15',
              preprint_abstract: 'Abstract here.',
              preprint_author_corresponding: 'Smith J',
              preprint_author_corresponding_institution: 'MIT',
              published_doi: '10.1038/xxx',
              published_journal: 'Nature',
              published_date: '2024-06-01',
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const result = await service.getPublishedVersion(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(result?.preprintTitle).toBe('Test Title');
      expect(result?.preprintAuthors).toBe('Smith J');
      expect(result?.preprintCategory).toBe('Neuroscience');
      expect(result?.preprintDate).toBe('2024-01-15');
      expect(result?.preprintAbstract).toBe('Abstract here.');
      expect(result?.preprintAuthorCorresponding).toBe('Smith J');
      expect(result?.preprintAuthorCorrespondingInstitution).toBe('MIT');
    });

    it('normalizes Highwire/JATS markup out of preprint title and abstract', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              preprint_doi: '10.1101/2024.01.15.575123',
              preprint_title: 'CO<sub>2</sub> fixation in <i>E. coli</i>',
              preprint_abstract:
                'AO_SCPLOWBSTRACTC_SCPLOWCarbon fixation is central to metabolism.',
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const result = await service.getPublishedVersion(
        '10.1101/2024.01.15.575123',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(result?.preprintTitle).toBe('CO2 fixation in E. coli');
      expect(result?.preprintAbstract).toBe('Carbon fixation is central to metabolism.');
    });

    it('resolves placeholders and removes display-figure blocks in the crosswalk abstract', async () => {
      // Live shape: 10.1101/2020.04.14.040204, whose `_DISPLAY` residue the old
      // lazy figure match left behind.
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              preprint_doi: '10.1101/2020.04.14.040204',
              preprint_title: 'TGF[beta] signaling after {Delta}F508 correction',
              preprint_abstract:
                'Relapse is reported in some, thought to be cured, patients.\n\nGraphical Abstract O_FIG_DISPLAY_L [Figure 1] M_FIG_DISPLAY C_FIG_DISPLAY',
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const result = await service.getPublishedVersion(
        '10.1101/2020.04.14.040204',
        'biorxiv',
        startCallDeadline(),
        ctx,
      );
      expect(result?.preprintTitle).toBe('TGFβ signaling after ΔF508 correction');
      expect(result?.preprintAbstract).toBe(
        'Relapse is reported in some, thought to be cured, patients.',
      );
    });

    it('throws serviceUnavailable when API returns HTML error page', async () => {
      mockFetch.mockResolvedValue(makeHtmlResponse());
      const ctx = createMockContext();
      await expect(
        service.getPublishedVersion(
          '10.1101/2024.01.15.575123',
          'biorxiv',
          startCallDeadline(),
          ctx,
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    });

    // The DOI-keyed form shares the `/pubs` envelope type with the interval
    // listing, whose `messages` carry string totals and cursors. This path reads
    // the collection alone, so whatever the envelope says leaves it unchanged.
    it('reads only the collection of a live-shaped envelope and keys the URL by DOI', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok', cursor: '100', count: 1, total: '449' }],
          collection: [PUBS_ROW_64898],
        }),
      );
      const result = await service.getPublishedVersionByJournalDoi(
        '10.1038/s41467-026-77129-4',
        '10.64898/2026.01.10.693661',
        'biorxiv',
        startCallDeadline(),
        createMockContext(),
      );
      expect((mockFetch.mock.calls[0] as string[])[0]).toBe(
        'https://api.biorxiv.org/pubs/biorxiv/10.1038/s41467-026-77129-4/json',
      );
      expect(result).toEqual(PUBLISHED_64898);
    });

    it('answers undefined for the empty status a 10.64898/ DOI key draws', async () => {
      // Live: the DOI-keyed form never parses a 10.64898/ DOI.
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'no articles found for published version of ' }],
          collection: [],
        }),
      );
      const result = await service.getPublishedVersion(
        '10.64898/2026.01.10.693661',
        'biorxiv',
        startCallDeadline(),
        createMockContext(),
      );
      expect(result).toBeUndefined();
    });

    it('sends a multi-slash DOI whole, never the first two segments the API would read raw', async () => {
      // Live: raw, /pubs/biorxiv/10.1101/614172/x/json is keyed by `10.1101/614172`
      // alone — the record of a different DOI.
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'DOI 10.1101/614172/x not recognizable' }],
          collection: [],
        }),
      );
      const result = await service.getPublishedVersion(
        '10.1101/614172/x',
        'biorxiv',
        startCallDeadline(),
        createMockContext(),
      );
      expect((mockFetch.mock.calls[0] as string[])[0]).toBe(
        'https://api.biorxiv.org/pubs/biorxiv/10.1101/614172%252Fx/json',
      );
      expect(result).toBeUndefined();
    });

    it('resolves a multi-slash journal DOI to the first record listed for it', async () => {
      // Live: /pubs/biorxiv/10.1093/molbev%252Fmsag238/json (trimmed).
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok' }],
          collection: [
            {
              preprint_doi: '10.1101/2025.10.01.679802',
              published_doi: '10.1093/molbev/msag238',
              published_journal: 'Molecular Biology and Evolution',
              published_date: '2026-10-03',
            },
          ],
        }),
      );
      const result = await service.getPublishedVersion(
        '10.1093/molbev/msag238',
        'biorxiv',
        startCallDeadline(),
        createMockContext(),
      );
      expect((mockFetch.mock.calls[0] as string[])[0]).toBe(
        'https://api.biorxiv.org/pubs/biorxiv/10.1093/molbev%252Fmsag238/json',
      );
      expect(result).toMatchObject({
        preprintDoi: '10.1101/2025.10.01.679802',
        publishedDoi: '10.1093/molbev/msag238',
        publishedJournal: 'Molecular Biology and Evolution',
      });
    });
  });

  // ── getPublishedListing ─────────────────────────────────────────────────────

  describe('getPublishedListing', () => {
    /** `limit` defaults to the whole 100-row upstream page. */
    const list = (server: 'biorxiv' | 'medrxiv', cursor: number, limit = 100) =>
      service.getPublishedListing(
        server,
        '2026-09-01',
        '2026-09-07',
        cursor,
        limit,
        startCallDeadline(),
        createMockContext(),
      );

    /** A full 100-row upstream page, its preprint DOIs numbered from `from`. */
    const fullPage = (from: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        ...PUBS_ROW_64898,
        preprint_doi: `10.64898/2026.01.01.${700000 + from + i}`,
      }));

    const pageResponse = (collection: object[], total = '449') =>
      makeResponse({ messages: [{ status: 'ok', total }], collection });

    it('serves the first `limit` rows of the upstream page and sends no size upstream', async () => {
      const raw = fullPage(0);
      mockFetch.mockResolvedValue(pageResponse(raw));
      const result = await list('biorxiv', 0, 25);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect((mockFetch.mock.calls[0] as string[])[0]).toBe(
        'https://api.biorxiv.org/pubs/biorxiv/2026-09-01/2026-09-07/0/json',
      );
      expect(result.publications.map((p) => p.preprintDoi)).toEqual(
        raw.slice(0, 25).map((r) => r.preprint_doi),
      );
      expect(result.rowCount).toBe(25);
      expect(result.pagination).toEqual({ cursor: 0, total: 449 });
    });

    it.each([
      [1, 1],
      [99, 99],
      [100, 100],
      [101, 100],
      [1000, 100],
    ])('limit %i serves %i rows of a 100-row page', async (limit, served) => {
      const raw = fullPage(0);
      mockFetch.mockResolvedValue(pageResponse(raw));
      const result = await list('biorxiv', 0, limit);
      expect(result.rowCount).toBe(served);
      expect(result.publications.map((p) => p.preprintDoi)).toEqual(
        raw.slice(0, served).map((r) => r.preprint_doi),
      );
    });

    it('serves a short last page whole when limit reaches past it', async () => {
      mockFetch.mockResolvedValue(pageResponse(MEDRXIV_C100_ROWS, '103'));
      const result = await list('medrxiv', 100, 25);
      expect(result.rowCount).toBe(3);
      expect(result.publications.map((p) => p.preprintDoi)).toEqual(
        MEDRXIV_C100_ROWS.map((r) => r.preprint_doi),
      );
    });

    // The slice is of upstream rows: a dropped row inside it still occupies its
    // offset, and the row just past it is never read, so nextCursor (cursor +
    // rowCount) lands on the first row this page did not serve.
    it('slices upstream rows before dropping one that names no preprint', async () => {
      const raw = fullPage(0);
      raw[10] = { ...raw[10], preprint_doi: '' } as (typeof raw)[number];
      mockFetch.mockResolvedValue(pageResponse(raw));
      const result = await list('biorxiv', 0, 25);
      expect(result.rowCount).toBe(25);
      expect(result.publications).toHaveLength(24);
      expect(result.publications.map((p) => p.preprintDoi)).toEqual(
        raw
          .slice(0, 25)
          .filter((_, i) => i !== 10)
          .map((r) => r.preprint_doi),
      );
      expect(result.publications.map((p) => p.preprintDoi)).not.toContain(raw[25]?.preprint_doi);
    });

    it('requests the interval page and parses the string total (live page-0 envelope)', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [
            { status: 'ok', interval: '2026-09-01:2026-09-07', cursor: 0, count: 2, total: '449' },
          ],
          collection: [PUBS_ROW_64898, PUBS_ROW_1101],
        }),
      );
      const result = await list('biorxiv', 0);
      expect((mockFetch.mock.calls[0] as string[])[0]).toBe(
        'https://api.biorxiv.org/pubs/biorxiv/2026-09-01/2026-09-07/0/json',
      );
      expect(result.pagination).toEqual({ cursor: 0, total: 449 });
      expect(result.publications).toEqual([
        PUBLISHED_64898,
        {
          preprintDoi: '10.1101/2025.11.21.689628',
          publishedDoi: '10.1038/s42003-026-10580-7',
          publishedJournal: 'Communications Biology',
          publishedDate: '2026-09-03',
          preprintTitle:
            'Observations of anisotropic paramagnetic and diamagnetic susceptibility in the primate brain',
          preprintAuthors: PUBS_ROW_1101.preprint_authors,
          preprintCategory: 'neuroscience',
          preprintDate: '2025-11-22',
          preprintAbstract: PUBS_ROW_1101.preprint_abstract,
          preprintAuthorCorresponding: 'Jingjia Chen',
          preprintAuthorCorrespondingInstitution: 'New York University',
        },
      ]);
    });

    it('reads a later page, whose cursor echo is a string', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [
            {
              status: 'ok',
              interval: '2026-09-01:2026-09-07',
              cursor: '100',
              count: 3,
              total: '103',
            },
          ],
          collection: MEDRXIV_C100_ROWS,
        }),
      );
      const result = await list('medrxiv', 100);
      expect((mockFetch.mock.calls[0] as string[])[0]).toBe(
        'https://api.biorxiv.org/pubs/medrxiv/2026-09-01/2026-09-07/100/json',
      );
      expect(result.pagination).toEqual({ cursor: 100, total: 103 });
      expect(result.publications.map((p) => p.preprintDoi)).toEqual(
        MEDRXIV_C100_ROWS.map((r) => r.preprint_doi),
      );
    });

    it.each([
      ['a cursor at the end', 449],
      ['a cursor past the end', 500],
      ['an empty interval', 0],
    ])('reports no total for "no articles found" (%s)', async (_label, cursor) => {
      mockFetch.mockResolvedValue(makeResponse({ messages: [NO_ARTICLES], collection: [] }));
      const result = await list('biorxiv', cursor);
      expect(result.publications).toEqual([]);
      expect(result.pagination).toEqual({ cursor });
      expect(result.rowCount).toBe(0);
    });

    it('accepts a numeric total and drops one that is not a count', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ messages: [{ status: 'ok', total: 12 }], collection: [PUBS_ROW_1101] }),
      );
      expect((await list('biorxiv', 0)).pagination).toEqual({ cursor: 0, total: 12 });
      mockFetch.mockResolvedValueOnce(
        makeResponse({ messages: [{ status: 'ok', total: 'n/a' }], collection: [PUBS_ROW_1101] }),
      );
      expect((await list('biorxiv', 0)).pagination).toEqual({ cursor: 0 });
    });

    it('keeps a sparse row sparse and drops a row naming no preprint', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok', total: '2' }],
          collection: [
            { preprint_doi: '10.1101/2025.01.01.000001', published_journal: 'eLife' },
            { published_doi: '10.7554/eLife.00001' },
          ],
        }),
      );
      const { publications, rowCount } = await list('biorxiv', 0);
      expect(publications).toEqual([
        { preprintDoi: '10.1101/2025.01.01.000001', publishedJournal: 'eLife' },
      ]);
      // The dropped row still occupies its upstream offset.
      expect(rowCount).toBe(2);
    });

    it('normalizes Highwire markup out of each title and abstract', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok', total: '1' }],
          collection: [
            {
              ...PUBS_ROW_1101,
              preprint_title: 'TGF[beta] signaling in <i>E. coli</i>',
              preprint_abstract: 'AO_SCPLOWBSTRACTC_SCPLOWWe report a method.',
            },
          ],
        }),
      );
      const [publication] = (await list('biorxiv', 0)).publications;
      expect(publication?.preprintTitle).toBe('TGFβ signaling in E. coli');
      expect(publication?.preprintAbstract).toBe('We report a method.');
    });

    it('throws serviceUnavailable when API returns HTML error page', async () => {
      mockFetch.mockResolvedValue(makeHtmlResponse());
      await expect(list('biorxiv', 0)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
    });

    describe('by publisher prefix', () => {
      const listPublisher = (publisher: string, cursor: number, limit = 100) =>
        service.getPublishedListing(
          { publisher },
          '2026-10-01',
          '2026-10-02',
          cursor,
          limit,
          startCallDeadline(),
          createMockContext(),
        );
      const requestedUrl = () => (mockFetch.mock.calls[0] as string[])[0];

      it("requests bioRxiv's /publisher page and reads biorxiv_doi as the preprint DOI (live envelope)", async () => {
        mockFetch.mockResolvedValue(
          makeResponse({
            messages: [
              { status: 'ok', interval: '2026-10-01:2026-10-02', cursor: 0, count: 5, total: 5 },
            ],
            collection: PUBLISHER_ELIFE_ROWS,
          }),
        );
        const result = await listPublisher('10.7554', 0);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(requestedUrl()).toBe(
          'https://api.biorxiv.org/publisher/10.7554/2026-10-01/2026-10-02/0',
        );
        expect(result.pagination).toEqual({ cursor: 0, total: 5 });
        expect(result.rowCount).toBe(5);
        expect(result).not.toHaveProperty('publisherNotRecognized');
        expect(result.publications.map((p) => p.preprintDoi)).toEqual(
          PUBLISHER_ELIFE_ROWS.map((r) => r.biorxiv_doi),
        );
        expect(result.publications[0]).toEqual({
          preprintDoi: '10.1101/2025.09.09.675263',
          publishedDoi: '10.7554/eLife.109426.3',
          publishedDate: '2026-10-01',
          preprintTitle:
            'Sex-biased expression of enteroendocrine cell-derived hormones contributes to higher fat storage in Drosophila females',
          preprintCategory: 'physiology',
          preprintDate: '2025-09-12',
        });
        // Nothing a /publisher row lacks is filled in from anywhere else.
        for (const p of result.publications) {
          expect(Object.keys(p).sort()).toEqual([
            'preprintCategory',
            'preprintDate',
            'preprintDoi',
            'preprintTitle',
            'publishedDate',
            'publishedDoi',
          ]);
        }
      });

      it('continues at a later cursor, whose echo is a string, and slices the page to limit', async () => {
        const raw = Array.from({ length: 100 }, (_, i) => ({
          ...PUBLISHER_ELIFE_ROWS[0],
          biorxiv_doi: `10.64898/2026.01.01.${700100 + i}`,
          published_doi: `10.1016/j.example.2026.${100 + i}`,
        }));
        mockFetch.mockResolvedValue(
          makeResponse({
            messages: [{ status: 'ok', interval: '', cursor: '100', count: 100, total: 401 }],
            collection: raw,
          }),
        );
        const result = await listPublisher('10.1016', 100, 25);
        expect(requestedUrl()).toBe(
          'https://api.biorxiv.org/publisher/10.1016/2026-10-01/2026-10-02/100',
        );
        expect(result.rowCount).toBe(25);
        expect(result.pagination).toEqual({ cursor: 100, total: 401 });
        expect(result.publications.map((p) => p.preprintDoi)).toEqual(
          raw.slice(0, 25).map((r) => r.biorxiv_doi),
        );
      });

      it.each([
        ['an empty interval or a prefix with no rows', '10.9999', 0],
        ['a cursor past the last row', '10.7554', 1000],
      ])(
        'reads "no articles found" (%s) as an empty page with no total',
        async (_label, prefix, cursor) => {
          mockFetch.mockResolvedValue(
            makeResponse({ messages: [PUBLISHER_NO_ARTICLES], collection: [] }),
          );
          const result = await listPublisher(prefix, cursor);
          expect(requestedUrl()).toBe(
            `https://api.biorxiv.org/publisher/${prefix}/2026-10-01/2026-10-02/${cursor}`,
          );
          expect(result).toEqual({ publications: [], pagination: { cursor }, rowCount: 0 });
        },
      );

      it('flags a prefix upstream does not recognize instead of reading it as an empty page', async () => {
        mockFetch.mockResolvedValue(
          makeResponse({ messages: [PUBLISHER_NOT_RECOGNIZED], collection: [] }),
        );
        const result = await listPublisher('10.123456', 0);
        expect(requestedUrl()).toBe(
          'https://api.biorxiv.org/publisher/10.123456/2026-10-01/2026-10-02/0',
        );
        expect(result).toEqual({
          publications: [],
          pagination: { cursor: 0 },
          rowCount: 0,
          publisherNotRecognized: true,
        });
      });

      it('never reads a server-keyed /pubs listing answering that status as an unrecognized prefix', async () => {
        mockFetch.mockResolvedValue(
          makeResponse({ messages: [PUBLISHER_NOT_RECOGNIZED], collection: [] }),
        );
        expect(await list('biorxiv', 0)).not.toHaveProperty('publisherNotRecognized');
      });
    });
  });

  // ── The call budget ─────────────────────────────────────────────────────────

  describe('call budget', () => {
    it.each(Object.entries(API_CALLS))(
      '%s bounds an attempt at its own timeout while the budget leaves more, on the attempt signal',
      async (name, call) => {
        const attempt = new AbortController();
        retry.impl = (fn) => fn({ signal: attempt.signal, remainingMs: Number.POSITIVE_INFINITY });
        mockFetch.mockResolvedValue(makeResponse({ messages: [NO_ARTICLES] }));
        const ctx = createMockContext();
        await call(service, ctx);
        const [, timeoutMs, , options] = mockFetch.mock.calls[0] as FetchCall;
        expect(timeoutMs).toBe(ATTEMPT_TIMEOUT_MS[name as keyof typeof API_CALLS]);
        // The attempt's own signal, which the deadline aborts — not the caller's.
        expect(options.signal).toBe(attempt.signal);
        expect(options.signal).not.toBe(ctx.signal);
      },
    );

    it.each(Object.entries(API_CALLS))(
      '%s bounds an attempt at what the budget has left once that is less than its own timeout',
      async (_name, call) => {
        const attempt = new AbortController();
        retry.impl = (fn) => fn({ signal: attempt.signal, remainingMs: 7_000 });
        mockFetch.mockResolvedValue(makeResponse({ messages: [NO_ARTICLES] }));
        await call(service, createMockContext());
        const [, timeoutMs] = mockFetch.mock.calls[0] as FetchCall;
        expect(timeoutMs).toBe(7_000);
      },
    );

    describe('against an origin that never answers', () => {
      let origin: ReturnType<typeof hungOrigin>;

      beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
        const { withRetry } = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
          '@cyanheads/mcp-ts-core/utils',
        );
        retry.impl = withRetry as RetryFn;
        origin = hungOrigin();
        mockFetch.mockImplementation(origin.fetch);
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it.each(Object.entries(API_CALLS))(
        '%s settles inside the 50 s call budget, under a client 60 s request timeout',
        async (_name, call) => {
          const deadline = startCallDeadline();
          const ctx = createMockContext();
          const { err, elapsedMs } = await settle(call(service, ctx, deadline));

          expect(err).toBeInstanceOf(McpError);
          expect(err.code).toBe(JsonRpcErrorCode.Timeout);
          expect(err.data?.reason).toBe('retry_deadline_exceeded');
          expect(elapsedMs).toBeLessThanOrEqual(CALL_BUDGET_MS);
          // Four unbounded attempts plus backoff would run past a minute.
          expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
          // Every attempt was capped at what the call had left when it started,
          // and listened on the attempt signal the budget aborts.
          for (const [i, [, timeoutMs, , options]] of (
            mockFetch.mock.calls as FetchCall[]
          ).entries()) {
            expect(timeoutMs).toBeLessThanOrEqual(deadline - (origin.startedAt[i] as number));
            expect(options.signal).not.toBe(ctx.signal);
          }
        },
      );

      it.each(Object.entries(API_CALLS))(
        '%s spends only what is left of a budget an earlier request already drew on',
        async (_name, call) => {
          // The call is 40 s in: an earlier, chained request took the rest.
          const deadline = (Date.now() + 10_000) as CallDeadline;
          const { err, elapsedMs } = await settle(call(service, createMockContext(), deadline));
          expect(err.data?.reason).toBe('retry_deadline_exceeded');
          expect(elapsedMs).toBeLessThanOrEqual(10_000);
        },
      );

      it.each(Object.entries(API_CALLS))(
        '%s keeps a caller cancellation a cancellation, never relabelled as the deadline',
        async (_name, call) => {
          const caller = new AbortController();
          setTimeout(() => caller.abort(), 10_000);
          const ctx = createMockContext({ signal: caller.signal });
          const { err, elapsedMs } = await settle(call(service, ctx, startCallDeadline()));
          expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
          expect(err.data?.reason).toBeUndefined();
          expect(elapsedMs).toBe(10_000);
        },
      );

      it.each([
        [
          'getDetails',
          (ctx: Ctx, signal: AbortSignal) =>
            service.getDetails(
              '10.1101/2024.01.15.575123',
              'biorxiv',
              startCallDeadline(),
              ctx,
              signal,
            ),
        ],
        [
          'getPublishedVersion',
          (ctx: Ctx, signal: AbortSignal) =>
            service.getPublishedVersion(
              '10.1101/2024.01.15.575123',
              'biorxiv',
              startCallDeadline(),
              ctx,
              signal,
            ),
        ],
      ])(
        '%s stops when the leg signal it was handed aborts, with the caller still live',
        async (_name, call) => {
          const leg = new AbortController();
          setTimeout(() => leg.abort(), 10_000);
          const { err, elapsedMs } = await settle(call(createMockContext(), leg.signal));

          expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
          expect(err.data?.reason).toBeUndefined();
          expect(elapsedMs).toBe(10_000);
          expect(mockFetch).toHaveBeenCalledTimes(1);
        },
      );

      it.each(Object.entries(API_CALLS))(
        '%s fails fast as rate_limited on a Retry-After longer than the budget leaves',
        async (_name, call) => {
          mockFetch.mockRejectedValue(httpError(429, '30'));
          const deadline = (Date.now() + 10_000) as CallDeadline;
          const { err, elapsedMs } = await settle(call(service, createMockContext(), deadline));
          expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
          expect(err.data).toMatchObject({ reason: 'rate_limited', retryAfter: 30 });
          expect(elapsedMs).toBe(0);
          expect(mockFetch).toHaveBeenCalledTimes(1);
        },
      );

      // Wiring only: retryWithinBudget's own tests table every unusable Retry-After
      // shape, and every call runs on it, so one call proves the origin's 429 reaches
      // the ladder in the shape it reads.
      it('backs off on a 429 with Retry-After: 0 as on one with no header, never re-sending at once', async () => {
        const startedAt: number[] = [];
        mockFetch.mockImplementation(() => {
          startedAt.push(Date.now());
          return Promise.reject(httpError(429, '0'));
        });
        const { err } = await settle(API_CALLS.getDetails(service, createMockContext()));

        // 500 ms base, ±25% jitter: waits of 375–625, 750–1250, 1500–2500 ms.
        const gaps = startedAt.slice(1).map((t, i) => t - (startedAt[i] as number));
        expect(gaps).toHaveLength(3);
        for (const [i, gap] of gaps.entries()) {
          expect(gap).toBeGreaterThanOrEqual(375 * 2 ** i);
          expect(gap).toBeLessThanOrEqual(625 * 2 ** i);
        }
        expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(err.message).toBe('api.biorxiv.org is rate-limiting this host (HTTP 429).');
        expect(err.data).toEqual({
          reason: 'rate_limited',
          retryable: true,
          recovery: expect.any(Object),
        });
      });

      it.each(Object.entries(API_CALLS))(
        '%s keeps a 429 the budget ran out after as rate_limited, never an expiry',
        async (_name, call) => {
          // 20 s left. Every attempt answers 429 with no Retry-After 9.6 s in,
          // inside every call's per-attempt timeout, which still applies: the
          // second lands at 19.6–19.8 s, with less left than the 0.75–1.25 s
          // backoff before a third.
          mockFetch.mockImplementation((...args: FetchCall) =>
            Promise.race([
              new Promise((_resolve, reject) => setTimeout(() => reject(httpError(429)), 9_600)),
              origin.fetch(...args),
            ]),
          );
          const deadline = (Date.now() + 20_000) as CallDeadline;
          const { err, elapsedMs } = await settle(call(service, createMockContext(), deadline));
          expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
          expect(err.data).toMatchObject({ reason: 'rate_limited', retryable: true });
          expect(err.message).toContain('api.biorxiv.org is rate-limiting this host');
          expect(mockFetch).toHaveBeenCalledTimes(2);
          expect(elapsedMs).toBeLessThanOrEqual(20_000);
        },
      );

      describe.each([
        [
          'no Retry-After',
          undefined,
          { reason: 'rate_limited', retryable: true },
          'api.biorxiv.org is rate-limiting this host (HTTP 429).',
        ],
        [
          'a Retry-After',
          '2',
          { reason: 'rate_limited', retryable: true, retryAfter: 2 },
          'api.biorxiv.org is rate-limiting this host (HTTP 429) and asked for a 2-second wait before the next request.',
        ],
      ])('against slow 429s with %s', (_label, retryAfter, data, message) => {
        it.each(Object.entries(API_CALLS))(
          '%s stays rate_limited when the budget cuts a later attempt short',
          async (_name, call) => {
            // Every attempt answers 429 13.5 s in, inside every per-attempt timeout.
            // The fourth starts 43.1–46.5 s in and is still waiting at 50 s.
            mockFetch.mockImplementation(
              slowOrigin(13_500, () => httpError(429, retryAfter)).fetch,
            );
            const { err, elapsedMs } = await settle(call(service, createMockContext()));
            expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
            expect(err.data).toEqual({ ...data, recovery: expect.any(Object) });
            expect(err.message).toBe(message);
            expect(mockFetch).toHaveBeenCalledTimes(4);
            expect(elapsedMs).toBe(CALL_BUDGET_MS);
          },
        );
      });

      it.each(Object.entries(API_CALLS))(
        '%s reports a budget already spent as the call running out of time, without a request',
        async (_name, call) => {
          const spent = Date.now() as CallDeadline;
          const { err, elapsedMs } = await settle(call(service, createMockContext(), spent));
          expect(err.code).toBe(JsonRpcErrorCode.Timeout);
          expect(err.data?.reason).toBe('retry_deadline_exceeded');
          expect(err.message).toContain("the call's 50 s time budget had run out");
          expect(err.message).not.toMatch(/\b0ms\b/);
          expect(mockFetch).not.toHaveBeenCalled();
          expect(elapsedMs).toBe(0);
        },
      );

      it.each(Object.entries(API_CALLS))(
        '%s makes the same attempts and returns the same result against a healthy origin',
        async (name, call) => {
          // One row every call parses into a non-empty result: a `/details`
          // revision and the `/pubs` record the journal-DOI lookup matches.
          const row = {
            doi: '10.1101/2024.01.15.575123',
            title: 'Healthy origin',
            preprint_doi: '10.64898/2026.01.07.26343585',
            preprint_title: 'Healthy origin',
          };
          const ok = () => makeResponse({ messages: [{ status: 'ok' }], collection: [row] });
          mockFetch.mockReset().mockResolvedValue(ok());
          const direct = await call(service, createMockContext());
          expect(JSON.stringify(direct)).toContain('Healthy origin');

          mockFetch.mockReset().mockRejectedValueOnce(httpError(503)).mockResolvedValue(ok());
          const { value, elapsedMs } = await settle(call(service, createMockContext()));
          expect(value).toEqual(direct);
          expect(mockFetch).toHaveBeenCalledTimes(2);
          // One 503, one 500 ms backoff (±25 % jitter), the full per-attempt timeout each time.
          expect(elapsedMs).toBeLessThanOrEqual(625);
          for (const [, timeoutMs] of mockFetch.mock.calls as FetchCall[]) {
            expect(timeoutMs).toBe(ATTEMPT_TIMEOUT_MS[name as keyof typeof API_CALLS]);
          }
        },
      );
    });
  });

  // ── getCategories / isValidCategory ────────────────────────────────────────

  describe('getCategories / isValidCategory', () => {
    it('returns a non-empty taxonomy for both servers', () => {
      const taxonomy = service.getCategories();
      expect(taxonomy.biorxiv.length).toBeGreaterThan(0);
      expect(taxonomy.medrxiv.length).toBeGreaterThan(0);
    });

    it('validates known categories as true and unknown as false', () => {
      expect(service.isValidCategory('Neuroscience')).toBe(true);
      expect(service.isValidCategory('FakeCategory')).toBe(false);
    });

    it('validates per-server: biorxiv category is not valid for medrxiv', () => {
      // Neuroscience is biorxiv-only
      expect(service.isValidCategory('Neuroscience', 'biorxiv')).toBe(true);
      expect(service.isValidCategory('Neuroscience', 'medrxiv')).toBe(false);
    });

    it('validates per-server: medrxiv category is not valid for biorxiv', () => {
      // Cardiology is medrxiv-only
      expect(service.isValidCategory('Cardiovascular Medicine', 'medrxiv')).toBe(true);
      expect(service.isValidCategory('Cardiovascular Medicine', 'biorxiv')).toBe(false);
    });

    it('validates both-server: accepts category in either taxonomy', () => {
      expect(service.isValidCategory('Neuroscience', 'both')).toBe(true);
      expect(service.isValidCategory('Cardiovascular Medicine', 'both')).toBe(true);
    });

    it('validates both-server: rejects unknown category', () => {
      expect(service.isValidCategory('QuantumBiology', 'both')).toBe(false);
    });

    it('returns the same taxonomy object on repeated calls (idempotent)', () => {
      const first = service.getCategories();
      const second = service.getCategories();
      expect(first).toEqual(second);
    });

    it('matches case-insensitively, reading "_", "-", and "/" as a space', () => {
      for (const spelling of [
        'Cell Biology',
        'cell biology',
        'CELL_BIOLOGY',
        ' cell  biology ',
        'cell-biology',
      ]) {
        expect(service.isValidCategory(spelling, 'biorxiv')).toBe(true);
      }
      // The spelling the API echoes in every record's own category field
      expect(service.isValidCategory('hiv aids', 'medrxiv')).toBe(true);
      expect(service.isValidCategory('HIV_AIDS', 'medrxiv')).toBe(true);
      // The websites' collection slugs
      expect(service.isValidCategory('hiv-aids', 'medrxiv')).toBe(true);
      expect(service.isValidCategory('animal-behavior-and-cognition', 'biorxiv')).toBe(true);
      expect(service.isValidCategory('hiv aids', 'biorxiv')).toBe(false);
    });

    it('omits the categories the API cannot filter on', () => {
      const taxonomy = service.getCategories();
      expect(taxonomy.biorxiv).not.toContain('Epidemiology');
      expect(taxonomy.biorxiv).not.toContain('Clinical Trials');
      expect(taxonomy.medrxiv).not.toContain('Vascular Medicine');
      expect(taxonomy.medrxiv).toContain('Epidemiology');
      expect(taxonomy.medrxiv).toContain('HIV/AIDS');
      expect(taxonomy.biorxiv).toHaveLength(25);
      expect(taxonomy.medrxiv).toHaveLength(51);
      expect(service.isValidCategory('Epidemiology', 'biorxiv')).toBe(false);
      expect(service.isValidCategory('Epidemiology', 'medrxiv')).toBe(true);
      expect(service.isValidCategory('Clinical Trials', 'both')).toBe(false);
      expect(service.isValidCategory('Vascular Medicine', 'both')).toBe(false);
    });

    it('keeps a category shared by both taxonomies valid on each', () => {
      expect(service.isValidCategory('Pathology', 'biorxiv')).toBe(true);
      expect(service.isValidCategory('Pathology', 'medrxiv')).toBe(true);
    });
  });

  // ── getListing category spelling and ignored-filter detection ─────────────

  describe('getListing category filter', () => {
    const listing = (category: string | undefined) =>
      service.getListing(
        'medrxiv',
        '2026-01-01',
        '2026-09-01',
        0,
        { category },
        startCallDeadline(),
        createMockContext(),
      );
    const calledUrl = () => (mockFetch.mock.calls[0] as string[])[0] ?? '';

    it.each([
      ['HIV/AIDS', 'hiv%20aids'],
      ['hiv_aids', 'hiv%20aids'],
      ['Cell Biology', 'cell%20biology'],
      ['CELL_BIOLOGY', 'cell%20biology'],
      ['hiv-aids', 'hiv%20aids'],
      ['Pharmacology and Therapeutics', 'pharmacology%20and%20therapeutics'],
    ])('sends %s in the API spelling (%s)', async (category, encoded) => {
      mockFetch.mockResolvedValue(
        makeResponse({ messages: [{ status: 'ok', category: 'x', total: '1' }], collection: [] }),
      );
      await listing(category);
      expect(calledUrl()).toMatch(new RegExp(`\\?category=${encoded}$`));
    });

    it('flags a requested category the API echoed back as "all"', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok', category: 'all', total: '13507' }],
          collection: [],
        }),
      );
      const result = await listing('Vascular Medicine');
      expect(result.categoryIgnored).toBe(true);
      expect(result.pagination.total).toBe(13507);
    });

    it('does not flag a category the API applied', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok', category: 'hiv aids', total: '177' }],
          collection: [],
        }),
      );
      expect((await listing('HIV/AIDS')).categoryIgnored).toBeUndefined();
    });

    it('does not flag an unfiltered request, whose echo is always "all"', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok', category: 'all', total: '318' }],
          collection: [],
        }),
      );
      const result = await listing(undefined);
      expect(result.categoryIgnored).toBeUndefined();
      expect(calledUrl()).not.toContain('category=');
    });

    it('does not flag an empty page, whose message carries no category echo', async () => {
      // Live shape for a filtered interval with no posts: status only, no category.
      mockFetch.mockResolvedValue(makeResponse({ messages: [{ status: 'no posts found' }] }));
      const result = await listing('Paleontology');
      expect(result.categoryIgnored).toBeUndefined();
      expect(result.preprints).toEqual([]);
    });
  });

  // ── getListing funder filter ────────────────────────────────────────────────

  describe('getListing funder filter', () => {
    const listing = (filters: { category?: string; funder?: string }) =>
      service.getListing(
        'biorxiv',
        '2026-08-01',
        '2026-08-31',
        0,
        filters,
        startCallDeadline(),
        createMockContext(),
      );
    const calledUrl = () => (mockFetch.mock.calls[0] as string[])[0] ?? '';

    /** Live NSF envelope for 2026-08: the funder echo names the real funder. */
    const NSF_ECHO = 'National Science Foundation : https://ror.org/021nxhr62';

    it('sends the funder query parameter', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok', category: 'all', funder: NSF_ECHO, total: '12' }],
          collection: [{ doi: '10.1101/2026.08.01.000001' }],
        }),
      );
      const result = await listing({ funder: '021nxhr62' });
      expect(calledUrl()).toMatch(/\/0\/json\?funder=021nxhr62$/);
      expect(result.pagination.total).toBe(12);
      // A funder-only page echoes category "all"; no category was sent, so no flag.
      expect(result.categoryIgnored).toBeUndefined();
      expect(result.funderNotFound).toBeUndefined();
    });

    it('sends category and funder together', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok', category: 'neuroscience', funder: NSF_ECHO, total: '4' }],
          collection: [],
        }),
      );
      await listing({ category: 'Neuroscience', funder: '021nxhr62' });
      expect(calledUrl()).toMatch(/\?category=neuroscience&funder=021nxhr62$/);
    });

    it('still flags a category the API ignored under a funder filter', async () => {
      // Live shape: the funder applied, the category did not — the page is the
      // funder's unfiltered-by-category listing.
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok', category: 'all', funder: NSF_ECHO, total: '12' }],
          collection: [],
        }),
      );
      const result = await listing({ category: 'Epidemiology', funder: '021nxhr62' });
      expect(result.categoryIgnored).toBe(true);
      expect(result.funderNotFound).toBeUndefined();
    });

    it('flags "funder value not found" as funderNotFound, not as an empty page', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ messages: [{ status: 'funder value not found' }] }),
      );
      const result = await listing({ funder: '016jc2h42' });
      expect(result.funderNotFound).toBe(true);
      expect(result.preprints).toEqual([]);
    });

    it('does not flag a funder page that is merely empty', async () => {
      // Live shape past the funder's last page, or for a funder with no posts.
      mockFetch.mockResolvedValue(makeResponse({ messages: [{ status: 'no posts found' }] }));
      const result = await listing({ funder: '021nxhr62' });
      expect(result.funderNotFound).toBeUndefined();
    });

    it('does not flag the not-found status when no funder was sent', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ messages: [{ status: 'funder value not found' }] }),
      );
      expect((await listing({})).funderNotFound).toBeUndefined();
      expect(calledUrl()).not.toContain('?');
    });
  });

  // ── getPublishedVersionByJournalDoi ─────────────────────────────────────────

  describe('getPublishedVersionByJournalDoi', () => {
    const PREPRINT = '10.64898/2026.01.07.26343585';
    const JOURNAL = '10.1017/S0033291726104693';

    it('queries /pubs by the journal DOI and returns the record naming the preprint', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok' }],
          collection: [
            { preprint_doi: '10.64898/2025.01.01.000001', published_doi: JOURNAL },
            {
              preprint_doi: PREPRINT,
              published_doi: JOURNAL,
              published_journal: 'Psychological Medicine',
              published_date: '2026-06-17',
            },
          ],
        }),
      );
      const result = await service.getPublishedVersionByJournalDoi(
        JOURNAL,
        PREPRINT,
        'medrxiv',
        startCallDeadline(),
        createMockContext(),
      );
      expect((mockFetch.mock.calls[0] as string[])[0]).toBe(
        `https://api.biorxiv.org/pubs/medrxiv/${JOURNAL}/json`,
      );
      expect(result).toMatchObject({
        preprintDoi: PREPRINT,
        publishedDoi: JOURNAL,
        publishedJournal: 'Psychological Medicine',
        publishedDate: '2026-06-17',
      });
    });

    it('double-encodes every slash after the first, so a multi-slash journal DOI arrives whole', async () => {
      // Sent raw, the API reads only `10.1093/genetics`; a single-encoded %2F is a 404.
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'ok' }],
          collection: [
            {
              preprint_doi: '10.64898/2026.01.07.697413',
              published_doi: '10.1093/genetics/iyag142',
              published_journal: 'GENETICS',
              published_date: '2026-06-03',
            },
          ],
        }),
      );
      const result = await service.getPublishedVersionByJournalDoi(
        '10.1093/genetics/iyag142',
        '10.64898/2026.01.07.697413',
        'biorxiv',
        startCallDeadline(),
        createMockContext(),
      );
      expect((mockFetch.mock.calls[0] as string[])[0]).toBe(
        'https://api.biorxiv.org/pubs/biorxiv/10.1093/genetics%252Fiyag142/json',
      );
      expect(result).toMatchObject({ publishedJournal: 'GENETICS', publishedDate: '2026-06-03' });
    });

    it('returns undefined when the crosswalk answers empty', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          messages: [{ status: 'Preprint for DOI 10.1093/genetics/iyag142 not found' }],
          collection: [],
        }),
      );
      const result = await service.getPublishedVersionByJournalDoi(
        '10.1093/genetics/iyag142',
        PREPRINT,
        'medrxiv',
        startCallDeadline(),
        createMockContext(),
      );
      expect(result).toBeUndefined();
    });

    it('ignores a record for a different preprint', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [{ preprint_doi: '10.1101/2024.01.01.000001', published_doi: JOURNAL }],
        }),
      );
      const result = await service.getPublishedVersionByJournalDoi(
        JOURNAL,
        PREPRINT,
        'medrxiv',
        startCallDeadline(),
        createMockContext(),
      );
      expect(result).toBeUndefined();
    });
  });

  // ── HTTP 429 classification ─────────────────────────────────────────────────

  describe('rate-limit classification', () => {
    for (const [name, call] of Object.entries(API_CALLS)) {
      it(`${name} classifies a 429 as rate_limited carrying the parsed Retry-After`, async () => {
        mockFetch.mockRejectedValue(httpError(429, '30'));
        const ctx = createMockContext();
        const err = await call(service, ctx).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
        expect((err as McpError).data).toMatchObject({
          reason: 'rate_limited',
          retryable: true,
          retryAfter: 30,
        });
      });

      it(`${name} keeps the upstream 429 body out of the caller-visible payload`, async () => {
        mockFetch.mockRejectedValue(httpError(429, '30'));
        const ctx = createMockContext();
        const err = await call(service, ctx).catch((e: unknown) => e);

        // `data` is what reaches the client as structuredContent.error.data.
        const data = (err as McpError).data ?? {};
        expect(JSON.stringify(data)).not.toContain('429 Too Many Requests');
        expect(data).not.toHaveProperty('body');
        expect(data).not.toHaveProperty('responseBody');
        expect(data).not.toHaveProperty('statusCode');
        expect(data).not.toHaveProperty('status');
        expect((err as McpError).message).not.toContain('<html>');
      });

      it(`${name} passes 429 as an expected status so it logs at debug`, async () => {
        mockFetch.mockRejectedValue(httpError(429, '30'));
        const ctx = createMockContext();
        await call(service, ctx).catch(() => undefined);

        const options = (mockFetch.mock.calls[0] as unknown[])[3] as {
          expectedStatuses?: number[];
        };
        expect(options.expectedStatuses).toEqual([429]);
      });
    }

    it('reads an HTTP-date Retry-After as a wait in seconds', async () => {
      mockFetch.mockRejectedValue(httpError(429, new Date(Date.now() + 120_000).toUTCString()));
      const ctx = createMockContext();
      const err = await API_CALLS.getDetails(service, ctx).catch((e: unknown) => e);
      const retryAfter = (err as McpError).data?.retryAfter as number;
      expect(retryAfter).toBeGreaterThan(110);
      expect(retryAfter).toBeLessThanOrEqual(120);
    });

    it('leaves retryAfter absent when the origin sent no Retry-After header', async () => {
      mockFetch.mockRejectedValue(httpError(429));
      const ctx = createMockContext();
      const err = await API_CALLS.getDetails(service, ctx).catch((e: unknown) => e);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
      expect((err as McpError).data?.retryAfter).toBeUndefined();
      expect((err as McpError).data?.reason).toBe('rate_limited');
    });

    it('treats Retry-After: 0 exactly like a 429 with no header', async () => {
      const ctx = createMockContext();
      mockFetch.mockRejectedValue(httpError(429, '0'));
      const zero = (await API_CALLS.getDetails(service, ctx).catch((e: unknown) => e)) as McpError;
      mockFetch.mockRejectedValue(httpError(429));
      const none = (await API_CALLS.getDetails(service, ctx).catch((e: unknown) => e)) as McpError;

      expect(zero.message).toBe(none.message);
      expect(zero.data).toEqual(none.data);
      expect(zero.data).not.toHaveProperty('retryAfter');
      expect(zero.message).not.toContain('0-second');
      expect(zero.data?.recovery).toMatchObject({
        hint: expect.stringContaining('a minute or two'),
      });
    });

    it('names the wait in a recovery hint the caller can act on', async () => {
      mockFetch.mockRejectedValue(httpError(429, '30'));
      const ctx = createMockContext();
      const err = await API_CALLS.getDetails(service, ctx).catch((e: unknown) => e);
      const hint = ((err as McpError).data?.recovery as { hint?: string } | undefined)?.hint ?? '';
      expect(hint).toContain('30 seconds');
      expect(hint).toContain('api.biorxiv.org');
    });

    it('preserves the upstream rejection as cause for diagnosis', async () => {
      const upstream = httpError(429, '30');
      mockFetch.mockRejectedValue(upstream);
      const ctx = createMockContext();
      const err = await API_CALLS.getDetails(service, ctx).catch((e: unknown) => e);
      expect((err as Error).cause).toBe(upstream);
    });

    it('leaves a non-429 upstream failure untouched for the framework to classify', async () => {
      const upstream = httpError(503);
      mockFetch.mockRejectedValue(upstream);
      const ctx = createMockContext();
      const err = await API_CALLS.getDetails(service, ctx).catch((e: unknown) => e);
      expect(err).toBe(upstream);
    });

    it('leaves a plain network rejection untouched', async () => {
      const upstream = new Error('ECONNREFUSED');
      mockFetch.mockRejectedValue(upstream);
      const ctx = createMockContext();
      const err = await API_CALLS.getDetails(service, ctx).catch((e: unknown) => e);
      expect(err).toBe(upstream);
    });

    it('throws a rejection findRateLimit recognizes — the seam every tool branches on', async () => {
      mockFetch.mockRejectedValue(httpError(429, '30'));
      const ctx = createMockContext();
      const err = await API_CALLS.getDetails(service, ctx).catch((e: unknown) => e);
      expect(findRateLimit([err])).toEqual({ retryAfter: 30 });
    });

    it('throws the shape the shared tool-test fixture stands in for', async () => {
      // The tool suites mock this service away and drive `rateLimitError()`
      // instead. If the real throw and that fixture drift apart, every one of
      // those suites keeps passing while the tools mis-branch in production.
      mockFetch.mockRejectedValue(httpError(429, '30'));
      const ctx = createMockContext();
      const err = (await API_CALLS.getDetails(service, ctx).catch((e: unknown) => e)) as McpError;
      const fixture = rateLimitError(30);
      const contractFields = (e: McpError) => ({
        code: e.code,
        reason: e.data?.reason,
        retryable: e.data?.retryable,
        retryAfter: e.data?.retryAfter,
      });
      expect(contractFields(err)).toEqual(contractFields(fixture));
    });
  });
});
