/**
 * Image generation client. Spawns the Python sidecar (diffusers + Koji) on
 * demand, waits for it to be healthy, then proxies generation requests.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PYTHON_DIR, IMAGES_DIR } from "./paths";
import { combineSignals } from "./signal";

const PORT = 8770;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess | null = null;
let ready = false;
let loading = false;
let lastError = "";
let ensurePromise: Promise<boolean> | null = null;

export interface ImageStatus {
  running: boolean;
  ready: boolean;
  loading: boolean;
  error: string;
}

export function imageStatus(): ImageStatus {
  return { running: proc !== null, ready, loading, error: lastError };
}

/** Probe the sidecar live (it may have been started externally). */
export async function probeImageStatus(): Promise<ImageStatus> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const j = (await r.json()) as { status?: string; error?: string };
      return { running: true, ready: j.status === "ready", loading: j.status === "loading", error: j.error ?? "" };
    }
  } catch {
    /* not running */
  }
  return imageStatus();
}

function pythonExecutable(): string {
  const candidates = [
    path.join(PYTHON_DIR, ".venv", "Scripts", "python.exe"),
    path.join(PYTHON_DIR, ".venv", "bin", "python"),
    "python",
  ];
  for (const c of candidates) {
    try {
      if (c.includes(path.sep) || c.includes("/")) {
        fs.accessSync(c);
        return c;
      }
      return "python";
    } catch {
      /* try next */
    }
  }
  return "python";
}

export function ensureImageServer(timeoutMs = 300_000): Promise<boolean> {
  if (ensurePromise) return ensurePromise;
  let wrapped: Promise<boolean>;
  wrapped = ensureImageServerOnce(timeoutMs).finally(() => {
    if (ensurePromise === wrapped) ensurePromise = null;
  });
  ensurePromise = wrapped;
  return wrapped;
}

async function ensureImageServerOnce(timeoutMs: number): Promise<boolean> {
  if (ready) return true;
  let waitingForExternal = false;
  // Already running (started externally)?
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const j = (await r.json()) as { status?: string; error?: string };
      if (j.status === "ready") {
        ready = true;
        loading = false;
        return true;
      }
      if (j.status === "error") {
        ready = false;
        loading = false;
        lastError = j.error || "Le serveur d'images a échoué à charger le modèle.";
        return false;
      }
      if (j.status === "loading") {
        // Do not spawn a second listener while an external sidecar is loading.
        waitingForExternal = true;
        loading = true;
      }
    }
  } catch {
    /* not running */
  }
  if (!proc && !waitingForExternal) {
    lastError = "";
    loading = true;
    const py = pythonExecutable();
    const server = path.join(PYTHON_DIR, "server.py");
    console.log(`[image] spawning: ${py} ${server} (port ${PORT})`);
    const child = spawn(py, [server, "--port", String(PORT)], {
      cwd: PYTHON_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      // the GPU is shared with the resident LLM: grow the CUDA arena in small
      // segments so renders can't fragment/claim VRAM the LLM needs back
      env: { ...process.env, PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True" },
    });
    proc = child;
    child.stdout?.on("data", (d) => process.stdout.write(`[image] ${String(d)}`));
    child.stderr?.on("data", (d) => process.stderr.write(`[image] ${String(d)}`));
    child.on("exit", (code) => {
      console.log(`[image] server exited (${code})`);
      // An old launcher may exit after stopImageServer has already started a
      // replacement. It must not clear the replacement's state.
      if (proc !== child) return;
      proc = null;
      ready = false;
      loading = false;
    });
    child.on("error", (e) => {
      lastError = String(e);
      console.error("[image] spawn error:", e);
      if (proc !== child) return;
      proc = null;
      ready = false;
      loading = false;
    });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!proc && !waitingForExternal) return false;
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = (await r.json()) as { status?: string; error?: string };
        if (j.status === "ready") {
          ready = true;
          loading = false;
          return true;
        }
        if (j.status === "error") {
          loading = false;
          lastError = j.error || "Le serveur d'images a échoué à charger le modèle.";
          stopImageServer();
          return false;
        }
      }
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  loading = false;
  lastError = waitingForExternal
    ? "Le serveur d'images externe n'est pas devenu prêt à temps."
    : "Le serveur d'images n'a pas démarré à temps (chargement du modèle Koji très long ?).";
  stopImageServer();
  return false;
}

