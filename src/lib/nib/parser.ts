/**
 * NibParser — converts raw PDF text content into structured .nib documents.
 *
 * Handles:
 *  • Header detection   (top-of-page, larger/bold fonts, short lines matching patterns)
 *  • Footer detection   (bottom-of-page, page numbers, running titles)
 *  • Footnote detection (small font, bottom region, numbered/symbol markers)
 *  • Paragraph splitting (vertical gaps between text blocks)
 *  • Sentence splitting  (period/question/exclamation + space + capital letter)
 *  • Word tokenization   (whitespace splitting with punctuation handling)
 *  • Hyphenation repair  (re-joining words split across line breaks)
 */

import type {
  NibDocumentData,
  NibPageData,
  NibParagraphData,
  NibSentenceData,
  NibWordData,
  NibHeaderData,
  NibFooterData,
  NibFootnoteData,
  NibFigureData,
  NibPdfRect,
} from './models.js'

// ─── Types for raw PDF text items (from pdfjs textContent.items) ─────────────

export interface RawTextItem {
  /** The text string */
  str: string
  /** Transformation matrix [scaleX, skewX, skewY, scaleY, translateX, translateY] */
  transform: number[]
  /** Width of the text item in PDF units */
  width: number
  /** Height of the text item (approximates font size) */
  height: number
  /** Font identifier */
  fontName: string
  /** Whether pdfjs detected this as ending a line */
  hasEOL: boolean
}

/** Region of an image detected on a PDF page via getOperatorList */
export interface RawImageRegion {
  x: number
  y: number
  width: number
  height: number
  /** Base64 data URL of the cropped image */
  imageSrc?: string
}

