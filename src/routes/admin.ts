import { Hono } from 'hono';
import { z } from 'zod';
import { bookRepository } from '../repositories/book.repository.js';
import { billingRepository } from '../repositories/billing.repository.js';
import { db } from '../db/index.js';
import { users, books, processingJobs, processingCharges } from '../db/schema.js';
import { sql, count, sum, desc, eq } from 'drizzle-orm';
import { userRepository } from '../repositories/user.repository.js';
import { Errors } from '../lib/errors.js';

export const adminRoutes = new Hono();

const uuidParamSchema = z.string().uuid('Invalid UUID format');
const jobStatusSchema = z.enum(['pending', 'processing', 'completed', 'failed']).optional();

const catalogPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

const updateCatalogSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  description: z.string().optional(),
  coverUrl: z.string().optional(),
  isbn: z.string().optional(),
  language: z.string().optional(),
  publisher: z.string().optional(),
  publishYear: z.number().int().optional(),
  categories: z.array(z.string()).optional(),
  totalPages: z.number().int().min(0).optional(),
  userCount: z.number().int().min(0).optional(),
  metadataSource: z.string().optional(),
}).strict();

// List all users
adminRoutes.get('/users', async (c) => {
  const allUsers = await db.select({
    id: users.id,
    email: users.email,
    name: users.name,
    authRole: users.authRole,
    createdAt: users.createdAt,
  }).from(users).orderBy(desc(users.createdAt));
  return c.json(allUsers);
});

// Update user role
adminRoutes.put('/users/:id/role', async (c) => {
  const userId = uuidParamSchema.parse(c.req.param('id'));
  const body = await c.req.json();
  const { role } = z.object({ role: z.enum(['admin', 'user']) }).parse(body);

  const target = await userRepository.findById(userId);
  if (!target) throw Errors.notFound('User');

  const updated = await userRepository.update(userId, { authRole: role });
  return c.json({ id: updated.id, email: updated.email, authRole: updated.authRole });
});

// List catalog entries (paginated)
adminRoutes.get('/catalog', async (c) => {
  const { page, limit, search } = catalogPaginationSchema.parse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
    search: c.req.query('search'),
  });

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
  const id = uuidParamSchema.parse(c.req.param('id'));
  const entry = await bookRepository.findCatalogById(id);
  if (!entry) throw Errors.notFound('Catalog entry');
  return c.json(entry);
});

// Update catalog entry
adminRoutes.put('/catalog/:id', async (c) => {
  const id = uuidParamSchema.parse(c.req.param('id'));
  const body = await c.req.json();
  const data = updateCatalogSchema.parse(body);
  const updated = await bookRepository.updateCatalog(id, data);
  if (!updated) throw Errors.notFound('Catalog entry');
  return c.json(updated);
});

// Delete catalog entry
adminRoutes.delete('/catalog/:id', async (c) => {
  const id = uuidParamSchema.parse(c.req.param('id'));
  const { bookCatalog } = await import('../db/schema.js');
  const [deleted] = await db.delete(bookCatalog).where(eq(bookCatalog.id, id)).returning({ id: bookCatalog.id });
  if (!deleted) throw Errors.notFound('Catalog entry');
  return c.json({ deleted: true });
});

// Add a catalog book to admin's own bookshelf (marketplace → library)
adminRoutes.post('/catalog/:id/add-to-shelf', async (c) => {
  const user = c.get('user');
  const catalogId = uuidParamSchema.parse(c.req.param('id'));
  const catalog = await bookRepository.findCatalogById(catalogId);
  if (!catalog) throw Errors.notFound('Catalog entry');

  // Check if already in user's library
  const existing = await bookRepository.findByUserIdAndCatalogId(user.id, catalogId);
  if (existing) return c.json({ book: existing, alreadyExists: true });

  const book = await bookRepository.create({
    userId: user.id,
    catalogId,
    processingStatus: 'complete',
  });
  return c.json({ book, alreadyExists: false }, 201);
});

// List processing jobs
adminRoutes.get('/jobs', async (c) => {
  const status = jobStatusSchema.parse(c.req.query('status') || undefined);

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
