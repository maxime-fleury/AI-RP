// DOM + UI helpers
const BOOLEAN_ATTRS = new Set(["hidden", "disabled", "checked", "selected", "readonly", "required", "open", "autofocus"]);
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function" && (k.length > 3 && /^on(click|change|input|submit|keydown|keyup|keypress|mousedown|mouseup|mouseenter|mouseleave|mouseover|mouseout|mousemove|focus|focusin|focusout|blur|dblclick|contextmenu|scroll|dragover|dragleave|drop|touchstart|touchend|paste|copy|cut|wheel|resize|pointerdown|pointerup|animationend)$/i.test(k))) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (BOOLEAN_ATTRS.has(k)) { if (v && v !== "false") node.setAttribute(k, ""); else node.removeAttribute(k); }
    else if (v === false || v === null || v === undefined) continue;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  // a11y: every icon/tooltip button gets an accessible name from its title
  if (!node.hasAttribute("aria-label") && node.getAttribute("title")) {
    node.setAttribute("aria-label", node.getAttribute("title"));
  }
  return node;
}

/**
 * Identity escape for user content. All rendering goes through `el()` which
 * builds text nodes via document.createTextNode(), so XSS is automatically
 * prevented. This function exists for clarity and for cases where content
 * must be serialized into HTML strings (exports, clipboard, lightbox).
 */
export function esc(s) {
  if (s == null) return "";
  return String(s);
}

/**
 * Conversation-settings blob accessor (mirror of the server-side
 * `conversationSettingsOf`). ONE place owns the parse so call sites stop
 * hand-rolling `JSON.parse(conv.settings || "{}")` — corrupt JSON -> {}.
 */
export function convSettingsOf(conv) {
  let raw = typeof conv === "string" ? conv : conv && conv.settings;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${time}`;
}

/** Relative age for backup lists ("il y a 3 h", "il y a 2 j"…). */
export function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `il y a ${d} j`;
  return new Date(Date.now() - ms).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

export function toast(msg, type = "ok", ms = 3800) {
  const root = document.getElementById("toasts");
  if (!root) { console.log(`[toast:${type}]`, msg); return; }
  const t = el("div", { class: `toast ${type}`, role: "status", "aria-live": "polite" }, type === "err" || type === "warn" ? "⚠️" : "✅", msg);
  root.append(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity .3s";
    setTimeout(() => t.remove(), 320);
  }, ms);
}

/** Toast with a clickable action (e.g. "Annuler") — used for undoable deletes. */
export function actionToast(msg, actionLabel, onAction, ms = 6000) {
  const root = document.getElementById("toasts");
  if (!root) { console.log("[toast:action]", msg); return; }
  const btn = el("button", { class: "toast-action", onclick: () => { onAction?.(); dismiss(); } }, actionLabel);
  const t = el("div", { class: "toast ok action", role: "status", "aria-live": "polite" }, "✅", msg, btn);
  const dismiss = () => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 320); };
  root.append(t);
  setTimeout(dismiss, ms);
}

let modalSeq = 0;

/**
 * True modal focus system: unique title id, initial focus (autofocus field
 * first), a Tab/Shift+Tab focus trap that only the TOPMOST modal owns, Escape
 * that closes only the topmost, focus return on close (to the previously
 * focused element — which is inside the parent modal for nested dialogs) and
 * screen-reader announcements through the live region.
 */
export function openModal({ title, sub, body, footer, wide = false, onClose }) {
  const root = document.getElementById("modal-root");
  const backdrop = el("div", { class: "modal-backdrop" });
  const titleId = `innsekai-modal-title-${++modalSeq}`;
  const modal = el("div", { class: `modal${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1" });
  if (title) modal.append(el("h3", { id: titleId }, title));
  if (sub) modal.append(el("div", { class: "m-sub" }, sub));
  if (body) modal.append(body);
  if (footer) modal.append(el("div", { class: "modal-footer" }, footer));
  backdrop.append(modal);
  root.append(backdrop);

  const previousFocus = document.activeElement;
  const focusables = () =>
    [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')]
      .filter((n) => !n.hidden && n.getAttribute("aria-hidden") !== "true");
  const announce = (msg) => {
    const r = document.getElementById("live-region");
    if (!r) return;
    r.textContent = "";
    requestAnimationFrame(() => { r.textContent = msg; });
  };

  const close = () => {
    document.removeEventListener("keydown", trapKey, true);
    document.removeEventListener("keydown", escKey);
    backdrop.remove();
    if (previousFocus && typeof previousFocus.focus === "function" && document.contains(previousFocus)) previousFocus.focus();
    onClose?.();
    announce(title ? `Fenêtre fermée : ${title}` : "Fenêtre fermée");
  };
  // stash the close handle so a route change can force-close leftover modals
  // (see closeAllModals) — otherwise an open modal keeps swallowing clicks
  // on the freshly rendered screen behind it
  backdrop._close = close;
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });

  // focus trap: capture-phase so it runs before app-level Tab handlers; only
  // the topmost backdrop traps (nested modals take over while they're open)
  function trapKey(e) {
    if (e.key !== "Tab" || backdrop !== root.lastElementChild) return;
    const list = focusables();
    if (!list.length) { e.preventDefault(); modal.focus(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !modal.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !modal.contains(active))) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", trapKey, true);

  // Escape closes only the topmost modal; the listener dies with the modal
  function escKey(e) {
    if (e.key === "Escape" && backdrop === root.lastElementChild) close();
  }
  document.addEventListener("keydown", escKey);

  // initial focus: an explicit autofocus field wins, else the first focusable
  setTimeout(() => {
    const auto = modal.querySelector("[autofocus]");
    const target = auto || focusables()[0] || modal;
    target.focus();
  }, 0);
  announce(title ? `Fenêtre ouverte : ${title}` : "Fenêtre ouverte");
  return { close, modal, backdrop };
}

/** Force-close every open modal (e.g. when switching screens): without this, a
 * modal left open on a previous view keeps its backdrop on top and silently
 * swallows clicks on the new screen. onClose hooks still fire. */
export function closeAllModals() {
  const root = document.getElementById("modal-root");
  if (!root) return;
  for (const backdrop of [...root.querySelectorAll(".modal-backdrop")]) {
    const close = backdrop._close;
    if (typeof close === "function") close();
    else backdrop.remove();
  }
}

export function confirmModal({ title, message, confirmLabel = "Supprimer", danger = true }) {
  return new Promise((resolve) => {
    // settle only once: the footer buttons win, but backdrop-click / Escape /
    // route change (all of which just call close()) must also resolve —
    // otherwise the awaiting caller hangs forever
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); };
    const { close } = openModal({
      title,
      body: el("p", { style: { lineHeight: "1.6", color: "var(--text-dim)" } }, message),
      footer: [
        el("button", { class: "btn btn-ghost", onclick: () => { finish(false); close(); } }, "Annuler"),
        el("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, onclick: () => { finish(true); close(); } }, confirmLabel),
      ],
      onClose: () => finish(false),
    });
  });
}

