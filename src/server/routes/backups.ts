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
      const conversations = listConversations().map((c) => {
        let cast: unknown = [];
        let settings: unknown = {};
        try { cast = JSON.parse(c.cast); } catch { /* ignore */ }
        try { settings = JSON.parse(c.settings); } catch { /* ignore */ }
        // parse the JSON-stringified columns (segments, meta) so the backup file
        // is clean JSON — restoring it must not double-encode them
        return { ...c, cast, settings, messages: listMessages(c.id).map(messageView) };
      });
      const payload: any = {
        app: "innsekai",
        version: 1,
        exported_at: new Date().toISOString(),
        worlds: listWorlds(),
        locations: listWorlds().flatMap((w) => listLocations(w.id)),
        lorebook: listWorlds().flatMap((w) => listLorebook(w.id)),
        relations: listWorlds().flatMap((w) => listRelations(w.id)),
        scenarios: listScenarios(),
        cards: listCards(),
        personas: listPersonas(),
        conversations,
        timeline_events: listWorlds().flatMap((w) => listTimeline(w.id)),
      };
      // make the export self-contained: embed every referenced illustration /
      // avatar as base64, so a restore brings the images back too
      const urls = new Set<string>();
      collectMediaUrls(payload, urls);
      const media: Record<string, string> = {};
      for (const u of urls) {
        const file = mediaFileFor(u);
        if (!file) continue;
        try {
          const st = fs.statSync(file);
          if (!st.isFile()) continue;
          media[u] = fs.readFileSync(file).toString("base64");
        } catch { /* vanished between scan and read */ }
      }
      if (Object.keys(media).length) payload.media = media;
      return json(payload);
    }

    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
