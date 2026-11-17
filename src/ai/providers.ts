// The four providers a reader's key can belong to, behind one shape. Ported
// from shaneBackend modules/ai/providers.ts (SHAN-596), extended for Nibbler:
// requests can carry page images (OCR, table-of-contents reading, figure
// explanation) and can ask for a JSON object back.
//
// Every call has a deadline (no fetch here has a default one) and every
// provider failure becomes a ProviderError with a `kind` the service and
// Settings can act on: "auth" (key wrong or revoked), "quota" (key fine, the
// account cannot pay), "model" (model gone or not offered to this key),
// "rate", "timeout", or "other". The provider's own words are kept, trimmed:
// they are about the reader's own account. A client disconnect is not a
// provider failure; the caller's AbortError is rethrown untouched.

import type { AiProvider } from './detect.js';

export const DEFAULT_TIMEOUT_MS = 25_000;

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
  const b = body as { error?: { message?: string } | string; message?: string } | null;
  const msg = (typeof b?.error === 'string' ? b.error : b?.error?.message) ?? b?.message ?? fallback;
  return String(msg).replace(/\s+/g, ' ').slice(0, 300);
}

export function classify(status: number, message: string): ProviderErrorKind {
  const m = message.toLowerCase();
  if (status === 401 || status === 403 || m.includes('api key not valid') || m.includes('invalid api key') || m.includes('incorrect api key')) {
    return 'auth';
  }
  if (status === 402 || m.includes('credit balance') || m.includes('insufficient_quota') || m.includes('exceeded your current quota') || m.includes('billing')) {
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

export async function listModels(provider: AiProvider, key: string): Promise<string[]> {
  switch (provider) {
    case 'openai': {
      const b = (await call('https://api.openai.com/v1/models', { headers: bearer(key) }, DEFAULT_TIMEOUT_MS)) as { data?: { id: string }[] };
      return (b.data ?? []).map((m) => m.id);
    }
    case 'xai': {
      const b = (await call('https://api.x.ai/v1/models', { headers: bearer(key) }, DEFAULT_TIMEOUT_MS)) as { data?: { id: string }[] };
      return (b.data ?? []).map((m) => m.id);
    }
    case 'anthropic': {
      const b = (await call('https://api.anthropic.com/v1/models?limit=100', { headers: anthropicHeaders(key) }, DEFAULT_TIMEOUT_MS)) as {
        data?: { id: string }[];
      };
      return (b.data ?? []).map((m) => m.id);
    }
    case 'gemini': {
      const b = (await call('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
        headers: geminiHeaders(key),
      }, DEFAULT_TIMEOUT_MS)) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return (b.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''));
    }
  }
}

/** Reasoning models spend hidden tokens before the visible answer. */
function isReasoning(provider: AiProvider, model: string): boolean {
  if (provider === 'openai') return /^(gpt-5|o\d)/.test(model);
  if (provider === 'xai') return model.includes('grok-3-mini');
  return false;
}

export async function generate(
  provider: AiProvider,
  key: string,
  model: string,
  input: GenerateInput,
): Promise<GenerateResult> {
  const images = input.images ?? [];
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (provider) {
    case 'openai':
    case 'xai': {
      const reasoning = isReasoning(provider, model);
      const url = provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.x.ai/v1/chat/completions';
      const userContent = images.length === 0
        ? input.prompt
        : [
          ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
          { type: 'text', text: input.prompt },
        ];
      const b = (await call(url, {
        method: 'POST',
        headers: bearer(key),
        body: JSON.stringify({
          model,
          messages: [
            ...(input.system ? [{ role: 'system', content: input.system }] : []),
            { role: 'user', content: userContent },
          ],
          // OpenAI's newer models take max_completion_tokens and reject
          // max_tokens; xAI documents max_tokens.
          ...(provider === 'openai'
            ? { max_completion_tokens: input.maxTokens + (reasoning ? 1024 : 0) }
            : { max_tokens: input.maxTokens + (reasoning ? 1024 : 0) }),
          ...(reasoning ? { reasoning_effort: 'low' } : {}),
          ...(input.json && provider === 'openai' ? { response_format: { type: 'json_object' } } : {}),
        }),
      }, timeoutMs, input.signal)) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: b.choices?.[0]?.message?.content ?? '',
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
      const b = (await call('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: anthropicHeaders(key),
        body: JSON.stringify({
          model,
          max_tokens: input.maxTokens,
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
      const b = (await call(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
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
