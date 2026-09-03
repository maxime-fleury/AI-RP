/**
 * Daily SQLite backups + storage reporting.
 *
 * Copying the DB file while Bun's :memory: is not an issue — bun:sqlite
 * persists to data/app.db and a simple file copy at a quiet moment is safe
 * enough for a single-user app. We keep 7 rotated copies.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, IMAGES_DIR, UPLOADS_DIR, DB_PATH } from "./paths";
import { db, listConversations, listMessages, listWorlds, listCards, listPersonas } from "./db";

const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const KEEP = 7; // calendar-day snapshots kept
const KEEP_FORCED = 14; // extra safety-net snapshots kept (they can pile up)

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
      // checksum status: the .sha256 sidecar is verified against the file
      let checksumOk = false;
      try {
        const want = fs.readFileSync(full + ".sha256", "utf8").trim();
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(fs.readFileSync(full));
        checksumOk = hasher.digest("hex") === want;
      } catch { /* no sidecar yet */ }
      return {
        file: f,
        size: st.size,
        date: st.mtime.toISOString(),
        ageMs: Math.max(0, Date.now() - st.mtime.getTime()),
        checksumOk,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    imagesMB: +(dirSize(IMAGES_DIR) / 1e6).toFixed(1),
    uploadsMB: +(dirSize(UPLOADS_DIR) / 1e6).toFixed(1),
    dbMB: +(dirSize(DB_PATH) / 1e6).toFixed(1),
    backups,
  };
}

// ─── orphan file analysis & purge (Réglages → Stockage) ─────────────────────
export interface OrphanFile {
  path: string; // URL-style path (/images/…, /uploads/…)
  file: string;
  size: number;
  kind: "image" | "upload";
}

/**
 * Scan the media dirs for files not referenced by any row in the DB
 * (deleted messages, replaced avatars, test clips…).
 * Pure analysis — nothing is deleted here (the "simulation" step).
 */
export function analyzeOrphans(): { orphans: OrphanFile[]; orphanCount: number; totalMB: number } {
  const referenced = new Set<string>();
  const norm = (p: string) => (p.startsWith("/") ? p : "/" + p);
  for (const c of listConversations()) {
    for (const m of listMessages(c.id)) {
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
    if (url.startsWith("/images/")) { root = IMAGES_DIR; rel = url.slice("/images/".length); }
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

/**
 * Run a backup now. The daily scheduled copy is idempotent (one per calendar
 * day); forced copies (manual backup + the pre-action safety nets around
 * import / purge / rewind) always write a NEW file, so two operations on the
 * same day each keep their own pre-state snapshot instead of overwriting it.
 */
export function runBackup(force = false): string | null {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) return null;
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let base = `app-${stamp}`;
  if (force) {
    for (let n = 1; n < 1000; n++) {
      if (!fs.existsSync(path.join(BACKUPS_DIR, `${base}.db`))) break;
      base = `app-${stamp}-${String(n).padStart(3, "0")}`;
    }
  }
  const dest = path.join(BACKUPS_DIR, `${base}.db`);
  if (fs.existsSync(dest) && !force) return null;
  try {
    // VACUUM INTO writes a consistent snapshot (committed WAL data included)
    // into a fresh file, so a busy/locked live connection can never yield a
    // truncated backup. Write to a temp file, then rename atomically.
    const tmp = dest + ".tmp";
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    fs.renameSync(tmp, dest);
    // checksum sidecar so a restore can verify integrity
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(fs.readFileSync(dest));
    fs.writeFileSync(dest + ".sha256", hasher.digest("hex"));
  } catch (e) {
    console.error("[backup] failed:", e);
    return null;
  }
  // rotation: daily copies keep KEEP calendar days; forced safety-net
  // snapshots (multiple per day possible) keep the most recent ones
  const files = fs.readdirSync(BACKUPS_DIR).filter((f) => f.endsWith(".db"));
  const isDaily = (f: string) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f);
  const prune = (f: string) => {
    for (const suffix of ["", ".sha256"]) {
      try { fs.unlinkSync(path.join(BACKUPS_DIR, f + suffix)); } catch { /* ignore */ }
    }
  };
  for (const f of files.filter(isDaily).sort().reverse().slice(KEEP)) prune(f);
  for (const f of files.filter((f) => !isDaily(f)).sort().reverse().slice(KEEP_FORCED)) prune(f);
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