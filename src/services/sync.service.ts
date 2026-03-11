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
  syncedAt: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

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

  return merged;
}

// ─── Sync service ───────────────────────────────────────────────────

export const syncService = {
  async sync(userId: string, payload: SyncPayload): Promise<SyncResponse> {
    const since = new Date(payload.lastSyncedAt);
    const now = new Date();

    // ── 1. Apply client changes ──────────────────────────────────

    // Books
    for (const clientBook of payload.changes.books) {
      const server = await bookRepository.findById(clientBook.id);
      if (!server) {
        await bookRepository.create({
          ...clientBook,
          userId,
        } as any);
      } else {
        const clientTime = new Date(clientBook.updatedAt).getTime();
        const serverTime = new Date(server.updatedAt).getTime();
        if (clientTime > serverTime) {
          const { id, createdAt, updatedAt, ...data } = clientBook;
          if (clientBook.deletedAt) {
            await bookRepository.softDelete(clientBook.id);
          } else {
            await bookRepository.update(clientBook.id, data as any);
          }
        }
      }
    }

    // Chapters
    for (const clientChapter of payload.changes.chapters) {
      const server = await chapterRepository.findById(clientChapter.id);
      if (!server) {
        await chapterRepository.create(
          clientChapter as any,
        );
      } else {
        const clientTime = new Date(clientChapter.updatedAt).getTime();
        const serverTime = new Date(server.updatedAt).getTime();
        if (clientTime > serverTime) {
          const { id, createdAt, updatedAt, ...data } = clientChapter;
          if (clientChapter.deletedAt) {
            await chapterRepository.softDelete(clientChapter.id);
          } else {
            await chapterRepository.update(clientChapter.id, data as any);
          }
        }
      }
    }

    // Sections (with reading-progress special rule)
    for (const clientSection of payload.changes.sections) {
      const server = await sectionRepository.findById(clientSection.id);
      if (!server) {
        await sectionRepository.create(
          clientSection as any,
        );
      } else {
        const clientTime = new Date(clientSection.updatedAt).getTime();
        const serverTime = new Date(server.updatedAt).getTime();

        // Always resolve reading-progress conflicts regardless of timestamp
        const progressMerge = resolveConflict(clientSection, server);

        if (clientTime > serverTime) {
          // Client wins on general fields, but merge reading progress
          const { id, createdAt, updatedAt, ...data } = clientSection;
          if (clientSection.deletedAt) {
            await sectionRepository.softDelete(clientSection.id);
          } else {
            await sectionRepository.update(clientSection.id, {
              ...data,
              ...progressMerge,
            } as any);
          }
        } else {
          // Server wins on timestamp, but still apply reading-progress merge
          await sectionRepository.update(clientSection.id, progressMerge as any);
        }
      }
    }

    // Vocabulary
    for (const clientWord of payload.changes.vocabulary) {
      const server = await vocabularyRepository.findById(clientWord.id);
      if (!server) {
        await vocabularyRepository.create({
          ...clientWord,
          userId,
        } as any);
      } else {
        const clientTime = new Date(clientWord.updatedAt).getTime();
        const serverTime = new Date(server.updatedAt).getTime();
        if (clientTime > serverTime) {
          const { id, createdAt, updatedAt, ...data } = clientWord;
          if (clientWord.deletedAt) {
            await vocabularyRepository.softDelete(clientWord.id);
          } else {
            await vocabularyRepository.update(clientWord.id, data as any);
          }
        }
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
      const serverRecords = await exerciseRepository.findProgressByUserId(userId);
      const server = serverRecords.find((r) => r.id === clientProgress.id);
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
    const serverBooks = await bookRepository.findModifiedSince(userId, since);

    // Get book IDs to query child entities
    const userBooks = await bookRepository.findByUserId(userId);
    const allBookIds = [
      ...new Set([
        ...userBooks.map((b) => b.id),
        ...serverBooks.map((b) => b.id),
      ]),
    ];

    // Chapters & sections for all user books
    const serverChapters: SyncEntity[] = [];
    const serverSections: SyncEntity[] = [];
    for (const bookId of allBookIds) {
      const chapters = await chapterRepository.findModifiedSince(bookId, since);
      serverChapters.push(...(chapters as unknown as SyncEntity[]));
      const sections = await sectionRepository.findModifiedSince(bookId, since);
      serverSections.push(...(sections as unknown as SyncEntity[]));
    }

    // Vocabulary
    const serverVocabulary = await vocabularyRepository.findModifiedSince(userId, since);

    // Settings
    const serverSettings = await settingsRepository.findModifiedSince(userId, since);

    // Exercise progress
    const serverExerciseProgress = await exerciseRepository.findProgressModifiedSince(userId, since);

    // Exercises (server-to-client only): get all exercises for user's book catalog IDs
    const catalogIds = [...new Set(userBooks.map((b) => b.catalogId))];
    const serverExercises: SyncEntity[] = [];
    for (const catalogId of catalogIds) {
      const exercises = await exerciseRepository.findByCatalogId(catalogId);
      serverExercises.push(...(exercises as unknown as SyncEntity[]));
    }

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
      syncedAt: now.toISOString(),
    };
  },
};
