import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearAssets,
  getAsset,
  latestGeneratedAsset,
  listAssets,
  upsertAsset,
  isLegacyAssetDoc,
  isAssetIndex,
  type ProjectAsset,
} from './assetStore';
import { openKey, STORE_ASSETS } from './db';

const PID = `asset-flow-${Date.now()}`;

describe('assetStore 全流程', () => {
  beforeEach(async () => {
    await clearAssets(PID);
  });

  it('并发 upsert 多张不同图不会丢', async () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      projectId: PID,
      kind: 'product' as const,
      name: `p${i}.png`,
      dataUri: `data:image/png;base64,AAA${i}`,
      mediaType: 'image/png',
      source: 'canvas-upload' as const,
      nodeId: 'n1',
    }));
    await Promise.all(inputs.map((input) => upsertAsset(input)));
    const assets = await listAssets(PID);
    expect(assets).toHaveLength(5);
    expect(new Set(assets.map((a) => a.dataUri)).size).toBe(5);
  });

  it('相同 dataUri+kind+source 去重', async () => {
    const input = {
      projectId: PID,
      kind: 'reference' as const,
      name: 'r.png',
      dataUri: 'data:image/png;base64,SAME',
      mediaType: 'image/png',
      source: 'canvas-upload' as const,
    };
    const a = await upsertAsset(input);
    const b = await upsertAsset(input);
    expect(a.id).toBe(b.id);
    expect(await listAssets(PID)).toHaveLength(1);
  });

  it('旧聚合文档可读，且读取不会毁掉原文档', async () => {
    const legacyId = 'ast_legacy_1';
    await openKey(STORE_ASSETS, `assets:${PID}`).enqueue({
      assets: [
        {
          id: legacyId,
          projectId: PID,
          kind: 'reference',
          name: '旧参考图',
          dataUri: 'data:image/png;base64,LEGACYREF',
          mediaType: 'image/png',
          createdAt: new Date().toISOString(),
          source: 'canvas-upload',
        },
        {
          id: 'ast_legacy_2',
          projectId: PID,
          kind: 'product',
          name: '旧商品图',
          dataUri: 'data:image/png;base64,LEGACYPROD',
          mediaType: 'image/png',
          createdAt: new Date().toISOString(),
          source: 'canvas-upload',
        },
        {
          id: 'ast_legacy_3',
          projectId: PID,
          kind: 'generated',
          name: '旧生成图',
          dataUri: 'data:image/png;base64,LEGACYGEN',
          mediaType: 'image/png',
          createdAt: new Date().toISOString(),
          source: 'canvas-run',
        },
      ],
    });

    const listed = await listAssets(PID);
    expect(listed).toHaveLength(3);
    expect(listed.map((a) => a.kind).sort()).toEqual(['generated', 'product', 'reference']);

    const raw = await openKey(STORE_ASSETS, `assets:${PID}`).load((d) => d);
    expect(isLegacyAssetDoc(raw)).toBe(true);
    expect(isAssetIndex(raw)).toBe(false);
  });

  it('破坏性空索引（ids 无对应文档）时，新写入仍可见', async () => {
    await openKey(STORE_ASSETS, `assets:${PID}`).enqueue({
      ids: ['ast_missing_1', 'ast_missing_2'],
    });
    expect(await listAssets(PID)).toHaveLength(0);

    await upsertAsset({
      projectId: PID,
      kind: 'reference',
      name: '恢复参考图',
      dataUri: 'data:image/png;base64,RECOVER',
      mediaType: 'image/png',
      source: 'canvas-upload',
    });
    const assets = await listAssets(PID);
    expect(assets).toHaveLength(1);
    expect(assets[0].dataUri).toContain('RECOVER');
  });

  it('参考图/商品图/生成图写入后都能列出', async () => {
    await upsertAsset({
      projectId: PID,
      kind: 'reference',
      name: 'ref',
      dataUri: 'data:image/png;base64,R',
      mediaType: 'image/png',
      source: 'canvas-upload',
    });
    await upsertAsset({
      projectId: PID,
      kind: 'product',
      name: 'prod',
      dataUri: 'data:image/png;base64,P',
      mediaType: 'image/png',
      source: 'canvas-upload',
    });
    await upsertAsset({
      projectId: PID,
      kind: 'generated',
      name: 'gen',
      dataUri: 'data:image/png;base64,G',
      mediaType: 'image/png',
      source: 'canvas-run',
    });
    const assets = await listAssets(PID);
    expect(assets).toHaveLength(3);
    expect(new Set(assets.map((a) => a.kind))).toEqual(new Set(['reference', 'product', 'generated']));
  });

  it('getAsset 按 ID 取单张（聚合形态），缺失返回 null', async () => {
    const created = await upsertAsset({
      projectId: PID,
      kind: 'generated',
      name: 'gen',
      dataUri: 'data:image/png;base64,G1',
      mediaType: 'image/png',
      source: 'canvas-run',
    });
    const hit = await getAsset(PID, created.id);
    expect(hit?.id).toBe(created.id);
    expect(hit?.dataUri).toContain('G1');
    expect(await getAsset(PID, 'ast_not_exist')).toBeNull();
    expect(await getAsset(PID, undefined)).toBeNull();
  });

  it('getAsset 在分条索引形态下只读单图文档', async () => {
    const id = 'ast_split_1';
    await openKey(STORE_ASSETS, `asset:${PID}:${id}`).enqueue({
      id,
      projectId: PID,
      kind: 'generated',
      name: '分条生成图',
      dataUri: 'data:image/png;base64,SPLIT',
      mediaType: 'image/png',
      createdAt: '2026-09-21T10:00:00.000Z',
      source: 'canvas-run',
    });
    await openKey(STORE_ASSETS, `assets:${PID}`).enqueue({ ids: [id] });

    const hit = await getAsset(PID, id);
    expect(hit?.dataUri).toContain('SPLIT');
    // 索引中不存在的 id 直接返回 null，不读素材文档
    expect(await getAsset(PID, 'ast_other')).toBeNull();
  });

  it('latestGeneratedAsset 取 createdAt 最新的生成图，忽略参考/商品图', async () => {
    const mk = (id: string, kind: ProjectAsset['kind'], createdAt: string, dataUri: string) => ({
      id,
      projectId: PID,
      kind,
      name: `${id}.png`,
      dataUri,
      mediaType: 'image/png',
      createdAt,
      source: 'canvas-run' as const,
    });
    const assets = [
      mk('g1', 'generated', '2026-09-21T09:00:00.000Z', 'data:image/png;base64,G_OLD'),
      mk('p1', 'product', '2026-09-21T12:00:00.000Z', 'data:image/png;base64,P_LATE'),
      mk('g2', 'generated', '2026-09-21T11:00:00.000Z', 'data:image/png;base64,G_NEW'),
    ];
    expect(latestGeneratedAsset(assets)?.id).toBe('g2');
    expect(latestGeneratedAsset([assets[1]])).toBeUndefined();
    expect(latestGeneratedAsset([])).toBeUndefined();
  });
});
