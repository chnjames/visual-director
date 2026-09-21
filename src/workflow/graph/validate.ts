/**
 * 工作流图校验（docs/15 §5）。纯函数，不依赖 UI。
 * error 阻断发布/运行；warning 需知情；hint 仅建议。
 */
import { findPortDef, getNodeDefinition, isPortCompatible } from './registry';
import type {
  Edge,
  GraphIssue,
  GraphValidationResult,
  NodeInstance,
  PortDataType,
  WorkflowGraph,
} from './types';

function err(code: string, message: string, ref?: { nodeId?: string; edgeId?: string }): GraphIssue {
  return { level: 'error', code, message, ...ref };
}
function warn(code: string, message: string, ref?: { nodeId?: string }): GraphIssue {
  return { level: 'warning', code, message, ...ref };
}
function hint(code: string, message: string, ref?: { nodeId?: string }): GraphIssue {
  return { level: 'hint', code, message, ...ref };
}

export function validateGraph(graph: WorkflowGraph): GraphValidationResult {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const hints: GraphIssue[] = [];
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // 1. 节点类型合法 & 实例数限制
  for (const node of graph.nodes) {
    const def = getNodeDefinition(node.type);
    if (!def) {
      errors.push(err('E_UNKNOWN_NODE_TYPE', `存在未知节点类型“${node.type}”，请删除后重试`, { nodeId: node.id }));
      continue;
    }
    const count = graph.nodes.filter((x) => x.type === node.type).length;
    if (def.maxInstances && count > def.maxInstances) {
      errors.push(
        err('E_REPAIR_LIMIT', `“${def.title}”每条工作流最多 ${def.maxInstances} 个，请删除多余节点`, { nodeId: node.id }),
      );
    }
  }

  // 2. 边引用存在 & 端口存在 & 类型兼容 & 无自连
  const inEdges = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    const a = nodeMap.get(edge.from.node);
    const b = nodeMap.get(edge.to.node);
    if (!a || !b) {
      errors.push(err('E_DANGLING_EDGE', '存在引用了已删除节点的连线，请删除该连线', { edgeId: edge.id }));
      continue;
    }
    if (edge.from.node === edge.to.node) {
      errors.push(err('E_CYCLE_DETECTED', '节点不能连接到自身，工作流不允许循环', { edgeId: edge.id }));
      continue;
    }
    const defA = getNodeDefinition(a.type);
    const defB = getNodeDefinition(b.type);
    if (!defA || !defB) continue;
    const outPort = findPortDef(defA, 'out', edge.from.port);
    const inPort = findPortDef(defB, 'in', edge.to.port);
    if (!outPort || !inPort) {
      errors.push(err('E_DANGLING_PORT', '连线引用了不存在的端口，请重新连接', { edgeId: edge.id }));
      continue;
    }
    if (!isPortCompatible(outPort.dataType as PortDataType, inPort.dataType as PortDataType)) {
      errors.push(
        err(
          'E_PORT_TYPE_MISMATCH',
          `“${defA.title}”的${outPort.label}不能连到“${defB.title}”的${inPort.label}（数据类型不兼容）`,
          { edgeId: edge.id },
        ),
      );
    }
    const list = inEdges.get(`${edge.to.node}:${edge.to.port}`) ?? [];
    list.push(edge);
    inEdges.set(`${edge.to.node}:${edge.to.port}`, list);
  }

  // 3. 单源入端口唯一
  for (const [key, list] of inEdges) {
    if (list.length <= 1) continue;
    const [nodeId, portId] = key.split(':');
    const node = nodeMap.get(nodeId);
    const def = node && getNodeDefinition(node.type);
    const port = def && findPortDef(def, 'in', portId);
    if (port?.multi) continue;
    errors.push(
      err('E_INPUT_MULTI_SOURCE', `“${def?.title ?? nodeId}”的${port?.label ?? portId}只能接一条输入`, {
        edgeId: list[list.length - 1].id,
        nodeId,
      }),
    );
  }

  // 4. 必填入端口已连接
  for (const node of graph.nodes) {
    const def = getNodeDefinition(node.type);
    if (!def) continue;
    for (const port of def.inputs) {
      if (!port.required) continue;
      const has = graph.edges.some((e) => e.to.node === node.id && e.to.port === port.portId);
      if (!has) {
        errors.push(err('E_UNREACHABLE_INPUT', `“${def.title}”缺少必需输入：${port.label}`, { nodeId: node.id }));
      }
    }
  }

  // 5. 无环检测（DFS 三色），返回构成环的边
  const cycle = detectCycle(graph);
  if (cycle) {
    errors.push(err('E_CYCLE_DETECTED', '工作流包含循环连接；定向修复的重生已由修复节点表达，不能手动成环', { edgeId: cycle }));
  }

  // 6. 可达性：未接到验收路径的输入不再阻断发布
  const sources = graph.nodes.filter((n) => getNodeDefinition(n.type)?.kind === 'source');
  const sinks = graph.nodes.filter((n) => {
    const def = getNodeDefinition(n.type);
    return def?.kind === 'sink' || n.type === 'auditExport';
  });
  const reachableToSink = new Set<string>();
  const reachableFromSource = new Set<string>();
  for (const s of sources) walkForward(s.id, graph, reachableToSink, new Set(sinks.map((x) => x.id)));
  for (const s of sinks) walkBackward(s.id, graph, reachableFromSource, new Set(sources.map((x) => x.id)));

  for (const s of sources) {
    if (!canReachAny(s.id, graph, new Set(sinks.map((x) => x.id)))) {
      const touched = graph.edges.some((e) => e.from.node === s.id || e.to.node === s.id);
      if (touched) {
        const title = getNodeDefinition(s.type)?.title ?? s.type;
        warnings.push(
          warn(
            'W_SOURCE_WITHOUT_PATH',
            `“${title}”已连线但还到不了验收/导出节点，运行时可能用不上这些素材`,
            { nodeId: s.id },
          ),
        );
      }
    }
  }
  for (const s of sinks) {
    if (sources.length > 0 && !canReachAnyReverse(s.id, graph, new Set(sources.map((x) => x.id)))) {
      const title = getNodeDefinition(s.type)?.title ?? s.type;
      warnings.push(
        warn('W_UNREACHABLE_SINK', `“${title}”没有连到任何素材输入，工作流可能产不出终稿`, { nodeId: s.id }),
      );
    }
  }
  void reachableToSink;
  void reachableFromSource;

  // 7. 闸门语义：未确认配方不能到达 promptCompiler
  const compiler = graph.nodes.find((n) => n.type === 'promptCompiler');
  if (compiler) {
    const recipeInto = graph.edges.filter((e) => e.to.node === compiler.id && e.to.port === 'recipe');
    for (const edge of recipeInto) {
      const from = nodeMap.get(edge.from.node);
      if (from && from.type !== 'recipeConfirmGate') {
        errors.push(
          err(
            'E_UNCONFIRMED_RECIPE_TO_COMPILER',
            'Prompt 编译只接受“已确认配方”，请先经过“视觉配方确认”闸门',
            { edgeId: edge.id, nodeId: compiler.id },
          ),
        );
      }
    }
  }

  // 8. 同一数据既走闸门又绕过闸门汇入下游
  detectGateBypass(graph, errors);

  // 9. 警告（对齐出厂四节点 + 完整节点库，避免旧节点名误报）
  const hasIdentityGate = graph.nodes.some((n) => n.type === 'identityConfirmGate');
  const hasProductPath = graph.nodes.some(
    (n) => n.type === 'productInput' || n.type === 'batchProductInput' || n.type === 'identityExtractor',
  );
  if (hasProductPath && !hasIdentityGate) {
    warnings.push(warn('W_NO_IDENTITY_CONSTRAINTS', '图中有商品输入但没有身份确认闸门，生成将缺少身份硬约束（风险由你承担）'));
  }
  const hasAudit = graph.nodes.some((n) => n.type === 'resultAuditor' || n.type === 'auditExport');
  const hasAdvancedGenerator = graph.nodes.some((n) => n.type === 'sceneGenerator');
  const hasInlineMaterialInput = graph.nodes.some((n) => n.type === 'sceneGenerate');
  if (hasAdvancedGenerator && !hasAudit) {
    warnings.push(warn('W_AUDIT_SKIPPED', '图中有生成节点但没有验收节点，生成后不会自动四维验收'));
  }
  if (hasAudit && !graph.nodes.some((n) => n.type === 'targetedRepair')) {
    hints.push(hint('H_NO_REPAIR', '图中没有定向修复节点，验收失败即终态'));
  }
  if (sources.length === 0 && !hasInlineMaterialInput) {
    warnings.push(warn('W_NO_SOURCE', '图中没有任何素材输入节点'));
  }
  if (sinks.length === 0) {
    warnings.push(warn('W_NO_SINK', '图中没有验收/导出或结果定稿节点，无法形成终稿'));
  }

  // 10. 提示：孤立节点
  for (const node of graph.nodes) {
    const touched = graph.edges.some((e) => e.from.node === node.id || e.to.node === node.id);
    if (!touched) {
      const def = getNodeDefinition(node.type);
      hints.push(hint('H_ISOLATED_NODE', `“${def?.title ?? node.type}”尚未连接任何连线`, { nodeId: node.id }));
    }
  }

  const isAcyclic = !cycle;
  return {
    errors,
    warnings,
    hints,
    isAcyclic,
    canPublish: errors.length === 0,
  };
}

