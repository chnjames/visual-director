/**
 * 单件工作流编排（框架无关）。所有模型调用经阶段1 同源客户端，状态转移经状态机，
 * 模型输出经 Schema 装配；任何一步失败都转为 lastError + failed，不伪造结果。
 */
import {
  ARK_IMAGE_TIMEOUT_MS,
  IDENTITY_CATEGORY_LABELS,
  LIMITS,
} from '../shared/constants';
import {
  assembleAuditResult,
  assembleIdentityFeatures,
  assembleVisualRecipe,
  hardConstraints,
} from '../shared/schema';
import { generateImage, runProbe } from '../model/arkClient';
import {
  buildAuditMessages,
  buildIdentityMessages,
  buildRecipeMessages,
  buildRepairMessages,
} from '../model/prompts';
import {
  WORKFLOW_SCHEMA_VERSION,
  type BatchState,
} from './workflowConstants';
import { compilePrompt } from './promptCompiler';
import { isHighRiskAudit, assembleRepairProposal } from './workflowSchema';
import { interruptIfInFlight, transition, type WorkflowEvent } from './stateMachine';
import type {
  CompiledPrompt,
  GeneratedImage,
  GenerationAttempt,
  RepairProposal,
  SingleItemWorkflow,
} from './workflowTypes';
import type {
  AuditResult,
  IdentityFeature,
  ModelSettings,
  ProbeOutcome,
  SafeError,
  UploadedImage,
  VisualRecipe,
} from '../shared/types';
import type { ImageGenerateOptions, ImageGenerateResult } from '../model/arkClient';

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export type CreateWorkflowInput = {
  referenceImages: UploadedImage[];
  productImages: UploadedImage[];
  taskPurpose: string;
  name?: string;
};

export function createWorkflow(input: CreateWorkflowInput): SingleItemWorkflow {
  if (
    input.referenceImages.length < LIMITS.referenceImagesMin ||
    input.referenceImages.length > LIMITS.referenceImagesMax
  ) {
    throw new Error(`参考图需 ${LIMITS.referenceImagesMin}-${LIMITS.referenceImagesMax} 张`);
  }
  if (
    input.productImages.length < LIMITS.identityImagesMin ||
    input.productImages.length > LIMITS.identityImagesMax
  ) {
    throw new Error(`商品多角度图需 ${LIMITS.identityImagesMin}-${LIMITS.identityImagesMax} 张`);
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: uid('wf'),
    name: input.name?.trim() || '单件静物场景图',
    createdAt: now,
    updatedAt: now,
    taskPurpose: input.taskPurpose,
    referenceImages: input.referenceImages,
    productImages: input.productImages,
    recipeConfirmed: false,
    identityFeatures: [],
    identityConfirmed: false,
    state: 'draft',
    repairUsed: false,
    callsUsed: 0,
    attempts: [],
  };
}

/** 刷新恢复：进行中一律判为 interrupted */
export function resumeWorkflow(wf: SingleItemWorkflow): SingleItemWorkflow {
  const state = interruptIfInFlight(wf.state);
  return state === wf.state ? wf : { ...wf, state, updatedAt: new Date().toISOString() };
}

/** 用户在 interrupted 后选择回到草稿（进行中的半成品不自动续跑） */
export function dismissInterruption(wf: SingleItemWorkflow): SingleItemWorkflow {
  return touch(wf, { state: transition(wf.state, 'RESUME') });
}

/* ----------------------------- 可注入 runner ----------------------------- */

export type RecipeRunOptions = {
  purpose?: string;
  excludeSubject?: boolean;
};

export type Runners = {
  recipe: (
    s: ModelSettings,
    imgs: UploadedImage[],
    opts?: RecipeRunOptions,
  ) => Promise<ProbeOutcome<VisualRecipe>>;
  identity: (
    s: ModelSettings,
    imgs: UploadedImage[],
    statement: string,
  ) => Promise<ProbeOutcome<IdentityFeature[]>>;
  image: (
    s: ModelSettings,
    positive: string,
    negative: string,
    options?: ImageGenerateOptions,
  ) => Promise<ImageGenerateResult>;
  audit: (
    s: ModelSettings,
    product: UploadedImage[],
    candidate: UploadedImage,
    recipe: VisualRecipe,
    purpose: string,
  ) => Promise<ProbeOutcome<AuditResult>>;
  repair: (
    s: ModelSettings,
    product: UploadedImage[],
    generated: UploadedImage,
    audit: AuditResult,
    compiled: CompiledPrompt,
    identityStatements: string[],
    highRisk: boolean,
  ) => Promise<ProbeResult<RepairProposal>>;
};

type ProbeResult<T> = ProbeOutcome<T>;

