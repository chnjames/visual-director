/**
 * 阶段3 测试夹具（仅被 *.test.ts 引用）：构造合法图片/配方/验收、可控假 runners，
 * 不发起任何真实模型调用。
 */
import type {
  AuditResult,
  AuditStatus,
  IdentityFeature,
  ModelSettings,
  ProbeOutcome,
  SafeDiagnostics,
  UploadedImage,
  VisualRecipe,
  RecipeField,
} from '../shared/types';
import { RECIPE_FIELD_KEYS } from '../shared/constants';
import type { Runners } from '../workflow/orchestrator';
import type { RepairProposal } from '../workflow/workflowTypes';
import type { ImageGenerateResult } from '../model/arkClient';

export function img(id: string, name = `${id}.jpg`): UploadedImage {
  return {
    id,
    dataUri: `data:image/jpeg;base64,AAAA${id}`,
    mediaType: 'image/jpeg',
    name,
    width: 100,
    height: 100,
    bytes: 10,
  };
}

export function fakeSettings(): ModelSettings {
  return {
    apiKey: 'test-key',
    seedEndpoint: 'ep.test',
    imageEndpoint: 'ep.image',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  };
}

function diag(): SafeDiagnostics {
  return { endpointMasked: 'ep.t***', model: 'ep.test' };
}

export function rawCall() {
  return {
    kind: 'audit' as const,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    httpStatus: 200,
    rawContent: '{}',
    diagnostics: diag(),
  };
}

export function makeRecipe(confirmed = true): VisualRecipe {
  const fields: RecipeField[] = RECIPE_FIELD_KEYS.map((key) => ({
    key,
    value: `${key} 值`,
    confidence: 0.8,
    evidence: [],
    locked: false,
  }));
  return {
    id: 'recipe_1',
    name: '测试配方',
    fields,
    required: ['保持主体形态'],
    variable: ['背景道具可替换'],
    forbidden: ['不出现水印'],
    confirmedAt: confirmed ? new Date().toISOString() : undefined,
  };
}

let featureSeq = 0;
export function makeFeature(partial: Partial<IdentityFeature> = {}): IdentityFeature {
  featureSeq += 1;
  return {
    id: `feat_${featureSeq}`,
    category: 'shape',
    statement: '圆柱形瓶身',
    source: 'model-proposed',
    evidence: [],
    status: 'pending',
    severityIfViolated: 'critical',
    ...partial,
  };
}

export function makeAudit(status: AuditStatus, issues: AuditResult['issues'] = []): AuditResult {
  const scoreBy: Record<AuditStatus, number> = {
    passed: 90,
    warning: 70,
    failed: 40,
    'needs-review': 65,
  };
  const score = scoreBy[status];
  return {
    productId: 'product',
    status,
    identityScore: score,
    recipeScore: score,
    taskScore: score,
    technicalScore: score,
    compositeScore: score,
    criticalViolation: issues.some((i) => i.severity === 'critical'),
    insufficientEvidence: status === 'needs-review',
    issues,
    modelConfidence: 0.8,
    statusReason: '测试',
  };
}

export function ok<T>(data: T): ProbeOutcome<T> {
  return { ok: true, raw: rawCall(), data };
}

export function imageOk(): ImageGenerateResult {
  return { ok: true, b64Json: 'R0lGODlh', mediaType: 'image/png', diagnostics: diag() };
}

