/**
 * Job ids whose pipeline is currently running in THIS process.
 *
 * The stuck-job sweep only knows a job's updated_at, and a single slow stage
 * (a large Mathpix or OCR batch) can go 10+ minutes without a progress write.
 * Without this, the sweep would re-dispatch a pipeline that is still alive and
 * run it twice. A job that is stale AND not in here belongs to a process that
 * is gone — typically the container a redeploy just killed (KAN-340).
 */
export const inFlightJobIds = new Set<string>();
