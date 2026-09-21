import { useCallback, useMemo } from 'react';
import { useSingleItemWorkflow, type WorkflowBusy } from './useSingleItemWorkflow';
import { isTextConfigured } from '../shared/security';
import type { ModelSettings, UploadedImage } from '../shared/types';
import type { SingleItemWorkflow } from '../workflow/workflowTypes';

export type WorkflowApi = {
  busy: WorkflowBusy;
  actionError: string | null;
  setReferenceImages: (imgs: UploadedImage[]) => void;
  setProductImages: (imgs: UploadedImage[]) => void;
  setTaskPurpose: (text: string) => void;
  runAnalyze: () => void;
  confirmRecipe: () => void;
  setFeature: (id: string, status: 'confirmed' | 'rejected') => void;
  finishIdentityLock: () => void;
  skipIdentityWithRisk: () => void;
  runGenerate: () => void;
  requestRepair: () => void;
  applyRepair: () => void;
  acceptWarning: () => void;
  reset: () => Promise<void>;
};

/**
 * 画布工作流适配：完全复用 useSingleItemWorkflow（状态机/编排器/中断恢复不变），
 * 把画布检查器所需的素材编辑与闸门动作收敛为一个稳定 API。
 *
 * 关键约束：
 * - 未配置 Key 时所有真实运行动作不触发（UI 也已禁用按钮，双保险）；
 * - 素材修改只发生在没有任何模型结果时（避免用新图覆盖已确认事实）。
 */
export function useCanvasWorkflow(projectId: string, settings: ModelSettings | null) {
  const wfApi = useSingleItemWorkflow(projectId);
  const { wf, loaded } = wfApi;
  const configured = isTextConfigured(settings);

  const setReferenceImages = useCallback(
    (imgs: UploadedImage[]) => {
      wfApi.patchDraftInputs({ referenceImages: imgs });
    },
    [wfApi],
  );

  const setProductImages = useCallback(
    (imgs: UploadedImage[]) => {
      wfApi.patchDraftInputs({ productImages: imgs });
    },
    [wfApi],
  );

  const setTaskPurpose = useCallback(
    (text: string) => {
      wfApi.patchDraftInputs({ taskPurpose: text });
    },
    [wfApi],
  );

  const runAnalyze = useCallback(() => {
    if (!configured) return;
    void wfApi.runAnalyze(settings);
  }, [configured, settings, wfApi]);

  const confirmRecipe = useCallback(() => wfApi.confirmRecipe(), [wfApi]);
  const setFeature = useCallback(
    (id: string, status: 'confirmed' | 'rejected') => wfApi.setFeature(id, status),
    [wfApi],
  );
  const finishIdentityLock = useCallback(() => wfApi.finishIdentityLock(), [wfApi]);
  const skipIdentityWithRisk = useCallback(() => wfApi.finishIdentityLock(), [wfApi]);

  const runGenerate = useCallback(() => {
    if (!configured) return;
    void wfApi.generate(settings);
  }, [configured, settings, wfApi]);

  const requestRepair = useCallback(() => {
    if (!configured) return;
    void wfApi.requestRepair(settings);
  }, [configured, settings, wfApi]);

  const applyRepair = useCallback(() => {
    if (!configured) return;
    void wfApi.applyRepair(settings);
  }, [configured, settings, wfApi]);

  const acceptWarning = useCallback(() => wfApi.accept(), [wfApi]);
  const reset = useCallback(() => wfApi.reset(), [wfApi]);

  const api: WorkflowApi = useMemo(
    () => ({
      busy: wfApi.busy,
      actionError: wfApi.actionError,
      setReferenceImages,
      setProductImages,
      setTaskPurpose,
      runAnalyze,
      confirmRecipe,
      setFeature,
      finishIdentityLock,
      skipIdentityWithRisk,
      runGenerate,
      requestRepair,
      applyRepair,
      acceptWarning,
      reset,
    }),
    [
      wfApi.busy,
      wfApi.actionError,
      setReferenceImages,
      setProductImages,
      setTaskPurpose,
      runAnalyze,
      confirmRecipe,
      setFeature,
      finishIdentityLock,
      skipIdentityWithRisk,
      runGenerate,
      requestRepair,
      applyRepair,
      acceptWarning,
      reset,
    ],
  );

  return { wf, loaded, configured, api };
}

export type { SingleItemWorkflow };
