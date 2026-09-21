/**
 * 阶段3「画布与批量」固定规则（docs/01 第3/4节、docs/02 错误隔离、docs/09 预算/停止线、docs/10 阶段3）。
 * 这些是确定性产品规则，UI 与模型输出都不得改变。
 */

/** 一批最多 5 件商品（docs/01 第4节） */
export const BATCH_MAX_ITEMS = 5;

/** 每件商品 2-3 张多角度图（与阶段1/2 身份探针边界一致） */
export const BATCH_ITEM_IMAGES_MIN = 2;
export const BATCH_ITEM_IMAGES_MAX = 3;

/** 并发：同时分析 2 件、同时生成 1 件（docs/01 第4节） */
export const CONCURRENCY_ANALYZE = 2;
export const CONCURRENCY_GENERATE = 1;

/** 每件自动修复最多 1 次（沿用阶段2，docs/09） */
export const BATCH_MAX_REPAIRS_PER_ITEM = 1;

/**
 * 连续网络失败达到该阈值视为系统级故障，暂停整批（docs/02：连续网络失败→系统级）。
 * 单次网络错误仍按商品级隔离，只有“连续”发生才升级。
 */
export const CONSECUTIVE_NETWORK_FAILURE_LIMIT = 3;

/** 批量持久化 schema 版本（导出 JSON 也带该字段，docs/03） */
export const BATCH_SCHEMA_VERSION = 1;

/** IndexedDB 当前批次存储键 */
export const BATCH_STORE_KEY = 'current-batch';

/**
 * 错误分级（docs/02 错误隔离）：
 * - 系统级：Key 无效、额度不足、Endpoint 不存在、服务端配置错误 → 暂停整批；
 * - 商品级：超时、单次网络、请求/输出问题 → 只影响当前商品。
 */
export const SYSTEM_ERROR_CLASSES = [
  'invalid-key',
  'quota',
  'endpoint-not-found',
  'server',
  'not-configured',
] as const;

export type BatchQueueStatus =
  | 'setup' // 尚未确认配方/分组/预算
  | 'ready' // 已确认成本，待开始
  | 'running'
  | 'paused' // 用户主动暂停整批
  | 'system-paused' // 系统级错误，等待处置
  | 'completed';

export const BATCH_QUEUE_STATUS_LABELS: Record<BatchQueueStatus, string> = {
  setup: '准备中',
  ready: '待运行',
  running: '运行中',
  paused: '已暂停整批',
  'system-paused': '系统错误·整批暂停',
  completed: '本批结束',
};

/** 单件商品在批量中的身份锁定策略（IdentityLock 可跳过但必须提示风险，docs/01） */
export type IdentityMode = 'lock' | 'skip';

/** 商品在人工闸门处的等待原因（瞬时态，不持久化，加载时重算） */
export type ItemAwaiting = 'identity' | 'repair' | 'accept' | null;
