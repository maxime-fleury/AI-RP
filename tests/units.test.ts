import { describe, test, expect } from "bun:test";
// helpers FIRST: sets INNSEKAI_DATA_DIR before src/server/db is pulled in
// transitively (jobs.ts), so unit tests never touch the real ./data
import "./helpers";
import { zipFiles, safeZipPath, crc32 } from "../src/server/zip";
import {
  SETTING_DEFS, CONVERSATION_SETTING_DEFS, WORLD_SETTING_DEFS,
  validateSettingsPatch, validateSettingValue, objectSettingsJson,
} from "../src/server/settingsSchema";
import { fkId, intArray, settingsJson, sniffImage, Codes } from "../src/server/validate";
import { HttpError } from "../src/server/http";
import { packResult, canonicalStatus, jobView } from "../src/server/jobs";
import { combineSignals } from "../src/server/signal";
import { log } from "../src/server/log";
import { normalizeModelList, LMStudioProvider } from "../src/llm/providers";
import { getSetting, setSetting } from "../src/server/db";

function errOf(fn: () => unknown): HttpError | null {
  try {
    fn();
  } catch (e) {
    return e as HttpError;
  }
  return null;
}

describe("zip writer", () => {
  test("produces PK magic + EOCD file count", () => {
    const z = zipFiles([
      { path: "a.txt", data: "hello" },
      { path: "d/b.txt", data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(z[0]).toBe(0x50);
    expect(z[1]).toBe(0x4b);
    const view = new DataView(z.buffer, z.byteOffset, z.byteLength);
    const eocd = z.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
  });

  test("Zip-Slip paths are sanitized", () => {
    expect(safeZipPath("../evil.sh")).toBe("evil.sh");
    expect(safeZipPath("/abs/path.txt")).toBe("abs/path.txt");
    expect(safeZipPath("a/../../b.txt")).toBe("a/b.txt");
    expect(safeZipPath("")).toBe("file");
    expect(safeZipPath("C:\\win\\x.txt")).toBe("win/x.txt");
  });

  test("duplicate names are deduped, oversized archives rejected", () => {
    const z = zipFiles([
      { path: "same.txt", data: "one" },
      { path: "same.txt", data: "two" },
    ]);
    const text = new TextDecoder().decode(z);
    expect(text.match(/same\.txt/g)?.length).toBe(2);
    expect(text).toContain("same-1.txt");
    expect(() => zipFiles(new Array(65001).fill({ path: "x", data: "" }))).toThrow();
  });

  test("crc32 is stable", () => {
    const a = crc32(new TextEncoder().encode("abc"));
    expect(a).toBe(crc32(new TextEncoder().encode("abc")));
    expect(a).not.toBe(crc32(new TextEncoder().encode("abd")));
  });
});

describe("global settings schema", () => {
  test("unknown keys are rejected, nothing stored", () => {
    const e = errOf(() => validateSettingsPatch({ typo_key: 1, provider: "lmstudio" }));
    expect(e).toBeInstanceOf(HttpError);
    expect(e?.status).toBe(400);
    expect(e?.code).toBe(Codes.INVALID_FIELD);
  });

  test("out-of-range values rejected with OUT_OF_RANGE", () => {
    expect(errOf(() => validateSettingValue("image_steps", 999))?.code).toBe(Codes.OUT_OF_RANGE);
    expect(errOf(() => validateSettingValue("temperature", -1))?.code).toBe(Codes.OUT_OF_RANGE);
    expect(errOf(() => validateSettingValue("provider", "nope"))?.code).toBe(Codes.INVALID_ENUM);
    expect(errOf(() => validateSettingValue("lmstudio_url", "not-a-url"))?.code).toBe(Codes.INVALID_FIELD);
  });

  test("empty secrets are skipped (not wiped), narrator_avatar accepted", () => {
    expect(validateSettingsPatch({ openrouter_key: "" })).toEqual([]);
    expect(validateSettingsPatch({ auth_token: "" })).toEqual([]);
    const [[k, v]] = validateSettingsPatch({ narrator_avatar: "/images/x.png" });
    expect(k).toBe("narrator_avatar");
    expect(v).toBe("/images/x.png");
  });

  test("every declared def has a description", () => {
    for (const [k, d] of Object.entries(SETTING_DEFS)) expect(d.desc, k).toBeTruthy();
  });
});

describe("per-object settings schemas", () => {
  test("conversation: empty object valid, unknown keys rejected", () => {
    expect(objectSettingsJson({}, CONVERSATION_SETTING_DEFS, "settings")).toBe("{}");
    expect(objectSettingsJson({ provider: "lmstudio", temperature: 0.7 }, CONVERSATION_SETTING_DEFS, "settings")).toContain("lmstudio");
    const e = errOf(() => objectSettingsJson({ typo: 1 }, CONVERSATION_SETTING_DEFS, "settings"));
    expect(e?.status).toBe(400);
    expect(errOf(() => objectSettingsJson("{nope", CONVERSATION_SETTING_DEFS, "settings"))?.code).toBe(Codes.INVALID_JSON);
    expect(errOf(() => objectSettingsJson([1], CONVERSATION_SETTING_DEFS, "settings"))?.code).toBe(Codes.INVALID_BODY);
  });

  test("conversation: ranges enforced, server-managed keys accepted", () => {
    expect(errOf(() => objectSettingsJson({ temperature: 99 }, CONVERSATION_SETTING_DEFS, "settings"))?.code).toBe(Codes.OUT_OF_RANGE);
    const s = JSON.parse(objectSettingsJson(
      { recap: { a: 1 }, rels: {}, quests: [], scene_state: null, lore_entries: [], checkpoints: [], loops: [] },
      CONVERSATION_SETTING_DEFS, "settings",
    ));
    expect(s.scene_state).toBeNull();
  });

  test("world: negative + caps accepted, unknown rejected", () => {
    expect(objectSettingsJson({ negative: "x" }, WORLD_SETTING_DEFS, "settings")).toContain("negative");
    expect(errOf(() => objectSettingsJson({ wat: 1 }, WORLD_SETTING_DEFS, "settings"))?.status).toBe(400);
  });
});

describe("boundary validators", () => {
  test("booleans are not valid ids", () => {
    expect(errOf(() => fkId(true, "x"))?.code).toBe(Codes.INVALID_ID);
    expect(errOf(() => intArray([true], "x"))?.code).toBe(Codes.INVALID_ID);
    expect(fkId(null, "x")).toBeNull();
    expect(fkId("3", "x")).toBe(3);
  });

  test("settingsJson rejects non-object JSON", () => {
    expect(errOf(() => settingsJson("null"))?.code).toBe(Codes.INVALID_JSON);
    expect(errOf(() => settingsJson("123"))?.code).toBe(Codes.INVALID_JSON);
    expect(errOf(() => settingsJson("{bad"))?.code).toBe(Codes.INVALID_JSON);
    expect(JSON.parse(settingsJson({ a: 1 }))).toEqual({ a: 1 });
  });

  test("sniffImage: 12-byte webp ok, unknown ext rejected", () => {
    const webp12 = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImage("webp", webp12)).toBe(true);
    expect(sniffImage("png", new Uint8Array([1, 2, 3]))).toBe(false);
    expect(sniffImage("exe", new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("jobs hub helpers", () => {
  test("packResult caps at 20KB and tolerates circular input", () => {
    expect(packResult(undefined)).toBe("");
    expect(packResult({ a: 1 })).toBe('{"a":1}');
    expect(packResult("x".repeat(30000)).length).toBeLessThanOrEqual(20000);
    const circ: any = {};
    circ.self = circ;
    expect(packResult(circ)).toBe("");
  });

  test("canonicalStatus maps legacy rows", () => {
    expect(canonicalStatus("pending")).toBe("queued");
    expect(canonicalStatus("done")).toBe("completed");
    expect(canonicalStatus("running")).toBe("running");
    expect(canonicalStatus("weird")).toBe("queued");
  });

  test("jobView exposes parsed result + hasResult", () => {
    const v = jobView({ id: 1, result: '{"fields":{"a":[]}}', payload: '{"x":1}', status: "completed" } as any);
    expect(v.hasResult).toBe(true);
    expect(v.resultObj).toEqual({ fields: { a: [] } });
    expect(v.payloadObj).toEqual({ x: 1 });
    expect(jobView({ id: 2, result: "", payload: "nope", status: "queued" } as any).hasResult).toBe(false);
  });
});

describe("abort signals", () => {
  test("combined signal fires when the external one aborts", async () => {
    const ac = new AbortController();
    // short watchdog: AbortSignal.timeout holds a real timer, so a long one
    // would keep the test runner alive after the suite finishes
    const s = combineSignals(ac.signal, 500);
    expect(s.aborted).toBe(false);
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.aborted).toBe(true);
  });

  test("timeout alone fires", async () => {
    const s = combineSignals(undefined, 30);
    // NOTE (bun 1.3 quirk): a bare AbortSignal.timeout is not pumped when it
    // is the SOLE pending handle — awaiting only its abort event stalls
    // forever. A real setTimeout past the deadline keeps the loop alive.
    // Production paths always pair the signal with a fetch, so only tests
    // hit this.
    await new Promise((r) => setTimeout(r, 150));
    expect(s.aborted).toBe(true);
  });
});

describe("model list normalization + LM Studio fallback", () => {
  test("accepts every /models shape, sorts + dedupes", () => {
    expect(normalizeModelList({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, " c ", {}] })).toEqual(["a", "b", "c"]);
    expect(normalizeModelList([{ id: "x" }])).toEqual(["x"]);
    expect(normalizeModelList({ models: ["m1", "m2"] })).toEqual(["m1", "m2"]);
    expect(normalizeModelList(null)).toEqual([]);
    expect(normalizeModelList({ data: "nope" })).toEqual([]);
  });

  test("bare host without /v1 falls back to /v1/models", async () => {
    const prev = getSetting("lmstudio_url", "http://localhost:1234/v1");
    setSetting("lmstudio_url", "http://localhost:1234");
    const seen: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      seen.push(String(url));
      if (String(url).endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "fallback-model" }] }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const r = await new LMStudioProvider().listModels();
      expect(r.models).toEqual(["fallback-model"]);
      expect(r.error).toBeUndefined();
      expect(seen).toHaveLength(2);
    } finally {
      globalThis.fetch = orig;
      setSetting("lmstudio_url", prev);
    }
  });

  test("unreachable server yields an actionable error, not a silent []", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    try {
      const r = await new LMStudioProvider().listModels();
      expect(r.models).toEqual([]);
      expect(r.error || "").toContain("Developer");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("structured log", () => {
  test("emits [scope] + message + data on one line", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m: string) => lines.push(m);
    try {
      log("jobs", "completed", { jobId: 7 });
    } finally {
      console.log = orig;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[jobs]");
    expect(lines[0]).toContain("completed");
    expect(lines[0]).toContain('"jobId":7');
    expect(lines[0].split("\n")).toHaveLength(1);
  });
});
