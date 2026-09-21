/**
 * 阶段3 工作流画布：可视化与批量执行**同一个** WorkflowDefinition（batch.definition）。
 * 固定主干：不提供自由增删节点/连线/循环/自定义代码（docs/01 规则、docs/09 防画布吞噬工期）。
 * - 输入/生成类节点永久不可删；
 * - 仅 identityLock / resultAuditor 可跳过（勾选即提示风险，运行开始后锁定不可改）；
 * - targetedRepair 默认锁定，仅在所选商品验收失败后点亮；
 * - 节点状态随所选商品实时高亮（数据来自批量执行体，非动画假状态）。
 */
import type { Batch, BatchItem } from '../../batch/batchTypes';
import { isNodeSkipped } from '../../batch/batchBudget';
import { SKIPPABLE_NODES, WORKFLOW_NODE_LABELS, type WorkflowNodeId } from '../../workflow/workflowConstants';

type Pos = { x: number; y: number };
const NODE_W = 178;
const NODE_H = 60;
const POSITIONS: Record<WorkflowNodeId, Pos> = {
  referenceInput: { x: 16, y: 16 },
  productInput: { x: 16, y: 168 },
  recipeExtractor: { x: 250, y: 16 },
  identityLock: { x: 484, y: 92 },
  sceneGenerator: { x: 718, y: 92 },
  resultAuditor: { x: 940, y: 92 },
  targetedRepair: { x: 940, y: 210 },
};
const CANVAS_W = 1140;
const CANVAS_H = 300;

type NodeVisualState = 'idle' | 'active' | 'done' | 'skipped' | 'locked' | 'failed';

