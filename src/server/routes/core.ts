/**
 * Shared helpers for the API routers: views, LLM operations, image
 * pipelines, retry handlers and re-exports of the low-level modules.
 */

/**
 * API router: worlds, scenarios, cards, personas, conversations, chat
 * streaming (SSE), images and settings.
 */
import fs from "node:fs";
import path from "node:path";
import {
  allSettings, setSetting, getSetting, listWorlds, getWorld, createWorld, updateWorld, deleteWorld,
  listScenarios, getScenario, createScenario, updateScenario, deleteScenario,
  listCards, getCard, createCard, updateCard, deleteCard,
  listPersonas, getPersona, createPersona, updatePersona, deletePersona,
  listConversations, getConversation, createConversation, updateConversation, deleteConversation,
  listMessages, getMessage, createMessage, updateMessage, deleteMessage, deleteMessagesAfter, touchConversation,
  listTrashedResources, restoreTrashed, permanentDeleteTrashed,
  lastMessageOf,
  listLocations, createLocation, updateLocation, deleteLocation,
  listLorebook, createLorebookEntry, updateLorebookEntry, deleteLorebookEntry, activeLorebook,
  listRelations, createRelation, updateRelation, deleteRelation,
  listTimeline, createTimelineEvent, updateTimelineEvent, deleteTimelineEvent,
  createJob, listJobs, updateJob, pendingJobs,
  listBranches,
  listCanon, getCanon, createCanon, updateCanon, deleteCanon, activeCanon,
  type CanonRow,
  conversationSettingsOf,
} from "../db";
import { importFile, scanDirectory, sizeLimitFor, type ImportResult } from "../importCards";
import { classifyIntent, directionChanged, intentToFocus } from "../../llm/intent";
import { checkResponseDrift } from "../../llm/guardrail";
import { getProvider, defaultModelFor, type ChatMessage } from "../../llm/providers";
import type { ConversationView, MessageView } from "../../shared/contracts";
import { buildMessages, buildSystemPrompt, estimateTokens, parseSegments, fallbackSpeaker, summarizeSystem, presetFromKey, parseMemory, memoryToText, profileFromSettings, modelClass, modelContextBudget, recencyBlock, stripThinking, type Segment, type CastContext, type MemoryState, type BuildPromptOptions, type SceneFocus } from "../../llm/prompt";
import type { ConversationRow, MessageRow } from "../db";
import { generateAndSave, probeImageStatus, ensureImageServer } from "../image";
import { storageInfo, runBackup, analyzeOrphans, purgeOrphans } from "../backup";
import { zipFiles } from "../zip";
import { providerHealth } from "../health";
import { IMAGES_DIR, UPLOADS_DIR } from "../paths";

import { registerJobRetry, trackJob } from "../jobs";
import { NEGATIVE_PROMPT, buildIllustrationPrompt, charSeed, characterForMessage, descriptionToTags, detectSceneKind } from "../imgPrompts";
import { HttpError } from "../http";
import { combineSignals } from "../signal";
import { log, recordMetric } from "../log";
import { promptFilled, promptText } from "../../llm/promptText";

// ─── helpers ──────────────────────────────────────────────────────────────────
// HTTP plumbing, embedded-media helpers and SSE are shared modules — see the
// re-exports right below (readJson / json / mediaFileFor / collectMediaUrls /
// restoreMedia / sseStream).
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // total cap for one import batch
export const MAX_IMPORT_FILES = 100;
export const SECRET_KEYS = new Set(["openrouter_key", "auth_token"]);

export function publicSettings(): Record<string, unknown> {
  const settings = allSettings();
  for (const key of SECRET_KEYS) {
    if (key in settings) {
      settings[`${key}_set`] = Boolean(settings[key]);
      delete settings[key];
    }
  }
  return settings;
}

/** Typed chat-message builder — stops `role` literals from widening to string. */
export function chatMsg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

// json/readJson/sseStream come from the shared ../http module; the embedded
// media helpers live in ../media (shared with the transactional restore). The
// bindings are imported AND re-exported so routers and core itself share one
// implementation (HttpError instance-of checks keep working across modules).
import { json, readJson, sseStream } from "../http";
import { collectMediaUrls, mediaFileFor, restoreMedia } from "../media";
export { json, readJson, sseStream } from "../http";
export { mediaFileFor, collectMediaUrls, restoreMedia } from "../media";

export function parseSegmentsFor(conv: any, content: string): Segment[] {
  let castNames: string[] = [];
  try {
    const ids: number[] = JSON.parse(conv.cast || "[]");
    castNames = ids.map((id) => getCard(Number(id))?.name ?? "").filter(Boolean);
  } catch { /* ignore */ }
  return fallbackSpeaker(parseSegments(content), castNames);
}

// ─── AI scenario generation (genre-aware) ─────────────────────────────────────
export const SCENARIO_GENRES: Record<string, { label: string; angle: string }> = {
  mystere: {
    label: "Mystère",
    angle: "Un mystère s'installe dès les premières lignes : un événement étrange, une disparition ou un secret que le joueur va devoir élucider.",
  },
  romance: {
    label: "Romance",
    angle: "Une rencontre chargée d'électricité : un lien qui naît, une attirance ou une tension romantique immédiate entre le joueur et un personnage.",
  },
  comedie: {
    label: "Comédie",
    angle: "Une situation absurde et drôle : un quiproquo, un malentendu ou une catastrophe burlesque qui prête à rire.",
  },
  action: {
    label: "Action / Aventure",
    angle: "L'action démarre immédiatement : une menace, une course-poursuite ou un danger qui pousse le joueur à agir vite.",
  },
  horreur: {
    label: "Horreur",
    angle: "Une atmosphère oppressante : quelque chose ne tourne pas rond, les ombres bougent et le danger est là, invisible.",
  },
  pvp: {
    label: "PVP",
    angle: "Le joueur est en rivalité directe avec un ou plusieurs personnages présents : un duel, une compétition ou un conflit d'intérêts immédiat.",
  },
};

