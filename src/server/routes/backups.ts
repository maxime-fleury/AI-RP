/**
 * backups resource router: storage analytics, file backups (with the pre-purge
 * safety snapshot), full export, and the transactional restore workflow —
 * preview (counts + checksum), then restore with a conflict policy
 * (append/replace) and selective resource includes.
 */
import { json, mediaFileFor, messageView, readJson } from "./core";
import { listCards, listConversations, listLocations, listLorebook, listMessages, listPersonas, listRelations, listScenarios, listTimeline, listWorlds } from "../db";
import { errorResponse } from "../http";
import { analyzeOrphans, purgeOrphans, runBackup, storageInfo } from "../backup";
import { analyzeBackup, restoreBackupTx } from "../restore";
import { collectMediaUrls } from "../media";
import fs from "node:fs";
import { createHash } from "node:crypto";

/** The wrapper body is { backup, conflict?, include? } — the backup itself is the inner payload. */
function innerBackup(body: any): any {
  if (body && typeof body === "object") {
    if (body.backup && typeof body.backup === "object") return body.backup;
    if (Array.isArray(body.worlds) || Array.isArray(body.cards) || Array.isArray(body.conversations)) return body;
  }
  return null;
}

export async function handleBackups(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
    if (p === "/api/storage" && method === "GET") {
      return json(storageInfo());
    }

    if (p === "/api/storage/analyze" && method === "POST") {
      return json(analyzeOrphans());
    }

    if (p === "/api/storage/purge" && method === "POST") {
      const body = await readJson(req);
      const files = Array.isArray(body.files) ? body.files.map(String).filter(Boolean) : [];
      if (!files.length) return json({ removed: 0, bytes: 0 });
      // safety net: snapshot the DB before anything is deleted, so a purge can
      // be undone from the backups (the danger is in the confirmed deletes)
      const backup = runBackup(true);
      console.log(`[purge] 🗑 ${files.length} fichier(s) — sauvegarde ${backup || "du jour déjà existante"}`);
      const r = purgeOrphans(files);
      return json({ ...r, backup });
    }

    if (p === "/api/backup" && method === "POST") {
      const body = await readJson(req);
      // same verb serves two intents: restore (a backup payload) or create a file
      const backup = innerBackup(body);
      if (backup) {
        const report = restoreBackupTx(backup, { conflict: "append" });
        return json(report);
      }
      const file = runBackup(true);
      return json({ ok: Boolean(file), file });
    }

    // restore preview: analyze WITHOUT writing anything + a stable checksum so
    // the UI can confirm the file is byte-for-byte the one that was previewed
    if (p === "/api/backup/preview" && method === "POST") {
      const body = await readJson(req);
      const backup = innerBackup(body);
      if (!backup) return json({ error: "backup invalide", code: "INVALID_BACKUP" }, 400);
      const checksum = createHash("sha256").update(JSON.stringify(backup)).digest("hex");
      return json({ preview: analyzeBackup(backup), checksum });
    }

    if (p === "/api/backup/restore" && method === "POST") {
      const body = await readJson(req);
      const backup = innerBackup(body);
      if (!backup) return json({ error: "backup invalide", code: "INVALID_BACKUP" }, 400);
      const conflict = body?.conflict === "replace" ? "replace" : "append";
      const include = body?.include && typeof body.include === "object" ? body.include : undefined;
      const report = restoreBackupTx(backup, { conflict, include });
      return json(report);
    }

    if (p === "/api/export" && method === "GET") {
      // STREAMED export: sections are serialized one at a time instead of
      // building the whole backup (DB rows + every image as base64) as a
      // single giant string. Peak memory is one section / one file, not the
      // entire library. Shape note: "media" is now always present (possibly
      // {}) — restore/preview treat {} and missing identically.
      const worlds = listWorlds();
      const encoder = new TextEncoder();
      const urls = new Set<string>();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (s: string) => controller.enqueue(encoder.encode(s));
          try {
            send(`{"app":"innsekai","version":1,"exported_at":${JSON.stringify(new Date().toISOString())},`);
            const section = (name: string, items: unknown[]) => {
              send(`${JSON.stringify(name)}:[`);
              items.forEach((it, i) => {
                collectMediaUrls(it, urls);
                if (i) send(",");
                send(JSON.stringify(it));
              });
              send("],");
            };
            section("worlds", worlds);
            section("locations", worlds.flatMap((w) => listLocations(w.id)));
            section("lorebook", worlds.flatMap((w) => listLorebook(w.id)));
            section("relations", worlds.flatMap((w) => listRelations(w.id)));
            section("scenarios", listScenarios());
            section("cards", listCards());
            section("personas", listPersonas());
            // conversations + parsed columns, one party at a time
            send(`"conversations":[`);
            const convs = listConversations();
            convs.forEach((c, i) => {
              let cast: unknown = [];
              let settings: unknown = {};
              try { cast = JSON.parse(c.cast); } catch { /* ignore */ }
              try { settings = JSON.parse(c.settings); } catch { /* ignore */ }
              // parse the JSON-stringified columns (segments, meta) so the
              // backup file is clean JSON — restoring it must not
              // double-encode them
              const row = { ...c, cast, settings, messages: listMessages(c.id).map(messageView) };
              collectMediaUrls(row, urls);
              if (i) send(",");
              send(JSON.stringify(row));
            });
            send("],");
            section("timeline_events", worlds.flatMap((w) => listTimeline(w.id)));
            // self-contained media: embed every referenced illustration /
            // avatar as base64, one file at a time
            send(`"media":{`);
            let first = true;
            for (const u of urls) {
              const file = mediaFileFor(u);
              if (!file) continue;
              try {
                const st = fs.statSync(file);
                if (!st.isFile()) continue;
                const b64 = fs.readFileSync(file).toString("base64");
                if (!first) send(",");
                first = false;
                send(`${JSON.stringify(u)}:${JSON.stringify(b64)}`);
              } catch { /* vanished between scan and read */ }
            }
            send("}}");
            controller.close();
          } catch (e) {
            controller.error(e);
          }
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
