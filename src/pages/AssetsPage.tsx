import { useCallback, useEffect, useMemo, useState } from 'react';
import { listAssets, type ProjectAsset } from '../data/assetStore';
import { loadDraft } from '../data/draftStore';
import { collectImagesFromGraph, indexNodeImagesToAssets } from '../data/indexNodeImages';
import type { ModelSettings, UploadedImage } from '../shared/types';

type AssetTab = 'refs' | 'products' | 'generated';

function mergeAssetRows(store: ProjectAsset[], draft: ProjectAsset[]): ProjectAsset[] {
  const out: ProjectAsset[] = [];
  const seen = new Set<string>();
  for (const asset of [...store, ...draft]) {
    const key = `${asset.kind}|${asset.source}|${asset.dataUri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * 素材库：画布上传 + 试运行生成图 + 批量任务图。
 * 展示以 IndexedDB 素材库为准，并始终合并当前草稿里的图，避免索引/迁移失败时整页空白。
 */
export function AssetsPage({ projectId }: { projectId: string; settings: ModelSettings | null; configured: boolean }) {
  const [tab, setTab] = useState<AssetTab>('refs');
  const [canvasAssets, setCanvasAssets] = useState<ProjectAsset[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const draft = await loadDraft(projectId, 'project');
      const fromDraft = collectImagesFromGraph(draft.graph).map(
        (image, index): ProjectAsset => ({
          id: `draft_${image.nodeId}_${index}`,
          projectId,
          kind: image.kind,
          name: image.name,
          dataUri: image.dataUri,
          mediaType: image.mediaType,
          createdAt: new Date(0).toISOString(),
          source: image.source,
          nodeId: image.nodeId,
        }),
      );

      // 尽力把草稿图补进素材库；失败不阻断展示
      for (const node of draft.graph.nodes) {
        await indexNodeImagesToAssets({
          projectId,
          nodeId: node.id,
          nodeType: node.type,
          patch: node.config,
        });
      }

      const fromStore = await listAssets(projectId);
      setCanvasAssets(mergeAssetRows(fromStore, fromDraft));
    } catch (err) {
      console.warn('素材库加载失败', err);
      setCanvasAssets([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  const refs = useMemo(() => {
    const rows: Array<{ key: string; src: string; name: string; caption: string }> = [];
    const seen = new Set<string>();
    for (const asset of canvasAssets.filter((a) => a.kind === 'reference')) {
      if (seen.has(asset.dataUri)) continue;
      seen.add(asset.dataUri);
      rows.push({
        key: asset.id,
        src: asset.dataUri,
        name: asset.name,
        caption: `${asset.name} · ${asset.source === 'batch' ? '批量' : '画布'}`,
      });
    }
    return rows;
  }, [canvasAssets]);

  const products = useMemo(
    () =>
      canvasAssets
        .filter((asset) => asset.kind === 'product')
        .map((asset) => ({
          id: asset.id,
          name: asset.name,
          mediaType: asset.mediaType,
          dataUri: asset.dataUri,
          caption: `${asset.name} · ${asset.source === 'batch' ? '批量' : '画布'}`,
        })),
    [canvasAssets],
  );
  const generated = useMemo(() => {
    const rows: Array<{ key: string; image: UploadedImage; caption: string }> = [];
    const seen = new Set<string>();
    for (const asset of canvasAssets.filter((a) => a.kind === 'generated')) {
      if (seen.has(asset.dataUri)) continue;
      seen.add(asset.dataUri);
      rows.push({
        key: asset.id,
        image: {
          id: asset.id,
          name: asset.name,
          mediaType: asset.mediaType,
          dataUri: asset.dataUri,
        },
        caption: asset.name,
      });
    }
    return rows;
  }, [canvasAssets]);

  const tabs: Array<{ id: AssetTab; label: string; count: number }> = [
    { id: 'refs', label: '参考图', count: refs.length },
    { id: 'products', label: '商品图', count: products.length },
    { id: 'generated', label: '生成图', count: generated.length },
  ];

  return (
    <div className="page-scroll">
      <div className="page-container">
        <h1 className="page-title">素材库</h1>
        <p className="page-sub">
          参考图 / 商品图来自画布节点与批量任务上传；生成图来自画布试运行与批量结果。都保存在本机 IndexedDB。
        </p>

        <div className="page-tabs" role="tablist" aria-label="素材分类">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className={`page-tab ${tab === item.id ? 'active' : ''}`}
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label} {item.count}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="hint">正在加载素材…</p>
        ) : (
          <>
            {tab === 'refs' && (
              <AssetSection
                empty="在「参考图分析」上传参考图后会出现在这里。"
                images={refs}
              />
            )}
            {tab === 'products' && (
              <AssetSection
                empty="在「商品图」节点、生成节点或批量任务里上传商品图后会出现在这里。"
                images={products.map((img) => ({
                  key: img.id,
                  src: img.dataUri,
                  name: img.name,
                  caption: img.caption,
                }))}
              />
            )}
            {tab === 'generated' && (
              <AssetSection
                empty="画布试运行或批量任务成功出图后会出现在这里。"
                images={generated.map((row) => ({
                  key: row.key,
                  src: row.image.dataUri,
                  name: row.caption,
                  caption: row.caption,
                }))}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AssetSection({
  empty,
  images,
}: {
  empty: string;
  images: Array<{ key: string; src: string; name: string; caption: string }>;
}) {
  if (!images.length) {
    return (
      <div className="empty-state" data-testid="assets-empty">
        <h3>还没有素材</h3>
        <p>{empty}</p>
      </div>
    );
  }
  return (
    <div className="asset-grid" data-testid="assets-grid">
      {images.map((image) => (
        <figure className="asset-card" key={image.key}>
          <img src={image.src} alt={image.name} />
          <div className="name">{image.caption}</div>
        </figure>
      ))}
    </div>
  );
}
