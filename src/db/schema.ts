import {
  pgTable, uuid, text, integer, boolean, timestamp,
  real, bigint, jsonb, uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ============ USERS ============
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleId: text('google_id').unique(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  passwordHash: text('password_hash'),
  emailVerified: boolean('email_verified').notNull().default(false),
  authRole: text('auth_role').notNull().default('user'),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ============ OAUTH ACCOUNTS (for NextAuth account linking) ============
export const oauthAccounts = pgTable('oauth_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  expiresAt: integer('expires_at'),
  tokenType: text('token_type'),
  scope: text('scope'),
  idToken: text('id_token'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_oauth_provider_account').on(table.provider, table.providerAccountId),
  index('idx_oauth_user').on(table.userId),
]);

// ============ USER SETTINGS ============
export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  autoReadThresholdSeconds: integer('auto_read_threshold_seconds').default(5),
  defaultViewMode: text('default_view_mode').default('pdf'),
  readingMode: text('reading_mode').default('scroll'),
  trackingMode: text('tracking_mode').default('timer'),
  targetLanguage: text('target_language'),
  keymapOverrides: jsonb('keymap_overrides').default({}),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ============ BOOK CATALOG (shared, admin-only) ============
export const bookCatalog = pgTable('book_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  author: text('author'),
  description: text('description'),
  coverUrl: text('cover_url'),
  isbn: text('isbn'),
  language: text('language').default('en'),
  publisher: text('publisher'),
  publishYear: integer('publish_year'),
  categories: text('categories').array(),
  fileHash: text('file_hash').notNull().unique(),
  totalPages: integer('total_pages'),
  /** Source format of the uploaded file. 'pdf' | 'epub'. Existing rows default to 'pdf'. */
  format: text('format').notNull().default('pdf'),
  userCount: integer('user_count').notNull().default(1),
  metadataSource: text('metadata_source').notNull().default('manual'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ============ BOOKS (per-user library) ============
export const books = pgTable('books', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  catalogId: uuid('catalog_id').notNull().references(() => bookCatalog.id, { onDelete: 'restrict' }),
  customTitle: text('custom_title'),
  coverUrl: text('cover_url'),
  structureSource: text('structure_source'),
  processingStatus: text('processing_status').default('pending'),
  lastReadAt: timestamp('last_read_at'),
  lastAccessedSectionId: uuid('last_accessed_section_id'),
  lastAccessedScrollProgress: real('last_accessed_scroll_progress').default(0),
  lastAccessedWordIndex: integer('last_accessed_word_index'),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('idx_books_user_catalog').on(table.userId, table.catalogId),
  index('idx_books_user_id').on(table.userId),
  index('idx_books_user_updated').on(table.userId, table.updatedAt),
  index('idx_books_processing_status').on(table.processingStatus),
  index('idx_books_deleted_at').on(table.deletedAt),
]);

// ============ CHAPTERS ============
export const chapters = pgTable('chapters', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  startPage: integer('start_page'),
  endPage: integer('end_page'),
  sortOrder: integer('sort_order').notNull().default(0),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('idx_chapters_book_id').on(table.bookId),
  index('idx_chapters_book_sort').on(table.bookId, table.sortOrder),
  index('idx_chapters_book_updated').on(table.bookId, table.updatedAt),
  index('idx_chapters_deleted_at').on(table.deletedAt),
]);

// ============ SECTIONS ============
export const sections = pgTable('sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  chapterId: uuid('chapter_id').notNull().references(() => chapters.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  startPage: integer('start_page'),
  endPage: integer('end_page'),
  isRead: boolean('is_read').notNull().default(false),
  readAt: timestamp('read_at'),
  lastPageViewed: integer('last_page_viewed'),
  scrollProgress: real('scroll_progress').default(0),
  extractedText: text('extracted_text'),
  richContent: text('rich_content'),  // Mathpix Markdown (tables, formulas, formatted text)
  sectionType: text('section_type').notNull().default('content'),
  sortOrder: integer('sort_order').notNull().default(0),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('idx_sections_book_id').on(table.bookId),
  index('idx_sections_book_updated').on(table.bookId, table.updatedAt),
  index('idx_sections_chapter_id').on(table.chapterId),
  index('idx_sections_chapter_sort').on(table.chapterId, table.sortOrder),
  index('idx_sections_deleted_at').on(table.deletedAt),
]);

// ============ VOCABULARY ============
export const vocabulary = pgTable('vocabulary', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: uuid('book_id').references(() => books.id, { onDelete: 'set null' }),
  word: text('word').notNull(),
  pronunciation: text('pronunciation'),
  translation: text('translation'),
  targetLanguage: text('target_language'),
  definition: text('definition'),
  contextSentence: text('context_sentence'),
  explanation: text('explanation'),
  bookTitle: text('book_title'),
  sectionTitle: text('section_title'),
  page: integer('page'),
  reviewCount: integer('review_count').notNull().default(0),
  lastReviewedAt: timestamp('last_reviewed_at'),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('idx_vocabulary_user_id').on(table.userId),
  index('idx_vocabulary_user_word').on(table.userId, table.word),
  index('idx_vocabulary_user_updated').on(table.userId, table.updatedAt),
  index('idx_vocabulary_book_id').on(table.bookId),
  index('idx_vocabulary_word').on(table.word),
]);

