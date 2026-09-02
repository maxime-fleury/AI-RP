import { Database } from "bun:sqlite";
import fs from "node:fs";
import { DB_PATH, DATA_DIR, IMAGES_DIR, UPLOADS_DIR } from "./paths";

for (const d of [DATA_DIR, IMAGES_DIR, UPLOADS_DIR]) {
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
  fingerprint TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 50,
  y REAL NOT NULL DEFAULT 50,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lorebook_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  triggers TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  from_name TEXT NOT NULL,
  to_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'neutre',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  message_id INTEGER,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,
  conversation_id INTEGER,
  message_id INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_world ON conversations(world_id);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at);
`);

// migrations for pre-existing databases (columns added later)
{
  const convCols = new Set((db.query("PRAGMA table_info(conversations)").all() as any[]).map((c) => c.name));
  if (!convCols.has("summary")) db.exec("ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
  if (!convCols.has("summary_msg_id")) db.exec("ALTER TABLE conversations ADD COLUMN summary_msg_id INTEGER NOT NULL DEFAULT 0");
  if (!convCols.has("memory_json")) db.exec("ALTER TABLE conversations ADD COLUMN memory_json TEXT NOT NULL DEFAULT ''");
  if (!convCols.has("pinned")) db.exec("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!convCols.has("archived")) db.exec("ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  const worldCols = new Set((db.query("PRAGMA table_info(worlds)").all() as any[]).map((c: any) => c.name));
  if (!worldCols.has("map")) db.exec("ALTER TABLE worlds ADD COLUMN map TEXT NOT NULL DEFAULT ''");
  const convCols2 = new Set((db.query("PRAGMA table_info(conversations)").all() as any[]).map((c: any) => c.name));
  if (!convCols2.has("parent_id")) db.exec("ALTER TABLE conversations ADD COLUMN parent_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL");
  if (!convCols2.has("branch_kind")) db.exec("ALTER TABLE conversations ADD COLUMN branch_kind TEXT NOT NULL DEFAULT 'main'");
  const cardCols = new Set((db.query("PRAGMA table_info(cards)").all() as any[]).map((c: any) => c.name));
  if (!cardCols.has("fingerprint")) db.exec("ALTER TABLE cards ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
  // soft-delete (trash) support: deletes move rows here, restore brings them back
  for (const [table, cols] of [["worlds", worldCols], ["scenarios", null], ["cards", cardCols], ["personas", null]] as [string, Set<string> | null][]) {
    if (cols && cols.has("trashed")) continue;
    const tcols = new Set((db.query(`PRAGMA table_info(${table})`).all() as any[]).map((c: any) => c.name));
    if (!tcols.has("trashed")) db.exec(`ALTER TABLE ${table} ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_cards_fingerprint ON cards(fingerprint)");

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
  return db.query("SELECT * FROM worlds WHERE trashed = 0 ORDER BY created_at DESC").all() as WorldRow[];
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
  db.query("UPDATE worlds SET trashed = 1 WHERE id = ?").run(id);
}
export function restoreWorld(id: number): void {
  db.query("UPDATE worlds SET trashed = 0 WHERE id = ?").run(id);
}
export function permanentDeleteWorld(id: number): void {
  db.query("DELETE FROM worlds WHERE id = ?").run(id);
}

// ─── scenarios ────────────────────────────────────────────────────────────────
export interface ScenarioRow {
  id: number; world_id: number; name: string; intro: string; notes: string; created_at: number;
}

export function listScenarios(worldId?: number): ScenarioRow[] {
  if (worldId) return db.query("SELECT * FROM scenarios WHERE world_id = ? AND trashed = 0 ORDER BY created_at").all(worldId) as ScenarioRow[];
  return db.query("SELECT * FROM scenarios WHERE trashed = 0 ORDER BY created_at").all() as ScenarioRow[];
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
  db.query("UPDATE scenarios SET trashed = 1 WHERE id = ?").run(id);
}
export function restoreScenario(id: number): void {
  db.query("UPDATE scenarios SET trashed = 0 WHERE id = ?").run(id);
}
export function permanentDeleteScenario(id: number): void {
  db.query("DELETE FROM scenarios WHERE id = ?").run(id);
}

