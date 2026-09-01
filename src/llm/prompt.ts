/**
 * SillyTavern-inspired prompt assembly for roleplay, plus parsing of assistant
 * output into segments (narration / character dialogue) used by the TTS.
 */
import type { CardRow, ConversationRow, MessageRow, PersonaRow, ScenarioRow, WorldRow } from "../server/db";
import { getSetting } from "../server/db";

export interface CastContext {
  world?: WorldRow | null;
  persona?: PersonaRow | null;
  cards: CardRow[];
  scenario?: ScenarioRow | null;
  conversation: ConversationRow;
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

  // narrator voice preset (settings) — overrides the world narration style
  const NARRATOR_STYLES: Record<string, string> = {
    neutre: "Sobre, direct et factuel : tu décris sans t'impliquer.",
    epique: "Grandiose, lyrique et dramatique : chaque scène devient une épopée.",
    sarcastique: "Sarcastique et mordant : tu commentes les actions du joueur avec ironie et piques bien placées.",
    cynique: "Cynique et désabusé : le monde est dur, injuste, et tu le fais sentir à chaque phrase.",
    en_colere: "En colère : la narration est tendue, brutale, presque rageuse. Les descriptions frappent fort.",
    nagatoro: "Taquin et espiègle, comme Nagatoro : tu provoques gentiment le joueur avec des piques affectueuses, un sourire malicieux et beaucoup d'assurance.",
  };
  const styleKey = String(getSetting("narrator_style", "epique"));
  const styleDesc = NARRATOR_STYLES[styleKey] ?? NARRATOR_STYLES.epique;
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
  const system = buildSystemPrompt(ctx);
  const personaName = ctx.persona?.name ?? "Moi";
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of history) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      messages.push({ role: "assistant", content: m.content });
    }
  }
  return { system, messages };
}

// ─── Segment parsing (for TTS routing) ────────────────────────────────────────
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
    // narration: *...* possibly with surrounding text
    const italics = line.match(/\*([^*]+)\*/g);
    if (italics) {
      let rest = line.replace(/\*[^*]+\*/g, "").trim();
      for (const it of italics) {
        const inner = it.slice(1, -1).trim();
        if (inner) segments.push({ type: "narration", speaker: "", text: inner });
      }
      if (rest) {
        const dm = rest.match(NAME_RE);
        if (dm) segments.push({ type: "dialogue", speaker: dm[1].trim(), text: dm[2].trim() });
        else segments.push({ type: "action", speaker: "", text: rest });
      }
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