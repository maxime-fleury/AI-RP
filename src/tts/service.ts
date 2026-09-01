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

export function buildTtsContext(conversation: { world_id: number | null; cast: string }): TtsContext {
  const language = (getSetting("tts_language", "fr") === "en" ? "en" : "fr") as TtsLang;
  const context: TtsContext = {
    narratorVoice: getSetting("tts_voice_narrateur", "jean") as string,
    defaultVoice: getSetting("tts_voice_default", "cosette") as string,
    language,
    characterVoices: {},
    characterLangs: {},
    lsdSteps: Number(getSetting("tts_lsd_steps", 4)),
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

export async function synthSegments(
  conversationId: number,
  messageId: number,
  segments: Segment[],
  ctx: TtsContext,
  existing: SynthAudio[] = [],
): Promise<SynthAudio[]> {
  const results: SynthAudio[] = [];
  const dir = path.join(AUDIO_DIR, String(conversationId));
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (existing[i]?.path && fs.existsSync(existing[i].path)) {
      results.push(existing[i]);
      continue;
    }
    const { voice, lang } = resolveVoice(seg, ctx);
    const file = path.join(dir, `${messageId}-${i}.wav`);
    try {
      const res = await withMutex(() =>
        synthesize({ text: seg.text, voice, lang, lsdSteps: ctx.lsdSteps }),
      );
      fs.writeFileSync(file, wavBytes(res.pcm, res.sampleRate));
      results.push({
        type: seg.type,
        speaker: seg.speaker,
        path: `/audio/${conversationId}/${messageId}-${i}.wav`,
        voice,
        lang,
        durationMs: res.durationMs,
      });
    } catch (e) {
      results.push({
        type: seg.type,
        speaker: seg.speaker,
        path: "",
        voice,
        lang,
        durationMs: 0,
        error: String(e),
      });
    }
  }
  return results;
}

export async function warmupTts(): Promise<void> {
  const lang = (getSetting("tts_language", "fr") === "en" ? "en" : "fr") as TtsLang;
  await ensureTtsLoaded(lang);
}

export { listCards };