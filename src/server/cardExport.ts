/**
 * SillyTavern-compatible card export: a PNG carrying the "chara" tEXt chunk
 * (base64 JSON, V2). Reuses the card avatar when present, else a placeholder
 * solid-color PNG so the export is always a valid ST card.
 */
import { deflateSync } from "node:zlib";
import { crc32 } from "./zip";

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crc = crc32(new Uint8Array(out.subarray(4, 8 + data.length)));
  out.writeUInt32BE(crc >>> 0, 8 + data.length);
  return out;
}

export function placeholderPng(size = 256, rgb: [number, number, number] = [43, 24, 66]): Buffer {
  const stride = 1 + size * 4;
  const rows = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const off = y * stride;
    rows[off] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = off + 1 + x * 4;
      rows[o] = rgb[0];
      rows[o + 1] = rgb[1];
      rows[o + 2] = rgb[2];
      rows[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Inject a "chara" tEXt chunk right before IEND (standard ST card position). */
export function withCharaChunk(png: Uint8Array, charaJson: string): Buffer {
  const buf = Buffer.from(png);
  const iend = buf.lastIndexOf(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44])); // ...IEND
  if (iend < 0) return buf;
  const payload = Buffer.from(`chara\0${Buffer.from(charaJson, "utf8").toString("base64")}`, "utf8");
  return Buffer.concat([buf.subarray(0, iend), chunk("tEXt", payload), buf.subarray(iend)]);
}
