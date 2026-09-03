/**
 * Single source of truth for global settings (Réglages).
 *
 * Every key the client may PATCH is declared here with its type and bounds.
 * Unknown keys are REJECTED with a 400 (instead of being persisted silently
 * forever — the old behaviour turned every typo into permanent junk), and
 * out-of-range values are rejected too (instead of being silently dropped,
 * which left the user believing the save had worked).
 *
 * Conversation/world-level settings (temperature, context budgets…) live in
 * the per-object `settings` JSON blobs and are NOT covered here.
 */
import { HttpError } from "./http";
import { Codes } from "./validate";

export type SettingKind = "string" | "number" | "integer" | "boolean" | "enum" | "object" | "array" | "any" | "url";

export interface SettingDef {
  kind: SettingKind;
  min?: number;
  max?: number;
  maxLen?: number;
  values?: readonly string[];
  secret?: boolean;
  desc: string;
}

export const SECRET_SETTING_KEYS = new Set(["openrouter_key", "auth_token"]);

const DIMS = [512, 768, 832, 1152, 1216] as const;

export const SETTING_DEFS: Record<string, SettingDef> = {
  provider: { kind: "enum", values: ["lmstudio", "openrouter"], desc: "Fournisseur IA" },
  lmstudio_url: { kind: "url", maxLen: 500, desc: "URL LM Studio (API)" },
  lmstudio_model: { kind: "string", maxLen: 200, desc: "Modèle LM Studio" },
  openrouter_key: { kind: "string", maxLen: 500, secret: true, desc: "Clé API OpenRouter" },
  openrouter_model: { kind: "string", maxLen: 200, desc: "Modèle OpenRouter" },
  narrator_style: { kind: "string", maxLen: 80, desc: "Style du narrateur" },
  narrator_presets: { kind: "object", desc: "Presets du narrateur" },
  temperature: { kind: "number", min: 0, max: 2, desc: "Température" },
  max_tokens: { kind: "integer", min: 64, max: 16384, desc: "Tokens max" },
  llm_timeout: { kind: "integer", min: 20, max: 900, desc: "Timeout du modèle (s)" },
  image_steps: { kind: "integer", min: 8, max: 60, desc: "Étapes de génération" },
  image_cfg: { kind: "number", min: 1, max: 20, desc: "Guidance" },
  image_width: { kind: "enum", values: DIMS.map(String), desc: "Largeur d'image" },
  image_height: { kind: "enum", values: DIMS.map(String), desc: "Hauteur d'image" },
  image_ref_strength: { kind: "number", min: 0, max: 1, desc: "Fidélité au portrait" },
  image_preload: { kind: "boolean", desc: "Précharger le modèle d'images" },
  context_max_messages: { kind: "integer", min: 2, max: 200, desc: "Tours gardés en mémoire" },
  context_max_tokens: { kind: "integer", min: 0, max: 32000, desc: "Budget tokens du contexte (0 = désactivé)" },
  world_context_max_messages: { kind: "integer", min: 0, max: 200, desc: "Cap monde : tours max (0 = désactivé)" },
  world_context_max_tokens: { kind: "integer", min: 0, max: 32000, desc: "Cap monde : budget tokens (0 = désactivé)" },
  auth_token: { kind: "string", maxLen: 200, secret: true, desc: "Token d'accès LAN" },
  narrator_avatar: { kind: "string", maxLen: 2000, desc: "Avatar du narrateur" },
  notifications: { kind: "boolean", desc: "Notifications" },
  sound_effects: { kind: "boolean", desc: "Effets sonores" },
  shortcuts: { kind: "object", desc: "Raccourcis clavier" },
};

export function isKnownSetting(key: string): boolean {
  return key in SETTING_DEFS;
}

/** Validate ONE global setting value; returns the normalized value or throws 400. */
export function validateSettingValue(key: string, v: unknown): unknown {
  const def = SETTING_DEFS[key];
  if (!def) {
    throw new HttpError(400, `Réglage inconnu : ${key}`, Codes.INVALID_FIELD);
  }
  return validateValueWithDef(key, v, def);
}

