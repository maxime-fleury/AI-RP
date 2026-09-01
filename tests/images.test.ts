import { describe, test, expect } from "bun:test";
import { loadApp } from "./helpers";

const { routes } = await loadApp();

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