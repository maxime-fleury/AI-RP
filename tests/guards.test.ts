import { describe, test, expect } from "bun:test";
import { loadApp, api } from "./helpers";

const { db, routes } = await loadApp();

const j = async (r: Response) => r.json();

describe("import batch atomicity", () => {
  test("over-limit batches are rejected whole — nothing is imported", async () => {
    // 101 files > the 100-file cap: the batch must 413 with ZERO writes (the
    // whole batch is validated before the first file is imported)
    const card = JSON.stringify({ data: { name: "Jamais", description: "" } });
    const b64 = Buffer.from(card).toString("base64");
    const files = Array.from({ length: 101 }, (_, i) => ({ name: `carte-${i}.json`, base64: b64 }));
    const before = db.listCards().map((c: any) => c.id).sort((a: number, b: number) => a - b);
    const res = await api(routes, "POST", "/api/import", { files });
    expect(res.status).toBe(413);
    // rejected whole: the card table is byte-for-byte unchanged (no partial batch)
    const after = db.listCards().map((c: any) => c.id).sort((a: number, b: number) => a - b);
    expect(after).toEqual(before);
  });

  test("per-file rejections don't poison the rest of the batch", async () => {
    // an over-5Mo JSON (reported invalid, excluded from the total) + a valid
    // card → the valid one still imports, nothing is partially written
    const big = Buffer.alloc(6 * 1024 * 1024, 0x41).toString("base64");
    const ok = JSON.stringify({ data: { name: "Rescapée", description: "OK" } });
    const res = await api(routes, "POST", "/api/import", {
      files: [
        { name: "trop-gros.json", base64: big },
        { name: "valide.json", base64: Buffer.from(ok).toString("base64") },
      ],
    });
    expect(res.status).toBe(200);
    const out = await j(res);
    expect(out.imported).toHaveLength(1);
    expect(out.imported[0].name).toBe("Rescapée");
    expect(out.report.find((r: any) => r.status === "invalid").reason).toContain("trop volumineux");
    // exactly one card exists
    expect(db.listCards().filter((c: any) => c.name === "Rescapée")).toHaveLength(1);
  });

  test("valid batches still import after the change", async () => {
    const card = JSON.stringify({ data: { name: "Atomique", description: "OK" } });
    const res = await api(routes, "POST", "/api/import", {
      files: [{ name: "a.json", base64: Buffer.from(card).toString("base64") }],
    });
    expect(res.status).toBe(200);
    const out = await j(res);
    expect(out.imported).toHaveLength(1);
    expect(out.imported[0].name).toBe("Atomique");
  });
});

describe("cross-conversation message guards", () => {
  const convA = db.createConversation({ title: "A" });
  const convB = db.createConversation({ title: "B" });
  const msgA = db.createMessage({ conversation_id: convA.id, role: "user", content: "AAAA", meta: JSON.stringify({ note: "x" }) });
  const msgB = db.createMessage({ conversation_id: convB.id, role: "user", content: "BBBB" });

  test("PATCH refuses a message that belongs to another conversation", async () => {
    const res = await api(routes, "PATCH", `/api/conversations/${convA.id}/messages/${msgB.id}`, { content: "HACK" });
    expect(res.status).toBe(404);
    expect(db.getMessage(msgB.id)?.content).toBe("BBBB");
    // same-conversation edits keep working
    const ok = await api(routes, "PATCH", `/api/conversations/${convA.id}/messages/${msgA.id}`, { content: "AAAA2" });
    expect(ok.status).toBe(200);
    expect(db.getMessage(msgA.id)?.content).toBe("AAAA2");
  });

  test("DELETE / reactions / image / bulk-delete refuse foreign ids", async () => {
    expect((await api(routes, "DELETE", `/api/conversations/${convA.id}/messages/${msgB.id}`)).status).toBe(404);
    expect(db.getMessage(msgB.id)).not.toBeNull();

    expect((await api(routes, "POST", `/api/conversations/${convA.id}/messages/${msgB.id}/reactions`, { emoji: "👍" })).status).toBe(404);
    expect(db.getMessage(msgB.id)?.meta).toBe("{}");

    // 404 before any image-server call is attempted
    expect((await api(routes, "POST", `/api/conversations/${convA.id}/messages/${msgB.id}/image`, { kind: "auto" })).status).toBe(404);

    const bulk = await api(routes, "POST", `/api/conversations/${convA.id}/messages/bulk-delete`, { ids: [msgB.id, msgA.id] });
    // msgB is not owned by A → filtered out before deleting; msgA IS owned
    expect(bulk.status).toBe(200);
    const out = await j(bulk);
    expect(out.removed).toBe(1);
    expect(db.getMessage(msgB.id)).not.toBeNull();
    expect(db.getMessage(msgA.id)).toBeNull();
  });
});

describe("stats & user-message edits", () => {
  const conv = db.createConversation({ title: "Stats" });
  db.createMessage({ conversation_id: conv.id, role: "user", content: "Salut" });
  db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Répond.*" });
  // display-only markers must not count as story messages / replies
  db.createMessage({ conversation_id: conv.id, role: "assistant", name: "", content: "📖 Chapitre 1 — Le départ\n\nRésumé.", meta: JSON.stringify({ chapter: true }) });

  test("stats ignore chapter/rewind markers", async () => {
    const res = await api(routes, "GET", `/api/conversations/${conv.id}/stats`);
    expect(res.status).toBe(200);
    const s = await j(res);
    expect(s.messages).toBe(2);
    expect(s.user_msgs).toBe(1);
    expect(s.assistant_msgs).toBe(1);
    expect(s.speakers.some((sp: any) => sp.name === "Narrateur")).toBe(true);
  });

  test("editing a user message drops the stale model-facing rewrite (meta.prompt/directive)", async () => {
    const u = db.createMessage({
      conversation_id: conv.id, role: "user", content: "/narrate original",
      meta: JSON.stringify({ prompt: "rewrite du slash", directive: "Directive." }),
    });
    const res = await api(routes, "PATCH", `/api/conversations/${conv.id}/messages/${u.id}`, { content: "nouveau texte" });
    expect(res.status).toBe(200);
    const view = await j(res);
    expect(view.content).toBe("nouveau texte");
    expect(view.meta.prompt).toBeUndefined();
    expect(view.meta.directive).toBeUndefined();
  });
});
