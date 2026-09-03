/**
 * conversations resource router (extracted from the monolithic routes.ts).
 * Returns null when no route matches; throws are mapped by index.ts.
 */
import { CHAPTER_MIN_MESSAGES, type Quest, RECAP_MIN_MESSAGES, type RecapData, conversationView, forkTail, generateCaptions, generateQuests, generateSceneState, generateSuggestions, handleStream, json, messageView, readJson, recapOf, relsOf, renderRecapShots, scanRelations, storyMessages, suggestChapter, suggestLore, suggestNpcs, suggestRecap, summarizeLoop, validateNarrative } from "./core";
import { type ConversationRow, type MessageRow, createCard, createConversation, createMessage, deleteConversation, deleteMessagesAfter, getCard, getConversation, getMessage, getPersona, getScenario, getSetting, getWorld, lastMessageOf, listBranches, listConversations, listMessages, updateConversation, updateMessage } from "../db";
import { errorResponse } from "../http";
import { trackJob } from "../jobs";
import { Codes, apiError, en, fkId, intArray, obj, str } from "../validate";
import { runBackup } from "../backup";
import { zipFiles } from "../zip";
import { IMAGES_DIR } from "../paths";
import { buildMessages, estimateTokens, memoryToText, parseMemory } from "../../llm/prompt";
import fs from "node:fs";
import path from "node:path";

