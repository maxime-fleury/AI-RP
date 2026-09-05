import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import "./helpers"; // must set INNSEKAI_DATA_DIR before any src import
import { conversationSettingsOf, runMigrations, SCHEMA_VERSION } from "../src/server/db";

function legacyDb(): Database {
  const dir = mkdtempSync(path.join(tmpdir(), "innsekai-migr-"));
  const d = new Database(path.join(dir, "legacy.db"));
  // minimal v0 shapes: original column sets, BEFORE the migration columns
  d.exec(`CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'Nouvelle partie',
    world_id INTEGER, persona_id INTEGER, scenario_id INTEGER,
    cast TEXT NOT NULL DEFAULT '[]', group_mode INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '', last_message TEXT NOT NULL DEFAULT '',
    legacy_col TEXT NOT NULL DEFAULT 'keep-me',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
  for (const t of ["worlds", "scenarios", "cards", "personas"]) {
    d.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '');`);
  }
  d.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);`);
  return d;
}

function cols(d: Database, table: string): Set<string> {
  return new Set((d.query(`PRAGMA table_info(${table})`).all() as any[]).map((c: any) => c.name));
}

describe("schema migrations (PRAGMA user_version)", () => {
  test("runMigrations upgrades a v0 schema and stamps user_version", () => {
    const d = legacyDb();
    expect(cols(d, "conversations").has("summary")).toBe(false);
    expect((d.query("PRAGMA user_version").get() as any).user_version).toBe(0);
    runMigrations(d);
    // columns added by the v0→v1 step
    expect(cols(d, "conversations").has("summary")).toBe(true);
    expect(cols(d, "conversations").has("summary_msg_id")).toBe(true);
    expect(cols(d, "conversations").has("memory_json")).toBe(true);
    expect(cols(d, "conversations").has("pinned")).toBe(true);
    expect(cols(d, "conversations").has("archived")).toBe(true);
    expect(cols(d, "conversations").has("parent_id")).toBe(true);
    expect(cols(d, "conversations").has("branch_kind")).toBe(true);
    expect(cols(d, "worlds").has("map")).toBe(true);
    expect(cols(d, "cards").has("fingerprint")).toBe(true);
    expect(cols(d, "jobs").has("title")).toBe(true);
    expect(cols(d, "jobs").has("result")).toBe(true);
    for (const t of ["worlds", "scenarios", "cards", "personas"]) {
      expect(cols(d, t).has("trashed")).toBe(true);
    }
    // existing data is never dropped
    expect(cols(d, "conversations").has("legacy_col")).toBe(true);
    expect((d.query("PRAGMA user_version").get() as any).user_version).toBe(SCHEMA_VERSION);
    d.close();
  });

  test("runMigrations is a no-op on an up-to-date database", () => {
    const d = legacyDb();
    runMigrations(d);
    const v = (d.query("PRAGMA user_version").get() as any).user_version;
    // adding a sentinel column AFTER migration: a second run must not touch it
    d.exec("ALTER TABLE conversations ADD COLUMN sentinel INTEGER NOT NULL DEFAULT 0");
    runMigrations(d);
    expect((d.query("PRAGMA user_version").get() as any).user_version).toBe(v);
    expect(cols(d, "conversations").has("sentinel")).toBe(true);
    d.close();
  });
});

describe("conversationSettingsOf", () => {
  test("parses a row's settings blob into a mutable object", () => {
    const cs = conversationSettingsOf({ settings: '{"behavior":"reactif","scene_focus":"romance"}' });
    expect(cs.behavior).toBe("reactif");
    expect(cs.scene_focus).toBe("romance");
    cs.chapters = [];
    expect(conversationSettingsOf({ settings: JSON.stringify({ chapters: [] }) }).chapters).toEqual([]);
  });

  test("accepts a raw JSON string (prompt-layer call sites)", () => {
    expect(conversationSettingsOf('{"context_mode":"avance"}').context_mode).toBe("avance");
  });

  test("degrades to {} on corrupt/empty/missing blobs instead of throwing", () => {
    expect(conversationSettingsOf({ settings: "{not json" })).toEqual({});
    expect(conversationSettingsOf({ settings: null })).toEqual({});
    expect(conversationSettingsOf(null)).toEqual({});
    expect(conversationSettingsOf({})).toEqual({});
    expect(conversationSettingsOf({ settings: "[]" })).toEqual({});
  });
});
