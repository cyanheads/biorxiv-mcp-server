/**
 * @fileoverview BiorxivFullTextService — fetches a preprint's rendered full-text
 * HTML page from the bioRxiv/medRxiv website (`www.{server}.org/content/{doi}v{N}.full`)
 * and extracts readable Markdown via the framework HTML extractor.
 *
 * This is a DISTINCT fetch path from BiorxivApiService: it EXPECTS an HTML
 * document (the rendered article page), so it never routes through the JSON
 * API's "HTML response = upstream error" guard. Cloudflare challenge/block pages
 * and empty extractions are surfaced as a typed `unavailable` result rather than
 * crashing or feeding interstitial garbage to the extractor.
 * @module services/biorxiv-fulltext/biorxiv-fulltext-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, htmlExtractor, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { BiorxivServer } from '@/services/biorxiv/types.js';
import { asRc, SERVER_VERSION } from '@/services/shared.js';

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
      reason: 'blocked' | 'empty';
      detail: string;
      sourceUrl: string;
    };

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
   * challenge), missing, or yields no extractable text (PDF-only preprints).
   * Transient failures (5xx, timeout, network) bubble as `ServiceUnavailable`
   * after retry so the framework classifies them as retryable.
   */
  async fetchFullText(
    server: BiorxivServer,
    doi: string,
    version: string,
    ctx: Context,
  ): Promise<FullTextFetchResult> {
    const encodedDoi = doi.split('/').map(encodeURIComponent).join('/');
    const sourceUrl = `${this.webBaseUrls[server]}/content/${encodedDoi}v${version}.full`;
    const rc = asRc(ctx);

    let html: string;
    try {
      html = await withRetry(
        async () => {
          const response = await fetchWithTimeout(sourceUrl, 30_000, rc, {
            signal: ctx.signal,
            headers: { 'User-Agent': this.userAgent, Accept: 'text/html' },
          });
          return await response.text();
        },
        {
          operation: 'BiorxivFullTextService.fetchFullText',
          context: rc,
          baseDelayMs: 500,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      // fetchWithTimeout throws on non-2xx with data.statusCode set. Deterministic
      // access failures (403 block, 404 missing) become an `unavailable` result;
      // transient codes (5xx / timeout / network) bubble unchanged as ServiceUnavailable.
      const status =
        err instanceof McpError &&
        typeof (err.data as { statusCode?: unknown })?.statusCode === 'number'
          ? (err.data as { statusCode: number }).statusCode
          : undefined;
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

    return {
      kind: 'article',
      markdown,
      ...(extracted.title && { title: extracted.title }),
      ...(typeof extracted.wordCount === 'number' && { wordCount: extracted.wordCount }),
      sourceUrl,
    };
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