/** DFS 三色：返回环上的一条边 id（用于高亮），无环返回 null */
export function detectCycle(graph: WorkflowGraph): string | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(graph.nodes.map((n) => [n.id, WHITE]));
  let cycleEdge: string | null = null;

  const adj = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    const list = adj.get(e.from.node) ?? [];
    list.push(e);
    adj.set(e.from.node, list);
  }

  function visit(nodeId: string): boolean {
    color.set(nodeId, GRAY);
    for (const edge of adj.get(nodeId) ?? []) {
      const target = edge.to.node;
      const c = color.get(target);
      if (c === GRAY) {
        cycleEdge = edge.id;
        return true;
      }
      if (c === WHITE && visit(target)) return true;
    }
    color.set(nodeId, BLACK);
    return false;
  }

  for (const n of graph.nodes) {
    if (color.get(n.id) === WHITE && visit(n.id)) return cycleEdge;
  }
  return null;
}

/** 从 start 正向遍历，把能到达 targets 集合的节点加入 out */
function walkForward(start: string, graph: WorkflowGraph, out: Set<string>, targets: Set<string>): void {
  const stack = [start];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (targets.has(id)) out.add(id);
    for (const e of graph.edges.filter((x) => x.from.node === id)) stack.push(e.to.node);
  }
}
function walkBackward(start: string, graph: WorkflowGraph, out: Set<string>, targets: Set<string>): void {
  const stack = [start];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (targets.has(id)) out.add(id);
    for (const e of graph.edges.filter((x) => x.to.node === id)) stack.push(e.from.node);
  }
}

