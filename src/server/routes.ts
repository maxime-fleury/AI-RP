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
} from "./db";
import { importFile, scanDirectory, sizeLimitFor, type ImportResult } from "./importCards";
import { getProvider, defaultModelFor, type ChatMessage } from "../llm/providers";
import { buildMessages, buildSystemPrompt, estimateTokens, parseSegments, fallbackSpeaker, summarizeSystem, presetFromKey, parseMemory, memoryToText, type Segment, type CastContext, type MemoryState } from "../llm/prompt";
import type { ConversationRow, MessageRow } from "./db";
import { generateAndSave, probeImageStatus, ensureImageServer } from "./image";
import { storageInfo, runBackup, analyzeOrphans, purgeOrphans } from "./backup";
import { zipFiles } from "./zip";
import { providerHealth } from "./health";
import { IMAGES_DIR, UPLOADS_DIR } from "./paths";
import { withCharaChunk, placeholderPng } from "./cardExport";

// ─── helpers ──────────────────────────────────────────────────────────────────
async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON invalide");
  }
}

const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // total cap for one import batch
const MAX_IMPORT_FILES = 100;
const SECRET_KEYS = new Set(["openrouter_key", "auth_token"]);

function publicSettings(): Record<string, unknown> {
  const settings = allSettings();
  for (const key of SECRET_KEYS) {
    if (key in settings) {
      settings[`${key}_set`] = Boolean(settings[key]);
      delete settings[key];
    }
  }
  return settings;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** An error that maps to a specific HTTP status (client errors → 4xx, not 500). */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function sseStream(
  onStart: (send: (event: string, data: unknown) => void, close: () => void) => Promise<void>,
  onCancel?: () => void,
): Response {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      controller = null;
      onCancel?.();
    },
  });
  const send = (event: string, data: unknown) => {
    if (!controller) return;
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      /* closed */
    }
  };
  const close = () => {
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
    controller = null;
  };
  onStart(send, close).catch((e) => {
    send("error", { message: String(e) });
    close();
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function parseSegmentsFor(conv: any, content: string): Segment[] {
  let castNames: string[] = [];
  try {
    const ids: number[] = JSON.parse(conv.cast || "[]");
    castNames = ids.map((id) => getCard(Number(id))?.name ?? "").filter(Boolean);
  } catch { /* ignore */ }
  return fallbackSpeaker(parseSegments(content), castNames);
}

// ─── AI scenario generation (genre-aware) ─────────────────────────────────────
const SCENARIO_GENRES: Record<string, { label: string; angle: string }> = {
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
async function generateScenarioIntro(
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
  const sys = [
    "Tu écris l'ouverture d'un scénario de roleplay immersif.",
    "Réponds en 120-220 mots, en français, à la deuxième personne (\"tu\"), vivant et sensoriel.",
    "Commence par le titre du scénario sur sa propre ligne (sans # ni *), saute une ligne, puis écris l'introduction.",
    "Aucune métadonnée, aucun commentaire, aucun texte autour du titre et de l'introduction.",
  ].join(" ");
  const promptText = [
    `Monde : ${world?.name ?? "?"}`,
    `Univers : ${world?.lore || world?.description || "?"}`,
    `Thème / point de départ : ${theme || "un départ inattendu"}`,
    `Genre : ${g.label} — ${g.angle}`,
    "Écris l'ouverture de cette histoire.",
  ].join("\n");
  let text = "";
  for await (const delta of provider.stream({
    messages: [{ role: "system", content: sys }, { role: "user", content: promptText }],
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

function conversationView(id: number) {
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
  return { ...rest, memory, world, persona, scenario, cards };
}

function messageView(m: any) {
  try { m.segments = JSON.parse(m.segments || "[]"); } catch { m.segments = []; }
  // TTS has been removed — audio data is no longer served
  delete m.audio;
  try { m.meta = JSON.parse(m.meta || "{}"); } catch { m.meta = {}; }
  return m;
}

// ─── router ───────────────────────────────────────────────────────────────────
export async function handleApi(req: Request, url: URL): Promise<Response> {
  const method = req.method;
  const p = url.pathname;
  const parts = p.split("/").filter(Boolean); // ["api", ...]

  // optional LAN token: when set, every API call must carry it
  const authToken = getSetting("auth_token", "");
  if (authToken && p !== "/api/auth") {
    const presented =
      url.searchParams.get("token") ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      req.headers.get("x-auth-token");
    if (presented !== authToken) return json({ error: "unauthorized" }, 401);
  }

  try {
    // models list per provider
    if (p === "/api/models" && method === "GET") {
      const provider = getProvider(url.searchParams.get("provider") || undefined);
      const models = await provider.models().catch(() => []);
      return json({ models });
    }

    // health / meta
    if (method === "GET" && p === "/api/health/providers") {
      return json(providerHealth());
    }
    if (method === "GET" && p === "/api/health") {
      return json({
        ok: true,
        image: await probeImageStatus(),
      });
    }
    // test all services at once (LLM provider, image sidecar) with latencies
    if (p === "/api/test" && method === "POST") {
      const results: Record<string, any> = {};
      const t0 = Date.now();
      const provider = getProvider();
      const models = await provider.models().catch(() => []);
      results.provider = {
        provider: provider.id,
        ok: Array.isArray(models) && models.length > 0,
        ms: Date.now() - t0,
        models: Array.isArray(models) ? models.slice(0, 3) : [],
      };
      results.image = await probeImageStatus();
      return json(results);
    }

    // LAN auth
    if (p === "/api/auth" && method === "GET") {
      const token = getSetting("auth_token", "");
      const presented = url.searchParams.get("token") || req.headers.get("x-auth-token") || "";
      return json({ required: Boolean(token), ok: !token || presented === token });
    }
    if (p === "/api/auth" && method === "POST") {
      const body = await readJson(req);
      const token = getSetting("auth_token", "");
      if (token && body.token !== token) return json({ error: "token invalide" }, 401);
      return json({ ok: true });
    }

    // storage / backups
    if (p === "/api/storage" && method === "GET") {
      return json(storageInfo());
    }
    // orphan file analysis (simulation — nothing deleted) + purge
    if (p === "/api/storage/analyze" && method === "POST") {
      return json(analyzeOrphans());
    }
    if (p === "/api/storage/purge" && method === "POST") {
      const body = await readJson(req);
      const files = Array.isArray(body.files) ? body.files.map(String).filter(Boolean) : [];
      if (!files.length) return json({ removed: 0, bytes: 0 });
      // safety net: snapshot the DB before anything is deleted, so a purge can
      // be undone from the backups (the danger is in the confirmed deletes)
      const backup = runBackup(true);
      console.log(`[purge] 🗑 ${files.length} fichier(s) — sauvegarde ${backup || "du jour déjà existante"}`);
      const r = purgeOrphans(files);
      return json({ ...r, backup });
    }
    if (p === "/api/backup" && method === "POST") {
      const body = await readJson(req);
      // same verb serves two intents: restore (a backup payload) or create a file
      const backup =
        body && typeof body === "object"
          ? body.backup && typeof body.backup === "object"
            ? body.backup
            : Array.isArray(body.worlds)
              ? body
              : null
          : null;
      if (backup) return restoreBackup(backup);
      const file = runBackup(true);
      return json({ ok: Boolean(file), file });
    }

    // settings
    if (p === "/api/settings" && method === "GET") {
      return json(publicSettings());
    }
    if (p === "/api/settings" && method === "PATCH") {
      const body = await readJson(req);
      for (const [k, v] of Object.entries(body)) {
        if (SECRET_KEYS.has(k) && (v === undefined || v === null || String(v) === "")) continue;
        // validate numeric settings
        if (typeof v === "number" || (typeof v === "string" && /^[\d.]+$/.test(v))) {
          const num = Number(v);
          if (k === "context_max_messages" && (num < 2 || num > 200)) continue;
          if (k === "image_steps" && (num < 1 || num > 50)) continue;
          if (k === "temperature" && (num < 0 || num > 2)) continue;
          if (k === "max_tokens" && (num < 64 || num > 16384)) continue;
          if (k === "image_cfg" && (num < 1 || num > 20)) continue;
        }
        setSetting(k, v);
      }
      return json(publicSettings());
    }
    // warm up the Python image sidecar (optional, first generation is slow)
    if (p === "/api/images/preload" && method === "POST") {
      const ok = await ensureImageServer();
      return json({ ok });
    }

    // import cards — per-file report (importé / doublon / invalide) + limits
    if (p === "/api/import" && method === "POST") {
      const ct = req.headers.get("content-type") || "";
      const imported: any[] = [];
      const report: ImportResult[] = [];
      let totalBytes = 0;
      // safety net: snapshot the DB before the batch touches anything — the
      // import is bulk-writing, so a bad card must be undoable from backups
      const backup = runBackup(true);
      // returns true when the whole batch must be rejected (total too big)
      const account = (name: string, n: number): boolean => {
        totalBytes += n;
        return totalBytes > MAX_TOTAL_BYTES;
      };
      if (ct.includes("multipart/form-data")) {
        const form = await req.formData();
        const files = form.getAll("files");
        if (files.length > MAX_IMPORT_FILES) return json({ error: `Maximum ${MAX_IMPORT_FILES} fichiers par import` }, 413);
        for (const f of files) {
          if (typeof f === "string") continue;
          const bytes = new Uint8Array(await f.arrayBuffer());
          if (!sizeLimitFor(f.name)) {
            report.push({ status: "invalid", name: f.name, reason: "Format non reconnu (PNG ou JSON attendu)" });
            continue;
          }
          if (account(f.name, bytes.byteLength)) return json({ error: "Import trop volumineux (maximum 50 Mo au total)" }, 413);
          const res = importFile(f.name, bytes);
          report.push(res);
          if (res.status === "imported" && res.card) imported.push(messageView(res.card));
        }
      } else {
        const body = await readJson(req);
        const files: { name: string; base64: string }[] = body.files ?? [];
        if (!Array.isArray(files) || files.length > MAX_IMPORT_FILES) {
          return json({ error: `Maximum ${MAX_IMPORT_FILES} fichiers par import` }, 413);
        }
        for (const f of files) {
          if (!f || typeof f.base64 !== "string") continue;
          const raw = atob(f.base64);
          if (!sizeLimitFor(f.name)) {
            report.push({ status: "invalid", name: String(f.name || "?"), reason: "Format non reconnu (PNG ou JSON attendu)" });
            continue;
          }
          if (account(f.name, raw.length)) return json({ error: "Import trop volumineux (maximum 50 Mo au total)" }, 413);
          const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
          const res = importFile(f.name, bytes);
          report.push(res);
          if (res.status === "imported" && res.card) imported.push(messageView(res.card));
        }
      }
      if (imported.length) console.log(`[import] 📥 ${imported.length} carte(s) — sauvegarde ${backup || "du jour déjà existante"}`);
      return json({ imported, duplicates: report.filter((r) => r.status === "duplicate").map((r) => r.name), report, backup });
    }
    if (p === "/api/cards/scan" && method === "POST") {
      const body = await readJson(req);
      const dir = body.dir || "";
      if (!dir || !fs.existsSync(dir)) return json({ error: "Dossier introuvable" }, 400);
      const count = scanDirectory(dir);
      return json({ imported: count });
    }

    // worlds
    if (p === "/api/worlds" && method === "GET") {
      const worlds = listWorlds().map((w) => ({
        ...w,
        scenario_count: (listScenarios(w.id) as any[]).length,
      }));
      return json({ worlds });
    }
    if (p === "/api/worlds" && method === "POST") {
      const body = await readJson(req);
      return json(createWorld(body), 201);
    }
    if (parts[1] === "worlds" && parts[2] && !parts[3] && method === "GET") {
      const w = getWorld(Number(parts[2]));
      return w ? json(w) : json({ error: "not found" }, 404);
    }
    if (parts[1] === "worlds" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      const w = updateWorld(Number(parts[2]), body);
      return w ? json(w) : json({ error: "not found" }, 404);
    }
    if (parts[1] === "worlds" && parts[2] && !parts[3] && method === "DELETE") {
      // soft delete → trash; restore via /api/trash
      deleteWorld(Number(parts[2]));
      return json({ ok: true, trashed: true });
    }
    if (parts[1] === "worlds" && parts[2] && parts[3] === "cover" && method === "POST") {
      const body = await readJson(req);
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const sceneText = [world.description, world.lore, world.tone].filter(Boolean).join(" ");
      const prompt = body.prompt || buildIllustrationPrompt(world.name, "", world.tone || "épique", sceneText || `${world.name}, fantasy landscape`, "landscape");
      const cover = await generateAndSave(`worlds/${world.id}`, {
        prompt,
        negative: NEGATIVE_PROMPT,
        steps: Number(getSetting("image_steps", 28)),
        cfg: Number(getSetting("image_cfg", 7)),
        width: Number(getSetting("image_width", 1152)),
        height: Number(getSetting("image_height", 768)),
      });
      updateWorld(world.id, { cover: cover.url });
      return json({ cover: cover.url });
    }
    // world map: generate an illustrated map of the world (landscape)
    if (parts[1] === "worlds" && parts[2] && parts[3] === "map" && parts[4] === "generate" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const prompt = [
        `Illustrated fantasy map of the world of "${world.name}".`,
        `Lore: ${(world.lore || world.description || "").slice(0, 800)}`,
        "Regions, capitals, forests, mountains, rivers, coastlines. Cartography style, top-down view, parchment texture, muted colors, hand-drawn labels. Landscape format.",
      ].join("\n");
      const saved = await generateAndSave(`worlds/${world.id}`, {
        prompt,
        negative: NEGATIVE_PROMPT,
        steps: 24,
        cfg: 6.5,
        width: 1216,
        height: 832,
      });
      updateWorld(world.id, { map: saved.url });
      return json({ map: saved.url });
    }
    // world map view + place names cited in this world's conversations
    if (parts[1] === "worlds" && parts[2] && parts[3] === "map" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const texts: string[] = [];
      for (const c of listConversations().filter((x: any) => x.world_id === world.id)) {
        for (const m of listMessages(c.id)) if (m.role === "assistant") texts.push(m.content);
      }
      const seen = new Set<string>();
      const locations: string[] = [];
      // place names: two+ capitalized words — filter out sentence starters and
      // common words so narration like "Les échos de ta voix" isn't a "place"
      const SKIP = new Set(["Les", "Le", "La", "Un", "Une", "Des", "Au", "Aux", "Dans", "Sur", "Sous", "Et", "Mais", "Ou", "Elle", "Il", "Ils", "Elles", "Tu", "Vous", "Je", "Nous", "On", "Ce", "Cette", "Ces", "Son", "Sa", "Ses", "Mon", "Ma", "Mes", "Ton", "Ta", "Tes", "Notre", "Votre", "Leur", "Quand", "Comme", "Alors", "Soudain", "Puis", "Enfin", "Après", "Avant", "Devant", "Derrière", "Vers", "Avec", "Sans", "Pour", "Par", "Seul", "Tout", "Toute"]);
      const re = /\b([A-ZÀ-ÖØ-öø-ÿ][a-zà-öø-ÿ'’-]{2,24})\s+((?:de|du|des|d'|la|le|les|au|aux|en|l')?\s*[A-ZÀ-ÖØ-öø-ÿ][a-zà-öø-ÿ'’-]{2,24})/g;
      for (const t of texts) {
        for (const m of t.matchAll(re)) {
          const name = `${m[1]} ${m[2]}`.replace(/\s+/g, " ").trim();
          if (SKIP.has(m[1])) continue;
          if (SKIP.has(name.split(" ")[0])) continue;
          if (!seen.has(name)) { seen.add(name); locations.push(name); }
          if (locations.length >= 10) break;
        }
        if (locations.length >= 10) break;
      }
      return json({ map: world.map || null, locations });
    }
    // structured locations (managed by the user, pinned on the map)
    if (parts[1] === "worlds" && parts[2] && parts[3] === "locations" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      return json({ locations: listLocations(world.id) });
    }
    if (parts[1] === "worlds" && parts[2] && parts[3] === "locations" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      return json(createLocation({ world_id: world.id, ...body }), 201);
    }
    if (parts[1] === "locations" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      return json(updateLocation(Number(parts[2]), body));
    }
    if (parts[1] === "locations" && parts[2] && !parts[3] && method === "DELETE") {
      deleteLocation(Number(parts[2]));
      return json({ ok: true });
    }
    // lorebook: conditional memory entries injected only when triggers match
    if (parts[1] === "worlds" && parts[2] && parts[3] === "lorebook" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      return json({ entries: listLorebook(world.id) });
    }
    if (parts[1] === "worlds" && parts[2] && parts[3] === "lorebook" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      return json(createLorebookEntry({ world_id: world.id, ...body }), 201);
    }
    if (parts[1] === "lorebook" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      return json(updateLorebookEntry(Number(parts[2]), body));
    }
    if (parts[1] === "lorebook" && parts[2] && !parts[3] && method === "DELETE") {
      deleteLorebookEntry(Number(parts[2]));
      return json({ ok: true });
    }
    // relations: character relationship graph (from → kind → to)
    if (parts[1] === "worlds" && parts[2] && parts[3] === "relations" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      return json({ relations: listRelations(world.id) });
    }
    if (parts[1] === "worlds" && parts[2] && parts[3] === "relations" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      return json(createRelation({ world_id: world.id, ...body }), 201);
    }
    if (parts[1] === "relations" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      return json(updateRelation(Number(parts[2]), body));
    }
    if (parts[1] === "relations" && parts[2] && !parts[3] && method === "DELETE") {
      deleteRelation(Number(parts[2]));
      return json({ ok: true });
    }
    // timeline: major world events (auto-suggested or added by hand)
    if (parts[1] === "worlds" && parts[2] && parts[3] === "timeline" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      return json({ events: listTimeline(world.id) });
    }
    if (parts[1] === "worlds" && parts[2] && parts[3] === "timeline" && !parts[4] && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      return json(createTimelineEvent({ world_id: world.id, ...body }), 201);
    }
    if (parts[1] === "timeline" && parts[2] && !parts[3] && method === "DELETE") {
      deleteTimelineEvent(Number(parts[2]));
      return json({ ok: true });
    }
    // propose major events for the world timeline from the playthroughs — the
    // LLM only SUGGESTS (label + justifying extract); nothing is written until
    // the user accepts a proposal in the Chronologie tab
    if (parts[1] === "worlds" && parts[2] && parts[3] === "timeline" && parts[4] === "propose" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const result = await proposeTimelineEvents(world.id);
      if (!result) return json({ error: "Le modèle n'a pas pu analyser les parties" }, 502);
      return json(result);
    }

    // async background tasks (images / summaries / captions): status + history
    if (p === "/api/jobs" && method === "GET") {
      const status = url.searchParams.get("status") || undefined;
      return json({ jobs: listJobs(status) });
    }

    // export a whole world (scenarios + conversations) as a ZIP
    if (parts[1] === "worlds" && parts[2] && parts[3] === "export" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const files: { path: string; data: Uint8Array | string }[] = [
        { path: "world.json", data: JSON.stringify({ name: world.name, description: world.description, lore: world.lore, tone: world.tone, narration_style: world.narration_style, language: world.language, map: world.map, exported_at: new Date().toISOString() }, null, 2) },
        { path: "scenarios.json", data: JSON.stringify(listScenarios(world.id), null, 2) },
      ];
      for (const c of listConversations().filter((x: any) => x.world_id === world.id)) {
        const msgs = listMessages(c.id).map(messageView);
        const lines = msgs.map((m: any) => {
          const who = m.role === "user" ? "Moi" : m.name || "Narrateur";
          const body = (m.meta?.image ? `![illustration](${m.meta.image})\n` : "") + (m.content || "");
          return m.role === "user" ? `**${who}** : ${body}` : `> **${who}** : ${body}`;
        }).join("\n\n");
        const safe = (c.title || "partie").replace(/[^\p{L}\p{N} _-]+/gu, "").slice(0, 40);
        files.push({ path: `conversations/${c.id}-${safe}.md`, data: `# ${c.title}\n\n${lines}\n` });
      }
      const zip = zipFiles(files);
      const name = encodeURIComponent(world.name.replace(/[^\p{L}\p{N} _-]+/gu, "").slice(0, 40));
      return new Response(zip, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename*=UTF-8''${name}.zip`,
        },
      });
    }

    // scenarios
    if (parts[1] === "worlds" && parts[2] && parts[3] === "scenarios" && method === "GET") {
      return json({ scenarios: listScenarios(Number(parts[2])) });
    }
    // generate a new scenario from a genre (wizard / world detail) — must come
    // BEFORE the plain POST create route (same prefix, deeper path)
    if (parts[1] === "worlds" && parts[2] && parts[3] === "scenarios" && parts[4] === "generate" && method === "POST") {
      const body = await readJson(req);
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const { name, intro } = await generateScenarioIntro(world, body.genre, body.theme);
      const customName = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
      // Generation is preview-only by default; persist only when explicitly requested.
      if (body.persist === true) return json(createScenario({ world_id: world.id, name: customName ?? name, intro }), 201);
      return json({ name: customName ?? name, intro, draft: true }, 200);
    }
    if (parts[1] === "worlds" && parts[2] && parts[3] === "scenarios" && method === "POST") {
      const body = await readJson(req);
      const s = createScenario({ world_id: Number(parts[2]), ...body });
      return json(s, 201);
    }
    if (p === "/api/scenarios" && method === "POST") {
      const body = await readJson(req);
      return json(createScenario(body), 201);
    }
    if (parts[1] === "scenarios" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      return json(updateScenario(Number(parts[2]), body));
    }
    if (parts[1] === "scenarios" && parts[2] && !parts[3] && method === "DELETE") {
      deleteScenario(Number(parts[2]));
      return json({ ok: true, trashed: true });
    }
    // regenerate the intro of an existing scenario (genre-aware)
    if (parts[1] === "scenarios" && parts[2] && parts[3] === "generate" && method === "POST") {
      const body = await readJson(req);
      const scenario = getScenario(Number(parts[2]));
      if (!scenario) return json({ error: "not found" }, 404);
      const world = getWorld(scenario.world_id);
      const theme = body.theme || scenario.name || "un nouveau départ";
      const { intro } = await generateScenarioIntro(world, body.genre, theme);
      return json(updateScenario(scenario.id, { intro }));
    }

    // cards
    if (p === "/api/cards" && method === "GET") {
      return json({ cards: listCards().map(messageView) });
    }
    if (p === "/api/cards" && method === "POST") {
      const body = await readJson(req);
      if (body.avatar && typeof body.avatar === "string" && body.avatar.startsWith("data:image/")) {
        const match = body.avatar.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
        if (!match) return json({ error: "Avatar invalide" }, 400);
        const bytes = Buffer.from(match[2], "base64");
        if (bytes.length > 5 * 1024 * 1024) return json({ error: "Avatar limité à 5 Mo" }, 413);
        const card = createCard({ ...body, avatar: "" });
        const file = `card-${card.id}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
        fs.mkdirSync(path.join(UPLOADS_DIR, "avatars"), { recursive: true });
        fs.writeFileSync(path.join(UPLOADS_DIR, "avatars", file), bytes);
        return json(updateCard(card.id, { avatar: `/uploads/avatars/${file}` }), 201);
      }
      return json(createCard(body), 201);
    }
    // AI-assisted card creation: idea → chips per field (see cardModal "✨ Aide IA")
    if (p === "/api/cards/assist" && method === "POST") {
      const body = await readJson(req);
      const idea = String(body.idea || "").trim().slice(0, 1500);
      if (!idea) return json({ error: "Décris d'abord ton idée de personnage." }, 400);
      console.log(`[cards/assist] ✨ idée : ${idea.replace(/\s+/g, " ").slice(0, 90)}…`);
      const fields = await generateCardAssist(idea);
      const hasAny = CARD_ASSIST_FIELDS.some((k) => fields[k].length);
      if (!hasAny) return json({ error: "Le modèle n'a rien proposé — réessaie ou vérifie ta connexion IA." }, 502);
      return json({ fields });
    }
    // generate a character avatar with the image model: portrait built from the
    // card fields, stable seed per character (same face as chat illustrations),
    // optional img2img from the previous avatar on rerolls (face consistency)
    if (p === "/api/cards/generate-avatar" && method === "POST") {
      const body = await readJson(req);
      const name = String(body.name || "").trim().slice(0, 80);
      const description = String(body.description || "").trim().slice(0, 2000);
      const personality = String(body.personality || "").trim().slice(0, 2000);
      const scenario = String(body.scenario || "").trim().slice(0, 1000);
      let tags: string[] = [];
      try {
        const t = JSON.parse(String(body.tags || "[]"));
        if (Array.isArray(t)) tags = t.map(String).slice(0, 12);
      } catch {
        tags = String(body.tags || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12);
      }
      if (!name && !description && !personality && !scenario && !tags.length) return json({ error: "Remplis au moins un champ du personnage pour générer un avatar." }, 400);
      const cardId = Number(body.id);
      const seed =
        typeof body.seed === "number" ? body.seed
        : Number.isFinite(cardId) && cardId > 0 ? charSeed(cardId)
        : undefined;
      // same portrait pipeline as the message illustrations: identity tags + stable framing
      const charTags = descriptionToTags([name, description, personality, scenario, ...tags].join(" ")).slice(0, 18);
      const prompt = [
        "masterpiece, best quality, anime illustration, highly detailed, vibrant colors, character focus, one character",
        ...charTags,
        name.replace(/\s+/g, "_"),
        "portrait, solo, upper body, detailed face, face focus, looking at viewer, cinematic lighting, detailed background",
      ].filter(Boolean).join(", ");
      // img2img from the current avatar so rerolls keep the same face
      let init_image: string | undefined;
      const refBase = path.basename(String(body.ref_image || ""));
      if (refBase) {
        for (const dir of [path.join(IMAGES_DIR, "avatars"), path.join(UPLOADS_DIR, "avatars")]) {
          const f = path.join(dir, refBase);
          if (fs.existsSync(f)) { init_image = fs.readFileSync(f).toString("base64"); break; }
        }
      }
      console.log(`[cards/generate-avatar] 🎨 ${name || "nouveau personnage"}${seed != null ? ` seed ${seed}` : ""}${init_image ? " (img2img)" : ""}`);
      try {
        const res = await generateAndSave("avatars", {
          prompt,
          negative: NEGATIVE_PROMPT,
          steps: Number(getSetting("image_steps", 28)),
          cfg: Number(getSetting("image_cfg", 7)),
          width: Number(getSetting("image_width", 768)),
          height: Number(getSetting("image_height", 1152)),
          seed,
          init_image,
          strength: Number(getSetting("image_ref_strength", 0.55)),
        });
        return json({ image: res.url, seed: res.seed });
      } catch (e) {
        console.error(`[cards/generate-avatar] échec : ${e instanceof Error ? e.message : e}`);
        return json({ error: "La génération d'image a échoué — vérifie que le serveur d'images est bien configuré." }, 502);
      }
    }
    if (parts[1] === "cards" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      if (body.avatar && typeof body.avatar === "string" && body.avatar.startsWith("data:image/")) {
        const match = body.avatar.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
        if (!match) return json({ error: "Avatar invalide" }, 400);
        const bytes = Buffer.from(match[2], "base64");
        if (bytes.length > 5 * 1024 * 1024) return json({ error: "Avatar limité à 5 Mo" }, 413);
        const file = `card-${Number(parts[2])}-${Date.now()}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
        fs.mkdirSync(path.join(UPLOADS_DIR, "avatars"), { recursive: true });
        fs.writeFileSync(path.join(UPLOADS_DIR, "avatars", file), bytes);
        body.avatar = `/uploads/avatars/${file}`;
      }
      return json(updateCard(Number(parts[2]), body));
    }
    if (parts[1] === "cards" && parts[2] && !parts[3] && method === "DELETE") {
      deleteCard(Number(parts[2]));
      return json({ ok: true, trashed: true });
    }
    // export a card as a SillyTavern-compatible PNG (chara chunk)
    if (parts[1] === "cards" && parts[2] && parts[3] === "export-st" && method === "GET") {
      const card = getCard(Number(parts[2]));
      if (!card) return json({ error: "not found" }, 404);
      const chara = JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: card.name,
          description: [card.description, card.personality, card.scenario].filter(Boolean).join("\n\n"),
          personality: card.personality || "",
          scenario: card.scenario || "",
          first_mes: card.first_mes || "",
          mes_example: card.mes_example || "",
          system_prompt: card.system_prompt || "",
          post_history_instructions: card.post_history_instructions || "",
          creator: "Freebuff Innsekai",
          character_version: "1.0",
          alternate_greetings: [],
          tags: [],
        },
      });
      let png: Uint8Array;
      const avatarFile = card.avatar ? path.join(UPLOADS_DIR, path.basename(card.avatar)) : "";
      if (avatarFile && fs.existsSync(avatarFile)) png = new Uint8Array(fs.readFileSync(avatarFile));
      else png = placeholderPng(256, [43, 24, 66]);
      const out = withCharaChunk(png, chara);
      return new Response(out, {
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(card.name)}.png`,
        },
      });
    }

    // personas
    if (p === "/api/personas" && method === "GET") {
      return json({ personas: listPersonas() });
    }
    if (p === "/api/personas" && method === "POST") {
      const body = await readJson(req);
      return json(createPersona(body), 201);
    }
    if (parts[1] === "personas" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      return json(updatePersona(Number(parts[2]), body));
    }
    if (parts[1] === "personas" && parts[2] && !parts[3] && method === "DELETE") {
      deletePersona(Number(parts[2]));
      return json({ ok: true, trashed: true });
    }

    // trash: soft-deleted resources (worlds, scenarios, cards, personas)
    if (p === "/api/trash" && method === "GET") {
      return json({ items: listTrashedResources() });
    }
    if (p === "/api/trash/restore" && method === "POST") {
      const body = await readJson(req);
      const ok = restoreTrashed(String(body.type), Number(body.id));
      return ok ? json({ ok: true }) : json({ error: "type inconnu" }, 400);
    }
    if (p === "/api/trash/permanent" && method === "POST") {
      const body = await readJson(req);
      const ok = permanentDeleteTrashed(String(body.type), Number(body.id));
      return ok ? json({ ok: true }) : json({ error: "type inconnu" }, 400);
    }

    // conversations
    if (p === "/api/conversations" && method === "GET") {
      const convs = listConversations().map((c) => {
        const world = c.world_id ? getWorld(c.world_id) : null;
        return { ...c, world };
      });
      return json({ conversations: convs });
    }
    if (p === "/api/conversations" && method === "POST") {
      const body = await readJson(req);
      const conv = createConversation({
        title: body.title || "Nouvelle partie",
        world_id: body.world_id ?? null,
        persona_id: body.persona_id ?? null,
        scenario_id: body.scenario_id ?? null,
        cast: JSON.stringify(body.cast ?? []),
        group_mode: body.group_mode ? 1 : 0,
        settings: JSON.stringify(body.settings ?? {}),
      });
      // opening: scenario intro (or first card greeting)
      let convSettings: Record<string, unknown> = {};
      try { convSettings = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      const scenario = conv.scenario_id ? getScenario(conv.scenario_id) : null;
      const draftIntro = typeof convSettings.draft_intro === "string" ? convSettings.draft_intro : "";
      const cards = (JSON.parse(conv.cast) as number[]).map((id) => getCard(Number(id))).filter(Boolean) as any[];
      let opening: MessageRow | null = null;
      if (draftIntro) {
        opening = createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: draftIntro });
      } else if (scenario?.intro) {
        opening = createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: scenario.intro });
      } else if (cards[0]?.first_mes) {
        opening = createMessage({ conversation_id: conv.id, role: "assistant", name: cards[0].name, content: cards[0].first_mes });
      } else if (cards.length > 0) {
        const names = cards.map((c: any) => c.name).join(", ");
        opening = createMessage({
          conversation_id: conv.id, role: "assistant", name: "Narrateur",
          content: `*Le décor se met en place. ${names} ${cards.length > 1 ? "sont là" : "est là"}, devant toi. Que se passe-t-il ?*`,
        });
      } else {
        opening = createMessage({
          conversation_id: conv.id, role: "assistant", name: "Narrateur",
          content: `*Une nouvelle aventure commence. Décris ton personnage et ce que tu fais.*`,
        });
      }
      const view = conversationView(conv.id);
      // background: pre-generate response suggestions for the opening message
      if (opening?.id) {
        generateSuggestions(
          { world: view.world, persona: view.persona, cards: view.cards, scenario: view.scenario, conversation: conv },
          [],
        ).then((sugg) => {
          if (!sugg.length) return;
          const m = getMessage(opening.id);
          if (!m) return;
          updateMessage(opening.id, { meta: JSON.stringify({ ...JSON.parse(m.meta || "{}"), suggestions: sugg }) });
        }).catch(() => {});
      }
      return json(view, 201);
    }
    if (parts[1] === "conversations" && parts[2] && !parts[3] && method === "GET") {
      const view = conversationView(Number(parts[2]));
      if (!view) return json({ error: "not found" }, 404);
      view.messages = listMessages(view.id).map(messageView);
      return json(view);
    }
    if (parts[1] === "conversations" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      const patch: any = {
        title: body.title,
        group_mode: body.group_mode === undefined ? undefined : body.group_mode ? 1 : 0,
        pinned: body.pinned === undefined ? undefined : body.pinned ? 1 : 0,
        archived: body.archived === undefined ? undefined : body.archived ? 1 : 0,
        cast: body.cast ? JSON.stringify(body.cast) : undefined,
        settings: body.settings ? JSON.stringify(body.settings) : undefined,
      };
      if (typeof body.branch_kind === "string" && ["main", "canon", "alternative", "draft", "abandoned"].includes(body.branch_kind)) {
        patch.branch_kind = body.branch_kind;
      }
      if (body.memory && typeof body.memory === "object" && !Array.isArray(body.memory)) {
        const m = parseMemory(JSON.stringify(body.memory));
        if (m) {
          patch.memory_json = JSON.stringify(m);
          // keep the readable summary in sync so list views show the memory
          patch.summary = memoryToText(m);
        }
      }
      updateConversation(Number(parts[2]), patch);
      return json(conversationView(Number(parts[2])));
    }
    if (parts[1] === "conversations" && parts[2] && !parts[3] && method === "DELETE") {
      // soft delete: move to the trash (archived=1); restore via PATCH archived:0
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      updateConversation(conv.id, { archived: 1 });
      return json({ ok: true, archived: true });
    }
    // permanent delete (trash screen) — drops rows + images
    if (parts[1] === "conversations" && parts[2] && parts[3] === "permanent" && method === "DELETE") {
      const convId = Number(parts[2]);
      deleteConversation(convId);
      try { fs.rmSync(path.join(IMAGES_DIR, "conversations", String(convId)), { recursive: true, force: true }); } catch { /* ignore */ }
      return json({ ok: true });
    }
    // story chapters: POST closes the current stretch — the model titles and
    // summarizes it, a display-only marker lands in the thread (meta.chapter,
    // skipped when building the model input) and the summary is injected in the
    // system prompt (see buildSystemPrompt "Chapitres précédents").
    if (parts[1] === "conversations" && parts[2] && parts[3] === "chapter" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      let cs: Record<string, any> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      const chapters = Array.isArray(cs.chapters) ? cs.chapters : [];
      const sinceId = Number(cs.chapter_msg_id || 0);
      const all = listMessages(conv.id).filter((m) => {
        try { const meta = JSON.parse(m.meta || "{}"); return !meta.chapter; } catch { return true; }
      });
      const fresh = sinceId ? all.filter((m) => m.id > sinceId) : all;
      if (fresh.length < CHAPTER_MIN_MESSAGES) return json({ created: false, reason: "threshold" });
      const proposed = await suggestChapter(conv.title || "Partie", fresh);
      if (!proposed) return json({ created: false, error: "L'analyse du chapitre a échoué — vérifie la connexion au modèle." }, 502);
      const n = chapters.length + 1;
      const marker = createMessage({
        conversation_id: conv.id, role: "assistant", name: "",
        content: `📖 Chapitre ${n} — ${proposed.title}\n\n${proposed.summary}`,
        meta: JSON.stringify({ chapter: true }),
      });
      chapters.push({ n, title: proposed.title, summary: proposed.summary, at: Date.now(), msg_id: marker.id });
      cs.chapters = chapters;
      cs.chapter_msg_id = marker.id;
      updateConversation(conv.id, { settings: JSON.stringify(cs) });
      console.log(`[chapters] 📖 Chapitre ${n} « ${proposed.title} » — ${fresh.length} messages`);
      return json({ created: true, chapter: { n, title: proposed.title, summary: proposed.summary }, marker: messageView(marker) });
    }
    // session recap ("Previously on…"): GET returns the stored recap, POST
    // writes a fresh one once enough story accumulated since the last recap,
    // POST …/recap/shots re-queues the storyboard rendering of the current one
    if (parts[1] === "conversations" && parts[2] && parts[3] === "recap" && parts[4] === "shots" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const { cs, recap } = recapOf(conv);
      if (!recap) return json({ created: false, reason: "no-recap" });
      let queued = 0;
      for (const s of recap.shots ?? []) {
        if (s.status !== "done") { s.status = "pending"; delete s.error; queued++; }
      }
      if (queued) {
        cs.recap = recap;
        updateConversation(conv.id, { settings: JSON.stringify(cs) });
        void renderRecapShots(conv.id).catch((e) => console.warn("[recap] images:", String(e?.message ?? e).slice(0, 160)));
      }
      return json({ ok: true, queued, recap });
    }
    if (parts[1] === "conversations" && parts[2] && parts[3] === "recap" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      return json({ recap: recapOf(conv).recap });
    }
    if (parts[1] === "conversations" && parts[2] && parts[3] === "recap" && !parts[4] && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const { cs, recap } = recapOf(conv);
      const sinceId = Number(recap?.last_msg_id ?? 0);
      const fresh = storyMessages(listMessages(conv.id)).filter((m) => m.id > sinceId);
      if (fresh.length < RECAP_MIN_MESSAGES) {
        return json({ created: false, reason: "threshold", needed: RECAP_MIN_MESSAGES, have: fresh.length });
      }
      const proposed = await suggestRecap(conv.title || "Partie", fresh);
      if (!proposed) {
        return json({ created: false, error: "Le récap n'a pas pu être rédigé — vérifie la connexion au modèle." }, 502);
      }
      const data: RecapData = {
        title: proposed.title,
        text: proposed.text,
        at: Date.now(),
        last_msg_id: fresh[fresh.length - 1].id,
        shots: proposed.shots.map((s) => ({ caption: s.caption, prompt: s.prompt, status: "pending" as const })),
      };
      cs.recap = data;
      updateConversation(conv.id, { settings: JSON.stringify(cs) });
      console.log(`[recap] 🎬 « ${data.title} » (#${conv.id}) — ${fresh.length} messages, ${data.shots.length} shot(s)`);
      // storyboard rendering runs in the background — never blocks the response
      void renderRecapShots(conv.id).catch((e) => console.warn("[recap] images:", String(e?.message ?? e).slice(0, 160)));
      return json({ created: true, recap: data });
    }
    // dynamic NPCs: suggest secondary characters from the recent fiction
    // (POST .../npcs/suggest), then add an approved one to the cast
    if (parts[1] === "conversations" && parts[2] && parts[3] === "npcs" && parts[4] === "suggest" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const npcs = await suggestNpcs(conv, listMessages(conv.id));
      console.log(`[npcs] 💡 conversation #${conv.id} — ${npcs.length} proposition(s)`);
      return json({ npcs });
    }
    if (parts[1] === "conversations" && parts[2] && parts[3] === "npcs" && parts[4] === "accept" && method === "POST") {
      const body = await readJson(req);
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const npc = body?.npc || {};
      const name = String(npc.name || "").trim().slice(0, 80);
      if (!name) return json({ error: "Nom de PNJ manquant" }, 400);
      const card = createCard({
        name,
        description: String(npc.description || "").trim().slice(0, 2000),
        personality: String(npc.personality || "").trim().slice(0, 2000),
        scenario: String(npc.role || "").trim().slice(0, 500),
        tags: "[]",
      });
      let cast: number[] = [];
      try { cast = (JSON.parse(conv.cast || "[]") as number[]).map(Number); } catch { /* ignore */ }
      if (!cast.includes(card.id)) cast.push(card.id);
      updateConversation(conv.id, { cast: JSON.stringify(cast) });
      console.log(`[npcs] ➕ carte #${card.id} « ${card.name} » ajoutée à la partie #${conv.id}`);
      return json({ card: messageView(card) });
    }
    // per-game statistics: counts, wordage, speaker frequency, activity span
    if (parts[1] === "conversations" && parts[2] && parts[3] === "stats" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const msgs = listMessages(conv.id);
      const words = (t: string) => (t || "").trim() ? (t.trim().match(/\S+/g) || []).length : 0;
      const speaker = new Map<string, number>();
      let userMsgs = 0, assistantMsgs = 0, totalWords = 0, totalChars = 0, images = 0, bookmarks = 0;
      let firstTs = 0, lastTs = 0;
      for (const m of msgs) {
        const c = m.content || "";
        totalWords += words(c);
        totalChars += c.length;
        if (m.role === "user") userMsgs++; else assistantMsgs++;
        if (m.meta) {
          try {
            const meta = JSON.parse(m.meta as string);
            if (meta.image) images++;
            if (meta.bookmark) bookmarks++;
          } catch { /* ignore */ }
        }
        const name = m.role === "user" ? (conv.persona_id ? "Joueur" : "Moi") : m.name || "Narrateur";
        speaker.set(name, (speaker.get(name) || 0) + 1);
        if (!firstTs || m.created_at < firstTs) firstTs = m.created_at;
        if (m.created_at > lastTs) lastTs = m.created_at;
      }
      const speakers = [...speaker.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      const spanDays = firstTs ? Math.round((lastTs - firstTs) / 86_400_000) : 0;
      return json({
        messages: msgs.length, user_msgs: userMsgs, assistant_msgs: assistantMsgs,
        words: totalWords, chars: totalChars,
        avg_words: msgs.length ? Math.round(totalWords / msgs.length) : 0,
        images, bookmarks, first_ts: firstTs, last_ts: lastTs, days: spanDays,
        speakers,
      });
    }
    // story checkpoints & rewind (RE:ZERO-style): mark a point in the thread,
    // then rewind to it. The doomed stretch becomes a restorable abandoned
    // branch, the world state IS restored to the checkpoint (strict), and a
    // condensed loop summary is kept for the narrator's memories (sliders).
    // ── checkpoint (stack semantics: only the top can be popped)
    if (parts[1] === "conversations" && parts[2] && parts[3] === "checkpoint" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const last = lastMessageOf(conv.id);
      if (!last) return json({ error: "La partie est vide — rien à marquer." }, 400);
      const body = await readJson(req);
      let cs: Record<string, any> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      const checkpoints = Array.isArray(cs.checkpoints) ? cs.checkpoints : [];
      // the snapshot keeps the fiction state that is rewound on return;
      // the memory sliders are settings, NOT fiction, so they're excluded
      checkpoints.push({
        n: checkpoints.length + 1,
        msg_id: last.id,
        note: String(body.note || "").trim().slice(0, 120),
        at: Date.now(),
        snapshot: {
          memory_json: conv.memory_json,
          summary: conv.summary,
          summary_msg_id: conv.summary_msg_id,
          cast: conv.cast,
          group_mode: conv.group_mode,
          chapters: Array.isArray(cs.chapters) ? cs.chapters : [],
          chapter_msg_id: cs.chapter_msg_id ?? 0,
          quests: cs.quests ?? [],
          scene_state: cs.scene_state ?? null,
          scene_updated_at: cs.scene_updated_at ?? 0,
        },
      });
      cs.checkpoints = checkpoints;
      updateConversation(conv.id, { settings: JSON.stringify(cs) });
      console.log(`[checkpoint] 📌 #${checkpoints.length} « ${checkpoints[checkpoints.length - 1].note || "point de retour"} » — msg #${last.id}`);
      return json({ created: true, count: checkpoints.length, checkpoint: checkpoints[checkpoints.length - 1] });
    }
    // ── rewind to the top checkpoint
    if (parts[1] === "conversations" && parts[2] && parts[3] === "return" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      let cs: Record<string, any> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      const checkpoints = Array.isArray(cs.checkpoints) ? cs.checkpoints : [];
      const top = checkpoints[checkpoints.length - 1];
      if (!top) return json({ error: "Aucun checkpoint — marque-en un d'abord." }, 400);
      const snap = top.snapshot || {};
      const fromId = Number(top.msg_id || 0);
      const doomed = listMessages(conv.id).filter((m) => m.id > fromId);
      if (!doomed.length) return json({ error: "Le checkpoint est déjà au fil le plus récent." }, 400);
      const backup = runBackup(true); // safety net before the confirmed deletion
      // 1) restorable branch: the doomed stretch + its images, kept as abandoned
      const abandoned = await forkTail(conv, doomed, fromId);
      // 2) restore the world state to the checkpoint (strict RE:ZERO)
      const removed = deleteMessagesAfter(conv.id, fromId);
      for (const rm of removed) {
        let meta: any = {};
        try { meta = JSON.parse(rm.meta || "{}"); } catch { /* ignore */ }
        if (meta.image) {
          try { fs.rmSync(path.join(IMAGES_DIR, "conversations", String(conv.id), path.basename(meta.image)), { force: true }); } catch { /* ignore */ }
        }
      }
      const restoredCs: Record<string, any> = {
        ...cs,
        chapter_msg_id: snap.chapter_msg_id ?? cs.chapter_msg_id ?? 0,
        quests: Array.isArray(snap.quests) ? snap.quests : [],
        scene_state: snap.scene_state ?? null,
        scene_updated_at: snap.scene_updated_at ?? 0,
      };
      restoredCs.chapters = Array.isArray(snap.chapters) ? snap.chapters : [];
      // 3) condensed loop summary (narrator memory). Offline model → placeholder.
      const loop = await summarizeLoop(conv.title || "Partie", doomed);
      const loops = Array.isArray(cs.loops) ? cs.loops : [];
      loops.push({ n: loops.length + 1, checkpoint_n: top.n, at: Date.now(), branch: abandoned?.id ?? null, note: top.note || "", ...loop });
      restoredCs.loops = loops;
      // 4) pop the checkpoint (the one before becomes accessible next time)
      restoredCs.checkpoints = checkpoints.slice(0, -1);
      const lastKept = getMessage(fromId);
      updateConversation(conv.id, {
        settings: JSON.stringify(restoredCs),
        memory_json: String(snap.memory_json ?? ""),
        summary: String(snap.summary ?? ""),
        summary_msg_id: Number(snap.summary_msg_id || 0),
        cast: String(snap.cast || "[]"),
        group_mode: Number(snap.group_mode ?? conv.group_mode),
        last_message: lastKept?.content?.slice(0, 200) ?? conv.last_message,
      });
      // 5) display-only rewind marker
      const marker = createMessage({
        conversation_id: conv.id, role: "assistant", name: "",
        content: `🔁 Retour au point ${top.n}${top.note ? ` — ${top.note}` : ""}`,
        meta: JSON.stringify({ rewind: true }),
      });
      console.log(`[rewind] 🔁 partie #${conv.id} → point ${top.n} (msg #${fromId}) — ${doomed.length} message(s) tronqué(s), boucle #${loops.length}`);
      return json({
        ok: true, truncated: doomed.length, loop: loops[loops.length - 1],
        branch: abandoned ? { id: abandoned.id, title: abandoned.title } : null,
        backup,
      });
    }
    // ── loop journal
    if (parts[1] === "conversations" && parts[2] && parts[3] === "loops" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      let cs: Record<string, any> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      return json({ checkpoints: Array.isArray(cs.checkpoints) ? cs.checkpoints : [], loops: Array.isArray(cs.loops) ? cs.loops : [] });
    }
    // per-game lorebook (dynamic canon): facts built during play, kept in the
    // conversation settings, injected like world lore (trigger-matched). GET
    // lists; POST {entries:[...]} saves the full list; /suggest asks the model
    // to propose entries from the recent fiction.
    if (parts[1] === "conversations" && parts[2] && parts[3] === "lore" && parts[4] === "suggest" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const entries = await suggestLore(conv, listMessages(conv.id));
      console.log(`[lore] 🧭 conversation #${conv.id} — ${entries.length} proposition(s)`);
      return json({ entries });
    }
    if (parts[1] === "conversations" && parts[2] && parts[3] === "lore" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      let cs: Record<string, any> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      return json({ entries: Array.isArray(cs.lore_entries) ? cs.lore_entries : [] });
    }
    if (parts[1] === "conversations" && parts[2] && parts[3] === "lore" && method === "POST") {
      const convId = Number(parts[2]);
      const conv = getConversation(convId);
      if (!conv) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      const entries = (Array.isArray(body?.entries) ? body.entries : [])
        .map((e: any) => ({
          key: String(e?.key || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`).slice(0, 40),
          name: String(e?.name || "").trim().slice(0, 120),
          triggers: String(e?.triggers || "").trim().slice(0, 300),
          content: String(e?.content || "").trim().slice(0, 2000),
          enabled: e?.enabled === false || e?.enabled === 0 ? 0 : 1,
          at: e?.at ?? Date.now(),
        }))
        .filter((x: any) => x.name || x.content);
      let cs: Record<string, any> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      cs.lore_entries = entries;
      updateConversation(convId, { settings: JSON.stringify(cs) });
      return json({ entries });
    }
    // quest journal: POST {refresh:true} asks the LLM to extract the current
    // objectives from the conversation; POST {quests:[...]} saves them (manual
    // status edits). Stored in the conversation settings, never in the prompt.
    if (parts[1] === "conversations" && parts[2] && parts[3] === "quests" && method === "POST") {
      const convId = Number(parts[2]);
      const conv = getConversation(convId);
      if (!conv) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      let cs: Record<string, unknown> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      let quests: Quest[] = [];
      try { quests = Array.isArray(cs.quests) ? cs.quests : []; } catch { /* ignore */ }
      if (body.refresh) {
        console.log(`[quests] 📜 conversation #${convId} « ${(conv.title || "").slice(0, 50)} » — analyse IA`);
        try {
          const fresh = await generateQuests(conv.title || "Partie", listMessages(convId));
          // keep the player's manual status changes on same-titled quests
          const byTitle = new Map(quests.map((q) => [q.title.toLowerCase(), q]));
          quests = fresh.map((q) => ({ ...q, status: byTitle.get(q.title.toLowerCase())?.status ?? q.status }));
        } catch (e) {
          console.warn("[quests] analyse échouée:", String(e?.message ?? e).slice(0, 160));
          return json({ error: "L'analyse IA a échoué — vérifie la connexion au modèle.", quests }, 502);
        }
      } else if (Array.isArray(body.quests)) {
        quests = body.quests
          .map((q: any) => ({
            title: String(q?.title || "").trim().slice(0, 140),
            status: ["active", "done", "dropped"].includes(q?.status) ? q.status : "active",
            notes: String(q?.notes || "").trim().slice(0, 400),
          }))
          .filter((q: Quest) => q.title);
      }
      cs.quests = quests;
      updateConversation(convId, { settings: JSON.stringify(cs) });
      return json({ quests });
    }
    // fork a conversation up to a message — branching: regenerate in a copy,
    // the original stays intact (images are copied with remapped ids)
    if (parts[1] === "conversations" && parts[2] && parts[3] === "fork" && method === "POST") {
      const body = await readJson(req);
      const src = getConversation(Number(parts[2]));
      if (!src) return json({ error: "not found" }, 404);
      // copy everything strictly BEFORE the given message: the caller replays
      // that message itself (regenerate re-sends the user turn), so copying it
      // too would duplicate it in the branch
      const before = Number(body.upToMessageId);
      const srcMsgs = listMessages(src.id).filter((m) => m.id < before);
      if (!srcMsgs.length) return json({ error: "rien à copier" }, 400);
      const fork = createConversation({
        title: (src.title || "Partie") + " · variante",
        world_id: src.world_id,
        persona_id: src.persona_id,
        scenario_id: src.scenario_id,
        cast: src.cast,
        group_mode: src.group_mode,
        settings: src.settings,
        parent_id: src.id,
        branch_kind: "alternative",
      });
      const imgSrcDir = path.join(IMAGES_DIR, "conversations", String(src.id));
      const imgDstDir = path.join(IMAGES_DIR, "conversations", String(fork.id));
      for (const m of srcMsgs) {
        const view = messageView({ ...m });
        const meta = view.meta as any;
        const newMid = createMessage({
          conversation_id: fork.id, role: m.role, name: m.name, content: m.content,
          segments: m.segments, meta: "{}",
        }).id;
        // copy the illustration
        if (meta.image) {
          const file = path.basename(meta.image);
          const srcImg = path.join(imgSrcDir, file);
          if (fs.existsSync(srcImg)) {
            fs.mkdirSync(imgDstDir, { recursive: true });
            fs.copyFileSync(srcImg, path.join(imgDstDir, file));
            meta.image = `/images/conversations/${fork.id}/${file}`;
          }
        }
        delete meta.suggestions; // the branch point changed the context
        updateMessage(newMid, { meta: JSON.stringify(meta) });
      }
      const last = srcMsgs[srcMsgs.length - 1];
      updateConversation(fork.id, { last_message: last.content.slice(0, 200) });
      const view = conversationView(fork.id)!;
      view.messages = listMessages(view.id).map(messageView);
      return json(view, 201);
    }
    // scene state panel: stored structured summary of the current scene
    if (parts[1] === "conversations" && parts[2] && parts[3] === "scene" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      let cs: Record<string, unknown> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      const state = cs.scene_state && typeof cs.scene_state === "object" ? cs.scene_state : null;
      return json({ state, updatedAt: typeof cs.scene_updated_at === "number" ? cs.scene_updated_at : 0 });
    }
    if (parts[1] === "conversations" && parts[2] && parts[3] === "scene" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      let cs: Record<string, unknown> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      const lastUpdate = typeof cs.scene_updated_at === "number" ? cs.scene_updated_at : 0;
      // throttle: never regenerate more than once every 2 minutes
      if (Date.now() - lastUpdate < 120_000 && cs.scene_state) {
        return json({ state: cs.scene_state, updatedAt: lastUpdate, throttled: true });
      }
      const state = await generateSceneState(conv.id);
      if (!state) return json({ error: "Le modèle n'a pas pu produire l'état de scène" }, 502);
      updateConversation(conv.id, { settings: JSON.stringify({ ...cs, scene_state: state, scene_updated_at: Date.now() }) });
      return json({ state, updatedAt: Date.now() });
    }

    // branch family: parent + siblings + children of a conversation
    if (parts[1] === "conversations" && parts[2] && parts[3] === "branches" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const family = new Map<number, ConversationRow>();
      family.set(conv.id, conv);
      if (conv.parent_id) {
        const parent = getConversation(conv.parent_id);
        if (parent) family.set(parent.id, parent);
        for (const s of listBranches(conv.parent_id)) family.set(s.id, s);
      }
      for (const c of listBranches(conv.id)) family.set(c.id, c);
      const list = [...family.values()].sort((a, b) => a.created_at - b.created_at);
      return json({ branches: list.map((c) => conversationView(c.id)) });
    }
    // narrative consistency check (LLM, button-triggered — never blocks a turn)
    if (parts[1] === "conversations" && parts[2] && parts[3] === "validate" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const result = await validateNarrative(conv.id);
      if (!result) return json({ error: "Le modèle n'a pas pu vérifier la cohérence" }, 502);
      let cs: Record<string, unknown> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      updateConversation(conv.id, { settings: JSON.stringify({ ...cs, validation: result }) });
      return json(result);
    }

    // estimate the tokens the model would receive for this conversation
    if (parts[1] === "conversations" && parts[2] && parts[3] === "context" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const view = conversationView(conv.id)!;
      const msgs = listMessages(conv.id);
      const { system, messages } = buildMessages(
        { world: view.world, persona: view.persona, cards: view.cards, scenario: view.scenario, conversation: conv, summary: conv.summary || undefined, memory: parseMemory(conv.memory_json) || undefined },
        msgs,
      );
      const tokens = estimateTokens(system) + messages.reduce((acc, m) => acc + estimateTokens(m.content), 0);
      // context budget: tokens used vs the configured window (conversation or world cap)
      let cs: Record<string, unknown> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      let maxMsgs = Number(cs.context_max_messages ?? getSetting("context_max_messages", 20));
      let capSource = "partie";
      const world = conv.world_id ? getWorld(conv.world_id) : null;
      if (world) {
        let ws: Record<string, unknown> = {};
        try { ws = JSON.parse(world.settings || "{}"); } catch { /* ignore */ }
        const worldCap = Number(ws.context_max_messages ?? getSetting("world_context_max_messages", 0));
        if (worldCap > 0 && worldCap < maxMsgs) { maxMsgs = worldCap; capSource = "monde"; }
      }
      const estPerMsg = Math.max(80, Math.round(tokens / Math.max(1, messages.length)));
      const budgetTokens = maxMsgs * estPerMsg;
      return json({
        tokens,
        systemTokens: estimateTokens(system),
        messageCount: messages.length,
        keptMessages: Math.min(messages.length, maxMsgs),
        budgetTokens,
        budget: Math.min(100, Math.round((tokens / Math.max(1, budgetTokens)) * 100)),
        capSource,
      });
    }
    // full export of a conversation: markdown + JSON + images, as a ZIP
    if (parts[1] === "conversations" && parts[2] && parts[3] === "export" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const view = conversationView(conv.id)!;
      const msgs = listMessages(conv.id).map(messageView);
      const lines = msgs.map((m: any) => {
        const who = m.role === "user" ? (view.persona?.name || "Moi") : (m.name || "Narrateur");
        const body = (m.meta?.image ? `![illustration](${m.meta.image})\n` : "") + (m.content || "");
        return m.role === "user" ? `**${who}** : ${body}` : `> **${who}** : ${body}`;
      }).join("\n\n");
      const md = `# ${conv.title}\n\n${lines}\n`;
      const files: { path: string; data: Uint8Array | string }[] = [
        { path: "conversation.md", data: md },
        {
          path: "messages.json",
          data: JSON.stringify({
            title: conv.title, world: view.world?.name ?? null, exported_at: new Date().toISOString(), messages: msgs,
          }, null, 2),
        },
      ];
      const imgDir = path.join(IMAGES_DIR, "conversations", String(conv.id));
      const seenImg = new Set<string>();
      for (const m of msgs as any[]) {
        if (m.meta?.image && !seenImg.has(m.meta.image)) {
          seenImg.add(m.meta.image);
          const full = path.join(imgDir, path.basename(m.meta.image));
          if (fs.existsSync(full)) files.push({ path: `images/${path.basename(m.meta.image)}`, data: new Uint8Array(fs.readFileSync(full)) });
        }
      }
      const zip = zipFiles(files);
      const name = encodeURIComponent((conv.title || "partie").replace(/[^\p{L}\p{N} _-]+/gu, "").slice(0, 60));
      return new Response(zip, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename*=UTF-8''${name}.zip`,
        },
      });
    }
    // export the party as a Markdown book: chapters, scene breaks, memory header
    // branch=current (default) | canon (main + canon branches of the family)
    if (parts[1] === "conversations" && parts[2] && parts[3] === "export-md" && method === "GET") {
      const convId = Number(parts[2]);
      const conv = getConversation(convId);
      if (!conv) return json({ error: "not found" }, 404);
      const branchMode = url.searchParams.get("branch") || "current";
      // canon mode: gather the family (root + siblings/children) and keep only
      // main / canon branches, in chronological order
      let exports: { conv: ConversationRow; view: any; msgs: any[]; title: string }[] = [];
      if (branchMode === "canon") {
        const family = new Map<number, ConversationRow>();
        family.set(conv.id, conv);
        if (conv.parent_id) {
          const parent = getConversation(conv.parent_id);
          if (parent) { family.set(parent.id, parent); for (const s of listBranches(parent.id)) family.set(s.id, s); }
        }
        for (const c of listBranches(conv.id)) family.set(c.id, c);
        const kept = [...family.values()]
          .filter((c) => c.branch_kind === "main" || c.branch_kind === "canon")
          .sort((a, b) => a.created_at - b.created_at);
        for (const c of kept) exports.push({ conv: c, view: conversationView(c.id)!, msgs: listMessages(c.id).map(messageView), title: c.title || "Partie" });
      } else {
        exports = [{ conv, view: conversationView(convId)!, msgs: listMessages(convId).map(messageView), title: conv.title || "Partie" }];
      }
      const renderBook = (conv: ConversationRow, view: any, msgs: any[]): string[] => {
        const lines: string[] = [];
        const mem = parseMemory(conv.memory_json);
        if (mem) lines.push(`## Mémoire\n${memoryToText(mem)}\n`);
        if (!msgs.length) { lines.push("*(Aucun message.)*"); return lines; }
        let chapter = 0;
        let lastTs = 0;
        let inChapter = false;
        for (const m of msgs) {
          const gap = lastTs && m.created_at - lastTs > 2 * 3600 * 1000;
          const chapterBreak = gap || chapter === 0;
          if (chapterBreak) {
            chapter++;
            const d = new Date(m.created_at);
            lines.push(`\n## Chapitre ${chapter} — ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}`);
            inChapter = false;
          } else if (inChapter) {
            lines.push("---\n"); // scene break between messages
          }
          inChapter = true;
          const who = m.role === "user" ? (view.persona?.name ?? "Moi") : (m.name || "Narrateur");
          const img = m.meta?.image ? `\n![illustration](${m.meta.image})\n` : "";
          const body = (m.content || "").replace(/\*\*/g, "").trim();
          lines.push(m.role === "user" ? `**${who}** : ${body}` : `> **${who}** : ${body}`);
          if (img) lines.push(img);
          lastTs = m.created_at;
        }
        return lines;
      };
      const title = conv.title || "Partie";
      const lines: string[] = [`# ${title}\n`];
      const firstView = exports[0].view;
      const metaBits = [
        firstView.world?.name ? `**Monde :** ${firstView.world.name}` : null,
        conv.group_mode ? "**Mode :** groupe" : "**Mode :** solo",
        branchMode === "canon" ? "**Export :** canon (branches principales)" : null,
        `**Exporté le :** ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}`,
      ].filter(Boolean);
      lines.push(metaBits.join(" · ") + "\n");
      if (exports.length > 1) {
        for (const e of exports) {
          lines.push(`\n---\n\n## Branch ${e.title} — ${e.conv.branch_kind === "canon" ? "⭐ canon" : "🌳 principale"}\n`);
          lines.push(...renderBook(e.conv, e.view, e.msgs));
        }
      } else {
        lines.push(...renderBook(exports[0].conv, exports[0].view, exports[0].msgs));
      }
      const text = lines.join("\n");
      const safe = title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "partie";
      return new Response(text, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safe}${branchMode === "canon" ? "-canon" : ""}.md"`,
        },
      });
    }
    // gallery: all illustrations of a conversation + AI captions
    if (parts[1] === "conversations" && parts[2] && parts[3] === "gallery" && method === "GET") {
      const convId = Number(parts[2]);
      const conv = getConversation(convId);
      if (!conv) return json({ error: "not found" }, 404);
      const msgs = listMessages(convId).map(messageView);
      const items = msgs.filter((m: any) => m.meta?.image).map((m: any) => ({
        id: m.id, image: m.meta.image, seed: m.meta.image_seed ?? m.meta.seed ?? null,
        kind: m.meta.image_kind ?? null, character: m.meta.image_char ?? m.meta.character ?? null,
        fav: m.meta.image_fav ? 1 : 0, message: (m.content || "").slice(0, 200),
      }));
      let captions: Record<string, string> = {};
      try {
        captions = JSON.parse(fs.readFileSync(path.join(IMAGES_DIR, "conversations", String(convId), "captions.json"), "utf8"));
      } catch { /* none yet */ }
      return json({ items, captions });
    }
    // world gallery: every illustration across the world's parties (conversation
    // images + world cover/map) with filters: kind, character, favorites
    if (parts[1] === "worlds" && parts[2] && parts[3] === "gallery" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const items: any[] = [];
      const push = (image: string, kind: string | null, character: string | null, seed: number | null, msg: string, convId: number | null, convTitle: string, createdAt: number, fav: number, mid?: number) => {
        items.push({ image, kind, character, seed, message: msg.slice(0, 200), conversation_id: convId, conversation: convTitle, created_at: createdAt, fav, id: mid ?? `w${image}` });
      };
      for (const conv of listConversations().filter((c) => c.world_id === world.id)) {
        for (const m of listMessages(conv.id).map(messageView)) {
          const meta = m.meta as any;
          if (meta?.image) push(meta.image, meta.image_kind ?? null, meta.image_char ?? null, meta.image_seed ?? meta.seed ?? null, m.content || "", conv.id, conv.title, m.created_at, meta.image_fav ? 1 : 0, m.id);
        }
      }
      if (world.cover) push(world.cover, "landscape", null, null, "Couverture du monde", null, world.name, world.created_at ?? Date.now(), 0);
      if (world.map) push(world.map, "landscape", null, null, "Carte du monde", null, world.name, world.created_at ?? Date.now(), 0);
      items.sort((a, b) => b.created_at - a.created_at);
      return json({ items });
    }
    // generate AI captions for the gallery in one pass (one LLM call)
    if (parts[1] === "conversations" && parts[2] && parts[3] === "gallery" && parts[4] === "captions" && method === "POST") {
      const convId = Number(parts[2]);
      const conv = getConversation(convId);
      if (!conv) return json({ error: "not found" }, 404);
      const msgs = listMessages(convId).map(messageView);
      const items = msgs.filter((m: any) => m.meta?.image);
      if (!items.length) return json({ captions: {} });
      let existing: Record<string, string> = {};
      const capFile = path.join(IMAGES_DIR, "conversations", String(convId), "captions.json");
      try { existing = JSON.parse(fs.readFileSync(capFile, "utf8")); } catch { /* none */ }
      const job = createJob({ type: "captions", status: "running", progress: 0, conversation_id: convId, payload: JSON.stringify({ count: items.length }) });
      try {
        const provider = getProvider();
        let model = defaultModelFor(provider.id);
        if (!model) { const models = await provider.models(); model = models[0] ?? ""; }
        const list = items.map((m: any, i: number) => `[${i + 1}] ${(m.content || "").slice(0, 300)}`).join("\n\n");
        const sys = [
          "Tu écris des légendes courtes pour la galerie d'illustrations d'une partie de roleplay.",
          "Pour chaque extrait numéroté, écris une légende d'1-2 phrases qui résume ce qui se passe, comme la voix d'un documentaire.",
          "Réponds strictement au format : 1: légende, 2: légende… Une ligne par numéro, rien d'autre.",
        ].join(" ");
        let text = "";
        try {
          for await (const delta of provider.stream({
            messages: [{ role: "system", content: sys }, { role: "user", content: `Illustrations à légender :\n\n${list}` }],
            model, temperature: 0.8, maxTokens: 800, noThinking: true,
            signal: AbortSignal.timeout(120_000),
          })) { text += delta; }
        } catch (e) {
          updateJob(job.id, { status: "failed", error: String((e as any)?.message ?? e).slice(0, 300), completed_at: Date.now() });
          return json({ captions: existing, error: `Le modèle n'a pas pu écrire les légendes : ${(e as any)?.message ?? e}` });
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
        updateJob(job.id, { status: "done", progress: 100, completed_at: Date.now() });
        return json({ captions: existing });
      } catch (e: any) {
        updateJob(job.id, { status: "failed", error: String(e?.message ?? e).slice(0, 300), completed_at: Date.now() });
        return json({ captions: existing, error: String(e?.message ?? e) }, 500);
      }
    }
    // edit a message's content (double-click in the UI)
    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && !parts[5] && method === "PATCH") {
      const convId = Number(parts[2]);
      const mid = Number(parts[4]);
      const body = await readJson(req);
      const m = getMessage(mid);
      const conv = getConversation(convId);
      if (!conv || !m) return json({ error: "not found" }, 404);
      const meta = JSON.parse(m.meta || "{}");
      // meta-only updates (favoris, notes privées…) never touch content
      if (body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)) {
        Object.assign(meta, body.meta);
        updateMessage(mid, { meta: JSON.stringify(meta) });
        return json(messageView(getMessage(mid)!));
      }
      if (typeof body.content !== "string" || !body.content.trim()) {
        return json({ error: "contenu vide" }, 400);
      }
      const content = body.content.trim();
      const updates: Record<string, string> = { content };
      if (m.role === "assistant") {
        updates.segments = JSON.stringify(parseSegmentsFor(conv, content));
      }
      // content changed → the old response suggestions no longer match
      delete meta.suggestions;
      updates.meta = JSON.stringify(meta);
      updateMessage(mid, updates);
      return json(messageView(getMessage(mid)!));
    }
    // delete message + everything after (for regenerate/edit)
    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && !parts[5] && method === "DELETE") {
      const convId = Number(parts[2]);
      const mid = Number(parts[4]);
      const msgs = listMessages(convId);
      const idx = msgs.findIndex((m) => m.id === mid);
      if (idx < 0) return json({ error: "message not found" }, 404);
      for (const m of msgs.slice(idx)) {
        deleteMessage(m.id);
      }
      const last = lastMessageOf(convId);
      updateConversation(convId, { last_message: last?.content ?? "" });
      return json({ ok: true });
    }
    // emoji reactions on a message (kept in meta.reactions)
    // bulk delete: remove EXACTLY the selected message ids (no cascade) — used
    // by the chat's multi-select mode
    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] === "bulk-delete" && method === "POST") {
      const convId = Number(parts[2]);
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return json({ error: "aucun message sélectionné" }, 400);
      for (const mid of ids) {
        deleteMessage(mid);
      }
      const last = lastMessageOf(convId);
      updateConversation(convId, { last_message: last?.content ?? "" });
      return json({ ok: true, removed: ids.length });
    }
    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && parts[5] === "reactions" && (method === "POST" || method === "DELETE")) {
      const mid = Number(parts[4]);
      const m = getMessage(mid);
      if (!m) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      const emoji = String(body.emoji || "").trim();
      if (!emoji) return json({ error: "emoji manquant" }, 400);
      const meta = JSON.parse(m.meta || "{}");
      const reactions: string[] = Array.isArray(meta.reactions) ? meta.reactions : [];
      const idx = reactions.indexOf(emoji);
      if (method === "POST" && idx < 0) reactions.push(emoji);
      if (method === "DELETE" && idx >= 0) reactions.splice(idx, 1);
      meta.reactions = reactions;
      updateMessage(mid, { meta: JSON.stringify(meta) });
      return json(messageView(getMessage(mid)!));
    }
    // stream a chat turn
    if (parts[1] === "conversations" && parts[2] && parts[3] === "stream" && method === "POST") {
      return handleStream(req, Number(parts[2]));
    }
    // scene illustration for a message (kind: auto | landscape | portrait)
    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && parts[5] === "image" && method === "POST") {
      const convId = Number(parts[2]);
      const mid = Number(parts[4]);
      const conv = getConversation(convId);
      const m = getMessage(mid);
      if (!conv || !m) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      const world = conv.world_id ? getWorld(conv.world_id) : null;
      let cast: any[] = [];
      try { cast = (JSON.parse(conv.cast || "[]") as number[]).map((cid) => getCard(Number(cid))).filter(Boolean); } catch { /* ignore */ }
      // "character" forces a character portrait (first cast card as fallback)
      const forcedChar = body.kind === "character";
      const char = forcedChar
        ? (characterForMessage(cast, m.content) ?? cast[0] ?? null)
        : characterForMessage(cast, m.content);
      const kind = forcedChar ? "portrait"
        : body.kind === "landscape" || body.kind === "portrait" ? body.kind
        : detectSceneKind(m.content);
      const landscape = kind === "landscape";
      let prompt = buildIllustrationPrompt(world?.name ?? "", world?.description ?? "", world?.tone ?? "épique", m.content, kind, char);
      const seed =
        typeof body.seed === "number" ? body.seed
        : body.vary ? undefined
        : char ? charSeed(char.id)
        : undefined;
      // optional seed-locked variation: same seed + a prompt tweak = same
      // composition, different details (used by the gallery's 🔒 button)
      if (typeof body.variation === "string" && body.variation.trim()) {
        prompt = `${prompt}\n(${body.variation.trim().slice(0, 300)})`;
      }
      // img2img: use the character's avatar as a visual reference so their
      // face stays consistent from one illustration to the next
      let init_image: string | undefined;
      const fullChar = char ? cast.find((c) => c.id === char.id) ?? null : null;
      const avatarRel = fullChar?.avatar ?? "";
      if (avatarRel) {
        const avatarFile = path.join(UPLOADS_DIR, path.basename(avatarRel));
        if (fs.existsSync(avatarFile)) {
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
      const res = await generateAndSave(`conversations/${convId}`, {
        prompt,
        negative,
        steps: Number(getSetting("image_steps", 28)),
        cfg: Number(getSetting("image_cfg", 7)),
        width: Number(getSetting("image_width", landscape ? 1152 : 768)),
        height: Number(getSetting("image_height", landscape ? 768 : 1152)),
        seed,
        init_image,
        strength: Number(getSetting("image_ref_strength", 0.55)),
      });
      const meta = { ...messageView(m).meta, image: res.url, image_seed: res.seed, image_kind: kind, image_char: char?.name ?? undefined };
      updateMessage(mid, { meta: JSON.stringify(meta) });
      return json({ image: res.url, seed: res.seed, kind, character: char?.name ?? null });
    }

    // (re)generate response suggestions for the last assistant message
    if (parts[1] === "conversations" && parts[2] && parts[3] === "suggestions" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const view = conversationView(conv.id)!;
      const msgs = listMessages(conv.id);
      const lastAssist = [...msgs].reverse().find((m) => m.role === "assistant");
      if (!lastAssist) return json({ suggestions: [] });
      const sugg = await generateSuggestions(
        { world: view.world, persona: view.persona, cards: view.cards, scenario: view.scenario, conversation: conv },
        msgs.filter((m) => m.id !== lastAssist.id),
      );
      if (sugg.length) {
        const meta = { ...JSON.parse(lastAssist.meta || "{}"), suggestions: sugg };
        updateMessage(lastAssist.id, { meta: JSON.stringify(meta) });
      }
      return json({ messageId: lastAssist.id, suggestions: sugg });
    }

    // full backup: worlds + scenarios + cards + personas + conversations
    if (p === "/api/export" && method === "GET") {
      const conversations = listConversations().map((c) => {
        let cast: unknown = [];
        let settings: unknown = {};
        try { cast = JSON.parse(c.cast); } catch { /* ignore */ }
        try { settings = JSON.parse(c.settings); } catch { /* ignore */ }
        return { ...c, cast, settings, messages: listMessages(c.id) };
      });
      return json({
        app: "innsekai",
        version: 1,
        exported_at: new Date().toISOString(),
        worlds: listWorlds(),
        scenarios: listScenarios(),
        cards: listCards(),
        personas: listPersonas(),
        conversations,
        timeline_events: listWorlds().flatMap((w) => listTimeline(w.id)),
      });
    }
// restore a backup (creates fresh rows, remaps foreign keys)
function restoreBackup(b: any): Response {
  const worldIds = new Map<number, number>();
  for (const w of b.worlds ?? []) {
    const nw = createWorld(w);
    worldIds.set(Number(w.id), nw.id);
  }
  const scenIds = new Map<number, number>();
  for (const s of b.scenarios ?? []) {
    const ns = createScenario({ ...s, world_id: worldIds.get(Number(s.world_id)) ?? s.world_id });
    scenIds.set(Number(s.id), ns.id);
  }
  const cardIds = new Map<number, number>();
  for (const c of b.cards ?? []) {
    const nc = createCard(c);
    cardIds.set(Number(c.id), nc.id);
  }
  const personaIds = new Map<number, number>();
  for (const po of b.personas ?? []) {
    const np = createPersona(po);
    personaIds.set(Number(po.id), np.id);
  }
  let conversations = 0;
  const convIds = new Map<number, number>();
  const msgIds = new Map<number, number>();
  for (const c of b.conversations ?? []) {
    const conv = createConversation({
      title: c.title ?? "Partie restaurée",
      world_id: c.world_id ? (worldIds.get(Number(c.world_id)) ?? null) : null,
      persona_id: c.persona_id ? (personaIds.get(Number(c.persona_id)) ?? null) : null,
      scenario_id: c.scenario_id ? (scenIds.get(Number(c.scenario_id)) ?? null) : null,
      cast: JSON.stringify((Array.isArray(c.cast) ? c.cast : []).map((id: number) => cardIds.get(Number(id)) ?? id)),
      group_mode: c.group_mode ? 1 : 0,
      settings: JSON.stringify(c.settings ?? {}),
    });
    convIds.set(Number(c.id), conv.id);
    for (const m of c.messages ?? []) {
      const nm = createMessage({
        conversation_id: conv.id, role: m.role ?? "assistant", name: m.name ?? "",
        content: m.content ?? "", segments: JSON.stringify(m.segments ?? "[]"),
        meta: JSON.stringify(m.meta ?? {}),
      });
      if (m.id != null) msgIds.set(Number(m.id), nm.id);
    }
    conversations++;
  }
  // second pass: restore branch links — a parent can appear after its child
  for (const c of b.conversations ?? []) {
    const newId = convIds.get(Number(c.id));
    if (newId === undefined) continue;
    const patch: any = { parent_id: c.parent_id != null ? (convIds.get(Number(c.parent_id)) ?? null) : null };
    if (typeof c.branch_kind === "string") patch.branch_kind = c.branch_kind;
    updateConversation(newId, patch);
  }
  // timeline events: remap world / conversation / message ids
  let timelineEvents = 0;
  for (const e of b.timeline_events ?? []) {
    createTimelineEvent({
      world_id: worldIds.get(Number(e.world_id)) ?? 0,
      conversation_id: e.conversation_id != null ? (convIds.get(Number(e.conversation_id)) ?? null) : null,
      message_id: e.message_id != null ? (msgIds.get(Number(e.message_id)) ?? null) : null,
      label: e.label ?? "",
    });
    timelineEvents++;
  }
  return json({
    ok: true,
    worlds: (b.worlds ?? []).length, scenarios: (b.scenarios ?? []).length,
    cards: (b.cards ?? []).length, personas: (b.personas ?? []).length, conversations,
    timeline_events: timelineEvents,
  });
}


    return json({ error: "Not found" }, 404);
  } catch (e: any) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: String(e?.message ?? e) }, status);
  }
}

