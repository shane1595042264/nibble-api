CREATE INDEX "idx_chapters_book_sort" ON "chapters" USING btree ("book_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_sections_chapter_sort" ON "sections" USING btree ("chapter_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_vocabulary_user_word" ON "vocabulary" USING btree ("user_id","word");