function canReachAny(start: string, graph: WorkflowGraph, targets: Set<string>): boolean {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (targets.has(id)) return true;
    for (const e of graph.edges.filter((x) => x.from.node === id)) {
      if (!seen.has(e.to.node)) {
        seen.add(e.to.node);
        stack.push(e.to.node);
      }
    }
  }
  return false;
}
function canReachAnyReverse(start: string, graph: WorkflowGraph, targets: Set<string>): boolean {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (targets.has(id)) return true;
    for (const e of graph.edges.filter((x) => x.to.node === id)) {
      if (!seen.has(e.from.node)) {
        seen.add(e.from.node);
        stack.push(e.from.node);
      }
    }
  }
  return false;
}

/**
 * 闸门绕过检测：若同一“受保护数据类型”既存在经闸门的路径，
 * 又存在一条不经闸门的路径汇入同一消费节点，判定为绕过。
 * 首版只对 recipe（recipeConfirmGate）做强校验。
 */
function detectGateBypass(graph: WorkflowGraph, errors: GraphIssue[]): void {
  const compiler = graph.nodes.find((n) => n.type === 'promptCompiler');
  if (!compiler) return;
  // compiler 的 recipe 入边来源已在第 7 步逐个校验；此处补充：
  // 任意节点把 UnconfirmedRecipe 直接送到非 extractor/gate 的下游
  for (const edge of graph.edges) {
    const from = graph.nodes.find((n) => n.id === edge.from.node);
    const to = graph.nodes.find((n) => n.id === edge.to.node);
    if (!from || !to) continue;
    const fromDef = getNodeDefinition(from.type);
    const toDef = getNodeDefinition(to.type);
    if (!fromDef || !toDef) continue;
    const port = findPortDef(fromDef, 'out', edge.from.port);
    // promptEditor 的入端口类型就是 UnconfirmedRecipe：简化主线在节点内编辑提示词，
    // 真正编译硬约束仍只允许 recipeConfirmGate → promptCompiler（见第 7 步）。
    if (
      port?.dataType === 'UnconfirmedRecipe' &&
      to.type !== 'recipeConfirmGate' &&
      to.type !== 'promptEditor'
    ) {
      errors.push(
        err(
          'E_GATE_BYPASS_AMBIGUOUS',
          '待确认配方只能送入“视觉配方确认”或“提示词编辑”，不能绕过确认直接用于其他节点',
          { edgeId: edge.id },
        ),
      );
    }
    if (port?.dataType === 'IdentityCandidates' && to.type !== 'identityConfirmGate') {
      errors.push(
        err(
          'E_GATE_BYPASS_AMBIGUOUS',
          '候选身份特征只能送入“商品身份确认”闸门，不能绕过确认直接用于生成',
          { edgeId: edge.id },
        ),
      );
    }
  }
}

