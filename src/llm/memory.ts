/**
 * Unified memory store (§8.8): every long-term source (rolling summary,
 * structured memory, chapters, session recap, loop summaries, lore entries)
 * converges into ONE relevance-selected block injected into the prompt.
 *
 * Selection is deterministic and offline: normalized keyword-overlap between
 * the candidate and the current turn (+ recent exchanges), a recency bonus for
 * narrative sources, and near-duplicate dedupe. The interface is deliberately
 * small so an embedding-based retriever can replace the scorer later without
 * touching the prompt compiler.
 */

export interface MemoryCandidateInput {
  /** rolling summary (text form, readable rendering of structured memory). */
  summary?: string;
  memoryText?: string;
  /** trigger-activated lore entries (already matched against the fiction). */
  lore?: { name: string; content: string }[];
  chapters?: { n: number; title: string; summary: string }[];
  recap?: { title?: string; text: string };
  loopsText?: string;
}

export interface MemorySelectOpts {
  /** current user turn + recent exchanges, used as the query. */
  query: string;
  mode: "simple" | "avance";
  /** hard cap on the block's total length in characters. */
  maxChars: number;
}

const STOP_WORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "à", "au", "aux",
  "dans", "sur", "avec", "pour", "se", "je", "tu", "il", "elle", "on", "nous",
  "vous", "ils", "elles", "ne", "pas", "que", "qui", "quoi", "ce", "cette",
  "ces", "son", "sa", "ses", "mon", "ma", "mes", "ton", "ta", "tes", "en", "y",
  "vers", "par", "est", "sont", "a", "ont", "fait", "faire", "plus", "moins",
  "très", "bien", "aussi", "mais", "si", "donc", "car", "tout", "toute", "tous",
  "toutes", "être", "avoir", "comme", "chez", "sous", "entre",
]);

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ");
}

function words(s: string): string[] {
  return norm(s).split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Ratio of the candidate's content words that also appear in the query. */
function overlap(query: string, text: string): number {
  const qw = new Set(words(query));
  const tw = words(text);
  if (!qw.size || !tw.length) return 0;
  return tw.filter((w) => qw.has(w)).length / tw.length;
}

interface Item {
  text: string;
  score: number;
  always?: boolean;
}

/**
 * Returns the memory lines to inject (already deduped, relevance-sorted and
 * capped at maxChars). The rolling summary / structured memory are the primary
 * memory and are ALWAYS included; everything else participates only when the
 * current turn actually touches it (fixing the lorebook one-turn delay: the
 * query includes the current user message).
 */
export function selectRelevantMemory(input: MemoryCandidateInput, opts: MemorySelectOpts): string[] {
  const query = opts.query || "";
  // fresh session start (no current turn, empty history): narrative spine
  // (recap, chapters) is injected anyway so "Previously on…" survives
  const freshStart = !query.trim();
  const items: Item[] = [];

  const primary = (input.memoryText || input.summary || "").replace(/^\(Session antérieure résumée\)\s*/i, "").trim();
  if (primary) items.push({ text: primary, score: 5, always: true });

  for (const l of input.lore ?? []) {
    const t = `${l.name} : ${l.content}`.trim();
    if (!t) continue;
    // lore participates only when the fiction actually mentions it (the caller
    // already trigger-matched; the overlap refines the ranking)
    const o = overlap(query, t);
    if (o > 0) items.push({ text: t, score: 4 * (0.25 + 0.75 * o) });
  }

  if (opts.mode === "avance") {
    for (const c of input.chapters ?? []) {
      const t = `Chapitre ${c.n}${c.title ? ` — ${c.title}` : ""} : ${(c.summary || "").trim()}`.trim();
      if (!t) continue;
      const o = overlap(query, t);
      if (o > 0.05 || freshStart) items.push({ text: t, score: 3 * (0.2 + 0.8 * o) });
    }
    if (input.recap?.text) {
      const t = `Récapitulatif${input.recap.title ? ` (${input.recap.title})` : ""} : ${input.recap.text.trim()}`.trim();
      const o = overlap(query, t);
      if (o > 0.05 || freshStart) items.push({ text: t, score: 3 * (0.2 + 0.8 * o) });
    }
    if (input.loopsText) items.push({ text: input.loopsText, score: 1, always: true });
  }

  // near-duplicate dedupe (summary vs memory mirror, overlapping chapters…)
  const seen: string[] = [];
  const deduped = items.filter((it) => {
    const n = norm(it.text).replace(/\s+/g, " ").trim();
    if (!n) return false;
    if (seen.some((s) => s.includes(n) || n.includes(s))) return false;
    seen.push(n);
    return true;
  });

  const sorted = [...deduped].sort((a, b) => (b.always ? 1 : 0) - (a.always ? 1 : 0) || b.score - a.score);
  const out: string[] = [];
  let used = 0;
  for (const it of sorted) {
    const need = it.text.length + 2;
    if (used + need > opts.maxChars && out.length) break;
    out.push(it.text);
    used += need;
  }
  return out;
}