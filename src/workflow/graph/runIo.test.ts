import { describe, expect, it, vi } from 'vitest';
import type { NodeInstance, WorkflowGraph } from './types';
import {
  buildAnalyzeLog,
  buildGenerateLog,
  connectedGalleries,
  writeGenerateLocal,
  writeGenerateWorkflow,
} from './runIo';

const generate: NodeInstance = {
  id: 'gen-1',
  type: 'sceneGenerate',
  position: { x: 0, y: 0 },
  config: {
    productImages: [{ dataUri: 'data:image/png;base64,AAA', mediaType: 'image/png', name: 'p.png' }],
    positivePrompt: '白底耳机',
    aspectRatio: '1:1',
    resolution: '2K',
    count: 1,
  },
};

const gallery: NodeInstance = {
  id: 'gal-1',
  type: 'resultGallery',
  position: { x: 280, y: 0 },
  config: {},
};

const graph: WorkflowGraph = {
  nodes: [generate, gallery],
  edges: [{ id: 'e1', from: { node: 'gen-1', port: 'image' }, to: { node: 'gal-1', port: 'images' } }],
};

describe('单节点 vs 整图写入', () => {
  it('相连的结果展示会被识别', () => {
    expect(connectedGalleries(graph, 'gen-1').map((n) => n.id)).toEqual(['gal-1']);
  });

  it('单节点试运行只写当前生成节点，不写入结果展示', () => {
    const update = vi.fn();
    const images = [{ dataUri: 'data:image/png;base64,BBB', mediaType: 'image/png' }];
    const log = buildGenerateLog({
      scope: 'node',
      node: generate,
      images,
      message: '已生成 1 张',
      ok: true,
      durationMs: 1200,
    });
    writeGenerateLocal(update, generate.id, images, log.message, true, log);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      'gen-1',
      expect.objectContaining({
        lastOutputImages: images,
        lastRunOk: true,
        lastRunIo: expect.objectContaining({ scope: 'node' }),
      }),
    );
  });

  it('整图运行才把生成图写入结果展示', () => {
    const update = vi.fn();
    const images = [{ dataUri: 'data:image/png;base64,CCC', mediaType: 'image/png' }];
    const log = buildGenerateLog({
      scope: 'workflow',
      node: generate,
      images,
      message: '已生成 1 张',
      ok: true,
      durationMs: 2400,
    });
    writeGenerateWorkflow(update, graph, generate.id, images, log.message, true, log);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0]).toBe('gen-1');
    expect(update.mock.calls[1][0]).toBe('gal-1');
    expect(update.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        lastOutputImages: images,
        lastRunIo: expect.objectContaining({ scope: 'workflow' }),
      }),
    );
  });

  it('分析日志读取 images 字段而不是 referenceImages', () => {
    const analyze: NodeInstance = {
      id: 'a1',
      type: 'referenceAnalyze',
      position: { x: 0, y: 0 },
      config: {
        images: [{ dataUri: 'data:image/png;base64,AAA', mediaType: 'image/png', name: 'ref.png' }],
        purpose: 'main-scene',
      },
    };
    const log = buildAnalyzeLog({
      scope: 'node',
      node: analyze,
      summary: '结构要点',
      suggestedPrompt: '浅色侧光',
      ok: true,
      durationMs: 800,
    });
    expect(log.inputs.find((item) => item.key === 'referenceImages')?.images).toHaveLength(1);
    expect(log.outputs.find((item) => item.key === 'suggestedPrompt')?.text).toBe('浅色侧光');
  });
});