// ─── cards ────────────────────────────────────────────────────────────────────
export interface CardRow {
  id: number; name: string; description: string; personality: string; scenario: string;
  first_mes: string; mes_example: string; system_prompt: string; post_history_instructions: string;
  alternate_greetings: string; tags: string; creator: string; avatar: string; voice: string;
  language: string; data: string; fingerprint: string; created_at: number;
}

export function listCards(): CardRow[] {
  return db.query("SELECT * FROM cards WHERE trashed = 0 ORDER BY created_at DESC").all() as CardRow[];
}

export function getCard(id: number): CardRow | null {
  return db.query("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | null;
}

export function createCard(c: Partial<CardRow>): CardRow {
  const r = db.query(
    `INSERT INTO cards (name, description, personality, scenario, first_mes, mes_example,
       system_prompt, post_history_instructions, alternate_greetings, tags, creator, avatar,
       voice, language, data, fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.name ?? "Carte sans nom", c.description ?? "", c.personality ?? "", c.scenario ?? "",
    c.first_mes ?? "", c.mes_example ?? "", c.system_prompt ?? "", c.post_history_instructions ?? "",
    c.alternate_greetings ?? "[]", c.tags ?? "[]", c.creator ?? "", c.avatar ?? "",
    c.voice ?? "", c.language ?? "", c.data ?? "{}", c.fingerprint ?? "", now(),
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
       avatar=?, voice=?, language=?, data=?, fingerprint=? WHERE id=?`,
  ).run(
    merged.name, merged.description, merged.personality, merged.scenario, merged.first_mes,
    merged.mes_example, merged.system_prompt, merged.post_history_instructions,
    merged.alternate_greetings, merged.tags, merged.creator, merged.avatar, merged.voice,
    merged.language, merged.data, merged.fingerprint, id,
  );
  return getCard(id);
}

/** First card whose content fingerprint matches (duplicate detection on import). */
export function cardByFingerprint(fp: string): CardRow | null {
  if (!fp) return null;
  return db.query("SELECT * FROM cards WHERE fingerprint = ? LIMIT 1").get(fp) as CardRow | null;
}

export function deleteCard(id: number): void {
  db.query("UPDATE cards SET trashed = 1 WHERE id = ?").run(id);
}
export function restoreCard(id: number): void {
  db.query("UPDATE cards SET trashed = 0 WHERE id = ?").run(id);
}
export function permanentDeleteCard(id: number): void {
  db.query("DELETE FROM cards WHERE id = ?").run(id);
}

// ─── personas ─────────────────────────────────────────────────────────────────
export interface PersonaRow {
  id: number; name: string; description: string; avatar: string; created_at: number;
}

export function listPersonas(): PersonaRow[] {
  return db.query("SELECT * FROM personas WHERE trashed = 0 ORDER BY created_at DESC").all() as PersonaRow[];
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
  db.query("UPDATE personas SET trashed = 1 WHERE id = ?").run(id);
}
export function restorePersona(id: number): void {
  db.query("UPDATE personas SET trashed = 0 WHERE id = ?").run(id);
}
export function permanentDeletePersona(id: number): void {
  db.query("DELETE FROM personas WHERE id = ?").run(id);
}

// ─── trash (soft-deleted resources) ───────────────────────────────────────────
export interface TrashedResource {
  type: "world" | "scenario" | "card" | "persona";
  id: number;
  name: string;
  updated_at: number;
}
export function listTrashedResources(): TrashedResource[] {
  const out: TrashedResource[] = [];
  for (const r of db.query("SELECT id, name, created_at AS updated_at FROM worlds WHERE trashed = 1").all() as any[]) out.push({ type: "world", ...r });
  for (const r of db.query("SELECT id, name, created_at AS updated_at FROM scenarios WHERE trashed = 1").all() as any[]) out.push({ type: "scenario", ...r });
  for (const r of db.query("SELECT id, name, created_at AS updated_at FROM cards WHERE trashed = 1").all() as any[]) out.push({ type: "card", ...r });
  for (const r of db.query("SELECT id, name, created_at AS updated_at FROM personas WHERE trashed = 1").all() as any[]) out.push({ type: "persona", ...r });
  return out.sort((a, b) => b.updated_at - a.updated_at);
}
export function restoreTrashed(type: string, id: number): boolean {
  const fn: Record<string, (x: number) => void> = {
    world: restoreWorld, scenario: restoreScenario, card: restoreCard, persona: restorePersona,
  };
  const f = fn[type];
  if (!f) return false;
  f(id);
  return true;
}
export function permanentDeleteTrashed(type: string, id: number): boolean {
  const fn: Record<string, (x: number) => void> = {
    world: permanentDeleteWorld, scenario: permanentDeleteScenario, card: permanentDeleteCard, persona: permanentDeletePersona,
  };
  const f = fn[type];
  if (!f) return false;
  f(id);
  return true;
}

// ─── conversations ────────────────────────────────────────────────────────────
export interface ConversationRow {
  id: number; title: string; world_id: number | null; persona_id: number | null;
  scenario_id: number | null; cast: string; group_mode: number; pinned: number; archived: number; settings: string;
  last_message: string; summary: string; summary_msg_id: number; memory_json: string;
  parent_id: number | null; branch_kind: string;
  created_at: number; updated_at: number;
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
    `INSERT INTO conversations (title, world_id, persona_id, scenario_id, cast, group_mode, settings, last_message, memory_json, parent_id, branch_kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.title ?? "Nouvelle partie", c.world_id ?? null, c.persona_id ?? null, c.scenario_id ?? null,
    c.cast ?? "[]", c.group_mode ?? 0, c.settings ?? "{}", c.last_message ?? "",
    c.memory_json ?? "", c.parent_id ?? null, c.branch_kind ?? "main", t, t,
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
    `UPDATE conversations SET title=?, world_id=?, persona_id=?, scenario_id=?, cast=?, group_mode=?, pinned=?, archived=?, settings=?, last_message=?, summary=?, summary_msg_id=?, memory_json=?, parent_id=?, branch_kind=?, updated_at=? WHERE id=?`,
  ).run(
    merged.title, merged.world_id, merged.persona_id, merged.scenario_id, merged.cast,
    merged.group_mode, merged.pinned, merged.archived, merged.settings, merged.last_message,
    merged.summary, merged.summary_msg_id, merged.memory_json ?? "", merged.parent_id ?? null, merged.branch_kind ?? "main", now(), id,
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

/** Delete every message strictly after `minId` in a conversation, returning them. */
export function deleteMessagesAfter(conversationId: number, minId: number): MessageRow[] {
  const rows = db.query(
    "SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id",
  ).all(conversationId, minId) as MessageRow[];
  db.query("DELETE FROM messages WHERE conversation_id = ? AND id > ?").run(conversationId, minId);
  return rows;
}

export function lastMessageOf(conversationId: number): MessageRow | null {
  return db.query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1").get(conversationId) as MessageRow | null;
}

// ─── locations (structured world places) ─────────────────────────────────────
export interface LocationRow {
  id: number; world_id: number; name: string; description: string;
  x: number; y: number; created_at: number;
}

export function listLocations(worldId: number): LocationRow[] {
  return db.query("SELECT * FROM locations WHERE world_id = ? ORDER BY created_at").all(worldId) as LocationRow[];
}

export function getLocation(id: number): LocationRow | null {
  return db.query("SELECT * FROM locations WHERE id = ?").get(id) as LocationRow | null;
}

export function createLocation(l: Partial<LocationRow>): LocationRow {
  const r = db.query(
    "INSERT INTO locations (world_id, name, description, x, y, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(l.world_id ?? 0, l.name ?? "場所", l.description ?? "", l.x ?? 50, l.y ?? 50, now());
  return getLocation(Number(r.lastInsertRowid))!;
}

export function updateLocation(id: number, l: Partial<LocationRow>): LocationRow | null {
  const cur = getLocation(id);
  if (!cur) return null;
  const merged = { ...cur, ...l, id };
  db.query("UPDATE locations SET name=?, description=?, x=?, y=? WHERE id=?").run(
    merged.name, merged.description, merged.x, merged.y, id,
  );
  return getLocation(id);
}

export function deleteLocation(id: number): void {
  db.query("DELETE FROM locations WHERE id = ?").run(id);
}

// ─── lorebook (conditional memory entries) ────────────────────────────────────
export interface LorebookRow {
  id: number; world_id: number; name: string; triggers: string; content: string;
  priority: number; enabled: number; created_at: number;
}

export function listLorebook(worldId: number): LorebookRow[] {
  return db.query("SELECT * FROM lorebook_entries WHERE world_id = ? ORDER BY priority DESC, created_at").all(worldId) as LorebookRow[];
}

export function getLorebookEntry(id: number): LorebookRow | null {
  return db.query("SELECT * FROM lorebook_entries WHERE id = ?").get(id) as LorebookRow | null;
}

export function createLorebookEntry(l: Partial<LorebookRow>): LorebookRow {
  const r = db.query(
    "INSERT INTO lorebook_entries (world_id, name, triggers, content, priority, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(l.world_id ?? 0, l.name ?? "Entry", l.triggers ?? "", l.content ?? "", l.priority ?? 1, l.enabled ?? 1, now());
  return getLorebookEntry(Number(r.lastInsertRowid))!;
}

export function updateLorebookEntry(id: number, l: Partial<LorebookRow>): LorebookRow | null {
  const cur = getLorebookEntry(id);
  if (!cur) return null;
  const merged = { ...cur, ...l, id };
  db.query("UPDATE lorebook_entries SET name=?, triggers=?, content=?, priority=?, enabled=? WHERE id=?").run(
    merged.name, merged.triggers, merged.content, merged.priority, merged.enabled, id,
  );
  return getLorebookEntry(id);
}

export function deleteLorebookEntry(id: number): void {
  db.query("DELETE FROM lorebook_entries WHERE id = ?").run(id);
}

/** Entries whose triggers (comma-separated) match the recent text. */
export function activeLorebook(worldId: number, recentText: string): LorebookRow[] {
  const lower = recentText.toLowerCase();
  return listLorebook(worldId)
    .filter((e) => e.enabled === 1)
    .filter((e) => e.triggers.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).some((t) => lower.includes(t)));
}

// ─── relations (character relationship graph) ─────────────────────────────────
export interface RelationRow {
  id: number; world_id: number; from_name: string; to_name: string; kind: string; created_at: number;
}

export function listRelations(worldId: number): RelationRow[] {
  return db.query("SELECT * FROM relations WHERE world_id = ? ORDER BY created_at").all(worldId) as RelationRow[];
}

export function getRelation(id: number): RelationRow | null {
  return db.query("SELECT * FROM relations WHERE id = ?").get(id) as RelationRow | null;
}

export function createRelation(r: Partial<RelationRow>): RelationRow {
  const row = db.query(
    "INSERT INTO relations (world_id, from_name, to_name, kind, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(r.world_id ?? 0, r.from_name ?? "", r.to_name ?? "", r.kind ?? "neutre", now());
  return getRelation(Number(row.lastInsertRowid))!;
}

export function updateRelation(id: number, r: Partial<RelationRow>): RelationRow | null {
  const cur = getRelation(id);
  if (!cur) return null;
  const merged = { ...cur, ...r, id };
  db.query("UPDATE relations SET from_name=?, to_name=?, kind=? WHERE id=?").run(
    merged.from_name, merged.to_name, merged.kind, id,
  );
  return getRelation(id);
}

export function deleteRelation(id: number): void {
  db.query("DELETE FROM relations WHERE id = ?").run(id);
}

// ─── timeline events ──────────────────────────────────────────────────────────
export interface TimelineRow {
  id: number; world_id: number; conversation_id: number | null; message_id: number | null;
  label: string; created_at: number;
}

export function listTimeline(worldId: number): TimelineRow[] {
  return db.query("SELECT * FROM timeline_events WHERE world_id = ? ORDER BY created_at").all(worldId) as TimelineRow[];
}

export function getTimelineEvent(id: number): TimelineRow | null {
  return db.query("SELECT * FROM timeline_events WHERE id = ?").get(id) as TimelineRow | null;
}

export function createTimelineEvent(t: Partial<TimelineRow>): TimelineRow {
  const r = db.query(
    "INSERT INTO timeline_events (world_id, conversation_id, message_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(t.world_id ?? 0, t.conversation_id ?? null, t.message_id ?? null, t.label ?? "", now());
  return getTimelineEvent(Number(r.lastInsertRowid))!;
}

export function updateTimelineEvent(id: number, t: Partial<TimelineRow>): TimelineRow | null {
  const cur = getTimelineEvent(id);
  if (!cur) return null;
  const merged = { ...cur, ...t, id };
  db.query("UPDATE timeline_events SET label=? WHERE id=?").run(merged.label, id);
  return getTimelineEvent(id);
}

export function deleteTimelineEvent(id: number): void {
  db.query("DELETE FROM timeline_events WHERE id = ?").run(id);
}

// ─── jobs (async background task queue) ───────────────────────────────────────
export interface JobRow {
  id: number; type: string; status: string; progress: number; conversation_id: number | null;
  message_id: number | null; payload: string; error: string; created_at: number; completed_at: number | null;
}

export function createJob(j: Partial<JobRow>): JobRow {
  const r = db.query(
    `INSERT INTO jobs (type, status, progress, conversation_id, message_id, payload, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(j.type ?? "generic", j.status ?? "pending", j.progress ?? 0, j.conversation_id ?? null,
    j.message_id ?? null, j.payload ?? "{}", j.error ?? "", now());
  return getJob(Number(r.lastInsertRowid))!;
}

export function getJob(id: number): JobRow | null {
  return db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
}

export function listJobs(status?: string): JobRow[] {
  if (status) return db.query("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT 50").all(status) as JobRow[];
  return db.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50").all() as JobRow[];
}

export function updateJob(id: number, j: Partial<JobRow>): JobRow | null {
  const cur = getJob(id);
  if (!cur) return null;
  const merged = { ...cur, ...j, id };
  db.query("UPDATE jobs SET status=?, progress=?, error=?, completed_at=? WHERE id=?").run(
    merged.status, merged.progress, merged.error, merged.completed_at, id,
  );
  return getJob(id);
}

export function pendingJobs(): JobRow[] {
  return db.query("SELECT * FROM jobs WHERE status IN ('pending','running') ORDER BY created_at").all() as JobRow[];
}

/**
 * Mark jobs left dangling by a restart (crashed while running) as failed, so
 * the queue never shows zombie tasks. Returns the number of jobs cleaned up.
 */
export function cleanupStaleJobs(maxAgeMs = 6 * 3600 * 1000): number {
  const cutoff = now() - maxAgeMs;
  const stale = db.query("SELECT id FROM jobs WHERE status IN ('pending','running') AND created_at < ?").all(cutoff) as { id: number }[];
  for (const r of stale) {
    updateJob(r.id, { status: "failed", error: "Interrompu au redémarrage", completed_at: now() });
  }
  return stale.length;
}

// ─── branch metadata helpers ──────────────────────────────────────────────────
export function listBranches(parentId: number): ConversationRow[] {
  return db.query("SELECT * FROM conversations WHERE parent_id = ? ORDER BY created_at").all(parentId) as ConversationRow[];
}

export function setBranchKind(id: number, kind: string): void {
  db.query("UPDATE conversations SET branch_kind = ? WHERE id = ?").run(kind, id);
}