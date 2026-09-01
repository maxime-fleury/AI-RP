import { api, readSseStream } from "./api.js?v=26";
import { el, esc, toast, confirmModal, ICONS, fmtTime } from "./ui.js?v=26";
import { store, refreshAll, navigate, applyTheme } from "./app.js?v=26";

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
  resolveCurrent: null,
  gen: 0,
  async play(urls) {
    for (const u of urls) this.items.push(u);
    if (!this.playing) await this.pump();
  },
  async pump() {
    this.playing = true;
    const myGen = this.gen;
    while (this.items.length) {
      const url = this.items.shift();
      await new Promise((resolve) => {
        this.resolveCurrent = resolve;
        const a = new Audio(url);
        this.current = a;
        const done = () => { if (this.resolveCurrent === resolve) this.resolveCurrent = null; resolve(); };
        a.onended = done;
        a.onerror = done;
        a.play().catch(done);
      });
      if (myGen !== this.gen) break; // stopped mid-play → abandon this pump
    }
    if (myGen === this.gen) { this.playing = false; this.current = null; }
  },
  stop() {
    this.items = [];
    this.gen++;
    this.playing = false;
    if (this.resolveCurrent) { const r = this.resolveCurrent; this.resolveCurrent = null; r(); }
    if (this.current) { try { this.current.pause(); } catch { /* ignore */ } }
  },
};

