/**
 * New-game & guided builder (extracted from app.js). « Décris ce que tu veux »
 * turns a free-form idea into a proposed world/persona/cast; newGameWizard is
 * the classic step-by-step party creation. Purely UI — data flows through the
 * API like everywhere else.
 *
 * Imported from app.js (store, refreshAll/refreshPersonas, navigate, avatar
 * helpers, checkbox): keep those exports stable — other modules import them
 * from app.js too.
 */
import { api } from "./api.js";
import { el, esc, toast, openModal, closeAllModals, field, ICONS } from "./ui.js";
import { autoCardAvatar, autoPersonaAvatar, checkbox, navigate, refreshAll, refreshPersonas, store } from "./app.js";



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
export function guidedWizard() {
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
  const spinner = (txt) => el("div", { class: "assist-status", role: "status" }, "⏳ " + esc(txt));
  // honest spinner: local models can take a minute per batch — show elapsed
  // time instead of "quelques secondes". Call node._stop() when done.
  const timed = (txt) => {
    const t0 = Date.now();
    const node = el("div", { class: "assist-status", role: "status" }, "⏳ " + esc(txt));
    const iv = setInterval(() => {
      if (!node.isConnected) { clearInterval(iv); return; } // user moved on — don't tick a dead node forever
      node.textContent = `⏳ ${txt} (${Math.round((Date.now() - t0) / 1000)}s)`;
    }, 1000);
    node._stop = () => clearInterval(iv);
    return node;
  };
  // "Varier" helper: prefill the batch feedback box with an anchor proposal
  // ("more like this one") — no backend change, just better steering.
  const varyText = (name, desc) =>
    `Dans l'esprit de « ${name} » (${String(desc || "").slice(0, 140)}) : une autre proposition du même genre, mais différente`;
  // Draft persistence: closing the modal no longer loses the wizard — every
  // step transition and every choice snapshots `st` to localStorage.
  const DRAFT_KEY = "innsekai-assist-draft";
  function saveAssistDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, at: Date.now(), st }));
    } catch { /* quota / private mode — the wizard just won't resume */ }
  }
  function loadAssistDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (!d || d.v !== 1 || !d.st || typeof d.st.desc !== "string") return null;
      return d;
    } catch { return null; }
  }
  function clearAssistDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  }
  // soft=true renders the previous batch from memory instead of calling the LLM.
  const go = (i, soft) => {
    saveAssistDraft();
    if (i === 1) stepWorlds("", soft);
    else if (i === 2) stepPersonas("", soft);
    else if (i === 3) stepCharacters(soft);
    else stepCreate();
  };
  const keyOf = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

  // ── étape 1 : la description libre ──
  // instant checklist (no LLM): guides a better idea before spending GPU
  // time — world cues, a "you", and named/role characters
  const WORLD_CUES = ["monde", "royaume", "empire", "ville", "village", "futur", "cyber", "magie", "école", "forêt", "planète", "univers", "île", "désert", "espace", "médiéval", "steampunk", "post-apo", "donjon"];
  const SELF_CUES = ["je suis", "je m'appelle", "moi,", "moi ", "mon ", "ma ", "mes ", "m'appelle"];
  const ROLE_CUES = ["tavernière", "tavernier", "garde", "marchand", "sorcièr", "mage", "reine", "roi ", "princesse", "prince ", "détective", "fantôme", "dragon", "elfe", "nain", "vampire", "robot", "androïde", "prêtre", "capitaine", "pirate", "assassin", "aubergiste", "forgeron", "oracle", "démon", "ange "];
  function analyzeIdea(text) {
    const low = text.toLowerCase();
    const words = low.trim() ? (low.trim().match(/\S+/g) || []).length : 0;
    const hasWorld = WORLD_CUES.some((w) => low.includes(w));
    const hasSelf = SELF_CUES.some((w) => low.includes(w));
    const names = [...new Set([...text.matchAll(/\b([A-ZÀ-Þ][a-zà-ÿ'’-]{2,24})\b/g)].map((m) => m[1]))]
      .filter((n) => !["Je", "Tu", "Il", "Elle", "Nous", "Vous", "Ils", "Elles", "Mon", "Ma", "Mes", "Le", "La", "Les", "Un", "Une", "Des", "Ex"].includes(n));
    const roles = ROLE_CUES.filter((r) => low.includes(r));
    return { words, hasWorld, hasSelf, names, roles };
  }
  function stepDescribe() {
    const viewVersion = ++st.viewVersion;
    stepIdx = 0; paintProgress();
    const ta = fieldRow("Ton idée", st.desc, "Ex. : Un monde médiéval fantastique avec de la magie. Moi, Max, 22 ans, je suis téléporté au milieu de nulle part, dans un village perdu. Il y a une tavernière mystérieuse et un garde arrogant…", 7).input;
    ta.style.minHeight = "150px";
    const ex1 = "Un monde médiéval fantastique avec de la magie. Moi, Max, 22 ans, je suis téléporté au milieu de nulle part, dans un village perdu. Il y a une tavernière mystérieuse et un garde arrogant.";
    const ex2 = "Un futur cyberpunk moite et pluvieux où la mémoire se vend à crédit. Je suis un détective endetté, et une fantôme de synthèse me hante. Décris mes partenaires de fortune.";
    const checklist = el("div", { class: "idea-checks", role: "status" });
    let checkTimer = null;
    const paintChecks = () => {
      const a = analyzeIdea(ta.value);
      const chip = (ok, label) => el("span", { class: "chip" + (ok ? " on" : "") }, (ok ? "✓ " : "○ ") + label);
      const hints = [];
      if (a.words > 0 && a.words < 20) hints.push("quelques phrases de plus aideront l'IA");
      else {
        if (!a.hasWorld) hints.push("décris le monde (époque, lieu, magie…)");
        if (!a.hasSelf) hints.push("dis qui tu es (« je suis… »)");
        if (!a.names.length && !a.roles.length) hints.push("nomme 1-2 personnages à rencontrer (facultatif)");
      }
      checklist.replaceChildren(
        chip(a.hasWorld, "monde"),
        chip(a.hasSelf, "toi"),
        chip(a.names.length + a.roles.length > 0, `personnages${a.names.length + a.roles.length ? ` (${[...a.names, ...a.roles].slice(0, 3).join(", ")})` : ""}`),
        el("span", { class: "idea-count" }, `${a.words} mot${a.words > 1 ? "s" : ""}`),
        hints.length ? el("span", { class: "idea-hint" }, "💡 " + hints.join(" · ")) : null,
      );
    };
    ta.addEventListener("input", () => { clearTimeout(checkTimer); checkTimer = setTimeout(() => { if (ta.isConnected) paintChecks(); }, 300); });
    paintChecks();
    run(() => el("div", {},
      el("h3", {}, "Raconte ton idée"),
      el("p", { class: "modal-note" }, "Décris le monde, qui tu es, ce qui t'arrive — et les personnages que tu veux voir (facultatif). Ton modèle local (LM Studio) a besoin de quelques secondes par lot : laisse-le finir."),
      ta,
      checklist,
      el("div", { class: "assist-refine", style: { justifyContent: "flex-start" } },
        el("button", { class: "chip-btn", onclick: () => { ta.value = ex1; } }, "Ex. isekai médiéval"),
        el("button", { class: "chip-btn", onclick: () => { ta.value = ex2; } }, "Ex. cyberpunk"),
      ),
      el("div", { class: "assist-refine", style: { justifyContent: "flex-end" } },
        el("button", { class: "btn btn-primary", onclick: () => {
          st.desc = ta.value.trim();
          if (!st.desc) return toast("Décris d'abord ton idée.", "err");
          saveAssistDraft();
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
    const status = timed("L'IA propose des mondes…");
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
      status._stop?.();
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
              saveAssistDraft();
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
          const varyBtn = el("button", { class: "btn btn-ghost btn-sm", title: "Pré-remplit l'amélioration pour d'autres mondes dans cet esprit", onclick: () => {
            fb.value = varyText(fName.input.value.trim() || p.name, fDesc.input.value.trim() || p.description);
            fb.focus();
            fb.scrollIntoView({ block: "nearest", behavior: "smooth" });
          } }, "🎲 Varier");
          list.append(el("div", { class: "assist-prop" + (isChosen ? " chosen" : "") }, fName.wrap, fDesc.wrap, fTone.wrap, fLore.wrap,
            el("div", { class: "card-actions" }, varyBtn, el("button", { class: "btn btn-primary btn-sm", onclick: () => {
              const world = {
                id: null, name: fName.input.value.trim(), description: fDesc.input.value.trim(),
                tone: fTone.input.value.trim(), lore: fLore.input.value.trim(),
              };
              if (!world.name) return toast("Donne un nom au monde.", "err");
              if (!world.description) return toast("Décris le monde en une phrase au minimum.", "err");
              st.world = world;
              st.memo.personas = null; st.chars = []; st.charsCtx = null;
              saveAssistDraft();
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
      if (r.truncated) toast(r.note || "Description tronquée.", "warn");
      paintBatch(r);
    } catch (e) {
      if (requestId !== st.requests.worlds || viewVersion !== st.viewVersion) return;
      status._stop?.();
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
    const status = timed("L'IA propose des personas…");
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
      status._stop?.();
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
              saveAssistDraft();
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
          const varyBtn = el("button", { class: "btn btn-ghost btn-sm", title: "Pré-remplit l'amélioration pour d'autres personas dans cet esprit", onclick: () => {
            fb.value = varyText(fName.input.value.trim() || p.name, fDesc.input.value.trim() || p.description);
            fb.focus();
            fb.scrollIntoView({ block: "nearest", behavior: "smooth" });
          } }, "🎲 Varier");
          list.append(el("div", { class: "assist-prop" + (isChosen ? " chosen" : "") }, fName.wrap, fDesc.wrap,
            el("div", { class: "card-actions" }, varyBtn, el("button", { class: "btn btn-primary btn-sm", onclick: () => {
              const persona = { id: null, name: fName.input.value.trim(), description: fDesc.input.value.trim() };
              if (!persona.name) return toast("Donne un nom à ton persona.", "err");
              st.persona = persona;
              st.chars = []; st.charsCtx = null;
              saveAssistDraft();
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
      if (r.truncated) toast(r.note || "Description tronquée.", "warn");
      paintBatch(r);
    } catch (e) {
      if (requestId !== st.requests.personas || viewVersion !== st.viewVersion) return;
      status._stop?.();
      status.replaceChildren(el("span", { class: "danger" }, "⚠️ " + esc(e.message)));
      list.append(el("div", { class: "assist-refine" },
        el("button", { class: "btn btn-primary btn-sm", onclick: () => stepPersonas(feedback, false) }, "↻ Réessayer"),
      ));
    }
  }

  // ── étape 4 : personnages évoqués → 4 cartes chacun ──
  async function stepCharacters(soft = false, feedback = "") {
    const viewVersion = ++st.viewVersion;
    stepIdx = 3; paintProgress();
    const requestId = ++st.requests.characters;
    const charsKey = keyOf(`${st.desc}|${st.world?.id || ""}|${st.world?.name || ""}|${st.persona?.id || ""}|${st.persona?.name || ""}`);
    const list = el("div", { class: "assist-list" });
    const status = timed("Recherche des personnages évoqués…");
    // refine the extraction itself (previously only a full reset existed —
    // the server always accepted feedback, the UI just never sent any)
    const extractFb = el("input", { class: "assist-in", placeholder: "💡 Affiner l'extraction (ex. « oublie le garde, ajoute la sœur »)…" });
    const extractBar = el("div", { class: "assist-refine" }, extractFb,
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
        const v = extractFb.value.trim();
        if (!v) return toast("Écris d'abord ton amélioration.", "err");
        st.chars = []; st.charsCtx = null;
        stepCharacters(false, v);
      } }, "↻ Ré-extraire"),
    );
    const addName = el("input", { class: "assist-in", placeholder: "Nom d'un personnage…" });
    const addRole = el("input", { class: "assist-in", placeholder: "Rôle (optionnel)…" });
    const cardDurations = []; // ms per card batch, for the remaining-time estimate
    const fmtEta = (ms) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}min ${Math.round((ms % 60000) / 1000)}s`;
    const genAllBtn = el("button", { class: "btn btn-primary", onclick: async () => {
      genAllBtn.disabled = true;
      const total = st.chars.length;
      let done = 0;
      genAllBtn.textContent = `⏳ Génération des cartes… (0/${total})`;
      for (const ch of st.chars) { ch.cards = null; ch.chosen = null; }
      for (const ch of st.chars) {
        done++;
        const avg = cardDurations.length ? cardDurations.reduce((a, b) => a + b, 0) / cardDurations.length : 0;
        const eta = avg && done < total ? ` — reste ≈ ${fmtEta(avg * (total - done + 1))}` : "";
        genAllBtn.textContent = `⏳ Génération des cartes… (${done}/${total}) — ${ch.name}${eta}`;
        const t0 = Date.now();
        await genCards(ch, "");
        cardDurations.push(Date.now() - t0);
        if (cardDurations.length > 8) cardDurations.shift();
      }
      saveAssistDraft();
      genAllBtn.disabled = false; genAllBtn.textContent = "↻ Régénérer toutes les cartes";
    } }, "✨ Générer les cartes");
    const root = el("div", {},
      el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } },
        el("h3", { style: { margin: 0 } }, "🎭 Personnages évoqués"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => go(2, true) }, "← Persona"),
      ),
      el("p", { class: "modal-note" }, "Ceux que tu as décrits, repérés dans ton idée. Chacun recevra 4 cartes à choisir — ou sa carte existante si elle correspond déjà."),
      status, list, extractBar,
      el("div", { class: "assist-footer" },
        el("div", { class: "assist-refine", style: { flex: "1" } }, addName, addRole,
          el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
            const nm = addName.value.trim();
            if (!nm) return toast("Écris un nom.", "err");
            st.chars.push({ name: nm, role: addRole.value.trim(), detail: "", reuseName: null, reuseCard: null, cards: null, chosen: null, status: "", skipped: false });
            addName.value = ""; addRole.value = "";
            saveAssistDraft();
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
      const t0 = Date.now();
      try {
        // persona + sibling names keep variants distinct from the player and
        // from each other (server forbidden-name set); first_mes comes back
        // with every proposal so the party starts talking right away
        const r = await api("/api/assist/build", { body: {
          stage: "cards", description: st.desc, world: st.world, persona: st.persona,
          character: { name: ch.name, role: ch.role, detail: ch.detail || "" },
          siblings: st.chars.map((x) => x.name).filter((n) => n && n !== ch.name),
          feedback: feedback || "",
        } });
        if (r.truncated) toast(r.note || "Description tronquée.", "warn");
        ch.cards = (r.proposals || []).filter((p2) => p2 && p2.name).slice(0, 4);
        ch.status = "";
        if (!ch.cards.length) ch.status = "Le modèle n'a rien proposé pour « " + ch.name + " » — affine ci-dessous.";
      } catch (e) {
        ch.status = "⚠️ " + e.message;
      }
      cardDurations.push(Date.now() - t0);
      if (cardDurations.length > 8) cardDurations.shift();
      paint();
    };

    const cardProp = (c, ch, onVary) => {
      const f = {
        name: fieldRow("Nom", c.name, "", 1),
        desc: fieldRow("Description", c.description, "Apparence, signes distinctifs…", 3),
        pers: fieldRow("Personnalité", c.personality, "", 2),
        sce: fieldRow("Situation initiale", c.scenario, "", 2),
        tags: fieldRow("Tags", Array.isArray(c.tags) ? c.tags.join(", ") : "", "", 1),
        first: fieldRow("Premier message", c.first_mes || "", "Sa première réplique quand le joueur le rencontre…", 2),
      };
      const varyBtn = onVary
        ? el("button", { class: "btn btn-ghost btn-sm", title: "Pré-remplit l'amélioration pour d'autres cartes dans cet esprit", onclick: onVary }, "🎲 Varier")
        : null;
      return el("div", { class: "assist-prop sub" }, f.name.wrap, f.desc.wrap, f.pers.wrap, f.sce.wrap, f.tags.wrap, f.first.wrap,
        el("div", { class: "card-actions" }, varyBtn, el("button", { class: "btn btn-primary btn-sm", onclick: () => {
          ch.chosen = {
            card: {
              name: f.name.input.value.trim() || "Personnage",
              description: f.desc.input.value.trim(),
              personality: f.pers.input.value.trim(),
              scenario: f.sce.input.value.trim(),
              tags: f.tags.input.value.split(",").map((t) => t.trim()).filter(Boolean),
              first_mes: f.first.input.value.trim(),
            },
          };
          saveAssistDraft();
          paint();
        } }, "✓ Valider cette carte")),
      );
    };

    const charRow = (ch) => {
      const parts = [];
      parts.push(el("div", { class: "char-head" },
        el("input", { class: "assist-in", value: ch.name, oninput: (e) => (ch.name = e.target.value.trim()) }),
        el("input", { class: "assist-in", value: ch.role, placeholder: "Rôle…", oninput: (e) => (ch.role = e.target.value.trim()) }),
        el("button", { class: "mini-btn", title: "Retirer ce personnage", onclick: () => { st.chars = st.chars.filter((x) => x !== ch); saveAssistDraft(); paint(); } }, "🗑"),
      ));
      if (ch.detail) parts.push(el("div", { class: "assist-hint", style: { fontSize: "12px" } }, "📜 " + esc(ch.detail)));
      if (ch.reuseCard) parts.push(el("div", { class: "assist-hint reuse" }, "💡 Correspond à ta carte « " + esc(ch.reuseCard.name) + " »."));
      if (ch.status) parts.push(el("div", { class: "assist-status" }, esc(ch.status)));
      if (ch.chosen) {
        parts.push(el("div", { class: "assist-hint ok" },
          "✓ " + (ch.chosen.reuseCardId ? "Carte existante utilisée : « " + esc(ch.reuseCard.name) + " »" : "Carte choisie : « " + esc(ch.chosen.card.name) + " »"),
          el("button", { class: "mini-btn", onclick: () => { ch.chosen = null; saveAssistDraft(); paint(); } }, "↺ Changer"),
        ));
      } else {
        // The matching existing card is offered immediately, BEFORE any LLM
        // call: choosing it skips the 4-variant generation entirely.
        if (ch.reuseCard) parts.push(el("div", { class: "assist-prop reuse" },
          el("strong", {}, "Déjà dans ta collection"),
          el("p", {}, esc(ch.reuseCard.description || "")),
          el("div", { class: "card-actions" }, el("button", { class: "btn btn-primary btn-sm", onclick: () => { ch.chosen = { reuseCardId: ch.reuseCard.id, reuseName: ch.reuseCard.name }; saveAssistDraft(); paint(); } }, "Utiliser « " + esc(ch.reuseCard.name) + " »")),
        ));
        if (ch.cards) {
          if (ch.cards.length) parts.push(el("div", { class: "assist-sec" }, "Variantes générées"));
          const fb = el("input", { class: "assist-in", placeholder: "💡 Pas convaincu ? Améliore et régénère…" });
          // anchor steering per variant: "more like this one" without retyping
          const varyFor = (c) => () => {
            fb.value = varyText(c.name, c.description);
            fb.focus();
            fb.scrollIntoView({ block: "nearest", behavior: "smooth" });
          };
          for (const c of ch.cards) parts.push(cardProp(c, ch, varyFor(c)));
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
      status._stop?.();
      status.hidden = true;
      applyCharacters(st.memo.characters, true);
      return;
    }
    try {
      const r = await api("/api/assist/build", { body: { stage: "characters", description: st.desc, world: st.world, persona: st.persona, feedback: feedback || "" } });
      if (requestId !== st.requests.characters || viewVersion !== st.viewVersion) return;
      if (r.truncated) toast(r.note || "Description tronquée.", "warn");
      status._stop?.();
      status.hidden = true;
      // Keep a manual character added while the extraction request was in
      // flight; the user should never lose edits because the model answered.
      applyCharacters(r, st.chars.length > 0);
      saveAssistDraft();
    } catch (e) {
      if (requestId !== st.requests.characters || viewVersion !== st.viewVersion) return;
      status._stop?.();
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
    // opening situation, generated from the idea (the situation used to die
    // at the handoff — now it becomes the party's draft intro, editable)
    if (!st.opening) st.opening = { title: "", intro: "" };
    const opTitleF = fieldRow("Titre", st.opening.title, "Ex : Arrivée au village", 1);
    const opIntroF = fieldRow("Situation de départ", st.opening.intro, "L'IA peut l'écrire depuis ton idée — ou écris-la toi-même…", 4);
    const opTitle = opTitleF.input;
    const opIntro = opIntroF.input;
    opIntro.style.minHeight = "90px";
    const opStatus = el("div", { class: "assist-status", role: "status", hidden: true });
    let opBusy = false;
    const opFb = el("input", { class: "assist-in", placeholder: "💡 Affiner (ex. « de nuit, sous la pluie »)…" });
    const genOpening = async () => {
      if (opBusy) return;
      opBusy = true;
      opStatus.hidden = false;
      opStatus.textContent = "✨ L'IA écrit la scène d'ouverture…";
      try {
        const castNames = chosen.map((c) => (c.reuseCardId ? c.reuseName : c.card?.name)).filter(Boolean);
        const r = await api("/api/assist/build", {
          body: {
            stage: "opening", description: st.desc, world: st.world, persona: st.persona,
            castNames, feedback: opFb.value.trim(),
          },
        });
        if (r.truncated) toast(r.note || "Description tronquée.", "warn");
        opTitle.value = r.title || "";
        opIntro.value = r.intro || "";
        st.opening = { title: opTitle.value, intro: opIntro.value };
        saveAssistDraft();
        opStatus.textContent = "Scène prête — modifie-la à ton goût ✓";
        toast("Situation de départ générée ✓", "ok");
      } catch (e) {
        opStatus.textContent = "⚠️ " + (e?.message || "génération impossible");
      } finally {
        opBusy = false;
      }
    };
    const syncOpening = () => {
      st.opening = { title: opTitle.value.trim(), intro: opIntro.value.trim() };
      saveAssistDraft();
    };
    opTitle.addEventListener("change", syncOpening);
    opIntro.addEventListener("change", syncOpening);
    const openingBox = el("details", { class: "assist-opening", ...(st.opening.intro ? { open: "" } : {}) },
      el("summary", {}, "📜 Situation de départ (optionnel — sinon l'accueil par défaut)"),
      el("p", { class: "modal-note" }, "La scène d'ouverture de ta partie, écrite depuis ton idée. Elle sera proposée comme scénario au lancement."),
      el("div", { class: "assist-refine" }, opFb,
        el("button", { class: "btn btn-primary btn-sm", onclick: genOpening }, "✨ Générer"),
      ),
      opTitleF.wrap, opIntroF.wrap, opStatus,
    );
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
      openingBox,
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
              const cardPayload = { name: card.name, description: card.description, personality: card.personality, scenario: card.scenario, first_mes: card.first_mes || "", tags: JSON.stringify(card.tags || []) };
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
            clearAssistDraft();
            closeAllModals();
            toast("✨ Monde, persona et personnages créés ✓");
            syncOpening();
            newGameWizard({
              world_id: worldId, persona_id: personaId, cast,
              ...(st.opening?.intro?.trim()
                ? { draft_title: st.opening.title.trim() || "Situation de départ", draft_intro: st.opening.intro.trim() }
                : {}),
            });
          } catch (err) {
            toast(err.message, "err");
            btn.disabled = false; btn.textContent = "✨ Créer & lancer la partie";
          }
        } }, "✨ Créer & lancer la partie"),
      ),
    ));
  }

  // Resume: a draft from a closed wizard offers to pick up where it stopped
  // (memoized batches render instantly, created ids keep creation idempotent).
  const draft = loadAssistDraft();
  if (draft && (draft.st.world || draft.st.persona || (draft.st.chars || []).length || draft.st.desc)) {
    const when = new Date(draft.at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const bits = [
      draft.st.world?.name ? "🌍 " + draft.st.world.name : null,
      draft.st.persona?.name ? "🧑‍🤝‍🧑 " + draft.st.persona.name : null,
      (draft.st.chars || []).length ? `🎭 ${(draft.st.chars || []).length} personnage(s)` : null,
    ].filter(Boolean).join(" · ");
    stepIdx = 0; paintProgress();
    run(() => el("div", {},
      el("h3", {}, "📝 Brouillon retrouvé"),
      el("p", { class: "modal-note" }, `Une création interrompue (${when})${bits ? " : " + bits : ""}. Tes choix et tes lots déjà générés sont conservés.`),
      el("div", { class: "assist-refine", style: { justifyContent: "flex-end" } },
        el("button", { class: "btn btn-ghost", onclick: () => { clearAssistDraft(); stepDescribe(); } }, "🗑 Recommencer"),
        el("button", { class: "btn btn-primary", onclick: () => {
          Object.assign(st, draft.st, { requests: { worlds: 0, personas: 0, characters: 0 }, viewVersion: 0 });
          if ((st.chars || []).length || st.memo.characters) go(3, true);
          else if (st.persona) go(2, true);
          else if (st.world) go(2, true);
          else if (st.memo.worlds) { stepIdx = 0; stepWorlds("", true); }
          else stepDescribe();
        } }, "▶ Reprendre"),
      ),
    ));
  } else {
    stepDescribe();
  }
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
      if (pre?.scenario_id && sc?.some((s) => String(s.id) === String(pre.scenario_id))) {
        scenSel.input.value = pre.scenario_id;
        return;
      }
      applyGuidedDraft();
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
  // coming from the guided builder with a generated opening → preselect it as
  // a draft scenario, exactly like the in-modal genre generator does. Applied
  // AFTER the async scenario load (which rebuilds the options and would wipe
  // an earlier append).
  const applyGuidedDraft = () => {
    if (!pre?.draft_intro || scenSel.input.querySelector('option[value="draft"]')) return;
    scenSel.input.append(el("option", { value: "draft", selected: "" }, pre.draft_title || "Situation de départ"));
    scenSel.input.dataset.draftName = pre.draft_title || "Situation de départ";
    scenSel.input.dataset.draftIntro = pre.draft_intro;
    scenSel.input.value = "draft";
    scenPreview.hidden = false;
    scenPreview.replaceChildren(
      el("div", { class: "gen-preview-head" }, "📜 " + esc(pre.draft_title || "Situation de départ")),
      el("p", {}, esc(pre.draft_intro)),
    );
  };
  if (!pre?.world_id) applyGuidedDraft();
  // coming from the guided builder → preselect the validated persona & cast
  if (pre?.persona_id) persoSel.input.value = String(pre.persona_id);
  if (Array.isArray(pre?.cast)) {
    for (const id of pre.cast) {
      castGrid.querySelector(`[data-card-id="${id}"]`)?.classList.add("selected");
    }
  }
}
