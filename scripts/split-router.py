"""Split the monolithic src/server/routes.ts into per-resource router modules.

Each top-level `if (...)` block inside handleApi's try is classified by its
path pattern into a resource router (worlds, cards, personas, conversations,
messages, media, backups, jobs, settings, assist). Non-route helper code moves
to core.ts (with all top-level decls exported); routes.ts becomes a thin
re-export shim so src/index.ts and the tests keep working unchanged.

Dispatch order in index.ts follows the ORIGINAL first-appearance order of the
blocks, so cross-router precedence (e.g. message-image before generic message
POST) is preserved exactly.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "server"
# pass the original monolithic file as argv[1] (e.g. `git show HEAD:src/server/routes.ts`)
ROUTES = Path(sys.argv[1]) if len(sys.argv) > 1 else SRC / "routes.ts"
OUT = SRC / "routes"

src = ROUTES.read_text(encoding="utf-8")

# ── boundaries ────────────────────────────────────────────────────────────────
handle_start = src.index("export async function handleApi")
handle_end = src.index("// standard danbooru-style negative prompt")
head = src[:handle_start]
tail = src[handle_end:]
body = src[handle_start:handle_end]

# auth block: everything between the handleApi signature and `try {`
sig_end = body.index("{") + 1
try_idx = body.index("try {")
auth_block = body[sig_end:try_idx].strip("\n")

# everything inside try, up to the final not-found return
notfound_idx = body.rindex('return json({ error: "Not found"')
try_body = body[try_idx + len("try {"):notfound_idx]


# ── split into top-level if blocks (balanced braces) ──────────────────────────
def split_ifs(text):
    blocks = []
    i = 0
    n = len(text)
    while i < n:
        j = text.find("if (", i)
        if j < 0:
            rest = text[i:].strip()
            if rest:
                blocks.append(("raw", rest))
            break
        if text[i:j].strip():
            blocks.append(("raw", text[i:j].strip()))
        brace = text.find("{", j)
        depth = 0
        k = brace
        while k < n:
            c = text[k]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        blocks.append(("if", text[j:k + 1]))
        i = k + 1
    return blocks


blocks = split_ifs(try_body)


def cond_of(block):
    m = re.match(r"if \(([\s\S]*?)\) \{", block)
    return m.group(1) if m else block


# ── classify each block into a resource ───────────────────────────────────────
def classify(c):
    if 'p === "/api/conversations"' in c:
        return "conversations"
    if 'parts[1] === "conversations"' in c:
        if "reactions" in c:
            return "messages"
        if "bulk-delete" in c:
            return "messages"
        if "messages" in c and "image" in c:
            return "media"
        if "messages" in c:
            return "messages"
        return "conversations"
    if "storage" in c or "backup" in c or 'p === "/api/export"' in c:
        return "backups"
    if "jobs" in c:
        return "jobs"
    if "settings" in c or "auth" in c or "models" in c:
        return "settings"
    if "assist" in c:
        return "assist"
    if "cards" in c or "import" in c:
        return "cards"
    if "personas" in c or "trash" in c:
        return "personas"
    if ("worlds" in c or "scenarios" in c or "templates" in c or "locations" in c
            or "lorebook" in c or "relations" in c or "timeline" in c):
        return "worlds"
    if "images/preload" in c:
        return "media"
    return "index"


files = {k: [] for k in
         ["index", "worlds", "cards", "personas", "conversations", "messages",
          "media", "backups", "jobs", "settings", "assist"]}
for kind, block in blocks:
    if kind != "if":
        continue
    files[classify(cond_of(block))].append(block)

# ── exported-name registries (functions, consts, classes, types) ──────────────
def exported_names(path: Path):
    names = set()
    txt = path.read_text(encoding="utf-8")
    for m in re.finditer(r"^export (?:async )?function (\w+)", txt, re.M):
        names.add(m.group(1))
    for m in re.finditer(r"^export const (\w+)", txt, re.M):
        names.add(m.group(1))
    for m in re.finditer(r"^export class (\w+)", txt, re.M):
        names.add(m.group(1))
    for m in re.finditer(r"^export (?:type|interface) (\w+)", txt, re.M):
        names.add(m.group(1))
    return names


def type_names(path: Path):
    txt = path.read_text(encoding="utf-8")
    return set(re.findall(r"^export (?:type|interface) (\w+)", txt, re.M))


def type_names_in(text):
    return set(re.findall(r"^(?:type|interface) (\w+)", text, re.M))


REGISTRIES = {
    "db": (SRC / "db.ts", "../db"),
    "http": (SRC / "http.ts", "../http"),
    "validate": (SRC / "validate.ts", "../validate"),
    "jobs": (SRC / "jobs.ts", "../jobs"),
    "media": (SRC / "media.ts", "../media"),
    "backup": (SRC / "backup.ts", "../backup"),
    "image": (SRC / "image.ts", "../image"),
    "restore": (SRC / "restore.ts", "../restore"),
    "templates": (SRC / "templates.ts", "../templates"),
    "zip": (SRC / "zip.ts", "../zip"),
    "cardexport": (SRC / "cardExport.ts", "../cardExport"),
    "health": (SRC / "health.ts", "../health"),
    "importcards": (SRC / "importCards.ts", "../importCards"),
    "paths": (SRC / "paths.ts", "../paths"),
    "providers": (SRC / ".." / "llm" / "providers.ts", "../../llm/providers"),
    "prompt": (SRC / ".." / "llm" / "prompt.ts", "../../llm/prompt"),
}

module_names = {}
module_types = {}
for mod, (p, _) in REGISTRIES.items():
    module_names[mod] = exported_names(p)
    module_types[mod] = type_names(p)

# core helpers: everything defined in the non-route sections of routes.ts
core_src_raw = head + "\n" + tail
core_names = set(re.findall(r"^(?:export )?(?:async )?function (\w+)", core_src_raw, re.M))
core_names |= set(re.findall(r"^(?:export )?const (\w+)", core_src_raw, re.M))
core_types = set(re.findall(r"^(?:export )?(?:type|interface) (\w+)", core_src_raw, re.M))

KEYWORDS = {
    "if", "else", "return", "const", "let", "var", "for", "while", "function",
    "async", "await", "try", "catch", "throw", "new", "typeof", "instanceof",
    "in", "of", "class", "extends", "switch", "case", "break", "continue",
    "true", "false", "null", "undefined", "void", "delete", "this", "export",
    "import", "from", "default", "do", "yield", "static", "get", "set",
    "type", "interface", "satisfies", "as", "string", "number", "boolean",
    "unknown", "any", "never", "Record", "Promise", "Error", "Set", "Buffer",
    "Object", "Array", "String", "Number", "Boolean", "JSON", "Date",
    "Math", "console", "process", "URL", "Response", "Request", "URLSearchParams",
}


def identifiers(text):
    ids = set(re.findall(r"\b([A-Za-z_]\w*)\b", text))
    return ids - KEYWORDS


def build_imports(text, force_http=False):
    ids = identifiers(text)
    used = {}  # mod -> set of names
    for name in ids:
        if name in core_names or name in core_types:
            used.setdefault("core", set()).add(name)
            continue
        for mod, (_, rel) in REGISTRIES.items():
            if name in module_names[mod]:
                used.setdefault(mod, set()).add(name)
                break
    if force_http:
        used.setdefault("http", set()).update(FORCE_HTTP)
    lines = []
    for mod in ["core"] + list(REGISTRIES.keys()):
        names = used.get(mod)
        if not names:
            continue
        types = module_types[mod] if mod in module_types else set()
        if mod == "core":
            types = core_types
        parts = []
        for n in sorted(names):
            parts.append(f"type {n}" if n in types else n)
        rel = "./core" if mod == "core" else REGISTRIES[mod][1]
        lines.append(f"import {{ {', '.join(parts)} }} from \"{rel}\";")
    if "fs." in text:
        lines.append("import fs from \"node:fs\";")
    if "path." in text:
        lines.append("import path from \"node:path\";")
    return lines


# generated router/index files all carry their own try/catch, which calls
# errorResponse — it must always be imported even if no block mentions it.
FORCE_HTTP = {"errorResponse"}


# ── emit router files ─────────────────────────────────────────────────────────
OUT.mkdir(exist_ok=True)
router_names = {
    "worlds": "handleWorlds", "cards": "handleCards", "personas": "handlePersonas",
    "conversations": "handleConversations", "messages": "handleMessages",
    "media": "handleMedia", "backups": "handleBackups", "jobs": "handleJobs",
    "settings": "handleSettings", "assist": "handleAssist",
}

for router, fn in router_names.items():
    router_blocks = files[router]
    if not router_blocks:
        continue
    text = "\n\n".join(router_blocks)
    imports = build_imports(text, force_http=True)
    header = (
        "/**\n"
        f" * {router} resource router (extracted from the monolithic routes.ts).\n"
        " * Returns null when no route matches; throws are mapped by index.ts.\n"
        " */\n"
    )
    body = "\n".join(imports) + "\n\n" + (
        f"export async function {fn}(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {{\n"
        "  const p = url.pathname;\n"
        "  try {\n"
        f"{text}\n"
        "    return null;\n"
        "  } catch (e) {\n"
        "    return errorResponse(e);\n"
        "  }\n"
        "}\n"
    )
    (OUT / f"{router}.ts").write_text(header + body, encoding="utf-8")
    print(f"[split] {router}.ts — {len(router_blocks)} route(s)")

# ── index.ts dispatcher ───────────────────────────────────────────────────────
index_blocks = files["index"]
index_text = "\n\n".join(index_blocks)

# dispatch in original first-appearance order (preserves route precedence)
order = []
for kind, block in blocks:
    if kind != "if":
        continue
    r = classify(cond_of(block))
    if r != "index" and r not in order:
        order.append(r)

chain = "\n".join(
    f"  const r{i} = await {router_names[r]}(req, url, parts, method);\n  if (r{i}) return r{i};"
    for i, r in enumerate(order)
)
print("[split] dispatch order:", " -> ".join(order))

meta_imports = build_imports(auth_block + "\n" + index_text, force_http=True)
router_imports = "\n".join(
    f"import {{ {router_names[r]} }} from \"./{r}\";"
    for r in order
)
index_src = (
    "/**\n"
    " * API dispatcher: LAN auth + meta endpoints inline, then per-resource\n"
    " * routers in original route order. Returns 404 when nothing matches.\n"
    " */\n"
    + "\n".join(meta_imports) + "\n\n"
    + router_imports + "\n\n"
    "export async function handleApi(req: Request, url: URL): Promise<Response> {\n"
    + auth_block + "\n"
    "  try {\n"
    + index_text + "\n"
    + chain + "\n"
    "    return json({ error: \"Not found\", code: Codes.NOT_FOUND }, 404);\n"
    "  } catch (e) {\n"
    "    return errorResponse(e);\n"
    "  }\n"
    "}\n"
)
(OUT / "index.ts").write_text(index_src, encoding="utf-8")
print("[split] index.ts")

# ── core.ts: all non-route helper code, exported ──────────────────────────────
def export_top_level(txt):
    txt = re.sub(r"^function (\w+)", r"export function \1", txt, flags=re.M)
    txt = re.sub(r"^async function (\w+)", r"export async function \1", txt, flags=re.M)
    txt = re.sub(r"^const (\w+)", r"export const \1", txt, flags=re.M)
    txt = re.sub(r"^type (\w+)", r"export type \1", txt, flags=re.M)
    txt = re.sub(r"^interface (\w+)", r"export interface \1", txt, flags=re.M)
    return txt


def fix_import_paths(txt):
    txt = re.sub(r'from "\./([^"]+)"', r'from "../\1"', txt)
    txt = re.sub(r'from "\.\./llm/([^"]+)"', r'from "../../llm/\1"', txt)
    return txt


core_src = fix_import_paths(export_top_level(core_src_raw))
core_header = (
    "/**\n"
    " * Shared helpers for the API routers: views, LLM operations, image\n"
    " * pipelines, retry handlers and re-exports of the low-level modules.\n"
    " */\n"
)
(OUT / "core.ts").write_text(core_header + "\n" + core_src, encoding="utf-8")
print("[split] core.ts")

print("done")