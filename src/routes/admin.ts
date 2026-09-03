import { Hono } from 'hono';
import { z } from 'zod';
import { bookRepository } from '../repositories/book.repository.js';
import { billingRepository } from '../repositories/billing.repository.js';
import { db } from '../db/index.js';
import { users, books, processingJobs, processingCharges } from '../db/schema.js';
import { sql, count, sum, desc, eq } from 'drizzle-orm';
import { userRepository } from '../repositories/user.repository.js';
import { Errors, isForeignKeyViolation } from '../lib/errors.js';
import { reclaimCatalogStorage } from '../jobs/cleanup.js';

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

// Pure guard for the role-change endpoint. Returns a rejection message when a
// demotion (admin -> user) would lock everyone out of the admin surface — the
// admin demoting their own account, or removing the last remaining admin.
// Returns null when the change is safe. Promotions and no-op writes always pass.
export function roleDemotionGuardError(args: {
  role: 'admin' | 'user';
  targetId: string;
  targetRole: string;
  callerId: string;
  adminCount: number;
}): string | null {
  const { role, targetId, targetRole, callerId, adminCount } = args;
  if (role !== 'user' || targetRole !== 'admin') return null;
  if (targetId === callerId) return 'You cannot demote your own admin account';
  if (adminCount <= 1) return 'Cannot demote the last remaining admin';
  return null;
}

// Update user role
adminRoutes.put('/users/:id/role', async (c) => {
  const userId = uuidParamSchema.parse(c.req.param('id'));
  const body = await c.req.json();
  const { role } = z.object({ role: z.enum(['admin', 'user']) }).parse(body);

  const target = await userRepository.findById(userId);
  if (!target) throw Errors.notFound('User');

  // Guard the admin surface: a demotion must not lock everyone out. Only count
  // admins when the request is actually a demotion (avoids an extra query on
  // promotions / no-op writes).
  if (role === 'user' && target.authRole === 'admin') {
    const caller = c.get('user');
    const adminCount = await userRepository.countAdmins();
    const rejection = roleDemotionGuardError({
      role,
      targetId: target.id,
      targetRole: target.authRole,
      callerId: caller.id,
      adminCount,
    });
    if (rejection) throw Errors.conflict(rejection);
  }

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

  const { bookCatalog } = await import('../db/schema.js');
  const offset = (page - 1) * limit;

  // Use bookRepository catalog methods
  if (search) {
    // findCatalogByFuzzyTitle returns the full ranked match set (capped at
    // MAX_LIST_ROWS). Paginate over it here so search behaves like browse:
    // total is the true match count, data is the requested page slice.
    const results = await bookRepository.findCatalogByFuzzyTitle(search);
    return c.json({ data: results.slice(offset, offset + limit), page, total: results.length });
  }

  // Browse: order by createdAt desc so paging is deterministic (without an
  // ORDER BY, limit/offset returns arbitrary rows and pages can overlap/skip).
  const data = await db
    .select()
    .from(bookCatalog)
    .orderBy(desc(bookCatalog.createdAt))
    .limit(limit)
    .offset(offset);
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

// Delete catalog entry — reclaims the R2 PDF + .nib objects and the
// pdf_files / nib_cache rows keyed by this catalog's fileHash before dropping
// the catalog row itself. Deleting the row alone destroys the only key the
// hourly reclaimer discovers orphans by, stranding those artifacts forever.
adminRoutes.delete('/catalog/:id', async (c) => {
  const id = uuidParamSchema.parse(c.req.param('id'));
  const catalog = await bookRepository.findCatalogById(id);
  if (!catalog) throw Errors.notFound('Catalog entry');

  // books.catalogId is onDelete 'restrict', so deleting a catalog someone still
  // has on their shelf raises Postgres 23503 and surfaces as an opaque 500.
  // Pre-flight the FK for an actionable 409, mirroring the createBook guard.
  const referencingBooks = await bookRepository.countByCatalogId(id);
  if (referencingBooks > 0) {
    throw Errors.conflict(
      `Catalog entry is still referenced by ${referencingBooks} book${referencingBooks === 1 ? '' : 's'} and cannot be deleted`,
    );
  }

  let reclaimed: boolean;
  try {
    reclaimed = await reclaimCatalogStorage(id, catalog.fileHash);
  } catch (err) {
    // The pre-flight count is not atomic with the delete: a book added to a
    // shelf in between makes the final catalog delete raise 23503. Report the
    // real cause instead of a 500.
    if (isForeignKeyViolation(err)) {
      throw Errors.conflict('Catalog entry was added to a library while it was being deleted');
    }
    throw err;
  }

  // An R2 delete failed, so reclaimCatalogStorage left every row intact for the
  // hourly job to retry. Nothing was deleted — don't report success.
  if (!reclaimed) throw Errors.storageReclaimFailed();

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
