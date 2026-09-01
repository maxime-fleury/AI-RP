/**
 * API router: worlds, scenarios, cards, personas, conversations, chat
 * streaming (SSE), TTS, images and settings.
 */
import fs from "node:fs";
import path from "node:path";
import {
  allSettings, setSetting, getSetting, listWorlds, getWorld, createWorld, updateWorld, deleteWorld,
  listScenarios, getScenario, createScenario, updateScenario, deleteScenario,
  listCards, getCard, createCard, updateCard, deleteCard,
  listPersonas, getPersona, createPersona, updatePersona, deletePersona,
  listConversations, getConversation, createConversation, updateConversation, deleteConversation,
  listMessages, getMessage, createMessage, updateMessage, deleteMessage, touchConversation,
  lastMessageOf,
} from "./db";
import { importFile, scanDirectory } from "./importCards";
import { getProvider, defaultModelFor, type ChatMessage } from "../llm/providers";
import { buildMessages, buildSystemPrompt, estimateTokens, parseSegments, fallbackSpeaker, summarizeSystem, type Segment, type CastContext } from "../llm/prompt";
import type { MessageRow } from "./db";
import { synthSegments, buildTtsContext, listVoices, warmupTts, getVoiceSample } from "../tts/service";
import { ensureTtsLoaded, synthesize, wavBytes } from "../tts/engine";
import { generateAndSave, probeImageStatus, ensureImageServer } from "./image";
import { storageInfo, runBackup } from "./backup";
import { zipFiles } from "./zip";
import { AUDIO_DIR, IMAGES_DIR, UPLOADS_DIR } from "./paths";
import { withCharaChunk, placeholderPng } from "./cardExport";

const preparingAudio = new Set<number>();

// ─── helpers ──────────────────────────────────────────────────────────────────
async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("JSON invalide");
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
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
  return { ...conv, world, persona, scenario, cards };
}

