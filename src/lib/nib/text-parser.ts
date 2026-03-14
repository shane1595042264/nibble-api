/**
 * NibTextParser — parses plain text (from AI/OCR extraction) into .nib structure.
 *
 * Unlike NibParser which works with rich PDF text items (positions, fonts),
 * this handles the common case of scanned PDFs where text comes from OCR/AI
 * as a flat string. It uses heuristic patterns to detect:
 *  • Headers (numbered sections like "1.1 Title", "CHAPTER N", uppercase lines)
 *  • Paragraphs (double newlines, or single newlines with indentation changes)
 *  • Footnotes (lines starting with superscript numbers at end of text)
 *  • Page breaks (form feeds, "---", or page number patterns)
 *  • Sentence boundaries (with abbreviation awareness)
 *  • Word tokenization
 */

import type {
  NibBlockType,
  NibDocumentData,
  NibPageData,
  NibParagraphData,
  NibSentenceData,
  NibWordData,
  NibHeaderData,
  NibFootnoteData,
  NibListItemData,
  NibFigureData,
} from './models.js'

// ─── Configuration ───────────────────────────────────────────────────────────

export interface NibTextParserConfig {
  /**
   * Regex patterns for lines that are headers/section titles.
   * Matched against trimmed lines.
   */
  headerPatterns?: RegExp[]

  /**
   * Regex patterns for footnote lines.
   */
  footnotePatterns?: RegExp[]

  /**
   * Regex patterns for list item lines (bullets, numbered lists).
   */
  listItemPatterns?: RegExp[]

  /**
   * Regex patterns for blockquote lines (indented quotes, epigraphs).
   */
  blockquotePatterns?: RegExp[]

  /**
   * Regex patterns for figure/table captions.
   */
  figureCaptionPatterns?: RegExp[]

  /**
   * Patterns that indicate "junk" lines to strip out
   * (page numbers in the text, running headers baked into extracted text)
   */
  junkPatterns?: RegExp[]

  /**
   * Page number for the resulting single-page NibPage (since we often
   * don't know the actual page number from flat text).
   */
  defaultPageNumber?: number
}

const DEFAULT_CONFIG: Required<NibTextParserConfig> = {
  headerPatterns: [
    /^(chapter|part|section)\s+[\divxlc]+/i,
    /^\d+\s+(chapter|part|section)/i,
    /^(\d+\.)+\d*\s+\S/,                         // "1.1 What Is a Design Pattern?"
    /^[IVXLC]+\.\s/,                              // "IV. Something"
    /^\d+\s+[A-Z][A-Z\s]{4,}$/,                   // "2 INTRODUCTION CHAPTER 1"
    /^[A-Z][A-Z\s]{10,}$/,                         // All-caps lines of 10+ chars
  ],
  footnotePatterns: [
    /^(\d+|[*†‡§¶]|\(\d+\))\s+\S/,               // Lines starting with footnote markers
  ],
  listItemPatterns: [
    /^\s*[\u2022\u2023\u25E6\u2043\u2219•·-]\s+/,   // Bullet points (•, ‣, ◦, ⁃, etc.)
    /^\s*\d+[.)\]]\s+/,                           // Numbered lists: "1." , "2)" , "3]"
    /^\s*\([a-z\d]+\)\s+/i,                       // "(a)" or "(1)" style
    /^\s*[a-z][.)\]]\s+/,                         // "a." or "b)" style
  ],
  blockquotePatterns: [
    /^\s{4,}/,                                     // Deeply indented lines (4+ spaces)
    /^["\u201C]/,                                   // Lines starting with opening quote
    /^—\s*[A-Z]/,                                  // Attribution lines: "— Author"
  ],
  figureCaptionPatterns: [
    /^(figure|fig\.|table|diagram|chart)\s+\d/i,   // "Figure 1.1", "Table 2"
  ],
  junkPatterns: [
    /^\d+\s*$/,                                    // Standalone page numbers
    /^[-–—]\s*\d+\s*[-–—]$/,                       // Dashed page numbers
    /^page\s+\d+/i,
    /^\d+\s+[A-Z][A-Z\s]+[A-Z]\s+\d+$/,            // Running headers like "2 INTRODUCTION CHAPTER 1"
  ],
  defaultPageNumber: 1,
}

// ─── Sentence splitting (shared logic) ───────────────────────────────────────

function splitSentences(text: string): string[] {
  const abbrevs = '(?<!Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|Inc|Ltd|Corp|St|Ave|approx|ca|cf|e\\.g|i\\.e|al)'
  const regex = new RegExp(`${abbrevs}([.!?])\\s+(?=[A-Z""\u201C])`, 'g')

  const sentences: string[] = []
  let lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const end = match.index + match[1].length
    sentences.push(text.slice(lastIndex, end).trim())
    lastIndex = end + match[0].length - match[1].length
  }

  const remaining = text.slice(lastIndex).trim()
  if (remaining) sentences.push(remaining)

  return sentences.length > 0 ? sentences : [text]
}

