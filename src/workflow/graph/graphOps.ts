/**
 * 工作流图编辑操作（docs/12 §4-6）。
 * 全部为纯函数：输入旧图，输出新图；不触碰 DOM/执行器。
 */
import { getNodeDefinition, requireNodeDefinition } from './registry';
import { canConnect } from './validate';
import type { Edge, NodeInstance, WorkflowGraph } from './types';

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** 测试中需要稳定 id 时可重置 */
export function resetIdCounter(): void {
  counter = 0;
}

export function addNode(
  graph: WorkflowGraph,
  type: string,
  position: { x: number; y: number },
  configOverrides?: Record<string, unknown>,
): WorkflowGraph {
  const def = requireNodeDefinition(type);
  if (def.maxInstances) {
    const count = graph.nodes.filter((n) => n.type === type).length;
    if (count >= def.maxInstances) {
      throw new Error(`“${def.title}”每条工作流最多 ${def.maxInstances} 个`);
    }
  }
  const config = def.configFields.reduce<Record<string, unknown>>((acc, f) => {
    acc[f.key] = f.defaultValue;
    return acc;
  }, {});
  if (configOverrides) {
    for (const [key, value] of Object.entries(configOverrides)) {
      if (key in config) config[key] = value;
    }
  }
  const node: NodeInstance = {
    id: uid('n'),
    type,
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    config,
  };
  return { nodes: [...graph.nodes, node], edges: graph.edges };
}

/** 删除节点：同时删除其全部连线（docs/12：删除节点必然带走相连边） */
export function removeNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return graph;
  const def = getNodeDefinition(node.type);
  if (def && !def.removable) {
    throw new Error(`“${def.title}”是必需节点，不能删除`);
  }
  return {
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    edges: graph.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId),
  };
}

/**
 * 复制节点：深拷贝配置，生成新 id 并偏移 24px；不复制任何连线（避免非法接线）。
 */
export function duplicateNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  const src = graph.nodes.find((n) => n.id === nodeId);
  if (!src) return graph;
  const def = requireNodeDefinition(src.type);
  if (def.maxInstances) {
    const count = graph.nodes.filter((n) => n.type === src.type).length;
    if (count >= def.maxInstances) {
      throw new Error(`“${def.title}”每条工作流最多 ${def.maxInstances} 个`);
    }
  }
  const copy: NodeInstance = {
    id: uid('n'),
    type: src.type,
    position: { x: src.position.x + 24, y: src.position.y + 24 },
    config: JSON.parse(JSON.stringify(src.config)),
  };
  return { nodes: [...graph.nodes, copy], edges: graph.edges };
}

export function moveNode(
  graph: WorkflowGraph,
  nodeId: string,
  position: { x: number; y: number },
): WorkflowGraph {
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const x = Math.round(position.x);
    const y = Math.round(position.y);
    if (n.position.x === x && n.position.y === y) return n;
    changed = true;
    return { ...n, position: { x, y } };
  });
  return changed ? { nodes, edges: graph.edges } : graph;
}

export function updateNodeConfig(
  graph: WorkflowGraph,
  nodeId: string,
  key: string,
  value: unknown,
): WorkflowGraph {
  return updateNodeConfigs(graph, nodeId, { [key]: value });
}

/** 一次写入多个配置键，只产生一条历史记录 */
export function updateNodeConfigs(
  graph: WorkflowGraph,
  nodeId: string,
  patch: Record<string, unknown>,
): WorkflowGraph {
  const nodes = graph.nodes.map((n) =>
    n.id === nodeId ? { ...n, config: { ...n.config, ...patch } } : n,
  );
  return { nodes, edges: graph.edges };
}

/** 尝试连接；非法时抛错并带可展示原因（调用方应先用 canConnect 预校验） */
export function connect(
  graph: WorkflowGraph,
  fromNode: string,
  fromPort: string,
  toNode: string,
  toPort: string,
): WorkflowGraph {
  const reason = canConnect(graph, fromNode, fromPort, toNode, toPort);
  if (reason) throw new Error(reason);
  const edge: Edge = {
    id: uid('e'),
    from: { node: fromNode, port: fromPort },
    to: { node: toNode, port: toPort },
  };
  return { nodes: graph.nodes, edges: [...graph.edges, edge] };
}

export function removeEdge(graph: WorkflowGraph, edgeId: string): WorkflowGraph {
  return { nodes: graph.nodes, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

/* ------------------------- 自动布局（Kahn 分层） ------------------------- */

const NODE_W = 280;
const NODE_H = 150;
const COL_GAP = 72;
const ROW_GAP = 144;

/**
 * 一键整理：按拓扑深度分列（source 在最左，sink 在最右），
 * 同列节点纵向均匀排布。这是辅助整理，不强制、不改变连接关系。
 */
export function autoLayout(graph: WorkflowGraph): WorkflowGraph {
  const indegree = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) {
    indegree.set(e.to.node, (indegree.get(e.to.node) ?? 0) + 1);
  }
  const layer = new Map<string, number>();
  const remaining = new Set(graph.nodes.map((n) => n.id));
  // 反复把入度为 0 的节点分层（在剩余子图中）
  let depth = 0;
  const layerMembers: string[][] = [];
  while (remaining.size) {
    const current = [...remaining].filter((id) =>
      graph.edges
        .filter((e) => e.to.node === id && remaining.has(e.from.node))
        .every((e) => layer.has(e.from.node)),
    );
    const batch = current.length ? current : [...remaining];
    layerMembers.push(batch);
    for (const id of batch) {
      layer.set(id, depth);
      remaining.delete(id);
    }
    depth += 1;
  }

  const positioned = graph.nodes.map((n) => {
    const col = layer.get(n.id) ?? 0;
    const sameCol = layerMembers[col];
    const row = sameCol.indexOf(n.id);
    return {
      ...n,
      position: {
        x: 48 + col * (NODE_W + COL_GAP),
        y: 64 + row * ROW_GAP,
      },
    };
  });

  return { nodes: positioned, edges: graph.edges };
}

/** 计算“适应全部节点”所需的视口平移与缩放（供 UI 视口使用） */
export function fitBounds(
  graph: WorkflowGraph,
  viewport: { width: number; height: number },
  margin = 48,
): { pan: { x: number; y: number }; zoom: number } {
  if (graph.nodes.length === 0 || viewport.width === 0) {
    return { pan: { x: 0, y: 0 }, zoom: 1 };
  }
  const xs = graph.nodes.map((n) => n.position.x);
  const ys = graph.nodes.map((n) => n.position.y);
  const minX = Math.min(...xs) - margin;
  const minY = Math.min(...ys) - margin;
  const maxX = Math.max(...xs.map((x) => x + NODE_W)) + margin;
  const maxY = Math.max(...ys.map((y) => y + NODE_H)) + margin;
  const w = maxX - minX;
  const h = maxY - minY;
  const zoom = Math.min(viewport.width / w, viewport.height / h, 1.2);
  return {
    zoom,
    pan: {
      x: (viewport.width - w * zoom) / 2 - minX * zoom,
      y: (viewport.height - h * zoom) / 2 - minY * zoom,
    },
  };
}

export const LAYOUT_NODE_W = NODE_W;
export const LAYOUT_NODE_H = NODE_H;
