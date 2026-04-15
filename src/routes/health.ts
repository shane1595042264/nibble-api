import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

const DB_TIMEOUT_MS = 3000;

export const healthRoutes = new Hono();

healthRoutes.get('/', async (c) => {
  const timestamp = new Date().toISOString();

  try {
    await Promise.race([
      db.execute(sql`SELECT 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB ping timed out')), DB_TIMEOUT_MS)
      ),
    ]);

    return c.json({ status: 'ok', database: 'ok', timestamp });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ status: 'degraded', database: message, timestamp }, 503);
  }
});
