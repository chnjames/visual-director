/**
 * 把画布节点上的图片变更同步进素材库索引。
 * 草稿本身已含 dataURI；素材页也会直接从草稿收集展示，避免索引失败时整页空白。
 */
import { upsertAsset, type ProjectAssetKind, type ProjectAssetSource } from './assetStore';
import type { WorkflowGraph } from '../workflow/graph/types';

const IMAGE_FIELD_KIND: Record<string, ProjectAssetKind> = {
  images: 'reference',
  referenceImages: 'reference',
  productImages: 'product',
  lastOutputImages: 'generated',
};

function kindForNodeField(nodeType: string, fieldKey: string): ProjectAssetKind | null {
  if (fieldKey === 'lastOutputImages') return 'generated';
  if (fieldKey === 'productImages') return 'product';
  if (fieldKey === 'referenceImages') return 'reference';
  if (fieldKey === 'images') {
    if (nodeType === 'productImages' || nodeType === 'productInput' || nodeType === 'batchProductInput') {
      return 'product';
    }
    if (
      nodeType === 'referenceAnalyze' ||
      nodeType === 'referenceInput' ||
      nodeType === 'referenceAnalyzer'
    ) {
      return 'reference';
    }
    // 其它节点上的 images 不盲猜成 reference，避免误归类
    return null;
  }
  return IMAGE_FIELD_KIND[fieldKey] ?? null;
}

type ImageLike = { dataUri?: unknown; mediaType?: unknown; name?: unknown };

function readImages(value: unknown): Array<{ dataUri: string; mediaType: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as ImageLike;
    if (typeof raw.dataUri !== 'string' || !raw.dataUri) return [];
    return [
      {
        dataUri: raw.dataUri,
        mediaType: typeof raw.mediaType === 'string' ? raw.mediaType : 'image/png',
        name: typeof raw.name === 'string' && raw.name ? raw.name : `未命名图片 ${index + 1}`,
      },
    ];
  });
}

export type CollectedGraphImage = {
  kind: ProjectAssetKind;
  source: ProjectAssetSource;
  name: string;
  dataUri: string;
  mediaType: string;
  nodeId: string;
};

/** 从工作流图收集可展示的图片（不写库）。 */
export function collectImagesFromGraph(graph: WorkflowGraph): CollectedGraphImage[] {
  const out: CollectedGraphImage[] = [];
  for (const node of graph.nodes) {
    for (const [fieldKey, value] of Object.entries(node.config)) {
      const kind = kindForNodeField(node.type, fieldKey);
      if (!kind) continue;
      const source: ProjectAssetSource = kind === 'generated' ? 'canvas-run' : 'canvas-upload';
      for (const [index, image] of readImages(value).entries()) {
        const name =
          kind === 'generated' && image.name.startsWith('未命名')
            ? `生成图 ${index + 1}`
            : image.name;
        out.push({
          kind,
          source,
          name,
          dataUri: image.dataUri,
          mediaType: image.mediaType,
          nodeId: node.id,
        });
      }
    }
  }
  return out;
}

export async function indexNodeImagesToAssets(args: {
  projectId: string;
  nodeId: string;
  nodeType: string;
  patch: Record<string, unknown>;
}): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  for (const [fieldKey, value] of Object.entries(args.patch)) {
    const kind = kindForNodeField(args.nodeType, fieldKey);
    if (!kind) continue;
    const source: ProjectAssetSource = kind === 'generated' ? 'canvas-run' : 'canvas-upload';
    for (const [index, image] of readImages(value).entries()) {
      const name =
        kind === 'generated' && image.name.startsWith('未命名')
          ? `生成图 ${index + 1}`
          : image.name;
      tasks.push(
        upsertAsset({
          projectId: args.projectId,
          kind,
          name,
          dataUri: image.dataUri,
          mediaType: image.mediaType,
          source,
          nodeId: args.nodeId,
        }),
      );
    }
  }
  if (tasks.length) {
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('素材索引失败', result.reason);
      }
    }
  }
}
