import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveBatchInputContract,
  isBatchRunnableVersion,
  type BatchInputContract,
} from '../batch/batchInputContract';
import {
  createBatchJob,
  createBatchRow,
  emptySharedInputs,
  type BatchJob,
  type BatchSharedInputs,
} from '../batch/jobTypes';
import { clearBatchJob, loadBatchJob, saveBatchJob } from '../data/batchJobStore';
import { loadBatch } from '../data/db';
import { upsertAsset } from '../data/assetStore';
import { persistCanvasRun } from '../data/persistCanvasRun';
import { persistBatchItemRun } from '../data/persistBatchItemRun';
import { syncBatchJobProjectStats } from '../data/projectStats';
import { listVersions, type WorkflowVersion } from '../data/versionStore';
import type { ModelSettings, UploadedImage } from '../shared/types';
import { isImageConfigured, isTextConfigured } from '../shared/security';
import { runWorkflowVersion, type WorkflowBindings } from '../workflow/runtime';

function selectedVersion(
  versions: WorkflowVersion[],
  workflowVersionId: string | null,
): WorkflowVersion | undefined {
  return versions.find((version) => version.id === workflowVersionId);
}

function contractOf(version: WorkflowVersion | undefined): BatchInputContract | null {
  if (!version) return null;
  return deriveBatchInputContract(version.graph, version.plan);
}

function applyVersionDefaults(
  shared: BatchSharedInputs,
  contract: BatchInputContract,
): BatchSharedInputs {
  return {
    ...shared,
    purpose:
      shared.purpose ||
      contract.defaultPurpose ||
      (contract.shared.purpose ? 'main-scene' : ''),
    positivePrompt: shared.positivePrompt || contract.defaultPositivePrompt,
  };
}

function validateReady(
  job: BatchJob,
  contract: BatchInputContract,
): string | null {
  if (!job.rows.length) return '请至少添加一行商品';
  if (contract.shared.referenceImages && job.shared.referenceImages.length < 1) {
    return '请先上传本批共用的参考图';
  }
  if (contract.shared.purpose && !job.shared.purpose.trim()) {
    return '请填写参考图用途';
  }
  if (contract.shared.positivePrompt && !job.shared.positivePrompt.trim()) {
    return '请填写本批共用的提示词（可先在画布分析后再粘贴，或直接手写）';
  }
  const missingProducts = job.rows.find((row) => !row.productImages.length);
  if (missingProducts) return `“${missingProducts.name}”还没有商品图`;
  return null;
}

function bindingsForRow(
  job: BatchJob,
  row: BatchJob['rows'][number],
  contract: BatchInputContract,
): WorkflowBindings {
  const rowPrompt = row.overrides.positivePrompt?.trim();
  const sharedPrompt = job.shared.positivePrompt.trim();
  const positivePrompt =
    rowPrompt ||
    sharedPrompt ||
    (contract.defaultPositivePrompt || undefined);

  return {
    productImages: row.productImages,
    ...(contract.shared.referenceImages
      ? { referenceImages: job.shared.referenceImages }
      : {}),
    ...(contract.shared.purpose || job.shared.purpose
      ? { purpose: job.shared.purpose.trim() || undefined }
      : {}),
    ...(positivePrompt ? { positivePrompt } : {}),
    ...(row.overrides.targetUse ? { targetUse: row.overrides.targetUse } : {}),
    ...(row.overrides.aspectRatio ? { aspectRatio: row.overrides.aspectRatio } : {}),
    ...(row.overrides.resolution ? { resolution: row.overrides.resolution } : {}),
    ...(row.overrides.count ? { count: row.overrides.count } : {}),
  };
}

