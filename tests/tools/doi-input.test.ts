/**
 * @fileoverview DOI input handling shared by the three DOI-keyed tools —
 * biorxiv_get_preprint, biorxiv_get_published_version, and biorxiv_get_fulltext.
 * Every bare DOI these tools already accepted must reach the service unchanged;
 * the pasted forms around it (doi.org and article URLs, `doi:`, version and
 * `.full` suffixes) must reach it as the same bare DOI; and anything still
 * unparseable after that is rejected before any API call.
 * @module tests/tools/doi-input.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetFulltextTool } from '@/mcp-server/tools/definitions/biorxiv-get-fulltext.tool.js';
import { biorxivGetPreprintTool } from '@/mcp-server/tools/definitions/biorxiv-get-preprint.tool.js';
import { biorxivGetPublishedVersionTool } from '@/mcp-server/tools/definitions/biorxiv-get-published-version.tool.js';
import { recoveryHint, rejection } from '../helpers/rejection.js';

const mockGetDetails = vi.fn();
const mockGetPublishedVersion = vi.fn();
const mockFetchFullText = vi.fn();

vi.mock('@/services/biorxiv/biorxiv-service.js', () => ({
  getBiorxivApiService: () => ({
    getDetails: mockGetDetails,
    getPublishedVersion: mockGetPublishedVersion,
  }),
}));

vi.mock('@/services/biorxiv-fulltext/biorxiv-fulltext-service.js', () => ({
  getBiorxivFullTextService: () => ({ fetchFullText: mockFetchFullText }),
}));

/** Bare DOIs every tool accepted before normalization existed — each must pass through unchanged. */
const ACCEPTED_BARE_DOIS = [
  '10.1101/2024.01.15.575123',
  '10.64898/2026.05.07.723463',
  '10.1101/2020.03.26.20044651',
  // Pre-2019 numeric bioRxiv identifier — no date segments, ends in digits
  '10.1101/339853',
];

describe('DOI input — bare DOIs already accepted reach the service unchanged', () => {
  beforeEach(() => {
    mockGetDetails.mockReset();
    mockGetPublishedVersion.mockReset();
    mockFetchFullText.mockReset();
  });

  it.each(ACCEPTED_BARE_DOIS)('biorxiv_get_preprint passes %s through', async (doi) => {
    mockGetDetails.mockResolvedValue([{ doi, version: '1', server: 'biorxiv' }]);
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({ dois: [doi], server: 'biorxiv' });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(mockGetDetails).toHaveBeenCalledWith(doi, 'biorxiv', expect.anything());
    expect(result.preprints[0]?.doi).toBe(doi);
  });

  it.each(ACCEPTED_BARE_DOIS)('biorxiv_get_published_version passes %s through', async (doi) => {
    mockGetPublishedVersion.mockResolvedValue({ preprintDoi: doi, publishedDoi: '10.1000/x' });
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi, server: 'biorxiv' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(mockGetPublishedVersion).toHaveBeenCalledWith(doi, 'biorxiv', expect.anything());
    expect(result.preprintDoi).toBe(doi);
  });

  it.each(ACCEPTED_BARE_DOIS)(
    'biorxiv_get_fulltext passes %s through at the latest version',
    async (doi) => {
      mockGetDetails.mockResolvedValue([
        { doi, version: '1', server: 'biorxiv' },
        { doi, version: '2', server: 'biorxiv' },
      ]);
      mockFetchFullText.mockResolvedValue({
        kind: 'article',
        markdown: 'Body text.',
        sourceUrl: `https://www.biorxiv.org/content/${doi}v2.full`,
      });
      const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
      const input = biorxivGetFulltextTool.input.parse({ doi, server: 'biorxiv' });
      const result = await biorxivGetFulltextTool.handler(input, ctx);
      expect(mockGetDetails).toHaveBeenCalledWith(doi, 'biorxiv', expect.anything());
      expect(mockFetchFullText).toHaveBeenCalledWith('biorxiv', doi, '2', expect.anything());
      expect(result.doi).toBe(doi);
      expect(result.version).toBe('2');
    },
  );
});

describe('DOI input — unparseable input is still rejected before any API call', () => {
  const INVALID = ['bad-doi', '10notadoi', 'not-a-doi; DROP TABLE preprints;--'];

  beforeEach(() => {
    mockGetDetails.mockReset();
    mockGetPublishedVersion.mockReset();
  });

  it.each(INVALID)('biorxiv_get_published_version rejects %s', async (doi) => {
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi });
    const err = await rejection(biorxivGetPublishedVersionTool.handler(input, ctx));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_doi_format' },
    });
    expect(mockGetPublishedVersion).not.toHaveBeenCalled();
  });

  it.each(INVALID)('biorxiv_get_fulltext rejects %s', async (doi) => {
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi });
    const err = await rejection(biorxivGetFulltextTool.handler(input, ctx));
    expect(err).toMatchObject({ data: { reason: 'invalid_doi_format' } });
    expect(mockGetDetails).not.toHaveBeenCalled();
  });

  it.each(INVALID)('biorxiv_get_preprint routes %s to failed[]', async (doi) => {
    mockGetDetails.mockResolvedValue([{ doi: '10.1101/2024.01.15.575123', version: '1' }]);
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: ['10.1101/2024.01.15.575123', doi],
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.failed).toEqual([expect.objectContaining({ doi, reason: 'invalid_doi_format' })]);
    expect(mockGetDetails).toHaveBeenCalledTimes(1);
  });
});

