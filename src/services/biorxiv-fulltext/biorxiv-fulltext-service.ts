/**
 * @fileoverview BiorxivFullTextService — fetches a preprint's rendered full-text
 * HTML page from the bioRxiv/medRxiv website (`www.{server}.org/content/{doi}v{N}.full`)
 * and extracts readable Markdown via the framework HTML extractor. The page is
 * reshaped first (`prepareArticlePage`) so the extractor keeps inline citation
 * labels, reference text, and every article block, renders each figure and
 * reference number once, sets each display formula in a block of its own, and
 * the tables the page carries no cells for are returned by name with the URL
 * that serves them.
 *
 * This is a DISTINCT fetch path from BiorxivApiService: it EXPECTS an HTML
 * document (the rendered article page), so it never routes through the JSON
 * API's "HTML response = upstream error" guard. Cloudflare challenge/block pages,
 * origin rate limiting (HTTP 429), and empty extractions are surfaced as a typed
 * `unavailable` result rather than crashing or feeding interstitial garbage to
 * the extractor.
 *
 * Extracted articles are cached in `ctx.state` under
 * `fulltext/v5/{server}/{doi}/{version}` for {@link FULLTEXT_CACHE_TTL_SECONDS}
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
import { fetchWithTimeout, htmlExtractor } from '@cyanheads/mcp-ts-core/utils';
import { parseHTML } from 'linkedom';
import { getServerConfig } from '@/config/server-config.js';
import type { BiorxivServer } from '@/services/biorxiv/types.js';
import {
  type CallDeadline,
  parseRetryAfterSeconds,
  retryWithinBudget,
  SERVER_VERSION,
} from '@/services/shared.js';

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
 * Cache key: `fulltext/v5/{server}/{doi}/{version}`. Slash-delimited because the
 * storage layer validates keys against `[a-zA-Z0-9_.\-/]` — a colon separator is
 * rejected outright, and a DOI's own `/` and `.` are already inside the allowed
 * set. The `v5` segment is the cached-value generation — bump it when
 * {@link CachedArticle} or the Markdown it holds changes shape, so entries
 * written by an older build are never read back. (`v2` dropped the extractor's
 * `wordCount`; `v3` added `omittedTables` and keeps citation labels and
 * reference text; `v4` renders each figure once, numbers each reference once,
 * and sets each display formula in a block of its own; `v5` keeps a short
 * section whose heading holds a navigation word, sets a list nested in a
 * reference entry inline, and drops a duplicate one whose names the entry
 * already gives.)
 */
const cacheKeyFor = (server: BiorxivServer, doi: string, version: string): string =>
  `fulltext/v5/${server}/${doi}/${version}`;

/**
 * The block elements Defuddle's low-score removal scores (`BLOCK_ELEMENTS` in
 * its constants, which the package does not export).
 */
const SCORED_BLOCK_SELECTOR = 'div, section, article, main, aside, header, footer, nav, content';

/**
 * A reference label that is one integer: `12.`, `(12).`, or `[12].`. Anchored at
 * both ends, so a label carrying anything else (`12a.`, `1–2.`) is not a number.
 */
const NUMERIC_REF_LABEL = /^[([]?(\d+)[)\]]?\.?$/;

/** An element of a page parsed by linkedom. */
type PageElement = NonNullable<
  ReturnType<ReturnType<typeof parseHTML>['document']['querySelector']>
>;

/**
 * The elements under `root` matching `selector` that no other match contains.
 * Every pass of {@link prepareArticlePage} that queries a match's own subtree
 * runs over these: a match nested inside another is reached through that one's
 * subtree and handled as part of it. Outermost matches have disjoint subtrees,
 * so each pass stays linear in the page's size.
 */
function outermost(root: PageElement, selector: string): PageElement[] {
  const nested = new Set<PageElement>();
  return [...root.querySelectorAll(selector)].filter((el) => {
    if (nested.has(el)) return false;
    for (const inner of el.querySelectorAll(selector)) nested.add(inner);
    return true;
  });
}

/**
 * The URL an image shows. The page lazy-loads: `src` holds a `data:`
 * placeholder and `data-src` the image, so `data-src` wins, and a `src` that is
 * a `data:` URL counts as no source.
 */
function imageSource(image: PageElement | null): string | undefined {
  const src = image?.getAttribute('data-src') ?? image?.getAttribute('src');
  return src && !src.startsWith('data:') ? src : undefined;
}

