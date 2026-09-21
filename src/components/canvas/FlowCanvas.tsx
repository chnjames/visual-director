import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowNodeId } from '../../workflow/workflowConstants';
import {
  deriveNodeSummaries,
  FIXED_EDGES,
  NODE_DEFAULT_POSITIONS,
  NODE_H,
  NODE_W,
  type NodeSummary,
} from './canvasModel';
import type { SingleItemWorkflow } from '../../workflow/workflowTypes';
import type { CanvasView } from '../../data/canvasViewStore';

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const WORLD_W = 1400;
const WORLD_H = 640;

type Point = { x: number; y: number };

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 固定连接的贝塞尔路径（只读；失败边为虚线条件边） */
function edgePath(from: Point, to: Point): string {
  const dx = Math.max(60, (to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

const NODE_STATE_ICON: Record<NodeSummary['state'], string> = {
  unconfigured: '○',
  waiting: '◌',
  running: '◔',
  review: '◆',
  done: '✓',
  warning: '▲',
  failed: '✕',
  skipped: '–',
};

export type FlowCanvasHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  fitAll: () => void;
};

/**
 * 可平移/缩放/拖动节点的画布（docs/12 §6）。
 * - 空白拖动平移；滚轮以指针为锚点缩放（0.2–2.5）；
 * - 节点可拖动（连接只读、不可自由连线）；
 * - 视口与位置经 onChange 上抛，由页面做 800ms 防抖持久化。
 */
export const FlowCanvas = ({
  wf,
  view,
  selectedNodeId,
  onSelectNode,
  onChange,
  onRunNode,
  handleRef,
}: {
  wf: SingleItemWorkflow | null;
  view: CanvasView;
  selectedNodeId: WorkflowNodeId | null;
  onSelectNode: (id: WorkflowNodeId) => void;
  onChange: (patch: Partial<Pick<CanvasView, 'pan' | 'zoom' | 'nodePositions' | 'selectedNodeId'>>) => void;
  onRunNode?: (id: WorkflowNodeId) => void;
  handleRef?: React.MutableRefObject<FlowCanvasHandle | null>;
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [panning, setPanning] = useState(false);
  const panStart = useRef<{ mouse: Point; pan: Point } | null>(null);
  const dragNode = useRef<{ id: WorkflowNodeId; offset: Point; moved: boolean } | null>(null);
  const [, force] = useState(0);

  const summaries = useMemo(() => deriveNodeSummaries(wf), [wf]);
  const summaryById = useMemo(
    () => new Map(summaries.map((s) => [s.id, s])),
    [summaries],
  );

  const posOf = useCallback(
    (id: WorkflowNodeId): Point => view.nodePositions[id] ?? NODE_DEFAULT_POSITIONS[id],
    [view.nodePositions],
  );

  const setZoom = useCallback(
    (next: number, anchor?: Point) => {
      const zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);
      let pan = view.pan;
      if (anchor) {
        // 以指针为锚点缩放：保持锚点下的世界坐标不动
        const wx = (anchor.x - view.pan.x) / view.zoom;
        const wy = (anchor.y - view.pan.y) / view.zoom;
        pan = { x: anchor.x - wx * zoom, y: anchor.y - wy * zoom };
      }
      onChange({ zoom, pan });
    },
    [onChange, view.pan, view.zoom],
  );

  const fitAll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const positions = summaries.map((s) => posOf(s.id));
    const minX = Math.min(...positions.map((p) => p.x)) - 32;
    const minY = Math.min(...positions.map((p) => p.y)) - 32;
    const maxX = Math.max(...positions.map((p) => p.x + NODE_W)) + 32;
    const maxY = Math.max(...positions.map((p) => p.y + NODE_H)) + 32;
    const zoom = clamp(
      Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY)),
      MIN_ZOOM,
      1,
    );
    onChange({
      zoom,
      pan: {
        x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom,
        y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom,
      },
    });
  }, [onChange, posOf, summaries]);

  useEffect(() => {
    if (handleRef) {
      handleRef.current = {
        zoomIn: () => setZoom(view.zoom * 1.15, centerAnchor()),
        zoomOut: () => setZoom(view.zoom / 1.15, centerAnchor()),
        resetZoom: () => onChange({ zoom: 1 }),
        fitAll,
      };
    }
    function centerAnchor(): Point | undefined {
      const el = viewportRef.current;
      if (!el) return undefined;
      const r = el.getBoundingClientRect();
      return { x: r.width / 2, y: r.height / 2 };
    }
  }, [fitAll, handleRef, onChange, setZoom, view.zoom]);

  // 首次进入且没有保存过视图时，自动适应全部节点
  const didInit = useRef(false);
  useLayoutEffect(() => {
    if (didInit.current) return;
    const hasSaved =
      view.nodePositions && Object.keys(view.nodePositions).length > 0;
    if (!hasSaved && viewportRef.current) {
      didInit.current = true;
      fitAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(view.zoom * factor, anchor);
  };

  const localPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onViewportMouseDown = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('canvas-world')) return;
    setPanning(true);
    panStart.current = { mouse: localPoint(e), pan: { ...view.pan } };
    // 点击空白取消选择
    onChange({ selectedNodeId: null });
  };

  const onNodeMouseDown = (e: React.MouseEvent, id: WorkflowNodeId) => {
    e.stopPropagation();
    onSelectNode(id);
    const p = posOf(id);
    const local = localPoint(e);
    dragNode.current = {
      id,
      offset: { x: (local.x - view.pan.x) / view.zoom - p.x, y: (local.y - view.pan.y) / view.zoom - p.y },
      moved: false,
    };
  };

  useEffect(() => {
    function move(e: MouseEvent) {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (panning && panStart.current) {
        onChange({
          pan: {
            x: panStart.current.pan.x + (local.x - panStart.current.mouse.x),
            y: panStart.current.pan.y + (local.y - panStart.current.mouse.y),
          },
        });
      } else if (dragNode.current) {
        const d = dragNode.current;
        const x = clamp((local.x - view.pan.x) / view.zoom - d.offset.x, -80, WORLD_W - 80);
        const y = clamp((local.y - view.pan.y) / view.zoom - d.offset.y, -40, WORLD_H - 60);
        const cur = posOf(d.id);
        if (Math.abs(cur.x - x) > 1 || Math.abs(cur.y - y) > 1) {
          d.moved = true;
          onChange({
            nodePositions: { ...view.nodePositions, [d.id]: { x: Math.round(x), y: Math.round(y) } },
          });
        }
      }
    }
    function up() {
      setPanning(false);
      panStart.current = null;
      dragNode.current = null;
      force((n) => n + 1);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [onChange, panning, posOf, view.nodePositions, view.pan, view.zoom]);

  // 边的锚点：右中 → 左中；失败边走 resultAuditor(右列上) → targetedRepair(同列下)
  function edgeAnchors(fromId: WorkflowNodeId, toId: WorkflowNodeId): { from: Point; to: Point } {
    const a = posOf(fromId);
    const b = posOf(toId);
    const sameColumn = Math.abs(a.x - b.x) < 40;
    if (sameColumn) {
      return {
        from: { x: a.x + NODE_W / 2, y: a.y + NODE_H },
        to: { x: b.x + NODE_W / 2, y: b.y },
      };
    }
    return {
      from: { x: a.x + NODE_W, y: a.y + NODE_H / 2 },
      to: { x: b.x, y: b.y + NODE_H / 2 },
    };
  }

  const upstreamDone = (id: WorkflowNodeId): boolean => {
    const s = summaryById.get(id);
    return !!s && (s.state === 'done' || s.state === 'warning' || s.state === 'review');
  };

  return (
    <div
      ref={viewportRef}
      className={`canvas-viewport ${panning ? 'panning' : ''}`}
      onWheel={onWheel}
      onMouseDown={onViewportMouseDown}
      data-testid="flow-canvas"
      role="application"
      aria-label="工作流画布：拖动空白处平移，滚轮缩放，拖动节点调整位置"
    >
      <div
        className="canvas-world"
        style={{
          width: WORLD_W,
          height: WORLD_H,
          transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`,
        }}
      >
        <svg className="canvas-svg-layer" viewBox={`0 0 ${WORLD_W} ${WORLD_H}`} preserveAspectRatio="none">
          <defs>
            <marker id="arrow-default" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="edge-arrow" />
            </marker>
            <marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="edge-arrow active" />
            </marker>
            <marker id="arrow-conditional" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="edge-arrow conditional" />
            </marker>
          </defs>
          {FIXED_EDGES.map((e) => {
            const { from, to } = edgeAnchors(e.from, e.to);
            const active = upstreamDone(e.from);
            const cls = `edge-path ${e.conditional ? 'conditional' : active ? 'active' : ''}`;
            const marker = `url(#arrow-${e.conditional ? 'conditional' : active ? 'active' : 'default'})`;
            return (
              <g key={`${e.from}-${e.to}`}>
                <path d={edgePath(from, to)} className={cls} markerEnd={marker} />
                {e.conditional && (
                  <text
                    x={(from.x + to.x) / 2}
                    y={(from.y + to.y) / 2 - 6}
                    className="edge-caption"
                    textAnchor="middle"
                  >
                    仅失败时
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {summaries.map((s) => {
          const p = posOf(s.id);
          const selected = selectedNodeId === s.id;
          return (
            <div
              key={s.id}
              className={`workflow-node ${s.state} ${selected ? 'selected' : ''}`}
              style={{ left: p.x, top: p.y, width: NODE_W }}
              onMouseDown={(e) => onNodeMouseDown(e, s.id)}
              onClick={(e) => {
                // 兜底：键盘/合成点击只派发 click 时也能选中（mousedown 已选中则幂等）
                e.stopPropagation();
                onSelectNode(s.id);
              }}
              data-testid={`node-${s.id}`}
              data-state={s.state}
            >
              <div className="node-head">
                <span className="node-title">{s.title}</span>
                <span className={`node-state-ico badge plain`} aria-hidden style={{ fontSize: 12 }}>
                  {NODE_STATE_ICON[s.state]}
                </span>
              </div>
              {s.lines.map((line, i) => (
                <div key={i} className="node-line" title={line}>
                  {line}
                </div>
              ))}
              {s.action && onRunNode && (
                <button
                  type="button"
                  className="btn sm"
                  style={{ alignSelf: 'flex-start', marginTop: 2 }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRunNode(s.id);
                  }}
                  data-testid={`node-action-${s.id}`}
                >
                  {s.action}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 小地图 */}
      <MiniMap summaries={summaries} posOf={posOf} />
    </div>
  );
};

function MiniMap({
  summaries,
  posOf,
}: {
  summaries: NodeSummary[];
  posOf: (id: WorkflowNodeId) => Point;
}) {
  const scaleX = 168 / WORLD_W;
  const scaleY = 84 / WORLD_H;
  return (
    <div className="minimap" aria-hidden>
      {summaries.map((s) => {
        const p = posOf(s.id);
        return (
          <div
            key={s.id}
            className={`mm-node ${s.state === 'running' || s.state === 'review' ? 'active' : ''}`}
            style={{
              left: p.x * scaleX,
              top: p.y * scaleY,
              width: NODE_W * scaleX,
              height: 10,
            }}
          />
        );
      })}
    </div>
  );
}
