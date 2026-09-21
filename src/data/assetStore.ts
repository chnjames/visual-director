/**
 * 项目素材清单（docs/11 附录 A · assets）。
 *
 * 存储形态（兼容）：
 * - 旧版聚合：`assets:{projectId}` → `{ assets: ProjectAsset[] }`（图直接嵌在文档里）
 * - 新版分条：`assets:{projectId}` → `{ ids: string[] }` + `asset:{projectId}:{id}` → ProjectAsset
 *
 * 读：两种形态都能直接列出，**绝不**在读取时毁掉旧文档。
 * 写：沿用当前文档形态追加；空库默认走聚合文档（实现简单、与旧数据一致）。
 */
import { openKey, STORE_ASSETS, type SaveStatus } from './db';

export type ProjectAssetKind = 'reference' | 'product' | 'generated';
export type ProjectAssetSource = 'batch' | 'canvas-run' | 'canvas-upload';

export type ProjectAsset = {
  id: string;
  projectId: string;
  kind: ProjectAssetKind;
  name: string;
  dataUri: string;
  mediaType: string;
  createdAt: string;
  source: ProjectAssetSource;
  runId?: string;
  nodeId?: string;
};

type AssetIndex = { ids: string[] };
type LegacyAssetDoc = { assets: ProjectAsset[] };
type AssetsRoot = AssetIndex | LegacyAssetDoc;

function indexDocKey(projectId: string) {
  return `assets:${projectId}`;
}
function assetDocKey(projectId: string, assetId: string) {
  return `asset:${projectId}:${assetId}`;
}