/* Floating-label field: the label lives inside the input and slides up when
 * the field is focused or filled. Selects always keep the label floated (they
 * always hold a value). */
export function field(labelText, value, opts = {}) {
  const wrap = el("label", { class: "fl-field" });
  let input;
  if (opts.type === "textarea") {
    input = el("textarea", { rows: opts.rows || 3, placeholder: opts.placeholder || " " }, value ?? "");
  } else if (opts.type === "select") {
    input = el("select", {});
    for (const [v, l] of opts.options || []) {
      input.append(el("option", { value: v, ...(String(v) === String(value) ? { selected: "" } : {}) }, l));
    }
  } else if (opts.type === "number") {
    input = el("input", { type: "number", value, placeholder: " ", ...(opts.min ? { min: opts.min } : {}), ...(opts.max ? { max: opts.max } : {}), ...(opts.step ? { step: opts.step } : {}) });
  } else {
    input = el("input", { value, placeholder: opts.placeholder || " ", ...(opts.type === "password" ? { type: "password" } : {}) });
  }
  if (opts.autofocus) setTimeout(() => input.focus(), 60);
  wrap.append(input, el("span", { class: "fl-label" }, labelText));
  return { wrap, input };
}

export function spinner() {
  return el("span", { class: "spin-ico" }, "⏳");
}

export const ICONS = {
  home: "🏠", worlds: "🌍", cards: "🎭", personas: "🧑‍🤝‍🧑", settings: "⚙️",
  plus: "＋", back: "←", send: "➤", play: "▶", stop: "⏹", retry: "↻", edit: "✎",
  trash: "🗑", image: "🖼", voice: "🔊", sparkles: "✨", group: "👥", solo: "🧍",
};
