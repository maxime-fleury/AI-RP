/**
 * Backup restore as a product workflow: preview the payload (counts, names,
 * media), then restore TRANSACTIONALLY with a conflict policy (append vs
 * replace — replace moves current data to the trash first) and selective
 * includes per resource type (worlds, scenarios, cards, personas,
 * conversations, locations, lorebook, relations, timeline, media).
 *
 * The legacy all-or-nothing restore is kept as the default include set.
 */
import { db } from "./db";
import {
  createWorld, createScenario, createCard, createPersona, createConversation, createMessage,
  createLocation, createLorebookEntry, createRelation, createTimelineEvent, updateConversation,
  deleteWorld, deleteScenario, deleteCard, deletePersona, getConversation,
} from "./db";
import { restoreMedia } from "./media";

export type ConflictPolicy = "append" | "replace";
export type RestoreInclude = {
  worlds?: boolean; scenarios?: boolean; cards?: boolean; personas?: boolean;
  conversations?: boolean; locations?: boolean; lorebook?: boolean; relations?: boolean;
  timeline?: boolean; media?: boolean;
};

export interface BackupPreview {
  app: unknown;
  version: unknown;
  exported_at: unknown;
  valid: boolean;
  counts: Record<string, number>;
  names: Record<string, string[]>;
  mediaMB: number;
}

/** Analyze a parsed backup payload WITHOUT writing anything (restore preview). */
export function analyzeBackup(b: any): BackupPreview {
  const count = (k: string) => (Array.isArray(b[k]) ? b[k].length : 0);
  const names = (k: string, max = 8) =>
    Array.isArray(b[k])
      ? b[k].map((x: any) => String(x?.name || x?.title || x?.label || "?").slice(0, 40)).filter(Boolean).slice(0, max)
      : [];
  let mediaChars = 0;
  for (const v of Object.values(b.media ?? {})) {
    const b64 = typeof v === "string" ? v : (v as any)?.b64 ?? (v as any)?.data ?? "";
    if (typeof b64 === "string") mediaChars += b64.length;
  }
  const valid = b && typeof b === "object" &&
    (b.app === "innsekai" || Array.isArray(b.worlds) || Array.isArray(b.cards) || Array.isArray(b.conversations));
  return {
    app: b?.app ?? null,
    version: b?.version ?? null,
    exported_at: b?.exported_at ?? null,
    valid,
    counts: {
      worlds: count("worlds"), scenarios: count("scenarios"), cards: count("cards"),
      personas: count("personas"), conversations: count("conversations"),
      locations: count("locations"), lorebook: count("lorebook"), relations: count("relations"),
      timeline: count("timeline_events"), media: Object.keys(b.media ?? {}).length,
    },
    names: {
      worlds: names("worlds"), conversations: names("conversations", 10),
      cards: names("cards"), personas: names("personas"), scenarios: names("scenarios"),
    },
    mediaMB: +(mediaChars / 1.33e6).toFixed(1), // base64 ≈ 4/3 of the raw bytes
  };
}

// Accept both clean JSON (arrays/objects — current exports) and legacy rows
// (JSON-stringified columns) without re-encoding them a second time.
function normalize(v: unknown, fallback: unknown): unknown {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; } // plain text (summary…) stays as-is
}

export interface RestoreReport {
  ok: boolean;
  worlds: number; scenarios: number; cards: number; personas: number; conversations: number;
  timeline_events: number; locations: number; lorebook: number; relations: number; media: number;
  conflict: ConflictPolicy;
  replaced: { worlds: number; scenarios: number; cards: number; personas: number; conversations: number; locations: number; lorebook: number; relations: number; timeline: number };
  note: string;
}