// ─── render ───────────────────────────────────────────────────────────────────
export async function renderChat(convIdRaw) {
  // support #/chat/new?world=&scenario=
  if (convIdRaw === "new") {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const pre = { world_id: params.get("world"), scenario_id: params.get("scenario") };
    const { newGameWizard } = await import("./app.js?v=26");
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
  const groupBtn = el("button", { class: "btn btn-ghost btn-sm group-toggle", onclick: toggleGroup },
    conv.group_mode ? ICONS.group + " Groupe" : ICONS.solo + " Solo",
  );
  const settingsBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Réglages de la partie", onclick: convSettingsModal }, "⚙️");
  const searchBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Rechercher dans l'historique (Entrée = suivant)", onclick: () => { searchBar.hidden = !searchBar.hidden; if (!searchBar.hidden) searchInput.focus(); } }, "🔍");
  const exportBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Exporter la partie (ZIP : texte + audio + images)", onclick: exportZip }, "⬇");
  const delBtn = el("button", { class: "btn btn-ghost btn-icon", style: { color: "var(--danger)" }, title: "Supprimer cette partie", onclick: deleteConversation }, "🗑");

  const searchInput = el("input", { placeholder: "Rechercher dans le fil… (Entrée = suivant)" });
  const searchBar = el("div", { class: "search-bar", hidden: true }, searchInput);
  let searchMatches = [];
  let searchIdx = 0;
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    searchMatches = [];
    searchIdx = 0;
    if (!q) return;
    for (const m of conv.messages || []) {
      if ((m.content || "").toLowerCase().includes(q)) searchMatches.push(String(m.id));
    }
    if (searchMatches.length) jumpToMatch(0);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && searchMatches.length) {
      e.preventDefault();
      jumpToMatch((searchIdx + 1) % searchMatches.length);
    }
  });
  function jumpToMatch(i) {
    searchIdx = i;
    const node = scroll.querySelector(`[data-mid="${searchMatches[i]}"]`);
    const bubble = node?.querySelector(".bubble");
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    if (bubble) {
      bubble.classList.remove("flash");
      void bubble.offsetWidth;
      bubble.classList.add("flash");
      setTimeout(() => bubble.classList.remove("flash"), 1600);
    }
  }

  const header = el("div", { class: "chat-header" }, backBtn, titleBlock, castStrip, groupBtn, searchBtn, exportBtn, delBtn, settingsBtn);

  async function exportZip() {
    exportBtn.disabled = true;
    try {
      const res = await fetch(`/api/conversations/${convId}/export`);
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || "Export impossible");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(conv.title || "partie").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "partie"}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Partie exportée (ZIP) ✓");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      exportBtn.disabled = false;
    }
  }

  async function deleteConversation() {
    if (!(await confirmModal({ title: "Supprimer la partie", message: `Supprimer « ${conv.title || "Partie"} » et tous ses fichiers audio/images ?`, confirmLabel: "Supprimer" }))) return;
    await api(`/api/conversations/${convId}`, { method: "DELETE" });
    await refreshAll();
    navigate("#/");
    toast("Partie supprimée.");
  }

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
    else if (e.key === "Tab") { e.preventDefault(); autocompleteName(); }
  });
  // Tab: complete the current word with an in-scene character/persona name
  function autocompleteName() {
    const names = [persona?.name, ...cards.map((c) => c.name)].filter(Boolean);
    const val = textarea.value;
    const caret = textarea.selectionStart;
    const before = val.slice(0, caret);
    const m = before.match(/(?:^|\s)(@?[\p{L}À-ÿ'’-]*)$/u);
    if (!m) return;
    const word = m[1] || "";
    const base = word.startsWith("@") ? word.slice(1) : word;
    if (!base) return;
    const hits = names.filter((n) => n.toLowerCase().startsWith(base.toLowerCase()));
    if (!hits.length) return toast("Aucun personnage ne commence par « " + base + " »");
    const hit = hits.find((n) => n.toLowerCase() === base.toLowerCase()) || hits[0];
    const at = word.startsWith("@") ? "@" : "";
    const after = val.slice(caret);
    textarea.value = before.slice(0, before.length - word.length) + at + hit + " " + after;
    const pos = before.length - word.length + at.length + hit.length + 1;
    textarea.setSelectionRange(pos, pos);
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px";
  }
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

  const chatMain = el("div", { class: "chat-main" }, header, searchBar, scroll, composerWrap);
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
    const raw = textarea.value.trim();
    if (!raw || busy) return;
    const slash = parseSlash(raw);
    textarea.value = "";
    textarea.style.height = "auto";
    if (slash) {
      if (!slash.prompt) return toast(slash.display); // invalid dice syntax → hint only
      await doStream(slash.display, { prompt: slash.prompt });
    } else {
      await doStream(raw);
    }
  }

  async function toggleGroup() {
    const next = !currentConversation.group_mode;
    await api(`/api/conversations/${convId}`, { method: "PATCH", body: { group_mode: next } });
    await refreshAll();
    renderChat(convIdRaw);
    toast(next ? "Mode groupe activé — tous les personnages parlent." : "Mode solo activé.", "ok");
  }

  function convSettingsModal() {
    let convSettings = {};
    try { convSettings = JSON.parse(currentConversation.settings || "{}"); } catch { /* ignore */ }
    const personaName = currentConversation.persona?.name;
    const castNames = (currentConversation.cards || []).map((c) => c.name).join(", ");

    // ── Modèle & génération ──
    const provider = field("Fournisseur", store.settings.provider || "lmstudio", { type: "select", options: [["lmstudio", "LM Studio (local)"], ["openrouter", "OpenRouter (cloud)"]] });
    const model = field("Modèle", convSettings.model || "", { placeholder: "Vide = défaut (ex: qwen2.5-7b, claude-3.5…)" });
    const temp = field("Température", convSettings.temperature ?? 0.9, { type: "number", min: 0, max: 2, step: 0.1 });
    const maxTok = field("Max tokens", convSettings.max_tokens ?? 2048, { type: "number", min: 64, max: 8192, step: 64 });
    const ctxMax = field("Tours gardés en mémoire", convSettings.context_max_messages ?? store.settings.context_max_messages ?? 20, { type: "number", min: 4, max: 100, step: 1 });

    // ── Mode de jeu ──
    let groupMode = Boolean(currentConversation.group_mode);
    const segSolo = el("button", { type: "button", onclick: () => { groupMode = false; paintSeg(); } }, "🧍 Solo");
    const segGroup = el("button", { type: "button", onclick: () => { groupMode = true; paintSeg(); } }, "👥 Groupe");
    const seg = el("div", { class: "seg" }, segSolo, segGroup);
    const paintSeg = () => {
      segSolo.classList.toggle("on", !groupMode);
      segGroup.classList.toggle("on", groupMode);
    };
    paintSeg();

    // ── Personnages présents ──
    let castIds = new Set();
    try { castIds = new Set((JSON.parse(currentConversation.cast || "[]") || []).map(Number)); } catch { /* ignore */ }
    const castList = el("div", { class: "cast-list" });
    const paintCast = () => {
      castList.replaceChildren(...store.cards.map((c) => {
        const cb = el("input", { type: "checkbox", ...(castIds.has(c.id) ? { checked: "" } : {}) });
        cb.addEventListener("change", () => {
          if (cb.checked) castIds.add(c.id); else castIds.delete(c.id);
          paintCast();
        });
        return el("label", { class: "cast-row", title: c.description || undefined },
          cb,
          c.avatar ? el("img", { src: c.avatar, class: "avatar avatar-sm" }) : el("div", { class: "avatar avatar-sm", style: { display: "grid", placeItems: "center", fontSize: "12px" } }, "🎭"),
          el("span", {}, esc(c.name)),
          cb.checked ? el("small", { class: "on-chip" }, "en scène") : null,
        );
      }));
    };
    paintCast();
    const allBtn = el("button", { class: "chip-btn slim", onclick: () => { castIds = new Set(store.cards.map((c) => c.id)); paintCast(); } }, "Tout");
    const noneBtn = el("button", { class: "chip-btn slim", onclick: () => { castIds = new Set(); paintCast(); } }, "Aucun");
    const castBox = el("div", { class: "cast-box" },
      el("div", { class: "cast-head" },
        el("span", {}, "Personnages en scène"),
        el("span", { class: "cast-count" }, idText(store.cards, castIds)),
      ),
      store.cards.length === 0
        ? el("p", { style: { color: "var(--text-dim)", fontSize: "12.5px" } }, "Aucune carte — importe des cartes dans l'onglet Cartes.")
        : el("div", {}, el("div", { class: "cast-tools" }, allBtn, noneBtn), castList),
    );

    // ── Voix (TTS) ──
    const ttsOn = field("TTS", convSettings.tts_enabled ?? store.settings.tts_enabled !== false, { type: "select", options: [["1", "Activé"], ["0", "Désactivé"]] });
    const autoplay = field("Lecture auto", convSettings.tts_autoplay ?? store.settings.tts_autoplay !== false, { type: "select", options: [["1", "Oui"], ["0", "Non"]] });
    const langSel = field("Langue des voix", convSettings.tts_language || store.settings.tts_language || "fr", { type: "select", options: [["fr", "Français"], ["en", "English"]] });
    const narratorSel = field("Voix du narrateur", convSettings.tts_voice_narrateur || store.settings.tts_voice_narrateur || "jean", { type: "select", options: voiceOpts(convSettings.tts_language || store.settings.tts_language || "fr") });
    const defCharSel = field("Voix des personnages", convSettings.tts_voice_default || store.settings.tts_voice_default || "cosette", { type: "select", options: voiceOpts(convSettings.tts_language || store.settings.tts_language || "fr") });
    langSel.input.addEventListener("change", () => {
      for (const sel of [narratorSel.input, defCharSel.input]) {
        const cur = sel.value;
        sel.replaceChildren(...voiceOpts(langSel.input.value).map(([v, l]) => el("option", { value: v, ...(v === cur ? { selected: "" } : {}) }, l)));
      }
    });

    const body = el("div", { class: "conv-settings" },
      el("div", { class: "modal-section" }, "Modèle & génération"),
      el("div", { class: "row" }, provider.wrap, model.wrap),
      el("div", { class: "row3" }, temp.wrap, maxTok.wrap, ctxMax.wrap),
      el("div", { class: "modal-section" }, "Mode de jeu"),
      el("div", { class: "row" }, el("div", { class: "modal-line" },
        el("div", { class: "ml-txt" }, el("strong", {}, "Faire jouer tous les personnages"), el("small", {}, "Groupe : chacun réagit à la scène · Solo : un personnage principal")),
        seg,
      )),
      el("div", { class: "modal-section" }, "Personnages en scène"),
      castBox,
      el("div", { class: "modal-section" }, "Voix (TTS)"),
      el("div", { class: "row" }, ttsOn.wrap, autoplay.wrap),
      el("div", { class: "row3" }, langSel.wrap, narratorSel.wrap, defCharSel.wrap),
      el("p", { class: "modal-note" }, "Ces réglages ne valent que pour cette partie. Les voix du narrateur et des personnages peuvent être redéfinies par carte. L'historique au-delà de la mémoire est résumé automatiquement par le modèle."),
    );

    const cancelBtn = el("button", { class: "btn btn-ghost" }, "Annuler");
    const saveBtn = el("button", { class: "btn btn-primary" }, "Enregistrer");
    const { close } = openModal({
      title: "⚙️ Réglages de la partie",
      sub: [currentConversation.title, personaName, castNames].filter(Boolean).join(" · "),
      body,
      footer: [cancelBtn, saveBtn],
      wide: true,
    });
    cancelBtn.addEventListener("click", close);
    saveBtn.addEventListener("click", async () => {
      try {
        const settings = {
          ...convSettings,
          provider: provider.input.value,
          model: model.input.value.trim(),
          temperature: Number(temp.input.value),
          max_tokens: Number(maxTok.input.value),
          context_max_messages: Number(ctxMax.input.value),
          tts_enabled: ttsOn.input.value === "1",
          tts_autoplay: autoplay.input.value === "1",
          tts_language: langSel.input.value,
          tts_voice_narrateur: narratorSel.input.value,
          tts_voice_default: defCharSel.input.value,
        };
        await api(`/api/conversations/${convId}`, { method: "PATCH", body: { settings, cast: [...castIds], group_mode: groupMode } });
        store.settings.provider = provider.input.value;
        close();
        toast("Réglages de la partie enregistrés ✓");
        await refreshAll();
        renderChat(convIdRaw);
      } catch (e) { toast(e.message, "err"); }
    });
  }

  function idText(cards, ids) {
    const used = cards.filter((c) => ids.has(c.id)).length;
    return used ? `${used} en scène` : "aucun";
  }
  function voiceOpts(lang) {
    const seen = new Set();
    const out = [];
    for (const v of store.voices || []) {
      if (v.lang !== lang || seen.has(v.name)) continue;
      seen.add(v.name);
      out.push([v.name, v.label]);
    }
    return out;
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

  let csTts = {};
  try { csTts = JSON.parse(currentConversation.settings || "{}"); } catch { /* ignore */ }
  const ttsEnabled = (csTts.tts_enabled ?? store.settings.tts_enabled !== false) !== false;
  const autoplay = (csTts.tts_autoplay ?? store.settings.tts_autoplay !== false) !== false;
  const pending = { id: `pending-${Date.now()}`, role: "assistant", name: "…", content: "", segments: [], audio: [], meta: {}, created_at: Date.now() };
  const pendingNode = renderMessage(pending);
  pendingNode.dataset.pending = "1";
  const bodyEl = pendingNode.querySelector(".body");
  const typing = el("div", { class: "typing" }, el("span"), el("span"), el("span"));
  bodyEl.append(typing);
  // visible "how long is the model thinking" timer
  const thinkEl = el("div", { class: "think-time" }, "⏱ 0s");
  bodyEl.append(thinkEl);
  const thinkStart = Date.now();
  const thinkTimer = setInterval(() => {
    thinkEl.textContent = `⏱ ${Math.round((Date.now() - thinkStart) / 1000)}s`;
  }, 1000);
  scroll.append(pendingNode);
  scrollToBottom(scroll);

  abortController = new AbortController();
  let full = "";
  let lastDoneId = null;
  try {
    const res = await fetch(`/api/conversations/${currentConversation.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, directive: opts.directive || "", prompt: opts.prompt || "" }),
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
        if (autoplay && ttsEnabled) playMessageAudio(m.id);
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
          if (autoplay && ttsEnabled && audio?.length) playMessageAudio(messageId);
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
    clearInterval(thinkTimer);
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

// ─── slash commands (/dice, /ooc, /narrate, /card) ────────────────────────────
function rollDice(spec) {
  const m = spec.match(/^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i);
  if (!m) return null;
  const n = Math.max(1, parseInt(m[1] || "1", 10));
  const sides = Math.max(1, parseInt(m[2], 10));
  if (n > 100 || sides > 1000) return null;
  const rolls = [];
  for (let i = 0; i < n; i++) rolls.push(1 + Math.floor(Math.random() * sides));
  const mod = m[3] ? parseInt(m[3].replace(/\s/g, ""), 10) : 0;
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  return { n, sides, rolls, mod, total };
}

function parseSlash(raw) {
  const cmd0 = raw.trim().split(/\s+/)[0] || "";
  const cmd = cmd0.toLowerCase();
  if (!cmd.startsWith("/")) return null;
  const rest = raw.trim().slice(cmd0.length).trim();
  if (cmd === "/dice") {
    const r = rollDice(rest || "1d20");
    if (!r) return { display: "🎲 Syntaxe : /dice 2d6, /dice d20, /dice 3d8+2 — ex. /dice 1d20", prompt: "" };
    const spec = `${r.n}d${r.sides}${r.mod ? (r.mod > 0 ? "+" + r.mod : String(r.mod)) : ""}`;
    const rolled = r.rolls.join(", ");
    const display = `🎲 ${spec} → ${r.total}`;
    const prompt = `Le joueur lance les dés (${spec}) : résultat ${rolled}, total ${r.total}. Décris ce qui se passe dans la fiction en intégrant ce jet — échec ou réussite selon le score.`;
    return { display, prompt };
  }
  if (cmd === "/ooc") {
    const q = rest || "Petite question hors-jeu.";
    return { display: `💬 (hors-jeu) ${rest || ""}`, prompt: `[Hors-jeu — le joueur s'adresse à toi, assistant de jeu] ${q} Réponds brièvement (2-4 phrases), hors de la fiction, sans narration en astérisques ni dialogue de personnage.` };
  }
  if (cmd === "/narrate") {
    return { display: `📖 Narration : ${rest}`, prompt: `[Directive : le joueur demande une narration] ${rest} Continue la scène en pure narration (entre astérisques), sans dialogue ni adresse directe au joueur, 2-4 paragraphes, fidèle au monde et à son ton.` };
  }
  if (cmd === "/card") {
    const q = rest ? ` La question du joueur : ${rest}` : "";
    return { display: `🗂 État de la partie${rest ? " : " + rest : ""}`, prompt: `[Demande du joueur] Fais le point sur l'état de la partie : personnages présents, lieu, situation en cours, objectifs et enjeux${q}. Réponds en 6-10 lignes concises, entièrement dans la fiction, sans liste numérotée.` };
  }
  return { display: `⚠️ Commande inconnue : ${cmd} — disponibles : /dice, /ooc, /narrate, /card`, prompt: "" };
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
    const illu = el("div", { class: "msg-illu" },
      el("img", { src: m.meta.image, alt: "illustration" }),
      el("div", { class: "illu-meta" },
        m.meta.image_char ? el("span", { class: "illu-char" }, "🎭 " + esc(m.meta.image_char)) : null,
        el("span", { class: "illu-seed" }, "seed " + (m.meta.image_seed ?? "—")),
        el("button", { class: "mini-btn", title: "Nouvelle variante du même prompt", onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = "↻…";
          try {
            // vary: keep the character's look in the prompt but roll a new seed
            await api(`/api/conversations/${currentConversation.id}/messages/${m.id}/image`, { body: { kind: m.meta.image_kind || "auto", vary: true } });
            renderChat(currentConversation.id);
          } catch (err) { toast(err.message, "err"); e.target.disabled = false; e.target.textContent = "↻ Variante"; }
        } }, "↻ Variante"),
      ),
    );
    bubble.append(illu);
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
  const real = (audio || []).filter((a) => a.path).length;
  const playBtn = el("button", { class: "mini-btn", onclick: () => playMessageAudio(messageId, playBtn) }, ICONS.voice, real ? `Voix (${real})` : "Voix");
  const illuBtn = el("button", { class: "mini-btn", onclick: async (e) => {
    e.target.disabled = true;
    e.target.textContent = "🖼 génération…";
    try {
      const res = await api(`/api/conversations/${currentConversation.id}/messages/${messageId}/image`, { body: {} });
      toast("Illustration générée ✓");
      renderChat(currentConversation.id);
    } catch (err) { toast(err.message, "err"); e.target.disabled = false; e.target.textContent = "🖼"; }
  } }, ICONS.image, "Illustrer");
  const retryBtn = el("button", { class: "mini-btn regen-btn", onclick: () => regenerate(messageId) }, ICONS.retry, "Régénérer");
  return [playBtn, illuBtn, retryBtn];
}

// keyboard shortcuts from within the chat (see app.js global handler)
export function chatShortcut(key) {
  if (key === "r") {
    const last = [...document.querySelectorAll(".msg[data-role='assistant']")].pop();
    last?.querySelector(".regen-btn")?.click();
  } else if (key === "g") {
    document.querySelector(".group-toggle")?.click();
  } else if (key === "/") {
    const ta = document.querySelector(".composer textarea");
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

async function playMessageAudio(messageId, btn) {
  // fetch fresh message (audio may not be cached)
  const conv = await api(`/api/conversations/${currentConversation.id}`);
  const msg = conv.messages.find((m) => m.id === messageId);
  if (!msg) return;
  let audio = msg.audio || [];
  let real = audio.filter((a) => a.path);
  // placeholders only (segments capped by tts_max_segments) → synthesize everything now
  if ((audio.length && !real.length || !audio.length) && msg.content) {
    toast("Génération de la voix…", "ok", 6000);
    const res = await api(`/api/conversations/${currentConversation.id}/messages/${messageId}/tts`, { body: {} });
    audio = res.audio || [];
    real = audio.filter((a) => a.path);
    await refreshAll();
  }
  if (!real.length) return toast("Pas de segments vocaux pour ce message.", "err");
  if (btn) {
    // toggle: same handler plays and stops (a second listener on the button
    // would fire both and restart the playback)
    if (btn.classList.contains("playing")) {
      audioQueue.stop();
      btn.classList.remove("playing");
      btn.textContent = ICONS.voice + ` Voix (${real.length})`;
      return;
    }
    btn.classList.add("playing");
    btn.textContent = "⏹ Arrêter";
  }
  await audioQueue.play(real.map((a) => a.path));
  if (btn) { btn.classList.remove("playing"); btn.textContent = ICONS.voice + ` Voix (${real.length})`; }
}

async function regenerate(messageId) {
  // branching: a variant is forked off and regenerated — the original thread
  // stays untouched, and the variant can be explored or deleted later
  const msgs = currentConversation.messages || [];
  const idx = msgs.findIndex((m) => m.id === messageId);
  if (idx < 0) return;
  const lastUser = [...msgs.slice(0, idx)].reverse().find((m) => m.role === "user");
  if (!lastUser) return toast("Rien à régénérer.", "err");
  if (!(await confirmModal({
    title: "Régénérer en variante",
    message: "Une nouvelle variante de la partie sera créée à partir d'ici et régénérée. Le fil d'origine reste intact — tu pourras supprimer la variante si elle ne te plaît pas.",
    confirmLabel: "Créer la variante",
  }))) return;
  try {
    const fork = await api(`/api/conversations/${currentConversation.id}/fork`, { body: { upToMessageId: lastUser.id } });
    await refreshAll();
    // point the URL at the variant without re-triggering route() (mid-stream)
    history.replaceState(null, "", `#/chat/${fork.id}`);
    await renderChat(fork.id);
    currentConversation = fork;
    // replay the exact model input (slash commands / directives rewrite it)
    const meta = lastUser.meta || {};
    const opts = {};
    if (meta.prompt) opts.prompt = meta.prompt;
    if (meta.directive) opts.directive = meta.directive;
    toast("↻ Régénération en cours…", "ok", 3000);
    await doStream(lastUser.content, opts);
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
import { openModal, field } from "./ui.js?v=26";
void applyTheme;
void fmtTime;
void currentConversation;