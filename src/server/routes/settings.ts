/**
 * settings resource router (extracted from the monolithic routes.ts).
 * Returns null when no route matches; throws are mapped by index.ts.
 */
import { json, publicSettings, readJson } from "./core";
import { getSetting, listCards, listConversations, listPersonas, listWorlds, setSetting } from "../db";
import { errorResponse } from "../http";
import { getProvider } from "../../llm/providers";
import { validateSettingsPatch } from "../settingsSchema";
import { providerHealth } from "../health";
import { jobView } from "../jobs";

export async function handleSettings(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
if (p === "/api/models" && method === "GET") {
      const provider = getProvider(url.searchParams.get("provider") || undefined);
      const models = await provider.models().catch(() => []);
      return json({ models });
    }

if (p === "/api/auth" && method === "GET") {
      const token = getSetting("auth_token", "");
      const presented = url.searchParams.get("token") || req.headers.get("x-auth-token") || "";
      return json({ required: Boolean(token), ok: !token || presented === token });
    }

if (p === "/api/auth" && method === "POST") {
      const body = await readJson(req);
      const token = getSetting("auth_token", "");
      if (token && body.token !== token) return json({ error: "token invalide" }, 401);
      return json({ ok: true });
    }

if (p === "/api/settings" && method === "GET") {
      return json(publicSettings());
    }

if (p === "/api/settings" && method === "PATCH") {
      const body = await readJson(req);
      // single schema: unknown keys and out-of-range values are rejected with
      // a 400 (nothing is persisted) instead of being silently stored/dropped
      const entries = validateSettingsPatch(body);
      for (const [k, v] of entries) setSetting(k, v);
      return json(publicSettings());
    }

if (p === "/api/settings/schema" && method === "GET") {
      const { SETTING_DEFS } = await import("../settingsSchema");
      return json({ settings: SETTING_DEFS });
    }

if (p === "/api/diagnostics" && method === "GET") {
      // one-click bug-report bundle: versions, provider health, recent job
      // outcomes (errors included, payloads stripped), redacted settings.
      // Payloads can contain prompt text — only metadata is exposed.
      const { listJobs } = await import("../db");
      const jobs = listJobs().slice(0, 20).map((j) => {
        const v = jobView(j);
        const { payload, payloadObj, result, resultObj, ...rest } = v;
        return { ...rest, hasResult: v.hasResult };
      });
      return json({
        app: "innsekai",
        at: new Date().toISOString(),
        providers: providerHealth(),
        jobs,
        settings: publicSettings(),
        counts: {
          worlds: listWorlds().length,
          cards: listCards().length,
          personas: listPersonas().length,
          conversations: listConversations().length,
        },
      });
    }
    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
