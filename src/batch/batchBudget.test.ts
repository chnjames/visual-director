import { describe, expect, it } from 'vitest';
import {
  batchUsesAudit,
  classifyErrorLevel,
  estimateBatchBudget,
  isGroupImageCountValid,
  isNetworkError,
  isNodeSkipped,
  isTerminalState,
  itemUsesIdentity,
  nodeForState,
} from './batchBudget';
import { buildReadyBatch, img, safeError } from './batchTestUtils';

describe('错误分级（docs/02 错误隔离）', () => {
  it('Key/额度/Endpoint/服务端为系统级', () => {
    for (const cls of ['invalid-key', 'quota', 'endpoint-not-found', 'server', 'not-configured'] as const) {
      expect(classifyErrorLevel(safeError(cls, 'x'))).toBe('system');
    }
  });
  it('超时/单次网络/请求/Schema 问题为商品级', () => {
    for (const cls of ['timeout', 'network', 'bad-request', 'illegal-json', 'schema-violation'] as const) {
      expect(classifyErrorLevel(safeError(cls, 'x'))).toBe('item');
    }
  });
  it('network/timeout 计为网络类错误（用于连续失败统计）', () => {
    expect(isNetworkError(safeError('network', 'x'))).toBe(true);
    expect(isNetworkError(safeError('timeout', 'x'))).toBe(true);
    expect(isNetworkError(safeError('server', 'x'))).toBe(false);
  });
});

describe('调用预算（开始前展示预计/最坏，docs/01）', () => {
  it('默认 2 件：每件身份1+生成1+验收1=3，最坏再+3', () => {
    const b = buildReadyBatch(2, { identityMode: 'lock' });
    const budget = estimateBatchBudget(b);
    expect(budget.prepCalls).toBe(1);
    expect(budget.expected).toBe(6);
    expect(budget.worst).toBe(12);
  });

  it('跳过身份：每件预计 2（生成+验收），最坏 5', () => {
    const b = buildReadyBatch(3, { identityMode: 'skip' });
    const budget = estimateBatchBudget(b);
    expect(budget.expected).toBe(6);
    expect(budget.worst).toBe(15);
  });

  it('画布跳过结果验收：每件身份1+生成1=2，且不存在修复链（worst=expected）', () => {
    let b = buildReadyBatch(2, { identityMode: 'lock', skipNodes: ['resultAuditor'] });
    expect(batchUsesAudit(b)).toBe(false);
    const budget = estimateBatchBudget(b);
    expect(budget.expected).toBe(4);
    expect(budget.worst).toBe(4);
  });

  it('画布跳过身份锁定 ⇒ 不再调用身份', () => {
    let b = buildReadyBatch(2, { skipNodes: ['identityLock'] });
    expect(itemUsesIdentity(b, b.items[0])).toBe(false);
    expect(isNodeSkipped(b, 'identityLock')).toBe(true);
    const budget = estimateBatchBudget(b);
    expect(budget.expected).toBe(4); // 生成+验收
  });

  it('跳过的商品不占预算', () => {
    const b = buildReadyBatch(2);
    b.items[0].skipped = true;
    const budget = estimateBatchBudget(b);
    expect(budget.perItem.find((x) => x.itemId === b.items[0].id)?.expected).toBe(0);
  });
});

describe('数量边界与节点映射', () => {
  it('每件 2-3 张', () => {
    expect(isGroupImageCountValid(1)).toBe(false);
    expect(isGroupImageCountValid(2)).toBe(true);
    expect(isGroupImageCountValid(3)).toBe(true);
    expect(isGroupImageCountValid(4)).toBe(false);
  });
  it('状态映射到固定节点', () => {
    expect(nodeForState('analyzing')).toBe('identityLock');
    expect(nodeForState('generating')).toBe('sceneGenerator');
    expect(nodeForState('auditing')).toBe('resultAuditor');
    expect(nodeForState('repairing')).toBe('targetedRepair');
    expect(nodeForState('passed')).toBeUndefined();
  });
  it('终态判定', () => {
    expect(isTerminalState('passed')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('warning')).toBe(true);
    expect(isTerminalState('needs-review')).toBe(true);
    expect(isTerminalState('generating')).toBe(false);
  });
  it('img 夹具合法', () => {
    expect(img('x').dataUri.startsWith('data:')).toBe(true);
  });
});
