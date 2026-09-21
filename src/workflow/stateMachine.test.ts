import { describe, expect, it } from 'vitest';
import { interruptIfInFlight, transition } from './stateMachine';

describe('stateMachine', () => {
  it('主路径：draft→analyzing→draft→generating→auditing→passed', () => {
    let s = transition('draft', 'START_ANALYSIS');
    expect(s).toBe('analyzing');
    s = transition(s, 'ANALYSIS_FINISHED');
    expect(s).toBe('draft');
    s = transition(s, 'START_GENERATION');
    expect(s).toBe('generating');
    s = transition(s, 'GENERATION_SUCCEEDED');
    expect(s).toBe('auditing');
    s = transition(s, 'AUDIT_FINISHED', { auditStatus: 'passed' });
    expect(s).toBe('passed');
  });

  it('failed→repairing→paused→generating（修复一次）', () => {
    let s = transition('failed', 'START_REPAIR', { repairUsed: false });
    expect(s).toBe('repairing');
    s = transition(s, 'REPAIR_PROPOSED');
    expect(s).toBe('paused');
    s = transition(s, 'APPLY_REPAIR');
    expect(s).toBe('generating');
  });

  it('已用过修复则禁止再次 START_REPAIR', () => {
    expect(() => transition('failed', 'START_REPAIR', { repairUsed: true })).toThrow(/最多定向修复一次/);
  });

  it('不能从 passed 发起修复（非法转移）', () => {
    expect(() => transition('passed', 'START_REPAIR')).toThrow(/非法状态转移/);
  });

  it('warning 只能人工确认转 passed', () => {
    expect(transition('warning', 'CONFIRM_WARNING')).toBe('passed');
    expect(() => transition('warning', 'START_GENERATION')).toThrow(/非法状态转移/);
  });

  it('needs-review 可人工接受为 passed', () => {
    expect(transition('needs-review', 'CONFIRM_WARNING')).toBe('passed');
  });

  it('AUDIT_FINISHED 必须带状态', () => {
    expect(() => transition('auditing', 'AUDIT_FINISHED')).toThrow(/必须携带验收状态/);
  });

  it('进行中状态刷新判为 interrupted，终态不受影响', () => {
    expect(interruptIfInFlight('generating')).toBe('interrupted');
    expect(interruptIfInFlight('auditing')).toBe('interrupted');
    expect(interruptIfInFlight('passed')).toBe('passed');
    expect(interruptIfInFlight('draft')).toBe('draft');
    expect(transition('interrupted', 'RESUME')).toBe('draft');
  });

  it('生成失败进入 failed', () => {
    expect(transition('generating', 'GENERATION_FAILED')).toBe('failed');
    expect(transition('analyzing', 'FAIL')).toBe('failed');
  });
});
