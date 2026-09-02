import { describe, test, expect } from "bun:test";
import { loadApp, api } from "./helpers";

const routesMod = await import("../src/server/routes");

describe("relationship graph (affinities)", async () => {
  const { db, routes } = await loadApp();

  function seedConv(n = 0) {
    const conv = db.createConversation({ title: "Rels" });
    for (let i = 0; i < n; i++) {
      db.createMessage({
        conversation_id: conv.id,
        role: i % 2 === 0 ? "user" : "assistant",
        name: i % 2 === 0 ? "" : "Alba",
        content: i % 2 === 0 ? `Le joueur agit ${i}.` : `*Alba réagit ${i}.*`,
      });
    }
    return conv;
  }

  test("GET returns null when nothing was ever scanned", async () => {
    const conv = seedConv(2);
    const res = await api(routes, "GET", `/api/conversations/${conv.id}/relations`);
    expect(res.status).toBe(200);
    expect((await res.json()).rels).toBeNull();
  });

  test("mergeRels: fresh pairs overwrite, unlisted pairs persist, directions are distinct", () => {
    const { mergeRels } = routesMod;
    const prev = {
      at: 1, last_msg_id: 9,
      pairs: [
        { a: "Alba", b: "Kael", value: 40, note: "alliés", at: 1 },
        { a: "Kael", b: "Alba", value: 10, note: "chaleureux", at: 1 },
        { a: "Alba", b: "Roi", value: -50, note: "méfiance", at: 1 },
      ],
    };
    const fresh = [
      { a: "Alba", b: "Kael", value: 55, note: "complice après la bataille", at: 2 },
      { a: "Kael", b: "Alba", value: 10, note: "chaleureux", at: 2 }, // identical → no change
    ];
    const { pairs, changed } = mergeRels(prev, fresh);
    expect(changed).toBe(1); // only Alba→Kael changed
    expect(pairs.length).toBe(3); // no new pair
    const albaKael = pairs.find((p) => p.a === "Alba" && p.b === "Kael");
    expect(albaKael?.value).toBe(55);
    expect(albaKael?.note).toContain("complice");
    // untouched pair survives (the graph accumulates across scans)
    expect(pairs.find((p) => p.a === "Alba" && p.b === "Roi")?.value).toBe(-50);
  });

  test("mergeRels counts a change only when value or note differ", () => {
    const { mergeRels } = routesMod;
    const prev = { at: 1, last_msg_id: 1, pairs: [{ a: "A", b: "B", value: 5, note: "n", at: 1 }] };
    const same = mergeRels(prev, [{ a: "A", b: "B", value: 5, note: "n", at: 2 }]);
    expect(same.changed).toBe(0);
    const diff = mergeRels(prev, [{ a: "A", b: "B", value: 5, note: "autre", at: 2 }]);
    expect(diff.changed).toBe(1);
  });

  test("auto scan is refused when the party is too short (no model call)", async () => {
    const conv = seedConv(1);
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/relations`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanned).toBe(false);
    expect(body.reason).toBe("empty");
  });

  test("auto scan waits for enough new story since the last scan", async () => {
    const conv = seedConv(3); // min is 6 fresh messages
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/relations`, {});
    const body = await res.json();
    expect(body.scanned).toBe(false);
    expect(body.reason).toBe("threshold");
    expect(body.have).toBe(3);
  });

  test("auto scan is throttled right after a previous scan", async () => {
    const conv = seedConv(8);
    db.updateConversation(conv.id, {
      settings: JSON.stringify({ rels: { at: Date.now(), last_msg_id: 0, pairs: [] } }),
    });
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/relations`, {});
    const body = await res.json();
    expect(body.scanned).toBe(false);
    expect(body.reason).toBe("throttle");
  });

  test("reset clears the stored graph and its settings key", async () => {
    const conv = seedConv(2);
    db.updateConversation(conv.id, {
      settings: JSON.stringify({
        rels: { at: Date.now(), last_msg_id: 2, pairs: [{ a: "Alba", b: "Kael", value: 30, note: "x", at: 1 }] },
      }),
    });
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/relations/reset`, {});
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const settings = JSON.parse(db.getConversation(conv.id)!.settings);
    expect("rels" in settings).toBe(false);
    const got = await api(routes, "GET", `/api/conversations/${conv.id}/relations`);
    expect((await got.json()).rels).toBeNull();
  });

  test("unknown conversations answer 404 on the relations endpoints", async () => {
    expect((await api(routes, "GET", "/api/conversations/999999/relations")).status).toBe(404);
    expect((await api(routes, "POST", "/api/conversations/999999/relations", {})).status).toBe(404);
    expect((await api(routes, "POST", "/api/conversations/999999/relations/reset", {})).status).toBe(404);
  });
});
