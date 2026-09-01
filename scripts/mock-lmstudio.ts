// Mock LM Studio (OpenAI-compatible) for offline testing.
//   bun scripts/mock-lmstudio.ts [port]
const port = Number(process.argv[2] || 1234);

const RP_ANSWER = `*La porte de pierre s'ouvre dans un grincement ancien, et la lumière du crépuscule inonde le hall.*\n\nAlba: "Sois le bienvenu, voyageur. On m'avait dit que tu arriverais — mais pas que tu tomberais du ciel."\n\n*Elle s'avance, une lueur malicieuse dans les yeux.*`;

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ data: [{ id: "test-rp-model" }, { id: "test-rp-model-2" }] });
    }
    if (url.pathname === "/v1/chat/completions") {
      const body = await req.json().catch(() => ({}));
      const stream = body.stream;
      if (stream) {
        const chunks = [];
        for (let i = 0; i < RP_ANSWER.length; i += 12) {
          chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: RP_ANSWER.slice(i, i + 12) } }] })}\n\n`);
        }
        chunks.push("data: [DONE]\n\n");
        return new Response(chunks.join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({
        choices: [{ message: { role: "assistant", content: RP_ANSWER } }],
      });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`[mock] LM Studio mock on :${port}`);