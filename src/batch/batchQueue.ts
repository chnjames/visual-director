/**
 * 阶段3 队列派生与刷新恢复（纯函数）。
 * 关键安全约束：刷新后进行中的任务一律判为 interrupted，绝不伪装仍在运行（docs/02、docs/10）。
 */
import { BATCH_QUEUE_STATUS_LABELS } from './batchConstants';
import { isTerminalState, nodeForState, nodeLabel } from './batchBudget';
import type { Batch, BatchItem, ItemRowStats } from './batchTypes';
import { resumeWorkflow } from '../workflow/orchestrator';
import type { GenerationAttempt } from '../workflow/workflowTypes';
import { BATCH_STATE_LABELS, type BatchState } from '../workflow/workflowConstants';

export function latestAttempt(item: BatchItem): GenerationAttempt | undefined {
  const attempts = item.wf?.attempts ?? [];
  return attempts[attempts.length - 1];
}

export function latestAudit(item: BatchItem) {
  for (let i = (item.wf?.attempts.length ?? 0) - 1; i >= 0; i -= 1) {
    const a = item.wf?.attempts[i];
    if (a?.audit) return a.audit;
  }
  return undefined;
}

/** 依据执行体状态重算人工闸门等待原因（瞬时态，刷新后据此恢复，不依赖持久化） */
export function deriveAwaiting(item: BatchItem): BatchItem['awaiting'] {
  const wf = item.wf;
  if (!wf) return null;
  const last = latestAttempt(item);
  if (wf.state === 'paused' && last?.repair && !last.repair.confirmedAt) return 'repair';
  if (wf.state === 'warning' || wf.state === 'needs-review') return 'accept';
  if (
    item.identityMode === 'lock' &&
    wf.identityFeatures.length > 0 &&
    !wf.identityConfirmed &&
    wf.state === 'draft'
  ) {
    return 'identity';
  }
  return null;
}

export function itemDisplayState(item: BatchItem): BatchState | 'skipped' | 'pending' {
  if (item.skipped) return 'skipped';
  if (!item.wf) return 'pending';
  return item.wf.state;
}

export function itemStateLabel(state: BatchState | 'skipped' | 'pending'): string {
  if (state === 'skipped') return '已跳过';
  if (state === 'pending') return '待运行';
  return BATCH_STATE_LABELS[state];
}

export function itemRowStats(item: BatchItem): ItemRowStats {
  const state = itemDisplayState(item);
  const audit = latestAudit(item);
  let elapsedMs: number | undefined;
  if (item.startedAt) {
    const end = item.finishedAt ?? new Date().toISOString();
    elapsedMs = Math.max(0, new Date(end).getTime() - new Date(item.startedAt).getTime());
  }
  return {
    itemId: item.id,
    stateLabel: itemStateLabel(state),
    currentStep: nodeLabel(item.wf ? nodeForState(item.wf.state) : undefined),
    issueCount: audit?.issues.length ?? 0,
    auditStatus: audit?.status,
    compositeScore: audit?.compositeScore,
    elapsedMs,
  };
}

export type BatchProgress = {
  total: number;
  passed: number;
  warning: number;
  failed: number;
  needsReview: number;
  skipped: number;
  inProgress: number;
  pending: number;
  interrupted: number;
  settled: number;
};

export function batchProgress(batch: Batch): BatchProgress {
  const p: BatchProgress = {
    total: batch.items.length,
    passed: 0,
    warning: 0,
    failed: 0,
    needsReview: 0,
    skipped: 0,
    inProgress: 0,
    pending: 0,
    interrupted: 0,
    settled: 0,
  };
  for (const item of batch.items) {
    const s = itemDisplayState(item);
    if (s === 'skipped') p.skipped += 1;
    else if (s === 'passed') p.passed += 1;
    else if (s === 'warning') p.warning += 1;
    else if (s === 'failed') p.failed += 1;
    else if (s === 'needs-review') p.needsReview += 1;
    else if (s === 'interrupted') p.interrupted += 1;
    else if (s === 'pending' || s === 'draft' || s === 'queued') p.pending += 1;
    else p.inProgress += 1;
  }
  p.settled = p.passed + p.warning + p.failed + p.needsReview + p.skipped;
  return p;
}

/** 本批是否已无在跑/待跑（终态、跳过、中断都视为不再被引擎推进） */
export function isBatchSettled(batch: Batch): boolean {
  if (batch.items.length === 0) return false;
  return batch.items.every((i) => {
    if (i.skipped) return true;
    const s = i.wf?.state;
    if (!s) return false;
    return (
      isTerminalState(s) ||
      s === 'interrupted' ||
      // 停在人工闸门且等待人工处置，也不属“仍在自动运行”
      (s === 'paused' && !!deriveAwaiting(i))
    );
  });
}

/**
 * 刷新/重载恢复：把每件进行中的执行体判为 interrupted，队列若原本在跑则降级为 paused，
 * 不伪装运行、不自动续跑（docs/02）。人工闸门等待态据此重算。
 */
export function interruptBatchOnReload(batch: Batch): Batch {
  const items = batch.items.map((item) => {
    if (!item.wf) return { ...item, awaiting: null };
    const wf = resumeWorkflow(item.wf);
    const next: BatchItem = { ...item, wf, userPaused: wf.state === 'interrupted' ? true : item.userPaused };
    next.awaiting = deriveAwaiting(next);
    return next;
  });
  let status = batch.status;
  if (status === 'running') status = 'paused';
  return { ...batch, items, status, updatedAt: new Date().toISOString() };
}

export function queueStatusLabel(status: Batch['status']): string {
  return BATCH_QUEUE_STATUS_LABELS[status];
}
