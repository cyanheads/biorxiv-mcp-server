/**
 * @fileoverview Test fixture for a rejection that `BiorxivApiService` has already
 * classified as an origin rate limit. This is what a tool handler sees when
 * api.biorxiv.org answers HTTP 429 — the raw `fetchWithTimeout` rejection, with
 * its status fields and upstream response body, never gets past the service.
 * Kept in one place so every tool suite exercises the same shape the service
 * actually throws rather than a hand-copied approximation of it.
 * @module tests/helpers/rate-limit
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * The upstream 429 response body. Assert its absence to prove the service kept
 * `fetchWithTimeout`'s `data.body` / `data.responseBody` out of the payload.
 */
export const RATE_LIMIT_BODY = '<html><body>429 Too Many Requests — api.biorxiv.org</body></html>';

/**
 * Build the rejection `BiorxivApiService` throws for an origin 429. Omit
 * `retryAfter` to model a 429 whose response carried no usable `Retry-After`.
 */
export function rateLimitError(retryAfter?: number): McpError {
  return new McpError(
    JsonRpcErrorCode.RateLimited,
    retryAfter === undefined
      ? 'api.biorxiv.org is rate-limiting this host (HTTP 429).'
      : `api.biorxiv.org is rate-limiting this host (HTTP 429) and asked for a ${retryAfter}-second wait before the next request.`,
    {
      reason: 'rate_limited',
      retryable: true,
      ...(retryAfter !== undefined && { retryAfter }),
      recovery: { hint: 'Wait before querying api.biorxiv.org again.' },
    },
  );
}
