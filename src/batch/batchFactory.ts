/**
 * 阶段3 批量工厂（纯函数、不可变更新）：建立批次、共享配方闸门、图片分组、画布节点跳过、
 * 分组/成本确认。所有“能否进入下一步”都在此显式校验，UI 与引擎共用。
 */
import {
  BATCH_MAX_ITEMS,
  BATCH_ITEM_IMAGES_MIN,
  BATCH_ITEM_IMAGES_MAX,
  BATCH_SCHEMA_VERSION,
  type IdentityMode,
} from './batchConstants';
import type { Batch, BatchItem, PublishedWorkflowBinding } from './batchTypes';
import type { UploadedImage, VisualRecipe } from '../shared/types';
import { SKIPPABLE_NODES, type WorkflowNodeId } from '../workflow/workflowConstants';
import { createFixedWorkflowDefinition, isFixedBackbone } from '../workflow/fixedWorkflow';
import { uid } from '../workflow/orchestrator';
import { assertBatchCompatiblePlan } from './batchExecutionPolicy';

function now(): string {
  return new Date().toISOString();
}

function touch(batch: Batch, patch: Partial<Batch>): Batch {
  return { ...batch, ...patch, updatedAt: now() };
}

export function createBatch(
  referenceImages: UploadedImage[],
  taskPurpose: string,
  binding?: PublishedWorkflowBinding,
): Batch {
  if (binding) assertBatchCompatiblePlan(binding.plan);
  return {
    schemaVersion: BATCH_SCHEMA_VERSION,
    id: uid('batch'),
    createdAt: now(),
    updatedAt: now(),
    taskPurpose,
    referenceImages,
    workflowVersionId: binding?.id,
    workflowVersionNo: binding?.versionNo,
    workflowVersionChecksum: binding?.checksum,
    workflowPlan: binding?.plan,
    recipeConfirmed: false,
    items: [],
    groupingConfirmed: false,
    budgetConfirmed: false,
    status: 'setup',
    skippedNodeIds: [],
    callsUsed: 0,
    prepCallsUsed: 0,
    consecutiveNetworkFailures: 0,
  };
}

export function bindWorkflowVersion(
  batch: Batch,
  binding: PublishedWorkflowBinding,
): Batch {
  assertBatchCompatiblePlan(binding.plan);
  return touch(batch, {
    workflowVersionId: binding.id,
    workflowVersionNo: binding.versionNo,
    workflowVersionChecksum: binding.checksum,
    workflowPlan: binding.plan,
    definition: undefined,
    groupingConfirmed: false,
    budgetConfirmed: false,
    status: 'setup',
  });
}

export function setTaskPurpose(batch: Batch, taskPurpose: string): Batch {
  return touch(batch, { taskPurpose });
}

/** 准备阶段：保存提取到但尚未确认的配方（第一道闸门未完成） */
export function setRecipe(batch: Batch, recipe: VisualRecipe): Batch {
  return touch(batch, { recipe, recipeConfirmed: false, definition: undefined });
}

/** 第一道人工闸门：确认视觉规则与商品无关迁移边界，随后生成共享 WorkflowDefinition */
export function confirmRecipe(batch: Batch): Batch {
  if (!batch.recipe) throw new Error('还没有提取到视觉配方，无法确认');
  const confirmed: VisualRecipe = { ...batch.recipe, confirmedAt: now() };
  if (batch.workflowPlan) {
    assertBatchCompatiblePlan(batch.workflowPlan);
    if (!batch.workflowVersionId) throw new Error('批次未绑定已发布工作流版本');
    return touch(batch, {
      recipe: confirmed,
      recipeConfirmed: true,
      definition: undefined,
      prepCallsUsed: Math.max(batch.prepCallsUsed, 1),
    });
  }
  const definition = createFixedWorkflowDefinition(confirmed.id, '静物场景图批量工作流');
  if (!isFixedBackbone(definition)) {
    throw new Error('工作流定义不是受允许的固定主干，拒绝继续');
  }
  return touch(batch, {
    recipe: confirmed,
    recipeConfirmed: true,
    definition,
    prepCallsUsed: Math.max(batch.prepCallsUsed, 1),
  });
}

function defaultName(index: number): string {
  return `商品${index + 1}`;
}

export function addGroup(batch: Batch): Batch {
  if (batch.items.length >= BATCH_MAX_ITEMS) {
    throw new Error(`一批最多 ${BATCH_MAX_ITEMS} 件商品`);
  }
  const identityMode: IdentityMode = batch.skippedNodeIds.includes('identityLock')
    ? 'skip'
    : 'lock';
  const item: BatchItem = {
    id: uid('item'),
    name: defaultName(batch.items.length),
    images: [],
    identityMode,
    groupingConfirmed: false,
    userPaused: false,
    skipped: false,
    retryCount: 0,
    awaiting: null,
  };
  return touch(batch, {
    items: [...batch.items, item],
    groupingConfirmed: false,
    budgetConfirmed: false,
  });
}

