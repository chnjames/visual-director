import { useCallback, useEffect, useRef, useState } from 'react';
import { clearWorkflow, loadWorkflow, saveWorkflow } from '../data/db';
import { confirmFeature, rejectFeature } from '../shared/schema';
import type { ModelSettings, UploadedImage } from '../shared/types';
import {
  analyze,
  applyRepairAndRegenerate,
  confirmIdentity,
  confirmRecipe,
  createWorkflow,
  currentRepairHighRisk,
  dismissInterruption,
  generateFirst,
  humanAccept,
  proposeRepair,
  resumeWorkflow,
} from '../workflow/orchestrator';
import type { SingleItemWorkflow } from '../workflow/workflowTypes';

export type WorkflowBusy =
  | 'analyzing'
  | 'generating'
  | 'repair-propose'
  | 'repair-apply'
  | null;

export function useSingleItemWorkflow(projectId?: string) {
  const [wf, setWf] = useState<SingleItemWorkflow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<WorkflowBusy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const wfRef = useRef<SingleItemWorkflow | null>(null);
  wfRef.current = wf;
  // 项目切换时重新装载；key 用于避免旧项目的异步加载写回新项目
  const loadKey = projectId ?? '__default__';

  // 初次加载：进行中状态一律转为 interrupted（不伪装运行）
  useEffect(() => {
    let alive = true;
    setWf(null);
    setLoaded(false);
    loadWorkflow(projectId).then((stored) => {
      if (!alive) return;
      if (stored) setWf(resumeWorkflow(stored));
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  useEffect(() => {
    if (wf) void saveWorkflow(wf, projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf, loadKey]);

  const update = useCallback((next: SingleItemWorkflow) => {
    setActionError(null);
    setWf(next);
  }, []);

  /**
   * 画布检查器编辑未开始草稿的素材/用途。
   * 仅在尚无配方与生成结果时允许，防止用新素材覆盖已确认事实。
   */
  const patchDraftInputs = useCallback(
    (patch: {
      referenceImages?: SingleItemWorkflow['referenceImages'];
      productImages?: SingleItemWorkflow['productImages'];
      taskPurpose?: string;
    }): SingleItemWorkflow | null => {
      const cur = wfRef.current;
      if (cur) {
        if (cur.recipe || cur.attempts.length > 0) return cur;
        const next = { ...cur, ...patch };
        update(next);
        return next;
      }
      // 尚无草稿：仅当确实带了素材或非空用途时才创建
      const hasRefs = (patch.referenceImages?.length ?? 0) > 0;
      const hasProds = (patch.productImages?.length ?? 0) > 0;
      const hasPurpose = (patch.taskPurpose ?? '').trim().length > 0;
      if (!hasRefs && !hasProds && !hasPurpose) return null;
      const draft = createWorkflow({
        referenceImages: patch.referenceImages ?? [],
        productImages: patch.productImages ?? [],
        taskPurpose: patch.taskPurpose ?? '',
      });
      update(draft);
      return draft;
    },
    [update],
  );

  const guard = useCallback((message: string) => {
    setActionError(message);
  }, []);

  const start = useCallback(
    (input: {
      referenceImages: UploadedImage[];
      productImages: UploadedImage[];
      taskPurpose: string;
      name?: string;
    }) => {
      try {
        update(createWorkflow(input));
        return true;
      } catch (e) {
        guard((e as Error).message);
        return false;
      }
    },
    [guard, update],
  );

  const runAnalyze = useCallback(
    async (settings: ModelSettings | null) => {
      const cur = wfRef.current;
      if (!cur || busy) return;
      setBusy('analyzing');
      try {
        update(await analyze(cur, settings));
      } catch (e) {
        guard((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [busy, guard, update],
  );

  const doConfirmRecipe = useCallback(() => {
    const cur = wfRef.current;
    if (!cur) return;
    try {
      update(confirmRecipe(cur));
    } catch (e) {
      guard((e as Error).message);
    }
  }, [guard, update]);

  const setFeature = useCallback(
    (id: string, status: 'confirmed' | 'rejected') => {
      const cur = wfRef.current;
      if (!cur) return;
      const identityFeatures = cur.identityFeatures.map((f) => {
        if (f.id !== id) return f;
        return status === 'confirmed' ? confirmFeature(f) : rejectFeature(f);
      });
      update({ ...cur, identityFeatures });
    },
    [update],
  );

  const finishIdentityLock = useCallback(() => {
    const cur = wfRef.current;
    if (!cur) return;
    update(confirmIdentity(cur));
  }, [update]);

  const generate = useCallback(
    async (settings: ModelSettings | null) => {
      const cur = wfRef.current;
      if (!cur || busy) return;
      setBusy('generating');
      try {
        update(await generateFirst(cur, settings));
      } catch (e) {
        guard((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [busy, guard, update],
  );

  const accept = useCallback(() => {
    const cur = wfRef.current;
    if (!cur) return;
    try {
      update(humanAccept(cur));
    } catch (e) {
      guard((e as Error).message);
    }
  }, [guard, update]);

  const requestRepair = useCallback(
    async (settings: ModelSettings | null) => {
      const cur = wfRef.current;
      if (!cur || busy) return;
      setBusy('repair-propose');
      try {
        update(await proposeRepair(cur, settings));
      } catch (e) {
        guard((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [busy, guard, update],
  );

  const applyRepair = useCallback(
    async (settings: ModelSettings | null) => {
      const cur = wfRef.current;
      if (!cur || busy) return;
      setBusy('repair-apply');
      try {
        update(await applyRepairAndRegenerate(cur, settings));
      } catch (e) {
        guard((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [busy, guard, update],
  );

  const reset = useCallback(async () => {
    await clearWorkflow(projectId);
    setWf(null);
    setActionError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  const resume = useCallback(() => {
    const cur = wfRef.current;
    if (!cur) return;
    try {
      update(dismissInterruption(cur));
    } catch (e) {
      guard((e as Error).message);
    }
  }, [guard, update]);

  const highRisk = wf ? currentRepairHighRisk(wf) : false;

  return {
    wf,
    loaded,
    busy,
    actionError,
    highRisk,
    start,
    runAnalyze,
    confirmRecipe: doConfirmRecipe,
    setFeature,
    finishIdentityLock,
    generate,
    accept,
    requestRepair,
    applyRepair,
    resume,
    reset,
    patchDraftInputs,
  };
}
