/**
 * TTS service: routes segments (narration / characters) to voices, serializes
 * inference (ORT sessions are not thread-safe), and caches WAV files on disk.
 */
import fs from "node:fs";
import path from "node:path";
import { AUDIO_DIR, SAMPLES_DIR } from "../server/paths";
import { getSetting, getCard, listCards } from "../server/db";
import { synthesize, wavBytes, ensureTtsLoaded, type TtsLang } from "./engine";
import { synthesizeBreeze, ensureBreezeServer, breezeModelPresent } from "./breeze";
import { breezeVoiceByName, breezeVoiceList, isBreezeEngine, type TtsEngine } from "./breezeVoices";
import type { Segment } from "../llm/prompt";

export interface VoiceOption {
  name: string;
  lang: "fr" | "en";
  label: string;
  predefined: boolean;
  engine: TtsEngine;
}

export function listVoices(): VoiceOption[] {
  const out: VoiceOption[] = [];
  const seen = new Set<string>();
  const push = (v: VoiceOption) => {
    const key = `${v.engine}:${v.lang}:${v.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  for (const lang of ["fr", "en"] as const) {
    const dir = `${import.meta.dir}/../../models/Pocket-tts/${lang === "fr" ? "french_24l" : "english_2026-04"}/voices`;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".json")) {
          const name = f.slice(0, -5);
          push({ name, lang, label: `${name} (${lang === "fr" ? "FR" : "EN"})`, predefined: true, engine: "pocket" });
        }
      }
    } catch {
      /* no bundle voices */
    }
  }
  for (const v of breezeVoiceList()) {
    push({
      name: v.name,
      lang: v.lang,
      label: `${v.name} (Breeze · ${v.lang === "fr" ? "FR" : "EN"})`,
      predefined: true,
      engine: "breeze",
    });
  }
  return out;
}

/**
 * Async mutex for TTS synthesis — ORT sessions are not thread-safe.
 * Uses a proper queue pattern that handles errors correctly and never
 * leaks locked state.
 */
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  /** Acquire the mutex, run fn, then release. Rejects if fn rejects. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.locked) {
      this.locked = true;
      try {
        return await fn();
      } finally {
        this.locked = false;
        this.drain();
      }
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.locked = true;
        fn().then(
          (val) => {
            this.locked = false;
            this.drain();
            resolve(val);
          },
          (err) => {
            this.locked = false;
            this.drain();
            reject(err);
          },
        );
      });
    });
  }

  private drain(): void {
    if (!this.locked && this.queue.length) {
      const next = this.queue.shift()!;
      next();
    }
  }
}

const ttsMutex = new AsyncMutex();
export { ttsMutex };

/**
 * Synthesize (once, cached on disk) a short sample clip for a voice, used in
 * the settings to preview each voice. Returns the public URL path.
 */
export async function getVoiceSample(name: string, lang: TtsLang, engine: TtsEngine = "pocket"): Promise<string> {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  // names are user-editable (Breeze presets) — keep the file inside SAMPLES_DIR
  const safeName = name.replace(/[^\p{L}\p{N}_-]+/gu, "_");
  const fileName = `${engine}-${lang}-${safeName}.wav`;
  const file = path.join(SAMPLES_DIR, fileName);
  if (fs.existsSync(file)) return `/samples/${fileName}`;
  const text =
    lang === "fr"
      ? `Bonjour ! Moi c'est ${name}. Voilà ma voix pour tes histoires.`
      : `Hello! I'm ${name}. This is my voice for your stories.`;
  const FR_DEFAULT_INSTRUCTION = "Une voix claire, chaleureuse et naturelle, au débit posé et agréable.";
  const EN_DEFAULT_INSTRUCTION = "A clear, warm, natural voice with a pleasant, calm delivery.";
  let pcm: Float32Array;
  let sampleRate: number;
  if (engine === "breeze") {
    const preset = breezeVoiceByName(name, lang);
    const res = await ttsMutex.run(() =>
      synthesizeBreeze({
        text,
        instruction: preset?.instruction ?? (lang === "fr" ? FR_DEFAULT_INSTRUCTION : EN_DEFAULT_INSTRUCTION),
      }),
    );
    pcm = res.pcm;
    sampleRate = res.sampleRate;
  } else {
    const res = await ttsMutex.run(() => synthesize({ text, voice: name, lang, lsdSteps: 4 }));
    pcm = res.pcm;
    sampleRate = res.sampleRate;
  }
  fs.writeFileSync(file, wavBytes(pcm, sampleRate));
  return `/samples/${fileName}`;
}

export interface SynthAudio {
  type: string;
  speaker: string;
  path: string;
  voice: string;
  engine: TtsEngine;
  lang: TtsLang;
  durationMs: number;
  error?: string;
}

export interface TtsContext {
  narratorVoice: string;
  defaultVoice: string;
  language: TtsLang;
  engine: TtsEngine;
  characterVoices: Record<string, string>; // card name → voice
  characterLangs: Record<string, TtsLang>;
  lsdSteps: number;
}

export function buildTtsContext(conversation: { world_id: number | null; cast: string; settings?: string }): TtsContext {
  // per-conversation overrides (set from the ⚙️ modal of the party) win over globals
  let cs: Record<string, unknown> = {};
  try { cs = JSON.parse(conversation.settings || "{}"); } catch { /* ignore */ }
  const language = ((cs.tts_language as string) || (getSetting("tts_language", "fr") as string === "en" ? "en" : "fr")) as TtsLang;
  const engine = (isBreezeEngine(cs.tts_engine)
    ? cs.tts_engine
    : getSetting("tts_engine", "pocket") === "breeze"
      ? "breeze"
      : "pocket") as TtsEngine;
  const context: TtsContext = {
    narratorVoice: (cs.tts_voice_narrateur || getSetting("tts_voice_narrateur", "jean")) as string,
    defaultVoice: (cs.tts_voice_default || getSetting("tts_voice_default", "cosette")) as string,
    language,
    engine,
    characterVoices: {},
    characterLangs: {},
    lsdSteps: Number(cs.tts_lsd_steps ?? getSetting("tts_lsd_steps", 4)),
  };
  try {
    const cast: number[] = JSON.parse(conversation.cast || "[]");
    for (const id of cast) {
      const card = getCard(Number(id));
      if (!card) continue;
      if (card.voice) context.characterVoices[card.name.toLowerCase()] = card.voice;
      if (card.language === "en" || card.language === "fr") {
        context.characterLangs[card.name.toLowerCase()] = card.language as TtsLang;
      }
    }
  } catch {
    /* empty cast */
  }
  return context;
}

function resolveVoice(seg: Segment, ctx: TtsContext): { voice: string; lang: TtsLang; engine: TtsEngine } {
  if (seg.type === "narration" || !seg.speaker) {
    return { voice: ctx.narratorVoice, lang: ctx.language, engine: ctx.engine };
  }
  const key = seg.speaker.toLowerCase().trim();
  const voice = ctx.characterVoices[key] || ctx.defaultVoice;
  const lang = ctx.characterLangs[key] || ctx.language;
  return { voice, lang, engine: ctx.engine };
}

// ─── synthesis units ───────────────────────────────────────────────────────────
// Consecutive segments of the same speaker are merged into a single synthesis
// unit while they stay short — one model call instead of N, with a single
// intonation curve. Per-segment entries are kept in the output so the UI can
// still index audio, but merged-away segments hold an empty `path` (the player
// already skips those).
const MERGE_MAX_WORDS = 42;
const MERGE_MAX_SEGMENTS = 6;

interface SynthUnit {
  segments: Segment[];
  voice: string;
  lang: TtsLang;
  engine: TtsEngine;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function joinSegments(segs: Segment[]): string { // internal, exported for tests
  let out = "";
  for (const s of segs) {
    const t = s.text.trim();
    if (!out) { out = t; continue; }
    const last = out[out.length - 1];
    if (s.type === "dialogue" && !/[!?…\.]$/.test(out)) out += "… ";
    else if (last && !/[!?…\.\s]$/.test(out)) out += ". ";
    else out += " ";
    out += t;
  }
  return out;
}

export function buildUnits(segments: Segment[], ctx: TtsContext): SynthUnit[] { // internal, exported for tests
  const units: SynthUnit[] = [];
  let cur: Segment[] = [];
  let curVoice = "";
  let curLang: TtsLang = "fr";
  let curEngine: TtsEngine = "pocket";
  const flush = () => {
    if (!cur.length) return;
    units.push({ segments: cur, voice: curVoice, lang: curLang, engine: curEngine });
    cur = [];
  };
  for (const seg of segments) {
    const { voice, lang, engine } = resolveVoice(seg, ctx);
    const sameSpeaker =
      cur.length > 0 &&
      (cur[0].type === seg.type) &&
      (seg.type !== "dialogue" || cur[0].speaker === seg.speaker) &&
      curVoice === voice && curLang === lang && curEngine === engine;
    const words = cur.reduce((a, s) => a + wordCount(s.text), 0);
    if (sameSpeaker && words + wordCount(seg.text) <= MERGE_MAX_WORDS && cur.length < MERGE_MAX_SEGMENTS) {
      cur.push(seg);
    } else {
      flush();
      cur = [seg];
      curVoice = voice;
      curLang = lang;
      curEngine = engine;
    }
  }
  flush();
  return units;
}

/** Global LRU-ish disk cache: identical (voice, lang, lsd, text) → same wav.
 * Prevents re-synthesizing repeated lines (refrains, catchphrases) or after a
 * fork/regen when the files were copied but the pattern differs. Capped. */
const TTS_CACHE_DIR = path.join(AUDIO_DIR, "_cache");

function cacheKey(text: string, unit: SynthUnit, ctx: TtsContext): string {
  if (unit.engine === "breeze") {
    const preset = breezeVoiceByName(unit.voice, unit.lang);
    const salt = preset?.instruction ?? "";
    const h = Bun.CryptoHasher.hash("sha1", `breeze|${unit.voice}|${unit.lang}|${salt}|${text}`).hex();
    return path.join(TTS_CACHE_DIR, `${h}.wav`);
  }
  const h = Bun.CryptoHasher.hash("sha1", `pocket|${unit.voice}|${unit.lang}|${ctx.lsdSteps}|${text}`).hex();
  return path.join(TTS_CACHE_DIR, `${h}.wav`);
}

function unitText(unit: SynthUnit): string {
  return joinSegments(unit.segments);
}

async function cacheLookup(unit: SynthUnit, ctx: TtsContext): Promise<string | null> {
  try {
    const file = cacheKey(unitText(unit), unit, ctx);
    return fs.existsSync(file) ? file : null;
  } catch { return null; }
}

function cacheStore(from: string, unit: SynthUnit, ctx: TtsContext): void {
  try {
    fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
    const f = cacheKey(unitText(unit), unit, ctx);
    if (!fs.existsSync(f)) fs.copyFileSync(from, f);
  } catch { /* cache is best-effort */ }
}

/** Read a wav's duration (ms) from its header without decoding the PCM. */
export function durationOfWav(file: string): number {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF") return 0;
    const byteRate = b.readUInt32LE(28);
    const dataSize = b.readUInt32LE(40);
    return byteRate > 0 ? Math.round((dataSize / byteRate) * 1000) : 0;
  } catch { return 0; }
}

const placeholderFor = (seg: Segment, ctx: TtsContext): SynthAudio => {
  const { voice, lang, engine } = resolveVoice(seg, ctx);
  return { type: seg.type, speaker: seg.speaker, path: "", voice, engine, lang, durationMs: 0 };
};

/**
 * Synthesize the audio of a message's segments. Short segments are merged into
 * larger units; only the first `maxUnits` units are synthesized eagerly (the
 * rest are returned as placeholders and generated on demand when the user
 * presses play) — pass `forceAll` to synthesize everything now.
 */
export async function synthSegments(
  conversationId: number,
  messageId: number,
  segments: Segment[],
  ctx: TtsContext,
  existing: SynthAudio[] = [],
  opts: { forceAll?: boolean } = {},
): Promise<SynthAudio[]> {
  const results: SynthAudio[] = [];
  const dir = path.join(AUDIO_DIR, String(conversationId));
  fs.mkdirSync(dir, { recursive: true });
  const units = buildUnits(segments, ctx);
  const maxUnits = opts.forceAll
    ? Infinity
    : Math.max(1, Number(getSetting("tts_max_segments", 5)));
  let segIndex = 0;
  for (let u = 0; u < units.length; u++) {
    const unit = units[u];
    const firstSeg = unit.segments[0];
    const eager = u < maxUnits;
    // reuse a previously synthesized (merged) wav covering this unit
    const cached = existing[segIndex]?.path && fs.existsSync(existing[segIndex].path);
    if (cached) {
      for (let k = 0; k < unit.segments.length; k++) {
        const seg = unit.segments[k];
        results.push({ ...existing[segIndex], type: seg.type, speaker: seg.speaker, path: k === 0 ? existing[segIndex].path : "" });
      }
      segIndex += unit.segments.length;
      continue;
    }
    if (existing[segIndex]?.path) {
      // old-style per-segment wav: keep it, do not re-synthesise
      for (let k = 0; k < unit.segments.length; k++) {
        results.push({ ...existing[segIndex + k], path: existing[segIndex + k]?.path ?? "" });
      }
      segIndex += unit.segments.length;
      continue;
    }
    const file = path.join(dir, `${messageId}-${segIndex}.wav`);
    if (!eager) {
      // not part of the eager window → placeholder (synthesized on demand)
      for (const seg of unit.segments) results.push(placeholderFor(seg, ctx));
      segIndex += unit.segments.length;
      continue;
    }
    // global disk cache: same engine + speaker (+ instruction) + same line → same wav
    const cachedWav = await cacheLookup(unit, ctx);
    try {
      if (cachedWav) {
        fs.copyFileSync(cachedWav, file);
        const dur = durationOfWav(file);
        unit.segments.forEach((seg, k) => {
          results.push({
            type: seg.type,
            speaker: seg.speaker,
            path: k === 0 ? `/audio/${conversationId}/${messageId}-${segIndex}.wav` : "",
            voice: unit.voice,
            engine: unit.engine,
            lang: unit.lang,
            durationMs: k === 0 ? dur : 0,
          });
        });
        segIndex += unit.segments.length;
        continue;
      }
      const res = await ttsMutex.run(() => synthUnit(unit, ctx));
      fs.writeFileSync(file, wavBytes(res.pcm, res.sampleRate));
      cacheStore(file, unit, ctx);
      unit.segments.forEach((seg, k) => {
        results.push({
          type: seg.type,
          speaker: seg.speaker,
          path: k === 0 ? `/audio/${conversationId}/${messageId}-${segIndex}.wav` : "",
          voice: unit.voice,
          engine: unit.engine,
          lang: unit.lang,
          durationMs: k === 0 ? res.durationMs : 0,
        });
      });
    } catch (e) {
      for (const seg of unit.segments) {
        results.push({ ...placeholderFor(seg, ctx), error: String(e) });
      }
    }
    segIndex += unit.segments.length;
  }
  return results;
}

/** Dispatch a single unit to the active TTS engine. */
async function synthUnit(
  unit: SynthUnit,
  _ctx: TtsContext,
): Promise<{ pcm: Float32Array; sampleRate: number; durationMs: number }> {
  if (unit.engine === "breeze") {
    const preset = breezeVoiceByName(unit.voice, unit.lang);
    const instruction =
      preset?.instruction ??
      (unit.lang === "fr"
        ? "Une voix claire, chaleureuse et naturelle, au débit posé et agréable."
        : "A clear, warm, natural voice with a pleasant, calm delivery.");
    const res = await synthesizeBreeze({ text: unitText(unit), instruction, seed: 42 });
    return { pcm: res.pcm, sampleRate: res.sampleRate, durationMs: res.durationMs };
  }
  const res = await synthesize({ text: unitText(unit), voice: unit.voice, lang: unit.lang, lsdSteps: _ctx.lsdSteps });
  return { pcm: res.pcm, sampleRate: res.sampleRate, durationMs: res.durationMs };
}

export async function warmupTts(): Promise<void> {
  const lang = (getSetting("tts_language", "fr") === "en" ? "en" : "fr") as TtsLang;
  await ensureTtsLoaded(lang);
}

/** Warm the currently selected engine (sidecar spawn without model preload is
 * left lazy so a Breeze model isn't pinned on GPU at boot). */
export function warmupSelectedEngine(): Promise<void> {
  const engine = getSetting("tts_engine", "pocket") === "breeze" ? "breeze" : "pocket";
  if (engine === "breeze") {
    if (!breezeModelPresent()) {
      throw new Error("Breeze - Le modèle n'est pas encore téléchargé dans models/Breeze-TTS-2.");
    }
    return ensureBreezeServer(600_000) as unknown as Promise<void>;
  }
  return warmupTts();
}

export { listCards };