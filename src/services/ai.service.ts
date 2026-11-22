import { Errors, AppError } from '../lib/errors.js';
import { runAi, type AiFeature } from '../ai/service.js';
import type { AiImage } from '../ai/providers.js';

/**
 * Every AI feature in Nibbler, run on the reader's OWN provider key (bring your
 * own key, 2026-11-17; src/ai/). The server holds no model key of its own any
 * more: a reader without a working key gets AI_KEY_REQUIRED (409) and Settings
 * > AI tells them what to add. Each call is metered in ai_usage_events.
 *
 * The prompts are the ones the server already used with its Anthropic key;
 * the model is whichever the reader's key resolves to (cheapest that works, or
 * the one they picked), so the prompts stay provider-neutral and ask for JSON
 * in words where they need it.
 */
export interface AiCallContext {
  userId: string;
  signal?: AbortSignal;
}

/** The only host figure images come from (all 2,906 in prod rich_content, 2026-11-17). */
const FIGURE_IMAGE_ORIGIN = 'https://cdn.mathpix.com';
const FIGURE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

async function text(ctx: AiCallContext, feature: AiFeature, input: Parameters<typeof runAi>[2]): Promise<string> {
  const r = await runAi(ctx.userId, feature, { ...input, signal: ctx.signal });
  // Cut off before any answer (e.g. the budget went on thinking): an error,
  // not an empty 200 that the reader would save as an empty explanation.
  if (r.truncated && !r.text.trim()) {
    throw Errors.aiError('The AI ran out of room before it answered — try again.');
  }
  return r.text;
}

function firstJson<T>(raw: string, shape: 'object' | 'array', what: string): T {
  const match = raw.match(shape === 'object' ? /\{[\s\S]*\}/ : /\[[\s\S]*\]/);
  if (!match) {
    console.error(`[ai.service] ${what}: no JSON ${shape} in the model's answer. Raw (first 500ch): ${raw.slice(0, 500)}`);
    throw Errors.aiError(`The AI's answer for ${what} was not valid JSON — try again.`);
  }
  try {
    return JSON.parse(match[0]) as T;
  } catch (err) {
    console.error(`[ai.service] ${what}: JSON.parse failed: ${err instanceof Error ? err.message : String(err)}. Raw (first 500ch): ${raw.slice(0, 500)}`);
    throw Errors.aiError(`The AI's answer for ${what} was not valid JSON — try again.`);
  }
}

const png = (data: string): AiImage => ({ mediaType: 'image/png', data });

const OCR_PROMPT =
  'Extract ALL text from this page image. Preserve paragraph structure. For mathematical formulas, use LaTeX notation wrapped in $...$ for inline or $$...$$ for display math. Return ONLY the extracted text, nothing else.';

