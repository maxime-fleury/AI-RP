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

/** Run a backup now (idempotent per day — one copy per calendar day). */
export function runBackup(force = false): string | null {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) return null;
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest = path.join(BACKUPS_DIR, `app-${stamp}.db`);
  if (fs.existsSync(dest) && !force) return null;
  try {
    fs.copyFileSync(DB_PATH, dest);
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