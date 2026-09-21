/**
 * 全局常量：产品合同中的固定枚举、数量边界、模型与权重配置。
 * 这些是确定性产品规则，模型输出不得改变它们。
 */

/** 火山方舟支持的两种接口协议 */
export type ArkProtocol = 'openai' | 'anthropic';

/**
 * 各协议的默认 Base URL（可在模型设置中修改）。
 * 浏览器直连需用平台地址（/api/v3）；Agent Plan（/api/plan）在浏览器里会拦鉴权头。
 * - OpenAI 兼容：{base}/chat/completions
 * - Anthropic 兼容：{base}/v1/messages
 */
export const ARK_DEFAULT_BASE_URLS: Record<ArkProtocol, string> = {
  openai: 'https://ark.cn-beijing.volces.com/api/v3',
  anthropic: 'https://ark.cn-beijing.volces.com/api/v3',
};

/** 火山方舟 Platform 图片生成接口默认基址。 */
export const ARK_IMAGE_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
/** 当前商品图主流程推荐并完成参数适配的模型版本。 */
export const SEEDREAM_5_MODEL_ID = 'doubao-seedream-5-0-260128';

/** 各协议在 Base URL 之后拼接的请求路径 */
export const ARK_API_PATHS: Record<ArkProtocol, string> = {
  openai: '/chat/completions',
  anthropic: '/v1/messages',
};

/** Anthropic 协议要求的版本头 */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 允许的目标主机后缀白名单（SSRF 防护）：
 * Base URL 可修改，但主机仍限定为火山引擎/方舟官方域名，且必须 https。
 */
export const ARK_ALLOWED_HOST_SUFFIXES = ['volces.com', '.volces.com'] as const;

/** 浏览器 → 同构代理的同源路径（对话/视觉理解） */
export const PROXY_PATH = '/api/ark/chat';
/** 浏览器 → 同构代理的同源路径（图片生成，阶段2） */
export const IMAGES_PROXY_PATH = '/api/ark/images';

/** OpenAI 兼容图片生成接口在 Base URL 之后拼接的路径 */
export const ARK_IMAGE_PATH = '/images/generations';
/** 图片生成通常比视觉理解更慢，给足上限内的超时 */
export const ARK_IMAGE_TIMEOUT_MS = 180_000;

/**
 * 图片生成只走 OpenAI 兼容面（Anthropic 无图片生成接口）。
 * 依据 OpenAI 兼容 Base URL 拼接最终图片生成地址。
 */
export function buildArkImageUrl(openaiBaseUrl: string): string {
  const trimmed = openaiBaseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith(ARK_IMAGE_PATH)) return trimmed;
  return `${trimmed}${ARK_IMAGE_PATH}`;
}

/** 把任意协议设置解析为用于图片生成的 OpenAI 兼容 Base URL */
export function resolveOpenaiBaseUrl(_protocol: ArkProtocol, imageBaseUrl: string): string {
  return imageBaseUrl.trim() || ARK_IMAGE_DEFAULT_BASE_URL;
}

/**
 * 超时（毫秒）。探针要带 1-5 张图并生成长 JSON，明显比“测试连接”慢，因此分级：
 * - 测试连接（1 token 文本探测）用较短超时；
 * - 探针用较长超时；
 * - 服务端对客户端传入的超时做上下限钳制，避免无限挂起或被设成极端值。
 */
export const ARK_TEST_TIMEOUT_MS = 30_000;
export const ARK_PROBE_TIMEOUT_MS = 180_000;
export const ARK_MIN_TIMEOUT_MS = 5_000;
export const ARK_MAX_TIMEOUT_MS = 180_000;
/** 代理默认超时（毫秒），超时归类为 timeout，不无限挂起 */
export const ARK_REQUEST_TIMEOUT_MS = 120_000;

/** 钳制客户端请求的超时到允许区间，非数字回落到默认值 */
export function clampTimeoutMs(value: unknown, fallback: number = ARK_REQUEST_TIMEOUT_MS): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(ARK_MAX_TIMEOUT_MS, Math.max(ARK_MIN_TIMEOUT_MS, Math.round(n)));
}

/** 依据协议与（可能被用户修改过的）Base URL 拼接最终上游地址。已带接口路径时不再重复拼接。 */
export function buildArkUpstreamUrl(protocol: ArkProtocol, baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const path = ARK_API_PATHS[protocol];
  if (trimmed.endsWith(path)) return trimmed;
  return `${trimmed}${path}`;
}

/** 12 个视觉配方字段键（顺序即产品合同，不可增减） */
export const RECIPE_FIELD_KEYS = [
  'subjectPlacement',
  'subjectScale',
  'cameraAngle',
  'shotAndDepth',
  'composition',
  'backgroundType',
  'environmentElements',
  'lightDirection',
  'lightQuality',
  'palette',
  'materialRendering',
  'mood',
] as const;

/** 字段中文标签，仅用于界面展示，不进入模型合同 */
export const RECIPE_FIELD_LABELS: Record<string, string> = {
  subjectPlacement: '主体位置',
  subjectScale: '主体比例',
  cameraAngle: '机位角度',
  shotAndDepth: '景别与景深',
  composition: '构图方式',
  backgroundType: '背景类型',
  environmentElements: '环境元素',
  lightDirection: '光线方向',
  lightQuality: '光线质感',
  palette: '色彩方案',
  materialRendering: '材质表现',
  mood: '氛围情绪',
};

export const IDENTITY_CATEGORIES = [
  'shape',
  'part',
  'color',
  'material',
  'logo',
  'texture',
] as const;

export const IDENTITY_CATEGORY_LABELS: Record<string, string> = {
  shape: '形状',
  part: '部件',
  color: '颜色',
  material: '材质',
  logo: 'Logo',
  texture: '纹理',
};

/** 数量边界 */
export const LIMITS = {
  referenceImagesMin: 1,
  referenceImagesMax: 5,
  identityImagesMin: 2,
  identityImagesMax: 3,
  auditCandidateImages: 1,
} as const;

/** 验收维度权重（产品规则，待实验校准，非行业标准） */
export const AUDIT_WEIGHTS = {
  identity: 0.4,
  recipe: 0.3,
  task: 0.2,
  technical: 0.1,
} as const;

export const AUDIT_THRESHOLDS = {
  pass: 80,
  warn: 60,
} as const;

/** Endpoint / 模型 ID 允许字符白名单（不含 / : ? 等，防止借该字段注入任意地址/头/命令） */
export const ENDPOINT_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
