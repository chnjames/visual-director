import { describe, it, expect } from 'vitest';
import { standardTemplateGraph } from './template';
import { validateGraph, canConnect, detectCycle } from './validate';
import {
  addNode,
  autoLayout,
  connect,
  duplicateNode,
  fitBounds,
  moveNode,
  removeEdge,
  removeNode,
  resetIdCounter,
} from './graphOps';
import { GraphHistory } from './history';

function template() {
  resetIdCounter();
  return standardTemplateGraph();
}

const MAINLINE_TYPES = [
  'productImages',
  'promptEditor',
  'referenceAnalyze',
  'resultGallery',
  'sceneGenerate',
];

describe('标准模板', () => {
  it('出厂模板自身必须通过全部校验（黄金基线）', () => {
    const r = validateGraph(template());
    expect(r.errors).toEqual([]);
    expect(r.canPublish).toBe(true);
    expect(r.isAcyclic).toBe(true);
  });

  it('包含五节点核心主线：参考分析、商品图、提示词、生成、展示', () => {
    const g = template();
    const types = g.nodes.map((n) => n.type).sort();
    expect(types).toEqual(MAINLINE_TYPES);
  });
});

describe('图校验', () => {
  it('拒绝类型不兼容的连接（待确认配方绕过闸门直连编译）', () => {
    let g = { nodes: [] as ReturnType<typeof template>['nodes'], edges: [] as ReturnType<typeof template>['edges'] };
    g = addNode(g, 'recipeExtractor', { x: 0, y: 0 });
    g = addNode(g, 'promptCompiler', { x: 200, y: 0 });
    const extractor = g.nodes.find((n) => n.type === 'recipeExtractor')!;
    const compiler = g.nodes.find((n) => n.type === 'promptCompiler')!;
    expect(canConnect(g, extractor.id, 'recipe', compiler.id, 'recipe')).toMatch(/不兼容/);
    expect(() => connect(g, extractor.id, 'recipe', compiler.id, 'recipe')).toThrow();
  });

  it('拒绝自连与环', () => {
    const g = template();
    const gen = g.nodes.find((n) => n.type === 'sceneGenerate')!;
    expect(canConnect(g, gen.id, 'image', gen.id, 'prompt')).toMatch(/自身|不兼容/);
    const cycle = {
      nodes: g.nodes,
      edges: [
        ...g.edges,
        { id: 'fake', from: { node: gen.id, port: 'image' }, to: { node: gen.id, port: 'prompt' } },
      ],
    };
    expect(detectCycle(cycle)).toBeTruthy();
  });

  it('单源入端口不允许第二条边', () => {
    let g = { nodes: [] as ReturnType<typeof template>['nodes'], edges: [] as ReturnType<typeof template>['edges'] };
    g = addNode(g, 'recipeConfirmGate', { x: 0, y: 0 });
    g = addNode(g, 'promptCompiler', { x: 200, y: 0 });
    const gate = g.nodes.find((n) => n.type === 'recipeConfirmGate')!;
    const compiler = g.nodes.find((n) => n.type === 'promptCompiler')!;
    g = connect(g, gate.id, 'recipe', compiler.id, 'recipe');
    expect(canConnect(g, gate.id, 'recipe', compiler.id, 'recipe')).toMatch(/已有连接/);
  });

  it('缺少必需输入时报 E_UNREACHABLE_INPUT', () => {
    let g = template();
    const gallery = g.nodes.find((n) => n.type === 'resultGallery')!;
    const incoming = g.edges.filter((e) => e.to.node === gallery.id);
    g = { ...g, edges: g.edges.filter((e) => !incoming.includes(e)) };
    const r = validateGraph(g);
    expect(r.errors.some((i) => i.code === 'E_UNREACHABLE_INPUT')).toBe(true);
    expect(r.canPublish).toBe(false);
  });

  it('核心主线允许先不启用身份与验收高级能力', () => {
    const r = validateGraph(template());
    expect(r.warnings.some((i) => i.code === 'W_NO_IDENTITY_CONSTRAINTS')).toBe(false);
    expect(r.warnings.some((i) => i.code === 'W_AUDIT_SKIPPED')).toBe(false);
    expect(r.warnings.some((i) => i.code === 'W_NO_SOURCE')).toBe(false);
    expect(r.canPublish).toBe(true);
  });

  it('孤立的规划中输入节点不阻断发布', () => {
    let g = template();
    g = addNode(g, 'batchProductInput', { x: 0, y: 400 });
    const r = validateGraph(g);
    expect(r.errors.some((i) => i.code === 'E_SOURCE_WITHOUT_PATH')).toBe(false);
    expect(r.canPublish).toBe(true);
    expect(r.hints.some((i) => i.code === 'H_ISOLATED_NODE')).toBe(true);
  });

  it('修复节点最多一个', () => {
    let g = { nodes: [] as ReturnType<typeof template>['nodes'], edges: [] as ReturnType<typeof template>['edges'] };
    g = addNode(g, 'targetedRepair', { x: 0, y: 0 });
    expect(() => addNode(g, 'targetedRepair', { x: 1, y: 1 })).toThrow(/最多/);
  });

  it('待确认配方送到非闸门节点报闸门绕过', () => {
    let g = { nodes: [] as ReturnType<typeof template>['nodes'], edges: [] as ReturnType<typeof template>['edges'] };
    g = addNode(g, 'recipeExtractor', { x: 0, y: 0 });
    g = addNode(g, 'finalSink', { x: 200, y: 0 });
    const extractor = g.nodes.find((n) => n.type === 'recipeExtractor')!;
    const sink = g.nodes.find((n) => n.type === 'finalSink')!;
    expect(() => connect(g, extractor.id, 'recipe', sink.id, 'audit')).toThrow();
  });
});

