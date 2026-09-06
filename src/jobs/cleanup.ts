import { db } from '../db/index.js';
import { books, chapters, sections, vocabulary, exerciseProgress, bookCatalog, pdfFiles, nibCache } from '../db/schema.js';
import { lt, gte, isNotNull, and, or, eq, isNull, count } from 'drizzle-orm';
import { storageService } from '../services/storage.service.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ORPHAN_RECLAIMS_PER_RUN = 100;
/**
 * How long a bookCatalog row must have been settled (neither created nor
 * touched) before it is eligible for orphan reclaim.
 *
 * handleUpload() writes the catalog row BEFORE uploading the file to R2 and
 * before creating the first books row, so for the whole span of an upload the
 * catalog is indistinguishable from a real orphan. Reclaiming inside that
 * window deletes the bytes the request just uploaded and makes the books
 * insert raise Postgres 23503 (books.catalog_id is onDelete 'restrict').
 *
 * An hour is far longer than any upload the platform will keep a request open
 * for, and costs nothing: the KAN-131 case this job exists for (last books row
 * hard-deleted after the 30-day window) has a catalog row that is months old,
 * so it is still reclaimed on the very next tick.
 */
const ORPHAN_GRACE_PERIOD_MS = 60 * 60 * 1000;

/**
 * Hard-delete records where deleted_at is older than 30 days.
 * Deletes in child-first order to respect foreign key constraints.
 * Then reclaims R2 objects + catalog rows for catalogs no longer referenced
 * by any books row (active OR soft-deleted).
 *
 * Per-table failures are caught and logged. setInterval cannot recover from
 * unhandled rejections — one FK violation must not crash the whole process.
 */
export async function runCleanup() {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);

  // Children first, then parents. Note: processing_jobs.book_id → books.id is
  // FK NO ACTION (see schema.ts), so books rows still referenced by a job will
  // fail to hard-delete. That's expected — log and move on.
  const deleteSoftDeleted = async (
    name: string,
    runner: () => Promise<unknown>,
  ) => {
    try {
      await runner();
    } catch (err) {
      console.error(`[cleanup] hard-delete failed for ${name}:`, err);
    }
  };

  await deleteSoftDeleted('vocabulary', () =>
    db.delete(vocabulary).where(and(isNotNull(vocabulary.deletedAt), lt(vocabulary.deletedAt, cutoff))),
  );
  await deleteSoftDeleted('exerciseProgress', () =>
    db.delete(exerciseProgress).where(and(isNotNull(exerciseProgress.deletedAt), lt(exerciseProgress.deletedAt, cutoff))),
  );
  await deleteSoftDeleted('sections', () =>
    db.delete(sections).where(and(isNotNull(sections.deletedAt), lt(sections.deletedAt, cutoff))),
  );
  await deleteSoftDeleted('chapters', () =>
    db.delete(chapters).where(and(isNotNull(chapters.deletedAt), lt(chapters.deletedAt, cutoff))),
  );
  await deleteSoftDeleted('books', () =>
    db.delete(books).where(and(isNotNull(books.deletedAt), lt(books.deletedAt, cutoff))),
  );

  try {
    const { reclaimed, skipped, deferred } = await reclaimOrphanedStorage();
    console.log(
      `Cleanup completed at ${new Date().toISOString()} — orphans reclaimed: ${reclaimed}, ` +
        `skipped (R2 failure, will retry): ${skipped}, deferred (within grace period): ${deferred}`,
    );
  } catch (err) {
    console.error('[cleanup] reclaimOrphanedStorage failed:', err);
  }
}

/**
 * Reclaim every artifact keyed by one catalog's fileHash: the R2 PDF object,
 * the R2 .nib cache object, and the pdf_files / nib_cache / book_catalog rows.
 *
 * R2 first, DB rows second, and only when every R2 delete succeeded. The
 * catalog row is the sole discovery key reclaimOrphanedStorage() scans by, so
 * dropping it while an R2 object survives strands that object forever. On a
 * partial R2 failure this leaves all three rows intact and returns false — the
 * hourly job then rediscovers the orphan and retries (R2 deletes are idempotent).
 *
 * Callers must have already established that no books row references catalogId;
 * books.catalog_id is onDelete 'restrict', so the final delete raises Postgres
 * 23503 otherwise.
 *
 * @returns true when the reclaim completed, false when it was skipped for retry.
 */
