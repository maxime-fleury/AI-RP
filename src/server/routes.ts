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
import { buildMessages, parseSegments, fallbackSpeaker, type Segment, type CastContext } from "../llm/prompt";
import type { MessageRow } from "./db";
import { synthSegments, buildTtsContext, listVoices, warmupTts, getVoiceSample } from "../tts/service";
import { ensureTtsLoaded, synthesize, wavBytes } from "../tts/engine";
import { generateAndSave, probeImageStatus, ensureImageServer } from "./image";
import { AUDIO_DIR, IMAGES_DIR } from "./paths";

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

function sseStream(onStart: (send: (event: string, data: unknown) => void, close: () => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      controller = null;
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
      const prompt = body.prompt || buildIllustrationPrompt(world.name, "", world.tone || "épique", sceneText || `${world.name}, fantasy landscape`);
      const cover = await generateAndSave(`worlds/${world.id}`, {
        prompt,
        negative: NEGATIVE_PROMPT,
        steps: Number(getSetting("image_steps", 28)),
        cfg: Number(getSetting("image_cfg", 7)),
        width: Number(getSetting("image_width", 768)),
        height: Number(getSetting("image_height", 1152)),
      });
      updateWorld(world.id, { cover });
      return json({ cover });
    }

    // scenarios
    if (parts[1] === "worlds" && parts[2] && parts[3] === "scenarios" && method === "GET") {
      return json({ scenarios: listScenarios(Number(parts[2])) });
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
    if (parts[1] === "scenarios" && parts[2] && parts[3] === "generate" && method === "POST") {
      const body = await readJson(req);
      const scenario = getScenario(Number(parts[3]));
      if (!scenario) return json({ error: "not found" }, 404);
      const world = getWorld(scenario.world_id);
      const theme = body.theme || scenario.name || "un nouveau départ";
      const provider = getProvider();
      let model = defaultModelFor(provider.id);
      if (!model) {
        const models = await provider.models();
        model = models[0] ?? "";
      }
      const sys = `Tu écris l'introduction d'un scénario de roleplay. Réponds en 120-220 mots, en français, à la deuxième personne ("tu"), immersif, sans métadonnées, sans titre.`;
      const promptText = `Monde : ${world?.name ?? "?"}\nUnivers : ${world?.lore || world?.description || "?"}\nThème du scénario : ${theme}\nÉcris l'ouverture de cette histoire.`;
      let intro = "";
      for await (const delta of provider.stream({
        messages: [{ role: "system", content: sys }, { role: "user", content: promptText }],
        model,
        temperature: 0.9,
        maxTokens: 600,
      })) {
        intro += delta;
      }
      updateScenario(scenario.id, { intro: intro.trim() });
      return json(updateScenario(scenario.id, { intro: intro.trim() }));
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
      const ttsOn = Boolean(getSetting("tts_enabled", true));
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
        cast: body.cast ? JSON.stringify(body.cast) : undefined,
        settings: body.settings ? JSON.stringify(body.settings) : undefined,
      });
      return json(conversationView(Number(parts[2])));
    }
    if (parts[1] === "conversations" && parts[2] && !parts[3] && method === "DELETE") {
      const convId = Number(parts[2]);
      deleteConversation(convId);
      // drop generated audio + images of this conversation
      for (const dir of [path.join(AUDIO_DIR, String(convId)), path.join(IMAGES_DIR, "conversations", String(convId))]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      return json({ ok: true });
    }
    // edit a message's content (double-click in the UI)
    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && method === "PATCH") {
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
    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && method === "DELETE") {
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
    // stream a chat turn
    if (parts[1] === "conversations" && parts[2] && parts[3] === "stream" && method === "POST") {
      return handleStream(req, Number(parts[2]));
    }
    // TTS for a conversation (all missing segments) or one message
    if (parts[1] === "conversations" && parts[2] && parts[3] === "tts" && method === "POST") {
      const convId = Number(parts[2]);
      const conv = getConversation(convId);
      if (!conv) return json({ error: "not found" }, 404);
      const ttsEnabled = getSetting("tts_enabled", true);
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
      const audio = await synthSegments(convId, mid, segs, ctx, messageView(m).audio);
      updateMessage(mid, { audio: JSON.stringify(audio) });
      return json({ audio });
    }
    // scene illustration for a message
    if (parts[1] === "conversations" && parts[2] && parts[3] === "messages" && parts[4] && parts[5] === "image" && method === "POST") {
      const convId = Number(parts[2]);
      const mid = Number(parts[4]);
      const conv = getConversation(convId);
      const m = getMessage(mid);
      if (!conv || !m) return json({ error: "not found" }, 404);
      const world = conv.world_id ? getWorld(conv.world_id) : null;
      const prompt = buildIllustrationPrompt(world?.name ?? "", world?.description ?? "", world?.tone ?? "épique", m.content);
      const url = await generateAndSave(`conversations/${convId}`, {
        prompt,
        negative: NEGATIVE_PROMPT,
        steps: Number(getSetting("image_steps", 28)),
        cfg: Number(getSetting("image_cfg", 7)),
        width: Number(getSetting("image_width", 768)),
        height: Number(getSetting("image_height", 1152)),
      });
      const meta = { ...messageView(m).meta, image: url };
      updateMessage(mid, { meta: JSON.stringify(meta) });
      return json({ image: url });
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

function buildIllustrationPrompt(world: string, desc: string, tone: string, scene: string): string {
  // strip roleplay markup, keep a clean lowercase word list
  const raw = scene.replace(/[*"«»]/g, " ").replace(/\s+/g, " ").trim();
  const stop = new Set([
    "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "dans", "sur", "sous", "avec", "pour", "plus", "pas",
    "très", "tres", "mais", "comme", "lui", "elle", "il", "ils", "tu", "vous", "je", "me", "moi", "mon", "ma", "mes",
    "ton", "ta", "tes", "sa", "son", "ses", "ce", "cet", "cette", "ces", "au", "aux", "en", "par", "se", "si", "ne",
    "y", "vers", "contre", "entre", "tout", "tous", "alors", "quand", "où", "ou", "comment", "pourquoi", "à", "a", "était",
    "etait", "être", "fait", "faire", "voit", "vois", "dit", "dis", "demande", "répond", "repond", "veux", "veut", "peux",
    "peut", "semble", "déjà", "deja", "encore", "aussi", "bien", "même", "meme", "autre", "rien", "quelque", "petite", "petit",
    "grand", "grande", "toujours", "jamais", "seul", "seule", "place", "peu", "long", "voix", "regarde", "sait", "savez", "sais",
    "face", "côté", "cote", "doit", "faites", "êtes", "etes",
  ]);
  const words = raw
    .toLowerCase()
    .split(/[^\p{L}'-]+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 3 && !stop.has(w) && !/^\d+$/.test(w));
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
  // danbooru-style: quality tags first, then environment, scene keywords, style
  return [
    "masterpiece, best quality, anime illustration, highly detailed, vibrant colors",
    worldPart,
    tags.slice(0, 16).join(", "),
    "cinematic lighting, dramatic composition, detailed background, depth of field, sharp focus",
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

async function generateSuggestions(ctx: CastContext, history: MessageRow[]): Promise<string[]> {
  const provider = getProvider();
  const model =
    (ctx.conversation.settings ? (JSON.parse(ctx.conversation.settings || "{}") as any).model : undefined) ||
    defaultModelFor(provider.id);
  const messages: ChatMessage[] = [
    { role: "system", content: suggestSystem(ctx) },
    ...history.slice(-10).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content })),
    { role: "user", content: "Propose tes suggestions de réponses pour le joueur." },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await provider
      .complete({ messages, model, temperature: 1.1, maxTokens: 512, noThinking: true })
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
  const directive = (body.directive ?? "").trim();
  if (!userText && !directive) return json({ error: "message vide" }, 400);
  const userMsg = createMessage({
    conversation_id: convId, role: "user",
    name: persona?.name ?? "Moi", content: userText || directive.slice(0, 120),
  });

  // history + new user message
  const history = listMessages(convId).map(messageView);
  const { system, messages } = buildMessages({ world, persona, cards, scenario, conversation: conv }, history.filter((m) => m.id !== userMsg.id));
  messages.push({ role: "user", content: userText || directive });
  // interpellation directive (e.g. "ask the narrator / a character to speak")
  if (directive) messages[messages.length - 1].content += `\n\n[Directive : ${directive}]`;

  const provider = getProvider();
  const model =
    (conv.settings ? (JSON.parse(conv.settings || "{}") as any).model : undefined) ||
    defaultModelFor(provider.id);
  const settings = JSON.parse(conv.settings || "{}");
  const temperature = Number(settings.temperature ?? getSetting("temperature", 0.9));
  const maxTokens = Number(settings.max_tokens ?? getSetting("max_tokens", 2048));
  const ttsEnabled = Boolean(getSetting("tts_enabled", true));

  return sseStream(async (send, close) => {
    let full = "";
    try {
      for await (const delta of provider.stream({
        messages: [{ role: "system", content: system }, ...messages],
        model,
        temperature,
        maxTokens,
        noThinking: true,
      })) {
        full += delta;
        send("delta", { text: delta });
      }
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
      const segments = parseSegmentsFor(conv, full);
      updateMessage(assistant.id, { segments: JSON.stringify(segments) });
      touchConversation(convId);
      const firstLine = full.trim().split("\n")[0]?.slice(0, 60) ?? "";
      if (history.length === 0 && conv.title === "Nouvelle partie") {
        updateConversation(convId, { title: firstLine || "Partie" });
      }
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
      send("error", { message: String(e?.message ?? e) });
      // remove the user message on failure so the user can retry cleanly
      deleteMessage(userMsg.id);
      close();
    }
  });
}