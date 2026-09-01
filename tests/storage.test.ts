import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadApp, api } from "./helpers";

const { db, routes } = await loadApp();
const { analyzeOrphans, purgeOrphans } = await import("../src/server/backup");
const { AUDIO_DIR, IMAGES_DIR, UPLOADS_DIR } = await import("../src/server/paths");

describe("storage: orphan analysis & purge", () => {
  test("referenced files are kept, unreferenced files are flagged", async () => {
    const conv = db.createConversation({ title: "P" });
    const m = db.createMessage({
      conversation_id: conv.id, role: "assistant", name: "Narrateur", content: "*Salut.*",
      audio: JSON.stringify([{ path: `/audio/${conv.id}/1-a.wav` }]),
      meta: JSON.stringify({ image: `/images/conversations/${conv.id}/scene.png` }),
    });
    const card = db.createCard({ name: "Lyra", avatar: "/uploads/avatars/card-1.png" });

    // write the referenced files + one orphan per kind
    const dirs = [
      path.join(AUDIO_DIR, String(conv.id)),
      path.join(IMAGES_DIR, "conversations", String(conv.id)),
      path.join(UPLOADS_DIR, "avatars"),
    ];
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(AUDIO_DIR, String(conv.id), "1-a.wav"), "ref");
    fs.writeFileSync(path.join(IMAGES_DIR, "conversations", String(conv.id), "scene.png"), "ref");
    fs.writeFileSync(path.join(UPLOADS_DIR, "avatars", "card-1.png"), "ref");
    fs.writeFileSync(path.join(AUDIO_DIR, String(conv.id), "2-orphan.wav"), "orphan");
    fs.writeFileSync(path.join(IMAGES_DIR, "conversations", String(conv.id), "ghost.png"), "orphan");
    fs.writeFileSync(path.join(UPLOADS_DIR, "avatars", "old-avatar.png"), "orphan");
    fs.writeFileSync(path.join(AUDIO_DIR, "test-clip.wav"), "test"); // TTS test clips are orphans too

    const { orphans, orphanCount } = analyzeOrphans();
    const urls = orphans.map((o) => o.path);
    // referenced files never appear
    expect(urls).not.toContain(`/audio/${conv.id}/1-a.wav`);
    expect(urls).not.toContain(`/images/conversations/${conv.id}/scene.png`);
    expect(urls).not.toContain("/uploads/avatars/card-1.png");
    // orphans are found
    expect(urls).toContain(`/audio/${conv.id}/2-orphan.wav`);
    expect(urls).toContain(`/images/conversations/${conv.id}/ghost.png`);
    expect(urls).toContain("/uploads/avatars/old-avatar.png");
    expect(urls).toContain("/audio/test-clip.wav");
    expect(orphanCount).toBe(4);

    void m; void card;

    // purge only the targeted ones
    const r = purgeOrphans([`/audio/${conv.id}/2-orphan.wav`, "/uploads/avatars/old-avatar.png"]);
    expect(r.removed).toBe(2);
    expect(r.bytes).toBe("orphan".length * 2);
    expect(fs.existsSync(path.join(AUDIO_DIR, String(conv.id), "2-orphan.wav"))).toBe(false);
    expect(fs.existsSync(path.join(AUDIO_DIR, String(conv.id), "1-a.wav"))).toBe(true);
  });

  test("purge refuses paths outside the media roots", () => {
    const r = purgeOrphans(["/etc/passwd", "/../data/app.db", "https://evil/x"]);
    expect(r.removed).toBe(0);
  });

  test("API: analyze + purge round-trip", async () => {
    fs.mkdirSync(path.join(AUDIO_DIR, "api-orphan"), { recursive: true });
    fs.writeFileSync(path.join(AUDIO_DIR, "api-orphan", "x.wav"), "data");
    const a = await api(routes, "POST", "/api/storage/analyze");
    expect(a.status).toBe(200);
    const analysis = (await a.json()) as any;
    expect(analysis.orphans.some((o: any) => o.path === "/audio/api-orphan/x.wav")).toBe(true);

    const p = await api(routes, "POST", "/api/storage/purge", { files: ["/audio/api-orphan/x.wav"] });
    expect(p.status).toBe(200);
    const purged = (await p.json()) as any;
    expect(purged.removed).toBe(1);
    expect(fs.existsSync(path.join(AUDIO_DIR, "api-orphan", "x.wav"))).toBe(false);
  });
});

describe("jobs: stale cleanup", () => {
  test("cleanupStaleJobs marks old running/pending jobs as failed, keeps fresh ones", () => {
    const job = db.createJob({ type: "tts", status: "running", payload: "{}" });
    // age the job beyond the staleness window via SQL (created_at set at insert)
    db.db.query("UPDATE jobs SET created_at = ? WHERE id = ?").run(Date.now() - 7 * 3600 * 1000, job.id);
    const fresh = db.createJob({ type: "image", status: "running", payload: "{}" });

    const cleaned = db.cleanupStaleJobs();
    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(db.getJob(job.id)?.status).toBe("failed");
    expect(db.getJob(job.id)?.error).toContain("redémarrage");
    expect(db.getJob(fresh.id)?.status).toBe("running");
  });
});
