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

// ============ AI: BRING YOUR OWN KEY (2026-11-17) ============
// Every model call Nibbler makes runs on the reader's own provider key, sealed
// with AES-256-GCM (src/ai/crypto.ts) and kept with their account so it works
// on every device. Ported from shaneBackend's modules/ai (SHAN-596).

/** One key per provider per user: adding a second Gemini key replaces the first. */
export const userAiKeys = pgTable('user_ai_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** 'gemini' | 'openai' | 'anthropic' | 'xai', detected from the key's format. */
  provider: text('provider').notNull(),
  /** base64(iv | tag | ciphertext). Never leaves the server. */
  keySealed: text('key_sealed').notNull(),
  /** Last four characters, to tell keys apart in Settings. */
  keyHint: text('key_hint').notNull(),
  /** Text models the key listed at its last check, cheapest first. */
  models: jsonb('models').notNull().default([]),
  /** The cheapest model that actually answered the check. */
  defaultModel: text('default_model').notNull(),
  /** Chosen in Settings; null = the cheapest that works. */
  preferredModel: text('preferred_model'),
  /** 'ok' | 'failing': flipped when the provider refuses the key mid-use. */
  status: text('status').notNull().default('ok'),
  lastError: text('last_error'),
  lastCheckedAt: timestamp('last_checked_at').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_user_ai_keys_user_provider').on(table.userId, table.provider),
]);

export const userAiSettings = pgTable('user_ai_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  /** Null: whichever working key was added first. */
  preferredProvider: text('preferred_provider'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/** Every model call made with a reader's key: the usage and cost page reads these. */
export const aiUsageEvents = pgTable('ai_usage_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  /** What the call was for: 'translate-word', 'ocr', 'toc', 'validate', ... (src/ai/service.ts AiFeature). */
  feature: text('feature').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  /** Estimated cost in millionths of a dollar at the price of that moment; null when unknown. */
  costMicroUsd: integer('cost_micro_usd'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_ai_usage_events_user_created').on(table.userId, table.createdAt),
]);

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
  // Knowledge-base forward outbox (2026-11-17). A new word is saved first and
  // forwarded to the personal-website knowledge base by src/jobs/kb-forward.ts.
  // NULL = still owed to the KB. Server-only bookkeeping: never sent to or
  // accepted from clients (see KB_OUTBOX_FIELDS in sync.service.ts), and only
  // ever written with raw SQL so it never bumps updated_at.
  kbForwardedAt: timestamp('kb_forwarded_at'),
  kbForwardAttempts: integer('kb_forward_attempts').notNull().default(0),
  /** Earliest time the forwarder may try (backoff after a failure, or a claim lease). */
  kbNextAttemptAt: timestamp('kb_next_attempt_at'),
  kbLastError: text('kb_last_error'),
}, (table) => [
  index('idx_vocabulary_user_id').on(table.userId),
  index('idx_vocabulary_user_word').on(table.userId, table.word),
  index('idx_vocabulary_user_updated').on(table.userId, table.updatedAt),
  index('idx_vocabulary_book_id').on(table.bookId),
  index('idx_vocabulary_word').on(table.word),
  // Only the (normally empty) set of words still owed to the knowledge base.
  index('idx_vocabulary_kb_pending')
    .on(table.kbNextAttemptAt)
    .where(sql`${table.kbForwardedAt} IS NULL AND ${table.deletedAt} IS NULL`),
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
