// Which provider(s) a pasted key could belong to, from its format alone.
// Ported from shaneBackend modules/ai/detect.ts (SHAN-596), then widened on
// 2026-11-17 after a reader's Gemini key was refused: Google now issues
// "AQ." keys alongside the old "AIza" ones.
//
// The rule is to turn a key away only when it cannot be an API key at all
// (spaces, too short) or can never run a model (an admin key). Anything else
// gets the list of providers whose format it matches, most likely owner first:
//
// - A distinctive prefix names one provider ("sk-ant-", "gsk_", "AQ.", ...).
//   Order matters where prefixes nest: every Anthropic and OpenRouter key also
//   starts with "sk-".
// - A plain "sk-" key is shared by OpenAI, DeepSeek, Qwen, Kimi and
//   SiliconFlow. OpenAI's own keys carry "T3BlbkFJ" (base64 of "OpenAI"), so
//   those are settled; for the rest service.ts asks the candidates in order and
//   keeps the first that accepts the key. That does show the key to the
//   providers before it, which is why Settings lets the reader name the
//   provider instead, and then only that one is asked.
// - A format we can't place returns no candidates and a reason; Settings asks
//   the reader to pick the provider, and that pick is honoured as is.

import { PROVIDER_LABEL, type AiProvider } from './registry.js';

export { AI_PROVIDERS, PROVIDER_LABEL, isProvider, type AiProvider } from './registry.js';

export interface Detection {
  /** Providers whose key format this matches, most likely first. Empty when unknown. */
  candidates: AiProvider[];
  /** Why there are no candidates. */
  reason?: string;
  /** The key can't be used whatever provider the reader names. */
  fatal?: boolean;
}

const PICK_PROVIDER = 'Choose its provider from the list and add it again.';

export function detectProviders(raw: string): Detection {
  const key = raw.trim();
  if (!key) return { candidates: [], reason: 'Paste an API key.', fatal: true };
  if (/\s/.test(key)) return { candidates: [], reason: 'A key has no spaces in it. Paste only the key.', fatal: true };
  if (key.length < 20) return { candidates: [], reason: 'That is too short to be an API key.', fatal: true };

  if (key.startsWith('sk-ant-admin')) {
    return {
      candidates: [],
      reason: 'That is an Anthropic Admin key, which cannot run models. Create a regular API key in the Anthropic console.',
      fatal: true,
    };
  }
  if (key.startsWith('sk-admin-')) {
    return { candidates: [], reason: 'That is an OpenAI Admin key, which cannot run models. Create a project API key.', fatal: true };
  }

  if (key.startsWith('sk-ant-')) return { candidates: ['anthropic'] };
  if (key.startsWith('sk-or-')) return { candidates: ['openrouter'] };
  if (/^sk-(proj|svcacct|None)-/.test(key) || key.includes('T3BlbkFJ')) return { candidates: ['openai'] };
  if (key.startsWith('xai-')) return { candidates: ['xai'] };
  if (key.startsWith('gsk_')) return { candidates: ['groq'] };
  if (key.startsWith('csk-')) return { candidates: ['cerebras'] };
  if (key.startsWith('fw_')) return { candidates: ['fireworks'] };
  if (key.startsWith('pplx-')) return { candidates: ['perplexity'] };
  if (key.startsWith('tgp_v1_') || /^[0-9a-f]{64}$/.test(key)) return { candidates: ['together'] };
  // Gemini: the old Cloud-console format and the "AQ." keys AI Studio issues now.
  if (key.startsWith('AQ.') || /^AIza[0-9A-Za-z_-]{35}$/.test(key)) return { candidates: ['gemini'] };

  if (key.startsWith('sk-')) {
    const body = key.slice(3);
    // DeepSeek and Qwen both issue sk- plus 32 hex characters.
    if (/^[0-9a-f]{32}$/.test(body)) return { candidates: ['deepseek', 'qwen'] };
    // SiliconFlow's are sk- plus lowercase letters.
    if (/^[a-z]{40,60}$/.test(body)) return { candidates: ['siliconflow', 'moonshot', 'openai'] };
    return { candidates: ['openai', 'deepseek', 'moonshot', 'qwen', 'siliconflow'] };
  }

  // Zhipu GLM keys are "<32 hex>.<secret>".
  if (/^[0-9a-f]{32}\.[A-Za-z0-9]{8,}$/.test(key)) return { candidates: ['zhipu'] };
  // Mistral and DeepInfra both issue 32 bare letters and digits.
  if (/^[A-Za-z0-9]{32}$/.test(key)) return { candidates: ['mistral', 'deepinfra'] };

  return { candidates: [], reason: `Could not tell which provider this key is for. ${PICK_PROVIDER}` };
}

/** Human list for messages: "OpenAI, DeepSeek or Qwen". */
export function providerList(providers: AiProvider[]): string {
  const labels = providers.map((p) => PROVIDER_LABEL[p]);
  return labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/** The last four characters: enough to tell two keys apart, useless to anyone else. */
export function keyHint(key: string): string {
  return key.trim().slice(-4);
}
