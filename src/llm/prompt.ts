/**
 * SillyTavern-inspired prompt assembly for roleplay, plus parsing of assistant
 * output into segments (narration / character dialogue) for display.
 */
import type { CardRow, ConversationRow, LorebookRow, MessageRow, PersonaRow, ScenarioRow, WorldRow } from "../server/db";
import { getSetting, activeLorebook } from "../server/db";

export interface NarratorPreset {
  label: string;
  prompt: string;
  /** false = built-in (re-editable, resettable); true = created by the user. */
  custom: boolean;
}

const BUILTIN_NARRATOR_PRESETS: Record<string, Omit<NarratorPreset, "custom">> = {
  neutre: { label: "Neutre", prompt: "Sobre, direct et factuel : tu décris sans t'impliquer." },
  epique: { label: "Épique", prompt: "Grandiose, lyrique et dramatique : chaque scène devient une épopée." },
  sarcastique: { label: "Sarcastique", prompt: "Sarcastique et mordant : tu commentes les actions du joueur avec ironie et piques bien placées." },
  cynique: { label: "Cynique", prompt: "Cynique et désabusé : le monde est dur, injuste, et tu le fais sentir à chaque phrase." },
  en_colere: { label: "En colère", prompt: "En colère : la narration est tendue, brutale, presque rageuse. Les descriptions frappent fort." },
  nagatoro: { label: "Nagatoro (taquin)", prompt: "Taquin et espiègle, comme Nagatoro : tu provoques gentiment le joueur avec des piques affectueuses, un sourire malicieux et beaucoup d'assurance." },
};

/**
 * All narrator presets: built-ins seeded with their defaults, overridden or
 * extended by the user's `narrator_presets` setting (key → { label, prompt },
 * plus custom keys). The system prompt resolves the active style by key.
 */
export function narratorPresets(): Record<string, NarratorPreset> {
  const out: Record<string, NarratorPreset> = {};
  for (const [k, v] of Object.entries(BUILTIN_NARRATOR_PRESETS)) {
    out[k] = { ...v, custom: false };
  }
  try {
    const overrides = (getSetting("narrator_presets", {}) ?? {}) as Record<string, Partial<NarratorPreset>>;
    for (const [k, v] of Object.entries(overrides)) {
      if (!v?.prompt) continue;
      const builtin = k in BUILTIN_NARRATOR_PRESETS;
      out[k] = {
        label: v.label?.trim() || (builtin ? out[k].label : k),
        prompt: v.prompt.trim(),
        custom: !builtin,
      };
    }
  } catch {
    /* malformed setting → fall back to built-ins */
  }
  return out;
}

// ─── generation presets (per-party style profiles) ───────────────────────────
export interface GenerationPreset {
  label: string;
  temperature: number;
  maxTokens: number;
  /** style directive injected into the system prompt while the preset is active */
  directive: string;
}

export const GENERATION_PRESETS: Record<string, GenerationPreset> = {
  cinematique: {
    label: "Cinématique", temperature: 0.95, maxTokens: 3000,
    directive: "Style cinématique : plans larges, transitions de scène nettes, rythme soutenu, dialogues percutants, descriptions évocatrices mais jamais verbeuses.",
  },
  rapide: {
    label: "Rapide", temperature: 0.85, maxTokens: 1200,
    directive: "Style rapide : actions courtes et directes, descriptions minimales, l'histoire avance vite à chaque tour.",
  },
  canon: {
    label: "Fidèle au canon", temperature: 0.5, maxTokens: 2500,
    directive: "Style fidèle au canon : respect strict des faits déjà établis, cohérence absolue, aucune invention qui contredirait le passé.",
  },
  chaotique: {
    label: "Chaotique", temperature: 1.2, maxTokens: 3000,
    directive: "Style chaotique : situations imprévisibles, retournements absurdes, humour noir, tout peut basculer à tout moment.",
  },
  dialogue: {
    label: "Dialogue", temperature: 1.0, maxTokens: 2000,
    directive: "Style dialogue : priorité aux échanges entre personnages, narration minimale, répliques vivantes et naturelles.",
  },
  horreur: {
    label: "Horreur", temperature: 0.9, maxTokens: 2500,
    directive: "Style horreur : atmosphère oppressante, tension montante, détails dérangeants, le danger se fait sentir avant d'apparaître.",
  },
  romance: {
    label: "Romance", temperature: 1.0, maxTokens: 2200,
    directive: "Style romance : attention aux émotions, regards, non-dits, gestes tendres, tension romantique qui se construit.",
  },
  narration_courte: {
    label: "Narration courte", temperature: 0.8, maxTokens: 900,
    directive: "Style narration courte : 2 à 4 phrases par tour, essentielles et évocatrices, jamais de remplissage.",
  },
};

