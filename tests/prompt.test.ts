import { describe, test, expect } from "bun:test";
import { loadApp } from "./helpers";

const { prompt } = await loadApp();

describe("parseSegments", () => {
  test("separates narration and dialogue lines", () => {
    const segs = prompt.parseSegments(
      "*Le vent se leva dans la plaine.*\nAlba: \"Tu es enfin arrivé.\"\n*Elle sourit, la lame à la main.*",
    );
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ type: "narration", text: "Le vent se leva dans la plaine." });
    expect(segs[1]).toMatchObject({ type: "dialogue", speaker: "Alba", text: "Tu es enfin arrivé." });
    expect(segs[2]).toMatchObject({ type: "narration", speaker: "" });
  });

  test("dialogue and narration on the same line", () => {
    const segs = prompt.parseSegments(`Kael: "Approche." *Il dégaine son épée de cristal.*`);
    expect(segs).toHaveLength(2);
    expect(segs[0].type).toBe("dialogue");
    expect(segs[1].type).toBe("narration");
  });

  test("falls back to non-italic lines as narration", () => {
    const segs = prompt.parseSegments("La brume s'épaissit autour du temple.");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ type: "narration", speaker: "" });
  });

  test("fallbackSpeaker assigns unnamed dialogue to the first cast member", () => {
    const segs = prompt.parseSegments('"Qui va là ?"');
    const withSpeaker = prompt.fallbackSpeaker(segs, ["Alba", "Kael"]);
    expect(withSpeaker[0].speaker).toBe("Alba");
    expect(withSpeaker[0].type).toBe("dialogue");
  });

  test("estimateTokens is a sane heuristic", () => {
    expect(prompt.estimateTokens("Un petit texte.")).toBeGreaterThan(0);
    expect(prompt.estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("buildSystemPrompt", async () => {
  const { db } = await loadApp();
  test("includes summary + narrator style without persona", () => {
    const conv = db.createConversation({ title: "P" });
    const ctx = { world: null, persona: null, cards: [], scenario: null, conversation: conv, summary: "Le groupe a atteint la cité." };
    const sys = prompt.buildSystemPrompt(ctx);
    expect(sys).toContain("Mémoire pertinente");
    expect(sys).toContain("Le groupe a atteint la cité.");
    expect(sys).toContain("partenaire de roleplay");
  });

  test("narrator never speaks: format section present", () => {
    const conv = db.createConversation({ title: "P" });
    const sys = prompt.buildSystemPrompt({ world: null, persona: null, cards: [], scenario: null, conversation: conv });
    expect(sys).toContain("raconte en narration entre astérisques");
    expect(sys).toContain("Ne fais JAMAIS agir, parler, penser ou décider à la place du joueur");
    // the default profile must not push forced plot movement
    expect(sys).not.toContain("rebondissements");
    expect(sys).toContain("partenaire de roleplay");
  });

  test("buildMessages maps roles 1:1", () => {
    const conv = db.createConversation({ title: "P" });
    const history = [
      { id: 1, conversation_id: conv.id, role: "user", name: "", content: "Bonjour", segments: "[]", audio: "[]", meta: "{}", created_at: 1 },
      { id: 2, conversation_id: conv.id, role: "assistant", name: "Alba", content: '*"Salut."*', segments: "[]", audio: "[]", meta: "{}", created_at: 2 },
    ];
    const out = prompt.buildMessages({ world: null, persona: null, cards: [], scenario: null, conversation: conv }, history);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toEqual({ role: "user", content: "Bonjour" });
    expect(out.messages[1].role).toBe("assistant");
  });

  test("chapter markers are display-only: never sent to the model", () => {
    const conv = db.createConversation({ title: "P" });
    const history = [
      { id: 1, conversation_id: conv.id, role: "user", name: "", content: "J'entre dans la grotte.", segments: "[]", audio: "[]", meta: "{}", created_at: 1 },
      { id: 2, conversation_id: conv.id, role: "assistant", name: "", content: "📖 Chapitre 1 — La grotte", segments: "[]", audio: "[]", meta: JSON.stringify({ chapter: true }), created_at: 2 },
      { id: 3, conversation_id: conv.id, role: "assistant", name: "Alba", content: '*"Attention."*', segments: "[]", audio: "[]", meta: "{}", created_at: 3 },
    ];
    const out = prompt.buildMessages({ world: null, persona: null, cards: [], scenario: null, conversation: conv }, history);
    expect(out.messages).toHaveLength(2);
    expect(out.messages.some((m) => m.content.includes("Chapitre"))).toBe(false);
  });
});

describe("context window via API", async () => {
  const { db, routes } = await loadApp();
  test("summary/columns exist on fresh conversations", () => {
    const conv = db.createConversation({ title: "Résumé" });
    expect(conv.summary).toBe("");
    expect(conv.summary_msg_id).toBe(0);
  });
});