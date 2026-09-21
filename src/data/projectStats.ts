import type { Batch } from '../batch/batchTypes';
import type { BatchJob } from '../batch/jobTypes';
import { latestGeneratedAsset, listAssets } from './assetStore';
import { updateProject, type ProjectStatus } from './projectStore';

export async function syncProjectStats(projectId: string, batch: Batch): Promise<void> {
  const assets = await listAssets(projectId);
  const generated = assets.filter((asset) => asset.kind === 'generated');
  const dataUris = new Set(generated.map((asset) => asset.dataUri));
  for (const item of batch.items) {
    for (const attempt of item.wf?.attempts ?? []) {
      if (attempt.image) dataUris.add(attempt.image.dataUri);
    }
  }

  const awaitingReviewCount = batch.items.filter((item) => item.awaiting !== null).length;
  let status: ProjectStatus = 'draft';
  if (batch.status === 'running' || batch.status === 'paused' || batch.status === 'system-paused' || awaitingReviewCount) {
    status = 'running';
  } else if (dataUris.size > 0) {
    status = 'completed';
  } else if (batch.recipeConfirmed) {
    status = 'recipe-ready';
  }

  await updateProject(projectId, {
    status,
    generatedCount: dataUris.size,
    awaitingReviewCount,
    coverAssetId: latestGeneratedAsset(generated)?.id,
  });
}

export async function syncBatchJobProjectStats(
  projectId: string,
  job: BatchJob,
): Promise<void> {
  const assets = await listAssets(projectId);
  const generated = assets.filter((asset) => asset.kind === 'generated');
  const awaitingReviewCount = job.rows.filter((row) =>
    ['running', 'waiting-user'].includes(row.status),
  ).length;
  let status: ProjectStatus = 'draft';
  if (job.status === 'running' || job.status === 'paused' || awaitingReviewCount) {
    status = 'running';
  } else if (generated.length) {
    status = 'completed';
  } else if (job.workflowVersionId) {
    status = 'recipe-ready';
  }
  await updateProject(projectId, {
    status,
    generatedCount: generated.length,
    awaitingReviewCount,
    coverAssetId: latestGeneratedAsset(generated)?.id,
  });
}

export async function syncProjectAssetStats(projectId: string): Promise<void> {
  const assets = await listAssets(projectId);
  const generated = assets.filter((asset) => asset.kind === 'generated');
  if (!generated.length) return;
  await updateProject(projectId, {
    status: 'completed',
    generatedCount: generated.length,
    coverAssetId: latestGeneratedAsset(generated)?.id,
  });
}
