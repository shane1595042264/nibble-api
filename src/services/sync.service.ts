import { bookRepository } from '../repositories/book.repository.js';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { sectionRepository } from '../repositories/section.repository.js';
import { vocabularyRepository } from '../repositories/vocabulary.repository.js';
import { settingsRepository } from '../repositories/settings.repository.js';
import { exerciseRepository } from '../repositories/exercise.repository.js';

// ─── Types ──────────────────────────────────────────────────────────

interface SyncEntity {
  id: string;
  updatedAt: string;
  deletedAt?: string | null;
  [key: string]: unknown;
}

interface SyncPayload {
  lastSyncedAt: string;
  changes: {
    books: SyncEntity[];
    chapters: SyncEntity[];
    sections: SyncEntity[];
    vocabulary: SyncEntity[];
    settings: Record<string, unknown> | null;
    exerciseProgress: SyncEntity[];
  };
}

interface SyncResponse {
  serverChanges: {
    books: SyncEntity[];
    chapters: SyncEntity[];
    sections: SyncEntity[];
    vocabulary: SyncEntity[];
    settings: Record<string, unknown> | null;
    exerciseProgress: SyncEntity[];
    exercises: SyncEntity[];
  };
  failedEntities: {
    books: string[];
    chapters: string[];
    sections: string[];
    vocabulary: string[];
  };
  syncedAt: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s: unknown): boolean {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Convert any timestamp-like values in an entity to Date objects for Drizzle.
 *  Handles strings, numbers (epoch ms), and null/undefined gracefully. */
function coerceDates(entity: Record<string, unknown>): Record<string, unknown> {
  const result = { ...entity };
  for (const [key, val] of Object.entries(result)) {
    // Skip non-timestamp fields
    if (!key.endsWith('At') && key !== 'deletedAt') continue;
    if (val === null || val === undefined) continue;
    if (val instanceof Date) continue;
    if (typeof val === 'string') {
      result[key] = new Date(val);
    } else if (typeof val === 'number') {
      result[key] = new Date(val);
    }
  }
  return result;
}

// Allowlists for book create/update via sync. Columns not listed here —
// processingStatus, structureSource, userId, catalogId (on update), etc. —
// are backend-managed and must not be writable by the client.
const BOOK_CREATE_FIELDS = [
  'id',
  'catalogId',
  'customTitle',
  'coverUrl',
  'lastReadAt',
  'lastAccessedSectionId',
  'lastAccessedScrollProgress',
  'lastAccessedWordIndex',
  'createdAt',
  'updatedAt',
] as const;

const BOOK_UPDATE_FIELDS = [
  'customTitle',
  'coverUrl',
  'lastReadAt',
  'lastAccessedSectionId',
  'lastAccessedScrollProgress',
  'lastAccessedWordIndex',
] as const;

function pickFields(entity: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of fields) {
    if (k in entity && entity[k] !== undefined) out[k] = entity[k];
  }
  return out;
}

/**
 * Resolve reading-progress conflicts for sections.
 * - isRead=true always wins over false, regardless of timestamp.
 * - Higher scrollProgress always wins.
 * Returns a merged partial that should be applied on top of the winning entity.
 */
function resolveConflict(
  clientEntity: SyncEntity,
  serverEntity: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  // isRead: true wins
  const clientIsRead = Boolean(clientEntity.isRead);
  const serverIsRead = Boolean(serverEntity.isRead);
  if (clientIsRead || serverIsRead) {
    merged.isRead = true;
    // Preserve the readAt from whichever side set isRead=true
    if (clientIsRead && !serverIsRead) {
      merged.readAt = clientEntity.readAt ?? new Date();
    } else if (serverIsRead && !clientIsRead) {
      merged.readAt = serverEntity.readAt;
    }
    // Both true — keep the more recent readAt
    else {
      const clientReadAt = clientEntity.readAt ? new Date(clientEntity.readAt as string).getTime() : 0;
      const serverReadAt = serverEntity.readAt ? new Date(serverEntity.readAt as string).getTime() : 0;
      merged.readAt = clientReadAt >= serverReadAt ? clientEntity.readAt : serverEntity.readAt;
    }
  }

  // scrollProgress: higher value wins
  const clientScroll = Number(clientEntity.scrollProgress ?? 0);
  const serverScroll = Number(serverEntity.scrollProgress ?? 0);
  merged.scrollProgress = Math.max(clientScroll, serverScroll);

  return coerceDates(merged);
}

// ─── Sync service ───────────────────────────────────────────────────

