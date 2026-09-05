/**
 * Chat providers: LM Studio (local, OpenAI-compatible) and OpenRouter (cloud).
 * Both expose the same streaming interface.
 */
import { getSetting } from "../server/db";
import { tracked } from "../server/health";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Disable chain-of-thought for qwen3-style models (LM Studio). */
  noThinking?: boolean;
}

export interface ChatProvider {
  id: string;
  label: string;
  configured(): boolean;
  models(): Promise<string[]>;
  /** Same list plus a human reason when it comes back empty (shown in settings). */
  listModels(): Promise<{ models: string[]; error?: string }>;
  stream(opts: StreamOptions): AsyncGenerator<string>;
  /** Non-streaming completion (used for suggestions, summaries…). */
  complete(opts: StreamOptions): Promise<string>;
}

/** Models that accept a `reasoning` control field on OpenRouter. */
function isThinkingModel(model: string): boolean {
  return /qwen|deepseek|r1|o1|o3|thinking|reasoning/i.test(String(model || ""));
}

/**
 * Normalize the many shapes a /models endpoint can return:
 * {data:[{id}]}, {data:["id"]}, {models:[…]}, or a bare array.
 * LM Studio versions disagree, so accept them all; sort + dedupe.
 */
export function normalizeModelList(data: unknown): string[] {
  const raw: unknown = Array.isArray(data)
    ? data
    : (data as any)?.data ?? (data as any)?.models ?? [];
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .map((m) => (typeof m === "string" ? m : (m as any)?.id))
    .filter((s): s is string => typeof s === "string" && !!s.trim())
    .map((s) => s.trim());
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export class LMStudioProvider implements ChatProvider {
  id = "lmstudio";
  label = "LM Studio (local)";

  configured(): boolean {
    return true;
  }

  baseUrl(): string {
    return (getSetting("lmstudio_url", "http://localhost:1234/v1") as string).replace(/\/+$/, "");
  }

  async models(): Promise<string[]> {
    return (await this.listModels()).models;
  }

  async listModels(): Promise<{ models: string[]; error?: string }> {
    const base = this.baseUrl();
    const urls = [`${base}/models`];
    // users often paste the bare host (http://localhost:1234) without /v1 —
    // try the suffixed endpoint before giving up
    if (!/\/v1$/.test(base)) urls.push(`${base}/v1/models`);
    let lastErr = "";
    for (const u of urls) {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) {
          lastErr = `LM Studio a répondu ${res.status} sur ${u}`;
          continue;
        }
        const models = normalizeModelList(await res.json().catch(() => null));
        if (models.length) return { models };
        lastErr = "aucun modèle chargé dans LM Studio — onglet Developer → charge un modèle (▶), puis actualise";
      } catch {
        lastErr = `LM Studio injoignable (${u}) — lance le serveur local (Developer → Start Server, port 1234)`;
      }
    }
    return { models: [], error: lastErr };
  }

  private body(opts: StreamOptions, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 2048,
      stream,
    };
    if (opts.noThinking && /qwen/i.test(opts.model)) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    return body;
  }

  async *stream(opts: StreamOptions): AsyncGenerator<string> {
    const res = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.body(opts, true)),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(`LM Studio (${res.status}): ${errText.slice(0, 300) || res.statusText}`);
    }
    yield* readSse(res.body, opts.signal);
  }

  async complete(opts: StreamOptions): Promise<string> {
    const res = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.body(opts, false)),
      signal: opts.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`LM Studio (${res.status}): ${errText.slice(0, 300) || res.statusText}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}

export class OpenRouterProvider implements ChatProvider {
  id = "openrouter";
  label = "OpenRouter (cloud)";

  configured(): boolean {
    return Boolean(getSetting("openrouter_key", ""));
  }

  key(): string {
    return getSetting("openrouter_key", "") as string;
  }

  baseUrl(): string {
    return "https://openrouter.ai/api/v1";
  }

  async models(): Promise<string[]> {
    return (await this.listModels()).models;
  }

  async listModels(): Promise<{ models: string[]; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl()}/models`, {
        headers: { Authorization: `Bearer ${this.key()}` },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return { models: [], error: `OpenRouter a répondu ${res.status} — vérifie la clé API` };
      const models = normalizeModelList(await res.json().catch(() => null));
      return models.length ? { models } : { models, error: "OpenRouter n'a renvoyé aucun modèle — vérifie la clé API" };
    } catch {
      return { models: [], error: "OpenRouter injoignable — vérifie ta connexion" };
    }
  }

  async *stream(opts: StreamOptions): AsyncGenerator<string> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 2048,
      stream: true,
    };
    if (opts.noThinking && isThinkingModel(opts.model)) {
      // OpenRouter parity with LM Studio's chat_template_kwargs: disable
      // chain-of-thought for reasoning models. Only sent for models known to
      // accept the field — unknown fields 400 on some OpenRouter models.
      body.reasoning = { enabled: false };
    }
    const res = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.key()}`,
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Innsekai",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenRouter (${res.status}): ${errText.slice(0, 300) || res.statusText}`);
    }
    yield* readSse(res.body, opts.signal);
  }

  async complete(opts: StreamOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 2048,
      stream: false,
    };
    if (opts.noThinking && isThinkingModel(opts.model)) {
      body.reasoning = { enabled: false };
    }
    const res = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.key()}`,
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Innsekai",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenRouter (${res.status}): ${errText.slice(0, 300) || res.statusText}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}

async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length) yield delta;
        } catch {
          /* partial chunk — ignore */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function getProvider(id?: string): ChatProvider {
  const provider = (id ?? getSetting("provider", "lmstudio")) as string;
  const raw = provider === "openrouter" ? new OpenRouterProvider() : new LMStudioProvider();
  return tracked(raw);
}

export function defaultModelFor(provider: string): string {
  if (provider === "openrouter") return getSetting("openrouter_model", "") as string;
  return getSetting("lmstudio_model", "") as string;
}