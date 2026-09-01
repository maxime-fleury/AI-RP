/**
 * Daily SQLite backups + storage reporting.
 *
 * Copying the DB file while Bun's :memory: is not an issue — bun:sqlite
 * persists to data/app.db and a simple file copy at a quiet moment is safe
 * enough for a single-user app. We keep 7 rotated copies.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, AUDIO_DIR, IMAGES_DIR, UPLOADS_DIR, DB_PATH } from "./paths";
import { db, listConversations, listMessages, listWorlds, listCards, listPersonas } from "./db";

const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const KEEP = 7;

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  // a plain file (the SQLite db) counts its own size
  if (fs.statSync(dir).isFile()) return fs.statSync(dir).size;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

export function storageInfo() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const backups = fs
    .readdirSync(BACKUPS_DIR)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const full = path.join(BACKUPS_DIR, f);
      const st = fs.statSync(full);
      return { file: f, size: st.size, date: st.mtime.toISOString() };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    audioMB: +(dirSize(AUDIO_DIR) / 1e6).toFixed(1),
    imagesMB: +(dirSize(IMAGES_DIR) / 1e6).toFixed(1),
    uploadsMB: +(dirSize(UPLOADS_DIR) / 1e6).toFixed(1),
    dbMB: +(dirSize(DB_PATH) / 1e6).toFixed(1),
    backups,
  };
}

// ─── orphan file analysis & purge (Réglages → Stockage) ─────────────────────
export interface OrphanFile {
  path: string; // URL-style path (/audio/…, /images/…, /uploads/…)
  file: string;
  size: number;
  kind: "audio" | "image" | "upload";
}

/**
 * Scan the media dirs for files not referenced by any row in the DB
 * (deleted messages, replaced avatars, regenerated audio, test clips…).
 * Pure analysis — nothing is deleted here (the "simulation" step).
 */
export function analyzeOrphans(): { orphans: OrphanFile[]; orphanCount: number; totalMB: number } {
  const referenced = new Set<string>();
  const norm = (p: string) => (p.startsWith("/") ? p : "/" + p);
  for (const c of listConversations()) {
    for (const m of listMessages(c.id)) {
      try {
        for (const a of JSON.parse(m.audio || "[]") as any[]) if (a?.path) referenced.add(norm(String(a.path)));
      } catch { /* ignore */ }
      try {
        const meta = JSON.parse(m.meta || "{}") as any;
        if (meta?.image) referenced.add(norm(String(meta.image)));
      } catch { /* ignore */ }
    }
  }
  for (const w of listWorlds()) {
    if (w.cover) referenced.add(norm(w.cover));
    if (w.map) referenced.add(norm(w.map));
  }
  for (const c of listCards()) if (c.avatar) referenced.add(norm(c.avatar));
  for (const p of listPersonas()) if (p.avatar) referenced.add(norm(p.avatar));

  const orphans: OrphanFile[] = [];
  const scan = (root: string, prefix: string, kind: OrphanFile["kind"]) => {
    if (!fs.existsSync(root)) return;
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          const url = norm(prefix + path.relative(root, full).split(path.sep).join("/"));
          if (referenced.has(url)) continue;
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          orphans.push({ path: url, file: e.name, size: st.size, kind });
        }
      }
    };
    walk(root);
  };
  scan(AUDIO_DIR, "/audio/", "audio");
  scan(IMAGES_DIR, "/images/", "image");
  scan(UPLOADS_DIR, "/uploads/", "upload");
  orphans.sort((a, b) => b.size - a.size);
  const totalMB = +(orphans.reduce((acc, o) => acc + o.size, 0) / 1e6).toFixed(1);
  return { orphans, orphanCount: orphans.length, totalMB };
}

/** Delete a list of orphan URL paths (must stay inside the media roots). */
export function purgeOrphans(files: string[]): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;
  for (const url of files) {
    let root: string;
    let rel: string;
    if (url.startsWith("/audio/")) { root = AUDIO_DIR; rel = url.slice("/audio/".length); }
    else if (url.startsWith("/images/")) { root = IMAGES_DIR; rel = url.slice("/images/".length); }
    else if (url.startsWith("/uploads/")) { root = UPLOADS_DIR; rel = url.slice("/uploads/".length); }
    else continue;
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) continue; // confinement
    try {
      const st = fs.statSync(resolved);
      if (!st.isFile()) continue;
      fs.unlinkSync(resolved);
      bytes += st.size;
      removed++;
    } catch { /* already gone */ }
  }
  return { removed, bytes };
}

// ─── cache analysis & purge (Réglages → Stockage) ────────────────────────────
// Audio cache = every generated .wav (fully regenerable from message text — safe
// to delete). Images are NOT regenerable, so only unreferenced ones are offered.
export function cacheInfo(): { audio: { files: number; mb: number }; imageOrphans: { files: number; mb: number } } {
  let audioFiles = 0;
  let audioBytes = 0;
  if (fs.existsSync(AUDIO_DIR)) {
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && e.name.endsWith(".wav")) {
          try { const st = fs.statSync(full); audioFiles++; audioBytes += st.size; } catch { /* ignore */ }
        }
      }
    };
    walk(AUDIO_DIR);
  }
  const imgOrphans = analyzeOrphans().orphans.filter((o) => o.kind === "image");
  const imgBytes = imgOrphans.reduce((a, o) => a + o.size, 0);
  return {
    audio: { files: audioFiles, mb: +(audioBytes / 1e6).toFixed(1) },
    imageOrphans: { files: imgOrphans.length, mb: +(imgBytes / 1e6).toFixed(1) },
  };
}

/** Delete every generated .wav (regenerated on demand from message text). */
export function purgeAudioCache(): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;
  if (!fs.existsSync(AUDIO_DIR)) return { removed, bytes };
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".wav")) {
        try { const st = fs.statSync(full); fs.unlinkSync(full); removed++; bytes += st.size; } catch { /* ignore */ }
      }
    }
  };
  walk(AUDIO_DIR);
  return { removed, bytes };
}

/** Run a backup now (idempotent per day — one copy per calendar day). */
export function runBackup(force = false): string | null {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) return null;
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest = path.join(BACKUPS_DIR, `app-${stamp}.db`);
  if (fs.existsSync(dest) && !force) return null;
  try {
    // flush the WAL into the main DB so the copy is complete even mid-write
    try { db.query("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch { /* busy — proceed */ }
    // atomic: write a temp file, then rename over the destination
    const tmp = dest + ".tmp";
    fs.copyFileSync(DB_PATH, tmp);
    fs.renameSync(tmp, dest);
    // checksum sidecar so a restore can verify integrity
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(fs.readFileSync(DB_PATH));
    fs.writeFileSync(dest + ".sha256", hasher.digest("hex"));
  } catch (e) {
    console.error("[backup] failed:", e);
    return null;
  }
  // rotation: keep only the KEEP most recent
  const files = fs
    .readdirSync(BACKUPS_DIR)
    .filter((f) => f.endsWith(".db"))
    .sort()
    .reverse();
  for (const f of files.slice(KEEP)) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); } catch { /* ignore */ }
  }
  console.log(`[backup] saved ${path.basename(dest)}`);
  return dest;
}

/** Schedule a daily backup (startup + every 24h). Never throws. */
export function scheduleDailyBackup(): void {
  try { runBackup(); } catch (e) { console.error("[backup] startup:", e); }
  setInterval(() => {
    try { runBackup(); } catch (e) { console.error("[backup] daily:", e); }
  }, 24 * 60 * 60 * 1000).unref?.();
}