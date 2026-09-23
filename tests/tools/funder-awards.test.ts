/**
 * @fileoverview Funder metadata on the record tools, end to end. api.biorxiv.org
 * misattributes each funder entry's `name` and ROR `id` to an unrelated
 * organization while keeping the `award`, so records carry `awards` and never
 * the funder name. The real `BiorxivApiService` and `EuropePmcService`,
 * `fetchWithTimeout`, `withRetry`, tool handlers, `format()`, and output
 * validation all run; only `globalThis.fetch` is faked, with the live upstream
 * funder shape. `biorxiv_list_recent` is covered in its funder test file.
 * @module tests/tools/funder-awards.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biorxivGetPreprintTool } from '@/mcp-server/tools/definitions/biorxiv-get-preprint.tool.js';
import { biorxivSearchPreprintsTool } from '@/mcp-server/tools/definitions/biorxiv-search-preprints.tool.js';
import { initBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import { initEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.biorxiv.org',
    europePmcBaseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
  }),
}));

const DOI = '10.1101/2025.06.23.661133';
const UNFUNDED_DOI = '10.1101/2025.06.24.000002';

/** The live funder array on both revisions of 10.1101/2025.06.23.661133. */
const LIVE_FUNDER = [
  {
    name: 'Sint Lucas Andreas Hospital',
    id: 'https://ror.org/016jc2h42',
    'id-type': 'ROR',
    award: 'R35GM134936R01CA260414K99GM155323',
  },
];

function revision(doi: string, version: string, funder: unknown) {
  return {
    doi,
    title: 'Kinetochore assembly in human cells',
    authors: 'Doe, J.',
    date: '2025-06-24',
    version,
    category: 'cell biology',
    server: 'bioRxiv',
    published: 'NA',
    funder,
  };
}

const DETAILS: Record<string, unknown[]> = {
  [DOI]: [revision(DOI, '1', LIVE_FUNDER), revision(DOI, '2', LIVE_FUNDER)],
  [UNFUNDED_DOI]: [revision(UNFUNDED_DOI, '1', 'NA')],
};

const http = createFetchMock();

function routeUpstreams(): void {
  http.route({
    match: (request) => new URL(request.url).hostname === 'api.biorxiv.org',
    respond: (request) => {
      const path = new URL(request.url).pathname;
      const doi = Object.keys(DETAILS).find((d) => path.includes(d));
      return Response.json({ messages: [{ status: 'ok' }], collection: doi ? DETAILS[doi] : [] });
    },
  });
  http.route({
    match: (request) => new URL(request.url).hostname === 'www.ebi.ac.uk',
    respond: () =>
      Response.json({
        version: '6.9',
        hitCount: 3,
        resultList: {
          result: [
            { doi: DOI, title: 'Kinetochore assembly in human cells', authorString: 'Doe J' },
            { doi: UNFUNDED_DOI, title: 'Unfunded record', authorString: 'Roe R' },
            // Not held by api.biorxiv.org, so this record falls back to EuropePMC metadata.
            { doi: '10.1101/2025.06.25.999999', title: 'Fallback record', authorString: 'Poe P' },
          ],
        },
      }),
  });
}

async function run<T extends Parameters<typeof runToolContract>[0]>(
  definition: T,
  input: Record<string, unknown>,
) {
  const pending = runToolContract(definition, input as never, {
    context: { errors: definition.errors },
  });
  await vi.runAllTimersAsync();
  const result = await pending;
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return { result, text, json: JSON.stringify(result.structuredContent) };
}

describe('funder metadata on record tools — awards only', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    http.reset();
    http.install();
    routeUpstreams();
    initBiorxivApiService({} as AppConfig, {} as StorageService);
    initEuropePmcService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it('biorxiv_get_preprint: every revision carries the award, neither surface the funder name', async () => {
    const { result, text, json } = await run(biorxivGetPreprintTool, {
      dois: [DOI],
      server: 'biorxiv',
    });

    expect(result.isError).toBeFalsy();
    const { revisions } = (
      result.structuredContent as { preprints: { revisions: Record<string, unknown>[] }[] }
    ).preprints[0] ?? { revisions: [] };
    expect(revisions).toHaveLength(2);
    for (const rev of revisions) {
      expect(rev.awards).toEqual(['R35GM134936R01CA260414K99GM155323']);
      expect(rev).not.toHaveProperty('funder');
    }
    expect(text.match(/^\*\*Awards:\*\* R35GM134936R01CA260414K99GM155323$/gm)).toHaveLength(2);
    for (const surface of [text, json]) {
      expect(surface).not.toContain('Sint Lucas');
      expect(surface).not.toContain('016jc2h42');
      expect(surface).not.toContain('Funder');
    }
  });

  it('biorxiv_get_preprint: a record with funder "NA" has no awards field and no Awards line', async () => {
    const { result, text } = await run(biorxivGetPreprintTool, {
      dois: [UNFUNDED_DOI],
      server: 'biorxiv',
    });

    const rev = (result.structuredContent as { preprints: { revisions: object[] }[] }).preprints[0]
      ?.revisions[0];
    expect(rev).not.toHaveProperty('awards');
    expect(text).not.toContain('**Awards:**');
  });

  it('biorxiv_search_preprints: enriched records carry awards; fallback and unfunded records do not', async () => {
    const { result, text, json } = await run(biorxivSearchPreprintsTool, {
      query: 'kinetochore',
      server: 'biorxiv',
    });

    expect(result.isError).toBeFalsy();
    const preprints = (result.structuredContent as { preprints: Record<string, unknown>[] })
      .preprints;
    expect(preprints.map((p) => [p.doi, p.enriched, p.awards])).toEqual([
      [DOI, true, ['R35GM134936R01CA260414K99GM155323']],
      [UNFUNDED_DOI, true, undefined],
      ['10.1101/2025.06.25.999999', false, undefined],
    ]);
    for (const p of preprints) expect(p).not.toHaveProperty('funder');
    expect(text.match(/\*\*Awards:\*\*/g)).toHaveLength(1);
    expect(text).toContain('**Awards:** R35GM134936R01CA260414K99GM155323\n');
    for (const surface of [text, json]) {
      expect(surface).not.toContain('Sint Lucas');
      expect(surface).not.toContain('Funder');
    }
  });
});
