// Memory Center: everything the story remembers (structured memory, canon
// facts, relation graph, lorebook) as tabbed panes. Extracted from chat.js —
// chat.js keeps the header buttons, the standalone-modal wrappers and the
// auto-refresh hook; this module owns the panes plus the shared relations ref.
import { api } from "./api.js?v=66";
import { el, esc, toast, confirmModal, openModal } from "./ui.js?v=66";

// Shared live ref so the post-turn auto hook can refresh an open relations
// pane (standalone modal or Memory Center tab) without chat.js coupling.
export const relationsRef = { current: null };

// Pane builder for the relations tab (shared by the standalone modal and the
// Memory Center). Returns the element plus refresh/redraw hooks — the caller
// owns the modal and calls refresh() once mounted.
export function buildRelationsPane(convIn, fmtAgo) {
  const convId = Number(convIn.id);
  let conv = convIn;
  let rels = null;
  let busy = false;
  const tip = el("div", { class: "rel-tip", hidden: true });
  const canvas = el("canvas", { class: "rel-canvas" });
  const canvasWrap = el("div", { class: "rel-wrap" }, canvas, tip);
  const status = el("span", { class: "rel-status" });
  const scanBtn = el("button", { class: "btn btn-primary btn-sm" }, "🔄 Analyser les dernières scènes");
  const resetBtn = el("button", { class: "btn btn-ghost btn-sm" }, "🗑 Réinitialiser");
  const legendEl = el("div", { class: "rel-legend" });
  const emptyEl = el("div", { class: "empty" },
    el("div", { class: "big" }, "💞"),
    el("h3", {}, "Aucun personnage à relier"),
    el("p", {}, "Ajoute au moins deux personnages à la partie (cartes en scène ou personnages secondaires découverts en jouant), puis lance une analyse."),
  );
  const toolbar = el("div", { class: "rel-toolbar" }, scanBtn, resetBtn, status);

  const bucketFor = (v) =>
    v <= -70 ? { color: "#e11d48", label: "haine" }
      : v <= -25 ? { color: "#f97316", label: "tension" }
        : v < 25 ? { color: "#94a3b8", label: "neutre" }
          : v < 70 ? { color: "#10b981", label: "allié" }
            : { color: "#ec4899", label: "passion" };
  const BUCKET_META = [
    { label: "haine", color: "#e11d48" }, { label: "tension", color: "#f97316" },
    { label: "neutre", color: "#94a3b8" }, { label: "allié", color: "#10b981" }, { label: "passion", color: "#ec4899" },
  ];
  legendEl.append(...BUCKET_META.map((b) => el("span", { class: "rel-legend-item" }, el("i", { style: { background: b.color } }), b.label)));

  const collectNames = () => {
    const map = new Map();
    for (const c of conv.cards || []) if (c?.name) map.set(c.name, { name: c.name, persona: false });
    if (conv.persona?.name) map.set(conv.persona.name, { name: conv.persona.name, persona: true });
    for (const p of rels?.pairs || []) {
      if (p?.a) map.set(p.a, { name: p.a, persona: false });
      if (p?.b) map.set(p.b, { name: p.b, persona: false });
    }
    const personaName = conv.persona?.name;
    return [...map.values()].sort((x, y) => {
      if (x.name === personaName) return -1;
      if (y.name === personaName) return 1;
      return x.name.localeCompare(y.name, "fr");
    });
  };

  let hoverName = null;
  let hoverKey = null; // canonical "a|b" of the edge under the cursor
  const redraw = () => {
    const names = collectNames();
    const hasPeople = names.length >= 2;
    canvas.hidden = !hasPeople;
    emptyEl.hidden = hasPeople;
    if (!hasPeople) { hoverName = null; hoverKey = null; tip.hidden = true; return; }
    const W = Math.max(560, canvasWrap.clientWidth - 8) || 860;
    const H = 520;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // circular layout
    const N = names.length;
    const cx = W / 2, cy = H / 2;
    const R = Math.max(120, Math.min(Math.min(W, H) / 2 - 70, (N * 96) / (2 * Math.PI)));
    const pos = new Map();
    names.forEach((n, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
      pos.set(n.name, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) });
    });
    const keyOf = (a, b) => (a < b ? a + "\u241f" + b : b + "\u241f" + a);
    const rowsFor = (a, b) => {
      const rows = { ab: null, ba: null };
      for (const p of rels?.pairs || []) {
        if (p.a === a && p.b === b) rows.ab = p;
        else if (p.a === b && p.b === a) rows.ba = p;
      }
      return rows;
    };
    // one record per undirected pair
    const seen = new Set();
    const pairKeys = [];
    for (const p of rels?.pairs || []) {
      if (!pos.has(p?.a) || !pos.has(p?.b)) continue;
      const k = keyOf(p.a, p.b);
      if (seen.has(k)) continue;
      seen.add(k);
      pairKeys.push(k);
    }
    const edgeInfo = (k) => {
      const [a, b] = k.split("\u241f");
      const rows = rowsFor(a, b);
      const vals = [rows.ab, rows.ba].filter(Boolean).map((r) => r.value);
      if (!vals.length) return null;
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      // the dominant direction drives the colour + the arrow head
      const dom = (rows.ab?.value ?? -Infinity) >= (rows.ba?.value ?? -Infinity) ? rows.ab : rows.ba;
      return { a, b, rows, avg, dom, bucket: bucketFor(dom.value) };
    };
    // edges (behind the nodes)
    for (const k of pairKeys) {
      const e = edgeInfo(k);
      if (!e) continue;
      const A = pos.get(e.a), B = pos.get(e.b);
      const hi = hoverKey === k;
      ctx.globalAlpha = hi ? 1 : 0.5 + (Math.abs(e.avg) / 100) * 0.45;
      ctx.strokeStyle = e.bucket.color;
      ctx.lineWidth = 1.6 + Math.min(4.5, (Math.abs(e.avg) / 100) * 4.4) + (hi ? 1.6 : 0);
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.stroke();
      // arrow head at the target of the dominant feeling (a feels → b)
      const fx = pos.get(e.dom.a).x, fy = pos.get(e.dom.a).y;
      const tx = pos.get(e.dom.b).x, ty = pos.get(e.dom.b).y;
      const ang = Math.atan2(ty - fy, tx - fx);
      const tipX = tx - Math.cos(ang) * 27, tipY = ty - Math.sin(ang) * 27;
      const back1 = ang + Math.PI - 0.55, back2 = ang + Math.PI + 0.55;
      ctx.globalAlpha = hi ? 1 : 0.75;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + Math.cos(back1) * 8, tipY + Math.sin(back1) * 8);
      ctx.lineTo(tipX + Math.cos(back2) * 8, tipY + Math.sin(back2) * 8);
      ctx.closePath();
      ctx.fillStyle = e.bucket.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      // score badge mid-edge when the graph is sparse enough
      if (N <= 12 && Math.abs(e.avg) >= 15) {
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        const label = (e.avg >= 0 ? "+" : "") + Math.round(e.avg);
        ctx.font = "700 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(0,0,0,.72)";
        ctx.fillRect(mx - 13, my - 10, 26, 19);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, mx, my + 0.5);
      }
    }
    ctx.globalAlpha = 1;
    // nodes
    for (const n of names) {
      const { x, y } = pos.get(n.name);
      const r = 21;
      const hue = nameHue(n.name);
      const grad = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
      grad.addColorStop(0, `hsl(${hue} 78% 62%)`);
      grad.addColorStop(1, `hsl(${(hue + 48) % 360} 80% 36%)`);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      if (hoverName === n.name) {
        ctx.strokeStyle = "rgba(255,255,255,.85)";
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (n.persona) {
        ctx.strokeStyle = "rgba(255,255,255,.95)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = "#fff";
      ctx.font = "700 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((n.name.charAt(0) || "?").toUpperCase(), x, y + 0.5);
      ctx.font = "11px system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.shadowColor = "rgba(0,0,0,.85)";
      ctx.shadowBlur = 3;
      ctx.fillStyle = "#fff";
      ctx.fillText(n.name, x, y + r + 7);
      if (n.persona) {
        ctx.font = "9.5px system-ui, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,.72)";
        ctx.fillText("(toi)", x, y + r + 20);
      }
      ctx.shadowBlur = 0;
    }
    // remember geometry for hit-testing
    redraw.geom = { pos, pairKeys, edgeInfo, W, H };
  };

  const fmtVal = (p) => (p.value >= 0 ? "+" : "") + p.value;
  const tipRows = (name, k, g) => {
    const out = [];
    if (name) {
      out.push(el("strong", {}, esc(name) + (name === conv.persona?.name ? " (toi)" : "")));
      const links = (rels?.pairs || []).filter((p) => p.a === name || p.b === name);
      if (!links.length) out.push(el("div", { class: "dim" }, "Aucun lien suivi pour l'instant."));
      else for (const p of links) {
        out.push(el("div", {}, esc(p.a) + " → " + esc(p.b) + " : " + fmtVal(p) + (p.note ? " — " + esc(p.note) : "")));
      }
    } else if (k && g) {
      const e = g.edgeInfo(k);
      if (e) {
        out.push(el("strong", {}, "Lien"));
        for (const p of [e.rows.ab, e.rows.ba]) {
          if (p) out.push(el("div", {}, esc(p.a) + " → " + esc(p.b) + " : " + fmtVal(p) + " (" + bucketFor(p.value).label + ")" + (p.note ? " — " + esc(p.note) : "")));
        }
      }
    }
    return out;
  };
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const g = redraw.geom;
    hoverName = null;
    hoverKey = null;
    if (g) {
      for (const [name, p] of g.pos) {
        if (Math.hypot(p.x - mx, p.y - my) <= 26) { hoverName = name; break; }
      }
      if (!hoverName) {
        for (const k of g.pairKeys) {
          const ed = g.edgeInfo(k);
          if (!ed) continue;
          const A = g.pos.get(ed.a), B = g.pos.get(ed.b);
          const dx = B.x - A.x, dy = B.y - A.y;
          const len2 = dx * dx + dy * dy;
          const t = len2 ? Math.max(0, Math.min(1, ((mx - A.x) * dx + (my - A.y) * dy) / len2)) : 0;
          const px = A.x + t * dx, py = A.y + t * dy;
          if (Math.hypot(mx - px, my - py) <= 8) { hoverKey = k; break; }
        }
      }
    }
    canvas.style.cursor = hoverName ? "pointer" : "default";
    const rows = tipRows(hoverName, hoverKey, g);
    if (rows.length) {
      tip.hidden = false;
      tip.replaceChildren(...rows);
      const maxX = g ? g.W : 800;
      const maxY = g ? g.H : 500;
      tip.style.left = Math.min(mx + 14, maxX - 320) + "px";
      tip.style.top = Math.min(my + 14, maxY - 130) + "px";
    } else tip.hidden = true;
    redraw();
  });
  canvas.addEventListener("mouseleave", () => {
    hoverName = null;
    hoverKey = null;
    tip.hidden = true;
    redraw();
  });

  const refreshData = async () => {
    const [c, r] = await Promise.all([
      api(`/api/conversations/${convId}`).catch(() => conv),
      api(`/api/conversations/${convId}/relations`).catch(() => ({ rels: null })),
    ]);
    conv = c;
    rels = r.rels || null;
    const n = rels?.pairs?.length || 0;
    resetBtn.hidden = !n;
    if (n) status.textContent = `${n} lien${n > 1 ? "s" : ""} suivi${n > 1 ? "s" : ""} · dernière analyse ${fmtAgo(rels.at) || "à l'instant"}.`;
    else status.textContent = "Aucun lien suivi pour l'instant — joue quelques scènes puis lance une analyse.";
    redraw();
  };

  scanBtn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    scanBtn.disabled = true;
    scanBtn.textContent = "⏳ Analyse en cours…";
    status.textContent = "Le modèle relit les dernières scènes…";
    try {
      const r = await api(`/api/conversations/${convId}/relations`, { method: "POST", body: { manual: true } });
      if (!r.scanned) {
        // refused scans are NOT errors — say why, so "nothing happened" is legible
        status.textContent =
          r.reason === "empty" ? "Il faut au moins deux messages de fiction pour analyser."
          : r.reason === "throttle" ? "Analyse déjà récente — l'auto-analyse tourne toutes les 8 min, réessaie dans quelques minutes."
          : r.reason === "threshold" ? `Pas assez de nouveaux messages (${r.have ?? 0}/${r.needed ?? "?"}). Joue encore quelques échanges.`
          : (r.error || "Analyse impossible pour l'instant.");
      } else {
        await refreshData();
        status.textContent = r.changed ? `${r.changed} lien${r.changed > 1 ? "s" : ""} mis à jour ✓` : "Analyse à jour — aucun changement.";
      }
    } catch (e) {
      status.textContent = "Analyse impossible — " + (e?.message || "modèle injoignable.");
    } finally {
      busy = false;
      scanBtn.disabled = false;
      scanBtn.textContent = "🔄 Analyser les dernières scènes";
    }
  });
  resetBtn.addEventListener("click", async () => {
    if (!(await confirmModal({ title: "Réinitialiser les relations", message: "Effacer tous les liens suivis ? Ils seront reconstruits lors des prochaines analyses.", confirmLabel: "Réinitialiser" }))) return;
    try {
      await api(`/api/conversations/${convId}/relations/reset`, { method: "POST", body: {} });
      await refreshData();
      toast("Relations réinitialisées ✓");
    } catch (e) { toast(e.message, "err"); }
  });

  const body = el("div", {},
    toolbar,
    legendEl,
    canvasWrap,
    emptyEl,
  );
  return { body, refresh: refreshData, redraw };
}


