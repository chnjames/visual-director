import { describe, expect, it } from 'vitest';
import {
  assembleRepairProposal,
  isHighRiskAudit,
  parsePersistedWorkflow,
} from './workflowSchema';

describe('repairProposal schema', () => {
  it('装配合法修复提案，highRisk 由代码传入', () => {
    const p = assembleRepairProposal(
      {
        reason: '背景过亮，压暗并补充负向',
        positivePromptOverride: '新的正向',
        addedNegative: ['不要过曝'],
        affectedFields: ['lightQuality', 'backgroundType'],
      },
      true,
    );
    expect(p.reason).toBe('背景过亮，压暗并补充负向');
    expect(p.highRisk).toBe(true);
    expect(p.addedNegative).toEqual(['不要过曝']);
  });

  it('缺省数组字段补空，reason 必填', () => {
    const p = assembleRepairProposal({ reason: '仅调整' }, false);
    expect(p.addedNegative).toEqual([]);
    expect(p.affectedFields).toEqual([]);
    expect(p.highRisk).toBe(false);
    expect(() => assembleRepairProposal({}, false)).toThrow();
  });

  it('模型自报 highRisk 字段被忽略（不进入结果）', () => {
    const p = assembleRepairProposal({ reason: 'x', highRisk: true } as any, false);
    expect(p.highRisk).toBe(false);
  });
});

describe('isHighRiskAudit', () => {
  it('身份维度 critical 判高风险', () => {
    expect(isHighRiskAudit([{ dimension: 'identity', severity: 'critical', statement: 'Logo 错误' }])).toBe(true);
  });
  it('技术维度 minor 不判高风险', () => {
    expect(isHighRiskAudit([{ dimension: 'technical', severity: 'minor', statement: '轻微噪点' }])).toBe(false);
  });
  it('非身份维度但描述涉及材质/变形 critical 判高风险', () => {
    expect(isHighRiskAudit([{ dimension: 'recipe', severity: 'critical', statement: '材质表现错误' }])).toBe(true);
  });
});

describe('persisted workflow shape', () => {
  it('形状不合法拒绝加载', () => {
    expect(() => parsePersistedWorkflow({ id: 'x' })).toThrow();
  });
  it('合法最小形状通过', () => {
    const wf = {
      schemaVersion: 1,
      id: 'wf_1',
      name: 'n',
      createdAt: 't',
      updatedAt: 't',
      taskPurpose: '',
      recipeConfirmed: false,
      identityConfirmed: false,
      state: 'draft',
      repairUsed: false,
      callsUsed: 0,
      attempts: [],
      referenceImages: [],
      productImages: [],
      identityFeatures: [],
    };
    expect(parsePersistedWorkflow(wf).state).toBe('draft');
  });
});
