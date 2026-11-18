// Every provider a reader's key can belong to, in one table (2026-11-17,
// widened the same day from the first four).
//
// Four speak their own wire format (Anthropic, Gemini, and OpenAI and xAI's
// chat completions). Everything else here speaks OpenAI-compatible chat
// completions at its own base URL, so adding a provider is a row in this table,
// not new request code. Providers that run separate servers per region (Qwen,
// Kimi, GLM, SiliconFlow) list every regional base URL: a key only works in the
// region it was made in, so the key check tries each and the row remembers the
// one that answered (user_ai_keys.base_url).

export type AiProvider =
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'xai'
  | 'deepseek'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'qwen'
  | 'moonshot'
  | 'zhipu'
  | 'siliconflow'
  | 'together'
  | 'fireworks'
  | 'deepinfra'
  | 'cerebras'
  | 'perplexity';

export interface ProviderSpec {
  label: string;
  /** Wire format. 'openai' = OpenAI-compatible chat completions at baseUrls[i]. */
  api: 'anthropic' | 'gemini' | 'openai';
  /** First is the default; the rest are other regions, tried in order when a key is checked. */
  baseUrls: string[];
  /** One label per base URL, shown on the key in Settings when it isn't the first. */
  regions?: string[];
  /** Where a reader creates a key. */
  keysUrl: string;
  /** What the key looks like, for Settings. */
  keyFormat: string;
  /** Where its list prices live in LiteLLM's file (catalog.ts / live-prices.ts). */
  litellm?: { provider: string; slashIds?: boolean };
  /** Accepts response_format: json_object reliably. Others get JSON from the prompt alone. */
  jsonMode?: boolean;
  /** OpenAI's newer models reject max_tokens. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** For providers with no usable models endpoint. */
  staticModels?: string[];
  /**
   * Good, cheap defaults, tried first in this order when the key lists them.
   * Aggregators list hundreds of models and the cheapest are often tiny ones
   * that translate badly, so "cheapest" alone is not a safe default there.
   */
  preferred?: string[];
}

