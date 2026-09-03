/**
 * Minimal structured logging: one line per event, machine-grepable.
 *
 * Format: `[ISO-time][scope] message {"k":"v",…}` — scope is the subsystem
 * (chat, jobs, assist, image, backup…), message is human, data carries ids
 * (convId, jobId) and outcomes. Replaces ad-hoc emoji logs at the call sites
 * that matter for debugging; everything else keeps console.* as-is.
 */

export type LogData = Record<string, string | number | boolean | null | undefined>;

function fmt(data?: LogData): string {
  if (!data) return "";
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) clean[k] = v;
  }
  const s = JSON.stringify(clean);
  return s === "{}" ? "" : ` ${s}`;
}

export function log(scope: string, message: string, data?: LogData): void {
  console.log(`[${new Date().toISOString()}][${scope}] ${message}${fmt(data)}`);
}

export function logWarn(scope: string, message: string, data?: LogData): void {
  console.warn(`[${new Date().toISOString()}][${scope}] ${message}${fmt(data)}`);
}

export function logError(scope: string, message: string, data?: LogData): void {
  console.error(`[${new Date().toISOString()}][${scope}] ${message}${fmt(data)}`);
}
