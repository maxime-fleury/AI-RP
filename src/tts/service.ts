/**
 * TTS service: routes segments (narration / characters) to voices, serializes
 * inference (ORT sessions are not thread-safe), and caches WAV files on disk.
 */
import fs from "node:fs";
import path from "node:path";
import { AUDIO_DIR, SAMPLES_DIR } from "../server/paths";
import { getSetting, getCard, listCards } from "../server/db";
import { synthesize, wavBytes, ensureTtsLoaded, type TtsLang } from "./engine";
import type { Segment } from "../llm/prompt";

export interface VoiceOption {
  name: string;
  lang: "fr" | "en";
  label: string;
  predefined: boolean;
}

export function listVoices(): VoiceOption[] {
  const out: VoiceOption[] = [];
  const seen = new Set<string>();
  for (const lang of ["fr", "en"] as const) {
    const dir = `${import.meta.dir}/../../models/Pocket-tts/${lang === "fr" ? "french_24l" : "english_2026-04"}/voices`;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".json")) {
          const name = f.slice(0, -5);
          const key = `${lang}:${name}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ name, lang, label: `${name} (${lang === "fr" ? "FR" : "EN"})`, predefined: true });
          }
        }
      }
    } catch {
      /* no bundle voices */
    }
  }
  return out;
}

let ttsMutex = Promise.resolve();
function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = ttsMutex.then(fn, fn);
  ttsMutex = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Synthesize (once, cached on disk) a short sample clip for a voice, used in
 * the settings to preview each voice. Returns the public URL path.
 */
export async function getVoiceSample(name: string, lang: TtsLang): Promise<string> {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const fileName = `${lang}-${name}.wav`;
  const file = path.join(SAMPLES_DIR, fileName);
  if (fs.existsSync(file)) return `/samples/${fileName}`;
  const text =
    lang === "fr"
      ? `Bonjour ! Moi c'est ${name}. Voilà ma voix pour tes histoires.`
      : `Hello! I'm ${name}. This is my voice for your stories.`;
  const res = await withMutex(() => synthesize({ text, voice: name, lang, lsdSteps: 4 }));
  fs.writeFileSync(file, wavBytes(res.pcm, res.sampleRate));
  return `/samples/${fileName}`;
}

export interface SynthAudio {
  type: string;
  speaker: string;
  path: string;
  voice: string;
  lang: TtsLang;
  durationMs: number;
  error?: string;
}

export interface TtsContext {
  narratorVoice: string;
  defaultVoice: string;
  language: TtsLang;
  characterVoices: Record<string, string>; // card name → voice
  characterLangs: Record<string, TtsLang>;
  lsdSteps: number;
}

export function buildTtsContext(conversation: { world_id: number | null; cast: string; settings?: string }): TtsContext {
  // per-conversation overrides (set from the ⚙️ modal of the party) win over globals
  let cs: Record<string, unknown> = {};
  try { cs = JSON.parse(conversation.settings || "{}"); } catch { /* ignore */ }
  const language = ((cs.tts_language as string) || (getSetting("tts_language", "fr") as string === "en" ? "en" : "fr")) as TtsLang;
  const context: TtsContext = {
    narratorVoice: (cs.tts_voice_narrateur || getSetting("tts_voice_narrateur", "jean")) as string,
    defaultVoice: (cs.tts_voice_default || getSetting("tts_voice_default", "cosette")) as string,
    language,
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

function resolveVoice(seg: Segment, ctx: TtsContext): { voice: string; lang: TtsLang } {
  if (seg.type === "narration" || !seg.speaker) {
    return { voice: ctx.narratorVoice, lang: ctx.language };
  }
  const key = seg.speaker.toLowerCase().trim();
  const voice = ctx.characterVoices[key] || ctx.defaultVoice;
  const lang = ctx.characterLangs[key] || ctx.language;
  return { voice, lang };
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
  const flush = () => {
    if (!cur.length) return;
    units.push({ segments: cur, voice: curVoice, lang: curLang });
    cur = [];
  };
  for (const seg of segments) {
    const { voice, lang } = resolveVoice(seg, ctx);
    const sameSpeaker =
      cur.length > 0 &&
      (cur[0].type === seg.type) &&
      (seg.type !== "dialogue" || cur[0].speaker === seg.speaker) &&
      curVoice === voice && curLang === lang;
    const words = cur.reduce((a, s) => a + wordCount(s.text), 0);
    if (sameSpeaker && words + wordCount(seg.text) <= MERGE_MAX_WORDS && cur.length < MERGE_MAX_SEGMENTS) {
      cur.push(seg);
    } else {
      flush();
      cur = [seg];
      curVoice = voice;
      curLang = lang;
    }
  }
  flush();
  return units;
}

const placeholderFor = (seg: Segment, ctx: TtsContext): SynthAudio => {
  const { voice, lang } = resolveVoice(seg, ctx);
  return { type: seg.type, speaker: seg.speaker, path: "", voice, lang, durationMs: 0 };
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
    const text = joinSegments(unit.segments);
    try {
      const res = await withMutex(() =>
        synthesize({ text, voice: unit.voice, lang: unit.lang, lsdSteps: ctx.lsdSteps }),
      );
      fs.writeFileSync(file, wavBytes(res.pcm, res.sampleRate));
      unit.segments.forEach((seg, k) => {
        results.push({
          type: seg.type,
          speaker: seg.speaker,
          path: k === 0 ? `/audio/${conversationId}/${messageId}-${segIndex}.wav` : "",
          voice: unit.voice,
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

export async function warmupTts(): Promise<void> {
  const lang = (getSetting("tts_language", "fr") === "en" ? "en" : "fr") as TtsLang;
  await ensureTtsLoaded(lang);
}

export { listCards };