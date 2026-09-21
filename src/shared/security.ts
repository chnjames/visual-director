/**
 * 安全模块：
 * - API Key / Endpoint 仅允许进入 sessionStorage，关闭标签页即清除；
 * - 提供脱敏与安全诊断构造，保证 Key、完整请求头、敏感内容不进日志；
 * - Endpoint 仅允许白名单字符，模型/客户端不能借此指定任意地址。
 */
import {
  ARK_ALLOWED_HOST_SUFFIXES,
  ARK_DEFAULT_BASE_URLS,
  ARK_IMAGE_DEFAULT_BASE_URL,
  ENDPOINT_PATTERN,
  type ArkProtocol,
} from './constants';
import type { ModelErrorClass, ModelSettings, SafeDiagnostics, SafeError } from './types';

const SETTINGS_STORAGE_KEY = 'vrp.modelSettings.v1';

function normalizeProtocol(p: unknown): ArkProtocol {
  return p === 'anthropic' ? 'anthropic' : 'openai';
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/** 用协议默认值补齐设置（旧版本只有一把 apiKey 时，同时填入图片/文本通道） */
function withDefaults(raw: Partial<ModelSettings>): ModelSettings {
  const protocol = normalizeProtocol(raw.protocol);
  const shared = trimmedString(raw.apiKey) ?? '';
  const imageApiKey = trimmedString(raw.imageApiKey) ?? shared;
  const textApiKey = trimmedString(raw.textApiKey) ?? shared;
  return {
    apiKey: imageApiKey || textApiKey,
    imageApiKey,
    textApiKey,
    seedEndpoint: trimmedString(raw.seedEndpoint) ?? '',
    imageEndpoint: trimmedString(raw.imageEndpoint) ?? '',
    imageBaseUrl:
      typeof raw.imageBaseUrl === 'string' && raw.imageBaseUrl.trim()
        ? raw.imageBaseUrl.trim()
        : ARK_IMAGE_DEFAULT_BASE_URL,
    protocol,
    baseUrl:
      typeof raw.baseUrl === 'string' && raw.baseUrl.trim()
        ? raw.baseUrl.trim()
        : ARK_DEFAULT_BASE_URLS[protocol],
  };
}

/** 图片通道实际使用的 Key：优先 imageApiKey，旧数据回落到 apiKey。 */
export function imageApiKeyOf(settings: ModelSettings | null | undefined): string {
  if (!settings) return '';
  return (settings.imageApiKey || settings.apiKey || '').trim();
}

/** 文本通道实际使用的 Key：优先 textApiKey，旧数据回落到 apiKey。 */
export function textApiKeyOf(settings: ModelSettings | null | undefined): string {
  if (!settings) return '';
  return (settings.textApiKey || settings.apiKey || '').trim();
}

export function isImageConfigured(settings: ModelSettings | null | undefined): settings is ModelSettings {
  return !!settings && imageApiKeyOf(settings).length > 0 && settings.imageEndpoint.trim().length > 0;
}

export function isTextConfigured(settings: ModelSettings | null | undefined): settings is ModelSettings {
  return !!settings && textApiKeyOf(settings).length > 0 && settings.seedEndpoint.trim().length > 0;
}

/* ------------------------- 会话级设置存储 ------------------------- */

function sessionStorageAvailable(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as any).sessionStorage) {
      return (globalThis as any).sessionStorage as Storage;
    }
  } catch {
    /* 隐私模式等场景下访问可能抛错，退化为内存存储 */
  }
  return null;
}

/** 非持久的内存兜底，绝不写入 localStorage / IndexedDB / Cookie */
let memoryFallback: ModelSettings | null = null;

export function saveModelSettings(settings: ModelSettings): void {
  const trimmed = withDefaults({
    apiKey: settings.apiKey.trim(),
    imageApiKey: settings.imageApiKey,
    textApiKey: settings.textApiKey,
    seedEndpoint: settings.seedEndpoint.trim(),
    imageEndpoint: settings.imageEndpoint.trim(),
    imageBaseUrl: settings.imageBaseUrl?.trim(),
    protocol: settings.protocol,
    baseUrl: settings.baseUrl.trim(),
  });
  const s = sessionStorageAvailable();
  if (s) {
    s.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(trimmed));
  } else {
    memoryFallback = trimmed;
  }
}

export function loadModelSettings(): ModelSettings | null {
  const s = sessionStorageAvailable();
  try {
    if (s) {
      const raw = s.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<ModelSettings>;
      if (
        typeof parsed.apiKey === 'string' ||
        typeof parsed.imageApiKey === 'string' ||
        typeof parsed.textApiKey === 'string'
      ) {
        return withDefaults(parsed);
      }
      return null;
    }
  } catch {
    return memoryFallback;
  }
  return memoryFallback;
}

export function clearModelSettings(): void {
  memoryFallback = null;
  const s = sessionStorageAvailable();
  if (s) s.removeItem(SETTINGS_STORAGE_KEY);
}

export function hasConfiguredKey(): boolean {
  const m = loadModelSettings();
  return isImageConfigured(m) || isTextConfigured(m);
}

/* ------------------------------ 脱敏 ------------------------------ */

export function maskApiKey(key: string): string {
  if (!key) return '(empty)';
  const tail = key.slice(-4);
  return `••••••••${tail ? tail.padStart(4, '•') : ''}`;
}

export function maskEndpoint(endpoint: string): string {
  if (!endpoint) return '(empty)';
  if (endpoint.length <= 10) return `${endpoint.slice(0, 2)}***`;
  return `${endpoint.slice(0, 6)}…${endpoint.slice(-4)}`;
}