export interface ImageRequest {
  prompt: string;
  negative?: string;
  steps?: number;
  cfg?: number;
  width?: number;
  height?: number;
  seed?: number;
  /** base64 PNG used as an img2img starting point (character portrait reference). */
  init_image?: string;
  /** how much to deviate from init_image (0 = keep, 1 = full redraw). */
  strength?: number;
}

export interface ImageResult {
  image_base64: string;
  seed: number;
  ms: number;
}

export async function generateImage(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
  if (!(await ensureImageServer())) throw new Error(lastError || "Serveur d'images indisponible.");
  // generous timeout: GPU inference can take minutes, but a wedged sidecar must
  // not hold the caller's connection open forever
  let res: Response;
  try {
    res = await fetch(`${BASE}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: combineSignals(signal, 300_000),
    });
  } catch (e) {
    // a user-initiated cancel is NOT a wedged sidecar: abort cleanly, do NOT
    // kill the Python server (that would force a full model reload for the
    // next request)
    if (signal?.aborted) throw new Error("Génération annulée");
    // network failure or watchdog timeout → the sidecar is likely wedged on a
    // tight GPU. Reset it NOW so the NEXT request spawns a fresh server instead
    // of every subsequent generation hanging on the dead one.
    console.error(`[image] génération interrompue (${String((e as Error)?.message ?? e).slice(0, 120)}) — redémarrage du serveur d'images`);
    stopImageServer();
    throw new Error("La génération d'image n'a pas répondu à temps — le serveur d'images a été relancé. Réessaie.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image (${res.status}): ${text.slice(0, 300)}`);
  }
  const j = (await res.json()) as Partial<ImageResult>;
  if (typeof j.image_base64 !== "string") {
    console.error("[image] unexpected sidecar response:", Object.keys(j));
    throw new Error("Réponse inattendue du serveur d'images.");
  }
  return j as ImageResult;
}

export interface SavedImage {
  url: string;
  seed: number;
  ms: number;
}

/**
 * Deterministic cache key for a seed-pinned generation. Seed + every prompt/
 * render parameter (and a fingerprint of the img2img source) must all match,
 * so only identical re-renders hit the cache — variations and „🔒 même seed“
 * rerolls (which append a variation clause) keep distinct keys.
 */
export function cacheKeyFor(subdir: string, req: ImageRequest): string {
  const h = createHash("sha256");
  h.update([
    subdir,
    req.prompt,
    req.negative ?? "",
    String(req.steps ?? 28),
    String(req.cfg ?? 7),
    String(req.width ?? 0),
    String(req.height ?? 0),
    String(req.seed ?? ""),
    String(req.strength ?? ""),
    req.init_image ? createHash("sha256").update(req.init_image).digest("hex") : "",
  ].join("\u001f"));
  return h.digest("hex").slice(0, 24);
}

export async function generateAndSave(
  subdir: string,
  req: ImageRequest,
  signal?: AbortSignal,
): Promise<SavedImage> {
  const dir = path.join(IMAGES_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  // GPU cache: a seed-pinned request with identical inputs is deterministic,
  // so reuse the already-rendered PNG instead of burning GPU time again.
  if (req.seed != null) {
    const key = cacheKeyFor(subdir, req);
    const hit = path.join(dir, `${key}.png`);
    if (fs.existsSync(hit)) {
      return { url: `/images/${subdir}/${key}.png`, seed: req.seed, ms: 0 };
    }
    const res = await generateImage(req, signal);
    fs.writeFileSync(path.join(dir, `${key}.png`), Buffer.from(res.image_base64, "base64"));
    return { url: `/images/${subdir}/${key}.png`, seed: res.seed, ms: res.ms };
  }
  const res = await generateImage(req, signal);
  const file = path.join(dir, `${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(res.image_base64, "base64"));
  return { url: `/images/${subdir}/${path.basename(file)}`, seed: res.seed, ms: res.ms };
}

/**
 * Kill the whole sidecar process TREE. On Windows the venv python is a launcher
 * that spawns the real interpreter as a child — killing only the launcher used
 * to orphan the listener holding port 8770, so every later spawn failed to bind
 * (winerror 10013) while the wedged orphan kept answering /health.
 */
function killProcTree(p: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      p.kill("SIGKILL");
    }
  } catch {
    try { p.kill(); } catch { /* ignore */ }
  }
}

export function stopImageServer(): void {
  if (proc) {
    const child = proc;
    proc = null;
    killProcTree(child);
  }
  ready = false;
  loading = false;
}