/** `text` with each run of whitespace collapsed to one space, trimmed. */
const collapseSpace = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim();

/**
 * `name` without the separators that run on to the next name of a list:
 * `A. Rich, and` → `A. Rich`. Expects collapsed whitespace.
 */
function withoutTrailingSeparators(name: string): string {
  let end = name.length;
  while (end > 0) {
    if (' ,;&'.includes(name.charAt(end - 1))) end--;
    else if (name.endsWith(' and', end)) end -= 4;
    else break;
  }
  return name.slice(0, end);
}

/**
 * The text of `root` with the subtrees of `excluded` (elements under it) left
 * out, whitespace collapsed. Each excluded element stands aside for an empty
 * comment while the text is read, then returns to its place.
 */
function textOutside(root: PageElement, excluded: PageElement[]): string {
  const swaps = excluded.map((el) => {
    const holder = root.ownerDocument.createComment('');
    el.replaceWith(holder);
    return [el, holder] as const;
  });
  const text = collapseSpace(root.textContent);
  for (const [el, holder] of swaps) holder.replaceWith(el);
  return text;
}

/** A letter or digit: a name that has one beside it is part of a longer word. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The first place at or after `from` where `text` holds `name` as whole words:
 * a match that a letter or digit runs on from, before or after, is part of a
 * longer name (`N. David` in `N. Davidson`) and is skipped. -1 when there is none.
 */
function indexOfWhole(text: string, name: string, from: number): number {
  const startsWord = WORD_CHAR.test(name.charAt(0));
  const endsWord = WORD_CHAR.test(name.charAt(name.length - 1));
  let at = text.indexOf(name, from);
  while (
    at >= 0 &&
    ((startsWord && WORD_CHAR.test(text.charAt(at - 1))) ||
      (endsWord && WORD_CHAR.test(text.charAt(at + name.length))))
  ) {
    at = text.indexOf(name, at + 1);
  }
  return at;
}

/**
 * Whether `text` names every item of `list`, in list order, and the list holds
 * nothing but its items. An item's name is its text with whitespace collapsed
 * and trailing separators trimmed, found as whole words. Each search starts
 * where the last match ended, so the check stays linear in the size of `text`
 * however many items the list holds.
 */
function namesEveryItem(list: PageElement, text: string): boolean {
  let from = 0;
  for (const node of list.childNodes) {
    if (node.nodeType === node.TEXT_NODE) {
      if (collapseSpace(node.textContent)) return false;
      continue;
    }
    if (node.nodeType !== node.ELEMENT_NODE) continue;
    if ((node as PageElement).localName !== 'li') return false;
    const name = withoutTrailingSeparators(collapseSpace(node.textContent));
    const at = indexOfWhole(text, name, from);
    if (at < 0) return false;
    from = at + name.length;
  }
  return true;
}

