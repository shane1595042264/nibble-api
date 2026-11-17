import { bookRepository } from '../repositories/book.repository.js';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { sectionRepository } from '../repositories/section.repository.js';
import { vocabularyRepository } from '../repositories/vocabulary.repository.js';
import { settingsRepository } from '../repositories/settings.repository.js';
import { exerciseRepository } from '../repositories/exercise.repository.js';
import { notifyNewVocabSaved } from '../jobs/kb-forward-signal.js';

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
  pullCursor?: PullCursor;
}

/**
 * Where the next pull page starts, per entity: the last id sent. Only chapters
 * and sections are paged (one book can carry thousands of sections); an entity
 * missing from the cursor is finished.
 */
interface PullCursor {
  chapters?: string;
  sections?: string;
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
  /** Set while chapters/sections remain past this page; echo it back with the same lastSyncedAt. */
  pullCursor: PullCursor | null;
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

// Allowlist for book updates via sync. Columns not listed here —
// processingStatus, structureSource, userId, catalogId, etc. —
// are backend-managed and must not be writable by the client.
// No coverUrl: WordByWord's coverImage is usually a page-1 PNG data: URL rendered
// on-device, and it must not be written into books.cover_url on every push.
const BOOK_UPDATE_FIELDS = [
  'customTitle',
  'lastReadAt',
  'lastAccessedSectionId',
  'lastAccessedScrollProgress',
  'lastAccessedWordIndex',
] as const;

// Knowledge-base outbox bookkeeping on vocabulary rows (src/jobs/kb-forward.ts).
// Server-only: stripped from every row sent to a client and from every row a
// client pushes, so no device can mark a word forwarded (or owed) by itself.
export const KB_OUTBOX_FIELDS = ['kbForwardedAt', 'kbForwardAttempts', 'kbNextAttemptAt', 'kbLastError'] as const;

export function withoutKbOutboxFields<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row };
  for (const k of KB_OUTBOX_FIELDS) delete (out as Record<string, unknown>)[k];
  return out;
}

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

/**
 * True when writing a resolveConflict() merge would change the stored section.
 * scroll_progress is a `real` (float4) column, so compare at that precision: the
 * client's double never equals the float the server hands back.
 */
export function progressMergeChanges(
  merge: Record<string, unknown>,
  server: Record<string, unknown>,
): boolean {
  const time = (v: unknown) => (v == null ? null : new Date(v as string | Date).getTime());
  if ('isRead' in merge && Boolean(merge.isRead) !== Boolean(server.isRead)) return true;
  if ('readAt' in merge && time(merge.readAt) !== time(server.readAt)) return true;
  return Math.fround(Number(merge.scrollProgress)) !== Math.fround(Number(server.scrollProgress ?? 0));
}

