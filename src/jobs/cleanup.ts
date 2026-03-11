import { db } from '../db/index.js';
import { books, chapters, sections, vocabulary, exerciseProgress } from '../db/schema.js';
import { lt, isNotNull, and } from 'drizzle-orm';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Hard-delete records where deleted_at is older than 30 days.
 * Deletes in child-first order to respect foreign key constraints.
 */
export async function runCleanup() {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);

  // Children first, then parents
  const tables = [vocabulary, exerciseProgress, sections, chapters, books];
  for (const table of tables) {
    await db.delete(table).where(
      and(isNotNull(table.deletedAt), lt(table.deletedAt, cutoff)),
    );
  }

  console.log(`Cleanup completed at ${new Date().toISOString()}`);
}
