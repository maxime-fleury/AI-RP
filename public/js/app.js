import { api, apiFetch, apiForm, uploadFiles, setToken } from "./api.js?v=51";
import { el, esc, toast, actionToast, openModal, confirmModal, closeAllModals, field, ICONS, fmtTime } from "./ui.js?v=51";
import { renderChat } from "./chat.js?v=51";

// ─── global state ─────────────────────────────────────────────────────────────
export const store = {
  settings: {},
  worlds: [],
  cards: [],
  personas: [],
  conversations: [],
  loaded: false,
};

export async function refreshAll() {
  const [s, w, c, p, conv] = await Promise.all([
    api("/api/settings"),
    api("/api/worlds"),
    api("/api/cards"),
    api("/api/personas"),
    api("/api/conversations"),
  ]);
  Object.assign(store, {
    settings: s, worlds: w.worlds || [], cards: c.cards || [],
    personas: p.personas || [], conversations: conv.conversations || [],
    loaded: true,
  });
  return store;
}

/** Partial refresh helpers — cheaper than full refreshAll() for simple mutations. */
export async function refreshConversations() {
  const conv = await api("/api/conversations");
  store.conversations = conv.conversations || [];
}
export async function refreshWorlds() {
  const w = await api("/api/worlds");
  store.worlds = w.worlds || [];
}
export async function refreshCards() {
  const c = await api("/api/cards");
  store.cards = c.cards || [];
}
export async function refreshPersonas() {
  const p = await api("/api/personas");
  store.personas = p.personas || [];
}
/** Update a single conversation in place (e.g. after PATCH). */
export async function refreshConversation(id) {
  const conv = await api(`/api/conversations/${id}`);
  if (!conv) return;
  const idx = store.conversations.findIndex((c) => c.id === id);
  if (idx >= 0) store.conversations[idx] = conv;
  else store.conversations.push(conv);
}

// ─── narrator presets (shared by the settings editor and the world modal) ───
const BUILTIN_NARRATOR = {
  neutre: { label: "Neutre", prompt: "Sobre, direct et factuel : tu décris sans t'impliquer." },
  epique: { label: "Épique", prompt: "Grandiose, lyrique et dramatique : chaque scène devient une épopée." },
  sarcastique: { label: "Sarcastique", prompt: "Sarcastique et mordant : tu commentes les actions du joueur avec ironie et piques bien placées." },
  cynique: { label: "Cynique", prompt: "Cynique et désabusé : le monde est dur, injuste, et tu le fais sentir à chaque phrase." },
  en_colere: { label: "En colère", prompt: "En colère : la narration est tendue, brutale, presque rageuse. Les descriptions frappent fort." },
  nagatoro: { label: "Nagatoro (taquin)", prompt: "Taquin et espiègle, comme Nagatoro : tu provoques gentiment le joueur avec des piques affectueuses, un sourire malicieux et beaucoup d'assurance." },
};

/** [[key, label], …] for the narrator-style selects, incl. user customs from settings. */
export function narratorStyleOptions() {
  const map = {};
  for (const [k, v] of Object.entries(BUILTIN_NARRATOR)) map[k] = v.label;
  try {
    for (const [k, v] of Object.entries((store.settings.narrator_presets) || {})) {
      if (v?.prompt) map[k] = v.label || (BUILTIN_NARRATOR[k]?.label ?? k);
    }
  } catch { /* ignore */ }
  return [
    ["", "Par défaut (réglages)"],
    ...Object.entries(map).map(([k, l]) => [k, l + (k === "epique" ? " (défaut)" : "") + (!BUILTIN_NARRATOR[k] ? " ⭐" : "")]),
  ];
}

// personalization: accent color + background image (local to this device)
export function applyCustom() {
  const accent = localStorage.getItem("innsekai-accent");
  if (accent) document.documentElement.style.setProperty("--accent", accent);
  else document.documentElement.style.removeProperty("--accent");
  const bg = localStorage.getItem("innsekai-bg");
  if (bg) {
    document.documentElement.style.setProperty("--app-bg", `url("${bg}")`);
    document.body.classList.add("custom-bg");
  } else {
    document.documentElement.style.removeProperty("--app-bg");
    document.body.classList.remove("custom-bg");
  }
}

const THEME_CYCLE = ["auto", "glass", "anime"];
const THEME_LABELS = { auto: "🌙 Auto (nuit → anime)", glass: "🌌 Thème néon", anime: "🌸 Thème anime" };
export function applyTheme(theme) {
  const h = new Date().getHours();
  const effective = theme === "auto" ? (h >= 20 || h < 8 ? "anime" : "glass") : theme;
  document.documentElement.dataset.theme = effective;
  localStorage.setItem("innsekai-theme", JSON.stringify(theme));
}
// 'auto' re-evaluates as the day/night boundary passes (and on window focus)
setInterval(() => {
  const t = getThemeChoice();
  if (t === "auto") applyTheme("auto");
}, 60_000);
window.addEventListener("focus", () => { if (getThemeChoice() === "auto") applyTheme("auto"); });
function getThemeChoice() {
  try { return JSON.parse(localStorage.getItem("innsekai-theme") || '"glass"'); } catch { return "glass"; }
}

// ─── sidebar ──────────────────────────────────────────────────────────────────
function renderSidebar(active) {
  const sb = document.getElementById("sidebar");
  const items = [
    ["#/", "home", "Accueil"],
    ["#/worlds", "worlds", "Mondes"],
    ["#/cards", "cards", "Cartes"],
    ["#/personas", "personas", "Persona"],
    ["#/settings", "settings", "Réglages"],
  ];
  const nav = items.map(([href, icon, label]) =>
    el("a", { href, title: label, class: `nav-item${active === icon ? " active" : ""}` },
      el("span", { class: "ic" }, ICONS[icon]),
      el("span", { class: "lbl" }, label),
      icon === "worlds" ? el("span", { class: "badge" }, store.worlds.length) : null,
      icon === "cards" ? el("span", { class: "badge" }, store.cards.length) : null,
    ),
  );
  const collapseBtn = el("button", { class: "collapse-toggle", title: "Réduire / agrandir le panneau", onclick: toggleSidebar },
    sb.classList.contains("collapsed") ? "»" : "«",
  );
  const status = el("div", { class: "side-status" },
    el("div", { class: "status-row" },
      el("span", { class: `dot ${providerDot()}` }),
      el("span", {}, providerLabel()),
    ),
  );
  const themeBtn = el("button", { class: "theme-toggle", title: "Cycle : auto / néon / anime", onclick: () => {
    const cur = getThemeChoice();
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length] || "auto";
    applyTheme(next);
    renderSidebar(active);
  } },
    THEME_LABELS[getThemeChoice()] || THEME_LABELS.glass,
  );
  sb.replaceChildren(
    el("div", { class: "brand" },
      el("div", { class: "logo" }, "🪄"),
      el("div", {},
        el("h1", {}, "Innsekai"),
        el("small", {}, "Mondes & Personnages"),
      ),
    ),
    ...nav,
    el("div", { class: "spacer" }),
    status,
    themeBtn,
    collapseBtn,
  );
}

function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  const collapsed = sb.classList.toggle("collapsed");
  try { localStorage.setItem("innsekai-sidebar", collapsed ? "1" : "0"); } catch { /* ignore */ }
  renderSidebar(currentSection);
}

function providerDot() {
  const p = store.settings.provider;
  if (p === "openrouter") return store.settings.openrouter_key ? "ok" : "";
  return "warn";
}
function providerLabel() {
  return store.settings.provider === "openrouter" ? "OpenRouter" : "LM Studio";
}

// ─── router ───────────────────────────────────────────────────────────────────
const main = () => document.getElementById("main");
// which sidebar section is active — used by renderSidebar/toggleSidebar
let currentSection = "";
let paletteOpen = false;

function globalSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const c of store.conversations) if (!c.archived && `${c.title} ${c.last_message}`.toLowerCase().includes(q)) results.push({ type: "Partie", label: c.title, href: `#/chat/${c.id}` });
  for (const w of store.worlds) if (`${w.name} ${w.description} ${w.lore}`.toLowerCase().includes(q)) results.push({ type: "Monde", label: w.name, href: `#/world/${w.id}` });
  for (const c of store.cards) if (`${c.name} ${c.description} ${c.personality} ${c.tags || ""}`.toLowerCase().includes(q)) results.push({ type: "Carte", label: c.name, href: "#/cards" });
  for (const p of store.personas) if (`${p.name} ${p.description}`.toLowerCase().includes(q)) results.push({ type: "Persona", label: p.name, href: "#/personas" });
  return results.slice(0, 20);
}

function openCommandPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  const root = document.getElementById("palette-root");
  const input = el("input", { class: "palette-input", placeholder: "Rechercher ou lancer une commande…", autofocus: true });
  const results = el("div", { class: "palette-results" });
  const commands = [
    ["Nouvelle partie", () => newGameWizard()], ["Accueil", () => navigate("#/")],
    ["Mondes", () => navigate("#/worlds")], ["Cartes", () => navigate("#/cards")],
    ["Personas", () => navigate("#/personas")], ["Réglages", () => navigate("#/settings")],
  ];
  const close = () => { paletteOpen = false; backdrop.remove(); };
  let selectedIndex = 0;
  const paint = () => {
    const q = input.value.trim();
    const matches = q ? globalSearch(q).map((r) => [r.label, () => navigate(r.href), r.type]) : commands.map((r) => [r[0], r[1], "Commande"]);
    results.replaceChildren(...matches.map(([label, action, type]) => el("button", { class: "palette-item", onclick: () => { close(); action(); } }, el("span", { class: "chip" }, type), el("span", {}, label))));
    if (!matches.length) results.append(el("div", { class: "palette-empty" }, "Aucun résultat"));
    selectedIndex = 0;
  };
  const items = () => [...results.querySelectorAll("button.palette-item")];
  const selectSelected = () => {
    const all = items();
    if (all[selectedIndex]) all[selectedIndex].click();
  };
  const moveSelection = (delta) => {
    const all = items();
    if (!all.length) return;
    selectedIndex = (selectedIndex + delta + all.length) % all.length;
    all.forEach((b, i) => b.classList.toggle("selected", i === selectedIndex));
    all[selectedIndex]?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", paint);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "Enter") selectSelected();
    else if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
  });
  results.addEventListener("click", (e) => {
    const btn = e.target.closest("button.palette-item");
    if (btn) {
      const all = items();
      selectedIndex = all.indexOf(btn);
      all.forEach((b, i) => b.classList.toggle("selected", i === selectedIndex));
    }
  });
  const backdrop = el("div", { class: "palette-backdrop" }, el("div", { class: "palette", role: "dialog", "aria-modal": "true" }, input, results));
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
  root.append(backdrop); paint(); setTimeout(() => input.focus(), 0);
}

export function navigate(hash) {
  location.hash = hash;
}

function doRender(section, parts) {
  if (section === "" || section === "home") return renderDashboard();
  if (section === "worlds") return renderWorlds();
  if (section === "world") return renderWorldDetail(parts[1]);
  if (section === "cards") return renderCards();
  if (section === "personas") return renderPersonas();
  if (section === "settings") return renderSettings();
  if (section === "chat") return renderChat(parts[1]);
  if (section === "graph") return renderBranchGraph(parts[1]);
  return renderDashboard();
}

async function route() {
  const hash = location.hash || "#/";
  const parts = hash.slice(2).split("/").filter(Boolean);
  const section = parts[0] || "";
  currentSection = section === "world" ? "worlds" : section;
  renderSidebar(currentSection);
  document.getElementById("sidebar")?.classList.remove("open"); // close the mobile drawer
  window.scrollTo(0, 0);
  // a modal left open on the previous screen must not keep blocking the new
  // one (its backdrop silently swallows every click, e.g. « Faire parler »)
  closeAllModals();
  const run = async () => {
    try {
      return doRender(section, parts);
    } catch (e) {
      main().replaceChildren(el("div", { class: "empty" },
        el("div", { class: "big" }, "😵"),
        el("h3", {}, "Oups"),
        el("p", {}, esc(String(e?.message || e))),
        el("button", { class: "btn btn-primary", onclick: () => location.reload() }, "Recharger"),
      ));
    }
  };
  // View Transitions API: the #main content cross-fades between routes
  if (document.startViewTransition) {
    try {
      const vt = document.startViewTransition(run);
      await vt.ready;
    } catch { await run(); }
  } else {
    await run();
  }
}

window.addEventListener("hashchange", route);

