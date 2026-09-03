/**
 * Shared HTTP plumbing for the API routers: typed JSON responses, request
 * body parsing, the SSE stream helper and standardized error responses with
 * stable machine-readable codes (see validate.ts for the code list).
 */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "INTERNAL",
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const MAX_JSON_BYTES = 60 * 1024 * 1024;

async function readTextLimited(req: Request): Promise<string> {
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) {
    throw new HttpError(413, "Corps de requête trop volumineux", "TOO_LONG");
  }
  return text;
}

export async function readJson(req: Request): Promise<any> {
  const text = await readTextLimited(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON invalide", "INVALID_JSON");
  }
}

/** Read a request body as raw text + parsed JSON (checksum flows need the raw bytes). */
export async function readJsonRaw(req: Request): Promise<{ raw: string; body: any }> {
  const raw = await readTextLimited(req);
  let body: any = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "JSON invalide", "INVALID_JSON");
    }
  }
  return { raw, body };
}

/**
 * Standardized error payload: `{ error: <human message>, code: <machine code> }`.
 * The legacy `error` field is preserved as a plain string (tests + older
 * clients rely on it); `code` carries the stable, documented machine code.
 */
export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    return json({ error: e.message, code: e.code }, e.status);
  }
  console.error("[api] internal error:", e instanceof Error ? (e.stack || e.message) : e);
  return json({ error: "Erreur interne", code: "INTERNAL" }, 500);
}

export function sseStream(
  onStart: (send: (event: string, data: unknown) => void, close: () => void) => Promise<void>,
  onCancel?: () => void,
): Response {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      controller = null;
      onCancel?.();
    },
  });
  const send = (event: string, data: unknown) => {
    if (!controller) return;
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      /* closed */
    }
  };
  const close = () => {
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
    controller = null;
  };
  onStart(send, close).catch((e) => {
    send("error", { message: String(e) });
    close();
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}