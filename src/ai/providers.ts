// Every provider a reader's key can belong to, behind one shape. Ported from
// shaneBackend modules/ai/providers.ts (SHAN-596), extended for Nibbler:
// requests can carry page images (OCR, table-of-contents reading, figure
// explanation) and can ask for a JSON object back. Anthropic and Gemini have
// their own wire format; every other provider in registry.ts speaks OpenAI
// chat completions at its own base URL, so they share one code path.
//
// Every call has a deadline (no fetch here has a default one) and every
// provider failure becomes a ProviderError with a `kind` the service and
// Settings can act on: "auth" (key wrong or revoked), "quota" (key fine, the
// account cannot pay), "model" (model gone or not offered to this key),
// "rate", "timeout", or "other". The provider's own words are kept, trimmed:
// they are about the reader's own account. A client disconnect is not a
// provider failure; the caller's AbortError is rethrown untouched.

import { PROVIDER_SPECS, baseUrlOf, type AiProvider } from './registry.js';

export const DEFAULT_TIMEOUT_MS = 25_000;

/** Which of a provider's regional servers to call; the provider's default when omitted. */
export interface CallOptions {
  baseUrl?: string | null;
  /** Listing only: a shorter deadline while working out whose key it is. */
  timeoutMs?: number;
}

export type ProviderErrorKind = 'auth' | 'quota' | 'model' | 'rate' | 'timeout' | 'other';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface AiImage {
  /** e.g. "image/png" */
  mediaType: string;
  /** base64, no data: prefix */
  data: string;
}

export interface GenerateInput {
  system?: string;
  prompt: string;
  images?: AiImage[];
  /** Visible answer budget. Reasoning and thinking models get extra headroom on top. */
  maxTokens: number;
  /** Ask for a JSON object (OpenAI response_format, Gemini responseMimeType). The prompt must still say JSON. */
  json?: boolean;
  timeoutMs?: number;
  /** The caller's own cancellation (client disconnected). */
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The answer hit the token budget and was cut off (callers parsing JSON can say so). */
  truncated: boolean;
}

function providerMessage(body: unknown, fallback: string): string {
  const b = body as {
    error?: { message?: string } | string;
    message?: string;
    detail?: string | { msg?: string }[];
    msg?: string;
  } | null;
  const detail = typeof b?.detail === 'string' ? b.detail : Array.isArray(b?.detail) ? b.detail[0]?.msg : undefined;
  const msg = (typeof b?.error === 'string' ? b.error : b?.error?.message) ?? b?.message ?? detail ?? b?.msg ?? fallback;
  return String(msg).replace(/\s+/g, ' ').slice(0, 300);
}

export function classify(status: number, message: string): ProviderErrorKind {
  const m = message.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    m.includes('api key not valid') ||
    m.includes('invalid api key') ||
    m.includes('incorrect api key') ||
    m.includes('invalid_api_key') ||
    m.includes('authentication fails') ||
    m.includes('unauthorized')
  ) {
    return 'auth';
  }
  if (
    status === 402 ||
    m.includes('credit balance') ||
    m.includes('insufficient_quota') ||
    m.includes('insufficient balance') ||
    m.includes('exceeded your current quota') ||
    m.includes('billing') ||
    m.includes('arrearage') ||
    m.includes('余额')
  ) {
    return 'quota';
  }
  if (status === 404 || m.includes('no longer available') || m.includes('does not exist') || m.includes('not found') || m.includes('not supported for generatecontent')) {
    return 'model';
  }
  if (status === 429) return 'rate';
  return 'other';
}