/**
 * Rewrites the article container so the extractor keeps what its cleanup rules
 * strip from Highwire pages, and lists the tables the page carries no cells for.
 * Defuddle removes every `a[href^="#"]` whose class contains `ref` — every
 * `a.xref-bibr` / `a.xref-fig` / `a.xref-table` label — leaving `()` behind; its
 * footnote pass renumbers numeric citations (`[^1]–[^3]` for `1–16`); and its
 * `metadata` partial selector removes each reference's `div.cit-metadata`. The
 * framework extractor exposes none of those switches, and turning them off
 * globally would re-admit the page chrome they exist to strip, so the page is
 * reshaped here instead:
 *
 * - each cross-reference anchor becomes its own label text;
 * - each inline formula (`span.inline-formula`) becomes a bare `<img>` with an
 *   empty alt where the span stood, inside its sentence (the image source is
 *   read as for figures, and a formula with none is left as the page has it).
 *   The page gives the formula image the alt `Embedded Image`, which Defuddle
 *   reads as a caption: it lifts the image out of the sentence into a captioned
 *   figure, so the alt becomes a paragraph of its own and the sentence's tail
 *   starts a new one;
 * - each display formula (`span.disp-formula`) becomes a bare `<img>` with an
 *   empty alt in a paragraph of its own, and a paragraph that held formulas is
 *   split around them, dropping the runs that hold only whitespace (the image
 *   source is read as for figures, and a formula with none is left as the page
 *   has it). The page sets the formula image inside the paragraph with the alt
 *   `Embedded Image`, which Defuddle reads as a caption: it makes the image a
 *   captioned figure, whose start tag closes the open paragraph, so the text
 *   after the formula loses its block and the next formula in the paragraph is
 *   glued onto it. The page prints no formula label for an alt, and Defuddle
 *   collapses adjacent images that share a non-empty alt, so consecutive
 *   equations keep an empty one;
 * - each figure (`div.fig`) loses its "Download figure" / "Open in new tab"
 *   links, and each of its images becomes a bare `<img>` in its own paragraph,
 *   alt-texted with the figure's printed label (`Figure 2`, `Fig. S16 (1 of 2)`
 *   when the figure holds several). The source is the lazy-loaded `data-src`, or
 *   a `src` that is not a `data:` placeholder; an image with neither is left to
 *   the extractor as the page has it. The page's image link carries the caption
 *   in its `title`, and the image the caption again in its `alt`: Defuddle
 *   emits the alt as the image text, then again as a paragraph, and its
 *   empty-link cleanup leaves the title's text after its first `)` spliced onto
 *   the preceding block, or glues the image onto that block when the title has
 *   none. The `div.fig-caption` below stays the figure's one caption. Distinct
 *   alts keep Defuddle from collapsing a figure's images into one, and the
 *   paragraph keeps the image off the `Figure N.` line;
 * - each list nested in a reference entry (an edited volume's editors as an
 *   `<ol>`), and every list within it, gives way to its items' content, inline
 *   where the list stood and in page order, with a space before each list and
 *   after each item. Defuddle renders a nested list as numbered items inside
 *   the entry, or, within 500 characters of either end of the article text,
 *   deletes it as a blog metadata list. A nested list marked `duplicate`
 *   (Highwire's copy of editors the citation already names) is dropped instead
 *   when it holds nothing but list items and the rest of the entry, read
 *   without its nested lists, names every item as whole words, in list
 *   order — the item's text with whitespace collapsed and its trailing
 *   separators (`, and`) trimmed;
 * - in a reference list (`ol.cit-list`) whose printed labels are consecutive
 *   integers, the labels give way to the list's own numbering, starting at the
 *   first label (a Methods list can start at 53); any other list keeps its
 *   labels and is rendered unordered, so no entry carries two numbers;
 * - in the reference list, the `↵` backlinks go, every `.cit-extra` link-out but
 *   the DOI one goes (the OpenURL ones are an unexpanded `{openurl}` template,
 *   the PubMed ones often a truncated `access_num`), the DOI one becomes a
 *   `doi.org` link labelled with the DOI, and every `class` and `id` is dropped
 *   so no selector matches the entries;
 * - every `div.table` loses its callout links ("View popup", "Download
 *   powerpoint"). One without a `<table>` holds only a caption and a link to the
 *   origin's expansion page, where the cells live: the caption stays in place,
 *   and the table is returned with that page's URL, under its printed label, or
 *   its `id` when it prints none. The cells are never fetched: each would cost
 *   a request to an origin that rate-limits after a handful;
 * - every block element left in the container that Defuddle's low-score removal
 *   scores ({@link SCORED_BLOCK_SELECTOR}, outside a table or a `pre`) gets
 *   `role="article"`, which that removal reads as content before any other
 *   test. Without it, a block under 200 words with a heading holding one of its
 *   navigation words (`related`, `responses`, `share`, `terms`, … as a
 *   substring) stops counting as content, and goes when its whole-word
 *   indicators outweigh its commas: a section headed `Effect of suppressing the
 *   vaccination-related input` was dropped whole. Defuddle also reads the role
 *   when choosing the content root, which never runs here (the content selector
 *   matches this container), and when flattening wrappers, which keeps a
 *   marked block as a block. Blocks inside a table or a `pre` stay unmarked:
 *   the scorer skips table cells and `pre`, and a marked block anywhere in a
 *   table, its caption included, would reach a table the extractor writes as
 *   HTML as a `<div>` instead of a `<p>`. The role never reaches the Markdown.
 *
 * Each pass that queries a match's subtree runs over the outermost matches only
 * ({@link outermost}), so the reshaping runs in linear time.
 * A page without the container is returned unchanged. An `href` that does not
 * parse as a URL counts as no link: the page is upstream markup, and one bad
 * link must not cost the caller the whole article.
 */