/** Resolve a preset key from conversation settings ("" or unknown → null). */
export function presetFromKey(key: unknown): GenerationPreset | null {
  if (typeof key !== "string" || !key) return null;
  return GENERATION_PRESETS[key] ?? null;
}

export interface MemoryState {
  location?: string;
  characters?: string[];
  goals?: string[];
  facts?: string[];
  items?: string[];
  relationships?: Record<string, string>;
}

/** Parse structured memory from LLM output — tolerates ```json fences and noise. */
export function parseMemory(text: unknown): MemoryState | null {
  if (typeof text !== "string" || !text.trim()) return null;
  let raw = text.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: any = null;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const str = (v: any): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const strArr = (v: any): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const arr = v.map((x) => String(x).trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  };
  const rel: Record<string, string> = {};
  if (obj.relationships && typeof obj.relationships === "object" && !Array.isArray(obj.relationships)) {
    for (const [k, v] of Object.entries(obj.relationships)) rel[k] = String(v);
  }
  const out: MemoryState = {
    location: str(obj.location) || undefined,
    characters: strArr(obj.characters),
    goals: strArr(obj.goals),
    facts: strArr(obj.facts),
    items: strArr(obj.items),
    relationships: Object.keys(rel).length ? rel : undefined,
  };
  return Object.values(out).some((v) => v !== undefined) ? out : null;
}

/** Readable rendering of the structured memory (used for list views + fallback). */
export function memoryToText(m: MemoryState): string {
  const lines: string[] = [];
  if (m.location) lines.push(`📍 Lieu : ${m.location}`);
  if (m.characters?.length) lines.push(`👥 Personnages : ${m.characters.join(", ")}`);
  if (m.goals?.length) lines.push(`🎯 Objectifs : ${m.goals.join(" ; ")}`);
  if (m.items?.length) lines.push(`📦 Objets : ${m.items.join(", ")}`);
  if (m.relationships && Object.keys(m.relationships).length) {
    lines.push(`🔗 Relations : ${Object.entries(m.relationships).map(([k, v]) => `${k} → ${v}`).join(" ; ")}`);
  }
  if (m.facts?.length) lines.push(`📌 Faits : ${m.facts.join(" ; ")}`);
  return lines.join("\n");
}

export interface CastContext {
  world?: WorldRow | null;
  persona?: PersonaRow | null;
  cards: CardRow[];
  scenario?: ScenarioRow | null;
  conversation: ConversationRow;
  summary?: string; // rolling summary of events older than the kept history
  memory?: MemoryState; // structured memory (location, characters, goals, facts…)
  lore?: LorebookRow[]; // active lorebook entries (triggers matched), injected below
}

