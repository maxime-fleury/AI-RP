/**
 * Breeze TTS 2 voice presets.
 *
 * Unlike Pocket-TTS (fixed named voice embeddings), every Breeze voice is a
 * voice-design instruction: a natural-language description of the speaker that
 * is fed to the model alongside the text. Users can edit the descriptions and
 * create new presets; they are stored in the settings table (breeze_voices).
 */
import { getSetting, setSetting } from "../server/db";
import type { TtsLang } from "./normalize";

export type TtsEngine = "pocket" | "breeze";

export interface BreezeVoice {
  name: string;
  lang: TtsLang;
  instruction: string;
}

/** Store key for the user-editable preset list. */
export const BREEZE_VOICES_KEY = "breeze_voices";

/**
 * Seed presets. Only applied when the store key is empty so the user's edits
 * are never overwritten. Instructions are written in the voice's language so
 * the model follows them naturally in that language.
 */
const DEFAULT_BREEZE_VOICES: BreezeVoice[] = [
  {
    name: "adèle",
    lang: "fr",
    instruction:
      "Une voix féminine douce et chaleureuse, claire et posée. Débit calme, articulation soignée, avec une touche de mélancolie poétique. Convient à une narration intime et immersive.",
  },
  {
    name: "baptiste",
    lang: "fr",
    instruction:
      "Une voix masculine grave et profonde, au timbre chaud et légèrement rocailleux. Débit mesuré, autorité tranquille, idéale pour un narrateur épique ou un personnage imposant.",
  },
  {
    name: "célia",
    lang: "fr",
    instruction:
      "Une voix féminine jeune et vive, lumineuse et expressive. Elle parle avec enthousiasme et spontanéité, parfaite pour une héroïne pleine d'énergie.",
  },
  {
    name: "luc",
    lang: "fr",
    instruction:
      "Une voix masculine claire et amicale, détendue et chaleureuse. Débit naturel, ton engageant, convient à un compagnon loyal ou à un personnage bienveillant.",
  },
  {
    name: "morgane",
    lang: "fr",
    instruction:
      "Une voix féminine au charme mystérieux, grave et hypnotique. Elle parle lentement, en pesant ses mots, avec un brin de malice — parfaite pour une antagoniste ou une sorcière.",
  },
  {
    name: "gaspard",
    lang: "fr",
    instruction:
      "Une voix masculine âgée et rauque, lente et pleine de sagesse. Les mots sont pesés, le ton grave et rassurant — idéale pour un mentor, un sage ou un vieux mage.",
  },
  {
    name: "eleanor",
    lang: "en",
    instruction:
      "A warm, clear female voice with a calm and thoughtful delivery. Slightly poetic, great for intimate narration.",
  },
  {
    name: "victor",
    lang: "en",
    instruction:
      "A deep, resonant male voice with a measured, authoritative tone. Commanding yet warm, ideal for epic narration.",
  },
  {
    name: "rosie",
    lang: "en",
    instruction:
      "A bright, youthful female voice, energetic and expressive. Friendly and spontaneous, perfect for a lively heroine.",
  },
];

export function isBreezeEngine(v: unknown): v is TtsEngine {
  return v === "breeze" || v === "pocket";
}

export function breezeVoiceList(): BreezeVoice[] {
  try {
    const raw = getSetting<string>(BREEZE_VOICES_KEY, "");
    if (!raw) return [...DEFAULT_BREEZE_VOICES];
    const parsed = Array.isArray(raw) ? raw : JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [...DEFAULT_BREEZE_VOICES];
    const out: BreezeVoice[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const name = String(item?.name ?? "").trim();
      const lang = item?.lang === "en" ? "en" : "fr";
      const instruction = String(item?.instruction ?? "").trim();
      if (!name || !instruction || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, lang, instruction });
    }
    return out.length ? out : [...DEFAULT_BREEZE_VOICES];
  } catch {
    return [...DEFAULT_BREEZE_VOICES];
  }
}

/** find a preset by name; falls back to the first preset of the language. */
export function breezeVoiceByName(name: string | undefined, lang: TtsLang): BreezeVoice | null {
  const voices = breezeVoiceList();
  if (name) {
    const hit = voices.find((v) => v.name.toLowerCase() === name.trim().toLowerCase());
    if (hit) return hit;
  }
  return voices.find((v) => v.lang === lang) ?? voices[0] ?? null;
}

/** Persist the full list (used by the settings UI). */
export function saveBreezeVoices(voices: unknown[]): BreezeVoice[] {
  const out: BreezeVoice[] = [];
  const seen = new Set<string>();
  for (const item of voices) {
    const name = String(item?.name ?? "").trim();
    const lang = item?.lang === "en" ? "en" : "fr";
    const instruction = String(item?.instruction ?? "").trim();
    if (!name || !instruction || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, lang, instruction });
  }
  setSetting(BREEZE_VOICES_KEY, out);
  return out.length ? out : defaultBreezeVoices();
}

/** Re-seed the list to defaults (exposed for the settings "reset" action). */
export function defaultBreezeVoices(): BreezeVoice[] {
  const list = [...DEFAULT_BREEZE_VOICES];
  setSetting(BREEZE_VOICES_KEY, list);
  return list;
}