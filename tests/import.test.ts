import { describe, test, expect } from "bun:test";
import { loadApp, dataDir } from "./helpers";

const { db, routes } = await loadApp();
const { importFile, parseJsonCard, parsePngCard, normalizeCard, fingerprintFor, sizeLimitFor, MAX_JSON_BYTES } = await import("../src/server/importCards");

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

  test("importFile: unrecognized format is reported invalid", () => {
    const res = importFile("notes.txt", enc.encode("hi"));
    expect(res.status).toBe("invalid");
    expect(res.name).toBe("notes.txt");
  });

  test("importFile: JSON over the 5 Mo limit is rejected before parsing", () => {
    const big = new Uint8Array(MAX_JSON_BYTES + 1); // filled with zeros → not valid JSON anyway
    const res = importFile("huge.json", big);
    expect(res.status).toBe("invalid");
    expect(res.reason).toContain("trop volumineux");
  });

  test("sizeLimitFor applies per type (PNG 50 Mo / JSON 5 Mo)", () => {
    expect(sizeLimitFor("a.png")).toBe(50 * 1024 * 1024);
    expect(sizeLimitFor("a.JSON")).toBe(MAX_JSON_BYTES);
    expect(sizeLimitFor("a.txt")).toBe(0);
  });

  test("fingerprintFor is stable across key order and whitespace", () => {
    const a = fingerprintFor({ data: { name: "Alba", description: "Elfe" }, spec: "chara_card_v2" });
    const b = fingerprintFor({ spec: "chara_card_v2", data: { description: "Elfe", name: "Alba" } });
    expect(a).toBe(b);
    expect(a.length).toBe(64); // sha256 hex
  });

  test("importFile: same character twice → second is a duplicate", () => {
    const json = JSON.stringify({ data: { name: "Duplicata", description: "Même contenu" } });
    const first = importFile("dup.json", enc.encode(json));
    expect(first.status).toBe("imported");
    const second = importFile("dup2.json", enc.encode(json));
    expect(second.status).toBe("duplicate");
    expect(second.reason).toContain("Duplicata");
    // only one row was created
    const matches = db.listCards().filter((c: any) => c.name === "Duplicata");
    expect(matches).toHaveLength(1);
    expect(matches[0].fingerprint).toBe(fingerprintFor(JSON.parse(json)));
  });

  test("parsePngCard extracts chara chunk without touching DB", () => {
    const png = pngWithChara(JSON.stringify({ data: { name: "Elda", description: "Née sous la lune" } }));
    const res = parsePngCard(png);
    expect(res).not.toBeNull();
    expect(res!.card.name).toBe("Elda");
  });

  test("parseJsonCard strips a UTF-8 BOM before parsing", () => {
    const withBom = "\uFEFF" + JSON.stringify({ data: { name: "Bom", description: "Accent é ok" } });
    const res = parseJsonCard(enc.encode(withBom));
    expect(res).not.toBeNull();
    expect(res!.name).toBe("Bom");
    expect(res!.description).toBe("Accent é ok");
  });

  test("parseJsonCard recovers accented text from a CP1252-encoded file", () => {
    // "Chanté" where é = 0xE9 (Latin-1) — decodes as U+FFFD under UTF-8
    const bytes = new Uint8Array([
      0x7B, 0x22, 0x64, 0x61, 0x74, 0x61, 0x22, 0x3A, 0x7B, 0x22, 0x6E, 0x61, 0x6D, 0x65, 0x22, 0x3A,
      0x22, 0x43, 0x68, 0x61, 0x6E, 0x74, 0xE9, 0x22, 0x7D, 0x7D, // {"data":{"name":"Chanté"}}
    ]);
    const res = parseJsonCard(bytes);
    expect(res).not.toBeNull();
    expect(res!.name).toBe("Chanté");
  });

  test("parsePngCard decodes a base64 CP1252 chara chunk (exporters edge case)", () => {
    const cp1252 = new Uint8Array([
      0x7B, 0x22, 0x64, 0x61, 0x74, 0x61, 0x22, 0x3A, 0x7B, 0x22, 0x6E, 0x61, 0x6D, 0x65, 0x22, 0x3A,
      0x22, 0x44, 0xE9, 0x6A, 0xE0, 0x76, 0x75, 0x22, 0x7D, 0x7D, // {"data":{"name":"Déjàvu"}}
    ]);
    const b64 = Buffer.from(cp1252).toString("base64");
    const png = pngWithChara(b64); // base64 is ASCII, safe in a tEXt chunk
    const res = parsePngCard(png);
    expect(res).not.toBeNull();
    expect(res!.card.name).toBe("Déjàvu");
  });

  test("importFile PNG creates a card + avatar", async () => {
    const png = pngWithChara(JSON.stringify({ data: { name: "Pixel", first_mes: "*Salut.*" } }));
    const res = importFile("pixel.png", png);
    expect(res.status).toBe("imported");
    const card = res.card!;
    expect(card.name).toBe("Pixel");
    expect(card.avatar).toContain("/uploads/avatars/");
    expect(db.getCard(card.id).name).toBe("Pixel");
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
    expect(j.report).toHaveLength(1);
    expect(j.report[0].status).toBe("imported");
  });

  test("POST /api/import reports duplicates + invalid files per file", async () => {
    const body = JSON.stringify({ data: { name: "Double", description: "Même carte" } });
    const payload = JSON.stringify({ files: [
      { name: "a.json", base64: Buffer.from(body).toString("base64") },
      { name: "a-copy.json", base64: Buffer.from(body).toString("base64") },
      { name: "notes.txt", base64: Buffer.from("hi").toString("base64") },
    ] });
    const res = await routes.handleApi(
      new Request("http://test.local/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }),
      new URL("http://test.local/api/import"),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.imported).toHaveLength(1);
    expect(j.duplicates).toEqual(["a-copy.json"]);
    const statuses = j.report.map((r: any) => r.status);
    expect(statuses).toContain("duplicate");
    expect(statuses).toContain("invalid");
  });

  test("data dir is isolated", () => {
    expect(dataDir).not.toContain("app.db");
  });
});