async function call(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  } catch (err) {
    if (signal?.aborted) throw err; // the client went away: not the provider's fault
    if (deadline.aborted) {
      throw new ProviderError('timeout', 0, `The provider did not answer within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new ProviderError('other', 0, `Could not reach the provider: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = providerMessage(body, `HTTP ${res.status}`);
    throw new ProviderError(classify(res.status, message), res.status, message);
  }
  return body;
}

function bearer(key: string) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

function anthropicHeaders(key: string) {
  return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
}

function geminiHeaders(key: string) {
  return { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
}

/** OpenAI-compatible /models: `{ data: [{ id }] }`, or a bare array (Together). */
function idsOf(body: unknown): string[] {
  const list = Array.isArray(body) ? body : (body as { data?: unknown[] } | null)?.data ?? [];
  return list
    .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export async function listModels(provider: AiProvider, key: string, opts: CallOptions = {}): Promise<string[]> {
  const spec = PROVIDER_SPECS[provider];
  const base = baseUrlOf(provider, opts.baseUrl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (spec.api) {
    case 'anthropic': {
      const b = (await call(`${base}/models?limit=100`, { headers: anthropicHeaders(key) }, timeoutMs)) as {
        data?: { id: string }[];
      };
      return (b.data ?? []).map((m) => m.id);
    }
    case 'gemini': {
      const b = (await call(`${base}/models?pageSize=1000`, {
        headers: geminiHeaders(key),
      }, timeoutMs)) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return (b.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''));
    }
    case 'openai': {
      try {
        return idsOf(await call(`${base}/models`, { headers: bearer(key) }, timeoutMs));
      } catch (err) {
        // No models endpoint on this provider: the key check proves the key on
        // one of the known models instead.
        if (spec.staticModels && err instanceof ProviderError && (err.status === 404 || err.status === 405)) {
          return [...spec.staticModels];
        }
        throw err;
      }
    }
  }
}

/**
 * Reasoning models spend hidden tokens before the visible answer, and several
 * of them count those against the same budget.
 */
function isReasoning(provider: AiProvider, model: string): boolean {
  if (provider === 'openai') return /^(gpt-5|o\d)/.test(model);
  if (provider === 'xai') return model.includes('grok-3-mini');
  return /gpt-oss|reasoner|thinking|qwq|(^|[/-])r1\b|magistral|glm-4\.[5-9]|glm-[5-9]|kimi-k2/i.test(model);
}

/**
 * Claude 5-generation models (Haiku 5.5, Sonnet 5/5.5, Opus 5/5.5, Fable,
 * Mythos) run adaptive thinking when `thinking` is omitted, and the thinking
 * counts against max_tokens (KAN-416). Older Claude models don't think unless
 * asked. Disabling it isn't an option: Opus 5.5, Sonnet 5.5 and Fable reject
 * `thinking: { type: 'disabled' }` with a 400.
 */
function anthropicThinksByDefault(model: string): boolean {
  return /claude-(haiku|sonnet|opus|fable|mythos)-[5-9]\b/.test(model);
}

/** Some providers inline the reasoning as <think>...</think> before the answer. */
function stripThinking(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('');
  }
  return '';
}

export async function generate(
  provider: AiProvider,
  key: string,
  model: string,
  input: GenerateInput,
  opts: CallOptions = {},
): Promise<GenerateResult> {
  const images = input.images ?? [];
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spec = PROVIDER_SPECS[provider];
  const base = baseUrlOf(provider, opts.baseUrl);
  switch (spec.api) {
    case 'openai': {
      const reasoning = isReasoning(provider, model);
      const budget = input.maxTokens + (reasoning ? 2048 : 0);
      const userContent = images.length === 0
        ? input.prompt
        : [
          ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
          { type: 'text', text: input.prompt },
        ];
      const b = (await call(`${base}/chat/completions`, {
        method: 'POST',
        headers: bearer(key),
        body: JSON.stringify({
          model,
          messages: [
            ...(input.system ? [{ role: 'system', content: input.system }] : []),
            { role: 'user', content: userContent },
          ],
          // OpenAI's newer models take max_completion_tokens and reject
          // max_tokens; everyone else documents max_tokens.
          ...(spec.maxTokensParam === 'max_completion_tokens' ? { max_completion_tokens: budget } : { max_tokens: budget }),
          ...(reasoning && (provider === 'openai' || provider === 'xai') ? { reasoning_effort: 'low' } : {}),
          ...(input.json && spec.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      }, timeoutMs, input.signal)) as {
        choices?: { message?: { content?: unknown }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: stripThinking(textOf(b.choices?.[0]?.message?.content)),
        inputTokens: b.usage?.prompt_tokens ?? 0,
        outputTokens: b.usage?.completion_tokens ?? 0,
        truncated: b.choices?.[0]?.finish_reason === 'length',
      };
    }
    case 'anthropic': {
      const content = images.length === 0
        ? input.prompt
        : [
          ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
          { type: 'text', text: input.prompt },
        ];
      const b = (await call(`${base}/messages`, {
        method: 'POST',
        headers: anthropicHeaders(key),
        body: JSON.stringify({
          model,
          max_tokens: input.maxTokens + (anthropicThinksByDefault(model) ? 2048 : 0),
          ...(input.system ? { system: input.system } : {}),
          messages: [{ role: 'user', content }],
        }),
      }, timeoutMs, input.signal)) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
        stop_reason?: string;
      };
      return {
        text: (b.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
        inputTokens: b.usage?.input_tokens ?? 0,
        outputTokens: b.usage?.output_tokens ?? 0,
        truncated: b.stop_reason === 'max_tokens',
      };
    }
    case 'gemini': {
      const b = (await call(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: geminiHeaders(key),
        body: JSON.stringify({
          ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
          contents: [{
            role: 'user',
            parts: [
              ...images.map((img) => ({ inline_data: { mime_type: img.mediaType, data: img.data } })),
              { text: input.prompt },
            ],
          }],
          // Gemini 3.x thinks before it answers and the thinking counts
          // against this budget (shaneBackend SHAN-527), so leave it room.
          generationConfig: {
            maxOutputTokens: input.maxTokens + 2048,
            ...(input.json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      }, timeoutMs, input.signal)) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      };
      const parts = b.candidates?.[0]?.content?.parts ?? [];
      return {
        text: parts.filter((p) => !p.thought).map((p) => p.text ?? '').join(''),
        inputTokens: b.usageMetadata?.promptTokenCount ?? 0,
        // Thinking tokens are billed as output.
        outputTokens: (b.usageMetadata?.candidatesTokenCount ?? 0) + (b.usageMetadata?.thoughtsTokenCount ?? 0),
        truncated: b.candidates?.[0]?.finishReason === 'MAX_TOKENS',
      };
    }
  }
}
