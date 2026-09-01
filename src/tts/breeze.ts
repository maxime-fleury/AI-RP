/**
 * Breeze TTS 2 client. Spawns the Python sidecar (PyTorch + CUDA) on demand,
 * waits for it to be healthy, then synthesizes text to PCM via an HTTP call.
 *
 * Breeze has no fixed voice embeddings — each "voice" is a voice-design
 * instruction (a natural-language description of the speaker). The app maps
 * editable voice presets (name → instruction) to Breeze requests.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BREEZE_DIR, MODELS_DIR } from "../server/paths";

const PORT = 8771;
const BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_MODEL = path.join(MODELS_DIR, "Breeze-TTS-2");

let proc: ChildProcess | null = null;
let ready = false;
let loading = false;
let lastError = "";

export interface BreezeStatus {
  running: boolean;
  ready: boolean;
  loading: boolean;
  error: string;
  sampleRate: number;
}

export function breezeStatus(): BreezeStatus {
  return { running: proc !== null, ready, loading, error: lastError, sampleRate: 0 };
}

function pythonExecutable(): string {
  const candidates = [
    path.join(BREEZE_DIR, ".venv", "Scripts", "python.exe"),
    path.join(BREEZE_DIR, ".venv", "bin", "python"),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c);
      return c;
    } catch { /* try next */ }
  }
  return "python";
}

/** Probe the sidecar live (it may have been started externally). */
export async function probeBreezeStatus(): Promise<BreezeStatus> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const j = (await r.json()) as { status?: string; error?: string; sample_rate?: number };
      ready = j.status === "ready";
      return {
        running: true,
        ready,
        loading: j.status === "loading",
        error: j.error ?? "",
        sampleRate: j.sample_rate ?? 0,
      };
    }
  } catch {
    /* not running */
  }
  return breezeStatus();
}

export async function ensureBreezeServer(timeoutMs = 600_000): Promise<boolean> {
  if (ready) return true;
  // Already running (started externally)?
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const j = (await r.json()) as { status?: string };
      ready = j.status === "ready";
      if (ready) loading = false;
      return ready;
    }
  } catch {
    /* not running */
  }
  if (!proc) {
    lastError = "";
    loading = true;
    const py = pythonExecutable();
    const server = path.join(BREEZE_DIR, "server.py");
    console.log(`[breeze] spawning: ${py} ${server} (port ${PORT})`);
    proc = spawn(py, [server, "--port", String(PORT)], {
      cwd: BREEZE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => process.stdout.write(`[breeze] ${String(d)}`));
    proc.stderr?.on("data", (d) => process.stderr.write(`[breeze] ${String(d)}`));
    proc.on("exit", (code) => {
      console.log(`[breeze] server exited (${code})`);
      proc = null;
      ready = false;
      loading = false;
    });
    proc.on("error", (e) => {
      lastError = String(e);
      console.error("[breeze] spawn error:", e);
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
        if (j.status === "error") {
          lastError = j.error ?? "Erreur du serveur Breeze.";
          ready = false;
          loading = false;
          return false;
        }
      }
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  loading = false;
  lastError = "Le serveur Breeze n'a pas démarré à temps (chargement du modèle ~1-2 min).";
  return false;
}

export interface BreezeRequest {
  text: string;
  instruction: string;
  seed?: number;
}

export interface BreezeResult {
  pcm: Float32Array;
  sampleRate: number;
  durationMs: number;
}

/** Decode a WAV returned by the sidecar into float32 PCM. */
function wavToPcm(wav: Uint8Array): { pcm: Float32Array; sampleRate: number } {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const byteRate = view.getUint32(28, true);
  const channels = view.getUint16(22, true);
  const bits = view.getUint16(34, true);
  const dataOffset = 44;
  const n = (wav.byteLength - dataOffset) / (bits / 8);
  const pcm = new Float32Array(n);
  if (bits === 16) {
    for (let i = 0; i < n; i++) pcm[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
  } else if (bits === 32) {
    for (let i = 0; i < n; i++) pcm[i] = view.getFloat32(dataOffset + i * 4, true);
  }
  const mono = channels > 1 ? decimateStereo(pcm, channels) : pcm;
  return { pcm: mono, sampleRate: channels > 1 ? byteRate / (channels * (bits / 8)) : byteRate / (bits / 8) };
}

function decimateStereo(pcm: Float32Array, channels: number): Float32Array {
  const out = new Float32Array(pcm.length / channels);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[i * channels + c];
    out[i] = sum / channels;
  }
  return out;
}

export async function synthesizeBreeze(req: BreezeRequest): Promise<BreezeResult> {
  if (!(await ensureBreezeServer())) throw new Error(lastError || "Serveur Breeze indisponible.");
  const res = await fetch(`${BASE}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: req.text,
      instruction: req.instruction,
      seed: req.seed ?? 42,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Breeze (${res.status}): ${text.slice(0, 300)}`);
  }
  const j = (await res.json()) as Partial<{ wav_base64: string; sample_rate: number; duration_ms: number }>;
  if (typeof j.wav_base64 !== "string") {
    throw new Error("Réponse inattendue du serveur Breeze.");
  }
  const wav = Uint8Array.from(atob(j.wav_base64), (c) => c.charCodeAt(0));
  const { pcm, sampleRate } = wavToPcm(wav);
  return { pcm, sampleRate, durationMs: j.duration_ms ?? Math.round((pcm.length / sampleRate) * 1000) };
}

/** Is the model present on disk? */
export function breezeModelPresent(): boolean {
  try {
    return fs.existsSync(path.join(DEFAULT_MODEL, "config.json"));
  } catch {
    return false;
  }
}

export function stopBreezeServer(): void {
  if (proc) {
    try { proc.kill(); } catch { /* ignore */ }
    proc = null;
    ready = false;
  }
}