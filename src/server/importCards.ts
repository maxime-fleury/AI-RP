/**
 * SillyTavern character card import: PNG (tEXt "chara" chunk) and JSON
 * (spec V1 / V2), with avatar extraction.
 */
import fs from "node:fs";
import path from "node:path";
import { UPLOADS_DIR } from "./paths";
import { createCard, updateCard, getCard, type CardRow } from "./db";

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
    parsed = JSON.parse(charaText);
  } catch {
    try {
      parsed = JSON.parse(atob(charaText.trim()));
    } catch {
      return null;
    }
  }
  return { card: normalizeCard(parsed), image: bytes };
}

export function parseJsonCard(bytes: Uint8Array): ParsedCard | null {
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return normalizeCard(parsed);
  } catch {
    return null;
  }
  return null;
}

export function importFile(
  fileName: string,
  bytes: Uint8Array,
  onProgress?: (name: string, status: string) => void,
): CardRow | null {
  const lower = fileName.toLowerCase();
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
    return null;
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
  return getCard(card.id);
}

export function scanDirectory(dirPath: string, onProgress?: (name: string, status: string) => void): number {
  let count = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && /\.(png|json)$/i.test(e.name)) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dirPath, e.name)));
      if (importFile(e.name, bytes, onProgress)) count++;
    }
  }
  return count;
}