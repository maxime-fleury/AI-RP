/**
 * API dispatcher: LAN auth + meta endpoints inline, then per-resource
 * routers in original route order. Returns 404 when nothing matches.
 */
import { json } from "./core";
import { getSetting } from "../db";
import { errorResponse } from "../http";
import { Codes } from "../validate";
import { probeImageStatus } from "../image";
import { providerHealth } from "../health";
import { getProvider } from "../../llm/providers";

import { handleSettings } from "./settings";
import { handleBackups } from "./backups";
import { handleMedia } from "./media";
import { handleCards } from "./cards";
import { handleWorlds } from "./worlds";
import { handleJobs } from "./jobs";
import { handleAssist } from "./assist";
import { handlePersonas } from "./personas";
import { handleConversations } from "./conversations";
import { handleMessages } from "./messages";

export async function handleApi(req: Request, url: URL): Promise<Response> {
  const method = req.method;
  const p = url.pathname;
  const parts = p.split("/").filter(Boolean); // ["api", ...]

  // optional LAN token: when set, every API call must carry it
  const authToken = getSetting("auth_token", "");
  if (authToken && p !== "/api/auth") {
    const presented =
      url.searchParams.get("token") ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      req.headers.get("x-auth-token");
    if (presented !== authToken) return json({ error: "unauthorized" }, 401);
  }

  try {
    // health / meta
    if (method === "GET" && p === "/api/health/providers") {
      return json(providerHealth());
    }
    if (method === "GET" && p === "/api/health") {
      return json({
        ok: true,
        image: await probeImageStatus(),
      });
    }
    // test all services at once (LLM provider, image sidecar) with latencies
    if (p === "/api/test" && method === "POST") {
      const results: Record<string, any> = {};
      const t0 = Date.now();
      const provider = getProvider();
      const models = await provider.models().catch(() => []);
      results.provider = {
        provider: provider.id,
        ok: Array.isArray(models) && models.length > 0,
        ms: Date.now() - t0,
        models: Array.isArray(models) ? models.slice(0, 3) : [],
      };
      results.image = await probeImageStatus();
      return json(results);
    }

    // per-resource routers, in original route order (deep routes win over
    // shallow ones exactly like the old single-file dispatcher)
    const chain: { handler: (req: Request, url: URL, parts: string[], method: string) => Promise<Response | null> }[] = [
      { handler: handleSettings },
      { handler: handleBackups },
      { handler: handleMedia },
      { handler: handleCards },
      { handler: handleWorlds },
      { handler: handleJobs },
      { handler: handleAssist },
      { handler: handlePersonas },
      { handler: handleConversations },
      { handler: handleMessages },
    ];
    for (const { handler } of chain) {
      const r = await handler(req, url, parts, method);
      if (r) return r;
    }
    return json({ error: "Not found", code: Codes.NOT_FOUND }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}
