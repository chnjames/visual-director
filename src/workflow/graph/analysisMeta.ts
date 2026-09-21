/**
 * 参考图分析元数据：图型角色 + 混传冲突提示。
 * 模型可返回 meta；失败时用用途关键词启发式兜底，不阻断配方本身。
 */
import type { UploadedImage, VisualRecipe } from '../../shared/types';

export type ImageRoleKind =
  | 'main-white'
  | 'main-scene'
  | 'main-feature'
  | 'detail-hero'
  | 'detail-scene'
  | 'detail-closeup'
  | 'other'
  | 'hero'
  | 'detail'
  | 'mixed'
  | 'unknown';

export type ImageRole = {
  sourceId: string;
  role: ImageRoleKind;
  confidence?: number;
  note?: string;
};

export type ReferenceAnalysisMeta = {
  imageRoles: ImageRole[];
  conflictHint: string;
  purposeBucket: 'hero' | 'detail' | 'custom' | 'unknown';
  suggestedTargetUse?: string;
};

export function emptyAnalysisMeta(): ReferenceAnalysisMeta {
  return { imageRoles: [], conflictHint: '', purposeBucket: 'unknown' };
}

export function purposeBucketOf(purpose: string): ReferenceAnalysisMeta['purposeBucket'] {
  const p = purpose.trim();
  if (!p) return 'unknown';
  if (p === 'detail-hero' || p === 'detail-scene' || p === 'detail-closeup') return 'detail';
  if (p === 'main-white' || p === 'main-scene' || p === 'main-feature' || p === 'social') return 'hero';
  if (/详情|首屏|规格|参数|卖点图|使用场景/.test(p) && /主图|白底/.test(p)) return 'custom';
  if (/详情|规格|参数|尺码|配件|售后/.test(p)) return 'detail';
  if (/主图|白底|场景展示|卖点\/特写|卖点特写|社媒/.test(p)) return 'hero';
  return 'custom';
}

/** 不依赖模型的启发式：用途桶 + 多图时提醒可能混传 */
export function heuristicAnalysisMeta(
  purpose: string,
  images: UploadedImage[],
  recipe?: VisualRecipe | null,
): ReferenceAnalysisMeta {
  const purposeBucket = purposeBucketOf(purpose);
  const imageRoles: ImageRole[] = images.map((img) => ({
    sourceId: img.id,
    role: purposeBucket === 'detail' ? 'detail' : purposeBucket === 'hero' ? 'hero' : 'unknown',
  }));

  let conflictHint = '';
  if (images.length >= 3 && purposeBucket === 'custom') {
    conflictHint = '参考图较多且用途较宽，若同时含主图与详情页风格，建议拆成两次分析或去掉冲突图。';
  } else if (images.length >= 2 && purposeBucket === 'unknown') {
    conflictHint = '未选择明确用途。若参考图里混有主图与详情页，分析出的配方可能偏乱，建议先选用途预设。';
  } else if (recipe) {
    const avg =
      recipe.fields.reduce((s, f) => s + (f.confidence ?? 0), 0) / Math.max(1, recipe.fields.length);
    if (avg < 0.55 && images.length >= 2) {
      conflictHint = '字段置信度偏低，参考图风格可能不一致；可减少张数或按主图/详情分开分析。';
    }
  }

  return { imageRoles, conflictHint, purposeBucket };
}

export function parseAnalysisMeta(raw: unknown, images: UploadedImage[]): ReferenceAnalysisMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const meta = (raw as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as {
    imageRoles?: unknown;
    conflictHint?: unknown;
    purposeBucket?: unknown;
    suggestedTargetUse?: unknown;
  };
  const allowed: ImageRoleKind[] = [
    'main-white',
    'main-scene',
    'main-feature',
    'detail-hero',
    'detail-scene',
    'detail-closeup',
    'other',
    'hero',
    'detail',
    'mixed',
    'unknown',
  ];
  const imageRoles: ImageRole[] = Array.isArray(m.imageRoles)
    ? m.imageRoles.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const row = item as { sourceId?: unknown; role?: unknown; note?: unknown; confidence?: unknown };
        const sourceId = typeof row.sourceId === 'string' ? row.sourceId : '';
        if (!sourceId || !images.some((img) => img.id === sourceId)) return [];
        const role = allowed.includes(row.role as ImageRoleKind) ? (row.role as ImageRoleKind) : 'unknown';
        return [
          {
            sourceId,
            role,
            note: typeof row.note === 'string' ? row.note : undefined,
            confidence: typeof row.confidence === 'number' ? row.confidence : undefined,
          },
        ];
      })
    : [];
  return {
    imageRoles,
    conflictHint: typeof m.conflictHint === 'string' ? m.conflictHint : '',
    purposeBucket:
      m.purposeBucket === 'hero' ||
      m.purposeBucket === 'detail' ||
      m.purposeBucket === 'custom' ||
      m.purposeBucket === 'unknown'
        ? m.purposeBucket
        : 'unknown',
    suggestedTargetUse: typeof m.suggestedTargetUse === 'string' ? m.suggestedTargetUse : undefined,
  };
}

export function mergeAnalysisMeta(
  fallback: ReferenceAnalysisMeta,
  fromModel: ReferenceAnalysisMeta | null,
): ReferenceAnalysisMeta {
  if (!fromModel) return fallback;
  const roles = fromModel.imageRoles.length ? fromModel.imageRoles : fallback.imageRoles;
  let conflictHint = fromModel.conflictHint || fallback.conflictHint;
  const hasHero = roles.some((r) => r.role === 'hero' || r.role.startsWith('main-'));
  const hasDetail = roles.some((r) => r.role === 'detail' || r.role.startsWith('detail-'));
  if (!conflictHint && hasHero && hasDetail) {
    conflictHint = '参考图同时含主图与详情风格，分析出的画面规则可能互相打架，建议拆开分析。';
  }
  return {
    imageRoles: roles,
    conflictHint,
    purposeBucket: fromModel.purposeBucket !== 'unknown' ? fromModel.purposeBucket : fallback.purposeBucket,
    suggestedTargetUse: fromModel.suggestedTargetUse ?? fallback.suggestedTargetUse,
  };
}
