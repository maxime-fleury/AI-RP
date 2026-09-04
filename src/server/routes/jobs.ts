/**
 * jobs resource router: list (with status filter), live SSE stream, retry and
 * cancel. Every long-running operation reports through the jobs hub (see
 * ../jobs.ts) so the activity panel can show a consistent lifecycle.
 */
import { canonicalStatus, cancelJob, jobStreamResponse, jobView, retryJob } from "../jobs";
import { getJob, listJobs } from "../db";
import { errorResponse, json } from "../http";
import { Codes } from "../validate";
import { idParam } from "../validate";

export async function handleJobs(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
    if (p === "/api/jobs" && method === "GET") {
      const status = url.searchParams.get("status") || undefined;
      return json({ jobs: listJobs(status).map(jobView) });
    }

    if (p === "/api/jobs/stream" && method === "GET") {
      return jobStreamResponse();
    }

    if (parts[1] === "jobs" && parts[2] && parts[3] === "retry" && method === "POST") {
      const id = idParam(parts[2], "job id");
      // distinguish the three refusals (previously all 404, so retrying a
      // RUNNING job reported "not found")
      const existing = getJob(id);
      if (!existing) return json({ error: "tâche introuvable", code: Codes.NOT_FOUND }, 404);
      const cur = canonicalStatus(existing.status);
      if (cur === "queued" || cur === "running") {
        return json({ error: "tâche déjà en cours", code: Codes.CONFLICT }, 409);
      }
      const job = await retryJob(id);
      if (!job) return json({ error: "ce type de tâche ne se relance pas", code: Codes.INVALID_FIELD }, 400);
      return json({ job: jobView(job) });
    }

    if (parts[1] === "jobs" && parts[2] && parts[3] === "cancel" && method === "POST") {
      const id = idParam(parts[2], "job id");
      const job = cancelJob(id);
      if (!job) return json({ error: "not found", code: "NOT_FOUND" }, 404);
      return json({ job: jobView(job) });
    }

    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
