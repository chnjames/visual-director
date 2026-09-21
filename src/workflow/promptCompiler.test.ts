import { describe, expect, it } from 'vitest';
import { compilePrompt } from './promptCompiler';
import { assembleIdentityFeatures, assembleVisualRecipe, confirmFeature } from '../shared/schema';
import { RECIPE_FIELD_KEYS } from '../shared/constants';
import type { IdentityFeature, VisualRecipe } from '../shared/types';

function rawRecipe() {
  return {
    name: '测试配方',
    fields: RECIPE_FIELD_KEYS.map((key) => ({
      key,
      value: `${key} 的值`,
      confidence: 0.8,
      evidence: [
        { sourceId: 'ref-1', sourceType: 'reference-image', region: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.8 },
      ],
    })),
    required: ['主体清晰'],
    variable: ['背景小物可替换'],
    forbidden: ['不要红色背景'],
  };
}

function recipe(confirmed = true): VisualRecipe {
  const r = assembleVisualRecipe(rawRecipe());
  return confirmed ? { ...r, confirmedAt: '2026-09-16T00:00:00.000Z' } : r;
}

function features(): IdentityFeature[] {
  let fs = assembleIdentityFeatures({
    features: [
      {
        category: 'shape',
        statement: '圆柱形瓶身',
        severityIfViolated: 'critical',
        evidence: [
          { sourceId: 'p-1', sourceType: 'product-image', region: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 },
        ],
      },
      {
        category: 'logo',
        statement: '瓶身正面蓝色品牌字样',
        severityIfViolated: 'major',
        evidence: [
          { sourceId: 'p-1', sourceType: 'product-image', region: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.7 },
        ],
      },
    ],
  });
  fs = fs.map((f) => (f.id === fs[0].id ? confirmFeature(f) : f)); // 只确认形状，Logo 保持 pending
  return fs;
}

describe('promptCompiler', () => {
  it('未确认配方不能编译', () => {
    expect(() => compilePrompt(recipe(false), [], '')).toThrow(/尚未经用户确认/);
  });

  it('缺字段的配方不能编译', () => {
    const r = recipe();
    const broken = { ...r, fields: r.fields.slice(1) };
    expect(() => compilePrompt(broken, [], '')).toThrow(/字段不完整/);
  });

  it('只有 confirmed 身份特征进入硬约束，pending 不进入', () => {
    const c = compilePrompt(recipe(), features(), '详情页首屏');
    expect(c.identityConstraints.some((s) => s.includes('圆柱形瓶身'))).toBe(true);
    expect(c.identityConstraints.some((s) => s.includes('蓝色品牌字样'))).toBe(false);
    expect(c.positivePrompt).toContain('详情页首屏');
  });

  it('12 字段按合同顺序进入 fieldValues', () => {
    const c = compilePrompt(recipe(), [], '');
    expect(Object.keys(c.fieldValues)).toEqual([...RECIPE_FIELD_KEYS]);
  });

  it('负向合并配方 forbidden 与通用安全负向且去重', () => {
    const c = compilePrompt(recipe(), [], '');
    expect(c.negativePrompt).toContain('不要红色背景');
    expect(c.negativePrompt).toContain('水印');
    expect(c.forbiddenRules).toContain('不要红色背景');
  });

  it('无任何已确认身份时给通用身份保持语，不报错', () => {
    const c = compilePrompt(recipe(), [], '');
    expect(c.positivePrompt).toContain('形状、关键部件、颜色、材质与纹理不变');
    expect(c.identityConstraints).toEqual([]);
  });
});
