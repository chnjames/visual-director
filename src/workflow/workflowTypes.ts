/**
 * 阶段2「单件工作流」数据模型（docs/03 WorkflowDefinition、docs/02 状态机、docs/04 编译器/修复）。
 * 复用阶段1 的 VisualRecipe / IdentityFeature / AuditResult / UploadedImage / SafeDiagnostics。
 */
import type {
  AuditResult,
  AuditStatus,
  IdentityFeature,
  SafeDiagnostics,
  SafeError,
  UploadedImage,
  VisualRecipe,
} from '../shared/types';
import type { BatchState, WorkflowNodeId } from './workflowConstants';

/* ----------------------- 固定工作流定义 ----------------------- */

export type WorkflowNodeKind =
  | 'input'
  | 'analysis'
  | 'lock'
  | 'generation'
  | 'audit'
  | 'repair';

export type WorkflowNode = {
  id: WorkflowNodeId;
  kind: WorkflowNodeKind;
  label: string;
  /** 输入/生成/输出类节点不可删除 */
  permanent: boolean;
  /** 可跳过但界面必须提示风险 */
  skippable: boolean;
};

export type WorkflowEdge = {
  from: WorkflowNodeId;
  to: WorkflowNodeId;
  /** 仅在验收失败后启用的条件边 */
  conditional?: 'on-fail';
};

export type InputField = { key: string; label: string; required: boolean };
export type OutputField = { key: string; label: string };

export type WorkflowDefinition = {
  id: string;
  name: string;
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  recipeId: string;
  inputSchema: InputField[];
  outputSchema: OutputField[];
};

/* ----------------------- Prompt 编译器输出 ----------------------- */

export type CompiledPrompt = {
  sourceRecipeId: string;
  compiledAt: string;
  /** 最终图片模型正向提示词（身份硬约束 + 12 字段 + 必须保持项） */
  positivePrompt: string;
  /** 负向约束（禁止项 + 通用安全负向） */
  negativePrompt: string;
  identityConstraints: string[];
  requiredRules: string[];
  variableRules: string[];
  forbiddenRules: string[];
  /** 12 字段值快照，证明 Prompt 来源于结构化配方 */
  fieldValues: Record<string, string>;
};

/* ----------------------- 调用四：定向修复 ----------------------- */

export type RepairProposal = {
  /** 为什么这样改 */
  reason: string;
  /** 完整替换的正向 Prompt（基于已确认结构，不允许反向覆盖锁定项） */
  positivePromptOverride?: string;
  /** 新增负向约束 */
  addedNegative: string[];
  /** 受影响字段（RecipeFieldKey 或 identity/global） */
  affectedFields: string[];
  /** 涉及形态/Logo/材质/虚构文字等高风险，需要人工确认后才执行 */
  highRisk: boolean;
};

/* ----------------------- 单件任务与版本 ----------------------- */

export type GeneratedImage = {
  id: string;
  mediaType: string;
  /** data: URI，仅存浏览器本地（IndexedDB），不上传第三方 */
  dataUri: string;
};

export type GenerationAttemptStatus =
  | 'pending'
  | 'generating'
  | 'generated'
  | 'auditing'
  | AuditStatus
  | 'generation-failed'
  | 'audit-failed';

export type GenerationAttempt = {
  id: string;
  /** 1 = 首次生成；2 = 定向修复后重生成（最多到 2） */
  version: number;
  status: GenerationAttemptStatus;
  prompt: CompiledPrompt;
  image?: GeneratedImage;
  audit?: AuditResult;
  /** version>=2 时记录修复方案与（高风险）确认时间 */
  repair?: RepairProposal & { confirmedAt?: string; raw?: string };
  generateDiagnostics?: SafeDiagnostics;
  auditDiagnostics?: SafeDiagnostics;
  startedAt?: string;
  finishedAt?: string;
};

export type SingleItemWorkflow = {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  taskPurpose: string;
  referenceImages: UploadedImage[];
  productImages: UploadedImage[];
  /** 已确认的视觉配方（含 confirmedAt） */
  recipe?: VisualRecipe;
  recipeConfirmed: boolean;
  identityFeatures: IdentityFeature[];
  identityConfirmed: boolean;
  workflowDefinitionId?: string;
  state: BatchState;
  currentNodeId?: WorkflowNodeId;
  /** 本商品是否已用过定向修复（最多一次） */
  repairUsed: boolean;
  /** 已消耗的模型调用数（运行前预算对照） */
  callsUsed: number;
  attempts: GenerationAttempt[];
  lastError?: SafeError;
};
