/**
 * @fileoverview Shared utilities for biorxiv-mcp-server service layer. Provides
 * the Context→RequestContext cast, HTML error detection, and the server version
 * string used in User-Agent headers across all services.
 * @module services/shared
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';

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

/** Version string used in outbound User-Agent headers. */
export const SERVER_VERSION = '0.1.8';
