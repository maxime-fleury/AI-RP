/**
 * Post-generation guardrail (§8.9): lightweight, rule-based drift checks that
 * run AFTER the response is committed (prevention alone never guarantees
 * obedience on a small model). No model call — pure regex over the reply.
 *
 * Two drift families:
 *  1. player puppeting — the AI spoke/decided for the player (always active);
 *  2. unrequested major event — a plot move nobody asked for, only checked
 *     when the active focus protects a calm scene (conversation / romance /
 *     adulte / tranche de vie) and the profile is not cinematic.
 */

export interface DriftIssue {
  kind: "player_puppet" | "unrequested_event";
  detail: string;
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PLAYER_DECISION_RE = /\b(?:tu|vous)\s+(?:décides|choisis|prends la décision)\b|\ble\s+joueur\s+(?:décide|choisit|pense|ressent|sent|sait)\b/i;

/** line-initial surprise openers + strong agentless event nouns */
const EVENT_RE = [
  /^\s*(?:soudain|tout à coup|brusquement|sans prévenir|d'un coup|sans crier gare)\b/i,
  /\b(?:une attaque|des ennemis|un piège|un grondement|un hurlement|une révélation|quelqu'un frappe|un inconnu entre|des bruits de pas)\b/i,
];

export function checkResponseDrift(
  full: string,
  opts: { personaName?: string; focus?: string; behavior: "reactif" | "equilibre" | "cinematique" },
): DriftIssue[] {
  if (!full || !full.trim()) return [];
  const issues: DriftIssue[] = [];
  const persona = (opts.personaName || "").trim();

  if (persona) {
    // dialogue line attributed to the player persona: "Name: \"…\""
    const dialogueRe = new RegExp(`^\\s*${escRe(persona)}\\s*[:：]\\s*["«]`, "i");
    for (const line of full.split("\n")) {
      if (dialogueRe.test(line)) {
        issues.push({ kind: "player_puppet", detail: "dialogue attribué au joueur" });
        break;
      }
    }
    if (!issues.some((i) => i.kind === "player_puppet") && PLAYER_DECISION_RE.test(full)) {
      issues.push({ kind: "player_puppet", detail: "décision ou réaction du joueur décidée par l'IA" });
    }
  }

  const calmFocus = opts.focus === "conversation" || opts.focus === "romance" || opts.focus === "adulte" || opts.focus === "tranche_de_vie";
  if (calmFocus && opts.behavior !== "cinematique") {
    for (const line of full.split("\n")) {
      if (EVENT_RE.some((re) => re.test(line))) {
        issues.push({ kind: "unrequested_event", detail: line.trim().slice(0, 90) });
        break;
      }
    }
  }

  return issues;
}