export function buildSystemPrompt(ctx: CastContext): string {
  const parts: string[] = [];
  const world = ctx.world;
  const persona = ctx.persona;
  const cards = ctx.cards;
  const group = ctx.conversation.group_mode === 1 && cards.length > 1;

  parts.push(
    `Tu es le maître de jeu d'un récit de roleplay immersif. Tu écris en français${world?.language === "en" ? " mais le joueur écrit parfois en anglais, adapte-toi" : ""} sauf si le contexte impose autre chose.`,
  );

  if (world) {
    parts.push(
      `## Monde : ${world.name}\n${world.description ? world.description + "\n" : ""}` +
        (world.lore ? `Lore / univers :\n${world.lore}\n` : "") +
        (world.tone ? `Tonalité : ${world.tone}.\n` : ""),
    );
  }

  // narrator voice preset — the world can override the global setting (each
  // world picks its own narration style in the world editor, stored in the
  // narration_style column). Presets live in narrator_presets (settings) :
  // custom keys + overrides of the built-ins. Unresolvable keys (e.g. legacy
  // free-text values) fall back to the global style.
  let styleKey = String(getSetting("narrator_style", "epique"));
  if (world && world.narration_style?.trim()) {
    const wsKey = world.narration_style.trim();
    if (narratorPresets()[wsKey]) styleKey = wsKey;
  }
  const styleDesc = narratorPresets()[styleKey]?.prompt ?? narratorPresets().epique.prompt;
  parts.push(`## Style du narrateur\n${styleDesc}\n`);

  if (persona) {
    parts.push(`## Toi (le joueur) — ${persona.name}\n${persona.description}\n`);
  } else {
    parts.push(`## Toi (le joueur)\nTu es le protagoniste de cette histoire, décris tes actions et tes paroles.\n`);
  }

  if (group && cards.length > 0) {
    parts.push("## Personnages présents (tous doivent apparaître quand c'est pertinent)");
  }
  for (const card of cards) {
    const desc = [
      card.description && `Description : ${card.description}`,
      card.personality && `Personnalité : ${card.personality}`,
      card.scenario && `Situation : ${card.scenario}`,
      card.system_prompt && `Directives : ${card.system_prompt}`,
    ].filter(Boolean).join("\n");
    parts.push(`### ${card.name}\n${desc || "(personnage secondaire)"}\n`);
  }

  if (ctx.scenario?.intro) {
    parts.push(`## Situation de départ\n${ctx.scenario.intro}\n`);
  }

  // active generation preset (per-party style profile)
  {
    let cs: Record<string, unknown> = {};
    try { cs = JSON.parse(ctx.conversation.settings || "{}"); } catch { /* ignore */ }
    const preset = presetFromKey(cs.preset);
    if (preset) parts.push(`## Directives de style (« ${preset.label} »)\n${preset.directive}\n`);
  }

  // game-master mode (10.A): one-shot directives applied to the NEXT turn only —
  // the panel sets settings.dm + dm_pending, cleared server-side once the turn
  // completes, so the next response follows these instructions then reverts
  {
    let cs: Record<string, unknown> = {};
    try { cs = JSON.parse(ctx.conversation.settings || "{}"); } catch { /* ignore */ }
    const dm = cs.dm as Record<string, unknown> | undefined;
    if (dm && cs.dm_pending) {
      const lines: string[] = [];
      if (typeof dm.tension === "number") {
        const t = Number(dm.tension);
        lines.push(`Tension : ${t < 34 ? "calme et contemplatif" : t < 67 ? "soutenue, avec des enjeux clairs" : "élevée, urgente et oppressante"} (${t}/100).`);
      }
      if (typeof dm.focus === "string" && dm.focus) lines.push(`Mets ${dm.focus} au premier plan de la scène : ses actions, son point de vue, sa voix.`);
      if (typeof dm.reveal === "string" && dm.reveal.trim()) lines.push(`Révèle progressivement : ${dm.reveal.trim().slice(0, 300)} — sans tout dévoiler d'un coup.`);
      if (typeof dm.pace === "string" && dm.pace && dm.pace !== "normal") {
        lines.push(dm.pace === "rapide" ? "Rythme rapide : scènes courtes, actions enchaînées, peu de descriptions longues." : "Rythme lent : descriptions détaillées, ambiances posées, temps de respiration.");
      }
      if (typeof dm.style === "string" && dm.style) lines.push(`Style de la scène : ${dm.style}.`);
      if (typeof dm.length === "string" && dm.length) {
        lines.push(dm.length === "courte" ? "Réponse courte : 1 à 2 paragraphes." : dm.length === "longue" ? "Réponse longue et dense : 5 à 8 paragraphes." : "Longueur normale : 2 à 4 paragraphes.");
      }
      if (lines.length) parts.push(`## Directives du maître de jeu (ce tour uniquement)\n${lines.join("\n")}\n`);
    }
  }

  // lorebook: conditional world knowledge — only entries whose triggers appear
  // in the recent text are included, so rich worlds don't blow up the context
  if (ctx.lore?.length) {
    parts.push(`## Connaissances du monde (mémoire)\n${ctx.lore.map((e) => `- ${e.name} : ${e.content.trim()}`).join("\n")}\n`);
  }

  if (ctx.memory) {
    const t = memoryToText(ctx.memory);
    parts.push(`## Mémoire structurée (état du monde)\n${t}\n`);
  }

  if (ctx.summary) {
    parts.push(`## Résumé des événements précédents\n${ctx.summary}\n`);
  }

  // story chapters: titled + summarized arcs written into the thread (display
  // only), injected here so long games keep a coherent narrative spine
  try {
    const cs = JSON.parse(ctx.conversation.settings || "{}");
    const chapters = Array.isArray(cs.chapters) ? cs.chapters.slice(-3) : [];
    if (chapters.length) {
      parts.push(
        `## Chapitres précédents\n${chapters
          .map((c: any) => `Chapitre ${c.n} — ${String(c.title || "")}\n${String(c.summary || "")}`)
          .join("\n\n")}\n`,
      );
    }
  } catch { /* ignore */ }

  const personaName = ctx.persona?.name ?? "le joueur";
  parts.push(`## Format d'écriture (important)
- Le narrateur raconte UNIQUEMENT l'histoire, en narration entre astérisques : *Le vent soulevait la poussière.*
- Le narrateur ne parle JAMAIS : pas de dialogues, pas de répliques, pas d'adresse directe aux personnages ni au joueur. Il décrit, il ne dialogue jamais.
- Seuls les personnages (NPC) ont des dialogues, au format : Nom: "paroles du personnage"
- Ne fais JAMAIS parler le joueur (${personaName}) à sa place : tu contrôles uniquement le narrateur et les personnages.
- Ne mélange jamais la narration et les paroles dans la même ligne.
- Reste dans la fiction, ne parle jamais hors-jeu, ne mentionne jamais "assistant", "IA" ni "roleplay".
- ${group ? "Fais réagir et parler TOUS les personnages présents, l'un après l'autre, quand la scène le demande." : "Fais vivre la scène : les personnages présents agissent, se parlent et s'adressent au joueur avec des dialogues vivants."}
- Propose des rebondissements, des dilemmes et des détails sensoriels. Pas de listes, pas de résumés.
- Longueur : 2 à 6 paragraphes de narration et 1 à 3 répliques par personnage selon l'élan de la scène.`);
  return parts.join("\n\n");
}

