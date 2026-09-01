// Tiny API helper
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    ...opts.fetchOpts,
  });
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

export async function apiForm(path, formData) {
  const res = await fetch(path, { method: "POST", body: formData });
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
          try { onEvent(event, JSON.parse(data)); } catch { onEvent(event, { raw: data }); }
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
      const fr = new FileReader();
      fr.onload = () => resolve({ name: f.name, base64: String(fr.result).split(",")[1] });
      fr.onerror = () => resolve({ name: f.name, base64: "" });
      fr.readAsDataURL(f);
    }),
  );
  return Promise.all(tasks);
}