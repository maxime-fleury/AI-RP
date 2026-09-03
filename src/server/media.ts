/**
 * Embedded-media helpers shared by exports, restores and image routes: resolve
 * a stored /images|/uploads URL to a confined file path, walk a payload for
 * every media URL, and restore embedded base64 media with conversation-id
 * remapping.
 */
import fs from "node:fs";
import path from "node:path";
import { IMAGES_DIR, UPLOADS_DIR } from "./paths";
import { listMessages, updateMessage } from "./db";

/** Resolve a stored media URL to a file path, confined to the media roots. */
export function mediaFileFor(url: string): string | null {
  let root: string;
  let rel: string;
  if (url.startsWith("/images/")) { root = IMAGES_DIR; rel = url.slice("/images/".length); }
  else if (url.startsWith("/uploads/")) { root = UPLOADS_DIR; rel = url.slice("/uploads/".length); }
  else return null;
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null; // confinement
  return resolved;
}

/** Recursively collect every /images|/uploads URL string in an export payload. */
export function collectMediaUrls(node: unknown, out: Set<string>): void {
  if (typeof node === "string") {
    if (node.startsWith("/images/") || node.startsWith("/uploads/")) out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectMediaUrls(v, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectMediaUrls(v, out);
  }
}

/**
 * Embed the media files referenced by a parsed backup payload ({url: base64}).
 * Conversation-scoped image URLs are remapped to the restored conversation ids
 * (and written at that path), and the restored messages' meta is rewritten to
 * match — so fork / rewind-delete / new illustrations keep working on the
 * restored party as if it had always lived under its fresh id.
 */
export function restoreMedia(b: any, convIds: Map<number, number>): number {
  let restored = 0;
  const remapUrl = (url: string): string => {
    const m = /^\/images\/conversations\/(\d+)\//.exec(url);
    if (!m) return url;
    const oldId = Number(m[1]);
    const newId = convIds.get(oldId);
    if (newId === undefined || newId === oldId) return url;
    return `/images/conversations/${newId}/${url.slice(m[0].length)}`;
  };
  for (const [url, data] of Object.entries(b.media ?? {})) {
    const b64 = typeof data === "string" ? data : (data as any)?.b64 ?? (data as any)?.data;
    if (typeof b64 !== "string" || !b64) continue;
    const file = mediaFileFor(remapUrl(url));
    if (!file) continue;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      restored++;
    } catch (e: any) {
      console.warn(`[restore] média ignoré (${url}) : ${e?.message ?? e}`);
    }
  }
  // align the URLs stored in restored messages with the fresh conversation ids
  for (const c of b.conversations ?? []) {
    const oldId = Number(c.id);
    const newId = convIds.get(oldId);
    if (newId === undefined || newId === oldId) continue;
    const oldPrefix = `/images/conversations/${oldId}/`;
    const newPrefix = `/images/conversations/${newId}/`;
    for (const m of listMessages(newId)) {
      let meta: any;
      try { meta = JSON.parse(m.meta || "{}"); } catch { continue; }
      const rewrite = (v: any): any => {
        if (typeof v === "string") return v.startsWith(oldPrefix) ? newPrefix + v.slice(oldPrefix.length) : v;
        if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = rewrite(v[i]); return v; }
        if (v && typeof v === "object") { for (const k of Object.keys(v)) v[k] = rewrite(v[k]); return v; }
        return v;
      };
      const next = JSON.stringify(rewrite(meta));
      if (next !== m.meta) updateMessage(m.id, { meta: next });
    }
  }
  return restored;
}