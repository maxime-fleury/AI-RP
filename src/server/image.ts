/**
 * Image generation client. Spawns the Python sidecar (diffusers + Koji) on
 * demand, waits for it to be healthy, then proxies generation requests.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PYTHON_DIR, IMAGES_DIR } from "./paths";

const PORT = 8770;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess | null = null;
let ready = false;
let loading = false;
let lastError = "";

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

export async function ensureImageServer(timeoutMs = 300_000): Promise<boolean> {
  if (ready) return true;
  // Already running (started externally)?
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const j = (await r.json()) as { status?: string };
      ready = j.status === "ready";
      return ready;
    }
  } catch {
    /* not running */
  }
  if (!proc) {
    lastError = "";
    loading = true;
    const py = pythonExecutable();
    const server = path.join(PYTHON_DIR, "server.py");
    console.log(`[image] spawning: ${py} ${server} (port ${PORT})`);
    proc = spawn(py, [server, "--port", String(PORT)], {
      cwd: PYTHON_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => process.stdout.write(`[image] ${String(d)}`));
    proc.stderr?.on("data", (d) => process.stderr.write(`[image] ${String(d)}`));
    proc.on("exit", (code) => {
      console.log(`[image] server exited (${code})`);
      proc = null;
      ready = false;
      loading = false;
    });
    proc.on("error", (e) => {
      lastError = String(e);
      console.error("[image] spawn error:", e);
      proc = null;
      loading = false;
    });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!proc) return false;
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = (await r.json()) as { status?: string };
        if (j.status === "ready") {
          ready = true;
          loading = false;
          return true;
        }
      }
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  loading = false;
  lastError = "Le serveur d'images n'a pas démarré à temps (chargement du modèle Koji très long ?).";
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

export async function generateImage(req: ImageRequest): Promise<ImageResult> {
  if (!(await ensureImageServer())) throw new Error(lastError || "Serveur d'images indisponible.");
  const res = await fetch(`${BASE}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
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

export async function generateAndSave(
  subdir: string,
  req: ImageRequest,
): Promise<SavedImage> {
  const res = await generateImage(req);
  const dir = path.join(IMAGES_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(res.image_base64, "base64"));
  return { url: `/images/${subdir}/${path.basename(file)}`, seed: res.seed, ms: res.ms };
}

export function stopImageServer(): void {
  if (proc) {
    try { proc.kill(); } catch { /* ignore */ }
    proc = null;
    ready = false;
  }
}