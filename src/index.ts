import fs from "node:fs";
import path from "node:path";
import { handleApi } from "./server/routes";
import { PUBLIC_DIR, IMAGES_DIR, UPLOADS_DIR, DATA_DIR } from "./server/paths";
import { ensureImageServer } from "./server/image";
import { getSetting, cleanupStaleJobs } from "./server/db";
import { scheduleDailyBackup } from "./server/backup";

const NAME = "innsekai";
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
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** Decode a percent-encoded request path (browsers encode non-ASCII names
 * like "adèle" → "ad%C3%A8le"); falls back to the raw string on garbage. */
function decodeRel(rel: string): string {
  try {
    return decodeURIComponent(rel);
  } catch {
    return rel;
  }
}

/**
 * Static file serving with real validators (ETag + Last-Modified) so the
 * hand-rolled ?v= cache busting can die: mutable assets (.html/.js/.css) are
 * served `no-cache` (always revalidated → 304 when unchanged, fresh bytes the
 * moment a file changes), immutable media keeps a 1 h max-age and revalidates.
 */
function serveFile(filePath: string, rootDir?: string, req?: Request): Response | null {
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
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const ext = path.extname(resolved).toLowerCase();
  const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
  const lastModified = st.mtime.toUTCString();
  const cacheControl = [".html", ".js", ".css"].includes(ext) ? "no-cache" : "public, max-age=3600";
  const validators = { ETag: etag, "Last-Modified": lastModified, "Cache-Control": cacheControl };
  if (req) {
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: validators });
    const ims = req.headers.get("if-modified-since");
    if (ims && new Date(ims).getTime() >= Math.floor(st.mtimeMs / 1000) * 1000) {
      return new Response(null, { status: 304, headers: validators });
    }
  }
  const body = new Uint8Array(fs.readFileSync(resolved));
  return new Response(body, {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      ...validators,
    },
  });
}

// Set by findAvailablePort once the server is up; needed to lift the per-
// connection idle timeout on SSE streams (Bun counts a quiet SSE stream as
// idle and closes it after `idleTimeout` seconds — mid-generation).
let httpServer: Bun.Server<undefined> | null = null;

async function handleApiRequest(req: Request, url: URL): Promise<Response> {
  const res = await handleApi(req, url);
  // Long generations can stream for minutes; without this, Bun closes the
  // connection at idleTimeout (255s) and the reply is cut off mid-word. Only
  // streaming responses get the exemption, regular requests keep the timeout.
  if (httpServer && (res.headers.get("content-type") || "").includes("text/event-stream")) {
    httpServer.timeout(req, 0);
  }
  return res;
}

function handler(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p.startsWith("/api/")) return handleApiRequest(req, url);

  // static data dirs
  if (p.startsWith("/images/")) {
    const file = serveFile(path.join(IMAGES_DIR, decodeRel(p.slice("/images/".length))), IMAGES_DIR, req);
    if (file) return file;
    return new Response("not found", { status: 404 });
  }
  if (p.startsWith("/uploads/")) {
    const file = serveFile(path.join(UPLOADS_DIR, decodeRel(p.slice("/uploads/".length))), UPLOADS_DIR, req);
    if (file) return file;
    return new Response("not found", { status: 404 });
  }

  // static app files
  if (p !== "/") {
    const rel = decodeRel(p.replace(/^\/+/, ""));
    const file = serveFile(path.join(PUBLIC_DIR, rel), PUBLIC_DIR, req);
    if (file) return file;
  }
  // SPA fallback
  const index = serveFile(path.join(PUBLIC_DIR, "index.html"), undefined, req);
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
      const s = Bun.serve({ port, fetch: handler, idleTimeout: 255 });
      httpServer = s;
      return s;
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

// Optional: pre-spawn the Python image sidecar so the first illustration is fast.
if (getSetting("image_preload", false)) {
  ensureImageServer()
    .then((ok) => console.log(`[image] preload ${ok ? "ready" : "failed — first generation will load it"}`))
    .catch((e) => console.log(`[image] preload failed: ${String((e as Error)?.message || e)}`));
}

for (const d of [DATA_DIR]) fs.mkdirSync(d, { recursive: true });
scheduleDailyBackup();

// mark jobs left dangling by a previous crash as failed (no zombies in the queue)
const cleaned = cleanupStaleJobs();
if (cleaned) console.log(`[jobs] ${cleaned} tâche(s) interrompue(s) marquée(s) comme échouées`);

export default server;