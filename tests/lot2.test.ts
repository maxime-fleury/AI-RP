import { describe, test, expect } from "bun:test";
import { dataDir, loadApp, api } from "./helpers";
import fs from "node:fs";
import path from "node:path";

describe("features: storage / backup / context budget / img2img request", async () => {
  const { db, routes } = await loadApp();

  test("/api/storage reports sizes + backups; POST /api/backup creates one", async () => {
    const before = await api(routes, "GET", "/api/storage");
    expect(before.status).toBe(200);
    const b0 = await before.json();
    expect(typeof b0.audioMB).toBe("number");
    expect(Array.isArray(b0.backups)).toBe(true);

    const created = await api(routes, "POST", "/api/backup", {});
    expect(created.status).toBe(200);
    const c = await created.json();
    expect(c.ok).toBe(true);
    expect(c.file).toContain("app-");

    const after = await api(routes, "GET", "/api/storage");
    const a = await after.json();
    expect(a.backups.length).toBeGreaterThan(0);
  });

  test("context endpoint adds budget + world cap info", async () => {
    const world = db.createWorld({ name: "W", description: "" });
    db.updateWorld(world.id, { settings: JSON.stringify({ context_max_messages: 6 }) });
    const conv = db.createConversation({ title: "C", world_id: world.id });
    const m1 = db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Scène.*" });
    const m2 = db.createMessage({ conversation_id: conv.id, role: "user", content: "Bonjour" });
    db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Suite.*" });
    void m1; void m2;

    const res = await api(routes, "GET", `/api/conversations/${conv.id}/context`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toBeGreaterThan(0);
    expect(body.keptMessages).toBeLessThanOrEqual(6);
    expect(body.budget).toBeGreaterThanOrEqual(0);
    expect(body.capSource).toBe("monde"); // world cap (6) beats the 20 default
  });

  // (img2img is integration-tested live: the route spawns the real Python
  // sidecar, which would hang a unit test for minutes)
});