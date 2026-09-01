// DOM + UI helpers
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// All rendering goes through `el()` which builds text nodes, so escaping is
// unnecessary (and would double-encode entities). Keep as an identity for safety.
export function esc(s) {
  return String(s ?? "");
}

export function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${time}`;
}

export function toast(msg, type = "ok", ms = 3800) {
  const root = document.getElementById("toasts");
  const t = el("div", { class: `toast ${type}` }, type === "err" ? "⚠️" : "✅", msg);
  root.append(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity .3s";
    setTimeout(() => t.remove(), 320);
  }, ms);
}

export function openModal({ title, sub, body, footer, wide = false, onClose }) {
  const root = document.getElementById("modal-root");
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: `modal${wide ? " wide" : ""}` });
  if (title) modal.append(el("h3", {}, title));
  if (sub) modal.append(el("div", { class: "m-sub" }, sub));
  if (body) modal.append(body);
  if (footer) modal.append(el("div", { class: "modal-footer" }, footer));
  backdrop.append(modal);
  root.append(backdrop);
  const close = () => {
    backdrop.remove();
    onClose?.();
  };
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", function escKey(e) {
    if (e.key === "Escape") { document.removeEventListener("keydown", escKey); close(); }
  });
  return { close, modal, backdrop };
}

export function confirmModal({ title, message, confirmLabel = "Supprimer", danger = true }) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title,
      body: el("p", { style: { lineHeight: "1.6", color: "var(--text-dim)" } }, message),
      footer: [
        el("button", { class: "btn btn-ghost", onclick: () => { close(); resolve(false); } }, "Annuler"),
        el("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, onclick: () => { close(); resolve(true); } }, confirmLabel),
      ],
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