/**
 * Validate ONE value against its def. Returns the normalized value, or
 * `undefined` as a "skip" sentinel for untouched secrets. Throws 400.
 */
export function validateValueWithDef(key: string, v: unknown, def: SettingDef): unknown {
  // empty secret = "don't touch" (clearing is done explicitly with null)
  if (def.secret && (v === undefined || v === null || String(v) === "")) {
    return undefined; // sentinel: skip
  }
  if (def.kind === "any") return v;
  if (def.kind === "array") {
    if (!Array.isArray(v)) throw new HttpError(400, `${def.desc} doit être un tableau`, Codes.INVALID_BODY);
    return v;
  }
  switch (def.kind) {
    case "boolean":
      if (typeof v !== "boolean") throw new HttpError(400, `${def.desc} doit être un booléen`, Codes.INVALID_FIELD);
      return v;
    case "integer": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isInteger(n)) {
        throw new HttpError(400, `${def.desc} doit être un entier`, Codes.INVALID_FIELD);
      }
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        throw new HttpError(400, `${def.desc} doit être entre ${def.min} et ${def.max}`, Codes.OUT_OF_RANGE);
      }
      return n;
    }
    case "number": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new HttpError(400, `${def.desc} doit être un nombre`, Codes.INVALID_FIELD);
      }
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        throw new HttpError(400, `${def.desc} doit être entre ${def.min} et ${def.max}`, Codes.OUT_OF_RANGE);
      }
      return n;
    }
    case "enum": {
      const s = String(v);
      if (!def.values!.includes(s)) {
        throw new HttpError(400, `${def.desc} doit être l'un de : ${def.values!.join(", ")}`, Codes.INVALID_ENUM);
      }
      return s;
    }
    case "url": {
      if (typeof v !== "string") throw new HttpError(400, `${def.desc} doit être une chaîne`, Codes.INVALID_FIELD);
      const s = v.trim();
      if (!s) return ""; // empty = unset (readers fall back to their default URL)
      if (def.maxLen !== undefined && s.length > def.maxLen) {
        throw new HttpError(400, `${def.desc} : maximum ${def.maxLen} caractère(s)`, Codes.TOO_LONG);
      }
      if (!/^https?:\/\/.+/i.test(s)) throw new HttpError(400, `${def.desc} doit être une URL http(s)`, Codes.INVALID_FIELD);
      return s;
    }
    case "string": {
      if (typeof v !== "string") throw new HttpError(400, `${def.desc} doit être une chaîne`, Codes.INVALID_FIELD);
      if (def.maxLen !== undefined && v.length > def.maxLen) {
        throw new HttpError(400, `${def.desc} : maximum ${def.maxLen} caractère(s)`, Codes.TOO_LONG);
      }
      return v;
    }
    case "object": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        throw new HttpError(400, `${def.desc} doit être un objet`, Codes.INVALID_BODY);
      }
      return v;
    }
  }
}

/**
 * Validate a whole PATCH body. Returns entries to persist ([key, value][]),
 * skipping untouched secrets. Throws 400 listing every problem at once.
 */
export function validateSettingsPatch(body: unknown): [string, unknown][] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Corps de réglages invalide", Codes.INVALID_BODY);
  }
  const entries = Object.entries(body as Record<string, unknown>);
  const unknown = entries.map(([k]) => k).filter((k) => !isKnownSetting(k));
  if (unknown.length) {
    throw new HttpError(
      400,
      `Réglage(s) inconnu(s) : ${unknown.join(", ")} — rien n'a été enregistré`,
      Codes.INVALID_FIELD,
    );
  }
  const out: [string, unknown][] = [];
  for (const [k, v] of entries) {
    const nv = validateSettingValue(k, v);
    if (nv !== undefined) out.push([k, nv]);
  }
  return out;
}

