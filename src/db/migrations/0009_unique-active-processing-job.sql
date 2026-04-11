-- Add partial unique index to prevent duplicate active processing jobs per file hash
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_active_file_hash
  ON processing_jobs (file_hash)
  WHERE status IN ('pending', 'processing');