function tokenizeWords(sentence: string): string[] {
  return sentence.split(/\s+/).filter(w => w.length > 0)
}

// ─── Main Text Parser ────────────────────────────────────────────────────────

export class NibTextParser {
  private config: Required<NibTextParserConfig>

  constructor(config?: NibTextParserConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Parse a flat extracted text string into a NibDocumentData.
   * Optionally accepts startPage/endPage if the text spans known pages.
   */
  parseText(
    text: string,
    title: string,
    author: string,
    pageNumber?: number,
  ): NibDocumentData {
    const page = this.parseTextToPage(text, pageNumber ?? this.config.defaultPageNumber)
    return {
      version: 1,
      sourceTitle: title,
      sourceAuthor: author,
      pages: [page],
      createdAt: Date.now(),
    }
  }

  /**
   * Parse text that may span multiple pages (separated by page markers).
   * Uses double-newline or form-feed as page boundaries if present.
   */
  parseMultiPageText(
    text: string,
    title: string,
    author: string,
    startPage: number,
  ): NibDocumentData {
    // Split on common page separators
    const pageTexts = text.split(/\n{3,}|\f/)
      .map(t => t.trim())
      .filter(t => t.length > 0)

    const pages = pageTexts.map((pageText, i) =>
      this.parseTextToPage(pageText, startPage + i)
    )

    return {
      version: 1,
      sourceTitle: title,
      sourceAuthor: author,
      pages: pages.length > 0 ? pages : [this.parseTextToPage(text, startPage)],
      createdAt: Date.now(),
    }
  }

  /**
   * Parse a single page's text into a NibPageData.
   */
  private parseTextToPage(text: string, pageNumber: number): NibPageData {
    const lines = text.split('\n').map(l => l.trimEnd())

    // Classify each line
    const headers: NibHeaderData[] = []
    const footnotes: NibFootnoteData[] = []
    const listItems: NibListItemData[] = []
    const figures: NibFigureData[] = []
    const bodyLines: { text: string; blockType: NibBlockType }[] = []
    let firstHeaderSeen = false

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) {
        bodyLines.push({ text: '', blockType: 'body' }) // preserve blank lines for paragraph detection
        continue
      }

      // Check if it's junk (page numbers, running headers)
      if (this.isJunk(trimmed)) continue

      // Check if it's a header
      if (this.isHeader(trimmed)) {
        headers.push(this.classifyHeader(trimmed))
        firstHeaderSeen = true
        continue
      }

      // Check if it's a figure/table caption
      const figureCaption = this.parseFigureCaption(trimmed)
      if (figureCaption) {
        figures.push(figureCaption)
        continue
      }

      // Check if it's a list item
      const listItem = this.parseListItem(line)
      if (listItem) {
        listItems.push(listItem)
        continue
      }

      // Check if it's a footnote
      const footnote = this.parseFootnote(trimmed)
      if (footnote) {
        footnotes.push(footnote)
        continue
      }

      // Check if it's a sub-heading (short title-like line within body text)
      if (firstHeaderSeen && this.isSubheading(trimmed)) {
        bodyLines.push({ text: '', blockType: 'body' }) // paragraph break before
        bodyLines.push({ text: trimmed, blockType: 'subheading' })
        bodyLines.push({ text: '', blockType: 'body' }) // paragraph break after
        continue
      }

      // Check if it's a blockquote
      const blockType: NibBlockType = this.isBlockquote(line) ? 'blockquote'
        : !firstHeaderSeen ? 'introduction'
        : 'body'

      bodyLines.push({ text: trimmed, blockType })
    }

    // Split body lines into paragraphs (blank lines separate paragraphs)
    const paragraphs = this.splitIntoParagraphs(bodyLines)