function newAssetId(): string {
  return `ast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function rootHandle(projectId: string) {
  return openKey<AssetsRoot>(STORE_ASSETS, indexDocKey(projectId));
}

function assetHandle(projectId: string, assetId: string) {
  return openKey<ProjectAsset>(STORE_ASSETS, assetDocKey(projectId, assetId));
}

export function isLegacyAssetDoc(raw: unknown): raw is LegacyAssetDoc {
  return !!raw && typeof raw === 'object' && Array.isArray((raw as LegacyAssetDoc).assets);
}

export function isAssetIndex(raw: unknown): raw is AssetIndex {
  return (
    !!raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as AssetIndex).ids) &&
    !Array.isArray((raw as LegacyAssetDoc).assets)
  );
}

function isValidAsset(a: unknown): a is ProjectAsset {
  return (
    !!a &&
    typeof a === 'object' &&
    typeof (a as ProjectAsset).id === 'string' &&
    typeof (a as ProjectAsset).dataUri === 'string' &&
    !!(a as ProjectAsset).dataUri &&
    typeof (a as ProjectAsset).kind === 'string'
  );
}

function sortAssets(assets: ProjectAsset[]): ProjectAsset[] {
  return [...assets].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function listFromIndex(projectId: string, ids: string[]): Promise<ProjectAsset[]> {
  const all: ProjectAsset[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id) continue;
    const asset = await assetHandle(projectId, id).load((d) => d as ProjectAsset);
    if (isValidAsset(asset)) all.push(asset);
  }
  return all;
}

/**
 * 按 ID 读取单张素材（首页封面用，避免把整项目 dataUri 全部拉出）。
 * 新分条形态只读单个素材文档；旧聚合形态回退为列出后查找。找不到返回 null。
 */
export async function getAsset(projectId: string, assetId: string | undefined): Promise<ProjectAsset | null> {
  if (!assetId) return null;
  const raw = await rootHandle(projectId).load((d) => d as AssetsRoot);
  if (!raw) return null;

  if (isLegacyAssetDoc(raw)) {
    return raw.assets.find((a) => isValidAsset(a) && a.id === assetId) ?? null;
  }

  if (isAssetIndex(raw)) {
    if (!raw.ids.includes(assetId)) return null;
    const asset = await assetHandle(projectId, assetId).load((d) => d as ProjectAsset);
    return isValidAsset(asset) && asset.id === assetId ? asset : null;
  }

  return null;
}

/**
 * 取最新一张生成图（按 createdAt 最大者），作为项目封面的唯一选取规则。
 * 纯函数，便于单测；无生成图时返回 undefined。
 */
export function latestGeneratedAsset(assets: ProjectAsset[]): ProjectAsset | undefined {
  return assets
    .filter((a) => a.kind === 'generated' && !!a.dataUri)
    .reduce<ProjectAsset | undefined>((latest, a) => {
      if (!latest || a.createdAt > latest.createdAt) return a;
      return latest;
    }, undefined);
}

/**
 * 列出项目素材。兼容旧聚合文档与新分条索引；读路径不做破坏性迁移。
 */
export async function listAssets(projectId: string): Promise<ProjectAsset[]> {
  const raw = await rootHandle(projectId).load((d) => d as AssetsRoot);
  if (!raw) return [];

  if (isLegacyAssetDoc(raw)) {
    return sortAssets(raw.assets.filter(isValidAsset));
  }

  if (isAssetIndex(raw)) {
    return sortAssets(await listFromIndex(projectId, raw.ids));
  }

  return [];
}

export type UpsertAssetInput = {
  projectId: string;
  kind: ProjectAssetKind;
  name: string;
  dataUri: string;
  mediaType: string;
  source: ProjectAssetSource;
  runId?: string;
  nodeId?: string;
};

/** 同项目 upsert 串行，避免并发互相覆盖。 */
const upsertChains = new Map<string, Promise<unknown>>();

function enqueueUpsert<T>(projectId: string, op: () => Promise<T>): Promise<T> {
  const prev = upsertChains.get(projectId) ?? Promise.resolve();
  const next = prev.then(op, op);
  upsertChains.set(
    projectId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function sameAsset(a: ProjectAsset, input: UpsertAssetInput): boolean {
  return a.dataUri === input.dataUri && a.kind === input.kind && a.source === input.source;
}

export async function upsertAsset(input: UpsertAssetInput): Promise<ProjectAsset> {
  return enqueueUpsert(input.projectId, async () => {
    const existing = (await listAssets(input.projectId)).find((a) => sameAsset(a, input));
    if (existing) return existing;

    const asset: ProjectAsset = {
      id: newAssetId(),
      projectId: input.projectId,
      kind: input.kind,
      name: input.name,
      dataUri: input.dataUri,
      mediaType: input.mediaType,
      createdAt: new Date().toISOString(),
      source: input.source,
      runId: input.runId,
      nodeId: input.nodeId,
    };

    const handle = rootHandle(input.projectId);
    const raw = await handle.load((d) => d as AssetsRoot);

    // 已是分条索引：继续写单图文档 + 索引 id
    if (isAssetIndex(raw)) {
      const docStatus = await assetHandle(input.projectId, asset.id).enqueue(asset);
      if (docStatus === 'failed') {
        throw new Error('素材写入失败（本地存储可能已满）');
      }
      const idxResult = await handle.enqueueMutate((prev) => {
        const ids = isAssetIndex(prev) ? prev.ids : [];
        if (ids.includes(asset.id)) return null;
        return { ids: [asset.id, ...ids].slice(0, 200) };
      });
      if (idxResult.status === 'failed') {
        throw new Error('素材索引写入失败（本地存储可能已满）');
      }
      return asset;
    }

    // 旧聚合文档 / 空库：写入 { assets }，不主动改成分条（避免破坏可读性）
    let created: ProjectAsset | null = null;
    const result = await handle.enqueueMutate((prev) => {
      const assets = isLegacyAssetDoc(prev) ? prev.assets.filter(isValidAsset) : [];
      const dup = assets.find((a) => sameAsset(a, input));
      if (dup) {
        created = dup;
        return null;
      }
      created = asset;
      return { assets: [asset, ...assets].slice(0, 200) };
    });
    if (!created) {
      throw new Error('素材写入失败');
    }
    if (result.status === 'failed') {
      throw new Error('素材写入失败（本地存储可能已满）');
    }
    return created;
  });
}

export async function upsertAssets(inputs: UpsertAssetInput[]): Promise<ProjectAsset[]> {
  const out: ProjectAsset[] = [];
  for (const input of inputs) {
    out.push(await upsertAsset(input));
  }
  return out;
}

export async function clearAssets(projectId: string): Promise<SaveStatus | void> {
  const raw = await rootHandle(projectId).load((d) => d as AssetsRoot);
  if (isAssetIndex(raw)) {
    for (const id of raw.ids) {
      await assetHandle(projectId, id).enqueueClear();
    }
  }
  await rootHandle(projectId).enqueueClear();
}