describe('图操作', () => {
  it('添加节点带默认配置与新 id', () => {
    const g = template();
    const next = addNode(g, 'resultAuditor', { x: 10, y: 10 });
    expect(next.nodes).toHaveLength(g.nodes.length + 1);
    const added = next.nodes[next.nodes.length - 1];
    expect(added.type).toBe('resultAuditor');
    expect(added.position).toEqual({ x: 10, y: 10 });
  });

  it('删除节点级联删除连线；结果展示不能删', () => {
    let g = template();
    const extract = g.nodes.find((n) => n.type === 'referenceAnalyze')!;
    g = removeNode(g, extract.id);
    expect(g.edges.some((e) => e.from.node === extract.id || e.to.node === extract.id)).toBe(false);
    const base = template();
    const editor = base.nodes.find((n) => n.type === 'promptEditor')!;
    const afterEditor = removeNode(base, editor.id);
    expect(afterEditor.nodes.some((n) => n.id === editor.id)).toBe(false);
    const gallery = base.nodes.find((n) => n.type === 'resultGallery')!;
    expect(() => removeNode(base, gallery.id)).toThrow(/必需/);
  });

  it('复制节点偏移 24px 且不复制连线', () => {
    const g = template();
    const src = g.nodes.find((n) => n.type === 'referenceAnalyze')!;
    const edgesBefore = g.edges.length;
    const next = duplicateNode(g, src.id);
    expect(next.nodes).toHaveLength(g.nodes.length + 1);
    expect(next.edges).toHaveLength(edgesBefore);
    const copy = next.nodes.find((n) => n.id !== src.id && n.type === 'referenceAnalyze')!;
    expect(copy.position).toEqual({ x: src.position.x + 24, y: src.position.y + 24 });
    expect(next.edges.some((e) => e.from.node === copy.id || e.to.node === copy.id)).toBe(false);
  });

  it('移动节点只在位置真正变化时返回新图', () => {
    const g = template();
    const n = g.nodes[0];
    expect(moveNode(g, n.id, n.position)).toBe(g);
    expect(moveNode(g, n.id, { x: n.position.x + 10, y: n.position.y })).not.toBe(g);
  });

  it('删除边后校验能识别缺失连接', () => {
    let g = template();
    const edgeToGenerate = g.edges.find(
      (e) => e.to.node === g.nodes.find((n) => n.type === 'resultGallery')!.id && e.to.port === 'images',
    )!;
    g = removeEdge(g, edgeToGenerate.id);
    const r = validateGraph(g);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('自动布局后所有节点有分层坐标且仍无环、可发布性不变', () => {
    const g = autoLayout(template());
    const r = validateGraph(g);
    expect(r.errors).toEqual([]);
    const xs = new Set(g.nodes.map((n) => n.position.x));
    expect(xs.size).toBeGreaterThan(1);
  });

  it('fitBounds 返回可容纳全部节点的缩放（<=1.2）与平移', () => {
    const g = template();
    const b = fitBounds(g, { width: 1200, height: 700 });
    expect(b.zoom).toBeGreaterThan(0);
    expect(b.zoom).toBeLessThanOrEqual(1.2);
  });
});

describe('撤销/重做', () => {
  it('提交后可逐步撤销与重做', () => {
    resetIdCounter();
    const h = new GraphHistory(template());
    const g1 = addNode(h.current, 'resultAuditor', { x: 0, y: 0 });
    h.commit(g1);
    const g2 = addNode(h.current, 'resultAuditor', { x: 40, y: 40 });
    h.commit(g2);
    expect(h.current.nodes).toHaveLength(g2.nodes.length);
    expect(h.canUndo).toBe(true);
    expect(h.undoCount).toBe(2);
    h.undo();
    expect(h.current.nodes).toHaveLength(g1.nodes.length);
    h.undo();
    expect(h.canUndo).toBe(false);
    h.redo();
    expect(h.canRedo).toBe(true);
    h.redo();
    expect(h.current.nodes).toHaveLength(g2.nodes.length);
  });

  it('提交相同图不产生历史点', () => {
    const g = template();
    const h = new GraphHistory(g);
    h.commit(g);
    expect(h.canUndo).toBe(false);
  });

  it('重做后新编辑会清空未来栈', () => {
    const h = new GraphHistory(template());
    const g1 = addNode(h.current, 'resultAuditor', { x: 0, y: 0 });
    h.commit(g1);
    h.undo();
    expect(h.canRedo).toBe(true);
    const gAlt = moveNode(h.current, h.current.nodes[0].id, { x: 1, y: 1 });
    h.commit(gAlt);
    expect(h.canRedo).toBe(false);
  });
});

describe('添加节点配置覆盖', () => {
  it('新生成节点可写入用途/比例/分辨率/数量，其余字段仍用注册表默认值', () => {
    resetIdCounter();
    const g = addNode(
      { nodes: [], edges: [] },
      'sceneGenerate',
      { x: 0, y: 0 },
      { aspectRatio: '16:9', resolution: '3K', count: 3, targetUse: 'banner' },
    );
    const node = g.nodes[0];
    expect(node.config.aspectRatio).toBe('16:9');
    expect(node.config.resolution).toBe('3K');
    expect(node.config.count).toBe(3);
    expect(node.config.targetUse).toBe('banner');
    expect(node.config.keepIdentity).toBe(true);
    expect(node.config.productImages).toEqual([]);
  });

  it('未知覆盖键不会写入节点配置', () => {
    resetIdCounter();
    const g = addNode({ nodes: [], edges: [] }, 'sceneGenerate', { x: 0, y: 0 }, { notAField: 'x' });
    expect(g.nodes[0].config).not.toHaveProperty('notAField');
  });
});
