CREATE INDEX "idx_books_processing_status" ON "books" USING btree ("processing_status");--> statement-breakpoint
CREATE INDEX "idx_books_deleted_at" ON "books" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "idx_chapters_deleted_at" ON "chapters" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "idx_sections_deleted_at" ON "sections" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "idx_vocabulary_word" ON "vocabulary" USING btree ("word");