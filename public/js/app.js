import { api, apiForm, uploadFiles, setToken } from "./api.js?v=30";
import { el, esc, toast, openModal, confirmModal, field, ICONS, fmtTime } from "./ui.js?v=30";
import { renderChat } from "./chat.js?v=30";

// ─── global state ─────────────────────────────────────────────────────────────
export const store = {
  settings: {},
  worlds: [],
  cards: [],
  personas: [],
  conversations: [],
  voices: [],
  loaded: false,
};

export async function refreshAll() {
  const [s, w, c, p, conv, v] = await Promise.all([
    api("/api/settings"),
    api("/api/worlds"),
    api("/api/cards"),
    api("/api/personas"),
    api("/api/conversations"),
    api("/api/voices"),
  ]);
  Object.assign(store, {
    settings: s, worlds: w.worlds || [], cards: c.cards || [],
    personas: p.personas || [], conversations: conv.conversations || [], voices: v.voices || [],
    loaded: true,
  });
  return store;
}

// personalization: accent color + background image (local to this device)
export function applyCustom() {
  const accent = localStorage.getItem("ai-rp-accent");
  if (accent) document.documentElement.style.setProperty("--accent", accent);
  else document.documentElement.style.removeProperty("--accent");
  const bg = localStorage.getItem("ai-rp-bg");
  if (bg) {
    document.documentElement.style.setProperty("--app-bg", `url("${bg}")`);
    document.body.classList.add("custom-bg");
  } else {
    document.documentElement.style.removeProperty("--app-bg");
    document.body.classList.remove("custom-bg");
  }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "anime" ? "anime" : "glass";
  localStorage.setItem("ai-rp-theme", JSON.stringify(theme === "anime" ? "anime" : "glass"));
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
      el("span", { class: `dot ${ttsDot()}` }),
      el("span", {}, "TTS " + (store.settings.tts_enabled === false ? "off" : "on")),
    ),
    el("div", { class: "status-row" },
      el("span", { class: `dot ${providerDot()}` }),
      el("span", {}, providerLabel()),
    ),
  );
  const themeBtn = el("button", { class: "theme-toggle", onclick: () => {
    const next = document.documentElement.dataset.theme === "anime" ? "glass" : "anime";
    applyTheme(next);
    renderSidebar(active);
  } },
    document.documentElement.dataset.theme === "anime" ? "🎨 " : "🌙 ",
    document.documentElement.dataset.theme === "anime" ? "Thème néon" : "Thème anime",
  );
  sb.replaceChildren(
    el("div", { class: "brand" },
      el("div", { class: "logo" }, "🪄"),
      el("div", {},
        el("h1", {}, "AI-RP"),
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
  try { localStorage.setItem("ai-rp-sidebar", collapsed ? "1" : "0"); } catch { /* ignore */ }
  renderSidebar(currentSection);
}

function ttsDot() { return store.settings.tts_enabled === false ? "" : "ok"; }
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

function shortcutsHelp() {
  const row = (k, desc) => el("div", { class: "k-row" }, el("kbd", {}, k), el("span", {}, desc));
  openModal({
    title: "⌨️ Raccourcis clavier",
    body: el("div", { class: "shortcuts" },
      row("n", "Nouvelle partie"),
      row("/", "Écrire un message (dans une partie)"),
      row("r", "Régénérer la dernière réponse (variante)"),
      row("g", "Basculer solo / groupe"),
      row("Esc", "Fermer la fenêtre / annuler l'édition"),
      row("?", "Afficher cette aide"),
    ),
  });
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key === "Escape") return;
  if (isTypingTarget(e) || document.querySelector(".modal")) return;
  const k = e.key.toLowerCase();
  const inChat = location.hash.startsWith("#/chat/");
  if (k === "?") { e.preventDefault(); shortcutsHelp(); }
  else if (k === "n") { e.preventDefault(); newGameWizard(); }
  else if (inChat && (k === "r" || k === "g" || k === "/")) {
    e.preventDefault();
    import("./chat.js?v=30").then((m) => m.chatShortcut(k)).catch(() => {});
  }
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

function renderDashboard() {
  const all = store.conversations;
  const archived = all.filter((c) => c.archived);
  const active = all.filter((c) => !c.archived);
  const pinned = active.filter((c) => c.pinned);
  const rest = active.filter((c) => !c.pinned);
  const worldCards = store.worlds.slice(0, 6);
  const banner = store.worlds[0]?.cover;

  if (trashMode) {
    main().replaceChildren(...[
      el("div", { class: "hero" },
        el("h2", {}, "🗑 Corbeille"),
        el("p", {}, "Les parties archivées restent ici (texte + audio + images) jusqu'à restauration ou suppression définitive."),
        el("div", { class: "cta-row" },
          el("button", { class: "btn btn-ghost", onclick: () => { trashMode = false; renderDashboard(); } }, "← Retour à l'accueil"),
        ),
      ),
      archived.length ? el("div", { class: "grid" }, archived.map(trashCard)) : el("div", { class: "empty" },
        el("div", { class: "big" }, "🗑"),
        el("h3", {}, "Corbeille vide"),
        el("p", {}, "Rien d'archivé pour l'instant."),
      ),
    ].filter(Boolean));
    return;
  }

  main().replaceChildren(...[
    el("div", { class: "hero" + (banner ? " hero-banner" : ""), style: banner ? { backgroundImage: `url(${banner})` } : null },
      el("div", { class: "hero-inner" },
        el("h2", {}, "Bienvenue, aventurier. ✨"),
        el("p", {}, "Crée des mondes, importe des personnages (cartes SillyTavern), définis tes scénarios isekai et laisse l'IA raconter l'histoire — avec des voix différentes pour chaque personnage."),
        el("div", { class: "cta-row" },
          el("button", { class: "btn btn-primary", onclick: newGameWizard }, ICONS.plus, "Nouvelle partie"),
          el("a", { href: "#/worlds", class: "btn btn-ghost" }, ICONS.worlds, "Explorer les mondes"),
          el("a", { href: "#/cards", class: "btn btn-ghost" }, ICONS.cards, "Importer des cartes"),
        ),
      ),
    ),
    archived.length ? el("div", { class: "section-title" }, "Corbeille",
      el("button", { class: "chip-btn slim", style: { marginLeft: "10px" }, onclick: () => { trashMode = true; renderDashboard(); } }, "🗑 " + archived.length),
    ) : null,
    pinned.length ? el("div", { class: "section-title" }, "⭐ Parties épinglées") : null,
    pinned.length ? el("div", { class: "grid" }, pinned.map(convCard)) : null,
    rest.length ? el("div", { class: "section-title" }, "Continuer une partie") : null,
    rest.length ? el("div", { class: "grid" }, rest.map(convCard)) : null,
    worldCards.length ? el("div", { class: "section-title" }, "Mondes récents") : null,
    worldCards.length ? el("div", { class: "grid" }, worldCards.map(worldCard)) : null,
    !store.worlds.length && !store.cards.length ? onboardingPanel() : null,
  ].filter(Boolean));
}

// ─── first-run onboarding (no world, no card yet) ────────────────────────────
function onboardingPanel() {
  const modelLine = el("div", { class: "onb-line" }, "⏳ vérification de la connexion IA…");
  const imgLine = el("div", { class: "onb-line" }, "Modèle d'images : au premier usage (chargement long).");
  const check = () => {
    api("/api/health")
      .then((h) => {
        const ok = h?.tts?.fr || h?.tts?.en;
        modelLine.replaceChildren(
          el("span", { class: "dot", style: { background: ok ? "var(--ok, #2ecc71)" : "var(--warn, #f1c40f)" } }),
          el("span", {}, ok
            ? "IA locale détectée — le TTS est prêt. Tu peux commencer !"
            : "TTS en cours de chargement (10-20 s la 1re fois) — ça se passe en arrière-plan."),
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
      imgLine.textContent = `Stockage actuel : ${((st.audioMB || 0) + (st.imagesMB || 0)).toFixed(1)} Mo d'audio/images générés, ${st.backups?.length ?? 0} backup(s) auto.`;
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
      step(3, "Le casting", "Importe des cartes SillyTavern (.png) ou crée tes personnages — chacun avec sa voix TTS."),
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
          if (await confirmModal({ title: "Supprimer définitivement", message: `Tout sera perdu (messages, audio, images) : « ${c.title} » ?`, confirmLabel: "Supprimer" })) {
            await api(`/api/conversations/${c.id}/permanent`, { method: "DELETE" });
            await refreshAll();
            renderDashboard();
          }
        } }, ICONS.trash, "Définitif"),
      ),
    ),
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
  const nstyle = field("Style de narration", f(existing?.narration_style), { placeholder: "Ex: immersive et cinématique" });
  const lang = field("Langue du monde", f(existing?.language), {
    type: "select", options: [["", "Par défaut (réglages)"], ["fr", "Français"], ["en", "English"]],
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
  const body = el("div", {}, name.wrap, desc.wrap, lore.wrap, el("div", { class: "row" }, tone.wrap, nstyle.wrap), lang.wrap, coverBox);
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
          narration_style: nstyle.input.value.trim(),
          language: lang.input.value,
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
  const scenarios = await api(`/api/worlds/${world.id}/scenarios`).then((r) => r.scenarios).catch(() => []);
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
        const res = await fetch(`/api/worlds/${world.id}/export`);
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
    } catch { /* ignore */ }
  })();

  body.append(el("div", { class: "section-title" }, `Scénarios (${scenarios.length})`));
  const addScen = el("button", { class: "btn btn-ghost btn-sm", onclick: () => scenarioModal(world) }, ICONS.plus, "Ajouter un scénario");
  if (!scenarios.length) {
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

  main().replaceChildren(head, body);
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
          if (await confirmModal({ title: "Supprimer le scénario", message: `Supprimer « ${s.name} » ?` })) {
            await api(`/api/scenarios/${s.id}`, { method: "DELETE" });
            await refreshAll();
            renderWorldDetail(world.id);
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
      el("button", { class: "btn btn-ghost", onclick: () => close() }, "Annuler"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        const payload = {
          name: name.input.value.trim() || "Scénario",
          intro: intro.input.value.trim(),
          notes: notes.input.value.trim(),
        };
        try {
          if (existing) await api(`/api/scenarios/${existing.id}`, { method: "PATCH", body: payload });
          else await api(`/api/worlds/${world.id}/scenarios`, { body: payload });
          close();
          await refreshAll();
          renderWorldDetail(world.id);
        } catch (e) { toast(e.message, "err"); }
      } }, "Enregistrer"),
    ],
  });
}

