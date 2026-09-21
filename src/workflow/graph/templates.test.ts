import { describe, it, expect, beforeEach } from 'vitest';
import { standardTemplateGraph } from './template';
import { WORKFLOW_TEMPLATES, getTemplate } from './templates';
import { validateGraph } from './validate';
import { addNode, removeNode } from './graphOps';
import { checksumGraph } from '../../data/versionStore';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('工作流模板', () => {
  it('只暴露两个可运行模板且均可发布', () => {
    const ids = WORKFLOW_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(['blank', 'standard-still-life']);
    const standard = getTemplate('standard-still-life').buildGraph();
    expect(validateGraph(standard).canPublish).toBe(true);
    expect(validateGraph(getTemplate('blank').buildGraph()).canPublish).toBe(true);
  });

  it('标准模板是参考分析、商品图、提示词、生成、展示五节点主线', () => {
    const g = standardTemplateGraph();
    const types = new Set(g.nodes.map((n) => n.type));
    for (const t of [
      'referenceAnalyze',
      'productImages',
      'promptEditor',
      'sceneGenerate',
      'resultGallery',
    ]) {
      expect(types.has(t)).toBe(true);
    }
    expect(g.nodes).toHaveLength(5);
    const generate = g.nodes.find((n) => n.type === 'sceneGenerate')!;
    const products = g.nodes.find((n) => n.type === 'productImages')!;
    expect(g.edges.some((edge) => edge.from.node === products.id && edge.to.node === generate.id && edge.to.port === 'products')).toBe(true);
  });

  it('直接生成模板只有生成和结果展示', () => {
    const g = getTemplate('blank').buildGraph();
    expect(g.nodes.length).toBe(2);
    const validation = validateGraph(g);
    expect(validation.warnings.map((warning) => warning.code)).not.toContain('W_NO_SOURCE');
    expect(validation.warnings.map((warning) => warning.code)).not.toContain('W_AUDIT_SKIPPED');
  });

  it('每次构建模板产生独立节点（编辑不影响模板源）', () => {
    const a = getTemplate('blank').buildGraph();
    const b = getTemplate('blank').buildGraph();
    expect(a.nodes[0].id).not.toBe(b.nodes[0].id);
  });

});

describe('版本内容校验和', () => {
  it('相同图产生相同 checksum，节点位置变化产生不同 checksum', () => {
    const g1 = standardTemplateGraph();
    const g2 = JSON.parse(JSON.stringify(g1));
    expect(checksumGraph(g1)).toBe(checksumGraph(g2));
    const moved = {
      ...g2,
      nodes: g2.nodes.map((n: { position: { x: number; y: number } }, i: number) =>
        i === 0 ? { ...n, position: { x: 1, y: 1 } } : n,
      ),
    };
    expect(checksumGraph(g1)).not.toBe(checksumGraph(moved));
  });

  it('加入规划中节点会让图含不可执行节点（发布检查依据）', () => {
    let g = standardTemplateGraph();
    g = addNode(g, 'backgroundRemove', { x: 40, y: 500 });
    const r = validateGraph(g);
    expect(g.nodes.some((n) => n.type === 'backgroundRemove')).toBe(true);
    expect(r).toBeTruthy();
  });

  it('提示词节点可删，结果展示不能删，模板配置带默认值', () => {
    const g = standardTemplateGraph();
    const prompt = g.nodes.find((n) => n.type === 'promptEditor')!;
    const gallery = g.nodes.find((n) => n.type === 'resultGallery')!;
    const generator = g.nodes.find((n) => n.type === 'sceneGenerate')!;
    expect(() => removeNode(g, prompt.id)).not.toThrow();
    expect(() => removeNode(g, gallery.id)).toThrow(/必需/);
    expect(prompt.config.positivePrompt).toBe('');
    expect(generator.config.aspectRatio).toBe('1:1');
    expect(generator.config.count).toBe(1);
  });
});