// Pane builder for the memory tab (standalone modal + Memory Center share it).
// `conv` is the fetched conversation (with .memory); onSaved receives the
// updated memory (the standalone modal closes, the Center stays open).
export function buildMemoryPane(conv, onSaved, syncMemory) {
  const convId = conv.id;
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
      const updated = await api(`/api/conversations/${convId}`, { method: "PATCH", body });
      syncMemory?.(convId, updated.memory || null);
      toast("Mémoire mise à jour ✓");
      onSaved?.(updated.memory || null);
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
  return el("div", {},
    el("p", { class: "modal-note" }, "Mise à jour automatiquement par le résumé quand le fil devient trop long. Modifie-la si un détail compte pour la suite."),
    body,
    el("div", { style: { marginTop: "14px", display: "flex", justifyContent: "flex-end" } }, saveBtn),
  );
}


// Pane builder for the canon tab (standalone modal + Memory Center share it).
export function buildCanonPane(convId) {
  const list = el("div", { class: "canon-list" });
  const summary = el("span", { class: "canon-summary" });
  const proposeBtn = el("button", { class: "btn btn-ghost btn-sm", title: "Le modèle propose de nouveaux faits à partir du fil — à approuver ici" }, "🤖 Proposer des faits");
  const STATUS_ARCHIVE = new Set(["rejected", "retired"]);

  const load = async () => {
    let data;
    try { data = await api(`/api/conversations/${convId}/canon`); }
    catch (e) { return toast(e.message, "err"); }
    const entries = data.entries || [];
    const confirmed = entries.filter((e) => e.status === "confirmed");
    const proposed = entries.filter((e) => e.status === "proposed");
    const archived = entries.filter((e) => STATUS_ARCHIVE.has(e.status));
    summary.textContent = `${confirmed.length} fait${confirmed.length > 1 ? "s" : ""} confirmé${confirmed.length > 1 ? "s" : ""} · ${proposed.length} proposition${proposed.length > 1 ? "s" : ""} à approuver`;
    // replaceChildren stringifies nulls into « null » text nodes — build the
    // array first and let el() (or an explicit filter) drop the empty sections
    const sections = [];
    if (confirmed.length) sections.push(el("div", { class: "canon-sec" },
      el("div", { class: "canon-sec-title" }, `✔ Faits confirmés (${confirmed.length})`),
      ...confirmed.map((e) => canonRow(e, "confirmed")),
    ));
    if (proposed.length) sections.push(el("div", { class: "canon-sec" },
      el("div", { class: "canon-sec-title" }, `⏳ Propositions IA (${proposed.length})`),
      ...proposed.map((e) => canonRow(e, "proposed")),
    ));
    if (archived.length) sections.push(el("details", { class: "canon-sec" },
      el("summary", { class: "canon-sec-title", style: { cursor: "pointer" } }, `Archivés (${archived.length})`),
      ...archived.map((e) => canonRow(e, "archived")),
    ));
    if (!sections.length) sections.push(el("div", { class: "empty" },
      el("div", { class: "big" }, "📖"), el("h3", {}, "Aucun fait canonique"),
      el("p", {}, "Ajoute un fait à la main, ou laisse le modèle en proposer depuis le fil — ils n'entrent en vigueur qu'une fois approuvés."),
    ));
    list.replaceChildren(...sections);
  };

  const canonRow = (e, status) => {
    const subjectEl = el("strong", { class: "canon-subject" }, esc(e.subject || ""));
    const factEl = el("div", { class: "canon-fact" }, esc(e.fact || ""));
    const act = el("div", { class: "canon-actions" });
    const chips = el("div", { class: "canon-chips" },
      el("span", { class: "chip tiny" }, e.scope === "world" ? "🌍 tout le monde" : "💬 cette partie"),
      e.locked ? el("span", { class: "chip tiny" }, "🔒 verrouillé") : null,
      e.origin === "ai" ? el("span", { class: "chip tiny" }, "proposé par IA") : null,
    );
    const row = el("div", { class: "canon-row" + (status === "proposed" ? " proposed" : "") },
      el("div", { class: "canon-main" }, subjectEl, factEl, chips),
      act,
    );

    const edit = () => {
      const sub = el("input", { class: "canon-input", value: e.subject || "", maxlength: 120 });
      const fac = el("textarea", { class: "canon-input", rows: 2, maxlength: 2000 }); fac.value = e.fact || "";
      const save = el("button", { class: "mini-btn", onclick: async () => {
        try {
          const up = await api(`/api/conversations/${convId}/canon/${e.id}`, { method: "PATCH", body: { subject: sub.value.trim(), fact: fac.value.trim() } });
          e.subject = up.subject; e.fact = up.fact;
          subjectEl.textContent = e.subject; factEl.textContent = e.fact;
          toast("Fait mis à jour ✓");
          paint();
        } catch (err) { toast(err.message, "err"); }
      } }, "✓");
      const cancel = el("button", { class: "mini-btn", onclick: paint }, "✕");
      act.replaceChildren(save, cancel);
      sub.focus();
    };
    const paint = () => act.replaceChildren(...actions());
    const editBtn = () => el("button", { class: "mini-btn", title: "Modifier", onclick: edit }, "✏️");
    const actions = () => {
      if (status === "proposed") {
        const ok = el("button", { class: "mini-btn", style: { color: "var(--ok, #35c27a)" }, title: "Approuver — devient un fait confirmé", onclick: async () => {
          try { await api(`/api/conversations/${convId}/canon/${e.id}/status`, { method: "POST", body: { status: "confirmed" } }); toast("Fait confirmé ✓"); load(); }
          catch (err) { toast(err.message, "err"); }
        } }, "✓ Approuver");
        const no = el("button", { class: "mini-btn", title: "Rejeter la proposition", onclick: async () => {
          try { await api(`/api/conversations/${convId}/canon/${e.id}/status`, { method: "POST", body: { status: "rejected" } }); toast("Proposition rejetée"); load(); }
          catch (err) { toast(err.message, "err"); }
        } }, "✗ Rejeter");
        return [ok, no, editBtn()];
      }
      const lock = el("button", { class: "mini-btn", title: e.locked ? "Déverrouiller" : "Verrouiller — prioritaire dans le prompt", onclick: async () => {
        try {
          await api(`/api/conversations/${convId}/canon/${e.id}`, { method: "PATCH", body: { locked: !e.locked } });
          e.locked = !e.locked;
          toast(e.locked ? "Fait verrouillé 🔒" : "Fait déverrouillé");
          load();
        } catch (err) { toast(err.message, "err"); }
      } }, e.locked ? "🔓" : "🔒");
      const del = el("button", { class: "mini-btn", style: { color: "var(--danger)" }, title: "Supprimer définitivement", onclick: async () => {
        if (!(await confirmModal({ title: "Supprimer le fait", message: `Supprimer « ${e.subject} : ${String(e.fact).slice(0, 80)} » ?` }))) return;
        try { await api(`/api/conversations/${convId}/canon/${e.id}`, { method: "DELETE" }); toast("Fait supprimé"); load(); }
        catch (err) { toast(err.message, "err"); }
      } }, "🗑");
      return [editBtn(), lock, del];
    };
    paint();
    return row;
  };

  const addSubject = el("input", { class: "canon-input", placeholder: "Sujet — ex : Élara", maxlength: 120 });
  const addFact = el("textarea", { class: "canon-input", rows: 2, placeholder: "Fait — ex : Élara a juré de protéger le médaillon", maxlength: 2000 });
  const addScope = el("select", { class: "mini-select", "aria-label": "Portée" },
    el("option", { value: "conversation" }, "💬 cette partie"),
    el("option", { value: "world" }, "🌍 tout le monde"),
  );
  const addLocked = el("input", { type: "checkbox", "aria-label": "Verrouiller le fait" });
  const addBtn = el("button", { class: "btn btn-primary btn-sm" }, "➕ Ajouter");
  addBtn.addEventListener("click", async () => {
    const subject = addSubject.value.trim();
    const fact = addFact.value.trim();
    if (!subject || !fact) return toast("Sujet et fait sont requis.", "err");
    try {
      await api(`/api/conversations/${convId}/canon`, { method: "POST", body: { subject, fact, scope: addScope.value, locked: addLocked.checked } });
      addSubject.value = ""; addFact.value = "";
      toast("Fait confirmé ajouté ✓");
      load();
    } catch (e) { toast(e.message, "err"); }
  });

  proposeBtn.addEventListener("click", async () => {
    proposeBtn.disabled = true;
    try {
      const r = await api(`/api/conversations/${convId}/canon/propose`, { method: "POST", body: {} });
      const n = (r.proposed || []).length;
      toast(n ? `${n} proposition${n > 1 ? "s" : ""} ajoutée${n > 1 ? "s" : ""} ✓` : "Aucun nouveau fait à proposer.");
      load();
    } catch (e) { toast(e.message, "err"); }
    finally { proposeBtn.disabled = false; }
  });

  const body = el("div", {},
    el("p", { class: "modal-note" }, "Autorité narrative : injectés dans le prompt avant la mémoire et le résumé. Les propositions IA n'entrent en vigueur qu'une fois approuvées."),
    el("div", { class: "canon-head" }, summary, proposeBtn),
    list,
    el("div", { class: "modal-section" }, "Ajouter un fait"),
    el("div", { class: "canon-add" },
      el("div", { class: "canon-add-grid" }, addSubject, addScope),
      addFact,
      el("div", { class: "canon-add-foot" },
        el("label", { class: "setting-row slim" }, el("span", { class: "lbl" }, "🔒 Verrouillé (prioritaire)"), addLocked),
        addBtn,
      ),
    ),
  );
  return { body, load };
}


