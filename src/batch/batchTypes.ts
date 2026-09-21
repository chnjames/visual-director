/**
 * 阶段3 批量域数据模型（docs/03 ProductBatchItem / WorkflowDefinition，docs/01 第4节）。
 * 每件商品的执行体复用阶段2 的 SingleItemWorkflow；画布与批量共享同一个 WorkflowDefinition。
 */
import type { SafeError, UploadedImage, VisualRecipe } from '../shared/types';
import type {
  SingleItemWorkflow,
  WorkflowDefinition,
} from '../workflow/workflowTypes';
import type { WorkflowNodeId } from '../workflow/workflowConstants';
import type { ExecutionPlan } from '../workflow/graph/executionPlan';
import type {
  BatchQueueStatus,
  IdentityMode,
  ItemAwaiting,
} from './batchConstants';

/** 批量中一件商品（分组由用户显式建立并确认，系统不自行永久决定归属，docs/01） */
export type BatchItem = {
  id: string;
  name: string;
  /** 该商品 2-3 张多角度图（分组阶段即持有，开跑时注入执行体） */
  images: UploadedImage[];
  identityMode: IdentityMode;
  /** 用户是否已确认该分组（图片归属） */
  groupingConfirmed: boolean;
  /** 用户对单件主动暂停（操作：暂停） */
  userPaused: boolean;
  /** 用户跳过该件（操作：跳过） */
  skipped: boolean;
  /** 用户手动重试次数（区别于自动修复预算） */
  retryCount: number;
  startedAt?: string;
  finishedAt?: string;
  /** 人工闸门等待原因（瞬时，加载时重算） */
  awaiting: ItemAwaiting;
  /** 该件执行体（配方为全批共享引用，在开跑时注入） */
  wf?: SingleItemWorkflow;
};

export type Batch = {
  schemaVersion: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  taskPurpose: string;
  referenceImages: UploadedImage[];
  /** 新批次必须绑定不可变发布版本；旧批次缺省时仅用于兼容读取。 */
  workflowVersionId?: string;
  workflowVersionNo?: number;
  workflowVersionChecksum?: string;
  /** 版本发布时固化的计划快照，批量执行不读取可变草稿。 */
  workflowPlan?: ExecutionPlan;
  /** 第一道闸门：已确认的视觉配方（全批共享，提取发生在批量开始前） */
  recipe?: VisualRecipe;
  recipeConfirmed: boolean;
  /** 画布与批量共同消费的唯一工作流定义 */
  definition?: WorkflowDefinition;
  items: BatchItem[];
  /** 用户必须显式确认图片分组 */
  groupingConfirmed: boolean;
  /** 用户必须显式确认调用成本 */
  budgetConfirmed: boolean;
  status: BatchQueueStatus;
  /** 画布上被跳过的节点（只允许 skippable 节点：identityLock / resultAuditor） */
  skippedNodeIds: WorkflowNodeId[];
  /** 全批已消耗模型调用数（运行前预算对照，docs/09） */
  callsUsed: number;
  /** 准备阶段（配方提取）已消耗调用数，单独列示 */
  prepCallsUsed: number;
  systemError?: SafeError;
  /** 连续网络失败计数（达到阈值升级为系统级暂停） */
  consecutiveNetworkFailures: number;
};

export type PublishedWorkflowBinding = {
  id: string;
  versionNo: number;
  checksum: string;
  plan: ExecutionPlan;
};

/** 运行前预算估算（docs/01：展示预计和最坏调用次数） */
export type BatchBudget = {
  prepCalls: number;
  expected: number;
  worst: number;
  perItem: Array<{ itemId: string; expected: number; worst: number }>;
  detail: string[];
};

/** 批量表格派生的单行统计（docs/01 展示字段） */
export type ItemRowStats = {
  itemId: string;
  stateLabel: string;
  currentStep?: string;
  issueCount: number;
  auditStatus?: string;
  compositeScore?: number;
  elapsedMs?: number;
};
