import { api, readSseStream } from "./api.js?v=14";
import { el, esc, toast, confirmModal, ICONS, fmtTime } from "./ui.js?v=14";
import { store, refreshAll, navigate, applyTheme } from "./app.js?v=14";

let currentConversation = null;
let currentCtx = null;
let busy = false;
let abortController = null;
let chipsRowRef = null;
const audioPrepared = new Set();

// ─── audio queue ──────────────────────────────────────────────────────────────
const audioQueue = {
  items: [],
  playing: false,
  current: null,
  async play(urls) {
    for (const u of urls) this.items.push(u);
    if (!this.playing) await this.pump();
  },
  async pump() {
    this.playing = true;
    while (this.items.length) {
      const url = this.items.shift();
      await new Promise((resolve) => {
        const a = new Audio(url);
        this.current = a;
        a.onended = resolve;
        a.onerror = resolve;
        a.play().catch(resolve);
      });
    }
    this.playing = false;
    this.current = null;
  },
  stop() {
    this.items = [];
    if (this.current) { try { this.current.pause(); } catch { /* ignore */ } }
    this.playing = false;
  },
};

// ─── render ───────────────────────────────────────────────────────────────────
export async function renderChat(convIdRaw) {
  // support #/chat/new?world=&scenario=
  if (convIdRaw === "new") {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const pre = { world_id: params.get("world"), scenario_id: params.get("scenario") };
    const { newGameWizard } = await import("./app.js?v=14");
    newGameWizard(pre);
    return;
  }
  const convId = Number(convIdRaw);
  currentConversation = null;
  const conv = await api(`/api/conversations/${convId}`);
  currentConversation = conv;

  const main = document.getElementById("main");
  const world = conv.world;
  const cards = conv.cards || [];
  const persona = conv.persona;

  // header
  const backBtn = el("a", { href: "#/", class: "btn btn-ghost btn-icon back" }, "←");
  const titleBlock = el("div", { class: "titles" },
    el("strong", {}, esc(conv.title || "Partie")),
    el("small", {}, [world?.name, persona?.name, cards.map((c) => c.name).join(", ")].filter(Boolean).join(" · ") || "Nouvelle partie"),
  );
  const castStrip = el("div", { class: "cast-strip" },
    ...cards.map((c) =>
      el("div", { style: { position: "relative", display: "inline-flex" } },
        c.avatar ? el("img", { src: c.avatar, class: "avatar avatar-sm", title: c.name }) : el("div", { class: "avatar avatar-sm", style: { display: "grid", placeItems: "center", fontSize: "13px" }, title: c.name }, "🎭"),
      ),
    ),
    persona ? el("span", { class: "chip" }, "Toi : " + esc(persona.name)) : null,
  );
  const groupBtn = el("button", { class: "btn btn-ghost btn-sm", onclick: toggleGroup },
    conv.group_mode ? ICONS.group + " Groupe" : ICONS.solo + " Solo",
  );
  const settingsBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Réglages de la partie", onclick: convSettingsModal }, "⚙️");

  const header = el("div", { class: "chat-header" }, backBtn, titleBlock, castStrip, groupBtn, settingsBtn);

  // scroll area
  const scroll = el("div", { class: "chat-scroll" });
  for (const m of conv.messages || []) scroll.append(renderMessage(m));
  // floating "back to latest" button (shown when scrolled up)
  const toBottom = el("button", { class: "to-bottom", title: "Retour aux derniers messages", onclick: () => scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" }) }, "↓");
  scroll.append(toBottom);
  scroll.addEventListener("scroll", () => {
    const near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180;
    toBottom.classList.toggle("show", !near);
  }, { passive: true });

  // composer
  const textarea = el("textarea", { rows: 1, placeholder: conv.cards?.[0] ? `Écris ta réplique à ${conv.cards[0].name}…` : "Écris ton action ou ta réplique…" });
  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px";
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  const sendBtn = el("button", { class: "send-btn", onclick: send, title: "Envoyer (Entrée)" }, "➤");
  const suggestBtn = el("button", { class: "send-btn ghost", onclick: onSuggest, title: "Suggestions de réponses" }, "💡");
  const composer = el("div", { class: "composer" }, textarea, suggestBtn, sendBtn);
  const chipsRow = el("div", { class: "chips-row" });
  const speakRow = el("div", { class: "speak-row" },
    el("span", { class: "chips-label" }, "Faire parler :"),
    el("button", { class: "speak-btn", onclick: () => askToSpeak("narrateur") }, "🎙 Narrateur"),
    ...cards.map((c) => el("button", { class: "speak-btn", onclick: () => askToSpeak(c.name) }, "🎙 " + esc(c.name))),
  );
  const ttsBar = el("div", { class: "tts-bar", hidden: true },
    el("span", { class: "spinner" }),
    el("span", {}, "🔊 Préparation des voix en cours…"),
  );
  const composerWrap = el("div", { class: "composer-wrap" }, ttsBar, speakRow, chipsRow, composer);

  chipsRowRef = chipsRow;

  async function onSuggest() {
    if (busy) return;
    suggestBtn.disabled = true;
    suggestBtn.textContent = "⏳";
    try {
      const res = await api(`/api/conversations/${convId}/suggestions`, { method: "POST", body: {} });
      renderChips(res.suggestions || []);
      if (!res.suggestions?.length) toast("Le modèle n'a rien proposé, réessaie.", "err");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      suggestBtn.disabled = false;
      suggestBtn.textContent = "💡";
    }
  }

  // show chips from the last assistant message if already generated
  const lastMsg = [...(conv.messages || [])].reverse().find((m) => m.role === "assistant");
  if (lastMsg?.meta?.suggestions?.length) renderChips(lastMsg.meta.suggestions);

  const chatMain = el("div", { class: "chat-main" }, header, scroll, composerWrap);
  main.replaceChildren(el("div", { class: "chat-layout" }, chatMain));
  scrollToBottom(scroll, true);
  setTimeout(() => textarea.focus(), 80);

  currentCtx = { scroll, textarea, sendBtn };

  // background: pre-generate the audio of recent messages so it's ready to listen
  if (store.settings.tts_enabled !== false && !audioPrepared.has(convId)) {
    const needAudio = (conv.messages || []).some((m) => m.role === "assistant" && !(m.audio || []).length);
    if (needAudio) {
      audioPrepared.add(convId);
      ttsBar.hidden = false;
      api(`/api/conversations/${convId}/prepare-audio`, { method: "POST", body: {} })
        .then((res) => {
          if (res?.busy) {
            // another job is already synthesizing — keep the indicator on and
            // re-sync once it finishes
            audioPrepared.delete(convId);
            setTimeout(() => { if (currentConversation?.id === convId) renderChat(convId); }, 25000);
            return;
          }
          ttsBar.hidden = true;
          if (res?.generated > 0 && currentConversation?.id === convId) renderChat(convId);
        })
        .catch(() => { ttsBar.hidden = true; });
    }
  }

  async function send() {
    const content = textarea.value.trim();
    if (!content || busy) return;
    textarea.value = "";
    textarea.style.height = "auto";
    await doStream(content);
  }

  async function toggleGroup() {
    const next = !currentConversation.group_mode;
    await api(`/api/conversations/${convId}`, { method: "PATCH", body: { group_mode: next } });
    await refreshAll();
    renderChat(convIdRaw);
    toast(next ? "Mode groupe activé — tous les personnages parlent." : "Mode solo activé.", "ok");
  }

  function convSettingsModal() {
    const provider = el("select", {},
      el("option", { value: "lmstudio" }, "LM Studio"),
      el("option", { value: "openrouter", ...(store.settings.provider === "openrouter" ? { selected: "" } : {}) }, "OpenRouter"),
    );
    let convSettings = {};
    try { convSettings = JSON.parse(currentConversation.settings || "{}"); } catch { /* ignore */ }
    const model = el("input", { value: convSettings.model || "", placeholder: "Modèle (ex: llama-3.3-70b, claude…) — vide = défaut" });
    const temp = el("input", { type: "number", value: convSettings.temperature ?? 0.9, min: 0, max: 2, step: 0.1 });

    // cast manager: add / remove cards from the scene
    let castIds = new Set();
    try { castIds = new Set((JSON.parse(currentConversation.cast || "[]") || []).map(Number)); } catch { /* ignore */ }
    const castBox = el("div", { class: "cast-box" },
      el("label", {}, "Personnages présents (cartes)"),
      el("div", { class: "cast-list" },
        store.cards.length === 0
          ? el("p", { style: { color: "var(--text-dim)", fontSize: "12.5px" } }, "Aucune carte disponible — importe des cartes dans l'onglet Cartes.")
          : store.cards.map((c) => {
            const cb = el("input", { type: "checkbox", ...(castIds.has(c.id) ? { checked: "" } : {}) });
            cb.addEventListener("change", () => {
              if (cb.checked) castIds.add(c.id); else castIds.delete(c.id);
            });
            return el("label", { class: "cast-row" },
              cb,
              c.avatar ? el("img", { src: c.avatar, class: "avatar avatar-sm" }) : el("div", { class: "avatar avatar-sm", style: { display: "grid", placeItems: "center", fontSize: "12px" } }, "🎭"),
              el("span", {}, esc(c.name)),
            );
          }),
      ),
    );

    const body = el("div", { class: "conv-settings" },
      el("label", {}, "Fournisseur"), provider,
      el("label", {}, "Modèle"), model,
      el("label", {}, "Température"), temp,
      castBox,
    );
    const cancelBtn = el("button", { class: "btn btn-ghost" }, "Annuler");
    const saveBtn = el("button", { class: "btn btn-primary" }, "Enregistrer");
    const { close } = openModal({
      title: "Réglages de la partie",
      sub: currentConversation.title || "",
      body,
      footer: [cancelBtn, saveBtn],
    });
    cancelBtn.addEventListener("click", close);
    saveBtn.addEventListener("click", async () => {
      try {
        const settings = {
          ...convSettings,
          provider: provider.value,
          model: model.value.trim(),
          temperature: Number(temp.value),
        };
        await api(`/api/conversations/${convId}`, { method: "PATCH", body: { settings, cast: [...castIds] } });
        store.settings.provider = provider.value;
        close();
        toast("Réglages de la partie enregistrés ✓");
        await refreshAll();
        renderChat(convIdRaw);
      } catch (e) { toast(e.message, "err"); }
    });
  }
}

// ─── streaming a turn ─────────────────────────────────────────────────────────
async function doStream(content, opts = {}) {
  if (!currentConversation || !currentCtx) return;
  const { scroll, textarea, sendBtn } = currentCtx;
  busy = true;
  sendBtn.disabled = true;

  // optimistic user bubble (display text may differ from the raw content)
  const displayText = opts.display || content;
  const userMsg = { id: `tmp-${Date.now()}`, role: "user", name: currentConversation.persona?.name || "Moi", content: displayText, segments: [], audio: [], meta: {}, created_at: Date.now() };
  scroll.append(renderMessage(userMsg));

  const pending = { id: `pending-${Date.now()}`, role: "assistant", name: "…", content: "", segments: [], audio: [], meta: {}, created_at: Date.now() };
  const pendingNode = renderMessage(pending);
  pendingNode.dataset.pending = "1";
  const bodyEl = pendingNode.querySelector(".body");
  bodyEl.append(el("div", { class: "typing" }, el("span"), el("span"), el("span")));
  scroll.append(pendingNode);
  scrollToBottom(scroll);

  abortController = new AbortController();
  let full = "";
  let lastDoneId = null;
  try {
    const res = await fetch(`/api/conversations/${currentConversation.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, directive: opts.directive || "" }),
      signal: abortController.signal,
    });
    await readSseStream(res, async (event, data) => {
      if (event === "delta") {
        full += data.text || "";
        const segs = splitBlocks(full);
        bodyEl.replaceChildren();
        for (const b of segs) {
          bodyEl.append(el("div", {}, formatBody(b)));
        }
        scrollToBottom(scroll);
      } else if (event === "done") {
        const m = data.message;
        lastDoneId = m.id;
        bodyEl.replaceChildren();
        const segs = m.segments?.length ? m.segments : [];
        for (const s of segs) {
          bodyEl.append(el("div", {}, formatSegment(s)));
        }
        if (segs.length === 0) bodyEl.append(el("div", {}, formatBody({ type: "text", text: full })));
        pendingNode.dataset.mid = m.id;
        // replace pending with final markup (keeps audio buttons wiring)
        const node = renderMessage({ ...m, segments: segs });
        pendingNode.replaceWith(node);
        scrollToBottom(scroll);
        if (store.settings.tts_autoplay !== false && store.settings.tts_enabled !== false) {
          playMessageAudio(m.id);
        }
      } else if (event === "tts-status") {
        // visible "voice being generated" state on the just-finished message
        const node = lastDoneId ? document.querySelector(`[data-mid="${lastDoneId}"]`) : null;
        const act = node?.querySelector(".msg-actions");
        if (act) act.replaceChildren(el("span", { class: "tts-note" }, "🔊 génération de la voix…"));
      } else if (event === "tts-done") {
        const { messageId, audio } = data;
        const node = document.querySelector(`[data-mid="${messageId}"]`);
        if (node) {
          const act = node.querySelector(".msg-actions");
          if (act) act.replaceChildren(messageActions(messageId, audio || []));
          if (store.settings.tts_autoplay !== false && store.settings.tts_enabled !== false && audio?.length) {
            playMessageAudio(messageId);
          }
        }
      } else if (event === "suggestions") {
        const { messageId, suggestions } = data;
        if (suggestions?.length) renderChips(suggestions);
        void messageId;
      } else if (event === "error") {
        throw new Error(data.message || "Erreur inconnue");
      }
    });
    await refreshAll();
  } catch (e) {
    if (e.name !== "AbortError") {
      pendingNode.remove();
      const errNode = el("div", { class: "msg me" },
        el("div", { class: "bubble", style: { borderColor: "var(--danger)", color: "var(--danger)" } },
          el("div", { style: { fontWeight: 700 } }, "⚠️ " + esc(e.message)),
          el("button", { class: "mini-btn", style: { marginTop: "8px" }, onclick: () => doStream(content) }, "↻ Réessayer"),
        ),
      );
      scroll.append(errNode);
      scrollToBottom(scroll);
    }
  } finally {
    busy = false;
    if (sendBtn) sendBtn.disabled = false;
    textarea?.focus();
  }
}

// ─── suggestion chips (module level: called from the SSE handler too) ────────
function chipIcon(s) {
  if (/[«"]/.test(s)) return "💬";
  if (/\?/.test(s)) return "❓";
  if (/^je /i.test(s) || /regarde|ouvre|fouille|avance|attaque|prend|sors|murmure|lance|saute|examine|liste/i.test(s)) return "🎯";
  if (/^\S+ :/.test(s)) return "🎭";
  return "✨";
}

function renderChips(suggestions) {
  const chipsRow = chipsRowRef;
  if (!chipsRow) return;
  chipsRow.replaceChildren();
  if (!suggestions?.length) return;
  const head = el("div", { class: "chips-head" },
    el("span", { class: "chips-title" }, "💡 Que faire ?"),
    el("button", { class: "chips-refresh", title: "Nouvelles suggestions", onclick: refreshSuggestions }, "↻"),
  );
  const grid = el("div", { class: "chips-grid" });
  suggestions.slice(0, 5).forEach((s, i) => {
    grid.append(el("button", { class: "chip-btn", style: { animationDelay: `${i * 70}ms` }, onclick: () => sendSuggestionFromChip(s) },
      el("span", { class: "chip-icon" }, chipIcon(s)),
      el("span", { class: "chip-text" }, esc(s)),
      el("span", { class: "chip-num" }, String(i + 1)),
    ));
  });
  chipsRow.append(head, grid);
}

async function refreshSuggestions() {
  if (!currentConversation) return;
  const res = await api(`/api/conversations/${currentConversation.id}/suggestions`, { method: "POST", body: {} }).catch(() => null);
  if (res?.suggestions?.length) renderChips(res.suggestions);
  else toast("Le modèle n'a rien proposé, réessaie.", "err");
}

async function sendSuggestionFromChip(text) {
  const ctx = currentCtx;
  if (!ctx || busy) return;
  ctx.textarea.value = text;
  ctx.textarea.style.height = "auto";
  await doStream(text);
}

// interpellation: ask the narrator or a specific character to speak
async function askToSpeak(target) {
  if (busy) return;
  const narrator = target === "narrateur";
  const display = narrator ? "🎙 Le narrateur prend la parole" : `🎙 ${target} prend la parole`;
  const directive = narrator
    ? "Le narrateur intervient maintenant : décris la scène et fais avancer l'histoire par une narration riche et immersive. Rappel : le narrateur ne parle jamais, il ne fait que raconter — aucun dialogue, aucune adresse directe."
    : `${target} prend la parole maintenant : décris ce que ${target} fait, pense et ressent, puis écris sa réplique. Les autres personnages restent en retrait.`;
  await doStream(display, { directive });
}

// ─── message rendering ────────────────────────────────────────────────────────
function renderMessage(m) {
  const isMe = m.role === "user";
  const segs = m.segments || [];
  const body = el("div", { class: "body" });
  if (isMe) {
    body.append(el("div", {}, esc(m.content)));
  } else if (segs.length) {
    for (const s of segs) body.append(el("div", {}, formatSegment(s)));
  } else if (m.content) {
    for (const b of splitBlocks(m.content)) body.append(el("div", {}, formatBody(b)));
  }
  const bubble = el("div", { class: "bubble", title: "Double-clic pour modifier" },
    isMe ? null : el("div", { class: "who" }, esc(m.name || "Narrateur")),
    body,
  );
  // double-click → inline edit (Enter valide, Échap annule)
  const midStr = String(m.id || "");
  if (!midStr.startsWith("tmp-") && !midStr.startsWith("pending")) {
    bubble.addEventListener("dblclick", (e) => {
      if (e.target.closest("button, a, img")) return;
      startEdit(m, body, bubble);
    });
  }
  if (!isMe && m.meta?.image) {
    bubble.append(el("div", { class: "msg-illu" }, el("img", { src: m.meta.image, alt: "illustration" })));
  }
  if (!isMe && m.id && !String(m.id).startsWith("pending")) {
    bubble.append(el("div", { class: "msg-actions" }, ...messageActions(m.id, m.audio || [])));
  }
  const avatar = avatarFor(m);
  return el("div", { class: `msg${isMe ? " me" : ""}`, dataset: { mid: m.id, role: m.role } },
    avatar,
    bubble,
  );
}

// inline edit: double-click a message, Enter to validate, Esc to cancel
function startEdit(m, body, bubble) {
  if (busy) return;
  if (body.querySelector(".edit-ta")) return;
  const ta = el("textarea", { class: "edit-ta", rows: Math.min(6, Math.max(2, (m.content || "").split("\n").length + 1)) }, m.content || "");
  body.replaceChildren(ta, el("div", { class: "edit-hint" }, "Entrée : valider · Échap : annuler"));
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const text = ta.value.trim();
    if (!save || text === (m.content || "")) {
      // cancel or no change → restore the original rendering
      bubble.closest(".msg")?.replaceWith(renderMessage(m));
      return;
    }
    try {
      const updated = await api(`/api/conversations/${currentConversation.id}/messages/${m.id}`, {
        method: "PATCH", body: { content: text },
      });
      const idx = currentConversation.messages.findIndex((x) => x.id === m.id);
      if (idx >= 0) currentConversation.messages[idx] = updated;
      bubble.closest(".msg")?.replaceWith(renderMessage(updated));
      toast("Message modifié ✓");
    } catch (e) {
      toast(e.message, "err");
      done = false;
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  ta.addEventListener("keydown", onKey);
  ta.addEventListener("blur", () => finish(true));
}

function avatarFor(m) {
  if (m.role === "user") {
    const p = currentConversation?.persona;
    return p?.avatar ? el("img", { src: p.avatar, class: "avatar avatar-md" }) : el("div", { class: "avatar avatar-md", style: { display: "grid", placeItems: "center" } }, "🧝");
  }
  const card = (currentConversation?.cards || []).find((c) => c.name.toLowerCase() === (m.name || "").toLowerCase());
  if (card?.avatar) return el("img", { src: card.avatar, class: "avatar avatar-md" });
  return el("div", { class: "avatar avatar-md", style: { display: "grid", placeItems: "center" } }, "📖");
}

function messageActions(messageId, audio) {
  const playBtn = el("button", { class: "mini-btn", onclick: () => playMessageAudio(messageId, playBtn) }, ICONS.voice, audio.length ? `Voix (${audio.length})` : "Voix");
  const illuBtn = el("button", { class: "mini-btn", onclick: async (e) => {
    e.target.disabled = true;
    e.target.textContent = "🖼 génération…";
    try {
      const res = await api(`/api/conversations/${currentConversation.id}/messages/${messageId}/image`, { body: {} });
      toast("Illustration générée ✓");
      renderChat(currentConversation.id);
    } catch (err) { toast(err.message, "err"); e.target.disabled = false; e.target.textContent = "🖼"; }
  } }, ICONS.image, "Illustrer");
  const retryBtn = el("button", { class: "mini-btn", onclick: () => regenerate(messageId) }, ICONS.retry, "Régénérer");
  return [playBtn, illuBtn, retryBtn];
}

async function playMessageAudio(messageId, btn) {
  // fetch fresh message (audio may not be cached)
  const conv = await api(`/api/conversations/${currentConversation.id}`);
  const msg = conv.messages.find((m) => m.id === messageId);
  if (!msg) return;
  let audio = msg.audio || [];
  if (!audio.length && msg.content) {
    toast("Génération de la voix…", "ok", 6000);
    const res = await api(`/api/conversations/${currentConversation.id}/messages/${messageId}/tts`, { body: {} });
    audio = res.audio || [];
    await refreshAll();
  }
  if (!audio.length) return toast("Pas de segments vocaux pour ce message.", "err");
  if (btn) {
    btn.classList.add("playing");
    btn.textContent = "⏹ Arrêter";
    btn.onclick = () => { audioQueue.stop(); btn.classList.remove("playing"); btn.textContent = ICONS.voice + " Voix"; };
  }
  await audioQueue.play(audio.filter((a) => a.path).map((a) => a.path));
  if (btn) { btn.classList.remove("playing"); btn.textContent = ICONS.voice + " Voix"; }
}

async function regenerate(messageId) {
  if (!(await confirmModal({ title: "Régénérer", message: "Cette réponse sera remplacée par une nouvelle. La suite de la conversation est supprimée.", confirmLabel: "Régénérer" }))) return;
  try {
    await api(`/api/conversations/${currentConversation.id}/messages/${messageId}`, { method: "DELETE" });
    await renderChat(currentConversation.id);
    const conv = await api(`/api/conversations/${currentConversation.id}`);
    currentConversation = conv;
    // retrigger the last user message → the model regenerates right away
    const users = conv.messages.filter((m) => m.role === "user");
    const lastUser = users[users.length - 1];
    if (lastUser) {
      toast("↻ Régénération en cours…", "ok", 3000);
      await doStream(lastUser.content);
    } else {
      toast("Rien à régénérer.", "err");
    }
  } catch (e) { toast(e.message, "err"); }
}

// ─── body formatting ──────────────────────────────────────────────────────────
function formatSegment(s) {
  if (s.type === "dialogue") {
    const p = el("p", {});
    p.append(el("strong", { style: { color: "var(--accent)" } }, esc(s.speaker) + " : "));
    p.append(esc("« " + s.text + " »"));
    return p;
  }
  if (s.type === "narration") {
    const p = el("p", { style: { fontStyle: "italic", color: "var(--text-dim)" } }, esc(s.text));
    return p;
  }
  return el("p", {}, esc(s.text));
}

function splitBlocks(text) {
  const out = [];
  const re = /(\*[^*]+\*)|("(?:\\.|[^"])*")|([^*"]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) out.push({ type: "narration", text: m[1].slice(1, -1) });
    else if (m[2]) out.push({ type: "dialogue", text: m[2].slice(1, -1) });
    else if (m[3].trim()) out.push({ type: "text", text: m[3] });
  }
  return out;
}

function formatBody(b) {
  if (b.type === "narration") {
    return el("span", { style: { fontStyle: "italic", color: "var(--text-dim)" } }, esc(b.text));
  }
  if (b.type === "dialogue") {
    return el("span", {}, "« " + esc(b.text) + " »");
  }
  // text block: separate name: "quoted" if present
  const mm = b.text.match(/^\s*([A-Za-zÀ-ÖØ-öø-ÿ'’ -]{1,40}?)\s*[::]\s*"([\s\S]*)"\s*$/);
  if (mm) {
    return el("span", {},
      el("strong", { style: { color: "var(--accent)" } }, esc(mm[1]) + " : "),
      "« " + esc(mm[2]) + " »",
    );
  }
  return el("span", {}, esc(b.text));
}

function scrollToBottom(scroll, force = false) {
  requestAnimationFrame(() => {
    scroll.scrollTop = scroll.scrollHeight;
  });
}

// expose openModal for settings modal
import { openModal } from "./ui.js?v=14";
void applyTheme;
void fmtTime;
void currentConversation;