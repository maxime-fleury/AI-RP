import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Static import-graph check for the plain-JS frontend. CI's `node --check`
 * only validates syntax per file — a renamed/removed export (or a module
 * split that forgets an export) breaks the SPA at load time without failing
 * the syntax pass. This walks every `import { a, b } from "./x.js"` and
 * verifies each name is actually exported by the target.
 */
describe("frontend import graph", () => {
  const jsDir = path.resolve(import.meta.dir, "..", "public", "js");
  const files = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js"));

  const exportsOf = (file: string): Set<string> => {
    const src = fs.readFileSync(path.join(jsDir, file), "utf8");
    const out = new Set<string>();
    // export function foo( / export async function foo(
    for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    // export const foo = / export let / export var
    for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    // export class Foo
    for (const m of src.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    // export { a, b as c } — also line-wrapped "export {" blocks
    const blockRe = /export\s*\{([\s\S]*?)\}/g;
    for (const bm of src.matchAll(blockRe)) {
      for (const item of bm[1].split(",")) {
        const t = item.trim().replace(/\/\/.*$/, "");
        if (!t) continue;
        const as = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        out.add(as ? as[2] : t);
      }
    }
    return out;
  };

  const problems: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(jsDir, file), "utf8");
    // relative imports to sibling modules
    const re = /import\s+\{([\s\S]*?)\}\s+from\s+["'](\.\/[A-Za-z0-9_./-]+\.js)["']/g;
    for (const m of src.matchAll(re)) {
      const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      const targetFile = m[2].replace(/^\.\//, "");
      if (!fs.existsSync(path.join(jsDir, targetFile))) {
        problems.push(`${file}: module "${targetFile}" introuvable`);
        continue;
      }
      const exps = exportsOf(targetFile);
      for (const raw of names) {
        // "a as b" → imported under b
        const imp = raw.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        const want = imp ? imp[2] : raw.replace(/^type\s+/, "");
        if (raw.startsWith("type ")) continue; // type-only import (erased at runtime)
        if (imp) continue; // alias — export checked via a different name
        if (!exps.has(want) && !exps.has(raw)) {
          problems.push(`${file}: importe "${raw}" mais ${targetFile} ne l'exporte pas`);
        }
      }
    }
    // default-import sanity: ./x.js must exist
    const dflt = /import\s+([A-Za-z_$][\w$]*)\s+from\s+["'](\.\/[A-Za-z0-9_./-]+\.js)["']/g;
    for (const m of src.matchAll(dflt)) {
      if (!fs.existsSync(path.join(jsDir, m[2].replace(/^\.\//, "")))) {
        problems.push(`${file}: module "${m[2]}" introuvable`);
      }
    }
  }
  test("every named import resolves to an export of its target module", () => {
    expect(problems).toEqual([]);
  });
});
