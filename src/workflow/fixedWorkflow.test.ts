import { describe, expect, it } from 'vitest';
import { createFixedWorkflowDefinition, isFixedBackbone } from './fixedWorkflow';
import { WORKFLOW_NODE_IDS } from './workflowConstants';

describe('fixed workflow backbone', () => {
  it('包含固定 7 节点，输入/生成节点永久，身份/验收可跳过', () => {
    const def = createFixedWorkflowDefinition('recipe-1');
    expect(def.nodes.map((n) => n.id)).toEqual([...WORKFLOW_NODE_IDS]);
    const byId = Object.fromEntries(def.nodes.map((n) => [n.id, n]));
    expect(byId.referenceInput.permanent).toBe(true);
    expect(byId.productInput.permanent).toBe(true);
    expect(byId.sceneGenerator.permanent).toBe(true);
    expect(byId.identityLock.skippable).toBe(true);
    expect(byId.resultAuditor.skippable).toBe(true);
    expect(def.recipeId).toBe('recipe-1');
  });

  it('修复边是 on-fail 条件边', () => {
    const def = createFixedWorkflowDefinition('recipe-1');
    const repairEdge = def.edges.find((e) => e.to === 'targetedRepair');
    expect(repairEdge?.conditional).toBe('on-fail');
  });

  it('主干不含循环', () => {
    const def = createFixedWorkflowDefinition('recipe-1');
    const targets = new Set(def.edges.map((e) => e.to));
    const backToEarlier = def.edges.some((e) => {
      const fi = WORKFLOW_NODE_IDS.indexOf(e.from);
      const ti = WORKFLOW_NODE_IDS.indexOf(e.to);
      return ti < fi;
    });
    // 唯一“回退”是条件修复边，且不形成环（无 targetedRepair 出边）
    expect(backToEarlier).toBe(false);
    expect(targets.has('targetedRepair')).toBe(true);
    expect(def.edges.some((e) => e.from === 'targetedRepair')).toBe(false);
  });

  it('被篡改的定义不能通过主干校验', () => {
    const def = createFixedWorkflowDefinition('r');
    expect(isFixedBackbone(def)).toBe(true);
    const tampered = { ...def, nodes: def.nodes.slice(0, 6) };
    expect(isFixedBackbone(tampered)).toBe(false);
  });
});
