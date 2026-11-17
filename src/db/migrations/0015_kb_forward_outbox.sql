ALTER TABLE "vocabulary" ADD COLUMN "kb_forwarded_at" timestamp;--> statement-breakpoint
ALTER TABLE "vocabulary" ADD COLUMN "kb_forward_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vocabulary" ADD COLUMN "kb_next_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "vocabulary" ADD COLUMN "kb_last_error" text;--> statement-breakpoint
-- Every row that exists today already reached the knowledge base: since the
-- 2026-05-16 cutover a row was only inserted after a successful forward. Mark
-- them all forwarded so the new kb-forward job does not re-send the library.
-- Raw SQL on purpose: updated_at must not move, or every word re-syncs.
UPDATE "vocabulary" SET "kb_forwarded_at" = "created_at" WHERE "kb_forwarded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_vocabulary_kb_pending" ON "vocabulary" USING btree ("kb_next_attempt_at") WHERE "vocabulary"."kb_forwarded_at" IS NULL AND "vocabulary"."deleted_at" IS NULL;
