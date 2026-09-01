import fs from "node:fs";
import path from "node:path";
import { handleApi } from "./server/routes";
import { PUBLIC_DIR, AUDIO_DIR, IMAGES_DIR, UPLOADS_DIR, DATA_DIR, SAMPLES_DIR } from "./server/paths";
import { warmupTts } from "./tts/service";
import { ensureImageServer } from "./server/image";
import { getSetting, cleanupStaleJobs } from "./server/db";
import { scheduleDailyBackup } from "./server/backup";

const NAME = "ai-rp";
const MIN_PORT = 3000;
const MAX_PORT = 3600;
const EXCLUDED = new Set([8000]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function serveFile(filePath: string, rootDir?: string): Response | null {
  let resolved: string;
  try {
    resolved = path.resolve(filePath);
    if (rootDir) {
      const root = path.resolve(rootDir);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    }
  } catch {
    return null;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  const ext = path.extname(resolved).toLowerCase();
  const body = new Uint8Array(fs.readFileSync(resolved));
  return new Response(body, {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": [".html", ".js", ".css"].includes(ext) ? "no-cache" : "public, max-age=3600",
    },
  });
}

function handler(req: Request): Response {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p.startsWith("/api/")) return handleApi(req, url);

  // static data dirs
  if (p.startsWith("/audio/")) {
    const file = serveFile(path.join(AUDIO_DIR, p.slice("/audio/".length)), AUDIO_DIR);
    if (file) return file;
    return new Response("not found", { status: 404 });
  }
  if (p.startsWith("/images/")) {
    const file = serveFile(path.join(IMAGES_DIR, p.slice("/images/".length)), IMAGES_DIR);
    if (file) return file;
    return new Response("not found", { status: 404 });
  }
  if (p.startsWith("/samples/")) {
    const file = serveFile(path.join(SAMPLES_DIR, p.slice("/samples/".length)), SAMPLES_DIR);
    if (file) return file;
    return new Response("not found", { status: 404 });
  }
  if (p.startsWith("/uploads/")) {
    const file = serveFile(path.join(UPLOADS_DIR, p.slice("/uploads/".length)), UPLOADS_DIR);
    if (file) return file;
    return new Response("not found", { status: 404 });
  }

  // static app files
  if (p !== "/") {
    const rel = p.replace(/^\/+/, "");
    const file = serveFile(path.join(PUBLIC_DIR, rel), PUBLIC_DIR);
    if (file) return file;
  }
  // SPA fallback
  const index = serveFile(path.join(PUBLIC_DIR, "index.html"));
  if (index) return index;
  return new Response(`Hello from ${NAME}! (front-end missing at ${PUBLIC_DIR})`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function findAvailablePort(start: number, end: number) {
  const pinned = Number(process.env.PORT);
  const from = Number.isInteger(pinned) && pinned >= 1 && pinned <= 65535 ? pinned : start;
  const to = Number.isInteger(pinned) ? pinned : end;
  for (let port = from; port <= to; port++) {
    if (EXCLUDED.has(port)) continue;
    try {
      return Bun.serve({ port, fetch: handler, idleTimeout: 255 });
    } catch {
      console.log(`  port ${port} busy — trying ${port + 1}…`);
    }
  }
  return null;
}

const server = findAvailablePort(MIN_PORT, MAX_PORT);
if (!server) {
  console.error(`No free port between ${MIN_PORT} and ${MAX_PORT} — giving up.`);
  process.exit(1);
}
const port = server.port;
console.log(`🟤 ${NAME} running → http://localhost:${port}`);

// Warm up the TTS in the background so the first voice is ready quickly.
warmupTts().catch((e) => console.warn("[tts] warmup failed:", e));

// Optional: pre-spawn the Python image sidecar so the first illustration is fast.
if (getSetting("image_preload", false)) {
  ensureImageServer().then((ok) => console.log(`[image] preload ${ok ? "ready" : "failed — first generation will load it"}`));
}

for (const d of [DATA_DIR]) fs.mkdirSync(d, { recursive: true });
scheduleDailyBackup();

// mark jobs left dangling by a previous crash as failed (no zombies in the queue)
const cleaned = cleanupStaleJobs();
if (cleaned) console.log(`[jobs] ${cleaned} tâche(s) interrompue(s) marquée(s) comme échouées`);

export default server;