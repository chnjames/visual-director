/**
 * 画布试运行记录（docs/11 附录 A · runs）。
 * 单次运行一份文档 + 每项目索引；不假装批量/旧单件流程的结构。
 */
import { openKey, STORE_RUNS, type SaveStatus } from './db';
import type { AuditResult } from '../shared/types';
import type { GraphStepLog } from '../workflow/graph/execute';

export type CanvasRunKind = 'node' | 'chain' | 'batch-item';
export type CanvasRunStatus = 'done' | 'failed' | 'partial';
export type RunImage = { dataUri: string; mediaType: string };

export type CanvasRun = {
  id: string;
  projectId: string;
  kind: CanvasRunKind;
  status: CanvasRunStatus;
  createdAt: string;
  nodeId?: string;
  nodeTitle?: string;
  steps: GraphStepLog[];
  message?: string;
  imageDataUri?: string;
  mediaType?: string;
  images: RunImage[];
  audit: AuditResult | null;
  recipeBound: boolean;
  callsUsed: number;
  assetIds: string[];
  workflowVersionId?: string;
  workflowVersionNo?: number;
  batchId?: string;
  itemId?: string;
  sourceKey?: string;
};

type RunIndex = { ids: string[] };

function indexKey(projectId: string) {
  return `runs:${projectId}`;
}
function runDocKey(projectId: string, runId: string) {
  return `run:${projectId}:${runId}`;
}

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function loadIndex(projectId: string): Promise<RunIndex> {
  const key = openKey<RunIndex>(STORE_RUNS, indexKey(projectId));
  const raw = await key.load((d) => d as RunIndex);
  return raw && Array.isArray(raw.ids) ? raw : { ids: [] };
}

export async function listRuns(projectId: string): Promise<CanvasRun[]> {
  const idx = await loadIndex(projectId);
  const all: CanvasRun[] = [];
  for (const id of idx.ids) {
    const key = openKey<CanvasRun>(STORE_RUNS, runDocKey(projectId, id));
    const run = await key.load((d) => d as CanvasRun);
    if (run?.id) all.push(run);
  }
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export type RecordRunInput = {
  projectId: string;
  kind: CanvasRunKind;
  status: CanvasRunStatus;
  nodeId?: string;
  nodeTitle?: string;
  steps?: GraphStepLog[];
  message?: string;
  imageDataUri?: string;
  mediaType?: string;
  images?: RunImage[];
  audit?: AuditResult | null;
  recipeBound?: boolean;
  callsUsed?: number;
  assetIds?: string[];
  workflowVersionId?: string;
  workflowVersionNo?: number;
  batchId?: string;
  itemId?: string;
  sourceKey?: string;
};

export async function recordRun(input: RecordRunInput): Promise<CanvasRun> {
  const id = newRunId();
  const run: CanvasRun = {
    id,
    projectId: input.projectId,
    kind: input.kind,
    status: input.status,
    createdAt: new Date().toISOString(),
    nodeId: input.nodeId,
    nodeTitle: input.nodeTitle,
    steps: input.steps ?? [],
    message: input.message,
    imageDataUri: input.imageDataUri,
    mediaType: input.mediaType,
    images:
      input.images ??
      (input.imageDataUri && input.mediaType
        ? [{ dataUri: input.imageDataUri, mediaType: input.mediaType }]
        : []),
    audit: input.audit ?? null,
    recipeBound: input.recipeBound ?? false,
    callsUsed: input.callsUsed ?? 0,
    assetIds: input.assetIds ?? [],
    workflowVersionId: input.workflowVersionId,
    workflowVersionNo: input.workflowVersionNo,
    batchId: input.batchId,
    itemId: input.itemId,
    sourceKey: input.sourceKey,
  };
  const doc = openKey<CanvasRun>(STORE_RUNS, runDocKey(input.projectId, id));
  const docStatus = await doc.enqueue(run);
  if (docStatus === 'failed') {
    throw new Error('运行记录写入失败（本地存储可能已满）');
  }
  const idxKey = openKey<RunIndex>(STORE_RUNS, indexKey(input.projectId));
  const idxResult = await idxKey.enqueueMutate((prev) => {
    const ids = prev && Array.isArray(prev.ids) ? prev.ids : [];
    if (ids.includes(id)) return null;
    return { ids: [id, ...ids].slice(0, 100) };
  });
  if (idxResult.status === 'failed') {
    throw new Error('运行索引写入失败（本地存储可能已满）');
  }
  return run;
}

export async function clearRuns(projectId: string): Promise<SaveStatus | void> {
  const idx = await loadIndex(projectId);
  for (const id of idx.ids) {
    await openKey(STORE_RUNS, runDocKey(projectId, id)).enqueueClear();
  }
  await openKey(STORE_RUNS, indexKey(projectId)).enqueueClear();
}

export async function attachRunAssets(
  projectId: string,
  runId: string,
  assetIds: string[],
): Promise<CanvasRun | null> {
  const key = openKey<CanvasRun>(STORE_RUNS, runDocKey(projectId, runId));
  const result = await key.enqueueMutate((prev) => {
    if (!prev) return null;
    return { ...prev, assetIds: [...new Set([...prev.assetIds, ...assetIds])] };
  });
  return result.value;
}
