import { describe, expect, it } from 'vitest';
import { RECIPE_FIELD_KEYS } from '../../shared/constants';
import { assembleVisualRecipe } from '../../shared/schema';
import type {
  AuditResult,
  IdentityFeature,
  ModelSettings,
  RawModelCall,
  UploadedImage,
  VisualRecipe,
} from '../../shared/types';
import {
  advancedCompatibilityTemplateGraph as standardTemplateGraph,
  legacyFourNodeTemplateGraph,
} from './template';
import { getTemplate } from './templates';
import {
  bindPrompt,
  extractRecipe,
  generateAndAudit,
  generationSize,
  graphHasRecipeSource,
  isStandardMainline,
  planNodeRuns,
  runConnectedGraph,
  topoSort,
} from './execute';
import type { StandardRunners } from './execute';

const settings: ModelSettings = {
  apiKey: 'test-key',
  seedEndpoint: 'ep-seed',
  imageEndpoint: 'ep-image',
  protocol: 'openai',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
};

describe('Seedream 5.0 输出尺寸', () => {
  it('按 2K/3K 与比例映射到官方有效像素尺寸', () => {
    expect(generationSize('1:1', '2K')).toBe('2048x2048');
    expect(generationSize('3:4', '2K')).toBe('1728x2304');
    expect(generationSize('16:9', '2K')).toBe('2848x1600');
    expect(generationSize('9:16', '3K')).toBe('2304x4096');
  });

  it('旧草稿分辨率安全迁移到 2K 方形默认值', () => {
    expect(generationSize('unknown', '1024')).toBe('2048x2048');
  });
});

function img(id: string): UploadedImage {
  return { id, dataUri: 'data:image/png;base64,aGk=', mediaType: 'image/png', name: `${id}.png` };
}

function recipe(confirmed = false): VisualRecipe {
  const r = assembleVisualRecipe({
    name: '配方',
    fields: RECIPE_FIELD_KEYS.map((key) => ({
      key,
      value: `${key}值`,
      confidence: 0.8,
      evidence: [{ sourceId: 'ref1', sourceType: 'reference-image', region: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.8 }],
    })),
    required: ['主体清晰'],
    variable: [],
    forbidden: ['不要红字'],
  });
  return confirmed ? { ...r, confirmedAt: '2026-09-19T00:00:00.000Z' } : r;
}

function raw(): RawModelCall {
  return {
    kind: 'recipe',
    startedAt: '2026-09-19T00:00:00.000Z',
    finishedAt: '2026-09-19T00:00:01.000Z',
    httpStatus: 200,
    rawContent: '{}',
    diagnostics: { endpointMasked: 'ep', model: 'm' },
  };
}

function audit(): AuditResult {
  return {
    productId: 'generated',
    status: 'passed',
    identityScore: 90,
    recipeScore: 80,
    taskScore: 85,
    technicalScore: 88,
    compositeScore: 86,
    criticalViolation: false,
    insufficientEvidence: false,
    issues: [],
    modelConfidence: 0.8,
    statusReason: '通过',
  };
}

function identity(status: IdentityFeature['status'] = 'pending'): IdentityFeature[] {
  return [
    {
      id: 'identity-1',
      category: 'shape',
      statement: '保持瓶身轮廓与瓶口结构',
      source: 'model-proposed',
      evidence: [],
      status,
      severityIfViolated: 'critical',
    },
  ];
}

/** 闸门主线：参考图 + 商品图 + 提示词 */
function graphWithInputs() {
  const g = standardTemplateGraph();
  const ref = g.nodes.find((n) => n.type === 'referenceInput')!;
  const product = g.nodes.find((n) => n.type === 'productInput')!;
  const compiler = g.nodes.find((n) => n.type === 'promptCompiler')!;
  ref.config = { ...ref.config, images: [img('r1')], purpose: '详情页首屏', excludeSubject: true };
  product.config = { ...product.config, images: [img('p1'), img('p2')] };
  compiler.config = { ...compiler.config, positivePrompt: '浅色背景 {{visualRecipe}}', negativePrompt: '避免杂乱' };
  return g;
}

