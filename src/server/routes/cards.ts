/**
 * cards resource router (extracted from the monolithic routes.ts).
 * Returns null when no route matches; throws are mapped by index.ts.
 */
import { MAX_IMPORT_FILES, MAX_TOTAL_BYTES, NEGATIVE_PROMPT, charSeed, descriptionToTags, json, mediaFileFor, messageView, readJson } from "./core";
import { createCard, deleteCard, getCard, getSetting, listCards, updateCard } from "../db";
import { errorResponse } from "../http";
import { trackJob, jobView } from "../jobs";
import { runBackup } from "../backup";
import { generateAndSave } from "../image";
import { placeholderPng, withCharaChunk } from "../cardExport";
import { type ImportResult, importFile, scanDirectory, sizeLimitFor } from "../importCards";
import { IMAGES_DIR, UPLOADS_DIR } from "../paths";
import fs from "node:fs";
import path from "node:path";

export async function handleCards(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const p = url.pathname;
  try {
if (p === "/api/import" && method === "POST") {
      const ct = req.headers.get("content-type") || "";
      const imported: any[] = [];
      const report: ImportResult[] = [];
      // safety net: snapshot the DB before the batch touches anything — the
      // import is bulk-writing, so a bad card must be undoable from backups
      const backup = runBackup(true);
      const pending: { name: string; bytes: Uint8Array }[] = [];
      if (ct.includes("multipart/form-data")) {
        const form = await req.formData();
        const entries = form.getAll("files");
        if (entries.length > MAX_IMPORT_FILES) return json({ error: `Maximum ${MAX_IMPORT_FILES} fichiers par import` }, 413);
        for (const f of entries) {
          if (typeof f === "string") continue;
          pending.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        }
      } else {
        const body = await readJson(req);
        const entries: { name?: string; base64?: string }[] = body.files ?? [];
        if (!Array.isArray(entries) || entries.length > MAX_IMPORT_FILES) {
          return json({ error: `Maximum ${MAX_IMPORT_FILES} fichiers par import` }, 413);
        }
        for (const f of entries) {
          if (!f || typeof f.base64 !== "string") continue;
          const raw = atob(f.base64);
          pending.push({ name: String(f.name ?? "?"), bytes: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
        }
      }
      // pass 1 — validate everything (format + per-file limit + batch total)
      let totalBytes = 0;
      const valid: { name: string; bytes: Uint8Array }[] = [];
      for (const f of pending) {
        const limit = sizeLimitFor(f.name);
        if (!limit) {
          report.push({ status: "invalid", name: f.name, reason: "Format non reconnu (PNG ou JSON attendu)" });
          continue;
        }
        if (f.bytes.byteLength > limit) {
          report.push({ status: "invalid", name: f.name, reason: `Fichier trop volumineux (${(f.bytes.byteLength / 1024 / 1024).toFixed(1)} Mo > limite ${Math.round(limit / 1024 / 1024)} Mo)` });
          continue;
        }
        totalBytes += f.bytes.byteLength;
        valid.push(f);
      }
      if (totalBytes > MAX_TOTAL_BYTES) {
        // nothing has been written yet — reject the whole batch
        return json({ error: "Import trop volumineux (maximum 50 Mo au total)" }, 413);
      }
      // pass 2 — import (only after the whole batch passed validation)
      for (const f of valid) {
        const res = importFile(f.name, f.bytes);
        report.push(res);
        if (res.status === "imported" && res.card) imported.push(messageView(res.card));
      }
      if (imported.length) console.log(`[import] 📥 ${imported.length} carte(s) — sauvegarde ${backup || "du jour déjà existante"}`);
      return json({ imported, duplicates: report.filter((r) => r.status === "duplicate").map((r) => r.name), report, backup });
    }

if (p === "/api/cards/scan" && method === "POST") {
      const body = await readJson(req);
      const dir = body.dir || "";
      if (!dir || !fs.existsSync(dir)) return json({ error: "Dossier introuvable" }, 400);
      const count = scanDirectory(dir);
      return json({ imported: count });
    }

if (p === "/api/cards" && method === "GET") {
      return json({ cards: listCards().map(messageView) });
    }

if (p === "/api/cards" && method === "POST") {
      const body = await readJson(req);
      if (body.avatar && typeof body.avatar === "string" && body.avatar.startsWith("data:image/")) {
        const match = body.avatar.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
        if (!match) return json({ error: "Avatar invalide" }, 400);
        const bytes = Buffer.from(match[2], "base64");
        if (bytes.length > 5 * 1024 * 1024) return json({ error: "Avatar limité à 5 Mo" }, 413);
        const card = createCard({ ...body, avatar: "" });
        const file = `card-${card.id}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
        fs.mkdirSync(path.join(UPLOADS_DIR, "avatars"), { recursive: true });
        fs.writeFileSync(path.join(UPLOADS_DIR, "avatars", file), bytes);
        return json(updateCard(card.id, { avatar: `/uploads/avatars/${file}` }), 201);
      }
      return json(createCard(body), 201);
    }

if (p === "/api/cards/generate-avatar" && method === "POST") {
      const body = await readJson(req);
      const name = String(body.name || "").trim().slice(0, 80);
      const description = String(body.description || "").trim().slice(0, 2000);
      const personality = String(body.personality || "").trim().slice(0, 2000);
      const scenario = String(body.scenario || "").trim().slice(0, 1000);
      let tags: string[] = [];
      try {
        const t = JSON.parse(String(body.tags || "[]"));
        if (Array.isArray(t)) tags = t.map(String).slice(0, 12);
      } catch {
        tags = String(body.tags || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12);
      }
      if (!name && !description && !personality && !scenario && !tags.length) return json({ error: "Remplis au moins un champ du personnage pour générer un avatar." }, 400);
      const cardId = Number(body.id);
      const seed =
        typeof body.seed === "number" ? body.seed
        : Number.isFinite(cardId) && cardId > 0 ? charSeed(cardId)
        : undefined;
      // same portrait pipeline as the message illustrations: identity tags + stable framing
      const charTags = descriptionToTags([name, description, personality, scenario, ...tags].join(" ")).slice(0, 18);
      const prompt = [
        "masterpiece, best quality, anime illustration, highly detailed, vibrant colors, character focus, one character",
        ...charTags,
        name.replace(/\s+/g, "_"),
        "portrait, solo, upper body, detailed face, face focus, looking at viewer, cinematic lighting, detailed background",
      ].filter(Boolean).join(", ");
      // img2img from the current avatar so rerolls keep the same face
      let init_image: string | undefined;
      const refBase = path.basename(String(body.ref_image || ""));
      if (refBase) {
        for (const dir of [path.join(IMAGES_DIR, "avatars"), path.join(UPLOADS_DIR, "avatars")]) {
          const f = path.join(dir, refBase);
          if (fs.existsSync(f)) { init_image = fs.readFileSync(f).toString("base64"); break; }
        }
      }
      // tracked job: the generation is long; the activity panel shows it and
      // the result is delivered on completion (see app.js's job events)
      const { job, result } = await trackJob(
        {
          type: "image",
          title: "Avatar IA",
          payload: {
            op: "avatar", name, description, personality, scenario, tags,
            seed, ref_image: String(body.ref_image || ""), cardId: Number.isFinite(cardId) && cardId > 0 ? cardId : undefined,
          },
          cancellable: true,
        },
        async () => {
          const res = await generateAndSave("avatars", {
            prompt,
            negative: NEGATIVE_PROMPT,
            steps: Number(getSetting("image_steps", 28)),
            cfg: Number(getSetting("image_cfg", 7)),
            width: Number(getSetting("image_width", 768)),
            height: Number(getSetting("image_height", 1152)),
            seed,
            init_image,
            strength: Number(getSetting("image_ref_strength", 0.55)),
          });
          console.log(`[cards/generate-avatar] 🎨 ${name || "nouveau personnage"}${seed != null ? ` seed ${seed}` : ""}${init_image ? " (img2img)" : ""}`);
          return res;
        },
      );
      return json({ image: result.url, seed: result.seed, job: jobView(job) });
    }

if (parts[1] === "cards" && parts[2] && !parts[3] && method === "PATCH") {
      const body = await readJson(req);
      if (body.avatar && typeof body.avatar === "string" && body.avatar.startsWith("data:image/")) {
        const match = body.avatar.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
        if (!match) return json({ error: "Avatar invalide" }, 400);
        const bytes = Buffer.from(match[2], "base64");
        if (bytes.length > 5 * 1024 * 1024) return json({ error: "Avatar limité à 5 Mo" }, 413);
        const file = `card-${Number(parts[2])}-${Date.now()}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
        fs.mkdirSync(path.join(UPLOADS_DIR, "avatars"), { recursive: true });
        fs.writeFileSync(path.join(UPLOADS_DIR, "avatars", file), bytes);
        body.avatar = `/uploads/avatars/${file}`;
      }
      const card = updateCard(Number(parts[2]), body);
      return card ? json(card) : json({ error: "not found" }, 404);
    }

if (parts[1] === "cards" && parts[2] && !parts[3] && method === "DELETE") {
      if (!getCard(Number(parts[2]))) return json({ error: "not found" }, 404);
      deleteCard(Number(parts[2]));
      return json({ ok: true, trashed: true });
    }

if (parts[1] === "cards" && parts[2] && parts[3] === "export-st" && method === "GET") {
      const card = getCard(Number(parts[2]));
      if (!card) return json({ error: "not found" }, 404);
      const chara = JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: card.name,
          description: [card.description, card.personality, card.scenario].filter(Boolean).join("\n\n"),
          personality: card.personality || "",
          scenario: card.scenario || "",
          first_mes: card.first_mes || "",
          mes_example: card.mes_example || "",
          system_prompt: card.system_prompt || "",
          post_history_instructions: card.post_history_instructions || "",
          creator: "Innsekai",
          character_version: "1.0",
          alternate_greetings: [],
          tags: [],
        },
      });
      let png: Uint8Array;
      const avatarFile = card.avatar ? mediaFileFor(card.avatar) : null;
      if (avatarFile && fs.existsSync(avatarFile)) png = new Uint8Array(fs.readFileSync(avatarFile));
      else png = placeholderPng(256, [43, 24, 66]);
      const out = withCharaChunk(png, chara);
      return new Response(out as unknown as BodyInit, {
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(card.name)}.png`,
        },
      });
    }
    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