/** Generate a scenario opening for a genre; returns a suggested name + intro. */
export async function generateScenarioIntro(
  world: { id: number; name: string; description: string; lore: string } | null,
  genre: string,
  theme?: string,
): Promise<{ name: string; intro: string }> {
  const g = SCENARIO_GENRES[genre] ?? SCENARIO_GENRES.mystere;
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) {
    const models = await provider.models();
    model = models[0] ?? "";
  }
  const sys = promptText("scenario-intro-system");
  const userText = [
    `Monde : ${world?.name ?? "?"}`,
    `Univers : ${world?.lore || world?.description || "?"}`,
    `Thème / point de départ : ${theme || "un départ inattendu"}`,
    `Genre : ${g.label} — ${g.angle}`,
    "Écris l'ouverture de cette histoire.",
  ].join("\n");
  let text = "";
  for await (const delta of provider.stream({
    messages: [{ role: "system", content: sys }, { role: "user", content: userText }],
    model,
    temperature: 0.95,
    maxTokens: 600,
    noThinking: true,
    signal: AbortSignal.timeout(120_000),
  })) {
    text += delta;
  }
  const trimmed = text.trim();
  const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  // the model emits a title line first — reuse it as the scenario name, but
  // only when it looks like a title (short, no sentence-ending punctuation,
  // and a real intro follows)
  const title =
    lines.length > 1 && lines[0].length <= 50 && !/[.!?…:]$/.test(lines[0])
      ? lines[0].replace(/^[*#\s]+|[*#\s]+$/g, "")
      : "";
  const rest = title ? lines.slice(1).join("\n") : trimmed;
  return { name: title || `Scénario ${g.label}`, intro: rest || trimmed };
}

export function conversationView(id: number): ConversationView | null {
  const conv = getConversation(id);
  if (!conv) return null;
  const world = conv.world_id ? getWorld(conv.world_id) : null;
  const persona = conv.persona_id ? getPersona(conv.persona_id) : null;
  const scenario = conv.scenario_id ? getScenario(conv.scenario_id) : null;
  let cards: any[] = [];
  try {
    cards = (JSON.parse(conv.cast) as number[]).map((cid) => getCard(Number(cid))).filter(Boolean);
  } catch { /* ignore */ }
  const memory = parseMemory(conv.memory_json);
  const { memory_json, ...rest } = conv;
  return { ...rest, memory, world, persona, scenario, cards, canon: listCanon(conv.id) } as ConversationView;
}

export function messageView(m: any): MessageView {
  try { m.segments = JSON.parse(m.segments || "[]"); } catch { m.segments = []; }
  // TTS has been removed — audio data is no longer served
  delete m.audio;
  try { m.meta = JSON.parse(m.meta || "{}"); } catch { m.meta = {}; }
  return m;
}

// ─── response suggestions (the "chips") ───────────────────────────────────────
export function suggestSystem(ctx: CastContext): string {
  const persona = ctx.persona?.name ?? "Moi";
  const cast = ctx.cards.map((c) => c.name).join(", ");
  // text lives in prompt/fr/chat-suggest-system.txt (editable without code)
  return promptFilled("chat-suggest-system", {
    persona,
    castLine: cast ? `, les personnages présents sont : ${cast}` : "",
  });
}

export function parseSuggestions(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    // only bulleted / numbered lines count (the model sometimes doubles the dash)
    const m = line.match(/^(?:(?:[-•*·◦]\s*){1,3}|\d+[.)]\s*)/);
    if (!m) continue;
    let s = line.slice(m[0].length).trim();
    s = s.replace(/^["'«]\s*|\s*["'»]$/g, "").trim();
    if (s.length >= 3 && s.length <= 140 && !out.includes(s)) out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}

// ─── AI-assisted card creation ────────────────────────────────────────────────
// The player describes a character idea in plain words; the model proposes
// several chips per field (name, description…) so the player picks favorites.
export const CARD_ASSIST_FIELDS = ["name", "description", "personality", "scenario", "first_mes", "mes_example", "tags"] as const;
export type CardAssistFields = Record<(typeof CARD_ASSIST_FIELDS)[number], string[]>;

export async function generateCardAssist(idea: string): Promise<CardAssistFields> {
  const empty = Object.fromEntries(CARD_ASSIST_FIELDS.map((k) => [k, []])) as CardAssistFields;
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) {
    const models = await provider.models();
    model = models[0] ?? "";
  }
  const fmt = JSON.stringify(Object.fromEntries(CARD_ASSIST_FIELDS.map((k) => [k, []])));
  const sys = promptText("card-assist-system");
  let text = "";
  try {
    text = await provider.complete({
      messages: [{ role: "system", content: sys }, { role: "user", content: `Idée du joueur : ${idea}` }],
      model,
      temperature: 1.0,
      maxTokens: 2400,
      noThinking: true,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    console.warn("[cards/assist] complete failed:", String(e?.message ?? e).slice(0, 200));
    return empty;
  }
  const out = { ...empty };
  try {
    const parsed = parseCardAssistJson(text || "");
    if (!parsed) return empty;
    for (const k of CARD_ASSIST_FIELDS) {
      const v = parsed[k];
      const items = (Array.isArray(v) ? v : [v])
        .map((x) => String(x ?? "").replace(/^["'«\s]+|["'»\s]+$/g, "").trim())
        .filter((s) => s.length >= 2 && s.length <= 900);
      out[k] = items.slice(0, k === "tags" ? 6 : 4);
    }
  } catch (e) {
    console.warn("[cards/assist] JSON invalide:", String(e?.message ?? e).slice(0, 120));
  }
  return out;
}

// ─── guided builder helpers (« Décris ce que tu veux ») ──────────────────────
export const ASSIST_STR = (v: unknown, max = 2000): string => String(v ?? "").trim().slice(0, max);
export const ASSIST_ARR = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Name-normalized key for dedupe: lowercase, accents stripped, non-letters → space. */
export const assistKey = (s: string): string =>
  String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
/** Drop near-duplicate names inside a batch (e.g. « la forêt » vs « La Forêt »). */
export function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const key = assistKey(it.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}
/** How many unique entries are complete enough to keep (name + body)? */
export function completeCount(r: Record<string, unknown> | null, field: string, forbiddenNames = new Set<string>()): number {
  const seen = new Set<string>();
  return ASSIST_ARR(r?.[field]).filter((p) => {
    const o = p as any;
    const name = assistKey(String(o?.name ?? ""));
    const description = String(o?.description ?? "").trim();
    if (!o || typeof o !== "object" || !name || !description || forbiddenNames.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  }).length;
}

/** Stage 1 — worlds: reuse up to 2 existing ones + exactly 4 new proposals. */
export async function assistWorlds(
  description: string, feedback: string,
  existing: { id: number; name: string; description: string; tone: string }[],
): Promise<{ matches: { id: number; reason: string }[]; proposals: { name: string; description: string; tone: string; lore: string }[] }> {
  const sys = promptText("assist-worlds-system");
  const existingBlock = existing.length
    ? existing.map((w) => `- #${w.id} « ${w.name} » : ${w.description.slice(0, 160)} (${w.tone})`).join("\n")
    : "(aucun monde existant)";
  const fb = feedback ? `\nRetour du joueur sur la fournée précédente (à intégrer absolument) : ${feedback}` : "";
  const text = await llmJson(
    `Idée du joueur : ${description}\n\nMondes existants à évaluer :\n${existingBlock}${fb}`,
    sys, 1600, 0.95, 300_000,
    (r) => {
      const props = completeCount(r, "proposals", new Set(existing.map((w) => assistKey(w.name))));
      if (props < 2) return `Il fallait au moins 2 mondes nouveaux complets, uniques et inédits (nom + description) ; ta réponse n'en contenait que ${props}.`;
      const ms = ASSIST_ARR(r?.matches).filter((m) => Number.isFinite(Number((m as any)?.id))).length;
      if (ms > 2) return "Au maximum 2 mondes existants peuvent être proposés en « matches ».";
      return null;
    },
  );
  const matches = dedupeByName(ASSIST_ARR(text?.matches)
    .map((m) => ({
      id: Number((m as any)?.id),
      name: existing.find((w) => w.id === Number((m as any)?.id))?.name ?? "",
      reason: ASSIST_STR((m as any)?.reason, 200),
    }))
    .filter((m) => Number.isFinite(m.id) && existing.some((w) => w.id === m.id)))
    .slice(0, 2)
    .map((m) => ({ id: m.id, reason: m.reason }));
  const proposals = dedupeByName(ASSIST_ARR(text?.proposals)
    .map((p) => ({
      name: ASSIST_STR((p as any)?.name, 80),
      description: ASSIST_STR((p as any)?.description, 1200),
      tone: ASSIST_STR((p as any)?.tone, 160),
      lore: ASSIST_STR((p as any)?.lore, 600),
    }))
    .filter((p) => p.name && p.description && !existing.some((w) => assistKey(w.name) === assistKey(p.name))))
    .slice(0, 4);
  return { matches, proposals };
}

/** Stage 2 — personas: reuse matching existing personas + exactly 4 new ones. */
export async function assistPersonas(
  description: string, world: Record<string, unknown> | null, feedback: string,
  existing: { id: number; name: string; description: string }[],
): Promise<{ matches: { id: number; reason: string }[]; proposals: { name: string; description: string }[] }> {
  const sys = promptText("assist-personas-system");
  const worldBlock = world ? `Monde validé : « ${ASSIST_STR(world.name, 80)} » — ${ASSIST_STR(world.description, 600)}` : "(pas de monde choisi)";
  const existingBlock = existing.length
    ? existing.map((p) => `- #${p.id} « ${p.name} » : ${p.description.slice(0, 160)}`).join("\n")
    : "(aucun persona existant)";
  const fb = feedback ? `\nRetour du joueur sur la fournée précédente (à intégrer absolument) : ${feedback}` : "";
  const text = await llmJson(
    `Idée du joueur : ${description}\n\n${worldBlock}\n\nPersonas existants à évaluer :\n${existingBlock}${fb}`,
    sys, 1500, 0.95, 300_000,
    (r) => {
      const props = completeCount(r, "proposals", new Set(existing.map((p) => assistKey(p.name))));
      if (props < 2) return `Il fallait au moins 2 personas nouveaux, uniques et inédits (nom + description) ; ta réponse n'en contenait que ${props}.`;
      const ms = ASSIST_ARR(r?.matches).filter((m) => Number.isFinite(Number((m as any)?.id))).length;
      if (ms > 2) return "Au maximum 2 personas existants peuvent être proposés en « matches ».";
      return null;
    },
  );
  const matches = dedupeByName(ASSIST_ARR(text?.matches)
    .map((m) => ({
      id: Number((m as any)?.id),
      name: existing.find((p) => p.id === Number((m as any)?.id))?.name ?? "",
      reason: ASSIST_STR((m as any)?.reason, 200),
    }))
    .filter((m) => Number.isFinite(m.id) && existing.some((p) => p.id === m.id)))
    .slice(0, 2)
    .map((m) => ({ id: m.id, reason: m.reason }));
  const proposals = dedupeByName(ASSIST_ARR(text?.proposals)
    .map((p) => ({ name: ASSIST_STR((p as any)?.name, 80), description: ASSIST_STR((p as any)?.description, 1400) }))
    .filter((p) => p.name && p.description && !existing.some((x) => assistKey(x.name) === assistKey(p.name))))
    .slice(0, 4);
  return { matches, proposals };
}

/** Stage 3 — characters the player described (with the fiction's own detail
 * about each one, so the card stage never invents blind), + reuse hints. */
export async function assistCharacters(
  description: string, world: Record<string, unknown> | null, persona: Record<string, unknown> | null,
  cards: { id: number; name: string; description: string }[], feedback: string,
): Promise<{ characters: { name: string; role: string; detail: string; reuse: string | null }[] }> {
  const sys = promptText("assist-characters-system");
  const worldBlock = world ? `Monde : « ${ASSIST_STR(world.name, 80)} » — ${ASSIST_STR(world.description, 400)}` : "";
  const personaBlock = persona ? `Persona du joueur : « ${ASSIST_STR(persona.name, 80)} »` : "";
  const cardsBlock = cards.length
    ? cards.map((c) => `- « ${c.name} » : ${c.description.slice(0, 120)}`).join("\n")
    : "(aucune carte existante)";
  const fb = feedback ? `\nRetour du joueur (à intégrer) : ${feedback}` : "";
  const text = await llmJson(
    `Idée du joueur : ${description}\n\n${[worldBlock, personaBlock].filter(Boolean).join("\n")}\n\nCartes existantes :\n${cardsBlock}${fb}`,
    sys, 1100, 0.5, 300_000,
  );
  const names = new Set(cards.map((c) => assistKey(c.name)));
  const characters = dedupeByName(ASSIST_ARR(text?.characters)
    .map((c) => {
      const reuse = ASSIST_STR((c as any)?.reuse, 80);
      return {
        name: ASSIST_STR((c as any)?.name, 80),
        role: ASSIST_STR((c as any)?.role, 200),
        detail: ASSIST_STR((c as any)?.detail, 400),
        reuse: reuse && names.has(assistKey(reuse)) ? reuse : null,
      };
    })
    .filter((c) => c.name))
    .slice(0, 4);
  return { characters };
}

/** Stage 4 — 4 card variants for one validated character. The player's own
 * persona is passed so cards stay distinct from it (name + concept), and each
 * card gets an opening line (first_mes) so the new party starts talking
 * instead of falling back to a generic greeting. */
export async function assistCards(
  description: string, world: Record<string, unknown> | null,
  character: Record<string, unknown> | undefined, feedback: string,
  persona?: Record<string, unknown> | null, siblingNames: string[] = [],
): Promise<{ proposals: { name: string; description: string; personality: string; scenario: string; tags: string[]; first_mes: string }[] }> {
  const charName = ASSIST_STR(character?.name, 80) || "le personnage";
  const charRole = ASSIST_STR(character?.role, 200);
  const charDetail = ASSIST_STR(character?.detail, 400);
  const personaName = ASSIST_STR(persona?.name, 80);
  const forbidden = new Set([personaName, ...siblingNames].map(assistKey).filter(Boolean));
  const sys = promptFilled("assist-cards-system", {
    charName,
    charRole: charRole || "rôle à définir",
    detailLine: charDetail ? `Le joueur a dit de lui : « ${charDetail} » — RESPECTE ces indices visuels et ce mystère dans chaque carte.` : "",
    personaLine: personaName ? `Le joueur incarne « ${personaName} » : n'utilise JAMAIS ce nom pour une carte, et rends chaque carte distincte de ce persona (pas un clone, pas un parent caché sauf si l'idée le suggère).` : "",
  });
  const worldBlock = world ? `Monde : « ${ASSIST_STR(world.name, 80)} » — ${ASSIST_STR(world.description, 400)}` : "";
  const personaBlock = personaName ? `Persona du joueur (à ne pas dupliquer) : « ${personaName} » — ${ASSIST_STR(persona?.description, 300)}` : "";
  const fb = feedback ? `\nRetour du joueur sur la fournée précédente (à intégrer) : ${feedback}` : "";
  const text = await llmJson(`Idée du joueur : ${description}\n\n${[worldBlock, personaBlock].filter(Boolean).join("\n")}${fb}`, sys, 2800, 0.9, 300_000,
    (r) => {
      const n = completeCount(r, "proposals", forbidden);
      if (n < 2) return `Il fallait au moins 2 cartes complètes et uniques (nom + description, noms jamais déjà vus) ; ta réponse n'en contenait que ${n}.`;
      return null;
    },
  );
  const proposals = dedupeByName(ASSIST_ARR(text?.proposals)
    .map((p) => ({
      name: ASSIST_STR((p as any)?.name, 80),
      description: ASSIST_STR((p as any)?.description, 1200),
      personality: ASSIST_STR((p as any)?.personality, 1200),
      scenario: ASSIST_STR((p as any)?.scenario, 800),
      tags: ASSIST_ARR((p as any)?.tags).map((t) => ASSIST_STR(t, 40)).filter(Boolean).slice(0, 8),
      first_mes: ASSIST_STR((p as any)?.first_mes, 600),
    }))
    .filter((p) => p.name && (p.description || p.personality) && !forbidden.has(assistKey(p.name))))
    .slice(0, 4);
  return { proposals };
}

/** Bonus stage — opening situation: the player's idea always contains a
 * situation ("téléporté au milieu de nulle part…") that used to die at the
 * wizard handoff. This turns it into an editable intro the new party starts
 * with (via settings.draft_intro, like the genre generator's drafts). */
export async function assistOpening(
  description: string, world: Record<string, unknown> | null,
  persona: Record<string, unknown> | null, castNames: string[], feedback: string,
): Promise<{ title: string; intro: string }> {
  const sys = promptText("assist-opening-system");
  const worldBlock = world ? `Monde : « ${ASSIST_STR(world.name, 80)} » — ${ASSIST_STR(world.description, 400)}` : "";
  const personaBlock = persona ? `Tu incarnes : « ${ASSIST_STR(persona.name, 80)} » — ${ASSIST_STR(persona.description, 300)}` : "";
  const castBlock = castNames.length ? `Personnages présents : ${castNames.map((n) => `« ${n} »`).join(", ")}` : "";
  const fb = feedback ? `\nRetour du joueur (à intégrer) : ${feedback}` : "";
  const text = await llmJson(
    `Idée du joueur : ${description}\n\n${[worldBlock, personaBlock, castBlock].filter(Boolean).join("\n")}${fb}`,
    sys, 700, 0.9, 300_000,
    (r) => {
      const title = ASSIST_STR((r as any)?.title, 120);
      const intro = ASSIST_STR((r as any)?.intro, 2000);
      if (!title || !intro) return "Il fallait un title ET un intro non vides.";
      if (intro.length < 120) return "L'intro est trop courte (minimum ~120 caractères) — développe la scène.";
      return null;
    },
  );
  return { title: ASSIST_STR((text as any)?.title, 120), intro: ASSIST_STR((text as any)?.intro, 2000) };
}

// ─── story chapters & dynamic NPCs ───────────────────────────────────────────
// Chapters: closed automatically every CHAPTER_MIN_MESSAGES turns; the marker
// message is display-only (skipped in buildMessages) and summaries feed the
// system prompt. NPCs: proposed from the fiction, approved into the cast.
export const CHAPTER_MIN_MESSAGES = 10;

export type NpcSuggestion = { name: string; description: string; personality: string; role: string };
export const NPC_FMT = '{"npcs":[{"name":"Prénom","description":"2 phrases visuelles","personality":"traits en une phrase","role":"fonction dans la scène"}]}';

/**
 * Ask the model for strict JSON, with ONE automatic corrective retry for two
 * failure classes that small local models hit constantly:
 *  1. the call threw / the text is not parseable (truncated, code fence, prose
 *     around the block, broken escapes) → re-ask with an explicit nudge;
 *  2. the JSON parses but fails `validate` (optional) — e.g. a stage that
 *     promised 4 proposals got 1 — → re-ask with the exact rejection reason.
 * Both retries run at a lower temperature to favor strict formatting over
 * creativity. A stage therefore never silently returns a 1-world batch just
 * because the first answer was short.
 */
export async function llmJson(
  prompt: string, sys: string, maxTokens = 700, temperature = 0.7, timeoutMs = 120_000,
  validate?: (parsed: Record<string, unknown> | null) => string | null,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) {
    try {
      const models = await provider.models();
      model = models[0] ?? "";
    } catch { /* offline */ }
  }
  if (!model) return null;
  const ask = async (extraSys: string, temp: number): Promise<Record<string, unknown> | null> => {
    try {
      const text = await provider.complete({
        messages: [
          { role: "system", content: sys + (extraSys ? " " + extraSys : "") },
          { role: "user", content: prompt },
        ],
        model, temperature: temp, maxTokens, noThinking: true, signal: combineSignals(signal, timeoutMs),
      });
      return parseCardAssistJson(text || "");
    } catch (e) {
      console.warn(`[llm-json] échec: ${String(e?.message ?? e).slice(0, 140)}`);
      return null;
    }
  };
  let parsed = await ask("", temperature);
  if (!parsed) {
    console.warn("[llm-json] réponse illisible — 1 relance corrective");
    // This is the one and only retry for a malformed response. Validate the
    // retry here too, without launching a third model call.
    parsed = await ask(
      "⚠️ Ta première réponse a été rejetée : elle n'était pas un JSON valide et complet (tronqué, entouré de texte, ou échappements cassés). Recommence et réponds UNIQUEMENT avec le JSON demandé, fermé, non tronqué, sans texte autour.",
      Math.min(0.5, temperature),
    );
    if (!parsed || (validate && validate(parsed))) return null;
    return parsed;
  }
  if (validate) {
    const reason = validate(parsed);
    if (reason) {
      console.warn(`[llm-json] réponse rejetée (${reason}) — 1 relance corrective`);
      const retried = await ask(
        `⚠️ Ta première réponse a été rejetée pour la raison suivante : ${reason} Recommence depuis zéro en corrigeant cela, en français, au format exact demandé, JSON complet et non tronqué.`,
        Math.min(0.6, temperature),
      );
      // Validate the corrective answer too. It must never become a successful
      // partial batch, but it must not trigger a third model call either.
      if (!retried || validate(retried)) return null;
      return retried;
    }
  }
  return parsed;
}

export function transcriptFor(msgs: MessageRow[], max = 60): string {
  const kept = msgs.filter((m) => {
    try { const meta = JSON.parse(m.meta || "{}"); return !meta.chapter && !meta.rewind; } catch { return true; }
  }).slice(-max);
  return kept.map((m) => `${m.role === "user" ? "Joueur" : m.name || "Narrateur"} : ${(m.content || "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
}

/**
 * Preserve a doomed stretch of a conversation as a restorable abandoned branch
 * (RE:ZERO rewind keeps the timeline around). Images are copied with remapped
 * ids, exactly like the "Régénérer en variante" fork. Returns the branch.
 */
export async function forkTail(src: ConversationRow, doomed: MessageRow[], fromId: number): Promise<ConversationRow | null> {
  if (!doomed.length) return null;
  void fromId;
  let cs: Record<string, unknown> = {};
  try { cs = JSON.parse(src.settings || "{}"); } catch { /* ignore */ }
  // the backup copy keeps the world state it left behind, but its checkpoint
  // & loop stacks belong to the parent — a reopen is just a record to replay
  delete cs.checkpoints;
  delete cs.loops;
  const branch = createConversation({
    title: (src.title || "Partie") + " · boucle",
    world_id: src.world_id, persona_id: src.persona_id, scenario_id: src.scenario_id,
    cast: src.cast, group_mode: src.group_mode, settings: JSON.stringify(cs),
    memory_json: src.memory_json, summary: src.summary, summary_msg_id: src.summary_msg_id,
    parent_id: src.id, branch_kind: "abandoned",
  });
  const imgSrcDir = path.join(IMAGES_DIR, "conversations", String(src.id));
  const imgDstDir = path.join(IMAGES_DIR, "conversations", String(branch.id));
  for (const m of doomed) {
    const meta = messageView({ ...m }).meta as any;
    const newMid = createMessage({
      conversation_id: branch.id, role: m.role, name: m.name, content: m.content,
      segments: m.segments, meta: "{}",
    }).id;
    if (meta?.image) {
      const file = path.basename(meta.image);
      const srcImg = path.join(imgSrcDir, file);
      if (fs.existsSync(srcImg)) {
        fs.mkdirSync(imgDstDir, { recursive: true });
        fs.copyFileSync(srcImg, path.join(imgDstDir, file));
        meta.image = `/images/conversations/${branch.id}/${file}`;
      }
    }
    delete meta.suggestions;
    updateMessage(newMid, { meta: JSON.stringify(meta) });
  }
  updateConversation(branch.id, { last_message: doomed[doomed.length - 1].content.slice(0, 200) });
  return branch;
}

/** Condense a doomed stretch into a narrator loop-summary (~3000 tokens budget). */
export async function summarizeLoop(title: string, doomed: MessageRow[]): Promise<{ title: string; summary: string }> {
  const fallback = { title: "Boucle", summary: "Une tentative aboutit à une impasse. Les détails de ce trajet ont été écrasés par le retour." };
  const sys = promptFilled("loop-summary-system", { title: title.slice(0, 60) });
  const transcript = transcriptFor(doomed, 200);
  if (!transcript.trim()) return fallback;
  try {
    const p = await llmJson(transcript, sys, 900, 0.7);
    const t = String(p?.title ?? "").trim().slice(0, 80);
    const s = String(p?.summary ?? "").trim().slice(0, 2000);
    if (t && s) return { title: t, summary: s };
  } catch { /* offline */ }
  return fallback;
}

export async function suggestLore(conv: ConversationRow, msgs: MessageRow[]): Promise<{ name: string; triggers: string; content: string }[]> {
  const LORE_FMT = '{"entries":[{"name":"faction ou lieu ou personne","triggers":"mots-clés (séparés par des virgules) qui signalent ce fait","content":"2 à 4 phrases fixes du canon, sans pronoms personnels de la scène"}]}';
  const sys = promptFilled("lore-suggest-system", { title: (conv.title || "").slice(0, 60), fmt: LORE_FMT });
  const transcript = transcriptFor(msgs.slice(-14), 280);
  if (!transcript.trim()) return [];
  try {
    const p = await llmJson(transcript, sys, 900, 0.7);
    const raw = Array.isArray(p?.entries) ? p.entries : [];
    return raw
      .map((e: any) => ({
        name: String(e?.name ?? "").trim().slice(0, 120),
        triggers: String(e?.triggers ?? "").trim().slice(0, 300),
        content: String(e?.content ?? "").trim().slice(0, 2000),
      }))
      .filter((x) => x.name && x.content);
  } catch { /* offline */ }
  return [];
}

// ─── player-owned canon: AI proposals ────────────────────────────────────────
// The model reads the recent fiction and proposes stable facts (identities,
// relations, possessions, promises…). Proposals land in status "proposed" and
// are only injected into the prompt once the player approves them.
export const CANON_FMT = '{"facts":[{"subject":"Alba","fact":"Alba est une revenante."}]}';

export async function proposeCanonFacts(convId: number, msgs: MessageRow[], signal?: AbortSignal): Promise<CanonRow[]> {
  const conv = getConversation(convId);
  if (!conv) return [];
  const story = storyMessages(msgs).slice(-20);
  if (story.length < 2) return [];
  const existing = listCanon(convId).filter((e) => e.status === "confirmed" || e.status === "proposed");
  const known = new Set(existing.map((e) => assistKey(e.subject)));
  const sys = promptFilled("canon-propose-system", { fmt: CANON_FMT });
  const p = await llmJson(transcriptFor(story, 40), sys, 800, 0.4, 120_000, undefined, signal);
  const raw = Array.isArray(p?.facts) ? p.facts : [];
  const created: CanonRow[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    const subject = String(f?.subject ?? "").trim().slice(0, 120);
    const fact = String(f?.fact ?? "").trim().slice(0, 2000);
    const key = assistKey(subject);
    if (!subject || !fact || !key) continue;
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    created.push(createCanon({
      conversation_id: convId,
      world_id: conv.world_id,
      subject,
      fact,
      status: "proposed",
      origin: "ai",
      source_message_id: story[story.length - 1]?.id ?? null,
    }));
  }
  return created;
}

export async function suggestChapter(title: string, msgs: MessageRow[]): Promise<{ title: string; summary: string } | null> {
  const sys = promptFilled("chapter-suggest-system", { title: title.slice(0, 60) });
  const p = await llmJson(transcriptFor(msgs), sys);
  const t = String(p?.title ?? "").trim().slice(0, 80);
  const s = String(p?.summary ?? "").trim().slice(0, 1200);
  return t && s ? { title: t, summary: s } : null;
}

// ─── session recap ("Previously on…") ────────────────────────────────────────
// When a party is reopened after an idle break with enough new story since the
// last recap, the narrator writes a short recap and proposes a 1-3 shot
// storyboard. The recap lives in conversation settings (settings.recap) — never
// in the message list — so no message-level logic needs to know about it; it is
// injected into the system prompt (buildSystemPrompt « Récap de la session
// précédente ») so cross-session context survives the context window. The
// storyboard PNGs are rendered in the background by the local Koji pipeline
// (deterministic seeds → GPU cache) and stored on each shot as they finish.
export const RECAP_MIN_MESSAGES = 6; // story messages since the last recap
export const RECAP_MAX_SHOTS = 3;

export type RecapShot = { caption: string; prompt: string; image?: string; seed?: number; status: "pending" | "done" | "error"; error?: string };
export type RecapData = { title: string; text: string; at: number; last_msg_id: number; shots: RecapShot[] };

export function recapOf(conv: ConversationRow): { cs: any; recap: RecapData | null } {
  const cs = conversationSettingsOf(conv);
  const r = cs.recap;
  return { cs, recap: r && typeof r === "object" && !Array.isArray(r) ? r : null };
}

/** Messages that belong to the story (display-only markers such as chapters or rewind notes excluded). */
export function storyMessages(msgs: MessageRow[]): MessageRow[] {
  return msgs.filter((m) => {
    try { const meta = JSON.parse(m.meta || "{}"); return !meta.chapter && !meta.rewind; } catch { return true; }
  });
}

export async function suggestRecap(title: string, msgs: MessageRow[]): Promise<{ title: string; text: string; shots: { caption: string; prompt: string }[] } | null> {
  const sys = promptFilled("recap-suggest-system", { title: title.slice(0, 60), maxShots: RECAP_MAX_SHOTS });
  const p = await llmJson(transcriptFor(msgs, 120), sys, 1400, 0.8);
  const t = String(p?.title ?? "").trim().slice(0, 100);
  const text = String(p?.recap ?? p?.text ?? "").trim().slice(0, 2000);
  if (!t || !text) return null;
  const shots = Array.isArray(p?.shots)
    ? p.shots
        .map((s: any) => ({
          caption: String(s?.caption ?? "").trim().slice(0, 200),
          prompt: String(s?.prompt ?? "").trim().slice(0, 900),
        }))
        .filter((s) => s.caption && s.prompt)
        .slice(0, RECAP_MAX_SHOTS)
    : [];
  return { title: t, text, shots };
}

/** Deterministic per conversation+shot seed, so re-renders hit the image cache. */
export function recapShotSeed(convId: number, i: number): number {
  const x = Math.imul(convId + 1, 2654435761) ^ Math.imul(i + 1, 40503);
  return (x >>> 0) % 2_147_483_647;
}

/**
 * Render the storyboard of the current recap in the background, one shot at a
 * time (the GPU is shared with scene illustrations). Each finished shot is
 * persisted into settings.recap so the UI can poll GET …/recap for progress.
 * Never throws: shot-level failures are recorded on the shot itself.
 */
/**
 * Render ONE recap shot (the work behind the tracked "image / recap-shot"
 * jobs). Persists only if the recap wasn't replaced meanwhile, so a stale
 * job never overwrites a newer recap's shots.
 */
export async function renderRecapShot(convId: number, shotIndex: number): Promise<void> {
  const conv = getConversation(convId);
  if (!conv) return;
  const { recap } = recapOf(conv);
  const shot = recap?.shots?.[shotIndex];
  if (!recap || !shot || shot.status === "done") return;
  shot.status = "pending";
  shot.error = undefined as any;
  try {
    const res = await generateAndSave(`conversations/${convId}`, {
      prompt: `masterpiece, best quality, anime illustration, highly detailed, vibrant colors, ${shot.prompt.trim()}`,
      negative: NEGATIVE_PROMPT,
      steps: Number(getSetting("image_steps", 28)),
      cfg: Number(getSetting("image_cfg", 7)),
      width: 1152, height: 768, // storyboard shots are landscape
      seed: recapShotSeed(convId, shotIndex),
    });
    shot.image = res.url;
    shot.seed = res.seed;
    shot.status = "done";
    delete shot.error;
    console.log(`[recap] 🎨 shot ${shotIndex + 1} (#${convId}) ok`);
  } catch (e) {
    shot.status = "error";
    shot.error = String(e?.message ?? e).slice(0, 200);
    console.warn(`[recap] shot ${shotIndex + 1}/${recap.shots.length} (#${convId}) échec: ${shot.error}`);
  }
  // persist — but only if the recap hasn't been replaced meanwhile
  const cur = getConversation(convId);
  if (!cur) return; // conversation deleted mid-render
  const curR = recapOf(cur);
  if (curR.recap && curR.recap.at === recap.at && Array.isArray(curR.recap.shots) && curR.recap.shots[shotIndex]) {
    Object.assign(curR.recap.shots[shotIndex], shot);
    curR.cs.recap = curR.recap;
    updateConversation(convId, { settings: JSON.stringify(curR.cs) });
  }
}

/** Run one recap shot as a tracked, retryable image job. */
export function runRecapShotJob(convId: number, shotIndex: number): void {
  void trackJob(
    {
      type: "image",
      title: "Illustration du récap",
      conversationId: convId,
      payload: { op: "recap-shot", conversationId: convId, shotIndex },
      cancellable: true,
      retryable: true,
    },
    async () => {
      await renderRecapShot(convId, shotIndex);
    },
  ).catch(() => {});
}

/**
 * Queue every pending recap shot as a tracked image job. Fire-and-forget (the
 * routes call this in the background); each shot reports through the jobs hub.
 */
export async function renderRecapShots(convId: number): Promise<void> {
  const conv = getConversation(convId);
  if (!conv) return;
  const { recap } = recapOf(conv);
  if (!recap || !Array.isArray(recap.shots)) return;
  let queued = 0;
  for (const s of recap.shots) {
    if (s.status !== "done") { s.status = "pending"; delete s.error; queued++; }
  }
  if (queued) {
    // persist the (re)queued markers so the per-shot jobs start from a clean slate
    const { cs } = recapOf(conv);
    cs.recap = recap;
    updateConversation(convId, { settings: JSON.stringify(cs) });
    recap.shots.forEach((s, i) => {
      if (s.status === "pending") runRecapShotJob(convId, i);
    });
  }
}

// ─── relationship graph (affinities that evolve during play) ─────────────────
// After each scene (auto, throttled) or on demand, the model reads the recent
// story and updates what each named character feels for the others. Stored in
// conversation settings (settings.rels) as DIRECTED pairs a→b with a score in
// [-100, 100] plus a justifying note; visualised as a graph in the chat. The
// world-level (static) relations table is deliberately not touched.
export const REL_AUTO_MIN_MESSAGES = 6; // new story messages before an auto re-scan
export const REL_AUTO_IDLE_MS = 3 * 60_000; // min time between two auto scans
export const REL_SCAN_WINDOW = 20; // messages handed to the model per scan
export const REL_MAX_PAIRS = 60;

export type RelPair = { a: string; b: string; value: number; note: string; at: number };
export type RelState = { at: number; last_msg_id: number; pairs: RelPair[] };

export function relPairKey(a: string, b: string): string {
  return `${a}\u241f${b}`;
}

export function relsOf(conv: ConversationRow): { cs: any; rels: RelState | null } {
  const cs = conversationSettingsOf(conv);
  const r = cs.rels;
  const ok = r && typeof r === "object" && !Array.isArray(r) && Array.isArray(r.pairs);
  return { cs, rels: ok ? r : null };
}

/**
 * Merge a fresh model read into the accumulated graph: listed pairs overwrite
 * their previous value, unlisted pairs stay (affinities persist across scenes).
 */
export function mergeRels(prev: RelState | null, fresh: RelPair[]): { pairs: RelPair[]; changed: number } {
  const byKey = new Map<string, RelPair>();
  for (const p of prev?.pairs ?? []) byKey.set(relPairKey(p.a, p.b), p);
  let changed = 0;
  for (const p of fresh) {
    const key = relPairKey(p.a, p.b);
    const old = byKey.get(key);
    if (!old || old.value !== p.value || old.note !== p.note) changed++;
    byKey.set(key, p);
  }
  const pairs = [...byKey.values()].sort((x, y) => y.at - x.at).slice(0, REL_MAX_PAIRS);
  return { pairs, changed };
}

export async function suggestRelations(known: string[], msgs: MessageRow[], signal?: AbortSignal): Promise<RelPair[] | null> {
  const knownTxt = known.length ? known.join(", ") : "aucun — utilise les noms tels qu'écrits dans la fiction";
  const sys = promptFilled("relations-system", { known: knownTxt });
  const p = await llmJson(transcriptFor(msgs, REL_SCAN_WINDOW), sys, 1200, 0.6, 120_000, undefined, signal);
  const list = Array.isArray(p?.relations) ? p.relations : null;
  if (!list) return null;
  const strip = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  const norm = (name: string): string => {
    const key = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const wanted = key(name);
    return known.find((k) => key(k) === wanted) ?? name;
  };
  const out: RelPair[] = [];
  for (const r of list) {
    const a = strip(r?.a);
    const b = strip(r?.b);
    if (!a || !b) continue;
    const na = norm(a);
    const nb = norm(b);
    if (na.toLowerCase() === nb.toLowerCase()) continue;
    const value = Math.max(-100, Math.min(100, Math.round(Number(r?.value) || 0)));
    const note = String(r?.note ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
    out.push({ a: na, b: nb, value, note, at: Date.now() });
  }
  return out;
}

export async function suggestNpcs(conv: ConversationRow, msgs: MessageRow[]): Promise<NpcSuggestion[]> {
  let castNames: string[] = [];
  try { castNames = (JSON.parse(conv.cast || "[]") as number[]).map((id) => getCard(Number(id))?.name ?? "").filter(Boolean); } catch { /* ignore */ }
  const norm = (s: string) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const castNorm = castNames.map(norm).filter(Boolean);
  const transcript = transcriptFor(msgs, 24);
  // a name collides with a card already in the party — exact, or word-level
  // ("Tavernier Grolo" vs the card "Tavernier") so variants of an existing
  // character are never re-proposed
  const collides = (nameRaw: string): boolean => {
    const n = norm(nameRaw);
    if (!n) return true;
    if (castNorm.includes(n)) return true;
    const words = n.split(/[\s'’-]+/).filter((w) => w.length >= 3);
    return castNorm.some((c) => {
      if (words.includes(c)) return true;
      // plural/possessive drift: "Taverniers", "l'ombre" spanning glue chars
      return c.length >= 4 && (n.startsWith(c + "s") || n.startsWith(c + "x") || n.startsWith(c + " "));
    });
  };
  const clean = (list: any[]): NpcSuggestion[] => {
    const seen = new Set<string>();
    const out: NpcSuggestion[] = [];
    for (const x of list) {
      const name = String(x?.name ?? "").trim().slice(0, 80);
      const key = norm(name);
      if (!name || !String(x?.description ?? "").trim()) continue;
      if (collides(name) || seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        description: String(x?.description ?? "").trim().slice(0, 1500),
        personality: String(x?.personality ?? "").trim().slice(0, 1200),
        role: String(x?.role ?? "").trim().slice(0, 400),
      });
    }
    return out.slice(0, 3);
  };
  // explicit exclusion list: the model famously re-proposes existing cast
  // members (then the filter drops them and the user sees "Aucun PNJ") — make
  // the rule loud and give the model a sanctioned empty answer instead
  const sys = (extra: string) => promptFilled("npc-suggest-system", {
    castNames: castNames.join(", ") || "aucun",
    extra,
    npcfmt: NPC_FMT,
  });
  const castsJoined = castNames.join(", ") || "aucun";
  const first = await llmJson(transcript, sys(""), 900, 0.8);
  let out = clean(Array.isArray(first?.npcs) ? first.npcs as any[] : []);
  // first pass only re-proposed cast members (or nothing) → one targeted retry
  if (!out.length) {
    const fallback = await llmJson(transcript, sys(`Rappel : ta première réponse ne contenait que des personnages déjà en carte (${castsJoined}) ou rien. Trouve un personnage secondaire DIFFÉRENT réellement présent dans ces échanges et donne-lui un nom propre inédit ; sinon {"npcs":[]}.`), 900, 0.6);
    out = clean(Array.isArray(fallback?.npcs) ? fallback.npcs as any[] : []);
    if (out.length) console.log(`[npcs] 💡 partie #${conv.id} — 1er essai vide (membres du casting re-proposés ?), 2e essai : ${out.map((n) => n.name).join(", ")}`);
  }
  return out;
}

// ─── quest journal ────────────────────────────────────────────────────────────
// The model reads the conversation and extracts the player's concrete
// objectives (0-5). Stored in conv.settings.quests — purely a UI aid, never
// injected in the prompt (the player may fake or reorder them).
export type Quest = { title: string; status: "active" | "done" | "dropped"; notes?: string };

export async function generateQuests(title: string, messages: MessageRow[]): Promise<Quest[]> {
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) {
    const models = await provider.models();
    model = models[0] ?? "";
  }
  const transcript = messages
    .slice(-60)
    .map((m) => `${m.role === "user" ? "Joueur" : m.name || "Narrateur"} : ${(m.content || "").replace(/\s+/g, " ").slice(0, 320)}`)
    .join("\n");
  const sys = promptFilled("quests-system", { title: title.slice(0, 60) });
  let text = "";
  try {
    text = await provider.complete({
      messages: [{ role: "system", content: sys }, { role: "user", content: transcript }],
      model,
      temperature: 0.6,
      maxTokens: 900,
      noThinking: true,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    console.warn("[quests] complete failed:", String(e?.message ?? e).slice(0, 160));
    return [];
  }
  try {
    const parsed = parseCardAssistJson(text || "");
    const list = Array.isArray(parsed?.quests) ? parsed.quests : [];
    return list
      .map((q: any) => ({
        title: String(q?.title ?? "").trim().slice(0, 140),
        status: ["active", "done", "dropped"].includes(q?.status) ? q.status : "active",
        notes: String(q?.notes ?? "").trim().slice(0, 400),
      }))
      .filter((q: Quest) => q.title)
      .slice(0, 6);
  } catch (e) {
    console.warn("[quests] JSON invalide:", String(e?.message ?? e).slice(0, 120));
    return [];
  }
}

export interface RpgQuestion {
  q: string;
  answers: string[];
}

/**
 * Questionnaire du meneur : the narrator prepares a short batch of questions
 * for the PLAYER, grounded in the world / cast / scenario / current scene, to
 * guide the RP (motivations, intentions, relations, upcoming choices). Each
 * question carries 2-4 suggested answers the player can pick or override.
 * Returns null when the model can't answer.
 */
export async function generateQuestions(conv: ConversationRow, messages: MessageRow[], count = 5): Promise<RpgQuestion[] | null> {
  const view = conversationView(conv.id)!;
  const msgs = messages.slice(-40);
  const { kept, summary, memory } = applyContextWindow(conv.id, conv, msgs);
  const personaName = view.persona?.name ?? "le joueur";
  const castLine = view.cards.length
    ? `Personnages en scène : ${view.cards.map((c: any) => c.name).join(", ")}.`
    : "Aucun personnage en scène.";
  const worldLine = view.world
    ? `Monde : ${view.world.name}.${view.world.description ? ` ${view.world.description.slice(0, 300)}` : ""}`
    : "Monde générique.";
  const sceneLine = (view.scenario?.intro || "").trim().slice(0, 400);
  const recent = [...kept].slice(-8)
    .map((m) => `${m.role === "user" ? personaName : (m.name || "Narrateur")} : ${(m.content || "").replace(/\s+/g, " ").slice(0, 260)}`)
    .join("\n");
  const memLine = (memory ? memoryToText(memory) : summary || "").trim().slice(0, 600);
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) {
    const models = await provider.models().catch(() => []);
    model = models[0] ?? "";
  }
  const n = Math.max(1, Math.min(8, Math.round(count)));
  const sys = promptFilled("questions-system", { count: n, persona: personaName });
  const prompt = [
    worldLine,
    castLine,
    sceneLine ? `Situation de départ : ${sceneLine}` : "",
    recent ? `Derniers échanges :\n${recent}` : "",
    memLine ? `Mémoire : ${memLine}` : "",
    `Pose ${n} questions qui guident la suite de la partie.`,
  ].filter(Boolean).join("\n\n");
  let text = "";
  try {
    text = await provider.complete({
      messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
      model,
      temperature: 0.8,
      maxTokens: 1600,
      noThinking: true,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    console.warn("[questions] complete failed:", String((e as any)?.message ?? e).slice(0, 160));
    return null;
  }
  const arr = parseJsonArray(text || "");
  if (!arr || !arr.length) {
    // tolerant fallback: some models wrap the list in an object
    const obj = parseCardAssistJson(text || "");
    const wrapped = obj && Array.isArray((obj as any).questions) ? (obj as any).questions : null;
    if (!wrapped?.length) return null;
    return normalizeQuestions(wrapped, n);
  }
  return normalizeQuestions(arr, n);
}

/** Extract + parse the first balanced JSON array — robust to prose around it. */
export function parseJsonArray(text: string): unknown[] | null {
  const raw = String(text)
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/[“”]/g, '"')
    .replace(/^\ufeff+/u, "");
  const tryParse = (s: string): unknown[] | null => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : null;
    } catch { return null; }
  };
  const fast = tryParse(raw);
  if (fast) return fast;
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") { if (depth === 0) start = i; depth++; }
    else if (c === "]") { depth--; if (depth === 0 && start >= 0) return tryParse(raw.slice(start, i + 1)); }
  }
  return null;
}

function normalizeQuestions(raw: unknown[], n: number): RpgQuestion[] {
  return raw
    .map((x: any) => {
      const q = String(x?.q ?? x?.question ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
      const answers = (Array.isArray(x?.answers) ? x.answers : [])
        .map((a: unknown) => String(a ?? "").trim().replace(/\s+/g, " ").slice(0, 180))
        .filter(Boolean)
        .slice(0, 4);
      return q ? { q, answers } : null;
    })
    .filter((x: RpgQuestion | null): x is RpgQuestion => x !== null)
    .slice(0, n);
}

/** Extract + parse the first balanced JSON object — robust to prose around it,
 * braces inside strings and raw newlines in string values (models cheat). */
export function parseCardAssistJson(text: string): Record<string, unknown> | null {
  // Small local models frequently emit curly typographic quotes around keys
  // and values (“name”:…). Normalize them to straight quotes BEFORE parsing so
  // the balanced-block scan treats them as real string delimiters; curly
  // apostrophes (’) stay content and are harmless inside double-quoted JSON.
  const raw = String(text)
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘]/g, "'")
    .replace(/^\ufeff+/u, "");
  const tryParse = (s: string): Record<string, unknown> | null => {
    try { return JSON.parse(s); } catch { return null; }
  };
  const fast = tryParse(raw);
  if (fast) return fast;
  // find the outermost balanced {...} block, ignoring braces inside strings
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (start < 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const block = raw.slice(start, i + 1);
        const direct = tryParse(block);
        if (direct) return direct;
        // sanitize: collapse raw newlines inside string values, drop trailing commas
        const cleaned = block.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (m, inner) => '"' + inner.replace(/[\r\n\t]+/g, " ") + '"').replace(/,([\s]*[}\]])/g, "$1");
        const lenient = tryParse(cleaned);
        if (lenient) return lenient;
        return null;
      }
    }
  }
  return null;
}

// ─── context window management ────────────────────────────────────────────────
// Keep only the recent messages for the model; older messages are compressed
// into a rolling summary (updated in the background by the LLM itself).
// Packing is deterministic and budget-driven: when `context_max_tokens` is set
// the kept window is sized by TOKENS (complete user/assistant exchanges only),
// otherwise it falls back to the legacy message-count cap.
export const SUMMARY_PREFIX = "(Session antérieure résumée)\n";

export function contextConfig(conv: ConversationRow): { maxMsgs: number; maxTokens: number; capSource: string } {
  const cs = conversationSettingsOf(conv);
  // per-world caps act as a hard ceiling over the conversation's own values,
  // so a world with a small model can protect every party in it
  let maxMsgs = Number(cs.context_max_messages ?? getSetting("context_max_messages", 20));
  let maxTokens = Number(cs.context_max_tokens ?? getSetting("context_max_tokens", 0));
  let capSource = "partie";
  const world = conv.world_id ? getWorld(conv.world_id) : null;
  if (world) {
    let ws: Record<string, unknown> = {};
    try { ws = JSON.parse(world.settings || "{}"); } catch { /* ignore */ }
    const worldMsgs = Number(ws.context_max_messages ?? getSetting("world_context_max_messages", 0));
    if (worldMsgs > 0) { maxMsgs = Math.min(maxMsgs, worldMsgs); capSource = "monde"; }
    const worldTokens = Number(ws.context_max_tokens ?? getSetting("world_context_max_tokens", 0));
    if (worldTokens > 0) {
      if (maxTokens <= 0) capSource = "monde";
      maxTokens = maxTokens > 0 ? Math.min(maxTokens, worldTokens) : worldTokens;
    }
  }
  return { maxMsgs: Math.max(4, Math.round(maxMsgs)), maxTokens: Math.max(0, Math.round(maxTokens)), capSource };
}

/**
 * Greedy token-budget pack from the END of the thread, keeping complete
 * user/assistant exchanges. Orphaned assistant replies (a reply whose question
 * fell outside the window) are dropped so the model never answers into a void.
 */
export function packByTokens(history: MessageRow[], msgBudget: number): MessageRow[] {
  const kept: MessageRow[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const cost = estimateTokens(m.content);
    if (kept.length && used + cost > msgBudget) break;
    kept.unshift(m);
    used += cost;
  }
  // drop orphaned assistant replies (no preceding user question in the window)
  return kept.filter((m, i) => !(m.role === "assistant" && (i === 0 || kept[i - 1].role !== "user")));
}

/**
 * Serialized per-conversation summary queue: batches run one after another, so
 * an older background batch can never overwrite a newer one's state. Each run
 * also re-checks the watermark and skips when a newer summary already covered
 * the range (see summarizeMessages).
 */
const summaryQueues = new Map<number, Promise<void>>();

export function summarizeOverflow(convId: number, conv: ConversationRow, newMsgs: MessageRow[]): void {
  const prev = summaryQueues.get(convId) ?? Promise.resolve();
  const next = prev
    .then(() => runSummarize(convId, newMsgs))
    .catch((e) => console.error(`[summary] failed (#${convId}):`, String(e?.message ?? e).slice(0, 200)));
  summaryQueues.set(convId, next);
  void next.finally(() => {
    if (summaryQueues.get(convId) === next) summaryQueues.delete(convId);
  });
}

async function runSummarize(convId: number, newMsgs: MessageRow[]): Promise<void> {
  const conv = getConversation(convId);
  if (!conv) return;
  const maxId = newMsgs.reduce((a, m) => Math.max(a, m.id), 0);
  if (Number(conv.summary_msg_id ?? 0) >= maxId) return; // already covered
  await trackJob(
    {
      type: "summary",
      title: "Résumé du fil",
      conversationId: convId,
      payload: { conversationId: convId, messageIds: newMsgs.map((m) => m.id) },
      retryable: true,
    },
    async (job, api) => {
      const fresh = getConversation(convId);
      if (!fresh || Number(fresh.summary_msg_id ?? 0) >= maxId) return;
      await summarizeMessages(convId, fresh, newMsgs, api.signal);
    },
  ).catch((e) => console.error("[summary] failed:", String(e?.message ?? e).slice(0, 200)));
}

/**
 * Pure window computation (no side effects): the message list the model will
 * actually receive. Token-budget packing when context_max_tokens is set, else
 * the legacy message-count cap. Shared by applyContextWindow and the context
 * inspector so what the UI shows is exactly what gets sent.
 */
export function computeKept(conv: ConversationRow, history: MessageRow[]): MessageRow[] {
  const cfg = contextConfig(conv);
  if (cfg.maxTokens > 0 && history.length > 2) {
    const msgBudget = Math.max(200, cfg.maxTokens - Math.min(1500, Math.round(cfg.maxTokens * 0.3)));
    let kept = packByTokens(history, msgBudget);
    // the message-count cap still acts as a hard ceiling on the number of turns
    if (kept.length > cfg.maxMsgs) kept = kept.slice(-cfg.maxMsgs);
    return kept;
  }
  return history.slice(-cfg.maxMsgs);
}

export function applyContextWindow(
  convId: number,
  conv: ConversationRow,
  history: MessageRow[],
): { kept: MessageRow[]; summary?: string; memory?: MemoryState } {
  const kept = computeKept(conv, history);
  const memory = parseMemory(conv.memory_json) || undefined;
  if (kept.length === history.length) return { kept, summary: conv.summary || undefined, memory };
  const firstKeptId = kept[0]?.id ?? 0;
  const overflow = history.filter((m) => m.id < firstKeptId);
  const newMsgs = overflow.filter((m) => m.id > (conv.summary_msg_id ?? 0));
  if (newMsgs.length) summarizeOverflow(convId, conv, newMsgs); // background, non-blocking
  return { kept, summary: conv.summary || undefined, memory };
}

/**
 * Narrative consistency check: ask the LLM for a list of incohérences
 * (dead character back, item used before obtained, POV violation…).
 * Button-triggered, never blocks a turn. Returns null when the model fails.
 */
export async function validateNarrative(convId: number): Promise<{ findings: any[] } | null> {
  const conv = getConversation(convId);
  if (!conv) return null;
  const view = conversationView(convId)!;
  const msgs = listMessages(convId).slice(-16);
  if (msgs.length < 2) return { findings: [] };
  const { kept, summary, memory } = applyContextWindow(convId, conv, msgs);
  const { system } = buildMessages(
    { world: view.world, persona: view.persona, cards: view.cards, scenario: view.scenario, conversation: conv, summary, memory },
    kept,
  );
  const transcript = msgs.map((m) => `${m.role === "user" ? "Joueur" : (m.name || "Narrateur")} : ${m.content.slice(0, 800)}`).join("\n");
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) { const models = await provider.models().catch(() => []); model = models[0] ?? ""; }
  if (!model) return null;
  const sys = promptText("coherence-system");
  const text = await provider
    .complete({
      messages: [{ role: "system", content: system + "\n\n" + sys }, { role: "user", content: transcript }],
      model, temperature: 0.2, maxTokens: 500, noThinking: true, signal: AbortSignal.timeout(90_000),
    })
    .catch(() => "");
  if (!text) return null;
  const parse = (t: string) => {
    try {
      const p = JSON.parse(t);
      return p && Array.isArray(p.findings) ? { findings: p.findings.slice(0, 6) } : null;
    } catch { return null; }
  };
  return parse(text) ?? (() => { const m = text.match(/\{[\s\S]*\}/); return m ? parse(m[0]) : null; })();
}