export const PROVIDER_SPECS: Record<AiProvider, ProviderSpec> = {
  gemini: {
    label: 'Google Gemini',
    api: 'gemini',
    baseUrls: ['https://generativelanguage.googleapis.com/v1beta'],
    keysUrl: 'https://aistudio.google.com/apikey',
    keyFormat: 'AQ.… or AIza…',
  },
  openai: {
    label: 'OpenAI',
    api: 'openai',
    baseUrls: ['https://api.openai.com/v1'],
    keysUrl: 'https://platform.openai.com/api-keys',
    keyFormat: 'sk-proj-… or sk-…',
    litellm: { provider: 'openai' },
    jsonMode: true,
    maxTokensParam: 'max_completion_tokens',
  },
  anthropic: {
    label: 'Anthropic Claude',
    api: 'anthropic',
    baseUrls: ['https://api.anthropic.com/v1'],
    keysUrl: 'https://console.anthropic.com/settings/keys',
    keyFormat: 'sk-ant-…',
  },
  xai: {
    label: 'xAI Grok',
    api: 'openai',
    baseUrls: ['https://api.x.ai/v1'],
    keysUrl: 'https://console.x.ai',
    keyFormat: 'xai-…',
    litellm: { provider: 'xai' },
  },
  deepseek: {
    label: 'DeepSeek',
    api: 'openai',
    baseUrls: ['https://api.deepseek.com/v1'],
    keysUrl: 'https://platform.deepseek.com/api_keys',
    keyFormat: 'sk-…',
    litellm: { provider: 'deepseek' },
    jsonMode: true,
    preferred: ['deepseek-chat'],
  },
  openrouter: {
    label: 'OpenRouter',
    api: 'openai',
    baseUrls: ['https://openrouter.ai/api/v1'],
    keysUrl: 'https://openrouter.ai/settings/keys',
    keyFormat: 'sk-or-v1-…',
    preferred: [
      'google/gemini-2.5-flash-lite',
      'openai/gpt-4.1-nano',
      'openai/gpt-4o-mini',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-chat-v3.1',
      'meta-llama/llama-3.3-70b-instruct',
    ],
  },
  groq: {
    label: 'Groq',
    api: 'openai',
    baseUrls: ['https://api.groq.com/openai/v1'],
    keysUrl: 'https://console.groq.com/keys',
    keyFormat: 'gsk_…',
    litellm: { provider: 'groq', slashIds: true },
    preferred: ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'openai/gpt-oss-120b'],
  },
  mistral: {
    label: 'Mistral',
    api: 'openai',
    baseUrls: ['https://api.mistral.ai/v1'],
    keysUrl: 'https://console.mistral.ai/api-keys',
    keyFormat: '32 letters and digits',
    litellm: { provider: 'mistral' },
    jsonMode: true,
    preferred: ['mistral-small-latest', 'ministral-8b-latest', 'mistral-medium-latest'],
  },
  qwen: {
    label: 'Qwen (Alibaba Model Studio)',
    api: 'openai',
    baseUrls: [
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    ],
    regions: ['International', 'China', 'US'],
    keysUrl: 'https://modelstudio.console.alibabacloud.com/',
    keyFormat: 'sk-…',
    litellm: { provider: 'dashscope' },
    jsonMode: true,
    preferred: ['qwen-flash', 'qwen-turbo', 'qwen-plus', 'qwen3-vl-flash', 'qwen-vl-plus'],
  },
  moonshot: {
    label: 'Moonshot Kimi',
    api: 'openai',
    baseUrls: ['https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1'],
    regions: ['International', 'China'],
    keysUrl: 'https://platform.moonshot.ai/console/api-keys',
    keyFormat: 'sk-…',
    litellm: { provider: 'moonshot' },
    jsonMode: true,
    preferred: ['kimi-k2-turbo-preview', 'moonshot-v1-8k', 'kimi-latest'],
  },
  zhipu: {
    label: 'Zhipu GLM (Z.ai)',
    api: 'openai',
    baseUrls: ['https://api.z.ai/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4'],
    regions: ['International', 'China'],
    keysUrl: 'https://z.ai/manage-apikey/apikey-list',
    keyFormat: 'id.secret',
    litellm: { provider: 'zai' },
    staticModels: ['glm-4.5-flash', 'glm-4-flash-250414', 'glm-4.5-air', 'glm-4.6', 'glm-4.5v'],
    preferred: ['glm-4.5-flash', 'glm-4-flash-250414', 'glm-4.5-air'],
  },
  siliconflow: {
    label: 'SiliconFlow',
    api: 'openai',
    baseUrls: ['https://api.siliconflow.com/v1', 'https://api.siliconflow.cn/v1'],
    regions: ['International', 'China'],
    keysUrl: 'https://cloud.siliconflow.cn/account/ak',
    keyFormat: 'sk-…',
    preferred: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-32B', 'Qwen/Qwen2.5-VL-72B-Instruct'],
  },
  together: {
    label: 'Together AI',
    api: 'openai',
    baseUrls: ['https://api.together.xyz/v1'],
    keysUrl: 'https://api.together.ai/settings/api-keys',
    keyFormat: 'tgp_v1_… or 64 hex characters',
    litellm: { provider: 'together_ai', slashIds: true },
    preferred: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    ],
  },
  fireworks: {
    label: 'Fireworks AI',
    api: 'openai',
    baseUrls: ['https://api.fireworks.ai/inference/v1'],
    keysUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    keyFormat: 'fw_…',
    litellm: { provider: 'fireworks_ai', slashIds: true },
    preferred: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/deepseek-v3',
      'accounts/fireworks/models/qwen3-235b-a22b',
    ],
  },
  deepinfra: {
    label: 'DeepInfra',
    api: 'openai',
    baseUrls: ['https://api.deepinfra.com/v1/openai'],
    keysUrl: 'https://deepinfra.com/dash/api_keys',
    keyFormat: 'letters and digits',
    litellm: { provider: 'deepinfra', slashIds: true },
    preferred: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  },
  cerebras: {
    label: 'Cerebras',
    api: 'openai',
    baseUrls: ['https://api.cerebras.ai/v1'],
    keysUrl: 'https://cloud.cerebras.ai',
    keyFormat: 'csk-…',
    litellm: { provider: 'cerebras' },
    preferred: ['llama-3.3-70b', 'gpt-oss-120b', 'qwen-3-32b', 'llama3.1-8b'],
  },
  perplexity: {
    label: 'Perplexity',
    api: 'openai',
    baseUrls: ['https://api.perplexity.ai'],
    keysUrl: 'https://www.perplexity.ai/settings/api',
    keyFormat: 'pplx-…',
    litellm: { provider: 'perplexity' },
    staticModels: ['sonar', 'sonar-pro'],
    preferred: ['sonar'],
  },
};

/** Display order in Settings: the big four, then the rest roughly by how common they are. */
export const AI_PROVIDERS = Object.keys(PROVIDER_SPECS) as AiProvider[];

export const PROVIDER_LABEL = Object.fromEntries(
  AI_PROVIDERS.map((p) => [p, PROVIDER_SPECS[p].label]),
) as Record<AiProvider, string>;

export function isProvider(value: string): value is AiProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDER_SPECS, value);
}

/** The base URL a key row uses: the one its check found, else the provider's default. */
export function baseUrlOf(provider: AiProvider, stored?: string | null): string {
  const spec = PROVIDER_SPECS[provider];
  return stored && spec.baseUrls.includes(stored) ? stored : spec.baseUrls[0];
}

/** "China" for a key on Qwen's China endpoint; null on the default one. */
export function regionOf(provider: AiProvider, stored?: string | null): string | null {
  const spec = PROVIDER_SPECS[provider];
  const i = stored ? spec.baseUrls.indexOf(stored) : -1;
  return i > 0 && spec.regions ? spec.regions[i] ?? null : null;
}

/** What Settings shows about each provider. */
export function providerCatalog() {
  return AI_PROVIDERS.map((id) => ({
    id,
    label: PROVIDER_SPECS[id].label,
    keyFormat: PROVIDER_SPECS[id].keyFormat,
    keysUrl: PROVIDER_SPECS[id].keysUrl,
  }));
}
