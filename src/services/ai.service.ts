import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';
import { Errors } from '../lib/errors.js';
import { SONNET_MODEL, HAIKU_MODEL } from '../lib/ai-models.js';

const anthropic = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 30_000 })
  : null;

export interface PageAnalysis {
  page: number;
  blocks: Array<{
    type: string;
    title?: string;
    startLine: number;
    endLine: number;
    hasMath: boolean;
    exerciseNumber?: string;
  }>;
  chapterTitle?: string;
  sectionTitle?: string;
}

export interface Exercise {
  exerciseNumber: string;
  content: string;
  page: number;
  chapterTitle?: string;
  exerciseType: string;
}

export const aiService = {
  // Structure extraction — sends EXTRACTED TEXT (not images) to Claude
  async classifyPages(extractedText: string[], tocIfAvailable?: string): Promise<PageAnalysis[]> {
    if (!anthropic) throw new Error('Anthropic not configured');

    const results: PageAnalysis[] = [];
    const BATCH_SIZE = 30;

    for (let i = 0; i < extractedText.length; i += BATCH_SIZE) {
      const batch = extractedText.slice(i, i + BATCH_SIZE);
      const pageNumbers = batch.map((_, idx) => i + idx + 1);

      const pagesText = batch.map((text, idx) =>
        `--- PAGE ${pageNumbers[idx]} ---\n${text}`
      ).join('\n\n');

      const systemPrompt = `You are a technical book structure analyzer. Given extracted text from pages of a technical/academic book, classify each page into structured blocks.

For each page, identify blocks with these types: body, theorem, proof, definition, example, exercise, figure, blockquote, list-item, epigraph, introduction, corollary, lemma, remark, heading, subheading.

For each block identify: type, approximate start/end lines, whether it contains math (hasMath), and if it's an exercise, the exercise number.

Also identify the current chapter title and section title if visible on the page.

${tocIfAvailable ? `Known table of contents:\n${tocIfAvailable}\n` : ''}

Respond with a JSON array of PageAnalysis objects.`;

      const response = await anthropic.messages.create({
        model: SONNET_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `Analyze these pages:\n\n${pagesText}`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          console.error(
            `[ai.service] classifyPages: no JSON array in Claude response for pages ${pageNumbers[0]}-${pageNumbers[pageNumbers.length - 1]}. Raw (first 500ch): ${text.slice(0, 500)}`,
          );
          continue;
        }
        const parsed = JSON.parse(jsonMatch[0]) as PageAnalysis[];
        results.push(...parsed);
      } catch (err) {
        console.error(
          `[ai.service] classifyPages: JSON.parse failed for pages ${pageNumbers[0]}-${pageNumbers[pageNumbers.length - 1]}: ${err instanceof Error ? err.message : String(err)}. Raw (first 500ch): ${text.slice(0, 500)}`,
        );
      }
    }

    return results;
  },

  // Extract exercises from page analyses (local, no API call)
  identifyExercises(pageAnalyses: PageAnalysis[]): Exercise[] {
    const exercises: Exercise[] = [];
    for (const page of pageAnalyses) {
      for (const block of page.blocks) {
        if (block.type === 'exercise' && block.exerciseNumber) {
          exercises.push({
            exerciseNumber: block.exerciseNumber,
            content: block.title ?? `Exercise ${block.exerciseNumber}`,
            page: page.page,
            chapterTitle: page.chapterTitle,
            exerciseType: 'problem',
          });
        }
      }
    }
    return exercises;
  },

  // Detect math-heavy pages from analysis results
  detectMathPages(extractedText: string[], pageAnalyses: PageAnalysis[]): number[] {
    const mathSymbols = /[∫∑∞√∂∈⊂≤≥≠∀∃∏∇∆λΩΣΠ]/;
    const mathPages = new Set<number>();

    for (const analysis of pageAnalyses) {
      for (const block of analysis.blocks) {
        if (block.hasMath) {
          mathPages.add(analysis.page);
          break;
        }
      }
    }

    // Also check raw text for math indicators
    extractedText.forEach((text, idx) => {
      if (mathSymbols.test(text)) {
        mathPages.add(idx + 1);
      }
    });

    return Array.from(mathPages).sort((a, b) => a - b);
  },

  // Claude Vision for math bounding boxes (only flagged pages)
  async getMathBoundingBoxes(pageImages: Buffer[], pageNumbers: number[]): Promise<Array<{ page: number; regions: Array<{ x: number; y: number; w: number; h: number }> }>> {
    if (!anthropic) throw new Error('Anthropic not configured');

    const results: Array<{ page: number; regions: Array<{ x: number; y: number; w: number; h: number }> }> = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < pageImages.length; i += BATCH_SIZE) {
      const batch = pageImages.slice(i, i + BATCH_SIZE);
      const batchPageNums = pageNumbers.slice(i, i + BATCH_SIZE);

      const content: Anthropic.MessageCreateParams['messages'][0]['content'] = [];

      for (let j = 0; j < batch.length; j++) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: batch[j].toString('base64') },
        });
        content.push({
          type: 'text',
          text: `Page ${batchPageNums[j]}: Identify all mathematical formula regions. Return bounding boxes as {x, y, w, h} in pixel coordinates.`,
        });
      }

      const response = await anthropic.messages.create({
        model: SONNET_MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content }],
        system: 'You are a math region detector. For each page image, return a JSON array of bounding boxes {page, regions: [{x, y, w, h}]} for mathematical formulas. Respond only with JSON.',
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          console.error(
            `[ai.service] getMathBoundingBoxes: no JSON array in Claude response for pages ${batchPageNums.join(',')}. Raw (first 500ch): ${text.slice(0, 500)}`,
          );
          continue;
        }
        results.push(...JSON.parse(jsonMatch[0]));
      } catch (err) {
        console.error(
          `[ai.service] getMathBoundingBoxes: JSON.parse failed for pages ${batchPageNums.join(',')}: ${err instanceof Error ? err.message : String(err)}. Raw (first 500ch): ${text.slice(0, 500)}`,
        );
      }
    }

    return results;
  },

  // Vision OCR — extract text from a page image
  async ocrPageImage(
    base64Image: string,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    if (!anthropic) throw new Error('Anthropic not configured');

    const response = await anthropic.messages.create(
      {
        model: SONNET_MODEL,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: base64Image },
            },
            {
              type: 'text',
              text: 'Extract ALL text from this page image. Preserve paragraph structure. For mathematical formulas, use LaTeX notation wrapped in $...$ for inline or $$...$$ for display math. Return ONLY the extracted text, nothing else.',
            },
          ],
        }],
      },
      { signal: options?.signal },
    );

    return response.content[0].type === 'text' ? response.content[0].text : '';
  },

  // Batch OCR — multiple pages at once
  async ocrPages(
    base64Images: string[],
    options?: { signal?: AbortSignal },
  ): Promise<string[]> {
    const results: string[] = [];
    for (const img of base64Images) {
      // Stop the queue between iterations if the client already disconnected,
      // so a 12-page batch doesn't bill 11 wasted Sonnet calls after abort.
      if (options?.signal?.aborted) break;
      const text = await this.ocrPageImage(img, { signal: options?.signal });
      results.push(text);
    }
    return results;
  },

  // AI proxy methods
  async wordContext(word: string, sentence: string, bookContext?: string): Promise<{ definition: string; translation?: string; explanation: string }> {
    if (!anthropic) throw new Error('Anthropic not configured');

    const response = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Given the word "${word}" in the sentence: "${sentence}"${bookContext ? ` (from: ${bookContext})` : ''}\n\nProvide:\n1. A clear definition in context\n2. A brief explanation of how it's used here\n\nRespond as JSON: { "definition": "...", "explanation": "..." }`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(
        `[ai.service] wordContext: no JSON object in Claude response for word "${word}". Raw (first 500ch): ${text.slice(0, 500)}`,
      );
      throw Errors.aiError('AI response was not valid JSON');
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.error(
        `[ai.service] wordContext: JSON.parse failed for word "${word}": ${err instanceof Error ? err.message : String(err)}. Raw (first 500ch): ${text.slice(0, 500)}`,
      );
      throw Errors.aiError('AI response was not valid JSON');
    }
  },

  async translate(text: string, targetLanguage: string): Promise<string> {
    if (!anthropic) throw new Error('Anthropic not configured');

    const response = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Translate the following text to ${targetLanguage}. Return only the translation, nothing else.\n\n${text}`,
      }],
    });

    return response.content[0].type === 'text' ? response.content[0].text : '';
  },

  async explain(text: string, bookContext?: string): Promise<string> {
    if (!anthropic) throw new Error('Anthropic not configured');

    const response = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Explain the following text in simple terms${bookContext ? ` (context: ${bookContext})` : ''}:\n\n${text}`,
      }],
    });

    return response.content[0].type === 'text' ? response.content[0].text : '';
  },

  // ─── Reader-side translation / explanation endpoints ─────────────
  // These match the prompts that used to live in the frontend's
  // translation-service.ts, so the client no longer needs its own
  // Anthropic key for word lookups.

  async translateWord(
    word: string,
    sentence: string,
    targetLanguage: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ pronunciation: string; translation: string; partOfSpeech: string }> {
    if (!anthropic) throw new Error('Anthropic not configured');
    const prompt = `You are a precise dictionary/translator. Given an English word and the sentence it appears in, provide:
1. The romanized pronunciation of the ENGLISH word (IPA format, e.g. /deɪ/ for "day")
2. A single, contextually accurate ${targetLanguage} translation — just ONE word or very short phrase, not multiple definitions
3. The part of speech (n., v., adj., adv., prep., conj., etc.)

Word: "${word}"
Sentence: "${sentence}"

Respond in this exact JSON format only, no other text:
{"pronunciation": "/.../ ", "translation": "...", "partOfSpeech": "..."}`;

    const response = await anthropic.messages.create(
      {
        model: HAIKU_MODEL,
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: options?.signal },
    );

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error(
        `[ai.service] translateWord: no JSON object in Claude response for word "${word}" (target ${targetLanguage}). Raw (first 500ch): ${text.slice(0, 500)}`,
      );
      throw Errors.aiError('AI translation response was not valid JSON');
    }
    try {
      const parsed = JSON.parse(match[0]);
      return {
        pronunciation: parsed.pronunciation ?? '',
        translation: parsed.translation ?? '',
        partOfSpeech: parsed.partOfSpeech ?? '',
      };
    } catch (err) {
      console.error(
        `[ai.service] translateWord: JSON.parse failed for word "${word}" (target ${targetLanguage}): ${err instanceof Error ? err.message : String(err)}. Raw (first 500ch): ${text.slice(0, 500)}`,
      );
      throw Errors.aiError('AI translation response was not valid JSON');
    }
  },

  async translateSentence(
    sentence: string,
    paragraphContext: string,
    targetLanguage: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ translation: string }> {
    if (!anthropic) throw new Error('Anthropic not configured');
    const prompt = `Translate the following English sentence into ${targetLanguage}. Use the surrounding paragraph for context to ensure accuracy. Return ONLY the translated sentence, nothing else.

Sentence: "${sentence}"

Paragraph context: "${paragraphContext}"`;

    const response = await anthropic.messages.create(
      {
        model: HAIKU_MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: options?.signal },
    );
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return { translation: text.trim().replace(/^["']|["']$/g, '') };
  },

  async explainTranslation(
    word: string,
    sentence: string,
    translation: string,
    targetLanguage: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ explanation: string }> {
    if (!anthropic) throw new Error('Anthropic not configured');
    const prompt = `Explain briefly (under 100 words) why the English word "${word}" is translated as "${translation}" in ${targetLanguage}, given the sentence: "${sentence}". Focus on how the sentence context determines this specific meaning. Be concise and direct.`;

    const response = await anthropic.messages.create(
      {
        model: HAIKU_MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: options?.signal },
    );
    return { explanation: response.content[0].type === 'text' ? response.content[0].text : '' };
  },

  async explainContent(
    content: string,
    surroundingContext: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ explanation: string }> {
    if (!anthropic) throw new Error('Anthropic not configured');
    const prompt = `Explain the following content clearly and concisely. What does it mean, what is it showing, and how does it relate to the surrounding context?

Content:
${content}

Surrounding context:
${surroundingContext}

Give a clear explanation in English. If it's a table, explain what the data represents. If it's code, explain the algorithm. If it's a formula, explain what each variable means. Be thorough but concise.`;

    const response = await anthropic.messages.create(
      {
        model: HAIKU_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: options?.signal },
    );
    return { explanation: response.content[0].type === 'text' ? response.content[0].text : '' };
  },
};
