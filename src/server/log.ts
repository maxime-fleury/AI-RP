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

export interface MetricsSummary {
  turns: number;
  byBehavior: Record<string, number>;
  byMode: Record<string, number>;
  byFocus: Record<string, number>;
  driftTriggers: number;
  driftRate: number; // share of turns that tripped the post-gen guardrail
  oocTurns: number;
  edits: number;
  regenerates: number;
  avgSecs: number;
  avgPromptTokens: number;
  windowDays: number;
}

/**
 * Phase 8 consumer: fold data/metrics.jsonl into a small summary for the
 * diagnostics panel (regeneration & guardrail rates per profile feed the
 * improvement loop). Never throws — no file yet means all-zero summary.
 */
export function readMetricsSummary(): MetricsSummary {
  const zero: MetricsSummary = {
    turns: 0, byBehavior: {}, byMode: {}, byFocus: {}, driftTriggers: 0, driftRate: 0,
    oocTurns: 0, edits: 0, regenerates: 0, avgSecs: 0, avgPromptTokens: 0, windowDays: 0,
  };
  try {
    const raw = fs.readFileSync(metricsPath(), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const turnRows: Record<string, any>[] = [];
    for (const line of lines.slice(-20_000)) {
      let row: Record<string, any>;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type === "turn") turnRows.push(row);
      else if (row.type === "edit") zero.edits++;
      else if (row.type === "regenerate") zero.regenerates++;
    }
    if (!turnRows.length) return zero;
    const sum = (k: string) => turnRows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const count = (k: string, bucket: Record<string, number>) => {
      for (const r of turnRows) {
        const v = String(r[k] ?? "unknown");
        bucket[v] = (bucket[v] || 0) + 1;
      }
    };
    const byBehavior: Record<string, number> = {};
    const byMode: Record<string, number> = {};
    const byFocus: Record<string, number> = {};
    count("behavior", byBehavior);
    count("contextMode", byMode);
    count("focus", byFocus);
    const drift = turnRows.filter((r) => r.driftRetry === true || r.driftRetry === 1).length;
    const first = turnRows[0].t || Date.now();
    const last = turnRows[turnRows.length - 1].t || Date.now();
    return {
      turns: turnRows.length,
      byBehavior, byMode, byFocus,
      driftTriggers: drift,
      driftRate: turnRows.length ? Math.round((drift / turnRows.length) * 1000) / 10 : 0,
      oocTurns: sum("ooc"),
      edits: zero.edits,
      regenerates: zero.regenerates,
      avgSecs: Math.round((sum("secs") / turnRows.length) * 10) / 10,
      avgPromptTokens: Math.round(sum("promptTokens") / turnRows.length),
      windowDays: Math.max(0, Math.round((last - first) / 86_400_000 * 10) / 10),
    };
  } catch {
    return zero;
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