export async function handleConversations(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
if (p === "/api/conversations" && method === "GET") {
      const convs = listConversations().map((c) => {
        const world = c.world_id ? getWorld(c.world_id) : null;
        return { ...c, world };
      });
      return json({ conversations: convs });
    }

if (p === "/api/conversations" && method === "POST") {
      const body = await readJson(req);
      const worldId = body.world_id != null ? fkId(body.world_id, "world_id", false) : null;
      const personaId = body.persona_id != null ? fkId(body.persona_id, "persona_id", false) : null;
      const scenarioId = body.scenario_id != null ? fkId(body.scenario_id, "scenario_id", false) : null;
      if (worldId && !getWorld(worldId)) apiError(Codes.OWNERSHIP, "world_id inconnu", 422);
      if (personaId && !getPersona(personaId)) apiError(Codes.OWNERSHIP, "persona_id inconnu", 422);
      if (scenarioId && !getScenario(scenarioId)) apiError(Codes.OWNERSHIP, "scenario_id inconnu", 422);
      const cast = intArray(body.cast, "cast");
      for (const cid of cast) if (!getCard(cid)) apiError(Codes.OWNERSHIP, `cast : carte #${cid} inconnue`, 422);
      const conv = createConversation({
        title: str(body.title, "title", { max: 160, required: false }) || "Nouvelle partie",
        world_id: worldId,
        persona_id: personaId,
        scenario_id: scenarioId,
        cast: JSON.stringify(cast),
        group_mode: body.group_mode ? 1 : 0,
        settings: JSON.stringify(obj(body.settings, "settings")),
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
        group_mode: body.group_mode === undefined ? undefined : body.group_mode ? 1 : 0,
        pinned: body.pinned === undefined ? undefined : body.pinned ? 1 : 0,
        archived: body.archived === undefined ? undefined : body.archived ? 1 : 0,
      };
      if (body.title !== undefined) {
        const t = str(body.title, "title", { max: 160, required: false });
        if (t) patch.title = t;
      }
      if (body.cast !== undefined) {
        const cast = intArray(body.cast, "cast");
        for (const cid of cast) if (!getCard(cid)) apiError(Codes.OWNERSHIP, `cast : carte #${cid} inconnue`, 422);
        patch.cast = JSON.stringify(cast);
      }
      if (body.settings !== undefined) {
        patch.settings = JSON.stringify(obj(body.settings, "settings"));
      }
      if (typeof body.branch_kind === "string") {
        patch.branch_kind = en(body.branch_kind, "branch_kind", ["main", "canon", "alternative", "draft", "abandoned"]);
      }
      if (body.memory && typeof body.memory === "object" && !Array.isArray(body.memory)) {
        const m = parseMemory(JSON.stringify(body.memory));
        if (m) {
          patch.memory_json = JSON.stringify(m);
          // keep the readable summary in sync so list views show the memory
          patch.summary = memoryToText(m);
        }
      }
      const updated = updateConversation(Number(parts[2]), patch);
      if (!updated) return json({ error: "not found" }, 404);
      return json(conversationView(updated.id));
    }

if (parts[1] === "conversations" && parts[2] && !parts[3] && method === "DELETE") {
      // soft delete: move to the trash (archived=1); restore via PATCH archived:0
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      updateConversation(conv.id, { archived: 1 });
      return json({ ok: true, archived: true });
    }

if (parts[1] === "conversations" && parts[2] && parts[3] === "permanent" && method === "DELETE") {
      const convId = Number(parts[2]);
      if (!getConversation(convId)) return json({ error: "not found" }, 404);
      deleteConversation(convId);
      try { fs.rmSync(path.join(IMAGES_DIR, "conversations", String(convId)), { recursive: true, force: true }); } catch { /* ignore */ }
      return json({ ok: true });
    }

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

if (parts[1] === "conversations" && parts[2] && parts[3] === "relations" && parts[4] === "reset" && method === "POST") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      const { cs } = relsOf(conv);
      delete cs.rels;
      updateConversation(conv.id, { settings: JSON.stringify(cs) });
      return json({ ok: true });
    }

if (parts[1] === "conversations" && parts[2] && parts[3] === "relations" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      return json({ rels: relsOf(conv).rels });
    }

if (parts[1] === "conversations" && parts[2] && parts[3] === "relations" && !parts[4] && method === "POST") {
      const convId = Number(parts[2]);
      if (!getConversation(convId)) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      const manual = body?.manual === true;
      // tracked job: a refused scan (empty/threshold/throttle) completes the
      // job untouched; a model failure marks it failed/retryable and the route
      // catch maps it to a 502
      const { result } = await trackJob(
        {
          type: "relations",
          title: "Analyse des relations",
          conversationId: convId,
          payload: { conversationId: convId, force: manual },
          retryable: true,
        },
        () => scanRelations(convId, manual),
      );
      return json(result);
    }

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

if (parts[1] === "conversations" && parts[2] && parts[3] === "stats" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      // display-only markers (chapters, rewind notes) are not story messages
      const msgs = storyMessages(listMessages(conv.id));
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

if (parts[1] === "conversations" && parts[2] && parts[3] === "loops" && method === "GET") {
      const conv = getConversation(Number(parts[2]));
      if (!conv) return json({ error: "not found" }, 404);
      let cs: Record<string, any> = {};
      try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
      return json({ checkpoints: Array.isArray(cs.checkpoints) ? cs.checkpoints : [], loops: Array.isArray(cs.loops) ? cs.loops : [] });
    }

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
      return new Response(zip as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename*=UTF-8''${name}.zip`,
        },
      });
    }

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

if (parts[1] === "conversations" && parts[2] && parts[3] === "gallery" && parts[4] === "captions" && method === "POST") {
      const convId = Number(parts[2]);
      const conv = getConversation(convId);
      if (!conv) return json({ error: "not found" }, 404);
      const items = listMessages(convId).map(messageView).filter((m: any) => m.meta?.image);
      if (!items.length) return json({ captions: {} });
      // tracked job: queued → running → completed/failed, visible in the
      // activity panel and retryable from there
      try {
        const { result } = await trackJob(
          {
            type: "captions",
            title: "Légendes de la galerie",
            conversationId: convId,
            payload: { conversationId: convId, count: items.length },
            retryable: true,
          },
          async () => generateCaptions(convId),
        );
        return json({ captions: result });
      } catch (e) {
        // model unavailable: keep the legacy shape (200 + error note) so the
        // gallery still shows whatever captions were already stored — the job
        // itself was marked failed by the hub
        let existing: Record<string, string> = {};
        try {
          existing = JSON.parse(fs.readFileSync(path.join(IMAGES_DIR, "conversations", String(convId), "captions.json"), "utf8"));
        } catch { /* none yet */ }
        const msg = e instanceof Error ? e.message : String(e);
        return json({ captions: existing, error: msg }, 200);
      }
    }

if (parts[1] === "conversations" && parts[2] && parts[3] === "stream" && method === "POST") {
      return handleStream(req, Number(parts[2]));
    }

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
    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
