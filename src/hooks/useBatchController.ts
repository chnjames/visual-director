/**
 * 阶段3 批量控制器：连接批量工厂/引擎与 IndexedDB、React 状态。
 * - 加载即把进行中任务判为 interrupted（parsePersistedBatch 内已处理），绝不伪装运行；
 * - API Key 不进入该状态/持久化（Key 仍只在 sessionStorage）；
 * - 引擎按需创建，设置变化时同步给引擎。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { clearBatch, loadBatch, saveBatch } from '../data/db';
import { listVersions, type WorkflowVersion } from '../data/versionStore';
import {
  batchItemRunSourceKey,
  persistBatchItemRun,
} from '../data/persistBatchItemRun';
import { syncProjectStats } from '../data/projectStats';
import { BatchEngine } from '../batch/batchEngine';
import {
  addGroup,
  confirmBudget,
  confirmGrouping,
  confirmRecipe,
  createBatch,
  removeGroup,
  renameGroup,
  setGroupIdentityMode,
  setGroupImages,
  setRecipe,
  setTaskPurpose,
  toggleSkippedNode,
  bindWorkflowVersion,
} from '../batch/batchFactory';
import { defaultRunners } from '../workflow/orchestrator';
import type { Batch } from '../batch/batchTypes';
import type { IdentityMode } from '../batch/batchConstants';
import type { ModelSettings, UploadedImage } from '../shared/types';
import type { WorkflowNodeId } from '../workflow/workflowConstants';

export type BatchBusy = 'recipe' | 'starting' | null;

export function useBatchController(projectId?: string) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<BatchBusy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const engineRef = useRef<BatchEngine | null>(null);
  const settingsRef = useRef<ModelSettings | null>(null);
  const projectedRunsRef = useRef(new Set<string>());
  const statsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const loadKey = projectId ?? '__default__';

  useEffect(() => {
    let alive = true;
    setBatch(null);
    setLoaded(false);
    setVersions([]);
    setSelectedVersionId(null);
    engineRef.current = null;
    projectedRunsRef.current.clear();
    Promise.all([loadBatch(projectId), projectId ? listVersions(projectId) : Promise.resolve([])]).then(([stored, published]) => {
      if (!alive) return;
      if (stored) setBatch(stored);
      const runnable = published.filter((version) => version.plan);
      setVersions(runnable);
      setSelectedVersionId(stored?.workflowVersionId ?? runnable[0]?.id ?? null);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  useEffect(() => {
    if (batch) {
      void saveBatch(batch, projectId);
      if (projectId) {
        statsQueueRef.current = statsQueueRef.current
          .catch(() => undefined)
          .then(() => syncProjectStats(projectId, batch));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch, loadKey]);

  useEffect(() => {
    if (!projectId || !batch) return;
    for (const item of batch.items) {
      if (!item.wf || !['passed', 'failed'].includes(item.wf.state)) continue;
      const sourceKey = batchItemRunSourceKey(batch, item);
      if (projectedRunsRef.current.has(sourceKey)) continue;
      projectedRunsRef.current.add(sourceKey);
      void persistBatchItemRun(projectId, batch, item).catch(() => {
        projectedRunsRef.current.delete(sourceKey);
      });
    }
  }, [batch, projectId]);

  const guard = useCallback((message: string) => setActionError(message), []);
  const apply = useCallback((next: Batch | null) => {
    setActionError(null);
    setBatch(next);
  }, []);

  const selectedVersion = versions.find((version) => version.id === selectedVersionId);

  const selectedBinding = useCallback(() => {
    if (!selectedVersion?.plan) return undefined;
    return {
      id: selectedVersion.id,
      versionNo: selectedVersion.versionNo,
      checksum: selectedVersion.checksum,
      plan: selectedVersion.plan,
    };
  }, [selectedVersion]);

  const selectVersion = useCallback(
    (versionId: string) => {
      const version = versions.find((candidate) => candidate.id === versionId);
      if (!version?.plan) {
        guard('该版本没有可执行计划，请重新发布工作流');
        return;
      }
      setSelectedVersionId(versionId);
      setBatch((current) =>
        current
          ? bindWorkflowVersion(current, {
              id: version.id,
              versionNo: version.versionNo,
              checksum: version.checksum,
              plan: version.plan!,
            })
          : current,
      );
      engineRef.current = null;
    },
    [guard, versions],
  );

  const ensureEngine = useCallback(
    (snapshot: Batch, settings: ModelSettings | null): BatchEngine => {
      if (!engineRef.current) {
        engineRef.current = new BatchEngine(snapshot, settings, {
          onChange: (b) => setBatch(b),
        });
      } else {
        engineRef.current.setSettings(settings);
      }
      return engineRef.current;
    },
    [],
  );

  /* ----------------------- 准备阶段 ----------------------- */

  const setPurpose = useCallback(
    (purpose: string) => setBatch((b) => (b ? setTaskPurpose(b, purpose) : b)),
    [],
  );

  const initFromReferences = useCallback(
    (referenceImages: UploadedImage[], taskPurpose: string) => {
      apply(createBatch(referenceImages, taskPurpose, selectedBinding()));
      engineRef.current = null;
    },
    [apply, selectedBinding],
  );

  const extractRecipe = useCallback(
    async (settings: ModelSettings | null, referenceImages: UploadedImage[], taskPurpose: string) => {
      if (!settings) {
        guard('未配置 API Key / Seed Endpoint，无法提取视觉配方');
        return;
      }
      if (referenceImages.length < 1) {
        guard('请先上传 1-5 张参考图');
        return;
      }
      setBusy('recipe');
      setActionError(null);
      try {
        const binding = selectedBinding();
        if (!binding) {
          guard('请先发布并选择一个可运行的工作流版本');
          return;
        }
        let current = createBatch(referenceImages, taskPurpose, binding);
        const res = await defaultRunners.recipe(settings, referenceImages);
        if (!res.ok) {
          guard(`配方提取失败 · ${res.errorClass}：${res.message}`);
          return;
        }
        current = setRecipe(current, res.data);
        current = { ...current, prepCallsUsed: 1 };
        apply(current);
      } finally {
        setBusy(null);
      }
    },
    [apply, guard, selectedBinding],
  );

  const confirmRecipeGate = useCallback(() => {
    setBatch((b) => {
      if (!b) return b;
      try {
        return confirmRecipe(b);
      } catch (e) {
        guard((e as Error).message);
        return b;
      }
    });
  }, [guard]);

  const addItemGroup = useCallback(() => {
    setBatch((b) => {
      try {
        return b ? addGroup(b) : b;
      } catch (e) {
        guard((e as Error).message);
        return b;
      }
    });
  }, [guard]);

  const removeItemGroup = useCallback(
    (itemId: string) => setBatch((b) => (b ? removeGroup(b, itemId) : b)),
    [],
  );

  const renameItemGroup = useCallback(
    (itemId: string, name: string) => setBatch((b) => (b ? renameGroup(b, itemId, name) : b)),
    [],
  );

  const setItemImages = useCallback(
    (itemId: string, images: UploadedImage[]) =>
      setBatch((b) => (b ? setGroupImages(b, itemId, images) : b)),
    [],
  );

  const setItemIdentityMode = useCallback(
    (itemId: string, mode: IdentityMode) =>
      setBatch((b) => (b ? setGroupIdentityMode(b, itemId, mode) : b)),
    [],
  );

  const toggleNode = useCallback(
    (nodeId: WorkflowNodeId) =>
      setBatch((b) => {
        try {
          return b ? toggleSkippedNode(b, nodeId) : b;
        } catch (e) {
          guard((e as Error).message);
          return b;
        }
      }),
    [guard],
  );

  const confirmGroupingGate = useCallback(() => {
    setBatch((b) => {
      try {
        return b ? confirmGrouping(b) : b;
      } catch (e) {
        guard((e as Error).message);
        return b;
      }
    });
  }, [guard]);

  const confirmBudgetGate = useCallback(() => {
    setBatch((b) => {
      try {
        return b ? confirmBudget(b) : b;
      } catch (e) {
        guard((e as Error).message);
        return b;
      }
    });
  }, [guard]);

  const start = useCallback(
    (settings: ModelSettings | null) => {
      setBatch((b) => {
        if (!b) return b;
        try {
          const ready = b.status === 'ready' ? b : confirmBudget(b);
          settingsRef.current = settings;
          const engine = ensureEngine(ready, settings);
          engine.setSettings(settings);
          engine.start();
          return engine.getSnapshot();
        } catch (e) {
          guard((e as Error).message);
          return b;
        }
      });
    },
    [ensureEngine, guard],
  );

  /* ----------------------- 运行期 ----------------------- */

  const withEngine = useCallback(
    (fn: (engine: BatchEngine, settings: ModelSettings | null) => void, settings?: ModelSettings | null) => {
      setBatch((b) => {
        if (!b || !engineRef.current) return b;
        try {
          if (settings !== undefined) engineRef.current.setSettings(settings);
          fn(engineRef.current, settings ?? null);
          return engineRef.current.getSnapshot();
        } catch (e) {
          guard((e as Error).message);
          return b;
        }
      });
    },
    [guard],
  );

  const resumeEngineIfNeeded = useCallback(
    (settings: ModelSettings | null) => {
      setBatch((b) => {
        if (!b) return b;
        const engine = ensureEngine(b, settings);
        engine.setSettings(settings);
        return engine.getSnapshot();
      });
    },
    [ensureEngine],
  );

  const pauseAll = useCallback(() => withEngine((e) => e.pauseAll()), [withEngine]);
  const resumeAll = useCallback(
    (settings: ModelSettings | null) => {
      resumeEngineIfNeeded(settings);
      withEngine((e) => e.resumeAll(), settings);
    },
    [resumeEngineIfNeeded, withEngine],
  );
  const pauseItem = useCallback((id: string) => withEngine((e) => e.pauseItem(id)), [withEngine]);
  const resumeItem = useCallback(
    (id: string, settings: ModelSettings | null) => {
      resumeEngineIfNeeded(settings);
      withEngine((e) => e.resumeItem(id), settings);
    },
    [resumeEngineIfNeeded, withEngine],
  );
  const skipItem = useCallback((id: string) => withEngine((e) => e.skipItem(id)), [withEngine]);
  const retryItem = useCallback(
    (id: string, settings: ModelSettings | null) => {
      resumeEngineIfNeeded(settings);
      withEngine((e) => e.retryItem(id), settings);
    },
    [resumeEngineIfNeeded, withEngine],
  );
  const setFeature = useCallback(
    (id: string, featureId: string, status: 'confirmed' | 'rejected') =>
      withEngine((e) => e.setFeature(id, featureId, status)),
    [withEngine],
  );
  const confirmIdentity = useCallback(
    (id: string) => withEngine((e) => e.confirmIdentity(id, e.getSnapshot().items.find((x) => x.id === id)!.wf!.identityFeatures)),
    [withEngine],
  );
  const skipIdentity = useCallback((id: string) => withEngine((e) => e.skipIdentity(id)), [withEngine]);
  const acceptItem = useCallback((id: string) => withEngine((e) => e.acceptItem(id)), [withEngine]);
  const applyRepair = useCallback((id: string) => withEngine((e) => e.applyRepair(id)), [withEngine]);

  const reset = useCallback(async () => {
    await clearBatch(projectId);
    engineRef.current = null;
    setBatch(null);
    setActionError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  return {
    batch,
    versions,
    selectedVersionId,
    selectVersion,
    loaded,
    busy,
    actionError,
    setPurpose,
    initFromReferences,
    extractRecipe,
    confirmRecipeGate,
    addItemGroup,
    removeItemGroup,
    renameItemGroup,
    setItemImages,
    setItemIdentityMode,
    toggleNode,
    confirmGroupingGate,
    confirmBudgetGate,
    start,
    pauseAll,
    resumeAll,
    pauseItem,
    resumeItem,
    skipItem,
    retryItem,
    setFeature,
    confirmIdentity,
    skipIdentity,
    acceptItem,
    applyRepair,
    reset,
  };
}
