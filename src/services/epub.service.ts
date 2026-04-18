import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import path from 'node:path';

export interface EpubChapter {
  chapterIndex: number;
  title: string;
  plainText: string;
  charCount: number;
}

export interface EpubBook {
  title: string;
  author: string | null;
  coverImage: Buffer | null;
  coverMimeType: string | null;
  chapters: EpubChapter[];
}

const MIN_CHAPTER_CHARS = 120;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  alwaysCreateTextNode: false,
  parseAttributeValue: false,
  removeNSPrefix: false,
  trimValues: true,
});

/**
 * Locate the OPF manifest path by reading META-INF/container.xml.
 * Spec: https://www.w3.org/publishing/epub3/epub-ocf.html
 */
function findOpfPath(zip: AdmZip): string {
  const containerEntry = zip.getEntry('META-INF/container.xml');
  if (!containerEntry) throw new Error('EPUB missing META-INF/container.xml');
  const xml = containerEntry.getData().toString('utf-8');
  const parsed = xmlParser.parse(xml);
  const rootfile = parsed?.container?.rootfiles?.rootfile;
  const entry = Array.isArray(rootfile) ? rootfile[0] : rootfile;
  const fullPath = entry?.['@_full-path'];
  if (!fullPath || typeof fullPath !== 'string') {
    throw new Error('EPUB container.xml missing rootfile full-path');
  }
  return fullPath;
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
}

interface OpfData {
  title: string;
  author: string | null;
  coverId: string | null;
  manifest: Map<string, ManifestItem>;
  spine: string[];
  /** Manifest id of the NCX (EPUB 2) or nav document (EPUB 3), if declared */
  tocId: string | null;
}

function parseOpf(xml: string): OpfData {
  const parsed = xmlParser.parse(xml);
  const pkg = parsed?.package;
  if (!pkg) throw new Error('EPUB OPF missing <package>');

  const md = pkg.metadata ?? {};

  // Title
  let title: string | undefined;
  const dcTitle = md['dc:title'];
  if (typeof dcTitle === 'string') title = dcTitle;
  else if (Array.isArray(dcTitle)) {
    const first = dcTitle[0];
    title = typeof first === 'string' ? first : first?.['#text'];
  } else if (dcTitle && typeof dcTitle === 'object') {
    title = dcTitle['#text'];
  }

  // Author (first dc:creator)
  let author: string | null = null;
  const dcCreator = md['dc:creator'];
  if (typeof dcCreator === 'string') author = dcCreator;
  else if (Array.isArray(dcCreator)) {
    const first = dcCreator[0];
    author = typeof first === 'string' ? first : (first?.['#text'] ?? null);
  } else if (dcCreator && typeof dcCreator === 'object') {
    author = dcCreator['#text'] ?? null;
  }

  // Cover — <meta name="cover" content="ITEM_ID"/> (EPUB 2 convention)
  let coverId: string | null = null;
  const metaEntries = Array.isArray(md.meta) ? md.meta : md.meta ? [md.meta] : [];
  for (const m of metaEntries) {
    if (m?.['@_name'] === 'cover' && m?.['@_content']) {
      coverId = m['@_content'];
      break;
    }
  }
  // Also check opf:meta (some publishers use this)
  const opfMetaEntries = Array.isArray(md['opf:meta']) ? md['opf:meta'] : md['opf:meta'] ? [md['opf:meta']] : [];
  for (const m of opfMetaEntries) {
    if (!coverId && m?.['@_name'] === 'cover' && m?.['@_content']) {
      coverId = m['@_content'];
      break;
    }
  }

  // Manifest
  const manifestItems = pkg.manifest?.item;
  const itemArr = Array.isArray(manifestItems) ? manifestItems : manifestItems ? [manifestItems] : [];
  const manifest = new Map<string, ManifestItem>();
  for (const item of itemArr) {
    const id = item['@_id'];
    const href = item['@_href'];
    const mediaType = item['@_media-type'] ?? '';
    if (!id || !href) continue;
    manifest.set(id, { id, href, mediaType });
  }

  // EPUB 3 sometimes marks cover via properties="cover-image" on a manifest item
  if (!coverId) {
    for (const item of itemArr) {
      if (item['@_properties'] === 'cover-image' && item['@_id']) {
        coverId = item['@_id'];
        break;
      }
    }
  }

  // Spine + NCX pointer (EPUB 2: spine@toc="id"; EPUB 3: nav document in manifest)
  const spineElem = pkg.spine ?? {};
  const tocIdFromSpine = spineElem['@_toc'] ?? null;
  const itemrefs = spineElem.itemref;
  const itemrefArr = Array.isArray(itemrefs) ? itemrefs : itemrefs ? [itemrefs] : [];
  const spine: string[] = [];
  for (const ref of itemrefArr) {
    const idref = ref['@_idref'];
    if (idref) spine.push(idref);
  }

  // EPUB 3 alternative: manifest item marked properties="nav"
  let tocId: string | null = tocIdFromSpine;
  if (!tocId) {
    for (const item of itemArr) {
      if (typeof item['@_properties'] === 'string' && /\bnav\b/.test(item['@_properties']) && item['@_id']) {
        tocId = item['@_id'];
        break;
      }
    }
  }

  return {
    title: (title ?? 'Untitled').trim(),
    author: author ? author.trim() : null,
    coverId,
    manifest,
    spine,
    tocId,
  };
}

