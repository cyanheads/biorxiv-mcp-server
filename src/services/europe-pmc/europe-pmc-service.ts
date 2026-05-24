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
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { asRc, detectHtmlError, SERVER_VERSION } from '@/services/shared.js';
import type { EuropePmcResult, RawEuropePmcSearchResponse } from './types.js';

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
    this.userAgent = serverCfg.mailto
      ? `biorxiv-mcp-server/${SERVER_VERSION} (mailto:${serverCfg.mailto})`
      : `biorxiv-mcp-server/${SERVER_VERSION}`;
  }

  /**
   * Search EuropePMC for preprints matching the query. Returns ranked results
   * with DOIs, used to drive bioRxiv API enrichment. Requests the minimal field
   * set (doi, title, authorString, firstPublicationDate, abstractText).
   */
  async search(options: SearchOptions, ctx: Context): Promise<EuropePmcResult[]> {
    const limit = Math.min(options.limit ?? 25, 100);

    let q = options.query;

    if (options.dateFrom || options.dateTo) {
      const from = options.dateFrom ?? '1900-01-01';
      const to = options.dateTo ?? '9999-12-31';
      q += ` AND FIRST_PDATE:[${from} TO ${to}]`;
    }

    // Scope to preprints; narrow to the specific server publisher when requested.
    // 'both' requires an explicit OR constraint — source:PPR alone includes journals.
    if (options.server === 'biorxiv') {
      q += ' AND PUBLISHER:bioRxiv';
    } else if (options.server === 'medrxiv') {
      q += ' AND PUBLISHER:medRxiv';
    } else {
      q += ' AND (PUBLISHER:bioRxiv OR PUBLISHER:medRxiv)';
    }
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
        return (data.resultList?.result ?? [])
          .filter((raw): raw is typeof raw & { doi: string } => raw.doi != null)
          .map(
            (raw): EuropePmcResult => ({
              doi: raw.doi,
              ...(raw.title && { title: raw.title }),
              ...(raw.authorString && { authors: raw.authorString }),
              ...(raw.firstPublicationDate && { publishedDate: raw.firstPublicationDate }),
              ...(raw.abstractText && { abstract: raw.abstractText }),
            }),
          );
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
