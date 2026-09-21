/**
 * Zod Schema：模型输出与产品合同的唯一校验入口。
 * 任何模型输出都必须先通过这里；Schema 失败绝不伪装成功。
 */
import { z } from 'zod';
import {
  RECIPE_FIELD_KEYS,
  IDENTITY_CATEGORIES,
  AUDIT_WEIGHTS,
  AUDIT_THRESHOLDS,
} from './constants';
import type {
  AuditDimension,
  AuditIssue,
  AuditResult,
  AuditStatus,
  Evidence,
  IdentityFeature,
  RecipeField,
  RecipeFieldKey,
  Severity,
  VisualRecipe,
} from './types';

/* ------------------------------ 基础件 ------------------------------ */

const confidence01 = z.number().min(0, '置信度不能小于 0').max(1, '置信度不能大于 1');

const regionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .refine((r) => r.x + r.width <= 1 + 1e-9, '区域右边界超出图像范围')
  .refine((r) => r.y + r.height <= 1 + 1e-9, '区域下边界超出图像范围');

export const evidenceSchema = z.object({
  sourceId: z.string().min(1, '证据缺少 sourceId'),
  sourceType: z.enum(['product-image', 'reference-image', 'user-text']),
  region: regionSchema.optional(),
  quote: z.string().optional(),
  confidence: confidence01,
});

const score0to100 = z.number().min(0).max(100);

/* --------------------------- A. 视觉配方 --------------------------- */

export const recipeFieldKeySchema = z.enum(RECIPE_FIELD_KEYS);

/** 模型返回的单个字段（locked 由程序强制为 false，模型无权锁定） */
const recipeFieldModelSchema = z.object({
  key: recipeFieldKeySchema,
  value: z.string().min(1, '字段值不能为空'),
  confidence: confidence01,
  evidence: z.array(evidenceSchema).min(1, '每个字段至少包含一条图像证据'),
  locked: z.boolean().optional(),
});

const recipeFieldArraySchema = z
  .array(recipeFieldModelSchema)
  .length(RECIPE_FIELD_KEYS.length, `必须恰好包含 ${RECIPE_FIELD_KEYS.length} 个字段`)
  .superRefine((fields, ctx) => {
    const seen = new Set<RecipeFieldKey>();
    for (const f of fields) {
      if (seen.has(f.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `字段 ${f.key} 重复出现`,
        });
      }
      seen.add(f.key);
    }
    for (const key of RECIPE_FIELD_KEYS) {
      if (!seen.has(key as RecipeFieldKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `缺少必需字段 ${key}`,
        });
      }
    }
  });

const stringListSchema = z.array(z.string().min(1));

/** 模型返回的视觉配方负载 */
export const modelRecipePayloadSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1, '配方名称不能为空'),
  fields: recipeFieldArraySchema,
  required: stringListSchema,
  variable: stringListSchema,
  forbidden: stringListSchema,
});

/** 完整产品合同 Schema（用于校验最终装配结果） */
export const recipeFieldSchema = z.object({
  key: recipeFieldKeySchema,
  value: z.string().min(1),
  confidence: confidence01,
  evidence: z.array(evidenceSchema).min(1),
  locked: z.boolean(),
});

export const visualRecipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  fields: z
    .array(recipeFieldSchema)
    .length(RECIPE_FIELD_KEYS.length)
    .superRefine((fields, ctx) => {
      const keys = fields.map((f) => f.key).sort();
      const expected = [...RECIPE_FIELD_KEYS].sort();
      if (keys.join('|') !== expected.join('|')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '字段集合与 12 项合同不一致' });
      }
    }),
  required: stringListSchema,
  variable: stringListSchema,
  forbidden: stringListSchema,
  confirmedAt: z.string().optional(),
});

