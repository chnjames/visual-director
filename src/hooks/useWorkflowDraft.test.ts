import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useWorkflowDraft } from './useWorkflowDraft';
import type { WorkflowGraph } from '../workflow/graph/types';
import { loadDraft } from '../data/draftStore';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

function findByType(graph: WorkflowGraph, type: string) {
  return graph.nodes.find((n) => n.type === type)!;
}

describe('useWorkflowDraft 草稿编辑', () => {
  it('加载标准模板，初始校验通过', async () => {
    const { result } = renderHook(() => useWorkflowDraft('proj-test-1', '测试项目'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.graph!.nodes.length).toBe(5);
    expect(result.current.validation.errors).toEqual([]);
    expect(result.current.validation.canPublish).toBe(true);
  });

  it('提示词节点可以删除，结果展示不能删', async () => {
    const { result } = renderHook(() => useWorkflowDraft('proj-test-2', '测试项目'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.selectNode(findByType(result.current.graph!, 'promptEditor').id));
    act(() => result.current.removeSelected());
    expect(result.current.graph!.nodes.some((n) => n.type === 'promptEditor')).toBe(false);
    const before = result.current.graph!.nodes.length;
    act(() => result.current.selectNode(findByType(result.current.graph!, 'resultGallery').id));
    act(() => result.current.removeSelected());
    expect(result.current.graph!.nodes.length).toBe(before);
  });

  it('添加参考图分析节点（第 2 个）成功，删除并可撤销', async () => {
    const { result } = renderHook(() => useWorkflowDraft('proj-test-3', '测试项目'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.addNode('referenceAnalyze', { x: 40, y: 500 }));
    expect(result.current.graph!.nodes.filter((n) => n.type === 'referenceAnalyze').length).toBe(2);

    // 选中并删除该新节点（它无边，删除安全）
    const added = result.current.graph!.nodes.filter(
      (n) => n.type === 'referenceAnalyze' && !result.current.graph!.edges.some((e) => e.to.node === n.id || e.from.node === n.id),
    )[0];
    act(() => result.current.selectNode(added.id));
    act(() => result.current.removeSelected());
    expect(result.current.graph!.nodes.filter((n) => n.type === 'referenceAnalyze').length).toBe(1);

    // 撤销恢复
    act(() => result.current.undo());
    expect(result.current.graph!.nodes.filter((n) => n.type === 'referenceAnalyze').length).toBe(2);
    act(() => result.current.redo());
    expect(result.current.graph!.nodes.filter((n) => n.type === 'referenceAnalyze').length).toBe(1);
  });

  it('类型不兼容的连接被拒绝并返回原因', async () => {
    const { result } = renderHook(() => useWorkflowDraft('proj-test-4', '测试项目'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const analyze = findByType(result.current.graph!, 'referenceAnalyze');
    const gen = findByType(result.current.graph!, 'sceneGenerate');
    const r = result.current.tryConnect(analyze.id, 'refs', gen.id, 'prompt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/不兼容/);
  });

  it('复制节点偏移且不带连线', async () => {
    const { result } = renderHook(() => useWorkflowDraft('proj-test-5', '测试项目'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const src = findByType(result.current.graph!, 'referenceAnalyze');
    act(() => result.current.selectNode(src.id));
    act(() => result.current.duplicateSelected());
    const copies = result.current.graph!.nodes.filter((n) => n.type === 'referenceAnalyze');
    expect(copies.length).toBe(2);
    const copy = copies.find((n) => n.id !== src.id)!;
    const hasEdge = result.current.graph!.edges.some((e) => e.from.node === copy.id || e.to.node === copy.id);
    expect(hasEdge).toBe(false);
  });

  it('节点配置更新立即写入草稿并可撤销', async () => {
    const { result } = renderHook(() => useWorkflowDraft('proj-test-6', '测试项目'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const generate = findByType(result.current.graph!, 'sceneGenerate');
    const productImages = [{
      id: 'product-1',
      name: 'product.png',
      mediaType: 'image/png',
      dataUri: 'data:image/png;base64,QUJD',
      bytes: 3,
    }];

    act(() => result.current.updateNodeConfig(generate.id, 'productImages', productImages));
    expect(findByType(result.current.graph!, 'sceneGenerate').config.productImages).toEqual(productImages);

    act(() => result.current.undo());
    expect(findByType(result.current.graph!, 'sceneGenerate').config.productImages).toEqual([]);
  });

  it('节点配置更新会自动保存并可重新读取', async () => {
    const projectId = 'proj-test-7';
    const { result } = renderHook(() => useWorkflowDraft(projectId, '测试项目'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const generate = findByType(result.current.graph!, 'sceneGenerate');

    act(() => result.current.updateNodeConfig(generate.id, 'positivePrompt', '保存这条商品提示词'));
    await waitFor(() => expect(result.current.saveState).toBe('saved'), { timeout: 2500 });

    const reloaded = await loadDraft(projectId, '测试项目');
    expect(findByType(reloaded.graph, 'sceneGenerate').config.positivePrompt).toBe('保存这条商品提示词');
  });

  it('添加生成节点时写入传入的生成默认值，不改已有节点', async () => {
    const { result } = renderHook(() => useWorkflowDraft('proj-test-defaults', '测试项目'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const existing = findByType(result.current.graph!, 'sceneGenerate');
    expect(existing.config.aspectRatio).toBe('1:1');

    act(() =>
      result.current.addNode('sceneGenerate', { x: 40, y: 500 }, {
        aspectRatio: '9:16',
        resolution: '3K',
        count: 2,
        targetUse: 'social',
      }),
    );
    const added = result.current.graph!.nodes.filter((n) => n.type === 'sceneGenerate' && n.id !== existing.id)[0];
    expect(added.config.aspectRatio).toBe('9:16');
    expect(added.config.resolution).toBe('3K');
    expect(added.config.count).toBe(2);
    expect(added.config.targetUse).toBe('social');
    expect(findByType(result.current.graph!, 'sceneGenerate').config.aspectRatio).toBe('1:1');
  });
});
