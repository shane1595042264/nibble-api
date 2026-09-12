import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// Drives the real orchestrateEpubPipeline (via processingService.orchestratePipeline)
// with the whole IO graph stubbed, so the assertions are about what the pipeline
// writes to the catalog — the KAN-301 bug was totalPages only being written
// inside the cover branch.

const {
  findCatalogByHashMock,
  updateCatalogMock,
  bookUpdateMock,
  limitMock,
  downloadPdfMock,
  parseEpubMock,
  appendMock,
  updateJobProgressMock,
  completeJobMock,
  failJobMock,
  chapterCreateMock,
  sectionCreateMock,
} = vi.hoisted(() => ({
  findCatalogByHashMock: vi.fn(),
  updateCatalogMock: vi.fn(),
  bookUpdateMock: vi.fn(),
  limitMock: vi.fn(),
  downloadPdfMock: vi.fn(),
  parseEpubMock: vi.fn(),
  appendMock: vi.fn(),
  updateJobProgressMock: vi.fn(),
  completeJobMock: vi.fn(),
  failJobMock: vi.fn(),
  chapterCreateMock: vi.fn(),
  sectionCreateMock: vi.fn(),
}));

vi.mock('../../../src/lib/config.js', () => ({
  config: {
    DATABASE_URL: 'postgres://test',
    R2_BUCKET_NAME: 'test-bucket',
    R2_ENDPOINT: 'https://test.r2',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
  },
}));
vi.mock('../../../src/db/index.js', () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = limitMock;
  return { db: { select: () => chain, transaction: vi.fn() } };
});
vi.mock('../../../src/services/storage.service.js', () => ({
  storageService: { downloadPdf: downloadPdfMock },
}));
vi.mock('../../../src/services/pdf.service.js', () => ({ pdfService: {} }));
vi.mock('../../../src/services/epub.service.js', () => ({ parseEpub: parseEpubMock }));
vi.mock('../../../src/repositories/book.repository.js', () => ({
  bookRepository: {
    findCatalogByHash: findCatalogByHashMock,
    updateCatalog: updateCatalogMock,
    update: bookUpdateMock,
  },
}));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({
  processingLogRepository: {
    append: appendMock,
    updateJobProgress: updateJobProgressMock,
    completeJob: completeJobMock,
    failJob: failJobMock,
    getJob: vi.fn(),
  },
}));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({
  chapterRepository: { create: chapterCreateMock, softDeleteByBookId: vi.fn() },
}));
vi.mock('../../../src/repositories/section.repository.js', () => ({
  sectionRepository: { create: sectionCreateMock, softDeleteByBookId: vi.fn() },
}));

import { processingService } from '../../../src/services/processing.service.js';

const CHAPTER_COUNT = 7;

function epubBook(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Real EPUB Title',
    author: 'Real EPUB Author',
    coverImage: null,
    coverMimeType: null,
    chapters: Array.from({ length: CHAPTER_COUNT }, (_, i) => ({
      chapterIndex: i + 1,
      title: `Chapter ${i + 1}`,
      plainText: 'text',
      charCount: 4,
    })),
    ...overrides,
  };
}

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'catalog-1',
    format: 'epub',
    title: 'Untitled',
    author: null,
    coverUrl: null,
    totalPages: 0,
    ...overrides,
  };
}

/** Log messages the pipeline appended, flattened for easy assertions. */
function logMessages(): string[] {
  return appendMock.mock.calls.map((c) => String(c[2]));
}

