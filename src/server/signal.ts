/**
 * Combine an external cancellation signal (job cancel / client stop) with an
 * internal watchdog timeout. Uses AbortSignal.any when available (Bun/Node
 * 20+), with a manual fallback so older runtimes still cancel correctly.
 */
export function combineSignals(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeout, external]);
  const c = new AbortController();
  const onAbort = () => c.abort();
  timeout.addEventListener("abort", onAbort, { once: true });
  external.addEventListener("abort", onAbort, { once: true });
  if (timeout.aborted || external.aborted) c.abort();
  return c.signal;
}