import { describe, expect, it } from 'vitest';
import {
  analyze,
  applyRepairAndRegenerate,
  confirmIdentity,
  confirmRecipe,
  createWorkflow,
  generateFirst,
  humanAccept,
  proposeRepair,
  resumeWorkflow,
  type Runners,
} from './orchestrator';
import { assembleAuditResult, assembleIdentityFeatures, assembleVisualRecipe, confirmFeature } from '../shared/schema';
import { RECIPE_FIELD_KEYS } from '../shared/constants';
import type { AuditResult, IdentityFeature, ModelSettings, ProbeOutcome, UploadedImage, VisualRecipe } from '../shared/types';
import type { ImageGenerateResult } from '../model/arkClient';
import type { RepairProposal } from './workflowTypes';

const SETTINGS: ModelSettings = {
  apiKey: 'sk-test',
  seedEndpoint: 'ep-seed',
  imageEndpoint: 'ep-image',
  protocol: 'openai',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
};

function img(id: string): UploadedImage {
  return { id, dataUri: `data:image/png;base64,${id}`, mediaType: 'image/png', name: `${id}.png` };
}

function makeWf() {
  return createWorkflow({
    referenceImages: [img('ref1')],
    productImages: [img('p1'), img('p2')],
    taskPurpose: '详情页场景图',
  });
}

function recipe(): VisualRecipe {
  const r = assembleVisualRecipe({
    name: '配方',
    fields: RECIPE_FIELD_KEYS.map((key) => ({
      key,
      value: `${key}值`,
      confidence: 0.8,
      evidence: [{ sourceId: 'ref1', sourceType: 'reference-image', region: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.8 }],
    })),
    required: ['主体清晰'],
    variable: ['道具可变'],
    forbidden: ['不要红字'],
  });
  return { ...r, confirmedAt: '2026-09-16T00:00:00.000Z' };
}

function identity(): IdentityFeature[] {
  return assembleIdentityFeatures({
    features: [
      {
        category: 'shape',
        statement: '圆柱瓶身',
        severityIfViolated: 'critical',
        evidence: [{ sourceId: 'p1', sourceType: 'product-image', region: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 }],
      },
    ],
  });
}

function ok<T>(data: T): ProbeOutcome<T> {
  return {
    ok: true,
    data,
    raw: { kind: 'recipe', startedAt: 't', finishedAt: 't', httpStatus: 200, rawContent: '{}', diagnostics: { endpointMasked: 'x', model: 'x' } },
  };
}

function auditRaw(candidateId: string, kind: 'pass' | 'fail' | 'review') {
  if (kind === 'pass') {
    return {
      identityScore: 92, recipeScore: 90, taskScore: 88, technicalScore: 95,
      criticalViolation: false, insufficientEvidence: false, modelConfidence: 0.9, issues: [],
    };
  }
  if (kind === 'fail') {
    return {
      identityScore: 30, recipeScore: 70, taskScore: 70, technicalScore: 70,
      criticalViolation: true, insufficientEvidence: false, modelConfidence: 0.85,
      issues: [
        {
          dimension: 'identity', severity: 'critical', statement: 'Logo 错误', confidence: 0.9,
          evidence: [{ sourceId: candidateId, sourceType: 'product-image', region: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 }],
        },
      ],
    };
  }
  return {
    identityScore: 70, recipeScore: 70, taskScore: 70, technicalScore: 70,
    criticalViolation: false, insufficientEvidence: true, modelConfidence: 0.4, issues: [],
  };
}

type RunnersFactory = (auditKind: 'pass' | 'fail' | 'review', imageFail?: boolean) => Runners;

const makeRunners: RunnersFactory = (auditKind, imageFail) => ({
  recipe: async () => ok(recipe()),
  identity: async () => ok(identity()),
  image: async (): Promise<ImageGenerateResult> =>
    imageFail
      ? { ok: false, errorClass: 'server', message: '生成失败', diagnostics: { endpointMasked: 'x', model: 'x' } }
      : { ok: true, b64Json: 'QUJD', mediaType: 'image/png', diagnostics: { endpointMasked: 'x', model: 'x' } },
  audit: async (_s, _p, candidate) =>
    ok(assembleAuditResult(candidate.id, auditRaw(candidate.id, auditKind)) as AuditResult),
  repair: async () =>
    ok({
      reason: '修正 Logo',
      positivePromptOverride: 'override positive',
      addedNegative: ['不要错误 Logo'],
      affectedFields: ['logo'],
      highRisk: true,
    } satisfies RepairProposal),
});

async function gatedWorkflow(runners: Runners) {
  let wf = await analyze(makeWf(), SETTINGS, runners);
  // 确认唯一的身份候选
  wf = { ...wf, identityFeatures: wf.identityFeatures.map((f) => confirmFeature(f)) };
  wf = confirmRecipe(wf);
  wf = confirmIdentity(wf);
  return wf;
}

