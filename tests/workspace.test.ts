import { describe, test, expect } from "bun:test";
import { loadApp, api } from "./helpers";

describe("presets, scene state & service tests", async () => {
  const { db, routes, prompt } = await loadApp();

  test("generation preset directive is injected into the system prompt", () => {
    const conv = db.createConversation({ title: "P", settings: JSON.stringify({ preset: "horreur" }) });
    const withPreset = prompt.buildMessages({ world: null, persona: null, cards: [], conversation: conv }, [] as any);
    expect(withPreset.system).toContain("Directives de style");
    expect(withPreset.system).toContain("Style horreur");

    const plain = db.createConversation({ title: "Q" });
    const without = prompt.buildMessages({ world: null, persona: null, cards: [], conversation: plain }, [] as any);
    expect(without.system).not.toContain("Directives de style");
  });

  test("unknown preset key is ignored safely", () => {
    const conv = db.createConversation({ title: "R", settings: JSON.stringify({ preset: "nope" }) });
    const out = prompt.buildMessages({ world: null, persona: null, cards: [], conversation: conv }, [] as any);
    expect(out.system).not.toContain("Directives de style");
  });

  test("GET scene state returns stored state or null", async () => {
    const empty = db.createConversation({ title: "Sans état" });
    const r1 = await api(routes, "GET", `/api/conversations/${empty.id}/scene`);
    expect(r1.status).toBe(200);
    expect((await r1.json()).state).toBeNull();

    const full = db.createConversation({
      title: "Avec état",
      settings: JSON.stringify({ scene_state: { location: "Forêt d'Émeraude", goals: ["Trouver la porte"], dangers: [] }, scene_updated_at: 1234 }),
    });
    const r2 = await (await api(routes, "GET", `/api/conversations/${full.id}/scene`)).json();
    expect(r2.state.location).toBe("Forêt d'Émeraude");
    expect(r2.state.goals).toContain("Trouver la porte");
    expect(r2.updatedAt).toBe(1234);
  });

  test("POST /api/test probes provider, tts and image without crashing", async () => {
    const res = await api(routes, "POST", "/api/test");
    expect(res.status).toBe(200);
    const r = (await res.json()) as any;
    expect(typeof r.provider.provider).toBe("string");
    expect(typeof r.provider.ok).toBe("boolean");
    expect(typeof r.provider.ms).toBe("number");
    expect(typeof r.tts.ok).toBe("boolean");
    expect(typeof r.image).toBe("object");
    expect("running" in r.image || "ready" in r.image).toBe(true);
  });
});