export interface RawPageData {
  pageNumber: number
  items: RawTextItem[]
  /** Page height in PDF units (for Y coordinate normalization) */
  pageHeight: number
  /** Page width in PDF units */
  pageWidth: number
  /** Image regions detected on this page */
  images?: RawImageRegion[]
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface NibParserConfig {
  /**
   * Vertical gap (as fraction of median line height) that separates paragraphs.
   * Default: 1.5 — a gap 1.5× the normal line spacing starts a new paragraph.
   */
  paragraphGapFactor?: number

  /**
   * Fraction of page height from top considered the header region.
   * Default: 0.08 (top 8% of page)
   */
  headerRegionFraction?: number

  /**
   * Fraction of page height from bottom considered the footer region.
   * Default: 0.08 (bottom 8% of page)
   */
  footerRegionFraction?: number

  /**
   * Minimum font size ratio (relative to median body font) to classify as a heading.
   * Default: 1.15 — text 15% larger than body text is likely a heading.
   */
  headingFontSizeRatio?: number

  /**
   * Maximum font size ratio (relative to median body font) to classify as footnote text.
   * Default: 0.85 — text 15% smaller than body text may be a footnote.
   */
  footnoteFontSizeRatio?: number

  /**
   * Regex patterns for header lines (e.g., "CHAPTER 1", "Part II", page-number-only lines).
   * These are tested against the joined text of short top-region lines.
   */
  headerPatterns?: RegExp[]

  /**
   * Regex patterns for footer lines (e.g., standalone page numbers).
   */
  footerPatterns?: RegExp[]
}

const DEFAULT_CONFIG: Required<NibParserConfig> = {
  paragraphGapFactor: 1.5,
  headerRegionFraction: 0.1,
  footerRegionFraction: 0.1,
  headingFontSizeRatio: 1.15,
  footnoteFontSizeRatio: 0.85,
  headerPatterns: [
    /^(chapter|part|section)\s+[\divxlc]+/i,
    /^\d+\s+(chapter|part|section)/i,
    /^[IVXLC]+\.\s/,                           // Roman numeral headings
    /^\d+(?:\.\d+)+\s+\S/,                       // Numbered headings like "1.1 Title" (requires multi-level)
    /^\d+\s+[A-Z][A-Z\s\d]+$/,                  // "14  INTRODUCTION  CHAPTER 1" (page# + ALL-CAPS)
    /^[A-Z][A-Z\s]{10,}\d*$/,                   // ALL-CAPS running title, optional trailing page#
  ],
  footerPatterns: [
    /^\d+$/,                                     // Standalone page number
    /^[-–—]\s*\d+\s*[-–—]$/,                     // Dashed page number
    /^page\s+\d+/i,
  ],
}

// ─── Internal helpers ────────────────────────────────────────────────────────

interface TextLine {
  items: RawTextItem[]
  /** Y position (top of line, normalized so 0 = top of page) */
  y: number
  /** Average font height of items on this line */
  avgHeight: number
  /** Joined text */
  text: string
}

/**
 * Group raw text items into lines based on Y-position proximity.
 * Items within ±half a line height of each other are grouped.
 */
function groupIntoLines(items: RawTextItem[], pageHeight: number): TextLine[] {
  if (items.length === 0) return []

  // PDF Y coordinates: 0 = bottom of page. We flip to 0 = top.
  const withY = items.map(item => ({
    item,
    y: pageHeight - item.transform[5], // flip Y
  }))

  // Sort by Y (top to bottom), then X (left to right)
  withY.sort((a, b) => a.y - b.y || a.item.transform[4] - b.item.transform[4])

  const lines: TextLine[] = []
  let currentLineItems: RawTextItem[] = [withY[0].item]
  let currentY = withY[0].y

  for (let i = 1; i < withY.length; i++) {
    const { item, y } = withY[i]
    const lineHeight = Math.max(item.height, currentLineItems[0]?.height ?? 10)
    // If this item is on roughly the same Y level, add to current line
    if (Math.abs(y - currentY) < lineHeight * 0.5) {
      currentLineItems.push(item)
    } else {
      // Emit the current line
      lines.push(buildLine(currentLineItems, currentY))
      currentLineItems = [item]
      currentY = y
    }
  }
  if (currentLineItems.length > 0) {
    lines.push(buildLine(currentLineItems, currentY))
  }

  return lines
}

function buildLine(items: RawTextItem[], y: number): TextLine {
  // Sort items left-to-right by X position
  items.sort((a, b) => a.transform[4] - b.transform[4])
  const avgHeight = items.reduce((sum, it) => sum + it.height, 0) / items.length
  const text = items.map(it => it.str).join(' ').trim()
  return { items, y, avgHeight, text }
}

/**
 * Compute the median of a number array.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ─── Sentence splitting ─────────────────────────────────────────────────────

/**
 * Split a paragraph text into sentences.
 * Handles abbreviations (Mr., Dr., etc.) and decimal numbers.
 */
function splitSentences(text: string): string[] {
  // Sentence-ending punctuation followed by space(s) and a capital letter or end of string
  // Negative lookbehind for common abbreviations
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

  // Remaining text is the last sentence
  const remaining = text.slice(lastIndex).trim()
  if (remaining) sentences.push(remaining)

  return sentences.length > 0 ? sentences : [text]
}

/**
 * Tokenize a sentence into words.
 * Keeps punctuation attached to words (e.g. "hello," → "hello,").
 */
function tokenizeWords(sentence: string): string[] {
  return sentence.split(/\s+/).filter(w => w.length > 0)
}

// ─── Main Parser ─────────────────────────────────────────────────────────────

export class NibParser {
  private config: Required<NibParserConfig>

