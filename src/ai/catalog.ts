// Which of a key's models can answer text (and read images), what each costs,
// and which to use by default. Ported from shaneBackend modules/ai/catalog.ts
// (SHAN-596 / SHAN-703); supportsImages is Nibbler's addition, because OCR and
// table-of-contents reading send page images. Widened 2026-11-17 to every
// provider in registry.ts.
//
// Prices are list prices in USD per million tokens: the live files first
// (LiteLLM's, and OpenRouter's own catalogue for OpenRouter), this file's table
// as the fallback, then a guess from the model's tier or size words ("lite",
// "mini", "flash", "8b", "70b", ...), marked as one.

import { liveModelOf } from './live-prices.js';
import { PROVIDER_SPECS, type AiProvider } from './registry.js';

export interface Price {
  input: number;
  output: number;
  known: boolean;
  source: 'live' | 'table' | 'estimate';
}

/** Never a chat model, whoever serves it. */
const NON_TEXT =
  /embed|tts|transcribe|whisper|audio|realtime|speech|imagen|veo|lyria|sora|dall-?e|moderation|robotics|computer-use|antigravity|deep-research|omni|nano-banana|aqa|learnlm|customtools|babbage|davinci|codex|vision-preview|guard|rerank|ocr|flux|stable-diffusion|sdxl|kolors|video|voxtral|compound|playai|orpheus|qwen-mt|-image(-|$|:)|(^|[/-])image-/i;

/** Extra exclusions for the first four, whose catalogues mix in models Nibbler can't drive. */
const NON_TEXT_NATIVE = /image|search|gemma|-instruct/i;

export function isTextModel(provider: AiProvider, id: string): boolean {
  if (NON_TEXT.test(id)) return false;
  switch (provider) {
    case 'openai':
      return !NON_TEXT_NATIVE.test(id) && /^(gpt-|o\d|chatgpt-)/.test(id);
    case 'anthropic':
      return id.startsWith('claude-');
    case 'gemini':
      return !NON_TEXT_NATIVE.test(id) && id.startsWith('gemini-');
    case 'xai':
      return !NON_TEXT_NATIVE.test(id) && id.startsWith('grok-');
    default:
      return true;
  }
}

/** Families known to read images, for models no live file describes. */
const VISION_HINT =
  /vision|[-_/]vl([-_.:]|$)|qvq|pixtral|llava|llama-4|llama-3\.2-(11|90)b|gemma-3|glm-4(\.\d+)?v|minicpm-v|mistral-(small|medium)|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|grok-4|kimi-k2\.5|kimi-vl|internvl|multimodal/i;

/**
 * Whether a model accepts page images. The live file's flag wins when it has
 * one; otherwise the families that are known to: every Claude 3+ and Gemini
 * model, OpenAI's 4o / 4.1 / 5 / o1 / o3 / o4 lines (not their -mini reasoning
 * siblings o1-mini and o3-mini, nor 3.5), Grok 4 or any Grok "vision" model,
 * and, from the other providers, model names that say so (VL, vision,
 * Pixtral, Llama 4, ...).
 */
export function supportsImages(provider: AiProvider, id: string): boolean {
  const live = liveModelOf(provider, id);
  if (live?.vision !== undefined) return live.vision;
  switch (provider) {
    case 'anthropic':
      return /^claude-(3|haiku|sonnet|opus|[4-9])/.test(id);
    case 'gemini':
      return id.startsWith('gemini-');
    case 'openai':
      if (/^o[13]-mini/.test(id)) return false;
      return /^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o1|o3|o4)/.test(id);
    case 'xai':
      return /vision|^grok-4/.test(id);
    default:
      return VISION_HINT.test(id);
  }
}

// Longest matching prefix wins, so "gpt-4.1-mini" beats "gpt-4.1".
const KNOWN: Partial<Record<AiProvider, [prefix: string, input: number, output: number][]>> = {
  openai: [
    ['gpt-5.5', 5, 30],
    ['gpt-5-nano', 0.05, 0.4],
    ['gpt-5-mini', 0.25, 2],
    ['gpt-5', 1.25, 10],
    ['gpt-4.1-nano', 0.1, 0.4],
    ['gpt-4.1-mini', 0.4, 1.6],
    ['gpt-4.1', 2, 8],
    ['gpt-4o-mini', 0.15, 0.6],
    ['gpt-4o', 2.5, 10],
    ['o4-mini', 1.1, 4.4],
    ['o3-mini', 1.1, 4.4],
    ['o3', 2, 8],
    ['gpt-3.5-turbo', 0.5, 1.5],
  ],
  anthropic: [
    ['claude-3-haiku', 0.25, 1.25],
    ['claude-3-5-haiku', 0.8, 4],
    ['claude-haiku-4-5', 1, 5],
    ['claude-sonnet-4', 3, 15],
    ['claude-opus-4-5', 5, 25],
    ['claude-haiku-5-5', 0.1, 0.5],
    ['claude-sonnet-5', 2, 10],
    ['claude-opus-5', 5, 25],
    ['claude-opus-5-5', 4, 20],
    ['claude-opus-4-1', 15, 75],
    ['claude-opus-4-0', 15, 75],
  ],
  gemini: [
    ['gemini-2.0-flash-lite', 0.075, 0.3],
    ['gemini-2.0-flash', 0.1, 0.4],
    ['gemini-2.5-flash-lite', 0.1, 0.4],
    ['gemini-2.5-flash', 0.3, 2.5],
    ['gemini-2.5-pro', 1.25, 10],
    ['gemini-3.5-flash-lite', 0.3, 2.5],
    ['gemini-3.5-flash', 1.5, 9],
  ],
  xai: [
    ['grok-4-1-fast', 0.2, 0.5],
    ['grok-4-fast', 0.2, 0.5],
    ['grok-code-fast', 0.2, 1.5],
    ['grok-3-mini', 0.3, 0.5],
    ['grok-3', 3, 15],
    ['grok-4', 3, 15],
  ],
  deepseek: [
    ['deepseek-chat', 0.28, 0.42],
    ['deepseek-reasoner', 0.28, 0.42],
  ],
  mistral: [
    ['ministral-3b', 0.04, 0.04],
    ['ministral-8b', 0.1, 0.1],
    ['mistral-small', 0.1, 0.3],
    ['mistral-medium', 0.4, 2],
    ['mistral-large', 2, 6],
  ],
  groq: [
    ['llama-3.1-8b-instant', 0.05, 0.08],
    ['llama-3.3-70b-versatile', 0.59, 0.79],
    ['openai/gpt-oss-20b', 0.075, 0.3],
    ['openai/gpt-oss-120b', 0.15, 0.6],
    ['meta-llama/llama-4-scout', 0.11, 0.34],
  ],
  zhipu: [
    ['glm-4.5-flash', 0, 0],
    ['glm-4-flash', 0, 0],
    ['glm-4.5-air', 0.2, 1.1],
  ],
  perplexity: [
    ['sonar-pro', 3, 15],
    ['sonar', 1, 1],
  ],
};

