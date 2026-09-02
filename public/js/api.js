// Tiny API helper
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
    const err = new Error("Authentification requise — entre le token LAN (Réglages → Sécurité).");
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res;
}

export async function apiFetch(path, options = {}) {
  return fetch(authUrl(path), options);
}

export async function apiForm(path, formData) {
  const res = await apiFetch(path, { method: "POST", body: formData });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("innsekai-unauthorized"));
    throw new Error("Authentification requise — entre le token LAN.");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
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
          else if (line.startsWith("data:")) data += line.slice(5).trim();
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

export function uploadFiles(files) {
  // files: FileList → [{name, base64}]
  const tasks = Array.from(files).map((f) =>
    new Promise((resolve) => {
      if (f.size > 50 * 1024 * 1024) {
        resolve({ name: f.name, base64: "" });
        return;
      }
      const fr = new FileReader();
      fr.onload = () => resolve({ name: f.name, base64: String(fr.result).split(",")[1] });
      fr.onerror = () => resolve({ name: f.name, base64: "" });
      fr.readAsDataURL(f);
    }),
  );
  return Promise.all(tasks);
}