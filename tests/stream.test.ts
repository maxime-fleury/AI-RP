import { describe, test, expect, afterEach, afterAll } from "bun:test";
// helpers FIRST: sets INNSEKAI_DATA_DIR before src/server/db loads
import "./helpers";
import { loadApp, api, isolated, uid } from "./helpers";

const { db, routes } = await loadApp();
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const t = isolated(db);
afterAll(() => t.cleanup());

/** Mock the LM Studio endpoint: SSE deltas for stream:true, JSON otherwise. */
function mockLlm(deltas: string[]) {
  globalThis.fetch = (async (_url: any, opts: any) => {
    let stream = false;
    try {
      stream = JSON.parse(String(opts?.body || "{}")).stream === true;
    } catch { /* ignore */ }
    if (stream) {
      const chunks = deltas
        .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}`)
        .join("\n\n");
      return new Response(chunks + "\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    // suggestions / summaries / model lists see an empty answer
    return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function readSseAll(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^\s/, "");
      }
      let parsed: any = data;
      try {
        parsed = JSON.parse(data);
      } catch { /* raw text block */ }
      return { event, data: parsed };
    });
}

describe("chat streaming (handleStream)", () => {
  test("empty message → 400 and does NOT lock the conversation", async () => {
    const conv = t.conv({ title: uid("Vide") });
    const bad = await api(routes, "POST", `/api/conversations/${conv.id}/stream`, { content: "   " });
    expect(bad.status).toBe(400);
    // the lock must be released: a real turn works right after (this used to
    // 409 forever — permanent lock on corrupt/empty input)
    mockLlm(["oui"]);
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/stream`, { content: "Bonjour" });
    const events = await readSseAll(res);
    expect(events.some((e) => e.event === "done")).toBe(true);
  });

  test("a full turn streams deltas then commits user + assistant messages", async () => {
    const conv = t.conv({ title: uid("Tour") });
    mockLlm(["Hello", " world"]);
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/stream`, { content: "Salut" });
    const events = await readSseAll(res);
    const deltas = events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
    expect(deltas).toBe("Hello world");
    const done = events.find((e) => e.event === "done");
    expect(done?.data.message.content).toContain("Hello world");
    const msgs = db.listMessages(conv.id);
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toContain("Hello world");
    // lock released: a second turn streams fine
    mockLlm(["bis"]);
    const res2 = await api(routes, "POST", `/api/conversations/${conv.id}/stream`, { content: "Et après ?" });
    expect((await readSseAll(res2)).some((e) => e.event === "done")).toBe(true);
  });

  test("background suggestions do NOT hold the conversation lock (Phase 4)", async () => {
    const conv = t.conv({ title: uid("Decouple") });
    // non-stream calls (suggestions…) answer SLOWLY — under the old code the
    // awaited suggestions kept activeStreams locked and the next turn 409'd
    globalThis.fetch = (async (_url: any, opts: any) => {
      let stream = false;
      try {
        stream = JSON.parse(String(opts?.body || "{}")).stream === true;
      } catch { /* ignore */ }
      if (stream) {
        const chunks = `data: ${JSON.stringify({ choices: [{ delta: { content: "réponse" } }] })}\n\ndata: [DONE]\n\n`;
        return new Response(chunks, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      await new Promise((r) => setTimeout(r, 500)); // slow background work
      return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await api(routes, "POST", `/api/conversations/${conv.id}/stream`, { content: "Premier tour" });
    expect((await readSseAll(res)).some((e) => e.event === "done")).toBe(true);
    // the SSE stream already closed → a new turn is NOT 409-blocked, even
    // though the background suggestion call is still in flight
    const res2 = await api(routes, "POST", `/api/conversations/${conv.id}/stream`, { content: "Deuxième tour" });
    const events2 = await readSseAll(res2);
    expect(events2.some((e) => e.event === "done")).toBe(true);
    expect(events2.some((e) => e.event === "error")).toBe(false);
  });

  test("provider failure → error event, user turn rolled back, lock released", async () => {
    const conv = t.conv({ title: uid("Echec") });
    globalThis.fetch = (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/stream`, { content: "Salut" });
    const events = await readSseAll(res);
    expect(events.some((e) => e.event === "error")).toBe(true);
    // the pending user turn is removed so a retry starts clean (no duplicate)
    expect(db.listMessages(conv.id)).toHaveLength(0);
    // …and the next attempt is not stuck behind a 409
    mockLlm(["recovered"]);
    const res2 = await api(routes, "POST", `/api/conversations/${conv.id}/stream`, { content: "Salut" });
    expect((await readSseAll(res2)).some((e) => e.event === "done")).toBe(true);
  }, 15000);
});