// ─── keyboard shortcuts ───────────────────────────────────────────────────────
function isTypingTarget(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

// ─── configurable keyboard shortcuts ──────────────────────────────────────────
// bindings are stored in settings.shortcuts as canonical strings: "ctrl+k", "n", "?"
const SHORTCUT_DEFAULTS = { palette: "ctrl+k", new_game: "n", help: "?", composer: "/", regen: "r", edit_last: "e", illustrate_last: "i", group: "g" };
const SHORTCUT_LABELS = {
  palette: "Palette de commandes", new_game: "Nouvelle partie", help: "Aide des raccourcis",
  composer: "Écrire un message (dans une partie)", regen: "Régénérer la dernière réponse",
  edit_last: "Modifier la dernière réponse (dans une partie)", illustrate_last: "Illustrer la dernière réponse (dans une partie)",
  group: "Basculer solo / groupe",
};
export function getShortcuts() {
  const custom = store.settings.shortcuts || {};
  return { ...SHORTCUT_DEFAULTS, ...custom };
}
// canonical form of a keypress: modifiers first (ctrl/alt/shift, shift only for
// letters so "?" stays "?") + the key, lowercase — e.g. "ctrl+k", "shift+n", "?"
function canonShortcut(e) {
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey && /^[a-z]$/i.test(e.key)) mods.push("shift");
  return [...mods, e.key.toLowerCase()].join("+");
}
function shortcutsHelp() {
  const S = getShortcuts();
  const row = (k, desc) => el("div", { class: "k-row" }, el("kbd", {}, k), el("span", {}, desc));
  openModal({
    title: "⌨️ Raccourcis clavier",
    body: el("div", { class: "shortcuts" },
      row(S.palette, SHORTCUT_LABELS.palette),
      row(S.new_game, SHORTCUT_LABELS.new_game),
      row(S.composer, SHORTCUT_LABELS.composer + " (dans une partie)"),
      row(S.regen, SHORTCUT_LABELS.regen + " (dans une partie)"),
      row(S.group, SHORTCUT_LABELS.group + " (dans une partie)"),
      row("Esc", "Fermer la fenêtre / annuler l'édition"),
      row(S.help, SHORTCUT_LABELS.help),
      el("p", { class: "modal-note" }, "Personnalisables dans Réglages → Raccourcis clavier."),
    ),
  });
}
let shortcutCapturing = false; // set while the settings editor awaits a keypress
function fireShortcut(k) {
  import("./chat.js?v=51").then((m) => m.chatShortcut(k)).catch(() => {});
}
document.addEventListener("keydown", (e) => {
  if (shortcutCapturing) return; // the settings key-capture owns this press
  const press = canonShortcut(e);
  const S = getShortcuts();
  if (press === S.palette) { e.preventDefault(); openCommandPalette(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || e.key === "Escape") return;
  if (isTypingTarget(e) || document.querySelector(".modal")) return;
  const inChat = location.hash.startsWith("#/chat/");
  if (press === S.help) { e.preventDefault(); shortcutsHelp(); }
  else if (press === S.new_game) { e.preventDefault(); newGameWizard(); }
  else if (inChat && press === S.regen) { e.preventDefault(); fireShortcut("r"); }
  else if (inChat && press === S.edit_last) { e.preventDefault(); fireShortcut("e"); }
  else if (inChat && press === S.illustrate_last) { e.preventDefault(); fireShortcut("i"); }
  else if (inChat && press === S.group) { e.preventDefault(); fireShortcut("g"); }
  else if (inChat && press === S.composer) { e.preventDefault(); fireShortcut("/"); }
});

// ─── mobile sidebar drawer ────────────────────────────────────────────────────
const menuBtn = () => document.getElementById("menu-btn");
menuBtn()?.addEventListener("click", () => {
  document.getElementById("sidebar")?.classList.toggle("open");
});
document.getElementById("sidebar")?.addEventListener("click", (e) => {
  if (e.target.closest("a")) document.getElementById("sidebar")?.classList.remove("open");
});

// ─── dashboard ────────────────────────────────────────────────────────────────
let trashMode = false;

function paintGlobalResults(query) {
  const input = document.querySelector(".global-search");
  const box = document.querySelector(".global-results");
  if (!input || !box) return;
  const results = globalSearch(query);
  box.hidden = !query.trim();
  box.replaceChildren(...results.map((r) => el("a", { href: r.href, class: "global-result" }, el("span", { class: "chip" }, r.type), el("span", {}, r.label))));
  if (query.trim() && !results.length) box.append(el("div", { class: "palette-empty" }, "Aucun résultat"));
}

// soft-delete with an undoable toast (resource → trash, restore possible)
async function softDeleteResource(type, id, label, after) {
  try {
    await api(`/api/${type}s/${id}`, { method: "DELETE" });
    await refreshAll();
    after?.();
    actionToast(`${label} déplacé${type === "world" || type === "scenario" ? " " : "e "}dans la corbeille`, "Annuler", async () => {
      try {
        await api("/api/trash/restore", { body: { type, id } });
        await refreshAll();
        after?.();
        toast("Restauration ✓");
      } catch (e) { toast(e.message, "err"); }
    });
  } catch (e) { toast(e.message, "err"); }
}

const TRASH_TYPE_LABEL = { world: "Monde", scenario: "Scénario", card: "Carte", persona: "Persona" };
const TRASH_TYPE_ICON = { world: "🌍", scenario: "📜", card: "🎭", persona: "🧑‍🤝‍🧑" };

function renderDashboard() {
  const all = store.conversations;
  const archived = all.filter((c) => c.archived);
  const active = all.filter((c) => !c.archived);
  const pinned = active.filter((c) => c.pinned);
  const rest = active.filter((c) => !c.pinned);
  const worldCards = store.worlds.slice(0, 6);
  const banner = store.worlds[0]?.cover;
  // most recently updated active party → dominant "Reprendre" action
  const lastActive = rest[0];

  if (trashMode) {
    const trashBox = el("div", {});
    const resSection = el("div", {});
    api("/api/trash").then(({ items }) => {
      if (!items.length) {
        resSection.replaceChildren(el("div", { class: "empty" },
          el("div", { class: "big" }, "🗑"),
          el("h3", {}, "Corbeille vide"),
          el("p", {}, "Rien d'archivé pour l'instant."),
        ));
        return;
      }
      resSection.replaceChildren(
        el("div", { class: "section-title" }, "Mondes, cartes, personas & scénarios"),
        el("div", { class: "grid" }, items.map((it) => {
          const restoreBtn = el("button", { class: "mini-btn", onclick: async () => {
            try {
              await api("/api/trash/restore", { body: { type: it.type, id: it.id } });
              await refreshAll();
              renderDashboard();
              toast("Restauration ✓");
            } catch (e) { toast(e.message, "err"); }
          } }, "↺ Restaurer");
          const delBtn = el("button", { class: "mini-btn", style: { color: "var(--danger)" }, onclick: async () => {
            if (!(await confirmModal({ title: "Supprimer définitivement", message: `Effacer définitivement « ${it.name} » ? Cette action est irréversible.` }))) return;
            try {
              await api("/api/trash/permanent", { body: { type: it.type, id: it.id } });
              await refreshAll();
              renderDashboard();
              toast("Supprimé définitivement ✓");
            } catch (e) { toast(e.message, "err"); }
          } }, ICONS.trash);
          return el("div", { class: "card trash-res" },
            el("div", { class: "card-body" },
              el("h3", {}, TRASH_TYPE_ICON[it.type] + " " + esc(it.name)),
              el("div", { class: "sub" }, TRASH_TYPE_LABEL[it.type] + " · supprimé " + fmtTime(it.updated_at)),
              el("div", { class: "card-actions" }, restoreBtn, delBtn),
            ),
          );
        })),
      );
    }).catch(() => {});
    trashBox.append(
      el("div", { class: "hero" },
        el("h2", {}, "🗑 Corbeille"),
        el("p", {}, "Les parties archivées et les ressources supprimées restent ici jusqu'à restauration ou suppression définitive."),
        el("div", { class: "cta-row" },
          el("button", { class: "btn btn-ghost", onclick: () => { trashMode = false; renderDashboard(); } }, "← Retour à l'accueil"),
        ),
      ),
    );
    if (archived.length) {
      trashBox.append(el("div", { class: "section-title" }, "Parties archivées"));
      trashBox.append(el("div", { class: "grid" }, archived.map(trashCard)));
    }
    trashBox.append(resSection);
    main().replaceChildren(trashBox);
    return;
  }

  main().replaceChildren(...[
    el("div", { class: "global-search-wrap" },
      el("input", { class: "global-search", placeholder: "Rechercher dans tes mondes, cartes et parties…", "aria-label": "Recherche globale", oninput: (e) => paintGlobalResults(e.target.value) }),
      el("div", { class: "global-results", hidden: true }),
    ),
    el("div", { class: "hero" + (banner ? " hero-banner" : ""), style: banner ? { backgroundImage: `url(${banner})` } : null },
      el("div", { class: "hero-inner" },
        el("h2", {}, "Bienvenue, aventurier. ✨"),
        el("p", {}, "Crée des mondes, importe des personnages (cartes SillyTavern), définis tes scénarios isekai et laisse l'IA raconter l'histoire à tes côtés."),
        el("div", { class: "cta-row" },
          el("button", { class: "btn btn-primary", onclick: guidedWizard }, ICONS.sparkles, "Décris ce que tu veux"),
          el("button", { class: "btn btn-ghost", onclick: newGameWizard }, ICONS.plus, "Nouvelle partie"),
          el("a", { href: "#/worlds", class: "btn btn-ghost" }, ICONS.worlds, "Explorer les mondes"),
          el("a", { href: "#/cards", class: "btn btn-ghost" }, ICONS.cards, "Importer des cartes"),
        ),
      ),
    ),
    lastActive ? resumeCard(lastActive) : null,
    // the trash section shows when conversations are archived OR resources were
    // soft-deleted — the count is filled in asynchronously
    el("div", { class: "section-title", id: "trash-sec", hidden: true }, "Corbeille",
      el("button", { class: "chip-btn slim", style: { marginLeft: "10px" }, onclick: () => { trashMode = true; renderDashboard(); } }, "🗑 " + archived.length),
    ),
    pinned.length ? el("div", { class: "section-title" }, "⭐ Parties épinglées") : null,
    pinned.length ? el("div", { class: "grid" }, pinned.map(convCard)) : null,
    rest.length ? el("div", { class: "section-title" }, "Continuer une partie") : null,
    rest.length ? el("div", { class: "grid" }, rest.map(convCard)) : null,
    worldCards.length ? el("div", { class: "section-title" }, "Mondes récents") : null,
    worldCards.length ? el("div", { class: "grid" }, worldCards.map(worldCard)) : null,
    !store.worlds.length && !store.cards.length ? onboardingPanel() : null,
  ].filter(Boolean));
  api("/api/trash").then(({ items }) => {
    const sec = document.getElementById("trash-sec");
    if (!sec) return;
    const total = archived.length + (items || []).length;
    sec.hidden = total === 0;
    sec.querySelector("button").textContent = "🗑 " + total;
  }).catch(() => {});
}

// ─── first-run onboarding (no world, no card yet) ────────────────────────────
function onboardingPanel() {
  const modelLine = el("div", { class: "onb-line" }, "⏳ vérification de la connexion IA…");
  const imgLine = el("div", { class: "onb-line" }, "Modèle d'images : au premier usage (chargement long).");
  const check = () => {
    api("/api/health")
      .then((h) => {
        const ok = h?.ok === true;
        modelLine.replaceChildren(
          el("span", { class: "dot", style: { background: ok ? "var(--ok, #2ecc71)" : "var(--warn, #f1c40f)" } }),
          el("span", {}, ok
            ? "Service d'images prêt. Tu peux commencer !"
            : "Le service d'images se charge en arrière-plan — tu peux déjà jouer."),
        );
      })
      .catch((e) => {
        modelLine.replaceChildren(
          el("span", { class: "dot", style: { background: "var(--danger, #e74c3c)" } }),
          el("span", {}, "Pas de connexion IA détectée : " + esc(e.message) + " → "),
          el("a", { href: "#/settings", class: "onb-link" }, "ouvrir les Réglages"),
        );
      });
    api("/api/storage").then((st) => {
      imgLine.textContent = `Stockage actuel : ${((st.imagesMB || 0)).toFixed(1)} Mo d'illustrations générées, ${st.backups?.length ?? 0} backup(s) auto.`;
    }).catch(() => {});
  };
  check();
  const step = (n, title, desc) => el("div", { class: "onb-step" },
    el("div", { class: "onb-num" }, String(n)),
    el("div", {},
      el("h4", {}, title),
      el("p", {}, desc),
    ),
  );
  return el("div", { class: "onboarding card" },
    el("div", { class: "onb-hero" },
      el("div", { class: "big" }, "🧭"),
      el("h3", {}, "Ton univers t'attend"),
      el("p", {}, "Trois étapes et tu joues : connecte l'IA, crée ton premier monde (isekai ?), importe ou crée des personnages."),
    ),
    el("div", { class: "onb-steps" },
      step(1, "L'IA", "LM Studio local ou OpenRouter, configuré dans les Réglages."),
      step(2, "Ton monde", "Un monde = un cadre, son histoire, des scénarios multiples (mystère, romance, PVP…)."),
      step(3, "Le casting", "Importe des cartes SillyTavern (.png) ou crée tes personnages — avec l'aide de l'IA si tu veux."),
    ),
    el("div", { class: "onb-status" }, modelLine, imgLine),
    el("div", { class: "onb-cta" },
      el("button", { class: "btn btn-primary", onclick: newGameWizard }, ICONS.plus, "Créer ma première partie"),
      el("a", { href: "#/cards", class: "btn btn-ghost" }, ICONS.cards, "Importer des cartes"),
      el("a", { href: "#/settings", class: "btn btn-ghost" }, "⚙️ Configurer l'IA"),
    ),
  );
}

async function togglePin(c) {
  await api(`/api/conversations/${c.id}`, { method: "PATCH", body: { pinned: !c.pinned } });
  await refreshAll();
  renderDashboard();
}

function trashCard(c) {
  const world = c.world;
  return el("div", { class: "card trash-card" },
    el("div", { class: "card-body" },
      el("h3", {}, esc(c.title)),
      el("div", { class: "desc" }, esc((c.last_message || "").slice(0, 90) || world?.name || "")),
      el("div", { class: "card-actions" },
        world ? el("span", { class: "chip" }, esc(world.name)) : null,
        el("button", { class: "mini-btn", onclick: async () => {
          await api(`/api/conversations/${c.id}`, { method: "PATCH", body: { archived: false } });
          await refreshAll();
          renderDashboard();
        } }, "↩ Restaurer"),
        el("button", { class: "mini-btn", style: { color: "var(--danger)" }, onclick: async () => {
          if (await confirmModal({ title: "Supprimer définitivement", message: `Tout sera perdu (messages, images) : « ${c.title} » ?`, confirmLabel: "Supprimer" })) {
            await api(`/api/conversations/${c.id}/permanent`, { method: "DELETE" });
            await refreshAll();
            renderDashboard();
          }
        } }, ICONS.trash, "Définitif"),
      ),
    ),
  );
}

// dominant "Reprendre" action for the most recent active party
function resumeCard(c) {
  const world = c.world;
  const castNames = (c.cards || []).map((x) => x.name).slice(0, 3).join(", ");
  return el("div", { class: "resume-card", onclick: () => navigate(`#/chat/${c.id}`), role: "button", tabindex: 0 },
    el("div", { class: "resume-art", style: world?.cover ? { backgroundImage: `url(${world.cover})` } : null },
      el("span", { class: "resume-play" }, "▶"),
    ),
    el("div", { class: "resume-main" },
      el("div", { class: "resume-label" }, "Reprendre ta dernière partie"),
      el("h3", {}, esc(c.title || "Partie")),
      el("div", { class: "resume-meta" },
        [world?.name, castNames, c.group_mode ? "groupe" : "solo"].filter(Boolean).join(" · ") || fmtTime(c.updated_at),
      ),
      c.last_message ? el("div", { class: "resume-preview" }, "« " + esc(c.last_message.slice(0, 110)) + (c.last_message.length > 110 ? "…" : "") + " »") : null,
    ),
    el("button", { class: "btn btn-primary btn-lg", onclick: (e) => { e.stopPropagation(); navigate(`#/chat/${c.id}`); } }, ICONS.play, "Continuer ▶"),
  );
}

function convCard(c) {
  const world = c.world;
  const last = c.last_message ? c.last_message.slice(0, 90) : "";
  return el("div", { class: "card", style: { cursor: "pointer" }, onclick: () => navigate(`#/chat/${c.id}`) },
    el("div", { class: "card-cover", style: world?.cover ? { backgroundImage: `url(${world.cover})` } : { background: "linear-gradient(135deg, var(--active-bg), transparent)" } }),
    el("button", { class: "star-btn" + (c.pinned ? " on" : ""), title: c.pinned ? "Désépingler" : "Épingler cette partie", onclick: (e) => { e.stopPropagation(); togglePin(c); } }, c.pinned ? "★" : "☆"),
    el("div", { class: "card-body" },
      el("h3", {}, esc(c.title)),
      el("div", { class: "desc" }, esc(last || world?.name || "Nouvelle partie")),
      el("div", { class: "card-actions" },
        world ? el("span", { class: "chip" }, ICONS.worlds, esc(world.name)) : null,
        el("span", { class: "chip" }, c.group_mode ? ICONS.group : ICONS.solo, c.group_mode ? "groupe" : "solo"),
        el("span", { class: "chip muted", style: { marginLeft: "auto" } }, fmtTime(c.updated_at)),
      ),
    ),
  );
}

function worldCard(w) {
  // lore card: the world's map (if any) or cover becomes the hero backdrop,
  // with scenario badges — the composition changes as the world lives
  const art = w.map || w.cover;
  const badges = [];
  if (w.tone) badges.push(el("span", { class: "chip chip-tone" }, "🎭 " + esc(w.tone)));
  if ((w.scenario_count ?? 0) > 0) badges.push(el("span", { class: "chip" }, `${w.scenario_count} scénario${w.scenario_count > 1 ? "s" : ""}`));
  return el("div", { class: "card world-lore-card", style: { cursor: "pointer" }, onclick: () => navigate(`#/world/${w.id}`) },
    el("div", { class: "lore-art", style: art
      ? { backgroundImage: `url(${art})` }
      : { background: "linear-gradient(150deg, var(--accent-glow), transparent 70%)" } },
      el("div", { class: "lore-shade" }),
      el("div", { class: "lore-badges" }, badges),
    ),
    el("div", { class: "card-body" },
      el("h3", {}, "🗺 " + esc(w.name)),
      el("div", { class: "desc" }, esc(w.description || w.tone || "Monde sans description")),
      el("div", { class: "card-actions" },
        el("button", { class: "mini-btn", onclick: (e) => { e.stopPropagation(); startGameFromWorld(w.id); } }, "Jouer ▶"),
        el("button", { class: "mini-btn", onclick: (e) => { e.stopPropagation(); navigate(`#/world/${w.id}`); } }, "Explorer"),
      ),
    ),
  );
}

// ─── worlds ───────────────────────────────────────────────────────────────────
async function renderWorlds() {
  const container = el("div", {});
  container.append(
    el("div", { class: "page-head" },
      el("div", {},
        el("h2", {}, "🌍 Mondes"),
        el("div", { class: "sub" }, "Univers, lore et scénarios — chaque monde peut accueillir plusieurs parties et personnages."),
      ),
      el("button", { class: "btn btn-primary", onclick: () => worldModal() }, ICONS.plus, "Nouveau monde"),
    ),
  );
  if (!store.worlds.length) {
    container.append(el("div", { class: "empty" },
      el("div", { class: "big" }, "🗺️"),
      el("h3", {}, "Aucun monde pour l'instant"),
      el("p", {}, "Crée ton premier monde : un royaume fantastique, un isekai, un space-opera… tout est possible."),
      el("button", { class: "btn btn-primary", onclick: () => worldModal() }, "Créer un monde"),
    ));
  } else {
    container.append(el("div", { class: "grid" }, store.worlds.map(worldCard)));
  }
  main().replaceChildren(container);
}

function worldModal(existing) {
  const f = (v) => v ?? "";
  const name = field("Nom du monde", f(existing?.name), { placeholder: "Ex: Eldoria, l'empire des cendres", autofocus: true });
  const desc = field("Description courte", f(existing?.description), { type: "textarea", rows: 2, placeholder: "Une phrase qui donne envie" });
  const lore = field("Lore / univers", f(existing?.lore), { type: "textarea", rows: 5, placeholder: "L'histoire du monde, ses règles, sa géographie, ses factions…" });
  const tone = field("Tonalité", f(existing?.tone), { placeholder: "Ex: épique, sombre, léger, comique" });
  // narrator style: picks a preset key (built-in or custom) — empty = follow the global settings
  const narrStyleOptions = narratorStyleOptions();
  const currentStyle = narrStyleOptions.some(([k]) => k === f(existing?.narration_style)) ? existing?.narration_style : "";
  const nstyle = field("Style du narrateur (preset)", currentStyle, { type: "select", options: narrStyleOptions });
  const stylePromptOf = (key) => (key && (store.settings.narrator_presets || {})[key]?.prompt) || BUILTIN_NARRATOR[key]?.prompt || "";
  const nstylePreview = el("p", { class: "style-preview" }, stylePromptOf(currentStyle));
  nstyle.input.addEventListener("change", () => { nstylePreview.textContent = stylePromptOf(nstyle.input.value); });
  const lang = field("Langue du monde", f(existing?.language), {
    type: "select", options: [["", "Par défaut (réglages)"], ["fr", "Français"], ["en", "English"]],
  });
  // per-world negative prompt for the illustrations (overrides the global one)
  let worldSettings = {};
  try { worldSettings = JSON.parse(existing?.settings || "{}"); } catch { /* ignore */ }
  const negative = field("Prompt négatif (illustrations)", f(worldSettings.negative), {
    type: "textarea", rows: 2,
    placeholder: "Ce que les illustrations de ce monde doivent éviter (ex: mains déformées, texte, logo…)",
  });
  // jaquette générée par IA (édition seulement — il faut un id de monde)
  const coverBox = el("div", { class: "cover-box", style: { marginTop: "16px" } });
  if (existing) {
    const preview = existing.cover ? el("img", { src: existing.cover, style: { width: "100%", maxHeight: "220px", objectFit: "cover", borderRadius: "12px", border: "1px solid var(--border)" } }) : null;
    const genBtn = el("button", { class: "btn btn-ghost btn-sm", style: { marginTop: "10px" }, onclick: async () => {
      genBtn.disabled = true;
      genBtn.textContent = "🎨 génération… (15-20 s)";
      try {
        const res = await api(`/api/worlds/${existing.id}/cover`, { body: {} });
        toast("Jaquette générée ✓");
        await refreshAll();
        if (preview) preview.src = res.cover;
        else coverBox.prepend(el("img", { src: res.cover, style: { width: "100%", maxHeight: "220px", objectFit: "cover", borderRadius: "12px", border: "1px solid var(--border)" } }));
      } catch (e) { toast(e.message, "err"); }
      genBtn.disabled = false;
      genBtn.textContent = "🎨 Générer une jaquette";
    } }, "🎨 Générer une jaquette");
    if (preview) coverBox.append(preview);
    coverBox.append(genBtn);
  }
  const body = el("div", {}, name.wrap, desc.wrap, lore.wrap, el("div", { class: "row" }, tone.wrap, nstyle.wrap), nstylePreview, lang.wrap, negative.wrap, coverBox);
  const { close } = openModal({
    title: existing ? "Modifier le monde" : "Nouveau monde",
    body,
    footer: [
      el("button", { class: "btn btn-ghost", onclick: () => close() }, "Annuler"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        const payload = {
          name: name.input.value.trim() || "Monde sans nom",
          description: desc.input.value.trim(),
          lore: lore.input.value.trim(),
          tone: tone.input.value.trim(),
          narration_style: nstyle.input.value,
          language: lang.input.value,
          settings: JSON.stringify({ ...worldSettings, negative: negative.input.value.trim() }),
        };
        try {
          if (existing) await api(`/api/worlds/${existing.id}`, { method: "PATCH", body: payload });
          else await api("/api/worlds", { body: payload });
          close();
          toast("Monde enregistré ✓");
          await refreshAll();
          route();
        } catch (e) { toast(e.message, "err"); }
      } }, "Enregistrer"),
    ],
  });
}

async function renderWorldDetail(id) {
  const world = store.worlds.find((w) => w.id === Number(id));
  if (!world) return renderWorlds();
  let scenarios = [];
  let scenariosErr = "";
  try { scenarios = (await api(`/api/worlds/${world.id}/scenarios`)).scenarios || []; }
  catch (e) { scenariosErr = e?.message || "Erreur inconnue"; }
  const plays = store.conversations.filter((c) => c.world_id === world.id);

  const head = el("div", { class: "page-head" },
    el("div", { style: { display: "flex", gap: "14px", alignItems: "center" } },
      el("a", { href: "#/worlds", class: "btn btn-ghost btn-icon" }, ICONS.back),
      el("div", {},
        el("h2", {}, esc(world.name)),
        el("div", { class: "sub" }, `${world.tone || ""}${world.tone && world.description ? " · " : ""}${world.description || ""}`),
      ),
    ),
    el("div", { style: { display: "flex", gap: "10px" } },
      el("button", { class: "btn btn-ghost", onclick: () => worldModal(world) }, ICONS.edit, "Modifier"),
      el("button", { class: "btn btn-primary", onclick: () => startGameFromWorld(world.id) }, ICONS.plus, "Nouvelle partie"),
      el("button", { class: "btn btn-ghost", style: { color: "var(--danger)" }, title: "Supprimer ce monde (corbeille)", onclick: async () => {
        if (await confirmModal({ title: "Supprimer le monde", message: `Supprimer « ${world.name} » ? Il ira dans la corbeille (ses parties restent accessibles).` })) {
          softDeleteResource("world", world.id, world.name, () => navigate("#/worlds"));
        }
      } }, ICONS.trash),
    ),
  );

  const body = el("div", {});
  if (world.cover) {
    body.append(el("div", { class: "hero", style: { padding: 0, overflow: "hidden" } },
      el("img", { src: world.cover, style: { width: "100%", maxHeight: "340px", objectFit: "cover", display: "block" } }),
    ));
  }
  if (world.lore) body.append(
    el("div", { class: "section-title" }, "Lore"),
    el("p", { style: { lineHeight: "1.7", color: "var(--text-dim)", whiteSpace: "pre-wrap", marginBottom: "8px" } }, esc(world.lore)),
  );

  // ── carte du monde + export ──
  body.append(el("div", { class: "section-title" }, "🗺 Carte du monde"));
  const mapTools = el("div", { class: "map-tools" },
    el("button", { class: "btn btn-ghost btn-sm", onclick: async (e) => {
      const b = e.target;
      b.disabled = true;
      b.textContent = "🎨 génération de la carte… (20-40 s)";
      try {
        const r = await api(`/api/worlds/${world.id}/map/generate`, { method: "POST", body: {} });
        await refreshAll();
        renderWorldDetail(world.id);
        toast("Carte générée ✓");
      } catch (err) { toast(err.message, "err"); }
      b.disabled = false;
      b.textContent = "🎨 Générer la carte";
    } }, "🎨 Générer la carte"),
    el("button", { class: "btn btn-ghost btn-sm", onclick: async (e) => {
      const b = e.target;
      b.disabled = true;
      try {
        const res = await apiFetch(`/api/worlds/${world.id}/export`);
        if (!res.ok) throw new Error("Export impossible");
        const blob = await res.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${world.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "monde"}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast("Monde exporté (ZIP) ✓");
      } catch (err) { toast(err.message, "err"); }
      b.disabled = false;
    } }, "⬇ Exporter le monde (ZIP)"),
  );
  const mapBox = el("div", { class: "world-map" });
  body.append(mapTools, mapBox);
  (async () => {
    try {
      const { map, locations } = await api(`/api/worlds/${world.id}/map`);
      if (map) {
        const img = el("img", { src: map, class: "world-map-img" });
        img.addEventListener("load", () => {
          const pins = el("div", { class: "map-pins" });
          locations.forEach((name, i) => {
            pins.append(el("div", { class: "map-pin", style: { left: (12 + ((i * 53 + 17) % 76)) + "%", top: (12 + ((i * 37 + 29) % 70)) + "%" }, title: name }, "📍"));
          });
          mapBox.replaceChildren(img, pins);
          if (locations.length) mapBox.append(el("div", { class: "map-legend" }, locations.map((l) => el("span", { class: "chip" }, "📍 " + esc(l)))));
        });
        img.addEventListener("error", () => mapBox.replaceChildren(el("div", { class: "empty", style: { padding: "22px" } }, el("p", {}, "Carte introuvable — régénère-la."))));
      } else {
        mapBox.append(el("div", { class: "empty", style: { padding: "26px" } },
          el("div", { class: "big" }, "🗺"),
          el("h3", {}, "Pas encore de carte"),
          el("p", {}, "Génère une carte illustrée de ce monde — les lieux cités dans tes parties y seront épinglés."),
        ));
      }
    } catch (e) {
      mapBox.replaceChildren(el("div", { class: "empty", style: { padding: "22px" } }, el("div", { class: "big" }, "🗺"), el("h3", {}, "Carte indisponible"), el("p", {}, esc(e.message) + " — recharge la page pour réessayer.")));
    }
  })();

  body.append(el("div", { class: "section-title" }, scenariosErr ? "Scénarios (indisponibles)" : `Scénarios (${scenarios.length})`));
  const addScen = el("button", { class: "btn btn-ghost btn-sm", onclick: () => scenarioModal(world) }, ICONS.plus, "Ajouter un scénario");
  if (scenariosErr) {
    body.append(el("div", { class: "empty", style: { padding: "30px" } },
      el("div", { class: "big" }, "🎬"),
      el("h3", {}, "Scénarios indisponibles"),
      el("p", {}, esc(scenariosErr) + " — recharge la page pour réessayer."),
    ));
  } else if (!scenarios.length) {
    body.append(el("div", { class: "empty", style: { padding: "30px" } },
      el("div", { class: "big" }, "🎬"),
      el("h3", {}, "Aucun scénario"),
      el("p", {}, "Un scénario définit comment la partie commence — ex: « la carte t'a invoqué dans ce monde », « vous avez été invoqués ensemble par accident »…"),
      el("button", { class: "btn btn-primary", onclick: () => scenarioModal(world) }, ICONS.plus, "Créer un scénario"),
      el("button", { class: "btn btn-ghost", style: { marginLeft: "8px" }, onclick: () => scenarioModal(world) }, ICONS.sparkles, "Générer par l'IA"),
    ));
  } else {
    body.append(el("div", { class: "grid", style: { gridTemplateColumns: "repeat(auto-fill, minmax(300px,1fr))" } },
      scenarios.map((s) => scenarioCard(world, s)),
      addScen && el("div", { class: "card", style: { display: "grid", placeItems: "center", minHeight: "120px", cursor: "pointer" }, onclick: () => scenarioModal(world) },
        el("div", { style: { textAlign: "center", color: "var(--text-dim)" } }, el("div", { style: { fontSize: "26px" } }, ICONS.plus), "Nouveau scénario")),
    ));
  }

  if (plays.length) {
    body.append(el("div", { class: "section-title" }, "Parties dans ce monde"));
    body.append(el("div", { class: "grid" }, plays.map(convCard)));
  }

  // workspace tabs: overview + lieux / lorebook / relations / chronologie
  const tabRenders = [
    ["Vue d'ensemble", () => body],
    ["Lieux", () => renderLocationsTab(world)],
    ["Lorebook", () => renderLorebookTab(world)],
    ["Relations", () => renderRelationsTab(world)],
    ["Chronologie", () => renderTimelineTab(world)],
    ["Galerie", () => renderGalleryTab(world)],
  ];
  const tabBar = el("div", { class: "world-tabs", role: "tablist" });
  const tabContent = el("div", { class: "world-tab-content" });
  const activate = (i) => {
    [...tabBar.children].forEach((b, j) => b.classList.toggle("on", j === i));
    tabContent.replaceChildren(tabRenders[i][1]());
  };
  tabRenders.forEach(([label], i) => tabBar.append(el("button", { class: "world-tab", role: "tab", onclick: () => activate(i) }, label)));
  activate(0);
  main().replaceChildren(head, tabBar, tabContent);
}

