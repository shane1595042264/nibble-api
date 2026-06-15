import { describe, it, expect } from 'vitest';
import { createChapterSchema, updateChapterSchema } from '../../../src/routes/chapters.js';
import {
  createSectionSchema,
  updateSectionSchema,
  SECTION_TITLE_MAX,
  SECTION_TYPE_MAX,
  SECTION_EXTRACTED_TEXT_MAX,
} from '../../../src/routes/sections.js';
import { updateMetadataSchema } from '../../../src/routes/books.js';
import { chapterBoundsSchema, sectionBoundsSchema } from '../../../src/routes/sync.js';

const validBookId = '11111111-1111-4111-8111-111111111111';
const validChapterId = '22222222-2222-4222-8222-222222222222';

describe('chapters schemas', () => {
  it('createChapterSchema accepts a 500-char title', () => {
    const r = createChapterSchema.safeParse({ bookId: validBookId, title: 'a'.repeat(500) });
    expect(r.success).toBe(true);
  });

  it('createChapterSchema rejects a 501-char title', () => {
    const r = createChapterSchema.safeParse({ bookId: validBookId, title: 'a'.repeat(501) });
    expect(r.success).toBe(false);
  });

  it('updateChapterSchema rejects a 501-char title', () => {
    const r = updateChapterSchema.safeParse({ title: 'a'.repeat(501) });
    expect(r.success).toBe(false);
  });

  it('updateChapterSchema accepts no fields (all optional)', () => {
    expect(updateChapterSchema.safeParse({}).success).toBe(true);
  });

  it('createChapterSchema accepts a valid positive range', () => {
    const r = createChapterSchema.safeParse({
      bookId: validBookId,
      title: 'ok',
      startPage: 1,
      endPage: 10,
    });
    expect(r.success).toBe(true);
  });

  it('createChapterSchema rejects startPage = 0', () => {
    const r = createChapterSchema.safeParse({
      bookId: validBookId,
      title: 'ok',
      startPage: 0,
      endPage: 5,
    });
    expect(r.success).toBe(false);
  });

  it('createChapterSchema rejects negative startPage', () => {
    const r = createChapterSchema.safeParse({
      bookId: validBookId,
      title: 'ok',
      startPage: -10,
      endPage: 5,
    });
    expect(r.success).toBe(false);
  });

  it('createChapterSchema rejects negative endPage', () => {
    const r = createChapterSchema.safeParse({
      bookId: validBookId,
      title: 'ok',
      startPage: 1,
      endPage: -1,
    });
    expect(r.success).toBe(false);
  });

  it('createChapterSchema rejects startPage > endPage', () => {
    const r = createChapterSchema.safeParse({
      bookId: validBookId,
      title: 'ok',
      startPage: 50,
      endPage: 1,
    });
    expect(r.success).toBe(false);
  });

  it('createChapterSchema accepts only startPage (endPage undefined)', () => {
    const r = createChapterSchema.safeParse({
      bookId: validBookId,
      title: 'ok',
      startPage: 1,
    });
    expect(r.success).toBe(true);
  });

  it('updateChapterSchema rejects startPage = 0', () => {
    expect(updateChapterSchema.safeParse({ startPage: 0 }).success).toBe(false);
  });

  it('updateChapterSchema rejects negative endPage', () => {
    expect(updateChapterSchema.safeParse({ endPage: -3 }).success).toBe(false);
  });

  it('updateChapterSchema accepts only one positive page field', () => {
    expect(updateChapterSchema.safeParse({ startPage: 5 }).success).toBe(true);
    expect(updateChapterSchema.safeParse({ endPage: 5 }).success).toBe(true);
  });
});

describe('sections schemas', () => {
  const basePost = { bookId: validBookId, chapterId: validChapterId };

  it('createSectionSchema accepts max-length title and sectionType', () => {
    const r = createSectionSchema.safeParse({
      ...basePost,
      title: 'a'.repeat(SECTION_TITLE_MAX),
      sectionType: 'b'.repeat(SECTION_TYPE_MAX),
    });
    expect(r.success).toBe(true);
  });

  it('createSectionSchema rejects over-limit title', () => {
    const r = createSectionSchema.safeParse({
      ...basePost,
      title: 'a'.repeat(SECTION_TITLE_MAX + 1),
    });
    expect(r.success).toBe(false);
  });

  it('createSectionSchema rejects over-limit sectionType', () => {
    const r = createSectionSchema.safeParse({
      ...basePost,
      title: 'ok',
      sectionType: 'b'.repeat(SECTION_TYPE_MAX + 1),
    });
    expect(r.success).toBe(false);
  });

  it('updateSectionSchema accepts max-length extractedText', () => {
    const r = updateSectionSchema.safeParse({
      extractedText: 'a'.repeat(SECTION_EXTRACTED_TEXT_MAX),
    });
    expect(r.success).toBe(true);
  });

  it('updateSectionSchema rejects over-limit extractedText', () => {
    const r = updateSectionSchema.safeParse({
      extractedText: 'a'.repeat(SECTION_EXTRACTED_TEXT_MAX + 1),
    });
    expect(r.success).toBe(false);
  });

  it('updateSectionSchema rejects over-limit title', () => {
    const r = updateSectionSchema.safeParse({ title: 'a'.repeat(SECTION_TITLE_MAX + 1) });
    expect(r.success).toBe(false);
  });

  it('updateSectionSchema rejects over-limit sectionType', () => {
    const r = updateSectionSchema.safeParse({ sectionType: 'b'.repeat(SECTION_TYPE_MAX + 1) });
    expect(r.success).toBe(false);
  });
});