/**
 * Ask the LLM for a compact structured "scene state" (location, characters,
 * goals, dangers, secrets) used by the collapsible chat panel. Never throws.
 */
export async function generateSceneState(convId: number): Promise<Record<string, unknown> | null> {
  const conv = getConversation(convId);
  if (!conv) return null;
  const view = conversationView(convId)!;
  const msgs = listMessages(convId);
  if (!msgs.length) return null;
  const { kept, summary, memory } = applyContextWindow(convId, conv, msgs);
  const { system } = buildMessages(
    { world: view.world, persona: view.persona, cards: view.cards, scenario: view.scenario, conversation: conv, summary, memory },
    kept,
  );
  const recent = msgs.slice(-8).map((m) => `${m.role === "user" ? "Joueur" : (m.name || "Narrateur")} : ${m.content.slice(0, 600)}`).join("\n");
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) { const models = await provider.models().catch(() => []); model = models[0] ?? ""; }
  if (!model) return null;
  const sys = promptText("scene-state-system");
  const text = await provider
    .complete({
      messages: [{ role: "system", content: system + "\n\n" + sys }, { role: "user", content: recent }],
      model, temperature: 0.3, maxTokens: 400, noThinking: true, signal: AbortSignal.timeout(90_000),
    })
    .catch(() => "");
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  }
  return null;
}

