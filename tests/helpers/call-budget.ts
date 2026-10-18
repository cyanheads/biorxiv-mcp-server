/**
 * @fileoverview Test seams for the per-tool-call budget. For the services: a
 * stand-in for `fetchWithTimeout` against an origin that accepts the
 * connection and never answers, or answers only late, and a fake-timer runner that reports when a
 * call settled — every service suite drives its real retry ladder
 * (`withRetry`) through these, so the bound is asserted on the attempts,
 * backoffs, and expiry the ladder actually produces. For the tools: a service
 * stub that records what each chained step had left of the call's budget, and
 * stubbed fan-out legs that answer late or never.
 * @module tests/helpers/call-budget
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { type Mock, vi } from 'vitest';

/** The arguments a service hands `fetchWithTimeout`. */
export type FetchCall = [string, number, unknown, { signal: AbortSignal }];

/**
 * A fake `fetchWithTimeout` whose every attempt hangs until its own timeout —
 * `Timeout` — or until its signal fires: a deadline abort (a `TimeoutError`
 * reason) as `Timeout` with `errorSource: 'FetchSignalTimeout'`, any other
 * abort as `RequestCancelled`, as the real helper classifies them.
 * `startedAt[i]` is when attempt `i` began, in (fake) epoch milliseconds.
 */
export function hungOrigin() {
  const startedAt: number[] = [];
  const fetch = (
    _url: string,
    timeoutMs: number,
    _ctx: unknown,
    options: { signal: AbortSignal },
  ) => {
    startedAt.push(Date.now());
    const { signal } = options;
    const aborted = () =>
      (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError'
        ? new McpError(JsonRpcErrorCode.Timeout, 'timed out on the caller signal', {
            errorSource: 'FetchSignalTimeout',
          })
        : new McpError(JsonRpcErrorCode.RequestCancelled, 'aborted', {
            errorSource: 'FetchAborted',
          });
    return new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(aborted());
        return;
      }
      const timer = setTimeout(
        () =>
          reject(
            new McpError(JsonRpcErrorCode.Timeout, 'attempt timed out', {
              errorSource: 'FetchTimeout',
            }),
          ),
        timeoutMs,
      );
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(aborted());
        },
        { once: true },
      );
    });
  };
  return { fetch, startedAt };
}

/**
 * A fake `fetchWithTimeout` against an origin that answers, but slowly: every
 * attempt rejects with `answer()` once `ms` of (fake) time has passed, unless
 * its own timeout or its signal ends it first, exactly as on {@link hungOrigin}.
 */
export function slowOrigin(ms: number, answer: () => unknown) {
  const origin = hungOrigin();
  const fetch = (...args: Parameters<typeof origin.fetch>) =>
    Promise.race([
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(answer()), ms)),
      origin.fetch(...args),
    ]);
  return { fetch, startedAt: origin.startedAt };
}

/**
 * Runs a call under fake timers until it settles and reports how long that
 * took. Fails the test if the call is still pending after `advanceMs` of fake
 * time.
 */
export async function settle(
  call: Promise<unknown>,
  advanceMs = 120_000,
): Promise<{ value: unknown; err: McpError; elapsedMs: number }> {
  const started = Date.now();
  let settledAt: number | undefined;
  const outcome = call.then(
    (value: unknown) => {
      settledAt = Date.now();
      return { value, err: undefined as unknown };
    },
    (err: unknown) => {
      settledAt = Date.now();
      return { value: undefined as unknown, err };
    },
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  if (settledAt === undefined) throw new Error(`The call did not settle within ${advanceMs} ms.`);
  const { value, err } = await outcome;
  return { value, err: err as McpError, elapsedMs: settledAt - started };
}

/**
 * A mocked service method standing in for one step of a tool's chain, under
 * fake timers: records what was left of the call budget when the step was
 * called — its deadline, the last number every service method takes, less the
 * time then — and lets `elapsedMs` pass before answering `value`.
 */
export function budgetStep(remaining: number[], elapsedMs: number, value: unknown) {
  return (...args: unknown[]) => {
    remaining.push((args.findLast((arg) => typeof arg === 'number') as number) - Date.now());
    vi.advanceTimersByTime(elapsedMs);
    return Promise.resolve(value);
  };
}

/** One server's stub for a fanned-out service call, run on the signal the leg uses. */
export type LegStub = (signal: AbortSignal) => Promise<unknown>;

/**
 * Routes each call of a mocked per-server service method — `(doi, server,
 * deadline, ctx, signal?)`, the shape of `getDetails` and `getPublishedVersion`
 * — to the stub for its server. Records the leg signal the caller handed it in
 * `legSignals` (`undefined` when it handed none), and runs the stub on the
 * signal the service itself would use: that one, or else `ctx.signal`.
 */
export function routeLegs(
  method: Mock,
  stubs: Record<string, LegStub>,
  legSignals: Record<string, AbortSignal | undefined>,
): void {
  method.mockImplementation(
    (
      _doi: string,
      server: string,
      _deadline: number,
      ctx: { signal: AbortSignal },
      signal?: AbortSignal,
    ) => {
      legSignals[server] = signal;
      const stub = stubs[server];
      if (!stub) throw new Error(`No stub for the ${server} leg.`);
      return stub(signal ?? ctx.signal);
    },
  );
}

/** A stubbed service leg that answers `value` once `ms` of (fake) time has passed. */
export function answerAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * A stubbed service leg against an origin that never answers. It rejects as an
 * aborted request when `signal` — the one the leg runs on — aborts, and, given
 * `deadlineMs`, as the ladder's budget expiry once that much (fake) time has
 * passed.
 */
export function neverAnswers(signal: AbortSignal, deadlineMs?: number) {
  return new Promise<never>((_resolve, reject) => {
    const expiry =
      deadlineMs === undefined
        ? undefined
        : setTimeout(
            () =>
              reject(
                new McpError(
                  JsonRpcErrorCode.Timeout,
                  `The lookup exceeded its ${deadlineMs}ms retry deadline after 4 attempts.`,
                  { reason: 'retry_deadline_exceeded' },
                ),
              ),
            deadlineMs,
          );
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(expiry);
        reject(
          new McpError(JsonRpcErrorCode.RequestCancelled, 'aborted', {
            errorSource: 'FetchAborted',
          }),
        );
      },
      { once: true },
    );
  });
}
