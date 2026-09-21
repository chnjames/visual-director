/**
 * 核心数据模型（产品合同，对应 docs/03-data-schema.md）。
 * 可补充实现字段，但不得改变核心语义。
 */

export type EvidenceSourceType =
  | 'product-image'
  | 'reference-image'
  | 'user-text';

export type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Evidence = {
  sourceId: string;
  sourceType: EvidenceSourceType;
  region?: Region;
  quote?: string;
  confidence: number;
};

export type RecipeFieldKey =
  | 'subjectPlacement'
  | 'subjectScale'
  | 'cameraAngle'
  | 'shotAndDepth'
  | 'composition'
  | 'backgroundType'
  | 'environmentElements'
  | 'lightDirection'
  | 'lightQuality'
  | 'palette'
  | 'materialRendering'
  | 'mood';

export type RecipeField = {
  key: RecipeFieldKey;
  value: string;
  confidence: number;
  evidence: Evidence[];
  locked: boolean;
};

export type VisualRecipe = {
  id: string;
  name: string;
  fields: RecipeField[];
  required: string[];
  variable: string[];
  forbidden: string[];
  confirmedAt?: string;
};

export type IdentityCategory =
  | 'shape'
  | 'part'
  | 'color'
  | 'material'
  | 'logo'
  | 'texture';

export type FeatureSource = 'model-proposed' | 'user-declared';
export type FeatureStatus = 'pending' | 'confirmed' | 'rejected';
export type Severity = 'critical' | 'major' | 'minor';

export type IdentityFeature = {
  id: string;
  category: IdentityCategory;
  statement: string;
  source: FeatureSource;
  evidence: Evidence[];
  status: FeatureStatus;
  severityIfViolated: Severity;
};

export type AuditStatus = 'passed' | 'warning' | 'failed' | 'needs-review';

export type AuditDimension =
  | 'identity'
  | 'recipe'
  | 'task'
  | 'technical';

export type AuditIssue = {
  dimension: AuditDimension;
  severity: Severity;
  statement: string;
  evidence: Evidence[];
  confidence: number;
};

export type AuditResult = {
  productId: string;
  status: AuditStatus;
  identityScore: number;
  recipeScore: number;
  taskScore: number;
  technicalScore: number;
  compositeScore: number;
  criticalViolation: boolean;
  insufficientEvidence: boolean;
  issues: AuditIssue[];
  modelConfidence: number;
  statusReason: string;
};

/* ------------------------------------------------------------------ */
/* 探针台实现类型                                                      */
/* ------------------------------------------------------------------ */

import type { ArkProtocol } from './constants';

export type ProbeKind = 'recipe' | 'identity' | 'audit' | 'repair';

/** 模型设置（Key 仅允许存于 sessionStorage；Base URL 可改但受主机白名单约束） */
export type ModelSettings = {
  /**
   * 兼容旧数据/旧调用：等于 imageApiKey || textApiKey。
   * 新代码请用 imageApiKey / textApiKey，不要拿这一把 Key 同时打图片和文本。
   */
  apiKey: string;
  /** 图片生成通道 Key（Platform API Key）。缺省时回落到 apiKey。 */
  imageApiKey?: string;
  /** 文本/视觉通道 Key。缺省时回落到 apiKey。 */
  textApiKey?: string;
  seedEndpoint: string;
  /** 图片生成接入点/模型 ID；与文本 Endpoint 分开配置 */
  imageEndpoint: string;
  protocol: ArkProtocol;
  /** 图片生成固定使用 OpenAI 兼容 Platform API，默认 /api/v3。 */
  imageBaseUrl?: string;
  baseUrl: string;
};

/** 脱敏后的安全诊断信息（禁止包含 Key、完整请求头、未脱敏响应） */
export type SafeDiagnostics = {
  requestId?: string;
  endpointMasked: string;
  model: string;
  protocol?: ArkProtocol;
  targetUrlMasked?: string;
  httpStatus?: number;
  errorClass?: ModelErrorClass;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ModelErrorClass =
  | 'invalid-key'
  | 'quota'
  | 'endpoint-not-found'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad-request'
  | 'illegal-json'
  | 'schema-violation'
  | 'not-configured'
  | 'illegal-endpoint'
  | 'unknown';

export type SafeError = {
  ok: false;
  errorClass: ModelErrorClass;
  message: string;
  diagnostics: SafeDiagnostics;
};

/** 一次模型调用：原始输出与解析结果分开保存 */
export type RawModelCall = {
  kind: ProbeKind;
  startedAt: string;
  finishedAt: string;
  httpStatus: number;
  /** 模型返回的原始文本内容（未经解析），用于证据留存 */
  rawContent: string;
  diagnostics: SafeDiagnostics;
};

export type ProbeOutcome<T> =
  | {
      ok: true;
      raw: RawModelCall;
      data: T;
    }
  | SafeError & { raw?: RawModelCall };

/** 上传图片在前端的最小表示 */
export type UploadedImage = {
  id: string;
  /** data: URI，仅在当前会话内存与请求体中使用（上传前已在浏览器端缩放压缩） */
  dataUri: string;
  mediaType: string;
  name: string;
  /** 处理后用于请求的近似字节数 */
  bytes?: number;
  /** 处理后的像素尺寸 */
  width?: number;
  height?: number;
};
