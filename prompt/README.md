# Prompts

Every text the app sends to a language model lives here as an **editable file**,
keyed by language, instead of a hard-coded string in the source. Editing a
prompt is now a content change, not a code change.

```
prompt/
  README.md
  fr/            # French (default language)
    summarize-system.txt
    chat-suggest-system.txt
    questions-system.txt
    scenario-intro-system.txt      # + all the assist/job/one-shot prompts
    …
  en/            # translations land here, one file at a time
    summarize-system.txt
```

## Layout & naming

- One file per prompt: `prompt/<lang>/<id>.txt` — `<id>` is a short
  kebab-case name (the thing the prompt is FOR, not its content: `summarize-system`,
  `chat-suggest-system`, `questions-system`).
- `<lang>` is an ISO 639-1 code. `fr` is the **fallback**: when a prompt has no
  file in the requested language yet, the French file is used, so translations
  can be added incrementally.
- Files are plain paragraphs, one sentence-group per line (the loader joins
  them as-is; the old code inconsistently used `join(" ")` vs `join("\n")` —
  files standardize on newlines).

## Loading (code)

Runtime loader: `src/llm/promptText.ts`.

```ts
import { promptText, promptFilled, fill } from "./promptText";

const sys = promptText("chat-suggest-system");                 // French default
const sys = promptFilled("questions-system", { count: n, persona }); // load + fill
const tpl = promptText("summarize-system", "en");              // explicit language
```

- **Lazy + cached**: a file is read on first use.
- **Fail fast**: a missing file throws (`prompt introuvable`) instead of
  silently sending an empty system prompt.
- **Placeholders** use `{{name}}` (double braces). Literal JSON examples in
  prompt text keep their single braces untouched.
- `INNSEKAI_PROMPT_DIR` overrides the root for tests/embedding.

## Rules for contributors

1. **Never hard-code a new LLM prompt in `.ts`** — create
   `prompt/fr/<id>.txt` and load it. A regression test
   (`tests/prompt-text.test.ts`) fails if a `const sys = […]` one-shot array
   reappears in `src/llm/prompt.ts` or `src/server/routes/core.ts`, and if any
   `promptText("…")` / `promptFilled("…")` id lacks its `prompt/fr/<id>.txt`
   file.
2. Keep ids stable; if a prompt's *meaning* changes, bump a version marker in
   the file or add a `-v2` id rather than silently editing (so older logged
   diagnostics stay interpretable).
3. Don't translate the format blocks (JSON schemas, `{{placeholders}}`).
4. Migration status: **complete** for every standalone system prompt (job
   prompts, AI-assist builders, the questionnaire, the summary prompt). The
   one deliberate exception is the **layered RP compiler copy** in
   `src/llm/prompt.ts` (`buildPromptLayers`): those fragments are assembled
   programmatically per profile with layer ordering and token-budget
   truncation, so they stay code — not flat files.