  constructor(config?: NibParserConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Parse a full document (multiple pages of raw PDF data) into a NibDocumentData.
   */
  parseDocument(
    pages: RawPageData[],
    title: string,
    author: string,
  ): NibDocumentData {
    const parsedPages = pages.map(p => this.parsePage(p))
    this.mergeCrossPageParagraphs(parsedPages)
    return {
      version: 1,
      sourceTitle: title,
      sourceAuthor: author,
      pages: parsedPages,
      createdAt: Date.now(),
    }
  }

  /**
   * Parse a single page of raw text items.
   */
  parsePage(raw: RawPageData): NibPageData {
    const lines = groupIntoLines(raw.items, raw.pageHeight)
    if (lines.length === 0) {
      return {
        pageNumber: raw.pageNumber,
        header: null,
        footer: null,
        footnotes: [],
        paragraphs: [],
        figures: [],
        listItems: [],
      }
    }

    // ── Compute page-level statistics ──
    const allHeights = lines.map(l => l.avgHeight)
    const medianHeight = median(allHeights)
    const headerCutoff = raw.pageHeight * this.config.headerRegionFraction
    const footerCutoff = raw.pageHeight * (1 - this.config.footerRegionFraction)

    // Determine the dominant body font from middle-region lines
    // Running headers/footers often use a different font family (e.g., Arial vs Times)
    const middleLines = lines.filter(l => l.y > headerCutoff && l.y < footerCutoff)
    const fontCounts = new Map<string, number>()
    for (const line of middleLines) {
      for (const item of line.items) {
        if (item.fontName) {
          fontCounts.set(item.fontName, (fontCounts.get(item.fontName) ?? 0) + item.str.length)
        }
      }
    }
    let dominantFont = ''
    let maxCount = 0
    for (const [font, count] of fontCounts) {
      if (count > maxCount) { dominantFont = font; maxCount = count }
    }

    // ── Detect header ──
    const header = this.detectHeader(lines, medianHeight, headerCutoff)

    // ── Detect footer ──
    const footer = this.detectFooter(lines, medianHeight, footerCutoff, raw.pageHeight)

    // ── Detect footnotes ──
    const footnotes = this.detectFootnotes(lines, medianHeight, footerCutoff, raw.pageHeight)

    // ── Determine which lines are body text ──
    const headerLines = new Set<TextLine>()
    const footerLines = new Set<TextLine>()
    const footnoteLines = new Set<TextLine>()

    // Header region: lines matching header patterns or using a non-body font
    for (const line of lines) {
      if (line.y < headerCutoff) {
        if (this.isHeaderLine(line, medianHeight)) {
          headerLines.add(line)
        } else if (dominantFont && line.items.length > 0 &&
          line.items.every(i => i.fontName !== dominantFont) && line.text.length < 100) {
          // Short line in header region using a different font — running header
          headerLines.add(line)
        }
      }
    }

    // Footer region: lines matching footer patterns or using a non-body font
    for (const line of lines) {
      if (line.y > footerCutoff) {
        if (this.isFooterLine(line, medianHeight)) {
          footerLines.add(line)
        } else if (dominantFont && line.items.length > 0 &&
          line.items.every(i => i.fontName !== dominantFont) && line.text.length < 100) {
          // Short line in footer region using a different font — running footer
          footerLines.add(line)
        }
      }
    }

    if (footnotes.length > 0) {
      for (const line of lines) {
        if (line.y > footerCutoff && line.avgHeight < medianHeight * this.config.footnoteFontSizeRatio) {
          footnoteLines.add(line)
        }
      }
    }

    // Construct header/footer data from detected lines
    const finalHeaderLines = [...headerLines]
    const finalHeader: NibHeaderData | null = finalHeaderLines.length > 0
      ? { text: finalHeaderLines.map(l => l.text).join(' ').trim(), level: header?.level ?? 2 }
      : header
    const finalFooterLines = [...footerLines].filter(l => !footnoteLines.has(l))
    const finalFooter: NibFooterData | null = finalFooterLines.length > 0
      ? { text: finalFooterLines.map(l => l.text).join(' ').trim() }
      : footer

    // ── Detect figures from image regions ──
    const figureAssociatedLines = new Set<TextLine>()
    const figures: NibFigureData[] = []

    if (raw.images && raw.images.length > 0) {
      for (const image of raw.images) {
        // Find text lines spatially near this image (for label/caption)
        const associated = lines.filter(line =>
          !headerLines.has(line) && !footerLines.has(line) && !footnoteLines.has(line) &&
          this.isFigureAssociatedLine(image, line, raw.pageWidth)
        )

        // Extract label and caption from associated lines below the image
        let label = ''
        let caption = ''
        const sortedAssoc = [...associated].sort((a, b) => a.y - b.y)
        for (const line of sortedAssoc) {
          if (line.y >= image.y + image.height - 5) {
            const figMatch = line.text.match(/^(Figure\s+[\d.]+)[.:]\s*(.*)/i)
            if (figMatch) {
              label = figMatch[1]
              caption = figMatch[2] || ''
            } else if (label && !caption) {
              caption = line.text
            }
          }
        }

        // Mark associated lines so they don't appear as body paragraphs
        for (const line of associated) {
          figureAssociatedLines.add(line)
        }

        figures.push({
          label,
          caption,
          imageSrc: image.imageSrc,
          top: image.y,
        })
      }
    }

    const bodyLines = lines.filter(
      l => !headerLines.has(l) && !footerLines.has(l) && !footnoteLines.has(l) && !figureAssociatedLines.has(l)
    )

    // ── Detect additional headings within the body ──
    // Lines that are significantly larger than body text or match heading patterns.
    // These become blockType: 'subheading' paragraphs (NOT merged into page header).
    const inlineHeadingSet = new Set(this.detectInlineHeadings(bodyLines, medianHeight))

    // ── Split body lines into paragraphs, marking inline headings ──
    const paragraphs = this.splitIntoParagraphs(bodyLines, medianHeight, inlineHeadingSet, raw.pageNumber)

    return {
      pageNumber: raw.pageNumber,
      header: finalHeader,
      footer: finalFooter,
      footnotes,
      paragraphs,
      figures,
      listItems: [],
    }
  }

  // ─── Figure Association ────────────────────────────────────────────────────

  /**
   * Determine if a text line is spatially associated with a figure image.
   * Lines that are within the image bounds (with some margin) and are short
   * enough to be labels/captions are associated.
   */
  private isFigureAssociatedLine(image: RawImageRegion, line: TextLine, pageWidth: number): boolean {
    const lineLeft = Math.min(...line.items.map(i => i.transform[4]))
    const lineRight = Math.max(...line.items.map(i => i.transform[4] + i.width))
    const lineCenter = (lineLeft + lineRight) / 2
    const lineWidth = lineRight - lineLeft

    const regionLeft = image.x - 12
    const regionRight = image.x + image.width + 12
    const regionTop = image.y - 24
    const regionBottom = image.y + image.height + 30

    const horizontallyInside = lineLeft >= regionLeft && lineRight <= regionRight
    const verticallyInside = line.y >= regionTop && line.y <= regionBottom
    const shortLine = line.text.length <= 60 || lineWidth <= Math.min(image.width * 0.6, pageWidth * 0.3)

    return verticallyInside && horizontallyInside && lineCenter >= regionLeft && lineCenter <= regionRight && shortLine
  }

  // ─── Header Detection ──────────────────────────────────────────────────────

  private detectHeader(
    lines: TextLine[],
    medianHeight: number,
    headerCutoff: number,
  ): NibHeaderData | null {
    // Look at lines in the header region (top of page)
    const topLines = lines.filter(l => l.y < headerCutoff)
    if (topLines.length === 0) return null

    const headerTexts: string[] = []
    let maxLevel = 2 // default to section-level

    for (const line of topLines) {
      if (this.isHeaderLine(line, medianHeight)) {
        headerTexts.push(line.text)
        // Larger font → higher-level heading
        if (line.avgHeight > medianHeight * 1.3) maxLevel = 1
      }
    }

    if (headerTexts.length === 0) return null

    return {
      text: headerTexts.join(' ').trim(),
      level: maxLevel,
    }
  }

  private isHeaderLine(line: TextLine, medianHeight: number): boolean {
    // Check if the line matches a header pattern
    for (const pattern of this.config.headerPatterns) {
      if (pattern.test(line.text)) return true
    }
    // Check if font size is significantly larger
    if (line.avgHeight > medianHeight * this.config.headingFontSizeRatio) {
      // But only if it's reasonably short (headers aren't full paragraphs)
      if (line.text.length < 100) return true
    }
    return false
  }

  /**
   * Detect headings that appear within the body (not just top of page).
   * E.g., "1.1  What Is a Design Pattern?" appearing mid-page.
   */
  private detectInlineHeadings(
    bodyLines: TextLine[],
    medianHeight: number,
  ): TextLine[] {
    const headings: TextLine[] = []
    for (const line of bodyLines) {
      // Must be a short line with larger font
      if (line.text.length > 120) continue
      if (line.avgHeight > medianHeight * this.config.headingFontSizeRatio) {
        headings.push(line)
        continue
      }
      // Check heading patterns
      for (const pattern of this.config.headerPatterns) {
        if (pattern.test(line.text)) {
          headings.push(line)
          break
        }
      }
    }
    return headings
  }

  /**
   * Merge the page-top header with any inline headings detected in the body.
   */
  private mergeHeaders(
    topHeader: NibHeaderData | null,
    inlineHeadings: TextLine[],
    _lines: TextLine[],
    _headerCutoff: number,
    _medianHeight: number,
  ): NibHeaderData | null {
    if (!topHeader && inlineHeadings.length === 0) return null

    const parts: string[] = []
    if (topHeader) parts.push(topHeader.text)
    for (const h of inlineHeadings) parts.push(h.text)

    return {
      text: parts.join(' | '),
      level: topHeader?.level ?? 2,
    }
  }

  // ─── Footer Detection ──────────────────────────────────────────────────────

  private detectFooter(
    lines: TextLine[],
    medianHeight: number,
    footerCutoff: number,
    _pageHeight: number,
  ): NibFooterData | null {
    const bottomLines = lines.filter(l => l.y > footerCutoff)
    if (bottomLines.length === 0) return null

    const footerTexts: string[] = []
    for (const line of bottomLines) {
      if (this.isFooterLine(line, medianHeight)) {
        footerTexts.push(line.text)
      }
    }

    if (footerTexts.length === 0) return null

    return { text: footerTexts.join(' ').trim() }
  }

  private isFooterLine(line: TextLine, medianHeight: number): boolean {
    for (const pattern of this.config.footerPatterns) {
      if (pattern.test(line.text)) return true
    }
    // Running headers that appear at the bottom of the page (even/odd page running titles)
    // e.g., "12  INTRODUCTION  CHAPTER 1" or "SECTION 1.6 HOW DESIGN PATTERNS..."
    for (const pattern of this.config.headerPatterns) {
      if (pattern.test(line.text)) return true
    }
    // Small text at bottom that's very short (page number, running title)
    if (line.text.length < 80 && line.avgHeight <= medianHeight) return true
    return false
  }

  // ─── Footnote Detection ────────────────────────────────────────────────────

  private detectFootnotes(
    lines: TextLine[],
    medianHeight: number,
    footerCutoff: number,
    _pageHeight: number,
  ): NibFootnoteData[] {
    // Footnotes: smaller font, bottom region, often starting with a number/symbol
    const candidates = lines.filter(l =>
      l.y > footerCutoff * 0.85 && // a bit above the strict footer region
      l.avgHeight < medianHeight * this.config.footnoteFontSizeRatio
    )

    const footnotes: NibFootnoteData[] = []
    const footnotePattern = /^(\d+|[*†‡§¶]|\(\d+\))\s*(.+)/

    for (const line of candidates) {
      const match = line.text.match(footnotePattern)
      if (match) {
        footnotes.push({
          marker: match[1],
          text: match[2].trim(),
        })
      }
    }

    return footnotes
  }

  // ─── Paragraph Splitting ───────────────────────────────────────────────────

  private splitIntoParagraphs(
    lines: TextLine[],
    medianHeight: number,
    inlineHeadings?: Set<TextLine>,
    pageNumber: number = 1,
  ): NibParagraphData[] {
    if (lines.length === 0) return []

    const paragraphs: NibParagraphData[] = []
    let currentParagraphLines: TextLine[] = [lines[0]]

    // Compute median line spacing
    const lineGaps: number[] = []
    for (let i = 1; i < lines.length; i++) {
      lineGaps.push(lines[i].y - lines[i - 1].y)
    }
    const medianGap = lineGaps.length > 0 ? median(lineGaps) : medianHeight * 1.5
    const paragraphThreshold = medianGap * this.config.paragraphGapFactor

    const flushParagraph = () => {
      if (currentParagraphLines.length === 0) return
      const para = this.buildParagraph(currentParagraphLines, paragraphs.length, pageNumber)
      // Check if ALL lines in this paragraph are inline headings
      if (inlineHeadings && currentParagraphLines.every(l => inlineHeadings.has(l))) {
        para.blockType = 'subheading'
      }
      paragraphs.push(para)
      currentParagraphLines = []
    }

    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i].y - lines[i - 1].y
      const lineIsHeading = inlineHeadings?.has(lines[i])
      const prevIsHeading = inlineHeadings?.has(lines[i - 1])

      // Force paragraph break before/after inline headings
      if (lineIsHeading !== prevIsHeading || gap > paragraphThreshold) {
        flushParagraph()
        currentParagraphLines = [lines[i]]
      } else {
        currentParagraphLines.push(lines[i])
      }
    }

