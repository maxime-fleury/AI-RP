import { describe, test, expect } from "bun:test";
import { dataDir, loadApp, api } from "./helpers";

describe("features: auth / context / gallery / map / reactions / exports", async () => {
  const { db, routes } = await loadApp();

  test("LAN token: API is locked without it, open with it", async () => {
    db.setSetting("auth_token", "secret");
    try {
      const locked = await api(routes, "GET", "/api/worlds");
      expect(locked.status).toBe(401);

      const ok = await api(routes, "GET", "/api/worlds?token=secret");
      expect(ok.status).toBe(200);

      const bad = await api(routes, "POST", "/api/auth", { token: "wrong" });
      expect(bad.status).toBe(401);

      const good = await api(routes, "POST", "/api/auth", { token: "secret" });
      expect(good.status).toBe(200);

      // /api/auth itself is always reachable (to know a token is required)
      const probe = await api(routes, "GET", "/api/auth");
      expect(probe.status).toBe(200);
      const body = await probe.json();
      expect(body.required).toBe(true);
      expect(body.ok).toBe(false);
    } finally {
      db.setSetting("auth_token", "");
    }
  });

  test("context estimate returns tokens + message count", async () => {
    const conv = db.createConversation({ title: "Ctx" });
    db.createMessage({ conversation_id: conv.id, role: "user", content: "Bonjour" });
    db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Le vent souffle.*" });
    const res = await api(routes, "GET", `/api/conversations/${conv.id}/context`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messageCount).toBe(2);
    expect(body.tokens).toBeGreaterThan(0);
    expect(body.systemTokens).toBeGreaterThan(0);
  });

  test("gallery lists illustrations and stores AI captions", async () => {
    const conv = db.createConversation({ title: "Galerie" });
    db.createMessage({
      conversation_id: conv.id, role: "assistant", name: "Alba", content: "*Elle sourit.*",
      meta: JSON.stringify({ image: "/images/conversations/1/x.png", seed: 42, character: "Alba" }),
    });
    const res = await api(routes, "GET", `/api/conversations/${conv.id}/gallery`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].character).toBe("Alba");
    // no captions yet → {} ; generating with no images returns {}
    const cap = await api(routes, "POST", `/api/conversations/${conv.id}/gallery/captions`, {});
    expect(cap.status).toBe(200);
    const capBody = await cap.json();
    expect(capBody.captions).toEqual({});
  });

  test("world map returns the generated map + cited places", async () => {
    const world = db.createWorld({ name: "Eldoria", description: "Royaume" });
    const conv = db.createConversation({ title: "P", world_id: world.id });
    db.createMessage({
      conversation_id: conv.id, role: "assistant", name: "Narrateur",
      content: "*Ils traversent la Forêt d'Émeraude puis atteignent le Mont Noir.*",
    });
    const res = await api(routes, "GET", `/api/worlds/${world.id}/map`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map).toBeNull();
    expect(body.locations.length).toBeGreaterThan(0);
    expect(body.locations.join(" ")).toContain("Forêt");
  });

  test("emoji reactions toggle on a message", async () => {
    const conv = db.createConversation({ title: "Réactions" });
    const m = db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Salut.*" });
    const add = await api(routes, "POST", `/api/conversations/${conv.id}/messages/${m.id}/reactions`, { emoji: "👍" });
    expect(add.status).toBe(200);
    const added = await add.json();
    expect(added.meta.reactions).toContain("👍");
    const del = await api(routes, "DELETE", `/api/conversations/${conv.id}/messages/${m.id}/reactions`, { emoji: "👍" });
    expect(del.status).toBe(200);
    const removed = await del.json();
    expect(removed.meta.reactions).not.toContain("👍");
  });

  test("pinned flag persists through PATCH", async () => {
    const conv = db.createConversation({ title: "Pin" });
    const res = await api(routes, "PATCH", `/api/conversations/${conv.id}`, { pinned: true });
    expect(res.status).toBe(200);
    expect(db.getConversation(conv.id)?.pinned).toBe(1);
  });

  test("SillyTavern card export is a real PNG with a chara chunk", async () => {
    const card = db.createCard({ name: "Lyra", description: "Chanteuse", first_mes: "Salut !" });
    const res = await api(routes, "GET", `/api/cards/${card.id}/export-st`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    // PNG magic
    expect([...buf.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // chara tEXt chunk present (keyword plain, payload base64 JSON)
    const text = new TextDecoder().decode(buf);
    const keyIdx = text.indexOf("chara");
    expect(keyIdx).toBeGreaterThan(-1);
    const payload = text.slice(keyIdx + "chara".length + 1, text.indexOf("IEND"));
    const chara = JSON.parse(Buffer.from(payload, "base64").toString());
    expect(chara.data.name).toBe("Lyra");
    expect(chara.data.first_mes).toBe("Salut !");
    expect(chara.spec).toBe("chara_card_v2");
  });

  test("world export is a valid ZIP", async () => {
    const world = db.createWorld({ name: "Eldoria", description: "Royaume" });
    db.createScenario({ world_id: world.id, name: "L'invocation", intro: "*Tu t'éveilles.*" });
    const conv = db.createConversation({ title: "Partie 1", world_id: world.id });
    db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Début.*" });
    const res = await api(routes, "GET", `/api/worlds/${world.id}/export`);
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    // ZIP local-file magic
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });

  test("isolated data dir is used", () => {
    expect(dataDir).not.toContain("data");
  });
});
