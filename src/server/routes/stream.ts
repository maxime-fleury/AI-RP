/**
 * Chat streaming orchestration (extracted from core.ts): the SSE turn
 * handler, the in-flight-generation lock and the response-suggestion
 * generator. Pure orchestration — prompt assembly stays in llm/prompt.ts,
 * view/format helpers and job workers stay in core.ts.
 */
import type { CastContext } from "../../llm/prompt";
import { buildMessages, estimateTokens, profileFromSettings, presetFromKey, recencyBlock, modelClass, modelContextBudget, stripThinking, type BuildPromptOptions, type SceneFocus } from "../../llm/prompt";
import { classifyIntent, directionChanged, intentToFocus } from "../../llm/intent";
import { checkResponseDrift } from "../../llm/guardrail";
import { getProvider, defaultModelFor, type ChatMessage } from "../../llm/providers";
import { json, readJson, sseStream } from "../http";
import { log, recordMetric } from "../log";
import { trackJob } from "../jobs";
import { applyContextWindow, chatMsg, conversationView, messageView, parseSegmentsFor, parseSuggestions, proposeCanonFacts, suggestSystem } from "./core";
import { type MessageRow, conversationSettingsOf, createMessage, deleteMessage, getConversation, getMessage, getSetting, listMessages, touchConversation, updateConversation, updateMessage } from "../db";