export function buildMessages(ctx: CastContext, history: MessageRow[]): { system: string; messages: { role: "user" | "assistant"; content: string }[] } {
  // lorebook triggers are matched against the recent exchange (the last few
  // messages), so entries activate exactly when the fiction mentions them
  if (ctx.world && !ctx.lore) {
    const recent = history.slice(-6).map((m) => m.content).join("\n");
    const active = activeLorebook(ctx.world.id, recent);
    if (active.length) ctx.lore = active;
  }
  const system = buildSystemPrompt(ctx);
  const personaName = ctx.persona?.name ?? "Moi";
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of history) {
    // chapter markers are display-only: never part of the model input
    try {
      const meta = JSON.parse(m.meta || "{}");
      if (meta.chapter) continue;
    } catch { /* broken meta → treat as normal */ }
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      messages.push({ role: "assistant", content: m.content });
    }
  }
  return { system, messages };
}

// instructions for the background rolling-summary task
// The model is asked for structured JSON (location, characters, goals, facts,
// items, relationships) so the memory stays robust — a free-text paragraph is
// accepted as a fallback when the model can't produce JSON.
export function summarizeSystem(): string {
  return [
    "Tu compresses un fil de roleplay en une mémoire structurée pour l'IA qui poursuit l'histoire.",
    "Réponds UNIQUEMENT par un objet JSON valide, sans commentaire, avec ces champs :",
    '{"location": "lieu actuel", "characters": ["noms"], "goals": ["objectifs en cours"], "facts": ["événements importants, indices actifs"], "items": ["objets possédés/importants"], "relationships": {"X": "nature du lien avec Y"}}',
    "Garde les noms propres. Complète les informations manquantes, ne répète pas l'ancienne mémoire à l'identique.",
    "Si tu ne peux pas produire de JSON, écris 3 à 6 phrases en français à la place.",
  ].join("\n");
}

