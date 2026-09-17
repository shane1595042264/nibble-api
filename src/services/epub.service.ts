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

/** Strip the fragment and percent-decode an href, tolerating a malformed escape. */
function decodeHref(href: string): string {
  const bare = href.split('#')[0];
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

/**
 * Resolve an href against the directory of the document that declared it and
 * normalise it to a zip-relative path. Manifest hrefs are relative to the OPF;
 * NCX/nav hrefs are relative to the TOC document. Running both sides of the
 * title lookup through this is what makes them comparable — fixing only one
 * side would re-break the other.
 */
function resolveRelative(baseDir: string, href: string): string {
  const decoded = decodeHref(href);
  const joined = baseDir && baseDir !== '.' ? path.posix.join(baseDir, decoded) : decoded;
  return path.posix.normalize(joined);
}

/** Local name of a possibly namespace-prefixed element or attribute key. */
function localName(key: string): string {
  const i = key.indexOf(':');
  return i === -1 ? key : key.slice(i + 1);
}

/**
 * EPUB 3 nav documents are XHTML, and a TOC label can carry inline markup
 * (`<a>Chapter <em>One</em></a>`). The shared parser folds every text segment of
 * a mixed-content element into a single `#text` string, losing document order
 * and scrambling such a label, so nav walking gets its own preserveOrder parser.
 */
const navParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  removeNSPrefix: false,
  trimValues: true,
  preserveOrder: true,
});

/** A preserveOrder node: one tag key holding an array of children, plus `:@` attrs. */
type OrderedNode = Record<string, any>;

/** The tag name of a preserveOrder node — `#text` for a text node. */
function tagOf(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ':@') return key;
  }
  return null;
}

function childrenOf(node: OrderedNode, tag: string): OrderedNode[] {
  const value = node[tag];
  return Array.isArray(value) ? value : [];
}

function attrsOf(node: OrderedNode): Record<string, unknown> {
  return (node[':@'] as Record<string, unknown>) ?? {};
}

/** Text content of a preserveOrder subtree, in document order. */
function orderedText(nodes: OrderedNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === null) continue;
    const text = tag === '#text' ? String(node['#text'] ?? '').trim() : orderedText(childrenOf(node, tag));
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

/** Collect every <nav> element in a preserveOrder tree, at any depth. */
function collectNavElements(nodes: OrderedNode[], out: OrderedNode[]): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === null || tag === '#text') continue;
    if (localName(tag) === 'nav') out.push(node);
    collectNavElements(childrenOf(node, tag), out);
  }
}

/**
 * Tokens of a <nav>'s epub:type / role attributes. removeNSPrefix is false, so
 * the attribute arrives under its prefixed name (`@_epub:type`).
 */
function navTypeTokens(nav: OrderedNode): string[] {
  const tokens: string[] = [];
  for (const [key, value] of Object.entries(attrsOf(nav))) {
    if (!key.startsWith('@_') || typeof value !== 'string') continue;
    const name = localName(key.slice(2));
    if (name === 'type' || name === 'role') {
      tokens.push(...value.toLowerCase().split(/\s+/).filter(Boolean));
    }
  }
  return tokens;
}

/** The toc nav, by epub:type then ARIA role, falling back to the first <nav>. */
function pickTocNav(navs: OrderedNode[]): OrderedNode | null {
  return (
    navs.find((n) => navTypeTokens(n).includes('toc')) ??
    navs.find((n) => navTypeTokens(n).includes('doc-toc')) ??
    navs[0] ??
    null
  );
}

/**
 * EPUB 3: record every <a href> under the toc nav, in document order. Walking
 * for anchors rather than for a strict ol/li shape keeps nested <ol> lists,
 * <span> wrappers and publisher-specific markup working alike.
 */
