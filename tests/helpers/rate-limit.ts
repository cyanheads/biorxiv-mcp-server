/**
 * @fileoverview Test fixtures for the rejections a service has already
 * classified as an origin rate limit — `BiorxivApiService` for api.biorxiv.org,
 * `EuropePmcService` for the EuropePMC search endpoint. This is what a tool
 * handler sees when either origin answers HTTP 429: the raw `fetchWithTimeout`
 * rejection, with its status fields and upstream response body, never gets past
 * the service. Kept in one place so every tool suite exercises the same shape
 * the service actually throws rather than a hand-copied approximation of it;
 * each service suite asserts its real throw still matches its fixture here.
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

/**
 * The static `recovery` a tool declares for `rate_limited` — the text the
 * framework sends for a hintless failure. A 429 carries `retryAfter` only when
 * the origin named a usable wait, so this text must hold without one.
 */
export function declaredRateLimitRecovery(
  errors: readonly { reason: string; recovery: string }[] | undefined,
): string {
  const entry = errors?.find((e) => e.reason === 'rate_limited');
  if (!entry) throw new Error('tool declares no rate_limited reason');
  return entry.recovery;
}

/** Opening every `rate_limited` recovery shares: it holds when `retryAfter` is absent. */
export const RATE_LIMIT_RECOVERY_OPENING =
  'Wait the retryAfter seconds when present, otherwise a minute or two, before ';

/**
 * The upstream 429 response body EuropePMC returns. Assert its absence to prove
 * the service kept `fetchWithTimeout`'s `data.body` / `data.responseBody` out of
 * the payload.
 */
export const EUROPE_PMC_RATE_LIMIT_BODY =
  '<html><body>429 Too Many Requests — ebi.ac.uk/europepmc</body></html>';

/**
 * Build the rejection `EuropePmcService` throws for an origin 429. Omit
 * `retryAfter` to model a 429 whose response carried no usable `Retry-After`.
 */
export function europePmcRateLimitError(retryAfter?: number): McpError {
  return new McpError(
    JsonRpcErrorCode.RateLimited,
    retryAfter === undefined
      ? 'EuropePMC is rate-limiting this host (HTTP 429).'
      : `EuropePMC is rate-limiting this host (HTTP 429) and asked for a ${retryAfter}-second wait before the next request.`,
    {
      reason: 'rate_limited',
      retryable: true,
      ...(retryAfter !== undefined && { retryAfter }),
      recovery: { hint: 'Wait before querying EuropePMC again.' },
    },
  );
}
