/**
 * SillyTavern character card import: PNG (tEXt "chara" chunk) and JSON
 * (spec V1 / V2), with avatar extraction.
 */
import fs from "node:fs";
import path from "node:path";
import { UPLOADS_DIR } from "./paths";
import { createCard, updateCard, getCard, cardByFingerprint, type CardRow } from "./db";

// per-type size limits: PNG cards can be heavy, JSON must stay small
// (guards against oversized imports and pathological JSON payloads)
export const MAX_PNG_BYTES = 50 * 1024 * 1024; // 50 Mo
export const MAX_JSON_BYTES = 5 * 1024 * 1024; // 5 Mo

export type ImportStatus = "imported" | "duplicate" | "invalid";

export interface ImportResult {
  status: ImportStatus;
  name: string;
  /** human-readable reason (shown in the per-file report) */
  reason?: string;
  /** the created card, when status === "imported" */
  card?: CardRow;
}

export interface ParsedCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[];
  creator: string;
  raw: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/**
 * Decode text with a UTF-8 first, CP1252 fallback. SillyTavern exports saved
 * by Windows tools are often Latin-1/CP1252: decoding them as UTF-8 turns
 * every accent into U+FFFD (""). If the UTF-8 pass produces replacement
 * characters, retry with windows-1252 and keep that result when it is clean.
 */
function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("\uFFFD")) return utf8;
  const cp1252 = new TextDecoder("windows-1252").decode(bytes);
  return cp1252.includes("\uFFFD") ? utf8 : cp1252;
}

export function normalizeCard(v: any): ParsedCard {
  if (v && typeof v === "object" && v.data && typeof v.data === "object") {
    // V2
    const d = v.data;
    return {
      name: str(d.name) || "Carte sans nom",
      description: str(d.description),
      personality: str(d.personality),
      scenario: str(d.scenario),
      first_mes: str(d.first_mes),
      mes_example: str(d.mes_example),
      system_prompt: str(d.system_prompt),
      post_history_instructions: str(d.post_history_instructions),
      alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map(str) : [],
      tags: Array.isArray(d.tags) ? d.tags.map(str) : [],
      creator: str(d.creator),
      raw: v,
    };
  }
  // V1 or bare
  return {
    name: str(v?.name) || "Carte sans nom",
    description: str(v?.description),
    personality: str(v?.personality),
    scenario: str(v?.scenario),
    first_mes: str(v?.first_mes),
    mes_example: str(v?.mes_example),
    system_prompt: str(v?.system_prompt),
    post_history_instructions: str(v?.post_history_instructions),
    alternate_greetings: Array.isArray(v?.alternate_greetings) ? v.alternate_greetings.map(str) : [],
    tags: Array.isArray(v?.tags) ? v.tags.map(str) : [],
    creator: str(v?.creator) || str(v?.creatorcomment),
    raw: v,
  };
}

/** Extract the "chara" metadata from PNG bytes (tEXt chunks). */
export function parsePngCard(bytes: Uint8Array): { card: ParsedCard; image: Uint8Array } | null {
  if (bytes.length < 24) return null;
  // PNG signature check
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let charaText = "";
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off, false);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > bytes.length) break;
    if (type === "tEXt") {
      // keyword\0text
      let nul = dataStart;
      while (nul < dataEnd && bytes[nul] !== 0) nul++;
      const keyword = new TextDecoder().decode(bytes.subarray(dataStart, nul));
      if (keyword === "chara" || keyword === "ccv3" || keyword === "ccv2") {
        charaText = new TextDecoder().decode(bytes.subarray(nul + 1, dataEnd));
        break;
      }
    }
    off = dataStart + len + 4; // + CRC
    if (type === "IEND") break;
  }
  if (!charaText) return null;
  let parsed: any = null;
  try {
    parsed = JSON.parse(charaText.replace(/^\uFEFF/, ""));
  } catch {
    try {
      // some exporters base64 a CP1252-encoded JSON — decode bytes, then parse
      const b64 = charaText.trim().replace(/^\uFEFF/, "");
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      parsed = JSON.parse(decodeText(raw));
    } catch {
      return null;
    }
  }
  return { card: normalizeCard(parsed), image: bytes };
}