/**
 * Parse an NCX toc and return a map from chapter-file href → chapter title.
 * Silently returns an empty map on any error — caller falls back gracefully.
 */
function parseNcxTitles(ncxXml: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const parsed = xmlParser.parse(ncxXml);
    const navPoints = parsed?.ncx?.navMap?.navPoint;
    const arr = Array.isArray(navPoints) ? navPoints : navPoints ? [navPoints] : [];
    const walk = (points: any[]) => {
      for (const p of points) {
        const label = p?.navLabel?.text;
        const labelText = typeof label === 'string' ? label : label?.['#text'];
        const src = p?.content?.['@_src'];
        if (labelText && typeof src === 'string') {
          // Strip fragment and decode
          const href = decodeURIComponent(src.split('#')[0]);
          const clean = String(labelText).trim();
          if (clean && !map.has(href)) map.set(href, clean);
        }
        if (p?.navPoint) {
          const nested = Array.isArray(p.navPoint) ? p.navPoint : [p.navPoint];
          walk(nested);
        }
      }
    };
    walk(arr);
  } catch {
    // fall through
  }
  return map;
}

/**
 * Strip XHTML content to readable plain text.
 * - Removes <script>/<style> blocks entirely
 * - Preserves paragraph breaks (</p>, </div>, </h1-6>, <br/> → \n)
 * - Strips all other tags
 * - Decodes common HTML entities
 */
export function extractTextFromXhtml(xhtml: string): { title: string | null; plainText: string } {
  // Capture <title> for use as a fallback only — many publishers set the
  // same <title> on every chapter file, so we prefer in-body headings.
  const titleTagMatch = xhtml.match(/<title[^>]*>([^<]*)<\/title>/i);
  const fallbackTitle: string | null = titleTagMatch?.[1]?.trim() || null;

  let body = xhtml;

  // Prefer the <body> if present (skip <head>)
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];

  // Drop script/style
  body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  body = body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  // Prefer the first in-body <h1>-<h6> as the chapter title; <title> tag is the fallback.
  let docTitle: string | null = null;
  const h = body.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (h?.[1]) {
    const stripped = h[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (stripped) docTitle = stripped;
  }
  if (!docTitle) docTitle = fallbackTitle;

  // Block-level elements → newline
  body = body.replace(/<br\s*\/?\s*>/gi, '\n');
  body = body.replace(/<\/(p|div|li|h[1-6]|blockquote|section|article)\s*>/gi, '\n\n');
  body = body.replace(/<\/(tr|table)\s*>/gi, '\n');
  // Strip remaining tags
  body = body.replace(/<[^>]+>/g, ' ');

  // Decode entities — common set, plus numeric
  body = body
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));

  // Collapse whitespace: spaces within a line, blank lines between paragraphs
  body = body
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title: docTitle, plainText: body };
}

