import { describe, test, expect } from "bun:test";
import { loadApp, dataDir } from "./helpers";

const { db, routes } = await loadApp();
const { importFile, parsePngCard, normalizeCard } = await import("../src/server/importCards");

const enc = new TextEncoder();

/** Minimal valid-enough PNG with a "chara" tEXt chunk (parser doesn't check CRCs). */
function pngWithChara(json: string): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(enc.encode(type), 4);
    out.set(data, 8);
    return out; // CRC left as 0 — the parser ignores it
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, 1); v.setUint32(4, 1); ihdr[8] = 8; ihdr[9] = 6;
  const text = enc.encode(`chara\u0000${json}`);
  return new Uint8Array([...sig, ...chunk("IHDR", ihdr), ...chunk("tEXt", text), ...chunk("IEND", new Uint8Array(0))]);
}

describe("importCards", () => {
  test("JSON v2 card imports name + fields", () => {
    const card = normalizeCard({ data: { name: "Alba", description: "Elfe gardienne", personality: "Fière" } });
    expect(card.name).toBe("Alba");
    expect(card.description).toBe("Elfe gardienne");
  });

  test("JSON v1 card imports creatorComment", () => {
    const card = normalizeCard({ name: "Kael", creatorcomment: "Moi" });
    expect(card.creator).toBe("Moi");
  });

  test("importFile: unrecognized format returns null", () => {
    expect(importFile("notes.txt", enc.encode("hi"))).toBeNull();
  });

  test("parsePngCard extracts chara chunk without touching DB", () => {
    const png = pngWithChara(JSON.stringify({ data: { name: "Elda", description: "Née sous la lune" } }));
    const res = parsePngCard(png);
    expect(res).not.toBeNull();
    expect(res!.card.name).toBe("Elda");
  });

  test("importFile PNG creates a card + avatar", async () => {
    const png = pngWithChara(JSON.stringify({ data: { name: "Pixel", first_mes: "*Salut.*" } }));
    const card = importFile("pixel.png", png);
    expect(card).not.toBeNull();
    expect(card!.name).toBe("Pixel");
    expect(card!.avatar).toContain("/uploads/avatars/");
    expect(db.getCard(card!.id).name).toBe("Pixel");
  });
});

describe("export/import API", () => {
  test("POST /api/import accepts JSON base64 payload", async () => {
    const body = JSON.stringify({ data: { name: "Online", description: "Depuis l'API" } });
    const res = await routes.handleApi(
      new Request("http://test.local/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [{ name: "c.json", base64: Buffer.from(body).toString("base64") }] }) }),
      new URL("http://test.local/api/import"),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.imported).toHaveLength(1);
    expect(j.imported[0].name).toBe("Online");
  });

  test("data dir is isolated", () => {
    expect(dataDir).not.toContain("app.db");
  });
});