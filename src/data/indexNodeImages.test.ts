import { describe, expect, it, beforeEach } from 'vitest';
import { clearAssets, listAssets } from './assetStore';
import { indexNodeImagesToAssets } from './indexNodeImages';

const PID = `index-img-${Date.now()}`;

describe('indexNodeImagesToAssets', () => {
  beforeEach(async () => {
    await clearAssets(PID);
  });

  it('参考图分析节点的 images 记为 reference', async () => {
    await indexNodeImagesToAssets({
      projectId: PID,
      nodeId: 'analyze-1',
      nodeType: 'referenceAnalyze',
      patch: {
        images: [{ dataUri: 'data:image/png;base64,R1', mediaType: 'image/png', name: 'ref.png' }],
        purpose: 'main-scene',
      },
    });
    const assets = await listAssets(PID);
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe('reference');
    expect(assets[0].source).toBe('canvas-upload');
  });

  it('商品图节点的 images 记为 product', async () => {
    await indexNodeImagesToAssets({
      projectId: PID,
      nodeId: 'products-1',
      nodeType: 'productImages',
      patch: {
        images: [{ dataUri: 'data:image/png;base64,P1', mediaType: 'image/png', name: 'sku.png' }],
      },
    });
    const assets = await listAssets(PID);
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe('product');
  });

  it('生成节点 lastOutputImages 记为 generated', async () => {
    await indexNodeImagesToAssets({
      projectId: PID,
      nodeId: 'gen-1',
      nodeType: 'sceneGenerate',
      patch: {
        lastOutputImages: [
          { dataUri: 'data:image/png;base64,G1', mediaType: 'image/png' },
          { dataUri: 'data:image/png;base64,G2', mediaType: 'image/png' },
        ],
      },
    });
    const assets = await listAssets(PID);
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.kind === 'generated')).toBe(true);
    expect(assets.every((a) => a.source === 'canvas-run')).toBe(true);
  });

  it('collectImagesFromGraph 覆盖三类图且不写库', async () => {
    const { collectImagesFromGraph } = await import('./indexNodeImages');
    const images = collectImagesFromGraph({
      nodes: [
        {
          id: 'a',
          type: 'referenceAnalyze',
          position: { x: 0, y: 0 },
          config: {
            images: [{ dataUri: 'data:image/png;base64,R', mediaType: 'image/png', name: 'r.png' }],
          },
        },
        {
          id: 'p',
          type: 'productImages',
          position: { x: 0, y: 0 },
          config: {
            images: [{ dataUri: 'data:image/png;base64,P', mediaType: 'image/png', name: 'p.png' }],
          },
        },
        {
          id: 'g',
          type: 'sceneGenerate',
          position: { x: 0, y: 0 },
          config: {
            lastOutputImages: [{ dataUri: 'data:image/png;base64,G', mediaType: 'image/png' }],
          },
        },
      ],
      edges: [],
    });
    expect(images.map((i) => i.kind).sort()).toEqual(['generated', 'product', 'reference']);
    expect(await listAssets(PID)).toHaveLength(0);
  });
});