function tierPrice(provider: AiProvider, id: string): [number, number] {
  const s = id.toLowerCase();
  switch (provider) {
    case 'gemini':
      if (s.includes('lite')) return [0.1, 0.4];
      if (s.includes('flash')) return [0.3, 2.5];
      if (s.includes('pro')) return [1.25, 10];
      return [1, 8];
    case 'openai':
      if (s.includes('nano')) return [0.05, 0.4];
      if (s.includes('mini')) return [0.25, 2];
      if (/^o\d/.test(s)) return [2, 8];
      return [1.25, 10];
    case 'anthropic':
      if (s.includes('haiku')) return [1, 5];
      if (s.includes('opus')) return [5, 25];
      return [3, 15];
    case 'xai':
      if (s.includes('mini') || s.includes('fast')) return [0.2, 0.5];
      return [3, 15];
    default:
      if (s.endsWith(':free')) return [0, 0];
      if (/(^|[^\d.])(0\.\d+|1|1\.\d|2|3|4|7|8|9)b\b|nano|mini|lite|flash|instant|small|turbo|haiku/.test(s)) return [0.1, 0.3];
      if (/(^|[^\d.])(1[0-9]|2\d|3\d)b\b|medium|air/.test(s)) return [0.3, 0.9];
      if (/(^|[^\d.])([4-9]\d|1\d\d)b\b|plus/.test(s)) return [0.6, 1];
      if (/large|max|pro|opus|[2-9]\d\db\b/.test(s)) return [2, 8];
      return [0.5, 1.5];
  }
}

export function priceOf(provider: AiProvider, id: string): Price {
  const live = liveModelOf(provider, id);
  if (live) return { input: live.input, output: live.output, known: true, source: 'live' };
  let best: [string, number, number] | undefined;
  for (const row of KNOWN[provider] ?? []) {
    if (id.startsWith(row[0]) && (!best || row[0].length > best[0].length)) best = row;
  }
  if (best) return { input: best[1], output: best[2], known: true, source: 'table' };
  const [input, output] = tierPrice(provider, id);
  return { input, output, known: false, source: 'estimate' };
}

/** Estimated cost of one call, in millionths of a dollar. */
export function costMicroUsd(provider: AiProvider, model: string, inputTokens: number, outputTokens: number): number {
  const p = priceOf(provider, model);
  return Math.round(p.input * inputTokens + p.output * outputTokens);
}

/** A typical call is roughly three parts prompt to one part answer. */
function blended(p: Price): number {
  return p.input * 0.75 + p.output * 0.25;
}

function versionOf(id: string): number {
  const m = id.match(/(\d+(?:[.-]\d+)?)/);
  return m ? Number(m[1].replace('-', '.')) : 0;
}

const UNSTABLE = /preview|exp|experimental|-\d{2}-\d{2,4}$/i;

/** Small models that answer cheaply and translate badly; and free tiers that are heavily rate-limited. */
const DEMOTED = /(^|[^\d.])(0\.\d+|1|1\.\d|2|3)b\b|:free$/i;

/** Settings shows one picker per key; aggregators list hundreds. */
export const MAX_MODELS = 100;

/**
 * Text models in the order the key check tries them, which is also the order
 * of the model picker. The provider's preferred defaults first (registry.ts),
 * then cheapest first: ties go to stable over preview, then the newer
 * generation. On the many-model providers, tiny models and free tiers go last.
 */
export function rankModels(provider: AiProvider, ids: string[]): string[] {
  const spec = PROVIDER_SPECS[provider];
  const native = spec.api !== 'openai' || provider === 'openai' || provider === 'xai';
  const text = [...new Set(ids)].filter((id) => isTextModel(provider, id));
  const preferred = (spec.preferred ?? []).filter((id) => text.includes(id));
  const rest = text
    .filter((id) => !preferred.includes(id))
    .map((id) => ({
      id,
      demoted: !native && DEMOTED.test(id),
      cost: blended(priceOf(provider, id)),
      unstable: UNSTABLE.test(id),
      version: versionOf(id),
    }))
    .sort(
      (a, b) =>
        Number(a.demoted) - Number(b.demoted) ||
        a.cost - b.cost ||
        Number(a.unstable) - Number(b.unstable) ||
        b.version - a.version ||
        a.id.localeCompare(b.id),
    )
    .map((m) => m.id);
  return [...preferred, ...rest].slice(0, MAX_MODELS);
}
