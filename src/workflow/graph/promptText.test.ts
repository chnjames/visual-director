import { describe, expect, it } from 'vitest';
import {
  autoFillPromptPatch,
  bindAndFinalizePrompt,
  canAutoFillPrompt,
  isVacantPrompt,
  promptEditorStatus,
  recipeToSuggestedPrompt,
  stripPromptVariables,
} from './promptText';
import { RECIPE_FIELD_KEYS } from '../../shared/constants';
import { assembleVisualRecipe } from '../../shared/schema';

function recipe() {
  return assembleVisualRecipe({
    name: '配方',
    fields: RECIPE_FIELD_KEYS.map((key) => ({
      key,
      value: `${key}值`,
      confidence: 0.8,
      evidence: [{ sourceId: 'r', sourceType: 'reference-image', confidence: 0.8 }],
    })),
    required: ['主体清晰'],
    variable: [],
    forbidden: ['红字'],
  });
}

describe('提示词正文契约', () => {
  it('空字符串和出厂变量模板都视为空位', () => {
    expect(isVacantPrompt('')).toBe(true);
    expect(isVacantPrompt('   ')).toBe(true);
    expect(isVacantPrompt('{{visualRecipe}}\n{{taskPurpose}}')).toBe(true);
    expect(isVacantPrompt('（无分析结果）\ndetail-closeup')).toBe(true);
    expect(isVacantPrompt('浅色石材台面')).toBe(false);
  });

  it('用户改过的提示词不能被分析自动覆盖', () => {
    expect(canAutoFillPrompt({ positivePrompt: '', promptEditedByUser: false })).toBe(true);
    expect(canAutoFillPrompt({ positivePrompt: '{{visualRecipe}}', promptEditedByUser: false })).toBe(true);
    expect(canAutoFillPrompt({ positivePrompt: '（无分析结果）\ndetail-closeup', promptEditedByUser: false })).toBe(true);
    expect(canAutoFillPrompt({ positivePrompt: '手写', promptEditedByUser: true })).toBe(false);
    expect(canAutoFillPrompt({ positivePrompt: '', promptEditedByUser: true })).toBe(false);
  });

  it('绑定后清掉残留变量，避免送进图片模型', () => {
    expect(bindAndFinalizePrompt('{{visualRecipe}}', {
      visualRecipe: '侧光',
      taskPurpose: '主图',
      productImages: '',
    })).toBe('侧光');
    expect(stripPromptVariables('画面 {{visualRecipe}}')).toBe('画面');
    expect(stripPromptVariables('{{taskPurpose}}')).toBe('');
  });

  it('建议提示词用人能读的中文字段，并带用途', () => {
    const text = recipeToSuggestedPrompt(recipe(), 'main-scene');
    expect(text).toContain('用途：主图 · 场景展示');
    expect(text).toContain('主体位置：');
    expect(text).not.toContain('subjectPlacement：');
  });

  it('卡片状态：空 / 已采用分析 / 已手改', () => {
    expect(promptEditorStatus({ positivePrompt: '' })).toBe('empty');
    expect(promptEditorStatus({
      positivePrompt: '侧光',
      appliedFromAnalysisAt: '2026-09-21T00:00:00.000Z',
    })).toBe('from-analysis');
    expect(promptEditorStatus({
      positivePrompt: '侧光',
      promptEditedByUser: true,
      appliedFromAnalysisAt: '2026-09-21T00:00:00.000Z',
    })).toBe('edited');
  });

  it('空位才能自动填入建议稿', () => {
    expect(autoFillPromptPatch({ positivePrompt: '' }, '侧光')).toEqual(
      expect.objectContaining({ positivePrompt: '侧光', promptEditedByUser: false }),
    );
    expect(autoFillPromptPatch({ positivePrompt: '手写', promptEditedByUser: true }, '侧光')).toBeNull();
  });
});