const BARE = '10.64898/2026.03.11.711201';

/** Pasted forms of one preprint, each of which must reach the service as {@link BARE}. */
const PASTED_FORMS = [
  `${BARE}v2`,
  `https://doi.org/${BARE}`,
  `http://dx.doi.org/${BARE}`,
  `https://dx.doi.org/${BARE}`,
  `doi:${BARE}`,
  `DOI: ${BARE}`,
  `https://www.biorxiv.org/content/${BARE}v2`,
  `https://www.biorxiv.org/content/${BARE}v2.full`,
  `https://www.biorxiv.org/content/${BARE}v2.full.pdf`,
  `https://www.medrxiv.org/content/${BARE}v1.full?versioned=true`,
  `biorxiv.org/content/${BARE}.full`,
  `  ${BARE}  `,
];

describe('DOI input — pasted forms normalize to the bare DOI', () => {
  beforeEach(() => {
    mockGetDetails.mockReset();
    mockGetPublishedVersion.mockReset();
    mockFetchFullText.mockReset();
  });

  it('biorxiv_get_preprint resolves every pasted form, reporting the bare DOI', async () => {
    mockGetDetails.mockResolvedValue([{ doi: BARE, version: '2', server: 'biorxiv' }]);
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({
      dois: PASTED_FORMS.slice(0, 10),
      server: 'biorxiv',
    });
    const result = await biorxivGetPreprintTool.handler(input, ctx);
    expect(result.failed).toEqual([]);
    expect(result.preprints).toHaveLength(10);
    expect(new Set(result.preprints.map((p) => p.doi))).toEqual(new Set([BARE]));
    for (const call of mockGetDetails.mock.calls) expect(call[0]).toBe(BARE);
  });

  it.each(PASTED_FORMS)('biorxiv_get_published_version resolves %s', async (doi) => {
    mockGetPublishedVersion.mockResolvedValue({ preprintDoi: BARE, publishedDoi: '10.1000/x' });
    const ctx = createMockContext({ errors: biorxivGetPublishedVersionTool.errors });
    const input = biorxivGetPublishedVersionTool.input.parse({ doi, server: 'biorxiv' });
    const result = await biorxivGetPublishedVersionTool.handler(input, ctx);
    expect(mockGetPublishedVersion).toHaveBeenCalledWith(BARE, 'biorxiv', expect.anything());
    expect(result.preprintDoi).toBe(BARE);
  });

  it('keeps an invalid DOI in failed[] under the text the caller sent', async () => {
    const ctx = createMockContext({ errors: biorxivGetPreprintTool.errors });
    const input = biorxivGetPreprintTool.input.parse({ dois: ['https://doi.org/'] });
    const err = await rejection(biorxivGetPreprintTool.handler(input, ctx));
    expect(err).toMatchObject({ data: { reason: 'invalid_doi_format' } });
    expect(err.message).toContain('https://doi.org/');
    expect(mockGetDetails).not.toHaveBeenCalled();
  });
});