    // Don't forget the last paragraph
    flushParagraph()

    return paragraphs
  }

  /**
   * Merge paragraphs that were split across page boundaries.
   * If the last paragraph of page N ends mid-sentence (no terminal punctuation)
   * and the first paragraph of page N+1 starts with a lowercase letter,
   * merge them into one paragraph on page N.
   */
  private mergeCrossPageParagraphs(pages: NibPageData[]): void {
    for (let i = 0; i < pages.length - 1; i++) {
      const currentPage = pages[i]
      const nextPage = pages[i + 1]
      if (currentPage.paragraphs.length === 0 || nextPage.paragraphs.length === 0) continue

      const lastPara = currentPage.paragraphs[currentPage.paragraphs.length - 1]
      const firstParaNext = nextPage.paragraphs[0]

      // Skip if either paragraph is a special block type (subheading, figure-caption, etc.)
      if (lastPara.blockType && lastPara.blockType !== 'body') continue
      if (firstParaNext.blockType && firstParaNext.blockType !== 'body') continue

      // Get the full text of the last paragraph on the current page
      const lastParaText = lastPara.sentences
        .flatMap(s => s.words.map(w => w.text)).join(' ').trim()
      if (!lastParaText) continue

      // Get the first character of the next page's first paragraph
      const firstParaNextText = firstParaNext.sentences
        .flatMap(s => s.words.map(w => w.text)).join(' ').trim()
      if (!firstParaNextText) continue

      const lastChar = lastParaText[lastParaText.length - 1]
      const firstChar = firstParaNextText[0]

      // Merge if last paragraph doesn't end with sentence-ending punctuation
      // and next paragraph starts with a lowercase letter
      const endsWithTerminal = /[.!?:;"\u201D]$/.test(lastParaText)
      const startsWithLower = /^[a-z]/.test(firstChar)

      if (!endsWithTerminal && startsWithLower) {
        // Merge: append all sentences from the next page's first paragraph
        // into the current page's last paragraph
        lastPara.sentences.push(...firstParaNext.sentences)
        // Remove the first paragraph from the next page
        nextPage.paragraphs.shift()
        // Re-index remaining paragraphs on next page
        nextPage.paragraphs.forEach((p, idx) => { p.index = idx })
      }
    }
  }

  private buildParagraph(lines: TextLine[], index: number, pageNumber: number): NibParagraphData {
    // Build a list of spans from individual PDF items, preserving font style
    // AND source item position info for precise PDF highlight positioning.
    interface Span {
      text: string
      bold: boolean
      italic: boolean
      /** Source RawTextItem (null for synthetic separator spans) */
      sourceItem: RawTextItem | null
    }

    const spans: Span[] = []

    // Determine which font names are bold/italic — collect all font names first
    const allFontNames = new Set<string>()
    for (const line of lines) {
      for (const item of line.items) {
        if (item.fontName) allFontNames.add(item.fontName)
      }
    }
    const boldFontNames = new Set(
      [...allFontNames].filter(fn => /bold|black|heavy|demi/i.test(fn))
    )
    const italicFontNames = new Set(
      [...allFontNames].filter(fn => /italic|oblique/i.test(fn))
    )

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        // Check hyphenation: does previous span end with a hyphen?
        const lastSpan = spans[spans.length - 1]
        if (lastSpan && lastSpan.text.endsWith('-')) {
          lastSpan.text = lastSpan.text.slice(0, -1)
        } else {
          spans.push({ text: ' ', bold: false, italic: false, sourceItem: null })
        }
      }

      for (let j = 0; j < lines[i].items.length; j++) {
        const item = lines[i].items[j]
        const isBold = boldFontNames.has(item.fontName)
        const isItalic = italicFontNames.has(item.fontName)
        if (j > 0) spans.push({ text: ' ', bold: false, italic: false, sourceItem: null })
        spans.push({ text: item.str, bold: isBold, italic: isItalic, sourceItem: item })
      }
    }

