/**
 * @fileoverview biorxiv_get_published_version end to end for preprints the
 * `/pubs/{server}/{doi}` crosswalk cannot resolve by preprint DOI — every
 * `10.64898/` DOI today. The real `BiorxivApiService`, `fetchWithTimeout`,
 * `withRetry`, tool handler, `format()`, and error envelope all run; only
 * `globalThis.fetch` is faked, answering with the live API's envelopes for
 * `/pubs` and `/details`, so both client surfaces are asserted as a caller
 * receives them.
 * @module tests/tools/biorxiv-get-published-version.fallback.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetPublishedVersionTool } from '@/mcp-server/tools/definitions/biorxiv-get-published-version.tool.js';
import { initBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

const NEW_DOI = '10.64898/2026.01.07.26343585';
const JOURNAL_DOI = '10.1017/S0033291726104693';
const OLD_DOI = '10.1101/2025.09.17.676679';

/** `/pubs` by a `10.64898/` preprint DOI — the API never parses the DOI. */
const PUBS_UNPARSED = {
  messages: [{ status: 'no articles found for published version of ' }],
  collection: [],
};

const DETAILS_EMPTY = { messages: [{ status: 'no posts found' }], collection: [] };

/** `/details` for {@link NEW_DOI}: three medRxiv revisions, each naming the journal DOI. */
function details(published: string) {
  return {
    messages: [{ status: 'ok', category: 'all' }],
    collection: ['2026-01-08', '2026-04-02', '2026-06-01'].map((date, i) => ({
      doi: NEW_DOI,
      title: 'Real World Effectiveness of Antipsychotic Treatment on Functional Outcomes',
      authors: 'Twumasi, R.; Gronemann, F. H.',
      author_corresponding: 'Ricardo Twumasi',
      author_corresponding_institution: "King's College London",
      date,
      version: String(i + 1),
      type: 'new results',
      license: 'cc_by',
      category: 'psychiatry and clinical psychology',
      abstract: `Abstract of revision ${i + 1}.`,
      published,
      server: 'medRxiv',
    })),
  };
}

/** `/pubs` by the journal DOI — the crosswalk record, keyed the other way. */
const PUBS_BY_JOURNAL = {
  messages: [{ status: 'ok' }],
  collection: [
    {
      preprint_doi: NEW_DOI,
      published_doi: JOURNAL_DOI,
      published_journal: 'Psychological Medicine',
      preprint_platform: 'medRxiv',
      preprint_title: 'Real World Effectiveness of Antipsychotic Treatment on Functional Outcomes',
      preprint_authors: 'Twumasi, R.; Gronemann, F. H.',
      preprint_category: 'psychiatry and clinical psychology',
      preprint_date: '2026-01-08',
      published_date: '2026-06-17',
      preprint_abstract: 'Abstract of revision 3.',
      preprint_author_corresponding: 'Ricardo Twumasi',
      preprint_author_corresponding_institution: "King's College London",
    },
  ],
};

const http = createFetchMock();

/** Answer each exact api.biorxiv.org path; any other request fails the test loudly. */
function answer(routes: Record<string, unknown>): void {
  http.route({
    match: (request) => new URL(request.url).hostname === 'api.biorxiv.org',
    respond: (request) => {
      const path = new URL(request.url).pathname;
      if (!(path in routes)) throw new Error(`unexpected request: ${path}`);
      const body = routes[path];
      return typeof body === 'number'
        ? new Response('upstream error', { status: body })
        : Response.json(body);
    },
  });
}

const paths = () => http.calls.map(({ request }) => new URL(request.url).pathname);

async function run(input: Record<string, unknown>) {
  const pending = runToolContract(biorxivGetPublishedVersionTool, input as never, {
    context: { errors: biorxivGetPublishedVersionTool.errors },
  });
  await vi.runAllTimersAsync();
  return pending;
}

function text(result: Awaited<ReturnType<typeof run>>): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function structured(result: Awaited<ReturnType<typeof run>>) {
  return result.structuredContent as Record<string, unknown> & {
    error?: { code: number; message: string; data: Record<string, unknown> };
  };
}