// Pane builder for the lore tab (standalone modal + Memory Center share it).
// Actions live inside the pane so it works with or without a modal footer.
export function buildLorePane(conv, onSaved) {
  const convId = conv.id;
  const body = el("div", { class: "lore-body" }, el("p", { class: "modal-note" }, "Chargement…"));
  const suggestBtn = el("button", { class: "btn btn-ghost btn-sm", disabled: true }, "✨ Proposer depuis la fiction");
  const okBtn = el("button", { class: "btn btn-primary btn-sm" }, "💾 Enregistrer");
  const actions = el("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "12px" } }, suggestBtn, okBtn);
  const pane = el("div", {},
    el("p", { class: "modal-note" }, "Faits fixes du monde, injectés dans le prompt quand leurs motifs apparaissent dans la fiction."),
    body,
    actions,
  );
  let entries = [];
  const load = async () => {
    try {
      const d = await api(`/api/conversations/${convId}/lore`);
      entries = d.entries || [];
    } catch (e) { body.replaceChildren(el("p", { class: "modal-note" }, esc(e.message))); return; }
    render();
  };
  const render = () => {
    body.replaceChildren(
      el("div", { class: "lore-list" },
        ...entries.map((e, i) => {
          const name = el("input", { class: "field", placeholder: "Nom (ex : Guilde des Ombres)", value: e.name });
          const trig = el("input", { class: "field", placeholder: "Motifs, séparés par des virgules (ex : guilde, ombre)", value: e.triggers });
          const content = el("textarea", { class: "field", rows: 2, placeholder: "Fait canonique, en 2-4 phrases" }, e.content);
          name.addEventListener("input", () => { e.name = name.value; });
          trig.addEventListener("input", () => { e.triggers = trig.value; });
          content.addEventListener("input", () => { e.content = content.value; });
          const delBtn = el("button", { class: "btn btn-ghost btn-sm", title: "Supprimer", onclick: () => { entries.splice(i, 1); render(); } }, "🗑");
          const onBtn = el("button", { class: "btn btn-ghost btn-sm", title: e.enabled === 0 ? "Activé" : "Désactivé", onclick: () => { e.enabled = e.enabled === 0 ? 1 : 0; render(); } }, e.enabled === 0 ? "⛔" : "✅");
          return el("div", { class: "lore-card", "data-disabled": e.enabled === 0 },
            el("div", { class: "lore-head" }, name, el("div", { class: "lore-btns" }, onBtn, delBtn)),
            trig,
            content,
          );
        }),
      ),
      entries.length ? null : el("div", { class: "empty" }, el("div", { class: "big" }, "📚"), el("h3", {}, "Aucun canon défini"), el("p", {}, "Pose des faits fixes, ou fais-les proposer par le modèle depuis la fiction.")),
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
        entries.push({ key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: "", triggers: "", content: "", enabled: 1, at: Date.now() });
        render();
      } }, "＋ Ajouter un fait"),
    );
    const dirty = entries.some((x) => !x.name || !x.content);
    okBtn.disabled = dirty;
  };
  suggestBtn.addEventListener("click", async () => {
    const wasDirty = entries.some((x) => !x.name || !x.content);
    if (wasDirty) { toast("Enregistre d'abord l'état en cours.", "err"); return; }
    suggestBtn.disabled = true;
    suggestBtn.textContent = "✨ Analyse de la fiction…";
    try {
      const r = await api(`/api/conversations/${conv.id}/lore/suggest`, { body: {} });
      const fresh = r.entries || [];
      if (!fresh.length) { toast("Aucun fait stable détecté.", "err"); return; }
      const known = new Set(entries.map((x) => (x.name || "").toLowerCase()));
      entries = [...entries, ...fresh.filter((x) => !known.has((x.name || "").toLowerCase())).map((x) => ({ ...x, enabled: 1, at: Date.now() }))];
      render();
      toast(`✨ ${fresh.length} fait(s) proposé(s) — relis-les avant d'enregistrer.`);
    } catch (e) { toast(e.message, "err"); }
    finally { suggestBtn.disabled = false; suggestBtn.textContent = "✨ Proposer depuis la fiction"; }
  });
  okBtn.addEventListener("click", async () => {
    const clean = entries.filter((x) => x.name.trim() && x.content.trim());
    okBtn.disabled = true;
    try {
      await api(`/api/conversations/${convId}/lore`, { body: { entries: clean } });
      toast(`📚 ${clean.length} fait(s) canonique(s) enregistré(s) ✓`);
      onSaved?.(clean);
    } catch (e) { toast(e.message, "err"); okBtn.disabled = false; }
  });
  load();
  return { pane, load };
}