// standard danbooru-style negative prompt for anime SDXL checkpoints
const NEGATIVE_PROMPT =
  "worst quality, low quality, lowres, bad anatomy, bad hands, missing fingers, extra digits, " +
  "fewer digits, extra limbs, mutated hands and fingers, deformed, disfigured, blurry, out of focus, " +
  "ugly, duplicate, monochrome, text, watermark, signature, logo, jpeg artifacts, frame, border";

// common FR-EN keyword map: tag-trained anime models understand English tags
const IMG_TAGS_FR2EN: Record<string, string> = {
  temple: "grand temple", "château": "castle", "chateau": "castle", "forêt": "dense forest", "foret": "dense forest",
  "montagne": "mountain range", "grottes": "cavern", "grotte": "cavern", "rivière": "river", "riviere": "river",
  "lac": "lake", "océan": "ocean", "ocean": "ocean", "neige": "snow", "pluie": "rain, wet", "orage": "storm clouds",
  "rune": "glowing runes, arcane symbols", "runes": "glowing runes, arcane symbols", "magie": "magic circles, glowing magic",
  "lame": "glass sword, radiant blade", "épée": "ornate sword", "epee": "ornate sword", "bouclier": "shield",
  "flamme": "open flame, fire", "feu": "bonfire, embers", "ombre": "dark shadows, silhouettes", "ténèbres": "darkness, gloom", "tenebres": "darkness, gloom",
  "cendres": "floating ashes, apocalyptic", "mort": "skulls, dark fantasy", "dieux": "ancient statues", "autel": "stone altar",
  "statue": "stone statue", "colonnes": "ancient pillars", "portail": "portal, glowing gate", "escalier": "stone staircase",
  "toits": "medieval roofs", "salle": "stone hall", "trône": "throne", "trone": "throne", "crystal": "crystaline details", "cristal": "crystaline details", "gemme": "glowing gem",
  "sang": "dripping blood, dark", "squelette": "skeleton", "serpent": "serpent", "dragon": "dragon", "loup": "wolf", "corbeau": "raven", "chene": "ancient oak", "arbre": "ancient tree",
  "bougie": "candlelight", "fumée": "smoke, mist", "fumee": "smoke, mist", "brume": "mist, fog", "lune": "full moon", "étoiles": "starry night sky", "etoiles": "starry night sky", "ciel": "dramatic sky",
  "flèches": "arrows", "fleches": "arrows", "arc": "longbow", "armure": "armor, knight", "cape": "cape, cloak", "masque": "mask, masked", "ailes": "large wings", "alle": "large wings",
  "combat": "battle scene", "bataille": "epic battle", "guerre": "war-torn landscape", "village": "small village", "ville": "fantasy city", "tour": "tower, spire", "pont": "ancient bridge",
  "fleur": "flowers, nature", "fleurs": "flowers, nature", "herbe": "grass, nature", "falaise": "cliffside", "désert": "desert dunes", "desert": "desert dunes", "volcan": "volcano",
};

