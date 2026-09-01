import { describe, test, expect } from "bun:test";
import { loadApp, api } from "./helpers";

describe("time loops: checkpoints & rewind (RE:ZERO)", async () => {
  const { db, routes, prompt } = await loadApp();

  test("checkpoint requires a non-empty thread; returns a snapshot", async () => {
    const conv = db.createConversation({ title: "Café" });
    const empty = await api(routes, "POST", `/api/conversations/${conv.id}/checkpoint`, { note: "x" });
    expect(empty.status).toBe(400);

    db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Elle s'approche.*" });
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/checkpoint`, { note: "avant le café" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.count).toBe(1);
    expect(body.checkpoint.note).toBe("avant le café");
    expect(body.checkpoint.snapshot.summary).toBe("");
  });

  test("rewind restores the snapshot, shelves an abandoned branch, logs a loop", async () => {
    const conv = db.createConversation({ title: "Café", settings: JSON.stringify({ loop_mem_narrator: 3, loop_mem_player: 1 }) });
    const a = db.createMessage({ conversation_id: conv.id, role: "user", content: "J'entre dans le café." });
    const b = db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Mila", content: "*Elle te sourit.*", meta: JSON.stringify({ image: "/images/conversations/1/x.png" }) });
    // mark the checkpoint here (a + b), then play forward
    await api(routes, "POST", `/api/conversations/${conv.id}/checkpoint`, { note: "au café" });
    db.updateConversation(conv.id, { memory_json: JSON.stringify({ location: "rue", characters: ["Mila"], goals: ["rentrer"], facts: ["orage"], items: [], relationships: {} }) });
    const c = db.createMessage({ conversation_id: conv.id, role: "user", content: "Je dis une bêtise." });
    const d = db.createMessage({ conversation_id: conv.id, role: "assistant", name: "Mila", content: "*Elle se lève, déçue.*", meta: JSON.stringify({ image: "/images/conversations/1/x.png" }) });
    void a; void c; void d;

    const res = await api(routes, "POST", `/api/conversations/${conv.id}/return`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.truncated).toBe(2);

    // thread truncated: only [a, b] + the rewind marker remain
    const msgs = db.listMessages(conv.id);
    expect(msgs.length).toBe(3);
    expect(msgs[0].id).toBe(a.id);
    expect(msgs[1].id).toBe(b.id);
    const marker = msgs[2];
    expect(JSON.parse(marker.meta).rewind).toBe(true);

    // strict RE:ZERO: memory restored to the checkpoint value (empty here)
    const after = db.getConversation(conv.id)!;
    expect(after.memory_json).toBe("");

    // last_message recaled on the checkpoint message
    expect(after.last_message).toContain("*Elle te sourit.*");

    // loop journal got an entry pointing to a restorable abandoned branch
    const loops = await api(routes, "GET", `/api/conversations/${conv.id}/loops`);
    expect(loops.status).toBe(200);
    const lj = await loops.json();
    expect(lj.loops.length).toBe(1);
    expect(lj.loops[0].checkpoint_n).toBe(1);
    expect(lj.loops[0].branch).toBeGreaterThan(0);
    // the branch is a real conversation carrying the doomed stretch
    const branch = db.getConversation(lj.loops[0].branch)!;
    expect(branch.branch_kind).toBe("abandoned");
    expect(branch.parent_id).toBe(conv.id);
    const branchMsgs = db.listMessages(branch.id);
    expect(branchMsgs.length).toBe(2);
    // the illustration was copied along with the doomed stretch
    const copied = branchMsgs.find((m) => JSON.parse(m.meta).image);
    expect(copied).toBeTruthy();
    expect(JSON.parse(copied!.meta).image).toContain(".png");

    // the popped checkpoint lets the next return target the *previous* one — here none
    expect(lj.checkpoints.length).toBe(0);
    const again = await api(routes, "POST", `/api/conversations/${conv.id}/return`, {});
    expect(again.status).toBe(400);
  });

  test("narrator memory sliders gate the system prompt (loopMemoryText)", async () => {
    const cs = { loop_mem_narrator: 3, loop_mem_player: 0, loops: [
      { n: 1, title: "Faux pas", summary: "Lejoueur a mal répondu." },
      { n: 2, title: "La vérité", summary: "Mila a découvert le secret." },
    ] };
    const text = prompt.loopMemoryText(cs.loops);
    expect(text).toContain("Mila a découvert le secret.");
    expect(text).toContain("Faux pas");
    // budget truncation: an absurdly small budget still keeps the freshest loop
    const tiny = prompt.loopMemoryText(cs.loops, 5);
    expect(tiny).toContain("Mila a découvert le secret.");
    expect(tiny).not.toContain("Faux pas");
  });

  test("buildMessages drops rewind markers; buildSystemPrompt injects loops when narrator >= 1", () => {
    const conv = db.createConversation({ title: "P", settings: JSON.stringify({
      loop_mem_narrator: 3, loop_mem_player: 1,
      loops: [{ n: 1, title: "Faux pas", summary: "Une gaffe et Mila est partie." }],
    }) });
    const history = [
      { id: 1, conversation_id: conv.id, role: "user", name: "", content: "Bonjour", segments: "[]", audio: "[]", meta: "{}", created_at: 1 },
      { id: 2, conversation_id: conv.id, role: "assistant", name: "", content: "🔁 Retour au point 1", segments: "[]", audio: "[]", meta: JSON.stringify({ rewind: true }), created_at: 2 },
      { id: 3, conversation_id: conv.id, role: "assistant", name: "Mila", content: '*"Salut."*', segments: "[]", audio: "[]", meta: "{}", created_at: 3 },
    ];
    const out = prompt.buildMessages({ world: null, persona: null, cards: [], scenario: null, conversation: conv }, history);
    expect(out.messages).toHaveLength(2);
    expect(out.messages.some((m) => m.content.includes("Retour"))).toBe(false);
    // narrator is set (3) → the loop memory is in the system prompt
    expect(out.system).toContain("Faux pas");
    expect(out.system).toContain("assume le retour");
  });

  test("loopMemoryText is stable when not looping", () => {
    expect(prompt.loopMemoryText([])).toBe("");
  });

  test("per-game lorebook: save, triggers, injection", async () => {
    const conv = db.createConversation({ title: "Café" });
    const entries = [
      { key: "k1", name: "Guilde des Ombres", triggers: "guilde, ombre", content: "La Guilde des Ombres contrôle le port.", enabled: 1, at: Date.now() },
      { key: "k2", name: "Le secret de Mila", triggers: "secret", content: "Mila est une revenante.", enabled: 1, at: Date.now() },
    ];
    const save = await api(routes, "POST", `/api/conversations/${conv.id}/lore`, { entries });
    expect(save.status).toBe(200);
    const body = await save.json();
    expect(body.entries).toHaveLength(2);

    // persisted in settings, not in a separate table
    const stored = JSON.parse(db.getConversation(conv.id)!.settings);
    expect(stored.lore_entries).toHaveLength(2);

    // trigger matching: only the fact whose keyword appears in the fiction is active
    const savedSettings = JSON.parse(db.getConversation(conv.id)!.settings);
    const active = prompt.activeConvLore(JSON.stringify(savedSettings), "tu vois une guilde au loin.");
    expect(active.map((e) => e.name)).toEqual(["Guilde des Ombres"]);

    // disabled entries never fire
    await api(routes, "POST", `/api/conversations/${conv.id}/lore`, { entries: entries.map((e, i) => ({ ...e, enabled: i === 0 ? 0 : 1 })) });
    const reloaded = JSON.parse(db.getConversation(conv.id)!.settings);
    expect(prompt.activeConvLore(JSON.stringify(reloaded), "la guilde approche").map((e) => e.name)).toEqual([]);

    // buildMessages merges them into the system prompt (world is null here);
    // only the still-enabled entry fires on its trigger
    const history = [
      { id: 1, conversation_id: conv.id, role: "user", name: "", content: "J'approche du secret de Mila.", segments: "[]", audio: "[]", meta: "{}", created_at: 1 },
    ];
    const out = prompt.buildMessages({ world: null, persona: null, cards: [], scenario: null, conversation: { ...conv, settings: JSON.stringify(reloaded) } }, history);
    expect(out.system).toContain("Le secret de Mila");
    expect(out.system).toContain("revenante");
    expect(out.system).not.toContain("Guilde des Ombres");
  });
});