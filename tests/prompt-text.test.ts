import { describe, test, expect, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fill, promptFilled, promptText } from "../src/llm/promptText";

describe("prompt store", () => {
  test("summarize-system keeps its exact wording and JSON schema", () => {
    const t = promptText("summarize-system");
    expect(t).toContain("Tu compresses un fil de roleplay en une mémoire structurée");
    expect(t).toContain('{"location": "lieu actuel"');
    expect(t).toContain("Si tu ne peux pas produire de JSON, écris 3 à 6 phrases en français à la place.");
    expect(t.endsWith("\n")).toBe(false);
  });

  test("fill substitutes {{vars}} but leaves JSON single braces intact", () => {
    const t = fill('Mets {persona} à jour. {"json": 1} et {{persona}} fin.', { persona: "Alba" });
    expect(t).toBe('Mets {persona} à jour. {"json": 1} et Alba fin.');
  });

  test("chat-suggest-system fills persona and optional cast line", () => {
    const noCast = promptFilled("chat-suggest-system", { persona: "Moi", castLine: "" });
    expect(noCast).toContain("Le joueur s'appelle Moi.");
    expect(noCast).not.toContain("personnages présents");
    const withCast = promptFilled("chat-suggest-system", {
      persona: "Alba",
      castLine: ", les personnages présents sont : Théo, Ines",
    });
    expect(withCast).toContain("Le joueur s'appelle Alba, les personnages présents sont : Théo, Ines.");
    expect(withCast).toContain("une suggestion par ligne commençant par « - »");
  });

  test("questions-system fills the count and persona into the prose", () => {
    const t = promptFilled("questions-system", { count: 5, persona: "Alba" });
    expect(t).toContain("Tu prépares 5 questions à poser au joueur (Alba)");
    expect(t).toContain('[{"q":"question","answers":["proposition 1","proposition 2","proposition 3"]}]');
    expect(t).toContain("JSON complet, non tronqué.");
  });

  test("language fallback: en file used when present, fr otherwise", () => {
    const en = promptText("summarize-system", "en");
    expect(en).toContain("You compress a roleplay thread");
    // no en translation yet → falls back to the French file
    const frFallback = promptText("chat-suggest-system", "en");
    expect(frFallback).toContain("Tu es l'assistant de jeu");
  });

  test("every prompt id referenced in code has a fr file", () => {
    const root = path.resolve(import.meta.dir, "..");
    const frDir = path.join(root, "prompt", "fr");
    const files = new Set(fs.readdirSync(frDir));
    const ids = new Set<string>();
    const scan = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.includes("node_modules") || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (/\.[cm]?[jt]sx?$/.test(e.name) && !e.name.endsWith(".test.ts")) {
          const src = fs.readFileSync(p, "utf8");
          for (const m of src.matchAll(/prompt(?:Text|Filled)\s*\(\s*"([a-z0-9-]+)"/g)) ids.add(m[1]);
        }
      }
    };
    scan(path.join(root, "src"));
    expect(ids.size).toBeGreaterThan(10);
    const missing = [...ids].filter((id) => !files.has(`${id}.txt`));
    expect(missing).toEqual([]);
    // no stray non-fr language dirs outside en
    const langs = fs.readdirSync(path.join(root, "prompt")).filter((d) => !d.includes("."));
    expect(langs.sort()).toEqual(["en", "fr"]);
  });

  test("no hard-coded one-shot system-prompt arrays remain in the RP modules", () => {
    const root = path.resolve(import.meta.dir, "..");
    for (const rel of ["src/llm/prompt.ts", "src/server/routes/core.ts"]) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      expect(src).not.toMatch(/const sys\s*=\s*\[/);
    }
  });
});
