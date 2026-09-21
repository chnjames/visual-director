import { describe, expect, it, vi } from 'vitest';
import { fakeSettings, imageOk, img, makeRecipe, ok } from '../batch/batchTestUtils';
import { compileExecutionPlan } from './graph/executionPlan';
import { getTemplate } from './graph/templates';
import { runWorkflowVersion } from './runtime';
import type { ImageGenerateOptions } from '../model/arkClient';
import type { ModelSettings } from '../shared/types';

describe('WorkflowRuntime 核心流程', () => {
  it('直接生成模板把行级商品图、规格与数量注入图片适配器', async () => {
    const graph = getTemplate('blank').buildGraph();
    const generator = graph.nodes.find((node) => node.type === 'sceneGenerate')!;
    generator.config.positivePrompt = '高级白色背景商品主图';
    const image = vi.fn(async (
      _settings: ModelSettings,
      _positive: string,
      _negative: string,
      _options?: ImageGenerateOptions,
    ) => ({
      ...imageOk(),
      images: [
        { b64Json: 'QUFB', mediaType: 'image/png' },
        { b64Json: 'QkJC', mediaType: 'image/png' },
      ],
    }));
    const result = await runWorkflowVersion({
      version: {
        id: 'wfv_1',
        versionNo: 1,
        checksum: 'sum',
        graph,
        plan: compileExecutionPlan(graph),
      },
      settings: fakeSettings(),
      bindings: {
        productImages: [img('product')],
        aspectRatio: '3:4',
        resolution: '2K',
        count: 2,
      },
      runners: {
        recipe: vi.fn(),
        image,
        audit: vi.fn(),
      },
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.generation?.ok && result.generation.images).toHaveLength(2);
    expect(image).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('白色背景'),
      '',
      expect.objectContaining({
        productImages: [expect.objectContaining({ id: 'product' })],
        size: '1728x2304',
        count: 2,
      }),
    );
    expect(result.state.steps.map((step) => step.title)).toEqual([
      '商品场景生成',
      '结果展示',
    ]);
  });

  it('参考图辅助模板无需旧配方闸门即可生成可编辑提示词并出图', async () => {
    const graph = getTemplate('standard-still-life').buildGraph();
    const image = vi.fn(async (
      _settings: ModelSettings,
      _positive: string,
      _negative: string,
      _options?: ImageGenerateOptions,
    ) => imageOk());
    const result = await runWorkflowVersion({
      version: {
        id: 'wfv_ref',
        versionNo: 2,
        checksum: 'sum-ref',
        graph,
        plan: compileExecutionPlan(graph),
      },
      settings: fakeSettings(),
      bindings: {
        referenceImages: [img('reference')],
        purpose: 'detail-scene',
        positivePrompt: '浅色台面，柔和侧光',
        productImages: [img('product')],
      },
      runners: {
        recipe: vi.fn(async () => ok(makeRecipe(false))),
        image,
        audit: vi.fn(),
      },
    });
    expect(result.status).toBe('done');
    expect(image).toHaveBeenCalledOnce();
    expect(image.mock.calls[0][1]).toContain('浅色台面');
    expect(image.mock.calls[0][3]?.productImages?.map((item) => item.id)).toEqual(['product']);
    expect(result.state.steps.some((step) => step.status === 'paused')).toBe(false);
  });
});
