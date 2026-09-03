/**
 * messages resource router (extracted from the monolithic routes.ts).
 * Returns null when no route matches; throws are mapped by index.ts.
 */
import { json, messageView, parseSegmentsFor, readJson } from "./core";
import { type MessageRow, deleteMessage, getConversation, getMessage, lastMessageOf, listMessages, updateConversation, updateMessage } from "../db";
import { errorResponse } from "../http";

export async function handleMessages(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && !parts[5] && method === "PATCH") {
      const convId = Number(parts[2]);
      const mid = Number(parts[4]);
      const body = await readJson(req);
      const m = getMessage(mid);
      const conv = getConversation(convId);
      if (!conv || !m || m.conversation_id !== convId) return json({ error: "not found" }, 404);
      let meta: Record<string, unknown> = {};
      try { if (typeof m.meta === "string" && m.meta) meta = JSON.parse(m.meta); } catch { /* ignore */ }
      // meta-only updates (favoris, notes privées…) never touch content
      if (body.meta !== undefined && typeof body.meta === "object" && !Array.isArray(body.meta)) {
        Object.assign(meta, body.meta);
        updateMessage(mid, { meta: JSON.stringify(meta) } as Partial<MessageRow>);
        return json(messageView(getMessage(mid)!));
      }
      if (typeof body.content !== "string" || !body.content.trim()) {
        return json({ error: "contenu vide" }, 400);
      }
      const content = body.content.trim();
      if (content.length > 40_000) return json({ error: "message trop long (40 000 caractères max)" }, 413);
      const updates: Record<string, string> = { content };
      if (m.role === "assistant") {
        updates.segments = JSON.stringify(parseSegmentsFor(conv, content));
      }
      // content changed → the old response suggestions no longer match, and for
      // user messages the model-facing rewrite (meta.prompt/directive) is stale
      delete meta.suggestions;
      if (m.role === "user") {
        delete meta.prompt;
        delete meta.directive;
      }
      updates.meta = JSON.stringify(meta);
      updateMessage(mid, updates);
      return json(messageView(getMessage(mid)!));
    }

if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && !parts[5] && method === "DELETE") {
      const convId = Number(parts[2]);
      const mid = Number(parts[4]);
      const msgs = listMessages(convId);
      const idx = msgs.findIndex((m) => m.id === mid);
      if (idx < 0) return json({ error: "message not found" }, 404);
      for (const m of msgs.slice(idx)) {
        deleteMessage(m.id);
      }
      const last = lastMessageOf(convId);
      updateConversation(convId, { last_message: last?.content ?? "" });
      return json({ ok: true });
    }

if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] === "bulk-delete" && method === "POST") {
      const convId = Number(parts[2]);
      const body = await readJson(req);
      const requested = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
      if (!requested.length) return json({ error: "aucun message sélectionné" }, 400);
      // only messages that actually belong to this conversation (no cross-party deletes)
      const owned = new Set(listMessages(convId).map((m) => m.id));
      const ids = requested.filter((id) => owned.has(id));
      if (!ids.length) return json({ error: "aucun message sélectionné dans cette partie" }, 404);
      for (const mid of ids) {
        deleteMessage(mid);
      }
      const last = lastMessageOf(convId);
      updateConversation(convId, { last_message: last?.content ?? "" });
      return json({ ok: true, removed: ids.length });
    }

if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && parts[5] === "reactions" && (method === "POST" || method === "DELETE")) {
      const convId = Number(parts[2]);
      const mid = Number(parts[4]);
      const m = getMessage(mid);
      if (!m || m.conversation_id !== convId) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      const emoji = String(body.emoji || "").trim();
      if (!emoji) return json({ error: "emoji manquant" }, 400);
      if (emoji.length > 32) return json({ error: "emoji trop long" }, 400);
      let metaText = "{}";
      if (m.meta && typeof m.meta === "string") metaText = m.meta;
      let meta: any = {};
      try { meta = JSON.parse(metaText); } catch { meta = {}; }
      const reactions: string[] = Array.isArray(meta.reactions) ? meta.reactions : [];
      const idx = reactions.indexOf(emoji);
      if (method === "POST" && idx < 0) reactions.push(emoji);
      if (method === "DELETE" && idx >= 0) reactions.splice(idx, 1);
      meta.reactions = reactions;
      updateMessage(mid, { meta: JSON.stringify(meta) } as Partial<MessageRow>);
      return json(messageView(getMessage(mid)!));
    }
    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