    // Join all spans into full text, and build parallel arrays indexed by character position:
    // - style flags (bold/italic)
    // - source item reference + char offset within item (for pdfRect computation)
    const fullText = spans.map(s => s.text).join('').trim()
    const charBold: boolean[] = []
    const charItalic: boolean[] = []
    const charSourceItem: (RawTextItem | null)[] = []
    const charOffsetInItem: number[] = []
    for (const span of spans) {
      for (let c = 0; c < span.text.length; c++) {
        charBold.push(span.bold)
        charItalic.push(span.italic)
        charSourceItem.push(span.sourceItem)
        charOffsetInItem.push(c)
      }
    }
    // Trim may have removed leading whitespace; adjust flags accordingly
    const rawText = spans.map(s => s.text).join('')
    const leadingSpaces = rawText.length - rawText.trimStart().length
    const boldFlags = charBold.slice(leadingSpaces, leadingSpaces + fullText.length)
    const italicFlags = charItalic.slice(leadingSpaces, leadingSpaces + fullText.length)
    const sourceItems = charSourceItem.slice(leadingSpaces, leadingSpaces + fullText.length)
    const offsetsInItem = charOffsetInItem.slice(leadingSpaces, leadingSpaces + fullText.length)

    /**
     * Compute pdfRect for a word at character position `absPos` with length `len`.
     * Uses the source RawTextItem's transform matrix to get exact PDF coordinates.
     */
    const computePdfRect = (absPos: number, len: number): NibPdfRect | undefined => {
      if (absPos < 0 || absPos >= sourceItems.length) return undefined
      const item = sourceItems[absPos]
      if (!item) return undefined

      const charInItem = offsetsInItem[absPos]
      const itemCharCount = item.str.length || 1
      const charWidth = item.width / itemCharCount
      const wordWidth = charWidth * len

      return {
        pageNumber,
        x: item.transform[4] + charInItem * charWidth,
        y: item.transform[5],
        width: wordWidth,
        height: item.height || Math.abs(item.transform[3]),
      }
    }

