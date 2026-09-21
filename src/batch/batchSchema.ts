/**
 * 阶段3 批量持久化 Zod 形状校验（docs/03：导出 JSON 带 schemaVersion；损坏/旧版本不半信任加载）。
 * 内嵌单件执行体复用阶段2 的形状校验；加载后统一做“进行中→interrupted”。
 */
import { z } from 'zod';
import { BATCH_SCHEMA_VERSION, BATCH_QUEUE_STATUS_LABELS } from './batchConstants';
import { singleItemWorkflowShapeSchema } from '../workflow/workflowSchema';
import { interruptBatchOnReload } from './batchQueue';
import type { Batch } from './batchTypes';

const uploadedImageShape = z.object({
  id: z.string().min(1),
  dataUri: z.string().min(1),
  mediaType: z.string().min(1),
  name: z.string(),
});

const itemShape = z.object({
  id: z.string().min(1),
  name: z.string(),
  images: z.array(uploadedImageShape).default([]),
  identityMode: z.enum(['lock', 'skip']),
  groupingConfirmed: z.boolean(),
  userPaused: z.boolean(),
  skipped: z.boolean(),
  retryCount: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  awaiting: z.any().nullable(),
  wf: singleItemWorkflowShapeSchema.optional(),
});

const batchShapeSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  id: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  taskPurpose: z.string(),
  referenceImages: z.array(uploadedImageShape),
  workflowVersionId: z.string().optional(),
  workflowVersionNo: z.number().int().positive().optional(),
  workflowVersionChecksum: z.string().optional(),
  workflowPlan: z.any().optional(),
  recipe: z.any().optional(),
  recipeConfirmed: z.boolean(),
  definition: z.any().optional(),
  items: z.array(itemShape),
  groupingConfirmed: z.boolean(),
  budgetConfirmed: z.boolean(),
  status: z.enum(
    Object.keys(BATCH_QUEUE_STATUS_LABELS) as [keyof typeof BATCH_QUEUE_STATUS_LABELS],
  ),
  skippedNodeIds: z.array(z.string()).default([]),
  callsUsed: z.number().int().nonnegative(),
  prepCallsUsed: z.number().int().nonnegative().default(0),
  systemError: z.any().optional(),
  consecutiveNetworkFailures: z.number().int().nonnegative().default(0),
});

/** skippedNodeIds 实际是 WorkflowNodeId 枚举，这里做宽松校验，引擎/UI 只用固定节点 */
export function parsePersistedBatch(raw: unknown): Batch {
  const parsed = batchShapeSchema.parse(raw) as unknown as Batch;
  if (parsed.schemaVersion !== BATCH_SCHEMA_VERSION) {
    // 仅当前版本受支持；未来版本不半信任加载
    throw new Error(`不支持的批量 schemaVersion：${parsed.schemaVersion}`);
  }
  return interruptBatchOnReload(parsed);
}

export const CURRENT_BATCH_SCHEMA_VERSION = BATCH_SCHEMA_VERSION;
