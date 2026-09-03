/**
 * media resource router: image-server preload probe + the per-message
 * illustration pipeline (a tracked, cancellable/retryable job — see the
 * generateMessageIllustration work function in core.ts).
 */
import { generateMessageIllustration, json } from "./core";
import { getConversation, getMessage } from "../db";
import { errorResponse, readJson } from "../http";
import { jobView, trackJob } from "../jobs";
import { ensureImageServer } from "../image";
import { optStr } from "../validate";

export async function handleMedia(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
    if (p === "/api/images/preload" && method === "POST") {
      const ok = await ensureImageServer();
      return json({ ok });
    }

    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && parts[5] === "image" && method === "POST") {
      const convId = Number(parts[2]);
      const mid = Number(parts[4]);
      const conv = getConversation(convId);
      const m = getMessage(mid);
      if (!conv || !m || m.conversation_id !== convId) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      const kind = optStr(body.kind, "kind", 32);
      const variation = optStr(body.variation, "variation", 300);
      const seed = typeof body.seed === "number" ? body.seed : undefined;
      const vary = body.vary === true;
      const { job, result } = await trackJob(
        {
          type: "image",
          title: "Illustration du message",
          conversationId: convId,
          messageId: mid,
          payload: { op: "message", conversationId: convId, messageId: mid, kind, seed, vary, variation },
          cancellable: true,
          retryable: true,
        },
        async () => generateMessageIllustration(convId, mid, { kind, seed, vary, variation }),
      );
      // the work function stored the meta; same response shape as before, plus
      // the job row so the surface can show progress
      return json({
        image: result.url,
        seed: result.seed,
        kind: result.kind,
        character: result.character,
        job: jobView(job),
      });
    }

    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
