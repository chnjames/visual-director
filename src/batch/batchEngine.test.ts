import { describe, expect, it } from 'vitest';
import { BatchEngine } from './batchEngine';
import { estimateBatchBudget } from './batchBudget';
import {
  buildReadyBatch,
  deferred,
  fakeSettings,
  imageOk,
  makeAudit,
  makeFeature,
  makeRunners,
  ok,
  safeError,
  waitUntil,
} from './batchTestUtils';
import type { Runners } from '../workflow/orchestrator';
import type { IdentityFeature, ProbeOutcome } from '../shared/types';
import type { ImageGenerateResult } from '../model/arkClient';

function engineFor(batch: ReturnType<typeof buildReadyBatch>, runners: Runners) {
  const engine = new BatchEngine(batch, fakeSettings(), { runners, onChange: () => {} });
  engine.start();
  return engine;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('批量引擎 · 主路径与并发（docs/01：分析 2 / 生成 1）', () => {
  it('3 件跳过身份：全部生成+验收通过，调用数=预计值', async () => {
    const batch = buildReadyBatch(3, { identityMode: 'skip' });
    const runners = makeRunners({ auditStatus: 'passed' });
    const engine = engineFor(batch, runners);
    await waitUntil(() => engine.getSnapshot().status === 'completed');
    const snap = engine.getSnapshot();
    expect(snap.items.every((i) => i.wf?.state === 'passed')).toBe(true);
    expect(runners.counters.image).toBe(3);
    expect(runners.counters.audit).toBe(3);
    expect(runners.counters.identity).toBe(0);
    expect(snap.callsUsed).toBe(estimateBatchBudget(batch).expected);
  });

  it('身份提取最多并发 2，生成严格串行 1，身份闸门逐件确认', async () => {
    const batch = buildReadyBatch(3, { identityMode: 'lock' });
    const idGates = [
      deferred<ProbeOutcome<IdentityFeature[]>>(),
      deferred<ProbeOutcome<IdentityFeature[]>>(),
      deferred<ProbeOutcome<IdentityFeature[]>>(),
    ];
    const imgGate = deferred<ImageGenerateResult>();
    let idCall = 0;
    const runners = makeRunners({});
    runners.identity = async () => {
      runners.counters.identity += 1;
      runners.active.identity += 1;
      runners.maxActive.identity = Math.max(runners.maxActive.identity, runners.active.identity);
      const g = idGates[idCall];
      idCall += 1;
      try {
        return await g.promise;
      } finally {
        runners.active.identity -= 1;
      }
    };
    let imgCall = 0;
    runners.image = async () => {
      runners.counters.image += 1;
      runners.active.image += 1;
      runners.maxActive.image = Math.max(runners.maxActive.image, runners.active.image);
      try {
        if (imgCall === 0) return await imgGate.promise;
        return imageOk();
      } finally {
        runners.active.image -= 1;
        imgCall += 1;
      }
    };

    const engine = engineFor(batch, runners);

    // 仅 2 个身份提取同时进行
    await waitUntil(() => runners.counters.identity === 2);
    expect(runners.maxActive.identity).toBe(2);
    expect(runners.counters.identity).toBe(2);
    idGates[0].resolve(ok([makeFeature()]));
    idGates[1].resolve(ok([makeFeature()]));
    await waitUntil(() => runners.counters.identity === 3);
    idGates[2].resolve(ok([makeFeature()]));

    // 三件都到身份闸门，逐件确认
    await waitUntil(
      () => engine.getSnapshot().items.filter((i) => i.awaiting === 'identity').length === 3,
    );
    for (const item of engine.getSnapshot().items) engine.confirmIdentity(item.id);

    // 生成严格串行：第一件卡在图片调用时，不会有第二件进入生成
    await waitUntil(() => runners.counters.image === 1);
    expect(runners.maxActive.image).toBe(1);
    expect(runners.counters.image).toBe(1);
    imgGate.resolve(imageOk());

    await waitUntil(() => engine.getSnapshot().status === 'completed');
    expect(engine.getSnapshot().items.every((i) => i.wf?.state === 'passed')).toBe(true);
    expect(runners.counters.image).toBe(3);
  });
});

describe('批量引擎 · 错误隔离与系统级暂停（docs/02）', () => {
  it('单件商品级失败不影响其余商品', async () => {
    const batch = buildReadyBatch(3, { identityMode: 'skip' });
    const runners = makeRunners({});
    let imageCalls = 0;
    runners.image = async () => {
      imageCalls += 1;
      runners.counters.image += 1;
      if (imageCalls === 2) return safeError('timeout', '第2件生成超时');
      return imageOk();
    };
    const engine = engineFor(batch, runners);
    await waitUntil(() => engine.getSnapshot().status === 'completed');
    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.systemError).toBeUndefined();
    expect(snap.items[0].wf?.state).toBe('passed');
    expect(snap.items[1].wf?.state).toBe('failed');
    expect(snap.items[2].wf?.state).toBe('passed');
  });

  it('系统级错误（invalid-key）暂停整批，进行中该件判 interrupted；处置后可恢复', async () => {
    const batch = buildReadyBatch(3, { identityMode: 'skip' });
    const runners = makeRunners({});
    let imageCalls = 0;
    let keyFixed = false;
    runners.image = async () => {
      imageCalls += 1;
      runners.counters.image += 1;
      if (imageCalls === 1 && !keyFixed) return safeError('invalid-key', 'Key 无效');
      return imageOk();
    };
    const engine = engineFor(batch, runners);
    await waitUntil(() => engine.getSnapshot().status === 'system-paused');
    const snap1 = engine.getSnapshot();
    expect(snap1.systemError?.errorClass).toBe('invalid-key');
    expect(snap1.items[0].wf?.state).toBe('interrupted');
    expect(snap1.items[1].wf?.state).not.toBe('failed');

    // 用户修正 Key 后：继续整批（唤醒被暂停的件）并逐件恢复中断件
    keyFixed = true;
    engine.setSettings(fakeSettings());
    engine.resumeAll();
    engine.resumeItem(snap1.items[0].id);
    await waitUntil(() => engine.getSnapshot().status === 'completed');
    expect(engine.getSnapshot().items.every((i) => i.wf?.state === 'passed')).toBe(true);
  });

  it('连续网络失败达阈值升级为系统级暂停', async () => {
    const batch = buildReadyBatch(3, { identityMode: 'skip' });
    const runners = makeRunners({});
    runners.image = async () => {
      runners.counters.image += 1;
      return safeError('network', '网络失败');
    };
    const engine = engineFor(batch, runners);
    await waitUntil(() => engine.getSnapshot().status === 'system-paused');
    const snap = engine.getSnapshot();
    expect(snap.consecutiveNetworkFailures).toBe(3);
    expect(snap.systemError?.errorClass).toBe('network');
  });
});

