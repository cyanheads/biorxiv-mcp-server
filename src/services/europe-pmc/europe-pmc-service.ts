/**
 * @fileoverview EuropePmcService — wraps the EuropePMC REST search endpoint
 * for preprint keyword search. Returns ranked DOI lists used by
 * biorxiv_search_preprints for bioRxiv/medRxiv enrichment, and looks up
 * abstracts for records that fall back to EuropePMC metadata: the ranked search
 * uses the `lite` result type, which never carries `abstractText`, so abstracts
 * come from one DOI-keyed `core` query instead. All requests
 * include a polite User-Agent and are retried with exponential backoff.
 * Detects HTML error pages, retries an HTTP 200 body that carries no result
 * list, and classifies an origin rate limit (HTTP 429) as its own retryable
 * `rate_limited` condition carrying the parsed `Retry-After` wait — never the
 * upstream response body.
 * @module services/europe-pmc/europe-pmc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  describeWait,
  detectHtmlError,
  normalizeUpstreamText,
  parseRetryAfterSeconds,
  SERVER_VERSION,
} from '@/services/shared.js';
import type {
  EuropePmcResult,
  EuropePmcSearchResult,
  RawEuropePmcSearchResponse,
} from './types.js';

/**
 * The one status this service classifies itself rather than treating as a bug.
 * Passing it to `fetchWithTimeout` only lowers the log severity from `error` to
 * `debug`; the thrown error and its classification are unchanged.
 */
const EXPECTED_STATUSES = [429];

/**
 * `data.reason` on the error thrown for an HTTP 200 body with no `resultList`.
 * EuropePMC answers some requests with only `{"version":"6.9"}` — intermittently
 * for a valid first page or cursor page, and on every attempt for a malformed
 * `cursorMark`. Read as data, the body becomes a zero-result page, so it is
 * thrown as a transient `ServiceUnavailable` inside `withRetry` instead.
 */
const EMPTY_BODY_REASON = 'empty_response_body';

/**
 * Re-throws a failed EuropePMC call with the two conditions this service
 * classifies itself:
 *
 * - an empty body that outlasted every retry — a caller error when a cursor
 *   page was requested (`invalid_cursor_mark`), an upstream failure on a first
 *   page, which has no caller input to blame;
 * - HTTP 429, as its own retryable `rate_limited` condition.
 *
 * Everything else — 5xx, timeout, network error, the HTML-error guard below —
 * re-throws untouched for the framework's auto-classifier.
 *
 * The empty-body errors are built fresh rather than re-thrown: `withRetry`
 * suffixes an exhausted error's message with `(failed after N attempts)`, and
 * that wording would otherwise reach the caller inside the tool's message. The
 * attempt count moves to `data.retryAttempts`.
 *
 * `fetchWithTimeout` attaches the upstream response body to `err.data`
 * (`body`/`responseBody`), so the replacement payload is built from scratch
 * rather than spread: only the parsed `Retry-After` crosses into it. Retry is
 * not this function's concern — `withRetry` already honors `data.retryAfter`
 * and fails fast when the requested wait exceeds its cap, so by the time a 429
 * reaches here the waiting is over and only classification is left.
 */
function rethrowClassified(err: unknown, cursorMark: string): never {
  const data =
    err instanceof McpError
      ? (err.data as
          | { reason?: unknown; retryAttempts?: unknown; status?: unknown; retryAfter?: unknown }
          | undefined)
      : undefined;

  if (data?.reason === EMPTY_BODY_REASON) {
    // Always set: the empty body is transient, so it only escapes `withRetry`
    // exhausted, and exhaustion is what attaches the count.
    const retryAttempts = data.retryAttempts as number;
    const tries = `${retryAttempts} consecutive attempts`;
    if (cursorMark !== '*') {
      throw validationError(
        `EuropePMC did not recognize the supplied cursor_mark — ${tries} came back with no result list.`,
        { reason: 'invalid_cursor_mark', cursor_mark: cursorMark, retryAttempts },
        { cause: err },
      );
    }
    throw serviceUnavailable(
      `EuropePMC answered ${tries} with HTTP 200 and no result list.`,
      { reason: EMPTY_BODY_REASON, retryAttempts },
      { cause: err },
    );
  }

  if (data?.status !== 429) throw err;

  const retryAfter = parseRetryAfterSeconds(data.retryAfter);
  const wait = describeWait(retryAfter);
  throw rateLimited(
    retryAfter === undefined
      ? 'EuropePMC is rate-limiting this host (HTTP 429).'
      : `EuropePMC is rate-limiting this host (HTTP 429) and asked for a ${retryAfter}-second wait before the next request.`,
    {
      reason: 'rate_limited',
      retryable: true,
      ...(retryAfter !== undefined && { retryAfter }),
      recovery: {
        hint: `Wait ${wait} before querying EuropePMC again — only keyword search reaches this origin, so preprint metadata lookups on api.biorxiv.org are outside this limit.`,
      },
    },
    { cause: err },
  );
}

