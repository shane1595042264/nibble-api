import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';

const anthropic = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `Analyze these pages:\n\n${pagesText}`,
        }],
      });

      try {
        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as PageAnalysis[];
          results.push(...parsed);
        }
      } catch {
        // If parsing fails, create basic entries
        for (const pageNum of pageNumbers) {
          results.push({ page: pageNum, blocks: [{ type: 'body', startLine: 0, endLine: 999, hasMath: false }] });
        }
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content }],
        system: 'You are a math region detector. For each page image, return a JSON array of bounding boxes {page, regions: [{x, y, w, h}]} for mathematical formulas. Respond only with JSON.',
      });

      try {
        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          results.push(...JSON.parse(jsonMatch[0]));
        }
      } catch {
        // Skip on parse failure
      }
    }

    return results;
  },

  // AI proxy methods
  async wordContext(word: string, sentence: string, bookContext?: string): Promise<{ definition: string; translation?: string; explanation: string }> {
    if (!anthropic) throw new Error('Anthropic not configured');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Given the word "${word}" in the sentence: "${sentence}"${bookContext ? ` (from: ${bookContext})` : ''}\n\nProvide:\n1. A clear definition in context\n2. A brief explanation of how it's used here\n\nRespond as JSON: { "definition": "...", "explanation": "..." }`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { definition: text, explanation: '' };
    } catch {
      return { definition: text, explanation: '' };
    }
  },

  async translate(text: string, targetLanguage: string): Promise<string> {
    if (!anthropic) throw new Error('Anthropic not configured');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Explain the following text in simple terms${bookContext ? ` (context: ${bookContext})` : ''}:\n\n${text}`,
      }],
    });

    return response.content[0].type === 'text' ? response.content[0].text : '';
  },
};
