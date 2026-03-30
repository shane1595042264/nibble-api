CREATE INDEX "idx_exercise_progress_user_id" ON "exercise_progress" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_exercises_catalog_id" ON "exercises" USING btree ("catalog_id");