export const defaultRunners: Runners = {
  recipe: (s, imgs, opts) =>
    runProbe('recipe', s, buildRecipeMessages(imgs, opts), assembleVisualRecipe),
  identity: (s, imgs, statement) =>
    runProbe('identity', s, buildIdentityMessages(imgs, statement), assembleIdentityFeatures),
  image: (s, positive, negative, options) => {
    // 负向约束折叠进 prompt（不依赖 negative_prompt 兼容性）
    const folded = negative ? `${positive}\n\n${negative}` : positive;
    return generateImage(s, folded, { ...options, timeoutMs: ARK_IMAGE_TIMEOUT_MS });
  },
  audit: (s, product, candidate, recipe, purpose) =>
    runProbe(
      'audit',
      s,
      buildAuditMessages(product, candidate, recipe, purpose),
      (raw) => assembleAuditResult(candidate.id, raw),
    ),
  repair: (s, product, generated, audit, compiled, statements, highRisk) =>
    runProbe(
      'repair',
      s,
      buildRepairMessages(product, generated, audit, compiled, statements),
      (raw) => assembleRepairProposal(raw, highRisk),
    ),
};

function touch(wf: SingleItemWorkflow, patch: Partial<SingleItemWorkflow>): SingleItemWorkflow {
  return { ...wf, ...patch, updatedAt: new Date().toISOString() };
}

function fail(wf: SingleItemWorkflow, error: SafeError): SingleItemWorkflow {
  const state = transitionSafe(wf.state, 'FAIL');
  return touch(wf, { state, lastError: error });
}

function transitionSafe(state: BatchState, event: WorkflowEvent, ctx: Parameters<typeof transition>[2] = {}): BatchState {
  return transition(state, event, ctx);
}

/* ----------------------------- 步骤一：分析 ----------------------------- */

export async function analyze(
  wf: SingleItemWorkflow,
  settings: ModelSettings | null,
  runners: Runners = defaultRunners,
): Promise<SingleItemWorkflow> {
  if (!settings) return wf;
  let next = touch(wf, { state: transition(wf.state, 'START_ANALYSIS'), lastError: undefined });

  const recipeRes = await runners.recipe(settings, wf.referenceImages);
  if (!recipeRes.ok) return fail(next, recipeRes);
  const recipe = recipeRes.data;

  next = touch(next, { callsUsed: next.callsUsed + 1, recipe });

  const idRes = await runners.identity(settings, wf.productImages, wf.taskPurpose);
  if (!idRes.ok) return fail(next, idRes);

  next = touch(next, {
    callsUsed: next.callsUsed + 1,
    identityFeatures: idRes.data,
    state: transition(next.state, 'ANALYSIS_FINISHED'),
  });
  return next;
}

/* ----------------------------- 人工闸门 ----------------------------- */

export function confirmRecipe(wf: SingleItemWorkflow): SingleItemWorkflow {
  if (!wf.recipe) throw new Error('还没有视觉配方可供确认');
  const confirmed: VisualRecipe = { ...wf.recipe, confirmedAt: new Date().toISOString() };
  return touch(wf, { recipe: confirmed, recipeConfirmed: true });
}

export function confirmIdentity(wf: SingleItemWorkflow): SingleItemWorkflow {
  return touch(wf, { identityConfirmed: true });
}

function identityStatements(wf: SingleItemWorkflow): string[] {
  return hardConstraints(wf.identityFeatures).map(
    (f) => `[${IDENTITY_CATEGORY_LABELS[f.category] ?? f.category}] ${f.statement}`,
  );
}

/* --------------------- 生成 + 验收（版本化尝试） --------------------- */

function b64ToImage(b64: string, mediaType: string): GeneratedImage {
  return { id: uid('img'), mediaType, dataUri: `data:${mediaType};base64,${b64}` };
}

function generatedAsUploaded(img: GeneratedImage): UploadedImage {
  return { id: img.id, dataUri: img.dataUri, mediaType: img.mediaType, name: 'generated.png' };
}

function newAttempt(version: number, prompt: CompiledPrompt): GenerationAttempt {
  return { id: uid('att'), version, status: 'pending', prompt };
}

async function generateAndAudit(
  wf: SingleItemWorkflow,
  settings: ModelSettings,
  attempt: GenerationAttempt,
  runners: Runners,
  fromEvent: WorkflowEvent,
): Promise<SingleItemWorkflow> {
  let next = touch(wf, {
    state: transition(wf.state, fromEvent, { repairUsed: wf.repairUsed }),
  });
  attempt.status = 'generating';
  attempt.startedAt = new Date().toISOString();

  const imgRes = await runners.image(
    settings,
    attempt.prompt.positivePrompt,
    attempt.prompt.negativePrompt,
  );
  if (!imgRes.ok) {
    attempt.status = 'generation-failed';
    return fail(next, imgRes);
  }
  attempt.image = b64ToImage(imgRes.b64Json, imgRes.mediaType);
  attempt.generateDiagnostics = imgRes.diagnostics;
  next = touch(next, { callsUsed: next.callsUsed + 1 });

  // 生成成功 → 自动验收
  next = touch(next, { state: transition(next.state, 'GENERATION_SUCCEEDED') });
  attempt.status = 'auditing';
  if (!wf.recipe) return fail(next, createMissing('缺少已确认配方，无法验收'));

  const candidate = generatedAsUploaded(attempt.image);
  const auditRes = await runners.audit(
    settings,
    wf.productImages,
    candidate,
    wf.recipe,
    wf.taskPurpose,
  );
  if (!auditRes.ok) {
    attempt.status = 'audit-failed';
    return fail(next, auditRes);
  }
  attempt.audit = auditRes.data;
  attempt.auditDiagnostics = auditRes.raw.diagnostics;
  attempt.status = auditRes.data.status;
  attempt.finishedAt = new Date().toISOString();
  next = touch(next, {
    callsUsed: next.callsUsed + 1,
    state: transition(next.state, 'AUDIT_FINISHED', { auditStatus: auditRes.data.status }),
  });
  return next;
}

