/**
 * Lightweight per-turn intention classification (§8.2). Rule-based French
 * keyword scoring — deterministic, offline, ~zero cost. Used to auto-adjust
 * the scene focus and to detect direction changes (the player drops a quest
 * for a quiet scene → the persistent scene plan is held for one turn).
 */
import type { SceneFocus } from "./prompt";

export type IntentCategory =
  | "exploration"
  | "conversation"
  | "romance"
  | "adulte"
  | "combat"
  | "enquete"
  | "tranche_de_vie"
  | "ooc"
  | "autre";

const KEYWORDS: Record<Exclude<IntentCategory, "autre" | "ooc">, string[]> = {
  combat: [
    "attaque", "attaque", "frappe", "epee", "combat", "bataille", "degaine", "tire", "esquive",
    "poursuite", "duel", "assaut", "defend", "arme", "poing", "lame", "fleche", "sort", "ennemi",
    "monstre", "coup", "escrime", "riposte", "charge", "tue", "tuer",
  ],
  romance: [
    "embrasse", "baiser", "bise", "caresse", "tendre", "amour", "etreint", "enlace", "romance",
    "desir", "seduit", "murmure", "amoureux", "amoureuse", "joue contre", "front contre",
    "lui prend la main", "prend sa main", "prend la main", "prends sa main", "prends la main",
  ],
  adulte: [
    "se deshabille", "se devet", "intimite", "erotique", "nu", "nue", "caresses intimes",
    "s'embrassent", "se font l'amour", "fait l'amour", "lit partage", "peau contre peau",
  ],
  enquete: [
    "enquete", "indice", "mystere", "disparition", "inspecte", "examine", "preuve", "interroge",
    "fouille", "resoudre", "piste", "traces", "etrange", "suspect", "alibi", "indices",
  ],
  conversation: [
    "demande", "parle", "discute", "raconte", "explique", "repond", "question", "s'assoit",
    "assieds", "assis", "va bien", "salue", "lui parle", "discussion", "bavarde", "confie",
    "demande si", "dit", "raconte-lui", "comment va",
  ],
  tranche_de_vie: [
    "cuisine", "dine", "mange", "se promene", "jardin", "maison", "se repose", "the", "cafe",
    "coucher de soleil", "fenetre", "livre", "detend", "paisible", "balade", "s'allonge",
  ],
  exploration: [
    "entre", "ouvre", "explore", "marche", "avance", "traverse", "cherche", "monte", "descend",
    "route", "voyage", "arrive", "franchit", "grimpe", "longe", "chemin", "foret", "porte",
    "caverne", "ruines", "village", "carte", "part", "quitte", "decouvre",
  ],
};

// tie-break priority: the most "demanding" intent wins when scores are equal
const PRIORITY: Exclude<IntentCategory, "autre">[] = [
  "combat", "adulte", "romance", "enquete", "tranche_de_vie", "conversation", "exploration",
];

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s/<>]/g, " ");
}

/** Classify one user message (raw text, as typed by the player). */
export function classifyIntent(text: string): IntentCategory {
  const n = norm(text);
  if (!n.trim()) return "autre";
  const scores = new Map<Exclude<IntentCategory, "autre">, number>();
  // OOC is detected by explicit typed markers (slash command, <OOC:, tags)
  if (/\/ooc\b|<ooc:?\s|\(ooc\)|hors-jeu|hors jeu|out of character|hors personnage/i.test(String(text || ""))) {
    return "ooc";
  }
  for (const [cat, kws] of Object.entries(KEYWORDS)) {
    const c = cat as Exclude<IntentCategory, "autre">;
    let s = 0;
    for (const kw of kws) {
      // word-boundary match: "main" must not hit "maintenant"
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(n)) s++;
    }
    if (s > 0) scores.set(c, s);
  }
  if (!scores.size) return "autre";
  let best: Exclude<IntentCategory, "autre"> = PRIORITY[0];
  let bestScore = 0;
  for (const c of PRIORITY) {
    const s = scores.get(c) ?? 0;
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return best;
}

/**
 * Direction change: the player abandons a long-running intent for a different
 * one (e.g. quest → domestic scene). Requires at least two consecutive turns
 * on the same category, and ignores ooc/autre (not fiction intents).
 */
export function directionChanged(history: IntentCategory[], current: IntentCategory): boolean {
  if (!history.length || current === "autre" || current === "ooc") return false;
  const last = history[history.length - 1];
  if (last === current || last === "autre" || last === "ooc") return false;
  let run = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === last) run++;
    else break;
  }
  return run >= 2;
}

/** Map a detected intent onto a scene focus (undefined → keep the profile's). */
export function intentToFocus(intent: IntentCategory): SceneFocus | undefined {
  switch (intent) {
    case "exploration": return "explorer";
    case "conversation": return "conversation";
    case "romance": return "romance";
    case "adulte": return "adulte";
    case "combat": return "combat";
    case "enquete": return "enquete";
    case "tranche_de_vie": return "tranche_de_vie";
    default: return undefined;
  }
}