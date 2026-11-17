// Which provider a pasted key belongs to, from its format alone (ported from
// shaneBackend modules/ai/detect.ts, SHAN-596).
//
// Settings asks for nothing but the key, so this is the whole of the provider
// choice. The prefixes are the providers' own and do not overlap once they are
// checked in the right order: every Anthropic key also starts with "sk-", so
// "sk-ant-" has to be tested before the bare "sk-" that means OpenAI, and the
// same goes for OpenRouter's "sk-or-". Keys that are recognisably for a
// provider Nibbler does not support get a reason that names it, rather than a
// generic "unknown key".

export type AiProvider = 'gemini' | 'openai' | 'anthropic' | 'xai';

export const AI_PROVIDERS: readonly AiProvider[] = ['gemini', 'openai', 'anthropic', 'xai'];

export const PROVIDER_LABEL: Record<AiProvider, string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  xai: 'xAI Grok',
};

export type Detection = { provider: AiProvider } | { provider: null; reason: string };

const SUPPORTED_HINT =
  'Supported keys: Google Gemini (AIza...), OpenAI (sk-...), Anthropic (sk-ant-...) and xAI Grok (xai-...).';

export function detectProvider(raw: string): Detection {
  const key = raw.trim();
  if (!key) return { provider: null, reason: 'Paste an API key.' };
  if (/\s/.test(key)) return { provider: null, reason: 'A key has no spaces in it. Paste only the key.' };
  if (key.length < 20) return { provider: null, reason: 'That is too short to be an API key.' };

  if (key.startsWith('sk-ant-admin')) {
    return {
      provider: null,
      reason: 'That is an Anthropic Admin key, which cannot run models. Create a regular API key in the Anthropic console.',
    };
  }
  if (key.startsWith('sk-ant-')) return { provider: 'anthropic' };
  if (key.startsWith('sk-or-')) return { provider: null, reason: `OpenRouter keys are not supported yet. ${SUPPORTED_HINT}` };
  if (key.startsWith('sk-admin-')) {
    return { provider: null, reason: 'That is an OpenAI Admin key, which cannot run models. Create a project API key.' };
  }
  if (key.startsWith('xai-')) return { provider: 'xai' };
  if (key.startsWith('gsk_')) {
    return {
      provider: null,
      reason: 'That looks like a Groq key (gsk_). Groq is not supported; xAI Grok keys start with xai-.',
    };
  }
  if (/^AIza[0-9A-Za-z_-]{35}$/.test(key)) return { provider: 'gemini' };
  if (key.startsWith('sk-')) return { provider: 'openai' };
  return { provider: null, reason: `Could not tell which provider this key is for. ${SUPPORTED_HINT}` };
}

/** The last four characters: enough to tell two keys apart, useless to anyone else. */
export function keyHint(key: string): string {
  return key.trim().slice(-4);
}
