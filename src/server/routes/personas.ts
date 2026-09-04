/**
 * personas resource router (extracted from the monolithic routes.ts).
 * Returns null when no route matches; throws are mapped by index.ts.
 */
import { json, readJson } from "./core";
import { createPersona, deletePersona, getPersona, listPersonas, listTrashedResources, permanentDeleteTrashed, restoreTrashed, updatePersona } from "../db";
import { errorResponse } from "../http";
import { optStr, str } from "../validate";

export async function handlePersonas(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
if (p === "/api/personas" && method === "GET") {
      return json({ personas: listPersonas() });
    }

if (p === "/api/personas" && method === "POST") {
      const body = await readJson(req);
      return json(createPersona({
        name: str(body.name, "name", { max: 160 }),
        description: optStr(body.description, "description", 4000),
        ...(body.avatar !== undefined ? { avatar: optStr(body.avatar, "avatar", 300) } : {}),
      }), 201);
    }

if (parts[1] === "personas" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      // whitelist + validate (raw-body merge stored "[object Object]" for
      // non-string values and 500'd on sqlite bind)
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = str(body.name, "name", { max: 160 });
      if (body.description !== undefined) patch.description = optStr(body.description, "description", 4000);
      if (body.avatar !== undefined) patch.avatar = optStr(body.avatar, "avatar", 300);
      const row = updatePersona(Number(parts[2]), patch);
      return row ? json(row) : json({ error: "not found" }, 404);
    }

if (parts[1] === "personas" && parts[2] && !parts[3] && method === "DELETE") {
      const before = getPersona(Number(parts[2]));
      if (!before) return json({ error: "not found" }, 404);
      deletePersona(Number(parts[2]));
      return json({ ok: true, trashed: true });
    }

if (p === "/api/trash" && method === "GET") {
      return json({ items: listTrashedResources() });
    }

if (p === "/api/trash/restore" && method === "POST") {
      const body = await readJson(req);
      const ok = restoreTrashed(String(body.type), Number(body.id));
      return ok ? json({ ok: true }) : json({ error: "élément introuvable dans la corbeille", code: "NOT_FOUND" }, 404);
    }

if (p === "/api/trash/permanent" && method === "POST") {
      const body = await readJson(req);
      const ok = permanentDeleteTrashed(String(body.type), Number(body.id));
      return ok ? json({ ok: true }) : json({ error: "élément introuvable dans la corbeille", code: "NOT_FOUND" }, 404);
    }
    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