function createMissing(message: string): SafeError {
  return {
    ok: false,
    errorClass: 'bad-request',
    message,
    diagnostics: { endpointMasked: '(none)', model: '(none)' },
  };
}

export async function generateFirst(
  wf: SingleItemWorkflow,
  settings: ModelSettings | null,
  runners: Runners = defaultRunners,
): Promise<SingleItemWorkflow> {
  if (!settings) return wf;
  if (!wf.recipeConfirmed || !wf.recipe?.confirmedAt) {
    throw new Error('必须先确认视觉配方（第一道人工闸门）');
  }
  if (!wf.identityConfirmed) {
    throw new Error('必须先完成身份锁定（确认候选，或明确跳过并自担风险）');
  }
  if (wf.attempts.length > 0) throw new Error('已生成过，请勿重复首生成');
  const compiled = compilePrompt(wf.recipe, wf.identityFeatures, wf.taskPurpose);
  const attempt = newAttempt(1, compiled);
  const withAttempt = touch(wf, { attempts: [attempt] });
  return generateAndAudit(withAttempt, settings, attempt, runners, 'START_GENERATION');
}

/** 人工接受 warning / needs-review 为通过 */
export function humanAccept(wf: SingleItemWorkflow): SingleItemWorkflow {
  const state = transition(wf.state, 'CONFIRM_WARNING');
  const attempts = wf.attempts.map((a) =>
    a.status === 'warning' || a.status === 'needs-review' ? { ...a, status: 'passed' as const } : a,
  );
  return touch(wf, { state, attempts });
}

/* ----------------------------- 定向修复 ----------------------------- */

/** 计算当前失败尝试是否高风险（代码确定性，不信任模型自报） */
export function currentRepairHighRisk(wf: SingleItemWorkflow): boolean {
  const last = wf.attempts[wf.attempts.length - 1];
  if (!last?.audit) return false;
  return isHighRiskAudit(last.audit.issues);
}

export async function proposeRepair(
  wf: SingleItemWorkflow,
  settings: ModelSettings | null,
  runners: Runners = defaultRunners,
): Promise<SingleItemWorkflow> {
  if (!settings) return wf;
  if (wf.repairUsed || wf.attempts.length >= 2) {
    throw new Error('每件商品最多定向修复一次');
  }
  const last = wf.attempts[wf.attempts.length - 1];
  if (!last?.audit || !last.image || !wf.recipe) {
    throw new Error('缺少失败的验收结果，无法修复');
  }
  const highRisk = isHighRiskAudit(last.audit.issues);
  let next = touch(wf, {
    state: transition(wf.state, 'START_REPAIR', { repairUsed: wf.repairUsed }),
  });

  const res = await runners.repair(
    settings,
    wf.productImages,
    generatedAsUploaded(last.image),
    last.audit,
    last.prompt,
    identityStatements(wf),
    highRisk,
  );
  if (!res.ok) return fail(next, res);

  // 修复版本继承首版编译结果，应用时再覆盖（保留来源可追溯）
  const v2 = newAttempt(2, { ...last.prompt, compiledAt: new Date().toISOString() });
  v2.repair = { ...res.data, raw: res.raw.rawContent };
  next = touch(next, {
    callsUsed: next.callsUsed + 1,
    attempts: [...next.attempts, v2],
    // 总是暂停给用户确认（高风险尤其必须），不自动重生成
    state: transition(next.state, 'REPAIR_PROPOSED'),
  });
  return next;
}

export async function applyRepairAndRegenerate(
  wf: SingleItemWorkflow,
  settings: ModelSettings | null,
  runners: Runners = defaultRunners,
): Promise<SingleItemWorkflow> {
  if (!settings) return wf;
  const v2 = wf.attempts.find((a) => a.version === 2);
  if (!v2?.repair) throw new Error('没有待应用的修复方案');
  if (wf.state !== 'paused') throw new Error('仅在修复方案待确认（暂停）状态可应用修复');

  const base = wf.attempts.find((a) => a.version === 1);
  const positive = v2.repair.positivePromptOverride?.trim() || base?.prompt.positivePrompt || '';
  const negative = [
    base?.prompt.negativePrompt ?? '',
    ...v2.repair.addedNegative.map((s) => `避免：${s}`),
  ]
    .filter(Boolean)
    .join('；');
  v2.prompt = { ...v2.prompt, positivePrompt: positive, negativePrompt: negative };
  v2.repair.confirmedAt = new Date().toISOString();

  const marked = touch(wf, { repairUsed: true, attempts: [...wf.attempts] });
  return generateAndAudit(marked, settings, v2, runners, 'APPLY_REPAIR');
}