    // Split into sentences
    const sentenceTexts = splitSentences(fullText)
    let charOffset = 0

    const sentences: NibSentenceData[] = sentenceTexts.map((sentText, sIdx) => {
      // Find where this sentence starts in fullText
      const sentStart = fullText.indexOf(sentText, charOffset)
      const sentOffset = sentStart >= 0 ? sentStart : charOffset

      const wordTexts = tokenizeWords(sentText)
      let wordCharOffset = 0

      const words: NibWordData[] = wordTexts.map((w, wIdx) => {
        // Find word position within sentence text
        const wordPos = sentText.indexOf(w, wordCharOffset)
        const absPos = sentOffset + (wordPos >= 0 ? wordPos : wordCharOffset)

        // A word is bold/italic if the majority of its characters have that style
        let boldCount = 0
        let italicCount = 0
        for (let c = 0; c < w.length; c++) {
          if (boldFlags[absPos + c]) boldCount++
          if (italicFlags[absPos + c]) italicCount++
        }
        const isBold = boldCount > w.length / 2
        const isItalic = italicCount > w.length / 2

        // Compute PDF bounding box from source item position
        const pdfRect = computePdfRect(absPos, w.length)

        wordCharOffset = (wordPos >= 0 ? wordPos : wordCharOffset) + w.length

        return {
          text: w,
          index: wIdx,
          bold: isBold || undefined,
          italic: isItalic || undefined,
          pdfRect,
        }
      })

      charOffset = sentOffset + sentText.length
      return { words, index: sIdx }
    })

    return { sentences, index }
  }
}