export async function generateSuggestions(ctx: CastContext, history: MessageRow[]): Promise<string[]> {
  // same context policy as the main stream
  const { kept, summary, memory } = applyContextWindow(ctx.conversation.id, ctx.conversation, history);
  ctx = { ...ctx, summary, memory };
  const cs = conversationSettingsOf(ctx.conversation);
  const provider = getProvider((cs.provider as string) || undefined);
  const model = (cs.model as string) || defaultModelFor(provider.id);
  const messages: ChatMessage[] = [
    chatMsg("system", suggestSystem(ctx)),
    ...kept.slice(-10).map((m) => chatMsg(m.role === "user" ? "user" : "assistant", m.content)),
    chatMsg("user", "Propose tes suggestions de réponses pour le joueur."),
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




// one in-flight generation per conversation: a second tab (or a double-click)
// must never start a parallel turn on the same party
const activeStreams = new Set<number>();




export async function handleStream(req: Request, convId: number): Promise<Response> {
  const body = await readJson(req);
  const conv = getConversation(convId);
  if (!conv) return json({ error: "conversation not found" }, 404);
  if (activeStreams.has(convId)) {
    return json({ error: "Une génération est déjà en cours pour cette partie.", code: "CONFLICT" }, 409);
  }
  activeStreams.add(convId);
  // idempotent retries: the client tags every attempt with a uid and re-posts
  // the SAME uid when the connection dropped before any token arrived. If a
  // previous attempt with this uid partially committed (user turn + possibly a
  // partial reply), drop that tail so the retry starts clean — never touching
  // anything past the newest user message (real newer turns are safe).
  const attemptUid = typeof body.uid === "string" && body.uid ? body.uid.slice(0, 64) : "";
  if (attemptUid) {
    const msgs = listMessages(convId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      let meta: any = {};
      try { meta = JSON.parse(m.meta || "{}"); } catch { /* ignore */ }
      if (m.role === "user") {
        if (meta.uid === attemptUid && i < msgs.length) {
          for (const d of msgs.slice(i)) deleteMessage(d.id);
          console.log(`[chat] ↻ nouvelle tentative #${convId} — tour précédent (uid ${attemptUid.slice(0, 8)}) retiré`);
        }
        break;
      }
    }
  }
  const view = conversationView(convId)!;
  const world = view.world;
  const persona = view.persona;
  const cards = view.cards;
  const scenario = view.scenario;

  const userText = (body.content ?? "").trim();
  const modelText = (body.prompt ?? body.content ?? "").trim(); // slash commands rewrite the model input
  const directive = (body.directive ?? "").trim();
  const steering = (body.steering ?? "").trim(); // per-turn steering channel (§8.3)
  const isOoc = body.mode === "ooc" || /^(\/ooc\b|<ooc:?\s)/i.test(userText) || /^\[hors-jeu/i.test(modelText);
  if (!userText && !directive) { activeStreams.delete(convId); return json({ error: "message vide" }, 400); }
  // keep the model-facing input on the user message so "Régénérer" can replay
  // it exactly (slash commands and directives rewrite the raw content)
  const userMeta: Record<string, string> = {};
  if (modelText && modelText !== userText) userMeta.prompt = modelText;
  if (directive) userMeta.directive = directive;
  if (steering) userMeta.steering = steering;
  if (isOoc) userMeta.ooc = "1";
  if (attemptUid) userMeta.uid = attemptUid;
  const userMsg = createMessage({
    conversation_id: convId, role: "user",
    name: persona?.name ?? "Moi", content: userText || directive.slice(0, 120),
    meta: JSON.stringify(userMeta),
  });

  // messages present before this exchange (used for the auto-title heuristic)
  const historyBefore = listMessages(convId).filter((m) => m.id !== userMsg.id);
  // history + new user message
  const history = listMessages(convId);

  // per-party settings must be valid before we touch the model
  let settings: any = {};
  try {
    settings = JSON.parse(conv.settings || "{}");
    if (!settings || typeof settings !== "object") settings = {};
  } catch {
    activeStreams.delete(convId);
    return json({ error: "Réglages de la partie corrompus — réinitialise-les depuis les réglages.", code: "INVALID_JSON" }, 422);
  }

  // RP profile + intention classification (§8.2): the detected intent feeds
  // the scene focus by default, and a direction change puts the persistent
  // scene plan on hold for THIS turn only (manual focus always overrides).
  const profile = profileFromSettings(settings);
  const intent = classifyIntent(modelText || directive || userText);
  const intentHistory: string[] = Array.isArray(settings.intent_history)
    ? settings.intent_history.filter((x: unknown) => typeof x === "string")
    : [];
  const changed = directionChanged(intentHistory as any, intent);
  const sceneControlHeld = changed && settings.scene_control && settings.scene_control.enabled !== false;
  const effectiveFocus: SceneFocus | undefined = isOoc ? undefined : (profile.sceneFocus ?? intentToFocus(intent));

  const preset = presetFromKey(settings.preset);
  const provider = getProvider((settings.provider as string) || undefined);
  const model = (settings.model as string) || defaultModelFor(provider.id);
  const mclass = modelClass(model);
  const budgetTokens = modelContextBudget(mclass);
  // calmer defaults for the reactive profiles (report Phase 5)
  const behaviorDefaultTemp = profile.behavior === "cinematique" ? 0.9 : 0.75;
  const rawTemp = Number(settings.temperature ?? preset?.temperature ?? getSetting("temperature", behaviorDefaultTemp));
  const temperature = Number.isFinite(rawTemp) ? Math.min(2, Math.max(0, rawTemp)) : 0.75;
  const rawMax = Number(settings.max_tokens ?? preset?.maxTokens ?? getSetting("max_tokens", 2048));
  const maxTokens = Number.isFinite(rawMax) ? Math.min(8192, Math.max(64, Math.round(rawMax))) : 2048;

  // context window: keep recent messages, compress the rest into a rolling summary
  const { kept, summary, memory } = applyContextWindow(convId, conv, history.filter((m) => m.id !== userMsg.id));
  const buildOpts: BuildPromptOptions = {
    profile,
    ooc: isOoc,
    sceneControlHeld,
    steering: isOoc ? "" : steering,
    budgetTokens,
    currentTurn: modelText || directive,
  };
  const { system, messages } = buildMessages({ world, persona, cards, scenario, conversation: conv, summary, memory }, kept, buildOpts);
  messages.push({ role: "user", content: modelText || directive });
  // interpellation directive (e.g. "ask the narrator / a character to speak")
  // — only when the turn also carries text, else the directive IS the message
  if (directive && modelText) messages[messages.length - 1].content += `\n\n[Directive : ${directive}]`;
  // recency block (§8.3): agency + active focus repeated right before generation
  if (isOoc) messages[messages.length - 1].content += "\n\n[OOC — question hors-jeu : réponds hors de la fiction]";
  else messages[messages.length - 1].content += `\n\n${recencyBlock(persona?.name ?? "le joueur", effectiveFocus)}`;

  // server-side trace of every generation (structured — see log.ts)
  const genLabel = (userText || directive || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const genStart = Date.now();
  log("chat", "generation started", {
    convId, title: (conv.title || "sans titre").slice(0, 60), message: genLabel || "(directive)",
    provider: provider.id, model: model || "défaut", temperature, maxTokens,
    behavior: profile.behavior, contextMode: profile.contextMode, length: profile.responseLength,
    focus: effectiveFocus ?? "", focusSource: profile.manualFocus ? "manual" : isOoc ? "ooc" : "detected",
    intent, modelClass: mclass, budgetTokens, sceneControlHeld, ooc: isOoc ? 1 : 0,
  });

  // hard timeout: a stuck model must not leave the UI on "…" forever
  const rawTimeout = Number(getSetting("llm_timeout", 150));
  const timeoutSec = Number.isFinite(rawTimeout) ? Math.min(900, Math.max(20, rawTimeout)) : 150;
  const llmAbort = new AbortController();
  let llmTimer = setTimeout(() => llmAbort.abort(), timeoutSec * 1000);
  let clientStopped = false;
  let assistantCreated = false;
  let streamAttempts = 0;

  return sseStream(
    async (send, close) => {
    let full = "";
    let assistantId = 0;
    let doneSent = false; // the client was told the turn committed
    const MAX_ATTEMPTS = 3;
    // stream one attempt set with transient-failure backoff; sends deltas live
    const streamOnce = async (msgs: ChatMessage[], temp: number): Promise<string> => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        streamAttempts++;
        let acc = "";
        try {
          for await (const delta of provider.stream({
            messages: msgs,
            model,
            temperature: temp,
            maxTokens,
            noThinking: true,
            signal: llmAbort.signal,
          })) {
            acc += delta;
            send("delta", { text: delta });
          }
          return acc;
        } catch (e: any) {
          const aborted = e?.name === "AbortError" || e?.name === "TimeoutError" || /abort/i.test(String(e));
          // Once any output has reached the client, retrying would append a
          // second response to the partial one and commit duplicated fiction.
          if (aborted || acc || attempt >= MAX_ATTEMPTS) throw e;
          send("retry", { attempt, message: `Connexion au modèle instable — nouvelle tentative (${attempt}/${MAX_ATTEMPTS})…` });
          await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
          if (clientStopped) throw e;
        }
      }
      return "";
    };
    try {
      full = await streamOnce([{ role: "system", content: system }, ...messages], temperature);
      clearTimeout(llmTimer);
      // the guardrail correction below is a SECOND model call: re-arm a fresh,
      // shorter timeout so a hung model can't leave the SSE open and the
      // conversation locked after the main stream already succeeded
      llmTimer = setTimeout(() => llmAbort.abort(), 60_000);
      const genSecs = ((Date.now() - genStart) / 1000).toFixed(1);
      log("chat", "generation completed", { convId, secs: genSecs, chars: full.trim().length, attempts: streamAttempts });
      if (!full.trim()) {
        // try to get the model list for a nicer error
        const models = await provider.models().catch(() => []);
        const hint = models.length ? ` Modèles détectés : ${models.slice(0, 5).join(", ")}` : "";
        // like any other failure: drop the pending user turn so the retry
        // (the client keeps its own copy) doesn't duplicate the message
        deleteMessage(userMsg.id);
        send("error", { message: `Le modèle "${model}" n'a rien renvoyé.${hint}` });
        close();
        return;
      }
      // post-generation guardrail (§8.9): rule-based drift checks, then ONE
      // transparent corrective regeneration when a check trips (extra latency
      // only on real triggers; never for OOC turns or after Stop).
      let driftRetry = false;
      let driftIssues: string[] = [];
      if (!isOoc && !clientStopped) {
        const issues = checkResponseDrift(full, { personaName: persona?.name, focus: effectiveFocus, behavior: profile.behavior });
        if (issues.length) {
          driftIssues = issues.map((i) => i.detail);
          log("chat", "drift detected", { convId, issues: driftIssues.join(" | ") });
          const correction = `[CORRECTION : la réponse précédente ${driftIssues.join(" ; ")}. Réponds uniquement à la dernière action du joueur, sans contrôler le joueur ni introduire d'événement majeur non demandé, et termine à un point naturel où le joueur peut répondre.]`;
          try {
            // the correction MUST re-send the system prompt too: without the
            // RP rules (agency, focus, format) the model can't honor them
            const corrected = await streamOnce([{ role: "system", content: system }, ...messages, chatMsg("user", correction)], 0.6);
            if (corrected.trim()) { full = corrected; driftRetry = true; }
          } catch (e2) {
            console.warn(`[chat] correction du garde-fou échouée (partie #${convId}):`, String((e2 as any)?.message ?? e2).slice(0, 160));
          }
        }
      }
      clearTimeout(llmTimer);
      // strip any visible chain-of-thought from the SAVED content
      full = stripThinking(full);
      if (!full.trim()) { deleteMessage(userMsg.id); send("error", { message: `Le modèle "${model}" n'a rien renvoyé.` }); close(); return; }
      const assistant = createMessage({
        conversation_id: convId, role: "assistant",
        name: cards[0]?.name ?? "Narrateur", content: full.trim(),
        meta: JSON.stringify({ ooc: isOoc ? 1 : 0 }),
      });
      assistantCreated = true;
      assistantId = assistant.id;
      // The turn is now COMMITTED: bookkeeping failures below must never turn
      // into an "error" event (the client would think the turn failed and
      // retry, duplicating it). Log them and move on.
      try {
        // OOC replies stay plain text — never split into narration/dialogue
        if (!isOoc) {
          const segments = parseSegmentsFor(conv, full);
          updateMessage(assistant.id, { segments: JSON.stringify(segments) });
        }
        // diagnostic trace on the message (Phase 5 — context inspector + metrics)
        const diag = {
          behavior: profile.behavior, contextMode: profile.contextMode, length: profile.responseLength,
          focus: effectiveFocus ?? "", focusSource: profile.manualFocus ? "manual" : isOoc ? "ooc" : "detected",
          intent, modelClass: mclass, budgetTokens, promptTokens: estimateTokens(system),
          temperature, maxTokens, driftRetry, driftIssues, sceneControlHeld, attempts: streamAttempts,
        };
        const m2 = getMessage(assistant.id)!;
        updateMessage(assistant.id, { meta: JSON.stringify({ ...JSON.parse(m2.meta || "{}"), diagnostics: diag }) });
        touchConversation(convId);
        const firstLine = full.trim().split("\n")[0]?.slice(0, 60) ?? "";
        // fresh conversation (only the opening message so far) → name it from the
        // first reply; keep manual titles
        if (historyBefore.length <= 1 && conv.title === "Nouvelle partie") {
          updateConversation(convId, { title: firstLine || "Partie" });
        }
        // dashboard preview = the latest exchange
        updateConversation(convId, { last_message: full.trim().slice(0, 200) });
        // end-of-turn state: clear the one-shot DM flag, record the intent
        // history (scene_control.hold is per-turn only, never persisted)
        updateConversation(convId, { settings: JSON.stringify({ ...settings, dm_pending: false, intent_history: [...intentHistory, intent].slice(-5) }) });
      } catch (e) {
        console.error(`[chat] post-commit bookkeeping failed (partie #${convId}):`, String((e as any)?.message ?? e).slice(0, 160));
      }
      // Phase 8: raw per-turn metric (regeneration rate, guardrail, profiles)
      recordMetric("turn", {
        convId, behavior: profile.behavior, contextMode: profile.contextMode, length: profile.responseLength,
        focus: effectiveFocus ?? "", focusSource: profile.manualFocus ? "manual" : isOoc ? "ooc" : "detected",
        intent, modelClass: mclass, budgetTokens, promptTokens: estimateTokens(system),
        temperature, maxTokens, driftRetry, ooc: isOoc ? 1 : 0, attempts: streamAttempts, secs: Number(genSecs),
      });
      doneSent = true;
      send("done", { message: messageView(getMessage(assistant.id) ?? assistant) });
      console.log(`[chat] 📨  Réponse #${assistant.id} envoyée au client${driftRetry ? " (corrigée par le garde-fou)" : ""}`);
      // player-owned canon: optional AI proposals after each turn (opt-in via
      // settings.canon_auto, avancé mode only) — non-blocking tracked job
      try {
        const cs2 = conversationSettingsOf(conv);
        if (cs2.canon_auto && profile.contextMode === "avance") {
          void trackJob(
            {
              type: "canon",
              title: "Propositions de canon",
              conversationId: convId,
              payload: { conversationId: convId },
              retryable: true,
            },
            async (job, api) => {
              await proposeCanonFacts(convId, listMessages(convId), api.signal);
            },
          ).catch((e) => console.warn(`[canon] auto-propose failed (#${convId}):`, String((e as any)?.message ?? e).slice(0, 160)));
        }
      } catch { /* ignore */ }
      close();
    } catch (e: any) {
      const aborted = e?.name === "AbortError" || e?.name === "TimeoutError" || /abort/i.test(String(e));
      if (assistantCreated) {
        if (doneSent) {
          // committed AND announced — the client already has the turn, nothing
          // to report (this path is defensive; post-done work swallows its own
          // errors above)
          console.error(`[chat] erreur après envoi (partie #${convId}):`, String(e?.message ?? e).slice(0, 160));
        } else {
          // committed but never announced (e.g. the meta write above blew up) —
          // deliver "done" now so the client doesn't wait on a finished turn
          try {
            const m = getMessage(assistantId);
            if (m) send("done", { message: messageView(m) });
          } catch { /* stream closed */ }
        }
      } else if (aborted && clientStopped) {
        // user pressed Stop: commit whatever the model already wrote, then
        // drop the orphan user turn only if nothing was produced
        const stoppedText = stripThinking(full);
        if (stoppedText.trim()) {
          const partial = createMessage({
            conversation_id: convId, role: "assistant",
            name: cards[0]?.name ?? "Narrateur", content: stoppedText.trim(),
          });
          const segs = parseSegmentsFor(conv, stoppedText);
          updateMessage(partial.id, { segments: JSON.stringify(segs) });
          touchConversation(convId);
          updateConversation(convId, { last_message: stoppedText.trim().slice(0, 200) });
        } else {
          deleteMessage(userMsg.id);
        }
      } else {
        log("chat", "generation failed", { convId, secs: ((Date.now() - genStart) / 1000).toFixed(1), error: String(e?.message ?? e).slice(0, 160), aborted });
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
      activeStreams.delete(convId);
    }
  },
    () => {
      // client disconnected (Stop / tab closed): stop the model generation and
      // clean up the pending exchange
      activeStreams.delete(convId);
      clientStopped = true;
      llmAbort.abort();
    },
  );
}