/**
 * Parse an EPUB buffer into a structured book.
 * Throws on fatal errors (missing container.xml / OPF). Individual chapter
 * failures fall back to placeholder text rather than aborting the whole book.
 */
export function parseEpub(buffer: Buffer): EpubBook {
  const zip = new AdmZip(buffer);
  const opfPath = findOpfPath(zip);
  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error(`EPUB OPF not found at ${opfPath}`);
  const opf = parseOpf(opfEntry.getData().toString('utf-8'));

  // Paths inside the OPF are relative to the OPF's own directory.
  const opfDir = path.posix.dirname(opfPath);
  const resolveHref = (href: string) => {
    const decoded = decodeURIComponent(href.split('#')[0]);
    return opfDir && opfDir !== '.' ? path.posix.join(opfDir, decoded) : decoded;
  };

  // Cover
  let coverImage: Buffer | null = null;
  let coverMimeType: string | null = null;
  if (opf.coverId) {
    const item = opf.manifest.get(opf.coverId);
    if (item) {
      const entry = zip.getEntry(resolveHref(item.href));
      if (entry) {
        coverImage = entry.getData();
        coverMimeType = item.mediaType || null;
      }
    }
  }

  // NCX / nav TOC — canonical source of chapter titles when present.
  // Keyed by the href as it appears in the manifest (pre-resolve), so lookups
  // match what we see on each manifest item.
  let ncxTitles = new Map<string, string>();
  if (opf.tocId) {
    const tocItem = opf.manifest.get(opf.tocId);
    if (tocItem) {
      const tocEntry = zip.getEntry(resolveHref(tocItem.href));
      if (tocEntry) ncxTitles = parseNcxTitles(tocEntry.getData().toString('utf-8'));
    }
  }

  // When the publisher reuses the same <title> across every chapter file,
  // prefer "Chapter N" over a duplicate title so the reader doesn't show
  // 24 copies of the book name in the section list.
  const normalizedBookTitle = opf.title.toLowerCase().trim();

  // Chapters — walk the spine, resolve each idref, extract text
  const chapters: EpubChapter[] = [];
  for (const idref of opf.spine) {
    const item = opf.manifest.get(idref);
    if (!item) continue;
    if (!/x?html/i.test(item.mediaType) && !/\.x?html?$/i.test(item.href)) continue;
    const entry = zip.getEntry(resolveHref(item.href));
    if (!entry) continue;

    const xhtml = entry.getData().toString('utf-8');
    const { title: extractedTitle, plainText } = extractTextFromXhtml(xhtml);
    const charCount = plainText.length;
    // Drop tiny filler sections (title pages, blank covers, ToC markers) so
    // the reader doesn't get a pile of 0-word chapters.
    if (charCount < MIN_CHAPTER_CHARS) continue;

    const nextIndex = chapters.length + 1;
    // Title priority: NCX entry > in-body heading > <title> tag (if distinct from book title) > "Chapter N"
    let title = ncxTitles.get(item.href) ?? null;
    if (!title && extractedTitle) {
      const looksLikeBookTitle = extractedTitle.toLowerCase().trim() === normalizedBookTitle ||
        normalizedBookTitle.startsWith(extractedTitle.toLowerCase().trim());
      if (!looksLikeBookTitle) title = extractedTitle.trim();
    }
    if (!title) title = `Chapter ${nextIndex}`;

    chapters.push({
      chapterIndex: nextIndex,
      title,
      plainText,
      charCount,
    });
  }

  return {
    title: opf.title,
    author: opf.author,
    coverImage,
    coverMimeType,
    chapters,
  };
}