let recipeSeq = 0;
function genId(prefix: string): string {
  recipeSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${recipeSeq}`;
}

/**
 * 解析并装配模型配方负载：
 * - 严格校验 12 字段与证据；
 * - locked 一律强制 false（模型不能替用户锁定）；
 * - 补齐 id。
 * 校验失败抛出 z.ZodError。
 */
export function assembleVisualRecipe(raw: unknown): VisualRecipe {
  const stripped = stripRecipeMeta(raw);
  const payload = modelRecipePayloadSchema.parse(stripped);
  const fields: RecipeField[] = payload.fields.map((f) => ({
    key: f.key,
    value: f.value,
    confidence: f.confidence,
    evidence: f.evidence as Evidence[],
    locked: false, // 程序强制：模型输出不决定锁定状态
  }));
  const recipe: VisualRecipe = {
    id: payload.id ?? genId('recipe'),
    name: payload.name,
    fields,
    required: payload.required,
    variable: payload.variable,
    forbidden: payload.forbidden,
  };
  // 用完整合同再校验一次，确保装配结果合法
  return visualRecipeSchema.parse(recipe);
}

/** 去掉可选 meta，避免干扰配方 schema */
export function stripRecipeMeta(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { meta: _meta, ...rest } = raw as Record<string, unknown>;
  return rest;
}

/* --------------------------- B. 商品身份 --------------------------- */

const severitySchema = z.enum(['critical', 'major', 'minor']);

const identityFeatureModelSchema = z.object({
  id: z.string().min(1).optional(),
  category: z.enum(IDENTITY_CATEGORIES),
  statement: z.string().min(1, '特征描述不能为空'),
  evidence: z.array(evidenceSchema).min(1, '身份特征至少包含一条图像证据'),
  severityIfViolated: severitySchema,
  // 注意：模型负载中刻意【不接受】 source / status，
  // 即使模型擅自给出，也会被剥离，状态由程序强制为 pending。
});

export const modelIdentityPayloadSchema = z.object({
  features: z.array(identityFeatureModelSchema).min(1, '至少应提出一个候选特征'),
});

export const identityFeatureSchema = z.object({
  id: z.string().min(1),
  category: z.enum(IDENTITY_CATEGORIES),
  statement: z.string().min(1),
  source: z.enum(['model-proposed', 'user-declared']),
  evidence: z.array(evidenceSchema).min(1),
  status: z.enum(['pending', 'confirmed', 'rejected']),
  severityIfViolated: severitySchema,
});

/**
 * 装配模型提出的身份候选：来源固定 model-proposed，状态强制 pending。
 * 模型推测绝不能自动升级为 confirmed（硬约束）。
 */
export function assembleIdentityFeatures(raw: unknown): IdentityFeature[] {
  const payload = modelIdentityPayloadSchema.parse(raw);
  const features: IdentityFeature[] = payload.features.map((f) => ({
    id: f.id ?? genId('feat'),
    category: f.category,
    statement: f.statement,
    source: 'model-proposed',
    evidence: f.evidence as Evidence[],
    status: 'pending', // 程序强制：模型候选一律 pending
    severityIfViolated: f.severityIfViolated,
  }));
  return z.array(identityFeatureSchema).parse(features);
}

/** 用户确认一个候选特征（唯一能把 pending 升级为 confirmed 的路径） */
export function confirmFeature(feature: IdentityFeature): IdentityFeature {
  return identityFeatureSchema.parse({ ...feature, status: 'confirmed' });
}

/** 用户否决一个候选特征 */
export function rejectFeature(feature: IdentityFeature): IdentityFeature {
  return identityFeatureSchema.parse({ ...feature, status: 'rejected' });
}

/** 仅 confirmed 特征成为硬约束 */
export function hardConstraints(features: IdentityFeature[]): IdentityFeature[] {
  return features.filter((f) => f.status === 'confirmed');
}

/* --------------------------- C. 结果验收 --------------------------- */

const auditIssueModelSchema = z.object({
  dimension: z.enum(['identity', 'recipe', 'task', 'technical']),
  severity: severitySchema,
  statement: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
  confidence: confidence01,
});

export const modelAuditPayloadSchema = z.object({
  identityScore: score0to100,
  recipeScore: score0to100,
  taskScore: score0to100,
  technicalScore: score0to100,
  criticalViolation: z.boolean(),
  insufficientEvidence: z.boolean(),
  modelConfidence: confidence01,
  issues: z.array(auditIssueModelSchema),
});

export type ModelAuditPayload = z.infer<typeof modelAuditPayloadSchema>;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 确定性状态计算（产品规则，docs/04）：
 * 1. 任一严重错误 → failed（一票否决，优先级最高）；
 * 2. 证据不足 / 关键区域不可辨认 → needs-review（不强行判断）；
 * 3. 综合分 = 身份40% + 配方30% + 任务20% + 技术10%；
 *    >=80 passed，60–79 warning，<60 failed。
 */
export function computeAuditStatus(
  input: Omit<ModelAuditPayload, 'issues' | 'modelConfidence'>,
): { status: AuditStatus; compositeScore: number; reason: string } {
  const compositeScore = round1(
    input.identityScore * AUDIT_WEIGHTS.identity +
      input.recipeScore * AUDIT_WEIGHTS.recipe +
      input.taskScore * AUDIT_WEIGHTS.task +
      input.technicalScore * AUDIT_WEIGHTS.technical,
  );

  if (input.criticalViolation) {
    return { status: 'failed', compositeScore, reason: 'critical-veto' };
  }
  if (input.insufficientEvidence) {
    return { status: 'needs-review', compositeScore, reason: 'insufficient-evidence' };
  }
  if (compositeScore >= AUDIT_THRESHOLDS.pass) {
    return { status: 'passed', compositeScore, reason: 'score-pass' };
  }
  if (compositeScore >= AUDIT_THRESHOLDS.warn) {
    return { status: 'warning', compositeScore, reason: 'score-warn' };
  }
  return { status: 'failed', compositeScore, reason: 'score-fail' };
}

/** 装配验收结果：模型给分与问题，状态由代码确定性计算 */
export function assembleAuditResult(
  productId: string,
  raw: unknown,
): AuditResult {
  const payload = modelAuditPayloadSchema.parse(raw);
  const { status, compositeScore, reason } = computeAuditStatus(payload);
  const result: AuditResult = {
    productId,
    status,
    identityScore: payload.identityScore,
    recipeScore: payload.recipeScore,
    taskScore: payload.taskScore,
    technicalScore: payload.technicalScore,
    compositeScore,
    criticalViolation: payload.criticalViolation,
    insufficientEvidence: payload.insufficientEvidence,
    issues: payload.issues as AuditResult['issues'],
    modelConfidence: payload.modelConfidence,
    statusReason: reason,
  };
  return result;
}

export type {
  AuditDimension,
  AuditIssue,
  Severity,
};

/* --------------------------- 错误格式化 --------------------------- */

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.join('.');
    return path ? `${path}: ${i.message}` : i.message;
  });
}