const LANDSCAPE_WORDS = new Set([
  "temple", "château", "chateau", "forêt", "foret", "montagne", "grottes", "grotte", "rivière", "riviere",
  "lac", "océan", "ocean", "mer", "neige", "pluie", "orage", "ciel", "étoiles", "etoiles", "lune", "désert", "desert",
  "volcan", "village", "ville", "pont", "tour", "falaise", "plaine", "vallée", "vallee", "palais", "ruines", "prairie",
  "chene", "arbre", "fleur", "fleurs", "herbe", "lande", "port", "fjord", "donjon", "cols", "salle", "autel", "statue",
  "trône", "trone", "escalier", "toits", "bougie", "brume", "fumée", "fumee", "cendres", "portail", "colonnes", "monument",
]);

/** Guess the kind of image a message calls for: pure scenery → landscape. */
export function detectSceneKind(content: string): "landscape" | "portrait" {
  // drop dialogue lines, keep narration words (asterisks become spaces so a
  // fully italic message is not stripped bare)
  const withoutDialogue = content.replace(/"[^"]*"/g, " ").replace(/\*/g, " ");
  const words = withoutDialogue
    .toLowerCase()
    .split(/[^\p{L}'-]+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 2); // keep 3-letter words like mer/lac
  const hits = words.filter((w) => LANDSCAPE_WORDS.has(w)).length;
  const wc = words.length;
  return hits >= 2 && wc >= 5 ? "landscape" : "portrait";
}

/** Deterministic seed per card — the same character always gets the same seed. */
export function charSeed(cardId: number): number {
  return ((cardId * 2654435761) >>> 0) % 2_147_483_647;
}

/**
 * If the message is (mostly) a character's line, return that card so the
 * illustration keeps their look (prompt identity + fixed seed).
 */
export function characterForMessage(cast: { id: number; name: string; description?: string }[], content: string): { id: number; name: string; description: string } | null {
  if (!cast.length) return null;
  // first dialogue speaker of the message wins (the scene is about them)
  for (const seg of parseSegments(content)) {
    if (seg.type === "dialogue" && seg.speaker) {
      const card = cast.find((c) => c.name.toLowerCase() === seg.speaker.toLowerCase());
      if (card) return { id: card.id, name: card.name, description: card.description ?? "" };
    }
  }
  // narration mentioning a cast member by name → that character
  const lower = content.toLowerCase();
  const card = cast.find((c) => c.name.length > 2 && lower.includes(c.name.toLowerCase()));
  return card ? { id: card.id, name: card.name, description: card.description ?? "" } : null;
}

/** Card description → danbooru-style tags (shared pipeline with the scene prompt). */
function descriptionToTags(desc: string): string[] {
  const raw = desc.replace(/[*"«»]/g, " ").replace(/\s+/g, " ").trim();
  const words = raw
    .toLowerCase()
    .split(/[^\p{L}'-]+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const t = IMG_TAGS_FR2EN[w] ?? w;
    if (seen.has(t)) continue;
    seen.add(t);
    tags.push(t);
  }
  return tags;
}

const STOP_WORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "dans", "sur", "sous", "avec", "pour", "plus", "pas",
  "très", "tres", "mais", "comme", "lui", "elle", "il", "ils", "tu", "vous", "je", "me", "moi", "mon", "ma", "mes",
  "ton", "ta", "tes", "sa", "son", "ses", "ce", "cet", "cette", "ces", "au", "aux", "en", "par", "se", "si", "ne",
  "y", "vers", "contre", "entre", "tout", "tous", "alors", "quand", "où", "ou", "comment", "pourquoi", "à", "a", "était",
  "etait", "être", "fait", "faire", "voit", "vois", "dit", "dis", "demande", "répond", "repond", "veux", "veut", "peux",
  "peut", "semble", "déjà", "deja", "encore", "aussi", "bien", "même", "meme", "autre", "rien", "quelque", "petite", "petit",
  "grand", "grande", "toujours", "jamais", "seul", "seule", "place", "peu", "long", "voix", "regarde", "sait", "savez", "sais",
  "face", "côté", "cote", "doit", "faites", "êtes", "etes",
]);

function buildIllustrationPrompt(world: string, desc: string, tone: string, scene: string, kind: "auto" | "landscape" | "portrait" = "auto", character?: { id: number; name: string; description?: string } | null): string {
  // strip roleplay markup, keep a clean lowercase word list
  const raw = scene.replace(/[*"«»]/g, " ").replace(/\s+/g, " ").trim();
  const words = raw
    .toLowerCase()
    .split(/[^\p{L}'-]+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  // translate known words, keep unique order
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const t = IMG_TAGS_FR2EN[w] ?? w;
    if (seen.has(t)) continue;
    seen.add(t);
    tags.push(t);
  }
  // keep the prompt in tags: translate the tone, drop French prose (tag-trained
  // anime models respond poorly to natural-language sentences)
  const TONE_EN: Record<string, string> = {
    "épique": "epic", "epique": "epic", "sombre": "dark, grim", "léger": "lighthearted",
    "leger": "lighthearted", "mystérieux": "mysterious", "mysterieux": "mysterious",
    "comique": "comedic", "heroïque": "heroic", "heroique": "heroic", "neutre": "",
  };
  const worldPart = [world || "fantasy", TONE_EN[String(tone || "").toLowerCase().trim()] || ""].filter(Boolean).join(", ");
  // character identity: description-derived tags + name + stable face framing
  let charPart: string[] = [];
  if (character) {
    charPart = [
      "character focus, one character",
      ...descriptionToTags(character.description),
      character.name.replace(/\s+/g, "_"),
      "solo, upper body, detailed face, face focus, looking at viewer",
    ].filter(Boolean);
  }
  // environment-only scenes: push the scenery, keep the frame empty of people
  const sceneOverride =
    kind === "landscape"
      ? ["scenery, breathtaking landscape, wide angle shot, vast vista, clear composition", "no people, no characters, empty scene, background focus"]
      : ["cinematic lighting, dramatic composition, detailed background, depth of field, sharp focus"];
  // danbooru-style: quality tags first, then environment, scene keywords, style
  return [
    "masterpiece, best quality, anime illustration, highly detailed, vibrant colors",
    worldPart,
    ...charPart,
    tags.slice(0, 12).join(", "),
    ...sceneOverride,
  ].filter(Boolean).join(", ");
}

// ─── response suggestions (the "chips") ───────────────────────────────────────
function suggestSystem(ctx: CastContext): string {
  const persona = ctx.persona;
  const cast = ctx.cards.map((c) => c.name).join(", ");
  return [
    `Tu es l'assistant de jeu d'un roleplay immersif. Le joueur s'appelle ${persona?.name ?? "Moi"}${cast ? `, les personnages présents sont : ${cast}` : ""}.`,
    "À partir de la dernière scène, propose entre 3 et 5 réponses possibles pour le joueur : des actions ou des répliques à la première personne, courtes (moins de 12 mots chacune) et variées dans le ton (une prudente, une audacieuse, une curieuse, une émotionnelle…).",
    "Réponds UNIQUEMENT avec la liste, une suggestion par ligne commençant par « - ». Aucune autre explication, aucun texte autour.",
  ].join("\n");
}

function parseSuggestions(text: string): string[] {
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
const CARD_ASSIST_FIELDS = ["name", "description", "personality", "scenario", "first_mes", "mes_example", "tags"] as const;
type CardAssistFields = Record<(typeof CARD_ASSIST_FIELDS)[number], string[]>;

async function generateCardAssist(idea: string): Promise<CardAssistFields> {
  const empty = Object.fromEntries(CARD_ASSIST_FIELDS.map((k) => [k, []])) as CardAssistFields;
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) {
    const models = await provider.models();
    model = models[0] ?? "";
  }
  const fmt = JSON.stringify(Object.fromEntries(CARD_ASSIST_FIELDS.map((k) => [k, []])));
  const sys = [
    "Tu aides à créer des cartes de personnages de roleplay.",
    "L'utilisateur décrit une idée brute — propose des alternatives (chips) pour chaque champ de la carte.",
    `Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format : ${fmt}.`,
    "Contraintes : name → 3 noms courts ; description → 2 phrases autonomes ; personality → 2 blocs de traits ; scenario → 2 situations de départ ; first_mes → 2 premiers messages courts, à la première personne ; mes_example → 1 ou 2 exemples de dialogue au format « Nom : réplique » ; tags → 4 ou 5 tags sans # (une liste d'un seul élément = une chaîne). Tout en français, cohérent avec l'idée. JSON complet, non tronqué.",
  ].join(" ");
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

// ─── story chapters & dynamic NPCs ───────────────────────────────────────────
// Chapters: closed automatically every CHAPTER_MIN_MESSAGES turns; the marker
// message is display-only (skipped in buildMessages) and summaries feed the
// system prompt. NPCs: proposed from the fiction, approved into the cast.
const CHAPTER_MIN_MESSAGES = 10;

type NpcSuggestion = { name: string; description: string; personality: string; role: string };
const NPC_FMT = '{"npcs":[{"name":"Prénom","description":"2 phrases visuelles","personality":"traits en une phrase","role":"fonction dans la scène"}]}';

async function llmJson(prompt: string, sys: string, maxTokens = 700, temperature = 0.7): Promise<Record<string, unknown> | null> {
  const provider = getProvider();
  let model = defaultModelFor(provider.id);
  if (!model) {
    try {
      const models = await provider.models();
      model = models[0] ?? "";
    } catch { /* offline */ }
  }
  if (!model) return null;
  try {
    const text = await provider.complete({
      messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
      model, temperature, maxTokens, noThinking: true, signal: AbortSignal.timeout(120_000),
    });
    return parseCardAssistJson(text || "");
  } catch (e) {
    console.warn(`[llm-json] échec: ${String(e?.message ?? e).slice(0, 140)}`);
    return null;
  }
}

function transcriptFor(msgs: MessageRow[], max = 60): string {
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
async function forkTail(src: ConversationRow, doomed: MessageRow[], fromId: number): Promise<ConversationRow | null> {
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
async function summarizeLoop(title: string, doomed: MessageRow[]): Promise<{ title: string; summary: string }> {
  const fallback = { title: "Boucle", summary: "Une tentative aboutit à une impasse. Les détails de ce trajet ont été écrasés par le retour." };
  const sys = [
    `Tu es le narrateur d'un roleplay RE:ZERO. « ${title.slice(0, 60)} ». On te confie une tranche de partie qui a été brutalisée par un retour dans le temps, pour la condenser en souvenir.`,
    "Ce souvenir doit tenir DANS ~3000 tokens, donc RESUME : garde l'essentiel des actions, des choix du joueur et de leurs conséquences, mais écrase les détails.",
    "Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format : {\"title\": \"intitulé court du souvenir (2-5 mots)\", \"summary\": \"résumé concis de 4 à 8 phrases, au présent, focalisé sur les choix et leurs issues\"}. JSON complet, non tronqué.",
  ].join(" ");
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

async function suggestLore(conv: ConversationRow, msgs: MessageRow[]): Promise<{ name: string; triggers: string; content: string }[]> {
  const LORE_FMT = '{"entries":[{"name":"faction ou lieu ou personne","triggers":"mots-clés (séparés par des virgules) qui signalent ce fait","content":"2 à 4 phrases fixes du canon, sans pronoms personnels de la scène"}]}';
  const sys = [
    `Tu es le conservateur du canon d'un roleplay « ${(conv.title || "").slice(0, 60)} ».`,
    "À partir de la fiction ci-dessous, extrais 2 à 5 faits STABLES et toujours vrais de ce monde (relations, lieux, organisations, identités, règles), jamais des émotions de scène ni des actions ponctuelles.",
    "Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format : " + LORE_FMT,
    "Les triggers doivent être de courts mots-clés de scène (prénoms, lieux, concepts) qui déclencheront l'injection du fait dans le prompt du modèle.",
    "JSON complet, non tronqué.",
  ].join(" ");
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

async function suggestChapter(title: string, msgs: MessageRow[]): Promise<{ title: string; summary: string } | null> {
  const sys = [
    `Tu es le maître de jeu d'un roleplay « ${title.slice(0, 60)} ». On te confie une tranche de partie pour en faire un chapitre.`,
    "Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format : {\"title\": \"titre évocateur de 2-6 mots\", \"summary\": \"résumé de 3 à 5 phrases des événements et des enjeux restés ouverts\"}.",
    "Le titre ne contient pas le mot chapitre. Résumé au présent, en français, prêt à relire en reprenant la partie. JSON complet, non tronqué.",
  ].join(" ");
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
const RECAP_MIN_MESSAGES = 6; // story messages since the last recap
const RECAP_MAX_SHOTS = 3;

type RecapShot = { caption: string; prompt: string; image?: string; seed?: number; status: "pending" | "done" | "error"; error?: string };
type RecapData = { title: string; text: string; at: number; last_msg_id: number; shots: RecapShot[] };

function recapOf(conv: ConversationRow): { cs: any; recap: RecapData | null } {
  let cs: any = {};
  try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
  const r = cs.recap;
  return { cs, recap: r && typeof r === "object" && !Array.isArray(r) ? r : null };
}

/** Messages that belong to the story (display-only markers such as chapters or rewind notes excluded). */
function storyMessages(msgs: MessageRow[]): MessageRow[] {
  return msgs.filter((m) => {
    try { const meta = JSON.parse(m.meta || "{}"); return !meta.chapter && !meta.rewind; } catch { return true; }
  });
}

async function suggestRecap(title: string, msgs: MessageRow[]): Promise<{ title: string; text: string; shots: { caption: string; prompt: string }[] } | null> {
  const sys = [
    `Tu es le narrateur d'un roleplay « ${title.slice(0, 60)} ». La session précédente vient de s'arrêter ; le joueur va reprendre la partie.`,
    "Rédige le « Previously on… » : un résumé court et vivant qui replace le joueur dans l'histoire.",
    'Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format : {"title":"titre court de la session (2-5 mots)","recap":"résumé narratif de 4 à 8 phrases, au présent, à la voix du narrateur : ce qui s\'est passé, où l\'on en est, les enjeux restés ouverts","shots":[{"caption":"légende française du moment clé, une phrase","prompt":"prompt d\'illustration en anglais, tags danbooru pour un modèle anime : sujet, décor, lumière, composition — jamais de texte ni de mot français"}]}.',
    `1 à ${RECAP_MAX_SHOTS} shots au maximum, pour des scènes PAYSAGE larges et visuelles ; chaque prompt décrit un moment précis et auto-suffisant, pas un plan abstrait.`,
    "Ne mentionne jamais l'IA, l'assistant ni le mot récap. JSON complet, non tronqué.",
  ].join(" ");
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
function recapShotSeed(convId: number, i: number): number {
  const x = Math.imul(convId + 1, 2654435761) ^ Math.imul(i + 1, 40503);
  return (x >>> 0) % 2_147_483_647;
}

/**
 * Render the storyboard of the current recap in the background, one shot at a
 * time (the GPU is shared with scene illustrations). Each finished shot is
 * persisted into settings.recap so the UI can poll GET …/recap for progress.
 * Never throws: shot-level failures are recorded on the shot itself.
 */
async function renderRecapShots(convId: number): Promise<void> {
  const conv = getConversation(convId);
  if (!conv) return;
  const { recap } = recapOf(conv);
  if (!recap || !Array.isArray(recap.shots)) return;
  if (!recap.shots.some((s) => s.status !== "done")) return;
  const steps = Number(getSetting("image_steps", 28));
  const cfg = Number(getSetting("image_cfg", 7));
  let i = 0;
  for (const shot of recap.shots) {
    const idx = i++;
    if (shot.status === "done") continue;
    shot.status = "pending"; // (re)queued — also covers the retry endpoint
    try {
      const res = await generateAndSave(`conversations/${convId}`, {
        prompt: `masterpiece, best quality, anime illustration, highly detailed, vibrant colors, ${shot.prompt.trim()}`,
        negative: NEGATIVE_PROMPT,
        steps, cfg,
        width: 1152, height: 768, // storyboard shots are landscape
        seed: recapShotSeed(convId, idx),
      });
      shot.image = res.url;
      shot.seed = res.seed;
      shot.status = "done";
      delete shot.error;
      console.log(`[recap] 🎨 shot ${idx + 1}/${recap.shots.length} (#${convId}) ok`);
    } catch (e) {
      shot.status = "error";
      shot.error = String(e?.message ?? e).slice(0, 200);
      console.warn(`[recap] shot ${idx + 1}/${recap.shots.length} (#${convId}) échec: ${shot.error}`);
    }
    // persist — but only if the recap hasn't been replaced meanwhile
    const cur = getConversation(convId);
    if (!cur) return; // conversation deleted mid-render
    const curR = recapOf(cur);
    if (curR.recap && curR.recap.at === recap.at && Array.isArray(curR.recap.shots) && curR.recap.shots[idx]) {
      Object.assign(curR.recap.shots[idx], shot);
      curR.cs.recap = curR.recap;
      updateConversation(convId, { settings: JSON.stringify(curR.cs) });
    }
  }
}

async function suggestNpcs(conv: ConversationRow, msgs: MessageRow[]): Promise<NpcSuggestion[]> {
  let castNames: string[] = [];
  try { castNames = (JSON.parse(conv.cast || "[]") as number[]).map((id) => getCard(Number(id))?.name ?? "").filter(Boolean); } catch { /* ignore */ }
  const sys = [
    "Tu suis une partie de roleplay et repères les personnages secondaires qui émergent de la fiction.",
    `Personnages déjà en carte (à ignorer) : ${castNames.join(", ") || "aucun"}.`,
    "Ne propose QUE des personnages réellement évoqués par les derniers échanges (un tavernier, une garde, un rival…), jamais le narrateur ni le joueur.",
    `Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format : ${NPC_FMT}. 0 à 3 entrées. Noms propres, descriptions neutres et concrètes. JSON complet, non tronqué.`,
  ].join(" ");
  const p = await llmJson(transcriptFor(msgs, 24), sys, 900, 0.8);
  const list = Array.isArray(p?.npcs) ? p.npcs : [];
  const norm = (s: string) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const taken = new Set(castNames.map(norm));
  return list
    .map((x: any) => ({
      name: String(x?.name ?? "").trim().slice(0, 80),
      description: String(x?.description ?? "").trim().slice(0, 1500),
      personality: String(x?.personality ?? "").trim().slice(0, 1200),
      role: String(x?.role ?? "").trim().slice(0, 400),
    }))
    .filter((n) => n.name && n.description && !taken.has(norm(n.name)))
    .slice(0, 3);
}

// ─── quest journal ────────────────────────────────────────────────────────────
// The model reads the conversation and extracts the player's concrete
// objectives (0-5). Stored in conv.settings.quests — purely a UI aid, never
// injected in the prompt (the player may fake or reorder them).
type Quest = { title: string; status: "active" | "done" | "dropped"; notes?: string };

async function generateQuests(title: string, messages: MessageRow[]): Promise<Quest[]> {
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
  const sys = [
    `Tu suis la partie de roleplay « ${title.slice(0, 60)} » comme maître de jeu.`,
    "À partir du fil de la partie, identifie les objectifs concrets du joueur, en cours ou récemment terminés/abandonnés (0 à 5 éléments).",
    "Une quête = un objectif concret : retrouver quelqu'un, récupérer un objet, résoudre un mystère, échapper à une menace, gagner une bataille…",
    'Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format : {"quests":[{"title":"titre court","status":"active|done|dropped","notes":"une phrase de contexte"}]}.',
    "Ne recopie pas les répliques ; titre court et nominal ; notes en une phrase. Tout en français. JSON complet, non tronqué.",
  ].join(" ");
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

/** Extract + parse the first balanced JSON object — robust to prose around it,
 * braces inside strings and raw newlines in string values (models cheat). */
function parseCardAssistJson(text: string): Record<string, unknown> | null {
  const raw = String(text).replace(/```[a-zA-Z]*\n?/g, "");
  try {
    // fast path: whole text is valid JSON
    return JSON.parse(raw);
  } catch { /* fall through */ }
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
        try { return JSON.parse(block); } catch { /* try lenient below */ }
        try {
          // sanitize: collapse raw newlines inside string values, drop trailing commas
          const cleaned = block.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (m, inner) => '"' + inner.replace(/[\r\n\t]+/g, " ") + '"').replace(/,([\s]*[}\]])/g, "$1");
          return JSON.parse(cleaned);
        } catch { /* not JSON */ }
        return null;
      }
    }
  }
  return null;
}

// ─── context window management ────────────────────────────────────────────────
// Keep only the last N messages for the model; older messages are compressed
// into a rolling summary (updated in the background by the LLM itself).
const SUMMARY_PREFIX = "(Session antérieure résumée)\n";

function summarizeOverflow(convId: number, conv: ConversationRow, newMsgs: MessageRow[]): void {
  let cs: Record<string, unknown> = {};
  try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
  const provider = getProvider((cs.provider as string) || undefined);
  const model = (cs.model as string) || defaultModelFor(provider.id);
  const oldMem = parseMemory(conv.memory_json);
  const oldText = !oldMem && conv.summary && !conv.summary.startsWith(SUMMARY_PREFIX) ? conv.summary : "";
  const chat: ChatMessage[] = [
    { role: "system", content: summarizeSystem() },
    ...(oldMem
      ? [{ role: "user", content: `Mémoire structurée actuelle à compléter (garde ce qui reste vrai) :\n${JSON.stringify(oldMem)}` }]
      : oldText
        ? [{ role: "user", content: `Résumé actuel à compléter :\n${oldText}` }]
        : []),
    ...newMsgs.slice(-30).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content.slice(0, 1500) })),
  ];
  const job = createJob({ type: "summary", status: "running", progress: 0, conversation_id: convId, payload: JSON.stringify({ messages: newMsgs.length }) });
  provider
    .complete({ messages: chat, model, temperature: 0.4, maxTokens: 400, noThinking: true, signal: AbortSignal.timeout(90_000) })
    .then((text) => {
      const raw = (text || "").trim();
      if (!raw) return;
      const lastId = newMsgs[newMsgs.length - 1]?.id ?? 0;
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
      updateJob(job.id, { status: "done", progress: 100, completed_at: Date.now() });
    })
    .catch((e) => {
      updateJob(job.id, { status: "failed", error: String(e?.message ?? e).slice(0, 300), completed_at: Date.now() });
      console.error("[summary] failed:", String(e?.message ?? e).slice(0, 200));
    });
}

function applyContextWindow(
  convId: number,
  conv: ConversationRow,
  history: MessageRow[],
): { kept: MessageRow[]; summary?: string; memory?: MemoryState } {
  let cs: Record<string, unknown> = {};
  try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
  // per-world cap acts as a hard ceiling over the conversation's own value,
  // so a world with a small model can protect every party in it
  let maxMsgs = Number(cs.context_max_messages ?? getSetting("context_max_messages", 20));
  const world = conv.world_id ? getWorld(conv.world_id) : null;
  if (world) {
    let ws: Record<string, unknown> = {};
    try { ws = JSON.parse(world.settings || "{}"); } catch { /* ignore */ }
    const worldCap = Number(ws.context_max_messages ?? getSetting("world_context_max_messages", 0));
    if (worldCap > 0) maxMsgs = Math.min(maxMsgs, worldCap);
  }
  const memory = parseMemory(conv.memory_json) || undefined;
  if (history.length <= maxMsgs) return { kept: history, summary: conv.summary || undefined, memory };
  const kept = history.slice(-maxMsgs);
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
async function validateNarrative(convId: number): Promise<{ findings: any[] } | null> {
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
  const sys = [
    "Tu es un correcteur de cohérence pour une partie de roleplay.",
    "Relis le fil et détecte les incohérences : personnage mort qui réapparaît, objet utilisé avant d'être obtenu, lieu contradictoire, changement de nom, violation du point de vue, joueur contrôlé par l'IA.",
    'Réponds avec un JSON strict : {"findings":[{"severity":"info|warning|critical","message":"l\'incohérence en une phrase","suggestion":"correction proposée"}]} — tableau vide si tout est cohérent.',
    "Ne signale pas deux fois la même chose et ne sois pas tatillon : uniquement les vrais problèmes.",
  ].join(" ");
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
async function generateSceneState(convId: number): Promise<Record<string, unknown> | null> {
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
  const sys = [
    "Tu es un outil d'analyse de partie de roleplay.",
    "À partir du fil récent, produis un état de scène concis au format JSON strict, sans aucun texte autour :",
    '{"location":"lieu actuel si identifiable, sinon vide","characters":["personnages présents"],"goals":["objectifs du joueur en cours"],"dangers":["menaces en cours"],"secrets":["secrets que le joueur a déjà découverts"],"notes":"une phrase de contexte"}',
    "N'invente rien : ne mentionne que ce qui est visible dans le fil.",
  ].join(" ");
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
async function proposeTimelineEvents(worldId: number): Promise<{ proposals: any[] } | null> {
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
  const sys = [
    "Tu es un outil d'analyse de partie de roleplay. À partir des échanges récents d'une campagne, repère les ÉVÉNEMENTS MAJEURS à retenir pour la chronologie du monde : arrivées, rencontres marquantes, pactes, batailles, objets obtenus, révélations, choix importants.",
    "Ignore les échanges anodins. Maximum 6 événements, un seul par événement marquant.",
    "Réponds UNIQUEMENT par un tableau JSON, sans aucun texte autour :",
    `[{"label": "Jour 1 — Arrivée à Eldoria", "message": "extrait très court (moins de 120 caractères) tiré du fil justifiant l'événement"}]`,
    "Le label commence par « Jour N — » en respectant l'ordre chronologique apparent.",
  ].join(" ");
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

async function generateSuggestions(ctx: CastContext, history: MessageRow[]): Promise<string[]> {
  // same context policy as the main stream
  const { kept, summary, memory } = applyContextWindow(ctx.conversation.id, ctx.conversation, history);
  ctx = { ...ctx, summary, memory };
  let cs: Record<string, unknown> = {};
  try { cs = JSON.parse(ctx.conversation.settings || "{}"); } catch { /* ignore */ }
  const provider = getProvider((cs.provider as string) || undefined);
  const model = (cs.model as string) || defaultModelFor(provider.id);
  const messages: ChatMessage[] = [
    { role: "system", content: suggestSystem(ctx) },
    ...kept.slice(-10).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content })),
    { role: "user", content: "Propose tes suggestions de réponses pour le joueur." },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await provider
      .complete({ messages, model, temperature: 1.1, maxTokens: 512, noThinking: true, signal: AbortSignal.timeout(90_000) })
      .catch((e) => {
        console.error("[sugg] complete failed:", String(e?.message ?? e).slice(0, 200));
        return "";
      });
    const sugg = parseSuggestions(text);
    if (sugg.length >= 3) return sugg;
  }
  return [];
}

async function handleStream(req: Request, convId: number): Promise<Response> {
  const body = await readJson(req);
  const conv = getConversation(convId);
  if (!conv) return json({ error: "conversation not found" }, 404);
  const view = conversationView(convId)!;
  const world = view.world;
  const persona = view.persona;
  const cards = view.cards;
  const scenario = view.scenario;

  const userText = (body.content ?? "").trim();
  const modelText = (body.prompt ?? body.content ?? "").trim(); // slash commands rewrite the model input
  const directive = (body.directive ?? "").trim();
  if (!userText && !directive) return json({ error: "message vide" }, 400);
  // keep the model-facing input on the user message so "Régénérer" can replay
  // it exactly (slash commands and directives rewrite the raw content)
  const userMeta: Record<string, string> = {};
  if (modelText && modelText !== userText) userMeta.prompt = modelText;
  if (directive) userMeta.directive = directive;
  const userMsg = createMessage({
    conversation_id: convId, role: "user",
    name: persona?.name ?? "Moi", content: userText || directive.slice(0, 120),
    meta: JSON.stringify(userMeta),
  });

  // messages present before this exchange (used for the auto-title heuristic)
  const historyBefore = listMessages(convId).filter((m) => m.id !== userMsg.id);
  // history + new user message
  const history = listMessages(convId);
  // context window: keep recent messages, compress the rest into a rolling summary
  const { kept, summary, memory } = applyContextWindow(convId, conv, history.filter((m) => m.id !== userMsg.id));
  const { system, messages } = buildMessages({ world, persona, cards, scenario, conversation: conv, summary, memory }, kept);
  messages.push({ role: "user", content: modelText || directive });
  // interpellation directive (e.g. "ask the narrator / a character to speak")
  if (directive) messages[messages.length - 1].content += `\n\n[Directive : ${directive}]`;

  const settings = JSON.parse(conv.settings || "{}");
  const preset = presetFromKey(settings.preset);
  const provider = getProvider((settings.provider as string) || undefined);
  const model = (settings.model as string) || defaultModelFor(provider.id);
  const temperature = Number(settings.temperature ?? preset?.temperature ?? getSetting("temperature", 0.9));
  const maxTokens = Number(settings.max_tokens ?? preset?.maxTokens ?? getSetting("max_tokens", 2048));

  // server-side trace of every generation (see the console while playing)
  const genLabel = (userText || directive || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const genStart = Date.now();
  console.log(`\n[chat] ▶  Génération lancée — partie #${convId} « ${conv.title || "sans titre"} »`);
  console.log(`[chat]    message : ${genLabel || "(directive)"}`);
  console.log(`[chat]    modèle : ${provider.id} / ${model || "défaut"} · temp ${temperature} · max ${maxTokens} tokens`);

  // hard timeout: a stuck model must not leave the UI on "…" forever
  const timeoutSec = Math.max(20, Number(getSetting("llm_timeout", 150)));
  const llmAbort = new AbortController();
  const llmTimer = setTimeout(() => llmAbort.abort(), timeoutSec * 1000);
  let clientStopped = false;
  let assistantCreated = false;

  return sseStream(
    async (send, close) => {
    let full = "";
    try {
      // transient failures (LM Studio loading a model, network blips) are
      // retried with backoff before surfacing an error
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          for await (const delta of provider.stream({
            messages: [{ role: "system", content: system }, ...messages],
            model,
            temperature,
            maxTokens,
            noThinking: true,
            signal: llmAbort.signal,
          })) {
            full += delta;
            send("delta", { text: delta });
          }
          break; // stream finished
        } catch (e: any) {
          const aborted = e?.name === "AbortError" || e?.name === "TimeoutError" || /abort/i.test(String(e));
          if (aborted || attempt >= MAX_ATTEMPTS) throw e;
          const wait = 500 * attempt * attempt;
          send("retry", { attempt, message: `Connexion au modèle instable — nouvelle tentative (${attempt}/${MAX_ATTEMPTS})…` });
          await new Promise((r) => setTimeout(r, wait));
          if (clientStopped) throw e;
        }
      }
      clearTimeout(llmTimer);
      const genSecs = ((Date.now() - genStart) / 1000).toFixed(1);
      console.log(`[chat] ✔  Réponse générée en ${genSecs}s — ${full.trim().length} caractères, ${Math.max(1, Math.round(estimateTokens(full) / 100) * 100)} tokens ≈`);
      if (!full.trim()) {
        // try to get the model list for a nicer error
        const models = await provider.models().catch(() => []);
        const hint = models.length ? ` Modèles détectés : ${models.slice(0, 5).join(", ")}` : "";
        send("error", { message: `Le modèle "${model}" n'a rien renvoyé.${hint}` });
        close();
        return;
      }
      const assistant = createMessage({
        conversation_id: convId, role: "assistant",
        name: cards[0]?.name ?? "Narrateur", content: full.trim(),
      });
      assistantCreated = true;
      const segments = parseSegmentsFor(conv, full);
      updateMessage(assistant.id, { segments: JSON.stringify(segments) });
      touchConversation(convId);
      const firstLine = full.trim().split("\n")[0]?.slice(0, 60) ?? "";
      // fresh conversation (only the opening message so far) → name it from the
      // first reply; keep manual titles
      if (historyBefore.length <= 1 && conv.title === "Nouvelle partie") {
        updateConversation(convId, { title: firstLine || "Partie" });
      }
      // dashboard preview = the latest exchange
      updateConversation(convId, { last_message: full.trim().slice(0, 200) });
      // game-master directives apply to THIS turn only — clear the pending flag
      if (settings.dm) {
        updateConversation(convId, { settings: JSON.stringify({ ...settings, dm_pending: false }) });
      }
      send("done", { message: messageView(assistant) });
      console.log(`[chat] 📨  Réponse #${assistant.id} envoyée au client — suggestions en arrière-plan…`);
      // suggestions run in the background — the local model accepts concurrent
      // requests
      const suggPromise = generateSuggestions(
        { world, persona, cards, scenario, conversation: conv },
        listMessages(convId),
      );
      const sugg = await suggPromise;
      if (sugg.length) {
        const m2 = getMessage(assistant.id)!;
        updateMessage(assistant.id, { meta: JSON.stringify({ ...JSON.parse(m2.meta || "{}"), suggestions: sugg }) });
        send("suggestions", { messageId: assistant.id, suggestions: sugg });
      }
      close();
    } catch (e: any) {
      const aborted = e?.name === "AbortError" || e?.name === "TimeoutError" || /abort/i.test(String(e));
      if (assistantCreated) {
        // the reply was already committed — a post-done failure (suggestions on
        // a stream the client already closed) must NOT remove the user turn
        try {
          send("error", { message: String(e?.message ?? e) });
        } catch { /* stream already closed */ }
      } else if (aborted && clientStopped) {
        // user pressed Stop: commit whatever the model already wrote, then
        // drop the orphan user turn only if nothing was produced
        if (full.trim()) {
          const partial = createMessage({
            conversation_id: convId, role: "assistant",
            name: cards[0]?.name ?? "Narrateur", content: full.trim(),
          });
          const segs = parseSegmentsFor(conv, full);
          updateMessage(partial.id, { segments: JSON.stringify(segs) });
          touchConversation(convId);
          updateConversation(convId, { last_message: full.trim().slice(0, 200) });
        } else {
          deleteMessage(userMsg.id);
        }
      } else {
        console.log(`[chat] ✖  Échec après ${((Date.now() - genStart) / 1000).toFixed(1)}s — ${String(e?.message ?? e).slice(0, 160)}`);
        send("error", {
          message: aborted
            ? `Le modèle n'a pas répondu dans le délai de ${timeoutSec} s (il est peut-être en train de charger). Réessaie, ou augmente le timeout dans les réglages.`
            : String(e?.message ?? e),
        });
        // remove the user message on failure so the user can retry cleanly
        deleteMessage(userMsg.id);
      }
      close();
    } finally {
      clearTimeout(llmTimer);
    }
  },
    () => {
      // client disconnected (Stop / tab closed): stop the model generation and
      // clean up the pending exchange
      clientStopped = true;
      llmAbort.abort();
    },
  );
}