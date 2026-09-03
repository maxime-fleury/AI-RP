/**
 * Unified background-job hub. Every long-running operation (image generation,
 * recaps, captions, summaries, relation scans, AI assistance) reports through
 * here so the UI can show a consistent lifecycle — queued → running →
 * completed / failed / cancelled, with progress and retry support.
 *
 * Jobs are PERSISTED in the `jobs` table (survives restarts; stale rows are
 * marked failed at boot — see cleanupStaleJobs in db.ts) and BROADCAST live
 * to SSE clients via the in-memory listener set.
 */
import { createJob, getJob, updateJob, type JobRow } from "./db";
import { sseStream } from "./http";
import { log } from "./log";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "retryable";

export const STATUS_LABELS: Record<string, string> = {
  queued: "En attente",
  pending: "En attente",
  running: "En cours",
  completed: "Terminé",
  done: "Terminé",
  failed: "Échec",
  cancelled: "Annulé",
  retryable: "Échec — réessayable",
};

/** Canonicalize legacy statuses stored by older versions. */
export function canonicalStatus(s: string): JobStatus {
  if (s === "pending") return "queued";
  if (s === "done") return "completed";
  if (s === "running" || s === "failed" || s === "completed" || s === "cancelled" || s === "retryable" || s === "queued") {
    return s as JobStatus;
  }
  return "queued";
}

// ─── live broadcast ───────────────────────────────────────────────────────────
const listeners = new Set<(job: JobRow) => void>();

export function onJobEvent(fn: (job: JobRow) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcast(job: JobRow): void {
  for (const fn of [...listeners]) {
    try {
      fn(job);
    } catch {
      /* a broken listener must not kill the hub */
    }
  }
}

// ─── cancellation ─────────────────────────────────────────────────────────────
// Every running/queued job owns an AbortController. Cancel aborts the signal:
// work functions that accept a signal (image generation, LLM calls) stop at the
// next await instead of grinding to completion after the row said "cancelled".
const controllers = new Map<number, AbortController>();

export function abortSignalFor(jobId: number): AbortSignal | undefined {
  return controllers.get(jobId)?.signal;
}

function registerController(jobId: number): AbortController {
  const ac = new AbortController();
  controllers.set(jobId, ac);
  return ac;
}

function releaseController(jobId: number): void {
  controllers.delete(jobId);
}

// ─── retry handlers (registered per job type by the routers) ─────────────────
// Handlers may RETURN a value: it is persisted on the job row (`result`) so a
// retried assist job actually shows its fresh proposals (see jobView/"Voir").
type RetryFn = (payload: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export const MAX_RESULT_BYTES = 20000;

export function packResult(v: unknown): string {
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v).slice(0, MAX_RESULT_BYTES);
  } catch {
    return "";
  }
}
const retryHandlers = new Map<string, RetryFn>();

export function registerJobRetry(type: string, fn: RetryFn): void {
  retryHandlers.set(type, fn);
}

export interface JobSpec {
  type: string;
  title: string;
  conversationId?: number | null;
  messageId?: number | null;
  payload?: Record<string, unknown>;
  cancellable?: boolean;
  retryable?: boolean;
}

export function startJob(spec: JobSpec): JobRow {
  const job = createJob({
    type: spec.type,
    status: "queued",
    progress: 0,
    conversation_id: spec.conversationId ?? null,
    message_id: spec.messageId ?? null,
    payload: JSON.stringify(spec.payload ?? {}),
    title: spec.title,
    cancellable: spec.cancellable ? 1 : 0,
    retryable: spec.retryable ? 1 : 0,
  });
  broadcast(job);
  return job;
}

export function setJob(id: number, patch: Partial<JobRow>): JobRow | null {
  const job = updateJob(id, patch);
  if (job) broadcast(job);
  return job;
}

export function jobRunning(job: JobRow): void {
  setJob(job.id, { status: "running" });
}

export function jobProgress(job: JobRow, p: number): void {
  setJob(job.id, { progress: Math.max(0, Math.min(100, Math.round(p))) });
}

export function jobSucceed(job: JobRow, progress = 100, result?: unknown): void {
  setJob(job.id, {
    status: "completed", progress, completed_at: Date.now(),
    ...(result !== undefined ? { result: packResult(result) } : {}),
  });
  log("jobs", "completed", { jobId: job.id, type: job.type, conversationId: job.conversation_id ?? null });
}

export function jobFail(job: JobRow, error: unknown, retryable = false): void {
  const msg = String(error instanceof Error ? error.message : error).slice(0, 400);
  setJob(job.id, {
    status: retryable ? "retryable" : "failed",
    error: msg,
    completed_at: Date.now(),
  });
  log("jobs", retryable ? "retryable" : "failed", { jobId: job.id, type: job.type, error: msg.slice(0, 160) });
}

export function jobCancel(job: JobRow, reason = "Annulé"): void {
  setJob(job.id, { status: "cancelled", error: reason, completed_at: Date.now() });
}

