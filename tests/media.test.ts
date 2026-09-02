import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { dataDir, loadApp, api } from "./helpers";

const { db, routes } = await loadApp();

const IMG = path.join(dataDir, "images");
const UPL = path.join(dataDir, "uploads");

// NOTE: this box runs all test files against a shared data dir, so assertions
// must be scoped to rows/files this file created (never absolute counts), and
// restore payloads must be hand-built instead of restoring full /api/export
// snapshots (which would duplicate the other test files' data).

describe("JSON backup embeds referenced media (self-contained restores)", () => {
  test("export embeds every referenced illustration/avatar as base64", async () => {
    const world = db.createWorld({ name: "Monde couvert", cover: "/images/covers/hero.png" });
    db.createCard({ name: "Alba", avatar: "/uploads/avatars/alba.png" });
    const conv = db.createConversation({ title: "Ma partie", world_id: world.id });
    db.createMessage({
      conversation_id: conv.id, role: "assistant", name: "Alba",
      content: "Salut", segments: "[]",
      meta: JSON.stringify({ image: `/images/conversations/${conv.id}/scene-1.png` }),
    });

    // fake "PNG" bytes at the referenced locations (byte fidelity is all that
    // matters for the round-trip)
    const bytes = (tag: string) => new TextEncoder().encode(`fake-png-${tag}-${conv.id}`);
    const coverP = path.join(IMG, "covers", "hero.png");
    const avatarP = path.join(UPL, "avatars", "alba.png");
    const sceneP = path.join(IMG, "conversations", String(conv.id), "scene-1.png");
    for (const p of [coverP, avatarP, sceneP]) fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(coverP, bytes("cover"));
    fs.writeFileSync(avatarP, bytes("avatar"));
    fs.writeFileSync(sceneP, bytes("scene"));

    const backup = await (await api(routes, "GET", "/api/export")).json();
    const dec = (u: string) => Buffer.from(backup.media[u], "base64").toString("utf8");
    expect(backup.media).toBeDefined();
    expect(dec("/images/covers/hero.png")).toBe(`fake-png-cover-${conv.id}`);
    expect(dec("/uploads/avatars/alba.png")).toBe(`fake-png-avatar-${conv.id}`);
    expect(dec(`/images/conversations/${conv.id}/scene-1.png`)).toBe(`fake-png-scene-${conv.id}`);
    void world;
  });

  test("restore re-creates the files and remaps conversation-scoped URLs to the fresh ids", async () => {
    const world = db.createWorld({ name: "Monde média", cover: "/images/covers/hero2.png" });
    const conv = db.createConversation({ title: "Partie média", world_id: world.id });
    const sceneUrl = `/images/conversations/${conv.id}/scene-2.png`;
    db.createMessage({
      conversation_id: conv.id, role: "assistant", name: "Alba",
      content: "Salut", segments: "[]",
      meta: JSON.stringify({ image: sceneUrl, note: "gardée" }),
    });
    const sceneB64 = Buffer.from(`fake-scene-${conv.id}`).toString("base64");
    const coverB64 = Buffer.from(`fake-cover-${conv.id}`).toString("base64");
    const before = new Set(db.listConversations().map((c) => c.id));

    const res = await (await api(routes, "POST", "/api/backup", {
      backup: {
        worlds: [db.getWorld(world.id)],
        scenarios: [], cards: [], personas: [],
        conversations: [{
          id: conv.id, title: conv.title, world_id: conv.world_id,
          cast: "[]", settings: "{}", group_mode: 0,
          memory_json: "", summary: "", summary_msg_id: 0, pinned: 0, archived: 0,
          last_message: "",
          messages: db.listMessages(conv.id),
        }],
        timeline_events: [],
        media: { [sceneUrl]: sceneB64, "/images/covers/hero2.png": coverB64 },
      },
    })).json();
    expect(res.ok).toBe(true);
    expect(res.media).toBe(2);

    // one new conversation whose world is the restored copy of "Monde média"
    const restored = db.listConversations().find(
      (c) => !before.has(c.id) && db.getWorld(c.world_id ?? -1)?.name === "Monde média",
    );
    expect(restored).toBeDefined();
    const msg = db.listMessages(restored!.id).find((m) => m.role === "assistant")!;
    // the stored URL now points at the restored conversation's own directory
    const meta = JSON.parse(msg.meta) as { image: string; note: string };
    expect(meta.image).toBe(`/images/conversations/${restored!.id}/scene-2.png`);
    expect(meta.note).toBe("gardée");
    // …and the file really exists there with the exported bytes
    const back = fs.readFileSync(path.join(IMG, "conversations", String(restored!.id), "scene-2.png"));
    expect(back.toString("utf8")).toBe(`fake-scene-${conv.id}`);
    // world cover (no conversation scoping) is restored at its original path
    expect(fs.readFileSync(path.join(IMG, "covers", "hero2.png")).toString("utf8"))
      .toBe(`fake-cover-${conv.id}`);
  });

  test("legacy backups without embedded media still restore cleanly", async () => {
    const before = new Set(db.listConversations().map((c) => c.id));
    const res = await (await api(routes, "POST", "/api/backup", {
      backup: {
        app: "innsekai", worlds: [], scenarios: [], cards: [], personas: [],
        conversations: [{ title: "Héritage sans média" }],
        timeline_events: [],
      },
    })).json();
    expect(res.ok).toBe(true);
    expect(res.media).toBe(0);
    expect(db.listConversations().some((c) => !before.has(c.id) && c.title === "Héritage sans média"))
      .toBe(true);
  });
});
