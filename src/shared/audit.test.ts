import { describe, it, expect } from 'vitest';
import { computeAuditStatus, assembleAuditResult } from '../shared/schema';

function scores(over: Record<string, number | boolean> = {}) {
  return {
    identityScore: 90,
    recipeScore: 90,
    taskScore: 90,
    technicalScore: 90,
    criticalViolation: false,
    insufficientEvidence: false,
    ...over,
  };
}

describe('C. 验收状态确定性计算', () => {
  it('无严重错误且综合分≥80 → passed', () => {
    const r = computeAuditStatus(scores());
    expect(r.status).toBe('passed');
    expect(r.compositeScore).toBe(90);
  });

  it('综合分 60-79 → warning', () => {
    const r = computeAuditStatus(scores({ identityScore: 70, recipeScore: 70, taskScore: 70, technicalScore: 70 }));
    expect(r.status).toBe('warning');
    expect(r.compositeScore).toBe(70);
  });

  it('综合分 <60 → failed', () => {
    const r = computeAuditStatus(scores({ identityScore: 50, recipeScore: 50, taskScore: 50, technicalScore: 50 }));
    expect(r.status).toBe('failed');
  });

  it('严重错误一票否决：即使全部 95 分也必须 failed', () => {
    const r = computeAuditStatus(scores({ criticalViolation: true }));
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('critical-veto');
  });

  it('证据不足：高分也必须 needs-review，不强行判断', () => {
    const r = computeAuditStatus(scores({ insufficientEvidence: true }));
    expect(r.status).toBe('needs-review');
    expect(r.reason).toBe('insufficient-evidence');
  });

  it('权重 40/30/20/10：仅身份满分综合分为 40 → failed', () => {
    const r = computeAuditStatus(
      scores({ identityScore: 100, recipeScore: 0, taskScore: 0, technicalScore: 0 }),
    );
    expect(r.compositeScore).toBeCloseTo(40, 5);
    expect(r.status).toBe('failed');
  });

  it('边界：综合分恰好 80 → passed；恰好 60 → warning', () => {
    expect(computeAuditStatus(scores({ identityScore: 80, recipeScore: 80, taskScore: 80, technicalScore: 80 })).status).toBe('passed');
    expect(computeAuditStatus(scores({ identityScore: 60, recipeScore: 60, taskScore: 60, technicalScore: 60 })).status).toBe('warning');
  });

  it('assembleAuditResult 把模型分数装配为带状态的 AuditResult', () => {
    const result = assembleAuditResult('product-7', {
      identityScore: 95,
      recipeScore: 92,
      taskScore: 88,
      technicalScore: 90,
      criticalViolation: false,
      insufficientEvidence: false,
      modelConfidence: 0.86,
      issues: [
        {
          dimension: 'technical',
          severity: 'minor',
          statement: '右下角轻微噪点',
          evidence: [
            { sourceId: 'cand1', sourceType: 'product-image', confidence: 0.6 },
          ],
          confidence: 0.6,
        },
      ],
    });
    expect(result.productId).toBe('product-7');
    expect(result.status).toBe('passed');
    expect(result.issues).toHaveLength(1);
    expect(result.compositeScore).toBeGreaterThan(90);
  });
});
