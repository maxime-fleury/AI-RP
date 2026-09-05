/**
 * Shared client/server wire contract.
 *
 * Single source of truth for the JSON shapes that cross the HTTP boundary.
 * The server's view builders annotate their returns with these types; the
 * frontend references the very same declarations through JSDoc type imports
 * (`import("../../src/shared/contracts.ts").MessageView`) under `@ts-check`,
 * so a renamed/removed field fails the typecheck on BOTH sides — no separate
 * .d.ts copy to keep in sync.
 *
 * Keep this module types-only (no runtime exports): it is imported purely as
 * a type surface.
 */

/** A message segment as parsed for display (narration / character dialogue). */
export interface MessageSegment {
  type: "narration" | "dialogue" | "action";
  speaker?: string;
  text: string;
}

/** Assistant/user message as delivered to the client (messageView). */
export interface MessageView {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  /** Card/persona display name; "" = narrator marker message. */
  name: string;
  content: string;
  segments: MessageSegment[];
  /** Parsed per-message metadata (chapter markers, images, diagnostics…). */
  meta: Record<string, any>;
  created_at: number;
}

/** Story state view of one conversation (conversationView). */
export interface ConversationView {
  id: number;
  title: string;
  world_id: number | null;
  persona_id: number | null;
  scenario_id: number | null;
  cast: string;
  group_mode: number;
  settings: string;
  summary: string;
  summary_msg_id: number;
  pinned: number;
  archived: number;
  parent_id: number | null;
  branch_kind: string;
  last_message: string;
  created_at: number;
  updated_at: number;
  memory: any;
  world: any;
  persona: any;
  scenario: any;
  cards: any[];
  canon: any[];
  /** Attached by GET/POST handlers, not by conversationView itself. */
  messages?: MessageView[];
}

/** SSE event payload sent on a completed turn. */
export interface StreamDonePayload {
  message: MessageView;
}

/** SSE delta event payload (streamed tokens). */
export interface StreamDeltaPayload {
  text: string;
}

/** Error body shared by every API route (plus stable `code` where set). */
export interface ApiErrorBody {
  error: string;
  code?: string;
}

/** Response of POST /api/conversations/:id/suggestions. */
export interface SuggestionsResponse {
  messageId?: number;
  suggestions: string[];
}