function messageView(m: any) {
  try { m.segments = JSON.parse(m.segments || "[]"); } catch { m.segments = []; }
  try { m.audio = JSON.parse(m.audio || "[]"); } catch { m.audio = []; }
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
    if (method === "GET" && p === "/api/health") {
      return json({
        ok: true,
        tts: { fr: await ensureTtsLoaded("fr").catch(() => false), en: await ensureTtsLoaded("en").catch(() => false) },
        image: await probeImageStatus(),
      });
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
    if (p === "/api/backup" && method === "POST") {
      const file = runBackup(true);
      return json({ ok: Boolean(file), file });
    }

    // settings
    if (p === "/api/settings" && method === "GET") {
      return json(allSettings());
    }
    if (p === "/api/settings" && method === "PATCH") {
      const body = await readJson(req);
      for (const [k, v] of Object.entries(body)) setSetting(k, v);
      return json(allSettings());
    }
    if (p === "/api/voices" && method === "GET") {
      return json({ voices: listVoices() });
    }
    // generate (and cache) a short preview clip for a voice; first call is slow
    if (p === "/api/voices/sample" && method === "GET") {
      const name = (url.searchParams.get("name") || "").trim();
      const lang = (url.searchParams.get("lang") === "en" ? "en" : "fr") as "fr" | "en";
      if (!name) return json({ error: "name required" }, 400);
      const pathUrl = await getVoiceSample(name, lang);
      return json({ path: pathUrl });
    }
    if (p === "/api/tts/warmup" && method === "POST") {
      await warmupTts();
      return json({ ok: true });
    }
    // warm up the Python image sidecar (optional, first generation is slow)
    if (p === "/api/images/preload" && method === "POST") {
      const ok = await ensureImageServer();
      return json({ ok });
    }
    if (p === "/api/tts/test" && method === "POST") {
      const body = await readJson(req);
      const lang = body.lang === "en" ? "en" : "fr";
      await ensureTtsLoaded(lang);
      const res = await synthesize({
        text: body.text || "Bonjour, je suis une voix de test pour cette aventure.",
        voice: body.voice || "jean",
        lang,
        lsdSteps: Number(body.lsdSteps ?? getSetting("tts_lsd_steps", 4)),
      });
      const file = path.join(AUDIO_DIR, `test-${Date.now()}.wav`);
      fs.writeFileSync(file, wavBytes(res.pcm, res.sampleRate));
      return json({ url: `/audio/${path.basename(file)}`, durationMs: res.durationMs, voice: body.voice, lang });
    }

    // import cards
    if (p === "/api/import" && method === "POST") {
      const ct = req.headers.get("content-type") || "";
      const imported: any[] = [];
      if (ct.includes("multipart/form-data")) {
        const form = await req.formData();
        const files = form.getAll("files");
        for (const f of files) {
          if (typeof f === "string") continue;
          const bytes = new Uint8Array(await f.arrayBuffer());
          const card = importFile(f.name, bytes);
          if (card) imported.push(messageView(card));
        }
      } else {
        const body = await readJson(req);
        const files: { name: string; base64: string }[] = body.files ?? [];
        for (const f of files) {
          const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
          const card = importFile(f.name, bytes);
          if (card) imported.push(messageView(card));
        }
      }
      return json({ imported });
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
      deleteWorld(Number(parts[2]));
      return json({ ok: true });
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
      const s = createScenario({ world_id: world.id, name: customName ?? name, intro });
      return json(s, 201);
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
      return json({ ok: true });
    }
    // regenerate the intro of an existing scenario (genre-aware)
    if (parts[1] === "scenarios" && parts[2] && parts[3] === "generate" && method === "POST") {
      const body = await readJson(req);
      const scenario = getScenario(Number(parts[2]));
      if (!scenario) return json({ error: "not found" }, 404);
      const world = getWorld(scenario.world_id);
      const theme = body.theme || scenario.name || "un nouveau départ";
      const { intro } = await generateScenarioIntro(world, body.genre, theme);
      updateScenario(scenario.id, { intro });
      return json(updateScenario(scenario.id, { intro }));
    }

    // cards
    if (p === "/api/cards" && method === "GET") {
      return json({ cards: listCards().map(messageView) });
    }
    if (p === "/api/cards" && method === "POST") {
      const body = await readJson(req);
      return json(createCard(body), 201);
    }
    if (parts[1] === "cards" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      return json(updateCard(Number(parts[2]), body));
    }
    if (parts[1] === "cards" && parts[2] && !parts[3] && method === "DELETE") {
      deleteCard(Number(parts[2]));
      return json({ ok: true });
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
          creator: "Freebuff AI-RP",
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
      return json({ ok: true });
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
      const scenario = conv.scenario_id ? getScenario(conv.scenario_id) : null;
      const cards = (JSON.parse(conv.cast) as number[]).map((id) => getCard(Number(id))).filter(Boolean) as any[];
      let opening: MessageRow | null = null;
      if (scenario?.intro) {
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
      let cs: Record<string, unknown> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      const ttsOn = Boolean(cs.tts_enabled ?? getSetting("tts_enabled", true));
      if (opening?.id && ttsOn) {
        const ctx = buildTtsContext(conv);
        const segs = parseSegmentsFor(conv, opening.content);
        if (segs.length) {
          synthSegments(conv.id, opening.id, segs, ctx).then((audio) => {
            if (audio.length) updateMessage(opening.id, { audio: JSON.stringify(audio) });
          }).catch(() => {});
        }
      }
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
      updateConversation(Number(parts[2]), {
        title: body.title,
        group_mode: body.group_mode === undefined ? undefined : body.group_mode ? 1 : 0,
        pinned: body.pinned === undefined ? undefined : body.pinned ? 1 : 0,
        archived: body.archived === undefined ? undefined : body.archived ? 1 : 0,
        cast: body.cast ? JSON.stringify(body.cast) : undefined,
        settings: body.settings ? JSON.stringify(body.settings) : undefined,
      });
      return json(conversationView(Number(parts[2])));
    }
    if (parts[1] === "conversations" && parts[2] && !parts[3] && method === "DELETE") {
      // soft delete: move to the trash (archived=1); restore via PATCH archived:0
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      updateConversation(conv.id, { archived: 1 });
      return json({ ok: true, archived: true });
    }
    // permanent delete (trash screen) — drops rows + audio + images
    if (parts[1] === "conversations" && parts[2] && parts[3] === "permanent" && method === "DELETE") {
      const convId = Number(parts[2]);
      deleteConversation(convId);
      for (const dir of [path.join(AUDIO_DIR, String(convId)), path.join(IMAGES_DIR, "conversations", String(convId))]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      return json({ ok: true });
    }
    // fork a conversation up to a message — branching: regenerate in a copy,
    // the original stays intact (audio + images are copied with remapped ids)
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
      });
      const audioSrcDir = path.join(AUDIO_DIR, String(src.id));
      const audioDstDir = path.join(AUDIO_DIR, String(fork.id));
      const imgSrcDir = path.join(IMAGES_DIR, "conversations", String(src.id));
      const imgDstDir = path.join(IMAGES_DIR, "conversations", String(fork.id));
      for (const m of srcMsgs) {
        const view = messageView({ ...m });
        const audio = view.audio as any[];
        const meta = view.meta as any;
        const newMid = createMessage({
          conversation_id: fork.id, role: m.role, name: m.name, content: m.content,
          segments: m.segments, audio: "[]", meta: "{}",
        }).id;
        // copy each real wav with a remapped filename (old mid → new mid)
        const segMap = new Map<string, string>();
        const newAudio = audio.map((a: any) => {
          if (!a.path) return a;
          const file = path.basename(a.path);
          let dest = segMap.get(file);
          if (!dest) {
            dest = `${newMid}-${file.split("-").slice(1).join("-")}`;
            const srcFile = path.join(audioSrcDir, file);
            if (fs.existsSync(srcFile)) {
              fs.mkdirSync(audioDstDir, { recursive: true });
              fs.copyFileSync(srcFile, path.join(audioDstDir, dest));
            }
            segMap.set(file, dest);
          }
          return { ...a, path: `/audio/${fork.id}/${dest}` };
        });
        updateMessage(newMid, { audio: JSON.stringify(newAudio) });
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
    // estimate the tokens the model would receive for this conversation
    if (parts[1] === "conversations" && parts[2] && parts[3] === "context" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const view = conversationView(conv.id)!;
      const msgs = listMessages(conv.id);
      const { system, messages } = buildMessages(
        { world: view.world, persona: view.persona, cards: view.cards, scenario: view.scenario, conversation: conv, summary: conv.summary || undefined },
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
    // full export of a conversation: markdown + JSON + audio + images, as a ZIP
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
      const audioDir = path.join(AUDIO_DIR, String(conv.id));
      const imgDir = path.join(IMAGES_DIR, "conversations", String(conv.id));
      const seenAudio = new Set<string>();
      const seenImg = new Set<string>();
      for (const m of msgs as any[]) {
        for (const a of m.audio || []) {
          if (!a.path || seenAudio.has(a.path)) continue;
          seenAudio.add(a.path);
          const full = path.join(audioDir, path.basename(a.path));
          if (fs.existsSync(full)) files.push({ path: `audio/${m.id}-${path.basename(a.path)}`, data: new Uint8Array(fs.readFileSync(full)) });
        }
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
    // gallery: all illustrations of a conversation + AI captions
    if (parts[1] === "conversations" && parts[2] && parts[3] === "gallery" && method === "GET") {
      const convId = Number(parts[2]);
      const conv = getConversation(convId);
      if (!conv) return json({ error: "not found" }, 404);
      const msgs = listMessages(convId).map(messageView);
      const items = msgs.filter((m: any) => m.meta?.image).map((m: any) => ({
        id: m.id, image: m.meta.image, seed: m.meta.seed ?? null,
        character: m.meta.character ?? null, message: (m.content || "").slice(0, 200),
      }));
      let captions: Record<string, string> = {};
      try {
        captions = JSON.parse(fs.readFileSync(path.join(IMAGES_DIR, "conversations", String(convId), "captions.json"), "utf8"));
      } catch { /* none yet */ }
      return json({ items, captions });
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
        return json({ captions: existing, error: `Le modèle n'a pas pu écrire les légendes : ${e?.message ?? e}` });
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
      return json({ captions: existing });
    }
    // edit a message's content (double-click in the UI)
    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && !parts[5] && method === "PATCH") {
      const convId = Number(parts[2]);
      const mid = Number(parts[4]);
      const body = await readJson(req);
      const m = getMessage(mid);
      const conv = getConversation(convId);
      if (!conv || !m) return json({ error: "not found" }, 404);
      if (typeof body.content !== "string" || !body.content.trim()) {
        return json({ error: "contenu vide" }, 400);
      }
      const content = body.content.trim();
      const updates: Record<string, string> = { content };
      if (m.role === "assistant") {
        updates.segments = JSON.stringify(parseSegmentsFor(conv, content));
      }
      // content changed → the old audio + response suggestions no longer match
      updates.audio = "[]";
      const meta = JSON.parse(m.meta || "{}");
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
        // also drop the synthesized audio files from disk
        try {
          const dir = path.join(AUDIO_DIR, String(convId));
          for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(`${m.id}-`) && f.endsWith(".wav")) fs.rmSync(path.join(dir, f), { force: true });
          }
        } catch { /* no audio dir */ }
        deleteMessage(m.id);
      }
      const last = lastMessageOf(convId);
      updateConversation(convId, { last_message: last?.content ?? "" });
      return json({ ok: true });
    }
    // emoji reactions on a message (kept in meta.reactions)
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
    // TTS for a conversation (all missing segments) or one message
    if (parts[1] === "conversations" && parts[2] && parts[3] === "tts" && method === "POST") {
      const convId = Number(parts[2]);
      const conv = getConversation(convId);
      if (!conv) return json({ error: "not found" }, 404);
      let cs: Record<string, unknown> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      const ttsEnabled = Boolean(cs.tts_enabled ?? getSetting("tts_enabled", true));
      if (!ttsEnabled) return json({ error: "TTS désactivé" }, 400);
      const ctx = buildTtsContext(conv);
      const results: Record<number, any[]> = {};
      for (const m of listMessages(convId)) {
        if (m.role === "user") continue;
        const segs = parseSegmentsFor(conv, m.content);
        if (!segs.length) continue;
        const existing = messageView(m).audio;
        const audio = await synthSegments(convId, m.id, segs, ctx, existing);
        updateMessage(m.id, { audio: JSON.stringify(audio) });
        results[m.id] = audio;
      }
      return json({ audio: results });
    }
    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && parts[5] === "tts" && method === "POST") {
      const convId = Number(parts[2]);
      const mid = Number(parts[4]);
      const conv = getConversation(convId);
      const m = getMessage(mid);
      if (!conv || !m) return json({ error: "not found" }, 404);
      const ctx = buildTtsContext(conv);
      const segs = parseSegmentsFor(conv, m.content);
      const audio = await synthSegments(convId, mid, segs, ctx, messageView(m).audio, { forceAll: true });
      updateMessage(mid, { audio: JSON.stringify(audio) });
      return json({ audio });
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
      const prompt = buildIllustrationPrompt(world?.name ?? "", world?.description ?? "", world?.tone ?? "épique", m.content, kind, char);
      const seed =
        typeof body.seed === "number" ? body.seed
        : body.vary ? undefined
        : char ? charSeed(char.id)
        : undefined;
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
      const res = await generateAndSave(`conversations/${convId}`, {
        prompt,
        negative: NEGATIVE_PROMPT,
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

    // pre-generate missing TTS audio for the recent assistant messages
    if (parts[1] === "conversations" && parts[2] && parts[3] === "prepare-audio" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      if (preparingAudio.has(conv.id)) return json({ busy: true, generated: 0, remaining: 0 });
      preparingAudio.add(conv.id);
      try {
        const msgs = listMessages(conv.id).filter((m) => {
          if (m.role !== "assistant") return false;
          try { return (JSON.parse(m.audio || "[]") as unknown[]).length === 0; } catch { return true; }
        });
        const recent = msgs.slice(-8);
        const ctx = buildTtsContext(conv);
        let generated = 0;
        for (const m of recent) {
          const segs = parseSegmentsFor(conv, m.content);
          if (!segs.length) continue;
          const audio = await synthSegments(conv.id, m.id, segs, ctx);
          if (audio.length) {
            updateMessage(m.id, { audio: JSON.stringify(audio) });
            generated++;
          }
        }
        return json({ generated, remaining: Math.max(0, msgs.length - recent.length) });
      } finally {
        preparingAudio.delete(conv.id);
      }
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
        app: "ai-rp",
        version: 1,
        exported_at: new Date().toISOString(),
        worlds: listWorlds(),
        scenarios: listScenarios(),
        cards: listCards(),
        personas: listPersonas(),
        conversations,
      });
    }
    // restore a backup (creates fresh rows, remaps foreign keys)
    if (p === "/api/backup" && method === "POST") {
      const body = await readJson(req);
      const b = body.backup ?? body;
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
        for (const m of c.messages ?? []) {
          createMessage({
            conversation_id: conv.id, role: m.role ?? "assistant", name: m.name ?? "",
            content: m.content ?? "", segments: JSON.stringify(m.segments ?? "[]"),
            audio: "[]", meta: JSON.stringify(m.meta ?? {}),
          });
        }
        conversations++;
      }
      return json({
        ok: true,
        worlds: (b.worlds ?? []).length, scenarios: (b.scenarios ?? []).length,
        cards: (b.cards ?? []).length, personas: (b.personas ?? []).length, conversations,
      });
    }

    return json({ error: "Not found" }, 404);
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
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

// ─── context window management ────────────────────────────────────────────────
// Keep only the last N messages for the model; older messages are compressed
// into a rolling summary (updated in the background by the LLM itself).
const SUMMARY_PREFIX = "(Session antérieure résumée)\n";

function summarizeOverflow(convId: number, conv: ConversationRow, newMsgs: MessageRow[]): void {
  let cs: Record<string, unknown> = {};
  try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
  const provider = getProvider((cs.provider as string) || undefined);
  const model = (cs.model as string) || defaultModelFor(provider.id);
  const old = conv.summary && !conv.summary.startsWith(SUMMARY_PREFIX) ? conv.summary : "";
  const chat: ChatMessage[] = [
    { role: "system", content: summarizeSystem() },
    ...(old ? [{ role: "user", content: `Résumé actuel à compléter :\n${old}` }] : []),
    ...newMsgs.slice(-30).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content.slice(0, 1500) })),
  ];
  provider
    .complete({ messages: chat, model, temperature: 0.4, maxTokens: 400, noThinking: true, signal: AbortSignal.timeout(90_000) })
    .then((text) => {
      const summary = (text || "").trim();
      if (!summary) return;
      const merged = [SUMMARY_PREFIX, old ? `${old.trim()}\n` : "", summary].join("");
      const lastId = newMsgs[newMsgs.length - 1]?.id ?? 0;
      updateConversation(convId, { summary: merged, summary_msg_id: lastId });
    })
    .catch((e) => console.error("[summary] failed:", String(e?.message ?? e).slice(0, 200)));
}

