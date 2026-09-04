import { describe, test, expect, afterAll } from "bun:test";
import { loadApp, api, isolated, uid } from "./helpers";
import { placeholderPng, withCharaChunk } from "../src/server/cardExport";

describe("bug-hunt regressions", async () => {
  const { db, routes } = await loadApp();
  const MISSING = 987654321;

  // the suite shares one DB per process: create through the isolation helper
  // and clean up afterwards so count-sensitive tests (restore/export) keep
  // passing regardless of file order
  const t = isolated(db);
  afterAll(() => t.cleanup());

  test("trash restore/permanent on a missing id is 404, not a fake ok", async () => {
    for (const path of ["/api/trash/restore", "/api/trash/permanent"]) {
      const res = await api(routes, "POST", path, { type: "card", id: MISSING });
      expect(res.status).toBe(404);
    }
    const badType = await api(routes, "POST", "/api/trash/restore", { type: "nope", id: 1 });
    expect(badType.status).toBe(404);
  });

  test("personas PATCH validates field types (no [object Object], no 500)", async () => {
    const p = t.persona({ name: uid("P"), description: "d" });
    const bad = await api(routes, "PATCH", `/api/personas/${p.id}`, { name: { x: 1 } });
    expect(bad.status).toBe(400);
    expect(db.getPersona(p.id)?.name).toBe(p.name);
    const good = await api(routes, "PATCH", `/api/personas/${p.id}`, { name: uid("P2") });
    expect(good.status).toBe(200);
  });

  test("cards POST/PATCH validate field types", async () => {
    const bad = await api(routes, "POST", "/api/cards", { name: { x: 1 } });
    expect(bad.status).toBe(400);
    const c = t.card({ name: uid("C") });
    const badPatch = await api(routes, "PATCH", `/api/cards/${c.id}`, { name: 12345 });
    expect(badPatch.status).toBe(400);
    expect(db.getCard(c.id)?.name).toBe(c.name);
  });

  test("import with an unreadable base64 file reports per-file invalid, not 500", async () => {
    const res = await api(routes, "POST", "/api/import", { files: [{ name: "x.png", base64: "!!!not-base64!!!" }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report[0].status).toBe("invalid");
  });

  test("locations/lorebook/relations reject NaN-ish coords and validate PATCH", async () => {
    const w = t.world({ name: uid("W") });
    const badX = await api(routes, "POST", `/api/worlds/${w.id}/locations`, { name: "L", x: "abc" });
    expect(badX.status).toBe(400);
    const loc = await (await api(routes, "POST", `/api/worlds/${w.id}/locations`, { name: "L", x: 30, y: 40 })).json();
    t.ids.locations.push(loc.id);
    const badPatch = await api(routes, "PATCH", `/api/locations/${loc.id}`, { x: "abc" });
    expect(badPatch.status).toBe(400);
    const goodPatch = await api(routes, "PATCH", `/api/locations/${loc.id}`, { name: "L2" });
    expect(goodPatch.status).toBe(200);

    const badPrio = await api(routes, "POST", `/api/worlds/${w.id}/lorebook`, {
      name: "E", triggers: "t", content: "c", priority: "abc",
    });
    expect(badPrio.status).toBe(400);
    const entry = await (await api(routes, "POST", `/api/worlds/${w.id}/lorebook`, {
      name: "E", triggers: "t", content: "c", priority: 3,
    })).json();
    t.ids.lore.push(entry.id);
    const badRel = await api(routes, "PATCH", `/api/lorebook/${entry.id}`, { priority: "abc" });
    expect(badRel.status).toBe(400);

    const rel = t.relation({ world_id: w.id, from_name: "A", to_name: "B", kind: "ami" });
    const badRel2 = await api(routes, "PATCH", `/api/relations/${rel.id}`, { from_name: { x: 1 } });
    expect(badRel2.status).toBe(400);
  });

  test("DELETE /messages/:id removes only that message", async () => {
    const conv = t.conv({ title: uid("Del") });
    const m1 = db.createMessage({ conversation_id: conv.id, role: "user", content: "un" });
    const m2 = db.createMessage({ conversation_id: conv.id, role: "assistant", name: "N", content: "deux" });
    const m3 = db.createMessage({ conversation_id: conv.id, role: "user", content: "trois" });
    const res = await api(routes, "DELETE", `/api/conversations/${conv.id}/messages/${m2.id}`);
    expect(res.status).toBe(200);
    const left = db.listMessages(conv.id).map((m: any) => m.id).sort();
    expect(left).toEqual([m1.id, m3.id].sort());
  });

  test("jobs retry distinguishes missing / running / non-retryable", async () => {
    const miss = await api(routes, "POST", `/api/jobs/${MISSING}/retry`, {});
    expect(miss.status).toBe(404);
    const running = db.createJob({ type: "image", status: "running", title: "R" });
    const busy = await api(routes, "POST", `/api/jobs/${running.id}/retry`, {});
    expect(busy.status).toBe(409);
    const done = db.createJob({ type: "nope-unknown-type", status: "failed", title: "F" });
    const noHandler = await api(routes, "POST", `/api/jobs/${done.id}/retry`, {});
    expect(noHandler.status).toBe(400);
  });

  test("cardExport: placeholder caps size, non-PNG yields null (no corrupt card)", () => {
    const big = placeholderPng(100000);
    expect(big[0]).toBe(0x89);
    expect(big.length).toBeLessThan(10 * 1024 * 1024);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44]);
    expect(withCharaChunk(jpeg, "{}")).toBeNull();
    const png = placeholderPng(32);
    expect(withCharaChunk(png, '{"a":1}')).not.toBeNull();
  });

  test("isolation helper removes everything it created", async () => {
    const w = t.world({ name: uid("Tmp") });
    const c = t.conv({ title: uid("Tmp"), world_id: w.id });
    db.createMessage({ conversation_id: c.id, role: "user", content: "x" });
    t.location({ world_id: w.id, name: "L" });
    expect(db.getWorld(w.id)).toBeDefined();
    t.cleanup();
    expect(db.getWorld(w.id)).toBeNull();
    expect(db.getConversation(c.id)).toBeNull();
    expect(db.listMessages(c.id)).toHaveLength(0);
    expect(db.listLocations(w.id)).toHaveLength(0);
  });
});
