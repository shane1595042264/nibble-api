import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { parseEpub, extractTextFromXhtml } from '../../../src/services/epub.service.js';

// ─── KAN-309 ─────────────────────────────────────────────────────────────────
// The TOC is the highest-priority source of chapter titles, but two defects
// meant it almost never landed:
//   A. an EPUB 3 nav document was handed to an NCX-only parser -> empty map
//   B. the map was keyed decoded while the lookup used the raw manifest href,
//      so any percent-encoded filename missed while its plain siblings resolved
// These fixtures are built in-memory so they exercise the real zip/XML path.

const LONG = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10);

const BODY = (heading: string | null, filler: string) =>
  `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>My Great Book</title></head>
<body>${heading ? `<h1>${heading}</h1>` : ''}<p>${filler}</p></body></html>`;

const CONTAINER = (opfPath: string) =>
  `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`;

interface ChapterSpec {
  /** href exactly as it appears in the manifest (may be percent-encoded) */
  href: string;
  /** href exactly as it appears in the TOC, when it differs from the manifest's */
  tocHref?: string;
  /** path of the chapter file inside the OPF directory */
  path: string;
  /** TOC label, or null for a chapter the TOC doesn't mention */
  tocTitle: string | null;
  heading?: string | null;
}

function manifestAndSpine(chapters: ChapterSpec[]): { items: string; refs: string } {
  return {
    items: chapters
      .map((c, i) => `<item id="c${i + 1}" href="${c.href}" media-type="application/xhtml+xml"/>`)
      .join(''),
    refs: chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join(''),
  };
}

/** EPUB 2: NCX toc, pointed at by spine@toc. */
function buildEpub2(chapters: ChapterSpec[], opts: { tocPath?: string } = {}): Buffer {
  const dir = 'OEBPS';
  const tocHref = opts.tocPath ?? 'toc.ncx';
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER(`${dir}/content.opf`)));

  const navPoints = chapters
    .filter((c) => c.tocTitle)
    .map(
      (c, i) =>
        `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${c.tocTitle}</text></navLabel>` +
        `<content src="${c.tocHref ?? c.href}"/></navPoint>`,
    )
    .join('');
  zip.addFile(
    `${dir}/${tocHref}`,
    Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head/><docTitle><text>My Great Book</text></docTitle><navMap>${navPoints}</navMap></ncx>`),
  );

  const { items, refs } = manifestAndSpine(chapters);
  zip.addFile(
    `${dir}/content.opf`,
    Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>My Great Book</dc:title><dc:creator>A. Writer</dc:creator></metadata>
<manifest><item id="ncx" href="${tocHref}" media-type="application/x-dtbncx+xml"/>${items}</manifest>
<spine toc="ncx">${refs}</spine></package>`),
  );
  for (const c of chapters) zip.addFile(`${dir}/${c.path}`, Buffer.from(BODY(c.heading ?? null, LONG)));
  return zip.toBuffer();
}

/** EPUB 3: nav XHTML marked properties="nav", no NCX at all. */
function buildEpub3(chapters: ChapterSpec[], opts: { tocPath?: string } = {}): Buffer {
  const dir = 'OEBPS';
  const tocHref = opts.tocPath ?? 'nav.xhtml';
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER(`${dir}/content.opf`)));

  const lis = chapters
    .filter((c) => c.tocTitle)
    .map((c) => `<li><a href="${c.tocHref ?? c.href}">${c.tocTitle}</a></li>`)
    .join('');
  // The landmarks nav comes first on purpose: the toc nav must be picked by
  // epub:type, not by being the first <nav> in the document.
  zip.addFile(
    `${dir}/${tocHref}`,
    Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head><body>
<nav epub:type="landmarks" hidden=""><ol><li><a epub:type="bodymatter" href="nowhere.xhtml">Start Reading</a></li></ol></nav>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${lis}</ol></nav>
</body></html>`),
  );

  const { items, refs } = manifestAndSpine(chapters);
  zip.addFile(
    `${dir}/content.opf`,
    Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>My Great Book</dc:title><dc:creator>A. Writer</dc:creator></metadata>
<manifest><item id="nav" href="${tocHref}" media-type="application/xhtml+xml" properties="nav"/>${items}</manifest>
<spine>${refs}</spine></package>`),
  );
  for (const c of chapters) zip.addFile(`${dir}/${c.path}`, Buffer.from(BODY(c.heading ?? null, LONG)));
  return zip.toBuffer();
}

/** The ticket's repro: two chapters, the second one's href percent-encoded. */
const REPRO: ChapterSpec[] = [
  { href: 'Text/chap01.xhtml', path: 'Text/chap01.xhtml', tocTitle: 'The Bronze Key' },
  { href: 'Text/chap%2002.xhtml', path: 'Text/chap 02.xhtml', tocTitle: 'The Silver Gate' },
];