function applyContextWindow(
  convId: number,
  conv: ConversationRow,
  history: MessageRow[],
): { kept: MessageRow[]; summary?: string } {
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
  if (history.length <= maxMsgs) return { kept: history, summary: conv.summary || undefined };
  const kept = history.slice(-maxMsgs);
  const firstKeptId = kept[0]?.id ?? 0;
  const overflow = history.filter((m) => m.id < firstKeptId);
  const newMsgs = overflow.filter((m) => m.id > (conv.summary_msg_id ?? 0));
  if (newMsgs.length) summarizeOverflow(convId, conv, newMsgs); // background, non-blocking
  return { kept, summary: conv.summary || undefined };
}

async function generateSuggestions(ctx: CastContext, history: MessageRow[]): Promise<string[]> {
  // same context policy as the main stream
  const { kept, summary } = applyContextWindow(ctx.conversation.id, ctx.conversation, history);
  ctx = { ...ctx, summary };
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
  const { kept, summary } = applyContextWindow(convId, conv, history.filter((m) => m.id !== userMsg.id));
  const { system, messages } = buildMessages({ world, persona, cards, scenario, conversation: conv, summary }, kept);
  messages.push({ role: "user", content: modelText || directive });
  // interpellation directive (e.g. "ask the narrator / a character to speak")
  if (directive) messages[messages.length - 1].content += `\n\n[Directive : ${directive}]`;

  const settings = JSON.parse(conv.settings || "{}");
  const provider = getProvider((settings.provider as string) || undefined);
  const model = (settings.model as string) || defaultModelFor(provider.id);
  const temperature = Number(settings.temperature ?? getSetting("temperature", 0.9));
  const maxTokens = Number(settings.max_tokens ?? getSetting("max_tokens", 2048));
  const ttsEnabled = Boolean(settings.tts_enabled ?? getSetting("tts_enabled", true));

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
      send("done", { message: messageView(assistant) });
      // suggestions run in parallel with the (slow) TTS synthesis — the local
      // model accepts concurrent requests
      const suggPromise = generateSuggestions(
        { world, persona, cards, scenario, conversation: conv },
        listMessages(convId),
      );
      if (ttsEnabled) {
        send("tts-status", { status: "generating" });
        const ctx = buildTtsContext(conv);
        // keep the SSE connection alive while the (slow) synthesis runs — Bun's
        // idleTimeout would otherwise kill the stream mid-synthesis
        const keepAlive = setInterval(() => send("keepalive", { t: Date.now() }), 25000);
        try {
          const audio = await synthSegments(convId, assistant.id, segments, ctx);
          updateMessage(assistant.id, { audio: JSON.stringify(audio) });
          send("tts-done", { messageId: assistant.id, audio });
        } finally {
          clearInterval(keepAlive);
        }
      }
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
        // the reply was already committed — a post-done failure (TTS synthesis
        // or suggestions on a stream the client already closed) must NOT
        // remove the user turn: the exchange is complete
        try {
          send("error", {
            message: aborted
              ? `La réponse est là mais l'audio n'a pas pu être généré (${timeoutSec} s).`
              : String(e?.message ?? e),
          });
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