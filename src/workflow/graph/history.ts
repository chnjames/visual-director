/**
 * 工作流编辑历史（撤销/重做）。
 * 结构化快照：保存不可变图引用；每次提交产生一个历史点。
 * 拖动过程中只更新当前快照，松手才 push，避免历史被像素级拖动淹没。
 */
import type { WorkflowGraph } from './types';

export class GraphHistory {
  private past: WorkflowGraph[] = [];
  private present: WorkflowGraph;
  private future: WorkflowGraph[] = [];
  private capacity: number;

  constructor(initial: WorkflowGraph, capacity = 100) {
    this.present = initial;
    this.capacity = capacity;
  }

  get current(): WorkflowGraph {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoCount(): number {
    return this.past.length;
  }

  /** 提交一个已完成的编辑（产生历史点；相同引用/深相等则忽略） */
  commit(next: WorkflowGraph): void {
    if (next === this.present || graphsEqual(next, this.present)) return;
    this.past.push(this.present);
    if (this.past.length > this.capacity) this.past.shift();
    this.present = next;
    this.future = [];
  }

  /** 不产生历史点地替换当前（用于拖动等临时态） */
  replaceTransient(next: WorkflowGraph): void {
    this.present = next;
  }

  /** 把临时态固化为历史点（拖动松手） */
  commitTransient(): void {
    const prev = this.past[this.past.length - 1];
    if (prev && graphsEqual(prev, this.present)) {
      // 拖动没有实际位移
      this.present = prev;
      this.past.pop();
      return;
    }
    if (this.past.length > this.capacity) this.past.shift();
    // commit() 已经负责 push；这里仅在使用 transient 后由 UI 调用 commit 实际下一帧
  }

  undo(): WorkflowGraph {
    const prev = this.past.pop();
    if (!prev) return this.present;
    this.future.unshift(this.present);
    this.present = prev;
    return this.present;
  }

  redo(): WorkflowGraph {
    const next = this.future.shift();
    if (!next) return this.present;
    this.past.push(this.present);
    this.present = next;
    return this.present;
  }
}

function graphsEqual(a: WorkflowGraph, b: WorkflowGraph): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  // 历史必须同时识别位置和配置变化。图片、提示词与生成参数都保存在 config；
  // 若只比较位置/连线，所有检查器编辑都会被 commit 当成“没有变化”而丢弃。
  for (let i = 0; i < a.nodes.length; i += 1) {
    const x = a.nodes[i];
    const y = b.nodes.find((n) => n.id === x.id);
    if (!y) return false;
    if (x.position.x !== y.position.x || x.position.y !== y.position.y || x.type !== y.type) return false;
    // 图操作遵循不可变更新：配置改变时会创建新 config，未改变时复用引用。
    // 用引用比较可避免每次输入提示词都序列化体积很大的图片 data URI。
    if (x.config !== y.config) return false;
  }
  const ea = a.edges.map((e) => `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`).sort();
  const eb = b.edges.map((e) => `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`).sort();
  return ea.every((v, i) => v === eb[i]);
}
