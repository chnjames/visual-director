/**
 * 单件商品任务状态机（docs/02）。纯函数、确定性，便于单测。
 *
 * draft → analyzing → draft(人工闸门) → generating → auditing → passed|warning|failed|needs-review
 * 可选：failed → repairing → generating（每件最多一次）；warning → passed 仅人工确认；
 * 进行中刷新 → interrupted，由用户恢复，绝不伪装仍在运行。
 */
import { IN_FLIGHT_STATES, type BatchState } from './workflowConstants';

export type WorkflowEvent =
  | 'START_ANALYSIS'
  | 'ANALYSIS_FINISHED'
  | 'START_GENERATION'
  | 'GENERATION_SUCCEEDED'
  | 'GENERATION_FAILED'
  | 'START_REPAIR'
  | 'REPAIR_PROPOSED'
  | 'APPLY_REPAIR'
  | 'AUDIT_FINISHED'
  | 'CONFIRM_WARNING'
  | 'FAIL'
  | 'MARK_INTERRUPTED'
  | 'RESUME';

export type TransitionContext = {
  /** 本商品是否已用过定向修复（决定能否 START_REPAIR） */
  repairUsed?: boolean;
  /** AUDIT_FINISHED 时的验收结论 */
  auditStatus?: 'passed' | 'warning' | 'failed' | 'needs-review';
};

const ALLOWED: Record<WorkflowEvent, BatchState[]> = {
  START_ANALYSIS: ['draft', 'queued', 'interrupted'],
  ANALYSIS_FINISHED: ['analyzing'],
  START_GENERATION: ['draft', 'queued'],
  GENERATION_SUCCEEDED: ['generating'],
  GENERATION_FAILED: ['generating'],
  START_REPAIR: ['failed'],
  REPAIR_PROPOSED: ['repairing'],
  APPLY_REPAIR: ['paused'],
  AUDIT_FINISHED: ['auditing'],
  CONFIRM_WARNING: ['warning', 'needs-review'],
  FAIL: ['analyzing', 'generating', 'auditing', 'repairing', 'queued'],
  MARK_INTERRUPTED: [...IN_FLIGHT_STATES],
  RESUME: ['interrupted'],
};

function nextStateFor(event: WorkflowEvent, ctx: TransitionContext): BatchState {
  switch (event) {
    case 'START_ANALYSIS':
      return 'analyzing';
    case 'ANALYSIS_FINISHED':
      return 'draft'; // 回到人工确认闸门
    case 'START_GENERATION':
      return 'generating';
    case 'GENERATION_SUCCEEDED':
      return 'auditing';
    case 'GENERATION_FAILED':
      return 'failed';
    case 'START_REPAIR':
      return 'repairing';
    case 'REPAIR_PROPOSED':
      return 'paused';
    case 'APPLY_REPAIR':
      return 'generating';
    case 'AUDIT_FINISHED':
      return ctx.auditStatus ?? 'needs-review';
    case 'CONFIRM_WARNING':
      return 'passed';
    case 'FAIL':
      return 'failed';
    case 'MARK_INTERRUPTED':
      return 'interrupted';
    case 'RESUME':
      return 'draft';
  }
}

/**
 * 计算合法转移；非法转移抛错（状态机不允许被 UI/模型输出绕过）。
 */
export function transition(
  current: BatchState,
  event: WorkflowEvent,
  ctx: TransitionContext = {},
): BatchState {
  if (event === 'START_REPAIR' && ctx.repairUsed === true) {
    throw new Error('每件商品最多定向修复一次，不能再次修复');
  }
  if (event === 'AUDIT_FINISHED' && !ctx.auditStatus) {
    throw new Error('AUDIT_FINISHED 必须携带验收状态');
  }
  const allowed = ALLOWED[event];
  if (!allowed.includes(current)) {
    throw new Error(`非法状态转移：${current} --${event}--> ?`);
  }
  return nextStateFor(event, ctx);
}

/** 刷新/重载时，把进行中的状态判为 interrupted（docs/02：不能伪装仍在运行） */
export function interruptIfInFlight(state: BatchState): BatchState {
  return IN_FLIGHT_STATES.includes(state) ? 'interrupted' : state;
}
