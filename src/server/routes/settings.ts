/**
 * settings resource router (extracted from the monolithic routes.ts).
 * Returns null when no route matches; throws are mapped by index.ts.
 */
import { SECRET_KEYS, json, publicSettings, readJson } from "./core";
import { getSetting, setSetting } from "../db";
import { errorResponse } from "../http";
import { getProvider } from "../../llm/providers";

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
      for (const [k, v] of Object.entries(body)) {
        if (SECRET_KEYS.has(k) && (v === undefined || v === null || String(v) === "")) continue;
        // validate numeric settings
        if (typeof v === "number" || (typeof v === "string" && /^[\d.]+$/.test(v))) {
          const num = Number(v);
          if (k === "context_max_messages" && (num < 2 || num > 200)) continue;
          if (k === "image_steps" && (num < 1 || num > 50)) continue;
          if (k === "temperature" && (num < 0 || num > 2)) continue;
          if (k === "max_tokens" && (num < 64 || num > 16384)) continue;
          if (k === "image_cfg" && (num < 1 || num > 20)) continue;
        }
        setSetting(k, v);
      }
      return json(publicSettings());
    }
    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
