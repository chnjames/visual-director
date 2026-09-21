import { describe, expect, it } from 'vitest';
import {
  batchProgress,
  deriveAwaiting,
  interruptBatchOnReload,
  isBatchSettled,
  itemDisplayState,
  itemRowStats,
  latestAudit,
} from './batchQueue';
import { parsePersistedBatch } from './batchSchema';
import { buildReadyBatch, img, makeAudit, makeFeature } from './batchTestUtils';
import { createWorkflow } from '../workflow/orchestrator';
import type { BatchItem } from './batchTypes';
import type { SingleItemWorkflow } from '../workflow/workflowTypes';

function wfWith(partial: Partial<SingleItemWorkflow>): SingleItemWorkflow {
  const wf = createWorkflow({
    referenceImages: [img('r1')],
    productImages: [img('a'), img('b')],
    taskPurpose: '用途',
  });
  return { ...wf, ...partial };
}

function withItems(batch: ReturnType<typeof buildReadyBatch>, wfs: SingleItemWorkflow[]): typeof batch {
  const items: BatchItem[] = batch.items.map((item, i) => ({
    ...item,
    wf: wfs[i],
    startedAt: new Date().toISOString(),
  }));
  return { ...batch, items, status: 'running' };
}

describe('派生状态', () => {
  it('统计各状态数量', () => {
    let b = buildReadyBatch(4);
    b = withItems(b, [
      wfWith({ state: 'passed' }),
      wfWith({ state: 'failed' }),
      wfWith({ state: 'generating' }),
      wfWith({ state: 'queued' }),
    ]);
    const p = batchProgress(b);
    expect(p.passed).toBe(1);
    expect(p.failed).toBe(1);
    expect(p.inProgress).toBe(1);
    expect(p.pending).toBe(1);
    expect(p.settled).toBe(2);
  });

  it('跳过件计入 skipped', () => {
    let b = buildReadyBatch(2);
    b = withItems(b, [wfWith({ state: 'passed' }), wfWith({ state: 'queued' })]);
    b.items[1].skipped = true;
    expect(batchProgress(b).skipped).toBe(1);
  });

  it('最新验收与问题数', () => {
    const audit = makeAudit('failed', [
      { dimension: 'identity', severity: 'critical', statement: 'Logo 错误', evidence: [], confidence: 0.9 },
    ]);
    const wf = wfWith({
      state: 'failed',
      attempts: [
        {
          id: 'att1',
          version: 1,
          status: 'failed',
          prompt: {
            sourceRecipeId: 'r',
            compiledAt: '',
            positivePrompt: 'p',
            negativePrompt: 'n',
            identityConstraints: [],
            requiredRules: [],
            variableRules: [],
            forbiddenRules: [],
            fieldValues: {},
          },
          audit,
        },
      ],
    });
    const item: BatchItem = {
      id: 'x',
      name: 'x',
      images: [img('a'), img('b')],
      identityMode: 'skip',
      groupingConfirmed: true,
      userPaused: false,
      skipped: false,
      retryCount: 0,
      awaiting: null,
      wf,
    };
    expect(latestAudit(item)?.issues).toHaveLength(1);
    expect(itemRowStats(item).issueCount).toBe(1);
    expect(itemDisplayState(item)).toBe('failed');
  });
});

describe('人工闸门等待态重算（瞬时，不持久化）', () => {
  it('lock 模式提取身份后等待确认', () => {
    const item: BatchItem = {
      id: 'x',
      name: 'x',
      images: [img('a'), img('b')],
      identityMode: 'lock',
      groupingConfirmed: true,
      userPaused: false,
      skipped: false,
      retryCount: 0,
      awaiting: null,
      wf: wfWith({ state: 'draft', identityFeatures: [makeFeature()] }),
    };
    expect(deriveAwaiting(item)).toBe('identity');
  });
  it('warning/needs-review 等待人工接受', () => {
    const item = {
      id: 'x',
      name: 'x',
      images: [img('a'), img('b')],
      identityMode: 'skip' as const,
      groupingConfirmed: true,
      userPaused: false,
      skipped: false,
      retryCount: 0,
      awaiting: null,
      wf: wfWith({ state: 'warning' }),
    };
    expect(deriveAwaiting(item)).toBe('accept');
  });
});

describe('刷新恢复：进行中→interrupted，绝不伪装运行（docs/02、docs/10）', () => {
  it('running 批次重载后降级 paused，进行中件判 interrupted', () => {
    let b = buildReadyBatch(3);
    b = withItems(b, [
      wfWith({ state: 'analyzing' }),
      wfWith({ state: 'generating' }),
      wfWith({ state: 'passed' }),
    ]);
    const restored = interruptBatchOnReload(b);
    expect(restored.status).toBe('paused');
    expect(restored.items[0].wf!.state).toBe('interrupted');
    expect(restored.items[1].wf!.state).toBe('interrupted');
    expect(restored.items[2].wf!.state).toBe('passed');
    expect(restored.items[0].userPaused).toBe(true);
  });

  it('持久化往返后仍判定 interrupted（不半信任、不伪装）', () => {
    let b = buildReadyBatch(2);
    b = withItems(b, [wfWith({ state: 'auditing' }), wfWith({ state: 'queued' })]);
    const parsed = parsePersistedBatch(JSON.parse(JSON.stringify(b)));
    expect(parsed.status).toBe('paused');
    expect(parsed.items[0].wf!.state).toBe('interrupted');
    expect(parsed.items[1].wf!.state).toBe('interrupted'); // queued 也属进行中
  });

  it('损坏/不支持版本不被加载', () => {
    expect(() => parsePersistedBatch({ foo: 1 })).toThrow();
    expect(() => parsePersistedBatch({ ...buildReadyBatch(1), schemaVersion: 999 })).toThrow(/schemaVersion/);
  });

  it('全部终态/跳过才算 settled', () => {
    let b = buildReadyBatch(2);
    b = withItems(b, [wfWith({ state: 'passed' }), wfWith({ state: 'queued' })]);
    expect(isBatchSettled(b)).toBe(false);
    b.items[1].skipped = true;
    expect(isBatchSettled(b)).toBe(true);
  });
});
