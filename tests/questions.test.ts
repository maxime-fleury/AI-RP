import { describe, test, expect, afterEach } from "bun:test";
import { loadApp, api } from "./helpers";

const { db, routes } = await loadApp();
const core = await import("../src/server/routes/core");

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockLlmComplete(content: string) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("questionnaire du meneur (guider le RP)", () => {
  test("POST /questions without a reachable model → 502", async () => {
    const conv = db.createConversation({ title: "Q" });
    globalThis.fetch = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/questions`, { count: 5 });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("questions");
  });

  test("POST /questions parses the model's JSON into question objects with suggested answers", async () => {
    const conv = db.createConversation({ title: "Q" });
    mockLlmComplete(
      '[{"q":"Que veut ton personnage accomplir maintenant ?","answers":["Trouver un refuge","Suivre la piste","Explorer la ville"]},' +
        '{"q":"Quelle est ton intention envers Alba ?","answers":["Lui faire confiance","La surveiller","Se rapprocher d\'elle"]}]',
    );
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/questions`, { count: 5 });
    expect(res.status).toBe(200);
    const { questions } = await res.json();
    expect(questions).toHaveLength(2);
    expect(questions[0].q).toContain("Que veut");
    expect(questions[0].answers).toHaveLength(3);
    expect(questions[1].answers).toContain("La surveiller");
  });

  test("count is validated server-side (1..8)", async () => {
    const conv = db.createConversation({ title: "Q" });
    mockLlmComplete("[]");
    const bad = await api(routes, "POST", `/api/conversations/${conv.id}/questions`, { count: 99 });
    expect(bad.status).toBe(400);
    mockLlmComplete('[{"q":"Une question ?","answers":["a","b"]}]');
    const ok = await api(routes, "POST", `/api/conversations/${conv.id}/questions`, { count: 3 });
    expect(ok.status).toBe(200);
  });

  test("parseJsonArray tolerates prose and fences around the array", () => {
    expect(core.parseJsonArray('Voici : ```json\n[{"q":"a","answers":["x"]}]\n```')).toHaveLength(1);
    // an object-wrapped list also yields its inner array
    expect(core.parseJsonArray('{"questions":[{"q":"a","answers":[]}]}')).toHaveLength(1);
    expect(core.parseJsonArray("pas de json")).toBeNull();
  });

  test("normalized questions drop empty entries and cap answers", async () => {
    const conv = db.createConversation({ title: "Q" });
    mockLlmComplete('[{"q":"", "answers":["x"]},{"q":"Valide","answers":["a","b","c","d","e"]}]');
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/questions`, {});
    expect(res.status).toBe(200);
    const { questions } = await res.json();
    expect(questions).toHaveLength(1);
    expect(questions[0].q).toBe("Valide");
    expect(questions[0].answers).toHaveLength(4);
  });
});