    return {
      pageNumber,
      header: headers.length > 0 ? {
        text: headers.map(h => h.text).join(' | '),
        level: Math.min(...headers.map(h => h.level)),
      } : null,
      footer: null,
      footnotes,
      paragraphs,
      figures,
      listItems,
    }
  }

  private isJunk(line: string): boolean {
    return this.config.junkPatterns.some(p => p.test(line))
  }

  private isHeader(line: string): boolean {
    return this.config.headerPatterns.some(p => p.test(line))
  }

  private classifyHeader(line: string): NibHeaderData {
    // Determine heading level
    let level = 2 // default

    // "CHAPTER X" or all-caps → level 1
    if (/^(chapter|part)\s/i.test(line) || /^[A-Z][A-Z\s]{10,}$/.test(line)) {
      level = 1
    }
    // "1.1.1 Title" → level 3
    if (/^(\d+\.){2,}\d*\s/.test(line)) {
      level = 3
    }
    // "1.1 Title" → level 2
    else if (/^(\d+\.)\d+\s/.test(line)) {
      level = 2
    }
    // "1 Title" → level 1
    else if (/^\d+\s+[A-Z]/.test(line)) {
      level = 1
    }

    return { text: line.trim(), level }
  }

  private parseFootnote(line: string): NibFootnoteData | null {
    for (const pattern of this.config.footnotePatterns) {
      const match = line.match(pattern)
      if (match) {
        const marker = match[1] || match[0].charAt(0)
        const text = line.slice(match[0].length).trim() || line
        return { marker, text }
      }
    }
    return null
  }

  private parseListItem(line: string): NibListItemData | null {
    for (const pattern of this.config.listItemPatterns) {
      const match = line.match(pattern)
      if (match) {
        // Count leading whitespace for nesting depth
        const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0
        const depth = Math.floor(leadingSpaces / 2)
        const marker = match[0].trim()
        const text = line.slice(match[0].length).trim()
        return { marker, text, depth }
      }
    }
    return null
  }

  private parseFigureCaption(line: string): NibFigureData | null {
    for (const pattern of this.config.figureCaptionPatterns) {
      const match = line.match(pattern)
      if (match) {
        // Extract label ("Figure 1.1") and caption (rest of line)
        const labelMatch = line.match(/^((?:figure|fig\.|table|diagram|chart)\s+\d+(?:\.\d+)?)/i)
        const label = labelMatch ? labelMatch[1] : match[0]
        const caption = line.slice(label.length).replace(/^[.:;,]?\s*/, '').trim()
        return { label, caption: caption || line }
      }
    }
    return null
  }

  /**
   * Detect sub-headings: short title-like lines within body text.
   * e.g. "Finding Appropriate Objects", "Delegation", "Toolkits"
   * Criteria:
   *  - 3-80 characters (not too short, not too long)
   *  - Starts with a capital letter
   *  - Does NOT end with a period, comma, colon, or semicolon (not a sentence)
   *  - Does NOT look like a standalone number or page reference
   *  - Has at least 1 word, but no more than ~10 words
   */
  private isSubheading(line: string): boolean {
    if (line.length < 3 || line.length > 80) return false
    if (!/^[A-Z]/.test(line)) return false
    if (/[.,;:]$/.test(line)) return false
    if (/^\d+$/.test(line)) return false
    const words = line.split(/\s+/)
    if (words.length < 1 || words.length > 10) return false
    // Must have at least one capitalized word (title-case heuristic)
    const capitalizedWords = words.filter(w => /^[A-Z]/.test(w))
    if (capitalizedWords.length < words.length * 0.4) return false
    // Should not contain parenthetical references like "(325)"
    if (/\(\d+\)/.test(line)) return false
    return true
  }

  private isBlockquote(line: string): boolean {
    return this.config.blockquotePatterns.some(p => p.test(line))
  }

  private splitIntoParagraphs(lines: { text: string; blockType: NibBlockType }[]): NibParagraphData[] {
    const paragraphs: NibParagraphData[] = []
    let currentLines: string[] = []
    let currentBlockType: NibBlockType = 'body'

    const flushParagraph = () => {
      if (currentLines.length > 0) {
        paragraphs.push(this.buildParagraph(currentLines.join(' '), paragraphs.length, currentBlockType))
        currentLines = []
      }
    }

    for (const { text: line, blockType } of lines) {
      if (line === '') {
        // Blank line → paragraph boundary
        flushParagraph()
      } else {
        // If block type changes, flush and start new paragraph
        if (currentLines.length > 0 && blockType !== currentBlockType) {
          flushParagraph()
        }
        currentBlockType = blockType
        currentLines.push(line)
      }
    }

    // Don't forget remaining lines
    flushParagraph()

    return paragraphs
  }

  private buildParagraph(text: string, index: number, blockType: NibBlockType = 'body'): NibParagraphData {
    // Clean up double spaces
    const cleanText = text.replace(/\s+/g, ' ').trim()

    const sentenceTexts = splitSentences(cleanText)
    const sentences: NibSentenceData[] = sentenceTexts.map((sentText, sIdx) => {
      const wordTexts = tokenizeWords(sentText)
      const words: NibWordData[] = wordTexts.map((w, wIdx) => ({
        text: w,
        index: wIdx,
      }))
      return { words, index: sIdx }
    })

    return { sentences, index, blockType: blockType !== 'body' ? blockType : undefined }
  }
}
