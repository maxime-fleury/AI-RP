/** Test bootstrap: every test file gets its own throw-away data directory so
 * the real `data/` (and the user's world) is never touched. Must run BEFORE
 * any import of src/server/db or src/server/paths. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
export const dataDir = mkdtempSync(path.join(tmpdir(), "innsekai-test-"));

process.env.INNSEKAI_DATA_DIR = dataDir;

export async function loadApp() {
  const db = await import("../src/server/db");
  const routes = await import("../src/server/routes");
  const prompt = await import("../src/llm/prompt");
  return { db, routes, prompt };
}

export function api(routes: { handleApi: (req: Request, url: URL) => Promise<Response> }, method: string, pathname: string, body?: unknown) {
  return routes.handleApi(
    new Request(`http://test.local${pathname}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    new URL(`http://test.local${pathname}`),
  );
}

/** Unique name prefix so parallel/sequential files never collide on lookups
 * by name (e.g. restore tests finding "Monde plein"). */
export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Isolation tracker: bun test shares ONE process (and therefore one DB) across
 * test files, so every created row leaks into count-sensitive tests
 * (export/restore) unless removed. Create through this helper, then
 * `await cleanup()` in afterAll — deletions run in FK-safe order
 * (messages → sub-resources → cards/personas → worlds).
 *
 * Usage:
 *   const t = isolated(db);
 *   const w = t.world({ name: uid("Monde") });
 *   afterAll(() => t.cleanup());
 */
export function isolated(db: any) {
  const ids = {
    convs: [] as number[],
    locations: [] as number[],
    lore: [] as number[],
    relations: [] as number[],
    cards: [] as number[],
    personas: [] as number[],
    worlds: [] as number[],
  };
  type Bucket = keyof typeof ids;
  const track = <T extends { id: number }>(bucket: Bucket, row: T): T => {
    ids[bucket].push(row.id);
    return row;
  };
  return {
    ids,
    world: (w: any) => track("worlds", db.createWorld(w)),
    persona: (p: any) => track("personas", db.createPersona(p)),
    card: (c: any) => track("cards", db.createCard(c)),
    conv: (c: any) => track("convs", db.createConversation(c)),
    message: (m: any) => db.createMessage(m),
    location: (l: any) => track("locations", db.createLocation(l)),
    lore: (l: any) => track("lore", db.createLorebookEntry(l)),
    relation: (r: any) => track("relations", db.createRelation(r)),
    cleanup() {
      for (const id of ids.convs) {
        try {
          for (const m of db.listMessages(id)) db.deleteMessage(m.id);
          db.deleteConversation(id);
        } catch { /* already gone */ }
      }
      for (const id of ids.locations) { try { db.deleteLocation(id); } catch { /* ignore */ } }
      for (const id of ids.lore) { try { db.deleteLorebookEntry(id); } catch { /* ignore */ } }
      for (const id of ids.relations) { try { db.deleteRelation(id); } catch { /* ignore */ } }
      for (const id of ids.cards) { try { db.permanentDeleteCard(id); } catch { /* ignore */ } }
      for (const id of ids.personas) { try { db.permanentDeletePersona(id); } catch { /* ignore */ } }
      for (const id of ids.worlds) { try { db.permanentDeleteWorld(id); } catch { /* ignore */ } }
    },
  };
}