// The returned syncedAt is backed off by this much: a concurrent write stamps
// updatedAt (JS clock, or Postgres now() for inserts) before its commit is
// visible to our reads, so a row stamped just before the watermark can still
// be missing from them. Re-pulling the last second once is harmless.
const WATERMARK_SAFETY_MS = 1000;

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
          // Sync never creates books. WordByWord's only create path is POST
          // /books/upload, which needs the file bytes. Creating a row for any
          // client-supplied catalogId shelved another user's private upload and
          // unlocked GET /books/:id/download for it (KAN-390).
          continue;
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
    // its live server row belongs to this user.
    for (const clientBook of payload.changes.books) {
      if (!isValidUuid(clientBook.id)) continue;
      const server = serverBookMap.get(clientBook.id);
      const owned = server?.userId === userId && !server.deletedAt;
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
          } else if (progressMergeChanges(progressMerge, server)) {
            // Server wins on timestamp, but still apply reading-progress merge.
            // Skipped when the merge changes nothing: the write bumps updated_at,
            // the pull hands the row back, and the client re-pushes it at that new
            // stamp on every later sync, forever (KAN-406).
            await sectionRepository.update(clientSection.id, progressMerge as any);
          }
        }
      } catch (e) {
        console.error('[sync] section error:', clientSection.id, e);
        failedEntities.sections.push(clientSection.id);
      }
    }

    // Vocabulary
    let savedNewVocab = false;
    for (const clientWord of payload.changes.vocabulary) {
      try {
        if (!isValidUuid(clientWord.id)) continue;
        // Checked before the new-word insert below: a deleted word must never be
        // re-created, because a new row is owed to the knowledge base and would
        // be forwarded again.
        const tombstone = serverVocabMap.get(clientWord.id);
        if (tombstone?.deletedAt) {
          if (tombstone.userId === userId) tombstones.vocabulary.push(tombstone);
          continue;
        }
        // Skip if the referenced book doesn't exist on the server
        if (clientWord.bookId && isValidUuid(clientWord.bookId as string)) {
          if (!existingBookIdSet.has(clientWord.bookId as string)) continue;
        }
        const coerced = withoutKbOutboxFields(coerceDates(clientWord));
        const server = serverVocabMap.get(clientWord.id) ?? null;
        if (!server) {
          // Every NEW word still has to reach the personal-website knowledge
          // base (the user-facing source of truth since 2026-05-16), but it no
          // longer happens inside this request. Since 2026-11-17 the word is
          // saved here first with kb_forwarded_at NULL (= owed to the KB), and
          // src/jobs/kb-forward.ts forwards it in the background, retrying with
          // backoff until the KB accepts it. Before, the forward ran inline
          // with a 10s timeout and a slow KB failed the word, so the client
          // showed "Sync failed" and re-pushed it until the KB answered in time.
          await vocabularyRepository.create({
            ...coerced,
            userId,
          } as any);
          savedNewVocab = true;
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
    // Start forwarding now rather than at the next sweep. Fire-and-forget: the
    // response never waits on the knowledge base.
    if (savedNewVocab) notifyNewVocabSaved();

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

    // The client's next pull starts here, so take it BEFORE the reads below (not
    // in a transaction): a write landing while they run must stay after it.
    const syncedAt = new Date(Date.now() - WATERMARK_SAFETY_MS);

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

    // Chapters & sections for all user books, one page each. A capped result
    // used to be cut at an arbitrary 5000 rows with the client's watermark still
    // advancing past the rest, so they never arrived (KAN-397). A continuation
    // request (the client echoing pullCursor) gets only the rows past its cursor;
    // everything else already came with the first page.
    const cursor = payload.pullCursor;
    const noPage = { rows: [], nextAfterId: null };
    const chapterPage = cursor && !cursor.chapters
      ? noPage
      : await chapterRepository.findModifiedSinceForBooks(allBookIds, since, cursor?.chapters);
    const sectionPage = cursor && !cursor.sections
      ? noPage
      : await sectionRepository.findModifiedSinceForBooks(allBookIds, since, cursor?.sections);
    const serverChapters = withTombstones(chapterPage.rows, ownedTombstones(tombstones.chapters)) as unknown as SyncEntity[];
    const serverSections = withTombstones(sectionPage.rows, ownedTombstones(tombstones.sections)) as unknown as SyncEntity[];
    const nextCursor: PullCursor = {
      ...(chapterPage.nextAfterId ? { chapters: chapterPage.nextAfterId } : {}),
      ...(sectionPage.nextAfterId ? { sections: sectionPage.nextAfterId } : {}),
    };
    const pullCursor = Object.keys(nextCursor).length > 0 ? nextCursor : null;

    if (cursor) {
      return {
        serverChanges: {
          books: [], chapters: serverChapters, sections: serverSections,
          vocabulary: [], settings: null, exerciseProgress: [], exercises: [],
        },
        failedEntities,
        syncedAt: syncedAt.toISOString(),
        pullCursor,
      };
    }

    // Vocabulary
    const serverVocabulary = withTombstones(await vocabularyRepository.findModifiedSince(userId, since), tombstones.vocabulary)
      .map((row) => withoutKbOutboxFields(row as unknown as Record<string, unknown>));

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
      syncedAt: syncedAt.toISOString(),
      pullCursor,
    };
  },
};
