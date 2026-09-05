import { describe, test, expect } from "bun:test";
import { loadApp, api } from "./helpers";

describe("session recap (Previously on…)", async () => {
  const { db, routes, prompt } = await loadApp();

  function seedConversation(title = "Reprise", n = 0) {
    const conv = db.createConversation({ title });
    for (let i = 0; i < n; i++) {
      db.createMessage({
        conversation_id: conv.id,
        role: i % 2 === 0 ? "user" : "assistant",
        name: i % 2 === 0 ? "" : "Narrateur",
        content: i % 2 === 0 ? `Le joueur agit ${i}.` : `*Le narrateur décrit ${i}.*`,
      });
    }
    return conv;
  }

  test("POST recap refuses below the threshold (no model call) and persists nothing", async () => {
    const conv = seedConversation("Courte", 5);
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/recap`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.reason).toBe("threshold");
    expect(body.needed).toBe(6);

    const got = await api(routes, "GET", `/api/conversations/${conv.id}/recap`);
    expect((await got.json()).recap).toBeNull();
  });

  test("freshness only counts story messages written after the last recap", async () => {
    const conv = seedConversation("Reprise", 8);
    const msgs = db.listMessages(conv.id);
    // pretend a recap was made after message #5 (index 4)
    db.updateConversation(conv.id, {
      settings: JSON.stringify({
        recap: { at: Date.now(), last_msg_id: msgs[4].id, title: "Ancien", text: "x", shots: [] },
      }),
    });
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/recap`, {});
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.reason).toBe("threshold");
    expect(body.have).toBe(3);
  });

  test("chapter markers do not count as new story", async () => {
    const conv = seedConversation("Marqueurs", 5);
    // add a display-only chapter marker: without the exclusion it would push
    // the count to 6 and cross the threshold
    db.createMessage({
      conversation_id: conv.id, role: "assistant", name: "",
      content: "📖 Chapitre 1 — L'éveil", meta: JSON.stringify({ chapter: true }),
    });
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/recap`, {});
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.reason).toBe("threshold");
    expect(body.have).toBe(5); // marker excluded
  });

  test("stored recap is served by GET and injected into the system prompt", async () => {
    const conv = seedConversation("Injectée");
    const recap = {
      at: 1725000000000,
      last_msg_id: 7,
      title: "La chute de Valdore",
      text: "La cité est tombée sous les ombres.",
      shots: [{ caption: "Les remparts", prompt: "burning city walls at dusk", status: "done", image: "/images/x.png", seed: 1 }],
    };
    db.updateConversation(conv.id, { settings: JSON.stringify({ recap, context_mode: "avance" }) });

    const res = await api(routes, "GET", `/api/conversations/${conv.id}/recap`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recap.title).toBe("La chute de Valdore");
    expect(body.recap.shots[0].status).toBe("done");

    const ctx = { world: null, persona: null, cards: [], scenario: null, conversation: db.getConversation(conv.id)! };
    const sys = prompt.buildSystemPrompt(ctx);
    // avancé mode → the recap lands in the unified memory block
    expect(sys).toContain("Mémoire pertinente");
    expect(sys).toContain("La chute de Valdore");
    expect(sys).toContain("La cité est tombée sous les ombres.");
  });

  test("recap is not injected when settings carry no recap", async () => {
    const conv = seedConversation("Sans récap");
    const sys = prompt.buildSystemPrompt({
      world: null, persona: null, cards: [], scenario: null, conversation: db.getConversation(conv.id)!,
    });
    expect(sys).not.toContain("Récapitulatif");
  });

  test("shots retry on a finished recap re-queues nothing and reports ok", async () => {
    const conv = seedConversation("Shots");
    db.updateConversation(conv.id, {
      settings: JSON.stringify({
        recap: {
          at: Date.now(), last_msg_id: 0, title: "T", text: "Texte",
          shots: [{ caption: "a", prompt: "p", status: "done", image: "/i.png", seed: 3 }],
        },
      }),
    });
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/recap/shots`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(0);
  });

  test("shots retry without any recap reports no-recap", async () => {
    const conv = seedConversation("Vide");
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/recap/shots`, {});
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.reason).toBe("no-recap");
  });

  test("unknown conversations answer 404 on both recap endpoints", async () => {
    expect((await api(routes, "GET", "/api/conversations/999999/recap")).status).toBe(404);
    expect((await api(routes, "POST", "/api/conversations/999999/recap", {})).status).toBe(404);
  });
});