export function parseJsonCard(bytes: Uint8Array): ParsedCard | null {
  const text = decodeText(bytes);
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object") return normalizeCard(parsed);
  } catch {
    return null;
  }
  return null;
}

/**
 * Stable content fingerprint: canonical JSON (sorted keys) of the parsed card
 * data, hashed with SHA-256. Two files carrying the same character content
 * (whatever the whitespace/key order) hash identically → duplicate detection.
 */
export function fingerprintFor(raw: unknown): string {
  const canonical = JSON.stringify(sortKeys(raw));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  return hasher.digest("hex");
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** Max allowed bytes for a given file name (PNG vs JSON), or 0 when unsupported. */
export function sizeLimitFor(fileName: string): number {
  const lower = (fileName || "").toLowerCase();
  if (lower.endsWith(".png")) return MAX_PNG_BYTES;
  if (lower.endsWith(".json")) return MAX_JSON_BYTES;
  return 0;
}

export function importFile(
  fileName: string,
  bytes: Uint8Array,
  onProgress?: (name: string, status: string) => void,
): ImportResult {
  const lower = fileName.toLowerCase();
  const limit = sizeLimitFor(fileName);
  if (!limit) {
    onProgress?.(fileName, "ignoré (format non reconnu)");
    return { status: "invalid", name: fileName, reason: "Format non reconnu (PNG ou JSON attendu)" };
  }
  if (bytes.byteLength > limit) {
    onProgress?.(fileName, `ignoré (${(bytes.byteLength / 1024 / 1024).toFixed(1)} Mo > ${(limit / 1024 / 1024)} Mo)`);
    return { status: "invalid", name: fileName, reason: `Fichier trop volumineux (${(bytes.byteLength / 1024 / 1024).toFixed(1)} Mo > limite ${(limit / 1024 / 1024).toFixed(0)} Mo)` };
  }

  let parsed: ParsedCard | null = null;
  let avatar: Uint8Array | null = null;

  if (lower.endsWith(".png")) {
    const res = parsePngCard(bytes);
    if (res) {
      parsed = res.card;
      avatar = res.image;
    }
  } else if (lower.endsWith(".json")) {
    parsed = parseJsonCard(bytes);
  }

  if (!parsed) {
    onProgress?.(fileName, "ignoré (format non reconnu)");
    return { status: "invalid", name: fileName, reason: "Contenu invalide : ni carte V1/V2/V3 ni PNG « chara »" };
  }

  // duplicate detection: same character content already imported?
  const fp = fingerprintFor(parsed.raw);
  const existing = cardByFingerprint(fp);
  if (existing) {
    onProgress?.(fileName, `doublon de « ${existing.name} »`);
    return { status: "duplicate", name: fileName, reason: `Déjà importée : « ${existing.name} » (id ${existing.id})` };
  }

  const card = createCard({
    name: parsed.name,
    description: parsed.description,
    personality: parsed.personality,
    scenario: parsed.scenario,
    first_mes: parsed.first_mes,
    mes_example: parsed.mes_example,
    system_prompt: parsed.system_prompt,
    post_history_instructions: parsed.post_history_instructions,
    alternate_greetings: JSON.stringify(parsed.alternate_greetings),
    tags: JSON.stringify(parsed.tags),
    creator: parsed.creator,
    data: JSON.stringify(parsed.raw),
    fingerprint: fp,
  });

  if (avatar) {
    const avatarDir = path.join(UPLOADS_DIR, "avatars");
    fs.mkdirSync(avatarDir, { recursive: true });
    const dest = path.join(avatarDir, `card-${card.id}${path.extname(lower) || ".png"}`);
    fs.writeFileSync(dest, avatar);
    updateCard(card.id, { avatar: `/uploads/avatars/card-${card.id}${path.extname(lower) || ".png"}` });
  }

  onProgress?.(fileName, `importé : ${parsed.name}`);
  // re-read: the card row was updated with the avatar after createCard
  return { status: "imported", name: fileName, card: getCard(card.id)! };
}

export function scanDirectory(dirPath: string, onProgress?: (name: string, status: string) => void): number {
  let count = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && /\.(png|json)$/i.test(e.name)) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dirPath, e.name)));
      if (importFile(e.name, bytes, onProgress).status === "imported") count++;
    }
  }
  return count;
}