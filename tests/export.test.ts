import { describe, test, expect } from "bun:test";
import { dataDir, loadApp } from "./helpers";
import { zipFiles } from "../src/server/zip";

// tiny STORE-zip reader: verifies our writer round-trips without external tools
function readZipEntry(zip: Uint8Array, name: string): Uint8Array | null {
  // find central directory via EOCD (last 22+ bytes)
  const eocd = zip.length - 22;
  if (zip[eocd] !== 0x50 || zip[eocd + 1] !== 0x4b || zip[eocd + 2] !== 0x05 || zip[eocd + 3] !== 0x06) return null;
  const count = zip[eocd + 10] | (zip[eocd + 11] << 8);
  let off = zip[eocd + 16] | (zip[eocd + 17] << 8) | (zip[eocd + 18] << 16) | (zip[eocd + 19] << 24);
  for (let i = 0; i < count; i++) {
    if (zip[off] !== 0x50 || zip[off + 1] !== 0x4b) return null;
    const nameLen = zip[off + 28] | (zip[off + 29] << 8);
    const extraLen = zip[off + 30] | (zip[off + 31] << 8);
    const commentLen = zip[off + 32] | (zip[off + 33] << 8);
    const crc = zip[off + 16] | (zip[off + 17] << 8) | (zip[off + 18] << 16) | (zip[off + 19] << 24);
    const size = zip[off + 20] | (zip[off + 21] << 8) | (zip[off + 22] << 16) | (zip[off + 23] << 24);
    const localOff = zip[off + 42] | (zip[off + 43] << 8) | (zip[off + 44] << 16) | (zip[off + 45] << 24);
    const entryName = new TextDecoder().decode(zip.subarray(off + 46, off + 46 + nameLen));
    if (entryName === name) {
      const lnameLen = zip[localOff + 26] | (zip[localOff + 27] << 8);
      const lextraLen = zip[localOff + 28] | (zip[localOff + 29] << 8);
      const start = localOff + 30 + lnameLen + lextraLen;
      const data = zip.subarray(start, start + size);
      // CRC check (store method → raw bytes)
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
      let c = 0xffffffff;
      for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
      expect((c ^ 0xffffffff) >>> 0).toBe(crc >>> 0);
      return data;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

describe("zip export", () => {
  test("zipFiles round-trips entries with correct content", () => {
    const zip = zipFiles([
      { path: "conversation.md", data: "# L'invocation\n\n> **Alba** : *test*" },
      { path: "audio/23-0.wav", data: new Uint8Array([1, 2, 3, 4, 5]) },
      { path: "images/pic.png", data: new Uint8Array(100).fill(7) },
    ]);
    expect(zip[0]).toBe(0x50); // PK magic
    const md = readZipEntry(zip, "conversation.md");
    expect(new TextDecoder().decode(md)).toContain("L'invocation");
    const wav = readZipEntry(zip, "audio/23-0.wav");
    expect([...wav!]).toEqual([1, 2, 3, 4, 5]);
    expect(readZipEntry(zip, "images/pic.png")!.length).toBe(100);
    expect(readZipEntry(zip, "missing.txt")).toBeNull();
  });
});

describe("character-consistent illustrations", async () => {
  const { routes } = await loadApp();

  test("charSeed is deterministic per card", () => {
    expect(routes.charSeed(1)).toBe(routes.charSeed(1));
    expect(routes.charSeed(2)).toBe(routes.charSeed(2));
    expect(routes.charSeed(1)).not.toBe(routes.charSeed(2));
    expect(routes.charSeed(999)).toBeGreaterThan(0);
  });

  test("characterForMessage finds the dialogue speaker and named narration", () => {
    const cast = [
      { id: 1, name: "Alba", description: "elfe blonde aux yeux d'or, robe bleue et or" },
      { id: 2, name: "Lyra", description: "chanteuse des brumes" },
    ];
    const fromDialogue = routes.characterForMessage(cast, '*Alba déploie ses ailes.* Alba: "On ne passe pas."');
    expect(fromDialogue?.id).toBe(1);
    expect(fromDialogue?.description).toContain("elfe");
    const fromNarration = routes.characterForMessage(cast, "*Lyra chante au bord du lac.*");
    expect(fromNarration?.id).toBe(2);
    expect(routes.characterForMessage(cast, "*Le vent souffle dans les ruines.*")).toBeNull();
  });
});
