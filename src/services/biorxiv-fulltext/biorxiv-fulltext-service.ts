/**
 * @fileoverview BiorxivFullTextService — fetches a preprint's rendered full-text
 * HTML page from the bioRxiv/medRxiv website (`www.{server}.org/content/{doi}v{N}.full`)
 * and extracts readable Markdown via the framework HTML extractor.
 *
 * This is a DISTINCT fetch path from BiorxivApiService: it EXPECTS an HTML
 * document (the rendered article page), so it never routes through the JSON
 * API's "HTML response = upstream error" guard. Cloudflare challenge/block pages,
 * origin rate limiting (HTTP 429), and empty extractions are surfaced as a typed
 * `unavailable` result rather than crashing or feeding interstitial garbage to
 * the extractor.
 *
 * Extracted articles are cached in `ctx.state` under
 * `fulltext/v1/{server}/{doi}/{version}` for {@link FULLTEXT_CACHE_TTL_SECONDS}
 * seconds, so paging a long article with offset/limit costs one origin fetch and
 * one extraction instead of one per chunk. `ctx.state` is tenant-scoped, which is
 * the intended blast radius — no cross-tenant or process-wide sharing. Only
 * `kind: 'article'` results are written: a blocked, rate-limited, or empty page
 * must be able to recover on a later call. The cache is an optimization and never
 * a dependency — a storage backend that refuses a read or a write degrades to an
 * origin fetch instead of failing the caller.
 * @module services/biorxiv-fulltext/biorxiv-fulltext-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, htmlExtractor, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { BiorxivServer } from '@/services/biorxiv/types.js';
import { parseRetryAfterSeconds, SERVER_VERSION } from '@/services/shared.js';

/**
 * bioRxiv/medRxiv render their article pages on the Highwire platform, whose
 * main full-text container is `<div class="article fulltext-view">`. Defuddle's
 * auto-detection latches onto the reference apparatus on these pages and misses
 * the body; pointing it at this selector captures the full article text. When
 * the selector matches nothing, Defuddle falls back to auto-detection, so it is
 * always safe to pass.
 */
const FULLTEXT_CONTENT_SELECTOR = '.fulltext-view';

/**
 * HTTP statuses for which a re-fetch will never succeed — the full-text page is
 * blocked, missing, or legally unavailable at this origin. Classified as a
 * deterministic `unavailable` result (routing the agent to metadata) rather than
 * bubbling as a transient error the framework would advertise as retryable. 403
 * is what medRxiv's Cloudflare edge returns for programmatic access.
 */
const DETERMINISTIC_UNAVAILABLE_STATUSES = new Set([401, 403, 404, 410, 451]);

/**
 * Statuses this service classifies itself rather than treating as a bug — the
 * deterministic set plus 429, which becomes a `rate_limited` result. Passing them
 * to `fetchWithTimeout` only lowers the log severity from `error` to `debug`; the
 * thrown error and its classification are unchanged.
 */
const EXPECTED_STATUSES = [...DETERMINISTIC_UNAVAILABLE_STATUSES, 429];

/**
 * Lifetime of a cached extraction. A published version's rendered page is
 * effectively immutable (a revision gets a new version, hence a new cache key),
 * so this only bounds how long a re-render or a corrected page goes unseen. An
 * hour comfortably covers paging through even the longest article.
 */
const FULLTEXT_CACHE_TTL_SECONDS = 3_600;

/**
 * Cache key: `fulltext/v1/{server}/{doi}/{version}`. Slash-delimited because the
 * storage layer validates keys against `[a-zA-Z0-9_.\-/]` — a colon separator is
 * rejected outright, and a DOI's own `/` and `.` are already inside the allowed
 * set. The `v1` segment is the cached-value schema generation — bump it when
 * {@link CachedArticle} changes so entries written by an older build are never
 * read back under the new shape.
 */
const cacheKeyFor = (server: BiorxivServer, doi: string, version: string): string =>
  `fulltext/v1/${server}/${doi}/${version}`;

/**
 * Reads a cached extraction, treating any storage failure as a miss. A key the
 * backend rejects, an unreachable provider, or an in-memory store at capacity
 * must cost an origin fetch, not the caller's request.
 */