// ============ EXERCISES (shared, linked to catalog) ============
export const exercises = pgTable('exercises', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogId: uuid('catalog_id').notNull().references(() => bookCatalog.id, { onDelete: 'cascade' }),
  chapterTitle: text('chapter_title'),
  exerciseNumber: text('exercise_number'),
  content: text('content').notNull(),
  contentLatex: text('content_latex'),
  page: integer('page'),
  exerciseType: text('exercise_type').notNull().default('problem'),
  difficulty: text('difficulty'),
  hints: jsonb('hints'),
  solutionPage: integer('solution_page'),
  sortOrder: integer('sort_order').notNull().default(0),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_exercises_catalog_id').on(table.catalogId),
]);

// ============ EXERCISE PROGRESS (per-user) ============
export const exerciseProgress = pgTable('exercise_progress', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  exerciseId: uuid('exercise_id').notNull().references(() => exercises.id, { onDelete: 'cascade' }),
  bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('not_started'),
  notes: text('notes'),
  completedAt: timestamp('completed_at'),
  timeSpentSeconds: integer('time_spent_seconds').notNull().default(0),
  metadata: jsonb('metadata').notNull().default({}),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('idx_exercise_progress_unique').on(table.userId, table.exerciseId),
  index('idx_exercise_progress_user_id').on(table.userId),
]);

// ============ NIB CACHE (shared) ============
export const nibCache = pgTable('nib_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileHash: text('file_hash').notNull().unique(),
  r2Key: text('r2_key').notNull(),
  pageCount: integer('page_count'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ============ PDF FILES (R2 references) ============
export const pdfFiles = pgTable('pdf_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileHash: text('file_hash').notNull().unique(),
  r2Key: text('r2_key').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  uploadedAt: timestamp('uploaded_at').notNull().defaultNow(),
});

// ============ PROCESSING JOBS ============
export const processingJobs = pgTable('processing_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileHash: text('file_hash').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: uuid('book_id').references(() => books.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  stage: text('stage'),
  processingCostCents: integer('processing_cost_cents'),
  paid: boolean('paid').notNull().default(false),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  error: text('error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('idx_processing_jobs_status').on(table.status, table.createdAt),
  index('idx_processing_jobs_user_id').on(table.userId),
  index('idx_processing_jobs_file_hash').on(table.fileHash),
]);

// ============ PROCESSING LOGS ============
export const processingLogs = pgTable('processing_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => processingJobs.id, { onDelete: 'cascade' }),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  level: text('level').notNull().default('info'),
  stage: text('stage').notNull(),
  message: text('message').notNull(),
}, (table) => [
  index('idx_processing_logs_job_id').on(table.jobId),
]);

// ============ WEBHOOK EVENTS (idempotency) ============
export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  stripeEventId: text('stripe_event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  status: text('status').notNull().default('processing'),
  error: text('error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ============ PROCESSING CHARGES (billing ledger) ============
export const processingCharges = pgTable('processing_charges', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id').notNull().references(() => processingJobs.id, { onDelete: 'cascade' }),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});
