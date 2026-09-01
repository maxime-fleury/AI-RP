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
    expect(typeof b0.imagesMB).toBe("number");
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
describe("narrator presets", async () => {
  const { db, prompt } = await loadApp();

  test("built-ins resolve; overrides + custom keys win", () => {
    // default: 6 built-ins
    const defs = prompt.narratorPresets();
    expect(Object.keys(defs).length).toBe(6);
    expect(defs.nagatoro.custom).toBe(false);

    // override a built-in prompt + add a custom key
    db.setSetting("narrator_presets", {
      epique: { label: "Épique", prompt: "Prompt modifié par l'utilisateur." },
      sombre: { label: "Sombre", prompt: "Tout est gris et lourd." },
    });
    const merged = prompt.narratorPresets();
    expect(merged.epique.prompt).toBe("Prompt modifié par l'utilisateur.");
    expect(merged.epique.custom).toBe(false); // still a built-in → resettable
    expect(merged.sombre.custom).toBe(true);
    expect(merged.neutre.prompt.length).toBeGreaterThan(0); // unaffected
  });

  test("system prompt embeds the active preset text", () => {
    db.setSetting("narrator_style", "sombre");
    const conv = db.createConversation({ title: "C" });
    const sys = prompt.buildSystemPrompt({ world: null, persona: null, cards: [], scenario: null, conversation: conv });
    expect(sys).toContain("Tout est gris et lourd.");
  });
});