// ─── per-object settings (one conversation / one world) ─────────────────────
// Same idea as the global schema, but the blobs mix client-editable keys
// (model, budgets…) with server-managed state (recap, rels, scene…) because
// the client round-trips the whole object on every save. Both classes are
// accepted; only TRULY unknown keys are rejected (typos, stale experiments).
// Legacy keys (checkpoints, loops) are accepted so old parties keep saving.
export const CONVERSATION_SETTING_DEFS: Record<string, SettingDef> = {
  // client-managed
  provider: { kind: "enum", values: ["lmstudio", "openrouter"], desc: "Fournisseur (partie)" },
  model: { kind: "string", maxLen: 200, desc: "Modèle (partie)" },
  preset: { kind: "string", maxLen: 80, desc: "Preset de style (partie)" },
  temperature: { kind: "number", min: 0, max: 2, desc: "Température (partie)" },
  max_tokens: { kind: "integer", min: 64, max: 16384, desc: "Tokens max (partie)" },
  context_max_messages: { kind: "integer", min: 2, max: 200, desc: "Tours gardés (partie)" },
  context_max_tokens: { kind: "integer", min: 0, max: 32000, desc: "Budget tokens (partie)" },
  validate_auto: { kind: "boolean", desc: "Cohérence auto (partie)" },
  dice_enabled: { kind: "boolean", desc: "Dés /dice (partie)" },
  loop_mem_narrator: { kind: "integer", min: 0, max: 3, desc: "Mémoire boucles (narrateur)" },
  loop_mem_player: { kind: "integer", min: 0, max: 2, desc: "Mémoire boucles (joueur)" },
  draft_intro: { kind: "string", maxLen: 4000, desc: "Intro brouillon (partie)" },
  dm: { kind: "object", desc: "Directives MJ (partie)" },
  dm_pending: { kind: "boolean", desc: "Directives en attente (partie)" },
  canon_auto: { kind: "boolean", desc: "Propositions canon auto (partie)" },
  // server-managed state (round-tripped by the client on save)
  recap: { kind: "object", desc: "Récapitulatif (partie)" },
  rels: { kind: "object", desc: "Graphe de relations (partie)" },
  quests: { kind: "array", desc: "Journal de quêtes (partie)" },
  chapters: { kind: "array", desc: "Chapitres (partie)" },
  chapter_msg_id: { kind: "integer", min: 0, max: 1e9, desc: "Dernier chapitre (partie)" },
  checkpoints: { kind: "array", desc: "Checkpoints (partie, legacy)" },
  loops: { kind: "array", desc: "Boucles (partie, legacy)" },
  lore_entries: { kind: "array", desc: "Canon de partie (partie)" },
  scene_state: { kind: "any", desc: "État de scène (partie)" },
  scene_updated_at: { kind: "number", min: 0, max: 1e15, desc: "MAJ scène (partie)" },
  scene_control: { kind: "any", desc: "Directives de scène (partie)" },
};

export const WORLD_SETTING_DEFS: Record<string, SettingDef> = {
  negative: { kind: "string", maxLen: 2000, desc: "Prompt négatif (monde)" },
  context_max_messages: { kind: "integer", min: 0, max: 200, desc: "Cap monde : tours (0 = désactivé)" },
  context_max_tokens: { kind: "integer", min: 0, max: 32000, desc: "Cap monde : tokens (0 = désactivé)" },
};

/**
 * Validate a per-object settings blob (plain object or pre-serialized JSON
 * string, like the world editor sends). Returns the canonical JSON string
 * for storage. Unknown keys → 400, nothing is stored.
 */
export function objectSettingsJson(v: unknown, defs: Record<string, SettingDef>, label: string): string {
  let obj: unknown = v;
  if (typeof v === "string") {
    try {
      obj = JSON.parse(v);
    } catch {
      throw new HttpError(400, `${label} doit être du JSON valide`, Codes.INVALID_JSON);
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new HttpError(400, `${label} doit être un objet`, Codes.INVALID_BODY);
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  const unknown = entries.map(([k]) => k).filter((k) => !(k in defs));
  if (unknown.length) {
    throw new HttpError(400, `${label} : clé(s) inconnue(s) : ${unknown.join(", ")}`, Codes.INVALID_FIELD);
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of entries) {
    const nv = validateValueWithDef(k, val, defs[k]);
    if (nv !== undefined) out[k] = nv;
  }
  return JSON.stringify(out);
}
