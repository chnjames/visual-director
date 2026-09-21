/**
 * 节点执行能力目录。
 *
 * 这是“节点是否可执行、如何进入执行计划”的唯一事实源。UI 注册表只描述
 * 端口与配置；发布器和执行器都必须从这里解析能力，禁止各自维护类型集合。
 */
export type NodeAction =
  | 'source'
  | 'extract-recipe'
  | 'confirm-recipe'
  | 'extract-identity'
  | 'confirm-identity'
  | 'compile-prompt'
  | 'generate'
  | 'audit'
  | 'repair'
  | 'sink';

export type PlanStepKind =
  | 'local-input'
  | 'model-call'
  | 'local-transform'
  | 'human-gate'
  | 'conditional'
  | 'sink';

export type GateKind = 'recipe' | 'identity' | 'repair-risk';

export type NodeAdapterSpec = {
  nodeType: string;
  adapterId: string;
  action: NodeAction;
  stepKind: PlanStepKind;
  gate?: GateKind;
  /** 旧项目只读/兼容运行，不允许出现在新模板。 */
  legacy?: boolean;
};

const specs: NodeAdapterSpec[] = [
  {
    nodeType: 'referenceInput',
    adapterId: 'input.reference',
    action: 'source',
    stepKind: 'local-input',
    legacy: true,
  },
  {
    nodeType: 'productInput',
    adapterId: 'input.product',
    action: 'source',
    stepKind: 'local-input',
    legacy: true,
  },
  { nodeType: 'recipeExtractor', adapterId: 'model.recipe', action: 'extract-recipe', stepKind: 'model-call', legacy: true },
  {
    nodeType: 'recipeConfirmGate',
    adapterId: 'gate.recipe',
    action: 'confirm-recipe',
    stepKind: 'human-gate',
    gate: 'recipe',
    legacy: true,
  },
  { nodeType: 'identityExtractor', adapterId: 'model.identity', action: 'extract-identity', stepKind: 'model-call', legacy: true },
  {
    nodeType: 'identityConfirmGate',
    adapterId: 'gate.identity',
    action: 'confirm-identity',
    stepKind: 'human-gate',
    gate: 'identity',
    legacy: true,
  },
  {
    nodeType: 'promptCompiler',
    adapterId: 'local.prompt-compiler',
    action: 'compile-prompt',
    stepKind: 'local-transform',
    legacy: true,
  },
  { nodeType: 'sceneGenerator', adapterId: 'model.image', action: 'generate', stepKind: 'model-call', legacy: true },
  { nodeType: 'resultAuditor', adapterId: 'model.audit', action: 'audit', stepKind: 'model-call', legacy: true },
  {
    nodeType: 'targetedRepair',
    adapterId: 'model.repair',
    action: 'repair',
    stepKind: 'conditional',
    gate: 'repair-risk',
    legacy: true,
  },
  { nodeType: 'finalSink', adapterId: 'sink.final', action: 'sink', stepKind: 'sink', legacy: true },

  // 精简核心主线：分析 → 提示词 → 商品图生成 → 结果展示。
  {
    nodeType: 'referenceAnalyze',
    adapterId: 'model.reference-analysis',
    action: 'extract-recipe',
    stepKind: 'model-call',
  },
  {
    nodeType: 'productImages',
    adapterId: 'input.product-images',
    action: 'source',
    stepKind: 'local-input',
  },
  {
    nodeType: 'promptEditor',
    adapterId: 'local.prompt-editor',
    action: 'compile-prompt',
    stepKind: 'local-transform',
  },
  {
    nodeType: 'sceneGenerate',
    adapterId: 'model.product-image',
    action: 'generate',
    stepKind: 'model-call',
  },
  { nodeType: 'resultGallery', adapterId: 'sink.gallery', action: 'sink', stepKind: 'sink' },
  // 旧四节点出口仅兼容历史草稿。
  {
    nodeType: 'auditExport',
    adapterId: 'legacy.audit-export',
    action: 'audit',
    stepKind: 'model-call',
    legacy: true,
  },
];

const byType = new Map(specs.map((spec) => [spec.nodeType, spec]));

export const NODE_ADAPTER_SPECS: readonly NodeAdapterSpec[] = specs;

export function getNodeAdapterSpec(nodeType: string): NodeAdapterSpec | undefined {
  return byType.get(nodeType);
}

export function hasNodeAdapter(nodeType: string): boolean {
  return byType.has(nodeType);
}

/** 可在检查器里单独试运行：分析、提示词预览、出图。 */
export function isSoloRunnableNode(nodeType: string): boolean {
  const action = byType.get(nodeType)?.action;
  return action === 'generate' || action === 'extract-recipe' || action === 'compile-prompt';
}

export const EXECUTABLE_NODE_TYPES = new Set(specs.map((spec) => spec.nodeType));

export const MAINLINE_NODE_TYPES = new Set(
  specs.filter((spec) => !spec.legacy).map((spec) => spec.nodeType),
);

export const COMPAT_NODE_TYPES = new Set(
  specs.filter((spec) => spec.legacy).map((spec) => spec.nodeType),
);
