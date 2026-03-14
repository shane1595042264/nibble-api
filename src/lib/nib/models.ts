/**
 * .nib (Natural Interactive Book) Format — Core Data Models
 *
 * A word-level document object model designed for interactive reading.
 * Every word knows its sentence, every sentence knows its paragraph,
 * and every paragraph knows its page. This enables context-aware AI
 * features like translation-in-context.
 *
 * Hierarchy:
 *   NibDocument
 *     └── NibPage[]
 *           ├── header?:    NibHeader
 *           ├── footer?:    NibFooter
 *           ├── footnotes:  NibFootnote[]
 *           └── paragraphs: NibParagraph[]
 *                 └── sentences: NibSentence[]
 *                       └── words: NibWord[]
 */

// ─── Serializable plain-data interfaces (storable as JSON / IndexedDB) ───────

/** Bounding box of a word in PDF user-space coordinates (from pdfjs transform matrix) */
export interface NibPdfRect {
  /** Source page number in the PDF (may differ from parent NibPage after cross-page paragraph merging) */
  pageNumber: number
  /** X position in PDF user-space (transform[4]) */
  x: number
  /** Y position in PDF user-space (transform[5], bottom-origin) */
  y: number
  /** Width in PDF units */
  width: number
  /** Height in PDF units (font size) */
  height: number
}

export interface NibWordData {
  text: string
  /** 0-based index within the parent sentence */
  index: number
  /** Whether this word was hyphenated across a line break in the source */
  wasHyphenated?: boolean
  /** Whether this word appeared in a bold font in the source PDF */
  bold?: boolean
  /** Whether this word appeared in an italic font in the source PDF */
  italic?: boolean
  /** Bounding box in PDF user-space, for precise highlight positioning */
  pdfRect?: NibPdfRect
}

export interface NibSentenceData {
  words: NibWordData[]
  /** 0-based index within the parent paragraph */
  index: number
}

/** Discriminator for different block-level element types */
export type NibBlockType =
  | 'body'            // Normal body text
  | 'introduction'    // Chapter/section intro text before the first sub-heading
  | 'subheading'      // Sub-heading within body text (e.g. "Finding Appropriate Objects")
  | 'blockquote'      // Quoted block
  | 'list-item'       // An item in a list
  | 'figure-caption'  // Caption for a figure/table
  | 'epigraph'        // Opening quote/attribution at chapter start

export interface NibParagraphData {
  sentences: NibSentenceData[]
  /** 0-based index within the parent page body */
  index: number
  /** Block-level element type. Defaults to 'body' if omitted. */
  blockType?: NibBlockType
}

export interface NibFigureData {
  /** Figure/table label (e.g. "Figure 1.1") */
  label: string
  /** Caption text */
  caption: string
  /** Base64 data URL of the figure image (if extracted from PDF) */
  imageSrc?: string
  /** Y position of the figure on the page (for ordering with paragraphs) */
  top?: number
}

export interface NibListItemData {
  /** Bullet or number marker (e.g. "•", "1.", "(a)") */
  marker: string
  /** Body text of the list item */
  text: string
  /** Nesting depth (0 = top level) */
  depth: number
}

export interface NibHeaderData {
  /** Raw text of the header region */
  text: string
  /** Detected level – 1 = chapter title, 2 = section heading, etc. */
  level: number
}

export interface NibFootnoteData {
  /** The footnote marker/number as it appears in the text (e.g. "1", "†") */
  marker: string
  /** Body text of the footnote */
  text: string
}

export interface NibFooterData {
  /** Raw text of the footer region (e.g. page numbers, running titles) */
  text: string
}

export interface NibPageData {
  /** 1-based page number from the source PDF */
  pageNumber: number
  header: NibHeaderData | null
  footer: NibFooterData | null
  footnotes: NibFootnoteData[]
  paragraphs: NibParagraphData[]
  figures: NibFigureData[]
  listItems: NibListItemData[]
}

export interface NibDocumentData {
  /** Format version for forward-compatibility */
  version: 1
  sourceTitle: string
  sourceAuthor: string
  pages: NibPageData[]
  createdAt: number
}

// ─── Live class wrappers (provide getters & navigation) ─────────────────────

export class NibWord {
  readonly text: string
  readonly index: number
  readonly wasHyphenated: boolean
  readonly bold: boolean
  readonly italic: boolean
  /** Bounding box in PDF user-space for precise highlight positioning */
  readonly pdfRect: NibPdfRect | null
  /** @internal set by NibSentence constructor */
  _sentence!: NibSentence

