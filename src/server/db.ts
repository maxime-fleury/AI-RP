import { Database } from "bun:sqlite";
import fs from "node:fs";
import { DB_PATH, DATA_DIR, AUDIO_DIR, IMAGES_DIR, UPLOADS_DIR } from "./paths";

for (const d of [DATA_DIR, AUDIO_DIR, IMAGES_DIR, UPLOADS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS worlds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lore TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'épique',
  narration_style TEXT NOT NULL DEFAULT 'immersive et cinématique',
  language TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  map TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT '',
  first_mes TEXT NOT NULL DEFAULT '',
  mes_example TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  post_history_instructions TEXT NOT NULL DEFAULT '',
  alternate_greetings TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  creator TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Nouvelle partie',
  world_id INTEGER REFERENCES worlds(id) ON DELETE SET NULL,
  persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  scenario_id INTEGER REFERENCES scenarios(id) ON DELETE SET NULL,
  cast TEXT NOT NULL DEFAULT '[]',
  group_mode INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  last_message TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  summary_msg_id INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  segments TEXT NOT NULL DEFAULT '[]',
  audio TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
`);

// migrations for pre-existing databases (columns added later)
{
  const convCols = new Set((db.query("PRAGMA table_info(conversations)").all() as any[]).map((c) => c.name));
  if (!convCols.has("summary")) db.exec("ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
  if (!convCols.has("summary_msg_id")) db.exec("ALTER TABLE conversations ADD COLUMN summary_msg_id INTEGER NOT NULL DEFAULT 0");
  if (!convCols.has("pinned")) db.exec("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!convCols.has("archived")) db.exec("ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  const worldCols = new Set((db.query("PRAGMA table_info(worlds)").all() as any[]).map((c: any) => c.name));
  if (!worldCols.has("map")) db.exec("ALTER TABLE worlds ADD COLUMN map TEXT NOT NULL DEFAULT ''");
}

const now = () => Date.now();

// ─── settings ─────────────────────────────────────────────────────────────────
export function getSetting<T = string>(key: string, fallback?: T): T {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return fallback as T;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as T;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

export function allSettings(): Record<string, unknown> {
  const rows = db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

// ─── worlds ───────────────────────────────────────────────────────────────────
export interface WorldRow {
  id: number; name: string; description: string; lore: string; tone: string;
  narration_style: string; language: string; cover: string; settings: string; map: string; created_at: number;
}

export function listWorlds(): WorldRow[] {
  return db.query("SELECT * FROM worlds ORDER BY created_at DESC").all() as WorldRow[];
}

export function getWorld(id: number): WorldRow | null {
  return db.query("SELECT * FROM worlds WHERE id = ?").get(id) as WorldRow | null;
}

export function createWorld(w: Partial<WorldRow>): WorldRow {
  const r = db.query(
    `INSERT INTO worlds (name, description, lore, tone, narration_style, language, cover, settings, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    w.name ?? "Monde sans nom", w.description ?? "", w.lore ?? "", w.tone ?? "épique",
    w.narration_style ?? "immersive et cinématique", w.language ?? "", w.cover ?? "", w.settings ?? "{}", now(),
  );
  return getWorld(Number(r.lastInsertRowid))!;
}

export function updateWorld(id: number, w: Partial<WorldRow>): WorldRow | null {
  const cur = getWorld(id);
  if (!cur) return null;
  const merged = { ...cur, ...w, id };
  db.query(
    `UPDATE worlds SET name=?, description=?, lore=?, tone=?, narration_style=?, language=?, cover=?, settings=?, map=? WHERE id=?`,
  ).run(
    merged.name, merged.description, merged.lore, merged.tone, merged.narration_style,
    merged.language, merged.cover, merged.settings, merged.map, id,
  );
  return getWorld(id);
}

export function deleteWorld(id: number): void {
  db.query("DELETE FROM worlds WHERE id = ?").run(id);
}

// ─── scenarios ────────────────────────────────────────────────────────────────
export interface ScenarioRow {
  id: number; world_id: number; name: string; intro: string; notes: string; created_at: number;
}

export function listScenarios(worldId?: number): ScenarioRow[] {
  if (worldId) return db.query("SELECT * FROM scenarios WHERE world_id = ? ORDER BY created_at").all(worldId) as ScenarioRow[];
  return db.query("SELECT * FROM scenarios ORDER BY created_at").all() as ScenarioRow[];
}

export function getScenario(id: number): ScenarioRow | null {
  return db.query("SELECT * FROM scenarios WHERE id = ?").get(id) as ScenarioRow | null;
}

export function createScenario(s: Partial<ScenarioRow>): ScenarioRow {
  const r = db.query(
    "INSERT INTO scenarios (world_id, name, intro, notes, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(s.world_id ?? 0, s.name ?? "Scénario", s.intro ?? "", s.notes ?? "", now());
  return getScenario(Number(r.lastInsertRowid))!;
}

export function updateScenario(id: number, s: Partial<ScenarioRow>): ScenarioRow | null {
  const cur = getScenario(id);
  if (!cur) return null;
  const merged = { ...cur, ...s, id };
  db.query("UPDATE scenarios SET name=?, intro=?, notes=? WHERE id=?").run(
    merged.name, merged.intro, merged.notes, id,
  );
  return getScenario(id);
}

export function deleteScenario(id: number): void {
  db.query("DELETE FROM scenarios WHERE id = ?").run(id);
}

// ─── cards ────────────────────────────────────────────────────────────────────
export interface CardRow {
  id: number; name: string; description: string; personality: string; scenario: string;
  first_mes: string; mes_example: string; system_prompt: string; post_history_instructions: string;
  alternate_greetings: string; tags: string; creator: string; avatar: string; voice: string;
  language: string; data: string; created_at: number;
}

export function listCards(): CardRow[] {
  return db.query("SELECT * FROM cards ORDER BY created_at DESC").all() as CardRow[];
}

export function getCard(id: number): CardRow | null {
  return db.query("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | null;
}

export function createCard(c: Partial<CardRow>): CardRow {
  const r = db.query(
    `INSERT INTO cards (name, description, personality, scenario, first_mes, mes_example,
       system_prompt, post_history_instructions, alternate_greetings, tags, creator, avatar,
       voice, language, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.name ?? "Carte sans nom", c.description ?? "", c.personality ?? "", c.scenario ?? "",
    c.first_mes ?? "", c.mes_example ?? "", c.system_prompt ?? "", c.post_history_instructions ?? "",
    c.alternate_greetings ?? "[]", c.tags ?? "[]", c.creator ?? "", c.avatar ?? "",
    c.voice ?? "", c.language ?? "", c.data ?? "{}", now(),
  );
  return getCard(Number(r.lastInsertRowid))!;
}

export function updateCard(id: number, c: Partial<CardRow>): CardRow | null {
  const cur = getCard(id);
  if (!cur) return null;
  const merged = { ...cur, ...c, id };
  db.query(
    `UPDATE cards SET name=?, description=?, personality=?, scenario=?, first_mes=?, mes_example=?,
       system_prompt=?, post_history_instructions=?, alternate_greetings=?, tags=?, creator=?,
       avatar=?, voice=?, language=?, data=? WHERE id=?`,
  ).run(
    merged.name, merged.description, merged.personality, merged.scenario, merged.first_mes,
    merged.mes_example, merged.system_prompt, merged.post_history_instructions,
    merged.alternate_greetings, merged.tags, merged.creator, merged.avatar, merged.voice,
    merged.language, merged.data, id,
  );
  return getCard(id);
}

export function deleteCard(id: number): void {
  db.query("DELETE FROM cards WHERE id = ?").run(id);
}

// ─── personas ─────────────────────────────────────────────────────────────────
export interface PersonaRow {
  id: number; name: string; description: string; avatar: string; created_at: number;
}

export function listPersonas(): PersonaRow[] {
  return db.query("SELECT * FROM personas ORDER BY created_at DESC").all() as PersonaRow[];
}

export function getPersona(id: number): PersonaRow | null {
  return db.query("SELECT * FROM personas WHERE id = ?").get(id) as PersonaRow | null;
}

export function createPersona(p: Partial<PersonaRow>): PersonaRow {
  const r = db.query(
    "INSERT INTO personas (name, description, avatar, created_at) VALUES (?, ?, ?, ?)",
  ).run(p.name ?? "Persona", p.description ?? "", p.avatar ?? "", now());
  return getPersona(Number(r.lastInsertRowid))!;
}

export function updatePersona(id: number, p: Partial<PersonaRow>): PersonaRow | null {
  const cur = getPersona(id);
  if (!cur) return null;
  const merged = { ...cur, ...p, id };
  db.query("UPDATE personas SET name=?, description=?, avatar=? WHERE id=?").run(
    merged.name, merged.description, merged.avatar, id,
  );
  return getPersona(id);
}

export function deletePersona(id: number): void {
  db.query("DELETE FROM personas WHERE id = ?").run(id);
}

// ─── conversations ────────────────────────────────────────────────────────────
export interface ConversationRow {
  id: number; title: string; world_id: number | null; persona_id: number | null;
  scenario_id: number | null; cast: string; group_mode: number; pinned: number; archived: number; settings: string;
  last_message: string; summary: string; summary_msg_id: number; created_at: number; updated_at: number;
}

export function listConversations(): ConversationRow[] {
  return db.query("SELECT * FROM conversations ORDER BY updated_at DESC").all() as ConversationRow[];
}

export function getConversation(id: number): ConversationRow | null {
  return db.query("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | null;
}

export function createConversation(c: Partial<ConversationRow>): ConversationRow {
  const t = now();
  const r = db.query(
    `INSERT INTO conversations (title, world_id, persona_id, scenario_id, cast, group_mode, settings, last_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.title ?? "Nouvelle partie", c.world_id ?? null, c.persona_id ?? null, c.scenario_id ?? null,
    c.cast ?? "[]", c.group_mode ?? 0, c.settings ?? "{}", c.last_message ?? "", t, t,
  );
  return getConversation(Number(r.lastInsertRowid))!;
}

export function updateConversation(id: number, c: Partial<ConversationRow>): ConversationRow | null {
  const cur = getConversation(id);
  if (!cur) return null;
  const clean: any = {};
  for (const [k, v] of Object.entries(c)) if (v !== undefined) clean[k] = v;
  const merged = { ...cur, ...clean, id };
  db.query(
    `UPDATE conversations SET title=?, world_id=?, persona_id=?, scenario_id=?, cast=?, group_mode=?, pinned=?, archived=?, settings=?, last_message=?, summary=?, summary_msg_id=?, updated_at=? WHERE id=?`,
  ).run(
    merged.title, merged.world_id, merged.persona_id, merged.scenario_id, merged.cast,
    merged.group_mode, merged.pinned, merged.archived, merged.settings, merged.last_message,
    merged.summary, merged.summary_msg_id, now(), id,
  );
  return getConversation(id);
}

export function deleteConversation(id: number): void {
  db.query("DELETE FROM conversations WHERE id = ?").run(id);
}

export function touchConversation(id: number): void {
  db.query("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), id);
}

// ─── messages ─────────────────────────────────────────────────────────────────
export interface MessageRow {
  id: number; conversation_id: number; role: string; name: string; content: string;
  segments: string; audio: string; meta: string; created_at: number;
}

export function listMessages(conversationId: number): MessageRow[] {
  return db.query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id").all(conversationId) as MessageRow[];
}

export function getMessage(id: number): MessageRow | null {
  return db.query("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | null;
}

export function createMessage(m: Partial<MessageRow>): MessageRow {
  const r = db.query(
    `INSERT INTO messages (conversation_id, role, name, content, segments, audio, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.conversation_id, m.role ?? "assistant", m.name ?? "", m.content ?? "", m.segments ?? "[]",
    m.audio ?? "[]", m.meta ?? "{}", now(),
  );
  return getMessage(Number(r.lastInsertRowid))!;
}

export function updateMessage(id: number, m: Partial<MessageRow>): MessageRow | null {
  const cur = getMessage(id);
  if (!cur) return null;
  const merged = { ...cur, ...m, id };
  db.query("UPDATE messages SET content=?, segments=?, audio=?, meta=?, name=? WHERE id=?").run(
    merged.content, merged.segments, merged.audio, merged.meta, merged.name, id,
  );
  return getMessage(id);
}

export function deleteMessage(id: number): void {
  db.query("DELETE FROM messages WHERE id = ?").run(id);
}

export function lastMessageOf(conversationId: number): MessageRow | null {
  return db.query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1").get(conversationId) as MessageRow | null;
}