function edgePath(from: WorkflowNodeId, to: WorkflowNodeId): string {
  const a = POSITIONS[from];
  const b = POSITIONS[to];
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

function itemNodeState(
  item: BatchItem | undefined,
  nodeId: WorkflowNodeId,
  batchSkipped: WorkflowNodeId[],
): NodeVisualState {
  if (batchSkipped.includes(nodeId)) return 'skipped';
  const wf = item?.wf;
  switch (nodeId) {
    case 'referenceInput':
    case 'productInput':
      return wf ? 'done' : 'idle';
    case 'recipeExtractor':
      return wf?.recipeConfirmed ? 'done' : 'idle';
    case 'identityLock':
      if (item?.identityMode === 'skip') return 'skipped';
      if (wf?.state === 'analyzing') return 'active';
      return wf?.identityConfirmed ? 'done' : 'idle';
    case 'sceneGenerator':
      if (wf?.state === 'generating') return 'active';
      return wf?.attempts.some((a) => a.image) ? 'done' : 'idle';
    case 'resultAuditor':
      if (wf?.state === 'auditing') return 'active';
      return wf?.attempts.some((a) => a.audit) ? 'done' : 'idle';
    case 'targetedRepair': {
      if (wf?.state === 'repairing') return 'active';
      if (wf?.repairUsed) return 'done';
      const last = wf?.attempts[wf.attempts.length - 1];
      if (wf?.state === 'failed' && last?.audit) return 'failed';
      return 'locked';
    }
    default:
      return 'idle';
  }
}

const SKIP_RISK: Partial<Record<WorkflowNodeId, string>> = {
  identityLock: '跳过身份锁定后，模型推测特征不会成为硬约束，可能出现商品形态/Logo 偏差。',
  resultAuditor: '跳过结果验收后，系统无法判定成败，生成结果只能标记为“需人工确认”。',
};

export function WorkflowCanvas({
  batch,
  selectedItemId,
  onSelectItem,
  onToggleNode,
}: {
  batch: Batch | null;
  selectedItemId?: string;
  onSelectItem?: (itemId: string) => void;
  onToggleNode?: (nodeId: WorkflowNodeId) => void;
}) {
  if (!batch?.definition) {
    return (
      <div className="gate" data-testid="canvas-empty">
        <h3>画布将在确认视觉配方后生成</h3>
        <p>
          画布与批量运行共用同一个固定主干 WorkflowDefinition（7 节点、不可自由连线）。
          请先在“批量运行”页上传参考图、提取并确认视觉配方。
        </p>
      </div>
    );
  }

  const def = batch.definition;
  const selected = batch.items.find((i) => i.id === selectedItemId) ?? batch.items[0];
  const locked = batch.status === 'running' || batch.status === 'completed' || batch.status === 'system-paused';

  return (
    <div className="canvas-wrap" data-testid="workflow-canvas">
      <div className="canvas-meta">
        <strong>{def.name}</strong>
        <span className="hint">
          定义 ID {def.id} · v{def.version} · 固定主干（画布与批量共用，禁止循环/悬空边/自定义代码）
        </span>
      </div>

      <div className="canvas-selector">
        <span className="hint">高亮商品：</span>
        <select
          aria-label="选择要在画布上高亮的商品"
          value={selected?.id ?? ''}
          onChange={(e) => onSelectItem?.(e.target.value)}
          data-testid="canvas-item-select"
        >
          {batch.items.length === 0 && <option value="">（尚未添加商品）</option>}
          {batch.items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>

      <div className="canvas-scroll">
        <svg width={CANVAS_W} height={CANVAS_H} className="canvas-svg">
          {def.edges.map((e, idx) => {
            const failed = e.conditional === 'on-fail';
            return (
              <g key={idx} data-testid={`canvas-edge-${e.from}-${e.to}`}>
                <path
                  d={edgePath(e.from, e.to)}
                  fill="none"
                  className={failed ? 'edge edge-conditional' : 'edge'}
                  markerEnd={failed ? 'url(#arrow-red)' : 'url(#arrow)'}
                />
                {failed && (
                  <text x={POSITIONS[e.to].x + 96} y={POSITIONS[e.from].y + NODE_H + 18} className="edge-label">
                    仅验收失败
                  </text>
                )}
              </g>
            );
          })}
          <defs>
            <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6 Z" className="arrow-head" />
            </marker>
            <marker id="arrow-red" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6 Z" className="arrow-head-red" />
            </marker>
          </defs>
        </svg>

        {def.nodes.map((node) => {
          const pos = POSITIONS[node.id];
          const visual = itemNodeState(selected, node.id, batch.skippedNodeIds);
          const skippable = SKIPPABLE_NODES.includes(node.id);
          const skipped = isNodeSkipped(batch, node.id);
          return (
            <div
              key={node.id}
              className={`wf-node ${visual}`}
              data-testid={`canvas-node-${node.id}`}
              data-state={visual}
              style={{ left: pos.x, top: pos.y, width: NODE_W, minHeight: NODE_H }}
            >
              <div className="wf-node-label">{WORKFLOW_NODE_LABELS[node.id]}</div>
              <div className="wf-node-tags">
                {node.permanent && <span className="tag permanent">不可删</span>}
                {skippable && <span className="tag skippable">可跳过</span>}
                {node.id === 'targetedRepair' && visual === 'locked' && (
                  <span className="tag locked">失败后启用</span>
                )}
                {visual === 'skipped' && <span className="tag skipped-tag">已跳过</span>}
                {visual === 'active' && <span className="tag active">进行中</span>}
                {visual === 'done' && <span className="tag done">完成</span>}
                {visual === 'failed' && <span className="tag failed-tag">待修复</span>}
              </div>
              {skippable && (
                <label className="wf-skip" data-testid={`canvas-skip-${node.id}`}>
                  <input
                    type="checkbox"
                    checked={skipped}
                    disabled={locked}
                    onChange={() => onToggleNode?.(node.id)}
                  />
                  跳过此节点（风险自担）
                </label>
              )}
              {skippable && skipped && <div className="skip-risk">{SKIP_RISK[node.id]}</div>}
            </div>
          );
        })}
      </div>
      <p className="hint">
        说明：本画布是固定主干的实时可视化，不提供拖拽改线/自定义节点；分析、锁定、验收可在开跑前跳过并明确提示风险，
        修复节点仅在验收失败后启用，全图无环。
      </p>
    </div>
  );
}
