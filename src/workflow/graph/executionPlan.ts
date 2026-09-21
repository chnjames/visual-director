/**
 * WorkflowGraph → ExecutionPlan 编译器。
 *
 * 发布与运行共同依赖该模块。计划是不可变版本的一部分，包含确定拓扑顺序、
 * 端口绑定、适配器和人工闸门；它不执行模型调用。
 */
import { getNodeAdapterSpec, type GateKind, type PlanStepKind } from './adapters';
import { getNodeDefinition } from './registry';
import { validateGraph } from './validate';
import type { GraphIssue, WorkflowGraph } from './types';

export type DataBinding = {
  intoPort: string;
  fromNode: string;
  fromPort: string;
};

export type ExecutionPlanStep = {
  stepId: string;
  nodeInstanceId: string;
  nodeType: string;
  title: string;
  kind: PlanStepKind;
  adapterId: string;
  bindings: DataBinding[];
  gate?: { kind: GateKind };
};

export type ExecutionPlan = {
  schemaVersion: 1;
  steps: ExecutionPlanStep[];
  entryStepIds: string[];
  sinkStepIds: string[];
  modelCallCount: number;
};

export class PlanCompileError extends Error {
  constructor(public readonly issues: GraphIssue[]) {
    super(issues.map((issue) => issue.message).join('；') || '工作流无法编译为执行计划');
    this.name = 'PlanCompileError';
  }
}

export function executionCapabilityIssues(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  for (const node of graph.nodes) {
    const definition = getNodeDefinition(node.type);
    if (!definition) continue;
    if (!getNodeAdapterSpec(node.type)) {
      issues.push({
        level: 'error',
        code: 'E_NO_NODE_ADAPTER',
        nodeId: node.id,
        message: `“${definition.title}”尚无执行适配器，不能发布为可运行版本`,
      });
    }
  }
  return issues;
}

export function compileExecutionPlan(graph: WorkflowGraph): ExecutionPlan {
  const validation = validateGraph(graph);
  const issues = [...validation.errors, ...executionCapabilityIssues(graph)];
  if (issues.length) throw new PlanCompileError(issues);

  const order = topologicalOrder(graph);
  if (!order) {
    throw new PlanCompileError([
      {
        level: 'error',
        code: 'E_CYCLE_DETECTED',
        message: '工作流包含循环，不能生成执行计划',
      },
    ]);
  }

  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const steps: ExecutionPlanStep[] = order.map((nodeId) => {
    const node = nodeMap.get(nodeId)!;
    const definition = getNodeDefinition(node.type)!;
    const adapter = getNodeAdapterSpec(node.type)!;
    const bindings = graph.edges
      .filter((edge) => edge.to.node === node.id)
      .map((edge) => ({
        intoPort: edge.to.port,
        fromNode: edge.from.node,
        fromPort: edge.from.port,
      }))
      .sort((a, b) => a.intoPort.localeCompare(b.intoPort));
    return {
      stepId: `step:${node.id}`,
      nodeInstanceId: node.id,
      nodeType: node.type,
      title: definition.title,
      kind: adapter.stepKind,
      adapterId: adapter.adapterId,
      bindings,
      gate: adapter.gate ? { kind: adapter.gate } : undefined,
    };
  });

  return {
    schemaVersion: 1,
    steps,
    entryStepIds: steps
      .filter((step) => !graph.edges.some((edge) => edge.to.node === step.nodeInstanceId))
      .map((step) => step.stepId),
    sinkStepIds: steps
      .filter((step) => step.kind === 'sink')
      .map((step) => step.stepId),
    modelCallCount: steps.filter(
      (step) => step.kind === 'model-call' || step.adapterId === 'model.repair',
    ).length,
  };
}

function topologicalOrder(graph: WorkflowGraph): string[] | null {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!indegree.has(edge.from.node) || !indegree.has(edge.to.node)) continue;
    indegree.set(edge.to.node, (indegree.get(edge.to.node) ?? 0) + 1);
    const next = outgoing.get(edge.from.node) ?? [];
    next.push(edge.to.node);
    outgoing.set(edge.from.node, next);
  }

  const queue = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([nodeId]) => nodeId);
  const result: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    result.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const count = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, count);
      if (count === 0) queue.push(next);
    }
  }
  return result.length === graph.nodes.length ? result : null;
}