export interface SearchOptions {
  /** Optional author filter — ANDed into the query as an `AUTH:"…"` clause. */
  author?: string | undefined;
  /** Opaque EuropePMC cursor for the page to fetch. Defaults to '*' (first page). */
  cursorMark?: string | undefined;
  /** Optional date filter — format YYYY-MM-DD */
  dateFrom?: string | undefined;
  /** Optional date filter — format YYYY-MM-DD */
  dateTo?: string | undefined;
  /** Maximum number of results to return (capped at 100) */
  limit?: number | undefined;
  /** Free-text keyword query. Optional when `author` is supplied. */
  query?: string | undefined;
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
   * with DOIs plus the upstream hitCount grand total, used to drive bioRxiv API
   * enrichment. Uses the `lite` result type (doi, title, authorString,
   * firstPublicationDate), which carries no abstract — see `getAbstracts`.
   * Throws a retryable `rate_limited` error when the origin returns HTTP 429.
   * A body with no result list is retried; if every attempt returns one, throws
   * `ValidationError` (`invalid_cursor_mark`) when a cursor page other than `*`
   * was requested, and `ServiceUnavailable` (`empty_response_body`) otherwise.
   */
  async search(options: SearchOptions, ctx: Context): Promise<EuropePmcSearchResult> {
    const limit = Math.min(options.limit ?? 25, 100);

    // Base terms: the free-text keyword query and/or an AUTH: author clause.
    // At least one is guaranteed non-empty by the tool's input refinement.
    const terms: string[] = [];
    const keyword = options.query?.trim();
    if (keyword) terms.push(keyword);
    const author = options.author?.trim();
    if (author) {
      // Strip embedded double-quotes so a stray quote can't break the AUTH phrase.
      terms.push(`AUTH:"${author.replace(/"/g, '')}"`);
    }
    let q = terms.join(' AND ');

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

    // A blank cursor (a form client's empty field) is a first page, as it is
    // upstream. Tokens are base64, so surrounding whitespace is never part of one.
    const cursorMark = options.cursorMark?.trim() || '*';
    const params = new URLSearchParams({
      query: q,
      resulttype: 'lite',
      synonym: 'FALSE',
      cursorMark,
      pageSize: String(limit),
      format: 'json',
    });

    const url = `${this.baseUrl}/search?${params.toString()}&filter=${filterParam}`;

    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, 20_000, ctx, {
            signal: ctx.signal,
            headers: { 'User-Agent': this.userAgent },
            expectedStatuses: EXPECTED_STATUSES,
          });
          const text = await response.text();
          if (detectHtmlError(text)) {
            throw serviceUnavailable(
              'EuropePMC returned HTML instead of JSON — service may be degraded.',
              { url },
            );
          }
          const data = JSON.parse(text) as RawEuropePmcSearchResponse;
          // A genuine zero-hit answer still carries an empty `resultList`.
          if (!data.resultList) {
            throw serviceUnavailable('EuropePMC answered HTTP 200 with no result list.', {
              reason: EMPTY_BODY_REASON,
            });
          }
          const results = (data.resultList.result ?? [])
            .filter((raw): raw is typeof raw & { doi: string } => raw.doi != null)
            .map((raw): EuropePmcResult => {
              const title = normalizeUpstreamText(raw.title);
              return {
                doi: raw.doi,
                ...(title && { title }),
                ...(raw.authorString && { authors: raw.authorString }),
                ...(raw.firstPublicationDate && { publishedDate: raw.firstPublicationDate }),
              };
            });
          return {
            hitCount: data.hitCount ?? results.length,
            results,
            // Absent on the last page (EuropePMC omits it) — omit here too so
            // callers read "no field" as "no more pages".
            ...(data.nextCursorMark && { nextCursorMark: data.nextCursorMark }),
          };
        },
        {
          operation: 'EuropePmcService.search',
          context: ctx,
          baseDelayMs: 300,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      rethrowClassified(err, cursorMark);
    }
  }

  /**
   * Fetch the abstracts of preprints by DOI in one `resultType=core` query — the
   * only EuropePMC result type that carries `abstractText`. The query is keyed
   * by the given DOIs (`DOI:"…" OR …`, preprints only) and one page is sized to
   * hold them, so the response is bounded by the input. Returns normalized
   * abstracts keyed by lowercase DOI; a DOI EuropePMC holds no abstract for is
   * absent from the map. Throws on failure — classified like `search`, with an
   * HTTP 429 as a retryable `rate_limited` error carrying `Retry-After`.
   */
  async getAbstracts(dois: readonly string[], ctx: Context): Promise<Map<string, string>> {
    const unique = [...new Set(dois.map((doi) => doi.toLowerCase()))];
    // Quotes are stripped so a stray one cannot end the DOI phrase early.
    const clause = unique.map((doi) => `DOI:"${doi.replace(/"/g, '')}"`).join(' OR ');
    const params = new URLSearchParams({
      query: `(${clause}) AND SRC:PPR`,
      resultType: 'core',
      synonym: 'FALSE',
      pageSize: String(unique.length),
      format: 'json',
    });
    const url = `${this.baseUrl}/search?${params.toString()}`;

    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, 20_000, ctx, {
            signal: ctx.signal,
            headers: { 'User-Agent': this.userAgent },
            expectedStatuses: EXPECTED_STATUSES,
          });
          const text = await response.text();
          if (detectHtmlError(text)) {
            throw serviceUnavailable(
              'EuropePMC returned HTML instead of JSON — service may be degraded.',
              { url },
            );
          }
          const data = JSON.parse(text) as RawEuropePmcSearchResponse;
          if (!data.resultList) {
            throw serviceUnavailable('EuropePMC answered HTTP 200 with no result list.', {
              reason: EMPTY_BODY_REASON,
            });
          }
          const abstracts = new Map<string, string>();
          for (const raw of data.resultList.result ?? []) {
            const doi = raw.doi?.toLowerCase();
            const abstract = normalizeUpstreamText(raw.abstractText);
            if (doi && abstract && !abstracts.has(doi)) abstracts.set(doi, abstract);
          }
          return abstracts;
        },
        {
          operation: 'EuropePmcService.getAbstracts',
          context: ctx,
          baseDelayMs: 300,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      // No cursor: an empty body that outlasts the retries is an upstream failure.
      rethrowClassified(err, '*');
    }
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
