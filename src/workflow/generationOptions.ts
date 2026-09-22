export type GenerationOption = {
  value: string;
  label: string;
};

export const TARGET_USE_OPTIONS: GenerationOption[] = [
  { value: 'main-white', label: '主图 · 白底产品' },
  { value: 'main-scene', label: '主图 · 场景展示' },
  { value: 'main-feature', label: '主图 · 卖点特写' },
  { value: 'detail-hero', label: '详情 · 首屏主视觉' },
  { value: 'detail-scene', label: '详情 · 使用场景' },
  { value: 'detail-closeup', label: '详情 · 细节规格' },
  { value: 'banner', label: '营销横幅' },
  { value: 'social', label: '社交媒体图片' },
  { value: 'custom', label: '其他用途' },
];

export const ASPECT_RATIO_OPTIONS: GenerationOption[] = [
  { value: '1:1', label: '1:1 · 方形' },
  { value: '3:4', label: '3:4 · 竖版' },
  { value: '4:3', label: '4:3 · 横版' },
  { value: '16:9', label: '16:9 · 宽屏' },
  { value: '9:16', label: '9:16 · 竖屏' },
];

export const RESOLUTION_OPTIONS: GenerationOption[] = [
  { value: '1K', label: '1K · 快速预览' },
  { value: '2K', label: '2K · 标准输出' },
  { value: '3K', label: '3K · 高清输出' },
];

export type GenerationResolution = '1K' | '2K' | '3K';

export function normalizeGenerationResolution(value: unknown): GenerationResolution {
  const key = String(value ?? '').toUpperCase();
  if (key === '3K') return '3K';
  if (key === '2K') return '2K';
  if (key === '1K' || key === '1024') return '1K';
  return '1K';
}

export function generationOptionLabel(
  options: GenerationOption[],
  value: unknown,
): string {
  const key = String(value ?? '');
  return options.find((option) => option.value === key)?.label ?? key;
}

/** 场景用途：存储英文 key，展示与发给模型时用中文。 */
export function purposeLabel(value: unknown): string {
  const key = String(value ?? '').trim();
  if (!key) return '';
  return generationOptionLabel(TARGET_USE_OPTIONS, key);
}

export function fieldEnumLabel(field: { key: string; dataType?: string }, value: string): string {
  if (field.key === 'purpose' || field.key === 'targetUse') return purposeLabel(value) || value;
  if (field.dataType === 'aspect-ratio' || field.key === 'aspectRatio') {
    return generationOptionLabel(ASPECT_RATIO_OPTIONS, value);
  }
  if (field.dataType === 'resolution' || field.key === 'resolution') {
    return generationOptionLabel(RESOLUTION_OPTIONS, value);
  }
  return value;
}

/** 项目级生成默认值：只作用于之后新加入的商品场景生成节点。 */
export type GenerationDefaults = {
  aspectRatio: string;
  resolution: GenerationResolution;
  count: number;
  targetUse: string;
};

export const DEFAULT_GENERATION_DEFAULTS: GenerationDefaults = {
  aspectRatio: '1:1',
  resolution: '1K',
  count: 1,
  targetUse: 'main-scene',
};

export function normalizeGenerationDefaults(raw: unknown): GenerationDefaults {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const aspectRatio = ASPECT_RATIO_OPTIONS.some((option) => option.value === obj.aspectRatio)
    ? String(obj.aspectRatio)
    : DEFAULT_GENERATION_DEFAULTS.aspectRatio;
  const targetUse = TARGET_USE_OPTIONS.some((option) => option.value === obj.targetUse)
    ? String(obj.targetUse)
    : DEFAULT_GENERATION_DEFAULTS.targetUse;
  const countRaw = Number(obj.count);
  const count = Number.isFinite(countRaw)
    ? Math.min(4, Math.max(1, Math.round(countRaw)))
    : DEFAULT_GENERATION_DEFAULTS.count;
  return {
    aspectRatio,
    resolution: normalizeGenerationResolution(obj.resolution),
    count,
    targetUse,
  };
}

export function generationDefaultsToConfig(
  defaults: GenerationDefaults,
): Record<string, unknown> {
  return {
    aspectRatio: defaults.aspectRatio,
    resolution: defaults.resolution,
    count: defaults.count,
    targetUse: defaults.targetUse,
  };
}