async function readCachedArticle(ctx: Context, key: string): Promise<CachedArticle | undefined> {
  try {
    return (await ctx.state.get<CachedArticle>(key)) ?? undefined;
  } catch (err) {
    ctx.log.warning('Full-text cache read failed — falling through to the origin', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
}

/** Writes an extraction to the cache; a storage failure only costs the next page a refetch. */
async function writeCachedArticle(
  ctx: Context,
  key: string,
  article: CachedArticle,
): Promise<void> {
  try {
    await ctx.state.set(key, article, { ttl: FULLTEXT_CACHE_TTL_SECONDS });
  } catch (err) {
    ctx.log.warning('Full-text cache write failed — the next page will refetch the origin', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Markers unique to Cloudflare's interstitial / block pages. Deliberately narrow:
 * a genuine bioRxiv article page references `cloudflare-static/email-decode.min.js`
 * and reCAPTCHA form scripts, so a bare "cloudflare"/"captcha" match would
 * false-positive. These strings appear only on the challenge/block pages.
 */
const CHALLENGE_MARKERS = [
  'Attention Required! | Cloudflare',
  'cf-error-details',
  'cf-browser-verification',
  'cf-challenge-running',
  '_cf_chl_opt',
  'Checking your browser before accessing',
  'Just a moment...',
];

function isChallengePage(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

/**
 * Discriminated result of a full-text fetch. `article` carries the extracted
 * Markdown plus best-effort metadata; `unavailable` records why no readable full
 * text was produced so the tool can raise a typed error and route the agent to
 * metadata instead of returning an empty or garbage body.
 */
export type FullTextFetchResult =
  | {
      kind: 'article';
      markdown: string;
      title?: string;
      wordCount?: number;
      sourceUrl: string;
    }
  | {
      kind: 'unavailable';
      reason: 'blocked' | 'empty' | 'rate_limited';
      detail: string;
      /**
       * Wait in whole seconds parsed from the origin's `Retry-After`, on
       * `rate_limited` results that carried a usable one. Seconds rather than the
       * raw header because the header's two RFC 9110 forms are not interchangeable
       * in prose — an HTTP-date read as seconds renders nonsense.
       */
      retryAfter?: number;
      sourceUrl: string;
    };

/** The article payload as written to (and read back from) the `ctx.state` cache. */
type CachedArticle = Omit<Extract<FullTextFetchResult, { kind: 'article' }>, 'kind'>;

export class BiorxivFullTextService {
  private readonly webBaseUrls: Record<BiorxivServer, string>;
  private readonly userAgent: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverCfg = getServerConfig();
    this.webBaseUrls = {
      biorxiv: serverCfg.biorxivWebBaseUrl,
      medrxiv: serverCfg.medrxivWebBaseUrl,
    };
    this.userAgent = serverCfg.mailto
      ? `biorxiv-mcp-server/${SERVER_VERSION} (mailto:${serverCfg.mailto})`
      : `biorxiv-mcp-server/${SERVER_VERSION}`;
  }

  /**
   * Fetch and extract the full-text Markdown for a specific preprint version.
   *
   * Resolves to `{ kind: 'article', markdown, ... }` on success, or
   * `{ kind: 'unavailable', reason }` when the page is blocked (Cloudflare 403 /
   * challenge), rate-limited (429), missing, or yields no extractable text
   * (PDF-only preprints). Transient failures (5xx, timeout, network) bubble as
   * `ServiceUnavailable` after retry so the framework classifies them as retryable.
   *
   * A successful extraction is served from the tenant-scoped `ctx.state` cache on
   * subsequent calls for the same server/DOI/version, so offset paging does not
   * refetch the origin per chunk.
   */
  async fetchFullText(
    server: BiorxivServer,
    doi: string,
    version: string,
    ctx: Context,
  ): Promise<FullTextFetchResult> {
    const encodedDoi = doi.split('/').map(encodeURIComponent).join('/');
    const sourceUrl = `${this.webBaseUrls[server]}/content/${encodedDoi}v${version}.full`;

    // ctx.state is tenant-scoped and throws without a tenant (HTTP + JWT whose
    // token carries no `tid` claim), so a tenant-less caller runs uncached rather
    // than losing full-text retrieval entirely.
    const cacheKey = ctx.tenantId === undefined ? undefined : cacheKeyFor(server, doi, version);
    if (cacheKey) {
      const cached = await readCachedArticle(ctx, cacheKey);
      if (cached) {
        ctx.log.debug('Serving full text from cache', { cacheKey, sourceUrl });
        return { kind: 'article', ...cached };
      }
    }

    let html: string;
    try {
      html = await withRetry(
        async () => {
          const response = await fetchWithTimeout(sourceUrl, 30_000, ctx, {
            signal: ctx.signal,
            headers: { 'User-Agent': this.userAgent, Accept: 'text/html' },
            expectedStatuses: EXPECTED_STATUSES,
          });
          return await response.text();
        },
        {
          operation: 'BiorxivFullTextService.fetchFullText',
          context: ctx,
          baseDelayMs: 500,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      // fetchWithTimeout throws on non-2xx with data.status set. Deterministic
      // access failures (403 block, 404 missing) and origin rate limiting (429)
      // become an `unavailable` result; transient codes (5xx / timeout / network)
      // bubble unchanged as ServiceUnavailable.
      const errData =
        err instanceof McpError
          ? (err.data as { retryAfter?: unknown; status?: unknown } | undefined)
          : undefined;
      const status = typeof errData?.status === 'number' ? errData.status : undefined;
      if (status === 429) {
        // Only the parsed Retry-After crosses into the result — err.data also
        // carries the origin's block-page HTML (body/responseBody), which must
        // never reach the client payload.
        const retryAfter = parseRetryAfterSeconds(errData?.retryAfter);
        ctx.log.info('Full-text origin rate-limited the request', {
          sourceUrl,
          status,
          ...(retryAfter !== undefined && { retryAfter }),
        });
        return {
          kind: 'unavailable',
          reason: 'rate_limited',
          detail:
            retryAfter === undefined
              ? 'The full-text origin is rate-limiting this host (HTTP 429).'
              : `The full-text origin is rate-limiting this host (HTTP 429) and asked for a ${retryAfter}-second wait before the next request.`,
          ...(retryAfter !== undefined && { retryAfter }),
          sourceUrl,
        };
      }
      if (status !== undefined && DETERMINISTIC_UNAVAILABLE_STATUSES.has(status)) {
        ctx.log.info('Full-text HTML page unavailable', { sourceUrl, status });
        return {
          kind: 'unavailable',
          reason: 'blocked',
          detail: `The full-text HTML page is not accessible (HTTP ${status}). The origin may restrict programmatic access, or this version has no rendered HTML page.`,
          sourceUrl,
        };
      }
      throw err;
    }

    // Defense in depth: a challenge/interstitial served with a 2xx status would
    // otherwise be handed to the extractor as if it were the article body.
    if (isChallengePage(html)) {
      ctx.log.warning('Full-text page returned a bot-challenge/interstitial', { sourceUrl });
      return {
        kind: 'unavailable',
        reason: 'blocked',
        detail:
          'The full-text page returned a bot-challenge/interstitial instead of the article. The origin is blocking programmatic access from this host.',
        sourceUrl,
      };
    }

    const extracted = await htmlExtractor.extract(html, {
      url: sourceUrl,
      format: 'markdown',
      contentSelector: FULLTEXT_CONTENT_SELECTOR,
    });
    const markdown = extracted.content.trim();
    if (!markdown) {
      return {
        kind: 'unavailable',
        reason: 'empty',
        detail:
          'The full-text page contained no extractable article text — the preprint may be PDF-only, or the page carries figures without body text.',
        sourceUrl,
      };
    }

    const article: CachedArticle = {
      markdown,
      ...(extracted.title && { title: extracted.title }),
      ...(typeof extracted.wordCount === 'number' && { wordCount: extracted.wordCount }),
      sourceUrl,
    };
    // Success path only — an unavailable result must recover on a later call.
    if (cacheKey) {
      await writeCachedArticle(ctx, cacheKey, article);
    }

    return { kind: 'article', ...article };
  }
}

// ─── Init / accessor ─────────────────────────────────────────────────────────

let _service: BiorxivFullTextService | undefined;

export function initBiorxivFullTextService(config: AppConfig, storage: StorageService): void {
  _service = new BiorxivFullTextService(config, storage);
}

export function getBiorxivFullTextService(): BiorxivFullTextService {
  if (!_service)
    throw new Error(
      'BiorxivFullTextService not initialized — call initBiorxivFullTextService() in setup()',
    );
  return _service;
}
