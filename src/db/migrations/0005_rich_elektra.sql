CREATE INDEX "idx_books_user_id" ON "books" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_chapters_book_id" ON "chapters" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_user_id" ON "processing_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_file_hash" ON "processing_jobs" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "idx_sections_book_id" ON "sections" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "idx_sections_chapter_id" ON "sections" USING btree ("chapter_id");--> statement-breakpoint
CREATE INDEX "idx_vocabulary_user_id" ON "vocabulary" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_vocabulary_book_id" ON "vocabulary" USING btree ("book_id");