import { describe, it, expect, beforeEach } from 'vitest';
import { persistCanvasRun } from './persistCanvasRun';
import { listRuns, clearRuns } from './runStore';
import { listAssets, clearAssets } from './assetStore';

const PID = 'test-persist-run-pid';

describe('persistCanvasRun', () => {
  beforeEach(async () => {
    await clearRuns(PID);
    await clearAssets(PID);
  });

  it('生成成功时写入 run + generated asset', async () => {
    const run = await persistCanvasRun({
      projectId: PID,
      kind: 'node',
      status: 'done',
      nodeId: 'n1',
      nodeTitle: '商品场景生成',
      generation: {
        ok: true,
        positivePrompt: 'a product',
        negativePrompt: '',
        imageDataUri: 'data:image/png;base64,aaa',
        mediaType: 'image/png',
        audit: null,
        recipeBound: false,
        callsUsed: 2,
      },
    });

    expect(run.imageDataUri).toContain('data:image/png');
    expect(run.assetIds.length).toBe(1);

    const runs = await listRuns(PID);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(run.id);

    const assets = await listAssets(PID);
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe('generated');
    expect(assets[0].source).toBe('canvas-run');
    expect(assets[0].runId).toBe(run.id);
  });

  it('失败无图时只记 run，不写素材', async () => {
    await persistCanvasRun({
      projectId: PID,
      kind: 'chain',
      status: 'failed',
      message: '网络错误',
      callsUsed: 1,
      steps: [{ nodeId: 'n1', title: '参考图分析', status: 'failed', message: '网络错误' }],
    });

    const runs = await listRuns(PID);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].imageDataUri).toBeUndefined();

    const assets = await listAssets(PID);
    expect(assets).toHaveLength(0);
  });

  it('相同 dataUri 不重复写入素材', async () => {
    const uri = 'data:image/png;base64,dup';
    await persistCanvasRun({
      projectId: PID,
      kind: 'node',
      status: 'done',
      generation: {
        ok: true,
        positivePrompt: 'x',
        negativePrompt: '',
        imageDataUri: uri,
        mediaType: 'image/png',
        audit: null,
        recipeBound: true,
        callsUsed: 1,
      },
    });
    await persistCanvasRun({
      projectId: PID,
      kind: 'node',
      status: 'done',
      generation: {
        ok: true,
        positivePrompt: 'y',
        negativePrompt: '',
        imageDataUri: uri,
        mediaType: 'image/png',
        audit: null,
        recipeBound: true,
        callsUsed: 1,
      },
    });

    expect(await listRuns(PID)).toHaveLength(2);
    expect(await listAssets(PID)).toHaveLength(1);
  });

  it('显式 images 优先于 generation.imageDataUri', async () => {
    const run = await persistCanvasRun({
      projectId: PID,
      kind: 'node',
      status: 'done',
      nodeTitle: '商品场景生成',
      generation: {
        ok: true,
        positivePrompt: 'x',
        negativePrompt: '',
        imageDataUri: 'data:image/png;base64,LEGACY',
        mediaType: 'image/png',
        audit: null,
        recipeBound: false,
        callsUsed: 1,
      },
      images: [
        { dataUri: 'data:image/png;base64,A', mediaType: 'image/png' },
        { dataUri: 'data:image/png;base64,B', mediaType: 'image/png' },
      ],
    });

    expect(run.images).toHaveLength(2);
    expect(run.imageDataUri).toContain('base64,A');
    const assets = await listAssets(PID);
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.kind === 'generated')).toBe(true);
  });
});
