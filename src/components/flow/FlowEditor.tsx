/**
 * 可编辑工作流画布（docs/12，SellerPic 式节点）。
 *
 * 坐标与连线（彻底修复拖动错位/缩放不对准）：
 * - 节点在 world 层（pan/zoom transform）；
 * - 连线在“屏幕空间覆盖 SVG”，每次渲染通过 getBoundingClientRect 实测端口中心，
 *   因此节点高度变化、拖动、缩放、平移都不会让连线与端口错位；
 * - 临时连线同样使用屏幕坐标。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canConnect } from '../../workflow/graph/validate';
import type { WorkflowGraph, NodeInstance } from '../../workflow/graph/types';
import type { CanvasView } from '../../data/canvasViewStore';
import type { Selection, ConnectResult } from '../../hooks/useWorkflowDraft';
import { NodeCard, PORT_DOM_ID } from './NodeCard';

export type Point = { x: number; y: number };

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const WORLD_W = 6000;
const WORLD_H = 4000;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

type PendingEdge = {
  fromNode: string;
  fromPort: string;
  start: Point; // 屏幕坐标
  cursor: Point; // 屏幕坐标
};

export function FlowEditor({
  graph,
  view,
  selection,
  onPatchView,
  onSelect,
  onTransientMove,
  onEndMove,
  onConnect,
  invalidNodeIds,
  warningNodeIds,
  onConfigChange,
  onRunNode,
}: {
  graph: WorkflowGraph;
  view: CanvasView;
  selection: Selection;
  onPatchView: (p: Partial<CanvasView>) => void;
  onSelect: (s: Selection) => void;
  onTransientMove: (id: string, pos: Point) => void;
  onEndMove: () => void;
  onConnect: (f: string, fp: string, t: string, tp: string) => ConnectResult;
  invalidNodeIds: Set<string>;
  warningNodeIds: Set<string>;
  onConfigChange: (id: string, key: string, value: unknown) => void;
  onRunNode?: (node: NodeInstance) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [panning, setPanning] = useState(false);
  const [pending, setPending] = useState<PendingEdge | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [hoverPort, setHoverPort] = useState<string | null>(null);
  const [spacePanning, setSpacePanning] = useState(false);
  const [, forceTick] = useState(0);

  const panStart = useRef<{ mouse: Point; pan: Point } | null>(null);
  const draggingRef = useRef<{ id: string; offset: Point; moved: boolean } | null>(null);
  const panningState = useRef(false);

  const localPoint = useCallback((clientX: number, clientY: number): Point => {
    const r = viewportRef.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }, []);

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const r = viewportRef.current!.getBoundingClientRect();
      return {
        x: (clientX - r.left - view.pan.x) / view.zoom,
        y: (clientY - r.top - view.pan.y) / view.zoom,
      };
    },
    [view.pan, view.zoom],
  );

  const setZoom = useCallback(
    (next: number, anchorClient?: { x: number; y: number }) => {
      const zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);
      if (!anchorClient || !viewportRef.current) {
        onPatchView({ zoom });
        return;
      }
      const r = viewportRef.current.getBoundingClientRect();
      const sx = anchorClient.x - r.left;
      const sy = anchorClient.y - r.top;
      const wx = (sx - view.pan.x) / view.zoom;
      const wy = (sy - view.pan.y) / view.zoom;
      onPatchView({ zoom, pan: { x: sx - wx * zoom, y: sy - wy * zoom } });
    },
    [onPatchView, view.pan, view.zoom],
  );

  const onWheel = (e: React.WheelEvent) => {
    setZoom(view.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), { x: e.clientX, y: e.clientY });
  };

  const latest = useRef({ view, onPatchView, onSelect, onTransientMove, onEndMove });
  latest.current = { view, onPatchView, onSelect, onTransientMove, onEndMove };
  const interaction = useRef({ panning: false, pending: null as PendingEdge | null });
  interaction.current.pending = pending;

  const beginPan = (e: React.MouseEvent | MouseEvent) => {
    const r = viewportRef.current!.getBoundingClientRect();
    setPanning(true);
    panStart.current = {
      mouse: { x: e.clientX - r.left, y: e.clientY - r.top },
      pan: { ...latest.current.view.pan },
    };
  };

  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset.bg !== 'true') return;
    onSelect(null);
    beginPan(e);
  };

  // 空格平移
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'SELECT');
      if (e.code === 'Space' && !typing) {
        setSpacePanning(true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpacePanning(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // 拖动/平移/拉线期间用 rAF 测量端口并重绘屏幕空间边
  useEffect(() => {
    function move(e: MouseEvent) {
      const vp = viewportRef.current;
      if (!vp) return;
      const r = vp.getBoundingClientRect();
      const local = { x: e.clientX - r.left, y: e.clientY - r.top };
      const { pan: curPan, zoom } = latest.current.view;

      if (draggingRef.current) {
        const world = { x: (local.x - curPan.x) / zoom, y: (local.y - curPan.y) / zoom };
        const nx = world.x - draggingRef.current.offset.x;
        const ny = world.y - draggingRef.current.offset.y;
        if (Math.abs(nx) > 0.5 || Math.abs(ny) > 0.5) draggingRef.current.moved = true;
        latest.current.onTransientMove(draggingRef.current.id, {
          x: clamp(nx, -1000, WORLD_W - 120),
          y: clamp(ny, -1000, WORLD_H - 80),
        });
        forceTick((t) => t + 1);
        return;
      }
      if (panningState.current && panStart.current) {
        latest.current.onPatchView({
          pan: {
            x: panStart.current.pan.x + (local.x - panStart.current.mouse.x),
            y: panStart.current.pan.y + (local.y - panStart.current.mouse.y),
          },
        });
        return;
      }
      if (interaction.current.pending) {
        setPending((p) => (p ? { ...p, cursor: local } : p));
      }
    }
    function up() {
      setPanning(false);
      panningState.current = false;
      panStart.current = null;
      if (draggingRef.current) {
        const moved = draggingRef.current.moved;
        draggingRef.current = null;
        if (moved) latest.current.onEndMove();
      }
      setPending(null);
      setHoverPort(null);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  // 同步 React panning 到 ref
  useEffect(() => {
    panningState.current = panning;
  }, [panning]);

  const startNodeDrag = (e: React.MouseEvent, id: string) => {
    if (e.button === 1 || spacePanning) {
      beginPan(e);
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, button, label, a, .nodrag, .if-images, .if-prompt, .if-row')) {
      onSelect({ kind: 'node', id });
      return;
    }
    e.stopPropagation();
    onSelect({ kind: 'node', id });
    const world = screenToWorld(e.clientX, e.clientY);
    const node = graph.nodes.find((n) => n.id === id)!;
    draggingRef.current = { id, offset: { x: world.x - node.position.x, y: world.y - node.position.y }, moved: false };
  };

  const startConnect = (e: React.MouseEvent, nodeId: string, portId: string) => {
    e.stopPropagation();
    const s = localPoint(e.clientX, e.clientY);
    setPending({ fromNode: nodeId, fromPort: portId, start: s, cursor: s });
    setConnectError(null);
  };

  const enterInputPort = (nodeId: string, portId: string) => {
    if (!pending) return;
    setHoverPort(`${nodeId}:${portId}`);
    setConnectError(canConnect(graph, pending.fromNode, pending.fromPort, nodeId, portId));
  };

  const finishConnect = (nodeId: string, portId: string) => {
    if (!pending) return;
    const result = onConnect(pending.fromNode, pending.fromPort, nodeId, portId);
    if (!result.ok) setConnectError(result.reason);
    setPending(null);
    setHoverPort(null);
  };

  // 端口中心（屏幕坐标，相对视口）——实测 DOM
  const portScreen = useCallback((nodeId: string, side: 'in' | 'out', portId: string): Point | null => {
    const vp = viewportRef.current;
    const el = document.getElementById(PORT_DOM_ID(nodeId, side, portId));
    if (!vp || !el) return null;
    const vr = vp.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return { x: er.left + er.width / 2 - vr.left, y: er.top + er.height / 2 - vr.top };
  }, []);

  // 节点拖动/缩放/平移/连线变化后重新测量
  useLayoutEffect(() => {
    forceTick((t) => t + 1);
  }, [graph, view.pan, view.zoom, selection]);

  const edgePath = (a: Point, b: Point) => {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    const dir = b.x >= a.x ? 1 : -1;
    return `M ${a.x} ${a.y} C ${a.x + dx * dir} ${a.y}, ${b.x - dx * dir} ${b.y}, ${b.x} ${b.y}`;
  };

  const selectedNodeId = selection?.kind === 'node' ? selection.id : null;
  const relatedEdges = new Set<string>();
  const relatedNodes = new Set<string>();
  if (selectedNodeId) {
    relatedNodes.add(selectedNodeId);
    graph.edges.forEach((e) => {
      if (e.from.node === selectedNodeId || e.to.node === selectedNodeId) {
        relatedEdges.add(e.id);
        relatedNodes.add(e.from.node);
        relatedNodes.add(e.to.node);
      }
    });
  }

  return (
    <div
      ref={viewportRef}
      className={`flow-viewport ${panning || spacePanning ? 'panning' : ''}`}
      onWheel={onWheel}
      onMouseDown={onBackgroundMouseDown}
      data-testid="flow-canvas"
      role="application"
      aria-label="可编辑工作流画布：拖动空白或空格平移，滚轮缩放，拖动节点，从端口拉线连接"
    >
      {/* 节点世界层 */}
      <div
        className="flow-world"
        data-bg="true"
        style={{
          width: WORLD_W,
          height: WORLD_H,
          transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`,
        }}
      >
        {graph.nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            graph={graph}
            selected={selection?.kind === 'node' && selection.id === node.id}
            dimmed={!!selectedNodeId && !relatedNodes.has(node.id)}
            invalid={invalidNodeIds.has(node.id)}
            warning={warningNodeIds.has(node.id)}
            hoverPort={hoverPort}
            connectError={connectError}
            onNodeMouseDown={startNodeDrag}
            onSelect={onSelect}
            onPortMouseDown={startConnect}
            onPortEnter={enterInputPort}
            onPortLeave={() => setHoverPort(null)}
            onPortUp={finishConnect}
            onConfigChange={onConfigChange}
            onRunNode={onRunNode ?? undefined}
          />
        ))}
      </div>

      {/* 屏幕空间连线层（实测端口，不随缩放变形） */}
      <svg className="flow-edge-overlay" data-testid="edge-overlay">
        <defs>
          <marker id="fe-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#93a39c" />
          </marker>
          <marker id="fe-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#176b57" />
          </marker>
        </defs>
        {graph.edges.map((edge) => {
          const a = portScreen(edge.from.node, 'out', edge.from.port);
          const b = portScreen(edge.to.node, 'in', edge.to.port);
          if (!a || !b) return null;
          const isSelected = selection?.kind === 'edge' && selection.id === edge.id;
          const related = relatedEdges.has(edge.id);
          const dimmed = !!selectedNodeId && !related;
          return (
            <g key={edge.id} className={`edge-group ${isSelected ? 'edge-selected' : ''} ${dimmed ? 'edge-dimmed' : ''} ${related ? 'edge-related' : ''}`}>
              <path
                d={edgePath(a, b)}
                className="flow-edge-hit"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onSelect({ kind: 'edge', id: edge.id });
                }}
              />
              <path d={edgePath(a, b)} className="flow-edge" markerEnd={isSelected || related ? 'url(#fe-arrow-active)' : 'url(#fe-arrow)'} />
            </g>
          );
        })}
        {pending && (
          <path d={edgePath(pending.start, pending.cursor)} className={`flow-edge pending ${connectError ? 'invalid' : 'valid'}`} />
        )}
      </svg>

      {connectError && pending && (
        <div className="connect-error" data-testid="connect-error" style={{ left: pending.cursor.x + 12, top: pending.cursor.y + 12, position: 'absolute' }}>
          {connectError}
        </div>
      )}
    </div>
  );
}
