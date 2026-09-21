export type PromptProvenance =
  | 'manual'
  | 'reference-analysis'
  | 'optimized'
  | 'workflow'
  | 'batch-override';

export type PromptSpec = {
  positive: string;
  negative: string;
  targetUse: string;
  provenance: PromptProvenance[];
  updatedAt: string;
};

const TARGET_USE_LABELS: Record<string, string> = {
  'main-white': '电商白底主图，主体完整、背景纯净、轮廓清晰',
  'main-scene': '电商场景主图，第一视觉必须是商品主体',
  'main-feature': '电商卖点主图，突出单一核心卖点',
  'detail-hero': '详情页首屏主视觉，具备品牌氛围与纵深',
  'detail-scene': '详情页使用场景图，表达真实使用语境',
  'detail-closeup': '详情页细节特写，清楚呈现材质与工艺',
  banner: '横幅广告图，预留文案安全区',
  social: '社交媒体图片，构图醒目且适合移动端浏览',
  custom: '自定义用途',
};

export function createPromptSpec(input: {
  positive: string;
  negative?: string;
  targetUse?: string;
  provenance?: PromptProvenance[];
}): PromptSpec {
  return {
    positive: input.positive.trim(),
    negative: input.negative?.trim() ?? '',
    targetUse: input.targetUse ?? 'main-scene',
    provenance: input.provenance?.length ? input.provenance : ['manual'],
    updatedAt: new Date().toISOString(),
  };
}

export function promptTextForGeneration(spec: PromptSpec): string {
  const purpose = TARGET_USE_LABELS[spec.targetUse] ?? spec.targetUse;
  return `${spec.positive}\n\n输出用途：${purpose}`.trim();
}