/** Move current data of the included types to the trash (recoverable). */
function replaceExisting(include: RestoreInclude, replaced: RestoreReport["replaced"]): void {
  if (include.worlds) for (const w of db.query("SELECT id FROM worlds WHERE trashed = 0").all() as any[]) { deleteWorld(Number(w.id)); replaced.worlds++; }
  if (include.scenarios) for (const s of db.query("SELECT id FROM scenarios WHERE trashed = 0").all() as any[]) { deleteScenario(Number(s.id)); replaced.scenarios++; }
  if (include.cards) for (const c of db.query("SELECT id FROM cards WHERE trashed = 0").all() as any[]) { deleteCard(Number(c.id)); replaced.cards++; }
  if (include.personas) for (const p of db.query("SELECT id FROM personas WHERE trashed = 0").all() as any[]) { deletePersona(Number(p.id)); replaced.personas++; }
  if (include.conversations) for (const c of db.query("SELECT id FROM conversations WHERE archived = 0").all() as any[]) {
    updateConversation(Number(c.id), { archived: 1 });
    replaced.conversations++;
  }
  if (include.locations) { replaced.locations += (db.query("DELETE FROM locations").run() as any).changes ?? 0; }
  if (include.lorebook) { replaced.lorebook += (db.query("DELETE FROM lorebook_entries").run() as any).changes ?? 0; }
  if (include.relations) { replaced.relations += (db.query("DELETE FROM relations").run() as any).changes ?? 0; }
  if (include.timeline) { replaced.timeline += (db.query("DELETE FROM timeline_events").run() as any).changes ?? 0; }
}

/**
 * Restore a backup payload. ALL database writes run inside ONE transaction —
 * a failure mid-restore rolls everything back (no half-restored state). Media
 * files are written afterwards (file I/O can't roll back, but it only ADDS
 * files and is idempotent per URL).
 */