function prepareArticlePage(
  html: string,
  sourceUrl: string,
): { html: string; omittedTables: OmittedTable[] } {
  const { document } = parseHTML(html);
  const view = document.querySelector(FULLTEXT_CONTENT_SELECTOR);
  if (!view) return { html, omittedTables: [] };

  for (const anchor of outermost(view, 'a[class^="xref-"]')) {
    anchor.replaceWith(document.createTextNode(anchor.textContent ?? ''));
  }

  for (const formula of outermost(view, 'span.inline-formula')) {
    const src = imageSource(formula.querySelector('img'));
    if (!src) continue;
    const image = document.createElement('img');
    image.setAttribute('src', src);
    image.setAttribute('alt', '');
    formula.replaceWith(image);
  }

  const formulaBlocks = new Set<PageElement>();
  const heldFormulas = new Set<PageElement>();
  for (const formula of outermost(view, 'span.disp-formula')) {
    const src = imageSource(formula.querySelector('img'));
    if (!src) continue;
    const image = document.createElement('img');
    image.setAttribute('src', src);
    image.setAttribute('alt', '');
    const block = document.createElement('p');
    block.append(image);
    formulaBlocks.add(block);
    const parent = formula.parentElement;
    if (parent?.localName === 'p') heldFormulas.add(parent);
    formula.replaceWith(block);
  }
  // One pass over each paragraph's children, so a paragraph of many formulas
  // is split in time linear in its length.
  for (const paragraph of heldFormulas) {
    const parts: PageElement[] = [];
    let run = document.createElement('p');
    // A run holding only the whitespace around a formula is dropped, not left an empty paragraph.
    const endRun = () => {
      if (run.children.length > 0 || run.textContent?.trim()) parts.push(run);
      run = document.createElement('p');
    };
    for (const node of [...paragraph.childNodes]) {
      if (formulaBlocks.has(node)) {
        endRun();
        parts.push(node);
      } else {
        run.append(node);
      }
    }
    endRun();
    paragraph.replaceWith(...parts);
  }

  for (const figure of outermost(view, 'div.fig')) {
    for (const links of figure.querySelectorAll('ul.highwire-figure-links')) links.remove();
    const label =
      figure.querySelector('.fig-label')?.textContent?.trim().replace(/[.:]$/, '') ?? '';
    const holders = outermost(figure, '.fig-inline-img');
    for (const [index, holder] of holders.entries()) {
      const src = imageSource(holder.querySelector('img'));
      if (!src) continue;
      const image = document.createElement('img');
      image.setAttribute('src', src);
      image.setAttribute(
        'alt',
        holders.length > 1 ? `${label} (${index + 1} of ${holders.length})`.trim() : label,
      );
      const block = document.createElement('p');
      block.append(image);
      holder.replaceChildren(block);
    }
  }

  for (const refList of outermost(view, 'div.ref-list')) {
    for (const list of outermost(refList, 'ol.cit-list')) {
      for (const entry of list.children) {
        const nestedLists = outermost(entry, 'ol, ul');
        const isDuplicate = (nested: PageElement) => nested.classList.contains('duplicate');
        // Read without any nested list, so a name only another nested list
        // repeats does not count: dropping the list must lose no text.
        const rest = nestedLists.some(isDuplicate) ? textOutside(entry, nestedLists) : '';
        for (const nested of nestedLists) {
          if (isDuplicate(nested) && namesEveryItem(nested, rest)) {
            nested.remove();
            continue;
          }
          // Document order: each element is unwrapped once, moving only its own children.
          for (const el of [nested, ...nested.querySelectorAll('ol, ul, li')]) {
            if (el.localName === 'li') el.append(' ');
            else el.before(' ');
            el.replaceWith(...el.childNodes);
          }
        }
      }
    }
    for (const list of refList.querySelectorAll('ol.cit-list')) {
      const labels = [...list.children].map((item) =>
        [...item.children].find((child) => child.matches('span.ref-label')),
      );
      const numbers = labels.map((label) =>
        Number(NUMERIC_REF_LABEL.exec(label?.textContent?.trim() ?? '')?.[1] ?? Number.NaN),
      );
      const first = numbers[0];
      if (first !== undefined && numbers.every((n, i) => n === first + i)) {
        list.setAttribute('start', String(first));
        for (const label of labels) label?.remove();
      } else {
        const unordered = document.createElement('ul');
        unordered.append(...list.childNodes);
        list.replaceWith(unordered);
      }
    }
    for (const backlink of refList.querySelectorAll('a.rev-xref-ref')) backlink.remove();
    for (const extra of outermost(refList, '.cit-extra')) {
      for (const link of extra.querySelectorAll('a')) {
        const doi = link.classList.contains('cit-ref-sprinkles-doi')
          ? URL.parse(link.getAttribute('href') ?? '', sourceUrl)?.searchParams.get('access_num')
          : null;
        if (!doi) {
          link.remove();
          continue;
        }
        link.setAttribute('href', `https://doi.org/${doi}`);
        link.textContent = doi;
      }
    }
    for (const el of refList.querySelectorAll('[class], [id]')) {
      el.removeAttribute('class');
      el.removeAttribute('id');
    }
  }

  const omittedTables: OmittedTable[] = [];
  for (const table of outermost(view, 'div.table')) {
    const href = table.querySelector('a.table-expand-popup')?.getAttribute('href');
    for (const callout of table.querySelectorAll('.table-callout-links')) callout.remove();
    const url = href ? URL.parse(href, sourceUrl) : null;
    if (!url || table.querySelector('table')) continue;
    const label =
      table.querySelector('.table-label')?.textContent?.trim().replace(/[.:]$/, '') ||
      table.getAttribute('id') ||
      'Unlabelled table';
    omittedTables.push({ label, url: url.href });
  }

  const unmarked = new Set<PageElement>();
  for (const holder of outermost(view, 'table, pre')) {
    for (const block of holder.querySelectorAll(SCORED_BLOCK_SELECTOR)) unmarked.add(block);
  }
  for (const block of view.querySelectorAll(SCORED_BLOCK_SELECTOR)) {
    if (!unmarked.has(block)) block.setAttribute('role', 'article');
  }

  return { html: document.toString(), omittedTables };
}

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
 * A table the article page names but carries no cells for. Highwire serves a
 * table's cells from a separate expansion page; `url` is that page.
 */