describe('biorxiv_get_fulltext — requested version', () => {
  const REVISIONS = [
    { doi: BARE, version: '1', server: 'biorxiv' },
    { doi: BARE, version: '2', server: 'biorxiv' },
    { doi: BARE, version: '3', server: 'biorxiv' },
  ];

  beforeEach(() => {
    mockGetDetails.mockReset();
    mockFetchFullText.mockReset();
    mockGetDetails.mockImplementation((_doi: string, server: string) =>
      Promise.resolve(server === 'biorxiv' ? REVISIONS : []),
    );
    mockFetchFullText.mockImplementation((server: string, doi: string, version: string) =>
      Promise.resolve({
        kind: 'article',
        markdown: 'Body text of the article.',
        sourceUrl: `https://www.${server}.org/content/${doi}v${version}.full`,
      }),
    );
  });

  async function run(args: Record<string, unknown>) {
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    return biorxivGetFulltextTool.handler(biorxivGetFulltextTool.input.parse(args), ctx);
  }

  it('reads the latest revision for a bare DOI', async () => {
    const result = await run({ doi: BARE });
    expect(result.version).toBe('3');
    expect(mockFetchFullText).toHaveBeenCalledWith('biorxiv', BARE, '3', expect.anything());
  });

  it('honors a vN suffix as the requested version, resolving the bare DOI', async () => {
    const result = await run({ doi: `${BARE}v2` });
    expect(mockGetDetails).toHaveBeenCalledWith(BARE, 'biorxiv', expect.anything());
    expect(mockFetchFullText).toHaveBeenCalledWith('biorxiv', BARE, '2', expect.anything());
    expect(result).toMatchObject({ doi: BARE, version: '2' });
    expect(result.sourceUrl).toContain(`${BARE}v2.full`);
  });

  it('honors the version in a pasted article URL', async () => {
    const result = await run({ doi: `https://www.biorxiv.org/content/${BARE}v1.full.pdf` });
    expect(result.version).toBe('1');
  });

  it('honors an explicit version input', async () => {
    const result = await run({ doi: BARE, version: 2 });
    expect(result.version).toBe('2');
    expect(mockFetchFullText).toHaveBeenCalledWith('biorxiv', BARE, '2', expect.anything());
  });

  it('accepts a vN suffix and version input that agree', async () => {
    const result = await run({ doi: `${BARE}v2`, version: 2 });
    expect(result.version).toBe('2');
  });

  it('rejects a vN suffix that disagrees with the version input, before any API call', async () => {
    const err = await rejection(run({ doi: `${BARE}v2`, version: 3 }));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'version_conflict', doiVersion: '2', version: 3 },
    });
    expect(err.message).toContain('v2');
    expect(err.message).toContain('3');
    expect(recoveryHint(err)).toMatch(/version/);
    expect(mockGetDetails).not.toHaveBeenCalled();
  });

  it('raises version_not_found for a version the preprint does not have, listing the ones it does', async () => {
    const err = await rejection(run({ doi: `${BARE}v7` }));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'version_not_found', version: '7', availableVersions: ['1', '2', '3'] },
    });
    expect(err.message).toContain('1, 2, 3');
    expect(recoveryHint(err)).toMatch(/latest/);
    expect(mockFetchFullText).not.toHaveBeenCalled();
  });

  it('keeps the requested version in the next-chunk prompt so paging stays on it', async () => {
    mockFetchFullText.mockResolvedValue({
      kind: 'article',
      markdown: 'x'.repeat(120),
      sourceUrl: `https://www.biorxiv.org/content/${BARE}v1.full`,
    });
    const ctx = createMockContext({ errors: biorxivGetFulltextTool.errors });
    const input = biorxivGetFulltextTool.input.parse({ doi: BARE, version: 1, limit: 50 });
    const result = await biorxivGetFulltextTool.handler(input, ctx);
    const text = (biorxivGetFulltextTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain(`doi=${BARE}, version=1, offset=50`);
  });

  it('rejects a version below 1 at schema parse time', () => {
    expect(() => biorxivGetFulltextTool.input.parse({ doi: BARE, version: 0 })).toThrow();
  });

  // ── Both client surfaces ────────────────────────────────────────────────────

  const contract = (args: Record<string, unknown>) =>
    runToolContract(biorxivGetFulltextTool, args as never, {
      context: { errors: biorxivGetFulltextTool.errors },
    });
  const textOf = (result: Awaited<ReturnType<typeof contract>>) =>
    result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

  it('carries a suffix-requested version on structuredContent and content[]', async () => {
    const result = await contract({ doi: `https://www.biorxiv.org/content/${BARE}v2.full` });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ doi: BARE, version: '2' });
    const text = textOf(result);
    expect(text).toContain(`**DOI:** ${BARE} | **Server:** biorxiv | **Version:** v2`);
    expect(text).toContain(`${BARE}v2.full`);
  });

  it('renders version_conflict with its recovery on both surfaces', async () => {
    const result = await contract({ doi: `${BARE}v2`, version: 3 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'version_conflict' } },
    });
    const text = textOf(result);
    expect(text).toContain('Recovery:');
    expect(text).toContain('(reason version_conflict)');
  });

  it('renders version_not_found with the available versions on both surfaces', async () => {
    const result = await contract({ doi: BARE, version: 9 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'version_not_found', availableVersions: ['1', '2', '3'] },
      },
    });
    const text = textOf(result);
    expect(text).toContain('available versions: 1, 2, 3');
    expect(text).toContain('(reason version_not_found)');
  });
});

describe('biorxiv_get_preprint — pasted forms on both client surfaces', () => {
  beforeEach(() => {
    mockGetDetails.mockReset();
    mockGetDetails.mockImplementation((doi: string, server: string) =>
      Promise.resolve(server === 'biorxiv' ? [{ doi, version: '2', server: 'biorxiv' }] : []),
    );
  });

  it('reports the bare DOI for a pasted URL and the raw text for an unparseable one', async () => {
    const result = await runToolContract(
      biorxivGetPreprintTool,
      { dois: [`https://doi.org/${BARE}`, 'doi:'] } as never,
      { context: { errors: biorxivGetPreprintTool.errors } },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      preprints: [{ doi: BARE }],
      failed: [{ doi: 'doi:', reason: 'invalid_doi_format' }],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(`**DOI:** ${BARE}`);
    expect(text).not.toContain('https://doi.org/');
    expect(text).toContain('**doi:**: Invalid DOI format');
  });
});