describe('biorxiv_get_published_version — /details fallback for DOIs /pubs cannot key on', () => {
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

  it('resolves a 10.64898/ DOI through /details and the journal-DOI crosswalk (#46)', async () => {
    answer({
      [`/pubs/biorxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/pubs/medrxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/details/biorxiv/${NEW_DOI}/0/json`]: DETAILS_EMPTY,
      [`/details/medrxiv/${NEW_DOI}/0/json`]: details(JOURNAL_DOI),
      [`/pubs/medrxiv/${JOURNAL_DOI}/json`]: PUBS_BY_JOURNAL,
    });
    const result = await run({ doi: NEW_DOI });

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      preprintDoi: NEW_DOI,
      server: 'medrxiv',
      publishedDoi: JOURNAL_DOI,
      publishedJournal: 'Psychological Medicine',
      publishedDate: '2026-06-17',
      preprintDate: '2026-01-08',
    });
    // A complete crosswalk record needs no qualification
    expect(structured(result).notice).toBeUndefined();
    const rendered = text(result);
    expect(rendered).toContain('**Journal:** Psychological Medicine');
    expect(rendered).toContain('**Published Date:** 2026-06-17');
    expect(rendered).toContain(`**Published DOI:** ${JOURNAL_DOI}`);
    expect(paths()).toContain(`/pubs/medrxiv/${JOURNAL_DOI}/json`);
  });

  it('resolves a journal DOI with a second slash through the double-encoded crosswalk key (#46)', async () => {
    const multiSlash = '10.1093/genetics/iyag142';
    answer({
      [`/pubs/biorxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/pubs/medrxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/details/biorxiv/${NEW_DOI}/0/json`]: DETAILS_EMPTY,
      [`/details/medrxiv/${NEW_DOI}/0/json`]: details(multiSlash),
      // Live shape: the API decodes %252F to a slash and parses the whole DOI.
      '/pubs/medrxiv/10.1093/genetics%252Fiyag142/json': {
        messages: [{ status: 'ok' }],
        collection: [
          {
            preprint_doi: NEW_DOI,
            published_doi: multiSlash,
            published_journal: 'GENETICS',
            published_date: '2026-06-03',
          },
        ],
      },
    });
    const result = await run({ doi: NEW_DOI });

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      preprintDoi: NEW_DOI,
      server: 'medrxiv',
      publishedDoi: multiSlash,
      publishedJournal: 'GENETICS',
      publishedDate: '2026-06-03',
    });
    expect(structured(result).notice).toBeUndefined();
    const rendered = text(result);
    expect(rendered).toContain('**Journal:** GENETICS');
    expect(rendered).toContain('**Published Date:** 2026-06-03');
  });

  it('returns the /details journal DOI with journal and date absent when the crosswalk has no record either way (#46)', async () => {
    const multiSlash = '10.1093/genetics/iyag142';
    answer({
      [`/pubs/biorxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/pubs/medrxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/details/biorxiv/${NEW_DOI}/0/json`]: DETAILS_EMPTY,
      [`/details/medrxiv/${NEW_DOI}/0/json`]: details(multiSlash),
      '/pubs/medrxiv/10.1093/genetics%252Fiyag142/json': {
        messages: [{ status: 'Preprint for DOI 10.1093/genetics/iyag142 not found' }],
        collection: [],
      },
    });
    const result = await run({ doi: NEW_DOI });
    // The lookup answered empty — not the failed-lookup branch, which asks for a retry
    expect(paths()).toContain('/pubs/medrxiv/10.1093/genetics%252Fiyag142/json');

    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out).toMatchObject({
      preprintDoi: NEW_DOI,
      server: 'medrxiv',
      publishedDoi: multiSlash,
      preprintTitle: 'Real World Effectiveness of Antipsychotic Treatment on Functional Outcomes',
      preprintAuthors: 'Twumasi, R.; Gronemann, F. H.',
      preprintCategory: 'psychiatry and clinical psychology',
      // First posting, not the latest revision
      preprintDate: '2026-01-08',
      preprintAbstract: 'Abstract of revision 3.',
      preprintAuthorCorresponding: 'Ricardo Twumasi',
      preprintAuthorCorrespondingInstitution: "King's College London",
    });
    // Only /pubs supplies these — never fabricated from anything else
    expect(out).not.toHaveProperty('publishedJournal');
    expect(out).not.toHaveProperty('publishedDate');
    expect(out.notice).toMatch(/journal name and publication date/);
    expect(out.notice).toContain(multiSlash);
    expect(out.notice).toMatch(/holds no record/);
    expect(out.notice).not.toMatch(/failed/);
    const rendered = text(result);
    expect(rendered).toContain(`**Published DOI:** ${multiSlash}`);
    expect(rendered).not.toContain('**Journal:**');
    expect(rendered).toMatch(/journal name and publication date/);
  });

  it('still returns the journal DOI when the journal-DOI crosswalk lookup fails (#46)', async () => {
    answer({
      [`/pubs/biorxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/pubs/medrxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/details/biorxiv/${NEW_DOI}/0/json`]: DETAILS_EMPTY,
      [`/details/medrxiv/${NEW_DOI}/0/json`]: details(JOURNAL_DOI),
      [`/pubs/medrxiv/${JOURNAL_DOI}/json`]: 503,
    });
    const result = await run({ doi: NEW_DOI });

    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.publishedDoi).toBe(JOURNAL_DOI);
    expect(out).not.toHaveProperty('publishedJournal');
    expect(out.notice).toMatch(/retry/i);
  });

  it('raises doi_not_found when /details lists no journal version on the server holding the preprint (#46)', async () => {
    answer({
      [`/pubs/biorxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/pubs/medrxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/details/biorxiv/${NEW_DOI}/0/json`]: DETAILS_EMPTY,
      [`/details/medrxiv/${NEW_DOI}/0/json`]: details('NA'),
    });
    const result = await run({ doi: NEW_DOI });

    expect(result.isError).toBe(true);
    const error = structured(result).error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'doi_not_found', doi: NEW_DOI, servers: ['biorxiv', 'medrxiv'] },
    });
    expect(error?.message).toMatch(/no published journal version/i);
    expect(error?.message).toContain('medrxiv');
    const rendered = text(result);
    expect(rendered).toContain('Recovery:');
    expect(rendered).toContain('(reason doi_not_found)');
  });

  it('raises doi_not_found naming the missing preprint when no server holds the DOI', async () => {
    answer({
      [`/pubs/biorxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/pubs/medrxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/details/biorxiv/${NEW_DOI}/0/json`]: DETAILS_EMPTY,
      [`/details/medrxiv/${NEW_DOI}/0/json`]: DETAILS_EMPTY,
    });
    const result = await run({ doi: NEW_DOI });

    const error = structured(result).error;
    expect(error?.data.reason).toBe('doi_not_found');
    expect(error?.message).toMatch(/no preprint/i);
    // Points at finding the right DOI, not at waiting for a journal version
    const hint = (structured(result).error?.data.recovery as { hint: string } | undefined)?.hint;
    expect(hint).toContain('biorxiv_search_preprints');
    expect(hint).not.toMatch(/later/);
    expect(text(result)).toContain('biorxiv_search_preprints');
  });

  it('raises a retryable error, not doi_not_found, when /details never answered', async () => {
    answer({
      [`/pubs/medrxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/details/medrxiv/${NEW_DOI}/0/json`]: 503,
    });
    const result = await run({ doi: NEW_DOI, server: 'medrxiv' });

    const error = structured(result).error;
    expect(error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error?.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
  });

  it('leaves the 10.1101/ path on /pubs alone — no /details or reverse lookup (#46 regression guard)', async () => {
    answer({
      [`/pubs/biorxiv/${OLD_DOI}/json`]: {
        messages: [{ status: 'ok' }],
        collection: [
          {
            preprint_doi: OLD_DOI,
            published_doi: '10.1091/mbc.E25-09-0454',
            published_journal: 'Molecular Biology of the Cell',
            published_date: '2026-06-01',
          },
        ],
      },
      [`/pubs/medrxiv/${OLD_DOI}/json`]: {
        messages: [{ status: `no articles found for published version of ${OLD_DOI}` }],
        collection: [],
      },
    });
    const result = await run({ doi: OLD_DOI });

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      server: 'biorxiv',
      publishedJournal: 'Molecular Biology of the Cell',
    });
    expect(structured(result).notice).toBeUndefined();
    expect(paths().sort()).toEqual([
      `/pubs/biorxiv/${OLD_DOI}/json`,
      `/pubs/medrxiv/${OLD_DOI}/json`,
    ]);
  });

  it('resolves a pasted doi.org URL of a 10.64898/ DOI (#50)', async () => {
    answer({
      [`/pubs/medrxiv/${NEW_DOI}/json`]: PUBS_UNPARSED,
      [`/details/medrxiv/${NEW_DOI}/0/json`]: details(JOURNAL_DOI),
      [`/pubs/medrxiv/${JOURNAL_DOI}/json`]: PUBS_BY_JOURNAL,
    });
    const result = await run({ doi: `https://doi.org/${NEW_DOI}`, server: 'medrxiv' });
    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      preprintDoi: NEW_DOI,
      publishedJournal: 'Psychological Medicine',
    });
  });
});
