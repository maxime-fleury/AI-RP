/**
 * worlds resource router (extracted from the monolithic routes.ts).
 * Returns null when no route matches; throws are mapped by index.ts.
 */
import { NEGATIVE_PROMPT, buildIllustrationPrompt, generateScenarioIntro, json, messageView, proposeTimelineEvents, readJson } from "./core";
import { createLocation, createLorebookEntry, createRelation, createScenario, createTimelineEvent, createWorld, deleteLocation, deleteLorebookEntry, deleteRelation, deleteScenario, deleteTimelineEvent, deleteWorld, getScenario, getSetting, getWorld, listConversations, listLocations, listLorebook, listMessages, listRelations, listScenarios, listTimeline, listWorlds, updateLocation, updateLorebookEntry, updateRelation, updateScenario, updateTimelineEvent, updateWorld } from "../db";
import { errorResponse } from "../http";
import { trackJob } from "../jobs";
import { Codes, apiError, en, fkId, intArray, optStr, settingsJson, str } from "../validate";
import { generateAndSave } from "../image";
import { zipFiles } from "../zip";
import { applyWorldTemplate, listWorldTemplates } from "../templates";

export async function handleWorlds(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
if (p === "/api/worlds" && method === "GET") {
      const worlds = listWorlds().map((w) => ({
        ...w,
        scenario_count: (listScenarios(w.id) as any[]).length,
      }));
      return json({ worlds });
    }

if (p === "/api/worlds" && method === "POST") {
      const body = await readJson(req);
      const w = createWorld({
        name: str(body.name, "name", { max: 160 }),
        description: optStr(body.description, "description", 5000),
        lore: optStr(body.lore, "lore", 20_000),
        tone: optStr(body.tone, "tone", 200),
        narration_style: optStr(body.narration_style, "narration_style", 200),
        language: optStr(body.language, "language", 20),
        settings: settingsJson(body.settings),
      });
      return json(w, 201);
    }

    // world templates: list the starter genres / apply one (creates ordinary,
    // fully editable rows — worlds, locations, lorebook, draft scenario)
    if (p === "/api/templates/worlds" && method === "GET") {
      return json({ templates: listWorldTemplates() });
    }

    if (parts[1] === "templates" && parts[2] === "worlds" && parts[3] && !parts[4] && method === "POST") {
      const r = applyWorldTemplate(String(parts[3]));
      if (!r) return json({ error: "not found" }, 404);
      return json(r, 201);
    }

if (parts[1] === "worlds" && parts[2] && !parts[3] && method === "GET") {
      const w = getWorld(Number(parts[2]));
      return w ? json(w) : json({ error: "not found" }, 404);
    }

if (parts[1] === "worlds" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = str(body.name, "name", { max: 160 });
      if (body.description !== undefined) patch.description = optStr(body.description, "description", 5000);
      if (body.lore !== undefined) patch.lore = optStr(body.lore, "lore", 20_000);
      if (body.tone !== undefined) patch.tone = optStr(body.tone, "tone", 200);
      if (body.narration_style !== undefined) patch.narration_style = optStr(body.narration_style, "narration_style", 200);
      if (body.cover !== undefined) patch.cover = optStr(body.cover, "cover", 300);
      if (body.map !== undefined) patch.map = optStr(body.map, "map", 300);
      if (body.settings !== undefined) patch.settings = settingsJson(body.settings);
      const w = updateWorld(Number(parts[2]), patch);
      return w ? json(w) : json({ error: "not found" }, 404);
    }

if (parts[1] === "worlds" && parts[2] && !parts[3] && method === "DELETE") {
      // soft delete → trash; restore via /api/trash
      if (!getWorld(Number(parts[2]))) return json({ error: "not found" }, 404);
      deleteWorld(Number(parts[2]));
      return json({ ok: true, trashed: true });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "cover" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      const userPrompt = optStr(body.prompt, "prompt", 1000);
      const sceneText = [world.description, world.lore, world.tone].filter(Boolean).join(" ");
      const prompt = userPrompt || buildIllustrationPrompt(world.name, "", world.tone || "épique", sceneText || `${world.name}, fantasy landscape`, "landscape");
      const { result } = await trackJob(
        {
          type: "image",
          title: "Couverture du monde",
          payload: { op: "world-cover", worldId: world.id },
          cancellable: true,
        },
        async () => {
          const cover = await generateAndSave(`worlds/${world.id}`, {
            prompt,
            negative: NEGATIVE_PROMPT,
            steps: Number(getSetting("image_steps", 28)),
            cfg: Number(getSetting("image_cfg", 7)),
            width: Number(getSetting("image_width", 1152)),
            height: Number(getSetting("image_height", 768)),
          });
          updateWorld(world.id, { cover: cover.url });
          return cover;
        },
      );
      return json({ cover: result.url });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "map" && parts[4] === "generate" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const prompt = [
        `Illustrated fantasy map of the world of "${world.name}".`,
        `Lore: ${(world.lore || world.description || "").slice(0, 800)}`,
        "Regions, capitals, forests, mountains, rivers, coastlines. Cartography style, top-down view, parchment texture, muted colors, hand-drawn labels. Landscape format.",
      ].join("\n");
      const { result } = await trackJob(
        {
          type: "image",
          title: "Carte du monde",
          payload: { op: "world-map", worldId: world.id },
          cancellable: true,
        },
        async () => {
          const saved = await generateAndSave(`worlds/${world.id}`, {
            prompt,
            negative: NEGATIVE_PROMPT,
            steps: 24,
            cfg: 6.5,
            width: 1216,
            height: 832,
          });
          updateWorld(world.id, { map: saved.url });
          return saved;
        },
      );
      return json({ map: result.url });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "map" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const texts: string[] = [];
      for (const c of listConversations().filter((x: any) => x.world_id === world.id)) {
        for (const m of listMessages(c.id)) if (m.role === "assistant") texts.push(m.content);
      }
      const seen = new Set<string>();
      const locations: string[] = [];
      // place names: two+ capitalized words — filter out sentence starters and
      // common words so narration like "Les échos de ta voix" isn't a "place"
      const SKIP = new Set(["Les", "Le", "La", "Un", "Une", "Des", "Au", "Aux", "Dans", "Sur", "Sous", "Et", "Mais", "Ou", "Elle", "Il", "Ils", "Elles", "Tu", "Vous", "Je", "Nous", "On", "Ce", "Cette", "Ces", "Son", "Sa", "Ses", "Mon", "Ma", "Mes", "Ton", "Ta", "Tes", "Notre", "Votre", "Leur", "Quand", "Comme", "Alors", "Soudain", "Puis", "Enfin", "Après", "Avant", "Devant", "Derrière", "Vers", "Avec", "Sans", "Pour", "Par", "Seul", "Tout", "Toute"]);
      const re = /\b([A-ZÀ-ÖØ-öø-ÿ][a-zà-öø-ÿ'’-]{2,24})\s+((?:de|du|des|d'|la|le|les|au|aux|en|l')?\s*[A-ZÀ-ÖØ-öø-ÿ][a-zà-öø-ÿ'’-]{2,24})/g;
      for (const t of texts) {
        for (const m of t.matchAll(re)) {
          const name = `${m[1]} ${m[2]}`.replace(/\s+/g, " ").trim();
          if (SKIP.has(m[1])) continue;
          if (SKIP.has(name.split(" ")[0])) continue;
          if (!seen.has(name)) { seen.add(name); locations.push(name); }
          if (locations.length >= 10) break;
        }
        if (locations.length >= 10) break;
      }
      return json({ map: world.map || null, locations });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "locations" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      return json({ locations: listLocations(world.id) });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "locations" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      return json(createLocation({
        world_id: world.id,
        name: str(body.name, "name", { max: 160 }),
        description: optStr(body.description, "description", 4000),
        x: body.x !== undefined && body.x !== null ? Number(body.x) : 0,
        y: body.y !== undefined && body.y !== null ? Number(body.y) : 0,
      }), 201);
    }

if (parts[1] === "locations" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      const row = updateLocation(Number(parts[2]), body);
      if (!row) return json({ error: "not found" }, 404);
      return json(row);
    }

if (parts[1] === "locations" && parts[2] && !parts[3] && method === "DELETE") {
      if (!updateLocation(Number(parts[2]), {})) return json({ error: "not found" }, 404);
      deleteLocation(Number(parts[2]));
      return json({ ok: true });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "lorebook" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      return json({ entries: listLorebook(world.id) });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "lorebook" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      return json(createLorebookEntry({
        world_id: world.id,
        name: str(body.name, "name", { max: 160 }),
        triggers: optStr(body.triggers, "triggers", 500),
        content: str(body.content, "content", { max: 4000 }),
        priority: body.priority !== undefined && body.priority !== null ? Number(body.priority) : 0,
        enabled: body.enabled === false || body.enabled === 0 ? 0 : 1,
      }), 201);
    }

if (parts[1] === "lorebook" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      const row = updateLorebookEntry(Number(parts[2]), body);
      if (!row) return json({ error: "not found" }, 404);
      return json(row);
    }

if (parts[1] === "lorebook" && parts[2] && !parts[3] && method === "DELETE") {
      if (!updateLorebookEntry(Number(parts[2]), {})) return json({ error: "not found" }, 404);
      deleteLorebookEntry(Number(parts[2]));
      return json({ ok: true });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "relations" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      return json({ relations: listRelations(world.id) });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "relations" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      return json(createRelation({
        world_id: world.id,
        from_name: str(body.from_name, "from_name", { max: 120 }),
        to_name: str(body.to_name, "to_name", { max: 120 }),
        kind: optStr(body.kind, "kind", 80),
      }), 201);
    }

if (parts[1] === "relations" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      const row = updateRelation(Number(parts[2]), body);
      if (!row) return json({ error: "not found" }, 404);
      return json(row);
    }

if (parts[1] === "relations" && parts[2] && !parts[3] && method === "DELETE") {
      if (!updateRelation(Number(parts[2]), {})) return json({ error: "not found" }, 404);
      deleteRelation(Number(parts[2]));
      return json({ ok: true });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "timeline" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      return json({ events: listTimeline(world.id) });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "timeline" && !parts[4] && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      return json(createTimelineEvent({
        world_id: world.id,
        label: str(body.label, "label", { max: 200 }),
        conversation_id: body.conversation_id != null ? fkId(body.conversation_id, "conversation_id") : null,
        message_id: body.message_id != null ? fkId(body.message_id, "message_id") : null,
      }), 201);
    }

if (parts[1] === "timeline" && parts[2] && !parts[3] && method === "DELETE") {
      if (!updateTimelineEvent(Number(parts[2]), {})) return json({ error: "not found" }, 404);
      deleteTimelineEvent(Number(parts[2]));
      return json({ ok: true });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "timeline" && parts[4] === "propose" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const result = await proposeTimelineEvents(world.id);
      if (!result) return json({ error: "Le modèle n'a pas pu analyser les parties" }, 502);
      return json(result);
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "export" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const files: { path: string; data: Uint8Array | string }[] = [
        { path: "world.json", data: JSON.stringify({ name: world.name, description: world.description, lore: world.lore, tone: world.tone, narration_style: world.narration_style, language: world.language, map: world.map, exported_at: new Date().toISOString() }, null, 2) },
        { path: "scenarios.json", data: JSON.stringify(listScenarios(world.id), null, 2) },
      ];
      for (const c of listConversations().filter((x: any) => x.world_id === world.id)) {
        const msgs = listMessages(c.id).map(messageView);
        const lines = msgs.map((m: any) => {
          const who = m.role === "user" ? "Moi" : m.name || "Narrateur";
          const body = (m.meta?.image ? `![illustration](${m.meta.image})\n` : "") + (m.content || "");
          return m.role === "user" ? `**${who}** : ${body}` : `> **${who}** : ${body}`;
        }).join("\n\n");
        const safe = (c.title || "partie").replace(/[^\p{L}\p{N} _-]+/gu, "").slice(0, 40);
        files.push({ path: `conversations/${c.id}-${safe}.md`, data: `# ${c.title}\n\n${lines}\n` });
      }
      const zip = zipFiles(files);
      const name = encodeURIComponent(world.name.replace(/[^\p{L}\p{N} _-]+/gu, "").slice(0, 40));
      return new Response(zip as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename*=UTF-8''${name}.zip`,
        },
      });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "scenarios" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      return json({ scenarios: listScenarios(world.id) });
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "scenarios" && parts[4] === "generate" && method === "POST") {
      const body = await readJson(req);
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const { name, intro } = await generateScenarioIntro(world, body.genre, body.theme);
      const customName = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
      // Generation is preview-only by default; persist only when explicitly requested.
      if (body.persist === true) return json(createScenario({ world_id: world.id, name: customName ?? name, intro }), 201);
      return json({ name: customName ?? name, intro, draft: true }, 200);
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "scenarios" && method === "POST") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const body = await readJson(req);
      // whitelist fields like /api/scenarios: never trust `world_id` in the
      // body (the path owns it) and never spread arbitrary fields through
      const s = createScenario({
        world_id: world.id,
        name: str(body.name, "name", { max: 160 }),
        intro: optStr(body.intro, "intro", 8000),
        notes: optStr(body.notes, "notes", 4000),
      });
      return json(s, 201);
    }

if (p === "/api/scenarios" && method === "POST") {
      const body = await readJson(req);
      const worldId = fkId(body.world_id, "world_id", false)!;
      if (!getWorld(worldId)) apiError(Codes.OWNERSHIP, "world_id inconnu", 422);
      return json(createScenario({
        world_id: worldId,
        name: str(body.name, "name", { max: 160 }),
        intro: optStr(body.intro, "intro", 8000),
        notes: optStr(body.notes, "notes", 4000),
      }), 201);
    }

if (parts[1] === "scenarios" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = str(body.name, "name", { max: 160 });
      if (body.intro !== undefined) patch.intro = optStr(body.intro, "intro", 8000);
      if (body.notes !== undefined) patch.notes = optStr(body.notes, "notes", 4000);
      const row = updateScenario(Number(parts[2]), patch);
      return row ? json(row) : json({ error: "not found" }, 404);
    }

if (parts[1] === "scenarios" && parts[2] && !parts[3] && method === "DELETE") {
      const before = getScenario(Number(parts[2]));
      if (!before) return json({ error: "not found" }, 404);
      deleteScenario(Number(parts[2]));
      return json({ ok: true, trashed: true });
    }

if (parts[1] === "scenarios" && parts[2] && parts[3] === "generate" && method === "POST") {
      const body = await readJson(req);
      const scenario = getScenario(Number(parts[2]));
      if (!scenario) return json({ error: "not found" }, 404);
      const world = getWorld(scenario.world_id);
      const theme = body.theme || scenario.name || "un nouveau départ";
      const { intro } = await generateScenarioIntro(world, body.genre, theme);
      return json(updateScenario(scenario.id, { intro }));
    }

if (parts[1] === "worlds" && parts[2] && parts[3] === "gallery" && method === "GET") {
      const world = getWorld(Number(parts[2]));
      if (!world) return json({ error: "not found" }, 404);
      const items: any[] = [];
      const push = (image: string, kind: string | null, character: string | null, seed: number | null, msg: string, convId: number | null, convTitle: string, createdAt: number, fav: number, mid?: number) => {
        items.push({ image, kind, character, seed, message: msg.slice(0, 200), conversation_id: convId, conversation: convTitle, created_at: createdAt, fav, id: mid ?? `w${image}` });
      };
      for (const conv of listConversations().filter((c) => c.world_id === world.id)) {
        for (const m of listMessages(conv.id).map(messageView)) {
          const meta = m.meta as any;
          if (meta?.image) push(meta.image, meta.image_kind ?? null, meta.image_char ?? null, meta.image_seed ?? meta.seed ?? null, m.content || "", conv.id, conv.title, m.created_at, meta.image_fav ? 1 : 0, m.id);
        }
      }
      if (world.cover) push(world.cover, "landscape", null, null, "Couverture du monde", null, world.name, world.created_at ?? Date.now(), 0);
      if (world.map) push(world.map, "landscape", null, null, "Carte du monde", null, world.name, world.created_at ?? Date.now(), 0);
      items.sort((a, b) => b.created_at - a.created_at);
      return json({ items });
    }
    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
