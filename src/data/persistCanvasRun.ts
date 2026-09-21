/**
 * 试运行成功后回写 runs + assets。失败也会记一条记录（无图），方便排查。
 */
import { attachRunAssets, recordRun, type CanvasRun, type CanvasRunKind, type CanvasRunStatus } from './runStore';
import { upsertAssets } from './assetStore';
import type { AuditResult } from '../shared/types';
import type { GenerationRun, GraphStepLog } from '../workflow/graph/execute';
import { syncProjectAssetStats } from './projectStats';

export type PersistCanvasRunInput = {
  projectId: string;
  kind: CanvasRunKind;
  status: CanvasRunStatus;
  nodeId?: string;
  nodeTitle?: string;
  steps?: GraphStepLog[];
  message?: string;
  generation?: GenerationRun | null;
  /** 显式传入的生成图（与画布 lastOutputImages 同源）；优先于 generation.images */
  images?: Array<{ dataUri: string; mediaType: string }>;
  callsUsed?: number;
  workflowVersionId?: string;
  workflowVersionNo?: number;
  batchId?: string;
  itemId?: string;
  sourceKey?: string;
};

export async function persistCanvasRun(input: PersistCanvasRunInput): Promise<CanvasRun> {
  const gen = input.generation;
  const imageDataUri =
    input.images?.[0]?.dataUri ?? (gen?.ok ? gen.imageDataUri : gen?.imageDataUri);
  const mediaType =
    input.images?.[0]?.mediaType ?? (gen?.ok ? gen.mediaType : gen?.mediaType);
  const images =
    (input.images && input.images.length > 0 ? input.images : null) ??
    gen?.images ??
    (imageDataUri && mediaType ? [{ dataUri: imageDataUri, mediaType }] : []);
  const audit: AuditResult | null = gen?.ok ? gen.audit : null;
  const recipeBound = gen?.ok ? gen.recipeBound : false;
  const callsUsed = input.callsUsed ?? (gen?.callsUsed ?? 0);

  let run = await recordRun({
    projectId: input.projectId,
    kind: input.kind,
    status: input.status,
    nodeId: input.nodeId,
    nodeTitle: input.nodeTitle,
    steps: input.steps,
    message: input.message ?? (gen && !gen.ok ? gen.message : undefined),
    imageDataUri,
    mediaType,
    images,
    audit,
    recipeBound,
    callsUsed,
    workflowVersionId: input.workflowVersionId,
    workflowVersionNo: input.workflowVersionNo,
    batchId: input.batchId,
    itemId: input.itemId,
    sourceKey: input.sourceKey,
  });

  if (images.length) {
    const assets = await upsertAssets(
      images.map((image, index) => ({
        projectId: input.projectId,
        kind: 'generated' as const,
        name: input.nodeTitle
          ? `${input.nodeTitle} · ${index + 1}`
          : `试运行 ${run.id.slice(-6)} · ${index + 1}`,
        dataUri: image.dataUri,
        mediaType: image.mediaType,
        source: 'canvas-run' as const,
        runId: run.id,
        nodeId: input.nodeId,
      })),
    );
    const updated = await attachRunAssets(
      input.projectId,
      run.id,
      assets.map((asset) => asset.id),
    );
    if (updated) run = updated;
    await syncProjectAssetStats(input.projectId);
  }

  return run;
}
