/**
 * Minimal structured logging: one line per event, machine-grepable.
 *
 * Format: `[ISO-time][scope] message {"k":"v",…}` — scope is the subsystem
 * (chat, jobs, assist, image, backup…), message is human, data carries ids
 * (convId, jobId) and outcomes. Replaces ad-hoc emoji logs at the call sites
 * that matter for debugging; everything else keeps console.* as-is.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";

export type LogData = Record<string, string | number | boolean | null | undefined>;

let metricsFile: string | null = null;
function metricsPath(): string {
  if (!metricsFile) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    metricsFile = path.join(DATA_DIR, "metrics.jsonl");
  }
  return metricsFile;
}

/**
 * Phase 8 instrumentation: one JSON line per meaningful event, appended to
 * data/metrics.jsonl. Raw signal for the improvement loop (regeneration rate
 * per profile / context mode, guardrail triggers…) — no dashboard yet.
 */
export function recordMetric(type: string, data: LogData): void {
  try {
    fs.appendFileSync(metricsPath(), JSON.stringify({ t: Date.now(), type, ...data }) + "\n");
  } catch {
    /* best effort — a full disk must never break a turn */
  }
}

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
