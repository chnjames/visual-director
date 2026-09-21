/**
 * 固定主干工作流定义（docs/01 第3节）：输入 → 分析 → 配方 → 生成 → 验收。
 * 阶段2 不允许自由增删节点/连线/循环/悬空边/自定义代码；修复节点仅在验收失败后启用。
 * 画布与批量（阶段3）必须复用同一个 WorkflowDefinition。
 */
import {
  PERMANENT_NODES,
  SKIPPABLE_NODES,
  WORKFLOW_NODE_IDS,
  WORKFLOW_NODE_LABELS,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowNodeId,
} from './workflowConstants';
import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from './workflowTypes';

let defSeq = 0;
function defId(): string {
  defSeq += 1;
  return `wf_${Date.now().toString(36)}_${defSeq}`;
}

const NODE_KIND: Record<WorkflowNodeId, WorkflowNode['kind']> = {
  referenceInput: 'input',
  productInput: 'input',
  recipeExtractor: 'analysis',
  identityLock: 'lock',
  sceneGenerator: 'generation',
  resultAuditor: 'audit',
  targetedRepair: 'repair',
};

/** 固定连线（不含循环；修复→重生成由编排层以“新版本”实现，避免图中出现环） */
const FIXED_EDGES: WorkflowEdge[] = [
  { from: 'referenceInput', to: 'recipeExtractor' },
  { from: 'productInput', to: 'identityLock' },
  { from: 'recipeExtractor', to: 'identityLock' },
  { from: 'identityLock', to: 'sceneGenerator' },
  { from: 'sceneGenerator', to: 'resultAuditor' },
  { from: 'resultAuditor', to: 'targetedRepair', conditional: 'on-fail' },
];

export function createFixedWorkflowDefinition(
  recipeId: string,
  name = '单件静物场景图工作流',
): WorkflowDefinition {
  const nodes: WorkflowNode[] = WORKFLOW_NODE_IDS.map((id) => ({
    id,
    kind: NODE_KIND[id],
    label: WORKFLOW_NODE_LABELS[id],
    permanent: PERMANENT_NODES.includes(id),
    skippable: SKIPPABLE_NODES.includes(id),
  }));
  return {
    id: defId(),
    name,
    version: WORKFLOW_SCHEMA_VERSION,
    nodes,
    edges: FIXED_EDGES.map((e) => ({ ...e })),
    recipeId,
    inputSchema: [
      { key: 'referenceImages', label: '参考图 1-5 张', required: true },
      { key: 'productImages', label: '同一商品多角度图 2-3 张', required: true },
      { key: 'taskPurpose', label: '场景图用途说明', required: false },
    ],
    outputSchema: [
      { key: 'generatedImage', label: '场景图' },
      { key: 'audit', label: '验收结果与证据' },
      { key: 'versions', label: '修复前后版本' },
    ],
  };
}

/** 校验一个定义是否仍是受允许的固定主干（防止被改成任意图） */
export function isFixedBackbone(def: WorkflowDefinition): boolean {
  const ids = def.nodes.map((n) => n.id).join('|');
  if (ids !== WORKFLOW_NODE_IDS.join('|')) return false;
  const edgeKey = (e: WorkflowEdge) => `${e.from}->${e.to}:${e.conditional ?? ''}`;
  const actualEdges = def.edges.map(edgeKey).sort();
  const expectedEdges = FIXED_EDGES.map(edgeKey).sort();
  return actualEdges.join('||') === expectedEdges.join('||');
}
