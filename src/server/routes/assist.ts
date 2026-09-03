/**
 * assist resource router: AI-assisted creation (card ideas + the guided
 * world/persona/character/cards builder). Every call runs as a tracked job so
 * the activity panel shows queued → running → completed/failed — the response
 * is still delivered synchronously (the UI fills fields from it).
 */
import { CARD_ASSIST_FIELDS, assistCards, assistCharacters, assistPersonas, assistWorlds, generateCardAssist, json, readJson } from "./core";
import { listCards, listPersonas, listWorlds } from "../db";
import { HttpError, errorResponse } from "../http";
import { jobView, trackJob } from "../jobs";

export async function handleAssist(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
    if (p === "/api/cards/assist" && method === "POST") {
      const body = await readJson(req);
      const idea = String(body.idea || "").trim().slice(0, 1500);
      if (!idea) return json({ error: "Décris d'abord ton idée de personnage." }, 400);
      const { job, result } = await trackJob(
        {
          type: "assist",
          title: "Idée de personnage",
          payload: { idea },
          cancellable: true,
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
      return json({ ...result, job: jobView(job) });
    }

    if (p === "/api/assist/build" && method === "POST") {
      const body = await readJson(req);
      const stage = String(body.stage || "");
      const description = String(body.description || "").trim().slice(0, 3000);
      if (!description) return json({ error: "Décris d'abord ton idée de partie." }, 400);
      if (!["worlds", "personas", "characters", "cards"].includes(stage)) {
        return json({ error: "Étape inconnue." }, 400);
      }
      const feedback = String(body.feedback || "").trim().slice(0, 500);
      const world = body.world && typeof body.world === "object" ? (body.world as Record<string, unknown>) : null;
      const persona = body.persona && typeof body.persona === "object" ? (body.persona as Record<string, unknown>) : null;
      const { job, result } = await trackJob(
        {
          type: "assist",
          title: `Assistant — ${stage}`,
          payload: { stage, description, feedback },
          cancellable: true,
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
            console.warn(`[assist/${stage}] échec :`, String((e as Error)?.message ?? e).slice(0, 200));
            throw new HttpError(502, "L'IA n'a pas répondu — vérifie que LM Studio est lancé, puis réessaie.");
          }
        },
      );
      return json({ ...result, job: jobView(job) });
    }

    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
