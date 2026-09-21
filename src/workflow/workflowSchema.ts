/**
 * 阶段2 模型输出与持久化对象的 Zod 校验。
 * 关键：修复是否“高风险”由代码依据验收问题判定，模型无权自报 highRisk 绕过人工闸门。
 */
import { z } from 'zod';
import { BATCH_STATES, WORKFLOW_SCHEMA_VERSION } from './workflowConstants';
import type { RepairProposal } from './workflowTypes';

const nonEmpty = z.string().min(1);
const stringList = z.array(nonEmpty);

/* ----------------------- 调用四：定向修复 ----------------------- */

export const repairProposalModelSchema = z.object({
  reason: nonEmpty,
  positivePromptOverride: z.string().min(1).optional(),
  addedNegative: stringList.default([]),
  affectedFields: stringList.default([]),
  // 刻意不接受模型给出的 highRisk / status 等字段。
});

/**
 * 装配修复提案。
 * @param raw 模型 JSON
 * @param highRisk 由代码根据验收问题计算（见 isHighRiskAudit）
 */
export function assembleRepairProposal(raw: unknown, highRisk: boolean): RepairProposal {
  const p = repairProposalModelSchema.parse(raw);
  return {
    reason: p.reason,
    positivePromptOverride: p.positivePromptOverride,
    addedNegative: p.addedNegative,
    affectedFields: p.affectedFields,
    highRisk,
  };
}

/**
 * 代码确定性判定高风险：验收中出现身份/Logo/材质/虚构文字类 critical 问题。
 * 命中即默认暂停并请求人工确认（docs/02 第二道闸门）。
 */
export function isHighRiskAudit(issues: Array<{ dimension: string; severity: string; statement?: string }>): boolean {
  return issues.some((i) => {
    if (i.severity !== 'critical') return false;
    const text = i.statement ?? '';
    const identityHit = i.dimension === 'identity';
    const textHit = /文字|logo|Logo|材质|形态|变形|变脸|部件/.test(text);
    return identityHit || textHit;
  });
}

/* ----------------------- 编译结果（持久化前校验） ----------------------- */

export const compiledPromptSchema = z.object({
  sourceRecipeId: nonEmpty,
  compiledAt: nonEmpty,
  positivePrompt: nonEmpty,
  negativePrompt: nonEmpty,
  identityConstraints: z.array(z.string()),
  requiredRules: z.array(z.string()),
  variableRules: z.array(z.string()),
  forbiddenRules: z.array(z.string()),
  fieldValues: z.record(z.string()),
});

/* ----------------------- 单件工作流持久化形状 ----------------------- */

export const singleItemWorkflowShapeSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  id: nonEmpty,
  name: nonEmpty,
  createdAt: nonEmpty,
  updatedAt: nonEmpty,
  taskPurpose: z.string(),
  recipeConfirmed: z.boolean(),
  identityConfirmed: z.boolean(),
  state: z.enum(BATCH_STATES),
  repairUsed: z.boolean(),
  callsUsed: z.number().int().nonnegative(),
  attempts: z.array(z.any()),
  referenceImages: z.array(z.any()),
  productImages: z.array(z.any()),
  identityFeatures: z.array(z.any()),
});

/** 加载持久化记录时做形状校验；失败抛错由调用方降级为新建，绝不半信任写入 */
export function parsePersistedWorkflow(raw: unknown): z.infer<typeof singleItemWorkflowShapeSchema> {
  return singleItemWorkflowShapeSchema.parse(raw);
}

export const CURRENT_WORKFLOW_SCHEMA_VERSION = WORKFLOW_SCHEMA_VERSION;
