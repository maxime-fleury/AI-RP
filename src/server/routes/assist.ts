/**
 * assist resource router: AI-assisted creation (card ideas + the guided
 * world/persona/character/cards builder). Every call runs as a tracked job so
 * the activity panel shows queued → running → completed/failed — the response
 * is still delivered synchronously (the UI fills fields from it).
 */
import { CARD_ASSIST_FIELDS, assistCards, assistCharacters, assistPersonas, assistWorlds, generateCardAssist, json, readJson } from "./core";
import { listCards, listPersonas, listWorlds } from "../db";
import { HttpError, errorResponse } from "../http";
import { jobView, registerJobRetry, trackJob } from "../jobs";
import { logWarn } from "../log";

// Retry from the activity panel: re-runs the same generation with the stored
// payload and RETURNS the fresh proposals — the hub persists them on the job
// row, so the "Voir" button shows what the retry produced. (The editor that
// fired the original call already received its own response.)
registerJobRetry("assist", async (payload) => {
  const kind = String(payload.kind || (payload.idea ? "card" : ""));
  if (kind === "card") {
    const idea = String(payload.idea || "");
    if (!idea) throw new HttpError(400, "Idée manquante — relance l'assistant depuis la création de personnage.");
    const fields = await generateCardAssist(idea);
    if (!CARD_ASSIST_FIELDS.some((k) => fields[k].length)) {
      throw new HttpError(502, "Le modèle n'a rien proposé — réessaie ou vérifie ta connexion IA.");
    }
    return { fields };
  }
  if (kind === "build") {
    const stage = String(payload.stage || "");
    const description = String(payload.description || "");
    const feedback = String(payload.feedback || "");
    if (!description) throw new HttpError(400, "Description manquante — relance l'assistant guidé.");
    if (stage === "worlds") {
      const existing = listWorlds().sort((a, b) => b.created_at - a.created_at).slice(0, 25)
        .map((w) => ({ id: w.id, name: w.name, description: w.description, tone: w.tone }));
      const r = await assistWorlds(description, feedback, existing);
      if (!r.matches.length && !r.proposals.length) throw new HttpError(502, "Le modèle n'a rien fourni — réessaie.");
      return r;
    }
    if (stage === "personas") {
      const existing = listPersonas().sort((a, b) => b.created_at - a.created_at).slice(0, 25)
        .map((p) => ({ id: p.id, name: p.name, description: p.description }));
      const r = await assistPersonas(description, (payload.world as any) ?? null, feedback, existing);
      if (!r.matches.length && !r.proposals.length) throw new HttpError(502, "Le modèle n'a rien fourni — réessaie.");
      return r;
    }
    if (stage === "characters") {
      const cards = listCards().map((c) => ({ id: c.id, name: c.name, description: c.description }));
      return assistCharacters(description, (payload.world as any) ?? null, (payload.persona as any) ?? null, cards, feedback);
    }
    if (stage === "cards") {
      const r = await assistCards(description, (payload.world as any) ?? null, (payload.character as any) ?? undefined, feedback);
      if (!r.proposals.length) throw new HttpError(502, "Le modèle n'a rien fourni — réessaie.");
      return r;
    }
    throw new HttpError(400, "Étape inconnue — relance l'assistant guidé.");
  }
  throw new HttpError(400, "Ce job ne contient pas de quoi être rejoué — relance l'assistant depuis l'éditeur.");
});

