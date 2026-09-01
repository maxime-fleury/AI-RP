import { describe, test, expect } from "bun:test";
import { dataDir, loadApp, api } from "./helpers";

// ─── routing: each :id route must NOT match its sub-routes ────────────────────
// Regression test for the bug where DELETE /api/conversations/1/messages/20 was
// matched by the DELETE /api/conversations/:id handler and wiped the whole
// conversation.
describe("routing", async () => {
  const { db, routes } = await loadApp();

  test("DELETE conversation/:id does not match /messages/:mid", async () => {
    const conv = db.createConversation({ title: "Test" });
    const m1 = db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Début.*" });
    const m2 = db.createMessage({ conversation_id: conv.id, role: "user", content: "Bonjour" });

    const res = await api(routes, "DELETE", `/api/conversations/${conv.id}/messages/${m2.id}`);
    expect(res.status).toBe(200);

    // conversation intact, only message m2 removed
    expect(db.getConversation(conv.id)).not.toBeNull();
    const remaining = db.listMessages(conv.id).map((m) => m.id);
    expect(remaining).toContain(m1.id);
    expect(remaining).not.toContain(m2.id);
  });

  test("POST /scenarios/:id/generate reaches the handler (not a 404)", async () => {
    // regression: the route read parts[3] (= "generate") as the id, so
    // getScenario(NaN) returned a 404 for every valid scenario
    const world = db.createWorld({ name: "Eldoria", description: "Royaume elfique" });
    const s = db.createScenario({ world_id: world.id, name: "L'invocation", intro: "" });
    const res = await api(routes, "POST", `/api/scenarios/${s.id}/generate`, { genre: "mystere" });
    // no LLM in tests → connection failure surfaces as a 500 with a real error,
    // never as the route-miss 404
    expect(res.status).not.toBe(404);
    const text = await res.text();
    expect(text).not.toContain('"not found"');
  });

  test("POST /worlds/:id/scenarios/generate matches and validates the world", async () => {
    // missing world → 404 (correct), proving the route matched and read parts[2]
    const res = await api(routes, "POST", "/api/worlds/999999/scenarios/generate", { genre: "romance" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('"not found"');
  });

  test("POST /conversations/:id/fork copies messages strictly before the given id", async () => {
    const conv = db.createConversation({ title: "Origine" });
    const m1 = db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Début.*" });
    const m2 = db.createMessage({ conversation_id: conv.id, role: "user", content: "Bonjour" });
    const m3 = db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Alba", content: "Alba: \"Salut.\"" });

    // fork everything before the user turn (the caller replays it itself)
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/fork`, { upToMessageId: m2.id });
    expect(res.status).toBe(201);
    const fork = await res.json();
    expect(fork.title).toBe("Origine · variante");
    const copied = fork.messages.map((m: any) => m.content);
    expect(copied).toEqual(["*Début.*"]); // m2 and m3 are NOT copied
    expect(copied).not.toContain("Bonjour");
    expect(copied).not.toContain("Salut.");
    // the original is untouched
    expect(db.listMessages(conv.id)).toHaveLength(3);
  });

  test("GET /worlds/:id does not match /worlds/:id/scenarios", async () => {
    const world = db.createWorld({ name: "Eldoria", description: "Royaume elfique" });
    const s = db.createScenario({ world_id: world.id, name: "L'invocation" });

    const res = await api(routes, "GET", `/api/worlds/${world.id}/scenarios`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    // an array of scenarios (world-shaped rows have cover; scenarios don't)
    expect(Array.isArray(j.scenarios)).toBe(true);
    expect(j.scenarios).toHaveLength(1);
    expect(j.scenarios[0].name).toBe("L'invocation");
    expect(j.scenarios[0].world_id).toBe(world.id);
    expect(j.scenarios[0].cover).toBeUndefined();
    expect(s.id).toBe(j.scenarios[0].id);
  });

  test("PATCH /conversations/:id does not match the messages route", async () => {
    const conv = db.createConversation({ title: "Avant" });
    const m = db.createMessage({ conversation_id: conv.id, role: "assistant", content: "*Scène.*" });

    const res = await api(routes, "PATCH", `/api/conversations/${conv.id}/messages/${m.id}`, { content: "*Scène modifiée.*" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.content).toBe("*Scène modifiée.*");
    // the conversation itself must be untouched by the message PATCH
    expect(db.getConversation(conv.id)!.title).toBe("Avant");
  });

  test("unknown deep routes 404 (image/tts sub-resources don't hit root handlers)", async () => {
    const conv = db.createConversation({ title: "X" });
    const m = db.createMessage({ conversation_id: conv.id, role: "assistant", content: "*Ok.*" });
    const res = await api(routes, "GET", `/api/conversations/${conv.id}/messages/${m.id}/tts`);
    expect(res.status).toBe(404);
  });

  test("delete conversation archives it (trash), permanent removes it", async () => {
    const conv = db.createConversation({ title: "À supprimer" });
    const res = await api(routes, "DELETE", `/api/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    expect(db.getConversation(conv.id)?.archived).toBe(1);
    // restore via PATCH archived:0
    const restore = await api(routes, "PATCH", `/api/conversations/${conv.id}`, { archived: false });
    expect(restore.status).toBe(200);
    expect(db.getConversation(conv.id)?.archived).toBe(0);
    // permanent delete
    const perm = await api(routes, "DELETE", `/api/conversations/${conv.id}/permanent`);
    expect(perm.status).toBe(200);
    expect(db.getConversation(conv.id)).toBeNull();
  });

  test("isolated data dir is used", () => {
    expect(dataDir).not.toContain("data");
  });
});