describe('EPUB pipeline catalog backfill (KAN-301)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue([{ r2Key: 'epubs/test.epub', fileHash: 'hash-1' }]);
    downloadPdfMock.mockResolvedValue(Buffer.from('fake-epub'));
    chapterCreateMock.mockImplementation(async () => ({ id: 'chapter-x' }));
    sectionCreateMock.mockResolvedValue({ id: 'section-x' });
  });

  async function run() {
    await processingService.orchestratePipeline('job-1', 'hash-1', 'book-1');
    // The pipeline swallows its own errors, so a missing mock would look like a
    // silent pass. Assert it actually reached the end.
    expect(failJobMock).not.toHaveBeenCalled();
    expect(completeJobMock).toHaveBeenCalledWith('job-1');
  }

  it('branch C (Google Books supplied a cover): writes totalPages and keeps the existing cover', async () => {
    findCatalogByHashMock.mockResolvedValue(
      catalogRow({ coverUrl: 'https://books.google.com/cover.jpg', title: 'Googled Title', author: 'Googled Author' }),
    );
    parseEpubMock.mockReturnValue(epubBook({ coverImage: Buffer.from('img'), coverMimeType: 'image/png' }));

    await run();

    expect(updateCatalogMock).toHaveBeenCalledTimes(1);
    const [catalogId, patch] = updateCatalogMock.mock.calls[0];
    expect(catalogId).toBe('catalog-1');
    expect(patch.totalPages).toBe(CHAPTER_COUNT);
    // Must not clobber the cover or the better Google Books metadata.
    expect(patch.coverUrl).toBeUndefined();
    expect(patch.title).toBeUndefined();
    expect(patch.author).toBeUndefined();
    expect(logMessages()).toContain('Cover already exists — skipping');
  });

  it('branch B (EPUB has no embedded cover): writes totalPages plus title/author', async () => {
    findCatalogByHashMock.mockResolvedValue(catalogRow());
    parseEpubMock.mockReturnValue(epubBook({ coverImage: null }));

    await run();

    expect(updateCatalogMock).toHaveBeenCalledTimes(1);
    const [, patch] = updateCatalogMock.mock.calls[0];
    expect(patch.totalPages).toBe(CHAPTER_COUNT);
    expect(patch.title).toBe('Real EPUB Title');
    expect(patch.author).toBe('Real EPUB Author');
    expect(patch.coverUrl).toBeUndefined();
    expect(logMessages()).toContain('EPUB has no cover image — skipping');
  });

  it('branch A (cover extracted) still stores the cover alongside totalPages', async () => {
    findCatalogByHashMock.mockResolvedValue(catalogRow());
    parseEpubMock.mockReturnValue(epubBook({ coverImage: Buffer.from('img'), coverMimeType: 'image/png' }));

    await run();

    expect(updateCatalogMock).toHaveBeenCalledTimes(1);
    const [, patch] = updateCatalogMock.mock.calls[0];
    expect(patch.totalPages).toBe(CHAPTER_COUNT);
    expect(patch.coverUrl).toBe(`data:image/png;base64,${Buffer.from('img').toString('base64')}`);
    expect(patch.title).toBe('Real EPUB Title');
    expect(logMessages()).toContain('Cover extracted from EPUB metadata');
  });

  it('does not overwrite a title the user already set', async () => {
    findCatalogByHashMock.mockResolvedValue(catalogRow({ title: 'My Custom Title', author: 'My Author' }));
    parseEpubMock.mockReturnValue(epubBook());

    await run();

    const [, patch] = updateCatalogMock.mock.calls[0];
    expect(patch.title).toBeUndefined();
    expect(patch.author).toBeUndefined();
    expect(patch.totalPages).toBe(CHAPTER_COUNT);
  });

  it('warns instead of throwing when no catalog row exists for the file hash', async () => {
    findCatalogByHashMock.mockResolvedValue(null);
    parseEpubMock.mockReturnValue(epubBook());

    // orchestratePipeline dispatches on catalog.format, so an absent catalog only
    // reaches the EPUB pipeline if it disappears mid-run; simulate that by
    // answering the dispatch lookup first and the Stage 4 lookup with null.
    findCatalogByHashMock
      .mockResolvedValueOnce(catalogRow())
      .mockResolvedValueOnce(null);

    await run();

    expect(updateCatalogMock).not.toHaveBeenCalled();
    expect(logMessages()).toContain('No catalog entry for this file — skipping cover and page count');
  });
});