/**
 * Ask the LLM to spot MAJOR events across a world's playthroughs (arrivals,
 * pacts, battles, item gains, revelations, big choices). Proposals only — the
 * user accepts them one by one. Returns null when the model can't answer.
 */
export async function proposeTimelineEvents(worldId: number): Promise<{ proposals: any[] } | null> {
  const world = getWorld(worldId);
  if (!world) return null;
  const convs = listConversations().filter((c) => c.world_id === worldId);
  const threads: { conv: ConversationRow; msgs: MessageRow[] }[] = [];
  for (const conv of convs) {
    const msgs = listMessages(conv.id).slice(-40);
    if (msgs.length >= 2) threads.push({ conv, msgs });
  }
  if (!threads.length) return { proposals: [] };
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) { const models = await provider.models().catch(() => []); model = models[0] ?? ""; }
  if (!model) return null;
  const transcript = threads
    .map(({ conv, msgs }) => `--- Partie : ${conv.title} ---\n` + msgs.map((m) => `${m.role === "user" ? "Joueur" : (m.name || "Narrateur")} : ${m.content.slice(0, 500)}`).join("\n"))
    .join("\n\n");
  const sys = promptText("timeline-system");
  const text = await provider
    .complete({
      messages: [{ role: "system", content: sys }, { role: "user", content: transcript.slice(0, 16000) }],
      model, temperature: 0.3, maxTokens: 700, noThinking: true, signal: AbortSignal.timeout(90_000),
    })
    .catch(() => "");
  if (!text) return null;
  const parse = (t: string): any[] | null => {
    try {
      const p = JSON.parse(t);
      if (Array.isArray(p)) return p;
      if (p && Array.isArray(p.proposals)) return p.proposals;
      return null;
    } catch { return null; }
  };
  let arr = parse(text) ?? (() => { const m = text.match(/\[[\s\S]*\]/); return m ? parse(m[0]) : null; })();
  if (!arr) return null;
  arr = arr.slice(0, 6).filter((p: any) => p && typeof p.label === "string" && p.label.trim());
  // attach the source extract (nearest message mention) so the user can verify
  const existing = new Set(listTimeline(worldId).map((e) => e.label.trim().toLowerCase()));
  const proposals = arr.map((p: any) => {
    const needle = String(p.message || "").trim().slice(0, 60).toLowerCase();
    let found: { conversation_id: number; title: string; extract: string } | null = null;
    for (const { conv, msgs } of threads) {
      for (const m of msgs) {
        if (needle && m.content.toLowerCase().includes(needle)) {
          found = { conversation_id: conv.id, title: conv.title, extract: m.content.slice(0, 200) };
          break;
        }
      }
      if (found) break;
    }
    return {
      label: p.label.trim(),
      message: String(p.message || "").trim().slice(0, 120),
      conversation_id: found?.conversation_id ?? null,
      conversation: found?.title ?? null,
      extract: found?.extract ?? null,
      duplicate: existing.has(p.label.trim().toLowerCase()),
    };
  });
  return { proposals };
}