export function restoreBackupTx(b: any, opts: { conflict?: ConflictPolicy; include?: RestoreInclude } = {}): RestoreReport {
  const conflict: ConflictPolicy = opts.conflict === "replace" ? "replace" : "append";
  const include: RestoreInclude = { ...opts.include };
  // media requires conversations (URL remapping needs the fresh ids)
  const incl = (k: keyof RestoreInclude) => include[k] !== false;

  const replaced: RestoreReport["replaced"] = {
    worlds: 0, scenarios: 0, cards: 0, personas: 0, conversations: 0,
    locations: 0, lorebook: 0, relations: 0, timeline: 0,
  };

  const run = db.transaction(() => {
    if (conflict === "replace") replaceExisting(include, replaced);

    const worldIds = new Map<number, number>();
    if (incl("worlds")) {
      for (const w of b.worlds ?? []) {
        const nw = createWorld(w);
        worldIds.set(Number(w.id), nw.id);
      }
    }
    let locations = 0;
    if (incl("locations")) {
      for (const loc of b.locations ?? []) {
        createLocation({
          world_id: worldIds.get(Number(loc.world_id)) ?? 0,
          name: loc.name, description: loc.description, x: loc.x, y: loc.y,
        });
        locations++;
      }
    }
    let lorebook = 0;
    if (incl("lorebook")) {
      for (const le of b.lorebook ?? []) {
        createLorebookEntry({
          world_id: worldIds.get(Number(le.world_id)) ?? 0,
          name: le.name, triggers: le.triggers, content: le.content,
          priority: le.priority, enabled: le.enabled,
        });
        lorebook++;
      }
    }
    let relations = 0;
    if (incl("relations")) {
      for (const r of b.relations ?? []) {
        createRelation({
          world_id: worldIds.get(Number(r.world_id)) ?? 0,
          from_name: r.from_name, to_name: r.to_name, kind: r.kind,
        });
        relations++;
      }
    }
    const scenIds = new Map<number, number>();
    let scenarios = 0;
    if (incl("scenarios")) {
      for (const s of b.scenarios ?? []) {
        const ns = createScenario({ ...s, world_id: worldIds.get(Number(s.world_id)) ?? s.world_id });
        scenIds.set(Number(s.id), ns.id);
        scenarios++;
      }
    }
    const cardIds = new Map<number, number>();
    let cards = 0;
    if (incl("cards")) {
      for (const c of b.cards ?? []) {
        const nc = createCard(c);
        cardIds.set(Number(c.id), nc.id);
        cards++;
      }
    }
    const personaIds = new Map<number, number>();
    let personas = 0;
    if (incl("personas")) {
      for (const po of b.personas ?? []) {
        const np = createPersona(po);
        personaIds.set(Number(po.id), np.id);
        personas++;
      }
    }
    let conversations = 0;
    const convIds = new Map<number, number>();
    const msgIds = new Map<number, number>();
    if (incl("conversations")) {
      for (const c of b.conversations ?? []) {
        const conv = createConversation({
          title: c.title ?? "Partie restaurée",
          world_id: c.world_id ? (worldIds.get(Number(c.world_id)) ?? null) : null,
          persona_id: c.persona_id ? (personaIds.get(Number(c.persona_id)) ?? null) : null,
          scenario_id: c.scenario_id ? (scenIds.get(Number(c.scenario_id)) ?? null) : null,
          cast: JSON.stringify((Array.isArray(c.cast) ? c.cast : []).map((id: number) => cardIds.get(Number(id)) ?? id)),
          group_mode: c.group_mode ? 1 : 0,
          settings: JSON.stringify(normalize(c.settings, {}) ?? {}),
          memory_json: typeof c.memory_json === "string" ? c.memory_json : JSON.stringify(c.memory_json ?? ""),
          summary: String(c.summary ?? ""),
          summary_msg_id: Number(c.summary_msg_id) || 0,
          pinned: c.pinned ? 1 : 0,
          archived: c.archived ? 1 : 0,
          last_message: String(c.last_message ?? ""),
          created_at: c.created_at,
          updated_at: c.updated_at,
        });
        convIds.set(Number(c.id), conv.id);
        for (const m of c.messages ?? []) {
          const nm = createMessage({
            conversation_id: conv.id, role: m.role ?? "assistant", name: m.name ?? "",
            content: m.content ?? "",
            segments: JSON.stringify(normalize(m.segments, []) ?? []),
            meta: JSON.stringify(normalize(m.meta, {}) ?? {}),
            created_at: m.created_at,
          });
          if (m.id != null) msgIds.set(Number(m.id), nm.id);
        }
        conversations++;
      }
      // second pass: branch links, summary high-water mark, timestamps
      for (const c of b.conversations ?? []) {
        const newId = convIds.get(Number(c.id));
        if (newId === undefined) continue;
        const restored = getConversation(newId);
        const patch: any = {
          parent_id: c.parent_id != null ? (convIds.get(Number(c.parent_id)) ?? null) : null,
          updated_at: restored?.updated_at,
        };
        if (typeof c.branch_kind === "string") patch.branch_kind = c.branch_kind;
        const oldSummaryMsg = Number(c.summary_msg_id) || 0;
        if (oldSummaryMsg > 0 && msgIds.has(oldSummaryMsg)) patch.summary_msg_id = msgIds.get(oldSummaryMsg);
        updateConversation(newId, patch);
      }
    }
    let timelineEvents = 0;
    if (incl("timeline")) {
      for (const e of b.timeline_events ?? []) {
        createTimelineEvent({
          world_id: worldIds.get(Number(e.world_id)) ?? 0,
          conversation_id: e.conversation_id != null ? (convIds.get(Number(e.conversation_id)) ?? null) : null,
          message_id: e.message_id != null ? (msgIds.get(Number(e.message_id)) ?? null) : null,
          label: e.label ?? "",
        });
        timelineEvents++;
      }
    }
    return { worlds: (b.worlds ?? []).length, scenarios, cards, personas, conversations, timeline_events: timelineEvents, locations, lorebook, relations, convIds };
  });

  const r = run();
  let media = 0;
  if (incl("media")) media = restoreMedia(b, r.convIds);
  return {
    ok: true,
    worlds: r.worlds, scenarios: r.scenarios, cards: r.cards, personas: r.personas,
    conversations: r.conversations, timeline_events: r.timeline_events,
    locations: r.locations, lorebook: r.lorebook, relations: r.relations, media,
    conflict,
    replaced,
    note: "ids ré-attribués — restaurer deux fois le même fichier duplique les données",
  };
}