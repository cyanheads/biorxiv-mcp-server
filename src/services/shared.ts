/**
 * @fileoverview Shared utilities for biorxiv-mcp-server service layer. Provides
 * HTML error detection, DOI and ROR ID input normalization, calendar-date and
 * upstream-text normalization, the Markdown escaper every `format()` applies
 * to upstream text, `Retry-After` parsing and rate-limit rejection lookup
 * shared by every fetch path, and the server version string used in User-Agent
 * headers across all services.
 * @module services/shared
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import packageJson from '../../package.json' with { type: 'json' };
import {
  BRACE_PLACEHOLDERS,
  BRACKET_PLACEHOLDERS,
  GENE_SYMBOL_HEADINGS,
  SECTION_HEADINGS,
} from './upstream-text-tables.js';

/** Detect HTML error pages returned instead of JSON by upstream APIs. */
export function detectHtmlError(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/**
 * Validate that a `YYYY-MM-DD` string names a real calendar date. The shape
 * regex callers gate on first still accepts day-of-month overflow inside a
 * nominally valid month (`2024-02-30`, `2024-04-31`, `2023-02-29`), which
 * `new Date(...)` silently rolls forward into the following month rather than
 * rejecting. Construct a UTC date from the parsed numeric components and
 * round-trip each field back to catch that overflow; genuine leap days
 * (`2024-02-29`) round-trip cleanly and are accepted. A string that fails the
 * shape match returns `false` rather than throwing, so it is safe to call
 * without a prior regex gate.
 */
export function isValidCalendarDate(dateStr: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** A preprint DOI reduced to its bare form, plus the revision a version suffix named. */
export interface NormalizedDoi {
  /** Bare DOI, e.g. `10.64898/2026.03.11.711201`. */
  doi: string;
  /** Revision named by a trailing `vN` (`"2"` for `…711201v2`); absent when none was given. */
  version?: string;
}

/** A doi.org resolver or bioRxiv/medRxiv article URL in front of the DOI, scheme optional. */
const DOI_URL_PREFIX =
  /^(?:https?:\/\/)?(?:(?:dx\.)?doi\.org\/|(?:www\.)?(?:bio|med)rxiv\.org\/content\/)/i;

/** The `doi:` scheme label, as in citations. */
const DOI_SCHEME_PREFIX = /^doi:\s*/i;

/**
 * An article-page suffix after the DOI's final digit: an optional `vN` revision,
 * then any article-tab suffix (`.full`, `.full.pdf`, `.full.pdf+html`,
 * `.full-text`, `.article-metrics`, `.supplementary-material`, …), then an
 * optional trailing slash, matched case-insensitively. Anchored after a digit,
 * and each tab suffix starts with a letter, so neither a `v` inside a
 * non-numeric identifier nor a `.`-separated digit group is ever stripped —
 * bioRxiv and medRxiv identifiers are digits and dots, ending in a digit.
 */
const ARTICLE_SUFFIX = /(?<=\d)(?:v(\d+))?(?:\.[a-z][\w+-]*)*\/?$/i;

/** `10.` + a registrant code of four or more digits + `/` + a non-empty suffix. */
const BARE_DOI = /^10\.\d{4,}\/\S+$/;

/**
 * Reduce a pasted preprint reference to its bare DOI. Accepts the bare DOI
 * itself, a `https://doi.org/` or `http(s)://dx.doi.org/` resolver URL, a
 * `doi:` label, or a `{www.}{biorxiv,medrxiv}.org/content/` article URL — any
 * of them with a trailing `vN` revision and an article-tab suffix (`.full`,
 * `.full.pdf`, `.article-metrics`, …).
 * A URL's query string and fragment are dropped. Returns the revision the
 * suffix named alongside the DOI, and `undefined` when what is left is not a
 * DOI — callers raise their `invalid_doi_format` on that.
 *
 * A bare DOI passes through unchanged: stripping only ever removes text around
 * a bioRxiv/medRxiv identifier, never characters of one.
 */
export function normalizeDoi(input: string): NormalizedDoi | undefined {
  let text = input.trim();
  const url = DOI_URL_PREFIX.exec(text);
  text = url
    ? text.slice(url[0].length).replace(/[?#].*$/, '')
    : text.replace(DOI_SCHEME_PREFIX, '');
  const suffix = ARTICLE_SUFFIX.exec(text);
  const version = suffix?.[1];
  if (suffix) text = text.slice(0, suffix.index);
  if (!BARE_DOI.test(text)) return;
  return version === undefined ? { doi: text } : { doi: text, version: String(Number(version)) };
}

/** A `ror.org` URL in front of the ID, scheme and `www.` optional. */
const ROR_URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?ror\.org\//i;

/** `0`, six Crockford base32 characters (no i, l, o, u), and two checksum digits. */
const ROR_ID = /^0([0-9a-hjkmnp-tv-z]{6})(\d{2})$/;

const CROCKFORD_BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Reduce a ROR ID to the bare 9-character form — the only one the bioRxiv
 * listing endpoint's `funder` filter accepts. Accepts the bare ID or a
 * `https://ror.org/` URL, in any case, with a trailing slash. Returns
 * `undefined` unless what is left matches the ROR pattern and its ISO 7064
 * Mod 97-10 checksum (the last two digits, over the base32 value of the six
 * characters before them), so a mistyped ID is caught before any call.
 */
export function normalizeRorId(input: string): string | undefined {
  const id = input.trim().replace(ROR_URL_PREFIX, '').replace(/\/$/, '').toLowerCase();
  const match = ROR_ID.exec(id);
  if (!match) return;
  let value = 0;
  for (const char of match[1] as string) value = value * 32 + CROCKFORD_BASE32.indexOf(char);
  const checksum = 98 - ((value * 100) % 97);
  return checksum === Number(match[2]) ? id : undefined;
}

/** Longest heading first, so `Methods and Results` wins over `Methods`. */
const HEADINGS_LONGEST_FIRST = [...SECTION_HEADINGS].sort((a, b) => b.length - a.length);

/**
 * Give a paragraph-initial section heading its separator: `ResultsInsulin …`
 * → `Results: Insulin …`, and a heading alone on its line → `Results:`. Only a
 * heading from the closed list that opens the paragraph with an uppercase
 * letter is considered, and it is split only where the body follows with no
 * separator:
 *
 * - an uppercase letter or digit (`ResultsInsulin`, `Results50%`) — preferred,
 *   so `HighlightSbtA2` splits as `Highlight: SbtA2`, not `HighlightS: btA2`;
 * - failing that, a lowercase-led token with an uppercase letter or digit in
 *   it (`ResultssDII`, `ConclusionsmiRNA`), since a plain lowercase letter is
 *   more often the heading word continuing (`Aimed`, `Designs`).
 *
 * A heading already followed by a space or punctuation (`Results were`,
 * `RESULTS:`) is left alone. A mixed-case match ending in a capital has taken
 * the body's first letter (`AimS` of `AimSGLT2`, `ConclusionS` of
 * `ConclusionSARS-CoV-2`), so the shorter heading is tried instead, and a
 * heading that also opens gene symbols is never split before a digit (`AIM2`).
 */
function separateHeading(line: string): string {
  const start = line.length - line.trimStart().length;
  if (!/[A-Z]/.test(line.charAt(start))) return line;
  const lower = line.slice(start).toLowerCase();
  let lowercaseLed: string | undefined;
  for (const heading of HEADINGS_LONGEST_FIRST) {
    if (!lower.startsWith(heading)) continue;
    const end = start + heading.length;
    if (/[a-z].*[A-Z]$/.test(line.slice(start, end))) continue;
    const rest = line.slice(end);
    if (rest.trim() === '') return `${line.slice(0, end)}:`;
    if (/^\d/.test(rest) && GENE_SYMBOL_HEADINGS.has(heading)) continue;
    if (/^[A-Z0-9]/.test(rest)) return `${line.slice(0, end)}: ${rest}`;
    if (!/^[a-z]/.test(rest)) return line;
    if (lowercaseLed === undefined && /^[a-z]+[A-Z0-9]/.test(rest)) {
      lowercaseLed = `${line.slice(0, end)}: ${rest}`;
    }
  }
  return lowercaseLed ?? line;
}

/**
 * A `{name}` placeholder, skipped after `_`, `^`, a `\command`, or `{`, where
 * braces are LaTeX grouping (`F_{e}`, `\mathrm{F}`, `{{beta}}`) rather than a
 * Highwire symbol.
 */
const BRACE_PLACEHOLDER = /(?<![_^{]|\\[A-Za-z]+)\{([^{}]+)\}/g;

/** A `[name]` placeholder, or a `[xHHHH]` hex code point. */
const BRACKET_PLACEHOLDER = /\[([^[\]\s]+)\]/g;

/** A marked-up heading's text as ` Heading: `, or a blank when it held none. */
function headingLabel(_match: string, heading: string): string {
  const label = heading.trim().replace(/:$/, '');
  return label ? ` ${label}: ` : ' ';
}

function bracketGlyph(match: string, name: string): string {
  const codePoint = /^x([0-9A-Fa-f]{4,5})$/.exec(name)?.[1];
  if (codePoint) return String.fromCodePoint(Number.parseInt(codePoint, 16));
  return BRACKET_PLACEHOLDERS[name] ?? match;
}

/**
 * Strip Highwire/JATS export artifacts that bioRxiv/medRxiv and EuropePMC leak
 * into raw title and abstract text, so no upstream markup reaches
 * `structuredContent` or the rendered `content[]`. Handles:
 *
 * - whole blocks removed with everything inside: figures (`O_FIG … C_FIG`),
 *   display figures (`O_FIG_DISPLAY_L … C_FIG_DISPLAY`), and tables
 *   (`O_TBL … C_TBL`, caption included) — image refs, `SRC=` paths,
 *   `org.highwire.dtl.*` object references, "Graphical Abstract" boilerplate;
 * - the small-caps "Abstract" heading sentinel (`A<O_SCPLOW>BSTRACT<C_SCPLOW>`),
 *   which upstream fuses directly onto the first sentence with no separator;
 * - markers dropped with the text inside them kept: small caps, text boxes
 *   (`O_TEXTBOX`), and display formulas (`O_FD`, `O_INLINEFIG`);
 * - section headings rendered as `Heading: ` — from `O_ST_ABS … C_ST_ABS`
 *   markers, EuropePMC's `<h4>` headings, and a closed heading list at the
 *   start of a paragraph where upstream fused the heading onto the body
 *   (never before the digit of a gene symbol such as `AIM2`, and never taking
 *   the body's first capital into the heading). Paragraphs are read before
 *   whitespace collapses, since the line break is the only boundary left, and
 *   single-line text (a title) is never split;
 * - list items (`O_LI … C_LI`) rendered as `• ` items;
 * - Highwire symbol placeholders (`{beta}`, `{+/-}`, `[&ge;]`, `[~]`,
 *   `[x1D05]`, …) mapped to their characters through closed tables
 *   (`upstream-text-tables.ts`). An unknown name, LaTeX braces, and
 *   single-letter brackets stay verbatim;
 * - inline HTML formatting tags (`<i>`, `<b>`, `<sub>`, `<sup>`, `<u>`, …).
 *
 * The result is plain text, never Markdown: `format()` escapes it at
 * interpolation (`escapeMarkdown`), so anything emitted here as syntax would
 * render as literal characters. A `*` upstream (`A*T to G*C`, where EuropePMC
 * has `A•T`) is left alone — it may be a lost bullet, but nothing says so.
 *
 * Applied at the service boundary rather than in a tool's `format()` because
 * `structuredContent` is the handler's raw return value and bypasses `format()`;
 * normalizing here cleans both client surfaces from a single site. Returns
 * `undefined` for absent or now-empty input so callers keep treating missing
 * fields as absent rather than as empty strings.
 */
export function normalizeUpstreamText(text: string | undefined): string | undefined {
  if (!text) return;
  let cleaned = text
    // Whole blocks — display figures before plain ones, whose lazy match would
    // otherwise stop at the C_FIG inside C_FIG_DISPLAY and strand `_DISPLAY`.
    .replace(/O_FIG_DISPLAY[\s\S]*?C_FIG_DISPLAY/g, ' ')
    .replace(/O_FIG[\s\S]*?C_FIG/g, ' ')
    .replace(/O_TBL[\s\S]*?C_TBL/g, ' ')
    // Encoded "Abstract" heading, fused to the body with no separating space.
    .replace(/AO_SCPLOWBSTRACTC_SCPLOW/g, ' ')
    // Residual small-caps markers around inline text — drop markers, keep content.
    .replace(/[OC]_SCP(?:LOW|CAP)/g, '')
    // Leaked Java object references, e.g. org.highwire.dtl.DTLVardef@130b9ee.
    .replace(/org\.highwire\.dtl\.\S+/g, ' ')
    // Any unpaired figure sentinel that survived block removal.
    .replace(/[OCM]_FIG\b/g, ' ')
    // Residual figure image-source fragments.
    .replace(/\bSRC=\S*/gi, ' ')
    .replace(/Graphical Abstract/gi, ' ')
    // Text boxes and display formulas — drop the markers, keep the text.
    .replace(/[OMC]_(?:TEXTBOX|FD|INLINEFIG)/g, ' ')
    // Structured-abstract headings, then any unpaired or empty marker left over;
    // EuropePMC marks the same headings up as <h4>.
    .replace(/O_ST_ABS([\s\S]*?)C_ST_ABS/g, headingLabel)
    .replace(/[OC]_ST_ABS/g, ' ')
    .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, headingLabel);
  if (cleaned.includes('\n')) cleaned = cleaned.split(/\r?\n/).map(separateHeading).join('\n');
  cleaned = cleaned
    // List items. O_LINKSMALLFIG is a figure marker, not a list item.
    .replace(/O_LI(?!NKSMALLFIG)/g, ' • ')
    .replace(/C_LI/g, ' ')
    .replace(BRACE_PLACEHOLDER, (match, name: string) => BRACE_PLACEHOLDERS[name] ?? match)
    .replace(BRACKET_PLACEHOLDER, bracketGlyph)
    // Inline HTML formatting tags leaked from JATS (enumerated to avoid eating
    // legitimate inequalities like "x<y" that aren't real tags).
    .replace(/<\/?(?:i|b|u|em|strong|sub|sup|small|br|p|span|div|a|h[1-6])\b[^>]*>/gi, '')
    // Collapse whitespace opened up by the removals above.
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || undefined;
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/** Blank or the edge of the text — a delimiter here cannot be flanked on that side. */
function isSpaceOrEdge(char: string): boolean {
  return char === '' || /\s/.test(char);
}

/**
 * Whether one inline metacharacter at `index` can change how CommonMark or GFM
 * (markdown-it, marked) render `text`. `\`, `` ` ``, and `*` always can (`*`
 * flanks emphasis intraword). The rest only in a position that can open syntax:
 *
 * - `_` — not between two letters or digits, where it can never flank emphasis
 *   (`cc_by`, `snake_case` stay raw; `_word_` and `F_{e}` do not);
 * - `~` — not with blank space on both sides; marked strikes through a pair of
 *   single tildes (`(~10 lux) … (~1500 lux)`);
 * - `<` — before a letter, `/`, `!`, or `?` with a `>` later, the only shape of
 *   raw HTML or an autolink (`<COMP id>`, `IL-1<beta>`; `p<0.05` and `x<y` stay);
 * - `[` — before a later `](` or `][`, which an inline or reference link needs,
 *   or opening a line that a `]:` definition could follow.
 */
function changesRendering(char: string, text: string, index: number): boolean {
  const prev = text.charAt(index - 1);
  const next = text.charAt(index + 1);
  switch (char) {
    case '_':
      return !(ALPHANUMERIC.test(prev) && ALPHANUMERIC.test(next));
    case '~':
      return !(isSpaceOrEdge(prev) && isSpaceOrEdge(next));
    case '<':
      return /[A-Za-z/!?]/.test(next) && text.includes('>', index + 1);
    case '[': {
      const rest = text.slice(index + 1);
      if (rest.includes('](') || rest.includes('][')) return true;
      const lineStart = /(?:^|\n)[ \t]{0,3}$/.test(text.slice(0, index));
      return lineStart && /^[^\n]*\]:/.test(rest);
    }
    default:
      return true;
  }
}

/**
 * Escape upstream text for interpolation into `format()` Markdown so it renders
 * literally, inserting a backslash only where a character would otherwise
 * change rendering: the inline metacharacters ``\ * _ ` ~ [ <`` in a position
 * that can open syntax (see `changesRendering`), plus a line-initial `>`, a
 * line-initial `#` run that opens a heading (a space, tab, or line end follows
 * it — `#441914366` does not), or a list marker (`-`, `+`, `1.`, `1)`) — an
 * abstract is interpolated at the start of a line in some tools, and a joined
 * field (`awards`) starts with its first value. Agents read `content[]` as
 * text and copy spans out of it, so an escape that changes nothing
 * (`p\<0.05`, `cc\_by`) is noise.
 * An apostrophe, a mid-line `#`, or a signed `-0.42` already renders as itself.
 *
 * Apply to each upstream field value where it is interpolated, never to the
 * assembled text (the formatter's own `**Label:**` markup must survive), and
 * never to `structuredContent`, identifiers an agent copies back into a call
 * (DOIs, `jatsxmlUrl`, `sourceUrl`), or extractor-produced Markdown such as the
 * `biorxiv_get_fulltext` `content`. Local because `@cyanheads/mcp-ts-core`
 * exports an HTML escaper only.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_~[<]/g, (char: string, index: number) =>
      changesRendering(char, text, index) ? `\\${char}` : char,
    )
    .replace(/^([ \t]{0,3})(>|#{1,6}(?=[ \t]|$))/gm, '$1\\$2')
    .replace(/^([ \t]{0,3})([-+])(?=[ \t]|$)/gm, '$1\\$2')
    .replace(/^([ \t]{0,3}\d{1,9})([.)])(?=[ \t]|$)/gm, '$1\\$2');
}

/**
 * Reads a `Retry-After` header value as a wait in whole seconds. RFC 9110 §10.2.3
 * allows either delta-seconds or an HTTP-date; the date form is converted to a
 * wait from now and clamped at zero. Returns undefined for an absent, malformed,
 * or unparseable value so callers fall back to generic wording rather than
 * echoing an uninterpretable header into agent-facing prose.
 *
 * Shared by every fetch path — the JSON API, the full-text article origin, and
 * EuropePMC each surface the same header and must read it identically.
 */
export function parseRetryAfterSeconds(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return;
  return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
}

/**
 * Finds an origin rate limit among a set of rejections, recognising the
 * `reason: 'rate_limited'` marker this server's services attach when they
 * classify an HTTP 429. Returns the wait the caller should honor — the longest
 * of the reported ones, since a shorter wait would still land inside whichever
 * origin asked for the longer one — or an empty object when a rate limit fired
 * without a usable `Retry-After`. Returns undefined when no rejection was a
 * rate limit, so callers fall through to their generic upstream-failure
 * contract entry.
 */
export function findRateLimit(errors: readonly unknown[]): { retryAfter?: number } | undefined {
  let found = false;
  let longest: number | undefined;
  for (const err of errors) {
    if (!(err instanceof McpError)) continue;
    const data = err.data as { reason?: unknown; retryAfter?: unknown } | undefined;
    if (data?.reason !== 'rate_limited') continue;
    found = true;
    if (
      typeof data.retryAfter === 'number' &&
      (longest === undefined || data.retryAfter > longest)
    ) {
      longest = data.retryAfter;
    }
  }
  if (!found) return;
  return longest === undefined ? {} : { retryAfter: longest };
}

/**
 * Renders a `Retry-After` wait as the phrase every rate-limit recovery hint
 * interpolates, so the wording an agent reads is identical whichever origin or
 * tool produced the limit — including the fallback for a 429 whose response
 * named no usable wait.
 */
export function describeWait(seconds: number | undefined): string {
  return seconds === undefined ? 'a minute or two' : `${seconds} seconds`;
}

/**
 * Version string used in outbound User-Agent headers. Derived from package.json
 * (the single source of truth) so it can never drift from the released version.
 * Resolves identically from `src/services/shared.ts` and the built
 * `dist/services/shared.js` — `../../package.json` is the repo root in both, and
 * the Docker production stage copies package.json alongside dist/.
 */
export const SERVER_VERSION: string = packageJson.version;
