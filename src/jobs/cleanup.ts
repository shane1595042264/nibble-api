import { db } from '../db/index.js';
import { books, chapters, sections, vocabulary, exerciseProgress, bookCatalog, pdfFiles, nibCache } from '../db/schema.js';
import { lt, isNotNull, and, eq, isNull } from 'drizzle-orm';
import { storageService } from '../services/storage.service.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ORPHAN_RECLAIMS_PER_RUN = 100;

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
    const { reclaimed, skipped } = await reclaimOrphanedStorage();
    console.log(`Cleanup completed at ${new Date().toISOString()} — orphans reclaimed: ${reclaimed}, skipped: ${skipped}`);
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
 * Find bookCatalog rows no longer referenced by any books row (including
 * soft-deleted ones — those still protect the catalog until hard-deletion)
 * and reclaim their R2 objects + DB rows. Only removes DB rows once every R2
 * delete for the orphan succeeded, so a failed run is retried next pass.
 */
async function reclaimOrphanedStorage(): Promise<{ reclaimed: number; skipped: number }> {
  const orphans = await db
    .select({ catalogId: bookCatalog.id, fileHash: bookCatalog.fileHash })
    .from(bookCatalog)
    .leftJoin(books, eq(books.catalogId, bookCatalog.id))
    .where(isNull(books.id))
    .limit(MAX_ORPHAN_RECLAIMS_PER_RUN);

  let reclaimed = 0;
  let skipped = 0;

  for (const { catalogId, fileHash } of orphans) {
    if (await reclaimCatalogStorage(catalogId, fileHash)) {
      reclaimed++;
    } else {
      skipped++;
    }
  }

  return { reclaimed, skipped };
}
