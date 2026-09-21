/**
 * 阶段2「单件工作流」固定主干常量（docs/01 第3节、docs/02 状态机、docs/03 数据模型）。
 * 阶段2 只做固定线性流程可视化，不做可拖拽自由画布（那是阶段3）。
 */

/** 固定 7 节点（顺序即主干，不可删除输入/生成/输出） */
export const WORKFLOW_NODE_IDS = [
  'referenceInput',
  'productInput',
  'recipeExtractor',
  'identityLock',
  'sceneGenerator',
  'resultAuditor',
  'targetedRepair',
] as const;

export type WorkflowNodeId = (typeof WORKFLOW_NODE_IDS)[number];

export const WORKFLOW_NODE_LABELS: Record<WorkflowNodeId, string> = {
  referenceInput: '参考图输入',
  productInput: '商品输入',
  recipeExtractor: '配方提取',
  identityLock: '身份锁定',
  sceneGenerator: '场景生成',
  resultAuditor: '结果验收',
  targetedRepair: '定向修复',
};

/** 不可删除的节点（输入/生成/输出类） */
export const PERMANENT_NODES: WorkflowNodeId[] = [
  'referenceInput',
  'productInput',
  'sceneGenerator',
];

/** 可跳过但必须提示风险的节点 */
export const SKIPPABLE_NODES: WorkflowNodeId[] = ['identityLock', 'resultAuditor'];

/** docs/02 商品任务状态机 */
export const BATCH_STATES = [
  'draft',
  'queued',
  'analyzing',
  'generating',
  'auditing',
  'passed',
  'warning',
  'failed',
  'needs-review',
  'repairing',
  'paused',
  'interrupted',
] as const;

export type BatchState = (typeof BATCH_STATES)[number];

export const BATCH_STATE_LABELS: Record<BatchState, string> = {
  draft: '草稿',
  queued: '排队中',
  analyzing: '分析中',
  generating: '生成中',
  auditing: '验收中',
  passed: '通过',
  warning: '警告',
  failed: '失败',
  'needs-review': '需人工确认',
  repairing: '修复中',
  paused: '已暂停',
  interrupted: '已中断',
};

/** 进行中状态：刷新后必须转为 interrupted，不能伪装仍在运行 */
export const IN_FLIGHT_STATES: BatchState[] = [
  'analyzing',
  'generating',
  'auditing',
  'repairing',
  'queued',
];

/** 单件商品最多自动修复一次（docs/04 调用四、docs/09） */
export const MAX_REPAIRS_PER_ITEM = 1;

/** 本地持久化 schema 版本（导出 JSON 也带该字段） */
export const WORKFLOW_SCHEMA_VERSION = 1;

/**
 * 单件工作流的调用预算（运行前展示，docs/09 运行前预算）。
 * 必选：配方1 + 身份1 + 生成1 + 验收1 = 4；
 * 最坏：再叠加 修复1 + 重新生成1 + 重新验收1 = 7。
 */
export function estimateCallBudget(): { expected: number; worst: number; detail: string[] } {
  return {
    expected: 4,
    worst: 4 + 3,
    detail: [
      '视觉配方提取 ×1',
      '商品身份提取 ×1',
      '场景图生成 ×1',
      '结果验收 ×1',
      '最坏情况追加：定向修复 ×1 + 重新生成 ×1 + 重新验收 ×1（仅失败且修复一次）',
    ],
  };
}