// ─── world workspace: lieux / lorebook / relations / chronologie ─────────────
function renderLocationsTab(world) {
  const box = el("div", { class: "tab-box" });
  const paint = async () => {
    let locations = [];
    try {
      locations = (await api(`/api/worlds/${world.id}/locations`)).locations || [];
    } catch (e) {
      box.replaceChildren(el("div", { class: "empty" }, el("div", { class: "big" }, "📍"), el("h3", {}, "Lieux indisponibles"), el("p", {}, esc(e.message) + " — recharge la page pour réessayer.")));
      return;
    }
    box.replaceChildren(
      el("div", { class: "tab-head" },
        el("div", {},
          el("h3", {}, "📍 Lieux"),
          el("div", { class: "sub" }, "Les endroits clés du monde, avec leur position sur la carte (0-100)."),
        ),
        el("button", { class: "btn btn-primary btn-sm", onclick: () => locationModal(world, null, paint) }, ICONS.plus, "Ajouter un lieu"),
      ),
      locations.length
        ? el("div", { class: "workspace-list" }, locations.map((l) =>
            el("div", { class: "ws-row" },
              el("div", { class: "ws-main" },
                el("strong", {}, esc(l.name)),
                el("div", { class: "ws-sub" }, esc(l.description || "—")),
              ),
              el("span", { class: "chip" }, `x ${l.x} · y ${l.y}`),
              el("div", { class: "ws-actions" },
                el("button", { class: "mini-btn", onclick: () => locationModal(world, l, paint) }, ICONS.edit),
                el("button", { class: "mini-btn", style: { color: "var(--danger)" }, onclick: async () => {
                  if (await confirmModal({ title: "Supprimer le lieu", message: `Supprimer « ${l.name} » ?` })) {
                    await api(`/api/locations/${l.id}`, { method: "DELETE" });
                    paint();
                  }
                } }, ICONS.trash),
              ),
            ),
          ))
        : el("div", { class: "empty" }, el("div", { class: "big" }, "📍"), el("h3", {}, "Aucun lieu"), el("p", {}, "Ajoute les endroits clés du monde (capitale, forêt, donjon…).")),
    );
  };
  paint();
  return box;
}

function locationModal(world, existing, onDone) {
  const name = field("Nom", existing?.name, { autofocus: true });
  const desc = field("Description", existing?.description, { type: "textarea", rows: 2 });
  const x = field("Position X (%)", existing?.x ?? 50, { type: "number", min: 0, max: 100, step: 1 });
  const y = field("Position Y (%)", existing?.y ?? 50, { type: "number", min: 0, max: 100, step: 1 });
  const cancelBtn = el("button", { class: "btn btn-ghost" }, "Annuler");
  const saveBtn = el("button", { class: "btn btn-primary" }, "Enregistrer");
  const { close } = openModal({
    title: existing ? "Modifier le lieu" : "Nouveau lieu",
    body: el("div", {}, name.wrap, desc.wrap, el("div", { class: "row" }, x.wrap, y.wrap)),
    footer: [cancelBtn, saveBtn],
  });
  cancelBtn.addEventListener("click", close);
  saveBtn.addEventListener("click", async () => {
    try {
      const payload = { name: name.input.value.trim() || "Lieu", description: desc.input.value.trim(), x: Number(x.input.value), y: Number(y.input.value) };
      if (existing) await api(`/api/locations/${existing.id}`, { method: "PATCH", body: payload });
      else await api(`/api/worlds/${world.id}/locations`, { body: payload });
      close();
      toast(existing ? "Lieu modifié ✓" : "Lieu ajouté ✓");
      onDone?.();
    } catch (e) { toast(e.message, "err"); }
  });
}

function renderLorebookTab(world) {
  const box = el("div", { class: "tab-box" });
  const paint = async () => {
    let entries = [];
    try {
      entries = (await api(`/api/worlds/${world.id}/lorebook`)).entries || [];
    } catch (e) {
      box.replaceChildren(el("div", { class: "empty" }, el("div", { class: "big" }, "📖"), el("h3", {}, "Lorebook indisponible"), el("p", {}, esc(e.message) + " — recharge la page pour réessayer.")));
      return;
    }
    box.replaceChildren(
      el("div", { class: "tab-head" },
        el("div", {},
          el("h3", {}, "📖 Lorebook"),
          el("div", { class: "sub" }, "Mémoire conditionnelle : une entrée n'est injectée dans le prompt que si l'un de ses déclencheurs apparaît dans la partie."),
        ),
        el("button", { class: "btn btn-primary btn-sm", onclick: () => lorebookModal(world, null, paint) }, ICONS.plus, "Ajouter une entrée"),
      ),
      entries.length
        ? el("div", { class: "workspace-list" }, entries.map((e) =>
            el("div", { class: "ws-row" },
              el("div", { class: "ws-main" },
                el("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
                  el("strong", {}, esc(e.name)),
                  el("span", { class: "chip" }, "priorité " + e.priority),
                  e.enabled ? null : el("span", { class: "chip dim" }, "désactivée"),
                ),
                e.triggers ? el("div", { class: "ws-sub" }, e.triggers.split(",").map((t) => t.trim()).filter(Boolean).map((t) => el("span", { class: "chip tiny" }, t))) : null,
                el("div", { class: "ws-desc" }, esc(e.content)),
              ),
              el("div", { class: "ws-actions" },
                el("button", { class: "mini-btn", onclick: () => lorebookModal(world, e, paint) }, ICONS.edit),
                el("button", { class: "mini-btn", style: { color: "var(--danger)" }, onclick: async () => {
                  if (await confirmModal({ title: "Supprimer l'entrée", message: `Supprimer « ${e.name} » ?` })) {
                    await api(`/api/lorebook/${e.id}`, { method: "DELETE" });
                    paint();
                  }
                } }, ICONS.trash),
              ),
            ),
          ))
        : el("div", { class: "empty" }, el("div", { class: "big" }, "📖"), el("h3", {}, "Aucune entrée"), el("p", {}, "Ex : « La Guilde des Cendres », déclencheurs « guilde, cendres, maître forgeron » — le contenu n'entre dans le contexte que quand ces mots apparaissent.")),
    );
  };
  paint();
  return box;
}

function lorebookModal(world, existing, onDone) {
  const name = field("Nom", existing?.name, { autofocus: true });
  const triggers = field("Déclencheurs (séparés par des virgules)", existing?.triggers, { placeholder: "guilde, cendres, maître forgeron" });
  const content = field("Contenu", existing?.content, { type: "textarea", rows: 4 });
  const priority = field("Priorité", existing?.priority ?? 1, { type: "number", min: 1, max: 10, step: 1 });
  const enabled = el("label", { class: "modal-line" },
    el("div", { class: "ml-txt" }, el("strong", {}, "Entrée active")),
    el("input", { type: "checkbox", ...(existing?.enabled !== 0 ? { checked: "" } : {}) }),
  );
  const cancelBtn = el("button", { class: "btn btn-ghost" }, "Annuler");
  const saveBtn = el("button", { class: "btn btn-primary" }, "Enregistrer");
  const { close } = openModal({
    title: existing ? "Modifier l'entrée" : "Nouvelle entrée de lorebook",
    body: el("div", {}, name.wrap, triggers.wrap, content.wrap, priority.wrap, enabled),
    footer: [cancelBtn, saveBtn],
  });
  cancelBtn.addEventListener("click", close);
  saveBtn.addEventListener("click", async () => {
    try {
      const payload = {
        name: name.input.value.trim() || "Entrée",
        triggers: triggers.input.value.trim(),
        content: content.input.value.trim(),
        priority: Number(priority.input.value),
        enabled: enabled.querySelector("input").checked ? 1 : 0,
      };
      if (existing) await api(`/api/lorebook/${existing.id}`, { method: "PATCH", body: payload });
      else await api(`/api/worlds/${world.id}/lorebook`, { body: payload });
      close();
      toast(existing ? "Entrée modifiée ✓" : "Entrée ajoutée ✓");
      onDone?.();
    } catch (e) { toast(e.message, "err"); }
  });
}

function renderRelationsTab(world) {
  const box = el("div", { class: "tab-box" });
  const paint = async () => {
    let relations = [];
    try {
      relations = (await api(`/api/worlds/${world.id}/relations`)).relations || [];
    } catch (e) {
      box.replaceChildren(el("div", { class: "empty" }, el("div", { class: "big" }, "🕸"), el("h3", {}, "Relations indisponibles"), el("p", {}, esc(e.message) + " — recharge la page pour réessayer.")));
      return;
    }
    box.replaceChildren(
      el("div", { class: "tab-head" },
        el("div", {},
          el("h3", {}, "🕸 Relations"),
          el("div", { class: "sub" }, "Le réseau entre personnages : alliés, rivaux, familles… Les liens peuvent évoluer pendant les parties."),
        ),
        el("button", { class: "btn btn-primary btn-sm", onclick: () => relationModal(world, null, paint) }, ICONS.plus, "Ajouter une relation"),
      ),
      relations.length
        ? el("div", { class: "workspace-list" }, relations.map((r) =>
            el("div", { class: "ws-row" },
              el("div", { class: "ws-main rel-line" },
                el("strong", {}, esc(r.from_name)),
                el("span", { class: "rel-kind" }, "— " + esc(r.kind) + " →"),
                el("strong", {}, esc(r.to_name)),
              ),
              el("div", { class: "ws-actions" },
                el("button", { class: "mini-btn", onclick: () => relationModal(world, r, paint) }, ICONS.edit),
                el("button", { class: "mini-btn", style: { color: "var(--danger)" }, onclick: async () => {
                  if (await confirmModal({ title: "Supprimer la relation", message: `Supprimer le lien « ${r.from_name} — ${r.kind} — ${r.to_name} » ?` })) {
                    await api(`/api/relations/${r.id}`, { method: "DELETE" });
                    paint();
                  }
                } }, ICONS.trash),
              ),
            ),
          ))
        : el("div", { class: "empty" }, el("div", { class: "big" }, "🕸"), el("h3", {}, "Aucune relation"), el("p", {}, "Relie deux personnages : « Alba — méfiance → Kael ».")),
    );
  };
  paint();
  return box;
}

function relationModal(world, existing, onDone) {
  const from = field("De", existing?.from_name, { autofocus: true });
  const kind = field("Type de lien", existing?.kind || "allié", { type: "select", options: [["allié", "allié"], ["rivale", "rivale"], ["amoureux", "amoureux"], ["famille", "famille"], ["méfiance", "méfiance"], ["neutre", "neutre"], ["ennemi", "ennemi"]] });
  const to = field("Vers", existing?.to_name);
  const cancelBtn = el("button", { class: "btn btn-ghost" }, "Annuler");
  const saveBtn = el("button", { class: "btn btn-primary" }, "Enregistrer");
  const { close } = openModal({
    title: existing ? "Modifier la relation" : "Nouvelle relation",
    body: el("div", {}, el("div", { class: "row" }, from.wrap, to.wrap), kind.wrap),
    footer: [cancelBtn, saveBtn],
  });
  cancelBtn.addEventListener("click", close);
  saveBtn.addEventListener("click", async () => {
    try {
      const payload = { from_name: from.input.value.trim(), kind: kind.input.value, to_name: to.input.value.trim() };
      if (!payload.from_name || !payload.to_name) return toast("Les deux personnages sont requis", "err");
      if (existing) await api(`/api/relations/${existing.id}`, { method: "PATCH", body: payload });
      else await api(`/api/worlds/${world.id}/relations`, { body: payload });
      close();
      toast(existing ? "Relation modifiée ✓" : "Relation ajoutée ✓");
      onDone?.();
    } catch (e) { toast(e.message, "err"); }
  });
}

function renderTimelineTab(world) {
  const box = el("div", { class: "tab-box" });
  const paint = async () => {
    let events = [];
    try {
      events = (await api(`/api/worlds/${world.id}/timeline`)).events || [];
    } catch (e) {
      box.replaceChildren(el("div", { class: "empty" }, el("div", { class: "big" }, "🗓"), el("h3", {}, "Chronologie indisponible"), el("p", {}, esc(e.message) + " — recharge la page pour réessayer.")));
      return;
    }
    box.replaceChildren(
      el("div", { class: "tab-head" },
        el("div", {},
          el("h3", {}, "🗓 Chronologie"),
          el("div", { class: "sub" }, "Les grands événements du monde, dans l'ordre."),
        ),
        el("div", { style: { display: "flex", gap: "10px" } },
          el("button", { class: "btn btn-ghost btn-sm", onclick: () => proposeTimeline(world, paint) }, ICONS.sparkles, "Proposer depuis les parties"),
          el("button", { class: "btn btn-primary btn-sm", onclick: () => timelineModal(world, paint) }, ICONS.plus, "Ajouter un événement"),
        ),
      ),
      events.length
        ? el("div", { class: "timeline" }, events.map((ev) =>
            el("div", { class: "tl-item" },
              el("div", { class: "tl-date" }, fmtTime(ev.created_at)),
              el("div", { class: "tl-body" }, esc(ev.label)),
              el("button", { class: "mini-btn", style: { color: "var(--danger)" }, title: "Supprimer", onclick: async () => {
                if (await confirmModal({ title: "Supprimer l'événement", message: `Supprimer « ${ev.label} » ?` })) {
                  await api(`/api/timeline/${ev.id}`, { method: "DELETE" });
                  paint();
                }
              } }, ICONS.trash),
            ),
          ))
        : el("div", { class: "empty" }, el("div", { class: "big" }, "🗓"), el("h3", {}, "Chronologie vide"), el("p", {}, "Note les événements majeurs : arrivées, pactes, batailles, révélations…")),
    );
  };
  paint();
  return box;
}

// ── proposer des événements depuis les parties (l'IA ne fait QUE suggérer) ──
async function proposeTimeline(world, paint) {
  const toastShow = (msg, type = "ok") => toast(msg, type);
  let proposals = [];
  const list = el("div", { class: "prop-list" });
  const paintProps = () => {
    if (!proposals.length) {
      list.replaceChildren(el("div", { class: "empty" }, el("div", { class: "big" }, "✨"), el("h3", {}, "Rien à proposer"), el("p", {}, "L'IA n'a pas repéré d'événement majeur récent (ou ils sont déjà tous acceptés).")));
      return;
    }
    list.replaceChildren(...proposals.map((p) => {
      const acceptBtn = el("button", { class: "mini-btn", onclick: async () => {
        try {
          await api("/api/worlds/" + world.id + "/timeline", { body: { label: p.label, conversation_id: p.conversation_id ?? undefined } });
          proposals = proposals.filter((x) => x !== p);
          paintProps();
          paint();
          toastShow("Événement ajouté à la chronologie ✓");
        } catch (e) { toastShow(e.message, "err"); }
      } }, "✓ Accepter");
      const dropBtn = el("button", { class: "mini-btn", title: "Ignorer cette proposition", onclick: () => { proposals = proposals.filter((x) => x !== p); paintProps(); } }, "✕ Ignorer");
      return el("div", { class: "prop-row" },
        el("div", { class: "prop-main" },
          el("div", { class: "prop-label" }, p.duplicate ? el("span", { class: "chip tiny", title: "Un événement similaire existe déjà" }, "déjà présent") : null, esc(p.label)),
          p.conversation ? el("div", { class: "prop-sub" }, "Partie : " + esc(p.conversation)) : null,
          p.extract ? el("div", { class: "prop-extract" }, "« " + esc(p.extract) + " »") : null,
        ),
        acceptBtn,
        dropBtn,
      );
    }));
  };
  const { close } = openModal({
    title: "✨ Événements proposés par l'IA",
    sub: "Repérés dans les parties récentes de ce monde. Rien n'est appliqué automatiquement — accepte ou ignore chaque proposition.",
    body: el("div", {}, list),
    wide: true,
  });
  try {
    const r = await api(`/api/worlds/${world.id}/timeline/propose`, { body: {} });
    proposals = r.proposals || [];
  } catch (e) {
    list.replaceChildren(el("div", { class: "empty" }, el("div", { class: "big" }, "😵"), el("h3", {}, "Analyse impossible"), el("p", {}, esc(e.message))));
    return;
  }
  paintProps();
}

function timelineModal(world, onDone) {
  const label = field("Événement", "", { type: "textarea", rows: 2, autofocus: true, placeholder: "Jour 3 — Pacte avec le gardien de la porte noire" });
  const cancelBtn = el("button", { class: "btn btn-ghost" }, "Annuler");
  const addBtn = el("button", { class: "btn btn-primary" }, "Ajouter");
  const { close } = openModal({
    title: "Nouvel événement",
    body: el("div", {}, label.wrap),
    footer: [cancelBtn, addBtn],
  });
  cancelBtn.addEventListener("click", close);
  addBtn.addEventListener("click", async () => {
    const text = label.input.value.trim();
    if (!text) return toast("Décris l'événement", "err");
    try {
      await api(`/api/worlds/${world.id}/timeline`, { body: { label: text } });
      close();
      toast("Événement ajouté ✓");
      onDone?.();
    } catch (e) { toast(e.message, "err"); }
  });
}

