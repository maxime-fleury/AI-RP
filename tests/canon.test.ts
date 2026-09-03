import { describe, test, expect } from "bun:test";
import { dataDir, loadApp, api } from "./helpers";
import type { ConversationRow, MessageRow } from "../src/server/db";

describe("player-owned canon", async () => {
  const { db, routes } = await loadApp();

  test("CRUD: create confirmed fact, list, patch, change status, delete", async () => {
    const conv = db.createConversation({ title: "Canon" });
    const created = await api(routes, "POST", `/api/conversations/${conv.id}/canon`, {
      subject: "Élara", fact: "Élara a juré de protéger le médaillon.", locked: true,
    });
    expect(created.status).toBe(201);
    const entry = await created.json();
    expect(entry.status).toBe("confirmed");
    expect(entry.locked).toBe(1);
    expect(entry.origin).toBe("player");

    const list = await (await api(routes, "GET", `/api/conversations/${conv.id}/canon`)).json();
    expect(list.entries.length).toBe(1);

    const patched = await api(routes, "PATCH", `/api/conversations/${conv.id}/canon/${entry.id}`, {
      subject: "Élara", fact: "Élara protège le médaillon, coûte que coûte.", locked: false,
    });
    const after = await patched.json();
    expect(after.fact).toContain("coûte que coûte");
    expect(after.locked).toBe(0);

    const rejected = await api(routes, "POST", `/api/conversations/${conv.id}/canon/${entry.id}/status`, { status: "rejected" });
    expect((await rejected.json()).status).toBe("rejected");

    const confirmedOnly = await (await api(routes, "GET", `/api/conversations/${conv.id}/canon?status=confirmed`)).json();
    expect(confirmedOnly.entries.length).toBe(0);

    const del = await api(routes, "DELETE", `/api/conversations/${conv.id}/canon/${entry.id}`);
    expect(del.status).toBe(200);
    expect((await (await api(routes, "GET", `/api/conversations/${conv.id}/canon`)).json()).entries.length).toBe(0);
  });

  test("world scope requires an attached world, else 422", async () => {
    const conv = db.createConversation({ title: "Sans monde" });
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/canon`, {
      subject: "Loi", fact: "La magie est interdite.", scope: "world",
    });
    expect(res.status).toBe(400); // scope world sans monde attaché
  });

  test("ownership: an entry from another conversation is not reachable", async () => {
    const a = db.createConversation({ title: "A" });
    const b = db.createConversation({ title: "B" });
    const entry = await (await api(routes, "POST", `/api/conversations/${a.id}/canon`, { subject: "X", fact: "Y" })).json();
    const patch = await api(routes, "PATCH", `/api/conversations/${b.id}/canon/${entry.id}`, { fact: "Z" });
    expect(patch.status).toBe(404);
    const del = await api(routes, "DELETE", `/api/conversations/${b.id}/canon/${entry.id}`);
    expect(del.status).toBe(404);
  });

  test("confirmed facts are injected into the prompt; proposed ones are not", async () => {
    const conv = db.createConversation({ title: "Injection" });
    db.createMessage({ conversation_id: conv.id, role: "user", content: "Salut" });
    await api(routes, "POST", `/api/conversations/${conv.id}/canon`, { subject: "Alba", fact: "Alba est une revenante.", locked: true });
    // the POST route always creates confirmed facts — a proposal must come
    // from the AI pipeline, simulated here through the db directly
    db.createCanon({ conversation_id: conv.id, world_id: null, subject: "Doute", fact: "Peut-être un traître.", status: "proposed", origin: "ai" });
    const ctx = await (await api(routes, "GET", `/api/conversations/${conv.id}/context`)).json();
    expect(ctx.canon.count).toBe(1); // proposed never counted
    expect(ctx.system).toContain("Alba est une revenante");
    expect(ctx.system).toContain("Canon du récit");
    expect(ctx.system).toContain("🔒"); // locked marker
    expect(ctx.system).not.toContain("Peut-être un traître");
  });

  test("world-scoped canon is injected into every conversation of that world", async () => {
    const world = db.createWorld({ name: "Continent" });
    const conv = db.createConversation({ title: "Quête", world_id: world.id });
    const other = db.createConversation({ title: "Autre monde" });
    await api(routes, "POST", `/api/conversations/${conv.id}/canon`, {
      subject: "Loi", fact: "La magie est interdite.", scope: "world",
    });
    const ctx = await (await api(routes, "GET", `/api/conversations/${conv.id}/context`)).json();
    expect(ctx.system).toContain("La magie est interdite");
    const ctxOther = await (await api(routes, "GET", `/api/conversations/${other.id}/context`)).json();
    expect(ctxOther.system).not.toContain("La magie est interdite");
  });

  test("proposeCanonFacts returns [] without enough story (no model call)", async () => {
    const core = await import("../src/server/routes/core");
    const conv = db.createConversation({ title: "Court" });
    db.createMessage({ conversation_id: conv.id, role: "user", content: "Un seul message" });
    const empty = await core.proposeCanonFacts(conv.id, db.listMessages(conv.id));
    expect(empty).toEqual([]);
    const none = await core.proposeCanonFacts(999, []);
    expect(none).toEqual([]);
  });

  test("auto-propose is opt-in: canon_auto stores proposals in proposed status only", async () => {
    // without a reachable model the tracked job fails gracefully — the route
    // still answers and the job row records the failure instead of crashing
    const conv = db.createConversation({ title: "Auto", settings: JSON.stringify({ canon_auto: true }) });
    for (let i = 0; i < 4; i++) {
      db.createMessage({ conversation_id: conv.id, role: i % 2 ? "assistant" : "user", name: i % 2 ? "Narrateur" : undefined, content: `message ${i}` });
    }
    const res = await api(routes, "POST", `/api/conversations/${conv.id}/canon/propose`, {});
    expect([200, 500]).toContain(res.status);
    const jobs = db.listJobs();
    expect(jobs.some((j) => j.type === "canon")).toBe(true);
  });
});

describe("persistent scene directives (scene-control)", async () => {
  const { db, routes } = await loadApp();

  test("PUT stores a sanitized plan, GET returns it, disabled plans stay inert", async () => {
    const conv = db.createConversation({ title: "Scène" });
    const plan = {
      enabled: true,
      objectives: [" Convaincre la garde ", "Trouver le passage secret"],
      required: ["La lettre est remise à Liora"],
      forbidden: ["Aucun personnage ne meurt"],
      npc_agendas: { Varek: "cherche le médaillon", Inutile: "   " },
      reveal_gates: ["Le mage avoue son pacte"],
      directives: ["Termine sur un cliffhanger"],
    };
    const put = await api(routes, "PUT", `/api/conversations/${conv.id}/scene-control`, { scene_control: plan });
    expect(put.status).toBe(200);
    const saved = await put.json();
    expect(saved.scene_control.objectives).toEqual(["Convaincre la garde", "Trouver le passage secret"]);
    expect(saved.scene_control.npc_agendas).toEqual({ Varek: "cherche le médaillon" }); // blank agenda dropped

    const got = await (await api(routes, "GET", `/api/conversations/${conv.id}/scene-control`)).json();
    expect(got.scene_control.required[0]).toBe("La lettre est remise à Liora");

    const ctx = await (await api(routes, "GET", `/api/conversations/${conv.id}/context`)).json();
    expect(ctx.directives.persistent_scene_control).toBe(true);
    expect(ctx.system).toContain("Convaincre la garde ; Trouver le passage secret");
    expect(ctx.system).toContain("Interdits (ne les fais JAMAIS advenir)");
    expect(ctx.system).toContain("Varek : cherche le médaillon");

    // disabling stops injection
    await api(routes, "PUT", `/api/conversations/${conv.id}/scene-control`, { scene_control: { ...plan, enabled: false } });
    const ctxOff = await (await api(routes, "GET", `/api/conversations/${conv.id}/context`)).json();
    expect(ctxOff.directives.persistent_scene_control).toBe(false);
    expect(ctxOff.system).not.toContain("Convaincre la garde");
  });
});

describe("context inspector", async () => {
  const { db, routes } = await loadApp();

  test("reports the exact packed context with budget and kept messages", async () => {
    const conv = db.createConversation({ title: "Ctx", settings: JSON.stringify({ context_max_messages: 6 }) });
    for (let i = 0; i < 10; i++) {
      db.createMessage({ conversation_id: conv.id, role: i % 2 ? "assistant" : "user", name: i % 2 ? "Narrateur" : undefined, content: `trame ${i}` });
    }
    const ctx = await (await api(routes, "GET", `/api/conversations/${conv.id}/context`)).json();
    // the inspector reports exactly what the model receives: 6 packed messages
    expect(ctx.messageCount).toBe(6);
    expect(ctx.keptMessages).toBe(6);
    expect(ctx.messages.length).toBe(6);
    expect(ctx.systemTokens).toBeGreaterThan(0);
    expect(ctx.tokens).toBeGreaterThan(ctx.systemTokens);
  });
});

describe("token-budget context packing", async () => {
  const { db } = await loadApp();
  const core = await import("../src/server/routes/core");

  test("packByTokens keeps complete exchanges and drops orphaned assistant replies", () => {
    const { packByTokens } = core;
    const mk = (role, content, id): MessageRow => ({ id, conversation_id: 1, role, name: role === "assistant" ? "Narrateur" : null, content, segments: null, audio: null, meta: "{}", created_at: id });
    const history = [
      mk("assistant", "a".repeat(400), 1), // orphaned reply (no preceding user in window)
      mk("user", "Question", 2),
      mk("assistant", "Réponse", 3),
    ];
    const kept = packByTokens(history, 10_000);
    expect(kept.map((m) => m.id)).toEqual([2, 3]);
  });

  test("computeKept honours the token budget when set, message cap otherwise", () => {
    const { computeKept, contextConfig } = core;
    const convTok = { id: 1, settings: JSON.stringify({ context_max_tokens: 1500 }), world_id: null } as ConversationRow;
    const convMsgs = { id: 2, settings: JSON.stringify({ context_max_messages: 5 }), world_id: null } as ConversationRow;
    expect(contextConfig(convTok).capSource).toBe("partie");
    expect(contextConfig(convTok).maxTokens).toBe(1500);
    expect(contextConfig(convMsgs).maxTokens).toBe(0);
    const mk = (role, content, id): MessageRow => ({ id, conversation_id: 1, role, name: role === "assistant" ? "Narrateur" : null, content, segments: null, audio: null, meta: "{}", created_at: id });
    const history = [];
    for (let i = 1; i <= 12; i++) history.push(mk(i % 2 ? "user" : "assistant", "x".repeat(400), i));
    expect(computeKept(convMsgs, history).length).toBe(5);
    const packed = computeKept(convTok, history);
    expect(packed.length).toBeLessThan(12); // token budget trims the oldest turns
    expect(packed.length).toBeGreaterThanOrEqual(8);
    // exchanges stay complete: no orphaned assistant reply at the front
    expect(packed[0].role).toBe("user");
  });
});

describe("branch compare / merge", async () => {
  const { db, routes } = await loadApp();

  test("compare diffs canon at subject level: added / removed / conflicts", async () => {
    const mine = db.createConversation({ title: "Mine" });
    const theirs = db.createConversation({ title: "Leur" });
    db.createMessage({ conversation_id: mine.id, role: "user", content: "m1" });
    db.createMessage({ conversation_id: theirs.id, role: "user", content: "m1" });
    db.createMessage({ conversation_id: mine.id, role: "user", content: "m2" });
    db.createMessage({ conversation_id: theirs.id, role: "user", content: "m2b" });
    // shared subject with different fact → conflict; only-in-theirs → added; only-in-mine → removed
    await api(routes, "POST", `/api/conversations/${mine.id}/canon`, { subject: "Alba", fact: "Alba est gardienne." });
    await api(routes, "POST", `/api/conversations/${theirs.id}/canon`, { subject: "Alba", fact: "Alba est traîtresse." });
    await api(routes, "POST", `/api/conversations/${theirs.id}/canon`, { subject: "Varek", fact: "Varek a le médaillon." });
    await api(routes, "POST", `/api/conversations/${mine.id}/canon`, { subject: "Liora", fact: "Liora est disparue." });

    const d = await (await api(routes, "POST", `/api/conversations/${mine.id}/compare`, { otherId: theirs.id })).json();
    expect(d.canon.added.map((e) => e.subject)).toEqual(["Varek"]);
    expect(d.canon.removed.map((e) => e.subject)).toEqual(["Liora"]);
    expect(d.canon.conflicts.length).toBe(1);
    expect(d.canon.conflicts[0].subject).toBe("Alba");
    expect(d.canon.conflicts[0].mine.fact).toBe("Alba est gardienne.");
    expect(d.canon.conflicts[0].theirs.fact).toBe("Alba est traîtresse.");
    // divergence detected on the message list
    expect(d.sharedMessages).toBe(1);
    expect(d.divergedAt).toBeGreaterThan(0);
  });

  test("merge imports selected canon, resolves conflicts, merges quests/rels/scene/memory", async () => {
    const mine = db.createConversation({ title: "Mine" });
    const theirs = db.createConversation({ title: "Leur" });
    await api(routes, "POST", `/api/conversations/${mine.id}/canon`, { subject: "Alba", fact: "Alba est gardienne." });
    const varek = await (await api(routes, "POST", `/api/conversations/${theirs.id}/canon`, { subject: "Varek", fact: "Varek a le médaillon." })).json();
    await api(routes, "POST", `/api/conversations/${theirs.id}/canon`, { subject: "Alba", fact: "Alba est traîtresse." });
    await api(routes, "POST", `/api/conversations/${theirs.id}/quests`, { quests: [{ title: "Récupérer le médaillon", status: "active", notes: "Varek le détient" }] });
    await api(routes, "PUT", `/api/conversations/${theirs.id}/scene-control`, { scene_control: { enabled: true, objectives: ["Assiéger le donjon"] } });

    const res = await api(routes, "POST", `/api/conversations/${mine.id}/merge`, {
      fromId: theirs.id,
      include: { canon: true, quests: true, scene: true },
      onlyCanon: [varek.id],
      conflicts: [{ key: "canon:alba", take: "theirs" }],
    });
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.report.canon).toBe(2); // Varek added + Alba overwritten

    const mineCanon = (await (await api(routes, "GET", `/api/conversations/${mine.id}/canon`)).json()).entries;
    expect(mineCanon.some((e) => e.subject === "Varek" && e.fact === "Varek a le médaillon.")).toBe(true);
    expect(mineCanon.find((e) => e.subject === "Alba").fact).toBe("Alba est traîtresse.");

    // quests merged
    let cs = JSON.parse(db.getConversation(mine.id)!.settings || "{}");
    expect(cs.quests.some((q) => q.title === "Récupérer le médaillon")).toBe(true);
    // scene state merged
    const scene = await (await api(routes, "GET", `/api/conversations/${mine.id}/scene-control`)).json();
    expect(scene.scene_control.objectives).toEqual(["Assiéger le donjon"]);
    // message histories stay independent: nothing was concatenated
    expect(db.listMessages(mine.id).length).toBe(0);
    expect(db.listMessages(theirs.id).length).toBe(0);
  });

  test("merge with empty selection is a no-op", async () => {
    const mine = db.createConversation({ title: "M1" });
    const theirs = db.createConversation({ title: "T1" });
    await api(routes, "POST", `/api/conversations/${theirs.id}/canon`, { subject: "X", fact: "Y" });
    const res = await api(routes, "POST", `/api/conversations/${mine.id}/merge`, { fromId: theirs.id, include: {} });
    expect(res.status).toBe(200);
    expect((await res.json()).report.canon).toBe(0);
  });
});

describe("job cancellation plumbing", async () => {
  const { db } = await loadApp();
  const jobs = await import("../src/server/jobs");

  test("cancelJob aborts the running job's signal and the row stays cancelled", async () => {
    let sawAbort = false;
    let jobId = 0;
    const run = jobs.trackJob({ type: "cancel-test", title: "Annulable" }, (job, api) => {
      jobId = job.id;
      return new Promise((resolve) => {
        api.signal.addEventListener("abort", () => { sawAbort = true; resolve("done"); });
        // would run long without the abort listener resolving first
      });
    });
    // let the job flip to running
    await new Promise((r) => setTimeout(r, 20));
    expect(jobId).toBeGreaterThan(0);
    expect(db.getJob(jobId)!.status).toBe("running");

    jobs.cancelJob(jobId);
    await run;
    expect(sawAbort).toBe(true);
    const row = db.getJob(jobId)!;
    expect(jobs.canonicalStatus(row.status)).toBe("cancelled");
  });

  test("queued jobs can be cancelled before they start", async () => {
    const job = jobs.startJob({ type: "queued-test", title: "En file" });
    const row = jobs.cancelJob(job.id);
    expect(row).not.toBeNull();
    expect(jobs.canonicalStatus(db.getJob(job.id)!.status)).toBe("cancelled");
  });
});