// ─── job work functions (wrapped in tracked jobs by the routers) ─────────────

/**
 * Message-illustration pipeline (the work behind the tracked "image" jobs).
 * Character consistency, world negative prompt, img2img from the avatar.
 */
export async function generateMessageIllustration(
  conversationId: number,
  messageId: number,
  opts: { kind?: string; seed?: number; vary?: boolean; variation?: string } = {},
  signal?: AbortSignal,
): Promise<{ url: string; seed?: number; kind: string; character: string | null }> {
  const conv = getConversation(conversationId);
  const m = getMessage(messageId);
  if (!conv || !m || m.conversation_id !== conversationId) throw new HttpError(404, "not found");
  const world = conv.world_id ? getWorld(conv.world_id) : null;
  let cast: any[] = [];
  try { cast = (JSON.parse(conv.cast || "[]") as number[]).map((cid) => getCard(Number(cid))).filter(Boolean); } catch { /* ignore */ }
  // "character" forces a character portrait (first cast card as fallback)
  const forcedChar = opts.kind === "character";
  const char = forcedChar
    ? (characterForMessage(cast, m.content) ?? cast[0] ?? null)
    : characterForMessage(cast, m.content);
  const kind = forcedChar ? "portrait"
    : opts.kind === "landscape" || opts.kind === "portrait" ? opts.kind
    : detectSceneKind(m.content);
  const landscape = kind === "landscape";
  let prompt = buildIllustrationPrompt(world?.name ?? "", world?.description ?? "", world?.tone ?? "épique", m.content, kind, char);
  const seed =
    typeof opts.seed === "number" ? opts.seed
    : opts.vary ? undefined
    : char ? charSeed(char.id)
    : undefined;
  // optional seed-locked variation: same seed + a prompt tweak = same
  // composition, different details (used by the gallery's 🔒 button)
  if (typeof opts.variation === "string" && opts.variation.trim()) {
    prompt = `${prompt}\n(${opts.variation.trim().slice(0, 300)})`;
  }
  // img2img: use the character's avatar as a visual reference so their
  // face stays consistent from one illustration to the next
  let init_image: string | undefined;
  const fullChar = char ? cast.find((c) => c.id === char.id) ?? null : null;
  const avatarRel = fullChar?.avatar ?? "";
  if (avatarRel) {
    const avatarFile = mediaFileFor(avatarRel);
    if (avatarFile && fs.existsSync(avatarFile)) {
      init_image = fs.readFileSync(avatarFile).toString("base64");
    }
  }
  // per-world negative prompt overrides the global one (world.settings.negative)
  let negative = NEGATIVE_PROMPT;
  if (world) {
    try {
      const ws = JSON.parse(world.settings || "{}");
      if (typeof ws.negative === "string" && ws.negative.trim()) negative = ws.negative.trim();
    } catch { /* ignore */ }
  }
  const res = await generateAndSave(`conversations/${conversationId}`, {
    prompt,
    negative,
    steps: Number(getSetting("image_steps", 28)),
    cfg: Number(getSetting("image_cfg", 7)),
    width: Number(getSetting("image_width", landscape ? 1152 : 768)),
    height: Number(getSetting("image_height", landscape ? 768 : 1152)),
    seed,
    init_image,
    strength: Number(getSetting("image_ref_strength", 0.55)),
  }, signal);
  const meta = { ...messageView(m).meta, image: res.url, image_seed: res.seed, image_kind: kind, image_char: char?.name ?? undefined };
  updateMessage(messageId, { meta: JSON.stringify(meta) });
  return { url: res.url, seed: res.seed, kind, character: char?.name ?? null };
}

