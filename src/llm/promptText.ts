/**
 * Prompt text store — per-language prompt files under `prompt/<lang>/<id>.txt`.
 *
 * Every prompt the app sends to a model lives as an editable text file instead
 * of a hard-coded French string in code. The store is lazy + cached: a file is
 * read on first use, missing files fail fast (a silently-empty system prompt
 * would corrupt generations). French is the fallback when a requested language
 * has no file yet, so prompts can be translated one at a time.
 *
 * Placeholders use `{{name}}` (double braces) so literal JSON examples in the
 * text (single braces) are never mistaken for variables — see `fill()`.
 */
import fs from "node:fs";
import path from "node:path";

/** Root of the prompt tree; overridable so tests can point at fixtures. */
export const PROMPT_DIR = process.env.INNSEKAI_PROMPT_DIR || path.join(process.cwd(), "prompt");

const cache = new Map<string, string>();

/** Load `prompt/<lang>/<id>.txt`, falling back to `fr`, then failing loudly. */
export function promptText(id: string, lang = "fr"): string {
  const langs = lang && lang !== "fr" ? [lang, "fr"] : ["fr"];
  for (const l of langs) {
    const key = `${l}:${id}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    try {
      const text = fs.readFileSync(path.join(PROMPT_DIR, l, `${id}.txt`), "utf8").replace(/\r\n/g, "\n").trimEnd();
      cache.set(key, text);
      return text;
    } catch {
      // try the next language
    }
  }
  throw new Error(`prompt introuvable : ${lang}/${id} (cherché dans ${PROMPT_DIR}/${lang}/${id}.txt et fr/)`);
}

/** Substitute `{{name}}` placeholders. Single-brace JSON stays untouched. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ""));
}

/** Convenience: load + fill in one call. */
export function promptFilled(id: string, vars: Record<string, string | number>, lang = "fr"): string {
  return fill(promptText(id, lang), vars);
}