// ─── world gallery: every illustration of the world (parties + cover + map), ──
// with filters (paysage / personnage / favoris), favorites and seed-locked regen
function renderGalleryTab(world) {
  const box = el("div", { class: "tab-box" });
  let items = [];
  let filter = "all";
  let charFilter = null;
  const grid = el("div", { class: "gallery-grid" });
  const load = async () => {
    try {
      const r = await api(`/api/worlds/${world.id}/gallery`);
      items = r.items || [];
      paint();
    } catch (e) { box.replaceChildren(el("div", { class: "empty" }, el("div", { class: "big" }, "🖼"), el("h3", {}, "Galerie indisponible"), el("p", {}, esc(e.message)))); }
  };
  const visible = () => items.filter((it) => {
    if (charFilter && it.character !== charFilter) return false;
    if (filter === "fav") return it.fav;
    if (filter === "landscape") return it.kind === "landscape" || (!it.kind && !it.character);
    if (filter === "portrait") return it.kind === "portrait" || it.character;
    return true;
  });
  const paint = () => {
    // items arrive asynchronously; compute this from the current collection so
    // character filters are available after the gallery request completes.
    const characters = [...new Set(items.map((i) => i.character).filter(Boolean))];
    const pills = el("div", { class: "gallery-filters" },
      ["all", "landscape", "portrait", "fav"].map((k) =>
        el("button", { class: "chip-btn slim" + (filter === k ? " on" : ""), onclick: () => { filter = k; paint(); } },
          k === "all" ? "Toutes" : k === "landscape" ? "🏞 Paysages" : k === "portrait" ? "🎭 Personnages" : "⭐ Favoris")),
      ...characters.map((c) => el("button", { class: "chip-btn slim" + (charFilter === c ? " on" : ""), onclick: () => { charFilter = charFilter === c ? null : c; paint(); } }, "🎭 " + esc(c))),
    );
    const vis = visible();
    grid.replaceChildren(...(vis.length ? vis.map((it) => galleryCard(it)) : [el("div", { class: "empty" }, el("div", { class: "big" }, "🖼"), el("h3", {}, "Aucune illustration"), el("p", {}, "Génère des scènes dans les parties de ce monde."))]));
    box.replaceChildren(
      el("div", { class: "tab-head" },
        el("div", {},
          el("h3", {}, "🖼 Galerie du monde"),
          el("div", { class: "sub" }, `${items.length} illustration${items.length > 1 ? "s" : ""} — toutes les parties de « ${esc(world.name)} » + couverture et carte`),
        ),
      ),
      pills,
      grid,
    );
  };
  const toggleFav = async (it) => {
    if (typeof it.id !== "number") return; // world cover/map have no message to patch
    const next = it.fav ? 0 : 1;
    try {
      await api(`/api/conversations/${it.conversation_id}/messages/${it.id}`, { method: "PATCH", body: { meta: { image_fav: next } } });
      it.fav = next;
      paint();
    } catch (e) { toast(e.message, "err"); }
  };
  const regen = async (it, mode) => {
    if (typeof it.id !== "number") return toast("Couverture et carte ne se régénèrent pas ici.", "err");
    toast(mode === "seed" ? "🔒 Régénération (même seed)…" : "🎲 Variation…", "ok", 4000);
    try {
      const body = { kind: it.kind === "landscape" ? "landscape" : "portrait", ...(mode === "seed" ? { seed: it.seed, variation: "composition identique, détails et ambiance différents" } : { vary: true }) };
      await api(`/api/conversations/${it.conversation_id}/messages/${it.id}/image`, { body });
      toast("Illustration régénérée ✓");
      await load();
    } catch (e) { toast(e.message, "err"); }
  };
  const galleryCard = (it) => {
    const img = el("img", { src: it.image, alt: it.message || "illustration", loading: "lazy" });
    img.addEventListener("click", () => {
      const lb = el("div", { class: "lightbox" },
        el("img", { src: it.image }),
        el("div", { class: "lb-meta" },
          it.character ? el("span", { class: "chip" }, "🎭 " + esc(it.character)) : null,
          it.kind === "landscape" ? el("span", { class: "chip" }, "🏞 paysage") : it.character ? el("span", { class: "chip" }, "🎭 portrait") : null,
          it.seed != null ? el("span", { class: "chip" }, "seed " + it.seed) : null,
          it.fav ? el("span", { class: "chip" }, "⭐ favori") : null,
        ),
        it.conversation ? el("div", { class: "lb-conv" }, "Partie : " + esc(it.conversation)) : null,
        el("p", { class: "lb-caption" }, esc(it.message || "")),
        el("div", { class: "lb-actions" },
          el("button", { class: "mini-btn", title: "Régénérer avec le même seed (composition similaire)", onclick: () => { lb.remove(); regen(it, "seed"); } }, "🔒 Même seed"),
          el("button", { class: "mini-btn", title: "Varier avec un nouveau seed", onclick: () => { lb.remove(); regen(it, "vary"); } }, "🎲 Varier"),
          el("button", { class: "mini-btn" + (it.fav ? " on" : ""), title: "Favori", onclick: () => toggleFav(it) }, it.fav ? "⭐ Retirer des favoris" : "☆ Ajouter aux favoris"),
        ),
      );
      lb.addEventListener("click", (e) => { if (e.target === lb) lb.remove(); });
      document.body.append(lb);
    });
    return el("div", { class: "gallery-card" },
      img,
      el("div", { class: "gallery-cap" },
        it.character ? el("span", { class: "chip tiny" }, "🎭 " + esc(it.character)) : null,
        el("span", { class: "gallery-txt" }, esc(it.message || "")),
        el("button", { class: "mini-btn gal-fav" + (it.fav ? " on" : ""), title: "Favori", "aria-label": "Favori", onclick: (e) => { e.stopPropagation(); toggleFav(it); } }, it.fav ? "★" : "☆"),
      ),
    );
  };
  load();
  return box;
}

// ─── full branch graph view (#/graph/:id) — the whole fork family as a tree ──
// with connectors, statuses and per-node actions (open / kind / delete)
async function renderBranchGraph(id) {
  const main = document.getElementById("main");
  let data;
  try { data = await api(`/api/conversations/${id}/branches`); }
  catch (e) { return main.replaceChildren(el("div", { class: "empty" }, el("div", { class: "big" }, "🌿"), el("h3", {}, "Graphe indisponible"), el("p", {}, esc(e.message)))); }
  const branches = data.branches || [];
  const currentId = Number(id);
  const KIND_META = {
    main: { icon: "🌳", label: "principale" }, canon: { icon: "⭐", label: "canon" },
    alternative: { icon: "🌿", label: "variante" }, draft: { icon: "📝", label: "brouillon" },
    abandoned: { icon: "💤", label: "abandonnée" },
  };
  const byId = new Map(branches.map((b) => [b.id, b]));
  const childrenOf = (bid) => branches.filter((b) => b.parent_id === bid);
  const tree = [];
  const walk = (b, depth) => { tree.push([b, depth]); for (const c of childrenOf(b.id)) walk(c, depth + 1); };
  for (const r of branches.filter((b) => !b.parent_id || !byId.has(b.parent_id))) walk(r, 0);
  const kindSel = (b) => {
    const sel = el("select", { class: "mini-select", title: "Statut de cette branche", "aria-label": "Statut" },
      Object.entries(KIND_META).map(([k, m]) => el("option", { value: k, ...(b.branch_kind === k ? { selected: "" } : {}) }, m.label)),
    );
    sel.addEventListener("change", async () => {
      try {
        await api(`/api/conversations/${b.id}`, { method: "PATCH", body: { branch_kind: sel.value } });
        toast("Statut mis à jour ✓");
        renderBranchGraph(id);
      } catch (e) { toast(e.message, "err"); }
    });
    return sel;
  };
  const nodeCard = (b, depth) => {
    const meta = KIND_META[b.branch_kind] || KIND_META.alternative;
    const isCurrent = b.id === currentId;
    const kids = childrenOf(b.id).length;
    const card = el("div", { class: "graph-node" + (isCurrent ? " cur" : "") + (depth ? " child" : " root") },
      el("div", { class: "gn-top" },
        el("span", { class: "gn-icon" }, meta.icon),
        el("div", { class: "gn-title" }, esc(b.title || "Partie"),
          isCurrent ? el("span", { class: "chip tiny" }, "actuelle") : null,
          kids ? el("span", { class: "chip tiny" }, `${kids} enfant${kids > 1 ? "s" : ""}`) : null),
      ),
      b.last_message ? el("div", { class: "gn-preview" }, esc(b.last_message)) : null,
      el("div", { class: "gn-sub" }, fmtTime(b.updated_at), " · ", meta.label),
      el("div", { class: "gn-actions" },
        el("button", { class: "mini-btn", title: "Ouvrir cette branche", onclick: () => navigate(`#/chat/${b.id}`) }, ICONS.play, "Ouvrir"),
        kindSel(b),
        el("button", { class: "mini-btn", style: { color: "var(--danger)" }, title: "Supprimer définitivement", "aria-label": "Supprimer", onclick: async () => {
          if (!(await confirmModal({ title: "Supprimer la variante", message: `Supprimer définitivement « ${b.title} » ainsi que ses illustrations ?` }))) return;
          try {
            await api(`/api/conversations/${b.id}/permanent`, { method: "DELETE" });
            toast("Branche supprimée ✓");
            renderBranchGraph(id);
          } catch (e) { toast(e.message, "err"); }
        } }, ICONS.trash),
      ),
    );
    card.style.setProperty("--depth", String(depth));
    return card;
  };
  const legend = el("div", { class: "graph-legend" },
    Object.entries(KIND_META).map(([k, m]) => el("span", { class: "chip" }, `${m.icon} ${m.label}`)),
  );
  const backBtn = el("a", { href: "#", class: "btn btn-ghost btn-icon", onclick: (e) => { e.preventDefault(); navigate(`#/chat/${currentId}`); } }, ICONS.back);
  main.replaceChildren(
    el("div", { class: "graph-page" },
      el("div", { class: "page-head" },
        el("div", { style: { display: "flex", gap: "14px", alignItems: "center" } },
          backBtn,
          el("div", {},
            el("h2", {}, "🌿 Graphe des variantes"),
            el("div", { class: "sub" }, `${branches.length} branche${branches.length > 1 ? "s" : ""} · chaque « Régénérer » crée une variante reliée à sa source`),
          ),
        ),
      ),
      legend,
      branches.length
        ? el("div", { class: "graph-tree" }, tree.map(([b, d]) => nodeCard(b, d)))
        : el("div", { class: "empty" }, el("div", { class: "big" }, "🌿"), el("h3", {}, "Une seule branche"), el("p", {}, "Régénère une réponse pour créer une variante.")),
    ),
  );
}

function scenarioCard(world, s) {
  return el("div", { class: "card" },
    el("div", { class: "card-body" },
      el("h3", {}, esc(s.name)),
      el("div", { class: "desc", style: { "-webkit-line-clamp": "4" } }, esc(s.intro || "(intro vide)")),
      el("div", { class: "card-actions" },
        el("button", { class: "mini-btn", onclick: () => navigate(`#/chat/new?world=${world.id}&scenario=${s.id}`) }, "Jouer ▶"),
        el("button", { class: "mini-btn", onclick: () => scenarioModal(world, s) }, ICONS.edit),
        el("button", { class: "mini-btn", style: { color: "var(--danger)" }, onclick: async () => {
          if (await confirmModal({ title: "Supprimer le scénario", message: `Supprimer « ${s.name} » ? Il ira dans la corbeille.` })) {
            softDeleteResource("scenario", s.id, s.name, () => renderWorldDetail(world.id));
          }
        } }, ICONS.trash),
      ),
    ),
  );
}

function scenarioModal(world, existing) {
  const name = field("Nom du scénario", existing?.name, { placeholder: "Ex: L'invocation", autofocus: true });
  const intro = field("Introduction (texte de départ)", existing?.intro, {
    type: "textarea", rows: 6,
    placeholder: "Le texte qui ouvre la partie — écrit à la 2e personne. Ex: « Tu t'éveilles dans un jardin étrange. Une silhouette ailée te fixe : « Toi aussi, tu as été invoqué ? » »",
  });
  const notes = field("Notes (privées)", existing?.notes, { type: "textarea", rows: 2, placeholder: "Indices, enjeux, PNJ à introduire…" });
  const genreSel = field("Genre", "mystere", { type: "select", options: GENRE_OPTS });
  const genBtn = el("button", { class: "btn btn-primary btn-sm", onclick: generate }, ICONS.sparkles, "Générer par l'IA");
  const body = el("div", {}, name.wrap, intro.wrap, notes.wrap,
    el("div", { class: "scen-gen-row", style: { marginTop: "4px" } }, genreSel.wrap, genBtn),
  );
  // An empty scenario is auto-created before the IA generation so it has an id
  // to regenerate against. If the user then closes the modal WITHOUT saving,
  // that placeholder must not linger in the world — delete it on cancel.
  let autoCreatedId = null;
  let saved = false;
  const cleanupIfUnsaved = async () => {
    if (!autoCreatedId || saved) return;
    try {
      await api(`/api/scenarios/${autoCreatedId}`, { method: "DELETE" });
      await refreshAll();
      renderWorldDetail(world.id);
    } catch { /* already gone */ }
  };

  // write the AI opening into the intro field (new scenarios are created first
  // so they have an id to regenerate against)
  async function generate() {
    genBtn.disabled = true;
    genBtn.textContent = "✨ Génération…";
    try {
      let id = existing?.id;
      if (!id) {
        const created = await api(`/api/worlds/${world.id}/scenarios`, {
          body: { name: name.input.value.trim() || "Scénario", intro: "", notes: notes.input.value.trim() },
        });
        existing = created;
        autoCreatedId = created.id;
        id = created.id;
      }
      const res = await api(`/api/scenarios/${id}/generate`, {
        body: { genre: genreSel.input.value, theme: name.input.value.trim() || world.name },
      });
      intro.input.value = res.intro || "";
      toast("Intro générée — clique « Enregistrer » pour la garder ✓");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = ICONS.sparkles + " Générer par l'IA";
    }
  }

  const { close } = openModal({
    title: existing ? "Modifier le scénario" : "Nouveau scénario",
    body,
    footer: [
      el("button", { class: "btn btn-ghost", onclick: () => { cleanupIfUnsaved(); close(); } }, "Annuler"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        const payload = {
          name: name.input.value.trim() || "Scénario",
          intro: intro.input.value.trim(),
          notes: notes.input.value.trim(),
        };
        try {
          if (existing) await api(`/api/scenarios/${existing.id}`, { method: "PATCH", body: payload });
          else await api(`/api/worlds/${world.id}/scenarios`, { body: payload });
          saved = true; // the placeholder (if any) is now a real scenario
          close();
          await refreshAll();
          renderWorldDetail(world.id);
        } catch (e) { toast(e.message, "err"); }
      } }, "Enregistrer"),
    ],
    // Escape / backdrop close: same cleanup as the Annuler button
    onClose: cleanupIfUnsaved,
  });
}

// ─── cards ────────────────────────────────────────────────────────────────────
async function renderCards() {
  let cardQuery = "";
  let tagFilter = "";
  const cardSearch = el("input", { class: "search", placeholder: "Rechercher une carte…", "aria-label": "Rechercher une carte" });
  const allTags = [...new Set(store.cards.flatMap((c) => { try { return JSON.parse(c.tags || "[]"); } catch { return []; } }))].sort();
  const tagSelect = el("select", { class: "mini-select", "aria-label": "Filtrer par tag" }, el("option", { value: "" }, "Tous les tags"), ...allTags.map((t) => el("option", { value: t }, t)));
  const cardGrid = el("div", { class: "grid" });
  const paintCards = () => {
    const q = cardQuery.toLowerCase();
    const list = store.cards.filter((c) => {
      const tags = (() => { try { return JSON.parse(c.tags || "[]"); } catch { return []; } })();
      return (!q || `${c.name} ${c.description} ${c.personality} ${tags.join(" ")}`.toLowerCase().includes(q)) && (!tagFilter || tags.includes(tagFilter));
    });
    cardGrid.replaceChildren(...(list.length ? list.map(cardTile) : [el("div", { class: "empty" }, el("h3", {}, "Aucune carte trouvée"), el("p", {}, "Modifie la recherche ou le filtre."))]));
  };
  cardSearch.addEventListener("input", () => { cardQuery = cardSearch.value; paintCards(); });
  tagSelect.addEventListener("change", () => { tagFilter = tagSelect.value; paintCards(); });
  const dropzone = el("div", { class: "dropzone" },
    el("span", { class: "big" }, "🎭"),
    el("strong", {}, "Dépose tes cartes SillyTavern ici"),
    el("p", { style: { fontSize: "13px", marginTop: "6px" } }, "PNG (métadonnées Tavern) ou JSON — glisse-dépose ou clique pour choisir"),
    el("input", { type: "file", accept: ".png,.json", multiple: true, style: { display: "none" } }),
  );
  dropzone.addEventListener("click", () => dropzone.querySelector("input").click());
  dropzone.querySelector("input").addEventListener("change", (e) => doImport(e.target.files));
  ["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
  dropzone.addEventListener("drop", (e) => doImport(e.dataTransfer.files));

  const scanBtn = el("button", { class: "btn btn-ghost", onclick: scanDir }, ICONS.worlds, "Scanner un dossier");
  const newBtn = el("button", { class: "btn btn-primary", onclick: () => cardModal() }, ICONS.plus, "Créer un personnage");
  const container = el("div", {},
    el("div", { class: "page-head" },
      el("div", {},
        el("h2", {}, "🎭 Cartes"),
        el("div", { class: "sub" }, "Tes personnages importés (cartes SillyTavern V1/V2) ou créés à la main — avec l'aide de l'IA si tu veux."),
      ),
      newBtn,
      scanBtn,
    ),
    el("div", { class: "library-tools" }, cardSearch, tagSelect),
    dropzone,
  );
  if (!store.cards.length) {
    container.append(el("div", { class: "empty" },
      el("div", { class: "big" }, "🃏"),
      el("h3", {}, "Aucune carte pour l'instant"),
      el("p", {}, "Importe des cartes SillyTavern (PNG/JSON) ou crée ton premier personnage directement dans l'app."),
      el("button", { class: "btn btn-primary", onclick: () => cardModal() }, ICONS.plus, "Créer un personnage"),
    ));
  } else {
    container.append(cardGrid);
  }
  paintCards();
  main().replaceChildren(container);
}

async function doImport(files) {
  if (!files || !files.length) return;
  try {
    const list = await uploadFiles(files);
    const res = await api("/api/import", { body: { files: list } });
    const report = res.report || [];
    const imported = report.filter((r) => r.status === "imported").length;
    const duplicates = report.filter((r) => r.status === "duplicate");
    const invalid = report.filter((r) => r.status === "invalid");
    toast(`${imported} carte${imported > 1 ? "s" : ""} importée${imported > 1 ? "s" : ""} ✓` + (duplicates.length || invalid.length ? ` (${duplicates.length + invalid.length} ignorée${duplicates.length + invalid.length > 1 ? "s" : ""})` : ""));
    if (duplicates.length || invalid.length) {
      const okBtn = el("button", { class: "btn btn-primary" }, "OK");
      const { close } = openModal({
        title: "Rapport d'import",
        sub: "Certains fichiers n'ont pas été importés",
        body: el("div", { class: "import-report" }, report.map((r) =>
          el("div", { class: `import-line imp-${r.status}` },
            el("span", { class: "imp-icon" }, r.status === "imported" ? "✅" : r.status === "duplicate" ? "🔁" : "⚠️"),
            el("span", { class: "imp-name" }, esc(r.name)),
            el("span", { class: "imp-reason" }, esc(r.reason || (r.status === "imported" ? "importé" : r.status === "duplicate" ? "doublon" : "invalide"))),
          ),
        )),
        footer: [okBtn],
      });
      okBtn.addEventListener("click", close);
    }
    await refreshAll();
    renderCards();
  } catch (e) { toast(e.message, "err"); }
}

async function scanDir() {
  const { wrap, input } = field("Chemin du dossier", "", { placeholder: "C:\\Users\\moi\\cartes-sillytavern", autofocus: true });
  const { close } = openModal({
    title: "Scanner un dossier",
    body: el("div", {}, wrap, el("p", { style: { fontSize: "12.5px", color: "var(--text-dim)", marginTop: "8px" } }, "Tous les .png et .json du dossier seront importés.")),
    footer: [
      el("button", { class: "btn btn-ghost", onclick: () => close() }, "Annuler"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        try {
          const res = await api("/api/cards/scan", { body: { dir: input.value.trim() } });
          close();
          toast(`${res.imported} carte${res.imported > 1 ? "s" : ""} importée${res.imported > 1 ? "s" : ""} depuis le dossier ✓`);
          await refreshAll();
          renderCards();
        } catch (e) { toast(e.message, "err"); }
      } }, "Scanner"),
    ],
  });
}

function parseTags(raw) {
  try { return Array.isArray(raw) ? raw.map(String) : JSON.parse(raw || "[]").map(String); } catch { return []; }
}

function cardTile(card) {
  return el("div", { class: "card" },
    el("div", { style: { display: "flex", alignItems: "center", gap: "14px", padding: "18px 18px 8px" } },
      card.avatar ? el("img", { src: card.avatar, class: "avatar avatar-lg" }) : el("div", { class: "avatar avatar-lg", style: { display: "grid", placeItems: "center", fontSize: "22px" } }, "🎭"),
      el("div", { style: { minWidth: 0 } },
        el("h3", { style: { fontSize: "16px" } }, esc(card.name)),
      ),
    ),      el("div", { class: "card-body" },
      el("div", { class: "card-tags" }, ...parseTags(card.tags).map((tag) => el("span", { class: "chip" }, "#" + tag))),
      el("div", { class: "desc" }, esc(card.description || card.personality || "Personnage sans description")),
      el("div", { class: "card-actions" },
        el("button", { class: "mini-btn", onclick: () => cardModal(card) }, ICONS.edit, "Éditer"),
        el("button", { class: "mini-btn", style: { color: "var(--danger)" }, onclick: async () => {
          if (await confirmModal({ title: "Supprimer la carte", message: `Supprimer « ${card.name} » ? Elle ira dans la corbeille.` })) {
            softDeleteResource("card", card.id, card.name, () => renderCards());
          }
        } }, ICONS.trash),
      ),
    ),
  );
}

// 🎨 avatar auto-généré après la création d'une carte : portrait IA construit
// depuis les champs du personnage (seed stable par carte → même visage que les
// illustrations de dialogue), puis attaché à la carte. Tout se fait en
// arrière-plan — la création ne bloque jamais sur le serveur d'images.
const avatarGenInFlight = new Set();
export async function autoCardAvatar(id, fields, onDone) {
  if (!id || avatarGenInFlight.has(`card:${id}`)) return;
  avatarGenInFlight.add(`card:${id}`);
  try {
    const r = await api("/api/cards/generate-avatar", { body: { id, ...fields } });
    if (r?.image) {
      await api(`/api/cards/${id}`, { method: "PATCH", body: { avatar: r.image } });
      onDone?.(r.image);
    }
  } catch (e) {
    toast("Avatar IA non généré : " + (e?.message || "serveur d'images indisponible"), "warn");
  } finally {
    avatarGenInFlight.delete(`card:${id}`);
  }
}

export async function autoPersonaAvatar(id, fields, onDone) {
  if (!id || avatarGenInFlight.has(`persona:${id}`)) return;
  avatarGenInFlight.add(`persona:${id}`);
  try {
    const r = await api("/api/cards/generate-avatar", { body: fields });
    if (r?.image) {
      await api(`/api/personas/${id}`, { method: "PATCH", body: { avatar: r.image } });
      onDone?.(r.image);
    }
  } catch (e) {
    toast("Avatar IA du persona non généré : " + (e?.message || "serveur d'images indisponible"), "warn");
  } finally {
    avatarGenInFlight.delete(`persona:${id}`);
  }
}

