import { describe, test, expect, afterEach } from "bun:test";
import { loadApp, api } from "./helpers";

const { db, routes } = await loadApp();
const originalFetch = globalThis.fetch;

function llmResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("guided builder assistant", () => {
  test("accepts prose-wrapped JSON with typographic quotes", async () => {
    db.setSetting("lmstudio_model", "test-model");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return llmResponse(`Voici le résultat : {“matches”:[],“proposals":[{“name”:“Astreval”,“description”:“Un monde de brumes et de magie.”,“tone”:“fantasy”,“lore”:“Les anciennes portes se réveillent.”},{“name”:“Néréide”,“description”:“Des cités flottent au-dessus d'un océan vivant.”,“tone”:“aventure”,“lore”:“Les marées obéissent aux rêves.”}]}`);
    }) as unknown as typeof fetch;

    const res = await api(routes, "POST", "/api/assist/build", {
      stage: "worlds",
      description: "Un monde magique et mystérieux.",
    });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.proposals).toHaveLength(2);
    expect(out.proposals[0].name).toBe("Astreval");
    expect(calls).toBe(1);
  });

  test("returns a retryable error after the corrective answer is still underfilled", async () => {
    db.setSetting("lmstudio_model", "test-model");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return llmResponse('{"matches":[],"proposals":[{"name":"Un seul monde","description":"Trop peu."}]}');
    }) as unknown as typeof fetch;

    const res = await api(routes, "POST", "/api/assist/build", {
      stage: "worlds",
      description: "Un monde magique.",
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("monde exploitable");
    expect(calls).toBe(2);
  });

  test("also validates the corrective answer after a malformed first response", async () => {
    db.setSetting("lmstudio_model", "test-model");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? llmResponse("{not-json")
        : llmResponse('{"matches":[],"proposals":[{"name":"Réponse trop courte","description":"Toujours insuffisant."}]}');
    }) as unknown as typeof fetch;

    const res = await api(routes, "POST", "/api/assist/build", {
      stage: "worlds",
      description: "Un monde magique.",
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("monde exploitable");
    expect(calls).toBe(2);
  });
});
