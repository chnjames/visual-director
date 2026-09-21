import { describe, expect, it } from 'vitest';
import { compileExecutionPlan } from '../workflow/graph/executionPlan';
import { getTemplate } from '../workflow/graph/templates';
import { deriveBatchInputContract } from './batchInputContract';

describe('deriveBatchInputContract', () => {
  it('参考图辅助：共享参考图与提示词，按行商品图', () => {
    const graph = getTemplate('standard-still-life').buildGraph();
    const plan = compileExecutionPlan(graph);
    const contract = deriveBatchInputContract(graph, plan);
    expect(contract.runnable).toBe(true);
    expect(contract.shared.referenceImages).toBe(true);
    expect(contract.shared.purpose).toBe(true);
    expect(contract.shared.positivePrompt).toBe(true);
    expect(contract.perRow.productImages).toBe(true);
    expect(contract.perRow.promptOverride).toBe(false);
    expect(contract.estimatedModelCallsPerRow).toBe(2);
    expect(contract.summary).toContain('共享参考图');
    expect(contract.summary).toContain('每行商品图');
  });

  it('直接生成：按行商品图；版本无提示词时要共享提示词', () => {
    const graph = getTemplate('blank').buildGraph();
    const plan = compileExecutionPlan(graph);
    const contract = deriveBatchInputContract(graph, plan);
    expect(contract.runnable).toBe(true);
    expect(contract.shared.referenceImages).toBe(false);
    expect(contract.shared.positivePrompt).toBe(true);
    expect(contract.perRow.productImages).toBe(true);
    expect(contract.perRow.promptOverride).toBe(true);
    expect(contract.perRow.generationOverrides).toBe(true);
    expect(contract.estimatedModelCallsPerRow).toBe(1);
  });

  it('直接生成且版本已有提示词时，共享提示词可不填，仍允许行级覆盖', () => {
    const graph = getTemplate('blank').buildGraph();
    const generate = graph.nodes.find((node) => node.type === 'sceneGenerate')!;
    generate.config.positivePrompt = '浅色石材台面护肤品';
    const contract = deriveBatchInputContract(graph, compileExecutionPlan(graph));
    expect(contract.shared.positivePrompt).toBe(false);
    expect(contract.perRow.promptOverride).toBe(true);
    expect(contract.defaultPositivePrompt).toBe('浅色石材台面护肤品');
  });
});