describe('single-item orchestrator happy path', () => {
  it('分析→双闸门→生成→验收通过，共 4 次调用', async () => {
    const runners = makeRunners('pass');
    let wf = await analyze(makeWf(), SETTINGS, runners);
    expect(wf.state).toBe('draft');
    expect(wf.callsUsed).toBe(2);
    expect(wf.recipe).toBeTruthy();
    expect(wf.identityFeatures.every((f) => f.status === 'pending')).toBe(true);

    wf = { ...wf, identityFeatures: wf.identityFeatures.map((f) => confirmFeature(f)) };
    wf = confirmRecipe(wf);
    expect(wf.recipeConfirmed).toBe(true);
    wf = confirmIdentity(wf);

    wf = await generateFirst(wf, SETTINGS, runners);
    expect(wf.state).toBe('passed');
    expect(wf.callsUsed).toBe(4);
    expect(wf.attempts).toHaveLength(1);
    expect(wf.attempts[0].image?.dataUri).toContain('base64,QUJD');
    expect(wf.attempts[0].audit?.status).toBe('passed');
  });

  it('未确认配方不能生成', async () => {
    const runners = makeRunners('pass');
    const wf = await analyze(makeWf(), SETTINGS, runners);
    await expect(generateFirst(wf, SETTINGS, runners)).rejects.toThrow(/确认视觉配方/);
  });

  it('未完成身份锁定不能生成', async () => {
    const runners = makeRunners('pass');
    let wf = await gatedWorkflow(runners);
    wf = { ...wf, identityConfirmed: false };
    await expect(generateFirst(wf, SETTINGS, runners)).rejects.toThrow(/身份锁定/);
  });
});

describe('repair once', () => {
  it('失败→高风险修复提案（暂停）→确认重生成→通过，共 7 次，且不能再修', async () => {
    const runners = makeRunners('fail');
    let wf = await gatedWorkflow(runners);
    wf = await generateFirst(wf, SETTINGS, runners);
    expect(wf.state).toBe('failed');
    expect(wf.callsUsed).toBe(4);

    wf = await proposeRepair(wf, SETTINGS, runners);
    expect(wf.state).toBe('paused');
    expect(wf.callsUsed).toBe(5);
    expect(wf.attempts).toHaveLength(2);
    expect(wf.attempts[1].repair?.highRisk).toBe(true);

    // 应用修复（第二版用 pass 验收）
    const passRunners = makeRunners('pass');
    wf = await applyRepairAndRegenerate(wf, SETTINGS, passRunners);
    expect(wf.state).toBe('passed');
    expect(wf.repairUsed).toBe(true);
    expect(wf.callsUsed).toBe(7);
    expect(wf.attempts[1].version).toBe(2);
    expect(wf.attempts[1].image).toBeTruthy();

    await expect(proposeRepair(wf, SETTINGS, passRunners)).rejects.toThrow(/最多定向修复一次/);
  });

  it('非暂停状态不能应用修复', async () => {
    const runners = makeRunners('pass');
    const wf = await gatedWorkflow(runners);
    await expect(applyRepairAndRegenerate(wf, SETTINGS, runners)).rejects.toThrow(/待应用的修复/);
  });
});

describe('needs-review / failure handling', () => {
  it('证据不足→needs-review，人工接受→passed', async () => {
    const runners = makeRunners('review');
    let wf = await gatedWorkflow(runners);
    wf = await generateFirst(wf, SETTINGS, runners);
    expect(wf.state).toBe('needs-review');
    wf = humanAccept(wf);
    expect(wf.state).toBe('passed');
  });

  it('图片生成失败→failed 且记录 generation-failed', async () => {
    const runners = makeRunners('pass', true);
    let wf = await gatedWorkflow(runners);
    wf = await generateFirst(wf, SETTINGS, runners);
    expect(wf.state).toBe('failed');
    expect(wf.attempts[0].status).toBe('generation-failed');
    expect(wf.lastError?.ok).toBe(false);
  });

  it('未配置 settings 时分析原样返回，不崩溃', async () => {
    const wf = makeWf();
    const out = await analyze(wf, null);
    expect(out).toBe(wf);
  });

  it('刷新后进行中状态转 interrupted，且不伪装运行', () => {
    const wf = { ...makeWf(), state: 'generating' as const };
    const resumed = resumeWorkflow(wf);
    expect(resumed.state).toBe('interrupted');
  });
});

describe('input bounds', () => {
  it('参考图/商品图数量越界拒绝创建', () => {
    expect(() =>
      createWorkflow({ referenceImages: [], productImages: [img('a'), img('b')], taskPurpose: '' }),
    ).toThrow(/参考图/);
    expect(() =>
      createWorkflow({ referenceImages: [img('r')], productImages: [img('a')], taskPurpose: '' }),
    ).toThrow(/商品多角度图/);
  });
});
