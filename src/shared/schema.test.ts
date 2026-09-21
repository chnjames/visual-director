import { describe, it, expect } from 'vitest';
import { RECIPE_FIELD_KEYS } from '../shared/constants';
import {
  assembleVisualRecipe,
  assembleIdentityFeatures,
  confirmFeature,
  rejectFeature,
  hardConstraints,
  visualRecipeSchema,
  modelAuditPayloadSchema,
} from '../shared/schema';

function evidence(sourceId = 'ref1') {
  return {
    sourceId,
    sourceType: 'reference-image' as const,
    region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    quote: '依据',
    confidence: 0.82,
  };
}

function validRecipePayload() {
  return {
    name: '暖光木桌陶瓷场景',
    fields: RECIPE_FIELD_KEYS.map((key, i) => ({
      key,
      value: `${key} 描述`,
      confidence: 0.7 + (i % 3) * 0.05,
      evidence: [evidence()],
      locked: true, // 模型即使给出 locked，也必须被程序强制为 false
    })),
    required: ['主体居中', '暖调侧光'],
    variable: ['背景小道具'],
    forbidden: ['人物', '水印'],
  };
}

describe('A. VisualRecipe Schema', () => {
  it('合法输出：12 字段齐全可通过，且 locked 被强制为 false', () => {
    const recipe = assembleVisualRecipe(validRecipePayload());
    expect(recipe.fields).toHaveLength(12);
    expect(recipe.fields.every((f) => f.locked === false)).toBe(true);
    expect(recipe.required).toContain('主体居中');
    // 完整合同再校验通过
    expect(visualRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  it('缺字段：少一个字段必须被拒绝', () => {
    const payload = validRecipePayload() as any;
    payload.fields = payload.fields.slice(1); // 只剩 11 个
    expect(() => assembleVisualRecipe(payload)).toThrow(/12|缺少|字段/);
  });

  it('重复字段：同一 key 出现两次必须被拒绝', () => {
    const payload = validRecipePayload() as any;
    payload.fields[1] = { ...payload.fields[0] }; // 让第二个字段与第一个同 key
    expect(() => assembleVisualRecipe(payload)).toThrow();
  });

  it('错误类型：confidence 为字符串必须被拒绝', () => {
    const payload = validRecipePayload() as any;
    payload.fields[0].confidence = 'high';
    expect(() => assembleVisualRecipe(payload)).toThrow();
  });

  it('越界：confidence>1、区域越界、证据为空都必须被拒绝', () => {
    let p = validRecipePayload() as any;
    p.fields[0].confidence = 1.5;
    expect(() => assembleVisualRecipe(p)).toThrow();

    p = validRecipePayload() as any;
    p.fields[0].evidence[0].region = { x: 0.8, y: 0, width: 0.5, height: 1 };
    expect(() => assembleVisualRecipe(p)).toThrow();

    p = validRecipePayload() as any;
    p.fields[0].evidence = [];
    expect(() => assembleVisualRecipe(p)).toThrow();
  });
});

describe('B. IdentityFeature 状态', () => {
  const payload = {
    features: [
      {
        category: 'shape' as const,
        statement: '杯身为直筒圆形',
        evidence: [
          { sourceId: 'p1', sourceType: 'product-image' as const, confidence: 0.9 },
        ],
        severityIfViolated: 'critical' as const,
        // 尝试越权：模型/攻击者把状态伪造成 confirmed、来源伪造成 user-declared
        status: 'confirmed',
        source: 'user-declared',
      },
    ],
  };

  it('模型提出的特征一律强制为 pending / model-proposed，不能自证为事实', () => {
    const features = assembleIdentityFeatures(payload);
    expect(features).toHaveLength(1);
    expect(features[0].status).toBe('pending');
    expect(features[0].source).toBe('model-proposed');
    expect(hardConstraints(features)).toHaveLength(0);
  });

  it('只有用户确认后才成为硬约束；否决后不进入硬约束', () => {
    const [f] = assembleIdentityFeatures(payload);
    const confirmed = confirmFeature(f);
    expect(confirmed.status).toBe('confirmed');
    expect(hardConstraints([confirmed])).toHaveLength(1);
    const rejected = rejectFeature(f);
    expect(rejected.status).toBe('rejected');
    expect(hardConstraints([rejected])).toHaveLength(0);
  });
});

describe('验收模型负载 Schema', () => {
  it('分数越界（>100）必须被拒绝', () => {
    const bad = {
      identityScore: 120,
      recipeScore: 90,
      taskScore: 90,
      technicalScore: 90,
      criticalViolation: false,
      insufficientEvidence: false,
      modelConfidence: 0.9,
      issues: [],
    };
    expect(modelAuditPayloadSchema.safeParse(bad).success).toBe(false);
  });
});
