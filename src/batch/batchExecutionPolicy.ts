import type { Batch } from './batchTypes';
import type { ExecutionPlan } from '../workflow/graph/executionPlan';

const REQUIRED_ADAPTERS = [
  'input.reference',
  'input.product',
  'model.recipe',
  'local.prompt-compiler',
  'model.image',
  'sink.final',
] as const;

export function assertBatchCompatiblePlan(plan: ExecutionPlan): void {
  const adapters = new Set(plan.steps.map((step) => step.adapterId));
  const missing = REQUIRED_ADAPTERS.filter((adapter) => !adapters.has(adapter));
  if (missing.length) {
    throw new Error(`所选工作流版本不支持批量运行，缺少执行步骤：${missing.join('、')}`);
  }
}

export function planHasAdapter(batch: Batch, adapterId: string): boolean | undefined {
  if (!batch.workflowPlan) return undefined;
  return batch.workflowPlan.steps.some((step) => step.adapterId === adapterId);
}

export function batchPlanUsesIdentity(batch: Batch): boolean {
  return planHasAdapter(batch, 'model.identity') ?? !batch.skippedNodeIds.includes('identityLock');
}

export function batchPlanUsesAudit(batch: Batch): boolean {
  return planHasAdapter(batch, 'model.audit') ?? !batch.skippedNodeIds.includes('resultAuditor');
}

export function batchPlanUsesRepair(batch: Batch): boolean {
  return planHasAdapter(batch, 'model.repair') ?? !batch.skippedNodeIds.includes('targetedRepair');
}