describe("branches, backups & coherence check", async () => {
  const { db, routes } = await loadApp();

  test("fork links parent_id + branch_kind, branches route lists the family", async () => {
    const src = db.createConversation({ title: "Fil principal" });
    const u = db.createMessage({ conversation_id: src.id, role: "user", content: "J'ouvre la porte." });
    const a = db.createMessage({ conversation_id: src.id, role: "assistant", name: "Narrateur", content: "*La porte grince.*" });

    const forkRes = await api(routes, "POST", `/api/conversations/${src.id}/fork`, { upToMessageId: a.id });
    expect(forkRes.status).toBe(201);
    const fork = (await forkRes.json()) as any;
    expect(fork.parent_id).toBe(src.id);
    expect(fork.branch_kind).toBe("alternative");
    expect(db.listBranches(src.id).length).toBe(1);

    const fam = await (await api(routes, "GET", `/api/conversations/${fork.id}/branches`)).json();
    expect((fam.branches as any[]).length).toBe(2);
    expect((fam.branches as any[]).map((b: any) => b.id).sort()).toEqual([src.id, fork.id].sort());

    // mark the fork as canon via PATCH
    const patch = await api(routes, "PATCH", `/api/conversations/${fork.id}`, { branch_kind: "canon" });
    expect((await patch.json()).branch_kind).toBe("canon");
    const after = await (await api(routes, "GET", `/api/conversations/${fork.id}/branches`)).json();
    expect((after.branches as any[]).find((b: any) => b.id === fork.id).branch_kind).toBe("canon");

    void u;
  });

  test("runBackup writes an atomic db copy + checksum", async () => {
    const { runBackup } = await import("../src/server/backup");
    const { DATA_DIR } = await import("../src/server/paths");
    const dest = runBackup(true);
    expect(dest).not.toBeNull();
    const fs = await import("node:fs");
    const path = await import("node:path");
    expect(fs.existsSync(dest!)).toBe(true);
    expect(fs.existsSync(dest! + ".sha256")).toBe(true);
    // checksum matches the live DB content
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(fs.readFileSync(path.join(DATA_DIR, "app.db")));
    expect(fs.readFileSync(dest! + ".sha256", "utf8").trim()).toBe(hasher.digest("hex"));
  });

  test("coherence validate fails gracefully without a model", async () => {
    const conv = db.createConversation({ title: "Fil" });
    db.createMessage({ conversation_id: conv.id, role: "user", content: "Bonjour." });
    db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Salut.*" });
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/validate`);
    // no LM Studio in tests → the check can't run, but it must not crash
    expect([200, 502]).toContain(res.status);
    const body = (await res.json()) as any;
    if (res.status === 200) expect(Array.isArray(body.findings)).toBe(true);
    else expect(body.error).toContain("cohérence");
  });
});

describe("message meta: favoris & notes privées", async () => {
  const { db, routes } = await loadApp();

  test("meta-only PATCH (bookmark/note) never touches content or audio", async () => {
    const conv = db.createConversation({ title: "Meta" });
    const m = db.createMessage({
      conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Texte d'origine.*",
      audio: JSON.stringify([{ path: `/audio/${conv.id}/1-a.wav` }]),
      meta: JSON.stringify({ suggestions: ["a"] }),
    });
    const res = await api(routes, "PATCH", `/api/conversations/${conv.id}/messages/${m.id}`, { meta: { bookmark: 1, note: "Le joueur ignore le pacte" } });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as any;
    expect(updated.meta.bookmark).toBe(1);
    expect(updated.meta.note).toBe("Le joueur ignore le pacte");
    // content + audio untouched, suggestions kept (meta-only update)
    expect(updated.content).toBe("*Texte d'origine.*");
    expect(updated.audio).toHaveLength(1);
    expect(updated.meta.suggestions).toEqual(["a"]);

    // toggle bookmark off
    const off = await (await api(routes, "PATCH", `/api/conversations/${conv.id}/messages/${m.id}`, { meta: { bookmark: 0 } })).json();
    expect((off as any).meta.bookmark).toBe(0);
    expect((off as any).meta.note).toBe("Le joueur ignore le pacte");
  });
});

describe("world workspace: locations / lorebook / relations / timeline / jobs", async () => {
  const { db, routes, prompt } = await loadApp();

  test("locations: create, list, update, delete via API", async () => {
    const world = db.createWorld({ name: "Eldoria" });
    const created = await api(routes, "POST", `/api/worlds/${world.id}/locations`, { name: "Forêt d'Émeraude", description: "Vaste forêt", x: 30, y: 40 });
    expect(created.status).toBe(201);
    const loc = (await created.json()) as any;
    expect(loc.name).toBe("Forêt d'Émeraude");

    const list = await api(routes, "GET", `/api/worlds/${world.id}/locations`);
    expect(list.status).toBe(200);
    expect((await list.json()).locations).toHaveLength(1);

    const patched = await api(routes, "PATCH", `/api/locations/${loc.id}`, { name: "Forêt Noire" });
    expect((await patched.json()).name).toBe("Forêt Noire");

    const del = await api(routes, "DELETE", `/api/locations/${loc.id}`);
    expect(del.status).toBe(200);
    expect(db.listLocations(world.id)).toHaveLength(0);
  });

  test("lorebook: create + list, entries scoped to the world", async () => {
    const w1 = db.createWorld({ name: "A" });
    const w2 = db.createWorld({ name: "B" });
    const created = await api(routes, "POST", `/api/worlds/${w1.id}/lorebook`, {
      name: "La Guilde des Cendres", triggers: "guilde, cendres", content: "La guilde forge des armes maudites.", priority: 3,
    });
    expect(created.status).toBe(201);
    const e = (await created.json()) as any;
    expect(e.priority).toBe(3);

    expect((await (await api(routes, "GET", `/api/worlds/${w1.id}/lorebook`)).json()).entries).toHaveLength(1);
    expect((await (await api(routes, "GET", `/api/worlds/${w2.id}/lorebook`)).json()).entries).toHaveLength(0);

    const disabled = await api(routes, "PATCH", `/api/lorebook/${e.id}`, { enabled: 0 });
    expect((await disabled.json()).enabled).toBe(0);
  });

  test("activeLorebook matches triggers case-insensitively, respects enabled", () => {
    const world = db.createWorld({ name: "A" });
    db.createLorebookEntry({ world_id: world.id, name: "Guilde", triggers: "guilde, cendres", content: "…", priority: 1 });
    db.createLorebookEntry({ world_id: world.id, name: "Inactive", triggers: "dragon", content: "…", enabled: 0 });
    const active = db.activeLorebook(world.id, "*Il rejoint la GUILDE des cendres.*");
    expect(active.map((x: any) => x.name)).toEqual(["Guilde"]);
    expect(db.activeLorebook(world.id, "rien ici")).toHaveLength(0);
  });

  test("lorebook entries matching the recent text are injected into the system prompt", () => {
    const world = db.createWorld({ name: "Eldoria", lore: "Un royaume ancien." });
    db.createLorebookEntry({ world_id: world.id, name: "Guilde", triggers: "guilde", content: "La guilde dirige la ville.", priority: 2 });
    const conv = db.createConversation({ title: "P", world_id: world.id });
    const history = [db.createMessage({ conversation_id: conv.id, role: "user", content: "*Je frappe à la porte de la guilde.*" })];

    const withTrigger = prompt.buildMessages(
      { world, persona: null, cards: [], conversation: conv },
      history as any,
    );
    expect(withTrigger.system).toContain("Connaissances du monde");
    expect(withTrigger.system).toContain("La guilde dirige la ville.");

    const noTrigger = prompt.buildMessages(
      { world, persona: null, cards: [], conversation: conv },
      [{ ...history[0], content: "*Je dors.*" }] as any,
    );
    expect(noTrigger.system).not.toContain("Connaissances du monde");
  });

  test("relations: create + list", async () => {
    const world = db.createWorld({ name: "Eldoria" });
    const created = await api(routes, "POST", `/api/worlds/${world.id}/relations`, { from_name: "Alba", kind: "méfiance", to_name: "Kael" });
    expect(created.status).toBe(201);
    const list = await (await api(routes, "GET", `/api/worlds/${world.id}/relations`)).json();
    expect(list.relations).toHaveLength(1);
    expect(list.relations[0].kind).toBe("méfiance");
  });

  test("timeline: create + list + delete", async () => {
    const world = db.createWorld({ name: "Eldoria" });
    const created = await api(routes, "POST", `/api/worlds/${world.id}/timeline`, { label: "Jour 1 — Arrivée à Eldoria" });
    expect(created.status).toBe(201);
    const ev = (await created.json()) as any;
    const list = await (await api(routes, "GET", `/api/worlds/${world.id}/timeline`)).json();
    expect(list.events.map((e: any) => e.label)).toContain("Jour 1 — Arrivée à Eldoria");
    const del = await api(routes, "DELETE", `/api/timeline/${ev.id}`);
    expect(del.status).toBe(200);
    expect(db.listTimeline(world.id)).toHaveLength(0);
  });

  test("jobs: GET /api/jobs lists persisted jobs with status", async () => {
    db.createJob({ type: "tts", status: "running", progress: 40, payload: JSON.stringify({ marker: "ws-tts" }) });
    db.createJob({ type: "image", status: "failed", error: "CUDA OOM", payload: JSON.stringify({ marker: "ws-img" }) });
    const res = await api(routes, "GET", "/api/jobs");
    expect(res.status).toBe(200);
    const { jobs } = (await res.json()) as any;
    // scope to this file's jobs (other test files share the process in bun test)
    const mine = jobs.filter((j: any) => {
      try { return JSON.parse(j.payload || "{}").marker; } catch { return false; }
    });
    expect(mine.length).toBe(2);
    expect(mine.map((j: any) => j.type).sort()).toEqual(["image", "tts"]);
    const failed = mine.find((j: any) => j.type === "image");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("CUDA");
    // status filter returns at least our running job
    const running = (await (await api(routes, "GET", "/api/jobs?status=running")).json()).jobs;
    expect(running.some((j: any) => j.type === "tts" && j.progress === 40)).toBe(true);
  });
});

describe("structured memory & provider health", async () => {
  const { db, routes, prompt } = await loadApp();

  test("parseMemory handles fenced JSON, raw JSON and garbage", () => {
    const fenced = prompt.parseMemory('Voici :\n```json\n{"location": "Forêt", "characters": ["Alba"]}\n```');
    expect(fenced).toEqual({ location: "Forêt", characters: ["Alba"] });
    const raw = prompt.parseMemory('{"goals": ["Trouver la porte"], "items": []}');
    expect(raw?.goals).toEqual(["Trouver la porte"]);
    expect(raw?.items).toBeUndefined(); // empty arrays dropped
    expect(prompt.parseMemory("je n'ai pas pu produire de JSON")).toBeNull();
    expect(prompt.parseMemory("")).toBeNull();
    expect(prompt.parseMemory(42)).toBeNull();
    const rel = prompt.parseMemory('{"relationships": {"Alba": "méfiance"}}');
    expect(rel?.relationships).toEqual({ Alba: "méfiance" });
  });

  test("structured memory is injected into the system prompt", () => {
    const conv = db.createConversation({ title: "Mem" });
    const out = prompt.buildMessages(
      { world: null, persona: null, cards: [], conversation: conv, memory: { location: "Eldoria", characters: ["Alba"], goals: ["Trouver la source"] } },
      [] as any,
    );
    expect(out.system).toContain("Mémoire structurée");
    expect(out.system).toContain("📍 Lieu : Eldoria");
    expect(out.system).toContain("👥 Personnages : Alba");
  });

  test("PATCH conversation accepts a memory object and exposes it in the view", async () => {
    const conv = db.createConversation({ title: "Avec mémoire" });
    const res = await api(routes, "PATCH", `/api/conversations/${conv.id}`, {
      memory: { location: "La porte noire", characters: ["Kael"], relationships: { "Kael": "dette" } },
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as any;
    expect(view.memory.location).toBe("La porte noire");
    expect(view.memory.characters).toEqual(["Kael"]);
    expect(view.memory.relationships).toEqual({ Kael: "dette" });
    // readable summary is kept in sync for list views
    expect(view.summary).toContain("📍 Lieu : La porte noire");
    // raw column is not leaked
    expect("memory_json" in view).toBe(false);
    // conversation view from GET exposes it too
    const got = await (await api(routes, "GET", `/api/conversations/${conv.id}`)).json();
    expect((got as any).memory.location).toBe("La porte noire");
  });

  test("provider health records calls and aggregates stats", async () => {
    const health = await import("../src/server/health");
    health.resetHealth();
    health.recordCall("lmstudio", 120, true);
    health.recordCall("lmstudio", 80, true);
    health.recordCall("lmstudio", 900, false, "LM Studio (500): boom");
    const h = health.providerHealth().lmstudio;
    expect(h.calls).toBe(3);
    expect(h.ok).toBe(2);
    expect(h.errors).toBe(1);
    expect(h.lastError).toContain("boom");
    expect(h.history).toHaveLength(3);
    expect(h.history[2].ok).toBe(false);
    // history is capped
    for (let i = 0; i < 30; i++) health.recordCall("lmstudio", 10, true);
    expect(health.providerHealth().lmstudio.history.length).toBe(20);
    // GET /api/health/providers returns the stats
    const res = await api(routes, "GET", "/api/health/providers");
    expect(res.status).toBe(200);
    const stats = (await res.json()) as any;
    expect(typeof stats.lmstudio?.avgMs).toBe("number");
  });

  test("world gallery aggregates message images + cover/map with kind/character/seed/fav", async () => {
    const world = db.createWorld({ name: "Gal", tone: "épique" });
    const conv = db.createConversation({ world_id: world.id, title: "Partie gal" });
    db.createMessage({
      conversation_id: conv.id, role: "assistant", content: "*Scène épique.*",
      meta: JSON.stringify({ image: "/images/conversations/1/x.png", image_seed: 42, image_kind: "portrait", image_char: "Alba", image_fav: 1 }),
    });
    db.createMessage({ conversation_id: conv.id, role: "assistant", content: "*Paysage.*", meta: JSON.stringify({ image: "/images/conversations/1/y.png", image_seed: 7, image_kind: "landscape" }) });
    db.updateWorld(world.id, { cover: "/images/worlds/1/c.png", map: "/images/worlds/1/m.png" });
    const res = await api(routes, "GET", `/api/worlds/${world.id}/gallery`);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as any;
    expect(items).toHaveLength(4); // 2 message images + cover + map
    const msg1 = items.find((i: any) => i.seed === 42);
    expect(msg1.character).toBe("Alba");
    expect(msg1.kind).toBe("portrait");
    expect(msg1.fav).toBe(1);
    expect(msg1.conversation).toBe("Partie gal");
    const cover = items.find((i: any) => i.image.includes("c.png"));
    expect(cover.kind).toBe("landscape");
    // other-world conversations are excluded
    const other = db.createConversation({ title: "Autre monde" });
    db.createMessage({ conversation_id: other.id, role: "assistant", content: "*x*", meta: JSON.stringify({ image: "/images/conversations/9/z.png" }) });
    const r2 = (await (await api(routes, "GET", `/api/worlds/${world.id}/gallery`)).json()) as any;
    expect(r2.items).toHaveLength(4);
  });

  test("conversation gallery exposes image_kind/image_char/image_seed fields", async () => {
    const conv = db.createConversation({ title: "Gal conv" });
    db.createMessage({
      conversation_id: conv.id, role: "assistant", content: "*Scène.*",
      meta: JSON.stringify({ image: "/images/conversations/2/a.png", image_seed: 99, image_kind: "portrait", image_char: "Kael" }),
    });
    const res = await api(routes, "GET", `/api/conversations/${conv.id}/gallery`);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as any;
    expect(items[0].seed).toBe(99);
    expect(items[0].kind).toBe("portrait");
    expect(items[0].character).toBe("Kael");
  });

  test("timeline propose: no conversations → empty proposals, no model → 502", async () => {
    const world = db.createWorld({ name: "Solo" });
    // no conversations → the analyzer returns an empty proposal list (no LLM call)
    const empty = await api(routes, "POST", `/api/worlds/${world.id}/timeline/propose`);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as any).proposals).toEqual([]);
    // a conversation but no reachable model → graceful 502
    const conv = db.createConversation({ world_id: world.id, title: "Campagne" });
    db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Le voyage commence.*" });
    db.createMessage({ conversation_id: conv.id, role: "user", content: "J'avance vers la porte." });
    const res = await api(routes, "POST", `/api/worlds/${world.id}/timeline/propose`);
    expect(res.status).toBe(502);
  });

  test("timeline POST creates an event linked to a conversation", async () => {
    const world = db.createWorld({ name: "Lié" });
    const conv = db.createConversation({ world_id: world.id, title: "Partie" });
    const res = await api(routes, "POST", `/api/worlds/${world.id}/timeline`, { label: "Jour 1 — Arrivée", conversation_id: conv.id });
    expect(res.status).toBe(201);
    const ev = (await res.json()) as any;
    expect(ev.conversation_id).toBe(conv.id);
    expect(db.listTimeline(world.id)).toHaveLength(1);
  });

  test("soft delete → trash → restore → permanent delete keeps ids stable", async () => {
    const world = db.createWorld({ name: "À supprimer" });
    const card = db.createCard({ name: "Carte à supprimer" });
    const persona = db.createPersona({ name: "Persona à supprimer" });
    // delete moves to trash and hides from lists
    await api(routes, "DELETE", `/api/worlds/${world.id}`);
    await api(routes, "DELETE", `/api/cards/${card.id}`);
    await api(routes, "DELETE", `/api/personas/${persona.id}`);
    expect(db.listWorlds().some((w: any) => w.id === world.id)).toBe(false);
    expect(db.listCards().some((c: any) => c.id === card.id)).toBe(false);
    expect(db.listPersonas().some((p: any) => p.id === persona.id)).toBe(false);
    const trash = (await (await api(routes, "GET", "/api/trash")).json()) as any;
    expect(trash.items.map((i: any) => i.type + ":" + i.id).sort()).toEqual(["card:" + card.id, "persona:" + persona.id, "world:" + world.id].sort());
    // restore keeps the ORIGINAL id (references stay valid)
    const res = await api(routes, "POST", "/api/trash/restore", { type: "world", id: world.id });
    expect(res.status).toBe(200);
    expect(db.getWorld(world.id)!.name).toBe("À supprimer");
    expect(db.listWorlds().some((w: any) => w.id === world.id)).toBe(true);
    // permanent delete removes for good
    await api(routes, "POST", "/api/trash/permanent", { type: "card", id: card.id });
    expect(db.getCard(card.id)).toBeNull();
    const trash2 = (await (await api(routes, "GET", "/api/trash")).json()) as any;
    expect(trash2.items.some((i: any) => i.type === "card" && i.id === card.id)).toBe(false);
  });

  test("DM directives are injected only when dm_pending is set", () => {
    const conv = db.createConversation({ title: "DM", settings: JSON.stringify({ dm: { tension: 80, focus: "Alba", reveal: "L'identité du mage", pace: "rapide", style: "Horreur", length: "courte" }, dm_pending: true }) });
    const out = prompt.buildMessages({ world: null, persona: null, cards: [], conversation: conv }, [] as any);
    expect(out.system).toContain("Directives du maître de jeu");
    expect(out.system).toContain("Tension : élevée, urgente et oppressante (80/100)");
    expect(out.system).toContain("Mets Alba au premier plan");
    expect(out.system).toContain("L'identité du mage");
    expect(out.system).toContain("Rythme rapide");
    // not pending → no injection
    const idle = db.createConversation({ title: "DM2", settings: JSON.stringify({ dm: { tension: 80 } }) });
    const out2 = prompt.buildMessages({ world: null, persona: null, cards: [], conversation: idle }, [] as any);
    expect(out2.system).not.toContain("Directives du maître de jeu");
  });

  test("export-md renders a Markdown book with chapters, memory and messages", async () => {
    const world = db.createWorld({ name: "Eldoria" });
    const conv = db.createConversation({ world_id: world.id, title: "La quête", memory_json: JSON.stringify({ location: "Forêt", characters: ["Alba"] }), summary: "📍 Lieu : Forêt" });
    db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Le vent se lève.*", created_at: 1000 });
    db.createMessage({ conversation_id: conv.id, role: "user", content: "J'avance.", created_at: 2000 });
    const res = await api(routes, "GET", `/api/conversations/${conv.id}/export-md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("# La quête");
    expect(text).toContain("**Monde :** Eldoria");
    expect(text).toContain("## Mémoire");
    expect(text).toContain("📍 Lieu : Forêt");
    expect(text).toContain("## Chapitre 1");
    expect(text).toContain("> **Narrateur** : *Le vent se lève.*");
    expect(text).toContain("**Moi** : J'avance.");
    expect(text).toContain("---"); // scene break
  });

  test("bulk-delete removes exactly the selected message ids", async () => {
    const conv = db.createConversation({ title: "Sélection" });
    const a = db.createMessage({ conversation_id: conv.id, role: "assistant", content: "A" });
    const b = db.createMessage({ conversation_id: conv.id, role: "assistant", content: "B" });
    const c = db.createMessage({ conversation_id: conv.id, role: "assistant", content: "C" });
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/messages/bulk-delete`, { ids: [a.id, c.id] });
    expect(res.status).toBe(200);
    const r = (await res.json()) as any;
    expect(r.removed).toBe(2);
    const remaining = db.listMessages(conv.id).map((m: any) => m.id);
    expect(remaining).toEqual([b.id]);
    // empty selection is rejected
    const bad = await api(routes, "POST", `/api/conversations/${conv.id}/messages/bulk-delete`, { ids: [] });
    expect(bad.status).toBe(400);
  });

  test("tracked() wraps a provider and records stream/complete/models calls", async () => {
    const health = await import("../src/server/health");
    health.resetHealth();
    const fake = {
      id: "lmstudio", label: "fake",
      configured: () => true,
      models: async () => ["m1"],
      async *stream(): AsyncGenerator<string> { yield "a"; yield "b"; },
      complete: async () => "ok",
    };
    const t = health.tracked(fake as any);
    expect((await t.models()).join()).toBe("m1");
    expect(await t.complete({ messages: [] } as any)).toBe("ok");
    const parts: string[] = [];
    for await (const c of t.stream({ messages: [] } as any)) parts.push(c);
    expect(parts.join()).toBe("a,b");
    const h = health.providerHealth().lmstudio;
    expect(h.calls).toBe(3);
    expect(h.ok).toBe(3);
    // failures are recorded and rethrown
    const failing = { ...fake, complete: async () => { throw new Error("nope"); } };
    const tf = health.tracked(failing as any);
    await expect(tf.complete({ messages: [] } as any)).rejects.toThrow("nope");
    expect(health.providerHealth().lmstudio.errors).toBe(1);
  });

  test("world narration_style overrides the global narrator preset in the prompt", () => {
    const world = db.createWorld({ name: "Sombra", narration_style: "sarcastique" });
    const conv = db.createConversation({ world_id: world.id, title: "Dans Sombra" });
    const out = prompt.buildMessages({ world, persona: null, cards: [], conversation: conv }, [] as any);
    expect(out.system).toContain("## Style du narrateur");
    expect(out.system).toContain("Sarcastique et mordant");
    // legacy free-text values that don't match any preset key fall back to the GLOBAL style
    const styleLine = (s: string) => s.split("## Style du narrateur\n")[1]?.split("\n")[0] ?? "";
    const baseline = prompt.buildMessages({ world: null, persona: null, cards: [], conversation: db.createConversation({ title: "B" }) }, [] as any);
    const legacyWorld = db.createWorld({ name: "Vieux", narration_style: "immersive et cinématique" });
    const conv2 = db.createConversation({ world_id: legacyWorld.id, title: "D" });
    const out2 = prompt.buildMessages({ world: legacyWorld, persona: null, cards: [], conversation: conv2 }, [] as any);
    expect(styleLine(out2.system)).toBe(styleLine(baseline.system));
    expect(out2.system).not.toContain("immersive et cinématique");
  });

  test("export-md?branch=canon keeps only main + canon branches in chronological order", async () => {
    const root = db.createConversation({ title: "Racine" });
    db.createMessage({ conversation_id: root.id, role: "user", content: "Début", created_at: 1000 });
    db.createMessage({ conversation_id: root.id, role: "assistant", name: "Narrateur", content: "*La route s'ouvre.*", created_at: 2000 });
    const alt = db.createConversation({ parent_id: root.id, title: "Variante" });
    db.createMessage({ conversation_id: alt.id, role: "assistant", name: "Narrateur", content: "*Variante abandonnée.*", created_at: 3000 });
    const canon = db.createConversation({ parent_id: root.id, title: "Canon" });
    db.createMessage({ conversation_id: canon.id, role: "assistant", name: "Narrateur", content: "*Le pacte est scellé.*", created_at: 4000 });
    await api(routes, "PATCH", `/api/conversations/${canon.id}`, { branch_kind: "canon" });
    await api(routes, "PATCH", `/api/conversations/${alt.id}`, { branch_kind: "abandoned" });

    const res = await api(routes, "GET", `/api/conversations/${alt.id}/export-md?branch=canon`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("La route s'ouvre"); // main branch kept
    expect(text).toContain("Le pacte est scellé"); // canon branch kept
    expect(text).not.toContain("Variante abandonnée"); // abandoned/alternative excluded
    expect(text.indexOf("La route s'ouvre")).toBeLessThan(text.indexOf("Le pacte est scellé")); // chronological
  });

  test("cache endpoints report sizes and purge the audio cache", async () => {
    const info = await (await api(routes, "GET", "/api/cache")).json();
    expect(typeof info.audio.files).toBe("number");
    expect(typeof info.audio.mb).toBe("number");
    expect(typeof info.imageOrphans.files).toBe("number");
    const purge = await api(routes, "POST", "/api/cache/purge", { audio: true });
    expect(purge.status).toBe(200);
    const r = (await purge.json()) as any;
    expect(r.ok).toBe(true);
    expect(typeof r.removed).toBe("number");
  });
});