function cardModal(existing) {
  const f = (v) => v ?? "";
  const name = field("Nom", f(existing?.name), { autofocus: true });
  const desc = field("Description", f(existing?.description), { type: "textarea", rows: 3 });
  const perso = field("Personnalité", f(existing?.personality), { type: "textarea", rows: 4 });
  const scenario = field("Situation du personnage", f(existing?.scenario), { type: "textarea", rows: 2 });
  const firstMes = field("Premier message (greeting)", f(existing?.first_mes), { type: "textarea", rows: 3 });
  const example = field("Exemple de dialogue", f(existing?.mes_example), { type: "textarea", rows: 4 });
  const sys = field("Prompt système (bonus)", f(existing?.system_prompt), { type: "textarea", rows: 2 });
  const tags = field("Tags (séparés par des virgules)", parseTags(existing?.tags).join(", "), { placeholder: "mage, romance, pnJ" });
  const avatarInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
  // ✨ AI avatar generation: portrait from the card fields, stable seed per
  // character, img2img rerolls (vary / same seed) keep the same face.
  const genBtn = el("button", { class: "btn btn-sm", onclick: () => genAvatar() }, "✨ Générer un avatar");
  const avatarStatus = el("span", { class: "avatar-gen-status" });
  const sameSeedBtn = el("button", { class: "mini-btn", hidden: true, title: "Même composition, détails différents", onclick: () => genAvatar("seed") }, "🔒 Même seed");
  const varyBtn = el("button", { class: "mini-btn", hidden: true, title: "Nouvelle variation du même personnage", onclick: () => genAvatar("vary") }, "🎲 Varier");
  let avatarPreview = existing?.avatar ? el("img", { src: existing.avatar, class: "avatar avatar-lg" }) : el("div", { class: "avatar avatar-lg", style: { display: "grid", placeItems: "center" } }, "🎭");
  const avatarBox = el("div", { class: "avatar-editor" },
    avatarPreview,
    el("div", { class: "avatar-controls" },
      el("div", { class: "avatar-actions" }, genBtn, avatarStatus),
      el("div", { class: "avatar-actions" }, avatarInput, sameSeedBtn, varyBtn),
    ),
  );
  let avatarData = null;   // dataURL d'un fichier choisi manuellement
  let avatarServer = null; // URL d'un avatar généré par IA
  let lastSeed = null;
  let genBusy = false;
  let everGen = false;
  avatarInput.addEventListener("change", () => { const file = avatarInput.files?.[0]; if (!file || file.size > 5 * 1024 * 1024) return toast("Avatar limité à 5 Mo", "err"); const reader = new FileReader(); reader.onload = () => { avatarData = String(reader.result); avatarServer = null; lastSeed = null; sameSeedBtn.hidden = true; varyBtn.hidden = true; avatarStatus.textContent = ""; const next = el("img", { src: avatarData, class: "avatar avatar-lg" }); avatarPreview.replaceWith(next); avatarPreview = next; updatePreview(); }; reader.readAsDataURL(file); });
  async function genAvatar(mode) {
    if (genBusy) return;
    if (!name.input.value.trim() && !desc.input.value.trim() && !perso.input.value.trim() && !scenario.input.value.trim() && !tags.input.value.trim()) return toast("Remplis au moins un champ du personnage pour générer un avatar.", "err");
    genBusy = true;
    genBtn.disabled = true;
    genBtn.textContent = "🎨 Génération…";
    try {
      const r = await api("/api/cards/generate-avatar", {
        body: {
          ...(existing?.id ? { id: existing.id } : {}),
          name: name.input.value.trim(),
          description: desc.input.value.trim(),
          personality: perso.input.value.trim(),
          scenario: scenario.input.value.trim(),
          tags: tags.input.value,
          ...(mode === "seed" && lastSeed != null ? { seed: lastSeed } : {}),
          ...(avatarServer ? { ref_image: avatarServer } : {}),
        },
      });
      avatarServer = r.image; lastSeed = r.seed; avatarData = null;
      const next = el("img", { src: avatarServer, class: "avatar avatar-lg" });
      avatarPreview.replaceWith(next); avatarPreview = next;
      avatarStatus.textContent = "seed " + r.seed;
      sameSeedBtn.hidden = false; varyBtn.hidden = false;
      everGen = true;
      toast("Avatar généré ✓ — enregistre pour le garder", "ok");
      updatePreview();
    } catch (e) { toast(e.message, "err"); }
    finally { genBusy = false; genBtn.disabled = false; genBtn.textContent = everGen ? "↻ Régénérer l'avatar" : "✨ Générer un avatar"; }
  }
  // ── ✨ Aide IA : tu décris ton idée, le modèle propose des chips par champ ──
  // et tu choisis tes préférées d'un clic (chaque chip remplit son champ).
  const ASSIST_FIELDS = [
    { key: "name", id: "name", label: "Nom" },
    { key: "tags", id: "tags", label: "Tags" },
    { key: "description", id: "desc", label: "Description" },
    { key: "personality", id: "perso", label: "Personnalité" },
    { key: "scenario", id: "scenario", label: "Situation" },
    { key: "first_mes", id: "firstMes", label: "Premier message" },
    { key: "mes_example", id: "example", label: "Exemple de dialogue" },
  ];
  const fieldOf = { name, tags, desc, perso, scenario, firstMes, example };
  const assistChips = new Map();
  for (const af of ASSIST_FIELDS) assistChips.set(af.key, el("div", { class: "assist-chips", hidden: true }));
  const assistTa = el("textarea", { class: "assist-ta", rows: 2, placeholder: "Décris ton idée en quelques mots — ex : « elfe rousse, marchande ambulante, sarcastique, connaît tous les secrets du port »" });
  const assistBtn = el("button", { class: "btn btn-primary btn-sm", onclick: runAssist }, ICONS.sparkles, "Proposer");
  const assistRegen = el("button", { class: "mini-btn", hidden: true, onclick: runAssist }, "↻ Régénérer");
  const assistStatus = el("div", { class: "assist-status", hidden: true });
  let assistBusy = false;
  async function runAssist() {
    const idea = assistTa.value.trim();
    if (!idea) return toast("Décris d'abord ton idée de personnage.", "err");
    if (assistBusy) return;
    assistBusy = true;
    assistBtn.disabled = true;
    assistRegen.hidden = true;
    assistStatus.hidden = false;
    assistStatus.textContent = "✨ L'IA réfléchit… (quelques secondes)";
    try {
      const r = await api("/api/cards/assist", { body: { idea } });
      const fields = r.fields || {};
      let any = false;
      for (const af of ASSIST_FIELDS) {
        const values = (fields[af.key] || []).map((x) => String(x).trim()).filter(Boolean);
        const box = assistChips.get(af.key);
        if (!values.length) { box.hidden = true; box.replaceChildren(); continue; }
        any = true;
        box.hidden = false;
        box.replaceChildren(
          el("span", { class: "assist-label" }, "💡 " + af.label + " :"),
          ...values.map((v) => {
            const chip = el("button", { type: "button", class: "assist-chip", title: v, onclick: () => {
              const input = fieldOf[af.id].input;
              if (af.key === "tags") {
                input.value = v.replace(/#+/g, "").split(/[,;]/).map((t) => t.trim()).filter(Boolean).join(", ");
              } else {
                input.value = v;
              }
              box.querySelectorAll(".assist-chip").forEach((c) => c.classList.remove("selected"));
              chip.classList.add("selected");
              input.dispatchEvent(new Event("input"));
              input.focus();
            } }, v.length > 96 ? v.slice(0, 96) + "…" : v);
            return chip;
          }),
        );
      }
      assistStatus.textContent = any ? "Choisis ta préférée dans chaque champ ✨" : "Le modèle n'a rien proposé — réessaie ou vérifie la connexion IA.";
      assistRegen.hidden = !any;
      if (any) toast("Propositions générées ✓", "ok");
    } catch (e) {
      assistStatus.hidden = true;
      toast(String(e?.message || e), "err");
    } finally {
      assistBusy = false;
      assistBtn.disabled = false;
    }
  }
  const assistPanel = el("details", { class: "assist-panel" },
    el("summary", {}, ICONS.sparkles + " Aide IA — générer des propositions"),
    el("div", { class: "assist-body" },
      assistTa,
      el("div", { class: "assist-actions" }, assistBtn, assistRegen, assistStatus),
    ),
  );
  assistTa.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runAssist(); } });
  // ── live preview (SillyTavern-style character sheet) ──
  const preview = el("div", { class: "card-preview" }, el("div", { class: "card-preview-empty" }, "Aperçu en direct…"));
  const updatePreview = () => {
    const n = name.input.value.trim();
    const d = desc.input.value.trim();
    const p = perso.input.value.trim();
    const sc = scenario.input.value.trim();
    const fm = firstMes.input.value.trim();
    const ex = example.input.value.trim();
    const secs = [];
    if (p) secs.push(el("div", { class: "preview-sec" }, el("strong", {}, "Personnalité"), el("p", {}, esc(p))));
    if (sc) secs.push(el("div", { class: "preview-sec" }, el("strong", {}, "Situation"), el("p", {}, esc(sc))));
    if (fm) secs.push(el("div", { class: "preview-sec preview-greet" }, el("strong", {}, "Premier message"), el("blockquote", {}, esc(fm))));
    if (ex) secs.push(el("div", { class: "preview-sec preview-greet" }, el("strong", {}, "Exemple de dialogue"), el("blockquote", {}, esc(ex))));
    const previewImg = avatarServer || avatarData || existing?.avatar || null;
    preview.replaceChildren(
      previewImg
        ? el("img", { src: previewImg, class: "preview-avatar img" })
        : el("div", { class: "preview-avatar", style: { background: `linear-gradient(135deg, hsl(${(n.length * 59) % 360} 70% 55%), hsl(${(n.length * 59 + 60) % 360} 80% 40%))` } },
          n ? n[0].toUpperCase() : "?"),
      el("h3", {}, esc(n || "Nouvelle carte")),
      el("div", { class: "preview-sec" },
        el("strong", {}, "Description"),
        el("p", {}, esc(d || "—")),
      ),
      ...secs,
    );
  };
  for (const inp of [name.input, desc.input, perso.input, scenario.input, firstMes.input, example.input, sys.input, tags.input]) {
    inp.addEventListener("input", updatePreview);
    inp.addEventListener("change", updatePreview);
  }
  updatePreview();
  const formCol = el("div", { class: "card-form-col" },
    avatarBox, assistPanel,
    name.wrap, assistChips.get("name"),
    tags.wrap, assistChips.get("tags"),
    desc.wrap, assistChips.get("description"),
    perso.wrap, assistChips.get("personality"),
    scenario.wrap, assistChips.get("scenario"),
    firstMes.wrap, assistChips.get("first_mes"),
    example.wrap, assistChips.get("mes_example"),
    sys.wrap,
  );
  const body = el("div", { class: "card-modal-grid" }, formCol, preview);
  const { close } = openModal({
    title: existing ? `Éditer ${existing.name}` : "Nouvelle carte",
    body, wide: true,
    footer: [
      el("button", { class: "btn btn-ghost", onclick: () => close() }, "Annuler"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        const payload = {
          name: name.input.value.trim() || "Carte",
          description: desc.input.value.trim(), personality: perso.input.value.trim(),
          scenario: scenario.input.value.trim(), first_mes: firstMes.input.value.trim(),
          mes_example: example.input.value.trim(), system_prompt: sys.input.value.trim(),
          tags: JSON.stringify(tags.input.value.split(",").map((x) => x.trim()).filter(Boolean)), ...(avatarData ? { avatar: avatarData } : {}), ...(avatarServer ? { avatar: avatarServer } : {}),
        };
        try {
          let created = null;
          if (existing) await api(`/api/cards/${existing.id}`, { method: "PATCH", body: payload });
          else created = await api("/api/cards", { body: payload });
          close();
          await refreshAll();
          renderCards();
          // 🎨 nouveau personnage sans avatar fourni → portrait IA en arrière-plan
          if (created?.id && !payload.avatar) {
            autoCardAvatar(created.id, {
              name: payload.name, description: payload.description, personality: payload.personality,
              scenario: payload.scenario, tags: payload.tags,
            }, async () => {
              await refreshCards();
              if (location.hash.startsWith("#/cards")) renderCards();
            });
          }
        } catch (e) { toast(e.message, "err"); }
      } }, "Enregistrer"),
    ],
  });
}

// ─── personas ─────────────────────────────────────────────────────────────────
async function renderPersonas() {
  const container = el("div", {},
    el("div", { class: "page-head" },
      el("div", {},
        el("h2", {}, "🧑‍🤝‍🧑 Persona"),
        el("div", { class: "sub" }, "Qui es-tu dans l'histoire ? Ton persona est injecté dans chaque partie."),
      ),
      el("button", { class: "btn btn-primary", onclick: () => personaModal() }, ICONS.plus, "Nouveau persona"),
    ),
  );
  if (!store.personas.length) {
    container.append(el("div", { class: "empty" },
      el("div", { class: "big" }, "🧝"),
      el("h3", {}, "Aucun persona"),
      el("p", {}, "Crée le personnage que tu incarnes : héros réincarné, chevalier déchu, étudiant transporté dans un autre monde…"),
      el("button", { class: "btn btn-primary", onclick: () => personaModal() }, "Créer mon persona"),
    ));
  } else {
    container.append(el("div", { class: "grid" }, store.personas.map((p) =>
      el("div", { class: "card" },
        el("div", { style: { display: "flex", alignItems: "center", gap: "14px", padding: "18px 18px 8px" } },
          p.avatar ? el("img", { src: p.avatar, class: "avatar avatar-lg" }) : el("div", { class: "avatar avatar-lg", style: { display: "grid", placeItems: "center", fontSize: "22px" } }, "🧝"),
          el("h3", { style: { fontSize: "16px" } }, esc(p.name)),
        ),
        el("div", { class: "card-body" },
          el("div", { class: "desc" }, esc(p.description || "Persona sans description")),
          el("div", { class: "card-actions" },
            el("button", { class: "mini-btn", onclick: () => personaModal(p) }, ICONS.edit, "Éditer"),
            el("button", { class: "mini-btn", style: { color: "var(--danger)" }, onclick: async () => {
              if (await confirmModal({ title: "Supprimer le persona", message: `Supprimer « ${p.name} » ? Il ira dans la corbeille.` })) {
                softDeleteResource("persona", p.id, p.name, () => renderPersonas());
              }
            } }, ICONS.trash),
          ),
        ),
      ),
    )));
  }
  main().replaceChildren(container);
}

function personaModal(existing) {
  const name = field("Nom", existing?.name, { autofocus: true });
  const desc = field("Description", existing?.description, { type: "textarea", rows: 6, placeholder: "Qui es-tu ? Ton passé, ton apparence, tes pouvoirs, tes motivations…" });
  const body = el("div", {}, name.wrap, desc.wrap);
  const { close } = openModal({
    title: existing ? "Modifier le persona" : "Nouveau persona",
    body,
    footer: [
      el("button", { class: "btn btn-ghost", onclick: () => close() }, "Annuler"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        const payload = { name: name.input.value.trim() || "Persona", description: desc.input.value.trim() };
        try {
          let created = null;
          if (existing) await api(`/api/personas/${existing.id}`, { method: "PATCH", body: payload });
          else created = await api("/api/personas", { body: payload });
          close();
          await refreshAll();
          renderPersonas();
          if (created?.id) {
            autoPersonaAvatar(created.id, { name: payload.name, description: payload.description }, async () => {
              await refreshPersonas();
              if (location.hash.startsWith("#/personas")) renderPersonas();
            });
          }
        } catch (e) { toast(e.message, "err"); }
      } }, "Enregistrer"),
    ],
  });
}

