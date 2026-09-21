/**
 * 自定义工作流图模型（docs/15 §3）。
 * 纯类型与工厂，不依赖 React / DOM / 网络。
 */

/** 有类型端口携带的逻辑数据类型（封闭集合） */
export type PortDataType =
  | 'ReferenceImages'
  | 'ProductImages'
  | 'UnconfirmedRecipe' // 模型提取、未经人工确认的配方
  | 'VisualRecipe' // 已确认配方（仅 recipeConfirmGate 输出）
  | 'IdentityCandidates' // 模型提取的候选特征（pending）
  | 'IdentityFeatureSet' // 已确认身份硬约束集合
  | 'TaskPurpose'
  | 'CompiledPrompt'
  | 'GeneratedImage'
  | 'AuditResult'
  | 'RepairPatch'
  | 'FinalImage';

export type NodeKind =
  | 'source'
  | 'analysis'
  | 'gate'
  | 'transform'
  | 'generation'
  | 'audit'
  | 'repair'
  | 'sink';

export type NodeCategory =
  | '输入'
  | '理解'
  | '提示词'
  | '生成'
  | '图像处理'
  | '验收'
  | '人工确认'
  | '输出';

export type NodePortDefinition = {
  portId: string;
  label: string;
  direction: 'in' | 'out';
  dataType: PortDataType;
  required?: boolean;
  /** 入端口是否允许多来源（仅图片集合首版允许） */
  multi?: boolean;
};

export type NodeConfigFieldType =
  | 'text'
  | 'textarea'
  | 'prompt-editor'
  | 'number'
  | 'slider'
  | 'select'
  | 'switch'
  | 'image-upload'
  | 'image-list'
  | 'model-selector'
  | 'aspect-ratio'
  | 'resolution'
  | 'variable-reference'
  | 'readonly-output';

export type NodeConfigField = {
  key: string;
  label: string;
  dataType: NodeConfigFieldType;
  enumValues?: string[];
  defaultValue: unknown;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  help?: string;
  /** 该字段是否引用上游变量（prompt 节点用） */
  variables?: string[];
  /** true=高频控件，直接内嵌在节点卡片；false=只在右侧高级面板 */
  inline?: boolean;
  /** 高级面板内分组 */
  group?: string;
};

/** 节点定义（内置、封闭，用户不能新增类型） */
export type NodeDefinition = {
  type: string;
  kind: NodeKind;
  category: NodeCategory;
  title: string;
  summary: string;
  inputs: NodePortDefinition[];
  outputs: NodePortDefinition[];
  configFields: NodeConfigField[];
  isHumanGate?: boolean;
  /** 本流程最多实例数；缺省不限 */
  maxInstances?: number;
  removable: boolean;
  /** 执行接入状态：executable=已有适配器可运行；planned=可编排但暂不可执行 */
  execution: 'executable' | 'planned';
};

export type NodeInstance = {
  id: string;
  type: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
};

export type Edge = {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
};

export type WorkflowGraph = {
  nodes: NodeInstance[];
  edges: Edge[];
};

export type GraphIssueLevel = 'error' | 'warning' | 'hint';

export type GraphIssue = {
  level: GraphIssueLevel;
  code: string;
  nodeId?: string;
  edgeId?: string;
  message: string;
};

export type GraphValidationResult = {
  errors: GraphIssue[];
  warnings: GraphIssue[];
  hints: GraphIssue[];
  isAcyclic: boolean;
  canPublish: boolean;
};

/** 草稿（可带错保存） */
export type WorkflowDraft = {
  id: string;
  projectId: string;
  name: string;
  basedOnTemplateId: string | null;
  graph: WorkflowGraph;
  publishedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export const PORT_TYPE_LABELS: Record<PortDataType, string> = {
  ReferenceImages: '参考图',
  ProductImages: '商品图',
  UnconfirmedRecipe: '待确认配方',
  VisualRecipe: '已确认配方',
  IdentityCandidates: '候选身份特征',
  IdentityFeatureSet: '身份硬约束',
  TaskPurpose: '场景用途',
  CompiledPrompt: '编译后 Prompt',
  GeneratedImage: '生成图',
  AuditResult: '验收结论',
  RepairPatch: '修复补丁',
  FinalImage: '终稿',
};