/**
 * Run `work` as a tracked job. The job starts queued, flips to running, then
 * completes or fails — unless it was cancelled meanwhile (a cancelled job
 * stays cancelled even if the underlying work finishes). Resolves with the
 * work function's return value. `api.signal` is the job's AbortController
 * signal: pass it into provider/image calls so Cancel actually stops work.
 */
export async function trackJob<T = void>(
  spec: JobSpec,
  work: (job: JobRow, api: { progress: (p: number) => void; signal: AbortSignal }) => Promise<T>,
): Promise<{ job: JobRow; result: T }> {
  const job = startJob(spec);
  const ac = registerController(job.id);
  jobRunning(job);
  const api = { progress: (p: number) => jobProgress(job, p), signal: ac.signal };
  try {
    const result = await work(job, api);
    const cur = getJob(job.id);
    if (cur && cur.status === "running") jobSucceed(job, 100, result);
    // the `job` captured above predates the run (status/progress/result all
    // changed meanwhile) — return the FRESH row so callers never read stale
    // fields off it
    return { job: getJob(job.id) ?? job, result };
  } catch (e) {
    const cur = getJob(job.id);
    if (!cur || cur.status === "running") jobFail(job, e, spec.retryable);
    throw e;
  } finally {
    releaseController(job.id);
  }
}

/**
 * Serialize a job row for clients: canonical status + human label. The raw
 * `payload` JSON string is kept as-is (existing API clients parse it), and
 * `payloadObj` is provided as a convenience for new clients (activity panel).
 */
export function jobView(j: JobRow): any {
  let payloadObj: Record<string, unknown> = {};
  try {
    payloadObj = JSON.parse(j.payload || "{}");
  } catch { /* ignore */ }
  let resultObj: unknown = null;
  try {
    resultObj = j.result ? JSON.parse(j.result) : null;
  } catch {
    resultObj = { raw: String(j.result).slice(0, 2000) };
  }
  return {
    ...j,
    payloadObj,
    resultObj,
    hasResult: resultObj !== null && resultObj !== undefined,
    status: canonicalStatus(j.status),
    statusLabel: STATUS_LABELS[canonicalStatus(j.status)] ?? j.status,
  };
}

/**
 * Retry a failed/retryable/cancelled job: creates a fresh row of the same type
 * and runs the registered handler. Returns the new job, or null when no
 * handler is registered for the type.
 */
export async function retryJob(id: number): Promise<JobRow | null> {
  const old = getJob(id);
  if (!old) return null;
  const cur = canonicalStatus(old.status);
  if (cur === "queued" || cur === "running") return null;
  const handler = retryHandlers.get(old.type);
  if (!handler) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(old.payload || "{}");
  } catch { /* ignore */ }
  const fresh = startJob({
    type: old.type,
    title: old.title || old.type,
    conversationId: old.conversation_id,
    messageId: old.message_id,
    payload,
    retryable: old.retryable === 1,
  });
  const ac = registerController(fresh.id);
  jobRunning(fresh);
  try {
    const result = await handler(payload, ac.signal);
    const cur = getJob(fresh.id);
    if (cur && cur.status === "running") jobSucceed(fresh, 100, result);
  } catch (e) {
    const cur = getJob(fresh.id);
    if (!cur || cur.status === "running") jobFail(fresh, e, old.retryable === 1);
  } finally {
    releaseController(fresh.id);
  }
  return getJob(fresh.id);
}

export function cancelJob(id: number): JobRow | null {
  const job = getJob(id);
  if (!job) return null;
  if (job.status === "queued" || job.status === "pending") {
    jobCancel(job);
    controllers.get(id)?.abort();
    return getJob(id);
  }
  // running: mark cancelled AND abort the underlying work so the LLM/image
  // call stops at the next await; the tracked work stays cancelled
  if (job.status === "running") {
    jobCancel(job);
    controllers.get(id)?.abort();
    return getJob(id);
  }
  return null;
}

/**
 * SSE endpoint: sends a snapshot of recent jobs, then every live job event.
 * The stream stays open until the client disconnects (ReadableStream cancel →
 * sseStream's onCancel); the listener is torn down when the stream closes.
 */
export function jobStreamResponse(): Response {
  // The listener must be removed when the client disconnects; sseStream calls
  // onCancel for that, so detach is hoisted where both callbacks can reach it.
  let detach: (() => void) | null = null;
  return sseStream(
    async (send) => {
      // NOTE: onStart must never resolve for a live stream — resolving would
      // close it. (Previously detach() sat unreachable behind a
      // never-resolving promise and every client leaked a listener:
      // broadcasts kept enqueueing into closed streams forever.)
      detach = onJobEvent((job) => send("job", jobView(job)));
      const { listJobs } = await import("./db");
      send("snapshot", { jobs: listJobs().slice(0, 50).map(jobView) });
      return new Promise<void>(() => {});
    },
    () => {
      detach?.();
      detach = null;
    },
  );
}