describe('parseEpub — TOC chapter titles (KAN-309)', () => {
  it('reads titles from an EPUB 2 NCX, including a percent-encoded href', () => {
    const book = parseEpub(buildEpub2(REPRO));
    expect(book.title).toBe('My Great Book');
    expect(book.author).toBe('A. Writer');
    expect(book.chapters.map((c) => c.title)).toEqual(['The Bronze Key', 'The Silver Gate']);
  });

  it('reads titles from an EPUB 3 nav document with no NCX', () => {
    const book = parseEpub(buildEpub3(REPRO));
    expect(book.chapters.map((c) => c.title)).toEqual(['The Bronze Key', 'The Silver Gate']);
  });

  it('matches when the TOC encodes an href the manifest leaves plain', () => {
    const chapters: ChapterSpec[] = [
      { href: 'Text/a b.xhtml', tocHref: 'Text/a%20b.xhtml', path: 'Text/a b.xhtml', tocTitle: 'Spaced Out' },
    ];
    expect(parseEpub(buildEpub3(chapters)).chapters.map((c) => c.title)).toEqual(['Spaced Out']);
    expect(parseEpub(buildEpub2(chapters)).chapters.map((c) => c.title)).toEqual(['Spaced Out']);
  });

  it('drops the fragment on a TOC href that points at an anchor', () => {
    const chapters: ChapterSpec[] = [
      { href: 'Text/chap01.xhtml', tocHref: 'Text/chap01.xhtml#start', path: 'Text/chap01.xhtml', tocTitle: 'The Bronze Key' },
    ];
    expect(parseEpub(buildEpub3(chapters)).chapters.map((c) => c.title)).toEqual(['The Bronze Key']);
    expect(parseEpub(buildEpub2(chapters)).chapters.map((c) => c.title)).toEqual(['The Bronze Key']);
  });

  it('resolves TOC hrefs relative to the TOC file, not the OPF', () => {
    // nav.xhtml lives in Nav/, so its hrefs climb back out with ../Text/…
    const chapters: ChapterSpec[] = [
      { href: 'Text/chap01.xhtml', tocHref: '../Text/chap01.xhtml', path: 'Text/chap01.xhtml', tocTitle: 'The Bronze Key' },
    ];
    expect(parseEpub(buildEpub3(chapters, { tocPath: 'Nav/nav.xhtml' })).chapters.map((c) => c.title)).toEqual([
      'The Bronze Key',
    ]);
    expect(parseEpub(buildEpub2(chapters, { tocPath: 'Nav/toc.ncx' })).chapters.map((c) => c.title)).toEqual([
      'The Bronze Key',
    ]);
  });

  it('keeps nested nav entries and strips markup inside the anchor', () => {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/epub+zip'));
    zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER('content.opf')));
    zip.addFile(
      'nav.xhtml',
      Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
<li><a href="p1.xhtml">Part One</a><ol><li><a href="p2.xhtml">Chapter <span>the</span> Second</a></li></ol></li>
</ol></nav></body></html>`),
    );
    zip.addFile(
      'content.opf',
      Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>My Great Book</dc:title></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="p1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="p2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    );
    zip.addFile('p1.xhtml', Buffer.from(BODY(null, LONG)));
    zip.addFile('p2.xhtml', Buffer.from(BODY(null, LONG)));
    expect(parseEpub(zip.toBuffer()).chapters.map((c) => c.title)).toEqual(['Part One', 'Chapter the Second']);
  });
});

describe('parseEpub — title fallback chain is unchanged (KAN-309 negative controls)', () => {
  it('falls back to the in-body heading when the TOC has no entry', () => {
    const chapters: ChapterSpec[] = [
      { href: 'Text/chap01.xhtml', path: 'Text/chap01.xhtml', tocTitle: 'The Bronze Key' },
      { href: 'Text/chap02.xhtml', path: 'Text/chap02.xhtml', tocTitle: null, heading: 'An Untocced Chapter' },
    ];
    expect(parseEpub(buildEpub3(chapters)).chapters.map((c) => c.title)).toEqual([
      'The Bronze Key',
      'An Untocced Chapter',
    ]);
  });

  it('falls back to "Chapter N" when the heading is just the book title', () => {
    const chapters: ChapterSpec[] = [
      { href: 'Text/chap01.xhtml', path: 'Text/chap01.xhtml', tocTitle: null, heading: 'My Great Book' },
    ];
    expect(parseEpub(buildEpub3(chapters)).chapters.map((c) => c.title)).toEqual(['Chapter 1']);
  });

  it('degrades to the fallback chain when the TOC is unparseable', () => {
    const zip = new AdmZip(buildEpub3(REPRO));
    zip.updateFile('OEBPS/nav.xhtml', Buffer.from('<<<not xml at all'));
    const chapters = parseEpub(zip.toBuffer()).chapters;
    expect(chapters).toHaveLength(2);
    expect(chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('still drops sub-threshold filler sections', () => {
    const chapters: ChapterSpec[] = [
      { href: 'Text/chap01.xhtml', path: 'Text/chap01.xhtml', tocTitle: 'The Bronze Key' },
    ];
    const zip = new AdmZip(buildEpub3(chapters));
    zip.updateFile('OEBPS/Text/chap01.xhtml', Buffer.from(BODY(null, 'tiny')));
    expect(parseEpub(zip.toBuffer()).chapters).toHaveLength(0);
  });
});

// ─── KAN-356 ─────────────────────────────────────────────────────────────────
// Every leftover tag used to become a space, so inline markup split words
// (Butter<span>nut</span>) and detached punctuation (<i>indica</i>,).

const text = (inner: string) =>
  extractTextFromXhtml(`<html><body>${inner}</body></html>`).plainText;

describe('extractTextFromXhtml — inline tags (KAN-356)', () => {
  it('keeps a word whole across an inline tag', () => {
    expect(text('<p>Butter<span>nut</span> Squash</p>')).toBe('Butternut Squash');
  });

  it('keeps punctuation attached to an inline-wrapped word', () => {
    expect(text('<p><i>indica</i>, <i>japonica</i>.</p>')).toBe('indica, japonica.');
    expect(text('<p>rice (<i>paella</i>)</p>')).toBe('rice (paella)');
  });

  it('keeps the source whitespace between inline elements', () => {
    expect(text('<p><em>one</em> <em>two</em></p>')).toBe('one two');
  });

  it('keeps paragraph breaks, including back-to-back paragraphs', () => {
    expect(text('<p>a</p><p>b</p>')).toBe('a\n\nb');
    expect(text('<div>a<div>b</div></div>')).toBe('a\nb');
  });

  it('breaks the line on a <br> that carries attributes', () => {
    expect(text('<p>535 Albany Street<br class="calibre8"/>Boston</p>')).toBe('535 Albany Street\nBoston');
  });

  it('still separates table cells and void elements', () => {
    expect(text('<table><tr><td>1 cup</td><td>rice</td></tr></table>')).toBe('1 cup rice');
    expect(text('<p>one<img src="x.png"/>two<hr/>three</p>')).toBe('one two three');
  });

  it('decodes an escaped entity once', () => {
    expect(text('<p>&amp;lt; &amp;amp; &amp;#39; &lt;b&gt; &amp;</p>')).toBe('&lt; &amp; &#39; <b> &');
  });
});

// ─── KAN-373 ─────────────────────────────────────────────────────────────────
// The <h1>-<h6> / <title> fallback title skipped the entity decode the body
// gets, so untocced chapters were named 'Q&amp;A' and 'Chapter&nbsp;3'.

const titleOf = (xhtml: string) => extractTextFromXhtml(xhtml).title;

describe('extractTextFromXhtml — fallback titles are entity-decoded (KAN-373)', () => {
  it('decodes a named entity in the in-body heading', () => {
    expect(titleOf('<html><body><h1>Q&amp;A with the Chef</h1><p>x</p></body></html>')).toBe('Q&A with the Chef');
  });

  it('decodes a numeric entity in the <title> tag', () => {
    expect(titleOf('<html><head><title>Don&#8217;t Rinse the Rice</title></head><body><p>x</p></body></html>')).toBe(
      'Don\u2019t Rinse the Rice',
    );
  });

  it('turns &nbsp; into a plain space in the heading', () => {
    expect(titleOf('<html><body><h2>Chapter&nbsp;3: Salt &amp; Fat</h2><p>x</p></body></html>')).toBe(
      'Chapter 3: Salt & Fat',
    );
  });

  it('decodes an escaped entity once', () => {
    expect(titleOf('<html><body><h1>Using &amp;lt;b&amp;gt; &lt;i&gt;</h1></body></html>')).toBe('Using &lt;b&gt; <i>');
  });

  it('falls back to <title> when the heading is only an entity space', () => {
    expect(titleOf('<html><head><title>Salt</title></head><body><h1>&nbsp;</h1><p>x</p></body></html>')).toBe('Salt');
  });

  it('names an untocced chapter with the decoded heading', () => {
    const chapters: ChapterSpec[] = [
      { href: 'Text/chap01.xhtml', path: 'Text/chap01.xhtml', tocTitle: 'The Bronze Key' },
      { href: 'Text/chap02.xhtml', path: 'Text/chap02.xhtml', tocTitle: null, heading: 'Q&amp;A with the Chef' },
    ];
    expect(parseEpub(buildEpub3(chapters)).chapters.map((c) => c.title)).toEqual([
      'The Bronze Key',
      'Q&A with the Chef',
    ]);
  });

  it('recognises an entity-encoded heading as the book title', () => {
    const chapters: ChapterSpec[] = [
      { href: 'Text/chap01.xhtml', path: 'Text/chap01.xhtml', tocTitle: null, heading: 'My&nbsp;Great Book' },
    ];
    expect(parseEpub(buildEpub3(chapters)).chapters.map((c) => c.title)).toEqual(['Chapter 1']);
  });
});