/** 旧四节点兼容图 */
function legacyGraphWithInputs() {
  const g = legacyFourNodeTemplateGraph();
  const analyze = g.nodes.find((n) => n.type === 'referenceAnalyze')!;
  const editor = g.nodes.find((n) => n.type === 'promptEditor')!;
  const gen = g.nodes.find((n) => n.type === 'sceneGenerate')!;
  analyze.config = { ...analyze.config, images: [img('r1')], purpose: '详情页首屏' };
  editor.config = { ...editor.config, positivePrompt: '浅色背景 {{visualRecipe}}', negativePrompt: '避免杂乱' };
  gen.config = { ...gen.config, productImages: [img('p1'), img('p2')] };
  return g;
}

describe('标准主线执行', () => {
  it('出厂图被识别为可执行主线', () => {
    expect(isStandardMainline(standardTemplateGraph())).toBe(true);
    expect(isStandardMainline(legacyFourNodeTemplateGraph())).toBe(true);
    expect(isStandardMainline({
      nodes: ['promptEditor', 'referenceAnalyze', 'resultGallery', 'sceneGenerate'].map((type, index) => ({
        id: `n${index}`,
        type,
        position: { x: 0, y: 0 },
        config: {},
      })),
      edges: [],
    })).toBe(true);
    expect(isStandardMainline({ nodes: [], edges: [] })).toBe(false);
  });

  it('变量替换不改写未出现的占位符', () => {
    expect(bindPrompt('A {{taskPurpose}} B', { visualRecipe: '配方', taskPurpose: '主图', productImages: '无' })).toBe(
      'A 主图 B',
    );
  });

  it('没有参考图时不调用模型', async () => {
    let calls = 0;
    const runners: StandardRunners = {
      recipe: async () => {
        calls += 1;
        return { ok: false, errorClass: 'bad-request', message: '不应调用', diagnostics: { endpointMasked: 'x', model: 'x' } };
      },
      image: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    };
    const res = await extractRecipe(standardTemplateGraph(), settings, runners);
    expect(res.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('提取配方只调用一次，且结果仍未确认', async () => {
    const g = graphWithInputs();
    const ref = g.nodes.find((n) => n.type === 'referenceInput')!;
    ref.config = {
      ...ref.config,
      images: [img('r1'), img('r2')],
      purpose: '主图 · 场景展示',
    };
    const runners: StandardRunners = {
      recipe: async () => ({
        ok: true,
        data: recipe(true),
        raw: {
          kind: 'recipe',
          startedAt: '',
          finishedAt: '',
          httpStatus: 200,
          rawContent: JSON.stringify({
            name: '配方',
            meta: {
              imageRoles: [
                { sourceId: 'r1', role: 'hero' },
                { sourceId: 'r2', role: 'detail' },
              ],
              conflictHint: '',
            },
          }),
          diagnostics: { endpointMasked: 'x', model: 'x' },
        },
      }),
      image: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    };
    const res = await extractRecipe(g, settings, runners);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.callsUsed).toBe(1);
    expect(res.recipe.confirmedAt).toBeUndefined();
    expect(res.summary).toContain('主体清晰');
    expect(res.meta.conflictHint).toMatch(/主图与详情/);
    expect(res.meta.purposeBucket).toBe('hero');
  });

  it('闸门已确认配方时，按连线运行跳过提取', async () => {
    const g = graphWithInputs();
    const gate = g.nodes.find((n) => n.type === 'recipeConfirmGate')!;
    gate.config = { ...gate.config, confirmedRecipe: recipe(true) };
    const identityGate = g.nodes.find((n) => n.type === 'identityConfirmGate')!;
    identityGate.config = { ...identityGate.config, confirmedFeatures: identity('confirmed') };
    let recipeCalls = 0;
    const runners: StandardRunners = {
      recipe: async () => {
        recipeCalls += 1;
        return { ok: false, errorClass: 'bad-request', message: '不应调用', diagnostics: { endpointMasked: 'x', model: 'x' } };
      },
      image: async () => ({
        ok: true,
        b64Json: 'aGk=',
        mediaType: 'image/png',
        diagnostics: { endpointMasked: 'ep', model: 'm' },
      }),
      audit: async () => ({ ok: true, data: audit(), raw: raw() }),
    };
    const res = await runConnectedGraph(g, settings, { runners });
    expect(recipeCalls).toBe(0);
    expect(res.status).toBe('done');
  });

  it('整图运行按拓扑通知 onNodeStart，供画布连线动效使用', async () => {
    const seen: string[] = [];
    const g = getTemplate('blank').buildGraph();
    const runners: StandardRunners = {
      recipe: async () => ({
        ok: false,
        errorClass: 'bad-request',
        message: 'no',
        diagnostics: { endpointMasked: 'x', model: 'x' },
      }),
      image: async () => ({
        ok: true,
        b64Json: 'aGk=',
        mediaType: 'image/png',
        diagnostics: { endpointMasked: 'ep', model: 'm' },
      }),
      audit: async () => ({ ok: true, data: audit(), raw: raw() }),
    };
    await runConnectedGraph(g, settings, {
      runners,
      onNodeStart: (id) => seen.push(id),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
    expect(g.nodes.some((node) => seen.includes(node.id))).toBe(true);
  });

  it('未确认配方不能生成', async () => {
    let imageCalls = 0;
    const runners: StandardRunners = {
      recipe: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      image: async () => {
        imageCalls += 1;
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    };
    const res = await generateAndAudit(graphWithInputs(), settings, recipe(false), runners);
    expect(res.ok).toBe(false);
    expect(imageCalls).toBe(0);
  });

  it('确认后生成并验收，用户文案不能盖掉配方硬约束', async () => {
    const runners: StandardRunners = {
      recipe: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      image: async (_s, positive) => {
        expect(positive).toContain('主体清晰');
        expect(positive).toContain('浅色背景');
        expect(positive).toContain('不得覆盖');
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => ({
        ok: true,
        data: audit(),
        raw: raw(),
      }),
    };
    const res = await generateAndAudit(graphWithInputs(), settings, recipe(true), runners);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 商品图在 productInput→resultAuditor，生成步骤本身可能跳过验收
    expect(res.callsUsed).toBeGreaterThanOrEqual(1);
    expect(res.imageDataUri.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('没有商品图时出图但不假装已验收', async () => {
    const g = graphWithInputs();
    const product = g.nodes.find((n) => n.type === 'productInput')!;
    product.config = { ...product.config, images: [] };
    let audits = 0;
    const runners: StandardRunners = {
      recipe: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      image: async () => ({ ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } }),
      audit: async () => {
        audits += 1;
        return { ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } };
      },
    };
    const res = await generateAndAudit(g, settings, recipe(true), runners);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.audit).toBeNull();
    expect(res.auditSkippedReason).toMatch(/验收未执行/);
    expect(audits).toBe(0);
    expect(res.callsUsed).toBe(1);
  });

  it('没有适配器的节点不会被当成可运行', () => {
    const rows = planNodeRuns({
      nodes: [
        { id: 'a', type: 'promptEditor', position: { x: 0, y: 0 }, config: {} },
        { id: 'b', type: 'identityExtractor', position: { x: 1, y: 0 }, config: {} },
        { id: 'c', type: 'backgroundRemove', position: { x: 2, y: 0 }, config: {} },
        { id: 'd', type: 'recipeConfirmGate', position: { x: 3, y: 0 }, config: {} },
        { id: 'e', type: 'promptCompiler', position: { x: 4, y: 0 }, config: {} },
      ],
      edges: [],
    });
    expect(rows.find((r) => r.type === 'promptEditor')?.action).toBe('prompt');
    expect(rows.find((r) => r.type === 'promptCompiler')?.action).toBe('prompt');
    expect(rows.find((r) => r.type === 'recipeConfirmGate')?.action).toBe('gate');
    expect(rows.find((r) => r.type === 'identityExtractor')?.action).toBe('identity');
    expect(rows.find((r) => r.type === 'backgroundRemove')?.detail).toMatch(/规划中/);
  });

  it('没有配方节点时，只用已连接的提示词出图，并且不验收', async () => {
    const graph = {
      nodes: [
        {
          id: 'p',
          type: 'promptEditor',
          position: { x: 0, y: 0 },
          config: { positivePrompt: '白底静物', negativePrompt: '不要文字' },
        },
        {
          id: 'g',
          type: 'sceneGenerate',
          position: { x: 1, y: 0 },
          config: { productImages: [img('p1')] },
        },
      ],
      edges: [{ id: 'e', from: { node: 'p', port: 'prompt' }, to: { node: 'g', port: 'prompt' } }],
    };
    expect(graphHasRecipeSource(graph)).toBe(false);
    let audits = 0;
    const runners: StandardRunners = {
      recipe: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      image: async (_s, positive) => {
        expect(positive).toContain('白底静物');
        expect(positive).toContain('输出用途');
        expect(positive).not.toContain('不得覆盖');
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => {
        audits += 1;
        return { ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } };
      },
    };
    const res = await generateAndAudit(graph, settings, null, runners);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recipeBound).toBe(false);
    expect(res.audit).toBeNull();
    expect(res.auditSkippedReason).toMatch(/没有已确认配方/);
    expect(audits).toBe(0);
  });

  it('直接生成模板只用生成节点上的提示词和商品图出图', async () => {
    const graph = getTemplate('blank').buildGraph();
    const generate = graph.nodes.find((n) => n.type === 'sceneGenerate')!;
    generate.config.positivePrompt = '浅色石材台面的护肤品';
    generate.config.productImages = [img('p1')];
    const runners: StandardRunners = {
      recipe: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      image: async (_s, positive) => {
        expect(positive).toContain('浅色石材台面的护肤品');
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    };
    const res = await generateAndAudit(graph, settings, null, runners);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recipeBound).toBe(false);
  });

  it('直接生成缺少提示词时，提示填写生成节点而不是去接提示词节点', async () => {
    const graph = getTemplate('blank').buildGraph();
    const generate = graph.nodes.find((n) => n.type === 'sceneGenerate')!;
    generate.config.productImages = [img('p1')];
    const res = await generateAndAudit(graph, settings, null, {
      recipe: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      image: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/商品场景生成/);
    expect(res.message).not.toMatch(/提示词节点/);
  });

  it('模型失败时不返回图片', async () => {
    const runners: StandardRunners = {
      recipe: async () => ({
        ok: false,
        errorClass: 'invalid-key',
        message: '密钥无效',
        diagnostics: { endpointMasked: 'ep', model: 'm' },
      }),
      image: async () => ({ ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } }),
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    };
    const res = await extractRecipe(graphWithInputs(), settings, runners);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe('密钥无效');
  });

  it('图上多一个规划中节点时，仍可提取配方', async () => {
    const g = graphWithInputs();
    g.nodes.push({ id: 'extra', type: 'backgroundRemove', position: { x: 9, y: 9 }, config: {} });
    const runners: StandardRunners = {
      recipe: async () => ({ ok: true, data: recipe(true), raw: raw() }),
      image: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    };
    const res = await extractRecipe(g, settings, runners);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recipe.confirmedAt).toBeUndefined();
  });

  it('按连线运行：有闸门时在闸门暂停，确认后继续出图', async () => {
    const g = graphWithInputs();
    let recipeCalls = 0;
    let imageCalls = 0;
    const runners: StandardRunners = {
      recipe: async () => {
        recipeCalls += 1;
        return { ok: true, data: recipe(true), raw: raw() };
      },
      identity: async () => ({ ok: true, data: identity(), raw: raw() }),
      image: async (_s, positive) => {
        imageCalls += 1;
        expect(positive).toContain('主体清晰');
        expect(positive).toContain('不得覆盖');
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => ({ ok: true, data: audit(), raw: raw() }),
    };

    expect(topoSort(g)?.length).toBe(11);
    const paused = await runConnectedGraph(g, settings, { runners });
    expect(paused.status).toBe('awaiting-confirm');
    if (paused.status !== 'awaiting-confirm' || paused.gate !== 'recipe') return;
    expect(recipeCalls).toBe(1);
    expect(imageCalls).toBe(0);
    expect(paused.state.steps.some((s) => s.status === 'paused' && s.title.includes('配方确认'))).toBe(true);

    const confirmed = { ...paused.recipe, confirmedAt: '2026-09-20T00:00:00.000Z' };
    const waitingIdentity = await runConnectedGraph(g, settings, {
      runners,
      confirmedRecipe: confirmed,
      resume: paused.state,
    });
    expect(waitingIdentity.status).toBe('awaiting-confirm');
    if (waitingIdentity.status !== 'awaiting-confirm' || waitingIdentity.gate !== 'identity') return;
    expect(waitingIdentity.features).toHaveLength(1);
    expect(imageCalls).toBe(0);

    const confirmedIdentity = waitingIdentity.features.map((feature) => ({
      ...feature,
      status: 'confirmed' as const,
    }));
    const done = await runConnectedGraph(g, settings, {
      runners,
      confirmedRecipe: confirmed,
      confirmedIdentity,
      resume: waitingIdentity.state,
    });
    expect(done.status).toBe('done');
    if (done.status !== 'done') return;
    expect(recipeCalls).toBe(1);
    expect(imageCalls).toBe(1);
    expect(done.generation?.ok).toBe(true);
    if (!done.generation?.ok) return;
    expect(done.generation.recipeBound).toBe(true);
  });

  it('精简四节点：参考分析不再强制旧配方确认闸门', async () => {
    const g = legacyGraphWithInputs();
    const runners: StandardRunners = {
      recipe: async () => ({ ok: true, data: recipe(true), raw: raw() }),
      image: async () => ({ ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } }),
      audit: async () => ({ ok: true, data: audit(), raw: raw() }),
    };
    const result = await runConnectedGraph(g, settings, { runners });
    expect(result.status).toBe('done');
    expect(result.state.steps.some((s) => s.status === 'paused')).toBe(false);
  });

  it('验收失败时暂停确认修复，确认后只重生成一次并重新验收', async () => {
    const g = graphWithInputs();
    let imageCalls = 0;
    let auditCalls = 0;
    let repairCalls = 0;
    const runners: StandardRunners = {
      recipe: async () => ({ ok: true, data: recipe(), raw: raw() }),
      identity: async () => ({ ok: true, data: identity(), raw: raw() }),
      image: async () => {
        imageCalls += 1;
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => {
        auditCalls += 1;
        const result = audit();
        return {
          ok: true,
          data:
            auditCalls === 1
              ? {
                  ...result,
                  status: 'failed' as const,
                  criticalViolation: true,
                  statusReason: '商品轮廓发生变化',
                }
              : result,
          raw: raw(),
        };
      },
      repair: async () => {
        repairCalls += 1;
        return {
          ok: true,
          data: {
            reason: '加强轮廓约束',
            addedNegative: ['不要改变瓶口结构'],
            affectedFields: ['identity'],
            highRisk: true,
          },
          raw: raw(),
        };
      },
    };

    const recipePause = await runConnectedGraph(g, settings, { runners });
    expect(recipePause.status).toBe('awaiting-confirm');
    if (recipePause.status !== 'awaiting-confirm' || recipePause.gate !== 'recipe') return;
    const confirmedRecipe = { ...recipePause.recipe, confirmedAt: new Date().toISOString() };

    const identityPause = await runConnectedGraph(g, settings, {
      runners,
      confirmedRecipe,
      resume: recipePause.state,
    });
    expect(identityPause.status).toBe('awaiting-confirm');
    if (identityPause.status !== 'awaiting-confirm' || identityPause.gate !== 'identity') return;
    const confirmedIdentity = identityPause.features.map((feature) => ({
      ...feature,
      status: 'confirmed' as const,
    }));

    const repairPause = await runConnectedGraph(g, settings, {
      runners,
      confirmedRecipe,
      confirmedIdentity,
      resume: identityPause.state,
    });
    expect(repairPause.status).toBe('awaiting-confirm');
    if (repairPause.status !== 'awaiting-confirm' || repairPause.gate !== 'repair') return;
    expect(imageCalls).toBe(1);
    expect(auditCalls).toBe(1);
    expect(repairCalls).toBe(1);

    const done = await runConnectedGraph(g, settings, {
      runners,
      confirmedRecipe,
      confirmedIdentity,
      confirmedRepair: repairPause.proposal,
      resume: repairPause.state,
    });
    expect(done.status).toBe('done');
    expect(imageCalls).toBe(2);
    expect(auditCalls).toBe(2);
    expect(repairCalls).toBe(1);
    if (done.status !== 'done' || !done.generation?.ok) return;
    expect(done.generation.audit?.status).toBe('passed');
  });

  it('按连线运行：无配方节点时直接用提示词出图', async () => {
    const graph = {
      nodes: [
        {
          id: 'p',
          type: 'promptEditor',
          position: { x: 0, y: 0 },
          config: { positivePrompt: '白底静物', negativePrompt: '不要文字' },
        },
        {
          id: 'g',
          type: 'sceneGenerate',
          position: { x: 1, y: 0 },
          config: { productImages: [img('p1')] },
        },
      ],
      edges: [{ id: 'e', from: { node: 'p', port: 'prompt' }, to: { node: 'g', port: 'prompt' } }],
    };
    const runners: StandardRunners = {
      recipe: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      image: async (_s, positive) => {
        expect(positive).toContain('白底静物');
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    };
    const res = await runConnectedGraph(graph, settings, { runners });
    expect(res.status).toBe('done');
    if (res.status !== 'done') return;
    expect(res.generation?.ok).toBe(true);
    if (!res.generation?.ok) return;
    expect(res.generation.recipeBound).toBe(false);
    expect(res.state.steps.map((s) => s.title)).toEqual(['提示词编辑与优化', '商品场景生成']);
  });
});

function mainlineGraph(overrides?: { prompt?: string; edited?: boolean }) {
  const g = getTemplate('standard-still-life').buildGraph();
  const analyze = g.nodes.find((n) => n.type === 'referenceAnalyze')!;
  const editor = g.nodes.find((n) => n.type === 'promptEditor')!;
  const products = g.nodes.find((n) => n.type === 'productImages')!;
  const gen = g.nodes.find((n) => n.type === 'sceneGenerate')!;
  analyze.config = { ...analyze.config, images: [img('r1')], purpose: 'main-scene' };
  products.config = { ...products.config, images: [img('p1')] };
  gen.config = { ...gen.config, productImages: [img('ignored')] };
  if (overrides?.prompt !== undefined) editor.config.positivePrompt = overrides.prompt;
  if (overrides?.edited) editor.config.promptEditedByUser = true;
  return g;
}

describe('精简主线提示词契约', () => {
  it('分析产出建议提示词，不把 {{ }} 送到图片模型', async () => {
    const g = mainlineGraph({ prompt: '浅色背景 {{visualRecipe}}' });
    const runners: StandardRunners = {
      recipe: async () => ({ ok: true, data: recipe(), raw: raw() }),
      image: async (_s, positive, _negative, options) => {
        expect(positive).not.toContain('{{visualRecipe}}');
        expect(positive).not.toContain('{{taskPurpose}}');
        expect(positive).toContain('浅色背景');
        expect(options?.productImages?.map((image) => image.id)).toEqual(['p1']);
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    };
    const result = await runConnectedGraph(g, settings, { runners });
    expect(result.status).toBe('done');
    if (result.status !== 'done' || !result.extraction?.ok) return;
    expect(result.extraction.suggestedPrompt).toContain('主体位置');
    expect(result.extraction.suggestedPrompt).toContain('用途：主图 · 场景展示');
  });

  it('空提示词在整图运行时自动填入建议稿', async () => {
    const g = mainlineGraph();
    const runners: StandardRunners = {
      recipe: async () => ({ ok: true, data: recipe(), raw: raw() }),
      image: async (_s, positive) => {
        expect(positive).not.toContain('{{');
        expect(positive).toContain('主体位置');
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    };
    const result = await runConnectedGraph(g, settings, { runners });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.generation?.ok).toBe(true);
  });

  it('用户手改过的提示词不会被分析自动覆盖', async () => {
    const g = mainlineGraph({ prompt: '手写侧光台面', edited: true });
    const runners: StandardRunners = {
      recipe: async () => ({ ok: true, data: recipe(), raw: raw() }),
      image: async (_s, positive) => {
        expect(positive).toContain('手写侧光台面');
        expect(positive).not.toContain('{{');
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    };
    const result = await runConnectedGraph(g, settings, { runners });
    expect(result.status).toBe('done');
    const editor = g.nodes.find((n) => n.type === 'promptEditor')!;
    expect(editor.config.positivePrompt).toBe('手写侧光台面');
  });

  it('只跑生成且提示词节点仍为空时，报在提示词节点而不是静默用配方', async () => {
    const g = mainlineGraph();
    const generate = g.nodes.find((n) => n.type === 'sceneGenerate')!;
    const res = await generateAndAudit(g, settings, null, {
      recipe: async () => ({ ok: true, data: recipe(), raw: raw() }),
      image: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    }, generate.id);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/提示词编辑/);
  });

  it('出厂变量模板没有分析结果时不能当成正文出图', async () => {
    const g = mainlineGraph({ prompt: '{{visualRecipe}}\n{{taskPurpose}}' });
    const generate = g.nodes.find((n) => n.type === 'sceneGenerate')!;
    let imageCalls = 0;
    const res = await generateAndAudit(g, settings, null, {
      recipe: async () => ({ ok: true, data: recipe(), raw: raw() }),
      image: async () => {
        imageCalls += 1;
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    }, generate.id);
    expect(res.ok).toBe(false);
    expect(imageCalls).toBe(0);
    if (res.ok) return;
    expect(res.message).not.toMatch(/无分析结果/);
  });

  it('商品图节点连上后，生成节点自己的商品图不会送进图片模型', async () => {
    const g = mainlineGraph({ prompt: '浅色台面', edited: true });
    const products = g.nodes.find((n) => n.type === 'productImages')!;
    products.config.images = [];
    const generate = g.nodes.find((n) => n.type === 'sceneGenerate')!;
    let imageCalls = 0;
    const res = await generateAndAudit(g, settings, null, {
      recipe: async () => ({ ok: true, data: recipe(), raw: raw() }),
      image: async () => {
        imageCalls += 1;
        return { ok: true, b64Json: 'aGk=', mediaType: 'image/png', diagnostics: { endpointMasked: 'ep', model: 'm' } };
      },
      audit: async () => ({ ok: false, errorClass: 'bad-request', message: 'no', diagnostics: { endpointMasked: 'x', model: 'x' } }),
    }, generate.id);
    expect(res.ok).toBe(false);
    expect(imageCalls).toBe(0);
    if (res.ok) return;
    expect(res.message).toBe('请在「商品图」节点上传至少 1 张商品图。');
  });
});
