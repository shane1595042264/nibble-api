CREATE TABLE "processing_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"stage" text NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "book_id" uuid;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "processing_logs" ADD CONSTRAINT "processing_logs_job_id_processing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_processing_logs_job_id" ON "processing_logs" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;