// ─── Memory Center ───────────────────────────────────────────────────────────
// One tabbed panel for everything the story remembers (structured memory,
// canon facts, relation graph, lorebook). The four panes above are shared with
// the standalone modals, so old entry points keep working — the header now
// opens the Center directly on the relevant tab.
export async function openMemoryCenter(conv, { tab = "memory", fmtAgo = () => "", syncMemory = null } = {}) {
  if (!conv) return;
  const convId = conv.id;
  const tabs = [
    { key: "memory", label: "🧠 Mémoire", badge: "" },
    { key: "canon", label: "📖 Canon", badge: "" },
    { key: "relations", label: "💞 Relations", badge: "" },
    { key: "lore", label: "📚 Lore", badge: "" },
  ];
  let active = tabs.some((t) => t.key === tab) ? tab : "memory";
  const built = {}; // key → element
  let relPane = null;
  const bar = el("div", { class: "mem-tabs", role: "tablist" });
  const content = el("div", { class: "mem-tab-body" }, el("p", { class: "modal-note" }, "Chargement…"));
  const paintBar = () => {
    bar.replaceChildren(...tabs.map((t) => el("button", {
      class: `chip-btn${t.key === active ? " on" : ""}`,
      role: "tab", "aria-selected": String(t.key === active),
      onclick: () => activate(t.key),
    }, t.label + (t.badge ? ` ${t.badge}` : ""))));
  };
  async function activate(key) {
    active = key;
    paintBar();
    if (!built[key]) {
      content.replaceChildren(el("p", { class: "modal-note" }, "Chargement…"));
      try {
        if (key === "memory") {
          const full = await api(`/api/conversations/${convId}`).catch(() => conv);
          built[key] = buildMemoryPane(full, null, syncMemory);
        } else if (key === "canon") {
          const pane = buildCanonPane(convId);
          built[key] = pane.body;
          pane.load();
        } else if (key === "relations") {
          relPane = buildRelationsPane(conv, fmtAgo);
          built[key] = relPane.body;
          relationsRef.current = { refresh: relPane.refresh, center: true };
          await relPane.refresh();
          requestAnimationFrame(relPane.redraw);
        } else {
          built[key] = buildLorePane(conv, null).pane;
        }
      } catch (e) { toast(e.message, "err"); return; }
    }
    content.replaceChildren(built[key]);
    // a hidden canvas reports width 0 — recompute once visible
    if (key === "relations" && relPane) requestAnimationFrame(relPane.redraw);
  }
  const { close } = openModal({
    title: "🧠 Mémoire de la partie",
    sub: `${conv.title || ""} · souvenirs, faits, liens et canon — tout ce que le récit retient, au même endroit.`,
    body: el("div", {}, bar, content),
    footer: [el("button", { class: "btn btn-ghost", onclick: () => close() }, "Fermer")],
    wide: true,
    onClose: () => { if (relationsRef.current?.center) relationsRef.current = null; },
  });
  paintBar();
  // tab count badges (best-effort, never blocks the panel)
  Promise.all([
    api(`/api/conversations/${convId}/canon`).catch(() => null),
    api(`/api/conversations/${convId}/relations`).catch(() => null),
    api(`/api/conversations/${convId}/lore`).catch(() => null),
  ]).then(([c, r, l]) => {
    const proposed = (c?.entries || []).filter((e) => e.status === "proposed").length;
    if (proposed) tabs[1].badge = `(${proposed} ⏳)`;
    const pairs = (r?.rels?.pairs || []).length;
    if (pairs) tabs[2].badge = `(${pairs})`;
    const n = (l?.entries || []).length;
    if (n) tabs[3].badge = `(${n})`;
    paintBar();
  });
  await activate(active);
}

