import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../../src/db/schema.js';
import { sql } from 'drizzle-orm';

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nibble_test';
const client = postgres(TEST_DB_URL);
export const testDb = drizzle(client, { schema });

export async function cleanDb() {
  await testDb.execute(sql`TRUNCATE users, user_settings, book_catalog, books, chapters, sections, vocabulary, exercises, exercise_progress, nib_cache, pdf_files, processing_jobs, processing_charges CASCADE`);
}

export async function createTestUser(overrides?: Partial<typeof schema.users.$inferInsert>) {
  const [user] = await testDb.insert(schema.users).values({
    email: `test-${Date.now()}@example.com`,
    name: 'Test User',
    authRole: 'user',
    ...overrides,
  }).returning();
  return user;
}