function walkNavAnchors(nodes: OrderedNode[], tocDir: string, map: Map<string, string>): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === null || tag === '#text') continue;
    const children = childrenOf(node, tag);
    if (localName(tag) === 'a') {
      const href = attrsOf(node)['@_href'];
      if (typeof href === 'string' && href) {
        const label = orderedText(children).replace(/\s+/g, ' ').trim();
        const key = resolveRelative(tocDir, href);
        if (label && !map.has(key)) map.set(key, label);
      }
      continue;
    }
    walkNavAnchors(children, tocDir, map);
  }
}

/** EPUB 2: walk <navMap><navPoint>, nested navPoints included. */
function walkNavPoints(points: any[], tocDir: string, map: Map<string, string>): void {
  for (const p of points) {
    const label = p?.navLabel?.text;
    const labelText = typeof label === 'string' ? label : label?.['#text'];
    const src = p?.content?.['@_src'];
    if (labelText && typeof src === 'string') {
      const key = resolveRelative(tocDir, src);
      const clean = String(labelText).trim();
      if (clean && !map.has(key)) map.set(key, clean);
    }
    if (p?.navPoint) {
      walkNavPoints(Array.isArray(p.navPoint) ? p.navPoint : [p.navPoint], tocDir, map);
    }
  }
}

/**
 * Parse an EPUB table of contents — EPUB 2 NCX *or* EPUB 3 nav XHTML — into a
 * map from zip-relative chapter path → chapter title. `tocDir` is the TOC
 * file's own directory, which is what its hrefs are relative to.
 * Silently returns an empty map on any error — caller falls back gracefully.
 */
function parseTocTitles(tocXml: string, tocDir: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const parsed = xmlParser.parse(tocXml);
    if (!parsed || typeof parsed !== 'object') return map;

    // EPUB 2: <ncx><navMap><navPoint>
    const ncxRootKey = Object.keys(parsed).find((k) => localName(k) === 'ncx');
    if (ncxRootKey) {
      const navPoints = parsed[ncxRootKey]?.navMap?.navPoint;
      const arr = Array.isArray(navPoints) ? navPoints : navPoints ? [navPoints] : [];
      walkNavPoints(arr, tocDir, map);
      return map;
    }

    // EPUB 3: XHTML with <nav epub:type="toc"><ol><li><a href="…">Title</a>
    const navs: OrderedNode[] = [];
    collectNavElements(navParser.parse(tocXml) as OrderedNode[], navs);
    const toc = pickTocNav(navs);
    const tocTag = toc ? tagOf(toc) : null;
    if (!toc || !tocTag) return map;
    walkNavAnchors(childrenOf(toc, tocTag), tocDir, map);
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
  const resolveHref = (href: string) => resolveRelative(opfDir, href);

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

  // TOC (EPUB 2 NCX or EPUB 3 nav) — canonical source of chapter titles when
  // present. Keyed by zip-relative path, resolved against the TOC document's
  // own directory, so the lookup below — which resolves the manifest href the
  // same way — matches regardless of percent-encoding or of the TOC sitting in
  // a different directory than the OPF.
  let tocTitles = new Map<string, string>();
  if (opf.tocId) {
    const tocItem = opf.manifest.get(opf.tocId);
    if (tocItem) {
      const tocPath = resolveHref(tocItem.href);
      const tocEntry = zip.getEntry(tocPath);
      if (tocEntry) {
        tocTitles = parseTocTitles(tocEntry.getData().toString('utf-8'), path.posix.dirname(tocPath));
      }
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
    const entryPath = resolveHref(item.href);
    const entry = zip.getEntry(entryPath);
    if (!entry) continue;

    const xhtml = entry.getData().toString('utf-8');
    const { title: extractedTitle, plainText } = extractTextFromXhtml(xhtml);
    const charCount = plainText.length;
    // Drop tiny filler sections (title pages, blank covers, ToC markers) so
    // the reader doesn't get a pile of 0-word chapters.
    if (charCount < MIN_CHAPTER_CHARS) continue;

    const nextIndex = chapters.length + 1;
    // Title priority: TOC entry > in-body heading > <title> tag (if distinct from book title) > "Chapter N"
    let title = tocTitles.get(entryPath) ?? null;
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