export function repairProposal(highRiskFields: string[] = ['palette']): RepairProposal {
  return {
    reason: '调整背景',
    positivePromptOverride: undefined,
    addedNegative: ['多余文字'],
    affectedFields: highRiskFields,
    highRisk: false,
  };
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export type FakeRunners = Runners & {
  counters: { recipe: number; identity: number; image: number; audit: number; repair: number };
  active: { identity: number; image: number; audit: number };
  maxActive: { identity: number; image: number; audit: number };
};

/** 可覆盖行为的假 runners；默认全部成功（验收 passed、低风险修复） */
export function makeRunners(overrides: {
  auditStatus?: AuditStatus;
  auditIssues?: AuditResult['issues'];
  imageError?: import('../shared/types').SafeError;
  identityError?: import('../shared/types').SafeError;
  auditError?: import('../shared/types').SafeError;
  repairError?: import('../shared/types').SafeError;
  gateIdentity?: Deferred<ProbeOutcome<IdentityFeature[]>>;
  gateImage?: Deferred<ImageGenerateResult>;
  gateAudit?: Deferred<ProbeOutcome<AuditResult>>;
} = {}): FakeRunners {
  const counters = { recipe: 0, identity: 0, image: 0, audit: 0, repair: 0 };
  const active = { identity: 0, image: 0, audit: 0 };
  const maxActive = { identity: 0, image: 0, audit: 0 };
  const enter = (k: 'identity' | 'image' | 'audit') => {
    active[k] += 1;
    maxActive[k] = Math.max(maxActive[k], active[k]);
  };
  const leave = (k: 'identity' | 'image' | 'audit') => {
    active[k] -= 1;
  };

  return {
    counters,
    active,
    maxActive,
    recipe: async () => ok(makeRecipe()),
    identity: async () => {
      counters.identity += 1;
      enter('identity');
      try {
        if (overrides.identityError) return overrides.identityError as ProbeOutcome<IdentityFeature[]>;
        if (overrides.gateIdentity) return await overrides.gateIdentity.promise;
        return ok([makeFeature(), makeFeature({ category: 'color', statement: '白色' })]);
      } finally {
        leave('identity');
      }
    },
    image: async () => {
      counters.image += 1;
      enter('image');
      try {
        if (overrides.imageError) return overrides.imageError;
        if (overrides.gateImage) return await overrides.gateImage.promise;
        return imageOk();
      } finally {
        leave('image');
      }
    },
    audit: async () => {
      counters.audit += 1;
      enter('audit');
      try {
        if (overrides.auditError) return overrides.auditError as ProbeOutcome<AuditResult>;
        if (overrides.gateAudit) return await overrides.gateAudit.promise;
        return ok(makeAudit(overrides.auditStatus ?? 'passed', overrides.auditIssues));
      } finally {
        leave('audit');
      }
    },
    repair: async () => {
      counters.repair += 1;
      return ok(repairProposal());
    },
  };
}

export function safeError(
  errorClass: import('../shared/types').ModelErrorClass,
  message: string,
): import('../shared/types').SafeError {
  return { ok: false, errorClass, message, diagnostics: diag() };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

import {
  addGroup,
  confirmBudget,
  confirmGrouping,
  confirmRecipe,
  createBatch,
  setGroupIdentityMode,
  setGroupImages,
  setRecipe,
  toggleSkippedNode,
} from './batchFactory';
import type { Batch } from './batchTypes';
import type { IdentityMode } from './batchConstants';
import type { WorkflowNodeId } from '../workflow/workflowConstants';

/** 构造一个已确认配方/分组/预算、可直接 start 的批次 */
export function buildReadyBatch(
  count: number,
  opts: { identityMode?: IdentityMode; skipNodes?: WorkflowNodeId[] } = {},
): Batch {
  let b = createBatch([img('ref1'), img('ref2')], '电商详情页场景图');
  b = setRecipe(b, makeRecipe());
  b = confirmRecipe(b);
  for (const node of opts.skipNodes ?? []) b = toggleSkippedNode(b, node);
  for (let i = 0; i < count; i += 1) {
    b = addGroup(b);
    const id = b.items[b.items.length - 1].id;
    b = setGroupImages(b, id, [img(`p${i}a`), img(`p${i}b`)]);
    b = setGroupIdentityMode(b, id, opts.identityMode ?? 'skip');
  }
  b = confirmGrouping(b);
  b = confirmBudget(b);
  return b;
}
