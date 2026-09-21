import { describe, expect, it } from 'vitest';
import { publishVersion, PublishBlockedError } from '../../data/versionStore';
import { addNode } from './graphOps';
import { compileExecutionPlan, executionCapabilityIssues } from './executionPlan';
import { standardTemplateGraph } from './template';

describe('ExecutionPlan', () => {
  it('把标准模板编译成确定拓扑、绑定和闸门', () => {
    const graph = standardTemplateGraph();
    const plan = compileExecutionPlan(graph);

    expect(plan.steps).toHaveLength(graph.nodes.length);
    expect(plan.entryStepIds.length).toBeGreaterThan(0);
    expect(plan.sinkStepIds).toHaveLength(1);
    expect(plan.modelCallCount).toBe(2);
    expect(plan.steps.some((step) => step.kind === 'human-gate')).toBe(false);

    const compiler = plan.steps.find((step) => step.nodeType === 'promptEditor');
    expect(compiler?.bindings.map((binding) => binding.intoPort).sort()).toEqual([
      'purpose',
      'recipe',
    ]);
  });

  it('缺失适配器的节点由能力校验统一报错', () => {
    const graph = addNode(standardTemplateGraph(), 'backgroundRemove', { x: 0, y: 600 });
    expect(executionCapabilityIssues(graph)).toEqual([
      expect.objectContaining({
        code: 'E_NO_NODE_ADAPTER',
        nodeId: graph.nodes.at(-1)?.id,
      }),
    ]);
  });

  it('发布版本固化计划；不可执行图不能发布', async () => {
    const projectId = `plan-test-${Date.now()}`;
    const version = await publishVersion({
      projectId,
      name: '标准工作流',
      graph: standardTemplateGraph(),
    });
    expect(version.plan?.steps).toHaveLength(5);
    expect(version.plan?.sinkStepIds).toHaveLength(1);

    const invalid = addNode(standardTemplateGraph(), 'backgroundRemove', { x: 0, y: 600 });
    await expect(
      publishVersion({
        projectId: `${projectId}-invalid`,
        name: '不可执行工作流',
        graph: invalid,
      }),
    ).rejects.toBeInstanceOf(PublishBlockedError);
  });
});
