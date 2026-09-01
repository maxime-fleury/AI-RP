/**
 * Minimal ZIP writer (STORE, no compression) — Bun has no built-in zip API in
 * this version, and pulling a dependency just for exports is overkill.
 * Produces a valid archive readable by Windows Explorer, macOS, unzip, etc.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
}

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

/** Build a ZIP archive (store-only). `files` = [{ path, data }] with forward-slash paths. */
export function zipFiles(files: { path: string; data: Uint8Array | string }[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = encoder.encode(f.path);
    const data = typeof f.data === "string" ? encoder.encode(f.data) : f.data;
    const crc = crc32(data);
    const size = data.length;

    // local file header
    const local = concat([
      u32(0x04034b50),
      u16(20), // version needed (2.0)
      u16(0), // flags
      u16(0), // method: store
      u16(0), // time
      u16(0), // date
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0), // extra length
      nameBytes,
    ]);
    localParts.push(local, data);

    // central directory entry
    centralParts.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0), // external attrs
        u32(offset),
        nameBytes,
      ]),
    );
    offset += local.length + data.length;
  }

  const central = concat(centralParts);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...localParts, central, end]);
}
