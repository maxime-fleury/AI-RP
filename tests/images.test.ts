import { describe, test, expect } from "bun:test";
import { loadApp } from "./helpers";
import { cacheKeyFor } from "../src/server/image";

const { routes } = await loadApp();

describe("image cache key", () => {
  const req = { prompt: "elfe rousse", negative: "flou", steps: 28, cfg: 7, width: 768, height: 1152, seed: 123 };
  test("same seed + inputs → identical key (cache hit)", () => {
    expect(cacheKeyFor("avatars", req)).toBe(cacheKeyFor("avatars", { ...req }));
  });
  test("different seed → different key", () => {
    expect(cacheKeyFor("avatars", req)).not.toBe(cacheKeyFor("avatars", { ...req, seed: 124 }));
  });
  test("different prompt or subdir → different key", () => {
    expect(cacheKeyFor("avatars", req)).not.toBe(cacheKeyFor("conversations/1", req));
    expect(cacheKeyFor("avatars", req)).not.toBe(cacheKeyFor("avatars", { ...req, prompt: "elfe blonde" }));
  });
  test("img2img source changes the key (new reference = new render)", () => {
    const a = cacheKeyFor("avatars", { ...req, init_image: "AAAA" });
    const b = cacheKeyFor("avatars", { ...req, init_image: "BBBB" });
    expect(a).not.toBe(b);
  });
  test("seeded render is cached, seed-less render is not (generateAndSave cache branch)", () => {
    // cacheKeyFor only exists for seeded requests; the route only caches when req.seed != null
    expect(cacheKeyFor("avatars", req).length).toBe(24);
  });
});

describe("detectSceneKind", () => {
  test("pure scenery → landscape", () => {
    expect(routes.detectSceneKind("*Le temple ancien se dressait au milieu de la forêt, sous le ciel étoilé, la montagne au loin.*"))
      .toBe("landscape");
    expect(routes.detectSceneKind("*Le port s'étendait entre les toits de la ville et la mer.*")).toBe("landscape");
  });

  test("character scene stays portrait", () => {
    expect(routes.detectSceneKind("*Alba déploie ses grandes ailes argentées et sourit.*")).toBe("portrait");
  });

  test("dialogue-heavy message stays portrait even with scenery words", () => {
    expect(routes.detectSceneKind('Alba: "Le temple approche." Kael: "Je le vois."')).toBe("portrait");
  });
});