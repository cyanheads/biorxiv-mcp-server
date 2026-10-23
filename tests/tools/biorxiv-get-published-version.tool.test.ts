/**
 * @fileoverview Tests for biorxiv_get_published_version tool.
 * @module tests/tools/biorxiv-get-published-version.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetPublishedVersionTool } from '@/mcp-server/tools/definitions/biorxiv-get-published-version.tool.js';
import type { PublishedVersion } from '@/services/biorxiv/types.js';
import { CALL_BUDGET_MS } from '@/services/shared.js';
import {
  answerAfter,
  budgetStep,
  neverAnswers,
  routeLegs,
  settle,
} from '../helpers/call-budget.js';
import { ESCAPED, IDENTIFIERS, UPSTREAM } from '../helpers/markdown-fixtures.js';
import {
  declaredRateLimitRecovery,
  RATE_LIMIT_RECOVERY_OPENING,
  rateLimitError,
} from '../helpers/rate-limit.js';
import { envelopeHint, recoveryHint, rejection } from '../helpers/rejection.js';

const mockGetPublishedVersion = vi.fn();
// The /details fallback runs whenever the crosswalk answers empty; the default
// here is a preprint no server holds, so those tests still end in doi_not_found.
const mockGetDetails = vi.fn();
const mockGetPublishedVersionByJournalDoi = vi.fn();

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({
    getPublishedVersion: mockGetPublishedVersion,
    getDetails: mockGetDetails,
    getPublishedVersionByJournalDoi: mockGetPublishedVersionByJournalDoi,
  }),
}));

const PUBLISHED: PublishedVersion = {
  preprintDoi: '10.1101/2024.01.15.575123',
  publishedDoi: '10.1038/s41586-024-00001-0',
  publishedJournal: 'Nature',
  publishedDate: '2024-06-01',
  preprintTitle: 'Test Preprint Title',
  preprintAuthors: 'Smith J, Jones A',
  preprintCategory: 'Neuroscience',
};

describe('biorxivGetPublishedVersionTool', () => {
  beforeEach(() => {
    mockGetPublishedVersion.mockResolvedValue(PUBLISHED);
    mockGetDetails.mockReset();
    mockGetDetails.mockResolvedValue([]);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns the published version record', async () => {
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.preprintDoi).toBe('10.1101/2024.01.15.575123');
    expect(result.publishedJournal).toBe('Nature');
  });

  it('routes to medrxiv server when specified', async () => {
    const mxPublished: PublishedVersion = {
      ...PUBLISHED,
      preprintDoi: '10.1101/2024.06.01.123456',
      publishedJournal: 'Lancet',
    };
    mockGetPublishedVersion.mockResolvedValue(mxPublished);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.06.01.123456',
      server: 'medrxiv',
    });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.publishedJournal).toBe('Lancet');
    // Verify medrxiv was passed to the service
    expect(mockGetPublishedVersion).toHaveBeenCalledWith(
      '10.1101/2024.06.01.123456',
      'medrxiv',
      expect.any(Number),
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('defaults server to "both" when omitted', () => {
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    expect(input.server).toBe('both');
  });

  it('resolves a medRxiv-only DOI when server is omitted, naming medrxiv as the answering server', async () => {
    const mxPublished: PublishedVersion = {
      ...PUBLISHED,
      preprintDoi: '10.1101/2024.11.21.24317726',
      publishedDoi: '10.1172/JCI192052',
      publishedJournal: 'Journal of Clinical Investigation',
    };
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      server === 'medrxiv' ? Promise.resolve(mxPublished) : Promise.resolve(undefined),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.11.21.24317726',
    });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.publishedDoi).toBe('10.1172/JCI192052');
    expect(result.server).toBe('medrxiv');
    expect(mockGetPublishedVersion).toHaveBeenCalledWith(
      '10.1101/2024.11.21.24317726',
      'biorxiv',
      expect.any(Number),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(mockGetPublishedVersion).toHaveBeenCalledWith(
      '10.1101/2024.11.21.24317726',
      'medrxiv',
      expect.any(Number),
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('names biorxiv as the answering server when the DOI resolves there', async () => {
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv' ? Promise.resolve(PUBLISHED) : Promise.resolve(undefined),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.server).toBe('biorxiv');
  });

  it('accepts the alternative 10.64898/ DOI prefix', async () => {
    mockGetPublishedVersion.mockResolvedValue({
      ...PUBLISHED,
      preprintDoi: '10.64898/2026.05.07.723463',
    });
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.64898/2026.05.07.723463',
    });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.preprintDoi).toBe('10.64898/2026.05.07.723463');
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('throws invalid_doi_format for malformed DOI', async () => {
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: 'bad-doi' });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_doi_format' },
    });
  });

  it('throws invalid_doi_format for DOI without required prefix', async () => {
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    // A string starting with digits but missing the slash and subpath
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10notadoi' });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_doi_format' },
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('throws doi_not_found when preprint is not yet published', async () => {
    mockGetPublishedVersion.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.01.000001' });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found' },
    });
  });

  it('keeps doi_not_found when both servers answer with no record', async () => {
    mockGetPublishedVersion.mockReset();
    mockGetPublishedVersion.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'both',
    });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found' },
    });
    expect(mockGetPublishedVersion).toHaveBeenCalledTimes(2);
  });

  it('throws retryable upstream_unavailable instead of doi_not_found when both servers fail', async () => {
    const upstream = new Error('network error');
    mockGetPublishedVersion.mockRejectedValue(upstream);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'both',
    });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true },
    });
    // The upstream error is what a maintainer needs to diagnose the outage; the
    // wrapper carries it as `cause` rather than discarding it at the boundary.
    expect(err.cause).toBe(upstream);
  });

  it('throws retryable upstream_unavailable when the single requested server fails', async () => {
    mockGetPublishedVersion.mockRejectedValue(new Error('network error'));
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'biorxiv',
    });
    await expect(biorxivGetPublishedVersionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true },
    });
  });

  it('still resolves when one server fails and the other holds the record', async () => {
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv'
        ? Promise.reject(new Error('network error'))
        : Promise.resolve({ ...PUBLISHED, publishedJournal: 'Lancet' }),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.publishedJournal).toBe('Lancet');
    expect(result.server).toBe('medrxiv');
  });

  it('doi_not_found recovery routes to the other server rather than asserting the preprint is unpublished', async () => {
    mockGetPublishedVersion.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'biorxiv',
    });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));
    expect(recoveryHint(err)).toMatch(/both/i);
    expect(recoveryHint(err)).not.toMatch(/has not been accepted/i);
  });

  // The retry on server="both" is advice only to a call that checked one server.
  describe('doi_not_found hint on the wire', () => {
    const RETRY_BOTH = 'Retry with server="both"';
    const JOURNAL_HINT =
      'The crosswalk records no bioRxiv or medRxiv preprint for this journal article — it was never posted there, its preprint was never linked to it, or the DOI names part of an article (a figure or review such as 10.7554/eLife.55185.sa1) rather than the article itself. Search for the preprint by title with biorxiv_search_preprints.';
    const NO_PREPRINT_HINT =
      'No preprint has this DOI — check it, or find the preprint with biorxiv_search_preprints. A Cold Spring Harbor Laboratory Press journal DOI (10.1101/gr.…, 10.1101/gad.…, 10.1101/lm.…) shares the preprint prefix but cannot be looked up by DOI: search for its preprint by title instead.';
    const NO_JOURNAL_VERSION_HINT =
      'No journal version is recorded for this preprint yet — confirm the DOI with biorxiv_get_preprint, or check again later.';
    const scopedTo = (server: string, hint: string) =>
      `${RETRY_BOTH} — this call checked only ${server}. ${hint}`;
    const notFound = async (doi: string, server?: 'biorxiv' | 'medrxiv') => {
      const result = await runToolContract(
        biorxivGetPublishedVersionTool,
        { doi, ...(server && { server }) } as never,
        { context: { errors: biorxivGetPublishedVersionTool.errors } },
      );
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      const data = (result.structuredContent as { error?: { data?: Record<string, unknown> } })
        .error?.data;
      return { hint: envelopeHint(result), text, data };
    };

    beforeEach(() => {
      mockGetPublishedVersion.mockResolvedValue(undefined);
    });

    it.each([
      ['a journal DOI', '10.1038/nature12373', JOURNAL_HINT],
      ['a preprint DOI no server holds', '10.1101/2024.01.01.000001', NO_PREPRINT_HINT],
    ])(
      'omits the server="both" retry on %s when the call checked both',
      async (_case, doi, expected) => {
        const { hint, text } = await notFound(doi);
        expect(hint).toBe(expected);
        expect(text).toContain(expected);
        expect(text).not.toContain(RETRY_BOTH);
      },
    );

    it.each([
      ['a journal DOI', '10.1038/nature12373', JOURNAL_HINT],
      ['a preprint DOI no server holds', '10.1101/2024.01.01.000001', NO_PREPRINT_HINT],
    ])(
      'opens with the server="both" retry on %s when the call checked one server',
      async (_case, doi, expected) => {
        const { hint, text } = await notFound(doi, 'medrxiv');
        expect(hint).toBe(scopedTo('medrxiv', expected));
        expect(text).toContain(scopedTo('medrxiv', expected));
      },
    );

    it('scopes the retry on a preprint that lists no journal version the same way', async () => {
      mockGetDetails.mockResolvedValue([{ doi: '10.1101/2024.01.01.000001', version: '1' }]);
      const both = await notFound('10.1101/2024.01.01.000001');
      expect(both.hint).toBe(NO_JOURNAL_VERSION_HINT);
      const scoped = await notFound('10.1101/2024.01.01.000001', 'biorxiv');
      expect(scoped.hint).toBe(scopedTo('biorxiv', NO_JOURNAL_VERSION_HINT));
    });

    it('reads a component DOI as a whole journal DOI and names that case in the hint', async () => {
      const { hint, text, data } = await notFound('10.7554/eLife.85442.sa1');
      expect(data).toMatchObject({ reason: 'doi_not_found', doi: '10.7554/eLife.85442.sa1' });
      expect(mockGetPublishedVersion.mock.lastCall?.[0]).toBe('10.7554/eLife.85442.sa1');
      expect(hint).toBe(JOURNAL_HINT);
      expect(text).toContain(JOURNAL_HINT);
    });
  });

  it('declares a rate_limited recovery that holds when the origin named no wait', () => {
    expect(declaredRateLimitRecovery(biorxivGetPublishedVersionTool.errors)).toBe(
      `${RATE_LIMIT_RECOVERY_OPENING}retrying — every preprint metadata tool queries the same origin, so none of them will answer sooner.`,
    );
  });

  it('throws retryable rate_limited with the origin wait when the lookup was rate-limited', async () => {
    const upstream = rateLimitError(30);
    mockGetPublishedVersion.mockRejectedValue(upstream);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'both',
    });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryable: true,
        retryAfter: 30,
        doi: '10.1101/2024.01.01.000001',
        servers: ['biorxiv', 'medrxiv'],
      },
    });
    expect(recoveryHint(err)).toContain('30 seconds');
    expect(err.cause).toBe(upstream);
  });

  it('prefers rate_limited over upstream_unavailable when only one server was rate-limited', async () => {
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      Promise.reject(server === 'biorxiv' ? rateLimitError(45) : new Error('network error')),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.01.000001',
      server: 'both',
    });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: 45 },
    });
    expect(err.message).toContain('network error');
  });

  it('still resolves when one server is rate-limited and the other holds the record', async () => {
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv' ? Promise.reject(rateLimitError(30)) : Promise.resolve(PUBLISHED),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({
      doi: '10.1101/2024.01.15.575123',
    });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.server).toBe('medrxiv');
  });

  it('throws rate_limited, never doi_not_found, when a journal DOI lookup was rate-limited and the other server has no record', async () => {
    mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
      server === 'biorxiv' ? Promise.reject(rateLimitError(20)) : Promise.resolve(undefined),
    );
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1093/molbev/msag238' });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryAfter: 20,
        doi: '10.1093/molbev/msag238',
        servers: ['biorxiv'],
      },
    });
    expect(recoveryHint(err)).toContain('20 seconds');
    expect(mockGetDetails).not.toHaveBeenCalled();
  });

  it('doi_not_found error does not leak internal details', async () => {
    mockGetPublishedVersion.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.01.000001' });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));
    const serialized = JSON.stringify(err);
    expect(serialized).not.toMatch(/password|secret|key|token|BIORXIV_MAILTO/i);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it('handles sparse published record — only preprintDoi present', async () => {
    const sparse: PublishedVersion = { preprintDoi: '10.1101/2024.01.15.575123' };
    mockGetPublishedVersion.mockResolvedValue(sparse);
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi: '10.1101/2024.01.15.575123' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(result.preprintDoi).toBe('10.1101/2024.01.15.575123');
    expect(result.publishedJournal).toBeUndefined();
    expect(result.publishedDoi).toBeUndefined();
  });

  // ── format ──────────────────────────────────────────────────────────────────

  it('formats output with journal and crosswalk fields', () => {
    const blocks = biorxivGetPublishedVersionTool.format!({ ...PUBLISHED, server: 'biorxiv' });
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.15.575123');
    expect(text).toContain('Nature');
    expect(text).toContain('10.1038/s41586-024-00001-0');
  });

  it('renders the answering server so a both-server caller knows which one resolved', () => {
    const blocks = biorxivGetPublishedVersionTool.format!({ ...PUBLISHED, server: 'medrxiv' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('medrxiv');
  });

  it('formats full crosswalk record including all optional fields', () => {
    const full: PublishedVersion & { server: 'biorxiv' } = {
      ...PUBLISHED,
      server: 'biorxiv',
      preprintDate: '2024-01-15',
      preprintAbstract: 'The full abstract text here.',
      preprintAuthorCorresponding: 'Smith J',
      preprintAuthorCorrespondingInstitution: 'MIT',
    };
    const blocks = biorxivGetPublishedVersionTool.format!(full);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('MIT');
    expect(text).toContain('full abstract text');
    expect(text).toContain('Smith J');
  });

  it('formats sparse published record without fabricating absent fields', () => {
    const sparse: PublishedVersion & { server: 'biorxiv' } = {
      preprintDoi: '10.1101/2024.01.15.575123',
      server: 'biorxiv',
    };
    const blocks = biorxivGetPublishedVersionTool.format!(sparse);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10.1101/2024.01.15.575123');
    // Should not contain any fabricated placeholders
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  // ── Upstream Markdown ───────────────────────────────────────────────────────

  describe('upstream text with Markdown metacharacters', () => {
    const MARKDOWN_PUBLISHED: PublishedVersion = {
      preprintDoi: IDENTIFIERS.doi,
      publishedDoi: IDENTIFIERS.publishedDoi,
      publishedJournal: UPSTREAM.journal,
      publishedDate: '2026-09-01',
      preprintTitle: UPSTREAM.title,
      preprintAuthors: UPSTREAM.authors,
      preprintCategory: UPSTREAM.category,
      preprintDate: '2026-07-03',
      preprintAbstract: UPSTREAM.abstract,
      preprintAuthorCorresponding: UPSTREAM.authorCorresponding,
      preprintAuthorCorrespondingInstitution: UPSTREAM.authorCorrespondingInstitution,
    };

    async function call() {
      mockGetPublishedVersion.mockResolvedValue(MARKDOWN_PUBLISHED);
      const result = await runToolContract(
        biorxivGetPublishedVersionTool,
        { doi: IDENTIFIERS.doi, server: 'biorxiv' },
        { context: { errors: biorxivGetPublishedVersionTool.errors } },
      );
      return { result, text: (result.content[0] as { text: string }).text };
    }

    it('carries upstream text unescaped in structuredContent', async () => {
      const { result } = await call();
      expect(result.structuredContent).toMatchObject({
        publishedDoi: IDENTIFIERS.publishedDoi,
        publishedJournal: UPSTREAM.journal,
        preprintTitle: UPSTREAM.title,
        preprintAbstract: UPSTREAM.abstract,
      });
    });

    it('escapes every upstream field in content[], the line-initial abstract included', async () => {
      const { text } = await call();
      expect(text).toContain(`**Journal:** ${ESCAPED.journal}\n`);
      expect(text).toContain(`**Title:** ${ESCAPED.title}\n`);
      expect(text).toContain(`**Authors:** ${ESCAPED.authors}\n`);
      expect(text).toContain(`**Category:** ${ESCAPED.category}\n`);
      expect(text).toContain(`**Corresponding Author:** ${ESCAPED.authorCorresponding}\n`);
      expect(text).toContain(`**Institution:** ${ESCAPED.authorCorrespondingInstitution}\n`);
      // The abstract opens its own line under the label, where `1. ` starts an ordered list.
      expect(text).toContain(`**Abstract:**\n${ESCAPED.abstract}`);
      expect(text).not.toMatch(/^1\. /m);
    });

    it('leaves the preprint and journal DOIs unescaped in content[]', async () => {
      const { text } = await call();
      expect(text).toContain(`**Preprint DOI:** ${IDENTIFIERS.doi}\n`);
      expect(text).toContain(`**Published DOI:** ${IDENTIFIERS.publishedDoi}\n`);
    });
  });

  // ── Cancellation ────────────────────────────────────────────────────────────

  describe('cancellation', () => {
    const DOI = '10.1101/2024.01.15.575123';
    const HELD = [{ doi: DOI, version: '1', publishedJournalDoi: PUBLISHED.publishedDoi }];
    let controller: AbortController;
    let cancelled: Error;

    /** Aborts the caller's signal, then rejects the way an aborted request does. */
    const abortLeg = () => {
      controller.abort(cancelled);
      return Promise.reject(new Error('aborted'));
    };
    const call = () =>
      rejection(
        biorxivGetPublishedVersionTool.handler(
          biorxivGetPublishedVersionTool.input.parse({ doi: DOI }),
          createMockContext({
            errors: biorxivGetPublishedVersionTool.errors,
            signal: controller.signal,
          }),
        ),
      );

    beforeEach(() => {
      controller = new AbortController();
      cancelled = new Error('cancelled by caller');
      mockGetPublishedVersionByJournalDoi.mockReset();
    });

    it('rethrows a cancellation rather than returning the crosswalk leg that finished first', async () => {
      mockGetPublishedVersion.mockImplementation((_doi: string, server: string) =>
        server === 'biorxiv' ? Promise.resolve(PUBLISHED) : abortLeg(),
      );
      expect(await call()).toBe(cancelled);
    });

    it('rethrows a cancellation from the preprint lookup rather than moving on with the leg that answered', async () => {
      mockGetPublishedVersion.mockResolvedValue(undefined);
      mockGetDetails.mockImplementation((_doi: string, server: string) =>
        server === 'biorxiv' ? Promise.resolve(HELD) : abortLeg(),
      );
      expect(await call()).toBe(cancelled);
      expect(mockGetPublishedVersionByJournalDoi).not.toHaveBeenCalled();
    });

    it('rethrows a cancellation from the crosswalk by journal DOI rather than degrading to a notice', async () => {
      mockGetPublishedVersion.mockResolvedValue(undefined);
      mockGetDetails.mockImplementation((_doi: string, server: string) =>
        Promise.resolve(server === 'biorxiv' ? HELD : []),
      );
      mockGetPublishedVersionByJournalDoi.mockImplementation(abortLeg);
      expect(await call()).toBe(cancelled);
    });

    it('settles a cancelled crosswalk by journal DOI as RequestCancelled', async () => {
      mockGetPublishedVersion.mockResolvedValue(undefined);
      mockGetDetails.mockImplementation((_doi: string, server: string) =>
        Promise.resolve(server === 'biorxiv' ? HELD : []),
      );
      mockGetPublishedVersionByJournalDoi.mockImplementation(abortLeg);
      const result = await runToolContract(biorxivGetPublishedVersionTool, { doi: DOI } as never, {
        context: { errors: biorxivGetPublishedVersionTool.errors, signal: controller.signal },
      });

      // The runner settles any throw after the abort as RequestCancelled, so the
      // message is what shows the caller's reason was rethrown.
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: { code: JsonRpcErrorCode.RequestCancelled, message: 'cancelled by caller' },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'Error: cancelled by caller' }]);
    });

    it('still degrades a crosswalk by journal DOI that failed while the signal was live to a notice', async () => {
      mockGetPublishedVersion.mockResolvedValue(undefined);
      mockGetDetails.mockImplementation((_doi: string, server: string) =>
        Promise.resolve(server === 'biorxiv' ? HELD : []),
      );
      mockGetPublishedVersionByJournalDoi.mockRejectedValue(new Error('fetch failed'));
      const ctx = createMockContext({
        errors: biorxivGetPublishedVersionTool.errors,
        signal: controller.signal,
      });
      const result = await biorxivGetPublishedVersionTool.handler(
        biorxivGetPublishedVersionTool.input.parse({ doi: DOI }),
        ctx,
      );

      expect(controller.signal.aborted).toBe(false);
      expect(result).toMatchObject({ server: 'biorxiv', publishedDoi: PUBLISHED.publishedDoi });
      expect(result.publishedJournal).toBeUndefined();
      expect(getEnrichment(ctx).notice).toContain('failed (fetch failed)');
    });
  });

  // ── One budget across the chain ─────────────────────────────────────────────

  describe('call budget', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('hands the crosswalk, the preprint lookup, and the crosswalk by journal DOI one 50 s budget', async () => {
      const doi = '10.64898/2026.01.07.26343585';
      const remaining: number[] = [];
      mockGetPublishedVersion.mockImplementation(budgetStep(remaining, 20_000, undefined));
      mockGetDetails.mockImplementation(
        budgetStep(remaining, 15_000, [{ doi, publishedJournalDoi: PUBLISHED.publishedDoi }]),
      );
      mockGetPublishedVersionByJournalDoi.mockImplementation(
        budgetStep(remaining, 0, { ...PUBLISHED, preprintDoi: doi }),
      );
      const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
      const input = biorxivGetPublishedVersionTool.input.parse({ doi, server: 'medrxiv' });
      const result = await biorxivGetPublishedVersionTool.handler(input, ctx);

      expect(result.publishedJournal).toBe('Nature');
      // Each step gets what the steps before it left, never a fresh budget.
      expect(remaining).toEqual([CALL_BUDGET_MS, 30_000, 15_000]);
    });
  });

  // ── Lookups across both servers ─────────────────────────────────────────────

  describe('lookups across both servers', () => {
    const DOI = '10.1101/2024.01.15.575123';
    const HELD = [{ doi: DOI, version: '1', publishedJournalDoi: PUBLISHED.publishedDoi }];

    /** The leg signal each per-server lookup was handed, by server. */
    let crosswalkSignals: Record<string, AbortSignal | undefined>;
    let detailsSignals: Record<string, AbortSignal | undefined>;
    /** When each crosswalk-by-journal-DOI request went out, in ms after the call started. */
    let journalLookupAt: number[];

    const handle = (signal?: AbortSignal) =>
      settle(
        runToolContract(biorxivGetPublishedVersionTool, { doi: DOI } as never, {
          context: { errors: biorxivGetPublishedVersionTool.errors, ...(signal && { signal }) },
        }),
      );

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
      crosswalkSignals = {};
      detailsSignals = {};
      journalLookupAt = [];
      const startedAt = Date.now();
      mockGetPublishedVersionByJournalDoi.mockReset();
      mockGetPublishedVersionByJournalDoi.mockImplementation(() => {
        journalLookupAt.push(Date.now() - startedAt);
        return Promise.resolve({ ...PUBLISHED, preprintDoi: DOI });
      });
    });
    afterEach(() => vi.useRealTimers());

    it.each([
      ['biorxiv', 'medrxiv'],
      ['medrxiv', 'biorxiv'],
    ])(
      'returns the crosswalk record the moment %s, the server holding it, answers',
      async (holder, other) => {
        routeLegs(
          mockGetPublishedVersion,
          {
            [holder]: () => answerAfter(1_000, PUBLISHED),
            [other]: (signal) => neverAnswers(signal, CALL_BUDGET_MS),
          },
          crosswalkSignals,
        );
        const { value, elapsedMs } = await handle();
        const result = value as Awaited<ReturnType<typeof runToolContract>>;

        expect(elapsedMs).toBe(1_000);
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          server: holder,
          publishedJournal: 'Nature',
        });
        expect((result.content[0] as { text: string }).text).toContain(
          `**Resolved on server:** ${holder}`,
        );
        // The lookup still running on the other server is cut short, never the caller.
        expect(crosswalkSignals[other]?.aborted).toBe(true);
        expect(crosswalkSignals[holder]?.aborted).toBe(false);
        expect(mockGetDetails).not.toHaveBeenCalled();
      },
    );

    it('moves on to the crosswalk by journal DOI the moment the server holding the preprint answers', async () => {
      mockGetPublishedVersion.mockResolvedValue(undefined);
      routeLegs(
        mockGetDetails,
        {
          biorxiv: () => answerAfter(1_000, HELD),
          medrxiv: (signal) => neverAnswers(signal, CALL_BUDGET_MS),
        },
        detailsSignals,
      );
      const { value, elapsedMs } = await handle();
      const result = value as Awaited<ReturnType<typeof runToolContract>>;

      expect(journalLookupAt).toEqual([1_000]);
      expect(elapsedMs).toBe(1_000);
      expect(result.structuredContent).toMatchObject({
        server: 'biorxiv',
        publishedJournal: 'Nature',
      });
      expect(mockGetPublishedVersionByJournalDoi).toHaveBeenCalledWith(
        PUBLISHED.publishedDoi,
        DOI,
        'biorxiv',
        expect.any(Number),
        expect.anything(),
      );
      expect(detailsSignals.medrxiv?.aborted).toBe(true);
    });

    it('waits for the crosswalk exactly as long as before when the holding server answers last', async () => {
      routeLegs(
        mockGetPublishedVersion,
        {
          biorxiv: () => answerAfter(1_000, undefined),
          medrxiv: () => answerAfter(3_000, PUBLISHED),
        },
        crosswalkSignals,
      );
      const { value, elapsedMs } = await handle();
      const result = value as Awaited<ReturnType<typeof runToolContract>>;

      expect(elapsedMs).toBe(3_000);
      expect(result.structuredContent).toMatchObject({ server: 'medrxiv' });
      // Every lookup had answered, so none was cut short.
      expect(crosswalkSignals.biorxiv?.aborted).toBe(false);
      expect(crosswalkSignals.medrxiv?.aborted).toBe(false);
      expect(mockGetDetails).not.toHaveBeenCalled();
    });

    it('still settles a caller cancellation during the crosswalk as RequestCancelled', async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('cancelled by caller')), 5_000);
      routeLegs(
        mockGetPublishedVersion,
        { biorxiv: (signal) => neverAnswers(signal), medrxiv: (signal) => neverAnswers(signal) },
        crosswalkSignals,
      );
      const { value, elapsedMs } = await handle(controller.signal);
      const result = value as Awaited<ReturnType<typeof runToolContract>>;

      expect(elapsedMs).toBe(5_000);
      expect(result.isError).toBe(true);
      // The caller's reason, never the two aborted lookups reported as a failed crosswalk.
      expect(result.structuredContent).toEqual({
        error: { code: JsonRpcErrorCode.RequestCancelled, message: 'cancelled by caller' },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'Error: cancelled by caller' }]);
      expect(mockGetDetails).not.toHaveBeenCalled();
    });
  });
});