export async function handleAssist(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
    if (p === "/api/cards/assist" && method === "POST") {
      const body = await readJson(req);
      const rawIdea = String(body.idea || "").trim();
      const idea = rawIdea.slice(0, 1500);
      if (!idea) return json({ error: "Décris d'abord ton idée de personnage." }, 400);
      const { job, result } = await trackJob(
        {
          type: "assist",
          title: "Idée de personnage",
          payload: { kind: "card", idea },
          cancellable: true,
          retryable: true,
        },
        async () => {
          const fields = await generateCardAssist(idea);
          const hasAny = CARD_ASSIST_FIELDS.some((k) => fields[k].length);
          if (!hasAny) {
            throw new HttpError(502, "Le modèle n'a rien proposé — réessaie ou vérifie ta connexion IA.");
          }
          return { fields };
        },
      );
      return json({
        ...result,
        job: jobView(job),
        ...(rawIdea.length > 1500 ? { truncated: true, note: "Idée tronquée à 1500 caractères — raccourcis-la pour un meilleur résultat." } : {}),
      });
    }

    if (p === "/api/assist/build" && method === "POST") {
      const body = await readJson(req);
      const stage = String(body.stage || "");
      const rawDescription = String(body.description || "").trim();
      const description = rawDescription.slice(0, 3000);
      if (!description) return json({ error: "Décris d'abord ton idée de partie." }, 400);
      if (!["worlds", "personas", "characters", "cards"].includes(stage)) {
        return json({ error: "Étape inconnue." }, 400);
      }
      const feedback = String(body.feedback || "").trim().slice(0, 500);
      const world = body.world && typeof body.world === "object" ? (body.world as Record<string, unknown>) : null;
      const persona = body.persona && typeof body.persona === "object" ? (body.persona as Record<string, unknown>) : null;
      const character = body.character && typeof body.character === "object" ? (body.character as Record<string, unknown>) : null;
      const { job, result } = await trackJob(
        {
          type: "assist",
          title: `Assistant — ${stage}`,
          // full context so a failed job can be retried from the activity panel
          payload: { kind: "build", stage, description, feedback, world, persona, character },
          cancellable: true,
          retryable: true,
        },
        async () => {
          try {
            const t0 = Date.now();
            if (stage === "worlds") {
              const existing = listWorlds()
                .sort((a, b) => b.created_at - a.created_at)
                .slice(0, 25)
                .map((w) => ({ id: w.id, name: w.name, description: w.description, tone: w.tone }));
              const r = await assistWorlds(description, feedback, existing);
              console.log(`[assist/worlds] ${r.matches.length} correspondance(s), ${r.proposals.length} proposition(s) — ${Date.now() - t0} ms`);
              if (!r.matches.length && !r.proposals.length) {
                throw new HttpError(502, "Le modèle n'a pas fourni de monde exploitable — réessaie.");
              }
              return r;
            }
            if (stage === "personas") {
              const existing = listPersonas()
                .sort((a, b) => b.created_at - a.created_at)
                .slice(0, 25)
                .map((p) => ({ id: p.id, name: p.name, description: p.description }));
              const r = await assistPersonas(description, world, feedback, existing);
              console.log(`[assist/personas] ${r.matches.length} correspondance(s), ${r.proposals.length} proposition(s) — ${Date.now() - t0} ms`);
              if (!r.matches.length && !r.proposals.length) {
                throw new HttpError(502, "Le modèle n'a pas fourni de persona exploitable — réessaie.");
              }
              return r;
            }
            if (stage === "characters") {
              const cards = listCards().map((c) => ({ id: c.id, name: c.name, description: c.description }));
              const r = await assistCharacters(description, world, persona, cards, feedback);
              console.log(`[assist/characters] ${r.characters.length} personnage(s) — ${Date.now() - t0} ms`);
              return r;
            }
            if (stage === "cards") {
              const r = await assistCards(description, world, body.character as Record<string, unknown> | undefined, feedback);
              console.log(`[assist/cards] ${r.proposals.length} proposition(s) — ${Date.now() - t0} ms`);
              if (!r.proposals.length) {
                throw new HttpError(502, "Le modèle n'a pas fourni de carte exploitable — réessaie.");
              }
              return r;
            }
            throw new HttpError(400, "Étape inconnue.");
            // unreachable — the stage is validated before the job is created
          } catch (e) {
            if (e instanceof HttpError) throw e;
            logWarn("assist", "build failed", { stage, error: String((e as Error)?.message ?? e).slice(0, 200) });
            throw new HttpError(502, "L'IA n'a pas répondu — vérifie que LM Studio est lancé, puis réessaie.");
          }
        },
      );
      return json({
        ...result,
        job: jobView(job),
        ...(rawDescription.length > 3000 ? { truncated: true, note: "Description tronquée à 3000 caractères." } : {}),
      });
    }

    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