/**
 * Gallery-caption pipeline (the work behind the tracked "captions" jobs): the
 * model writes one-line captions for every illustration, merged into the
 * conversation's captions.json. Returns the merged captions map.
 */
export async function generateCaptions(conversationId: number, signal?: AbortSignal): Promise<Record<string, string>> {
  const conv = getConversation(conversationId);
  if (!conv) throw new HttpError(404, "not found");
  const capFile = path.join(IMAGES_DIR, "conversations", String(conversationId), "captions.json");
  let existing: Record<string, string> = {};
  try { existing = JSON.parse(fs.readFileSync(capFile, "utf8")); } catch { /* none */ }
  const items = listMessages(conversationId).map(messageView).filter((m: any) => m.meta?.image);
  if (!items.length) return existing;
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) { const models = await provider.models(); model = models[0] ?? ""; }
  const list = items.map((m: any, i: number) => `[${i + 1}] ${(m.content || "").slice(0, 300)}`).join("\n\n");
  const sys = promptText("captions-system");
  let text = "";
  try {
    for await (const delta of provider.stream({
      messages: [{ role: "system", content: sys }, { role: "user", content: `Illustrations à légender :\n\n${list}` }],
      model, temperature: 0.8, maxTokens: 800, noThinking: true,
      signal: combineSignals(signal, 120_000),
    })) { text += delta; }
  } catch (e) {
    if (signal?.aborted) throw new Error("Annulé");
    throw new HttpError(502, `Le modèle n'a pas pu écrire les légendes : ${(e as any)?.message ?? e}`);
  }
  const captions: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s*[:.-]\s*(.+)$/);
    if (m) {
      const idx = Number(m[1]) - 1;
      if (items[idx]) captions[String(items[idx].id)] = m[2].trim();
    }
  }
  Object.assign(existing, captions);
  fs.mkdirSync(path.dirname(capFile), { recursive: true });
  fs.writeFileSync(capFile, JSON.stringify(existing, null, 2));
  return existing;
}

