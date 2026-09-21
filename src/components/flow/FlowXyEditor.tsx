/**
 * React Flow 画布适配层。
 * 业务图模型仍是 WorkflowGraph；交互（拖拽/缩放/连线命中）交给 @xyflow/react，
 * 节点内表单用 nodrag，避免上传/输入被画布拖拽抢走。
 *
 * 同步策略：按 id 合并更新，避免 selection/config 变化时整树 remount 导致文件选择器失效。
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnMoveEnd,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { canConnect } from '../../workflow/graph/validate';
import { getNodeDefinition } from '../../workflow/graph/registry';
import type { WorkflowGraph, NodeInstance } from '../../workflow/graph/types';
import type { CanvasView } from '../../data/canvasViewStore';
import type { Selection, ConnectResult } from '../../hooks/useWorkflowDraft';
import { NodeCard } from './NodeCard';

type FlowNodeData = {
  graph: WorkflowGraph;
  instance: NodeInstance;
  selected: boolean;
  invalid: boolean;
  warning: boolean;
  running?: boolean;
  graphRunning?: boolean;
  onConfigChange: (id: string, key: string, value: unknown) => void;
  onRunNode?: (node: NodeInstance) => void;
  onSelectNode?: (id: string) => void;
};

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('button, input, textarea, select, label, a, .if-upload');
}

function WorkflowFlowNode({ data, selected }: NodeProps & { data: FlowNodeData }) {
  const def = getNodeDefinition(data.instance.type);
  if (!def) return null;
  return (
    <div className={`xy-node-shell nopan ${selected || data.selected ? 'selected' : ''} ${data.invalid ? 'has-error' : ''}`}>
      {def.inputs.map((p, i) => (
        <Handle
          key={`in-${p.portId}`}
          id={p.portId}
          type="target"
          position={Position.Left}
          className="xy-handle"
          style={{ top: `${((i + 1) / (def.inputs.length + 1)) * 100}%` }}
          title={`${p.label} · ${p.dataType}`}
        />
      ))}
      <NodeCard
        node={data.instance}
        graph={data.graph}
        selected={selected || data.selected}
        dimmed={false}
        invalid={data.invalid}
        warning={data.warning}
        hoverPort={null}
        connectError={null}
        mode="flow"
        running={data.running || data.graphRunning}
        onNodeMouseDown={() => {}}
        onSelect={(s) => {
          if (s) data.onSelectNode?.(s.id);
        }}
        onPortMouseDown={() => {}}
        onPortEnter={() => {}}
        onPortLeave={() => {}}
        onPortUp={() => {}}
        onConfigChange={data.onConfigChange}
        onRunNode={data.onRunNode}
      />
      {def.outputs.map((p, i) => (
        <Handle
          key={`out-${p.portId}`}
          id={p.portId}
          type="source"
          position={Position.Right}
          className="xy-handle"
          style={{ top: `${((i + 1) / (def.outputs.length + 1)) * 100}%` }}
          title={`${p.label} · ${p.dataType}`}
        />
      ))}
    </div>
  );
}

const nodeTypes = { workflow: WorkflowFlowNode };

function toFlowEdges(
  graph: WorkflowGraph,
  selection: Selection,
  run: { graphRunning: boolean; runningNodeId: string | null; completedNodeIds: string[] },
): Edge[] {
  const completed = new Set(run.completedNodeIds);
  return graph.edges.map((e) => {
    const selected = selection?.kind === 'edge' && selection.id === e.id;
    let cls = 'xy-edge';
    let animated = false;
    if (run.graphRunning) {
      const fromDone = completed.has(e.from.node) || e.from.node === run.runningNodeId;
      const toActive = e.to.node === run.runningNodeId;
      const toDone = completed.has(e.to.node);
      if (toActive || (e.from.node === run.runningNodeId && !toDone)) {
        cls += ' xy-edge-active';
        animated = true;
      } else if (fromDone && toDone) {
        cls += ' xy-edge-done';
      } else {
        cls += ' xy-edge-pending';
      }
    } else if (selected) {
      cls += ' xy-edge-selected';
    }
    return {
      id: e.id,
      source: e.from.node,
      sourceHandle: e.from.port,
      target: e.to.node,
      targetHandle: e.to.port,
      selected,
      animated,
      className: cls,
    };
  });
}

function mergeFlowNodes(
  prev: Node<FlowNodeData>[],
  graph: WorkflowGraph,
  selection: Selection,
  invalidNodeIds: Set<string>,
  warningNodeIds: Set<string>,
  runningNodeId: string | null,
  graphRunning: boolean,
  onConfigChange: (id: string, key: string, value: unknown) => void,
  onRunNode: ((node: NodeInstance) => void) | undefined,
  onSelectNode: (id: string) => void,
): Node<FlowNodeData>[] {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  return graph.nodes.map((n) => {
    const existing = prevById.get(n.id);
    const selected = selection?.kind === 'node' && selection.id === n.id;
    const data: FlowNodeData = {
      graph,
      instance: n,
      selected,
      invalid: invalidNodeIds.has(n.id),
      warning: warningNodeIds.has(n.id),
      running: runningNodeId === n.id,
      graphRunning,
      onConfigChange,
      onRunNode,
      onSelectNode,
    };
    if (existing) {
      return {
        ...existing,
        position: n.position,
        selected,
        data,
        dragHandle: '.fn-head',
      };
    }
    return {
      id: n.id,
      type: 'workflow',
      position: n.position,
      data,
      selected,
      dragHandle: '.fn-head',
    };
  });
}

function FlowXyInner({
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
  runningNodeId = null,
  graphRunning = false,
  completedNodeIds = [],
  fitRequest = 0,
  showMiniMap = false,
}: {
  graph: WorkflowGraph;
  view: CanvasView;
  selection: Selection;
  onPatchView: (p: Partial<CanvasView>) => void;
  onSelect: (s: Selection) => void;
  onTransientMove: (id: string, pos: { x: number; y: number }) => void;
  onEndMove: () => void;
  onConnect: (f: string, fp: string, t: string, tp: string) => ConnectResult;
  invalidNodeIds: Set<string>;
  warningNodeIds: Set<string>;
  onConfigChange: (id: string, key: string, value: unknown) => void;
  onRunNode?: (node: NodeInstance) => void;
  runningNodeId?: string | null;
  graphRunning?: boolean;
  completedNodeIds?: string[];
  fitRequest?: number;
  showMiniMap?: boolean;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node<FlowNodeData>[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const { setViewport, fitView, getViewport } = useReactFlow();
  const applyingExternalView = useRef(false);
  const lastFitRequest = useRef(0);
  const callbacksRef = useRef({ onConfigChange, onRunNode, onSelect });
  callbacksRef.current = { onConfigChange, onRunNode, onSelect };

  useEffect(() => {
    const { onConfigChange: cfg, onRunNode: run, onSelect: sel } = callbacksRef.current;
    setNodes((prev) =>
      mergeFlowNodes(
        prev,
        graph,
        selection,
        invalidNodeIds,
        warningNodeIds,
        runningNodeId,
        graphRunning,
        cfg,
        run,
        (id) => sel({ kind: 'node', id }),
      ),
    );
    setEdges(toFlowEdges(graph, selection, { graphRunning, runningNodeId, completedNodeIds }));
  }, [graph, selection, invalidNodeIds, warningNodeIds, runningNodeId, graphRunning, completedNodeIds, setNodes, setEdges]);

  useEffect(() => {
    applyingExternalView.current = true;
    setViewport({ x: view.pan.x, y: view.pan.y, zoom: view.zoom }, { duration: 0 });
    const t = window.setTimeout(() => {
      applyingExternalView.current = false;
    }, 0);
    return () => window.clearTimeout(t);
  }, [view.pan.x, view.pan.y, view.zoom, setViewport]);

  useEffect(() => {
    if (!fitRequest || fitRequest === lastFitRequest.current) return;
    lastFitRequest.current = fitRequest;
    applyingExternalView.current = true;
    void fitView({ padding: 0.18, duration: 200 }).then(() => {
      const vp = getViewport();
      onPatchView({ zoom: vp.zoom, pan: { x: vp.x, y: vp.y } });
      window.setTimeout(() => {
        applyingExternalView.current = false;
      }, 0);
    });
  }, [fitRequest, fitView, getViewport, onPatchView]);

  const onNodeDrag: OnNodeDrag = useCallback(
    (_e, node) => {
      onTransientMove(node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) });
    },
    [onTransientMove],
  );

  const onNodeDragStop = useCallback(() => {
    onEndMove();
  }, [onEndMove]);

  const handleConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      onConnect(c.source, c.sourceHandle, c.target, c.targetHandle);
    },
    [onConnect],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const source = 'source' in c ? c.source : null;
      const target = 'target' in c ? c.target : null;
      const sourceHandle = 'sourceHandle' in c ? c.sourceHandle : null;
      const targetHandle = 'targetHandle' in c ? c.targetHandle : null;
      if (!source || !target || !sourceHandle || !targetHandle) return false;
      return canConnect(graph, source, sourceHandle, target, targetHandle) === null;
    },
    [graph],
  );

  const onMoveEnd: OnMoveEnd = useCallback(
    (_e, viewport) => {
      if (applyingExternalView.current) return;
      onPatchView({ zoom: viewport.zoom, pan: { x: viewport.x, y: viewport.y } });
    },
    [onPatchView],
  );

  return (
    <div className="flow-viewport xy-flow-host" data-testid="flow-canvas" role="application" aria-label="可编辑工作流画布">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(e, node) => {
          if (isInteractiveTarget(e.target)) return;
          onSelect({ kind: 'node', id: node.id });
        }}
        onEdgeClick={(_e, edge) => onSelect({ kind: 'edge', id: edge.id })}
        onPaneClick={() => onSelect(null)}
        onMoveEnd={onMoveEnd}
        defaultViewport={{ x: view.pan.x, y: view.pan.y, zoom: view.zoom }}
        minZoom={0.2}
        maxZoom={2.5}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#d0dad5" />
        {showMiniMap && (
          <MiniMap
            pannable
            zoomable
            ariaLabel="画布小地图"
            maskColor="rgba(247, 249, 248, 0.72)"
            nodeColor="#9aaba4"
          />
        )}
      </ReactFlow>
    </div>
  );
}

export function FlowXyEditor(props: {
  graph: WorkflowGraph;
  view: CanvasView;
  selection: Selection;
  onPatchView: (p: Partial<CanvasView>) => void;
  onSelect: (s: Selection) => void;
  onTransientMove: (id: string, pos: { x: number; y: number }) => void;
  onEndMove: () => void;
  onConnect: (f: string, fp: string, t: string, tp: string) => ConnectResult;
  invalidNodeIds: Set<string>;
  warningNodeIds: Set<string>;
  onConfigChange: (id: string, key: string, value: unknown) => void;
  onRunNode?: (node: NodeInstance) => void;
  runningNodeId?: string | null;
  graphRunning?: boolean;
  completedNodeIds?: string[];
  fitRequest?: number;
  showMiniMap?: boolean;
}) {
  return (
    <ReactFlowProvider>
      <FlowXyInner {...props} />
    </ReactFlowProvider>
  );
}