describe('sync route bounds schemas (per-entity pre-filter)', () => {
  it('chapterBoundsSchema accepts a 500-char title', () => {
    expect(
      chapterBoundsSchema.safeParse({ id: 'x', updatedAt: 'now', title: 'a'.repeat(500) }).success,
    ).toBe(true);
  });

  it('chapterBoundsSchema rejects a 501-char title', () => {
    expect(
      chapterBoundsSchema.safeParse({ id: 'x', updatedAt: 'now', title: 'a'.repeat(501) }).success,
    ).toBe(false);
  });

  it('sectionBoundsSchema rejects a 2_000_001-char extractedText', () => {
    expect(
      sectionBoundsSchema.safeParse({
        id: 'x',
        updatedAt: 'now',
        extractedText: 'a'.repeat(2_000_001),
      }).success,
    ).toBe(false);
  });

  it('sectionBoundsSchema rejects a 2_000_001-char richContent', () => {
    expect(
      sectionBoundsSchema.safeParse({
        id: 'x',
        updatedAt: 'now',
        richContent: 'a'.repeat(2_000_001),
      }).success,
    ).toBe(false);
  });

  it('sectionBoundsSchema accepts a 2_000_000-char richContent', () => {
    expect(
      sectionBoundsSchema.safeParse({
        id: 'x',
        updatedAt: 'now',
        richContent: 'a'.repeat(2_000_000),
      }).success,
    ).toBe(true);
  });

  it('sectionBoundsSchema rejects a 101-char sectionType', () => {
    expect(
      sectionBoundsSchema.safeParse({
        id: 'x',
        updatedAt: 'now',
        sectionType: 'b'.repeat(101),
      }).success,
    ).toBe(false);
  });

  it('sectionBoundsSchema passthrough preserves extra fields', () => {
    const r = sectionBoundsSchema.safeParse({
      id: 'x',
      updatedAt: 'now',
      bookId: 'b',
      chapterId: 'c',
      isRead: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as any).bookId).toBe('b');
      expect((r.data as any).isRead).toBe(true);
    }
  });

  it('chapterBoundsSchema accepts a valid positive range', () => {
    const r = chapterBoundsSchema.safeParse({
      id: 'x',
      updatedAt: 'now',
      startPage: 1,
      endPage: 10,
    });
    expect(r.success).toBe(true);
  });

  it('chapterBoundsSchema rejects startPage = 0', () => {
    const r = chapterBoundsSchema.safeParse({
      id: 'x',
      updatedAt: 'now',
      startPage: 0,
      endPage: 5,
    });
    expect(r.success).toBe(false);
  });

  it('chapterBoundsSchema rejects negative startPage', () => {
    const r = chapterBoundsSchema.safeParse({
      id: 'x',
      updatedAt: 'now',
      startPage: -1,
      endPage: 5,
    });
    expect(r.success).toBe(false);
  });

  it('chapterBoundsSchema rejects startPage > endPage', () => {
    const r = chapterBoundsSchema.safeParse({
      id: 'x',
      updatedAt: 'now',
      startPage: 50,
      endPage: 1,
    });
    expect(r.success).toBe(false);
  });

  it('chapterBoundsSchema accepts payload with no page fields (title-only legacy)', () => {
    const r = chapterBoundsSchema.safeParse({
      id: 'x',
      updatedAt: 'now',
      title: 'a chapter',
    });
    expect(r.success).toBe(true);
  });

  it('sectionBoundsSchema accepts a valid positive range', () => {
    const r = sectionBoundsSchema.safeParse({
      id: 'x',
      updatedAt: 'now',
      startPage: 1,
      endPage: 10,
    });
    expect(r.success).toBe(true);
  });

  it('sectionBoundsSchema rejects startPage = 0', () => {
    const r = sectionBoundsSchema.safeParse({
      id: 'x',
      updatedAt: 'now',
      startPage: 0,
      endPage: 5,
    });
    expect(r.success).toBe(false);
  });

  it('sectionBoundsSchema rejects negative endPage', () => {
    const r = sectionBoundsSchema.safeParse({
      id: 'x',
      updatedAt: 'now',
      startPage: 1,
      endPage: -1,
    });
    expect(r.success).toBe(false);
  });

  it('sectionBoundsSchema rejects startPage > endPage', () => {
    const r = sectionBoundsSchema.safeParse({
      id: 'x',
      updatedAt: 'now',
      startPage: 99,
      endPage: 2,
    });
    expect(r.success).toBe(false);
  });
});

describe('books updateMetadataSchema', () => {
  it('accepts a 500-char title and 2000-char description', () => {
    const r = updateMetadataSchema.safeParse({
      title: 'a'.repeat(500),
      description: 'd'.repeat(2000),
    });
    expect(r.success).toBe(true);
  });

  it('rejects 501-char title', () => {
    expect(updateMetadataSchema.safeParse({ title: 'a'.repeat(501) }).success).toBe(false);
  });

  it('rejects 2001-char description', () => {
    expect(updateMetadataSchema.safeParse({ description: 'd'.repeat(2001) }).success).toBe(false);
  });

  it('rejects 501-char author', () => {
    expect(updateMetadataSchema.safeParse({ author: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects 501-char publisher', () => {
    expect(updateMetadataSchema.safeParse({ publisher: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects 101-char language', () => {
    expect(updateMetadataSchema.safeParse({ language: 'l'.repeat(101) }).success).toBe(false);
  });
});
