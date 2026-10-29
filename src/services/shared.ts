/**
 * @fileoverview Shared utilities for biorxiv-mcp-server service layer. Provides
 * HTML error detection, DOI and ROR ID input normalization, calendar-date and
 * upstream-text normalization, the Markdown escaper every `format()` applies
 * to upstream text, `Retry-After` parsing and rate-limit rejection lookup
 * shared by every fetch path, the per-tool-call time budget every upstream
 * request draws on (with the retry ladder that runs inside it, backs off on a
 * 429 whose `Retry-After` names no usable wait, and keeps an origin's 429 as
 * its answer when the budget runs out), the per-server DOI fan-out that settles
 * on the server holding the DOI, and the server version string used in
 * User-Agent headers across all services.
 * @module services/shared
 */

import { McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { type RetryAttempt, type RetryOptions, withRetry } from '@cyanheads/mcp-ts-core/utils';
import packageJson from '../../package.json' with { type: 'json' };
import {
  BRACE_PLACEHOLDERS,
  BRACKET_PLACEHOLDERS,
  GENE_SYMBOL_HEADINGS,
  SECTION_HEADINGS,
  TEX_N_COMMANDS,
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

/**
 * The DOI prefixes bioRxiv and medRxiv issue preprint DOIs under — both servers
 * share both, so a prefix never names the server. Cold Spring Harbor
 * Laboratory Press also registers its journal articles under `10.1101/`
 * (`10.1101/gr.…`, `gad.…`, `lm.…`), so a DOI here is a preprint DOI or one of
 * those; any other DOI is a journal article's.
 */
export const BIORXIV_DOI_PREFIXES = ['10.1101/', '10.64898/'] as const;

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

/**
 * The page-format tabs a journal DOI is pasted with (`.pdf`, `.full`,
 * `.full.pdf`, `.full-text`, …), compared lowercased. A journal DOI's own
 * trailing components — `.sa1`, `.g001`, `.t001`, Wiley's `.x` — are none of
 * these.
 */
const PAGE_FORMAT_TABS = new Set([
  'full',
  'pdf',
  'full-text',
  'pdf+html',
  'abstract',
  'article-info',
  'article-metrics',
  'supplementary-material',
]);

/** A `vN` revision ending a journal DOI, after a digit, matched case-insensitively. */
const JOURNAL_REVISION = /(?<=\d)v(\d+)$/i;

/** `10.` + a registrant code of four or more digits + `/` + a non-empty suffix. */
const BARE_DOI = /^10\.\d{4,}\/\S+$/;

/**
 * Reduce a pasted preprint or journal reference to its bare DOI. Accepts the bare DOI
 * itself, a `https://doi.org/` or `http(s)://dx.doi.org/` resolver URL, a
 * `doi:` label, or a `{www.}{biorxiv,medrxiv}.org/content/` article URL — any
 * of them with a trailing `vN` revision and an article-tab suffix (`.full`,
 * `.full.pdf`, `.article-metrics`, …).
 * A URL's query string and fragment are dropped. Returns the revision the
 * suffix named alongside the DOI, and `undefined` when what is left is not a
 * DOI — callers raise their `invalid_doi_format` on that.
 *
 * On a DOI under {@link BIORXIV_DOI_PREFIXES}, any article-tab suffix is
 * stripped, only ever as text around the bioRxiv/medRxiv identifier, never
 * characters of one. Any other DOI is a journal's, whose own trailing
 * components (`10.7554/eLife.55185.sa1`, `….pone.0123456.g001`, Wiley's `.x`)
 * name a different record than the DOI without them, so only the page-format
 * tabs (`.pdf`, `.full`, `.full.pdf`, `.full-text`, …) and a `vN` revision
 * after a digit are stripped from it, never one of its own components.
 */
export function normalizeDoi(input: string): NormalizedDoi | undefined {
  let text = input.trim();
  const url = DOI_URL_PREFIX.exec(text);
  text = url
    ? text.slice(url[0].length).replace(/[?#].*$/, '')
    : text.replace(DOI_SCHEME_PREFIX, '');
  let suffix: RegExpExecArray | null;
  if (BIORXIV_DOI_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    suffix = ARTICLE_SUFFIX.exec(text);
  } else {
    // Component by component from the end, so the pass stays linear in the input.
    const parts = text.replace(/\/$/, '').split('.');
    while (parts.length > 1 && PAGE_FORMAT_TABS.has(parts.at(-1)?.toLowerCase() ?? '')) {
      parts.pop();
    }
    text = parts.join('.');
    suffix = JOURNAL_REVISION.exec(text);
  }
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

/**
 * One character a `[xHHHH]` placeholder may stand for: a symbol outside ASCII.
 * ASCII, control, format, surrogate, private-use, and unassigned code points
 * are never Highwire symbols, and decoding one would let upstream text spell
 * out markup (`[x003C]iframe[x003E]`).
 */
const SYMBOL_CODE_POINT = /^[^\p{ASCII}\p{C}]$/u;

/**
 * An inline HTML formatting tag leaked from JATS, enumerated so a legitimate
 * inequality (`x<y`) is never taken for one. Skipped where an open `<` comes
 * before it with no `>` between them (`<scr<i>ipt>`, `<<i>iframe>`): removing
 * the tag there would join that `<` to the text after it and splice together a
 * tag the input never held.
 */
const INLINE_TAG =
  /(?<!<(?:[A-Za-z/!?][^<>]*)?)<\/?(?:i|b|u|em|strong|sub|sup|small|br|p|span|div|a|h[1-6])\b[^>]*>/gi;

/**
 * A backslash escape left in older bioRxiv text, never following another
 * backslash (`\\` is TeX's own line break): a literal backslash-`n` — two
 * characters, not a newline — standing for a line break, unless it opens a TeX
 * control word (`\nabla`, `\neq`), or a literal backslash-`"` standing for a
 * double quote. The lookarounds read a bounded number of characters, so one
 * pass is linear in the text.
 */
const LITERAL_ESCAPE = new RegExp(
  String.raw`(?<!\\)\\(?:"|(?!(?:${TEX_N_COMMANDS.join('|')})(?![A-Za-z]))n)`,
  'g',
);

/** What a {@link LITERAL_ESCAPE} match stands for. */
function unescapeLiteral(match: string): string {
  return match === '\\"' ? '"' : '\n';
}

/** A marked-up heading's text as ` Heading: `, or a blank when it held none. */
function headingLabel(_match: string, heading: string): string {
  const label = heading.trim().replace(/:$/, '');
  return label ? ` ${label}: ` : ' ';
}

function bracketGlyph(match: string, name: string): string {
  const codePoint = /^x([0-9A-Fa-f]{4,5})$/.exec(name)?.[1];
  if (codePoint) {
    const char = String.fromCodePoint(Number.parseInt(codePoint, 16));
    return SYMBOL_CODE_POINT.test(char) ? char : match;
  }
  return BRACKET_PLACEHOLDERS[name] ?? match;
}

/**
 * Strip `INLINE_TAG`s until none is left to strip. Its guard already keeps one
 * pass from forming a new tag; repeating to a fixed point makes that hold by
 * construction, and is the form static analysis checks sanitizers for.
 */
function stripInlineTags(text: string): string {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(INLINE_TAG, '');
  } while (current !== previous);
  return current;
}

/**
 * Strip Highwire/JATS export artifacts that bioRxiv/medRxiv and EuropePMC leak
 * into raw title and abstract text, so no upstream markup reaches
 * `structuredContent` or the rendered `content[]`. Handles:
 *
 * - the two backslash escapes bioRxiv abstracts posted before December 2019
 *   carry: a literal backslash-`n` (single, paired, or longer runs) read as a
 *   real line break, and a literal backslash-`"` read as `"` — first, so the
 *   heading and list handling below sees the breaks. Only in text with no real
 *   line break, the one form those abstracts use, and never where the
 *   backslash follows another backslash or a backslash-`n` opens a TeX
 *   control word (`\nabla`, `\neq`);
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
 *   (`upstream-text-tables.ts`), and `[xHHHH]` read as a code point when it
 *   is a non-ASCII symbol. An unknown name, any other code point, LaTeX
 *   braces, and single-letter brackets stay verbatim;
 * - inline HTML formatting tags (`<i>`, `<b>`, `<sub>`, `<sup>`, `<u>`, …),
 *   except where removing one would splice a new tag out of the text around it.
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
  const unescaped = text.includes('\n') ? text : text.replace(LITERAL_ESCAPE, unescapeLiteral);
  let cleaned = unescaped
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
    .replace(BRACKET_PLACEHOLDER, bracketGlyph);
  cleaned = stripInlineTags(cleaned)
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

/** The last index in a text of each closer a `changesRendering` check looks ahead for, -1 if absent. */
interface Closers {
  /** The last `>`, which raw HTML or an autolink opened by `<` needs. */
  readonly angle: number;
  /** The last `](` or `][`, which a link opened by `[` needs. */
  readonly link: number;
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
 *
 * "Later" is read from `closers`, found once per text, so each check is
 * constant time apart from the rest-of-line scan for `]:`, which only the one
 * `[` that can open a line reaches.
 */
function changesRendering(char: string, text: string, index: number, closers: Closers): boolean {
  const prev = text.charAt(index - 1);
  const next = text.charAt(index + 1);
  switch (char) {
    case '_':
      return !(ALPHANUMERIC.test(prev) && ALPHANUMERIC.test(next));
    case '~':
      return !(isSpaceOrEdge(prev) && isSpaceOrEdge(next));
    case '<':
      return /[A-Za-z/!?]/.test(next) && closers.angle > index;
    case '[': {
      if (closers.link > index) return true;
      /**
       * The four characters before `[` hold the longest line-start prefix (`\n`
       * and three blanks); four with no `\n` are too many blanks, so `^` matches
       * in the window only where the window begins the text.
       */
      const lineStart = /(?:^|\n)[ \t]{0,3}$/.test(text.slice(Math.max(0, index - 4), index));
      if (!lineStart) return false;
      const lineEnd = text.indexOf('\n', index + 1);
      return text.slice(index + 1, lineEnd === -1 ? text.length : lineEnd).includes(']:');
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
 * field (`awards`) starts with its first value. Last, the final `#` of a run
 * that a space or tab (or the value's start) precedes and only spaces or tabs
 * follow to the line end (`abc #` → `abc \#`, a seven-`#` value → `######\#`),
 * which an ATX heading would drop as its closing
 * sequence — every title is a heading in some tool. Agents read `content[]` as
 * text and copy spans out of it, so an escape that changes nothing
 * (`p\<0.05`, `cc\_by`) is noise.
 * An apostrophe, a mid-line `#`, or a signed `-0.42` already renders as itself.
 *
 * Apply to each upstream field value where it is interpolated, never to the
 * assembled text (the formatter's own `**Label:**` markup must survive), and
 * never to `structuredContent`, identifiers an agent copies back into a call
 * (DOIs, `jatsxmlUrl`, `sourceUrl`), or extractor-produced Markdown such as the
 * `biorxiv_get_fulltext` `content`. Kept local rather than the framework's
 * `escapeMarkdownInline` because that one escapes more by design — every `[`,
 * `]`, `|`, and `~`, entity-shaped `&` runs, edge whitespace — so it would add
 * backslashes to the abstracts and titles every tool renders where none
 * changes how they render. The closing-`#` rule is the one it shares.
 */
export function escapeMarkdown(text: string): string {
  /**
   * The closing-`#` step runs after the line-initial escapes, so a run they
   * already escaped (`\#`, `\##`) has a backslash, not a space, before it and
   * gains no second one. Its one-character lookbehind anchors each match at a
   * run's first `#`; a lookbehind spanning `[ \t]#*` would rescan the run from
   * every `#` in it, quadratic on a long run. The closers are found once here,
   * not per metacharacter, which keeps the pass linear.
   */
  const closers: Closers = {
    angle: text.lastIndexOf('>'),
    link: Math.max(text.lastIndexOf(']('), text.lastIndexOf('][')),
  };
  return text
    .replace(/[\\`*_~[<]/g, (char: string, index: number) =>
      changesRendering(char, text, index, closers) ? `\\${char}` : char,
    )
    .replace(/^([ \t]{0,3})(>|#{1,6}(?=[ \t]|$))/gm, '$1\\$2')
    .replace(/^([ \t]{0,3})([-+])(?=[ \t]|$)/gm, '$1\\$2')
    .replace(/^([ \t]{0,3}\d{1,9})([.)])(?=[ \t]|$)/gm, '$1\\$2')
    .replace(/(?<=^|[ \t])(#*)#(?=[ \t]*(?:[\r\n]|$))/g, '$1\\#');
}

/**
 * Reads a `Retry-After` header value as a wait in whole seconds. RFC 9110 §10.2.3
 * allows either delta-seconds or an HTTP-date; the date form is converted to a
 * wait from now. Returns undefined for an absent, malformed, or unparseable
 * value, and for a wait of zero or less (`0`, an HTTP-date already past): a
 * zero wait is no usable wait. Callers then fall back to generic wording
 * rather than telling an agent to wait 0 seconds and walk back into the
 * limiter, and `retryWithinBudget` keeps such a header from `withRetry`, which
 * would re-send at once.
 *
 * Shared by every fetch path — the JSON API, the full-text article origin, and
 * EuropePMC each surface the same header and must read it identically.
 */
export function parseRetryAfterSeconds(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return;
  const trimmed = raw.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const dateMs = Date.parse(trimmed);
    if (Number.isNaN(dateMs)) return;
    seconds = Math.round((dateMs - Date.now()) / 1000);
  }
  return seconds > 0 ? seconds : undefined;
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
  if (seconds === undefined) return 'a minute or two';
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/**
 * A not-found recovery hint for a lookup across `servers`. A call that checked
 * one server only is first sent to the other, since bioRxiv and medRxiv share
 * their DOI prefixes; a call that checked both gets `hint` alone.
 */
export function notFoundHint(servers: readonly string[], hint: string): string {
  return servers.length === 1
    ? `Retry with server="both" — this call checked only ${servers[0]}. ${hint}`
    : hint;
}

/**
 * Wall-clock budget for one tool call: every upstream request the call makes,
 * with each request's attempts, backoffs, and honored `Retry-After` waits. Kept
 * under the 60-second request timeout MCP SDK clients default to, so a hung
 * origin surfaces as this server's classified error — or as the degraded result
 * a tool already returns for an optional step — before the client gives up.
 */
export const CALL_BUDGET_MS = 50_000;

/**
 * The instant, in epoch milliseconds, one tool call's {@link CALL_BUDGET_MS}
 * runs out. A handler starts it once with {@link startCallDeadline} and passes
 * the same value to every service call, so requests chained one after another
 * share one budget instead of each starting its own.
 */
export type CallDeadline = number & { readonly __brand: 'CallDeadline' };

/** Starts a tool call's budget. Call once per tool call, before its first upstream request. */
export function startCallDeadline(): CallDeadline {
  return (Date.now() + CALL_BUDGET_MS) as CallDeadline;
}

/**
 * What is left of a call's budget, in milliseconds — 0 once it has run out.
 * Every retry ladder's `deadlineMs` is drawn from it ({@link ladderBudgetMs}).
 */
export function remainingBudgetMs(deadline: CallDeadline): number {
  return Math.max(0, deadline - Date.now());
}

/**
 * `withRetry`'s `deadlineMs` for a ladder about to start: what is left of the
 * call's budget. A budget already spent fails here, before any request, as the
 * call running out of time — a ladder started with nothing left would report
 * exceeding a "0ms retry deadline", which tells a caller nothing.
 */
export function ladderBudgetMs(deadline: CallDeadline, operation: string): number {
  const remaining = remainingBudgetMs(deadline);
  if (remaining > 0) return remaining;
  throw timeout(
    `${operation} was not attempted — the call's ${CALL_BUDGET_MS / 1000} s time budget had run out.`,
    { reason: 'retry_deadline_exceeded', retryAttempts: 0 },
  );
}

/** Whether `err` is an origin's HTTP 429 as `fetchWithTimeout` raises it. */
function isHttp429(err: unknown): err is McpError {
  return err instanceof McpError && (err.data as { status?: unknown } | undefined)?.status === 429;
}

/**
 * The 429 as `withRetry` should see it: without a `Retry-After` that
 * {@link parseRetryAfterSeconds} reads as no usable wait (`0`, an HTTP-date
 * already past). `withRetry` would take that header as a zero wait and re-send
 * at once, into the limiter that just refused; without it the attempt backs off
 * exponentially, as on a 429 that named no wait. The copy carries the origin's
 * error as its `cause`.
 */
function withoutUnusableRetryAfter(err: McpError): McpError {
  const { retryAfter, ...data } = err.data as Record<string, unknown>;
  if (retryAfter === undefined || parseRetryAfterSeconds(retryAfter) !== undefined) return err;
  return new McpError(err.code, err.message, data, { cause: err });
}

/**
 * Runs one retry ladder on what is left of a call's budget: `withRetry` with
 * {@link ladderBudgetMs} as its `deadlineMs`, so a spent budget fails before
 * any request. A 429 whose `Retry-After` names no usable wait reaches
 * `withRetry` without the header, so the ladder paces it with the exponential
 * backoff a header-less 429 takes rather than re-sending at once.
 *
 * The ladder remembers the last HTTP 429 an attempt received. When the budget
 * then runs out — in the backoff after it, or by cutting a later attempt
 * short — `withRetry` rejects with a `Timeout`
 * (`reason: 'retry_deadline_exceeded'`) whose `cause` is only the last
 * attempt; the ladder rejects with the 429 instead, as the origin sent it,
 * since it is still the origin's answer and the one the services classify.
 * Every other failure is rejected as `withRetry` threw it.
 */
export async function retryWithinBudget<T>(
  attempt: (attempt: RetryAttempt) => Promise<T>,
  options: Omit<RetryOptions, 'deadlineMs' | 'operation'> & {
    deadline: CallDeadline;
    operation: string;
  },
): Promise<T> {
  const { deadline, ...retryOptions } = options;
  let lastRateLimit: McpError | undefined;
  try {
    return await withRetry(
      async (a) => {
        try {
          return await attempt(a);
        } catch (err) {
          if (!isHttp429(err)) throw err;
          lastRateLimit = err;
          throw withoutUnusableRetryAfter(err);
        }
      },
      { ...retryOptions, deadlineMs: ladderBudgetMs(deadline, options.operation) },
    );
  } catch (err) {
    const expired =
      err instanceof McpError &&
      (err.data as { reason?: unknown } | undefined)?.reason === 'retry_deadline_exceeded';
    throw expired && lastRateLimit ? lastRateLimit : err;
  }
}

/**
 * One leg of a per-server fan-out as it stood when {@link firstHit} settled:
 * its settled result, or `undefined` for a leg still running then — aborted,
 * and never read as a failure.
 */
export type LegOutcome<T> = PromiseSettledResult<T> | undefined;

/**
 * Runs one DOI lookup per server and settles on the first leg whose answer
 * `isHit` accepts, or once every leg has settled. A DOI lives on one server, so
 * once a leg holds it no other leg's answer can change the result: the legs
 * still running are aborted rather than awaited, so a stalled server that does
 * not hold the DOI never spends the call's budget. Each leg runs on its own
 * signal combined with `callerSignal`, so a caller cancellation still stops
 * every leg; check the caller's signal afterwards, as after any fan-out.
 *
 * Returns the hit, if any, and each leg's outcome at that moment, in leg order.
 * Without a hit every leg had settled, so no outcome is `undefined`.
 */
export async function firstHit<T>(
  legs: readonly ((signal: AbortSignal) => Promise<T>)[],
  isHit: (value: T) => boolean,
  callerSignal: AbortSignal,
): Promise<{ hit: { leg: number; value: T } | undefined; outcomes: LegOutcome<T>[] }> {
  const runs = legs.map((start) => ({ start, controller: new AbortController() }));
  const outcomes: LegOutcome<T>[] = runs.map(() => undefined);
  const { promise, resolve } = Promise.withResolvers<{ leg: number; value: T } | undefined>();
  let running = runs.length;
  for (const [leg, { start, controller }] of runs.entries()) {
    start(AbortSignal.any([callerSignal, controller.signal])).then(
      (value) => {
        outcomes[leg] = { status: 'fulfilled', value };
        if (isHit(value)) resolve({ leg, value });
        if (--running === 0) resolve(undefined);
      },
      (reason: unknown) => {
        outcomes[leg] = { status: 'rejected', reason };
        if (--running === 0) resolve(undefined);
      },
    );
  }
  const hit = await promise;
  const settled = [...outcomes];
  for (const [leg, { controller }] of runs.entries()) {
    if (!settled[leg]) controller.abort();
  }
  return { hit, outcomes: settled };
}

/**
 * Version string used in outbound User-Agent headers. Derived from package.json
 * (the single source of truth) so it can never drift from the released version.
 * Resolves identically from `src/services/shared.ts` and the built
 * `dist/services/shared.js` — `../../package.json` is the repo root in both, and
 * the Docker production stage copies package.json alongside dist/.
 */
export const SERVER_VERSION: string = packageJson.version;
