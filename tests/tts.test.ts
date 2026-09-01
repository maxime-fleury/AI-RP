import { describe, test, expect } from "bun:test";
import { loadApp } from "./helpers";
import { buildUnits, joinSegments } from "../src/tts/service";
import type { Segment } from "../src/llm/prompt";

const { db } = await loadApp();

const ctx = {
  narratorVoice: "jean",
  defaultVoice: "cosette",
  language: "fr" as const,
  characterVoices: { alba: "cosette" },
  characterLangs: { alba: "fr" },
  lsdSteps: 1,
};

const narr = (t: string): Segment => ({ type: "narration", speaker: "", text: t });
const diag = (s: string, t: string): Segment => ({ type: "dialogue", speaker: s, text: t });

describe("buildUnits (TTS segment merging)", () => {
  test("short consecutive narrations merge into one unit", () => {
    const segs = [narr("Elle sourit."), narr("La lame s'illumine.")];
    const units = buildUnits(segs, ctx);
    expect(units).toHaveLength(1);
    expect(units[0].segments).toHaveLength(2);
  });

  test("dialogue only merges with the same speaker", () => {
    const segs = [diag("Alba", "Viens."), diag("Kael", "Jamais !")];
    const units = buildUnits(segs, ctx);
    expect(units).toHaveLength(2);
    expect(units[0].segments[0].speaker).toBe("Alba");
    expect(units[1].segments[0].speaker).toBe("Kael");
  });

  test("narration and dialogue never merge together", () => {
    const segs = [narr("*La nuit tombe.*"), diag("Alba", "On y va.")];
    const units = buildUnits(segs, ctx);
    expect(units).toHaveLength(2);
  });

  test("long segment stands alone", () => {
    const long = narr("*" + "un mot ".repeat(60) + "*");
    const units = buildUnits([long], ctx);
    expect(units).toHaveLength(1);
    expect(units[0].segments).toHaveLength(1);
  });

  test("merging respects a 42-word cap", () => {
    const short = narr("Oui.");
    const segs = Array.from({ length: 8 }, () => short);
    const units = buildUnits(segs, ctx);
    // 42 words / 1 word per seg → units of ≤42 segs but capped at 6 segs/unit
    const totalSegs = units.reduce((a, u) => a + u.segments.length, 0);
    expect(totalSegs).toBe(8);
    expect(Math.max(...units.map((u) => u.segments.length))).toBeLessThanOrEqual(6);
  });

  test("joinSegments punctuates sentences", () => {
    expect(joinSegments([narr("Elle sourit"), narr("la lame brille")])).toBe("Elle sourit. la lame brille");
    expect(joinSegments([diag("A", "Viens !"), diag("A", "Vite")])).toBe("Viens ! Vite");
  });
});

describe("TTS context", () => {
  test("character voice resolution via buildTtsContext", async () => {
    const card = db.createCard({ name: "Alba", voice: "cosette", language: "fr" });
    const conv = db.createConversation({ title: "T", cast: JSON.stringify([card.id]) });
    const { buildTtsContext } = await import("../src/tts/service");
    const c = buildTtsContext(conv);
    expect(c.characterVoices.alba).toBe("cosette");
  });
});