export function removeGroup(batch: Batch, itemId: string): Batch {
  return touch(batch, {
    items: batch.items.filter((i) => i.id !== itemId),
    groupingConfirmed: false,
    budgetConfirmed: false,
  });
}

export function renameGroup(batch: Batch, itemId: string, name: string): Batch {
  return touch(batch, {
    items: batch.items.map((i) => (i.id === itemId ? { ...i, name } : i)),
  });
}

export function setGroupImages(batch: Batch, itemId: string, images: UploadedImage[]): Batch {
  const clamped = images.slice(0, BATCH_ITEM_IMAGES_MAX);
  return touch(batch, {
    items: batch.items.map((i) =>
      i.id === itemId
        ? { ...i, images: clamped, groupingConfirmed: false, wf: undefined }
        : i,
    ),
    groupingConfirmed: false,
    budgetConfirmed: false,
  });
}

export function setGroupIdentityMode(
  batch: Batch,
  itemId: string,
  identityMode: IdentityMode,
): Batch {
  return touch(batch, {
    items: batch.items.map((i) => (i.id === itemId ? { ...i, identityMode } : i)),
  });
}

/** 画布节点跳过开关：只允许固定主干中标记为 skippable 的节点（docs/01） */
export function toggleSkippedNode(batch: Batch, nodeId: WorkflowNodeId): Batch {
  if (!SKIPPABLE_NODES.includes(nodeId)) {
    throw new Error(`节点 ${nodeId} 不可跳过（仅身份锁定/结果验收可跳过且需自担风险）`);
  }
  const present = batch.skippedNodeIds.includes(nodeId);
  const skippedNodeIds = present
    ? batch.skippedNodeIds.filter((n) => n !== nodeId)
    : [...batch.skippedNodeIds, nodeId];
  // 画布上跳过身份锁定 ⇒ 各分组默认改为 skip（用户仍可逐件改回 lock）
  const items = batch.items.map((i) =>
    nodeId === 'identityLock'
      ? { ...i, identityMode: (present ? 'lock' : 'skip') as IdentityMode }
      : i,
  );
  return touch(batch, {
    skippedNodeIds,
    items,
    groupingConfirmed: false,
    budgetConfirmed: false,
  });
}

/** 分组校验：1-5 件、每件 2-3 张、名称非空（系统不替用户决定图片归属，docs/01） */
export function groupingValidation(batch: Batch): { ok: boolean; reason?: string } {
  if (batch.items.length < 1) return { ok: false, reason: '至少添加 1 件商品' };
  if (batch.items.length > BATCH_MAX_ITEMS)
    return { ok: false, reason: `一批最多 ${BATCH_MAX_ITEMS} 件商品` };
  for (const [idx, item] of batch.items.entries()) {
    const label = item.name?.trim() || defaultName(idx);
    if (item.images.length < BATCH_ITEM_IMAGES_MIN || item.images.length > BATCH_ITEM_IMAGES_MAX) {
      return {
        ok: false,
        reason: `「${label}」需要 ${BATCH_ITEM_IMAGES_MIN}-${BATCH_ITEM_IMAGES_MAX} 张多角度图，当前 ${item.images.length} 张`,
      };
    }
  }
  const names = batch.items.map((i) => i.name.trim());
  if (new Set(names).size !== names.length) {
    return { ok: false, reason: '商品名称不能重复，请为每件商品命名以便区分' };
  }
  return { ok: true };
}

export function confirmGrouping(batch: Batch): Batch {
  const v = groupingValidation(batch);
  if (!v.ok) throw new Error(v.reason);
  return touch(batch, {
    groupingConfirmed: true,
    items: batch.items.map((i) => ({ ...i, groupingConfirmed: true })),
  });
}

export function canConfirmBudget(batch: Batch): { ok: boolean; reason?: string } {
  if (!batch.recipeConfirmed || (!batch.definition && !batch.workflowPlan))
    return { ok: false, reason: '请先确认视觉配方（第一道人工闸门）' };
  if (!batch.groupingConfirmed) {
    const v = groupingValidation(batch);
    if (!v.ok) return v;
    return { ok: false, reason: '请先确认图片分组' };
  }
  return { ok: true };
}

/** 第二道开始前确认：展示并确认预计/最坏调用次数后进入待运行（docs/01） */
export function confirmBudget(batch: Batch): Batch {
  const v = canConfirmBudget(batch);
  if (!v.ok) throw new Error(v.reason ?? '尚不能开始批量');
  return touch(batch, { budgetConfirmed: true, status: 'ready' });
}
