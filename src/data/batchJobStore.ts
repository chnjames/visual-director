import type { BatchJob } from '../batch/jobTypes';
import { normalizeBatchJob } from '../batch/jobTypes';
import { openKey, STORE_BATCH, type SaveStatus } from './db';

function key(projectId: string) {
  return `batch-v2:${projectId}`;
}

export async function loadBatchJob(projectId: string): Promise<BatchJob | null> {
  const stored = await openKey<BatchJob>(STORE_BATCH, key(projectId)).load((raw) => {
    const normalized = normalizeBatchJob(raw, projectId);
    if (!normalized) throw new Error('invalid batch job');
    return normalized;
  });
  if (!stored) return null;
  if (stored.status !== 'running') return stored;
  return {
    ...stored,
    status: 'paused',
    rows: stored.rows.map((row) =>
      row.status === 'running'
        ? {
            ...row,
            status: 'pending',
            currentStep: undefined,
            error: '页面重新加载，已安全暂停；请手动继续',
          }
        : row,
    ),
  };
}

export function saveBatchJob(job: BatchJob): Promise<SaveStatus> {
  return openKey<BatchJob>(STORE_BATCH, key(job.projectId)).enqueue(job);
}

export function clearBatchJob(projectId: string): Promise<void> {
  return openKey<BatchJob>(STORE_BATCH, key(projectId)).enqueueClear();
}
