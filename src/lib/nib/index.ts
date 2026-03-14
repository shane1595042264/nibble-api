/**
 * .nib (Natural Interactive Book) Format
 *
 * A word-level document object model for interactive reading.
 * Every word knows its sentence → paragraph → page context,
 * enabling AI features like context-aware translation.
 */

// Data interfaces (serializable, for storage)
export type {
  NibBlockType,
  NibWordData,
  NibSentenceData,
  NibParagraphData,
  NibHeaderData,
  NibFooterData,
  NibFootnoteData,
  NibFigureData,
  NibListItemData,
  NibPageData,
  NibDocumentData,
} from './models.js'

// Live class wrappers (with getters & navigation)
export {
  NibWord,
  NibSentence,
  NibParagraph,
  NibHeader,
  NibFootnote,
  NibFooter,
  NibFigure,
  NibListItem,
  NibPage,
  NibDocument,
} from './models.js'

// Parser (for rich PDF text items with positions/fonts)
export { NibParser } from './parser.js'
export type { RawTextItem, RawPageData, RawImageRegion, NibParserConfig } from './parser.js'

// Text parser (for flat AI/OCR-extracted text)
export { NibTextParser } from './text-parser.js'
export type { NibTextParserConfig } from './text-parser.js'