export async function reclaimCatalogStorage(catalogId: string, fileHash: string): Promise<boolean> {
  const [pdfRow] = await db.select().from(pdfFiles).where(eq(pdfFiles.fileHash, fileHash)).limit(1);

  const r2KeysToDelete = [`nibs/${fileHash}.nib.json`];
  if (pdfRow?.r2Key) r2KeysToDelete.unshift(pdfRow.r2Key);

  let allR2DeletesOk = true;
  for (const key of r2KeysToDelete) {
    try {
      await storageService.deleteObject(key);
    } catch (err) {
      allR2DeletesOk = false;
      console.error(`[cleanup] R2 delete failed for key=${key} catalogId=${catalogId}`, err);
    }
  }

  if (!allR2DeletesOk) return false;

  await db.delete(pdfFiles).where(eq(pdfFiles.fileHash, fileHash));
  await db.delete(nibCache).where(eq(nibCache.fileHash, fileHash));
  await db.delete(bookCatalog).where(eq(bookCatalog.id, catalogId));
  return true;
}

/**
 * Find bookCatalog rows that are no longer referenced by any books row
 * (including soft-deleted ones — those still protect the catalog until
 * hard-deletion) AND have been settled for at least ORPHAN_GRACE_PERIOD_MS,
 * then reclaim their R2 objects + DB rows. Only removes DB rows once every R2
 * delete for the orphan succeeded, so a failed run is retried next pass.
 *
 * The age bound is what separates a real orphan from an upload in progress.
 * Both timestamps are checked, because there are two ways a catalog can be
 * transiently unreferenced while a request is mid-flight:
 *   - a brand-new catalog (handleUpload creates it, then uploads to R2, then
 *     inserts the books row) — guarded by created_at;
 *   - an existing, currently unreferenced catalog being re-uploaded, where the
 *     userCount bump touches the row before the books insert — guarded by
 *     updated_at, which $onUpdate refreshes on that write.
 *
 * On the marketplace question this predicate is deliberate, not incidental:
 * handleUpload() is the only path in this codebase that creates a catalog row,
 * and it always goes on to create a books row, so a zero-reference catalog is
 * only ever an in-flight upload or a genuinely abandoned one. GET /admin/catalog
 * and add-to-shelf can therefore keep offering every catalog row. If a curation
 * endpoint that creates catalog entries ahead of demand is ever added, those
 * rows WOULD be reclaimed an hour later and this predicate must be revisited.
 */
export async function reclaimOrphanedStorage(): Promise<{
  reclaimed: number;
  skipped: number;
  deferred: number;
}> {
  const settledBefore = new Date(Date.now() - ORPHAN_GRACE_PERIOD_MS);
  // Built fresh per query rather than shared, so the two builders below never
  // hold a reference to the same predicate instance.
  const unreferenced = () => isNull(books.id);

  const orphans = await db
    .select({ catalogId: bookCatalog.id, fileHash: bookCatalog.fileHash, title: bookCatalog.title })
    .from(bookCatalog)
    .leftJoin(books, eq(books.catalogId, bookCatalog.id))
    .where(
      and(
        unreferenced(),
        lt(bookCatalog.createdAt, settledBefore),
        lt(bookCatalog.updatedAt, settledBefore),
      ),
    )
    .limit(MAX_ORPHAN_RECLAIMS_PER_RUN);

  // Counted separately rather than inferred, so the log distinguishes "nothing
  // to do" from "held back by the grace period" without a second guess.
  const [deferredRow] = await db
    .select({ total: count() })
    .from(bookCatalog)
    .leftJoin(books, eq(books.catalogId, bookCatalog.id))
    .where(
      and(
        unreferenced(),
        or(
          gte(bookCatalog.createdAt, settledBefore),
          gte(bookCatalog.updatedAt, settledBefore),
        ),
      ),
    );

  let reclaimed = 0;
  let skipped = 0;

  for (const { catalogId, fileHash, title } of orphans) {
    // Identify every reclaim in the log. These deletes are hard and there is no
    // other audit trail, so a bare count makes a future incident undiagnosable.
    const identity = `catalogId=${catalogId} fileHash=${fileHash} title=${JSON.stringify(title)}`;
    if (await reclaimCatalogStorage(catalogId, fileHash)) {
      reclaimed++;
      console.log(`[cleanup] reclaimed orphaned catalog ${identity}`);
    } else {
      skipped++;
      console.warn(`[cleanup] deferred reclaim after R2 failure, will retry ${identity}`);
    }
  }

  return { reclaimed, skipped, deferred: deferredRow?.total ?? 0 };
}
