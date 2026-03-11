import { Hono } from 'hono';
import { z } from 'zod';
import { bookRepository } from '../repositories/book.repository.js';
import { billingRepository } from '../repositories/billing.repository.js';
import { db } from '../db/index.js';
import { users, books, processingJobs, processingCharges } from '../db/schema.js';
import { sql, count, sum } from 'drizzle-orm';

export const adminRoutes = new Hono();

// List catalog entries (paginated)
adminRoutes.get('/catalog', async (c) => {
  const page = parseInt(c.req.query('page') ?? '1');
  const limit = parseInt(c.req.query('limit') ?? '20');
  const search = c.req.query('search');

  // Use bookRepository catalog methods
  if (search) {
    const results = await bookRepository.findCatalogByFuzzyTitle(search);
    return c.json({ data: results, page, total: results.length });
  }

  // For paginated listing, query directly
  const { bookCatalog } = await import('../db/schema.js');
  const offset = (page - 1) * limit;
  const data = await db.select().from(bookCatalog).limit(limit).offset(offset);
  const [{ total }] = await db.select({ total: count() }).from(bookCatalog);
  return c.json({ data, page, total });
});

// Get catalog entry detail
adminRoutes.get('/catalog/:id', async (c) => {
  const entry = await bookRepository.findCatalogById(c.req.param('id'));
  if (!entry) return c.json({ error: 'Not found' }, 404);
  return c.json(entry);
});

// Update catalog entry
adminRoutes.put('/catalog/:id', async (c) => {
  const body = await c.req.json();
  const updated = await bookRepository.updateCatalog(c.req.param('id'), body);
  return c.json(updated);
});

// Delete catalog entry
adminRoutes.delete('/catalog/:id', async (c) => {
  const { bookCatalog } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  await db.delete(bookCatalog).where(eq(bookCatalog.id, c.req.param('id')));
  return c.json({ deleted: true });
});

// List processing jobs
adminRoutes.get('/jobs', async (c) => {
  const status = c.req.query('status');
  const { eq, desc } = await import('drizzle-orm');

  let jobs;
  if (status) {
    jobs = await db.select().from(processingJobs).where(eq(processingJobs.status, status)).orderBy(desc(processingJobs.createdAt)).limit(50);
  } else {
    jobs = await db.select().from(processingJobs).orderBy(desc(processingJobs.createdAt)).limit(50);
  }
  return c.json(jobs);
});

// Usage stats
adminRoutes.get('/stats', async (c) => {
  const [userCount] = await db.select({ total: count() }).from(users);
  const [bookCount] = await db.select({ total: count() }).from(books);
  const [jobCount] = await db.select({ total: count() }).from(processingJobs);
  const [revenue] = await db.select({
    total: sum(processingCharges.amountCents)
  }).from(processingCharges);

  return c.json({
    totalUsers: userCount.total,
    totalBooks: bookCount.total,
    totalProcessed: jobCount.total,
    revenueCents: revenue.total ?? 0,
  });
});