export function estimateTokens(text: string): number {
  // rough heuristic (~4 chars/token for French) — used for context budgeting
  return Math.ceil((text.length || 1) / 4);
}

// ─── Segment parsing (narration / dialogue split) ─────────────────────────────
export type SegmentType = "narration" | "dialogue" | "action";

export interface Segment {
  type: SegmentType;
  speaker: string; // "" for narration
  text: string;
}

const NAME_RE = /^\s*([A-Za-zÀ-ÖØ-öø-ÿ'’ -]{1,40}?)\s*[::]\s*"([\s\S]*?)"\s*$/;

export function parseSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  const lines = content.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // dialogue line: Name: "text"
    const m = line.match(NAME_RE);
    if (m && m[2].trim()) {
      segments.push({ type: "dialogue", speaker: m[1].trim(), text: m[2].trim() });
      continue;
    }
    // narration (*...*) and dialogue can share one line — walk it left to
    // right so segments come out in written order (playback follows too)
    if (line.includes("*")) {
      const TOKEN_RE = /\*([^*]+)\*|([A-Za-zÀ-ÖØ-öø-ÿ'’ -]{1,40}?)\s*:\s*"([^"]*)"/g;
      let m: RegExpExecArray | null;
      let last = 0;
      while ((m = TOKEN_RE.exec(line))) {
        const plain = line.slice(last, m.index).trim();
        if (plain) segments.push({ type: "action", speaker: "", text: plain });
        if (m[1]) segments.push({ type: "narration", speaker: "", text: m[1].trim() });
        else if (m[3] !== undefined) segments.push({ type: "dialogue", speaker: m[2].trim(), text: m[3].trim() });
        last = m.index + m[0].length;
      }
      const tail = line.slice(last).trim();
      if (tail) segments.push({ type: "action", speaker: "", text: tail });
      continue;
    }
    // quoted speech without name → character line (speaker resolved later)
    const quoted = line.match(/^"([\s\S]*?)"\s*$/);
    if (quoted) {
      segments.push({ type: "dialogue", speaker: "", text: quoted[1].trim() });
      continue;
    }
    segments.push({ type: "narration", speaker: "", text: line });
  }
  return segments.filter((s) => s.text.length > 0);
}

export function fallbackSpeaker(segments: Segment[], castNames: string[]): Segment[] {
  // unnamed dialogue lines are attributed to the first cast member (or "Narrateur")
  const primary = castNames[0] ?? "Narrateur";
  return segments.map((s) => (s.type === "dialogue" && !s.speaker ? { ...s, speaker: primary } : s));
}