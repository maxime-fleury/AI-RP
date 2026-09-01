/**
 * End-to-end API test (needs the main server on :3000 and optionally the
 * mock LM Studio on :1234).
 *   bun scripts/test-api.ts
 */
const BASE = `http://localhost:${process.env.PORT ?? 3210}`;

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

const log = (...a) => console.log("•", ...a);

// 1. settings
log("settings:", await api("/api/settings"));

// 2. create a world
const world = await api("/api/worlds", { body: { name: "Eldoria", description: "Un royaume où les dieux sont morts", lore: "Il y a mille ans, les dieux ont disparu. Le royaume est devenu un champ de ruines peuplé de survivants.", tone: "épique et mélancolique" } });
log("world created:", world.id, world.name);

// 3. scenario
const scenario = await api(`/api/worlds/${world.id}/scenarios`, { body: { name: "L'invocation", intro: "Tu t'éveilles dans une salle de pierre. Une silhouette ailée te contemple : « Toi aussi, on t'a invoqué ? »" } });
log("scenario:", scenario.id, scenario.name);

// 4. import a JSON card (SillyTavern V2)
const cardJson = {
  spec: "chara_card_v2", spec_version: "2.0",
  data: {
    name: "Alba",
    description: "Une guerrière ailée, gardienne de la cité des cendres.",
    personality: "Fière, malicieuse, protectrice. Parle peu mais agit vite.",
    scenario: "Elle garde la porte du sanctuaire et juge les nouveaux arrivants.",
    first_mes: "*Alba déploie ses ailes, te jaugeant du regard.*\n\nAlba: \"On ne passe pas cette porte sans raison.\"",
    mes_example: "Alba: \"Tu es plus intéressant que les autres égarés.\"",
    system_prompt: "Parle avec des métaphores de vent et de cendres.",
    tags: ["fantasy", "guardian"],
  },
};
const imported = await api("/api/import", { body: { files: [{ name: "alba.json", base64: btoa(unescape(encodeURIComponent(JSON.stringify(cardJson)))) }] } });
log("imported cards:", imported.imported.length, imported.imported[0]?.name);
const card = imported.imported[0];

// 5. persona
const persona = await api("/api/personas", { body: { name: "Kael", description: "Un jeune homme réincarné, curieux et un peu tête brûlée. Garde ses souvenirs du monde réel." } });
log("persona:", persona.id, persona.name);

// 6. conversation
const conv = await api("/api/conversations", {
  body: {
    world_id: world.id, scenario_id: scenario.id, persona_id: persona.id,
    cast: [card.id], group_mode: true,
  },
});
log("conversation:", conv.id, "| opening message:", (conv.messages || []).length);

// 7. stream a turn
log("streaming a turn…");
const res = await fetch(`${BASE}/api/conversations/${conv.id}/stream`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "Je me redresse, encore groggy. « Où suis-je ? Et qui es-tu, toi ? »" }),
});
let full = "";
let sawDone = false;
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buffer.indexOf("\n\n")) >= 0) {
    const block = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const evt = block.match(/^event: (.*)$/m)?.[1] || "message";
    const data = block.match(/^data: (.*)$/m)?.[1];
    if (evt === "delta" && data) full += JSON.parse(data).text;
    if (evt === "done") { sawDone = true; log("  done, segments:", JSON.parse(data).message.segments?.length); }
    if (evt === "error") throw new Error("SSE error: " + JSON.parse(data).message);
  }
}
log("assistant text:", full.slice(0, 80) + "…");

// 8. fetch conversation
const conv2 = await api(`/api/conversations/${conv.id}`);
log("messages:", conv2.messages.length);
log("segments of last msg:", JSON.stringify(conv2.messages[conv2.messages.length - 1].segments?.slice(0, 2)));

log("✅ API integration test passed");