// ─── settings ─────────────────────────────────────────────────────────────────
async function renderSettings() {
  const s = store.settings;
  const container = el("div", {},
    el("div", { class: "page-head" },
      el("div", {},
        el("h2", {}, "⚙️ Réglages"),
        el("div", { class: "sub" }, "Fournisseur d'IA, narrateurs et génération d'images."),
      ),
    ),
  );
  // quick navigation between the sections
  const tocItem = (id, label) => el("a", { href: `#`, class: "chip-btn slim", onclick: (e) => {
    e.preventDefault();
    document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  } }, label);
  container.append(el("div", { class: "settings-toc" },
    tocItem("ia", "🤖 IA"),
    tocItem("narr", "🎭 Narrateurs"),
    tocItem("img", "🖼 Images"),
    tocItem("app", "🎨 Apparence"),
    tocItem("sc", "⌨️ Raccourcis"),
    tocItem("backup", "💾 Sauvegarde"),
    tocItem("storage", "📦 Stockage"),
    tocItem("jobs", "🧵 Tâches"),
  ));

  // ── IA ──
  container.append(el("div", { class: "section-title", id: "sec-ia" }, "IA conversationnelle"));
  const providerSel = field("Fournisseur", s.provider || "lmstudio", {
    type: "select", options: [["lmstudio", "LM Studio (local)"], ["openrouter", "OpenRouter (cloud)"]],
  });
  const lmUrl = field("URL LM Studio (API)", s.lmstudio_url || "http://localhost:1234/v1", { placeholder: "http://localhost:1234/v1" });
  const orKey = field("Clé API OpenRouter", s.openrouter_key || "", { type: "password", placeholder: "sk-or-v1-…" });
  const lmModel = field("Modèle LM Studio", s.lmstudio_model || "", { placeholder: "Chargement…" });
  const orModel = field("Modèle OpenRouter", s.openrouter_model || "", { placeholder: "Ex: anthropic/claude-3.7-sonnet" });
  // ── narrator style presets (built-ins + user overrides, editable below) ──
  const narrMap = {}; // key → { label, prompt, custom, dirty }
  for (const [k, v] of Object.entries(BUILTIN_NARRATOR)) narrMap[k] = { ...v, custom: false, dirty: false };
  try {
    for (const [k, v] of Object.entries((s.narrator_presets || {}))) {
      if (v?.prompt) narrMap[k] = { label: (v.label || (BUILTIN_NARRATOR[k]?.label ?? k)), prompt: v.prompt, custom: !BUILTIN_NARRATOR[k], dirty: false };
    }
  } catch { /* ignore */ }
  const narrOptions = () => Object.entries(narrMap).map(([k, v]) => [k, v.label + (k === "epique" ? " (défaut)" : "") + (v.custom ? " ⭐" : "")]);
  const narrStyle = field("Style du narrateur", s.narrator_style || "epique", { type: "select", options: narrOptions() });
  // live preview of the active style under the select
  const stylePreview = el("p", { class: "style-preview" }, narrMap[narrStyle.input.value]?.prompt || "");
  narrStyle.input.addEventListener("change", () => {
    const p = narrMap[narrStyle.input.value];
    stylePreview.textContent = p ? p.prompt : "";
  });

  const refreshModels = async () => {
    try {
      const models = await api(`/api/health`).catch(() => null); // just to keep import
      void models;
      const prov = providerSel.input.value;
      const res = await apiFetch(`/api/models?provider=${prov}`, { method: "GET" }).catch(() => null);
      let list = [];
      if (res?.ok) list = (await res.json()).models || [];
      if (prov === "lmstudio" && list.length) {
        lmModel.input.replaceChildren(...list.map((m) => el("option", { value: m, ...(m === s.lmstudio_model ? { selected: "" } : {}) }, m)));
      }
    } catch { /* ignore */ }
  };

  providerSel.input.addEventListener("change", refreshModels);
  lmUrl.input.addEventListener("change", refreshModels);
  orKey.input.addEventListener("input", () => { /* typed; saved on save */ });

  const llmTimeout = field("Timeout du modèle (s)", s.llm_timeout || 150, { type: "number", min: 20, max: 900, step: 10 });
  container.append(el("div", { class: "card", style: { padding: "18px 22px" } },
    el("div", { class: "row" }, providerSel.wrap, narrStyle.wrap),
    el("div", { class: "row" }, lmUrl.wrap, orKey.wrap),
    el("div", { class: "row" }, lmModel.wrap, orModel.wrap),
    el("div", { class: "row" }, llmTimeout.wrap),
    stylePreview,
    el("p", { style: { fontSize: "12.5px", color: "var(--text-dim)", marginTop: "12px" } },
      "LM Studio : lance le serveur local (onglet Developer → Start Server, port 1234). OpenRouter : colle ta clé API — les deux peuvent être utilisés et le choix se fait au lancement de partie. Le style du narrateur s'applique aux nouvelles réponses.",
    ),
    el("div", { style: { marginTop: "14px" } },
      el("button", { class: "btn btn-ghost btn-sm", onclick: testServices }, "🧪 Tester tous les services"),
      el("div", { id: "services-test", style: { marginTop: "10px" } }),
    ),
    el("div", { style: { marginTop: "18px", borderTop: "1px solid var(--border)", paddingTop: "14px" } },
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("span", { class: "sec-sub" }, "🩺 Santé du fournisseur (cette session)"),
        el("button", { class: "btn btn-ghost btn-sm", title: "Actualiser", onclick: loadProviderHealth, "aria-label": "Actualiser la santé du fournisseur" }, "↻"),
      ),
      el("div", { id: "provider-health", style: { marginTop: "10px" } }),
    ),
  ));

  // ── Presets du narrateur (éditeur compact, replié par défaut) ──
  const refreshNarrOptions = () => {
    const cur = narrStyle.input.value;
    narrStyle.input.replaceChildren(...narrOptions().map(([v, l]) => el("option", { value: v, ...(v === cur ? { selected: "" } : {}) }, l)));
    const p = narrMap[cur];
    if (stylePreview) stylePreview.textContent = p ? p.prompt : "";
    if (editSelect) editSelect.input.replaceChildren(...narrOptions().map(([v, l]) => el("option", { value: v, ...(v === editKey ? { selected: "" } : {}) }, l)));
  };
  let editKey = s.narrator_style || "epique";
  const editSelect = field("Narrateur à modifier", editKey, { type: "select", options: narrOptions() });
  const renameInput = el("input", { class: "narr-label-input", placeholder: "Nouveau nom…", hidden: true });
  const promptTa = el("textarea", { class: "narr-prompt-input", rows: 4, placeholder: "Instructions pour ce style de narrateur…" });
  const dirtyFlag = el("span", { class: "narr-dirty", hidden: true }, "non enregistré");
  const useKey = el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
    if (!narrMap[editKey]) return;
    narrStyle.input.value = editKey;
    refreshNarrOptions();
    toast(`Style actif : ${narrMap[editKey].label} ✓`);
  } }, "✓ Utiliser ce style");
  const loadEdit = () => {
    const p = narrMap[editKey];
    if (!p) return;
    promptTa.value = p.prompt;
    renameInput.value = p.label;
    renameInput.hidden = true;
    dirtyFlag.hidden = !p.dirty;
  };
  editSelect.input.addEventListener("change", () => { editKey = editSelect.input.value; loadEdit(); });
  promptTa.addEventListener("input", () => {
    const p = narrMap[editKey]; if (!p) return;
    p.prompt = promptTa.value; p.dirty = true;
    dirtyFlag.hidden = false;
    refreshNarrOptions();
  });
  renameInput.addEventListener("input", () => {
    const p = narrMap[editKey]; if (!p) return;
    p.label = renameInput.value.trim() || p.label; p.dirty = true;
    dirtyFlag.hidden = false;
    refreshNarrOptions();
  });
  const newPresetBtn = el("button", { class: "btn btn-ghost btn-sm", onclick: (e) => {
    e.preventDefault(); e.stopPropagation();
    let n = 1;
    while (narrMap[`perso_${n}`]) n++;
    narrMap[`perso_${n}`] = { label: `Personnalisé ${n}`, prompt: "Tu racontes avec un style unique à inventer.", custom: true, dirty: true };
    editKey = `perso_${n}`;
    refreshNarrOptions();
    loadEdit();
  } }, ICONS.plus, "Ajouter");
  loadEdit();
  container.append(el("div", { class: "section-title", id: "sec-narr" }, "Narrateurs"));
  container.append(el("details", { class: "card narr-collapse" },
    el("summary", { class: "narr-summary", title: "Cliquer pour déplier" },
      el("span", { class: "narr-summary-main" },
        "🎭 Presets du narrateur",
        el("span", { class: "narr-count" }, String(Object.keys(narrMap).length) + " styles"),
      ),
      newPresetBtn,
      el("span", { class: "narr-chev" }, "▾"),
    ),
    el("div", { class: "narr-editor" },
      el("p", { style: { fontSize: "12.5px", color: "var(--text-dim)", margin: "6px 0 12px" } },
        "Choisis un narrateur, modifie son texte (injecté dans le prompt système), renomme-le ou supprime-le. Les presets ⭐ sont les tiens ; les préréglages peuvent être modifiés puis réinitialisés.",
      ),
      el("div", { class: "row" }, editSelect.wrap, useKey),
      el("div", { class: "narr-rename-row" },
        renameInput,
        el("button", { class: "mini-btn", title: "Renommer (Entrée pour valider)", onclick: () => {
          renameInput.hidden = false;
          renameInput.focus();
          renameInput.select();
        } }, "✏️ Renommer"),
        el("button", { class: "mini-btn", title: "Restaurer le texte d'origine", onclick: () => {
          if (BUILTIN_NARRATOR[editKey]) {
            narrMap[editKey] = { ...BUILTIN_NARRATOR[editKey], custom: false, dirty: false };
            loadEdit(); refreshNarrOptions();
          }
        } }, "↺ Réinitialiser"),
        el("button", { class: "mini-btn", style: { color: "var(--danger)" }, title: "Supprimer ce preset", onclick: () => {
          if (!narrMap[editKey]?.custom) return toast("Les presets de base ne se suppriment pas — modifie-les ou réinitialise-les.", "err");
          delete narrMap[editKey];
          editKey = "epique";
          refreshNarrOptions(); loadEdit();
        } }, ICONS.trash, "Supprimer"),
        dirtyFlag,
      ),
      promptTa,
    ),
  ));

  // ── Images ──
  container.append(el("div", { class: "section-title", id: "sec-img" }, "Images (Koji)"));
  const imgSteps = field("Étapes de génération", s.image_steps || 28, { type: "number", min: 8, max: 60, step: 1 });
  const imgCfg = field("Guidance", s.image_cfg || 7, { type: "number", min: 3, max: 15, step: 0.5 });
  const imgRef = field("Fidélité au portrait (img2img)", s.image_ref_strength ?? 0.55, {
    type: "select",
    options: [["0.35", "Inventive (0.35)"], ["0.55", "Équilibré (0.55)"], ["0.75", "Fidèle (0.75)"], ["1", "Copie (1 — déconseillé)"]],
  });
  const imgPreload = checkbox("image_preload", s.image_preload === true, "Précharger le modèle d'images au démarrage");
  container.append(el("div", { class: "card", style: { padding: "18px 22px" } },
    el("div", { class: "row" }, imgSteps.wrap, imgCfg.wrap, imgRef.wrap),
    el("div", { class: "row" }, imgPreload.wrap),
    el("div", { style: { marginTop: "12px" } },
      el("button", { class: "btn btn-ghost btn-sm", onclick: async () => {
        try {
          toast("Chargement du modèle d'images… (plusieurs minutes la 1re fois)", "ok", 20000);
          const r = await api("/api/images/preload", { body: {} });
          toast(r.ok ? "Modèle d'images prêt ✓" : "Échec du chargement — regarde les logs.", r.ok ? "ok" : "err");
        } catch (e) { toast(e.message, "err"); }
      } }, ICONS.image, "Précharger le modèle d'images"),
    ),
    el("p", { style: { fontSize: "12.5px", color: "var(--text-dim)", marginTop: "12px" } },
      "Koji (SD1.5) tourne dans un service Python local sur le GPU. Les scènes 100 % décor (paysages, lieux) sont générées en format paysage automatiquement.",
    ),
  ));

  // ── Apparence & sécurité ──
  container.append(el("div", { class: "section-title", id: "sec-app" }, "Apparence & sécurité"));
  const accentCur = localStorage.getItem("innsekai-accent") || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff7ad9";
  const accentWrap = el("label", { class: "fl-field" },
    el("input", { type: "color", value: accentCur }),
    el("span", { class: "fl-label" }, "Couleur d'accent"),
  );
  accentWrap.querySelector("input").addEventListener("input", (e) => {
    localStorage.setItem("innsekai-accent", e.target.value);
    applyCustom();
  });
  const bgWrap = el("label", { class: "fl-field" },
    el("input", { value: localStorage.getItem("innsekai-bg") || "", placeholder: " " }),
    el("span", { class: "fl-label" }, "Image de fond (URL)"),
  );
  bgWrap.querySelector("input").addEventListener("input", (e) => {
    localStorage.setItem("innsekai-bg", e.target.value.trim());
    applyCustom();
  });
  const authField = field("Token d'accès LAN (vide = ouvert)", s.auth_token || "", { type: "password", placeholder: "Garde-le secret — protège l'API sur le réseau" });
  const notifCb = checkbox("notifications", s.notifications !== false, "Notifications quand la réponse est prête");
  const soundCb = checkbox("sound_effects", s.sound_effects !== false, "Effets sonores (whoosh, chime)");
  container.append(el("div", { class: "card", style: { padding: "18px 22px" } },
    el("div", { class: "row3" }, accentWrap, bgWrap, authField.wrap),
    el("div", { class: "row" },
      notifCb.wrap,
      soundCb.wrap,
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
        localStorage.removeItem("innsekai-accent");
        localStorage.removeItem("innsekai-bg");
        applyCustom();
        toast("Apparence réinitialisée ✓");
        renderSettings();
      } }, "↺ Réinitialiser l'apparence"),
    ),
    el("p", { style: { fontSize: "12.5px", color: "var(--text-dim)", marginTop: "12px" } },
      "Couleur d'accent et fond : stockés sur cet appareil. Token : quand il est défini, toute l'API exige ce mot de passe — utile quand l'app écoute sur le Wi-Fi.",
    ),
  ));

  // ── Raccourcis clavier (éditeur de touches, configurable) ──
  container.append(el("div", { class: "section-title", id: "sec-sc" }, "Raccourcis clavier"));
  const shortcutsDraft = { ...getShortcuts() };
  const scBox = el("div", { class: "shortcut-list" });
  const paintShortcuts = () => {
    scBox.replaceChildren(...Object.keys(SHORTCUT_LABELS).map((name) => {
      const kbd = el("kbd", {}, shortcutsDraft[name] || "—");
      const editBtn = el("button", { class: "btn btn-ghost btn-sm", title: `Modifier le raccourci « ${SHORTCUT_LABELS[name]} »` }, "Modifier");
      const resetBtn = el("button", { class: "mini-btn", title: "Rétablir la valeur par défaut", "aria-label": "Rétablir la valeur par défaut", onclick: () => { shortcutsDraft[name] = SHORTCUT_DEFAULTS[name]; paintShortcuts(); } }, "↺");
      editBtn.addEventListener("click", () => {
        editBtn.disabled = true;
        editBtn.textContent = "Appuie sur une touche… (Esc = annuler)";
        shortcutCapturing = true;
        const done = (e) => {
          if (e.key === "Escape") { /* cancel */ }
          else {
            e.preventDefault();
            e.stopPropagation();
            shortcutsDraft[name] = canonShortcut(e);
          }
          shortcutCapturing = false;
          document.removeEventListener("keydown", done, true);
          paintShortcuts();
        };
        document.addEventListener("keydown", done, true);
      });
      return el("div", { class: "shortcut-row" },
        el("span", { class: "sc-label" }, SHORTCUT_LABELS[name]),
        kbd,
        editBtn,
        resetBtn,
      );
    }));
  };
  paintShortcuts();
  container.append(el("div", { class: "card", style: { padding: "18px 22px" } },
    scBox,
    el("p", { style: { fontSize: "12.5px", color: "var(--text-dim)", marginTop: "12px" } },
      "Enregistre les réglages pour appliquer les nouveaux raccourcis. La palette (Ctrl+K) s'ouvre aussi depuis le champ de recherche.",
    ),
  ));

  // ── Backup / restore ──
  container.append(el("div", { class: "section-title", id: "sec-backup" }, "Sauvegarde"));
  const fileInput = el("input", { type: "file", accept: ".json,application/json", hidden: true });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.conversations)) {
        throw new Error("ce fichier ne ressemble pas à une sauvegarde innsekai");
      }
      // restore ADDS rows — warn before the user duplicates what they already
      // have (restoring the same file twice re-creates every element)
      const would = (parsed.conversations?.length || 0) + (parsed.worlds?.length || 0)
        + (parsed.cards?.length || 0) + (parsed.personas?.length || 0) + (parsed.scenarios?.length || 0);
      const existing = (store.conversations?.length || 0) + (store.worlds?.length || 0)
        + (store.cards?.length || 0) + (store.personas?.length || 0);
      if (would > 0 && existing > 0 && !(await confirmModal({
        title: "La restauration va AJOUTER des données",
        message: `Ce fichier contient ${would} élément(s) (parties, mondes, cartes, personas…). Restaurer ne remplace rien : ils seront créés EN PLUS des ${existing} élément(s) déjà présents — restaurer deux fois le même fichier duplique donc tout.`,
        confirmLabel: "Restaurer quand même",
      }))) return;
      toast("Restauration en cours…", "ok", 8000);
      const res = await api("/api/backup", { body: { backup: parsed } });
      toast(`Restauration terminée : ${res.worlds} mondes, ${res.cards} cartes, ${res.conversations} parties ✓`);
      await refreshAll();
      renderSettings();
    } catch (e) { toast("Fichier invalide : " + e.message, "err"); }
  });
  container.append(el("div", { class: "card", style: { padding: "18px 22px" } },
    el("div", { class: "row" },
      el("button", { class: "btn btn-ghost btn-sm", onclick: async () => {
        try {
          const data = await api("/api/export");
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `innsekai-backup-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
          toast("Sauvegarde téléchargée ✓");
        } catch (e) { toast(e.message, "err"); }
      } }, "⬇️ Exporter tout (mondes, cartes, parties)"),
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => fileInput.click() }, "⬆️ Restaurer depuis un fichier"),
      fileInput,
    ),
    el("p", { style: { fontSize: "12.5px", color: "var(--text-dim)", marginTop: "12px" } },
      "La sauvegarde contient tes mondes, scénarios, cartes, personas et conversations (texte + réglages), ainsi que les illustrations et avatars qu'ils référencent. Restaurer ajoute ces données à celles déjà présentes.",
    ),
  ));

  // ── Stockage & backups auto ──
  container.append(el("div", { class: "section-title", id: "sec-storage" }, "Stockage & sauvegardes auto"));
  const storageCard = el("div", { class: "card", style: { padding: "18px 22px" } }, el("div", { class: "storage-line" }, "⏳ lecture du disque…"));
  const renderStorage = async () => {
    try {
      const st = await api("/api/storage");
      const mb = (v) => `${Math.max(0, v).toFixed(1)} Mo`;
      storageCard.replaceChildren(
        el("div", { class: "storage-grid" },
          el("div", { class: "storage-tile" }, el("strong", {}, mb(st.imagesMB)), el("span", {}, "🖼 Illustrations")),
          el("div", { class: "storage-tile" }, el("strong", {}, mb(st.uploadsMB)), el("span", {}, "📎 Avatars & uploads")),
          el("div", { class: "storage-tile" }, el("strong", {}, mb(st.dbMB)), el("span", {}, "🗄 Base de données")),
        ),
        el("div", { class: "row", style: { marginTop: "14px" } },
          el("button", { class: "btn btn-ghost btn-sm", onclick: async () => {
            try {
              const r = await api("/api/backup", { body: {} });
              toast(r.ok ? "Backup créé ✓" : "Backup impossible", r.ok ? "ok" : "err");
              renderStorage();
            } catch (e) { toast(e.message, "err"); }
          } }, "💾 Créer un backup maintenant"),
          el("button", { class: "btn btn-ghost btn-sm", onclick: () => orphanModal() }, "🧹 Analyser les fichiers orphelins"),
        ),
        el("div", { class: "storage-backups" },
          (st.backups?.length
            ? st.backups.map((b) => el("div", { class: "storage-backup" },
                el("span", {}, "📦 " + esc(b.file)),
                el("span", {}, mb(b.size / 1e6) + " · " + new Date(b.date).toLocaleString("fr-FR")),
              ))
            : [el("p", { style: { color: "var(--text-dim)", fontSize: "13px" } }, "Aucun backup pour l'instant — un backup SQLite complet est créé chaque jour automatiquement.")]),
        ),
      );
    } catch (e) {
      storageCard.replaceChildren(el("div", { class: "storage-line" }, "Stockage indisponible : " + esc(e.message)));
    }
  };
  renderStorage();
  container.append(storageCard);

  // ── Tâches en arrière-plan (file de jobs persistante) ──
  container.append(el("div", { class: "section-title", id: "sec-jobs" }, "Tâches en arrière-plan"));
  const jobsCard = el("div", { class: "card", style: { padding: "18px 22px" } });
  const jobsRefresh = el("button", { class: "chip-btn slim", style: { marginLeft: "auto" }, title: "Actualiser", onclick: () => paintJobs() }, "↻");
  const jobsHead = el("div", { class: "jobs-head" }, el("span", { style: { fontSize: "13px", color: "var(--text-dim)" } }, "Images, résumés et légendes s'enregistrent ici (file persistante, reprise après redémarrage)."), jobsRefresh);
  container.append(jobsHead, jobsCard);
  const statusLabel = { pending: "en attente", running: "en cours", done: "terminé", failed: "échec" };
  let jobsTimer = null;
  const paintJobs = async () => {
    try {
      const { jobs } = await api("/api/jobs").catch(() => ({ jobs: [] }));
      jobsCard.replaceChildren(
        jobs.length
          ? el("div", { class: "jobs-list" }, jobs.map((j) =>
              el("div", { class: "job-row" },
                el("span", { class: `job-status st-${j.status}` }, j.status === "done" ? "✓" : j.status === "failed" ? "✗" : "⏳"),
                el("span", { class: "job-type" }, esc(j.type)),
                el("span", { class: "job-meta" }, `${statusLabel[j.status] || j.status}${j.progress ? " · " + j.progress + "%" : ""} · ${fmtTime(j.created_at)}`),
                j.error ? el("span", { class: "job-error" }, esc(String(j.error).slice(0, 90))) : null,
              ),
            ))
          : el("p", { style: { color: "var(--text-dim)", fontSize: "13px" } }, "Aucune tâche enregistrée pour l'instant."),
      );
      // live refresh while something is still running
      if (jobs.some((j) => j.status === "running" || j.status === "pending")) {
        clearTimeout(jobsTimer);
        jobsTimer = setTimeout(paintJobs, 4000);
      }
    } catch { /* ignore */ }
  };
  paintJobs();

  container.append(el("div", { class: "settings-save" },
    el("button", { class: "btn btn-primary", style: { padding: "12px 30px" }, onclick: async () => {
      try {
        await api("/api/settings", {
          method: "PATCH",
          body: {
            provider: providerSel.input.value,
            lmstudio_url: lmUrl.input.value.trim(),
            lmstudio_model: lmModel.input.value.trim(),
            openrouter_key: orKey.input.value.trim(),
            openrouter_model: orModel.input.value.trim(),
            narrator_style: narrStyle.input.value,
            narrator_presets: Object.fromEntries(
              Object.entries(narrMap).map(([k, v]) => [k, { label: v.label, prompt: v.prompt }]),
            ),
            image_steps: Number(imgSteps.input.value),
            image_cfg: Number(imgCfg.input.value),
            image_ref_strength: Number(imgRef.input.value),
            image_preload: imgPreload.input.checked,
            llm_timeout: Number(llmTimeout.input.value),
            auth_token: authField.input.value.trim(),
            notifications: notifCb.input.checked,
            sound_effects: soundCb.input.checked,
            shortcuts: shortcutsDraft,
          },
        });
        applyCustom();
        toast("Réglages enregistrés ✓");
        await refreshAll();
        renderSettings();
      } catch (e) { toast(e.message, "err"); }
    } }, "Enregistrer les réglages"),
  ));

  main().replaceChildren(container);
  refreshModels();
  loadProviderHealth();
}

// Réglages → IA : vérifie d'un coup le modèle et le service d'images
async function testServices() {
  const box = document.getElementById("services-test");
  if (!box) return;
  box.replaceChildren(el("div", { class: "storage-line" }, "⏳ test des services…"));
  try {
    const r = await api("/api/test", { body: {} });
    const row = (icon, title, ok, detail) => el("div", { class: "svc-row" },
      el("span", { class: "svc-icon" }, ok ? "✅" : "❌"),
      el("span", { class: "svc-name" }, title),
      el("span", { class: "svc-detail" }, esc(detail)),
      el("span", { class: "svc-ms" }, r[icon]?.ms != null ? `${r[icon].ms} ms` : ""),
    );
    const p = r.provider || {};
    const im = r.image || {};
    box.replaceChildren(
      row("provider", "Modèle " + (p.provider || ""), p.ok, p.ok ? (p.models || []).join(", ") : "aucun modèle détecté — LM Studio démarré ?"),
      row("image", "Service d'images", !im.error && im.ready, im.error || (im.loading ? "chargement du modèle…" : im.ready ? "prêt" : "non démarré")),
    );
  } catch (e) {
    box.replaceChildren(el("div", { class: "storage-line" }, "Test impossible : " + esc(e.message)));
  }
}

// Réglages → Fournisseur : statistiques de santé par provider (latence, erreurs)
async function loadProviderHealth() {
  const box = document.getElementById("provider-health");
  if (!box) return;
  try {
    const stats = await api("/api/health/providers", { method: "GET" });
    const entries = Object.entries(stats || {});
    if (!entries.length) {
      box.replaceChildren(el("div", { class: "storage-line" }, "Aucun appel encore mesuré — lance une réponse ou « Tester tous les services »."));
      return;
    }
    const card = ([id, h]) => {
      const dots = (h.history || []).slice(-10).map((e) =>
        el("span", { class: "hp-dot" + (e.ok ? " ok" : " err"), title: `${e.ok ? "OK" : "Erreur"} · ${e.ms} ms · ${new Date(e.at).toLocaleTimeString("fr-FR")}` }),
      );
      const rate = h.calls ? Math.round((h.ok / h.calls) * 100) : 0;
      return el("div", { class: "hp-card" },
        el("div", { class: "hp-head" },
          el("span", { class: "hp-name" }, id === "openrouter" ? "OpenRouter" : "LM Studio"),
          el("span", { class: "hp-rate" + (rate >= 80 ? " good" : rate > 0 ? " bad" : "") }, `${rate}% OK`),
        ),
        el("div", { class: "hp-line" }, `${h.calls} appel${h.calls > 1 ? "s" : ""} · ${h.ok} ok · ${h.errors} erreur${h.errors > 1 ? "s" : ""}`),
        el("div", { class: "hp-line" },
          `moyenne ${h.avgMs} ms` + (h.lastMs != null ? ` · dernier ${h.lastMs} ms` : "") + (h.lastAt ? ` · ${new Date(h.lastAt).toLocaleTimeString("fr-FR")}` : ""),
        ),
        h.lastError ? el("div", { class: "hp-line hp-err" }, "⚠ " + esc(h.lastError)) : null,
        dots.length ? el("div", { class: "hp-dots", title: "10 derniers appels" }, ...dots) : null,
      );
    };
    box.replaceChildren(...entries.map(card));
  } catch (e) {
    box.replaceChildren(el("div", { class: "storage-line" }, "Santé indisponible : " + esc(e.message)));
  }
}

// Réglages → Stockage : scan (simulation) puis suppression des fichiers orphelins
async function orphanModal() {
  let analysis = null;
  try {
    analysis = await api("/api/storage/analyze", { body: {} });
  } catch (e) { return toast(e.message, "err"); }
  const kindIcon = { image: "🖼", upload: "📎" };
  const rows = (analysis.orphans || []).map((o) => {
    const cb = el("input", { type: "checkbox", checked: "" });
    return el("label", { class: "orphan-row" },
      cb,
      el("span", { class: "chip" }, kindIcon[o.kind] || "📄"),
      el("span", { class: "orphan-path", title: o.path }, esc(o.path)),
      el("span", { class: "orphan-size" }, (o.size / 1024).toFixed(0) + " Ko"),
    );
  });
  const list = el("div", { class: "orphan-list" });
  const paint = () => {
    const picked = rows.filter((r) => r.querySelector("input").checked);
    deleteBtn.disabled = !picked.length;
    deleteBtn.textContent = `🗑 Supprimer ${picked.length} fichier${picked.length > 1 ? "s" : ""}`;
  };
  rows.forEach((r) => r.querySelector("input").addEventListener("change", paint));
  list.append(...rows);
  const cancelBtn = el("button", { class: "btn btn-ghost" }, "Annuler");
  const deleteBtn = el("button", { class: "btn btn-danger" }, "🗑 Supprimer");
  const { close } = openModal({
    title: "🧹 Fichiers orphelins",
    sub: analysis.orphanCount
      ? `${analysis.orphanCount} fichier${analysis.orphanCount > 1 ? "s" : ""} inutilisé${analysis.orphanCount > 1 ? "s" : ""} (≈ ${analysis.totalMB} Mo) — avatars remplacés, illustrations de messages supprimés, uploads orphelins…`
      : "Aucun fichier orphelin : tout ce qui est sur le disque est encore référencé.",
    body: analysis.orphanCount ? list : el("div", { class: "empty" }, el("div", { class: "big" }, "✨"), el("h3", {}, "Rien à nettoyer")),
    footer: [cancelBtn, deleteBtn],
    wide: true,
  });
  cancelBtn.addEventListener("click", close);
  paint();
  deleteBtn.addEventListener("click", async () => {
    const picked = rows.filter((r) => r.querySelector("input").checked).map((r) => r.querySelector(".orphan-path").textContent);
    try {
      const r = await api("/api/storage/purge", { body: { files: picked } });
      close();
      toast(`${r.removed} fichier${r.removed > 1 ? "s" : ""} supprimé${r.removed > 1 ? "s" : ""} (≈ ${((r.bytes || 0) / 1e6).toFixed(1)} Mo) ✓`);
      renderSettings();
    } catch (e) { toast(e.message, "err"); }
  });
}

function checkbox(key, checked, labelText) {
  const wrap = el("div", { class: "setting-row" },
    el("span", { class: "lbl" }, labelText),
    el("label", { class: "switch" },
      el("input", { type: "checkbox", ...(checked ? { checked: "" } : {}) }),
      el("span", { class: "slider" }),
    ),
  );
  return { wrap, input: wrap.querySelector("input") };
}

// ─── new game wizard ──────────────────────────────────────────────────────────
const GENRE_OPTS = [
  ["mystere", "🔍 Mystère"],
  ["romance", "💞 Romance"],
  ["comedie", "🎭 Comédie"],
  ["action", "⚔️ Action / Aventure"],
  ["horreur", "🌑 Horreur"],
  ["pvp", "⚡ PVP"],
];

// ─── guided builder « Décris ce que tu veux » ────────────────────────────────
// Une idée en langage libre → l'IA propose MONDE (existants correspondants +
// 4 nouveaux), puis 4 PERSONAS, puis 4 CARTES par personnage évoqué.
// Chaque lot : propositions éditables + « Valider » individuel, et un champ
// d'amélioration qui ne régénère QUE le lot courant. À la fin, tout est créé
// pour de vrai (avatars en arrière-plan) et la nouvelle partie s'ouvre pré-remplie.
function guidedWizard() {
  // Choices persist in `st` across steps so the user can wander back and forth;
  // `memo` keeps the last fetched batch per stage so « ← » renders instantly
  // (no second LLM call); `created` + per-character ids make the final step
  // resumable — a failure mid-creation never duplicates the world or persona.
  const st = { desc: "", world: null, persona: null, chars: [], memo: {}, charsCtx: null, requests: { worlds: 0, personas: 0, characters: 0 }, viewVersion: 0, created: { worldId: null, worldKey: "", worldOwned: false, personaId: null, personaKey: "", personaOwned: false } };
  const labels = ["Idée", "Monde", "Persona", "Personnages", "Créer"];
  let stepIdx = 0;
  const progress = el("div", { class: "assist-progress" });
  const stepEl = el("div", { class: "assist-stepbox" });
  const body = el("div", {}, progress, stepEl);
  openModal({ title: "✨ Décris ce que tu veux", sub: "L'IA construit ton monde, ton persona et tes personnages — lot par lot : modifie, valide ou affine. Tu peux revenir en arrière à tout moment, tes choix sont gardés.", body, wide: true });

  const paintProgress = () => {
    progress.replaceChildren(...labels.map((s, i) =>
      el("span", { class: "assist-ps" + (i === stepIdx ? " cur" : i < stepIdx ? " done" : "") }, i < stepIdx ? "✓ " + s : s)),
    );
  };
  const run = (fn) => { stepEl.replaceChildren(fn()); };
  const fieldRow = (label, value, placeholder, rows) => {
    const input = rows > 1
      ? el("textarea", { rows, placeholder: placeholder ?? "", class: "assist-in" }, value ?? "")
      : el("input", { placeholder: placeholder ?? "", class: "assist-in", value: value ?? "" });
    return { wrap: el("label", { class: "assist-field" }, el("span", {}, label), input), input };
  };
  const spinner = (txt) => el("div", { class: "assist-status" }, "⏳ " + esc(txt));
  // soft=true renders the previous batch from memory instead of calling the LLM.
  const go = (i, soft) => {
    if (i === 1) stepWorlds("", soft);
    else if (i === 2) stepPersonas("", soft);
    else if (i === 3) stepCharacters(soft);
    else stepCreate();
  };
  const keyOf = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

  // ── étape 1 : la description libre ──
  function stepDescribe() {
    const viewVersion = ++st.viewVersion;
    stepIdx = 0; paintProgress();
    const ta = fieldRow("Ton idée", st.desc, "Ex. : Un monde médiéval fantastique avec de la magie. Moi, Max, 22 ans, je suis téléporté au milieu de nulle part, dans un village perdu. Il y a une tavernière mystérieuse et un garde arrogant…", 7).input;
    ta.style.minHeight = "150px";
    const ex1 = "Un monde médiéval fantastique avec de la magie. Moi, Max, 22 ans, je suis téléporté au milieu de nulle part, dans un village perdu. Il y a une tavernière mystérieuse et un garde arrogant.";
    const ex2 = "Un futur cyberpunk moite et pluvieux où la mémoire se vend à crédit. Je suis un détective endetté, et une fantôme de synthèse me hante. Décris mes partenaires de fortune.";
    run(() => el("div", {},
      el("h3", {}, "Raconte ton idée"),
      el("p", { class: "modal-note" }, "Décris le monde, qui tu es, ce qui t'arrive — et les personnages que tu veux voir (facultatif). Ton modèle local (LM Studio) a besoin de quelques secondes par lot : laisse-le finir."),
      ta,
      el("div", { class: "assist-refine", style: { justifyContent: "flex-start" } },
        el("button", { class: "chip-btn", onclick: () => { ta.value = ex1; } }, "Ex. isekai médiéval"),
        el("button", { class: "chip-btn", onclick: () => { ta.value = ex2; } }, "Ex. cyberpunk"),
      ),
      el("div", { class: "assist-refine", style: { justifyContent: "flex-end" } },
        el("button", { class: "btn btn-primary", onclick: () => {
          st.desc = ta.value.trim();
          if (!st.desc) return toast("Décris d'abord ton idée.", "err");
          stepWorlds("");
        } }, "✨ Générer mon monde"),
      ),
    ));
  }

  // ── étape 2 : choisir / améliorer le monde ──
  async function stepWorlds(feedback, soft = false) {
    const viewVersion = ++st.viewVersion;
    stepIdx = 1; paintProgress();
    const requestId = ++st.requests.worlds;
    const list = el("div", { class: "assist-list" });
    const status = spinner("L'IA propose des mondes…");
    const root = el("div", {},
      el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } },
        el("h3", { style: { margin: 0 } }, "🌍 Choisis (ou affine) ton monde"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => stepDescribe() }, "← Idée"),
      ),
      el("p", { class: "modal-note" }, "Si un monde existant correspond, il est proposé en premier ; sinon l'IA en invente. Chaque carte est modifiable avant validation."),
      status, list,
    );
    run(() => root);
    const paintBatch = (r) => {
      status.hidden = true;
      const matches = r.matches || [];
      const proposals = r.proposals || [];
      const chosenKey = keyOf(st.world?.name);
      if (matches.length) {
        list.append(el("div", { class: "assist-sec" }, "✅ Déjà dans tes mondes"));
        for (const m of matches) {
          const w = store.worlds.find((x) => x.id === m.id);
          if (!w) continue;
          const isChosen = st.world?.id === w.id;
          list.append(el("div", { class: "assist-prop reuse" + (isChosen ? " chosen" : "") },
            el("strong", {}, esc(w.name)),
            el("p", {}, esc(m.reason || w.description?.slice(0, 160) || "")),
            el("div", { class: "card-actions" }, el("button", { class: "btn btn-primary btn-sm", onclick: () => {
              st.world = { id: w.id, name: w.name, description: w.description, tone: w.tone, lore: w.lore };
              st.created.worldId = w.id; st.created.worldKey = keyOf(w.name); st.created.worldOwned = false;
              st.memo.personas = null; st.chars = []; st.charsCtx = null; // contexte changé → régénère la suite
              go(2, false);
            } }, isChosen ? "✓ Monde choisi" : "Choisir ce monde")),
          ));
        }
      }
      if (proposals.length) {
        list.append(el("div", { class: "assist-sec" }, "🌱 Mondes générés"));
        for (const p of proposals) {
          const fName = fieldRow("Nom", p.name, "", 1);
          const fDesc = fieldRow("Description", p.description, "Ce qui rend ce monde unique, sa magie…", 4);
          const fTone = fieldRow("Genre / ambiance", p.tone, "ex. heroic fantasy sombre", 1);
          const fLore = fieldRow("Histoire fondatrice", p.lore, "Passé, enjeux…", 3);
          const isChosen = !st.world?.id && keyOf(p.name) === chosenKey;
          list.append(el("div", { class: "assist-prop" + (isChosen ? " chosen" : "") }, fName.wrap, fDesc.wrap, fTone.wrap, fLore.wrap,
            el("div", { class: "card-actions" }, el("button", { class: "btn btn-primary btn-sm", onclick: () => {
              const world = {
                id: null, name: fName.input.value.trim(), description: fDesc.input.value.trim(),
                tone: fTone.input.value.trim(), lore: fLore.input.value.trim(),
              };
              if (!world.name) return toast("Donne un nom au monde.", "err");
              if (!world.description) return toast("Décris le monde en une phrase au minimum.", "err");
              st.world = world;
              st.memo.personas = null; st.chars = []; st.charsCtx = null;
              go(2, false);
            } }, isChosen ? "✓ Monde choisi" : "Valider ce monde")),
          ));
        }
      }
      if (!matches.length && !proposals.length) {
        list.append(el("div", { class: "empty" }, el("h3", {}, "Le modèle n'a rien proposé"), el("p", {}, "Passe par l'amélioration ci-dessous et régénère.")));
      }
      const fb = el("input", { class: "assist-in", placeholder: "💡 Améliorer ces propositions (ex. « plus sombre, avec des îles flottantes »)…" });
      list.append(el("div", { class: "assist-refine" }, fb,
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
          const v = fb.value.trim();
          if (!v) return toast("Écris d'abord ton amélioration.", "err");
          stepWorlds(v, false);
        } }, "↻ Régénérer ce lot"),
      ));
    };
    if (soft && st.memo.worlds) { paintBatch(st.memo.worlds); return; }
    try {
      const r = await api("/api/assist/build", { body: { stage: "worlds", description: st.desc, feedback: feedback || "" } });
      if (requestId !== st.requests.worlds || viewVersion !== st.viewVersion) return;
      st.memo.worlds = r;
      paintBatch(r);
    } catch (e) {
      if (requestId !== st.requests.worlds || viewVersion !== st.viewVersion) return;
      status.replaceChildren(el("span", { class: "danger" }, "⚠️ " + esc(e.message)));
      list.append(el("div", { class: "assist-refine" },
        el("button", { class: "btn btn-primary btn-sm", onclick: () => stepWorlds(feedback, false) }, "↻ Réessayer"),
      ));
    }
  }

  // ── étape 3 : choisir / améliorer le persona ──
  async function stepPersonas(feedback, soft = false) {
    const viewVersion = ++st.viewVersion;
    stepIdx = 2; paintProgress();
    const requestId = ++st.requests.personas;
    const batchKey = keyOf(`${st.desc}|${st.world?.id || ""}|${st.world?.name || ""}`);
    const list = el("div", { class: "assist-list" });
    const status = spinner("L'IA propose des personas…");
    const root = el("div", {},
      el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } },
        el("h3", { style: { margin: 0 } }, "🧑‍🤝‍🧑 Qui incarnes-tu ?"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => go(1, true) }, "← Monde"),
      ),
      el("p", { class: "modal-note" }, "4 façons d'être « toi » dans ce monde — ou ton persona existant s'il correspond déjà. Modifie puis valide."),
      status, list,
    );
    run(() => root);
    const paintBatch = (r) => {
      status.hidden = true;
      const matches = r.matches || [];
      const proposals = r.proposals || [];
      const chosenKey = keyOf(st.persona?.name);
      if (matches.length) {
        list.append(el("div", { class: "assist-sec" }, "✅ Ton persona existe déjà"));
        for (const m of matches) {
          const p = store.personas.find((x) => x.id === m.id);
          if (!p) continue;
          const isChosen = st.persona?.id === p.id;
          list.append(el("div", { class: "assist-prop reuse" + (isChosen ? " chosen" : "") },
            el("strong", {}, esc(p.name)),
            el("p", {}, esc(m.reason || p.description?.slice(0, 160) || "")),
            el("div", { class: "card-actions" }, el("button", { class: "btn btn-primary btn-sm", onclick: () => {
              st.persona = { id: p.id, name: p.name, description: p.description };
              st.created.personaId = p.id; st.created.personaKey = keyOf(p.name); st.created.personaOwned = false;
              st.chars = []; st.charsCtx = null;
              go(3, false);
            } }, isChosen ? "✓ Persona choisi" : "Utiliser ce persona")),
          ));
        }
      }
      if (proposals.length) {
        list.append(el("div", { class: "assist-sec" }, "🌱 Personas générés"));
        for (const p of proposals) {
          const fName = fieldRow("Nom", p.name, "", 1);
          const fDesc = fieldRow("Description", p.description, "Qui tu es, apparence, passé, motivation…", 4);
          const isChosen = !st.persona?.id && keyOf(p.name) === chosenKey;
          list.append(el("div", { class: "assist-prop" + (isChosen ? " chosen" : "") }, fName.wrap, fDesc.wrap,
            el("div", { class: "card-actions" }, el("button", { class: "btn btn-primary btn-sm", onclick: () => {
              const persona = { id: null, name: fName.input.value.trim(), description: fDesc.input.value.trim() };
              if (!persona.name) return toast("Donne un nom à ton persona.", "err");
              st.persona = persona;
              st.chars = []; st.charsCtx = null;
              go(3, false);
            } }, isChosen ? "✓ Persona choisi" : "Valider ce persona")),
          ));
        }
      }
      if (!matches.length && !proposals.length) {
        list.append(el("div", { class: "empty" }, el("h3", {}, "Le modèle n'a rien proposé"), el("p", {}, "Affine et régénère ci-dessous.")));
      }
      const fb = el("input", { class: "assist-in", placeholder: "💡 Améliorer ces personas (ex. « plus naïf, avec un secret »)…" });
      list.append(el("div", { class: "assist-refine" }, fb,
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
          const v = fb.value.trim();
          if (!v) return toast("Écris d'abord ton amélioration.", "err");
          stepPersonas(v, false);
        } }, "↻ Régénérer ce lot"),
      ));
    };
    if (soft && st.memo.personas && st.memo.personasKey === batchKey) {
      paintBatch(st.memo.personas);
      return;
    }
    try {
      const r = await api("/api/assist/build", { body: { stage: "personas", description: st.desc, world: st.world, feedback: feedback || "" } });
      if (requestId !== st.requests.personas || viewVersion !== st.viewVersion) return;
      st.memo.personas = r;
      st.memo.personasKey = batchKey;
      paintBatch(r);
    } catch (e) {
      if (requestId !== st.requests.personas || viewVersion !== st.viewVersion) return;
      status.replaceChildren(el("span", { class: "danger" }, "⚠️ " + esc(e.message)));
      list.append(el("div", { class: "assist-refine" },
        el("button", { class: "btn btn-primary btn-sm", onclick: () => stepPersonas(feedback, false) }, "↻ Réessayer"),
      ));
    }
  }

  // ── étape 4 : personnages évoqués → 4 cartes chacun ──
  async function stepCharacters(soft = false) {
    const viewVersion = ++st.viewVersion;
    stepIdx = 3; paintProgress();
    const requestId = ++st.requests.characters;
    const charsKey = keyOf(`${st.desc}|${st.world?.id || ""}|${st.world?.name || ""}|${st.persona?.id || ""}|${st.persona?.name || ""}`);
    const list = el("div", { class: "assist-list" });
    const status = spinner("Recherche des personnages évoqués…");
    const addName = el("input", { class: "assist-in", placeholder: "Nom d'un personnage…" });
    const addRole = el("input", { class: "assist-in", placeholder: "Rôle (optionnel)…" });
    const genAllBtn = el("button", { class: "btn btn-primary", onclick: async () => {
      genAllBtn.disabled = true; genAllBtn.textContent = "⏳ Génération des cartes…";
      for (const ch of st.chars) { ch.cards = null; ch.chosen = null; }
      for (const ch of st.chars) await genCards(ch, "");
      genAllBtn.disabled = false; genAllBtn.textContent = "↻ Régénérer toutes les cartes";
    } }, "✨ Générer les cartes");
    const root = el("div", {},
      el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } },
        el("h3", { style: { margin: 0 } }, "🎭 Personnages évoqués"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => go(2, true) }, "← Persona"),
      ),
      el("p", { class: "modal-note" }, "Ceux que tu as décrits, repérés dans ton idée. Chacun recevra 4 cartes à choisir — ou sa carte existante si elle correspond déjà."),
      status, list,
      el("div", { class: "assist-footer" },
        el("div", { class: "assist-refine", style: { flex: "1" } }, addName, addRole,
          el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
            const nm = addName.value.trim();
            if (!nm) return toast("Écris un nom.", "err");
            st.chars.push({ name: nm, role: addRole.value.trim(), detail: "", reuseName: null, reuseCard: null, cards: null, chosen: null, status: "", skipped: false });
            addName.value = ""; addRole.value = "";
            paint();
          } }, "＋ Ajouter"),
        ),
        el("div", { class: "assist-refine", style: { justifyContent: "flex-end" } },
          el("button", { class: "btn btn-ghost", onclick: () => stepCreate() }, "→ Continuer"),
          el("button", { class: "btn btn-ghost btn-sm", title: "Relit ton idée depuis le début et remplace la liste", onclick: () => { st.chars = []; st.charsCtx = null; stepCharacters(false); } }, "↻ Relire ton idée"),
          genAllBtn,
        ),
      ),
    );
    const paint = () => { list.replaceChildren(...st.chars.map(charRow)); };
    run(() => root);

    const genCards = async (ch, feedback) => {
      ch.status = "⏳ L'IA crée 4 cartes pour « " + ch.name + " »…";
      paint();
      try {
        const r = await api("/api/assist/build", { body: { stage: "cards", description: st.desc, world: st.world, character: { name: ch.name, role: ch.role, detail: ch.detail || "" }, feedback: feedback || "" } });
        ch.cards = (r.proposals || []).filter((p2) => p2 && p2.name).slice(0, 4);
        ch.status = "";
        if (!ch.cards.length) ch.status = "Le modèle n'a rien proposé pour « " + ch.name + " » — affine ci-dessous.";
      } catch (e) {
        ch.status = "⚠️ " + e.message;
      }
      paint();
    };

    const cardProp = (c, ch) => {
      const f = {
        name: fieldRow("Nom", c.name, "", 1),
        desc: fieldRow("Description", c.description, "Apparence, signes distinctifs…", 3),
        pers: fieldRow("Personnalité", c.personality, "", 2),
        sce: fieldRow("Situation initiale", c.scenario, "", 2),
        tags: fieldRow("Tags", Array.isArray(c.tags) ? c.tags.join(", ") : "", "", 1),
      };
      return el("div", { class: "assist-prop sub" }, f.name.wrap, f.desc.wrap, f.pers.wrap, f.sce.wrap, f.tags.wrap,
        el("div", { class: "card-actions" }, el("button", { class: "btn btn-primary btn-sm", onclick: () => {
          ch.chosen = {
            card: {
              name: f.name.input.value.trim() || "Personnage",
              description: f.desc.input.value.trim(),
              personality: f.pers.input.value.trim(),
              scenario: f.sce.input.value.trim(),
              tags: f.tags.input.value.split(",").map((t) => t.trim()).filter(Boolean),
            },
          };
          paint();
        } }, "✓ Valider cette carte")),
      );
    };

    const charRow = (ch) => {
      const parts = [];
      parts.push(el("div", { class: "char-head" },
        el("input", { class: "assist-in", value: ch.name, oninput: (e) => (ch.name = e.target.value.trim()) }),
        el("input", { class: "assist-in", value: ch.role, placeholder: "Rôle…", oninput: (e) => (ch.role = e.target.value.trim()) }),
        el("button", { class: "mini-btn", title: "Retirer ce personnage", onclick: () => { st.chars = st.chars.filter((x) => x !== ch); paint(); } }, "🗑"),
      ));
      if (ch.detail) parts.push(el("div", { class: "assist-hint", style: { fontSize: "12px" } }, "📜 " + esc(ch.detail)));
      if (ch.reuseCard) parts.push(el("div", { class: "assist-hint reuse" }, "💡 Correspond à ta carte « " + esc(ch.reuseCard.name) + " »."));
      if (ch.status) parts.push(el("div", { class: "assist-status" }, esc(ch.status)));
      if (ch.chosen) {
        parts.push(el("div", { class: "assist-hint ok" },
          "✓ " + (ch.chosen.reuseCardId ? "Carte existante utilisée : « " + esc(ch.reuseCard.name) + " »" : "Carte choisie : « " + esc(ch.chosen.card.name) + " »"),
          el("button", { class: "mini-btn", onclick: () => { ch.chosen = null; paint(); } }, "↺ Changer"),
        ));
      } else {
        // The matching existing card is offered immediately, BEFORE any LLM
        // call: choosing it skips the 4-variant generation entirely.
        if (ch.reuseCard) parts.push(el("div", { class: "assist-prop reuse" },
          el("strong", {}, "Déjà dans ta collection"),
          el("p", {}, esc(ch.reuseCard.description || "")),
          el("div", { class: "card-actions" }, el("button", { class: "btn btn-primary btn-sm", onclick: () => { ch.chosen = { reuseCardId: ch.reuseCard.id, reuseName: ch.reuseCard.name }; paint(); } }, "Utiliser « " + esc(ch.reuseCard.name) + " »")),
        ));
        if (ch.cards) {
          if (ch.cards.length) parts.push(el("div", { class: "assist-sec" }, "Variantes générées"));
          for (const c of ch.cards) parts.push(cardProp(c, ch));
          const fb = el("input", { class: "assist-in", placeholder: "💡 Pas convaincu ? Améliore et régénère…" });
          parts.push(el("div", { class: "assist-refine" }, fb,
            el("button", { class: "btn btn-ghost btn-sm", onclick: () => genCards(ch, fb.value.trim()) }, "↻ Régénérer"),
          ));
        } else {
          parts.push(el("div", { class: "assist-hint" }, ch.reuseCard
            ? "Sa carte existante est proposée ci-dessus — ou génère des variantes si tu préfères."
            : "En attente — clique sur « ✨ Générer les cartes »."));
        }
      }
      return el("div", { class: "assist-prop char-row" }, ...parts);
    };

    const applyCharacters = (r, preserve = false) => {
      const previous = new Map(preserve ? st.chars.map((c) => [keyOf(c.name), c]) : []);
      const chars = (r.characters || []).map((c) => {
        const old = previous.get(keyOf(c.name));
        return old || {
          name: c.name, role: c.role || "", detail: c.detail || "", reuseName: c.reuse || null,
          reuseCard: c.reuse ? (store.cards.find((x) => keyOf(x.name) === keyOf(c.reuse)) || null) : null,
          cards: null, chosen: null, status: "", skipped: false,
        };
      });
      if (preserve) {
        for (const old of st.chars) if (!chars.some((c) => keyOf(c.name) === keyOf(old.name))) chars.push(old);
      }
      st.chars = chars;
      st.charsCtx = charsKey;
      st.memo.characters = r;
      paint();
      if (!chars.length) {
        list.append(el("div", { class: "empty" }, el("h3", {}, "Aucun personnage repéré"), el("p", {}, "Ajoute-en à la main ci-dessous, ou continue sans personnages secondaires.")));
      }
    };
    if (soft && st.memo.characters && st.charsCtx === charsKey) {
      status.hidden = true;
      applyCharacters(st.memo.characters, true);
      return;
    }
    try {
      const r = await api("/api/assist/build", { body: { stage: "characters", description: st.desc, world: st.world, persona: st.persona, feedback: "" } });
      if (requestId !== st.requests.characters || viewVersion !== st.viewVersion) return;
      status.hidden = true;
      // Keep a manual character added while the extraction request was in
      // flight; the user should never lose edits because the model answered.
      applyCharacters(r, st.chars.length > 0);    } catch (e) {
      if (requestId !== st.requests.characters || viewVersion !== st.viewVersion) return;
      status.replaceChildren(el("span", { class: "danger" }, "⚠️ " + esc(e.message)));
      list.append(el("div", { class: "assist-refine" },
        el("button", { class: "btn btn-primary btn-sm", onclick: () => stepCharacters(false) }, "↻ Réessayer"),
      ));
    }
  }


  // ── étape 5 : récap & création réelle ──
  function stepCreate() {
    ++st.viewVersion;
    stepIdx = 4; paintProgress();
    const chosen = st.chars.map((ch) => ch.chosen).filter(Boolean);
    run(() => el("div", {},
      el("h3", {}, "✨ Vérifie et crée"),
      el("p", { class: "modal-note" }, "Tout sera créé pour de vrai (avatars en arrière-plan), puis la nouvelle partie s'ouvrira pré-remplie."),
      el("div", { class: "assist-summary" },
        el("div", {}, el("strong", {}, "🌍 Monde"), el("p", {}, esc((st.world?.name || "") + (st.world?.description ? " — " + st.world.description : "")))),
        el("div", {}, el("strong", {}, "🧑‍🤝‍🧑 Persona"), el("p", {}, esc(st.persona?.name || st.persona?.description || "—"))),
        el("div", {}, el("strong", {}, "🎭 Personnages (" + chosen.length + ")"),
          el("p", {}, esc(chosen.map((c) => (c.reuseCardId ? c.reuseName || "carte existante" : c.card.name)).join(", ") || "aucun") + (st.chars.length > chosen.length ? " — d'autres personnages sans carte validée seront ignorés." : "")),
        ),
      ),
      el("div", { class: "assist-refine", style: { justifyContent: "flex-end", marginTop: "16px" } },
        el("button", { class: "btn btn-ghost", onclick: () => stepCharacters(true) }, "← Retour"),
        el("button", { class: "btn btn-primary", onclick: async (e) => {
          const btn = e.target;
          btn.disabled = true; btn.textContent = "Création…";
          try {
            if (!st.world?.name?.trim()) throw new Error("Choisis ou définis un monde avant de continuer.");

            // Keep every successful write in wizard state immediately. If a
            // later request fails, retrying resumes here instead of creating
            // a second world/persona/card.
            const worldKey = keyOf(st.world.name);
            let worldId = st.world.id || null;
            let worldCreated = false;
            let worldChanged = false;
            if (worldId && st.created.worldOwned && st.created.worldId === worldId && st.created.worldKey !== worldKey) {
              await api(`/api/worlds/${worldId}`, { method: "PATCH", body: { name: st.world.name, description: st.world.description, tone: st.world.tone || "épique", lore: st.world.lore || "" } });
              worldChanged = true;
            }
            if (!worldId && st.created.worldId && st.created.worldKey === worldKey) {
              worldId = st.created.worldId;
            }
            if (!worldId) {
              const existing = store.worlds.find((w) => keyOf(w.name) === worldKey);
              if (existing) {
                worldId = existing.id;
              } else {
                const w = await api("/api/worlds", { body: { name: st.world.name, description: st.world.description, tone: st.world.tone || "épique", lore: st.world.lore || "" } });
                worldId = w.id;
                worldCreated = true;
              }
            }
            st.world = { ...st.world, id: worldId };
            st.created.worldId = worldId;
            st.created.worldKey = worldKey;
            st.created.worldOwned = Boolean(st.created.worldOwned || worldCreated);
            if (worldCreated || worldChanged) api(`/api/worlds/${worldId}/cover`, { body: {} }).catch(() => {});

            // Reuse a selected existing persona, or resume/reuse a same-name
            // one before creating a new record. New personas still get an
            // avatar in the background.
            let personaId = st.persona?.id || null;
            let personaCreated = false;
            let personaChanged = false;
            if (st.persona) {
              const personaKey = keyOf(st.persona.name);
              if (personaId && st.created.personaOwned && st.created.personaId === personaId && st.created.personaKey !== personaKey) {
                await api(`/api/personas/${personaId}`, { method: "PATCH", body: { name: st.persona.name, description: st.persona.description } });
                personaChanged = true;
              }
              if (!personaId && st.created.personaId && st.created.personaKey === personaKey) {
                personaId = st.created.personaId;
              }
              if (!personaId) {
                const existing = store.personas.find((p) => keyOf(p.name) === personaKey);
                if (existing) personaId = existing.id;
              }
              if (!personaId) {
                const p = await api("/api/personas", { body: { name: st.persona.name, description: st.persona.description } });
                personaId = p.id;
                personaCreated = true;
              }
              st.persona = { ...st.persona, id: personaId };
              st.created.personaId = personaId;
              st.created.personaKey = personaKey;
              st.created.personaOwned = Boolean(st.created.personaOwned || personaCreated);
              if (personaCreated || personaChanged) {
                autoPersonaAvatar(personaId, { name: st.persona.name, description: st.persona.description }, async () => {
                  await refreshPersonas();
                });
              }
            }

            // Create each selected card once. A same-name card already in the
            // collection is reused, preventing duplicates from hand-edited
            // proposals as well as from a resumed partial run.
            const cast = [];
            const castSeen = new Set();
            const cardIdsByName = new Map(store.cards.map((x) => [keyOf(x.name), x.id]));
            const addCast = (id) => { if (id && !castSeen.has(id)) { castSeen.add(id); cast.push(id); } };
            for (const ch of st.chars) {
              if (ch.chosen?.reuseCardId) { addCast(ch.chosen.reuseCardId); continue; }
              const card = ch.chosen?.card;
              if (!card?.name?.trim()) continue;
              const cardKey = keyOf(card.name);
              const cardPayload = { name: card.name, description: card.description, personality: card.personality, scenario: card.scenario, tags: JSON.stringify(card.tags || []) };
              const cardSignature = JSON.stringify(cardPayload);
              // A wizard-owned card keeps its identity even if the user edits
              // its name between retries; update it instead of creating a
              // second card under the new name.
              let cardId = ch.createdId && ch.createdOwned ? ch.createdId : null;
              let cardCreated = false;
              let cardChanged = false;
              if (cardId && ch.createdSignature !== cardSignature) {
                await api(`/api/cards/${cardId}`, { method: "PATCH", body: cardPayload });
                cardChanged = true;
              }
              if (!cardId) cardId = cardIdsByName.get(cardKey) || null;
              if (!cardId) {
                const c = await api("/api/cards", { body: cardPayload });
                cardId = c.id;
                cardCreated = true;
                // Keep same-run retries and same-name proposals idempotent even
                // before refreshAll() updates the global store.
                cardIdsByName.set(cardKey, cardId);
              }
              ch.createdId = cardId;
              ch.createdKey = cardKey;
              ch.createdOwned = Boolean(ch.createdOwned || cardCreated);
              ch.createdSignature = cardSignature;
              addCast(cardId);
              if (cardCreated || cardChanged) autoCardAvatar(cardId, {
                name: card.name, description: card.description, personality: card.personality,
                scenario: card.scenario, tags: JSON.stringify(card.tags || []),
              });
            }
            await refreshAll();
            closeAllModals();
            toast("✨ Monde, persona et personnages créés ✓");
            newGameWizard({ world_id: worldId, persona_id: personaId, cast });
          } catch (err) {
            toast(err.message, "err");
            btn.disabled = false; btn.textContent = "✨ Créer & lancer la partie";
          }
        } }, "✨ Créer & lancer la partie"),
      ),
    ));
  }

  stepDescribe();
}

export function newGameWizard(pre) {
  const { close, modal } = openModal({
    title: "Nouvelle partie ✨",
    sub: "Choisis un monde, un scénario, ton persona et les personnages présents.",
    wide: true,
  });
  const worldSel = field("Monde", pre?.world_id || "", { type: "select", options: [["", "— Choisir —"], ...store.worlds.map((w) => [w.id, w.name])] });
  const scenSel = field("Scénario", "", { type: "select", options: [["", "— Par défaut (le personnage t'accueille) —"]] });
  // AI scenario generation: pick a genre, the model writes the opening
  const genreSel = field("Genre du scénario", "mystere", { type: "select", options: GENRE_OPTS });
  const scenGenBtn = el("button", { class: "btn btn-primary btn-sm", onclick: generateScenarioInWizard }, ICONS.sparkles, "Générer");
  const scenGenRow = el("div", { class: "scen-gen-row" }, genreSel.wrap, scenGenBtn);
  const scenPreview = el("div", { class: "gen-preview", hidden: true });
  const persoSel = field("Ton persona", pre?.persona_id || "", { type: "select", options: [["", "— Inventé sur place —"], ...store.personas.map((p) => [p.id, p.name])] });
  const groupToggle = checkbox("group", false, "Mode groupe : plusieurs cartes dans la même scène");
  const castWrap = el("div", {}, el("label", {}, "Personnages présents (cartes)"));
  const castGrid = el("div", { class: "grid", style: { gridTemplateColumns: "repeat(auto-fill, minmax(140px,1fr))", marginTop: "8px" } });

  async function generateScenarioInWizard() {
    const wid = worldSel.input.value;
    if (!wid) return toast("Choisis d'abord un monde.", "err");
    scenGenBtn.disabled = true;
    scenGenBtn.textContent = "✨ Génération…";
    try {
      const world = store.worlds.find((w) => String(w.id) === String(wid));
      const s = await api(`/api/worlds/${wid}/scenarios/generate`, {
        body: { genre: genreSel.input.value, theme: world?.description || undefined },
      });
      scenSel.input.append(el("option", { value: "draft", selected: "" }, s.name));
      scenSel.input.dataset.draftName = s.name;
      scenSel.input.dataset.draftIntro = s.intro;
      // the /generate endpoint returns a draft (no id) — select the "draft"
      // option so the opening is persisted via settings.draft_intro
      scenSel.input.value = "draft";
      scenPreview.hidden = false;
      scenPreview.replaceChildren(
        el("div", { class: "gen-preview-head" }, "📜 " + esc(s.name)),
        el("p", {}, esc(s.intro)),
      );
      toast("Scénario généré ✓");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      scenGenBtn.disabled = false;
      scenGenBtn.textContent = ICONS.sparkles + " Générer";
    }
  }

  const renderCast = () => {
    castGrid.replaceChildren(...store.cards.map((card) => {
      const box = el("label", { class: "card", style: { cursor: "pointer", padding: "12px", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", textAlign: "center" } },
        card.avatar ? el("img", { src: card.avatar, class: "avatar avatar-md" }) : el("div", { class: "avatar avatar-md", style: { display: "grid", placeItems: "center" } }, "🎭"),
        el("span", { style: { fontWeight: 700, fontSize: "13px" } }, esc(card.name)),
      );
      box.dataset.cardId = card.id;
      box.addEventListener("click", () => box.classList.toggle("selected"));
      return box;
    }));
  };

  // load the world's scenarios into the select (returns them so a preselected
  // scenario can be picked once the options exist)
  let scenarioLoadVersion = 0;
  const loadScenarios = async (wid) => {
    const version = ++scenarioLoadVersion;
    scenSel.input.replaceChildren(el("option", { value: "" }, "— Par défaut —"));
    scenPreview.hidden = true;
    if (!wid) return null;
    try {
      const sc = (await api(`/api/worlds/${wid}/scenarios`)).scenarios || [];
      if (version !== scenarioLoadVersion || String(worldSel.input.value) !== String(wid)) return null;
      scenSel.input.append(...sc.map((s) => el("option", { value: s.id }, s.name)));
      return sc;
    } catch (e) {
      if (version !== scenarioLoadVersion || String(worldSel.input.value) !== String(wid)) return null;
      scenSel.input.append(el("option", { value: "", disabled: "" }, "Scénarios indisponibles — " + e.message));
      toast("Impossible de charger les scénarios : " + e.message, "err");
      return null;
    }
  };
  worldSel.input.addEventListener("change", () => loadScenarios(worldSel.input.value));
  if (pre?.world_id) {
    // coming from « Jouer ▶ » on a scenario card (?world=&scenario=) : preselect
    // the world, wait for its scenarios, then preselect the requested one
    worldSel.input.value = pre.world_id;
    loadScenarios(pre.world_id).then((sc) => {
      if (!pre?.scenario_id || !sc?.some((s) => String(s.id) === String(pre.scenario_id))) return;
      scenSel.input.value = pre.scenario_id;
    });
  }

  modal.append(worldSel.wrap, scenSel.wrap, scenGenRow, scenPreview, persoSel.wrap, groupToggle.wrap, castWrap, castGrid,
    el("div", { class: "modal-footer" },
      el("button", { class: "btn btn-ghost", onclick: () => close() }, "Annuler"),
      el("button", { class: "btn btn-primary", onclick: async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = "Création…";
        const cast = [...castGrid.querySelectorAll(".selected")].map((el) => Number(el.dataset.cardId));
        try {
          const conv = await api("/api/conversations", {
            body: {
              world_id: worldSel.input.value ? Number(worldSel.input.value) : null,
              scenario_id: scenSel.input.value && scenSel.input.value !== "draft" ? Number(scenSel.input.value) : null,
              ...(scenSel.input.value === "draft" ? { title: scenSel.input.dataset.draftName, settings: { draft_intro: scenSel.input.dataset.draftIntro } } : {}),
              persona_id: persoSel.input.value ? Number(persoSel.input.value) : null,
              cast,
              group_mode: groupToggle.input.checked,
            },
          });
          close();
          await refreshAll();
          navigate(`#/chat/${conv.id}`);
        } catch (err) {
          toast(err.message, "err");
          btn.disabled = false;
          btn.textContent = "Créer la partie";
        }
      } }, "Lancer la partie ▶"),
    ),
  );
  renderCast();
  // coming from the guided builder → preselect the validated persona & cast
  if (pre?.persona_id) persoSel.input.value = String(pre.persona_id);
  if (Array.isArray(pre?.cast)) {
    for (const id of pre.cast) {
      castGrid.querySelector(`[data-card-id="${id}"]`)?.classList.add("selected");
    }
  }
}