// ─── cards ────────────────────────────────────────────────────────────────────
async function renderCards() {
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
        el("div", { class: "sub" }, "Tes personnages importés (cartes SillyTavern V1/V2) ou créés à la main, avec leur propre voix et langue."),
      ),
      newBtn,
      scanBtn,
    ),
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
    container.append(el("div", { class: "grid" }, store.cards.map(cardTile)));
  }
  main().replaceChildren(container);
}

async function doImport(files) {
  if (!files || !files.length) return;
  try {
    const list = await uploadFiles(files);
    const res = await api("/api/import", { body: { files: list } });
    toast(`${res.imported.length} carte${res.imported.length > 1 ? "s" : ""} importée${res.imported.length > 1 ? "s" : ""} ✓`);
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

function cardTile(card) {
  return el("div", { class: "card" },
    el("div", { style: { display: "flex", alignItems: "center", gap: "14px", padding: "18px 18px 8px" } },
      card.avatar ? el("img", { src: card.avatar, class: "avatar avatar-lg" }) : el("div", { class: "avatar avatar-lg", style: { display: "grid", placeItems: "center", fontSize: "22px" } }, "🎭"),
      el("div", { style: { minWidth: 0 } },
        el("h3", { style: { fontSize: "16px" } }, esc(card.name)),
        el("div", { style: { display: "flex", gap: "6px", marginTop: "4px", flexWrap: "wrap" } },
          card.voice ? el("span", { class: "chip" }, ICONS.voice, esc(card.voice)) : null,
          card.language ? el("span", { class: "chip" }, card.language.toUpperCase()) : null,
        ),
      ),
    ),
    el("div", { class: "card-body" },
      el("div", { class: "desc" }, esc(card.description || card.personality || "Personnage sans description")),
      el("div", { class: "card-actions" },
        el("button", { class: "mini-btn", onclick: () => cardModal(card) }, ICONS.edit, "Éditer"),
        el("button", { class: "mini-btn", style: { color: "var(--danger)" }, onclick: async () => {
          if (await confirmModal({ title: "Supprimer la carte", message: `Supprimer « ${card.name} » ?` })) {
            await api(`/api/cards/${card.id}`, { method: "DELETE" });
            await refreshAll();
            renderCards();
          }
        } }, ICONS.trash),
      ),
    ),
  );
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
  const lang = field("Langue de la voix", f(existing?.language), { type: "select", options: [["", "Par défaut"], ["fr", "Français"], ["en", "English"]] });
  // voices filtered by the chosen language (empty = toutes)
  const voiceOptsFor = () => {
    const l = lang.input.value;
    const seen = new Set();
    const out = [["", "Par défaut"]];
    for (const v of store.voices || []) {
      if (l && v.lang !== l) continue;
      if (seen.has(v.name)) continue;
      seen.add(v.name);
      out.push([v.name, v.label]);
    }
    return out;
  };
  const voice = field("Voix TTS", f(existing?.voice), { type: "select", options: voiceOptsFor() });
  lang.input.addEventListener("change", () => {
    const cur = voice.input.value;
    voice.input.replaceChildren(...voiceOptsFor().map(([v, l2]) => el("option", { value: v, ...(v === cur ? { selected: "" } : {}) }, l2)));
  });
  // ── live preview (SillyTavern-style character sheet) ──
  const preview = el("div", { class: "card-preview" }, el("div", { class: "card-preview-empty" }, "Aperçu en direct…"));
  const updatePreview = () => {
    const n = name.input.value.trim();
    const d = desc.input.value.trim();
    const p = perso.input.value.trim();
    const sc = scenario.input.value.trim();
    const fm = firstMes.input.value.trim();
    const ex = example.input.value.trim();
    const v = voice.input.value;
    const voiceLabel = (store.voices || []).find((x) => x.name === v)?.label ?? (v || "par défaut");
    preview.replaceChildren(
      el("div", { class: "preview-avatar", style: { background: `linear-gradient(135deg, hsl(${(n.length * 59) % 360} 70% 55%), hsl(${(n.length * 59 + 60) % 360} 80% 40%))` } },
        n ? n[0].toUpperCase() : "?"),
      el("h3", {}, esc(n || "Nouvelle carte")),
      el("div", { class: "preview-tags" },
        v ? el("span", { class: "preview-tag" }, "🔊 " + esc(voiceLabel)) : null,
        lang.input.value ? el("span", { class: "preview-tag" }, "🌍 " + (lang.input.value === "en" ? "EN" : "FR")) : null,
      ),
      el("div", { class: "preview-sec" },
        el("strong", {}, "Description"),
        el("p", {}, esc(d || "—")),
      ),
      p ? el("div", { class: "preview-sec" }, el("strong", {}, "Personnalité"), el("p", {}, esc(p))) : null,
      sc ? el("div", { class: "preview-sec" }, el("strong", {}, "Situation"), el("p", {}, esc(sc))) : null,
      fm ? el("div", { class: "preview-sec preview-greet" },
        el("strong", {}, "Premier message"),
        el("blockquote", {}, esc(fm)),
      ) : null,
      ex ? el("div", { class: "preview-sec preview-greet" },
        el("strong", {}, "Exemple de dialogue"),
        el("blockquote", {}, esc(ex)),
      ) : null,
    );
  };
  for (const inp of [name.input, desc.input, perso.input, scenario.input, firstMes.input, example.input, sys.input, voice.input, lang.input]) {
    inp.addEventListener("input", updatePreview);
    inp.addEventListener("change", updatePreview);
  }
  updatePreview();
  const formCol = el("div", { class: "card-form-col" }, name.wrap, el("div", { class: "row" }, lang.wrap, voice.wrap), desc.wrap, perso.wrap, scenario.wrap, firstMes.wrap, example.wrap, sys.wrap);
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
          voice: voice.input.value, language: lang.input.value,
        };
        try {
          if (existing) await api(`/api/cards/${existing.id}`, { method: "PATCH", body: payload });
          else await api("/api/cards", { body: payload });
          close();
          await refreshAll();
          renderCards();
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
              if (await confirmModal({ title: "Supprimer le persona", message: `Supprimer « ${p.name} » ?` })) {
                await api(`/api/personas/${p.id}`, { method: "DELETE" });
                await refreshAll();
                renderPersonas();
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
          if (existing) await api(`/api/personas/${existing.id}`, { method: "PATCH", body: payload });
          else await api("/api/personas", { body: payload });
          close();
          await refreshAll();
          renderPersonas();
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
        el("div", { class: "sub" }, "Fournisseur d'IA, voix, langue et génération d'images."),
      ),
    ),
  );

  // ── IA ──
  container.append(el("div", { class: "section-title" }, "IA conversationnelle"));
  const providerSel = field("Fournisseur", s.provider || "lmstudio", {
    type: "select", options: [["lmstudio", "LM Studio (local)"], ["openrouter", "OpenRouter (cloud)"]],
  });
  const lmUrl = field("URL LM Studio (API)", s.lmstudio_url || "http://localhost:1234/v1", { placeholder: "http://localhost:1234/v1" });
  const orKey = field("Clé API OpenRouter", s.openrouter_key || "", { type: "password", placeholder: "sk-or-v1-…" });
  const lmModel = field("Modèle LM Studio", s.lmstudio_model || "", { placeholder: "Chargement…" });
  const orModel = field("Modèle OpenRouter", s.openrouter_model || "", { placeholder: "Ex: anthropic/claude-3.7-sonnet" });
  const narrStyle = field("Style du narrateur", s.narrator_style || "epique", {
    type: "select",
    options: [
      ["epique", "Épique (défaut)"],
      ["neutre", "Neutre"],
      ["sarcastique", "Sarcastique"],
      ["cynique", "Cynique"],
      ["en_colere", "En colère"],
      ["nagatoro", "Nagatoro (taquin)"],
    ],
  });

  const refreshModels = async () => {
    try {
      const models = await api(`/api/health`).catch(() => null); // just to keep import
      void models;
      const prov = providerSel.input.value;
      const res = await fetch(`/api/models?provider=${prov}`, { method: "GET" }).catch(() => null);
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
    el("p", { style: { fontSize: "12.5px", color: "var(--text-dim)", marginTop: "12px" } },
      "LM Studio : lance le serveur local (onglet Developer → Start Server, port 1234). OpenRouter : colle ta clé API — les deux peuvent être utilisés et le choix se fait au lancement de partie. Le style du narrateur s'applique aux nouvelles réponses.",
    ),
  ));

  // ── TTS ──
  container.append(el("div", { class: "section-title" }, "Voix (TTS)"));
  const ttsOn = checkbox("tts_enabled", s.tts_enabled !== false, "Activer la synthèse vocale");
  const ttsLang = field("Langue des voix", s.tts_language || "fr", { type: "select", options: [["fr", "Français"], ["en", "English"]] });
  const narrator = field("Voix du narrateur", s.tts_voice_narrateur || "jean", { type: "select", options: voicesOptions(ttsLang.input.value) });
  const defChar = field("Voix par défaut des personnages", s.tts_voice_default || "cosette", { type: "select", options: voicesOptions(ttsLang.input.value) });
  const lsd = field("Qualité (pas de décodage)", s.tts_lsd_steps || 4, { type: "number", min: 1, max: 10, step: 1 });
  const maxSeg = field("Segments vocaux par réponse", s.tts_max_segments ?? 5, { type: "number", min: 1, max: 20, step: 1 });
  const autoplay = checkbox("tts_autoplay", s.tts_autoplay !== false, "Lecture auto des réponses");
  // ▶ buttons: play a sample of the currently selected voice
  const narratorPlay = samplePlayBtn(() => narrator.input.value, () => ttsLang.input.value);
  const defCharPlay = samplePlayBtn(() => defChar.input.value, () => ttsLang.input.value);
  narrator.wrap.append(narratorPlay);
  defChar.wrap.append(defCharPlay);
  // samples strip: every voice, playable
  const stripBox = el("div", { class: "voice-samples" });
  const renderStrip = () => {
    stripBox.replaceChildren(el("div", { class: "chips-label" }, "🎧 Aperçu des voix — clique pour écouter"));
    for (const lang of ["fr", "en"]) {
      const voices = store.voices.filter((v) => v.lang === lang);
      if (!voices.length) continue;
      const uniq = [...new Map(voices.map((v) => [v.name, v])).values()];
      stripBox.append(el("div", { class: "voice-group" },
        el("span", { class: "voice-lang" }, lang === "fr" ? "Français" : "English"),
        el("div", { class: "voice-chips" },
          uniq.map((v) => {
            const chip = el("button", { class: "voice-chip", onclick: () => playSample(v.name, v.lang, chip) }, "▶ " + esc(v.label));
            return chip;
          }),
        ),
      ));
    }
  };
  renderStrip();
  ttsLang.input.addEventListener("change", () => {
    // voice selects follow the chosen language (keep selection when possible)
    const lang = ttsLang.input.value;
    const opts = voicesOptions(lang);
    for (const sel of [narrator.input, defChar.input]) {
      const cur = sel.value;
      sel.replaceChildren(...opts.map(([v, l]) => el("option", { value: v, ...(v === cur ? { selected: "" } : {}) }, l)));
    }
    renderStrip();
  });
  container.append(el("div", { class: "card", style: { padding: "18px 22px" } },
    el("div", { class: "row" }, ttsOn.wrap, autoplay.wrap),
    el("div", { class: "row" }, ttsLang.wrap, lsd.wrap, maxSeg.wrap),
    el("div", { class: "row" }, narrator.wrap, defChar.wrap),
    stripBox,
    el("div", { style: { marginTop: "14px" } },
      el("button", { class: "btn btn-ghost btn-sm", onclick: async () => {
        try {
          toast("Warm-up du TTS… (la 1re génération est lente)", "ok", 10000);
          await api("/api/tts/warmup", { body: {} });
          toast("TTS prêt ✓");
        } catch (e) { toast(e.message, "err"); }
      } }, ICONS.voice, "Précharger le TTS"),
    ),
  ));

  // ── Images ──
  container.append(el("div", { class: "section-title" }, "Images (Koji)"));
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
  container.append(el("div", { class: "section-title" }, "Apparence & sécurité"));
  const accentCur = localStorage.getItem("ai-rp-accent") || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff7ad9";
  const accentWrap = el("label", { class: "fl-field" },
    el("input", { type: "color", value: accentCur }),
    el("span", { class: "fl-label" }, "Couleur d'accent"),
  );
  accentWrap.querySelector("input").addEventListener("input", (e) => {
    localStorage.setItem("ai-rp-accent", e.target.value);
    applyCustom();
  });
  const bgWrap = el("label", { class: "fl-field" },
    el("input", { value: localStorage.getItem("ai-rp-bg") || "", placeholder: " " }),
    el("span", { class: "fl-label" }, "Image de fond (URL)"),
  );
  bgWrap.querySelector("input").addEventListener("input", (e) => {
    localStorage.setItem("ai-rp-bg", e.target.value.trim());
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
        localStorage.removeItem("ai-rp-accent");
        localStorage.removeItem("ai-rp-bg");
        applyCustom();
        toast("Apparence réinitialisée ✓");
        renderSettings();
      } }, "↺ Réinitialiser l'apparence"),
    ),
    el("p", { style: { fontSize: "12.5px", color: "var(--text-dim)", marginTop: "12px" } },
      "Couleur d'accent et fond : stockés sur cet appareil. Token : quand il est défini, toute l'API exige ce mot de passe — utile quand l'app écoute sur le Wi-Fi.",
    ),
  ));

  // ── Backup / restore ──
  container.append(el("div", { class: "section-title" }, "Sauvegarde"));
  const fileInput = el("input", { type: "file", accept: ".json,application/json", hidden: true });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
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
          a.download = `ai-rp-backup-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
          toast("Sauvegarde téléchargée ✓");
        } catch (e) { toast(e.message, "err"); }
      } }, "⬇️ Exporter tout (mondes, cartes, parties)"),
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => fileInput.click() }, "⬆️ Restaurer depuis un fichier"),
      fileInput,
    ),
    el("p", { style: { fontSize: "12.5px", color: "var(--text-dim)", marginTop: "12px" } },
      "La sauvegarde contient tes mondes, scénarios, cartes, personas et conversations (texte + réglages) ; les fichiers audio et images générés ne sont pas inclus — tu peux copier le dossier data/ pour tout conserver.",
    ),
  ));

  // ── Stockage & backups auto ──
  container.append(el("div", { class: "section-title" }, "Stockage & sauvegardes auto"));
  const storageCard = el("div", { class: "card", style: { padding: "18px 22px" } }, el("div", { class: "storage-line" }, "⏳ lecture du disque…"));
  const renderStorage = async () => {
    try {
      const st = await api("/api/storage");
      const mb = (v) => `${Math.max(0, v).toFixed(1)} Mo`;
      storageCard.replaceChildren(
        el("div", { class: "storage-grid" },
          el("div", { class: "storage-tile" }, el("strong", {}, mb(st.audioMB)), el("span", {}, "🎙 Audio généré")),
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

  container.append(el("div", { style: { marginTop: "24px", display: "flex", justifyContent: "flex-end" } },
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
            tts_enabled: ttsOn.input.checked,
            tts_language: ttsLang.input.value,
            tts_voice_narrateur: narrator.input.value,
            tts_voice_default: defChar.input.value,
            tts_lsd_steps: Number(lsd.input.value),
            tts_max_segments: Number(maxSeg.input.value),
            tts_autoplay: autoplay.input.checked,
            image_steps: Number(imgSteps.input.value),
            image_cfg: Number(imgCfg.input.value),
            image_ref_strength: Number(imgRef.input.value),
            image_preload: imgPreload.input.checked,
            llm_timeout: Number(llmTimeout.input.value),
            auth_token: authField.input.value.trim(),
            notifications: notifCb.input.checked,
            sound_effects: soundCb.input.checked,
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

function voicesOptions(lang) {
  const voices = store.voices.filter((v) => v.lang === lang || !lang);
  const unique = [...new Map(voices.map((v) => [v.name, v])).values()];
  return unique.map((v) => [v.name, v.label]);
}

// ─── voice sample preview (settings) ─────────────────────────────────────────
let sampleHandler = null; // { audio, btn }
function stopSample() {
  if (sampleHandler) {
    try { sampleHandler.audio.pause(); } catch { /* ignore */ }
    const idle = sampleHandler.btn.dataset.idle ?? "▶";
    sampleHandler.btn.textContent = idle;
    sampleHandler.btn.classList.remove("playing", "busy");
    sampleHandler = null;
  }
}
async function playSample(name, lang, btn) {
  if (sampleHandler && sampleHandler.btn === btn) { stopSample(); return; }
  stopSample();
  if (!name) return;
  btn.dataset.idle = btn.textContent;
  btn.textContent = "⏳";
  btn.classList.add("busy");
  try {
    // server synthesizes (and caches) the clip on first request
    const res = await api(`/api/voices/sample?name=${encodeURIComponent(name)}&lang=${lang || "fr"}`);
    const a = new Audio(res.path);
    a.onended = () => {
      if (sampleHandler?.audio === a) sampleHandler = null;
      btn.textContent = btn.dataset.idle ?? "▶";
      btn.classList.remove("playing", "busy");
    };
    await a.play();
    sampleHandler = { audio: a, btn };
    btn.textContent = "⏹";
    btn.classList.remove("busy");
    btn.classList.add("playing");
  } catch (e) {
    btn.textContent = btn.dataset.idle ?? "▶";
    btn.classList.remove("busy");
    toast(String(e?.message ?? e), "err");
  }
}
function samplePlayBtn(getVoice, getLang) {
  const b = el("button", { class: "mini-btn play-voice", style: { marginTop: "8px" }, onclick: () => playSample(getVoice(), getLang ? getLang() : "fr", b) }, "▶ Écouter");
  return b;
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
  const persoSel = field("Ton persona", "", { type: "select", options: [["", "— Inventé sur place —"], ...store.personas.map((p) => [p.id, p.name])] });
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
      scenSel.input.append(el("option", { value: s.id, selected: "" }, s.name));
      scenSel.input.value = String(s.id);
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

  worldSel.input.addEventListener("change", async () => {
    const wid = worldSel.input.value;
    scenSel.input.replaceChildren(el("option", { value: "" }, "— Par défaut —"));
    scenPreview.hidden = true;
    if (!wid) return;
    const sc = await api(`/api/worlds/${wid}/scenarios`).then((r) => r.scenarios).catch(() => []);
    scenSel.input.append(...sc.map((s) => el("option", { value: s.id }, s.name)));
  });
  if (pre?.scenario_id) {
    // world already known
  }
  if (pre?.world_id) {
    worldSel.input.value = pre.world_id;
    worldSel.input.dispatchEvent(new Event("change"));
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
              scenario_id: scenSel.input.value ? Number(scenSel.input.value) : null,
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

window.addEventListener("airp-unauthorized", () => {
  if (!document.querySelector(".modal")) showAuthModal();
});

// ─── boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
  try {
    applyCustom();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    if (localStorage.getItem("ai-rp-sidebar") === "1") {
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