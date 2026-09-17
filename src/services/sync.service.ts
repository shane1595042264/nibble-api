import { bookRepository } from '../repositories/book.repository.js';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { sectionRepository } from '../repositories/section.repository.js';
import { vocabularyRepository } from '../repositories/vocabulary.repository.js';
import { settingsRepository } from '../repositories/settings.repository.js';
import { exerciseRepository } from '../repositories/exercise.repository.js';
import { forwardVocabToKnowledgeBase } from './knowledge-base.service.js';

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
    exerciseProgress: string[];
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

/** Append echoed tombstones the modified-since query didn't already return (once per id). */
function withTombstones<T extends { id: string }>(rows: T[], tombstones: T[]): T[] {
  const seen = new Set(rows.map((r) => r.id));
  const extra = tombstones.filter((t) => !seen.has(t.id) && seen.add(t.id));
  return [...rows, ...extra];
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

// No coverUrl: WordByWord's coverImage is usually a page-1 PNG data: URL rendered
// on-device, and it must not be written into books.cover_url on every push.
const BOOK_UPDATE_FIELDS = [
  'customTitle',
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
 * - isRead: the strictly-newer client wins (last-write-wins), so an explicit
 *   un-read propagates. Otherwise true wins over false.
 * - Higher scrollProgress always wins.
 * Returns a merged partial that should be applied on top of the winning entity.
 */
export function resolveConflict(
  clientEntity: SyncEntity,
  serverEntity: Record<string, unknown>,
  clientIsNewer: boolean,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  const clientIsRead = Boolean(clientEntity.isRead);
  const serverIsRead = Boolean(serverEntity.isRead);

  if (clientIsNewer) {
    // The client row is authoritatively newer, so read-state is last-write-wins
    // — NOT monotonic. The unconditional OR below folded an explicit
    // "Mark as Unread" back to true and echoed the flipped row out in the same
    // response's serverChanges, so the un-read could never survive a sync tick
    // on any device (KAN-299). readAt clears with it.
    merged.isRead = clientIsRead;
    merged.readAt = clientIsRead ? clientEntity.readAt ?? new Date() : null;
  } else if (clientIsRead || serverIsRead) {
    // Server row is newer, or the two are concurrent (equal timestamps) — the
    // client has no fresher claim, so keep the monotonic true-wins bias.
    // This is what stops a stale device from un-reading a section.
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

  // scrollProgress: higher value wins, clamped to [0, 1] to self-heal any
  // historical out-of-range rows that predate the sync route's Zod guard.
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const clientScroll = clamp(Number(clientEntity.scrollProgress ?? 0));
  const serverScroll = clamp(Number(serverEntity.scrollProgress ?? 0));
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
      exerciseProgress: [] as string[],
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
    // chapterId -> bookId for every chapter a pushed section may attach to. Security: only
    // chapters under a book this user owns (plus chapters this push creates, added below),
    // so a section can't be inserted under another user's chapter.
    const parentChapterBookIds = new Map(
      existingChapters.filter((c) => existingBookIdSet.has(c.bookId)).map((c) => [c.id, c.bookId]),
    );

    // Pre-load exercise progress into a Map for O(1) lookup by id
    const serverProgressRecords = await exerciseRepository.findProgressByUserId(userId);
    const serverProgressMap = new Map(serverProgressRecords.map((r) => [r.id, r]));

    // Pre-load all client entity IDs into batch queries for O(1) lookups (fixes N+1)
    const clientBookIds = payload.changes.books.map((b) => b.id).filter(isValidUuid);
    const clientChapterIds = payload.changes.chapters.map((c) => c.id).filter(isValidUuid);
    const clientSectionIds = payload.changes.sections.map((s) => s.id).filter(isValidUuid);
    const clientVocabIds = payload.changes.vocabulary.map((v) => v.id).filter(isValidUuid);

    // Soft-deleted rows are included so a stale client's push of a row the server
    // has already deleted is recognised as a tombstone, not mistaken for a new row
    // whose INSERT hits the primary key and is failed/re-queued on every sync.
    const [serverBooksArr, serverChaptersArr, serverSectionsArr, serverVocabArr] = await Promise.all([
      bookRepository.findByIds(clientBookIds, { includeDeleted: true }),
      chapterRepository.findByIds(clientChapterIds, { includeDeleted: true }),
      sectionRepository.findByIds(clientSectionIds, { includeDeleted: true }),
      vocabularyRepository.findByIds(clientVocabIds, { includeDeleted: true }),
    ]);

    const serverBookMap = new Map(serverBooksArr.map((b) => [b.id, b]));
    const serverChapterMap = new Map(serverChaptersArr.map((c) => [c.id, c]));
    const serverSectionMap = new Map(serverSectionsArr.map((s) => [s.id, s]));
    const serverVocabMap = new Map(serverVocabArr.map((v) => [v.id, v]));

    // The delete wins: a pushed id whose server row is soft-deleted is not written
    // and not failed. Its tombstone is echoed back in serverChanges (step 2) even if
    // it predates lastSyncedAt, so the stale client drops its copy (KAN-229 intent).
    const tombstones = {
      books: [] as typeof serverBooksArr,
      chapters: [] as typeof serverChaptersArr,
      sections: [] as typeof serverSectionsArr,
      vocabulary: [] as typeof serverVocabArr,
    };

    // Books
    const createdBookIds = new Set<string>();
    for (const clientBook of payload.changes.books) {
      try {
        if (!isValidUuid(clientBook.id)) continue;
        const tombstone = serverBookMap.get(clientBook.id);
        if (tombstone?.deletedAt) {
          if (tombstone.userId === userId) tombstones.books.push(tombstone);
          continue;
        }
        const coerced = coerceDates(clientBook);
        const server = serverBookMap.get(clientBook.id) ?? null;
        if (!server) {
          // catalogId (NOT NULL) is only needed to create the row. WordByWord never
          // creates books through sync — uploads go through /books — so bookToSync
          // doesn't send it; requiring it for updates made them unreachable.
          if (!isValidUuid(clientBook.catalogId)) continue;
          await bookRepository.create({
            ...pickFields(coerced, BOOK_CREATE_FIELDS),
            userId,
          } as any);
          createdBookIds.add(clientBook.id);
        } else {
          // Security: skip books not owned by the authenticated user
          if (server.userId !== userId) continue;
          const clientTime = new Date(clientBook.updatedAt).getTime();
          const serverTime = new Date(server.updatedAt).getTime();
          if (clientTime > serverTime) {
            if (clientBook.deletedAt) {
              await bookRepository.softDelete(clientBook.id);
            } else {
              const data = pickFields(coerced, BOOK_UPDATE_FIELDS);
              // A uuid column fed from the reader's URL segment: a junk value would throw
              // and re-queue the book on every sync, so drop just that field.
              if (data.lastAccessedSectionId != null && !isValidUuid(data.lastAccessedSectionId)) {
                delete data.lastAccessedSectionId;
              }
              await bookRepository.update(clientBook.id, data as any);
            }
          }
        }
      } catch (e) {
        console.error('[sync] book error:', clientBook.id, e);
        failedEntities.books.push(clientBook.id);
      }
    }

    // After processing books, update the existence set so child entities aren't skipped.
    // Security: a pushed id is client-controlled, so it only unlocks its children if
    // this push created the book or its live server row belongs to this user.
    for (const clientBook of payload.changes.books) {
      if (!isValidUuid(clientBook.id)) continue;
      const server = serverBookMap.get(clientBook.id);
      const owned = createdBookIds.has(clientBook.id) || (server?.userId === userId && !server.deletedAt);
      if (clientBook.deletedAt || !owned) {
        existingBookIdSet.delete(clientBook.id);
      } else {
        existingBookIdSet.add(clientBook.id);
      }
    }

    // Chapters
    for (const clientChapter of payload.changes.chapters) {
      try {
        if (!isValidUuid(clientChapter.id)) continue;
        const tombstone = serverChapterMap.get(clientChapter.id);
        if (tombstone?.deletedAt) {
          tombstones.chapters.push(tombstone); // ownership is checked before the echo
          continue;
        }
        // Skip if the book doesn't exist on the server (deleted or never uploaded)
        if (clientChapter.bookId && isValidUuid(clientChapter.bookId as string)) {
          if (!existingBookIdSet.has(clientChapter.bookId as string)) continue;
        }
        const coerced = coerceDates(clientChapter);
        const server = serverChapterMap.get(clientChapter.id) ?? null;
        if (!server) {
          await chapterRepository.create(coerced as any);
          const bookId = clientChapter.bookId as string;
          if (isValidUuid(bookId) && existingBookIdSet.has(bookId)) parentChapterBookIds.set(clientChapter.id, bookId);
        } else {
          // Security: server row's parent book must be owned by the authenticated user.
          // existingBookIdSet was built from books filtered by userId, so this enforces ownership.
          if (!existingBookIdSet.has(server.bookId)) continue;
          const clientTime = new Date(clientChapter.updatedAt).getTime();
          const serverTime = new Date(server.updatedAt).getTime();
          if (clientTime > serverTime) {
            // Strip bookId to prevent reparenting an owned chapter under a different book.
            const { id, bookId, createdAt, updatedAt, ...data } = coerced;
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

    // After processing chapters: a chapter this push deletes, or a tombstoned one, must not
    // become a parent for sections. A pushed id is never added here — it only counts if it
    // was loaded above under an owned book or created by the chapters loop.
    for (const clientChapter of payload.changes.chapters) {
      if (clientChapter.deletedAt || serverChapterMap.get(clientChapter.id)?.deletedAt) {
        parentChapterBookIds.delete(clientChapter.id);
      }
    }
    // A section whose chapter failed to write this push is failed too, so the client retries both.
    const failedChapterIds = new Set(failedEntities.chapters);

    // Sections (with reading-progress special rule)
    for (const clientSection of payload.changes.sections) {
      try {
        if (!isValidUuid(clientSection.id)) continue;
        const tombstone = serverSectionMap.get(clientSection.id);
        if (tombstone?.deletedAt) {
          tombstones.sections.push(tombstone); // ownership is checked before the echo
          continue;
        }
        // Skip if the book doesn't exist on the server
        if (clientSection.bookId && isValidUuid(clientSection.bookId as string)) {
          if (!existingBookIdSet.has(clientSection.bookId as string)) continue;
        }
        // Skip unless chapterId is a live chapter of this section's own (owned) book. A new
        // section is inserted with bookId/chapterId verbatim, and both FKs would accept a
        // foreign chapter or a chapter of a different book.
        const parentBookId = parentChapterBookIds.get(clientSection.chapterId as string);
        if (parentBookId === undefined || parentBookId !== clientSection.bookId) {
          if (failedChapterIds.has(clientSection.chapterId as string)) failedEntities.sections.push(clientSection.id);
          continue;
        }
        const coerced = coerceDates(clientSection);
        const server = serverSectionMap.get(clientSection.id) ?? null;
        if (!server) {
          await sectionRepository.create(coerced as any);
        } else {
          // Security: server row's parent book must be owned by the authenticated user.
          // Guards both the client-newer write AND the server-newer progressMerge write below.
          if (!existingBookIdSet.has(server.bookId)) continue;
          const clientTime = new Date(clientSection.updatedAt).getTime();
          const serverTime = new Date(server.updatedAt).getTime();

          // Always resolve reading-progress conflicts, but let the resolver know
          // which side is newer so an explicit un-read from a fresher client can win.
          const progressMerge = resolveConflict(clientSection, server, clientTime > serverTime);

          if (clientTime > serverTime) {
            // Client wins on general fields, but merge reading progress.
            // progressMerge stays spread AFTER data: on this path it echoes the
            // client's own isRead/readAt, and scrollProgress max-wins must land last.
            // Strip bookId / chapterId to prevent reparenting.
            const { id, bookId, chapterId, createdAt, updatedAt, ...data } = coerced;
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
        // Checked before the knowledge-base forward below: a deleted word must
        // never be re-forwarded (it would be, on every sync, before failing).
        const tombstone = serverVocabMap.get(clientWord.id);
        if (tombstone?.deletedAt) {
          if (tombstone.userId === userId) tombstones.vocabulary.push(tombstone);
          continue;
        }
        // Skip if the referenced book doesn't exist on the server
        if (clientWord.bookId && isValidUuid(clientWord.bookId as string)) {
          if (!existingBookIdSet.has(clientWord.bookId as string)) continue;
        }
        const coerced = coerceDates(clientWord);
        const server = serverVocabMap.get(clientWord.id) ?? null;
        if (!server) {
          // 2026-05-16: forward NEW vocab captures up to the personal-website
          // knowledge base. We still write a local row so the sync bookkeeping
          // (server-changes for incremental pulls, dirty-flag clearing on the
          // client) keeps working — but the user-facing source of truth for
          // vocab is now the knowledge base, not this PG table.
          //
          // If the forward fails the local insert is skipped and the entry is
          // pushed onto failedEntities so the WordByWord sync layer re-bumps
          // updatedAt and retries on the next tick. That preserves the
          // local-first guarantee: IndexedDB still has the word; it just
          // hasn't reached the knowledge base yet.
          try {
            await forwardVocabToKnowledgeBase({
              word: String(clientWord.word ?? ''),
              pronunciation: (clientWord.pronunciation as string) ?? undefined,
              translation: (clientWord.translation as string) ?? undefined,
              targetLanguage: (clientWord.targetLanguage as string) ?? undefined,
              definition: (clientWord.definition as string) ?? undefined,
              contextSentence: (clientWord.contextSentence as string) ?? undefined,
              explanation: (clientWord.explanation as string) ?? undefined,
              bookTitle: (clientWord.bookTitle as string) ?? undefined,
              sectionTitle: (clientWord.sectionTitle as string) ?? undefined,
              page: (clientWord.page as number) ?? undefined,
            });
          } catch (forwardErr) {
            console.error('[sync] forward to knowledge base failed:', clientWord.id, forwardErr);
            failedEntities.vocabulary.push(clientWord.id);
            continue;
          }
          await vocabularyRepository.create({
            ...coerced,
            userId,
          } as any);
        } else {
          // Security: skip vocab not owned by the authenticated user (matches books pattern at L224).
          if (server.userId !== userId) continue;
          const clientTime = new Date(clientWord.updatedAt).getTime();
          const serverTime = new Date(server.updatedAt).getTime();
          if (clientTime > serverTime) {
            // Strip userId / bookId to prevent reparenting an owned vocab row.
            const { id, userId: _userId, bookId, createdAt, updatedAt, ...data } = coerced;
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
    // Per-entity guard: a malformed settings blob must not throw and 500 the
    // whole sync (matches the books/chapters/etc. pattern). Settings is a single
    // blob with no per-id, so on failure we log and continue — the rest of the
    // sync still completes and the client retries the settings write next tick.
    if (payload.changes.settings) {
      try {
        // Settings don't have an updatedAt in the payload; always apply (last-write-wins from client)
        await settingsRepository.upsert(userId, payload.changes.settings as any);
      } catch (e) {
        console.error('[sync] settings error:', e);
      }
    }

    // Exercise progress
    for (const clientProgress of payload.changes.exerciseProgress) {
      try {
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
      } catch (e) {
        // A malformed row (e.g. an Invalid Date completedAt that Postgres rejects)
        // must not throw and 500 the whole sync. Push the id to failedEntities so
        // the client re-bumps updatedAt and retries, matching the per-entity contract.
        console.error('[sync] exerciseProgress error:', clientProgress.id, e);
        failedEntities.exerciseProgress.push(clientProgress.id);
      }
    }

    // ── 2. Gather server changes for the client ──────────────────

    // Books modified since lastSyncedAt (includes soft-deleted), plus echoed tombstones
    const serverBooksRaw = withTombstones(await bookRepository.findModifiedSince(userId, since), tombstones.books);

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

    // Chapter/section tombstones are echoed only when their book belongs to this
    // user — the pushed ids are client-controlled, so they prove nothing.
    const tombstoneBookIds = [...new Set([...tombstones.chapters, ...tombstones.sections].map((r) => r.bookId))];
    const ownedTombstoneBookIds = new Set(
      (await bookRepository.findByIds(tombstoneBookIds, { includeDeleted: true }))
        .filter((b) => b.userId === userId)
        .map((b) => b.id),
    );
    const ownedTombstones = <T extends { bookId: string }>(rows: T[]) =>
      rows.filter((r) => ownedTombstoneBookIds.has(r.bookId));

    // Chapters & sections for all user books (batch query)
    const serverChapters = withTombstones(
      await chapterRepository.findModifiedSinceForBooks(allBookIds, since),
      ownedTombstones(tombstones.chapters),
    ) as unknown as SyncEntity[];
    const serverSections = withTombstones(
      await sectionRepository.findModifiedSinceForBooks(allBookIds, since),
      ownedTombstones(tombstones.sections),
    ) as unknown as SyncEntity[];

    // Vocabulary
    const serverVocabulary = withTombstones(await vocabularyRepository.findModifiedSince(userId, since), tombstones.vocabulary);

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
