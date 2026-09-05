import { describe, test, expect, afterAll } from "bun:test";
import "./helpers";
import { db, createConversation, createMessage, getMessage } from "../src/server/db";
import { messageView, conversationView } from "../src/server/routes/core";

// isolated rows so count-sensitive suites elsewhere never see them
const conv = createConversation({ title: "contrat", settings: "{}", created_at: Date.now(), updated_at: Date.now() });
const msg = createMessage({ conversation_id: conv.id, role: "user", name: "Moi", content: "coucou" });
afterAll(() => {
  try { db.query("DELETE FROM messages WHERE id = ?").run(msg.id); } catch { /* ignore */ }
  try { db.query("DELETE FROM conversations WHERE id = ?").run(conv.id); } catch { /* ignore */ }
});

describe("wire contract (client/server)", () => {
  test("messageView keys are pinned", () => {
    const fresh = getMessage(msg.id)!;
    const view = messageView({ ...fresh });
    // TTS audio was removed from the wire; segments & meta arrive parsed
    expect(Object.keys(view).sort()).toEqual(
      ["conversation_id", "content", "created_at", "id", "meta", "name", "role", "segments"].sort(),
    );
    expect(Array.isArray(view.segments)).toBe(true);
    expect(typeof view.meta).toBe("object");
    expect("audio" in view).toBe(false);
  });

  test("conversationView keys are pinned", () => {
    const view = conversationView(conv.id)!;
    expect(view).not.toBeNull();
    const keys = Object.keys(view).sort();
    expect(keys).toEqual(
      [
        "archived", "branch_kind", "canon", "cards", "cast", "created_at", "group_mode", "id",
        "last_message", "memory", "parent_id", "persona", "persona_id",
        "pinned", "scenario", "scenario_id", "settings", "summary", "summary_msg_id",
        "title", "updated_at", "world", "world_id",
      ].sort(),
    );
    // the raw blob column never reaches the wire — only the parsed memory view
    expect(keys).not.toContain("memory_json");
  });

  test("messageView exposes segments as parsed arrays, meta as object", () => {
    const fresh = getMessage(msg.id)!;
    const view = messageView({ ...fresh });
    expect(Array.isArray(view.segments)).toBe(true);
    expect(typeof view.meta).toBe("object");
    expect("audio" in view).toBe(false);
  });
});
