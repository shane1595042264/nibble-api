ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_book_id_books_id_fk";
--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;