/** 连接预校验：拖线时实时调用（docs/12 §5），返回 null 表示可连 */
export function canConnect(
  graph: WorkflowGraph,
  fromNode: string,
  fromPort: string,
  toNode: string,
  toPort: string,
): string | null {
  if (fromNode === toNode) return '节点不能连接自身';
  const a = graph.nodes.find((n) => n.id === fromNode);
  const b = graph.nodes.find((n) => n.id === toNode);
  if (!a || !b) return '节点不存在';
  const defA = getNodeDefinition(a.type);
  const defB = getNodeDefinition(b.type);
  if (!defA || !defB) return '节点类型未知';
  const outPort = findPortDef(defA, 'out', fromPort);
  const inPort = findPortDef(defB, 'in', toPort);
  if (!outPort || !inPort) return '端口不存在';
  if (!isPortCompatible(outPort.dataType as PortDataType, inPort.dataType as PortDataType)) {
    return `${outPort.label} 不能连接到 ${inPort.label}（类型不兼容）`;
  }
  if (!inPort.multi) {
    const exists = graph.edges.some((e) => e.to.node === toNode && e.to.port === toPort);
    if (exists) return '该输入端口已有连接（单源）';
  }
  // 虚拟加边检测环
  const probe: Edge = {
    id: '__probe__',
    from: { node: fromNode, port: fromPort },
    to: { node: toNode, port: toPort },
  };
  if (detectCycle({ nodes: graph.nodes, edges: [...graph.edges, probe] })) {
    return '工作流不能包含循环';
  }
  return null;
}

export type { NodeInstance };
