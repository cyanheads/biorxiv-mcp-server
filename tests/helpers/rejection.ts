/**
 * @fileoverview Captures the `McpError` a tool handler throws. A tool
 * definition's `handler` is typed `Promise<TOutput> | TOutput` — a handler may
 * answer synchronously — so `handler(...).catch(...)` does not typecheck at the
 * call site. This awaits the call whatever its shape and fails loudly when it
 * resolves, instead of handing a success payload to an error assertion.
 * @module tests/helpers/rejection
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';

/** Await a handler call and return the error it threw. */
export async function rejection(call: unknown): Promise<McpError> {
  try {
    await call;
  } catch (err) {
    return err as McpError;
  }
  throw new Error('Expected the handler to throw, but it resolved.');
}

/**
 * The `recovery.hint` the throw site itself put on `McpError.data` — a handler
 * called directly gets no contract fill, so this sees only an explicit hint.
 * Returns `''` when the throw carried none, so an assertion reads as a missing
 * hint rather than a type error.
 */
export function recoveryHint(err: McpError): string {
  return (err.data?.recovery as { hint?: string } | undefined)?.hint ?? '';
}

/**
 * The `recovery.hint` on a `runToolContract` error envelope — what a client
 * receives, with a declared reason's contract hint filled in by the framework.
 */
export function envelopeHint(result: { structuredContent?: unknown }): string {
  const envelope = result.structuredContent as
    | { error?: { data?: { recovery?: { hint?: string } } } }
    | undefined;
  return envelope?.error?.data?.recovery?.hint ?? '';
}
