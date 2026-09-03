/**
 * Per-provider health tracking: latency history + error counts, kept in memory
 * for the current session. Wrapped around every provider call (stream, complete,
 * models) so the settings panel can show real usage statistics.
 */
import type { ChatProvider, StreamOptions } from "../llm/providers";

export interface HealthEntry {
  at: number;
  ms: number;
  ok: boolean;
  err?: string;
}

export interface ProviderHealth {
  calls: number;
  ok: number;
  errors: number;
  avgMs: number;
  lastMs: number | null;
  lastAt: number | null;
  lastError: string | null;
  history: HealthEntry[];
}

const stats = new Map<string, ProviderHealth>();
const MAX_HISTORY = 20;

function ensure(id: string): ProviderHealth {
  let h = stats.get(id);
  if (!h) {
    h = { calls: 0, ok: 0, errors: 0, avgMs: 0, lastMs: null, lastAt: null, lastError: null, history: [] };
    stats.set(id, h);
  }
  return h;
}

export function recordCall(id: string, ms: number, ok: boolean, err?: string): void {
  const h = ensure(id);
  h.calls++;
  if (ok) h.ok++;
  else h.errors++;
  h.lastMs = ms;
  h.lastAt = Date.now();
  if (!ok) h.lastError = (err || "erreur").slice(0, 200);
  // exponential moving average — robust to outliers, no unbounded memory
  h.avgMs = h.calls === 1 ? ms : Math.round(h.avgMs + (ms - h.avgMs) / Math.min(h.calls, 20));
  h.history.push({ at: h.lastAt, ms, ok, err: ok ? undefined : (err || "erreur").slice(0, 120) });
  if (h.history.length > MAX_HISTORY) h.history.shift();
}

export function providerHealth(): Record<string, ProviderHealth> {
  const out: Record<string, ProviderHealth> = {};
  for (const [k, v] of stats) out[k] = { ...v, history: [...v.history] };
  return out;
}

export function resetHealth(): void {
  stats.clear();
}

/** Wrap a provider so every call is timed and recorded. */
export function tracked(provider: ChatProvider): ChatProvider {
  // Object.create preserves the prototype chain: class providers define
  // configured()/models()/… on their prototype, and a plain object spread
  // ({ ...provider }) copies only own enumerable props, silently dropping
  // them (configured() was undefined on the wrapper).
  const wrapped: ChatProvider = Object.create(provider);
  return Object.assign(wrapped, {
    async *stream(opts: StreamOptions): AsyncGenerator<string> {
      const t0 = Date.now();
      try {
        yield* provider.stream(opts);
        recordCall(provider.id, Date.now() - t0, true);
      } catch (e) {
        recordCall(provider.id, Date.now() - t0, false, String((e as Error)?.message ?? e));
        throw e;
      }
    },
    async complete(opts: StreamOptions): Promise<string> {
      const t0 = Date.now();
      try {
        const out = await provider.complete(opts);
        recordCall(provider.id, Date.now() - t0, true);
        return out;
      } catch (e) {
        recordCall(provider.id, Date.now() - t0, false, String((e as Error)?.message ?? e));
        throw e;
      }
    },
    async models(): Promise<string[]> {
      const t0 = Date.now();
      try {
        const out = await provider.models();
        recordCall(provider.id, Date.now() - t0, true);
        return out;
      } catch (e) {
        recordCall(provider.id, Date.now() - t0, false, String((e as Error)?.message ?? e));
        throw e;
      }
    },
  });
}