export const syncService = {
  async sync(userId: string, payload: SyncPayload): Promise<SyncResponse> {
    const since = new Date(payload.lastSyncedAt);

    // Per-entity push failures so the client can re-bump updatedAt and retry instead of losing the change when lastSyncedAt advances.
    const failedEntities = {
      books: [] as string[],
      chapters: [] as string[],
      sections: [] as string[],
      vocabulary: [] as string[],
    };

    // ── 1. Apply client changes ──────────────────────────────────

    // Pre-load referenced books and chapters into Sets for O(1) existence checks
    const referencedBookIds = new Set<string>();
    for (const ch of payload.changes.chapters) {
      if (ch.bookId && isValidUuid(ch.bookId as string)) referencedBookIds.add(ch.bookId as string);
    }
    for (const sec of payload.changes.sections) {
      if (sec.bookId && isValidUuid(sec.bookId as string)) referencedBookIds.add(sec.bookId as string);
    }
    for (const word of payload.changes.vocabulary) {
      if (word.bookId && isValidUuid(word.bookId as string)) referencedBookIds.add(word.bookId as string);
    }
    const existingBooks = await bookRepository.findByIds([...referencedBookIds]);
    // Security: only allow references to books owned by the authenticated user
    const ownedBooks = existingBooks.filter((b) => b.userId === userId);
    const existingBookIdSet = new Set(ownedBooks.map((b) => b.id));

    const referencedChapterIds = new Set<string>();
    for (const sec of payload.changes.sections) {
      if (sec.chapterId && isValidUuid(sec.chapterId as string)) referencedChapterIds.add(sec.chapterId as string);
    }
    const existingChapters = await chapterRepository.findByIds([...referencedChapterIds]);
    const existingChapterIdSet = new Set(existingChapters.map((c) => c.id));

    // Pre-load exercise progress into a Map for O(1) lookup by id
    const serverProgressRecords = await exerciseRepository.findProgressByUserId(userId);
    const serverProgressMap = new Map(serverProgressRecords.map((r) => [r.id, r]));

    // Pre-load all client entity IDs into batch queries for O(1) lookups (fixes N+1)
    const clientBookIds = payload.changes.books.map((b) => b.id).filter(isValidUuid);
    const clientChapterIds = payload.changes.chapters.map((c) => c.id).filter(isValidUuid);
    const clientSectionIds = payload.changes.sections.map((s) => s.id).filter(isValidUuid);
    const clientVocabIds = payload.changes.vocabulary.map((v) => v.id).filter(isValidUuid);

    const [serverBooksArr, serverChaptersArr, serverSectionsArr, serverVocabArr] = await Promise.all([
      bookRepository.findByIds(clientBookIds),
      chapterRepository.findByIds(clientChapterIds),
      sectionRepository.findByIds(clientSectionIds),
      vocabularyRepository.findByIds(clientVocabIds),
    ]);

    const serverBookMap = new Map(serverBooksArr.map((b) => [b.id, b]));
    const serverChapterMap = new Map(serverChaptersArr.map((c) => [c.id, c]));
    const serverSectionMap = new Map(serverSectionsArr.map((s) => [s.id, s]));
    const serverVocabMap = new Map(serverVocabArr.map((v) => [v.id, v]));

    // Books
    for (const clientBook of payload.changes.books) {
      try {
        if (!isValidUuid(clientBook.id)) continue;
        // Skip books without a valid catalogId (required NOT NULL field)
        if (!clientBook.catalogId || !isValidUuid(clientBook.catalogId as string)) continue;
        const coerced = coerceDates(clientBook);
        const server = serverBookMap.get(clientBook.id) ?? null;
        if (!server) {
          await bookRepository.create({
            ...pickFields(coerced, BOOK_CREATE_FIELDS),
            userId,
          } as any);
        } else {
          // Security: skip books not owned by the authenticated user
          if (server.userId !== userId) continue;
          const clientTime = new Date(clientBook.updatedAt).getTime();
          const serverTime = new Date(server.updatedAt).getTime();
          if (clientTime > serverTime) {
            if (clientBook.deletedAt) {
              await bookRepository.softDelete(clientBook.id);
            } else {
              await bookRepository.update(clientBook.id, pickFields(coerced, BOOK_UPDATE_FIELDS) as any);
            }
          }
        }
      } catch (e) {
        console.error('[sync] book error:', clientBook.id, e);
        failedEntities.books.push(clientBook.id);
      }
    }

    // After processing books, update the existence set so child entities aren't skipped
    for (const clientBook of payload.changes.books) {
      if (!isValidUuid(clientBook.id)) continue;
      if (clientBook.deletedAt) {
        existingBookIdSet.delete(clientBook.id);
      } else {
        existingBookIdSet.add(clientBook.id);
      }
    }

    // Chapters
    for (const clientChapter of payload.changes.chapters) {
      try {
        if (!isValidUuid(clientChapter.id)) continue;
        // Skip if the book doesn't exist on the server (deleted or never uploaded)
        if (clientChapter.bookId && isValidUuid(clientChapter.bookId as string)) {
          if (!existingBookIdSet.has(clientChapter.bookId as string)) continue;
        }
        const coerced = coerceDates(clientChapter);
        const server = serverChapterMap.get(clientChapter.id) ?? null;
        if (!server) {
          await chapterRepository.create(coerced as any);
        } else {
          const clientTime = new Date(clientChapter.updatedAt).getTime();
          const serverTime = new Date(server.updatedAt).getTime();
          if (clientTime > serverTime) {
            const { id, createdAt, updatedAt, ...data } = coerced;
            if (clientChapter.deletedAt) {
              await chapterRepository.softDelete(clientChapter.id);
            } else {
              await chapterRepository.update(clientChapter.id, data as any);
            }
          }
        }
      } catch (e) {
        console.error('[sync] chapter error:', clientChapter.id, e);
        failedEntities.chapters.push(clientChapter.id);
      }
    }

    // After processing chapters, update the existence set so sections aren't skipped
    for (const clientChapter of payload.changes.chapters) {
      if (!isValidUuid(clientChapter.id)) continue;
      if (clientChapter.deletedAt) {
        existingChapterIdSet.delete(clientChapter.id);
      } else {
        existingChapterIdSet.add(clientChapter.id);
      }
    }

    // Sections (with reading-progress special rule)
    for (const clientSection of payload.changes.sections) {
      try {
        if (!isValidUuid(clientSection.id)) continue;
        // Skip if the book doesn't exist on the server
        if (clientSection.bookId && isValidUuid(clientSection.bookId as string)) {
          if (!existingBookIdSet.has(clientSection.bookId as string)) continue;
        }
        // Skip if chapterId is invalid or chapter doesn't exist
        if (clientSection.chapterId && isValidUuid(clientSection.chapterId as string)) {
          if (!existingChapterIdSet.has(clientSection.chapterId as string)) continue;
        }
        const coerced = coerceDates(clientSection);
        const server = serverSectionMap.get(clientSection.id) ?? null;
        if (!server) {
          await sectionRepository.create(coerced as any);
        } else {
          const clientTime = new Date(clientSection.updatedAt).getTime();
          const serverTime = new Date(server.updatedAt).getTime();

          // Always resolve reading-progress conflicts regardless of timestamp
          const progressMerge = resolveConflict(clientSection, server);

          if (clientTime > serverTime) {
            // Client wins on general fields, but merge reading progress
            const { id, createdAt, updatedAt, ...data } = coerced;
            if (clientSection.deletedAt) {
              await sectionRepository.softDelete(clientSection.id);
            } else {
              await sectionRepository.update(clientSection.id, coerceDates({
                ...data,
                ...progressMerge,
              }) as any);
            }
          } else {
            // Server wins on timestamp, but still apply reading-progress merge
            await sectionRepository.update(clientSection.id, progressMerge as any);
          }
        }
      } catch (e) {
        console.error('[sync] section error:', clientSection.id, e);
        failedEntities.sections.push(clientSection.id);
      }
    }

    // Vocabulary
    for (const clientWord of payload.changes.vocabulary) {
      try {
        if (!isValidUuid(clientWord.id)) continue;
        // Skip if the referenced book doesn't exist on the server
        if (clientWord.bookId && isValidUuid(clientWord.bookId as string)) {
          if (!existingBookIdSet.has(clientWord.bookId as string)) continue;
        }
        const coerced = coerceDates(clientWord);
        const server = serverVocabMap.get(clientWord.id) ?? null;
        if (!server) {
          await vocabularyRepository.create({
            ...coerced,
            userId,
          } as any);
        } else {
          const clientTime = new Date(clientWord.updatedAt).getTime();
          const serverTime = new Date(server.updatedAt).getTime();
          if (clientTime > serverTime) {
            const { id, createdAt, updatedAt, ...data } = coerced;
            if (clientWord.deletedAt) {
              await vocabularyRepository.softDelete(clientWord.id);
            } else {
              await vocabularyRepository.update(clientWord.id, data as any);
            }
          }
        }
      } catch (e) {
        console.error('[sync] vocab error:', clientWord.id, e);
        failedEntities.vocabulary.push(clientWord.id);
      }
    }

    // Settings
    if (payload.changes.settings) {
      const serverSettings = await settingsRepository.findByUserId(userId);
      if (!serverSettings) {
        await settingsRepository.upsert(userId, payload.changes.settings as any);
      } else {
        // Settings don't have an updatedAt in the payload; always apply (last-write-wins from client)
        await settingsRepository.upsert(userId, payload.changes.settings as any);
      }
    }

    // Exercise progress
    for (const clientProgress of payload.changes.exerciseProgress) {
      const server = serverProgressMap.get(clientProgress.id);
      if (!server) {
        // Use upsert to handle potential exerciseId conflicts
        if (clientProgress.exerciseId && clientProgress.bookId) {
          await exerciseRepository.upsertProgress(
            userId,
            clientProgress.exerciseId as string,
            {
              bookId: clientProgress.bookId as string,
              status: clientProgress.status as string | undefined,
              notes: clientProgress.notes as string | undefined,
              completedAt: clientProgress.completedAt ? new Date(clientProgress.completedAt as string) : undefined,
              timeSpentSeconds: clientProgress.timeSpentSeconds as number | undefined,
              metadata: clientProgress.metadata as Record<string, unknown> | undefined,
            },
          );
        }
      } else {
        const clientTime = new Date(clientProgress.updatedAt).getTime();
        const serverTime = new Date(server.updatedAt).getTime();
        if (clientTime > serverTime) {
          if (clientProgress.deletedAt) {
            await exerciseRepository.softDeleteProgress(clientProgress.id);
          } else {
            await exerciseRepository.upsertProgress(
              userId,
              server.exerciseId,
              {
                bookId: server.bookId,
                status: clientProgress.status as string | undefined,
                notes: clientProgress.notes as string | undefined,
                completedAt: clientProgress.completedAt ? new Date(clientProgress.completedAt as string) : undefined,
                timeSpentSeconds: clientProgress.timeSpentSeconds as number | undefined,
                metadata: clientProgress.metadata as Record<string, unknown> | undefined,
              },
            );
          }
        }
      }
    }

    // ── 2. Gather server changes for the client ──────────────────

    // Books modified since lastSyncedAt (includes soft-deleted)
    const serverBooksRaw = await bookRepository.findModifiedSince(userId, since);

    // Get book IDs to query child entities
    const userBooks = await bookRepository.findByUserId(userId);

    // Enrich books with totalPages from book_catalog
    const allCatalogIds = [...new Set([
      ...serverBooksRaw.map((b) => b.catalogId),
      ...userBooks.map((b) => b.catalogId),
    ])];
    const catalogs = await bookRepository.findCatalogByIds(allCatalogIds);
    const catalogMap = new Map(catalogs.map((c) => [c.id, c]));
    const serverBooks = serverBooksRaw.map((b) => ({
      ...b,
      totalPages: catalogMap.get(b.catalogId)?.totalPages ?? 0,
    }));
    const allBookIds = [
      ...new Set([
        ...userBooks.map((b) => b.id),
        ...serverBooks.map((b) => b.id),
      ]),
    ];

    // Chapters & sections for all user books (batch query)
    const serverChapters = await chapterRepository.findModifiedSinceForBooks(allBookIds, since) as unknown as SyncEntity[];
    const serverSections = await sectionRepository.findModifiedSinceForBooks(allBookIds, since) as unknown as SyncEntity[];

    // Vocabulary
    const serverVocabulary = await vocabularyRepository.findModifiedSince(userId, since);

    // Settings
    const serverSettings = await settingsRepository.findModifiedSince(userId, since);

    // Exercise progress
    const serverExerciseProgress = await exerciseRepository.findProgressModifiedSince(userId, since);

    // Exercises (server-to-client only): get all exercises for user's book catalog IDs (batch query)
    const catalogIds = [...new Set(userBooks.map((b) => b.catalogId))];
    const serverExercises = await exerciseRepository.findByCatalogIds(catalogIds) as unknown as SyncEntity[];

    // ── 3. Return response ───────────────────────────────────────

    return {
      serverChanges: {
        books: serverBooks as unknown as SyncEntity[],
        chapters: serverChapters,
        sections: serverSections,
        vocabulary: serverVocabulary as unknown as SyncEntity[],
        settings: serverSettings as Record<string, unknown> | null,
        exerciseProgress: serverExerciseProgress as unknown as SyncEntity[],
        exercises: serverExercises,
      },
      failedEntities,
      syncedAt: new Date().toISOString(),
    };
  },
};
