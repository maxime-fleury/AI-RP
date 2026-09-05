/**
 * Re-export shim — the API surface lives in src/server/routes/ now:
 *   index.ts   – dispatcher (LAN auth, meta endpoints, router chain)
 *   worlds.ts  – worlds, scenarios, templates, locations, lorebook, relations, timeline
 *   cards.ts   – cards, import/export
 *   personas.ts – personas, trash
 *   conversations.ts – conversations, branches, cast, streaming
 *   messages.ts – messages, reactions, bulk-delete
 *   media.ts   – message images, uploads
 *   backups.ts – storage, backups, export
 *   jobs.ts    – background job tracking
 *   settings.ts – settings, models, auth
 *   assist.ts  – AI-assisted creation
 *   core.ts    – shared helpers, LLM/image pipelines, job retry handlers
 */
export { handleApi } from "./routes/index";
// helpers the test suite exercises directly (kept exported for compatibility)
export { mergeRels } from "./routes/core";
export { charSeed, characterForMessage, detectSceneKind } from "./imgPrompts";