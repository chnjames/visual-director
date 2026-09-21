/**
 * 阶段3 纯函数：错误分级、调用预算、节点映射。无副作用、确定性，便于单测。
 */
import {
  BATCH_ITEM_IMAGES_MIN,
  SYSTEM_ERROR_CLASSES,
} from './batchConstants';
import type { Batch, BatchBudget, BatchItem } from './batchTypes';
import type { ModelErrorClass, SafeError } from '../shared/types';
import { WORKFLOW_NODE_LABELS, type BatchState, type WorkflowNodeId } from '../workflow/workflowConstants';
import {
  batchPlanUsesAudit,
  batchPlanUsesIdentity,
  batchPlanUsesRepair,
} from './batchExecutionPolicy';

/** 商品级 vs 系统级错误（docs/02 错误隔离） */
export function isSystemErrorClass(cls: ModelErrorClass): boolean {
  return (SYSTEM_ERROR_CLASSES as readonly string[]).includes(cls);
}

export function classifyErrorLevel(error: SafeError): 'system' | 'item' {
  return isSystemErrorClass(error.errorClass) ? 'system' : 'item';
}

export function isNetworkError(error: SafeError): boolean {
  return error.errorClass === 'network' || error.errorClass === 'timeout';
}

/** 画布上某节点是否被跳过 */
export function isNodeSkipped(batch: Batch, nodeId: WorkflowNodeId): boolean {
  return batch.skippedNodeIds.includes(nodeId);
}

/** 某件商品是否需要身份提取调用：节点未被画布跳过，且该件选择锁定身份（非 skip） */
export function itemUsesIdentity(batch: Batch, item: BatchItem): boolean {
  return batchPlanUsesIdentity(batch) && item.identityMode === 'lock';
}

/** 每件商品是否执行结果验收（ResultAuditor 被画布跳过则不调用，结果只能 needs-review） */
export function batchUsesAudit(batch: Batch): boolean {
  return batchPlanUsesAudit(batch);
}

/**
 * 运行前预算（docs/01：批量开始前展示预计和最坏调用次数）。
 * 配方提取在准备阶段已发生（prepCalls=1，单独列示）。
 * 每件：身份(可选) + 生成1 + 验收(可选)；最坏再叠加 修复1+重生成1+重验收1（仅失败且修复一次）。
 */
export function estimateBatchBudget(batch: Batch): BatchBudget {
  const useAudit = batchUsesAudit(batch);
  const useRepair = useAudit && batchPlanUsesRepair(batch);
  const perItem = batch.items.map((item) => {
    if (item.skipped) return { itemId: item.id, expected: 0, worst: 0 };
    const useIdentity = itemUsesIdentity(batch, item);
    const expected = (useIdentity ? 1 : 0) + 1 + (useAudit ? 1 : 0);
    // 修复链路（修复提案+重生成+重验收）只有在启用验收时才可能发生
    const repairChain = useRepair ? 3 : 0;
    return { itemId: item.id, expected, worst: expected + repairChain };
  });
  const expected = perItem.reduce((s, x) => s + x.expected, 0);
  const worst = perItem.reduce((s, x) => s + x.worst, 0);
  const anyIdentity = batch.items.some((i) => !i.skipped && itemUsesIdentity(batch, i));
  const detail = [
    `准备阶段：视觉配方提取 ×1（全批共享，开始批量前完成）`,
    `每件预计：身份提取 ×${anyIdentity ? '0~1（仅选择锁定身份的件）' : '0'} ＋ 场景生成 ×1 ＋ 结果验收 ×${useAudit ? 1 : 0}`,
    `每件最坏：在预计基础上追加 定向修复×${useRepair ? 1 : 0} ＋ 重新生成×${useRepair ? 1 : 0} ＋ 重新验收×${useRepair ? 1 : 0}`,
    `并发：同时分析 2 件、同时生成 1 件；自动修复每件最多 1 次，不随并发增加调用上限`,
  ];
  return { prepCalls: batch.prepCallsUsed || 1, expected, worst, perItem, detail };
}

/** 单件商品图片数量边界（分组校验） */
export function isGroupImageCountValid(count: number): boolean {
  return count >= BATCH_ITEM_IMAGES_MIN && count <= 3;
}

/** 依据单件状态映射当前所处固定节点（用于画布高亮与表格“当前步骤”） */
export function nodeForState(state: BatchState): WorkflowNodeId | undefined {
  switch (state) {
    case 'analyzing':
      return 'identityLock';
    case 'generating':
      return 'sceneGenerator';
    case 'auditing':
      return 'resultAuditor';
    case 'repairing':
      return 'targetedRepair';
    default:
      return undefined;
  }
}

export function nodeLabel(nodeId?: WorkflowNodeId): string | undefined {
  return nodeId ? WORKFLOW_NODE_LABELS[nodeId] : undefined;
}

/** 终态（不再消耗调用、不再推进） */
export function isTerminalState(state: BatchState): boolean {
  return (
    state === 'passed' ||
    state === 'warning' ||
    state === 'failed' ||
    state === 'needs-review'
  );
}