export function useBatchJob(projectId: string) {
  const [job, setJob] = useState<BatchJob>(() => createBatchJob(projectId));
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const jobRef = useRef(job);
  const runningRef = useRef(false);
  const pauseRef = useRef(false);
  const statsQueueRef = useRef<Promise<void>>(Promise.resolve());

  const commit = useCallback(
    (next: BatchJob) => {
      const touched = { ...next, updatedAt: new Date().toISOString() };
      jobRef.current = touched;
      setJob(touched);
      void saveBatchJob(touched);
      statsQueueRef.current = statsQueueRef.current
        .catch(() => undefined)
        .then(() => syncBatchJobProjectStats(projectId, touched));
      return touched;
    },
    [projectId],
  );

  useEffect(() => {
    let alive = true;
    Promise.all([loadBatchJob(projectId), listVersions(projectId), loadBatch(projectId)]).then(
      ([stored, published, legacyBatch]) => {
        if (!alive) return;
        const runnable = published.filter((version) =>
          isBatchRunnableVersion(version.graph, version.plan),
        );
        setVersions(runnable);
        const initial = stored ?? createBatchJob(projectId);
        const selectedExists = runnable.some(
          (version) => version.id === initial.workflowVersionId,
        );
        let next =
          !selectedExists && runnable[0]
            ? {
                ...initial,
                workflowVersionId: runnable[0].id,
                workflowVersionNo: runnable[0].versionNo,
              }
            : initial;
        const version = selectedVersion(runnable, next.workflowVersionId);
        const contract = contractOf(version);
        if (contract) {
          next = { ...next, shared: applyVersionDefaults(next.shared, contract) };
        }
        jobRef.current = next;
        setJob(next);
        setLoaded(true);
        if (legacyBatch) {
          for (const item of legacyBatch.items) {
            if (item.wf && ['passed', 'failed'].includes(item.wf.state)) {
              void persistBatchItemRun(projectId, legacyBatch, item);
            }
          }
        }
      },
    );
    return () => {
      alive = false;
      pauseRef.current = true;
    };
  }, [projectId]);

  const version = selectedVersion(versions, job.workflowVersionId);
  const contract = useMemo(() => contractOf(version), [version]);

  const selectVersion = useCallback(
    (versionId: string) => {
      const nextVersion = versions.find((candidate) => candidate.id === versionId);
      if (!nextVersion || jobRef.current.status === 'running') return;
      const nextContract = deriveBatchInputContract(nextVersion.graph, nextVersion.plan);
      commit({
        ...jobRef.current,
        workflowVersionId: nextVersion.id,
        workflowVersionNo: nextVersion.versionNo,
        status: 'draft',
        shared: applyVersionDefaults(emptySharedInputs(), nextContract),
        rows: jobRef.current.rows.map((row) => ({
          ...row,
          status: 'pending',
          runId: undefined,
          resultCount: 0,
          error: undefined,
        })),
      });
    },
    [commit, versions],
  );

  const patchShared = useCallback(
    (patch: Partial<BatchSharedInputs>) => {
      if (jobRef.current.status === 'running') return;
      commit({
        ...jobRef.current,
        status: jobRef.current.status === 'completed' ? 'draft' : jobRef.current.status,
        shared: { ...jobRef.current.shared, ...patch },
      });
    },
    [commit],
  );

  const setSharedReferenceImages = useCallback(
    (images: UploadedImage[]) => {
      patchShared({ referenceImages: images });
      for (const image of images) {
        void upsertAsset({
          projectId,
          kind: 'reference',
          name: image.name,
          dataUri: image.dataUri,
          mediaType: image.mediaType,
          source: 'batch',
        });
      }
    },
    [patchShared, projectId],
  );

  const addRow = useCallback(() => {
    commit({
      ...jobRef.current,
      status: 'draft',
      rows: [...jobRef.current.rows, createBatchRow(jobRef.current.rows.length)],
    });
  }, [commit]);

  const removeRow = useCallback(
    (rowId: string) => {
      if (jobRef.current.status === 'running') return;
      commit({
        ...jobRef.current,
        rows: jobRef.current.rows.filter((row) => row.id !== rowId),
      });
    },
    [commit],
  );

  const patchRow = useCallback(
    (rowId: string, patch: Partial<BatchJob['rows'][number]>) => {
      commit({
        ...jobRef.current,
        status: jobRef.current.status === 'completed' ? 'draft' : jobRef.current.status,
        rows: jobRef.current.rows.map((row) =>
          row.id === rowId
            ? {
                ...row,
                ...patch,
                status:
                  patch.status ??
                  (row.status === 'done' || row.status === 'failed' ? 'pending' : row.status),
                runId: patch.runId,
                error: patch.error,
              }
            : row,
        ),
      });
    },
    [commit],
  );

  const setRowImages = useCallback(
    (rowId: string, images: UploadedImage[]) => {
      patchRow(rowId, { productImages: images, status: 'pending', runId: undefined });
      for (const image of images) {
        void upsertAsset({
          projectId,
          kind: 'product',
          name: image.name,
          dataUri: image.dataUri,
          mediaType: image.mediaType,
          source: 'batch',
        });
      }
    },
    [patchRow, projectId],
  );

  const start = useCallback(
    async (settings: ModelSettings | null) => {
      if (runningRef.current) return;
      setActionError(null);
      if (!isImageConfigured(settings)) {
        setActionError('请先配置图片通道的 API Key 和生成模型');
        return;
      }
      const current = jobRef.current;
      const currentVersion = versions.find(
        (candidate) => candidate.id === current.workflowVersionId,
      );
      if (!currentVersion) {
        setActionError('请先发布并选择可批量运行的工作流版本');
        return;
      }
      const currentContract = deriveBatchInputContract(
        currentVersion.graph,
        currentVersion.plan,
      );
      if (!currentContract.runnable) {
        setActionError(currentContract.reason ?? '所选版本不适合批量');
        return;
      }
      if (currentContract.shared.referenceImages && !isTextConfigured(settings)) {
        setActionError('该版本需要先跑参考图分析，请配置文本模型');
        return;
      }
      const readyError = validateReady(current, currentContract);
      if (readyError) {
        setActionError(readyError);
        return;
      }

      runningRef.current = true;
      pauseRef.current = false;
      commit({ ...current, status: 'running' });
      try {
        for (const row of jobRef.current.rows) {
          if (pauseRef.current) break;
          const live = jobRef.current.rows.find((candidate) => candidate.id === row.id);
          if (!live || live.status !== 'pending') continue;
          commit({
            ...jobRef.current,
            rows: jobRef.current.rows.map((candidate) =>
              candidate.id === row.id
                ? {
                    ...candidate,
                    status: 'running',
                    currentStep: '执行已发布工作流',
                    error: undefined,
                  }
                : candidate,
            ),
          });

          try {
            const result = await runWorkflowVersion({
              version: currentVersion,
              settings,
              bindings: bindingsForRow(jobRef.current, live, currentContract),
            });
            const generation = result.status === 'done' ? result.generation : null;
            if (result.status !== 'done' || !generation?.ok) {
              const message =
                result.status === 'failed'
                  ? result.message
                  : result.status === 'awaiting-confirm'
                    ? `工作流在 ${result.gate} 闸门等待确认；批量核心流程不应包含人工闸门`
                    : '工作流没有生成图片';
              const run = await persistCanvasRun({
                projectId,
                kind: 'batch-item',
                status: 'failed',
                steps: result.state.steps,
                message,
                generation,
                callsUsed: result.state.callsUsed,
                workflowVersionId: currentVersion.id,
                workflowVersionNo: currentVersion.versionNo,
                batchId: current.id,
                itemId: live.id,
                sourceKey: `${current.id}:${live.id}:retry:${live.retryCount}`,
              });
              commit({
                ...jobRef.current,
                rows: jobRef.current.rows.map((candidate) =>
                  candidate.id === live.id
                    ? {
                        ...candidate,
                        status:
                          result.status === 'awaiting-confirm' ? 'waiting-user' : 'failed',
                        currentStep: undefined,
                        error: message,
                        runId: run.id,
                      }
                    : candidate,
                ),
              });
              continue;
            }

            const run = await persistCanvasRun({
              projectId,
              kind: 'batch-item',
              status: 'done',
              steps: result.state.steps,
              generation,
              callsUsed: result.state.callsUsed,
              workflowVersionId: currentVersion.id,
              workflowVersionNo: currentVersion.versionNo,
              batchId: current.id,
              itemId: live.id,
              sourceKey: `${current.id}:${live.id}:retry:${live.retryCount}`,
            });
            commit({
              ...jobRef.current,
              rows: jobRef.current.rows.map((candidate) =>
                candidate.id === live.id
                  ? {
                      ...candidate,
                      status: 'done',
                      currentStep: undefined,
                      runId: run.id,
                      resultCount:
                        generation.images?.length ?? (generation.imageDataUri ? 1 : 0),
                    }
                  : candidate,
              ),
            });
          } catch (error) {
            commit({
              ...jobRef.current,
              rows: jobRef.current.rows.map((candidate) =>
                candidate.id === live.id
                  ? {
                      ...candidate,
                      status: 'failed',
                      currentStep: undefined,
                      error: (error as Error).message,
                    }
                  : candidate,
              ),
            });
          }
        }
      } finally {
        runningRef.current = false;
        const nextStatus = pauseRef.current
          ? 'paused'
          : jobRef.current.rows.every((row) =>
                ['done', 'failed', 'skipped', 'waiting-user'].includes(row.status),
              )
            ? 'completed'
            : 'draft';
        commit({ ...jobRef.current, status: nextStatus });
      }
    },
    [commit, projectId, versions],
  );

  const pause = useCallback(() => {
    pauseRef.current = true;
    commit({ ...jobRef.current, status: 'paused' });
  }, [commit]);

  const retry = useCallback(
    (rowId: string) => {
      commit({
        ...jobRef.current,
        status: 'draft',
        rows: jobRef.current.rows.map((row) =>
          row.id === rowId
            ? {
                ...row,
                status: 'pending',
                runId: undefined,
                error: undefined,
                resultCount: 0,
                retryCount: row.retryCount + 1,
              }
            : row,
        ),
      });
    },
    [commit],
  );

  const reset = useCallback(async () => {
    pauseRef.current = true;
    await clearBatchJob(projectId);
    const next = createBatchJob(projectId);
    const first = versions[0];
    if (first) {
      next.workflowVersionId = first.id;
      next.workflowVersionNo = first.versionNo;
      next.shared = applyVersionDefaults(
        emptySharedInputs(),
        deriveBatchInputContract(first.graph, first.plan),
      );
    }
    jobRef.current = next;
    setJob(next);
    setActionError(null);
  }, [projectId, versions]);

  const budget = useMemo(() => {
    if (!contract) return null;
    const pending = job.rows.filter((row) => row.status === 'pending' || row.status === 'running')
      .length;
    const count = pending || job.rows.length;
    return {
      perRow: contract.estimatedModelCallsPerRow,
      expected: contract.estimatedModelCallsPerRow * count,
      rowCount: count,
    };
  }, [contract, job.rows]);

  return {
    job,
    versions,
    loaded,
    actionError,
    contract,
    budget,
    selectVersion,
    patchShared,
    setSharedReferenceImages,
    addRow,
    removeRow,
    patchRow,
    setRowImages,
    start,
    pause,
    retry,
    reset,
  };
}