  constructor(data: NibWordData) {
    this.text = data.text
    this.index = data.index
    this.wasHyphenated = data.wasHyphenated ?? false
    this.bold = data.bold ?? false
    this.italic = data.italic ?? false
    this.pdfRect = data.pdfRect ?? null
  }

  /** The sentence this word belongs to */
  get sentence(): NibSentence {
    return this._sentence
  }

  /** The paragraph this word belongs to */
  get paragraph(): NibParagraph {
    return this._sentence._paragraph
  }

  /** The page this word appears on */
  get page(): NibPage {
    return this._sentence._paragraph._page
  }

  /**
   * Get surrounding context for AI consumption.
   * Returns the full sentence text by default, or a window of ±n words.
   */
  getContext(windowSize?: number): string {
    if (windowSize === undefined) {
      return this._sentence.text
    }
    const words = this._sentence.words
    const start = Math.max(0, this.index - windowSize)
    const end = Math.min(words.length, this.index + windowSize + 1)
    return words.slice(start, end).map(w => w.text).join(' ')
  }

  /**
   * Build a context payload suitable for passing to an AI service.
   * Includes the word, its sentence, paragraph excerpt, and page number.
   */
  getAIContext(): { word: string; sentence: string; paragraphExcerpt: string; pageNumber: number } {
    const para = this.paragraph
    // Include up to 2 surrounding sentences for broader context
    const sentIdx = this._sentence.index
    const sentences = para.sentences
    const start = Math.max(0, sentIdx - 1)
    const end = Math.min(sentences.length, sentIdx + 2)
    const excerpt = sentences.slice(start, end).map(s => s.text).join(' ')

    return {
      word: this.text,
      sentence: this._sentence.text,
      paragraphExcerpt: excerpt,
      pageNumber: this.page.pageNumber,
    }
  }

  toData(): NibWordData {
    return { text: this.text, index: this.index, wasHyphenated: this.wasHyphenated || undefined, bold: this.bold || undefined, italic: this.italic || undefined, pdfRect: this.pdfRect ?? undefined }
  }
}

export class NibSentence {
  readonly words: NibWord[]
  readonly index: number
  /** @internal set by NibParagraph constructor */
  _paragraph!: NibParagraph

  constructor(data: NibSentenceData) {
    this.index = data.index
    this.words = data.words.map(w => {
      const word = new NibWord(w)
      word._sentence = this
      return word
    })
  }

  /** Full text of the sentence */
  get text(): string {
    return this.words.map(w => w.text).join(' ')
  }

  get paragraph(): NibParagraph {
    return this._paragraph
  }

  get page(): NibPage {
    return this._paragraph._page
  }

  /** Get a specific word by its 0-based index */
  getWord(index: number): NibWord | undefined {
    return this.words[index]
  }

  /** Find a word by its text (first match) */
  findWord(text: string): NibWord | undefined {
    return this.words.find(w => w.text.toLowerCase() === text.toLowerCase())
  }

  toData(): NibSentenceData {
    return { words: this.words.map(w => w.toData()), index: this.index }
  }
}

export class NibParagraph {
  readonly sentences: NibSentence[]
  readonly index: number
  readonly blockType: NibBlockType
  /** @internal set by NibPage constructor */
  _page!: NibPage

  constructor(data: NibParagraphData) {
    this.index = data.index
    this.blockType = data.blockType ?? 'body'
    this.sentences = data.sentences.map(s => {
      const sentence = new NibSentence(s)
      sentence._paragraph = this
      return sentence
    })
  }

  /** Full text of the paragraph */
  get text(): string {
    return this.sentences.map(s => s.text).join(' ')
  }

  get page(): NibPage {
    return this._page
  }

  /** All words in this paragraph, flattened */
  get allWords(): NibWord[] {
    return this.sentences.flatMap(s => s.words)
  }

  /** Whether this paragraph is an introduction block */
  get isIntroduction(): boolean {
    return this.blockType === 'introduction'
  }

  toData(): NibParagraphData {
    return {
      sentences: this.sentences.map(s => s.toData()),
      index: this.index,
      blockType: this.blockType !== 'body' ? this.blockType : undefined,
    }
  }
}

export class NibFigure {
  readonly label: string
  readonly caption: string
  readonly imageSrc?: string
  readonly top?: number

  constructor(data: NibFigureData) {
    this.label = data.label
    this.caption = data.caption
    this.imageSrc = data.imageSrc
    this.top = data.top
  }

  toData(): NibFigureData {
    return { label: this.label, caption: this.caption, imageSrc: this.imageSrc, top: this.top }
  }
}

