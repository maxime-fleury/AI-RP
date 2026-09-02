/** Test bootstrap: every test file gets its own throw-away data directory so
 * the real `data/` (and the user's world) is never touched. Must run BEFORE
 * any import of src/server/db or src/server/paths. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
export const dataDir = mkdtempSync(path.join(tmpdir(), "innsekai-test-"));

process.env.INNSEKAI_DATA_DIR = dataDir;

export async function loadApp() {
  const db = await import("../src/server/db");
  const routes = await import("../src/server/routes");
  const prompt = await import("../src/llm/prompt");
  return { db, routes, prompt };
}

export function api(routes: { handleApi: (req: Request, url: URL) => Promise<Response> }, method: string, pathname: string, body?: unknown) {
  return routes.handleApi(
    new Request(`http://test.local${pathname}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    new URL(`http://test.local${pathname}`),
  );
}