export const aiService = {
  // Vision OCR — extract text from a page image
  async ocrPageImage(ctx: AiCallContext, base64Image: string, feature: AiFeature = 'ocr'): Promise<string> {
    return text(ctx, feature, { prompt: OCR_PROMPT, images: [png(base64Image)], maxTokens: 4096, timeoutMs: 90_000 });
  },

  // Batch OCR — multiple pages at once
  async ocrPages(ctx: AiCallContext, base64Images: string[]): Promise<string[]> {
    const results: string[] = [];
    for (const img of base64Images) {
      // Stop between pages if the client already disconnected, so a 12-page
      // batch doesn't bill 11 wasted calls to the reader's key after an abort.
      if (ctx.signal?.aborted) break;
      results.push(await this.ocrPageImage(ctx, img));
    }
    return results;
  },

  // ─── Reader-side translation / explanation ───────────────────────

  async translateWord(
    ctx: AiCallContext,
    word: string,
    sentence: string,
    targetLanguage: string,
  ): Promise<{ pronunciation: string; translation: string; partOfSpeech: string }> {
    const prompt = `You are a precise dictionary/translator. Given an English word and the sentence it appears in, provide:
1. The romanized pronunciation of the ENGLISH word (IPA format, e.g. /deɪ/ for "day")
2. A single, contextually accurate ${targetLanguage} translation — just ONE word or very short phrase, not multiple definitions
3. The part of speech (n., v., adj., adv., prep., conj., etc.)

Word: "${word}"
Sentence: "${sentence}"

Respond in this exact JSON format only, no other text:
{"pronunciation": "/.../ ", "translation": "...", "partOfSpeech": "..."}`;
    const raw = await text(ctx, 'translate-word', { prompt, maxTokens: 150, json: true });
    const parsed = firstJson<{ pronunciation?: string; translation?: string; partOfSpeech?: string }>(raw, 'object', `"${word}"`);
    return {
      pronunciation: parsed.pronunciation ?? '',
      translation: parsed.translation ?? '',
      partOfSpeech: parsed.partOfSpeech ?? '',
    };
  },

  async translateSentence(
    ctx: AiCallContext,
    sentence: string,
    paragraphContext: string,
    targetLanguage: string,
  ): Promise<{ translation: string }> {
    const prompt = `Translate the following English sentence into ${targetLanguage}. Use the surrounding paragraph for context to ensure accuracy. Return ONLY the translated sentence, nothing else.

Sentence: "${sentence}"

Paragraph context: "${paragraphContext}"`;
    const raw = await text(ctx, 'translate-sentence', { prompt, maxTokens: 300 });
    return { translation: raw.trim().replace(/^["']|["']$/g, '') };
  },

  async explainTranslation(
    ctx: AiCallContext,
    word: string,
    sentence: string,
    translation: string,
    targetLanguage: string,
  ): Promise<{ explanation: string }> {
    const prompt = `Explain briefly (under 100 words) why the English word "${word}" is translated as "${translation}" in ${targetLanguage}, given the sentence: "${sentence}". Focus on how the sentence context determines this specific meaning. Be concise and direct.`;
    return { explanation: (await text(ctx, 'explain-translation', { prompt, maxTokens: 200 })).trim() };
  },

  async explainContent(
    ctx: AiCallContext,
    content: string,
    surroundingContext: string,
  ): Promise<{ explanation: string }> {
    const prompt = `Explain the following content clearly and concisely. What does it mean, what is it showing, and how does it relate to the surrounding context?

Content:
${content}

Surrounding context:
${surroundingContext}

Give a clear explanation in English. If it's a table, explain what the data represents. If it's code, explain the algorithm. If it's a formula, explain what each variable means. Be thorough but concise.`;
    return { explanation: (await text(ctx, 'explain-content', { prompt, maxTokens: 500 })).trim() };
  },

  /**
   * Explain a figure. Used to run in the browser straight against Anthropic
   * with a key kept in localStorage; now the server fetches the image itself
   * (Mathpix's CDN only, so this can't be pointed at internal hosts) and sends
   * it to the reader's own vision-capable model.
   */
  async explainImage(
    ctx: AiCallContext,
    imageUrl: string,
    surroundingContext: string,
  ): Promise<{ explanation: string }> {
    let url: URL;
    try {
      url = new URL(imageUrl);
    } catch {
      throw Errors.badRequest('Invalid image URL');
    }
    if (url.origin !== FIGURE_IMAGE_ORIGIN) throw Errors.badRequest('Only Mathpix figure images can be explained');
    let res: Response;
    try {
      res = await fetch(url, { signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      throw new AppError('AI_ERROR', 'Could not download the figure image', 502);
    }
    const mediaType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !mediaType.startsWith('image/')) {
      throw new AppError('AI_ERROR', `Could not download the figure image (HTTP ${res.status})`, 502);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > FIGURE_IMAGE_MAX_BYTES) throw Errors.badRequest('Figure image is too large to explain');
    const prompt = `Explain this figure/diagram clearly. What does it show? How does it relate to the surrounding text?\n\nSurrounding context: ${surroundingContext}`;
    const raw = await text(ctx, 'explain-image', {
      prompt,
      images: [{ mediaType, data: bytes.toString('base64') }],
      maxTokens: 500,
      timeoutMs: 60_000,
    });
    return { explanation: raw.trim() };
  },

  /**
   * Find the keyboard shortcuts that answer a question the reader's words did
   * not match ("how do I switch modes?"). The browser sends its own catalog,
   * since the keymap lives there; only ids from that catalog come back.
   */
  async searchShortcuts(
    ctx: AiCallContext,
    query: string,
    shortcuts: Array<{ id: string; label: string; description: string }>,
  ): Promise<{ ids: string[] }> {
    const catalog = shortcuts.map((s) => `${s.id} | ${s.label} | ${s.description}`).join('\n');
    const prompt = `A reader of an e-book app asked how to do something with the keyboard. Pick the shortcuts below that answer the question, most relevant first, at most 5. If none fits, pick none.

Question: "${query}"

Shortcuts (id | name | what it does):
${catalog}

Respond with ONLY a JSON array of the chosen ids, e.g. ["id-one","id-two"], or [] if none fits.`;
    const raw = await text(ctx, 'search-shortcuts', { prompt, maxTokens: 200, json: true });
    const picked = firstJson<unknown[]>(raw, 'array', 'shortcut search');
    const known = new Set(shortcuts.map((s) => s.id));
    const ids = [...new Set(picked.filter((id): id is string => typeof id === 'string' && known.has(id)))];
    return { ids: ids.slice(0, 5) };
  },

  /**
   * Split a run of pages into the smallest sections a reader could study on
   * their own. Moved here from the browser (WordByWord ai-service.ts), which
   * used to call Anthropic directly with a key kept in localStorage.
   */
  async splitSections(
    ctx: AiCallContext,
    input: { pageImages: string[]; pageTexts: string[]; startPage: number; bookTitle: string; previousSectionTitle: string | null },
  ): Promise<{ sections: Array<{ title: string; startPage: number; endPage: number; summary: string }> }> {
    const { pageImages, pageTexts, startPage, bookTitle, previousSectionTitle } = input;
    const contextNote = previousSectionTitle
      ? `The previous batch ended with a section titled "${previousSectionTitle}". Continue from where that left off.`
      : 'This is the first batch of pages in the book.';
    const extracted = pageTexts
      .map((t, i) => (t && t.trim() ? `[Page ${startPage + i} extracted text]: ${t}` : ''))
      .filter(Boolean)
      .join('\n\n');
    const prompt = `${extracted ? `${extracted}\n\n` : ''}You are analyzing pages ${startPage} to ${startPage + pageImages.length - 1} of the book "${bookTitle}". The page images are attached in order.

${contextNote}

Identify all logical sections/topics on these pages. A single page may contain multiple sections. A section may span multiple pages. Break the content into the smallest meaningful units a reader could study independently.

Respond with ONLY valid JSON in this exact format:
{
  "sections": [
    {
      "title": "Clear descriptive title for this section",
      "startPage": <page number where section starts>,
      "endPage": <page number where section ends>,
      "summary": "1-2 sentence summary of what this section covers"
    }
  ]
}`;
    const raw = await text(ctx, 'split-sections', {
      prompt,
      images: pageImages.map((d) => png(d.replace(/^data:image\/\w+;base64,/, ''))),
      maxTokens: 4096,
      json: true,
      timeoutMs: 120_000,
    });
    const parsed = firstJson<{ sections?: unknown }>(raw, 'object', 'section split');
    return { sections: Array.isArray(parsed.sections) ? (parsed.sections as any[]) : [] };
  },
};
