import { describe, test, expect } from "bun:test";
// Frontend modules must stay importable outside the browser (no DOM access at
// module top level) — this guards the memory-center split and catches a
// stray `document.*` / `window.*` executed on import, which would blank the app.
import * as apiJs from "../public/js/api.js";
import * as uiJs from "../public/js/ui.js";
import * as center from "../public/js/memory-center.js";

describe("frontend modules load without a DOM", () => {
  test("api.js exports its helpers", () => {
    for (const k of ["api", "apiFetch", "apiForm", "readSseStream", "uploadFiles", "fileToPngDataUrl", "getToken", "setToken", "authUrl"]) {
      expect(typeof (apiJs as any)[k], k).toBe("function");
    }
  });

  test("ui.js exports its helpers", () => {
    for (const k of ["el", "esc", "toast", "actionToast", "openModal", "closeAllModals", "confirmModal", "field", "spinner", "fmtTime", "fmtAge"]) {
      expect(typeof (uiJs as any)[k], k).toBe("function");
    }
    expect((uiJs as any).ICONS.home).toBe("🏠");
  });

  test("memory-center.js exposes the four panes + center + shared ref", () => {
    for (const k of ["buildMemoryPane", "buildCanonPane", "buildRelationsPane", "buildLorePane", "openMemoryCenter"]) {
      expect(typeof (center as any)[k], k).toBe("function");
    }
    expect((center as any).relationsRef).toEqual({ current: null });
  });

  test("ui.esc is a pure string coercion (safe although named esc)", () => {
    expect((uiJs as any).esc(null)).toBe("");
    expect((uiJs as any).esc(42)).toBe("42");
  });
});