/**
 * Relation-graph scan (the work behind the tracked "relations" jobs). Reads
 * the recent story and updates the directed affinity graph; refuses politely
 * (reason: empty/threshold/throttle) when a scan isn't due yet.
 */
export async function scanRelations(conversationId: number, force: boolean, signal?: AbortSignal): Promise<any> {
  const conv = getConversation(conversationId);
  if (!conv) throw new HttpError(404, "not found");
  const { cs, rels } = relsOf(conv);
  const story = storyMessages(listMessages(conv.id));
  if (story.length < 2) return { scanned: false, reason: "empty", have: story.length };
  const sinceId = Number(rels?.last_msg_id ?? 0);
  const fresh = story.filter((m) => m.id > sinceId);
  if (!force) {
    if (rels && Date.now() - Number(rels.at || 0) < REL_AUTO_IDLE_MS) {
      return { scanned: false, reason: "throttle" };
    }
    if (fresh.length < REL_AUTO_MIN_MESSAGES) {
      return { scanned: false, reason: "threshold", needed: REL_AUTO_MIN_MESSAGES, have: fresh.length };
    }
  }
  // known names: the cast + persona + names already in the graph, so the
  // model reuses exact spellings instead of drifting
  const known: string[] = [];
  try {
    for (const cid of JSON.parse(conv.cast || "[]") as number[]) {
      const c = getCard(Number(cid));
      if (c?.name) known.push(c.name);
    }
  } catch { /* ignore */ }
  if (conv.persona_id) {
    const po = getPersona(conv.persona_id);
    if (po?.name) known.push(po.name);
  }
  for (const p of rels?.pairs ?? []) { known.push(p.a, p.b); }
  const proposed = await suggestRelations([...new Set(known)], story.slice(-REL_SCAN_WINDOW), signal);
  if (!proposed) {
    throw new HttpError(502, "L'analyse des relations a échoué — vérifie la connexion au modèle.");
  }
  const merged = mergeRels(rels, proposed);
  const lastId = story[story.length - 1].id;
  const state: RelState = { at: Date.now(), last_msg_id: lastId, pairs: merged.pairs };
  cs.rels = state;
  updateConversation(conv.id, { settings: JSON.stringify(cs) });
  console.log(`[rels] 💞 ${conv.id} — ${proposed.length} lien(s) lus, ${merged.changed} mis à jour (${merged.pairs.length} au total)`);
  return { scanned: true, rels: state, changed: merged.changed };
}