/**
 * 把任意文本中出现的密钥替换为 [REDACTED]，
 * 供日志/错误信息在输出前做最后一道防线。
 */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'g'), '[REDACTED]');
}

/**
 * 展开 Node fetch / undici 的 cause 链，把 UND_ERR_* / ECONNRESET 等真正原因带给用户。
 * 顶层 message 经常只是无意义的 “fetch failed”。
 */
export function describeNetworkFailure(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (typeof current !== 'object' || seen.has(current)) break;
    seen.add(current);
    const row = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    if (typeof row.code === 'string' && row.code.trim()) parts.push(row.code);
    if (typeof row.message === 'string' && row.message.trim()) parts.push(row.message);
    if (
      typeof row.name === 'string' &&
      row.name.trim() &&
      row.name !== 'Error' &&
      row.name !== 'TypeError'
    ) {
      parts.push(row.name);
    }
    current = row.cause;
  }
  return [...new Set(parts)].join(' · ') || '网络错误';
}

/** 把上游英文错误收成可执行的中文说明，Request id 从正文剥离到 diagnostics。 */
export function localizeUpstreamError(
  errorClass: ModelErrorClass,
  rawMessage: string,
): { message: string; requestId?: string } {
  const requestId = rawMessage.match(/Request id:\s*([A-Za-z0-9]+)/i)?.[1];
  const stripped = rawMessage.replace(/\s*Request id:\s*[A-Za-z0-9]+/gi, '').trim();
  if (errorClass === 'invalid-key') {
    return {
      message:
        '当前 API Key 未被图片接口接受。请使用火山方舟控制台「API Key 管理」创建的 Key，不要使用 Agent Plan / Coding Plan 的 Key。',
      requestId,
    };
  }
  return { message: stripped || rawMessage, requestId };
}

/**
 * 测试/审计辅助：检查密钥是否泄漏到持久存储。
 * 注意：只读取，不写入。返回 true 表示发现泄漏。
 */
export function isSecretPersisted(secret: string): {
  inLocalStorage: boolean;
  inCookie: boolean;
} {
  if (!secret) return { inLocalStorage: false, inCookie: false };
  let inLocalStorage = false;
  let inCookie = false;
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (!k) continue;
        const v = localStorage.getItem(k) ?? '';
        if (v.includes(secret) || k.includes(secret)) {
          inLocalStorage = true;
          break;
        }
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof document !== 'undefined' && document.cookie) {
      inCookie = document.cookie.includes(secret);
    }
  } catch {
    /* ignore */
  }
  return { inLocalStorage, inCookie };
}

/* --------------------------- Endpoint 校验 --------------------------- */

/** Endpoint 仅允许保守字符集；不允许出现完整 URL，避免被引导到任意主机 */
export function isValidEndpoint(endpoint: string): boolean {
  if (!endpoint) return false;
  if (endpoint.includes('http://') || endpoint.includes('https://')) return false;
  return ENDPOINT_PATTERN.test(endpoint.trim());
}

/**
 * 校验可修改的 Base URL：
 * - 必须是合法 https URL；
 * - 主机名必须是火山引擎/方舟官方域名（白名单后缀），阻止指向任意主机（SSRF）；
 * - 不允许携带用户名/密码、查询串或 hash（Base URL 不应包含这些）。
 */
export function isValidBaseUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.search || u.hash) return false;
  return isAllowedHost(u.hostname);
}

/**
 * 主机白名单匹配（防 SSRF，防前缀仿冒）：
 * - 白名单条目以“.”开头（如 `.volces.com`）时做点边界后缀匹配，
 *   只接受其子域（如 ark.cn-beijing.volces.com）；
 * - 不带点的条目（如 `volces.com`）只接受精确相等；
 * 因此 evilvolces.com、volces.com.evil.io 均不得通过——
 * 裸后缀绝不能直接 endsWith，否则会放行同后缀前缀的攻击者域名。
 */
export function isAllowedHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase();
  return ARK_ALLOWED_HOST_SUFFIXES.some((entry) =>
    entry.startsWith('.') ? host.endsWith(entry) : host === entry,
  );
}

/* --------------------------- 错误分类/诊断 --------------------------- */

export function classifyHttpStatus(status: number): ModelErrorClass {
  if (status === 401 || status === 403) return 'invalid-key';
  if (status === 404 || status === 405) return 'endpoint-not-found';
  if (status === 429) return 'quota';
  if (status === 400 || status === 422) return 'bad-request';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * 只允许白名单诊断字段进入 SafeDiagnostics，
 * 从结构上杜绝把 Key、完整请求头、原始请求体放进去。
 */
export function buildSafeDiagnostics(
  partial: Partial<SafeDiagnostics> & { model: string },
): SafeDiagnostics {
  return {
    model: partial.model,
    endpointMasked: partial.endpointMasked ?? maskEndpoint(partial.model),
    protocol: partial.protocol,
    targetUrlMasked: partial.targetUrlMasked,
    requestId: partial.requestId,
    httpStatus: partial.httpStatus,
    errorClass: partial.errorClass,
    durationMs: partial.durationMs,
    promptTokens: partial.promptTokens,
    completionTokens: partial.completionTokens,
    totalTokens: partial.totalTokens,
  };
}

export function createSafeError(
  errorClass: ModelErrorClass,
  message: string,
  diagnostics: SafeDiagnostics,
  secretToStrip?: string,
): SafeError {
  const safeMessage = secretToStrip
    ? redactSecret(message, secretToStrip)
    : message;
  return {
    ok: false,
    errorClass,
    message: safeMessage,
    diagnostics,
  };
}
