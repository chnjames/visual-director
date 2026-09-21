import type { Batch, BatchItem } from '../batch/batchTypes';
import { attachRunAssets, listRuns, recordRun, type CanvasRun } from './runStore';
import { upsertAsset } from './assetStore';

export function batchItemRunSourceKey(batch: Batch, item: BatchItem): string {
  return `batch:${batch.id}:item:${item.id}:retry:${item.retryCount}:state:${item.wf?.state ?? 'unknown'}`;
}

export async function persistBatchItemRun(
  projectId: string,
  batch: Batch,
  item: BatchItem,
): Promise<CanvasRun | null> {
  const wf = item.wf;
  if (!wf || !['passed', 'failed'].includes(wf.state)) return null;

  const sourceKey = batchItemRunSourceKey(batch, item);
  const existing = (await listRuns(projectId)).find((run) => run.sourceKey === sourceKey);
  if (existing) return existing;

  const latest = [...wf.attempts].reverse().find((attempt) => attempt.image || attempt.audit);
  const run = await recordRun({
    projectId,
    kind: 'batch-item',
    status: wf.state === 'passed' ? 'done' : 'failed',
    nodeTitle: item.name,
    message: wf.lastError?.message ?? latest?.audit?.statusReason,
    imageDataUri: latest?.image?.dataUri,
    mediaType: latest?.image?.mediaType,
    audit: latest?.audit ?? null,
    recipeBound: wf.recipeConfirmed,
    callsUsed: wf.callsUsed,
    workflowVersionId: batch.workflowVersionId,
    workflowVersionNo: batch.workflowVersionNo,
    batchId: batch.id,
    itemId: item.id,
    sourceKey,
  });

  const assets = [];
  for (const attempt of wf.attempts) {
    if (!attempt.image) continue;
    assets.push(
      await upsertAsset({
        projectId,
        kind: 'generated',
        name: `${item.name} · v${attempt.version}`,
        dataUri: attempt.image.dataUri,
        mediaType: attempt.image.mediaType,
        source: 'batch',
        runId: run.id,
        nodeId: 'sceneGenerator',
      }),
    );
  }
  if (assets.length) await attachRunAssets(projectId, run.id, assets.map((asset) => asset.id));
  return run;
}