export class NibListItem {
  readonly marker: string
  readonly text: string
  readonly depth: number

  constructor(data: NibListItemData) {
    this.marker = data.marker
    this.text = data.text
    this.depth = data.depth
  }

  toData(): NibListItemData {
    return { marker: this.marker, text: this.text, depth: this.depth }
  }
}

export class NibHeader {
  readonly text: string
  readonly level: number

  constructor(data: NibHeaderData) {
    this.text = data.text
    this.level = data.level
  }

  toData(): NibHeaderData {
    return { text: this.text, level: this.level }
  }
}

export class NibFootnote {
  readonly marker: string
  readonly text: string

  constructor(data: NibFootnoteData) {
    this.marker = data.marker
    this.text = data.text
  }

  toData(): NibFootnoteData {
    return { marker: this.marker, text: this.text }
  }
}

export class NibFooter {
  readonly text: string

  constructor(data: NibFooterData) {
    this.text = data.text
  }

  toData(): NibFooterData {
    return { text: this.text }
  }
}

export class NibPage {
  readonly pageNumber: number
  readonly header: NibHeader | null
  readonly footer: NibFooter | null
  readonly footnotes: NibFootnote[]
  readonly paragraphs: NibParagraph[]
  /** @internal set by NibDocument constructor */
  _document!: NibDocument

  readonly figures: NibFigure[]
  readonly listItems: NibListItem[]

  constructor(data: NibPageData) {
    this.pageNumber = data.pageNumber
    this.header = data.header ? new NibHeader(data.header) : null
    this.footer = data.footer ? new NibFooter(data.footer) : null
    this.footnotes = data.footnotes.map(f => new NibFootnote(f))
    this.figures = (data.figures ?? []).map(f => new NibFigure(f))
    this.listItems = (data.listItems ?? []).map(l => new NibListItem(l))
    this.paragraphs = data.paragraphs.map(p => {
      const para = new NibParagraph(p)
      para._page = this
      return para
    })
  }

  /** All body text (paragraphs only, excluding header/footer/footnotes) */
  get bodyText(): string {
    return this.paragraphs.map(p => p.text).join('\n\n')
  }

  /** All words on this page (from paragraphs only) */
  get allWords(): NibWord[] {
    return this.paragraphs.flatMap(p => p.allWords)
  }

  toData(): NibPageData {
    return {
      pageNumber: this.pageNumber,
      header: this.header?.toData() ?? null,
      footer: this.footer?.toData() ?? null,
      footnotes: this.footnotes.map(f => f.toData()),
      paragraphs: this.paragraphs.map(p => p.toData()),
      figures: this.figures.map(f => f.toData()),
      listItems: this.listItems.map(l => l.toData()),
    }
  }
}

export class NibDocument {
  readonly version = 1
  readonly sourceTitle: string
  readonly sourceAuthor: string
  readonly pages: NibPage[]
  readonly createdAt: number

  constructor(data: NibDocumentData) {
    this.sourceTitle = data.sourceTitle
    this.sourceAuthor = data.sourceAuthor
    this.createdAt = data.createdAt
    this.pages = data.pages.map(p => {
      const page = new NibPage(p)
      page._document = this
      return page
    })
  }

  /** Get a page by its 1-based page number */
  getPage(pageNumber: number): NibPage | undefined {
    return this.pages.find(p => p.pageNumber === pageNumber)
  }

  /** Get all body text across all pages */
  get fullText(): string {
    return this.pages.map(p => p.bodyText).join('\n\n')
  }

  /** Total word count (body text only) */
  get wordCount(): number {
    return this.pages.reduce((sum, p) => sum + p.allWords.length, 0)
  }

  /** Find all occurrences of a word across the document */
  findWord(text: string): NibWord[] {
    const results: NibWord[] = []
    for (const page of this.pages) {
      for (const para of page.paragraphs) {
        for (const sent of para.sentences) {
          for (const word of sent.words) {
            if (word.text.toLowerCase() === text.toLowerCase()) {
              results.push(word)
            }
          }
        }
      }
    }
    return results
  }

  /** Serialize back to plain data for storage */
  toData(): NibDocumentData {
    return {
      version: 1,
      sourceTitle: this.sourceTitle,
      sourceAuthor: this.sourceAuthor,
      pages: this.pages.map(p => p.toData()),
      createdAt: this.createdAt,
    }
  }

  /** Rehydrate from stored data */
  static fromData(data: NibDocumentData): NibDocument {
    return new NibDocument(data)
  }
}
