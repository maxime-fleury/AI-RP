import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { dataDir, loadApp, api } from "./helpers";

const { db, routes } = await loadApp();
const { runBackup } = await import("../src/server/backup");

describe("JSON backup / restore fidelity", () => {
  test("restore keeps memory, flags, timestamps and never double-encodes meta/segments", async () => {
    const world = db.createWorld({ name: "Monde", settings: JSON.stringify({ negative: "x" }) });
    const created = db.createConversation({ title: "Ma partie", world_id: world.id });
    db.createMessage({
      conversation_id: created.id, role: "user", content: "J'ouvre la porte.",
      meta: JSON.stringify({ note: "privée" }),
    });
    const aiMsg = db.createMessage({
      conversation_id: created.id, role: "assistant", name: "Alba",
      content: '*Alba sourit.* Alba: "Bienvenue."',
      segments: JSON.stringify([
        { type: "narration", speaker: "", text: "Alba sourit." },
        { type: "dialogue", speaker: "Alba", text: "Bienvenue." },
      ]),
      meta: JSON.stringify({ bookmark: 1, reactions: ["👍"] }),
    });
    // re-read AFTER the writes: createX returned stale snapshots
    const conv = db.getConversation(created.id)!;
    db.updateConversation(conv.id, {
      memory_json: JSON.stringify({ location: "Café", facts: ["la clé"] }),
      summary: "résumé ancien",
      pinned: 1,
      archived: 0,
      last_message: "dernier message",
    });
    const userMsg = db.listMessages(conv.id)[0];
    db.updateConversation(conv.id, { summary_msg_id: userMsg.id });
    const before = db.getConversation(conv.id)!;

    const backup = await (await api(routes, "GET", "/api/export")).json();
    const restore = await (await api(routes, "POST", "/api/backup", { backup })).json();
    expect(restore.ok).toBe(true);

    const restored = db.listConversations().find((c) => c.id !== conv.id)!;
    expect(restored).toBeDefined();
    // conversation-level state survives the round-trip
    expect(restored.title).toBe(before.title);
    // world_id is remapped to the freshly-created copy of the world
    expect(db.getWorld(restored.world_id!)?.name).toBe("Monde");
    expect(restored.memory_json).toBe(before.memory_json);
    expect(restored.summary).toBe("résumé ancien");
    expect(restored.pinned).toBe(1);
    expect(restored.last_message).toBe("dernier message");
    expect(restored.created_at).toBe(before.created_at);
    expect(restored.updated_at).toBe(before.updated_at);

    const msgs = db.listMessages(restored.id);
    expect(msgs).toHaveLength(2);
    // segments/meta are JSON objects — restoring must not store them twice
    for (const m of msgs) {
      expect(typeof m.segments).toBe("string");
      const segs = JSON.parse(m.segments);
      expect(typeof segs).not.toBe("string");
      expect(typeof JSON.parse(m.meta)).toBe("object");
    }
    const restoredAi = msgs.find((m) => m.role === "assistant")!;
    expect(JSON.parse(restoredAi.segments)).toEqual(JSON.parse(aiMsg.segments));
    expect(JSON.parse(restoredAi.meta)).toEqual(JSON.parse(aiMsg.meta));
    expect(restoredAi.created_at).toBe(aiMsg.created_at);
    const restoredUser = msgs.find((m) => m.role === "user")!;
    expect(JSON.parse(restoredUser.meta)).toEqual({ note: "privée" });
    // the summary high-water mark is remapped to the restored message id
    expect(restored.summary_msg_id).toBe(restoredUser.id);
  });

  test("forced backups write distinct files instead of overwriting the day snapshot", async () => {
    const a = runBackup(true);
    const b = runBackup(true);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(fs.existsSync(a!)).toBe(true);
    expect(fs.existsSync(b!)).toBe(true);
    expect(fs.existsSync(a! + ".sha256")).toBe(true);
    // both live inside the per-test data dir
    const backupsDir = path.join(dataDir, "backups");
    expect(a!.startsWith(backupsDir + path.sep)).toBe(true);
    expect(b!.startsWith(backupsDir + path.sep)).toBe(true);
  });
});
