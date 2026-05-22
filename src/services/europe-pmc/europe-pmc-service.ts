/**
 * @fileoverview EuropePmcService — wraps the EuropePMC REST search endpoint
 * for preprint keyword search. Returns ranked DOI lists used by
 * biorxiv_search_preprints for bioRxiv/medRxiv enrichment. All requests
 * include a polite User-Agent and are retried with exponential backoff.
 * @module services/europe-pmc/europe-pmc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';

function asRc(ctx: Context): RequestContext {
  return ctx as unknown as RequestContext;
}

import { getServerConfig } from '@/config/server-config.js';
import type { EuropePmcResult, RawEuropePmcSearchResponse } from './types.js';

const SERVER_VERSION = '0.1.0';

function detectHtmlError(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

export interface SearchOptions {
  /** Optional date filter — format YYYY-MM-DD */
  dateFrom?: string | undefined;
  /** Optional date filter — format YYYY-MM-DD */
  dateTo?: string | undefined;
  /** Maximum number of results to return (capped at 100) */
  limit?: number | undefined;
  query: string;
  /** Server filter: 'biorxiv' | 'medrxiv' | 'both' */
  server?: string | undefined;
}

export class EuropePmcService {
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverCfg = getServerConfig();
    this.baseUrl = serverCfg.europePmcBaseUrl;
    this.userAgent = `biorxiv-mcp-server/${SERVER_VERSION} (mailto:${serverCfg.mailto})`;
  }

  /**
   * Search EuropePMC for preprints matching the query. Returns ranked results
   * with DOIs, used to drive bioRxiv API enrichment. Requests the minimal field
   * set (doi, title, authorString, firstPublicationDate, abstractText).
   */
  async search(options: SearchOptions, ctx: Context): Promise<EuropePmcResult[]> {
    const limit = Math.min(options.limit ?? 25, 100);

    // Build the query string for EuropePMC
    let q = options.query;

    // Add date filter if provided
    if (options.dateFrom || options.dateTo) {
      const from = options.dateFrom ?? '1900-01-01';
      const to = options.dateTo ?? '9999-12-31';
      q += ` AND FIRST_PDATE:[${from} TO ${to}]`;
    }

    // Scope to preprints; optionally scope to specific source
    if (options.server === 'biorxiv' || options.server === 'medrxiv') {
      q += ' AND SRC:PPR AND PUBLISHER:"Cold Spring Harbor Laboratory"';
    }
    // For 'both' or unspecified, use the preprint filter broadly
    const filterParam = 'source:PPR';

    const fields = 'doi,title,authorString,firstPublicationDate,abstractText';
    const params = new URLSearchParams({
      query: q,
      resulttype: 'lite',
      synonym: 'FALSE',
      cursorMark: '*',
      pageSize: String(limit),
      format: 'json',
      fields,
    });

    const url = `${this.baseUrl}/search?${params.toString()}&filter=${filterParam}`;

    const rc = asRc(ctx);
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 20_000, rc, {
          signal: ctx.signal,
          headers: { 'User-Agent': this.userAgent },
        });
        const text = await response.text();
        if (detectHtmlError(text)) {
          throw serviceUnavailable(
            'EuropePMC returned HTML instead of JSON — service may be degraded.',
            { url },
          );
        }
        const data = JSON.parse(text) as RawEuropePmcSearchResponse;
        const rawResults = data.resultList?.result ?? [];
        const results: EuropePmcResult[] = [];
        for (const raw of rawResults) {
          if (!raw.doi) continue;
          const r: EuropePmcResult = { doi: raw.doi };
          if (raw.title) r.title = raw.title;
          if (raw.authorString) r.authors = raw.authorString;
          if (raw.firstPublicationDate) r.publishedDate = raw.firstPublicationDate;
          if (raw.abstractText) r.abstract = raw.abstractText;
          results.push(r);
        }
        return results;
      },
      {
        operation: 'EuropePmcService.search',
        context: rc,
        baseDelayMs: 300,
        signal: ctx.signal,
      },
    );
  }
}

// ─── Init / accessor ─────────────────────────────────────────────────────────

let _service: EuropePmcService | undefined;

export function initEuropePmcService(config: AppConfig, storage: StorageService): void {
  _service = new EuropePmcService(config, storage);
}

export function getEuropePmcService(): EuropePmcService {
  if (!_service)
    throw new Error('EuropePmcService not initialized — call initEuropePmcService() in setup()');
  return _service;
}
