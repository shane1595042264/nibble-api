import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProviderError, generate, classify, listModels } from '../../../src/ai/providers.js';

const IMG = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

function ok(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function fail(status: number, body: unknown) {
  return { ok: false, status, text: async () => JSON.stringify(body) };
}

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const sentBody = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse(fetchMock.mock.calls[0][1].body);

describe('generate: request shapes with page images and JSON', () => {
  it('Anthropic: image blocks before the text, x-api-key, stop_reason max_tokens means truncated', async () => {
    const f = stubFetch(ok({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 9, output_tokens: 2 }, stop_reason: 'max_tokens' }));
    const r = await generate('anthropic', 'sk-ant-k', 'claude-haiku-4-5', { prompt: 'read', images: [IMG], maxTokens: 50 });
    const body = sentBody(f);
    expect(f.mock.calls[0][1].headers['x-api-key']).toBe('sk-ant-k');
    expect(body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG.data } });
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'read' });
    expect(body.system).toBeUndefined();
    expect(r).toEqual({ text: 'hi', inputTokens: 9, outputTokens: 2, truncated: true });
  });

  it('Anthropic: 5-generation models get 2048 extra tokens for default thinking, older ones the exact budget (KAN-416)', async () => {
    const reply = ok({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' }], usage: {}, stop_reason: 'end_turn' });
    for (const [model, expected] of [
      ['claude-haiku-5-5', 2198],
      ['claude-sonnet-5', 2198],
      ['claude-fable-5-1', 2198],
      ['claude-haiku-4-5', 150],
      ['claude-opus-4-8', 150],
      ['claude-3-5-haiku-latest', 150],
    ] as const) {
      const f = stubFetch(reply);
      const r = await generate('anthropic', 'k', model, { prompt: 'P', maxTokens: 150 });
      expect(sentBody(f).max_tokens, model).toBe(expected);
      expect(sentBody(f).thinking, model).toBeUndefined();
      expect(r.text).toBe('hi');
    }
  });

  it('OpenAI: data-URL image parts, json_object when asked, finish_reason length means truncated', async () => {
    const f = stubFetch(ok({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    const r = await generate('openai', 'sk-k', 'gpt-4.1-nano', { system: 'S', prompt: 'P', images: [IMG], maxTokens: 50, json: true });
    const body = sentBody(f);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'S' });
    expect(body.messages[1].content[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${IMG.data}` } });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_completion_tokens).toBe(50);
    expect(r.truncated).toBe(true);
  });

  it('xAI: plain string content without images, no response_format', async () => {
    const f = stubFetch(ok({ choices: [{ message: { content: 'x' } }], usage: {} }));
    await generate('xai', 'xai-k', 'grok-4-fast', { prompt: 'P', maxTokens: 10, json: true });
    const body = sentBody(f);
    expect(body.messages).toEqual([{ role: 'user', content: 'P' }]);
    expect(body.response_format).toBeUndefined();
    expect(body.max_tokens).toBe(10);
  });

  it('Gemini: inline_data parts, JSON mime type, thinking tokens billed as output', async () => {
    const f = stubFetch(ok({
      candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'answer' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, thoughtsTokenCount: 7 },
    }));
    const r = await generate('gemini', 'AIzaK', 'gemini-2.5-flash', { prompt: 'P', images: [IMG], maxTokens: 10, json: true });
    const body = sentBody(f);
    expect(body.contents[0].parts[0]).toEqual({ inline_data: { mime_type: 'image/png', data: IMG.data } });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(f.mock.calls[0][1].headers['x-goog-api-key']).toBe('AIzaK');
    expect(r).toEqual({ text: 'answer', inputTokens: 4, outputTokens: 10, truncated: false });
  });
});

describe('the OpenAI-compatible providers share one path', () => {
  it('Groq: its own base URL, a bearer key, max_tokens, no response_format', async () => {
    const f = stubFetch(ok({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    await generate('groq', 'gsk_k', 'llama-3.3-70b-versatile', { prompt: 'P', maxTokens: 20, json: true });
    expect(f.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer gsk_k');
    const body = sentBody(f);
    expect(body.max_tokens).toBe(20);
    expect(body.response_format).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('DeepSeek asks for JSON; a reasoning model gets headroom and its <think> block is dropped', async () => {
    const f = stubFetch(ok({ choices: [{ message: { content: '<think>hmm</think>\n{"ok":true}' } }], usage: {} }));
    const r = await generate('deepseek', 'sk-k', 'deepseek-reasoner', { prompt: 'P', maxTokens: 20, json: true });
    const body = sentBody(f);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(20 + 2048);
    expect(r.text).toBe('{"ok":true}');
  });

  it('a key on a regional server is called there; anything else falls back to the default', async () => {
    const f = stubFetch(ok({ choices: [{ message: { content: 'x' } }] }));
    await generate('qwen', 'sk-k', 'qwen-flash', { prompt: 'P', maxTokens: 5 }, { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
    await generate('qwen', 'sk-k', 'qwen-flash', { prompt: 'P', maxTokens: 5 }, { baseUrl: 'https://attacker.example/v1' });
    expect(f.mock.calls[0][0]).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(f.mock.calls[1][0]).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
  });

  it('lists models from {data:[...]} or a bare array, and falls back to known models where there is no list', async () => {
    stubFetch(ok([{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' }, { id: 'x' }]));
    expect(await listModels('together', 'k')).toEqual(['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'x']);
    stubFetch(fail(404, { error: { message: 'Not Found' } }));
    expect(await listModels('zhipu', 'k')).toContain('glm-4.5-flash');
    stubFetch(fail(404, { error: { message: 'Not Found' } }));
    await expect(listModels('mistral', 'k')).rejects.toBeInstanceOf(ProviderError);
  });

  it('a Gemini "AQ." key goes in the same x-goog-api-key header as the old format', async () => {
    const f = stubFetch(ok({ models: [{ name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] }));
    expect(await listModels('gemini', 'AQ.Ab8Rxyz')).toEqual(['gemini-2.5-flash-lite']);
    expect(f.mock.calls[0][1].headers['x-goog-api-key']).toBe('AQ.Ab8Rxyz');
  });
});

describe('generate: failures', () => {
  it.each([
    [401, { error: { message: 'invalid x-api-key' } }, 'auth'],
    [400, { error: { message: 'Your credit balance is too low' } }, 'quota'],
    [404, { error: { message: 'model not found' } }, 'model'],
    [429, { error: { message: 'slow down' } }, 'rate'],
    [500, { error: { message: 'boom' } }, 'other'],
  ])('HTTP %s becomes a %s ProviderError carrying the provider message', async (status, body, kind) => {
    stubFetch(fail(status, body));
    const err = await generate('anthropic', 'k', 'm', { prompt: 'P', maxTokens: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe(kind);
    expect(err.message).toBe(body.error.message);
  });

  it('a deadline becomes a "timeout" ProviderError', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    })));
    const err = await generate('openai', 'k', 'm', { prompt: 'P', maxTokens: 5, timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('timeout');
  });

  it("rethrows the caller's own abort untouched, so the route can answer 499", async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('gone'), { name: 'AbortError' })));
    })));
    const pending = generate('openai', 'k', 'm', { prompt: 'P', maxTokens: 5, signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e) => e);
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(err.name).toBe('AbortError');
  });

  it('classify reads status first, then the provider wording', () => {
    expect(classify(400, 'API key not valid. Please pass a valid API key.')).toBe('auth');
    expect(classify(429, 'You exceeded your current quota')).toBe('quota');
  });
});
