import { api, apiFetch, readSseStream } from "./api.js?v=37";
import { el, esc, toast, confirmModal, ICONS, fmtTime } from "./ui.js?v=37";
import { store, refreshAll, navigate, applyTheme } from "./app.js?v=37";

let currentConversation = null;
let currentCtx = null;
let busy = false;
let streamGeneration = 0;
let abortController = null;
let beforeUnloadHandler = null; // installed when streaming starts
let chipsRowRef = null;
let sceneRefreshHook = null; // set by renderChat; fired after each completed turn
let lastAutoValidateAt = 0; // per-session throttle for the auto coherence check
let autoValidateBusy = false;
// multi-select mode (module-level so renderMessage can read it)
let selectionMode = false;
const selectedIds = new Set();
let selectionBarRef = null; // wired by renderChat
let selectionExitRef = null; // wired by renderChat (the ☑ button)
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
    a.download = `${(conv.title || "partie").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "partie"}-selection.md`;
    a.click();
    URL.revokeObjectURL(a.href);
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
  const cs = JSON.parse(conv.settings || "{}");
  cs.dm = dm;
  cs.dm_pending = Boolean(pending);
  await api(`/api/conversations/${convId}`, { method: "PATCH", body: { settings: cs } });
  conv.settings = JSON.stringify(cs);
}
// ─── render ───────────────────────────────────────────────────────────────────
export async function renderChat(convIdRaw) {
  // support #/chat/new?world=&scenario=
  if (convIdRaw === "new") {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const pre = { world_id: params.get("world"), scenario_id: params.get("scenario") };
    const { newGameWizard } = await import("./app.js?v=37");
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
  const sceneBtn = el("button", { class: "btn btn-ghost btn-icon", title: "État de la scène (lieu, objectifs, dangers)", onclick: () => { sceneEnabled = !sceneEnabled; scenePanel.hidden = !scenePanel.hidden; if (!scenePanel.hidden) refreshScene(); } }, "🧭");
  const branchesBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Variantes de la partie (branches)", onclick: branchesModal }, "🌿");
  const memoryBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Mémoire structurée (lieu, personnages, objectifs)", onclick: memoryModal }, "🧠");
  const dmBtn = el("button", { class: "btn btn-ghost btn-icon" + (dmPending(conv) ? " on" : ""), title: "Mode maître de jeu (directives pour le prochain tour)", onclick: () => { dmEnabled = !dmEnabled; dmPanel.hidden = !dmPanel.hidden; if (!dmPanel.hidden) dmPaint(); } }, "🎮");
  const validateBtn = el("button", { class: "btn btn-ghost btn-icon", title: "Vérifier la cohérence du fil (IA)", onclick: validateModal }, "🛡");
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
      a.download = `${(conv.title || "partie").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "partie"}${branchMode === "canon" ? "-canon" : ""}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
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
    );
  };

  // ── scene-state panel (collapsible, LLM-maintained) ──
  let sceneEnabled = false;
  const scenePanel = el("div", { class: "scene-panel", hidden: true });
  const refreshScene = async () => {
    try {
      const r = await api(`/api/conversations/${convId}/scene`);
      scenePanel.replaceChildren(renderScenePanel(r.state, r.updatedAt, generateScene));
    } catch { /* panel is best-effort */ }
  };
  const generateScene = async () => {
    try {
      const r = await api(`/api/conversations/${convId}/scene`, { method: "POST", body: {} });
      scenePanel.replaceChildren(renderScenePanel(r.state, r.updatedAt, generateScene));
      toast(r.throttled ? "État déjà récent (2 min) ✓" : "État de la scène actualisé ✓");
    } catch (e) { toast(e.message, "err"); }
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

  // ── header overflow menu: secondary actions grouped by category ⇣ ──────────
  // the header keeps only the essentials; everything else lives in a dropdown
  const menu = el("div", { class: "header-menu", hidden: true, role: "menu" });
  const closeHeaderMenu = () => { menu.hidden = true; };
  const menuSection = (title, pairs) => {
    const items = pairs.map(([b, label]) => {
      if (!b) return null;
      const icon = (b.textContent || "›").trim().split(/\s/)[0] || "›";
      return el("button", { class: "menu-item", role: "menuitem", onclick: (e) => { e.stopPropagation(); closeHeaderMenu(); b.click(); } },
        el("span", { class: "menu-ico" }, icon),
        el("span", { class: "menu-lbl" }, label),
      );
    }).filter(Boolean);
    return items.length ? [el("div", { class: "menu-cat" }, title), ...items] : [];
  };
  const menuBtn = el("button", { class: "btn btn-ghost btn-icon header-more-btn", title: "Plus d'options", "aria-label": "Plus d'options", onclick: (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  } }, "⋮");
  menu.append(
    ...menuSection("🎬 Scène & mémoire", [[sceneBtn, "État de la scène"], [memoryBtn, "Mémoire structurée"], [dmBtn, "Directives du maître de jeu"], [branchesBtn, "Variantes"], [validateBtn, "Vérifier la cohérence"]]),
    ...menuSection("🔎 Fil & sélection", [[searchBtn, "Rechercher"], [bookmarkFilterBtn, "Favoris seulement"], [selectBtn, "Sélectionner plusieurs messages"]]),
    ...menuSection("📤 Export", [[mdBtn, "Exporter en Markdown"], [copyThreadBtn, "Copier le fil"], [galleryBtn, "Galerie d'illustrations"], [exportBtn, "Exporter en ZIP"]]),
    ...menuSection("🛠 Partie", [[settingsBtn, "Réglages de la partie"], [delBtn, "Archiver la partie"]]),
  );
  const header = el("div", { class: "chat-header" }, backBtn, titleBlock, castStrip, groupBtn, menuBtn, menu);

  async function exportZip() {
    exportBtn.disabled = true;
    try {
      const res = await apiFetch(`/api/conversations/${convId}/export`);
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
    if (!(await confirmModal({ title: "Archiver la partie", message: `Déplacer « ${conv.title || "Partie"} » dans la corbeille ? Tu pourras la restaurer depuis l'accueil. (La suppression définitive se fait dans la corbeille.)`, confirmLabel: "Archiver" }))) return;
    await api(`/api/conversations/${convId}`, { method: "DELETE" });
    await refreshConversations();
    navigate("#/");
    toast("Partie archivée — corbeille dans l'accueil.");
  }

  async function openGallery() {
    const data = await api(`/api/conversations/${convId}/gallery`).catch(() => ({ items: [], captions: {} }));
    const items = data.items || [];
    let captions = data.captions || {};
    const grid = el("div", { class: "gallery-grid" });
    const paint = () => {
      grid.replaceChildren(...items.map((it) => {
        const img = el("img", { src: it.image });
        img.addEventListener("click", () => {
          const lb = el("div", { class: "lightbox" },
            el("img", { src: it.image }),
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
        const r = await api(`/api/conversations/${convId}/gallery/captions`, { method: "POST", body: {} }).catch(() => ({ captions: captions }));
        captions = r.captions || {};
        paint();
        toast("Légendes générées ✓");
      } catch (e) { toast(e.message, "err"); }
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
          el("h3", {}, "Aucune illustration"),
          el("p", {}, "Génère des images depuis les messages (bouton « Illustrer »)."),
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

  // composer
  const textarea = el("textarea", { rows: 1, placeholder: conv.cards?.[0] ? `Écris ta réplique à ${conv.cards[0].name}…` : "Écris ton action ou ta réplique…" });
  // slash-command autocomplete (Discord-style menu)
  const SLASH_CMDS = [
    { cmd: "/dice", desc: "Lancer des dés — ex: /dice 2d6, /dice d20" },
    { cmd: "/ooc", desc: "Question hors-jeu au modèle" },
    { cmd: "/narrate", desc: "Forcer le narrateur à raconter la scène" },
    { cmd: "/card", desc: "État de la partie (lieu, enjeux, objectifs)" },
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
  function stopStreaming() {
    if (abortController) {
      const ac = abortController;
      abortController = null;
      ac.abort();
      toast("Génération arrêtée.", "ok", 2500);
      // the server commits whatever the model already wrote → show the real state
      setTimeout(async () => {
        if (currentConversation?.id) {
          await refreshConversation(currentConversation.id);
          await renderChat(String(currentConversation.id));
        }
      }, 900);
    }
  }
  const chipsRow = el("div", { class: "chips-row" });
  const speakRow = el("div", { class: "speak-row" },
    el("span", { class: "chips-label" }, "Faire parler :"),
    el("button", { class: "speak-btn", onclick: () => askToSpeak("narrateur") }, "🎙 Narrateur"),
    ...cards.map((c) => el("button", { class: "speak-btn", onclick: () => askToSpeak(c.name) }, "🎙 " + esc(c.name))),
  );
  // ── auto-validate: non-blocking coherence banner after a turn (opt-in) ──
  let lastFindings = [];
  const coherenceBanner = el("div", { class: "coherence-banner", hidden: true });
  const showCoherenceBanner = (findings) => {
    lastFindings = findings || [];
    if (!lastFindings.length) { coherenceBanner.hidden = true; return; }
    coherenceBanner.hidden = false;
    const viewBtn = el("button", { class: "mini-btn", onclick: () => openFindings(lastFindings) }, "Voir");
    const closeBtn = el("button", { class: "mini-btn", "aria-label": "Fermer", onclick: () => { coherenceBanner.hidden = true; } }, "✕");
    coherenceBanner.replaceChildren(
      el("span", {}, "🛡 " + lastFindings.length + " incohérence" + (lastFindings.length > 1 ? "s" : "") + " possible" + (lastFindings.length > 1 ? "s" : "") + " détectée" + (lastFindings.length > 1 ? "s" : "") + " — " + esc(lastFindings[0].message || "")),
      viewBtn,
      closeBtn,
    );
  };
  const maybeAutoValidate = async () => {
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
  };

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

  currentCtx = { scroll, textarea, sendBtn, stopBtn };
  // close the header menu when clicking anywhere else in the chat
  chatMain.addEventListener("click", (e) => {
    if (!e.target.closest(".header-menu, .header-more-btn")) closeHeaderMenu();
  });

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

    const body = el("div", { class: "conv-settings" },
      el("div", { class: "modal-section" }, "Modèle & génération"),
      el("div", { class: "row" }, provider.wrap, model.wrap),
      presetSel.wrap,
      el("div", { class: "row3" }, temp.wrap, maxTok.wrap, ctxMax.wrap),
      autoValCb,
      ctxLine,
      el("div", { class: "modal-section" }, "Mode de jeu"),
      el("div", { class: "row" }, el("div", { class: "modal-line" },
        el("div", { class: "ml-txt" }, el("strong", {}, "Faire jouer tous les personnages"), el("small", {}, "Groupe : chacun réagit à la scène · Solo : un personnage principal")),
        seg,
      )),
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

}

// ─── streaming a turn ─────────────────────────────────────────────────────────
async function doStream(content, opts = {}) {
  if (!currentConversation || !currentCtx) return;
  const { scroll, textarea, sendBtn, stopBtn } = currentCtx;
  busy = true;
  sendBtn.disabled = true;
  if (stopBtn) stopBtn.hidden = false;
  const streamGen = ++streamGeneration;

  // optimistic user bubble (display text may differ from the raw content)
  const displayText = opts.display || content;
  // animated dice roll on /dice messages (must be set before renderMessage)
  const userMsg = {
    id: `tmp-${Date.now()}`, role: "user", name: currentConversation.persona?.name || "Moi",
    content: displayText, segments: [], meta: {}, created_at: Date.now(),
    bubbleClass: displayText.startsWith("🎲 ") ? "dice-roll" : undefined,
  };
  scroll.append(renderMessage(userMsg));

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
          body: JSON.stringify({ content, directive: opts.directive || "", prompt: opts.prompt || "" }),
          signal: abortController.signal,
        });
    await readSseStream(res, async (event, data) => {
      if (event === "delta") {
        full += data.text || "";
        scheduleRender();
      } else if (event === "done") {
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
      } else if (event === "suggestions") {
        const { messageId, suggestions } = data;
        if (suggestions?.length) renderChips(suggestions);
        void messageId;
      } else if (event === "error") {
        throw new Error(data.message || "Erreur inconnue");
      }
    });
        await refreshAll();
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
        const errNode = el("div", { class: "msg me" },
          el("div", { class: "bubble", style: { borderColor: "var(--danger)", color: "var(--danger)" } },
            el("div", { style: { fontWeight: 700 } }, "⚠️ " + esc(e.message)),
            el("button", { class: "mini-btn", style: { marginTop: "8px" }, onclick: () => doStream(content) }, "↻ Réessayer"),
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
  box.append(
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
  );
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

// ─── structured memory (🧠) — view / edit the JSON memory maintained by the ──
// rolling summary: location, characters, goals, items, facts, relationships.
async function memoryModal() {
  if (!currentConversation) return;
  let conv;
  try { conv = await api(`/api/conversations/${currentConversation.id}`); }
  catch (e) { return toast(e.message, "err"); }
  const mem = conv.memory || {};
  const ta = (rows, ph, val) => {
    const node = el("textarea", { rows: Math.max(2, rows), placeholder: ph });
    node.value = val || ""; // el() uses setAttribute — textarea needs the live value
    return node;
  };
  const memField = (label, textarea) => el("label", { class: "mem-field" }, el("span", { class: "mem-label" }, label), textarea);
  const relTxt = Object.entries(mem.relationships || {}).map(([k, v]) => `${k} → ${v}`).join("\n");
  const locInput = el("input", { placeholder: "Lieu actuel", value: mem.location || "" });
  const charArea = ta((mem.characters || []).length + 1, "un par ligne", (mem.characters || []).join("\n"));
  const goalArea = ta((mem.goals || []).length + 1, "un par ligne", (mem.goals || []).join("\n"));
  const itemArea = ta((mem.items || []).length + 1, "un par ligne", (mem.items || []).join("\n"));
  const factArea = ta((mem.facts || []).length + 1, "un par ligne", (mem.facts || []).join("\n"));
  const relArea = ta(Object.keys(mem.relationships || {}).length + 1, "Alba → méfiance (une relation par ligne, format : Qui → lien)", relTxt);
  const saveBtn = el("button", { class: "btn btn-primary" }, "💾 Enregistrer la mémoire");
  saveBtn.addEventListener("click", async () => {
    const lines = (t) => t.value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const rel = {};
    for (const line of relArea.value.split(/\n/)) {
      const m = line.match(/^(.+?)\s*[→\-]\s*(.+)$/);
      if (m) rel[m[1].trim()] = m[2].trim();
    }
    const body = {
      memory: {
        location: locInput.value.trim() || undefined,
        characters: lines(charArea),
        goals: lines(goalArea),
        items: lines(itemArea),
        facts: lines(factArea),
        relationships: Object.keys(rel).length ? rel : undefined,
      },
    };
    try {
      const updated = await api(`/api/conversations/${currentConversation.id}`, { method: "PATCH", body });
      currentConversation.memory = updated.memory || null;
      toast("Mémoire mise à jour ✓");
      close();
    } catch (e) { toast(e.message, "err"); }
  });
  const body = el("div", { class: "mem-grid" },
    memField("📍 Lieu", locInput),
    memField("👥 Personnages", charArea),
    memField("🎯 Objectifs", goalArea),
    memField("📦 Objets", itemArea),
    memField("📌 Faits", factArea),
    memField("🔗 Relations", relArea),
  );
  const { close } = openModal({
    title: "🧠 Mémoire structurée",
    sub: "Mise à jour automatiquement par le résumé quand le fil devient trop long. Modifie-la si un détail compte pour la suite.",
    body: el("div", {}, body, el("div", { style: { marginTop: "14px", display: "flex", justifyContent: "flex-end" } }, saveBtn)),
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
  const segs = m.segments || [];
  const body = el("div", { class: "body" });
  if (isMe) {
    body.append(el("div", {}, esc(m.content)));
  } else if (segs.length) {
    for (let i = 0; i < segs.length; i++) {
      body.append(el("div", { class: `seg seg-${i}` }, formatSegment(segs[i])));
    }
  } else if (m.content) {
    for (const b of splitBlocks(m.content)) body.append(el("div", {}, formatBody(b)));
  }
  const bubble = el("div", { class: "bubble" + (m.bubbleClass ? " " + m.bubbleClass : ""), title: "Double-clic pour modifier" },
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
    bubble.append(el("div", { class: "msg-actions" }, ...messageActions(m.id)));
  }
  // private note (visible only to the player, never sent to the model)
  if (m.meta?.note && !String(m.id).startsWith("pending")) {
    bubble.append(el("div", { class: "msg-note" }, "📌 " + esc(m.meta.note)));
  }
  // emoji reactions (kept server-side in meta.reactions)
  if (m.id && !String(m.id).startsWith("pending")) {
    const list = Array.isArray(m.meta?.reactions) ? m.meta.reactions : [];
    const reacts = el("div", { class: "reactions" });
    for (const r of ["👍", "❤️", "😂"]) {
      const on = list.includes(r);
      const btn = el("button", { class: "reaction" + (on ? " on" : ""), title: on ? "Retirer la réaction" : "Réagir" }, r);
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/conversations/${currentConversation.id}/messages/${m.id}/reactions`, {
            method: on ? "DELETE" : "POST", body: { emoji: r },
          });
          const fresh = await api(`/api/conversations/${currentConversation.id}`);
          const nm = fresh.messages.find((x) => x.id === m.id) || m;
          const i = currentConversation.messages.findIndex((x) => x.id === m.id);
          if (i >= 0) currentConversation.messages[i] = nm;
          const node = document.querySelector(`[data-mid="${m.id}"]`);
          node?.replaceWith(renderMessage(nm));
        } catch (e) { toast(e.message, "err"); }
      });
      reacts.append(btn);
    }
    bubble.append(reacts);
  }
  const avatar = avatarFor(m);
  const node = el("div", { class: `msg${isMe ? " me" : ""}${selectedIds.has(m.id) ? " sel" : ""}`, dataset: { mid: m.id, role: m.role } }, avatar, bubble);
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

function avatarFor(m) {
  if (m.role === "user") {
    const p = currentConversation?.persona;
    if (p?.avatar) return el("img", { src: p.avatar, class: "avatar avatar-md" });
    return initialAvatar(p?.name || "Moi", "🧝");
  }
  const card = (currentConversation?.cards || []).find((c) => c.name.toLowerCase() === (m.name || "").toLowerCase());
  if (card?.avatar) return el("img", { src: card.avatar, class: "avatar avatar-md" });
  const name = m.name || "Narrateur";
  const isNarrator = name.toLowerCase() === "narrateur" || (!card && !m.name);
  return initialAvatar(name, isNarrator ? "🪄" : null);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // non-secure context fallback
    const ta = el("textarea", { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast((label || "Message") + " copié ✓");
}

function messageActions(messageId) {
  const m = (currentConversation?.messages || []).find((x) => x.id === messageId) || {};
  const favBtn = el("button", { class: "mini-btn" + (m.meta?.bookmark ? " on" : ""), title: m.meta?.bookmark ? "Retirer des favoris" : "Ajouter aux favoris", onclick: async () => {
    try {
      const updated = await api(`/api/conversations/${currentConversation.id}/messages/${messageId}`, { method: "PATCH", body: { meta: { bookmark: m.meta?.bookmark ? 0 : 1 } } });
      const idx = currentConversation.messages.findIndex((x) => x.id === messageId);
      if (idx >= 0) currentConversation.messages[idx] = updated;
      document.querySelector(`[data-mid="${messageId}"]`)?.replaceWith(renderMessage(updated));
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
      document.querySelector(`[data-mid="${m.id}"]`)?.replaceWith(renderMessage(updated));
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
import { openModal, field } from "./ui.js?v=37";
void applyTheme;
void fmtTime;
void currentConversation;