export interface OmittedTable {
  /** The table's label as the page prints it, without trailing punctuation (`Table 1`). */
  label: string;
  /** Absolute URL of the origin page that serves this table's cells. */
  url: string;
}

/**
 * Discriminated result of a full-text fetch. `article` carries the extracted
 * Markdown plus best-effort metadata; `unavailable` records why no readable full
 * text was produced so the tool can raise a typed error and route the agent to
 * metadata instead of returning an empty or garbage body.
 *
 * No word count: the extractor's figure is taken from its intermediate HTML, not
 * from `markdown`, so every measure of the article is derived from `markdown`
 * where it is paged.
 */
export type FullTextFetchResult =
  | {
      kind: 'article';
      markdown: string;
      title?: string;
      sourceUrl: string;
      /** Tables the page names without cells, in page order; absent when none. */
      omittedTables?: OmittedTable[];
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
   * (PDF-only preprints). Transient failures (5xx, timeout, network) bubble
   * unchanged after retry — `ServiceUnavailable`, or a `Timeout` once `deadline`
   * runs out — for the caller to classify.
   *
   * A successful extraction is served from the tenant-scoped `ctx.state` cache on
   * subsequent calls for the same server/DOI/version, so offset paging does not
   * refetch the origin per chunk.
   */
  async fetchFullText(
    server: BiorxivServer,
    doi: string,
    version: string,
    deadline: CallDeadline,
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
      html = await retryWithinBudget(
        async ({ signal, remainingMs }) => {
          const response = await fetchWithTimeout(sourceUrl, Math.min(30_000, remainingMs), ctx, {
            signal,
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
          deadline,
        },
      );
    } catch (err) {
      // fetchWithTimeout throws on non-2xx with data.status set. Deterministic
      // access failures (403 block, 404 missing) and origin rate limiting (429)
      // become an `unavailable` result; transient failures (5xx / timeout /
      // network / deadline expiry) bubble unchanged. A 429 the budget ran out
      // after arrives in place of the expiry, and is still the origin's answer.
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

    const page = prepareArticlePage(html, sourceUrl);
    const extracted = await htmlExtractor.extract(page.html, {
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
      sourceUrl,
      ...(page.omittedTables.length > 0 && { omittedTables: page.omittedTables }),
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
