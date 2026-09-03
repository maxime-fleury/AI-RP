/**
 * API-boundary validation: stable machine-readable error codes + small
 * validators for IDs, enums, numeric ranges, text lengths, JSON shapes and
 * upload constraints. Every validator throws an HttpError carrying a stable
 * `code`; the router catch maps it to `{ error, code }` (see http.ts).
 */
import { HttpError } from "./http";

export const Codes = {
  NOT_FOUND: "NOT_FOUND",
  INVALID_ID: "INVALID_ID",
  INVALID_JSON: "INVALID_JSON",
  INVALID_BODY: "INVALID_BODY",
  INVALID_FIELD: "INVALID_FIELD",
  INVALID_ENUM: "INVALID_ENUM",
  OUT_OF_RANGE: "OUT_OF_RANGE",
  TOO_SHORT: "TOO_SHORT",
  TOO_LONG: "TOO_LONG",
  EMPTY: "EMPTY",
  BAD_MEDIA: "BAD_MEDIA",
  BAD_MIME: "BAD_MIME",
  BAD_SIGNATURE: "BAD_SIGNATURE",
  OWNERSHIP: "OWNERSHIP",
  DUPLICATE: "DUPLICATE",
  UNAUTHORIZED: "UNAUTHORIZED",
  CONFLICT: "CONFLICT",
  RATE_LIMIT: "RATE_LIMIT",
} as const;
export type ErrCode = (typeof Codes)[keyof typeof Codes];

export function apiError(code: ErrCode, message: string, status = 400): never {
  throw new HttpError(status, message, code);
}

export function notFound(message = "not found"): never {
  throw new HttpError(404, message, Codes.NOT_FOUND);
}

/** Parse a positive integer path/id parameter. */
export function idParam(raw: string | undefined, label = "id"): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isInteger(n) || n <= 0) {
    apiError(Codes.INVALID_ID, `${label} invalide`);
  }
  return n;
}

/** Validate a foreign-key id inside a JSON body (optional when allowNull). */
export function fkId(v: unknown, label: string, allowNull = true): number | null {
  if (v === null || v === undefined || v === "") {
    if (allowNull) return null;
    apiError(Codes.INVALID_ID, `${label} requis`);
  }
  if (typeof v === "boolean") apiError(Codes.INVALID_ID, `${label} invalide`);
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) apiError(Codes.INVALID_ID, `${label} invalide`);
  return n;
}

export function str(
  v: unknown,
  label: string,
  opts: { min?: number; max?: number; required?: boolean; trim?: boolean } = {},
): string {
  const { min = 0, max = Infinity, required = true, trim = true } = opts;
  if (v === null || v === undefined || v === "") {
    if (required) apiError(Codes.EMPTY, `${label} requis`);
    return "";
  }
  if (typeof v !== "string") apiError(Codes.INVALID_FIELD, `${label} doit être une chaîne`);
  const s = trim ? v.trim() : v;
  if (required && !s) apiError(Codes.EMPTY, `${label} requis`);
  if (s.length < min) apiError(Codes.TOO_SHORT, `${label} : minimum ${min} caractère(s)`);
  if (s.length > max) apiError(Codes.TOO_LONG, `${label} : maximum ${max} caractère(s)`);
  return s;
}

export function optStr(v: unknown, label: string, max = Infinity): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") apiError(Codes.INVALID_FIELD, `${label} doit être une chaîne`);
  if (v.length > max) apiError(Codes.TOO_LONG, `${label} : maximum ${max} caractère(s)`);
  return v.trim();
}

export function num(v: unknown, label: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== "number" || Number.isNaN(v)) apiError(Codes.INVALID_FIELD, `${label} doit être un nombre`);
  if (v < min || v > max) apiError(Codes.OUT_OF_RANGE, `${label} doit être entre ${min} et ${max}`);
  return v;
}

export function int(v: unknown, label: string, min = -Infinity, max = Infinity): number {
  const n = num(v, label, min, max);
  if (!Number.isInteger(n)) apiError(Codes.INVALID_FIELD, `${label} doit être un entier`);
  return n;
}

export function bool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") apiError(Codes.INVALID_FIELD, `${label} doit être un booléen`);
  return v;
}

export function en<T extends string>(v: unknown, label: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    apiError(Codes.INVALID_ENUM, `${label} doit être l'un de : ${allowed.join(", ")}`);
  }
  return v as T;
}

export function obj(v: unknown, label: string): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) apiError(Codes.INVALID_BODY, `${label} doit être un objet`);
  return v as Record<string, unknown>;
}

/**
 * Settings payload: accept either a plain object or a pre-serialized JSON
 * string (the world editor sends a JSON.stringify'd settings blob). Returns
 * the settings as a JSON string for storage, or throws on bad JSON.
 */
export function settingsJson(v: unknown): string {
  if (typeof v === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      apiError(Codes.INVALID_JSON, "settings doit être du JSON valide");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      apiError(Codes.INVALID_JSON, "settings doit être un objet JSON");
    }
    return v;
  }
  return JSON.stringify(obj(v, "settings"));
}

export function arr(v: unknown, label: string): unknown[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) apiError(Codes.INVALID_BODY, `${label} doit être un tableau`);
  return v;
}

export function intArray(v: unknown, label: string): number[] {
  const a = arr(v, label);
  const out: number[] = [];
  for (const x of a) {
    if (typeof x === "boolean") apiError(Codes.INVALID_ID, `${label} : id invalide dans le tableau`);
    const n = Number(x);
    if (!Number.isInteger(n) || n <= 0) apiError(Codes.INVALID_ID, `${label} : id invalide dans le tableau`);
    out.push(n);
  }
  return out;
}

/** Validate a data:image/… avatar payload; returns { ext, bytes } or throws. */
export function dataImage(v: unknown, label = "Avatar"): { ext: string; bytes: Uint8Array } {
  if (typeof v !== "string" || !v.startsWith("data:image/")) {
    apiError(Codes.BAD_MEDIA, `${label} invalide (data:image attendu)`);
  }
  const m = v.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
  if (!m) apiError(Codes.BAD_MIME, `${label} : format non supporté (png/jpeg/webp)`);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(m![2]), (c) => c.charCodeAt(0));
  } catch {
    apiError(Codes.BAD_MEDIA, `${label} : base64 invalide`);
  }
  if (bytes!.length > 5 * 1024 * 1024) apiError(Codes.OUT_OF_RANGE, `${label} limité à 5 Mo`, 413);
  return { ext: m![1] === "jpeg" ? "jpg" : m![1], bytes: bytes! };
}

/**
 * Sniff a file's real content signature (magic bytes) against its extension,
 * so a .png renamed to .json (or vice versa) is rejected before import.
 * Returns the detected kind when it matches, or null when it doesn't.
 */
export function sniffImage(ext: string, bytes: Uint8Array): boolean {
  const head = (n: number) => {
    const b = bytes.subarray(0, n);
    return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  switch (ext.toLowerCase()) {
    case "png": return head(8) === "89504e470d0a1a0a";
    case "jpg":
    case "jpeg": {
      const h = head(3);
      return h === "ffd8ff";
    }
    case "webp": return head(4) === "52494646" && bytes.length >= 12 && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === "WEBP";
    case "gif": return head(4) === "47494638";
    default: return false; // unknown ext — reject rather than skip the check
  }
}