export async function startGameFromWorld(worldId) {
  await refreshAll();
  newGameWizard({ world_id: worldId });
}

// ─── LAN auth gate ────────────────────────────────────────────────────────────
function showAuthModal() {
  const tok = field("Token d'accès", "", { type: "password", autofocus: true, placeholder: "Token configuré dans les Réglages" });
  const { close } = openModal({
    title: "🔐 Accès sécurisé",
    body: el("div", {},
      el("p", { style: { lineHeight: "1.6", color: "var(--text-dim)", marginBottom: "12px" } },
        "Ce serveur est protégé par un token. Demande-le à la personne qui l'a configuré (Réglages → Apparence & sécurité)."),
      tok.wrap,
    ),
    footer: [
      el("button", { class: "btn btn-ghost", onclick: () => close() }, "Annuler"),
      el("button", { class: "btn btn-primary", onclick: async (e) => {
        const btn = e.target;
        btn.disabled = true;
        try {
          await api("/api/auth", { method: "POST", body: { token: tok.input.value.trim() } });
          setToken(tok.input.value.trim());
          close();
          await refreshAll();
          route();
        } catch (err) { toast(err.message, "err"); btn.disabled = false; }
      } }, "Déverrouiller"),
    ],
  });
}

window.addEventListener("innsekai-unauthorized", () => {
  if (!document.querySelector(".modal")) showAuthModal();
});

// ─── boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
  try {
    applyCustom();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    if (localStorage.getItem("innsekai-sidebar") === "1") {
      document.getElementById("sidebar")?.classList.add("collapsed");
    }
    // LAN token gate: ask for the token before loading anything
    const auth = await api("/api/auth");
    if (auth.required && !auth.ok) {
      showAuthModal();
      return;
    }
    await refreshAll();
  } catch (e) {
    main().replaceChildren(el("div", { class: "empty" },
      el("div", { class: "big" }, "🔌"),
      el("h3", {}, "Serveur injoignable"),
      el("p", {}, esc(String(e?.message || e))),
    ));
  }
  route();
})();

export { route };