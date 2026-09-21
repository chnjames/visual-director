/**
 * 节点库浮层（docs/12 §2/§4）。默认收起，按需打开；支持搜索、分类、
 * 点击在当前视口中心附近插入。
 * 分层：可执行主线 / 即将支持 / 兼容保留（旧四节点），不伪装可执行。
 */
import { useMemo, useState } from 'react';
import {
  LIBRARY_TIER_LABELS,
  NODE_REGISTRY,
  libraryTierOf,
  type LibraryTier,
} from '../../workflow/graph/registry';
import type { WorkflowGraph } from '../../workflow/graph/types';
import type { CanvasView } from '../../data/canvasViewStore';

const TIER_ORDER: LibraryTier[] = ['mainline'];
const CATEGORY_ORDER = ['输入', '理解', '提示词', '生成', '图像处理', '验收', '人工确认', '输出'];

export function NodeLibraryPopover({
  graph,
  onAdd,
  onClose,
  viewportCenter,
  view,
}: {
  graph: WorkflowGraph;
  onAdd: (type: string, worldPos?: { x: number; y: number }) => void;
  onClose: () => void;
  viewportCenter: () => { width: number; height: number };
  view: CanvasView;
}) {
  const [query, setQuery] = useState('');

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of graph.nodes) m.set(n.type, (m.get(n.type) ?? 0) + 1);
    return m;
  }, [graph]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return NODE_REGISTRY.filter((d) => {
      if (libraryTierOf(d.type) !== 'mainline') return false;
      if (!q) return true;
      return (
        d.title.toLowerCase().includes(q) ||
        d.category.includes(q) ||
        d.summary.toLowerCase().includes(q) ||
        d.type.toLowerCase().includes(q)
      );
    });
  }, [query]);

  const tiered = useMemo(() => {
    return TIER_ORDER.map((tier) => {
      const defs = filtered.filter((d) => libraryTierOf(d.type) === tier);
      const byCat = CATEGORY_ORDER.map((cat) => ({
        cat,
        defs: defs.filter((d) => d.category === cat),
      })).filter((g) => g.defs.length > 0);
      return { tier, byCat, count: defs.length };
    }).filter((g) => g.count > 0);
  }, [filtered]);

  function centerWorldPos() {
    const { width, height } = viewportCenter();
    return {
      x: Math.round((width / 2 - view.pan.x) / view.zoom - 80),
      y: Math.round((height / 2 - view.pan.y) / view.zoom - 30),
    };
  }

  return (
    <>
      <div className="popover-scrim" onMouseDown={onClose} aria-hidden />
      <div className="nodelib-popover" role="dialog" aria-label="节点库" data-testid="node-library">
        <div className="nodelib-head">
          <strong>添加节点</strong>
          <button type="button" className="icon-btn" aria-label="关闭节点库" onClick={onClose}>✕</button>
        </div>
        <input
          autoFocus
          type="text"
          className="nodelib-search"
          placeholder="搜索节点，如：配方、生成、验收、Prompt"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索节点"
          data-testid="node-library-search"
        />
        <div className="nodelib-list">
          {tiered.length === 0 && <div className="hint" style={{ padding: 12 }}>没有匹配的节点</div>}
          {tiered.map(({ tier, byCat }) => (
            <div key={tier} data-testid={`nodelib-tier-${tier}`}>
              <div className="nodelib-tier">{LIBRARY_TIER_LABELS[tier]}</div>
              {byCat.map(({ cat, defs }) => (
                <div key={`${tier}-${cat}`}>
                  <div className="nodelib-group">{cat}</div>
                  {defs.map((d) => {
                    const used = counts.get(d.type) ?? 0;
                    const full = !!d.maxInstances && used >= d.maxInstances;
                    return (
                      <button
                        key={d.type}
                        type="button"
                        className="nodelib-item"
                        disabled={full}
                        title={full ? `每条工作流最多 ${d.maxInstances} 个` : d.summary}
                        onClick={() => onAdd(d.type, centerWorldPos())}
                        data-testid={`add-node-${d.type}`}
                      >
                        <span className="nodelib-item-body">
                          <span className="nodelib-item-title">
                            {d.title}
                            {tier === 'planned' && <em className="planned-tag">规划中</em>}
                            {tier === 'compat' && <em className="planned-tag">兼容</em>}
                            {full && <span className="badge plain rejected">已达上限</span>}
                          </span>
                          <span className="nodelib-item-summary">{d.summary}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="nodelib-foot hint">
          当前仅展示已打通的核心节点；旧节点只用于打开历史工作流。
        </div>
      </div>
    </>
  );
}
