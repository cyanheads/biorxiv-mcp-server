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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import { findRateLimit } from '@/services/shared.js';
import { rateLimitError } from '../../helpers/rate-limit.js';

// Stub out fetchWithTimeout and withRetry so no real HTTP calls are made
const mockFetch = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetch(...args),
  withRetry: async (fn: () => Promise<unknown>) => fn(),
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

/** Every call BiorxivApiService makes against api.biorxiv.org, by name. */
const API_CALLS = {
  getDetails: (s: BiorxivApiService, ctx: ReturnType<typeof createMockContext>) =>
    s.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx),
  getListing: (s: BiorxivApiService, ctx: ReturnType<typeof createMockContext>) =>
    s.getListing('biorxiv', '2024-01-01', '2024-01-31', 0, undefined, ctx),
  getPublishedVersion: (s: BiorxivApiService, ctx: ReturnType<typeof createMockContext>) =>
    s.getPublishedVersion('10.1101/2024.01.15.575123', 'biorxiv', ctx),
} as const;

const MOCK_CONFIG = {} as AppConfig;
const MOCK_STORAGE = {} as StorageService;

describe('BiorxivApiService', () => {
  let service: BiorxivApiService;

  beforeEach(() => {
    service = new BiorxivApiService(MOCK_CONFIG, MOCK_STORAGE);
    mockFetch.mockReset();
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
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.doi).toBe('10.1101/2024.01.15.575123');
      expect(revisions[0]?.title).toBe('Test Preprint');
      // "NA" published should be normalized to absent
      expect(revisions[0]?.publishedJournalDoi).toBeUndefined();
    });

    it('returns empty array when DOI not found', async () => {
      mockFetch.mockResolvedValue(makeResponse({ collection: [] }));
      const ctx = createMockContext();
      const revisions = await service.getDetails('10.1101/2024.01.01.000001', 'biorxiv', ctx);
      expect(revisions).toHaveLength(0);
    });

    it('handles sparse upstream payload — omitted optional fields stay absent', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [{ doi: '10.1101/2024.01.15.575123' }],
        }),
      );
      const ctx = createMockContext();
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(revisions[0]?.title).toBeUndefined();
      expect(revisions[0]?.abstract).toBeUndefined();
      expect(revisions[0]?.authors).toBeUndefined();
    });

    it('normalizes funder array to a joined string', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              doi: '10.1101/2024.01.15.575123',
              funder: [{ name: 'NIH' }, { name: 'NSF' }],
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(revisions[0]?.funder).toBe('NIH; NSF');
    });

    it('normalizes funder="NA" to absent', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          collection: [
            {
              doi: '10.1101/2024.01.15.575123',
              funder: 'NA',
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(revisions[0]?.funder).toBeUndefined();
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
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
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
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
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
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(revisions[0]?.authorCorresponding).toBe('Smith J');
      expect(revisions[0]?.authorCorrespondingInstitution).toBe('MIT');
    });

    it('throws serviceUnavailable when API returns HTML error page', async () => {
      mockFetch.mockResolvedValue(makeHtmlResponse());
      const ctx = createMockContext();
      await expect(
        service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx),
      ).rejects.toThrow();
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
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
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
      const revisions = await service.getDetails('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(revisions[0]?.title).toBe('Editing Staphylococcus aureus genomes');
      expect(revisions[0]?.abstract).toBe('We report a method.');
      expect(revisions[0]?.abstract).not.toMatch(/O_FIG|C_FIG|SRC=|org\.highwire|SCPLOW/);
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
        undefined,
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
        undefined,
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
        undefined,
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
        undefined,
        ctx,
      );
      expect(result.preprints).toHaveLength(0);
    });

    it('passes cursor offset to the URL', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ messages: [{ total: 30, cursor: 30 }], collection: [] }),
      );
      const ctx = createMockContext();
      await service.getListing('biorxiv', '2024-01-01', '2024-01-31', 30, undefined, ctx);
      // URL should contain the offset
      const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
      expect(calledUrl).toContain('/30/');
    });

    it('appends category query param to URL when provided', async () => {
      mockFetch.mockResolvedValue(makeResponse({ messages: [{ total: 5 }], collection: [] }));
      const ctx = createMockContext();
      await service.getListing('biorxiv', '2024-01-01', '2024-01-31', 0, 'Neuroscience', ctx);
      const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
      expect(calledUrl).toContain('category=Neuroscience');
    });

    it('throws serviceUnavailable when API returns HTML error page', async () => {
      mockFetch.mockResolvedValue(makeHtmlResponse());
      const ctx = createMockContext();
      await expect(
        service.getListing('biorxiv', '2024-01-01', '2024-01-31', 0, undefined, ctx),
      ).rejects.toThrow();
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
      const result = await service.getPublishedVersion('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(result?.preprintDoi).toBe('10.1101/2024.01.15.575123');
      expect(result?.publishedJournal).toBe('Nature');
    });

    it('returns undefined when preprint is not yet published', async () => {
      mockFetch.mockResolvedValue(makeResponse({ collection: [] }));
      const ctx = createMockContext();
      const result = await service.getPublishedVersion('10.1101/2024.01.01.000001', 'biorxiv', ctx);
      expect(result).toBeUndefined();
    });

    it('returns undefined when collection record lacks preprint_doi', async () => {
      mockFetch.mockResolvedValue(makeResponse({ collection: [{ published_doi: '10.1038/xxx' }] }));
      const ctx = createMockContext();
      const result = await service.getPublishedVersion('10.1101/2024.01.15.575123', 'biorxiv', ctx);
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
      const result = await service.getPublishedVersion('10.1101/2024.01.15.575123', 'biorxiv', ctx);
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
      const result = await service.getPublishedVersion('10.1101/2024.01.15.575123', 'biorxiv', ctx);
      expect(result?.preprintTitle).toBe('CO2 fixation in E. coli');
      expect(result?.preprintAbstract).toBe('Carbon fixation is central to metabolism.');
    });

    it('throws serviceUnavailable when API returns HTML error page', async () => {
      mockFetch.mockResolvedValue(makeHtmlResponse());
      const ctx = createMockContext();
      await expect(
        service.getPublishedVersion('10.1101/2024.01.15.575123', 'biorxiv', ctx),
      ).rejects.toThrow();
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
