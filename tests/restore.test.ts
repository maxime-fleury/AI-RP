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

  test("restore keeps world locations, lorebook and relations with remapped world ids", async () => {
    const world = db.createWorld({ name: "Monde plein" });
    db.createLocation({ world_id: world.id, name: "La Taverne", description: "Fumée", x: 10, y: 20 });
    db.createLorebookEntry({ world_id: world.id, name: "Guildes", triggers: "guilde", content: "Deux guildes rivales.", priority: 2, enabled: 1 });
    db.createRelation({ world_id: world.id, from_name: "Alba", to_name: "Rin", kind: "alliées" });

    const backup = await (await api(routes, "GET", "/api/export")).json();
    expect(backup.locations.length).toBe(1);
    expect(backup.lorebook.length).toBe(1);
    expect(backup.relations.length).toBe(1);

    const restore = await (await api(routes, "POST", "/api/backup", { backup })).json();
    expect(restore.ok).toBe(true);
    expect(restore.locations).toBe(1);
    expect(restore.lorebook).toBe(1);
    expect(restore.relations).toBe(1);

    // the world got recreated with a fresh id — its sub-resources must follow
    const restoredWorlds = db.listWorlds().filter((w) => w.id !== world.id);
    const restoredWorld = restoredWorlds.find((w) => w.name === "Monde plein")!;
    expect(restoredWorld).toBeDefined();
    expect(db.listLocations(restoredWorld.id).map((l) => l.name)).toEqual(["La Taverne"]);
    expect(db.listLorebook(restoredWorld.id).map((l) => l.name)).toEqual(["Guildes"]);
    expect(db.listRelations(restoredWorld.id).map((r) => r.kind)).toEqual(["alliées"]);
  });

  test("backup preview reports counts/checksum; selective restore keeps only chosen types", async () => {
    // hermetic payload — never derived from the (shared) live DB
    const backup = {
      app: "innsekai", version: 1, exported_at: new Date().toISOString(),
      worlds: [{ name: "Preview Monde", description: "", lore: "", tone: "épique", narration_style: "", language: "", cover: "", settings: "{}" }],
      cards: [{ name: "Preview Carte", description: "", personality: "", scenario: "", first_mes: "", mes_example: "", system_prompt: "", post_history_instructions: "", alternate_greetings: "[]", tags: "[]", creator: "", avatar: "", voice: "", language: "", data: "{}", fingerprint: "" }],
      personas: [], scenarios: [], locations: [], lorebook: [], relations: [], timeline_events: [],
      conversations: [{ title: "Preview Partie", world_id: null, persona_id: null, scenario_id: null, cast: [], group_mode: 0, pinned: 0, archived: 0, settings: "{}", messages: [{ role: "user", name: "", content: "Salut", segments: [], meta: {} }] }],
      media: {},
    };
    const prev = await (await api(routes, "POST", "/api/backup/preview", { backup })).json();
    expect(prev.preview.valid).toBe(true);
    expect(prev.preview.counts.worlds).toBe(1);
    expect(prev.preview.counts.cards).toBe(1);
    expect(prev.preview.counts.conversations).toBe(1);
    expect(typeof prev.checksum).toBe("string");
    expect(prev.checksum.length).toBe(64);
    expect(prev.preview.names.worlds).toContain("Preview Monde");

    // selective: worlds ONLY (no cards / conversations) — append policy
    const beforeWorlds = db.listWorlds().length;
    const beforeCards = db.listCards().length;
    const sel = await (await api(routes, "POST", "/api/backup/restore", {
      backup, conflict: "append", include: { worlds: true, cards: false, conversations: false, scenarios: false, personas: false, locations: true, lorebook: true, relations: true, timeline: true, media: true },
    })).json();
    expect(sel.ok).toBe(true);
    expect(sel.worlds).toBe(1);
    expect(sel.cards).toBe(0);
    expect(sel.conversations).toBe(0);
    expect(db.listWorlds().length).toBe(beforeWorlds + 1);
    expect(db.listCards().length).toBe(beforeCards); // no cards restored
    // conversation count untouched too
    expect(db.listConversations().some((c: any) => c.title === "Preview Partie")).toBe(false);
  });

  test("replace policy moves current data to the trash before restoring", async () => {
    const world = db.createWorld({ name: "À remplacer" });
    const backup = {
      app: "innsekai", version: 1,
      worlds: [{ name: "Nouveau monde", description: "", lore: "", tone: "", narration_style: "", language: "", cover: "", settings: "{}" }],
      cards: [], personas: [], scenarios: [], locations: [], lorebook: [], relations: [], timeline_events: [], conversations: [], media: {},
    };
    const res = await (await api(routes, "POST", "/api/backup/restore", {
      backup, conflict: "replace", include: { worlds: true },
    })).json();
    expect(res.ok).toBe(true);
    expect(res.conflict).toBe("replace");
    expect(res.replaced.worlds).toBeGreaterThanOrEqual(1);
    // the old world is trashed (still in the DB, hidden from lists)
    expect(db.getWorld(world.id)?.trashed).toBe(1);
    expect(db.listWorlds().find((w) => w.name === "Nouveau monde")).toBeDefined();
    // cleanup: un-trash everything so sibling test files (shared process) see
    // a clean trash list — this test deliberately replaces the whole DB
    for (const r of db.listTrashedResources()) db.restoreTrashed(r.type, r.id);
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