describe('批量引擎 · 定向修复一次（docs/04、docs/09）', () => {
  it('低风险失败自动修复一次并重生成通过，自动调用数=最坏值且不超', async () => {
    const batch = buildReadyBatch(1, { identityMode: 'skip' });
    const runners = makeRunners({});
    let auditCalls = 0;
    runners.audit = (async () => {
      auditCalls += 1;
      if (auditCalls === 1) {
        return ok(makeAudit('failed', [{ dimension: 'technical', severity: 'major', statement: '轻微噪点', evidence: [], confidence: 0.7 }]));
      }
      return ok(makeAudit('passed'));
    }) as unknown as Runners['audit'];
    const engine = engineFor(batch, runners);
    await waitUntil(() => engine.getSnapshot().status === 'completed');
    const snap = engine.getSnapshot();
    expect(snap.items[0].wf?.state).toBe('passed');
    expect(snap.items[0].wf?.repairUsed).toBe(true);
    expect(snap.items[0].wf?.attempts).toHaveLength(2);
    expect(runners.counters.image).toBe(2);
    expect(auditCalls).toBe(2);
    expect(runners.counters.repair).toBe(1);
    expect(snap.callsUsed).toBe(estimateBatchBudget(batch).worst);
  });

  it('高风险失败必须停车人工确认，确认后才重生成', async () => {
    const batch = buildReadyBatch(1, { identityMode: 'skip' });
    const runners = makeRunners({});
    let auditCalls = 0;
    runners.audit = (async () => {
      auditCalls += 1;
      if (auditCalls === 1) {
        return ok(makeAudit('failed', [{ dimension: 'identity', severity: 'critical', statement: 'Logo 被改变', evidence: [], confidence: 0.9 }]));
      }
      return ok(makeAudit('passed'));
    }) as unknown as Runners['audit'];
    const engine = engineFor(batch, runners);
    await waitUntil(() => engine.getSnapshot().items[0].awaiting === 'repair');
    expect(runners.counters.image).toBe(1); // 尚未重生成
    expect(engine.getSnapshot().items[0].wf?.state).toBe('paused');
    engine.applyRepair(engine.getSnapshot().items[0].id);
    await waitUntil(() => engine.getSnapshot().status === 'completed');
    expect(runners.counters.image).toBe(2);
    expect(engine.getSnapshot().items[0].wf?.state).toBe('passed');
  });

  it('warning 需人工接受后才标记通过', async () => {
    const batch = buildReadyBatch(1, { identityMode: 'skip' });
    const runners = makeRunners({ auditStatus: 'warning' });
    const engine = engineFor(batch, runners);
    await waitUntil(() => engine.getSnapshot().items[0].awaiting === 'accept');
    expect(engine.getSnapshot().items[0].wf?.state).toBe('warning');
    engine.acceptItem(engine.getSnapshot().items[0].id);
    await waitUntil(() => engine.getSnapshot().items[0].wf?.state === 'passed');
  });
});

