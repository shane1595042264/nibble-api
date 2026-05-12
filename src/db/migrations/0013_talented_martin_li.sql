CREATE INDEX "idx_books_user_updated" ON "books" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_chapters_book_updated" ON "chapters" USING btree ("book_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_sections_book_updated" ON "sections" USING btree ("book_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_vocabulary_user_updated" ON "vocabulary" USING btree ("user_id","updated_at");