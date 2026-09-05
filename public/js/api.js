// @ts-check
// Tiny API helper

/**
 * Wire types imported straight from the server-side contract module — the
 * same source both sides compile against (no copied .d.ts to drift).
 * @typedef {import("../../src/shared/contracts.ts").MessageView} MessageView
 * @typedef {import("../../src/shared/contracts.ts").ConversationView} ConversationView
 * @typedef {import("../../src/shared/contracts.ts").SuggestionsResponse} SuggestionsResponse
 */

/**
 * Error carrying an HTTP status (thrown by api/apiForm on !ok responses).
 * @param {string} msg
 * @param {number} status
 * @returns {Error & { status?: number }}
 */
function httpError(msg, status) {
  const e = /** @type {Error & { status?: number }} */ (new Error(msg));
  e.status = status;
  return e;
}
//
// Type-checked against the shared wire contract (src/shared/contracts.ts) via
// JSDoc imports — the SAME declarations the server's view builders use, so a
// field rename/removal fails `bun run typecheck` on the client boundary too.
// Other JS files can join by adding @ts-check + fixing their (few) locals.
export function getToken() {
  try { return localStorage.getItem("innsekai-token") || ""; } catch { return ""; }
}
export function setToken(tok) {
  try {
    if (tok) localStorage.setItem("innsekai-token", tok);
    else localStorage.removeItem("innsekai-token");
  } catch { /* ignore */ }
}

export function authUrl(path) {
  const tok = getToken();
  if (!tok) return path;
  const u = new URL(path, location.href);
  u.searchParams.set("token", tok);
  return u.toString();
}

export async function api(path, opts = {}) {
  const res = await apiFetch(path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    ...opts.fetchOpts,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("innsekai-unauthorized"));
    throw httpError("Authentification requise — entre le token LAN (Réglages → Sécurité).", 401);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw httpError(msg, res.status);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  }
  return res;
}

export async function apiFetch(path, options = {}) {
  return fetch(authUrl(path), options);
}

export async function apiForm(path, formData) {
  const res = await apiFetch(path, { method: "POST", body: formData });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("innsekai-unauthorized"));
    throw httpError("Authentification requise — entre le token LAN.", 401);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return {};
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

// Read a SSE stream from a fetch response; calls onEvent(type, data)
export async function readSseStream(res, onEvent, onClose) {
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try { msg = (await res.text()) || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^\s/, "");
        }
        if (data) {
          // parse first, dispatch once: if onEvent itself throws (a handler
          // bug), that is NOT a JSON failure — re-calling it with {raw} would
          // double-process an already-handled event (e.g. a second "done")
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
          onEvent(event, parsed);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  onClose?.();
}

/**
 * Normalize an uploaded image to a PNG dataURL (browser-side, via canvas).
 * SillyTavern cards MUST be PNG to carry the chara chunk — a JPEG/WEBP avatar
 * would otherwise export as a placeholder and lose its cover art. Returns the
 * PNG dataURL, or the original dataURL when conversion is impossible (old
 * browsers, corrupt file): the server still accepts jpeg/webp uploads.
 */
export async function fileToPngDataUrl(file, maxSide = 1024) {
  const readOriginal = () => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("read"));
    fr.readAsDataURL(file);
  });
  if (file.type === "image/png") return readOriginal();
  try {
    const bitmap = await (typeof createImageBitmap === "function"
      ? createImageBitmap(file)
      : (() => { throw new Error("no-bitmap"); })());
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no-ctx");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (typeof bitmap.close === "function") bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("to-blob");
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error("read"));
      fr.readAsDataURL(blob);
    });
  } catch {
    return readOriginal(); // graceful fallback: server keeps accepting jpeg/webp
  }
}

export function uploadFiles(files) {
  // files: FileList → [{name, base64, skipped?}]
  if (!files || typeof files.length !== "number") return Promise.resolve([]);
  const tasks = Array.from(files).map((f) =>
    new Promise((resolve) => {
      if (f.size > 50 * 1024 * 1024) {
        resolve({ name: f.name, base64: "", skipped: `Fichier trop volumineux (>50 Mo) : ${f.name}` });
        return;
      }
      const fr = new FileReader();
      fr.onload = () => resolve({ name: f.name, base64: String(fr.result).split(",")[1] || "" });
      fr.onerror = () => resolve({ name: f.name, base64: "", skipped: `Lecture impossible : ${f.name}` });
      fr.readAsDataURL(f);
    }),
  );
  return Promise.all(tasks);
}