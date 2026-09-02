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
  stream(opts: StreamOptions): AsyncGenerator<string>;
  /** Non-streaming completion (used for suggestions, summaries…). */
  complete(opts: StreamOptions): Promise<string>;
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
    try {
      const res = await fetch(`${this.baseUrl()}/models`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
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
    const data = (await res.json()) as { choices?: { message?: { content?: string; reasoning_content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? data.choices?.[0]?.message?.reasoning_content ?? "";
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
    try {
      const res = await fetch(`${this.baseUrl()}/models`, {
        headers: { Authorization: `Bearer ${this.key()}` },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }

  async *stream(opts: StreamOptions): AsyncGenerator<string> {
    const body = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 2048,
      stream: true,
    };
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
    const body = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 2048,
      stream: false,
    };
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