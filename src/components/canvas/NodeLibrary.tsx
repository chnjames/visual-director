import type { WorkflowNodeId } from '../../workflow/workflowConstants';
import { WORKFLOW_NODE_LABELS } from '../../workflow/workflowConstants';

const GROUPS: Array<{ label: string; nodes: WorkflowNodeId[] }> = [
  { label: '输入', nodes: ['referenceInput', 'productInput'] },
  { label: '理解', nodes: ['recipeExtractor'] },
  { label: '锁定', nodes: ['identityLock'] },
  { label: '生成', nodes: ['sceneGenerator'] },
  { label: '验收', nodes: ['resultAuditor'] },
  { label: '输出', nodes: ['targetedRepair'] },
];

const ICONS: Record<WorkflowNodeId, string> = {
  referenceInput: '▣',
  productInput: '▣',
  recipeExtractor: '✦',
  identityLock: '🔒',
  sceneGenerator: '✸',
  resultAuditor: '✓',
  targetedRepair: '⟳',
};

/**
 * 左侧节点库（docs/12 §2）。首版只展示固定主干节点：
 * 点击即选中并定位到画布对应节点；不提供新增/自由连线（docs/12 §12）。
 */
export function NodeLibrary({
  collapsed,
  selectedNodeId,
  onSelect,
}: {
  collapsed: boolean;
  selectedNodeId: WorkflowNodeId | null;
  onSelect: (id: WorkflowNodeId) => void;
}) {
  if (collapsed) {
    return (
      <aside className="node-library collapsed" data-testid="node-library" aria-label="节点库">
        <div className="lib-ico" title="节点库">▦</div>
      </aside>
    );
  }
  return (
    <aside className="node-library" data-testid="node-library" aria-label="节点库">
      <div className="lib-title">节点库 · 固定主干</div>
      {GROUPS.map((g) => (
        <div key={g.label}>
          <div className="lib-group">{g.label}</div>
          {g.nodes.map((id) => (
            <button
              key={id}
              type="button"
              className="lib-node"
              onClick={() => onSelect(id)}
              style={selectedNodeId === id ? { background: 'var(--c-teal-soft)', color: 'var(--c-director-deep)', fontWeight: 600 } : undefined}
              data-testid={`lib-node-${id}`}
            >
              <span className="lib-ico" aria-hidden>{ICONS[id]}</span>
              <span>{WORKFLOW_NODE_LABELS[id]}</span>
            </button>
          ))}
        </div>
      ))}
      <div className="hint" style={{ padding: '12px 8px 0', lineHeight: 1.6 }}>
        首版连接关系固定，不可自由连线或新增节点。
      </div>
    </aside>
  );
}