/** Rolling-summary work, shared by the tracked job and its retry. */
async function summarizeMessages(convId: number, conv: ConversationRow, newMsgs: MessageRow[], signal?: AbortSignal): Promise<void> {
  const cs = conversationSettingsOf(conv);
  const provider = getProvider((cs.provider as string) || undefined);
  const model = (cs.model as string) || defaultModelFor(provider.id);
  const oldMem = parseMemory(conv.memory_json);
  const oldText = !oldMem && conv.summary && !conv.summary.startsWith(SUMMARY_PREFIX) ? conv.summary : "";
  const chat: ChatMessage[] = [
    chatMsg("system", summarizeSystem()),
    ...(oldMem
      ? [chatMsg("user", `Mémoire structurée actuelle à compléter (garde ce qui reste vrai) :\n${JSON.stringify(oldMem)}`)]
      : oldText
        ? [chatMsg("user", `Résumé actuel à compléter :\n${oldText}`)]
        : []),
    ...newMsgs.slice(-30).map((m) => chatMsg(m.role === "user" ? "user" : "assistant", m.content.slice(0, 1500))),
  ];
  const text = await provider.complete({
    messages: chat, model, temperature: 0.4, maxTokens: 400, noThinking: true,
    signal: combineSignals(signal, 90_000),
  });
  const raw = (text || "").trim();
  if (!raw) return;
  const lastId = newMsgs[newMsgs.length - 1]?.id ?? 0;
  // stale-guard: a NEWER summary already covered this batch's range → drop the
  // write (prevents an older async batch from clobbering newer state, even
  // outside the serialized queue — e.g. a retry racing an auto-run).
  const cur = getConversation(convId);
  if (!cur || Number(cur.summary_msg_id ?? 0) >= lastId) return;
  const mem = parseMemory(raw);
  if (mem) {
    // structured memory wins: store JSON + keep the readable rendering in sync
    updateConversation(convId, {
      memory_json: JSON.stringify(mem),
      summary: memoryToText(mem),
      summary_msg_id: lastId,
    });
  } else {
    // fallback: plain-text rolling summary (previous behaviour)
    const old = oldMem ? memoryToText(oldMem) : oldText;
    const merged = [SUMMARY_PREFIX, old ? `${old.trim()}\n` : "", raw].join("");
    updateConversation(convId, { summary: merged, summary_msg_id: lastId });
  }
}

// ─── job retry handlers ───────────────────────────────────────────────────────
// Registered once at module load: a failed/retryable job can be re-queued from
// the activity panel, re-running the same operation with its stored payload.
registerJobRetry("captions", async (payload, signal) => {
  await generateCaptions(Number(payload.conversationId), signal);
});
registerJobRetry("image", async (payload, signal) => {
  const op = String(payload.op || "message");
  if (op === "recap-shot") {
    await renderRecapShot(Number(payload.conversationId), Number(payload.shotIndex));
  } else {
    await generateMessageIllustration(Number(payload.conversationId), Number(payload.messageId), {
      kind: String(payload.kind || "auto"),
      seed: payload.seed ? Number(payload.seed) : undefined,
      vary: Boolean(payload.vary),
      variation: String(payload.variation || ""),
    }, signal);
  }
});
registerJobRetry("relations", async (payload, signal) => {
  await scanRelations(Number(payload.conversationId), true, signal);
});
registerJobRetry("summary", async (payload, signal) => {
  const conv = getConversation(Number(payload.conversationId));
  if (!conv) return;
  const all = listMessages(conv.id);
  const ids = Array.isArray(payload.messageIds) ? payload.messageIds.map(Number) : [];
  const msgs = (ids.length ? ids.map((id) => all.find((m) => m.id === id)).filter(Boolean) : all.slice(-30)) as MessageRow[];
  if (msgs.length) await summarizeMessages(conv.id, conv, msgs, signal);
});
registerJobRetry("canon", async (payload, signal) => {
  const conv = getConversation(Number(payload.conversationId));
  if (!conv) return;
  await proposeCanonFacts(conv.id, listMessages(conv.id), signal);
});