describe('批量引擎 · 暂停/跳过/重试/验收跳过', () => {
  it('暂停整批后不发起新的生成调用，继续后跑完', async () => {
    const batch = buildReadyBatch(3, { identityMode: 'skip' });
    const imgGate = deferred<ImageGenerateResult>();
    const runners = makeRunners({ gateImage: imgGate });
    const engine = engineFor(batch, runners);
    await waitUntil(() => runners.counters.image === 1);
    engine.pauseAll();
    imgGate.resolve(imageOk());
    await sleep(60);
    expect(runners.counters.image).toBe(1); // 第2、3件未开始生成
    expect(engine.getSnapshot().status).toBe('paused');
    engine.resumeAll();
    await waitUntil(() => engine.getSnapshot().status === 'completed');
    expect(runners.counters.image).toBe(3);
  });

  it('生成失败（无验收）终态失败，手动重试后通过，retryCount+1', async () => {
    const batch = buildReadyBatch(1, { identityMode: 'skip' });
    const runners = makeRunners({});
    let calls = 0;
    runners.image = async () => {
      calls += 1;
      runners.counters.image += 1;
      if (calls === 1) return safeError('timeout', '首图超时');
      return imageOk();
    };
    const engine = engineFor(batch, runners);
    await waitUntil(() => engine.getSnapshot().items[0].wf?.state === 'failed');
    expect(engine.getSnapshot().status).toBe('completed');
    engine.retryItem(engine.getSnapshot().items[0].id);
    await waitUntil(() => engine.getSnapshot().items[0].wf?.state === 'passed');
    expect(engine.getSnapshot().items[0].retryCount).toBe(1);
  });

  it('画布跳过结果验收：只生成不验收，结论为 needs-review，且不调用验收', async () => {
    const batch = buildReadyBatch(1, { identityMode: 'skip', skipNodes: ['resultAuditor'] });
    const runners = makeRunners({});
    const engine = engineFor(batch, runners);
    await waitUntil(() => engine.getSnapshot().items[0].awaiting === 'accept');
    const item = engine.getSnapshot().items[0];
    expect(item.wf?.state).toBe('needs-review');
    expect(runners.counters.audit).toBe(0);
    expect(item.wf?.attempts[0].image).toBeTruthy();
    engine.acceptItem(item.id);
    await waitUntil(() => engine.getSnapshot().items[0].wf?.state === 'passed');
  });

  it('未配置模型不能 start', () => {
    const batch = buildReadyBatch(1);
    const runners = makeRunners({});
    const engine = new BatchEngine(batch, null, { runners });
    expect(() => engine.start()).toThrow(/未配置/);
  });
});
