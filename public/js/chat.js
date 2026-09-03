import { api, apiFetch, readSseStream } from "./api.js?v=66";
import { el, esc, toast, confirmModal, ICONS, fmtTime } from "./ui.js?v=66";
import { store, refreshAll, refreshConversations, refreshConversation, navigate, applyTheme, autoCardAvatar } from "./app.js?v=66";
import { buildRelationsPane, buildMemoryPane, buildCanonPane, buildLorePane, openMemoryCenter, relationsRef } from "./memory-center.js?v=66";

let currentConversation = null;
let currentCtx = null;
let busy = false;
let streamGeneration = 0;
let abortController = null;
let stopRequested = false; // set when the user presses Stop — stale renders/optimistic UI must die
let currentStreamSettled = null; // promise that resolves when the in-flight doStream() fully settles (finally)
let streamSettledResolve = null; // resolver for currentStreamSettled
let beforeUnloadHandler = null; // installed when streaming starts
let chipsRowRef = null;
let turnSuggestionsMsgId = null; // last assistant message whose chips arrived via the SSE "suggestions" push
let sceneRefreshHook = null; // set by renderChat; fired after each completed turn
// auto-coherence check: module-level because the SSE "done" handler in
// doStream() runs outside renderChat (it used to live inside and threw a
// ReferenceError on every completed turn)
let lastAutoValidateAt = 0; // per-session throttle for the auto coherence check
let autoValidateBusy = false;
let narratorAvatarPending = false; // une seule tentative de portrait du narrateur par session
let coherenceBannerEl = null; // wired by renderChat
let coherenceFindings = [];
function showCoherenceBanner(findings) {
  coherenceFindings = findings || [];
  const banner = coherenceBannerEl;
  if (!banner) return;
  if (!coherenceFindings.length) { banner.hidden = true; return; }
  banner.hidden = false;
  const viewBtn = el("button", { class: "mini-btn", onclick: () => openFindings(coherenceFindings) }, "Voir");
  const closeBtn = el("button", { class: "mini-btn", "aria-label": "Fermer", onclick: () => { banner.hidden = true; } }, "✕");
  banner.replaceChildren(
    el("span", {}, "🛡 " + coherenceFindings.length + " incohérence" + (coherenceFindings.length > 1 ? "s" : "") + " possible" + (coherenceFindings.length > 1 ? "s" : "") + " détectée" + (coherenceFindings.length > 1 ? "s" : "") + " — " + esc(coherenceFindings[0].message || "")),
    viewBtn,
    closeBtn,
  );
}
/** Non-blocking post-turn coherence check (opt-in party setting, throttled). */
async function maybeAutoValidate() {
  if (!currentConversation || autoValidateBusy) return;
  let cs = {};
  try { cs = JSON.parse(currentConversation.settings || "{}"); } catch { /* ignore */ }
  if (!cs.validate_auto) return;
  const now = Date.now();
  if (now - (lastAutoValidateAt || 0) < 10 * 60 * 1000) return;
  lastAutoValidateAt = now;
  autoValidateBusy = true;
  try {
    const r = await api(`/api/conversations/${currentConversation.id}/validate`, { body: {} });
    showCoherenceBanner(r.findings || []);
  } catch { /* silent — the model may be busy */ }
  finally { autoValidateBusy = false; }
}
// multi-select mode (module-level so renderMessage can read it)
let selectionMode = false;
const selectedIds = new Set();
let selectionBarRef = null; // wired by renderChat
let selectionExitRef = null; // wired by renderChat (the ☑ button)
// "Previously on…" recap banner (module-level: one chat open at a time)
let recapBanner = null; // { node, timer, commit }
function clearRecapBanner() {
  // teardown/re-render: stop polling and drop the node WITHOUT a "seen" commit,
  // so the banner may come back when the conversation is reopened
  if (recapBanner?.timer) clearInterval(recapBanner.timer);
  recapBanner = null;
}
function dismissRecapBanner() {
  // the player acted (✕ or sent a message): commit "seen"/"asked" markers
  const b = recapBanner;
  clearRecapBanner();
  b?.commit?.();
  b?.node?.remove();
}
function recapLocal(convId) {
  try { return JSON.parse(localStorage.getItem("innsekai.recap." + convId) || "{}") || {}; } catch { return {}; }
}
function recapSaveLocal(convId, patch) {
  try { localStorage.setItem("innsekai.recap." + convId, JSON.stringify({ ...recapLocal(convId), ...patch })); } catch { /* private mode */ }
}
function paintSelectionBar() {
  const bar = selectionBarRef;
  if (!bar) return;
  const conv = currentConversation;
  if (!selectionMode || !selectedIds.size || !conv) { bar.hidden = true; return; }
  bar.hidden = false;
  const count = selectedIds.size;
  const md = () => {
    const sel = (conv.messages || []).filter((m) => selectedIds.has(m.id));
    return sel.map((m) => {
      const who = m.role === "user" ? (conv.persona?.name || "Moi") : (m.name || "Narrateur");
      return m.role === "user" ? `**${who}** : ${m.content || ""}` : `> **${who}** : ${m.content || ""}`;
    }).join("\n\n");
  };
  const copyBtn = el("button", { class: "mini-btn", onclick: () => copyText(md(), "Sélection") }, "📋 Copier");
  const expBtn = el("button", { class: "mini-btn", onclick: () => {
    const blob = new Blob([md()], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${String(conv.title || "partie").replace(/[^\p{L}\p{N}\- ]+/gu, "").trim().replace(/\s+/g, "-") || "partie"}-selection.md`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Sélection exportée (.md) ✓");
  } }, "📄 Exporter .md");
  const delBtn = el("button", { class: "mini-btn", style: { color: "var(--danger)" }, onclick: async () => {
    if (!(await confirmModal({ title: "Supprimer les messages", message: `Supprimer définitivement ${count} message${count > 1 ? "s" : ""} ?` }))) return;
    try {
      await api(`/api/conversations/${conv.id}/messages/bulk-delete`, { body: { ids: [...selectedIds] } });
      selectedIds.clear();
      toast(`${count} message${count > 1 ? "s" : ""} supprimé${count > 1 ? "s" : ""} ✓`);
      renderChat(conv.id);
    } catch (e) { toast(e.message, "err"); }
  } }, ICONS.trash);
  const closeBtn = el("button", { class: "mini-btn", "aria-label": "Fermer la sélection", onclick: () => selectionExitRef?.click() }, "✕");
  bar.replaceChildren(
    el("span", { class: "sel-count" }, `☑ ${count} sélectionné${count > 1 ? "s" : ""}`),
    copyBtn,
    expBtn,
    delBtn,
    closeBtn,
  );
}
// ── game-master mode (10.A): directives for the next turn only ───────────────
const DM_RYTHME = ["normal", "rapide", "lent"];
const DM_STYLES = ["", "Horreur", "Drame", "Action", "Léger & humoristique", "Héroïque", "Émotionnel"];
const DM_LENGTHS = ["normale", "courte", "longue"];
function dmState(conv) {
  try { return JSON.parse(conv.settings || "{}").dm || {}; } catch { return {}; }
}
function dmPending(conv) {
  try { return Boolean(JSON.parse(conv.settings || "{}").dm_pending); } catch { return false; }
}
async function dmSave(convId, dm, pending) {
  const conv = currentConversation;
  if (!conv) return;
  let cs = {};
  try { cs = JSON.parse(conv.settings || "{}"); } catch { cs = {}; }
  if (cs && typeof cs !== "object") cs = {};
  cs.dm = dm;
  cs.dm_pending = Boolean(pending);
  await api(`/api/conversations/${convId}`, { method: "PATCH", body: { settings: cs } });
  conv.settings = JSON.stringify(cs);
}
// ─── render ───────────────────────────────────────────────────────────────────
export async function renderChat(convIdRaw) {
  clearRecapBanner(); // a new render supersedes any previous recap banner/poll
  // support #/chat/new?world=&scenario= — the query string rides along in
  // parts[1] ("new?world=3&scenario=4"), so strip it before matching: without
  // this, "Jouer ▶" on a scenario card sent /api/conversations/NaN → 404
  const bareId = String(convIdRaw ?? "").split("?")[0];
  if (bareId === "new") {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const pre = { world_id: params.get("world"), scenario_id: params.get("scenario") };
    const { newGameWizard } = await import("./app.js?v=66");
    newGameWizard(pre);
    return;
  }
  const convId = Number(bareId);
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
  const searchBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Rechercher dans l'historique (Entrée = suivant)", "aria-expanded": "false", onclick: (e) => { searchBar.hidden = !searchBar.hidden; e.currentTarget.setAttribute("aria-expanded", String(!searchBar.hidden)); if (!searchBar.hidden) searchInput.focus(); } }, "🔍");
  const sceneBtn = el("button", { class: "btn btn-ghost btn-icon", title: "État de la scène (lieu, objectifs, dangers)", onclick: () => { sceneEnabled = !sceneEnabled; scenePanel.hidden = !scenePanel.hidden; if (!scenePanel.hidden) refreshScene(); } }, "🧭");
  const branchesBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Variantes de la partie (branches)", onclick: branchesModal }, "🌿");
  const memoryBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Mémoire de la partie (souvenirs, canon, relations, lore)", onclick: () => openMemoryCenter(currentConversation, { tab: "memory", fmtAgo: timeAgo, syncMemory: syncCurrentMemory }) }, "🧠");
  const dmBtn = el("button", { class: "btn btn-ghost btn-icon" + (dmPending(conv) ? " on" : ""), title: "Mode maître de jeu (directives pour le prochain tour)", onclick: () => { dmEnabled = !dmEnabled; dmPanel.hidden = !dmPanel.hidden; if (!dmPanel.hidden) dmPaint(); } }, "🎮");
  const validateBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Vérifier la cohérence du fil (IA)", onclick: validateModal }, "🛡");
  const canonBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Mémoire de la partie — faits canoniques à approuver", onclick: () => openMemoryCenter(currentConversation, { tab: "canon", fmtAgo: timeAgo, syncMemory: syncCurrentMemory }) }, "📖");
  const contextBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Inspecter le contexte envoyé au modèle (prompt + messages)", onclick: contextModal }, "📡");
  const bookmarkFilterBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Afficher seulement les favoris", onclick: () => {
    bookmarkFilter = !bookmarkFilter;
    bookmarkFilterBtn.classList.toggle("on", bookmarkFilter);
    bookmarkFilterBtn.title = bookmarkFilter ? "Afficher tout le fil" : "Afficher seulement les favoris";
    paintThread();
  } }, "★");
  const copyThreadBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Copier le fil en Markdown", onclick: () => {
    const lines = (conv.messages || []).map((m) => {
      const who = m.role === "user" ? (conv.persona?.name || "Moi") : (m.name || "Narrateur");
      return m.role === "user" ? `**${who}** : ${m.content || ""}` : `> **${who}** : ${m.content || ""}`;
    });
    copyText(lines.join("\n\n"), "Fil");
  } }, "📋");
  const selectBtn = el("button", { class: "btn btn-ghost btn-icon" + (selectionMode ? " on" : ""), title: selectionMode ? "Quitter la sélection" : "Sélectionner plusieurs messages", onclick: () => {
    selectionMode = !selectionMode;
    selectedIds.clear();
    selectBtn.classList.toggle("on", selectionMode);
    selectBtn.title = selectionMode ? "Quitter la sélection" : "Sélectionner plusieurs messages";
    paintSelectionBar();
    paintThread();
  } }, "☑");
  const mdBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Exporter en Markdown (livre avec chapitres)", onclick: async () => {
    mdBtn.disabled = true;
    try {
      // if the conversation is part of a branch family, let the user choose
      // between the current branch and the canon (main + ⭐) branches only
      let branchMode = "current";
      try {
        const { branches } = await api(`/api/conversations/${convId}/branches`);
        if (branches?.length > 1) {
          branchMode = await new Promise((resolve) => {
            const { close } = openModal({
              title: "📄 Exporter en Markdown",
              sub: "Cette partie fait partie d'une famille de branches.",
              body: el("div", { class: "export-branch-pick" },
                el("button", { class: "btn btn-ghost", onclick: () => { close(); resolve("current"); } }, "🌿 Cette branche (actuelle)"),
                el("button", { class: "btn btn-primary", onclick: () => { close(); resolve("canon"); } }, "⭐ Canon (branches principales uniquement)"),
              ),
              footer: [el("button", { class: "btn btn-ghost", onclick: () => { close(); resolve(""); } }, "Annuler")],
            });
          });
          if (!branchMode) return;
        }
      } catch { /* famille indisponible → export de la branche actuelle */ }
      const res = await apiFetch(`/api/conversations/${convId}/export-md?branch=${encodeURIComponent(branchMode)}`);
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || "Export impossible");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${String(conv.title || "partie").replace(/[^\p{L}\p{N}\- ]+/gu, "").trim().replace(/\s+/g, "-") || "partie"}${branchMode === "canon" ? "-canon" : ""}.md`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(branchMode === "canon" ? "Export canon ✓" : "Export Markdown ✓");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      mdBtn.disabled = false;
    }
  } }, "📄");
  const exportBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Exporter la partie (ZIP : texte + images)", onclick: exportZip }, "⬇");
  const galleryBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Galerie d'illustrations", onclick: openGallery }, "🖼");
  const delBtn = el("button", { class: "btn btn-ghost btn-icon", style: { color: "var(--danger)" }, title: "Archiver cette partie", onclick: deleteConversation }, "🗑");

  const searchInput = el("input", { placeholder: "Rechercher dans le fil… (Entrée = suivant)" });
  const searchBar = el("div", { class: "search-bar", hidden: true }, searchInput);

  // ── game-master panel (collapsible): tension / focus / reveal / pace / style ──
  let dmEnabled = false;
  const dmPanel = el("div", { class: "dm-panel", hidden: true });
  let dm = dmState(conv);
  let dmActive = dmPending(conv);
  const dmPaint = () => {
    const tension = el("input", { type: "range", min: 0, max: 100, step: 5, value: dm.tension ?? 50, "aria-label": "Tension" });
    const tensionLbl = el("span", { class: "dm-val" });
    const paintTension = () => {
      const t = Number(tension.value);
      tensionLbl.textContent = t < 34 ? `calme (${t})` : t < 67 ? `soutenue (${t})` : `élevée (${t})`;
    };
    tension.addEventListener("input", () => { dm.tension = Number(tension.value); paintTension(); });
    paintTension();
    const focusSel = el("select", { class: "mini-select" },
      ["", "Narrateur", ...(conv.cards || []).map((c) => c.name)].map((n) => el("option", { value: n, ...(dm.focus === n ? { selected: "" } : {}) }, n || "— aucun focus —")),
    );
    focusSel.addEventListener("change", () => { dm.focus = focusSel.value; });
    const revealInput = el("input", { placeholder: "Secret à révéler (ex: l'identité du mage)", value: dm.reveal || "" });
    revealInput.addEventListener("input", () => { dm.reveal = revealInput.value; });
    const paceSel = el("select", { class: "mini-select" },
      DM_RYTHME.map((r) => el("option", { value: r, ...(dm.pace === r ? { selected: "" } : {}) }, r === "normal" ? "rythme normal" : r === "rapide" ? "⚡ rapide" : "🐢 lent")),
    );
    paceSel.addEventListener("change", () => { dm.pace = paceSel.value; });
    const styleSel = el("select", { class: "mini-select" },
      DM_STYLES.map((s) => el("option", { value: s, ...(dm.style === s ? { selected: "" } : {}) }, s || "style par défaut")),
    );
    styleSel.addEventListener("change", () => { dm.style = styleSel.value; });
    const lenSel = el("select", { class: "mini-select" },
      DM_LENGTHS.map((l) => el("option", { value: l, ...(dm.length === l ? { selected: "" } : {}) }, l === "normale" ? "longueur normale" : l === "courte" ? "courte" : "longue")),
    );
    lenSel.addEventListener("change", () => { dm.length = lenSel.value; });
    const applyBtn = el("button", { class: "btn btn-primary btn-sm" + (dmActive ? " on" : "") }, dmActive ? "🎯 Actif — prochain tour" : "🎯 Appliquer au prochain tour");
    applyBtn.addEventListener("click", async () => {
      dmActive = !dmActive;
      applyBtn.textContent = dmActive ? "🎯 Actif — prochain tour" : "🎯 Appliquer au prochain tour";
      applyBtn.classList.toggle("on", dmActive);
      dmBtn.classList.toggle("on", dmActive);
      try { await dmSave(convId, dm, dmActive); toast(dmActive ? "Directives du maître de jeu actives pour le prochain tour ✓" : "Directives désactivées ✓"); }
      catch (e) { toast(e.message, "err"); }
    });
    const row = (label, control) => el("label", { class: "dm-row" }, el("span", { class: "dm-label" }, label), control);
    // ── persistent scene directives (plan de scène) ──────────────────────────
    // objectives, required/forbidden events, NPC agendas, reveal gates and free
    // directives — they stay active across turns until the player edits them
    const scLine = (rows, ph) => el("textarea", { class: "dm-sc-txt", rows, placeholder: ph });
    const scObjectives = scLine(2, "un objectif par ligne — ex : Convaincre la garde de laisser entrer le groupe");
    const scRequired = scLine(1, "un événement requis par ligne — ex : La lettre scellée est remise à Liora");
    const scForbidden = scLine(1, "un événement interdit par ligne — ex : Aucun personnage ne meurt dans cette scène");
    const scReveal = scLine(1, "une révélation par ligne — ex : Le mage avoue son pacte quand il est acculé");
    const scAgendas = scLine(2, "Nom du PNJ → son agenda — ex : Varek → cherche à récupérer le médaillon");
    const scDirectives = scLine(1, "directives libres — ex : Termine le tour par un cliffhanger");
    const scEnabled = el("input", { type: "checkbox", "aria-label": "Activer le plan de scène" });
    const scSaveBtn = el("button", { class: "btn btn-primary btn-sm" }, "💾 Enregistrer le plan");
    scSaveBtn.addEventListener("click", async () => {
      const lines = (t) => t.value.split(/\n/).map((s) => s.trim()).filter(Boolean);
      const npc_agendas = {};
      for (const line of scAgendas.value.split(/\n/)) {
        const m = line.match(/^(.+?)\s*[→\-]\s*(.+)$/);
        if (m) npc_agendas[m[1].trim()] = m[2].trim();
      }
      try {
        await api(`/api/conversations/${convId}/scene-control`, { method: "PUT", body: { scene_control: {
          enabled: scEnabled.checked,
          objectives: lines(scObjectives),
          required: lines(scRequired),
          forbidden: lines(scForbidden),
          reveal_gates: lines(scReveal),
          npc_agendas,
          directives: lines(scDirectives),
        } } });
        toast("Plan de scène enregistré ✓");
      } catch (e) { toast(e.message, "err"); }
    });
    const scBlock = el("div", { class: "dm-sc" },
      el("div", { class: "dm-sc-head" },
        el("span", {}, "🧭 Plan de scène persistant"),
        el("label", { class: "dm-sc-toggle", title: "Désactivé : le plan est ignoré au prochain tour" }, el("span", {}, "Actif"), scEnabled),
      ),
      row("🎯 Objectifs", scObjectives),
      row("⚡ Événements requis", scRequired),
      row("🚫 Événements interdits", scForbidden),
      row("🔒 Révélations à préparer", scReveal),
      row("🗣 Agendas des PNJ", scAgendas),
      row("📜 Directives libres", scDirectives),
      el("div", { style: { display: "flex", justifyContent: "flex-end" } }, scSaveBtn),
    );
    dmPanel.replaceChildren(
      el("div", { class: "dm-head" },
        el("span", {}, "🎮 Directives du maître de jeu"),
        el("span", { class: "dm-note" }, dmActive ? "actives — appliquées au prochain tour, puis désactivées" : "inactives — le prochain tour reste normal"),
      ),
      el("div", { class: "dm-grid" },
        row("Tension", el("div", { class: "dm-tension" }, tension, tensionLbl)),
        row("Focus", focusSel),
        row("Rythme", paceSel),
        row("Style", styleSel),
        row("Longueur", lenSel),
      ),
      row("Révéler", revealInput),
      el("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: "10px" } }, applyBtn),
      el("hr", { class: "dm-sep" }),
      scBlock,
    );
    // load the persisted plan (async — the panel is already visible)
    api(`/api/conversations/${convId}/scene-control`).then((r) => {
      const sc = r.scene_control || {};
      scObjectives.value = (sc.objectives || []).join("\n");
      scRequired.value = (sc.required || []).join("\n");
      scForbidden.value = (sc.forbidden || []).join("\n");
      scReveal.value = (sc.reveal_gates || []).join("\n");
      scAgendas.value = Object.entries(sc.npc_agendas || {}).map(([k, v]) => `${k} → ${v}`).join("\n");
      scDirectives.value = (sc.directives || []).join("\n");
      scEnabled.checked = sc.enabled !== false;
    }).catch(() => { /* réseau ou serveur indisponible : plan laissé vide */ });
  };

  // ── scene-state panel (collapsible, LLM-maintained) ──
  let sceneEnabled = false;
  const scenePanel = el("div", { class: "scene-panel", hidden: true });
  const refreshScene = async () => {
    try {
      const r = await api(`/api/conversations/${convId}/scene`);
      scenePanel.replaceChildren(renderScenePanel(r.state, r.updatedAt, generateScene));
    } catch {
      // model unreachable: never leave the panel open and EMPTY (a floating
      // rounded bar that contains nothing) — show the fallback state instead
      scenePanel.replaceChildren(renderScenePanel(null, null, generateScene));
    }
  };
  const generateScene = async () => {
    try {
      const r = await api(`/api/conversations/${convId}/scene`, { method: "POST", body: {} });
      scenePanel.replaceChildren(renderScenePanel(r.state, r.updatedAt, generateScene));
      toast(r.throttled ? "État déjà récent (2 min) ✓" : "État de la scène actualisé ✓");
    } catch (e) {
      scenePanel.replaceChildren(renderScenePanel(null, null, generateScene));
      toast(e.message, "err");
    }
  };
  // keep the panel fresh after each completed turn (only when it was opened)
  sceneRefreshHook = async () => { if (sceneEnabled && !busy) await generateScene().catch(() => {}); };
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
    const node = scroll.querySelector(`[data-mid="${CSS.escape(String(searchMatches[i]))}"]`);
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

  // ── header menu: several small category dropdowns, not one giant list ⇣ ───
  // the header keeps only the essentials; everything else lives in a two-pane
  // popup: a rail of category buttons on the left, the selected category's
  // actions on the right (each category acts as its own dropdown button).
  const questBtn = el("button", { title: "Journal de quêtes", onclick: () => questModal(conv) }, "🗡"); // invisible triggers, surfaced via the menu
  const statsBtn = el("button", { title: "Statistiques", onclick: () => statsModal(convId) }, "📊");
  const npcBtn = el("button", { title: "Proposer un PNJ", onclick: () => npcSuggestModal() }, "✨");
  const checkpointBtn = el("button", { title: "Marquer un checkpoint", onclick: () => checkpointModal() }, "📌");
  const returnBtn = el("button", { title: "Revenir au checkpoint (rewind)", onclick: () => rewindModal() }, "🔁");
  const loopsBtn = el("button", { title: "Journal des boucles", onclick: () => loopsModal() }, "📔");
  const loreBtn = el("button", { title: "Mémoire de la partie — canon (lore)", onclick: () => openMemoryCenter(currentConversation, { tab: "lore", fmtAgo: timeAgo, syncMemory: syncCurrentMemory }) }, "📚");
  const relBtn = el("button", { title: "Mémoire de la partie — relations (affinités)", onclick: () => openMemoryCenter(currentConversation, { tab: "relations", fmtAgo: timeAgo, syncMemory: syncCurrentMemory }) }, "💞");
  const menu = el("div", { class: "header-menu", hidden: true });
  const closeHeaderMenu = () => { menu.hidden = true; };
  const sections = [
    { title: "🎬 Scène & mémoire", items: [[sceneBtn, "État de la scène"], [memoryBtn, "Mémoire de la partie"], [dmBtn, "Directives du maître de jeu"], [contextBtn, "Contexte envoyé au modèle"], [branchesBtn, "Variantes"], [validateBtn, "Vérifier la cohérence"]] },
    { title: "🔎 Fil & sélection", items: [[searchBtn, "Rechercher"], [bookmarkFilterBtn, "Favoris seulement"], [selectBtn, "Sélectionner plusieurs messages"]] },
    { title: "📤 Export", items: [[mdBtn, "Exporter en Markdown"], [copyThreadBtn, "Copier le fil"], [galleryBtn, "Galerie d'illustrations"], [exportBtn, "Exporter en ZIP"]] },
    { title: "🕘 Boucles de temps", items: [[checkpointBtn, "Marquer un checkpoint"], [returnBtn, "Revenir au checkpoint"], [loopsBtn, "Journal des boucles"]] },
    { title: "🛠 Partie", items: [[loreBtn, "Mémoire — lore"], [relBtn, "Mémoire — relations"], [npcBtn, "Proposer un PNJ"], [questBtn, "Journal de quêtes"], [statsBtn, "Statistiques"], [settingsBtn, "Réglages de la partie"], [delBtn, "Archiver la partie"]] },
  ].map((s) => ({ ...s, items: s.items.filter(([b]) => !!b) })).filter((s) => s.items.length);
  const menuItem = ([b, label]) => {
    const icon = (b.textContent || "›").trim().split(/\s/)[0] || "›";
    return el("button", { class: "menu-item", onclick: (e) => { e.stopPropagation(); closeHeaderMenu(); b.click(); } },
      el("span", { class: "menu-ico" }, icon),
      el("span", { class: "menu-lbl" }, label),
    );
  };
  const rail = el("div", { class: "header-menu-rail" });
  const pane = el("div", { class: "header-menu-pane" });
  let activeSection = 0;
  // the pane follows the hovered/focused category — buttons are built once and
  // only their .on / hidden state flips, so the pointer and focus stay put
  const setActive = (i) => {
    if (i === activeSection) return;
    activeSection = i;
    railBtns.forEach((b, j) => {
      b.classList.toggle("on", j === i);
      b.setAttribute("aria-pressed", String(j === i));
    });
    sectionEls.forEach((sec, j) => { sec.hidden = j !== i; });
  };
  const railBtns = sections.map((s, i) => {
    const m = s.title.match(/^(\S+)\s+(.*)$/);
    return el("button", {
      class: "menu-rail-btn" + (i === 0 ? " on" : ""),
      "aria-pressed": String(i === 0),
      title: s.title,
      onmouseenter: () => setActive(i),
      onfocus: () => setActive(i),
      onclick: () => setActive(i),
    },
      el("span", { class: "menu-ico" }, m ? m[1] : "▪"),
      el("span", { class: "menu-rail-lbl" }, m ? m[2] : s.title),
      el("span", { class: "menu-rail-count" }, String(s.items.length)),
    );
  });
  // note: `el()` turns any non-null value into a setAttribute call, so the
  // hidden attr must be *omitted* for the first section (hidden: false would
  // still hide it)
  const sectionEls = sections.map((s, i) =>
    el("div", { class: "menu-section", ...(i !== 0 ? { hidden: "" } : {}) }, s.items.map(menuItem)),
  );
  rail.append(...railBtns);
  pane.append(...sectionEls);
  menu.append(rail, pane);
  const menuBtn = el("button", { class: "btn btn-ghost btn-icon header-more-btn", title: "Plus d'options", "aria-label": "Plus d'options", onclick: (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  } }, "⋮");
  const header = el("div", { class: "chat-header" }, backBtn, titleBlock, castStrip, groupBtn, menuBtn, menu);

  async function exportZip() {
    exportBtn.disabled = true;
    try {
      const res = await apiFetch(`/api/conversations/${convId}/export`);
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || "Export impossible");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${String(conv.title || "partie").replace(/[^\p{L}\p{N}\- ]+/gu, "").trim().replace(/\s+/g, "-") || "partie"}.zip`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast("Partie exportée (ZIP) ✓");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      exportBtn.disabled = false;
    }
  }

  async function deleteConversation() {
    if (!(await confirmModal({ title: "Archiver la partie", message: `Déplacer « ${conv.title || "Partie"} » dans la corbeille ? Tu pourras la restaurer depuis l'accueil. (La suppression définitive se fait dans la corbeille.)`, confirmLabel: "Archiver" }))) return;
    await api(`/api/conversations/${convId}`, { method: "DELETE" });
    await refreshConversations();
    navigate("#/");
    toast("Partie archivée — corbeille dans l'accueil.");
  }

  async function openGallery() {
    // a failed fetch must not masquerade as "Aucune illustration"
    let data = null;
    let galleryErr = "";
    try { data = await api(`/api/conversations/${convId}/gallery`); }
    catch (e) { galleryErr = e?.message || "Erreur inconnue"; }
    const items = data?.items || [];
    let captions = data?.captions || {};
    const grid = el("div", { class: "gallery-grid" });
    const paint = () => {
      grid.replaceChildren(...items.map((it) => {
        const imgAlt = it.character ? `Illustration de ${it.character}` : (it.message || "Illustration de la partie");
        const img = el("img", { src: it.image, alt: imgAlt });
        img.addEventListener("click", () => {
          const lb = el("div", { class: "lightbox" },
            el("img", { src: it.image, alt: imgAlt }),
            el("div", { class: "lb-meta" },
              it.character ? el("span", { class: "chip" }, "🎭 " + esc(it.character)) : null,
              el("span", { class: "chip" }, "seed " + (it.seed ?? "—")),
            ),
            el("p", { class: "lb-caption" }, captions[it.id] ? "💬 " + esc(captions[it.id]) : esc(it.message)),
          );
          lb.addEventListener("click", () => lb.remove());
          document.body.append(lb);
        });
        return el("div", { class: "gallery-card" },
          img,
          el("div", { class: "gallery-cap" }, captions[it.id] ? "💬 " + esc(captions[it.id]) : esc(it.message || "")),
        );
      }));
    };
    paint();
    const capBtn = el("button", { class: "btn btn-primary btn-sm", onclick: async () => {
      capBtn.disabled = true;
      capBtn.textContent = "✨ L'IA rédige les légendes…";
      try {
        // no silent swallow: a failed generation must NOT toast "✓" as if it
        // succeeded (the old .catch kept the stale captions AND the success toast)
        const r = await api(`/api/conversations/${convId}/gallery/captions`, { method: "POST", body: {} });
        captions = r.captions || {};
        paint();
        if (r.error) toast(`Légendes partielles — ${String(r.error).slice(0, 120)}`, "warn");
        else toast("Légendes générées ✓");
      } catch (e) { toast(e.message || "Génération des légendes impossible", "err"); }
      capBtn.disabled = false;
      capBtn.textContent = "✨ Légendes IA";
    } }, "✨ Légendes IA");
    openModal({
      title: "🖼 Galerie d'illustrations",
      sub: "Les scènes de la partie — clique pour agrandir",
      body: el("div", {},
        el("div", { style: { display: "flex", justifyContent: "flex-end", marginBottom: "10px" } }, capBtn),
        items.length ? grid : el("div", { class: "empty" },
          el("div", { class: "big" }, "🖼"),
          el("h3", {}, galleryErr ? "Galerie indisponible" : "Aucune illustration"),
          el("p", {}, galleryErr ? esc(galleryErr) : "Génère des images depuis les messages (bouton « Illustrer »)."),
        ),
      ),
      wide: true,
    });
  }

  // scroll area (with time separators + bookmark filter, re-paintable)
  const scroll = el("div", { class: "chat-scroll" });
  const toBottom = el("button", { class: "to-bottom", title: "Retour aux derniers messages", onclick: () => scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" }) }, "↓");
  scroll.append(toBottom);
  scroll.addEventListener("scroll", () => {
    const near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180;
    toBottom.classList.toggle("show", !near);
  }, { passive: true });
  let bookmarkFilter = false;
  const paintThread = () => {
    while (scroll.firstChild && scroll.firstChild !== toBottom) scroll.firstChild.remove();
    let prevTs = 0;
    for (const m of conv.messages || []) {
      if (bookmarkFilter && !m.meta?.bookmark) continue;
      if (prevTs && m.created_at - prevTs > 2 * 3600 * 1000) {
        scroll.insertBefore(el("div", { class: "time-sep" }, "── " + timeAgo(prevTs) + " ──"), toBottom);
      }
      scroll.insertBefore(renderMessage(m), toBottom);
      prevTs = m.created_at;
    }
    scrollToBottom(scroll, true);
  };
  paintThread();
  initMiniSheets(scroll);
  // ── "Previously on…" banner ──
  // On reopening a party after an idle break, surface the recap of the last
  // session (with its storyboard) if one is stored and not yet seen; otherwise,
  // if enough new story accumulated since the last recap, offer to generate
  // one. Falls back to the chapter stop-marker banner when there is nothing to
  // recap.
  let cs0 = {};
  try { cs0 = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
  const chapters0 = Array.isArray(cs0.chapters) ? cs0.chapters : [];
  const recap0 = cs0.recap && typeof cs0.recap === "object" && !Array.isArray(cs0.recap) ? cs0.recap : null;
  const story0 = (conv.messages || []).filter((m) => !m.meta?.chapter && !m.meta?.rewind);
  const lastStory0 = story0[story0.length - 1] || null;
  const RECAP_MIN_NEW = 6; // keep in sync with the server (RECAP_MIN_MESSAGES)
  const RECAP_IDLE_MS = 10 * 60 * 1000; // an idle party = a "session break"
  const sinceId0 = recap0?.last_msg_id || 0;
  const fresh0 = story0.filter((m) => m.id > sinceId0).length;
  const lastId0 = lastStory0?.id || 0;
  const local0 = recapLocal(conv.id);
  let recapMode = null; // "show" (stored recap not seen yet) | "ask" (offer to generate)
  if (recap0 && recap0.at !== local0.seenAt) recapMode = "show";
  else if (fresh0 >= RECAP_MIN_NEW && lastStory0 && Date.now() - lastStory0.created_at >= RECAP_IDLE_MS && lastId0 > (local0.askFromId || 0)) recapMode = "ask";
  if (!recapMode && chapters0.length) {
    const last = chapters0[chapters0.length - 1];
    scroll.insertBefore(el("div", { class: "chapter-resume" },
      el("strong", {}, `📖 Chapitre ${last.n} — ${esc(last.title || "")}`),
      el("p", {}, esc(last.summary || "")),
    ), toBottom);
  }
  if (recapMode) {
    let data = recapMode === "show" ? recap0 : null;
    let generating = false;
    const banner = el("div", { class: "recap-banner" });
    const contentEl = el("div", { class: "recap-content" });
    banner.append(contentEl);
    const closeBtn = (title) => el("button", { class: "btn btn-ghost btn-icon", title, onclick: dismissRecapBanner }, "✕");
    const idleNote = () => {
      const t = timeAgo(lastStory0.created_at);
      const base = `La partie s'est arrêtée ${t || "récemment"}`;
      if (fresh0 <= 0) return base + ".";
      return `${base} — ${fresh0} nouveau${fresh0 > 1 ? "x" : ""} message${fresh0 > 1 ? "s" : ""} depuis le dernier récap.`;
    };
    const shotCard = (s) => {
      const fig = (mid, ...kids) => el("figure", { class: "recap-shot" }, mid, el("figcaption", { class: "shot-cap" }, esc(s.caption || "")));
      if (s.status === "done" && s.image) {
        return fig(el("img", { src: s.image, alt: s.caption || "", loading: "lazy" }));
      }
      if (s.status === "pending") return fig(el("div", { class: "shot-pending" }, "🎨", "Storyboard en cours…"));
      return fig(el("div", { class: "shot-err" },
        "🎨 échec",
        el("button", { class: "mini-btn", title: "Relancer la génération", onclick: async (e) => {
          e.target.disabled = true;
          try { await api(`/api/conversations/${conv.id}/recap/shots`, { method: "POST", body: {} }); } catch { /* will retry via poll */ }
          e.target.disabled = false;
          startPoll();
        } }, "↻ Réessayer"),
      ));
    };
    const paint = () => {
      if (!data) {
        contentEl.replaceChildren(
          el("div", { class: "recap-head" },
            el("span", { class: "recap-icon" }, "🎬"),
            el("div", { class: "grow" },
              el("strong", {}, generating ? "Le narrateur résume la session…" : "Reprendre la partie"),
              el("small", {}, generating ? "Écriture du « Previously on… » (quelques secondes)." : idleNote()),
            ),
            closeBtn("Fermer"),
          ),
          el("div", { class: "recap-actions" },
            generating
              ? el("span", { class: "recap-busy" }, "⏳ Écriture en cours…")
              : el("button", { class: "btn btn-primary btn-sm", onclick: askRecap }, "✨ Générer le récap"),
            generating ? null : el("span", { class: "hint" }, "Résumé narratif du narrateur + storyboard illustré (1 à 3 scènes)."),
          ),
        );
        return;
      }
      const shots = Array.isArray(data.shots) ? data.shots : [];
      contentEl.replaceChildren(
        el("div", { class: "recap-head" },
          el("span", { class: "recap-icon" }, "🎬"),
          el("div", { class: "grow" },
            el("strong", {}, `Previously on… — ${esc(data.title || "Partie")}`),
            el("small", {}, timeAgo(data.at) || "Session précédente"),
          ),
          closeBtn("Fermer"),
        ),
        el("p", { class: "recap-text" }, esc(data.text || "")),
        shots.length ? el("div", { class: "recap-shots" }, ...shots.map(shotCard)) : null,
      );
    };
    const startPoll = () => {
      if (recapBanner?.timer) clearInterval(recapBanner.timer);
      const timer = setInterval(async () => {
        if (recapBanner?.node !== banner || !banner.isConnected) { clearInterval(timer); if (recapBanner?.node === banner) recapBanner = null; return; }
        try {
          const r = await api(`/api/conversations/${conv.id}/recap`);
          const d = r.recap;
          if (!d) return;
          data = d;
          paint();
          const shots = Array.isArray(d.shots) ? d.shots : [];
          if (!shots.some((s) => s.status === "pending")) { clearInterval(timer); if (recapBanner) recapBanner.timer = null; }
        } catch { /* offline — keep polling */ }
      }, 6000);
      if (recapBanner) recapBanner.timer = timer;
    };
    const askRecap = async () => {
      generating = true;
      paint();
      try {
        const r = await api(`/api/conversations/${conv.id}/recap`, { method: "POST", body: {} });
        if (!r.created) {
          generating = false;
          paint();
          toast(r.reason === "threshold" ? "Pas encore assez de messages pour un récap." : (r.error || "Récap indisponible."), "warn");
          return;
        }
        data = r.recap;
        generating = false;
        cs0.recap = r.recap; // keep the local conversation state coherent
        paint();
        if ((data.shots || []).some((s) => s.status === "pending")) startPoll();
      } catch (e) {
        generating = false;
        paint();
        toast(e.message || "Échec du récap.", "err");
      }
    };
    const commit = () => {
      if (data) recapSaveLocal(conv.id, { seenAt: data.at, askFromId: 0 });
      else recapSaveLocal(conv.id, { askFromId: lastId0 || Date.now() });
    };
    scroll.insertBefore(banner, toBottom);
    recapBanner = { node: banner, timer: null, commit };
    paint();
    if (data && (data.shots || []).some((s) => s.status === "pending")) startPoll();
  }

  // composer
  const textarea = el("textarea", { rows: 1, placeholder: conv.cards?.[0] ? `Écris ta réplique à ${conv.cards[0].name}…` : "Écris ton action ou ta réplique…" });
  // slash-command autocomplete (Discord-style menu)
  const SLASH_CMDS = [
    { cmd: "/dice", desc: "Lancer des dés — ex: /dice 2d6, /dice d20" },
    { cmd: "/ooc", desc: "Question hors-jeu au modèle" },
    { cmd: "/narrate", desc: "Forcer le narrateur à raconter la scène" },
    { cmd: "/card", desc: "État de la partie (lieu, enjeux, objectifs)" },
    { cmd: "/checkpoint", desc: "Marquer un point de retour (avec une note optionnelle)" },
    { cmd: "/return", desc: "Revenir au dernier checkpoint (rewind)" },
  ];
  let slashIdx = 0;
  const slashMenu = el("div", { class: "slash-menu", hidden: true });
  const paintSlash = () => {
    [...slashMenu.querySelectorAll(".slash-item")].forEach((it, i) => it.classList.toggle("sel", i === slashIdx));
  };
  const renderSlash = (query) => {
    const q = (query || "").toLowerCase();
    const hits = SLASH_CMDS.filter((c) => c.cmd.startsWith("/" + q));
    if (!hits.length) { slashMenu.hidden = true; return; }
    slashIdx = 0;
    slashMenu.hidden = false;
    slashMenu.replaceChildren(...hits.map((c, i) =>
      el("div", { class: `slash-item${i === 0 ? " sel" : ""}`, onclick: () => insertSlash(c.cmd) },
        el("code", {}, c.cmd), el("span", {}, c.desc)),
    ));
  };
  const insertSlash = (cmd) => {
    const val = textarea.value;
    const caret = textarea.selectionStart;
    const before = val.slice(0, caret);
    const after = val.slice(caret);
    const m = before.match(/(\/[\p{L}]*)$/u);
    const start = m ? before.length - m[1].length : before.length;
    textarea.value = before.slice(0, start) + cmd + " " + after;
    const pos = start + cmd.length + 1;
    textarea.setSelectionRange(pos, pos);
    slashMenu.hidden = true;
    textarea.focus();
  };
  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px";
    const v = textarea.value;
    if (v.startsWith("/") && !v.includes("\n")) renderSlash(v.slice(1).split(/\s+/)[0]);
    else slashMenu.hidden = true;
  });
  textarea.addEventListener("keydown", (e) => {
    if (!slashMenu.hidden) {
      const items = [...slashMenu.querySelectorAll(".slash-item")];
      if (e.key === "ArrowDown") { e.preventDefault(); slashIdx = (slashIdx + 1) % items.length; paintSlash(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); slashIdx = (slashIdx - 1 + items.length) % items.length; paintSlash(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); items[slashIdx]?.click(); return; }
      if (e.key === "Escape") { e.preventDefault(); slashMenu.hidden = true; return; }
    }
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
  const stopBtn = el("button", { class: "send-btn stop-btn", hidden: true, onclick: stopStreaming, title: "Arrêter la génération" }, "⏹");
  const suggestBtn = el("button", { class: "send-btn ghost", onclick: onSuggest, title: "Suggestions de réponses" }, "💡");
  const composer = el("div", { class: "composer" }, textarea, suggestBtn, stopBtn, sendBtn);
  async function stopStreaming() {
    if (!abortController) return;
    const ac = abortController;
    abortController = null;
    stopRequested = true;
    ac.abort(); // aborts the SSE fetch → the server aborts the provider request
    toast("Génération arrêtée — le texte déjà écrit est conservé.", "ok", 3200);
    // wait for the in-flight doStream() to fully settle (its finally drops the
    // stale optimistic UI), THEN show the server's committed state — the
    // partial reply if the model had written something, or the cleaned-up
    // thread (user turn removed) if it hadn't. No fixed delay, no duplicates.
    if (currentStreamSettled) {
      try { await currentStreamSettled; } catch { /* doStream handles its own errors */ }
    }
    if (currentConversation?.id) {
      try {
        await refreshConversation(currentConversation.id);
        await renderChat(String(currentConversation.id));
      } catch { /* re-render failure is non-fatal */ }
    }
  }
  const chipsRow = el("div", { class: "chips-row" });
  const speakRow = el("div", { class: "speak-row" },
    el("span", { class: "chips-label" }, "Faire parler :"),
    el("button", { class: "speak-btn", onclick: () => askToSpeak("narrateur") }, "🎙 Narrateur"),
    ...cards.map((c) => el("button", { class: "speak-btn", onclick: () => askToSpeak(c.name) }, "🎙 " + esc(c.name))),
  );
  // ── auto-validate banner: module-level check, banner element wired here ──
  const coherenceBanner = el("div", { class: "coherence-banner", hidden: true });
  coherenceBannerEl = coherenceBanner;

  // ── multi-select bar (☑): count + copy / export / delete of the selection ──
  const selectionBar = el("div", { class: "selection-bar", hidden: true });
  selectionBarRef = selectionBar;

  selectionExitRef = selectBtn;
  const composerWrap = el("div", { class: "composer-wrap" }, selectionBar, coherenceBanner, slashMenu, speakRow, chipsRow, composer);

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

  const chatMain = el("div", { class: "chat-main" }, header, searchBar, scenePanel, dmPanel, scroll, composerWrap);
  main.replaceChildren(el("div", { class: "chat-layout" }, chatMain));
  scrollToBottom(scroll, true);
  setTimeout(() => textarea.focus(), 80);

  currentCtx = { scroll, textarea, sendBtn, stopBtn, composerWrap };
  // close the header menu when clicking anywhere else in the chat
  chatMain.addEventListener("click", (e) => {
    if (!e.target.closest(".header-menu, .header-more-btn")) closeHeaderMenu();
  });

  async function send() {
    const raw = textarea.value.trim();
    if (busy && raw) return toast("Une génération est déjà en cours…", "warn", 2000);
    if (!raw || busy) return;
    const slash = parseSlash(raw);
    textarea.value = "";
    textarea.style.height = "auto";
    if (slash) {
      if (slash.action) { await slash.action(); return; }
      if (!slash.prompt) return toast(slash.display); // invalid dice syntax → hint only
      await doStream(slash.display, { prompt: slash.prompt });
    } else {
      await doStream(raw);
    }
  }

  async function toggleGroup() {
    const next = !currentConversation.group_mode;
    await api(`/api/conversations/${convId}`, { method: "PATCH", body: { group_mode: next } });
    await refreshConversation(convId);
    renderChat(convIdRaw);
    toast(next ? "Mode groupe activé — tous les personnages parlent." : "Mode solo activé.", "ok");
  }

  function convSettingsModal() {
    let convSettings = {};
    try { convSettings = JSON.parse(currentConversation.settings || "{}"); } catch { /* ignore */ }
    const personaName = currentConversation.persona?.name;
    const castNames = (currentConversation.cards || []).map((c) => c.name).join(", ");

    // ── Modèle & génération ──
    const GENERATION_PRESETS = {
      cinematique: { label: "Cinématique", temperature: 0.95, maxTokens: 3000 },
      rapide: { label: "Rapide", temperature: 0.85, maxTokens: 1200 },
      canon: { label: "Fidèle au canon", temperature: 0.5, maxTokens: 2500 },
      chaotique: { label: "Chaotique", temperature: 1.2, maxTokens: 3000 },
      dialogue: { label: "Dialogue", temperature: 1.0, maxTokens: 2000 },
      horreur: { label: "Horreur", temperature: 0.9, maxTokens: 2500 },
      romance: { label: "Romance", temperature: 1.0, maxTokens: 2200 },
      narration_courte: { label: "Narration courte", temperature: 0.8, maxTokens: 900 },
    };
    const provider = field("Fournisseur", store.settings.provider || "lmstudio", { type: "select", options: [["lmstudio", "LM Studio (local)"], ["openrouter", "OpenRouter (cloud)"]] });
    const model = field("Modèle", convSettings.model || "", { placeholder: "Vide = défaut (ex: qwen2.5-7b, claude-3.5…)" });
    const presetSel = field("Preset de style", convSettings.preset || "", { type: "select", options: [["", "Par défaut (réglages manuels)"], ...Object.entries(GENERATION_PRESETS).map(([k, v]) => [k, v.label])] });
    const temp = field("Température", convSettings.temperature ?? 0.9, { type: "number", min: 0, max: 2, step: 0.1 });
    const maxTok = field("Max tokens", convSettings.max_tokens ?? 2048, { type: "number", min: 64, max: 8192, step: 64 });
    const ctxMax = field("Tours gardés en mémoire", convSettings.context_max_messages ?? store.settings.context_max_messages ?? 20, { type: "number", min: 4, max: 100, step: 1 });
    const autoValCb = el("label", { class: "setting-row" },
      el("span", { class: "lbl" }, "Vérifier la cohérence après chaque tour"),
      el("input", { type: "checkbox", ...(convSettings.validate_auto ? { checked: "" } : {}) }),
    );
    const diceCb = el("label", { class: "setting-row" },
      el("span", { class: "lbl" }, "Lancer des dés (/dice)"),
      el("input", { type: "checkbox", "aria-label": "Activer /dice", ...(convSettings.dice_enabled === false ? {} : { checked: "" }) }),
    );
    // choosing a preset pre-fills the temperature / max tokens fields (still editable)
    presetSel.input.addEventListener("change", () => {
      const p = GENERATION_PRESETS[presetSel.input.value];
      if (p) {
        temp.input.value = p.temperature;
        maxTok.input.value = p.maxTokens;
      }
    });

    // ── Contexte (estimation des tokens envoyés au modèle) ──
    const ctxLine = el("div", { class: "ctx-line" }, "⏳ estimation du contexte…");
    api(`/api/conversations/${convId}/context`).then((r) => {
      ctxLine.textContent = `≈ ${r.tokens.toLocaleString("fr-FR")} tokens · ${r.messageCount} messages (dont ${r.systemTokens.toLocaleString("fr-FR")} pour le prompt système)`;
    }).catch(() => { ctxLine.textContent = "Contexte indisponible."; });

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

    // ── Personnages présents (casting de la partie) ──
    let castIds = new Set();
    try { castIds = new Set((JSON.parse(currentConversation.cast || "[]") || []).map(Number)); } catch { /* ignore */ }
    const castFilter = el("input", { type: "search", class: "cast-filter", placeholder: "Filtrer…", "aria-label": "Filtrer les personnages" });
    const castList = el("div", { class: "cast-list" + (store.cards.length > 5 ? " many" : "") });
    const castCount = el("span", { class: "cast-count" });
    const paintCastCount = () => {
      const used = store.cards.filter((c) => castIds.has(c.id)).length;
      castCount.textContent = used ? `${used} en scène` : "aucun en scène";
    };
    const paintCast = () => {
      const q = castFilter.value.trim().toLowerCase();
      castList.replaceChildren(...store.cards
        .filter((c) => !q || (c.name || "").toLowerCase().includes(q) || (c.description || "").toLowerCase().includes(q))
        .map((c) => {
          const cb = el("input", { type: "checkbox", "aria-label": "En scène : " + c.name, ...(castIds.has(c.id) ? { checked: "" } : {}) });
          cb.addEventListener("change", () => {
            if (cb.checked) castIds.add(c.id); else castIds.delete(c.id);
            paintCastCount();
            paintCast();
          });
          const hue = nameHue(c.name || "?");
          const avatar = c.avatar
            ? el("img", { src: c.avatar, class: "avatar avatar-sm", alt: "" })
            : el("div", { class: "avatar avatar-sm cast-avatar", style: { background: `linear-gradient(135deg, hsl(${hue} 65% 45%), hsl(${(hue + 50) % 360} 75% 26%))` } }, (c.name || "?").charAt(0).toUpperCase());
          return el("label", { class: "cast-row" + (castIds.has(c.id) ? " on" : ""), title: c.description || c.personality || undefined },
            cb,
            avatar,
            el("span", { class: "cast-main" },
              el("span", { class: "cast-name" }, esc(c.name)),
              c.description ? el("small", { class: "cast-sub" }, esc(c.description.length > 64 ? c.description.slice(0, 64) + "…" : c.description)) : null,
            ),
          );
        }));
    };
    paintCastCount();
    paintCast();
    castFilter.addEventListener("input", paintCast);
    const allBtn = el("button", { class: "chip-btn slim", onclick: () => { castIds = new Set(store.cards.map((c) => c.id)); paintCastCount(); paintCast(); } }, "Tout");
    const noneBtn = el("button", { class: "chip-btn slim", onclick: () => { castIds = new Set(); paintCastCount(); paintCast(); } }, "Aucun");
    const castBox = el("div", { class: "cast-box" },
      el("div", { class: "cast-head" },
        el("span", { class: "cast-title" }, "Personnages en scène"),
        castCount,
      ),
      store.cards.length === 0
        ? el("p", { class: "cast-empty" }, "Aucune carte — importe des cartes dans l'onglet Cartes.")
        : el("div", { class: "cast-body" },
            el("div", { class: "cast-tools" }, castFilter, el("div", { class: "cast-tools-btns" }, allBtn, noneBtn)),
            castList,
          ),
    );

    // ── Mémoire des boucles (RE:ZERO) ──
    // narrator axis: how much the writer may reference rewound stretches.
    // player axis: whether the persona / characters know the loops happened.
    const loopSlider = (label, min, max, value, labels) => {
      const lbl = el("span", { class: "slider-lbl" }, labels[value] ?? String(value));
      const input = el("input", { type: "range", min, max, step: 1, value, "aria-label": label });
      input.addEventListener("input", () => { lbl.textContent = labels[Number(input.value)] ?? input.value; });
      return { wrap: el("div", { class: "loop-slider" },
        el("div", { class: "modal-line" },
          el("div", { class: "ml-txt" }, el("strong", {}, label), el("small", {}, labels.map((l, i) => (i === Number(input.value) ? null : l)).filter(Boolean).slice(0, 2).join(" · "))),
          lbl,
        ),
        input,
      ), input };
    };
    const loopNarr = loopSlider("Mémoire du Narrateur", 0, 3, Number(convSettings.loop_mem_narrator ?? 0),
      ["0 · Amnésie (ignorant)", "1 · Sait, n'en parle pas", "2 · Allusions discrètes", "3 · RE:ZERO assumé"]);
    const loopPlayer = loopSlider("Mémoire du joueur & PNJ", 0, 2, Number(convSettings.loop_mem_player ?? 0),
      ["0 · Personne ne le sait", "1 · Le perso se souvient (secret)", "2 · Souvenir partagé"]);
    const loopHint = el("p", { class: "modal-note" }, "Agit quand tu marques un checkpoint et que tu reviens dessus : la tentative abandonnée devient une « boucle » que le Narrateur peut (ou non) garder en mémoire.");

    const body = el("div", { class: "conv-settings" },
      el("div", { class: "modal-section" }, "Modèle & génération"),
      el("div", { class: "row" }, provider.wrap, model.wrap),
      presetSel.wrap,
      el("div", { class: "row3" }, temp.wrap, maxTok.wrap, ctxMax.wrap),
      autoValCb,
      diceCb,
      ctxLine,
      el("div", { class: "modal-section" }, "Mode de jeu"),
      el("div", { class: "row" }, el("div", { class: "modal-line" },
        el("div", { class: "ml-txt" }, el("strong", {}, "Faire jouer tous les personnages"), el("small", {}, "Groupe : chacun réagit à la scène · Solo : un personnage principal")),
        seg,
      )),
      el("div", { class: "modal-section" }, "Mémoire des boucles (retour temporel)"),
      loopNarr.wrap, loopPlayer.wrap, loopHint,
      el("div", { class: "modal-section" }, "Personnages en scène"),
      castBox,
      el("p", { class: "modal-note" }, "Ces réglages ne valent que pour cette partie. L'historique au-delà de la mémoire est résumé automatiquement par le modèle."),
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
          preset: presetSel.input.value,
          temperature: Number(temp.input.value),
          max_tokens: Number(maxTok.input.value),
          context_max_messages: Number(ctxMax.input.value),
          validate_auto: autoValCb.querySelector("input").checked,
          dice_enabled: diceCb.querySelector("input").checked,
          loop_mem_narrator: Number(loopNarr.input.value),
          loop_mem_player: Number(loopPlayer.input.value),
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

  // 🪄 avatar du narrateur — généré en arrière-plan, une seule fois par session
  maybeNarratorAvatar();
}

// ─── streaming a turn ─────────────────────────────────────────────────────────
async function doStream(content, opts = {}) {
  if (!currentConversation || !currentCtx) return;
  dismissRecapBanner(); // the player is playing on — the "Previously on…" has served its purpose
  const { scroll, textarea, sendBtn, stopBtn } = currentCtx;
  busy = true;
  stopRequested = false;
  // resolvable once, so stopStreaming() can await the full settle + reconcile
  currentStreamSettled = new Promise((res) => { streamSettledResolve = res; });
  sendBtn.disabled = true;
  if (stopBtn) stopBtn.hidden = false;
  const gen = ++streamGeneration;
  // idempotency key for this attempt: the SSE retry loop re-posts with the
  // SAME uid, so the server can drop a partially-committed exchange instead of
  // duplicating it
  const attemptUid = (typeof crypto !== "undefined" && crypto.randomUUID?.()) ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  // optimistic user bubble (display text may differ from the raw content)
  const displayText = opts.display || content;
  // animated dice roll on /dice messages (must be set before renderMessage)
  const userMsg = {
    id: `tmp-${Date.now()}`, role: "user", name: currentConversation.persona?.name || "Moi",
    content: displayText, segments: [], meta: {}, created_at: Date.now(),
    bubbleClass: displayText.startsWith("🎲 ") ? "dice-roll" : undefined,
  };
  const userNode = renderMessage(userMsg);
  scroll.append(userNode);

  const pending = { id: `pending-${Date.now()}`, role: "assistant", name: "…", content: "", segments: [], meta: {}, created_at: Date.now() };
  const pendingNode = renderMessage(pending);
  pendingNode.dataset.pending = "1";
  const bodyEl = pendingNode.querySelector(".body");
  const typing = el("div", { class: "typing" }, el("span"), el("span"), el("span"));
  bodyEl.append(typing);
  // visible "how long is the model thinking" timer
  const thinkEl = el("div", { class: "think-time" }, "⏱ 0s");
  bodyEl.append(thinkEl);
  const thinkStart = Date.now();
  const baseTitle = document.title;

  // beforeunload: prevent navigating away / closing the tab while streaming
  if (!beforeUnloadHandler) {
    beforeUnloadHandler = (e) => {
      if (busy) {
        e.preventDefault();
        e.returnValue = "";
        return "Une génération est en cours. Confirmer quitte la partie.";
      }
    };
    window.addEventListener("beforeunload", beforeUnloadHandler);
  }

  const thinkTimer = setInterval(() => {
    thinkEl.textContent = `⏱ ${Math.round((Date.now() - thinkStart) / 1000)}s`;
    // live progress in the tab title while the tab is hidden
    if (document.hidden) document.title = `⏳ ${Math.round((Date.now() - thinkStart) / 1000)}s · ${full.length} c. — ${baseTitle}`;
  }, 1000);
  scroll.append(pendingNode);
  scrollToBottom(scroll);
  sfx("whoosh");

  abortController = new AbortController();
  let full = "";
  // throttled incremental rendering: deltas only mark dirty state, a rAF pass
  // (≤ 1 per frame) diffs against what's already on screen and touches only
  // the last block — no full DOM rebuild per delta (long replies stay smooth)
  let renderedFull = "";
  let renderQueued = false;
  const renderDelta = () => {
    renderQueued = false;
    // stale generation guard: after Stop (or a newer turn), never touch the DOM
    if (gen !== streamGeneration || stopRequested) return;
    if (!full || full === renderedFull) return;
    renderedFull = full;
    if (bodyEl.dataset.streaming !== "1") {
      // first visible token: drop the typing dots + timer placeholder
      bodyEl.dataset.streaming = "1";
      bodyEl.replaceChildren();
    }
    const segs = splitBlocks(full);
    while (bodyEl.children.length > segs.length) bodyEl.lastChild?.remove();
    segs.forEach((b, i) => {
      const fresh = formatBody(b);
      if (i < bodyEl.children.length) {
        const node = bodyEl.children[i];
        if (node.textContent !== fresh.textContent) node.replaceChildren(fresh);
      } else {
        bodyEl.append(el("div", {}, fresh));
      }
    });
    scrollToBottom(scroll);
  };
  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderDelta);
  };
  try {
    // Connection blips are retried with backoff, but only while nothing has
    // been written yet — once the stream produces content (or completes), the
    // exchange is committed server-side and re-posting would duplicate it.
    const MAX_SSE_RETRIES = 2;
    for (let sseAttempts = 0; sseAttempts <= MAX_SSE_RETRIES; sseAttempts++) {
      if (abortController?.signal.aborted) return;
      try {
        const res = await apiFetch(`/api/conversations/${currentConversation.id}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, directive: opts.directive || "", prompt: opts.prompt || "", uid: attemptUid }),
          signal: abortController.signal,
        });
    let streamDone = false; // an "error" after "done" is never a failure (turn committed)
    await readSseStream(res, async (event, data) => {
      if (gen !== streamGeneration || stopRequested) return; // stale generation (Stop / newer turn)
      if (event === "delta") {
        full += data.text || "";
        scheduleRender();
      } else if (event === "done") {
        streamDone = true;
        sfx("chime");
        if (document.hidden) notify("Réponse prête ✨", (currentConversation?.title || "Partie") + " — " + (data.message?.content || "").slice(0, 80));
        const m = data.message;
        bodyEl.replaceChildren();
        const segs = m.segments?.length ? m.segments : [];
        for (const s of segs) {
          bodyEl.append(el("div", {}, formatSegment(s)));
        }
        if (segs.length === 0) bodyEl.append(el("div", {}, formatBody({ type: "text", text: full })));
        pendingNode.dataset.mid = m.id;
        // replace pending with final markup
        const node = renderMessage({ ...m, segments: segs });
        pendingNode.replaceWith(node);
        scrollToBottom(scroll);
        // keep the scene-state panel fresh (throttled server-side)
        sceneRefreshHook?.();
        // optional auto-coherence check (opt-in in the party settings, throttled)
        maybeAutoValidate();
        // background but SEQUENCED (not fire-and-forget): maybeChapter may
        // re-render the chat, so the NPC/relations hooks must run afterwards to
        // attach their UI to the fresh DOM (each is server-throttled)
        try { await maybeChapter(); } catch { /* non-blocking */ }
        try { await maybeNpcSuggest(); } catch { /* non-blocking */ }
        try { await maybeRelations(); } catch { /* non-blocking */ }
      } else if (event === "suggestions") {
        const { messageId, suggestions } = data;
        if (messageId) turnSuggestionsMsgId = messageId;
        if (suggestions?.length) renderChips(suggestions);
      } else if (event === "error") {
        if (streamDone) { console.warn("[chat] erreur signalée après done — tour déjà validé, ignoré:", data.message); return; }
        throw new Error(data.message || "Erreur inconnue");
      }
    });
        // Stream ended without a "done" event and the user didn't press Stop:
        // the connection was cut (network blip, server restart, idle timeout…)
        // and the turn was never committed — surface it like any other failure
        // instead of leaving the "…" bubble hanging with the timer running.
        if (!streamDone && !stopRequested && !abortController?.signal.aborted) {
          throw new Error("La connexion au modèle a été coupée — réponse incomplète. Réessaie.");
        }
        await refreshAll();
        // keep the open party's state (messages, meta) fresh so actions on the
        // newest reply — Régénérer, favori, note, réactions — can find it
        if (currentConversation?.id) {
          const fresh = await api(`/api/conversations/${currentConversation.id}`).catch(() => null);
          if (fresh) {
            currentConversation = fresh;
            const ci = store.conversations.findIndex((c) => c.id === fresh.id);
            if (ci >= 0) store.conversations[ci] = fresh;
            else store.conversations.unshift(fresh);
          }
        }
        // after a completed turn, make sure the player always has fresh
        // response suggestions (the SSE push can miss them when a chapter or
        // sidebar card becomes the last message, or the model returned nothing)
        scheduleAutoSuggestions();
        break; // stream finished cleanly — never re-post
      } catch (e) {
        if (e.name === "AbortError" || abortController?.signal.aborted) return;
        // transient network failure before any content → retry with backoff;
        // once tokens flowed the server already committed the exchange
        if (!full && sseAttempts < MAX_SSE_RETRIES && /fetch|network|ECONN|socket|timeout/i.test(String(e?.message ?? e))) {
          toast(`Connexion au modèle perdue — nouvelle tentative (${sseAttempts + 1}/${MAX_SSE_RETRIES})…`, "warn");
          await new Promise((r) => setTimeout(r, 2000 * (sseAttempts + 1)));
          continue;
        }
        if (document.hidden) notify("⚠️ Erreur", String(e.message || "Échec"));
        pendingNode.remove();
        const errNode = el("div", { class: "msg me", role: "alert", "aria-live": "assertive" },
          el("div", { class: "bubble", style: { borderColor: "var(--danger)", color: "var(--danger)" } },
            el("div", { style: { fontWeight: 700 } }, "⚠️ " + esc(e.message)),
            el("button", { class: "mini-btn", style: { marginTop: "8px" }, onclick: () => {
              // drop the stale optimistic bubble + error before re-posting;
              // keep the original opts so slash-command rewrites and
              // directives aren't lost on the retry
              userNode.remove();
              errNode.remove();
              doStream(content, opts);
            } }, "↻ Réessayer"),
          ),
        );
        scroll.append(errNode);
        scrollToBottom(scroll);
        break;
      }
    }
  } finally {
    clearInterval(thinkTimer);
    document.title = baseTitle;

    // restore beforeunload handler
    busy = false;
    if (sendBtn) sendBtn.disabled = false;
    if (stopBtn) stopBtn.hidden = true;
    window.removeEventListener("beforeunload", beforeUnloadHandler);
    beforeUnloadHandler = null;
    // Stop pressed: drop the stale optimistic bubbles — the stopStreaming()
    // reconcile re-renders the conversation from the server's committed state
    // (partial reply kept, or the user turn removed if nothing was written)
    if (stopRequested) {
      pendingNode?.remove();
      userNode?.remove();
    }
    streamSettledResolve?.();
    streamSettledResolve = null;
    currentStreamSettled = null;
    textarea?.focus();
  }
}

// ─── micro-sfx (synthesized, zero assets) ─────────────────────────────────────
let _audioCtx = null;
function sfx(kind) {
  try {
    if (window.__aiRpSettings?.sound_effects === false && store?.settings?.sound_effects === false) return;
    const allowed = store?.settings?.sound_effects !== false;
    if (!allowed) return;
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;
    if (kind === "whoosh") {
      // short filtered noise sweep going up
      const dur = 0.28;
      const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = "bandpass";
      filt.frequency.setValueAtTime(300, t);
      filt.frequency.exponentialRampToValueAtTime(2200, t + dur);
      filt.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(filt).connect(g).connect(ctx.destination);
      src.start(t);
    } else if (kind === "chime") {
      // two soft sine notes (E5→A5)
      [659.25, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const g = ctx.createGain();
        const start = t + i * 0.14;
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(0.09, start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, start + 0.6);
        osc.connect(g).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.65);
      });
    }
  } catch { /* sfx is best-effort */ }
}

// ─── notifications (tab hidden → OS notification + title flash) ───────────────
function notify(title, body) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch { /* ignore */ }
  const orig = document.title;
  let n = 0;
  const flash = setInterval(() => {
    document.title = n++ % 2 ? orig : "🔔 " + title;
    if (n >= 8) { clearInterval(flash); document.title = orig; }
  }, 700);
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
  const grid = el("div", { class: "chips-grid" });
  // 4 max: keeps the cards on one full-width row — a 5th would wrap alone on a
  // second line and leave the grid looking half-empty next to the composer.
  // A click anywhere on the card only fills the composer (editable); each card
  // carries its own ➤ button for sending straight away.
  suggestions.slice(0, 4).forEach((s, i) => {
    grid.append(el("div", { class: "chip-btn", style: { animationDelay: `${i * 70}ms` } },
      el("button", { class: "chip-main", title: "Mettre dans la zone de saisie (modifiable)", onclick: () => fillComposerFromChip(s) },
        el("span", { class: "chip-icon" }, chipIcon(s)),
        el("span", { class: "chip-text" }, esc(s)),
      ),
      el("button", { class: "chip-send", title: "Envoyer cette suggestion", "aria-label": "Envoyer cette suggestion", onclick: () => sendSuggestionFromChip(s) }, "➤"),
    ));
  });
  chipsRow.append(grid);
}

// ─── automatic chips after each completed turn ───────────────────────────────
// Fired once the stream fully closed (server background generation included):
// if the SSE "suggestions" push covered the last assistant reply — or its meta
// already carries chips — we simply display them. Otherwise (push lost, a
// chapter/sidebar card became the last message, background returned nothing)
// we ask the server once so suggestions never silently stay away.
let autoSuggestTimer = null;
function scheduleAutoSuggestions() {
  if (!currentConversation?.id) return;
  const convId = currentConversation.id;
  clearTimeout(autoSuggestTimer);
  autoSuggestTimer = setTimeout(async () => {
    if (busy || currentConversation?.id !== convId) return;
    const msgs = currentConversation.messages || [];
    const lastAssist = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!lastAssist) return;
    if (turnSuggestionsMsgId === lastAssist.id) return; // SSE already delivered chips
    if (Array.isArray(lastAssist.meta?.suggestions) && lastAssist.meta.suggestions.length) {
      renderChips(lastAssist.meta.suggestions);
      return;
    }
    const res = await api(`/api/conversations/${convId}/suggestions`, { method: "POST", body: {} }).catch(() => null);
    if (!res?.suggestions?.length || busy || currentConversation?.id !== convId) return;
    renderChips(res.suggestions);
  }, 450);
}

function fillComposerFromChip(text) {
  // clicking a suggestion never sends it — it loads into the composer so the
  // player can tweak it before hitting the send button (or Enter)
  const ctx = currentCtx;
  if (!ctx) return;
  const ta = ctx.textarea;
  ta.value = text;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  ta.focus();
  ta.setSelectionRange(text.length, text.length);
}

async function sendSuggestionFromChip(text) {
  const ctx = currentCtx;
  if (!ctx || busy) return;
  // the sent text must not stay behind in the composer
  ctx.textarea.value = "";
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
    let cs = {};
    try { cs = JSON.parse(currentConversation?.settings || "{}"); } catch { /* ignore */ }
    if (cs.dice_enabled === false) return { display: "🎲 Les dés sont désactivés dans les réglages de la partie.", prompt: "" };
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
  if (cmd === "/checkpoint") {
    return { display: `📌 Checkpoint${rest ? " — " + rest : ""}`, prompt: "", action: () => checkpointModal(rest) };
  }
  if (cmd === "/return") {
    return { display: "🔁 Retour au checkpoint", prompt: "", action: async () => rewindModal() };
  }
  return { display: `⚠️ Commande inconnue : ${cmd} — disponibles : /dice, /ooc, /narrate, /card, /checkpoint, /return`, prompt: "" };
}

// interpellation: ask the narrator or a specific character to speak
async function askToSpeak(target) {
  if (busy) return toast("Attends la fin de la génération en cours…", "warn", 2000);
  const narrator = target === "narrateur";
  const display = narrator ? "🎙 Le narrateur prend la parole" : `🎙 ${target} prend la parole`;
  const directive = narrator
    ? "Le narrateur intervient maintenant : décris la scène et fais avancer l'histoire par une narration riche et immersive. Rappel : le narrateur ne parle jamais, il ne fait que raconter — aucun dialogue, aucune adresse directe."
    : `${target} prend la parole maintenant : décris ce que ${target} fait, pense et ressent, puis écris sa réplique. Les autres personnages restent en retrait.`;
  await doStream(display, { directive });
}

// ─── scene-state panel content ───────────────────────────────────────────────
function renderScenePanel(state, updatedAt, generate) {
  const box = el("div", { class: "scene-panel" });
  if (!state) {
    box.append(
      el("div", { class: "scene-empty" },
        el("span", {}, "🧭 Pas encore d'état de scène — un résumé structuré du lieu, des objectifs et des dangers, maintenu par le modèle."),
        el("button", { class: "mini-btn", onclick: generate }, ICONS.sparkles, "Générer l'état"),
      ),
    );
    return box;
  }
  const row = (icon, label, items) => {
    if (!items || (Array.isArray(items) && !items.length)) return null;
    const val = Array.isArray(items) ? items.join(" · ") : String(items);
    return el("div", { class: "scene-row" },
      el("span", { class: "scene-icon" }, icon),
      el("span", { class: "scene-label" }, label),
      el("span", { class: "scene-value" }, esc(val)),
    );
  };
  for (const n of [
    el("div", { class: "scene-head" },
      el("span", { class: "scene-title" }, "🧭 État de la scène"),
      el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
        updatedAt ? el("span", { class: "chip tiny" }, fmtTime(updatedAt)) : null,
        el("button", { class: "mini-btn", onclick: generate }, "↻ Actualiser"),
      ),
    ),
    row("📍", "Lieu", state.location),
    row("🎯", "Objectifs", state.goals),
    row("👥", "Présents", state.characters),
    row("⚠️", "Danger", state.dangers),
    row("🔒", "Secrets", state.secrets),
    state.notes ? el("div", { class: "scene-notes" }, esc(String(state.notes))) : null,
  ]) if (n) box.append(n);
  return box;
}

// human-friendly "il y a …" label for the time separators
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 2 * 3600 * 1000) return "";
  const min = Math.floor(diff / 60000);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `il y a ${d} jour${d > 1 ? "s" : ""}`;
  return new Date(ts).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

// ─── branch family (variantes) ───────────────────────────────────────────────
async function branchesModal() {
  if (!currentConversation) return;
  let data;
  try { data = await api(`/api/conversations/${currentConversation.id}/branches`); }
  catch (e) { return toast(e.message, "err"); }
  const branches = data.branches || [];
  const KIND_LABEL = { main: "principale", canon: "canon", alternative: "variante", draft: "brouillon", abandoned: "abandonnée" };
  const list = el("div", { class: "branch-list" });
  // build a tree: roots first (no parent in the family), then children by depth
  const childrenOf = (id) => branches.filter((b) => b.parent_id === id);
  const treeRows = () => {
    const byId = new Map(branches.map((b) => [b.id, b]));
    const out = [];
    const walk = (b, depth) => {
      out.push([b, depth]);
      for (const c of childrenOf(b.id)) walk(c, depth + 1);
    };
    for (const r of branches.filter((b) => !b.parent_id || !byId.has(b.parent_id))) walk(r, 0);
    return out;
  };
  const paint = () => { list.replaceChildren(...treeRows().map(([b, depth]) => branchRow(b, depth))); };
  const branchRow = (b, depth) => {
    const isCurrent = b.id === currentConversation.id;
    const kindSel = el("select", { class: "mini-select", title: "Statut de cette branche", "aria-label": "Statut" },
      Object.entries(KIND_LABEL).map(([k, l]) => el("option", { value: k, ...(b.branch_kind === k ? { selected: "" } : {}) }, l)),
    );
    kindSel.addEventListener("change", async () => {
      try {
        await api(`/api/conversations/${b.id}`, { method: "PATCH", body: { branch_kind: kindSel.value } });
        toast("Statut mis à jour ✓");
      } catch (e) { toast(e.message, "err"); }
    });
    const openBtn = el("button", { class: "mini-btn", title: "Ouvrir cette branche", onclick: () => { close(); navigate(`#/chat/${b.id}`); } }, ICONS.play);
    const cmpBtn = el("button", { class: "mini-btn", title: "Comparer avec cette variante puis fusionner l'état (canon, quêtes, relations, scène, mémoire)", onclick: () => { close(); compareModal(currentConversation, b); } }, "⇄");
    const delBtn = el("button", { class: "mini-btn", style: { color: "var(--danger)" }, title: "Supprimer définitivement", onclick: async () => {
      if (!(await confirmModal({ title: "Supprimer la variante", message: `Supprimer définitivement « ${b.title} » ainsi que ses illustrations ?` }))) return;
      try {
        await api(`/api/conversations/${b.id}/permanent`, { method: "DELETE" });
        data.branches = data.branches.filter((x) => x.id !== b.id);
        paint();
      } catch (e) { toast(e.message, "err"); }
    } }, ICONS.trash);
    const kids = childrenOf(b.id).length;
    const row = el("div", { class: "branch-row" + (isCurrent ? " cur" : "") + (depth ? " branch-child" : " branch-root") },
      el("span", { class: "branch-icon" }, b.branch_kind === "canon" ? "⭐" : b.parent_id ? "🌿" : "🌳"),
      el("div", { class: "branch-main" },
        el("div", { class: "branch-title" }, esc(b.title || "Partie"), isCurrent ? el("span", { class: "chip tiny" }, "actuelle") : null,
          kids ? el("span", { class: "chip tiny" }, `${kids} enfant${kids > 1 ? "s" : ""}`) : null),
        el("div", { class: "branch-sub" }, fmtTime(b.updated_at)),
      ),
      kindSel,
      openBtn,
      cmpBtn,
      delBtn,
    );
    row.style.setProperty("--depth", String(depth));
    return row;
  };
  const graphBtn = el("button", { class: "btn btn-ghost btn-sm", title: "Vue complète en arbre de la famille de branches", onclick: () => { close(); navigate(`#/graph/${currentConversation.id}`); } }, "🌿 Ouvrir le graphe complet");
  const { close } = openModal({
    title: "🌿 Variantes de la partie",
    sub: "Chaque « Régénérer » crée une variante. Explore-les, définis le canon, abandonne ou supprime celles qui ne servent plus.",
    body: el("div", {},
      el("div", { style: { display: "flex", justifyContent: "flex-end", marginBottom: "10px" } }, graphBtn),
      branches.length ? list : el("div", { class: "empty" }, el("div", { class: "big" }, "🌿"), el("h3", {}, "Une seule branche"), el("p", {}, "Régénère une réponse pour créer une variante.")),
    ),
    wide: true,
  });
  paint();
}

// ─── branch compare / merge (⇄) ──────────────────────────────────────────────
// Diffs CURATED state (canon, quests, relations, scene, memory) between the
// current branch and another variant — message histories are never concatenated.
// The player picks what to import and resolves conflicts per item.
async function compareModal(conv, other) {
  const convId = conv.id;
  // mirror of the server's assistKey: normalized key used for conflict ids
  const assistKey = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  let d;
  try { d = await api(`/api/conversations/${convId}/compare`, { method: "POST", body: { otherId: other.id } }); }
  catch (e) { return toast(e.message, "err"); }

  const conflicts = []; // { key, take: "theirs" } entries sent to the merge endpoint
  const chosen = new Map();
  const takeSel = (key, def) => {
    const cur = chosen.get(key) ?? def;
    const sel = el("select", { class: "mini-select", "aria-label": "Résoudre le conflit" },
      el("option", { value: "mine", ...(cur === "mine" ? { selected: "" } : {}) }, "garder le mien"),
      el("option", { value: "theirs", ...(cur === "theirs" ? { selected: "" } : {}) }, "prendre le leur"),
    );
    sel.addEventListener("change", () => {
      chosen.set(key, sel.value);
      const i = conflicts.findIndex((c) => c.key === key);
      if (sel.value === "theirs") { if (i < 0) conflicts.push({ key, take: "theirs" }); }
      else if (i >= 0) conflicts.splice(i, 1);
    });
    return el("div", { class: "cmp-take" }, "conflit :", sel);
  };
  const section = (title, ...children) => el("div", { class: "cmp-row" },
    el("div", { class: "cmp-row-head" }, el("strong", {}, title)),
    ...children,
  );
  const rows = el("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } });
  const include = { canon: false, quests: false, rels: false, scene: false, memory: false };
  const onlyCanon = new Set();

  // ── canon: per-item import + per-subject conflict resolution ──
  if (d.canon.added.length || d.canon.conflicts.length || d.canon.removed.length) {
    const kids = [];
    for (const e of d.canon.added) {
      const cb = el("input", { type: "checkbox", checked: "", "aria-label": "Importer ce fait" });
      cb.addEventListener("change", () => { if (cb.checked) onlyCanon.add(e.id); else onlyCanon.delete(e.id); });
      onlyCanon.add(e.id);
      kids.push(el("div", { class: "cmp-item" },
        el("label", {}, cb,
          el("div", {},
            el("strong", {}, esc(e.subject)), " — ",
            el("span", { class: "cmp-fact" }, esc(String(e.fact).slice(0, 160))),
            e.locked ? " 🔒" : "",
          ),
        ),
      ));
    }
    if (d.canon.conflicts.length) kids.push(el("div", { class: "cmp-note" },
      `Conflits : ${d.canon.conflicts.length} sujet${d.canon.conflicts.length > 1 ? "s" : ""} existe${d.canon.conflicts.length > 1 ? "nt" : ""} des deux côtés avec un fait différent.`,
    ));
    for (const c of d.canon.conflicts) {
      kids.push(el("div", { class: "cmp-item cmp-conflict" },
        el("div", { style: { flex: 1, minWidth: 0 } },
          el("strong", {}, esc(c.subject)),
          el("div", { class: "cmp-fact" }, `Mien : ${esc(String(c.mine.fact).slice(0, 120))}`),
          el("div", { class: "cmp-fact" }, `Leur : ${esc(String(c.theirs.fact).slice(0, 120))}`),
        ),
        takeSel(`canon:${assistKey(c.subject)}`, "mine"),
      ));
    }
    if (d.canon.removed.length) kids.push(el("div", { class: "cmp-note" },
      `Faits présents seulement ici (inchangés) : ${d.canon.removed.map((r) => r.subject).join(", ")}`,
    ));
    rows.append(section(`📖 Canon — ${d.canon.added.length} à importer`, ...kids));
    include.canon = true;
  }

  // ── quests ──
  const qOther = d.state.quests.other || [];
  if (qOther.length) {
    const qCb = el("input", { type: "checkbox", checked: "", "aria-label": "Reprendre les quêtes" });
    qCb.addEventListener("change", () => { include.quests = qCb.checked; });
    const kids = [el("div", { class: "cmp-item" },
      el("label", {}, qCb, el("span", {}, `Reprendre les ${qOther.length} quête${qOther.length > 1 ? "s" : ""} de « ${esc(other.title)} » (celles déjà présentes gardent leur statut)`)),
    )];
    if ((d.state.quests.mine || []).length) kids.push(takeSel("quests", "mine"));
    rows.append(section("🗡 Quêtes", ...kids));
  }

  // ── relations ──
  const rOther = d.state.rels.other || [];
  if (rOther.length) {
    const rCb = el("input", { type: "checkbox", checked: "", "aria-label": "Reprendre les relations" });
    rCb.addEventListener("change", () => { include.rels = rCb.checked; });
    const kids = [el("div", { class: "cmp-item" },
      el("label", {}, rCb, el("span", {}, `Reprendre les ${rOther.length} relation${rOther.length > 1 ? "s" : ""} de « ${esc(other.title)} »`)),
    )];
    if ((d.state.rels.mine || []).length) kids.push(takeSel("rels", "mine"));
    rows.append(section("💞 Relations", ...kids));
  }

  // ── scene state / plan / memory ──
  if (d.state.scene.other || d.state.sceneControl.other) {
    const sCb = el("input", { type: "checkbox", checked: "", "aria-label": "Reprendre l'état de scène" });
    sCb.addEventListener("change", () => { include.scene = sCb.checked; });
    const desc = [
      d.state.scene.other ? `état de scène (${esc(d.state.scene.other.location || "sans lieu")}…)` : null,
      d.state.sceneControl.other ? "plan de scène persistant" : null,
    ].filter(Boolean).join(" et ");
    const kids = [el("div", { class: "cmp-item" },
      el("label", {}, sCb, el("span", {}, `Reprendre le ${desc} de « ${esc(other.title)} »`)),
    )];
    if (d.state.scene.mine || d.state.sceneControl.mine) kids.push(takeSel("scene", "mine"));
    rows.append(section("🧭 Scène (état + plan)", ...kids));
  }
  const otherMem = d.state.memory.other;
  if (otherMem && (otherMem.characters?.length || otherMem.location || otherMem.facts?.length || otherMem.goals?.length)) {
    const mCb = el("input", { type: "checkbox", checked: "", "aria-label": "Reprendre la mémoire" });
    mCb.addEventListener("change", () => { include.memory = mCb.checked; });
    const kids = [el("div", { class: "cmp-item" },
      el("label", {}, mCb, el("span", {}, "Reprendre la mémoire structurée de l'autre variante")),
    )];
    if (d.state.memory.mine) kids.push(takeSel("memory", "mine"));
    rows.append(section("🧠 Mémoire", ...kids));
  }

  if (!rows.children.length) rows.append(el("div", { class: "empty" },
    el("div", { class: "big" }, "✨"), el("h3", {}, "Rien de différent"),
    el("p", {}, "Les deux variantes partagent le même canon, les mêmes quêtes et le même état de scène."),
  ));

  const head = el("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "10px" } },
    el("div", { style: { color: "var(--text-dim)", fontSize: "12.5px" } },
      `${d.sharedMessages} messages en commun — divergence à partir du message #${d.divergedAt || "—"}`,
    ),
    el("span", { class: "chip" }, `${d.mine.messageCount} msgs ici · ${d.other.messageCount} msgs là-bas`),
  );

  const mergeBtn = el("button", { class: "btn btn-primary" }, "🔀 Fusionner la sélection");
  mergeBtn.addEventListener("click", async () => {
    if (!Object.values(include).some(Boolean)) return toast("Sélectionne au moins une catégorie à fusionner.", "err");
    mergeBtn.disabled = true;
    try {
      const r = await api(`/api/conversations/${convId}/merge`, { method: "POST", body: { fromId: other.id, include, onlyCanon: [...onlyCanon], conflicts } });
      const rep = r.report || {};
      toast(`Fusion ✓ · ${rep.canon} fait${rep.canon > 1 ? "s" : ""} canon · ${rep.quests} quête${rep.quests > 1 ? "s" : ""} · ${rep.rels} relation${rep.rels > 1 ? "s" : ""}` + (rep.scene ? " · scène" : "") + (rep.memory ? " · mémoire" : ""));
      close();
    } catch (e) { toast(e.message, "err"); mergeBtn.disabled = false; }
  });
  const cancelBtn = el("button", { class: "btn btn-ghost" }, "Annuler");
  const { close } = openModal({
    title: `⇄ Comparer avec « ${other.title} »`,
    sub: "Seul l'état est comparé (canon, quêtes, relations, scène, mémoire) — les fils de messages restent indépendants, rien n'est concaténé.",
    body: el("div", {}, head, rows),
    footer: [cancelBtn, mergeBtn],
    wide: true,
  });
  cancelBtn.addEventListener("click", close);
}

// ─── relationship graph (💞) — affinities that evolve during play ─────────────
// Data: conversation settings.rels, updated by the model after scenes (auto,
// throttled) or on demand. Rendered as a canvas graph: each node is a character
// (the persona is dashed), each directed pair a→b is scored -100…+100 and the
// edge colour follows the dominant feeling. Hovering an edge shows both
// directions; hovering a node highlights its links.
// Shared relations live-ref lives in memory-center.js (relationsRef.current).

async function relationsModal(convIn) {
  const pane = buildRelationsPane(convIn, timeAgo);
  openModal({
    title: "💞 Relations entre personnages",
    sub: "Ce que chaque personnage ressent pour les autres, mis à jour par le modèle à mesure que la partie avance. Survole un personnage ou un lien pour les détails.",
    body: pane.body,
    wide: true,
    onClose: () => { if (relationsRef.current?.refresh === pane.refresh) relationsRef.current = null; },
  });
  relationsRef.current = { refresh: pane.refresh };
  await pane.refresh();
  // the modal may still be animating → recompute the layout once it settles
  requestAnimationFrame(pane.redraw);
}

async function memoryModal() {
  if (!currentConversation) return;
  let conv;
  try { conv = await api(`/api/conversations/${currentConversation.id}`); }
  catch (e) { return toast(e.message, "err"); }
  let closeModal = null;
  const pane = buildMemoryPane(conv, () => closeModal?.(), syncCurrentMemory);
  const { close } = openModal({
    title: "🧠 Mémoire structurée",
    sub: currentConversation.title || "",
    body: pane,
    wide: true,
  });
  closeModal = close;
}

// ─── player-owned canon (📖) ─────────────────────────────────────────────────
// Facts the player pins or approves are injected into the prompt AHEAD of the
// generated memory and summaries: they are the narrative authority. AI
// proposals land here as « proposé » and must be approved to take effect.
async function canonModal() {
  if (!currentConversation) return;
  const pane = buildCanonPane(currentConversation.id);
  openModal({
    title: "📖 Faits canoniques",
    sub: currentConversation.title || "",
    body: pane.body,
    wide: true,
  });
  pane.load();
}

// ─── context inspector (📡) ───────────────────────────────────────────────────
// Shows EXACTLY what the model will receive at the next turn: the same system
// prompt and the same packed message list the server builds for generation.
async function contextModal() {
  if (!currentConversation) return;
  const convId = currentConversation.id;
  let r;
  try { r = await api(`/api/conversations/${convId}/context`); }
  catch (e) { return toast(e.message, "err"); }

  const bar = el("div", { class: "ctx-bar" }, el("div", { class: "ctx-fill", style: { width: `${Math.min(100, r.budget)}%` } }));
  const stat = (label, value) => el("div", { class: "ctx-stat" }, el("strong", {}, value), el("small", {}, label));
  const chips = el("div", { class: "ctx-chips" },
    el("span", { class: "chip" }, `📖 ${r.canon.count} faits canoniques`),
    r.directives.one_shot_dm ? el("span", { class: "chip" }, "🎮 directives DM actives") : null,
    r.directives.persistent_scene_control ? el("span", { class: "chip" }, "🧭 plan de scène actif") : null,
    r.summaryUsed ? el("span", { class: "chip" }, "📚 résumé utilisé") : null,
    r.memoryUsed ? el("span", { class: "chip" }, "🧠 mémoire utilisée") : null,
  );
  const sysBlock = el("details", { class: "ctx-block" },
    el("summary", {}, `📜 Prompt système (${r.systemTokens.toLocaleString("fr-FR")} tokens)`),
    el("pre", { class: "ctx-pre" }, esc(r.system)),
  );
  const msgs = el("div", { class: "ctx-msgs" });
  const shown = r.messages.slice(-20);
  msgs.replaceChildren(...shown.map((m) =>
    el("details", { class: "ctx-msg" },
      el("summary", {}, `${m.role === "user" ? "🧑 vous" : "🎭 narrateur"} · ${String(m.content).length} caractères`),
      el("pre", { class: "ctx-pre" }, esc(m.content)),
    ),
  ));

  openModal({
    title: "📡 Contexte envoyé au modèle",
    sub: "Ce que le modèle recevra au prochain tour : canon, directives, mémoire, résumé, puis messages récents.",
    body: el("div", { class: "ctx-body" },
      el("div", { class: "ctx-stats" },
        stat("tokens envoyés", r.tokens.toLocaleString("fr-FR")),
        stat("messages gardés", `${r.keptMessages} / ${r.messageCount}`),
        stat("budget tokens", r.budgetTokens.toLocaleString("fr-FR")),
        stat("plafond", r.capSource === "tokens" ? "tokens" : "tours"),
      ),
      bar,
      el("div", { class: "ctx-budget-note" }, `Budget utilisé : ${r.budget}%`),
      chips,
      sysBlock,
      el("div", { class: "ctx-block" },
        el("summary", {}, `💬 Messages envoyés (${r.messages.length} — aperçu des ${shown.length} derniers)`),
        msgs,
      ),
    ),
    wide: true,
  });
}

// ─── narrative consistency check (IA, button-triggered) ─────────────────────
async function validateModal() {
  if (!currentConversation) return;
  try {
    const r = await api(`/api/conversations/${currentConversation.id}/validate`, { body: {} });
    const findings = r.findings || [];
    if (!findings.length) {
      openModal({ title: "🛡 Cohérence", body: el("div", { class: "empty" }, el("div", { class: "big" }, "✨"), el("h3", {}, "Aucune incohérence détectée"), el("p", {}, "Le fil est cohérent selon le modèle.")) });
      return;
    }
    openFindings(findings);
  } catch (e) {
    toast(e.message, "err");
  }
}

// shared findings modal (button-triggered and auto-validate banner)
function openFindings(findings) {
  const sevIcon = { critical: "🔴", warning: "🟠", info: "🔵" };
  const lastAssist = [...(currentConversation.messages || [])].reverse().find((m) => m.role === "assistant");
  const body = el("div", { class: "val-list" }, findings.map((f) =>
    el("div", { class: `val-row sev-${f.severity || "info"}` },
      el("span", { class: "val-icon" }, sevIcon[f.severity] || "🔵"),
      el("div", { class: "val-main" },
        el("div", { class: "val-msg" }, esc(String(f.message || ""))),
        f.suggestion ? el("div", { class: "val-sugg" }, "💡 " + esc(String(f.suggestion))) : null,
      ),
    ),
  ));
  const closeBtn = el("button", { class: "btn btn-ghost" }, "Ignorer");
  const fixBtn = el("button", { class: "btn btn-primary" }, "↻ Corriger la réponse");
  const { close } = openModal({ title: "🛡 Incohérences détectées", sub: "Problèmes possibles relevés par le modèle — à toi de trancher.", body, footer: [closeBtn, fixBtn], wide: true });
  closeBtn.addEventListener("click", close);
  fixBtn.addEventListener("click", () => {
    close();
    if (lastAssist) regenerate(lastAssist.id);
    else toast("Rien à corriger.", "err");
  });
}

// ─── message rendering ────────────────────────────────────────────────────────
function renderMessage(m) {
  const isMe = m.role === "user";
  const isChapter = !isMe && m.meta?.chapter;
  const isRewind = !isMe && m.meta?.rewind;
  const marker = isChapter || isRewind;
  const isSystem = !isMe && (m.meta?.system || (m.name || "").toLowerCase() === "système" || (m.content || "").startsWith("[Système]"));
  const isDice = (m.content || "").startsWith("🎲 ") || m.meta?.dice;
  // distinct accessible kind per message — screen readers announce the role,
  // CSS can target each kind without relying on color/italics/emoji alone
  const kind = marker ? (isChapter ? "chapter" : "rewind") : isSystem ? "system" : isDice ? "dice" : isMe ? "user" : "narrator";
  const segs = m.segments || [];
  const body = el("div", { class: "body" });
  if (isChapter) {
    const [head, ...rest] = (m.content || "").split("\n\n");
    body.append(el("div", { class: "chapter-head", role: "heading", "aria-level": "2" }, esc(head || "")));
    if (rest.length) body.append(el("div", { class: "chapter-summary" }, esc(rest.join("\n\n"))));
  } else if (isRewind) {
    body.append(el("div", { class: "rewind-head", role: "note" }, esc(m.content)));
  } else if (isMe) {
    body.append(el("div", { "data-kind": "user" }, esc(m.content)));
  } else if (segs.length) {
    for (let i = 0; i < segs.length; i++) {
      body.append(el("div", { class: `seg seg-${i}`, "data-kind": segs[i].type || "text" }, formatSegment(segs[i])));
    }
  } else if (m.content) {
    for (const b of splitBlocks(m.content)) body.append(el("div", { "data-kind": b.type || "text" }, formatBody(b)));
  }
  const bubble = el("div", { class: "bubble" + (m.bubbleClass ? " " + m.bubbleClass : "") + (marker ? " chapter-bubble rewind-bubble" : ""), ...(!marker ? { title: "Double-clic pour modifier" } : {}) },
    isMe || marker ? null : el("div", { class: "who" }, esc(m.name || "Narrateur")),
    body,
  );
  // double-click → inline edit (Enter valide, Échap annule)
  const midStr = String(m.id || "");
  if (!marker && !midStr.startsWith("tmp-") && !midStr.startsWith("pending")) {
    bubble.addEventListener("dblclick", (e) => {
      if (e.target.closest("button, a, img")) return;
      startEdit(m, body, bubble);
    });
  }
  if (!marker && !isMe && m.meta?.image) {
    const altText = m.meta.image_char
      ? `Illustration : ${m.meta.image_char}`
      : (m.content || "").replace(/[*"«»]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "Illustration de la scène";
    const illu = el("div", { class: "msg-illu" },
      el("img", { src: m.meta.image, alt: altText, loading: "lazy" }),
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
  if (!marker && !isMe && m.id && !String(m.id).startsWith("pending")) {
    bubble.append(el("div", { class: "msg-actions" }, ...messageActions(m.id)));
  }
  // private note (visible only to the player, never sent to the model)
  if (!marker && m.meta?.note && !String(m.id).startsWith("pending")) {
    bubble.append(el("div", { class: "msg-note" }, "📌 " + esc(m.meta.note)));
  }
  // emoji reactions (kept server-side in meta.reactions)
  if (!marker && m.id && !String(m.id).startsWith("pending")) {
    const list = Array.isArray(m.meta?.reactions) ? m.meta.reactions : [];
    const reacts = el("div", { class: "reactions" });
    for (const r of ["👍", "❤️", "😂"]) {
      const on = list.includes(r);
      const btn = el("button", { class: "reaction" + (on ? " on" : ""), title: on ? "Retirer la réaction" : "Réagir", "aria-pressed": String(on), "aria-label": (on ? "Retirer " : "Réagir avec ") + r }, r);
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/conversations/${currentConversation.id}/messages/${m.id}/reactions`, {
            method: on ? "DELETE" : "POST", body: { emoji: r },
          });
          const fresh = await api(`/api/conversations/${currentConversation.id}`);
          const nm = fresh.messages.find((x) => x.id === m.id) || m;
          const i = currentConversation.messages.findIndex((x) => x.id === m.id);
          if (i >= 0) currentConversation.messages[i] = nm;
          const node = document.querySelector(`[data-mid="${CSS.escape(String(m.id))}"]`);
          node?.replaceWith(renderMessage(nm));
        } catch (e) { toast(e.message, "err"); }
      });
      reacts.append(btn);
    }
    bubble.append(reacts);
  }
  const avatar = marker ? null : avatarFor(m);
  const node = el("div", {
    class: `msg${isMe ? " me" : ""}${marker ? " chapter" : ""}${selectedIds.has(m.id) ? " sel" : ""}`,
    dataset: { mid: m.id, role: m.role, kind },
    ...(kind === "dice" ? { role: "status" } : {}),
  }, avatar, bubble);
  if (selectionMode && m.id && !String(m.id).startsWith("pending")) {
    const cb = el("input", { type: "checkbox", class: "sel-cb", "aria-label": "Sélectionner ce message", ...(selectedIds.has(m.id) ? { checked: "" } : {}) });
    cb.addEventListener("change", () => {
      if (cb.checked) selectedIds.add(m.id); else selectedIds.delete(m.id);
      node.classList.toggle("sel", cb.checked);
      paintSelectionBar();
    });
    node.prepend(cb);
  }
  return node;
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

// deterministic hue per name → each speaker keeps a recognizable color
function nameHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

function initialAvatar(name, glyph) {
  const hue = nameHue(name || "?");
  return el("div", {
    class: "avatar avatar-md init-avatar",
    style: {
      background: `linear-gradient(135deg, hsl(${hue} 65% 45%), hsl(${(hue + 50) % 360} 75% 26%))`,
      display: "grid", placeItems: "center", color: "#fff", fontWeight: 800,
      fontSize: "15px", textShadow: "0 1px 3px rgba(0,0,0,.35)",
    },
  }, glyph || (name || "?").charAt(0).toUpperCase());
}

// 🪄 avatar du narrateur : généré une fois (lazily) dès qu'une partie contient
// de la narration, puis stocké globalement dans les réglages pour toutes les
// parties. Le narrateur reste un rôle spécial (jamais une carte) — c'est lui
// qui raconte, il n'entre pas dans le casting.
async function maybeNarratorAvatar() {
  if (narratorAvatarPending || store.settings?.narrator_avatar) return;
  const conv = currentConversation;
  const msgs = conv?.messages || [];
  const hasNarrator = msgs.some((m) => m.role !== "user" && (!m.name || String(m.name).toLowerCase() === "narrateur"));
  if (!hasNarrator) return;
  narratorAvatarPending = true;
  try {
    const r = await api("/api/cards/generate-avatar", {
      body: {
        name: "Narrateur",
        description: "Le narrateur omniscient d'un récit fantastique : une silhouette éthérée et voilée de lumière, tenant un vieux grimoire ouvert d'où s'échappent des volutes d'encre et des étoiles, visage indistinct, ambiance mystique, fond sombre.",
        personality: "Raconte, ne parle jamais : narration immersive, posée et omnisciente.",
      },
    });
    if (r?.image) {
      const s = await api("/api/settings", { method: "PATCH", body: { narrator_avatar: r.image } });
      store.settings = s;
      toast("🪄 Avatar du narrateur généré ✓");
      if (!busy && currentConversation) await renderChat(currentConversation.id);
    }
  } catch (e) {
    toast("Avatar du narrateur non généré : " + (e?.message || "serveur d'images indisponible"), "warn");
  }
}

function avatarFor(m) {
  if (m.role === "user") {
    const p = currentConversation?.persona;
    if (p?.avatar) return el("img", { src: p.avatar, class: "avatar avatar-md" });
    return initialAvatar(p?.name || "Moi", "🧝");
  }
  const card = (currentConversation?.cards || []).find((c) => String(c?.name || "").toLowerCase() === String(m.name || "").toLowerCase());
  if (card?.avatar) return el("img", { src: card.avatar, class: "avatar avatar-md" });
  const name = m.name || "Narrateur";
  const isNarrator = name.toLowerCase() === "narrateur" || (!card && !m.name);
  if (isNarrator && store.settings?.narrator_avatar) return el("img", { src: store.settings.narrator_avatar, class: "avatar avatar-md" });
  return initialAvatar(name, isNarrator ? "🪄" : null);
}

async function copyText(text, label) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // non-secure context fallback
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch { ok = false; }
  }
  toast((label || "Message") + (ok ? " copié ✓" : " — copie impossible"), ok ? "ok" : "err");
}

function messageActions(messageId) {
  const m = (currentConversation?.messages || []).find((x) => x.id === messageId) || {};
  const favBtn = el("button", { class: "mini-btn" + (m.meta?.bookmark ? " on" : ""), title: m.meta?.bookmark ? "Retirer des favoris" : "Ajouter aux favoris", onclick: async () => {
    try {
      const updated = await api(`/api/conversations/${currentConversation.id}/messages/${messageId}`, { method: "PATCH", body: { meta: { bookmark: m.meta?.bookmark ? 0 : 1 } } });
      const idx = currentConversation.messages.findIndex((x) => x.id === messageId);
      if (idx >= 0) currentConversation.messages[idx] = updated;
      document.querySelector(`[data-mid="${CSS.escape(String(messageId))}"]`)?.replaceWith(renderMessage(updated));
    } catch (e) { toast(e.message, "err"); }
  } }, "★");
  const noteBtn = el("button", { class: "mini-btn" + (m.meta?.note ? " on" : ""), title: m.meta?.note ? "Modifier la note privée" : "Ajouter une note privée", onclick: () => noteModal(m) }, "📌");
  const copyBtn = el("button", { class: "mini-btn", title: "Copier le message", onclick: () => {
    const mm = (currentConversation?.messages || []).find((x) => x.id === messageId);
    copyText(mm?.content || "", "Message");
  } }, "📋 Copier");
  const illuSel = el("select", { class: "mini-select", title: "Générer une illustration (auto / paysage / personnage)" },
    el("option", { value: "auto" }, "🖼 Illustrer"),
    el("option", { value: "landscape" }, "🏞 Paysage"),
    el("option", { value: "character" }, "🎭 Personnage"),
  );
  illuSel.addEventListener("change", async (e) => {
    const kind = e.target.value;
    illuSel.value = "auto";
    if (!kind) return;
    illuSel.disabled = true;
    try {
      await api(`/api/conversations/${currentConversation.id}/messages/${messageId}/image`, {
        body: kind === "auto" ? {} : { kind },
      });
      toast(kind === "landscape" ? "Paysage généré ✓" : kind === "character" ? "Illustration du personnage ✓" : "Illustration générée ✓");
      renderChat(currentConversation.id);
    } catch (err) { toast(err.message, "err"); }
    finally { illuSel.disabled = false; }
  });
  const retryBtn = el("button", { class: "mini-btn regen-btn", onclick: () => regenerate(messageId) }, ICONS.retry, "Régénérer");
  return [favBtn, noteBtn, copyBtn, illuSel, retryBtn];
}

// private note on a message (stored in meta.note, never sent to the model)
async function noteModal(m) {
  const ta = el("textarea", { class: "edit-ta", rows: 3, placeholder: "Note privée — pour toi seul·e, jamais envoyée au modèle." }, m.meta?.note || "");
  const clearBtn = el("button", { class: "btn btn-ghost", style: { color: "var(--danger)" } }, "Effacer");
  const cancelBtn = el("button", { class: "btn btn-ghost" }, "Annuler");
  const saveBtn = el("button", { class: "btn btn-primary" }, "Enregistrer");
  const { close } = openModal({ title: "📌 Note privée", body: el("div", {}, ta), footer: [clearBtn, cancelBtn, saveBtn] });
  const save = async (note) => {
    try {
      const updated = await api(`/api/conversations/${currentConversation.id}/messages/${m.id}`, { method: "PATCH", body: { meta: { note } } });
      const idx = currentConversation.messages.findIndex((x) => x.id === m.id);
      if (idx >= 0) currentConversation.messages[idx] = updated;
      document.querySelector(`[data-mid="${CSS.escape(String(m.id))}"]`)?.replaceWith(renderMessage(updated));
      close();
      toast(note ? "Note enregistrée ✓" : "Note supprimée");
    } catch (e) { toast(e.message, "err"); }
  };
  cancelBtn.addEventListener("click", close);
  saveBtn.addEventListener("click", () => save(ta.value.trim()));
  clearBtn.addEventListener("click", () => save(""));
}

// keyboard shortcuts from within the chat (see app.js global handler)
export function chatShortcut(key) {
  const last = [...document.querySelectorAll(".msg[data-role='assistant']")].pop();
  if (key === "r") {
    last?.querySelector(".regen-btn")?.click();
  } else if (key === "e") {
    // same path as a double-click: inline editor on the last reply
    last?.querySelector(".bubble")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  } else if (key === "i") {
    const sel = last?.querySelector(".mini-select");
    if (sel) { sel.value = "auto"; sel.dispatchEvent(new Event("change")); }
  } else if (key === "g") {
    document.querySelector(".group-toggle")?.click();
  } else if (key === "/") {
    const ta = document.querySelector(".composer textarea");
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
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
    // spoken line: speaker attribution + quoted text, announced as dialogue
    const p = el("p", { "data-kind": "dialogue", class: "seg-dialogue" });
    p.append(el("strong", { class: "seg-speaker", style: { color: "var(--accent)" } }, esc(s.speaker) + " : "));
    p.append(el("span", { class: "seg-line" }, esc("« " + s.text + " »")));
    return p;
  }
  if (s.type === "narration") {
    // narrative description: real <em> (semantic emphasis), not just italic color
    return el("p", { "data-kind": "narration", class: "seg-narration" },
      el("em", { style: { color: "var(--text-dim)" } }, esc(s.text)),
    );
  }
  return el("p", { "data-kind": "text" }, esc(s.text));
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
    return el("em", { "data-kind": "narration", style: { fontStyle: "italic", color: "var(--text-dim)" } }, esc(b.text));
  }
  if (b.type === "dialogue") {
    return el("span", { "data-kind": "dialogue" }, "« " + esc(b.text) + " »");
  }
  // text block: separate name: "quoted" if present
  const mm = b.text.match(/^\s*([A-Za-zÀ-ÖØ-öø-ÿ'’ -]{1,40}?)\s*[::]\s*"([\s\S]*)"\s*$/);
  if (mm) {
    return el("span", { "data-kind": "dialogue" },
      el("strong", { style: { color: "var(--accent)" } }, esc(mm[1]) + " : "),
      "« " + esc(mm[2]) + " »",
    );
  }
  return el("span", { "data-kind": "text" }, esc(b.text));
}

// ─── mini character sheet on hover ───────────────────────────────────────────
// Hovering a speaker (message header, avatar or in-body name) opens a small
// sheet with their avatar, description and tags. Data comes from the cast / persona.
let sheetEl = null;
let sheetTimer = null;
let sheetLast = null;
function sheetDataFor(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return null;
  const card = (currentConversation?.cards || []).find((c) => c.name.toLowerCase() === lower);
  if (card) return { name: card.name, desc: card.description || "", avatar: card.avatar || "", tags: card.tags };
  const persona = currentConversation?.persona;
  if (persona && (lower === "joueur" || (persona.name.toLowerCase() === lower))) {
    return { name: persona.name, desc: persona.description || "", avatar: persona.avatar || "", tags: null };
  }
  return null;
}
function hideMiniSheet() {
  clearTimeout(sheetTimer);
  sheetEl?.remove();
  sheetEl = null;
}
function showMiniSheetFor(host) {
  const msgEl = host.closest(".msg");
  let name = null;
  if (host.classList.contains("who")) name = host.textContent.trim();
  else if (host.closest(".seg")) name = host.textContent.replace(/\s*:\s*$/, "").trim();
  else if (msgEl?.dataset.role === "user") name = "Joueur";
  else {
    const m = (currentConversation?.messages || []).find((x) => String(x.id) === String(msgEl?.dataset.mid));
    name = m?.name || null;
  }
  const data = sheetDataFor(name);
  if (!data) return;
  let tags = [];
  try { tags = Array.isArray(data.tags) ? data.tags : JSON.parse(data.tags || "[]"); } catch { /* ignore */ }
  sheetEl = el("div", { class: "mini-sheet", role: "tooltip" },
    el("div", { class: "mini-sheet-top" },
      data.avatar
        ? el("img", { src: data.avatar, class: "avatar avatar-md" })
        : el("div", { class: "avatar avatar-md init-avatar", style: { display: "grid", placeItems: "center", background: `linear-gradient(135deg, hsl(${nameHue(data.name)} 65% 45%), hsl(${(nameHue(data.name) + 50) % 360} 75% 26%))`, color: "#fff", fontWeight: 800 } }, (data.name || "?").charAt(0).toUpperCase()),
      el("span", { class: "mini-sheet-name" }, esc(data.name)),
    ),
    data.desc ? el("p", { class: "ms-desc" }, esc(data.desc)) : el("p", { class: "ms-desc muted" }, "Pas de description."),
    tags.length ? el("div", { class: "ms-tags" }, ...tags.slice(0, 6).map((t) => el("span", { class: "chip tiny" }, "#" + esc(t)))) : null,
  );
  document.body.append(sheetEl);
  const r = host.getBoundingClientRect();
  const pad = 10;
  let left = Math.min(r.left, window.innerWidth - sheetEl.offsetWidth - pad);
  let top = r.bottom + 8;
  if (top + sheetEl.offsetHeight > window.innerHeight - pad) top = r.top - sheetEl.offsetHeight - 8;
  sheetEl.style.left = Math.max(pad, left) + "px";
  sheetEl.style.top = Math.max(pad, top) + "px";
}
function initMiniSheets(scroll) {
  const TARGET = ".who, .avatar, .seg strong";
  scroll.addEventListener("mouseover", (e) => {
    const t = e.target.closest?.(TARGET);
    if (!t || !scroll.contains(t) || t.closest("button, a, .illu-meta")) return;
    if (t === sheetLast && sheetEl) return;
    sheetLast = t;
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(() => showMiniSheetFor(t), 200);
  });
  scroll.addEventListener("mouseout", (e) => {
    const t = e.target.closest?.(TARGET);
    if (t === sheetLast) { clearTimeout(sheetTimer); hideMiniSheet(); sheetLast = null; }
  });
  scroll.addEventListener("scroll", hideMiniSheet, { passive: true });
}
document.addEventListener("click", (e) => { if (sheetEl && !sheetEl.contains(e.target)) hideMiniSheet(); });

// ─── quest journal ───────────────────────────────────────────────────────────
// Objectives auto-extracted by the LLM on demand, editable by the player.
// Stored user-side only: never injected into the model prompt.
async function questModal(conv) {
  const convId = currentConversation.id;
  let quests = [];
  try { quests = JSON.parse(conv.settings || "{}").quests || []; } catch { /* ignore */ }
  const list = el("div", { class: "quest-list" });
  const STATUS = [
    ["active", "▶ En cours"], ["done", "✓ Accomplie"], ["dropped", "✗ Abandonnée"],
  ];
  const paint = () => {
    list.replaceChildren(...quests.map((q, i) => {
      const title = el("input", { class: "quest-title", value: q.title || "", "aria-label": "Titre de la quête" });
      title.addEventListener("input", () => { q.title = title.value; });
      const sel = el("select", { class: "quest-status", "aria-label": "Statut" },
        ...STATUS.map(([v, l]) => el("option", { value: v, ...(q.status === v ? { selected: "" } : {}) }, l)));
      sel.addEventListener("change", () => { q.status = sel.value; });
      const del = el("button", { class: "mini-btn", title: "Retirer cette quête", "aria-label": "Retirer", onclick: () => { quests.splice(i, 1); paint(); } }, ICONS.trash);
      return el("div", { class: "quest-row" }, title, sel, del);
    }));
  };
  paint();
  const status = el("div", { class: "assist-status", hidden: true });
  const analyzeBtn = el("button", { class: "btn btn-primary btn-sm" }, ICONS.sparkles, "Analyser avec l'IA");
  analyzeBtn.addEventListener("click", async () => {
    analyzeBtn.disabled = true;
    status.hidden = false;
    status.textContent = "✨ L'IA relit la partie…";
    try {
      const r = await api(`/api/conversations/${convId}/quests`, { body: { refresh: true } });
      quests = r.quests || [];
      paint();
      status.textContent = quests.length ? "Objectifs détectés ✓ — ajuste-les puis enregistre." : "Aucun objectif détecté pour l'instant.";
    } catch (e) { status.hidden = true; toast(e.message, "err"); }
    finally { analyzeBtn.disabled = false; }
  });
  const addBtn = el("button", { class: "btn btn-ghost btn-sm", onclick: () => { quests.push({ title: "", status: "active", notes: "" }); paint(); list.querySelector(".quest-title")?.focus(); } }, "＋ Ajouter");
  const cancelBtn = el("button", { class: "btn btn-ghost" }, "Fermer");
  const saveBtn = el("button", { class: "btn btn-primary" }, "Enregistrer");
  const { close } = openModal({
    title: "🗡 Journal de quêtes",
    body: el("div",
      el("p", { class: "modal-note" }, "Les objectifs détectés par l'IA à la lecture de la partie — ajuste-les ou ajoute les tiens. Ce journal est pour toi seul·e, jamais envoyé au modèle."),
      el("div", { class: "quest-actions" }, analyzeBtn, status),
      list,
      el("div", { style: { display: "flex", justifyContent: "flex-end" } }, addBtn),
    ),
    footer: [cancelBtn, saveBtn],
  });
  cancelBtn.addEventListener("click", close);
  saveBtn.addEventListener("click", async () => {
    try {
      await api(`/api/conversations/${convId}/quests`, { body: { quests: quests.map((q) => ({ title: q.title.trim(), status: q.status, notes: q.notes || "" })).filter((q) => q.title) } });
      close();
      toast("Journal de quêtes enregistré ✓");
    } catch (e) { toast(e.message, "err"); }
  });
}

// ─── game statistics ──────────────────────────────────────────────────────────
// Simple aggregates computed server-side from the message history.
async function statsModal(convId) {
  const body = el("div", { class: "stats-body" }, el("p", { class: "modal-note" }, "Calcul des statistiques…"));
  const { close } = openModal({ title: "📊 Statistiques de la partie", body, footer: [el("button", { class: "btn btn-ghost", onclick: close }, "Fermer")] });
  let s;
  try { s = await api(`/api/conversations/${convId}/stats`); }
  catch (e) { body.replaceChildren(el("p", { class: "modal-note" }, esc(e.message))); return; }
  const tile = (v, l) => el("div", { class: "stat-tile" }, el("strong", {}, v), el("span", {}, l));
  const speakers = (s.speakers || []).slice(0, 6);
  const maxC = speakers[0]?.count || 1;
  const days = s.days ? (s.days === 1 ? "1 jour" : `${s.days} jours`) : "aujourd'hui";
  body.replaceChildren(
    el("div", { class: "stat-grid" },
      tile(s.messages.toLocaleString("fr-FR"), "messages"),
      tile(s.user_msgs.toLocaleString("fr-FR"), "tes répliques"),
      tile(s.assistant_msgs.toLocaleString("fr-FR"), "réponses"),
      tile(s.words.toLocaleString("fr-FR"), "mots écrits"),
      tile(s.avg_words, "mots / message"),
      tile(s.images, "illustrations"),
      tile(s.bookmarks, "favoris"),
      tile(days, "de partie"),
    ),
    speakers.length ? el("div", { class: "stat-speakers" },
      el("h4", {}, "Personnages les plus présents"),
      ...speakers.map((sp) => {
        const pct = Math.round((sp.count / s.messages) * 100);
        const hue = nameHue(sp.name || "?");
        return el("div", { class: "speaker-row" },
          el("span", { class: "speaker-name" }, esc(sp.name)),
          el("div", { class: "speaker-bar" }, el("div", { style: { width: Math.max(4, pct) + "%", background: `hsl(${hue} 70% 55%)` } })),
          el("span", { class: "speaker-pct" }, `${sp.count} · ${pct}%`),
        );
      }),
    ) : null,
  );
}

// ─── time loops: checkpoints & rewind (RE:ZERO) ──────────────────────────────
// Mark a point of return; rewind to it strictly (state restored, doomed stretch
// shelved as an abandoned branch); the loop journal lists every rewind.
async function checkpointModal(note) {
  const conv = currentConversation;
  if (busy) { toast("Attends la fin de la génération.", "err"); return; }
  const input = el("input", { class: "field", placeholder: "Note optionnelle (ex : avant le duel, au café…)", value: note || "" });
  const okBtn = el("button", { class: "btn btn-primary" }, "📌 Marquer le checkpoint");
  const { close } = openModal({
    title: "📌 Marquer un checkpoint",
    sub: "Le fil actuel devient un point de retour. Tu pourras y revenir après (rewind), et l'histoire en cours sera conservée en boucle.",
    body: input,
    footer: [el("button", { class: "btn btn-ghost", onclick: close }, "Annuler"), okBtn],
  });
  okBtn.addEventListener("click", async () => {
    okBtn.disabled = true;
    try {
      const r = await api(`/api/conversations/${conv.id}/checkpoint`, { body: { note: input.value } });
      toast(`📌 Checkpoint ${r.checkpoint.n} marqué ✓`);
      close();
    } catch (e) { toast(e.message, "err"); okBtn.disabled = false; }
  });
}

async function rewindModal() {
  const conv = currentConversation;
  if (busy) { toast("Attends la fin de la génération.", "err"); return; }
  const okBtn = el("button", { class: "btn btn-danger" }, "🔁 Revenir au checkpoint");
  const { close } = openModal({
    title: "🔁 Revenir au checkpoint",
    sub: "Le fil depuis le dernier checkpoint sera TRONQUÉ (conserve une boucle de secours relançable). L'état du monde, la mémoire, les quêtes et l'état de scène REVIENNENT à leur valeur du checkpoint.",
    body: el("p", { class: "modal-note" }, "Le Narrateur garde une mémoire condensée de cette tentative — active-la via les réglages de la partie (mémoire des boucles). Cette action est enregistrée dans le journal des boucles."),
    footer: [el("button", { class: "btn btn-ghost", onclick: close }, "Annuler"), okBtn],
  });
  okBtn.addEventListener("click", async () => {
    okBtn.disabled = true;
    okBtn.textContent = "🔁 Retour en cours…";
    try {
      const r = await api(`/api/conversations/${conv.id}/return`, { body: {} });
      toast(`🔁 Retour effectué — boucle n°${r.loop.n} archivée ✓`);
      close();
      await refreshAll();
      renderChat(conv.id);
    } catch (e) { toast(e.message, "err"); okBtn.disabled = false; okBtn.textContent = "🔁 Revenir au checkpoint"; }
  });
}

async function loopsModal() {
  const conv = currentConversation;
  const list = el("div", { class: "loop-list" }, el("p", { class: "modal-note" }, "Chargement…"));
  const { close } = openModal({ title: "📔 Journal des boucles", sub: conv.title, body: list, footer: [el("button", { class: "btn btn-ghost", onclick: close }, "Fermer")], wide: true });
  let d;
  try { d = await api(`/api/conversations/${conv.id}/loops`); }
  catch (e) { list.replaceChildren(el("p", { class: "modal-note" }, esc(e.message))); return; }
  list.replaceChildren(
    ...(d.loops || []).slice().reverse().map((lp) => {
      const when = new Date(lp.at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      return el("div", { class: "loop-card" },
        el("div", { class: "loop-head" },
          el("strong", {}, `🔁 Boucle n°${lp.n} · ${lp.checkpoint_n ? `depuis le point ${lp.checkpoint_n}` : ""}`),
          el("small", {}, `${when}${lp.branch ? " · une copie de secours existe" : ""}`),
        ),
        el("div", { class: "loop-title" }, esc(lp.title || "")),
        el("p", { class: "loop-desc" }, esc(lp.summary || "")),
        lp.note ? el("div", { class: "loop-note" }, "📌 " + esc(lp.note)) : null,
        lp.branch
          ? el("div", { class: "loop-actions" }, el("button", { class: "btn btn-ghost btn-sm", onclick: () => { close(); location.hash = `#/chat/${lp.branch}`; } }, "↪ Rouvrir cette boucle"))
          : null,
      );
    }),
  );
  if (!d.loops?.length) list.append(el("div", { class: "empty" }, el("div", { class: "big" }, "📔"), el("h3", {}, "Aucune boucle"), el("p", {}, "Marque un checkpoint puis reviens-y : la tentative abandonnée sera consignée ici.")));
}

// ─── per-game lorebook (dynamic canon) ────────────────────────────────────────
// Facts the player pins as canon during play. Stored in the conversation
// settings (settings.lore_entries), injected into the system prompt when a
// trigger matches the recent fiction — exactly like a world lorebook.
async function loreModal() {
  const conv = currentConversation;
  if (!conv) return;
  let closeModal = null;
  const { pane } = buildLorePane(conv, () => closeModal?.());
  const { close } = openModal({
    title: "📚 Canon de la partie",
    sub: `${conv.title} · ces faits fixes du monde sont injectés dans le prompt quand leurs motifs apparaissent dans la fiction.`,
    body: pane,
    footer: [el("button", { class: "btn btn-ghost", onclick: () => close() }, "Fermer")],
    wide: true,
  });
  closeModal = close;
}

// Sync the header-owned conversation memory after a Memory Center save.
function syncCurrentMemory(convId, mem) {
  if (currentConversation && currentConversation.id === convId) currentConversation.memory = mem;
}

// ─── story chapters (automatic) ──────────────────────────────────────────────
// After every completed turn we ask the server to close a chapter once enough
// messages have piled up; the marker lands in the thread and the summary is
// injected into the system prompt (buildSystemPrompt « Chapitres précédents »).
async function maybeChapter() {
  const conv = currentConversation;
  if (!conv) return;
  const r = await api(`/api/conversations/${conv.id}/chapter`, { body: {} });
  if (r.created) {
    toast(`📖 Chapitre ${r.chapter.n} — ${r.chapter.title} ✓`);
    await refreshConversation(conv.id);
    await renderChat(conv.id);
  }
}

// ─── dynamic NPCs ────────────────────────────────────────────────────────────
// After each turn (throttled to 8 min) the model looks for secondary characters
// emerging from the fiction; the player can approve them into the cast, or ask
// for a fresh batch anytime via the header menu.
async function maybeNpcSuggest() {
  const conv = currentConversation;
  if (!conv || !conv.cards?.length) return;
  let cs = {};
  try { cs = JSON.parse(conv.settings || "{}"); } catch { /* ignore */ }
  if (Date.now() - Number(cs.npc_last_suggest || 0) < 8 * 60_000) return;
  cs.npc_last_suggest = Date.now();
  await api(`/api/conversations/${conv.id}`, { method: "PATCH", body: { settings: cs } }).catch(() => {});
  const r = await api(`/api/conversations/${conv.id}/npcs/suggest`, { body: {} }).catch(() => ({ npcs: [] }));
  if (r.npcs?.length) showNpcChips(r.npcs);
}

// 🎨 generic "accept an NPC into the party" flow (used by the suggestion chips
// AND the "Proposer un PNJ" modal): adds the card, refreshes, then generates
// an avatar for the new character in the background once the card exists.
async function acceptNpc(npc) {
  try {
    const r = await api(`/api/conversations/${currentConversation.id}/npcs/accept`, { body: { npc } });
    toast(`✨ ${npc.name} rejoint la partie ✓`);
    await refreshAll();
    await renderChat(currentConversation.id);
    const card = r?.card;
    if (card && !card.avatar) {
      autoCardAvatar(card.id, {
        name: card.name,
        description: card.description || "",
        personality: card.personality || "",
        scenario: card.scenario || npc.role || "",
        tags: "[]",
      }, async () => {
        // avatar prêt → rafraîchir la carte pour qu'elle apparaisse sur le cast
        try {
          const fresh = await refreshConversation(currentConversation.id);
          if (currentConversation?.id === fresh?.id) currentConversation = fresh;
        } catch { /* garde la copie courante ; l'avatar apparaîtra à la prochaine visite */ }
        if (!busy) await renderChat(currentConversation.id);
      });
    }
    return true;
  } catch (e) { toast(e.message, "err"); return false; }
}

// ─── relationship graph (auto, throttled server-side) ────────────────────────
// After each completed turn we ask the server to re-read the recent scenes and
// update the affinities between characters — silently: the server only scans
// when enough new story accumulated and enough time passed since the last one.
async function maybeRelations() {
  const conv = currentConversation;
  if (!conv || !conv.cards?.length) return;
  const r = await api(`/api/conversations/${conv.id}/relations`, { body: {} }).catch(() => null);
  // the graph modal is open → refresh it live; otherwise keep the scan silent
  if (r?.scanned) relationsRef.current?.refresh?.();
}

function showNpcChips(npcs) {
  const wrap = currentCtx?.composerWrap || document.querySelector(".composer");
  if (!wrap) return;
  let row = wrap.querySelector(".npc-chips");
  if (!row) { row = el("div", { class: "npc-chips" }); wrap.prepend(row); }
  const accept = async (npc) => {
    row.remove();
    await acceptNpc(npc);
  };
  row.replaceChildren(
    el("span", { class: "npc-hint" }, "💡 PNJ repérés :"),
    ...npcs.map((n) => el("button", { class: "chip-btn", title: n.description ? esc(n.description) : undefined, onclick: () => accept(n) }, esc(n.name))),
    el("button", { class: "mini-btn", title: "Fermer la suggestion", onclick: () => row.remove() }, "Ignorer"),
  );
}

async function npcSuggestModal() {
  const list = el("div", { class: "npc-list" });
  const status = el("div", { class: "assist-status", hidden: true });
  const retryBtn = el("button", { class: "mini-btn", hidden: true, onclick: run }, "↻ Régénérer");
  let busy = false;
  const cancelBtn = el("button", { class: "btn btn-ghost" }, "Fermer");
  const { close } = openModal({
    title: "✨ Proposer un PNJ",
    body: el("div", {},
      el("p", { class: "modal-note" }, "L'IA relit la scène récente et propose des personnages secondaires qui y apparaissent. Clique sur « Ajouter » pour créer leur carte et les mettre en scène."),
      el("div", { class: "quest-actions" }, el("button", { class: "btn btn-primary btn-sm", onclick: run }, ICONS.sparkles, "Analyser la scène"), retryBtn, status),
      list,
    ),
    footer: [cancelBtn],
  });
  cancelBtn.addEventListener("click", close);
  async function run() {
    if (busy) return;
    busy = true;
    status.hidden = false;
    status.textContent = "✨ L'IA relit la scène…";
    retryBtn.hidden = true;
    try {
      const r = await api(`/api/conversations/${currentConversation.id}/npcs/suggest`, { body: {} });
      const npcs = r.npcs || [];
      retryBtn.hidden = !npcs.length;
      status.textContent = npcs.length ? "Propositions ✓ — ajoute celles qui te plaisent." : "Aucun PNJ distinct repéré dans la scène récente.";
      list.replaceChildren(...npcs.map((n) => {
        const card = el("div", { class: "npc-card" },
          el("div", { class: "npc-card-head" },
            el("div", { class: "avatar avatar-md init-avatar", style: { display: "grid", placeItems: "center", background: `linear-gradient(135deg, hsl(${nameHue(n.name)} 65% 45%), hsl(${(nameHue(n.name) + 50) % 360} 75% 26%))`, color: "#fff", fontWeight: 800 } }, (n.name || "?").charAt(0).toUpperCase()),
            el("div", {},
              el("strong", {}, esc(n.name)),
              n.role ? el("small", {}, esc(n.role)) : null,
            ),
          ),
          n.description ? el("p", { class: "npc-desc" }, esc(n.description)) : null,
          n.personality ? el("p", { class: "npc-perso" }, esc(n.personality)) : null,
          el("button", { class: "btn btn-primary btn-sm", onclick: async () => {
            if (await acceptNpc(n)) close();
          } }, "＋ Ajouter à la partie"),
        );
        return card;
      }));
    } catch (e) { status.hidden = true; toast(e.message, "err"); }
    finally { busy = false; }
  }
}

function scrollToBottom(scroll, force = false) {
  requestAnimationFrame(() => {
    if (force || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180) {
      scroll.scrollTop = scroll.scrollHeight;
    }
  });
}

// expose openModal for settings modal
import { openModal, field } from "./ui.js?v=66";
void applyTheme;
void fmtTime;
void currentConversation;