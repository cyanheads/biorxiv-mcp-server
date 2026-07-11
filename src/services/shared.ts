/**
 * @fileoverview Shared utilities for biorxiv-mcp-server service layer. Provides
 * the Context→RequestContext cast, HTML error detection, and the server version
 * string used in User-Agent headers across all services.
 * @module services/shared
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import packageJson from '../../package.json' with { type: 'json' };

/**
 * Cast Context to RequestContext for fetchWithTimeout / withRetry.
 * Context is structurally assignable but lacks the index signature — cast once per call site.
 */
export function asRc(ctx: Context): RequestContext {
  return ctx as unknown as RequestContext;
}

/** Detect HTML error pages returned instead of JSON by upstream APIs. */
export function detectHtmlError(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/**
 * Strip Highwire/JATS export artifacts that bioRxiv/medRxiv and EuropePMC leak
 * into raw title and abstract text, so no upstream markup reaches
 * `structuredContent` or the rendered `content[]`. Removes:
 *
 * - whole figure blocks (`O_FIG … C_FIG`), which carry image refs, `SRC=` paths,
 *   `org.highwire.dtl.*` object references, and "Graphical Abstract" boilerplate;
 * - the small-caps "Abstract" heading sentinel (`A<O_SCPLOW>BSTRACT<C_SCPLOW>`),
 *   which upstream fuses directly onto the first sentence with no separator;
 * - remaining small-caps markers around inline text (markers dropped, the wrapped
 *   scientific text kept);
 * - inline HTML formatting tags (`<i>`, `<b>`, `<sub>`, `<sup>`, `<u>`, …).
 *
 * Applied at the service boundary rather than in a tool's `format()` because
 * `structuredContent` is the handler's raw return value and bypasses `format()`;
 * normalizing here cleans both client surfaces from a single site. Returns
 * `undefined` for absent or now-empty input so callers keep treating missing
 * fields as absent rather than as empty strings.
 */
export function normalizeUpstreamText(text: string | undefined): string | undefined {
  if (!text) return;
  const cleaned = text
    // Figure blocks wrap image/export boilerplate — none of it is human text.
    .replace(/O_FIG[\s\S]*?C_FIG/g, ' ')
    // Encoded "Abstract" heading, fused to the body with no separating space.
    .replace(/AO_SCPLOWBSTRACTC_SCPLOW/g, ' ')
    // Residual small-caps markers around inline text — drop markers, keep content.
    .replace(/[OC]_SCPLOW/g, '')
    // Leaked Java object references, e.g. org.highwire.dtl.DTLVardef@130b9ee.
    .replace(/org\.highwire\.dtl\.\S+/g, ' ')
    // Any unpaired figure sentinel that survived block removal.
    .replace(/[OCM]_FIG\b/g, ' ')
    // Residual figure image-source fragments.
    .replace(/\bSRC=\S*/gi, ' ')
    .replace(/Graphical Abstract/gi, ' ')
    // Inline HTML formatting tags leaked from JATS (enumerated to avoid eating
    // legitimate inequalities like "x<y" that aren't real tags).
    .replace(/<\/?(?:i|b|u|em|strong|sub|sup|small|br|p|span|div|a|h[1-6])\b[^>]*>/gi, '')
    // Collapse whitespace opened up by the removals above.
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || undefined;
}

/**
 * Version string used in outbound User-Agent headers. Derived from package.json
 * (the single source of truth) so it can never drift from the released version.
 * Resolves identically from `src/services/shared.ts` and the built
 * `dist/services/shared.js` — `../../package.json` is the repo root in both, and
 * the Docker production stage copies package.json alongside dist/.
 */
export const SERVER_VERSION: string = packageJson.version;
