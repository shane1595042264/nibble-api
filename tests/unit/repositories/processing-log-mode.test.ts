import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({ db: {} }));

const { processingLogRepository } = await import('../../../src/repositories/processing-log.repository.js');

/** Executor whose select chain yields the given processing_logs rows. */
const selecting = (rows: { message: string }[]) => ({
  select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(rows) }) }) }) }),
}) as any;

// The mode a re-run uses is read back from what recordMode wrote (KAN-396).
describe('processingLogRepository mode round trip', () => {
  it('reads back the toc-only row recordMode writes', async () => {
    let written: { stage: string; message: string } | undefined;
    const executor = { insert: () => ({ values: (v: typeof written) => { written = v; return Promise.resolve(); } }) } as any;

    await processingLogRepository.recordMode('job-1', 'toc-only', executor);
    expect(written).toMatchObject({ jobId: 'job-1', stage: 'mode' });

    expect(await processingLogRepository.getJobMode('job-1', selecting([written!]))).toBe('toc-only');
  });

  it('returns full for a job recorded as full', async () => {
    expect(await processingLogRepository.getJobMode('job-1', selecting([{ message: 'Processing mode: full' }]))).toBe('full');
  });

  it('treats a legacy job that logged the Stage 5b toc-only skip as toc-only', async () => {
    const legacy = selecting([{ message: 'TOC-only mode — skipping Mathpix' }]);
    expect(await processingLogRepository.getJobMode('job-1', legacy)).toBe('toc-only');
  });

  it('returns full for a legacy job with no mode row', async () => {
    expect(await processingLogRepository.getJobMode('job-1', selecting([]))).toBe('full');
  });
});
