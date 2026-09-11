import { describe, it, expect, vi } from 'vitest';

// sync.service pulls in every repository (and therefore the db connection) at
// import time. resolveConflict is a pure function, so stub the lot out.
vi.mock('../../../src/repositories/book.repository.js', () => ({ bookRepository: {} }));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({ chapterRepository: {} }));
vi.mock('../../../src/repositories/section.repository.js', () => ({ sectionRepository: {} }));
vi.mock('../../../src/repositories/vocabulary.repository.js', () => ({ vocabularyRepository: {} }));
vi.mock('../../../src/repositories/settings.repository.js', () => ({ settingsRepository: {} }));
vi.mock('../../../src/repositories/exercise.repository.js', () => ({ exerciseRepository: {} }));
vi.mock('../../../src/services/knowledge-base.service.js', () => ({
  forwardVocabToKnowledgeBase: vi.fn(),
}));

const { resolveConflict } = await import('../../../src/services/sync.service.js');

const READ_AT = '2026-09-01T10:00:00.000Z';

function clientSection(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    updatedAt: '2026-09-02T10:00:00.000Z',
    isRead: false,
    readAt: null,
    scrollProgress: 0.5,
    ...over,
  };
}

function serverSection(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    updatedAt: '2026-09-01T10:00:00.000Z',
    isRead: true,
    readAt: READ_AT,
    scrollProgress: 0.5,
    ...over,
  };
}

describe('resolveConflict — isRead', () => {
  it('lets a newer client un-read a section the server has as read (KAN-299)', () => {
    const merged = resolveConflict(clientSection(), serverSection(), true);

    expect(merged.isRead).toBe(false);
    expect(merged.readAt).toBeNull();
  });

  it('keeps true-wins when the server row is newer', () => {
    const merged = resolveConflict(clientSection(), serverSection(), false);

    expect(merged.isRead).toBe(true);
    expect(merged.readAt).toEqual(new Date(READ_AT));
  });

  it('keeps true-wins on concurrent edits (equal timestamps → clientIsNewer false)', () => {
    const ts = '2026-09-02T10:00:00.000Z';
    const merged = resolveConflict(
      clientSection({ updatedAt: ts }),
      serverSection({ updatedAt: ts }),
      false,
    );

    expect(merged.isRead).toBe(true);
  });

  it('still marks read when a newer client reports isRead:true', () => {
    const merged = resolveConflict(
      clientSection({ isRead: true, readAt: READ_AT }),
      serverSection({ isRead: false, readAt: null }),
      true,
    );

    expect(merged.isRead).toBe(true);
    expect(merged.readAt).toEqual(new Date(READ_AT));
  });

  it('backfills readAt when a newer client marks read without one', () => {
    const merged = resolveConflict(
      clientSection({ isRead: true, readAt: null }),
      serverSection({ isRead: false, readAt: null }),
      true,
    );

    expect(merged.isRead).toBe(true);
    expect(merged.readAt).toBeInstanceOf(Date);
  });

  it('propagates an un-read even when the client row carries a stale readAt', () => {
    const merged = resolveConflict(
      clientSection({ isRead: false, readAt: READ_AT }),
      serverSection(),
      true,
    );

    expect(merged.isRead).toBe(false);
    expect(merged.readAt).toBeNull();
  });

  it('leaves isRead untouched when neither side has read it and the server is newer', () => {
    const merged = resolveConflict(
      clientSection(),
      serverSection({ isRead: false, readAt: null }),
      false,
    );

    expect(merged).not.toHaveProperty('isRead');
  });
});

describe('resolveConflict — scrollProgress', () => {
  it('keeps max-wins on the client-newer path', () => {
    const merged = resolveConflict(
      clientSection({ scrollProgress: 0.2 }),
      serverSection({ scrollProgress: 0.8 }),
      true,
    );

    expect(merged.scrollProgress).toBe(0.8);
  });

  it('clamps out-of-range historical rows into [0, 1]', () => {
    const merged = resolveConflict(
      clientSection({ scrollProgress: 42 }),
      serverSection({ scrollProgress: -3 }),
      true,
    );

    expect(merged.scrollProgress).toBe(1);
  });
});
