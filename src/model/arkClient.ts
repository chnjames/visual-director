/**
 * 浏览器侧模型客户端：只调用同源代理 /api/ark/chat。
 * - API Key 仅放在请求头 x-ark-api-key，不进 URL、不进请求体、不进日志；
 * - 随请求下发协议、可改 Base URL（代理侧做官方主机白名单校验）与分级超时；
 * - 失败、超时、非法 JSON、Schema 违规都转为安全的 SafeError，绝不抛进 UI；
 * - 原始模型文本与解析结果分开保存。
 */
import {
  PROXY_PATH,
  IMAGES_PROXY_PATH,
  ARK_IMAGE_DEFAULT_BASE_URL,
  ARK_REQUEST_TIMEOUT_MS,
  ARK_TEST_TIMEOUT_MS,
  ARK_PROBE_TIMEOUT_MS,
  ARK_IMAGE_TIMEOUT_MS,
  ARK_MAX_TIMEOUT_MS,
} from '../shared/constants';
import {
  buildSafeDiagnostics,
  createSafeError,
  imageApiKeyOf,
  isImageConfigured,
  isTextConfigured,
  isValidBaseUrl,
  isValidEndpoint,
  maskEndpoint,
  textApiKeyOf,
} from '../shared/security';
import type {
  ModelSettings,
  ProbeKind,
  ProbeOutcome,
  RawModelCall,
  SafeDiagnostics,
  SafeError,
  UploadedImage,
} from '../shared/types';
import type { ChatMessage } from './prompts';
import { extractJson } from './parseJson';

type ProxySuccess = {
  ok: true;
  content: string;
  requestId?: string;
  diagnostics: SafeDiagnostics;
};

/** 客户端比服务端超时多 15s 缓冲，确保先收到服务端规范的 504，而不是浏览器先 abort */
const CLIENT_TIMEOUT_GRACE_MS = 15_000;

async function postToProxy(
  settings: ModelSettings,
  messages: ChatMessage[],
  opts: { maxTokens?: number; jsonMode?: boolean; timeoutMs?: number } = {},
): Promise<
  | { ok: true; status: number; body: ProxySuccess }
  | { ok: false; status: number; error: SafeError }
> {
  const serverTimeout = opts.timeoutMs ?? ARK_REQUEST_TIMEOUT_MS;
  const clientTimeout = Math.min(
    ARK_MAX_TIMEOUT_MS + CLIENT_TIMEOUT_GRACE_MS,
    serverTimeout + CLIENT_TIMEOUT_GRACE_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clientTimeout);
  const baseDiag = () =>
    buildSafeDiagnostics({
      model: settings.seedEndpoint,
      endpointMasked: maskEndpoint(settings.seedEndpoint),
      protocol: settings.protocol,
    });

  const apiKey = textApiKeyOf(settings);
  let res: Response;
  try {
    res = await fetch(PROXY_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [API_KEY_HEADER]: apiKey,
      },
      body: JSON.stringify({
        model: settings.seedEndpoint,
        protocol: settings.protocol,
        baseUrl: settings.baseUrl,
        timeoutMs: serverTimeout,
        messages,
        temperature: 0.2,
        ...(opts.jsonMode === false
          ? {}
          : { response_format: { type: 'json_object' } }),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === 'AbortError';
    const error = createSafeError(
      aborted ? 'timeout' : 'network',
      aborted
        ? `客户端等待超时（>${clientTimeout}ms）`
        : `无法连接本地代理：${(err as Error)?.message ?? '网络错误'}`,
      baseDiag(),
      apiKey,
    );
    return { ok: false, status: 0, error };
  }
  clearTimeout(timer);

  let json: any;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      status: res.status,
      error: createSafeError('illegal-json', '代理返回了无法解析的响应', baseDiag()),
    };
  }

  if (res.ok && json?.ok === true) {
    return { ok: true, status: res.status, body: json as ProxySuccess };
  }

  // 代理已返回脱敏 SafeError，直接采用其分类
  const error: SafeError = {
    ok: false,
    errorClass: json?.errorClass ?? 'unknown',
    message: typeof json?.message === 'string' ? json.message : `请求失败 HTTP ${res.status}`,
    diagnostics: json?.diagnostics ?? baseDiag(),
  };
  return { ok: false, status: res.status, error };
}

const API_KEY_HEADER = 'x-ark-api-key';

/**
 * 通用探针执行器：调用模型 → 提取 JSON → Schema 装配。
 * assemble 负责把任意 JSON 校验/装配为 T，非法时应抛 z.ZodError。
 */
export async function runProbe<T>(
  kind: ProbeKind,
  settings: ModelSettings | null,
  messages: ChatMessage[],
  assemble: (raw: unknown) => T,
): Promise<ProbeOutcome<T>> {
  if (!isTextConfigured(settings)) {
    return {
      ok: false,
      errorClass: 'not-configured',
      message: '尚未配置文本模型：请填写文本通道的 API Key 和 Endpoint',
      diagnostics: buildSafeDiagnostics({ model: '(none)', endpointMasked: '(none)' }),
    };
  }
  if (!isValidEndpoint(settings.seedEndpoint)) {
    return {
      ok: false,
      errorClass: 'illegal-endpoint',
      message: 'Endpoint 不合法：只允许模型/接入点 ID，不允许填写 URL 或路径',
      diagnostics: baseDiagOf(settings),
    };
  }
  if (!isValidBaseUrl(settings.baseUrl)) {
    return {
      ok: false,
      errorClass: 'illegal-endpoint',
      message: 'Base URL 不合法：仅允许火山方舟官方 https 域名（.volces.com）',
      diagnostics: baseDiagOf(settings),
    };
  }

  const startedAt = new Date().toISOString();
  const result = await postToProxy(settings, messages, { timeoutMs: ARK_PROBE_TIMEOUT_MS });
  const finishedAt = new Date().toISOString();

  if (!result.ok) {
    return result.error;
  }

  const { content, diagnostics } = result.body;
  const raw: RawModelCall = {
    kind,
    startedAt,
    finishedAt,
    httpStatus: result.status,
    rawContent: content,
    diagnostics,
  };

  const extracted = extractJson(content);
  if (!extracted.ok) {
    return {
      ...createSafeError('illegal-json', extracted.message, diagnostics),
      raw,
    };
  }

  try {
    const data = assemble(extracted.value);
    return { ok: true, raw, data };
  } catch (e) {
    // ZodError：Schema 违规，明确拒绝，绝不伪装成功
    const issues = formatSchemaError(e);
    return {
      ...createSafeError(
        'schema-violation',
        `模型输出未通过 Schema 校验：${issues.join('；')}`,
        diagnostics,
      ),
      raw,
    };
  }
}

function formatSchemaError(e: unknown): string[] {
  const issues = (e as { issues?: Array<{ path?: Array<string | number>; message: string }> })
    ?.issues;
  if (Array.isArray(issues)) {
    return issues.map((i) => {
      const p = Array.isArray(i.path) && i.path.length ? `${i.path.join('.')}: ` : '';
      return `${p}${i.message}`;
    });
  }
  return [(e as Error)?.message ?? 'Schema 校验失败'];
}

function baseDiagOf(settings: ModelSettings): SafeDiagnostics {
  return buildSafeDiagnostics({
    model: settings.seedEndpoint,
    endpointMasked: maskEndpoint(settings.seedEndpoint),
    protocol: settings.protocol,
  });
}

/**
 * 测试连接：发送一次最小 chat 请求（max_tokens=1），
 * 只回传脱敏结果，不回传 Key 或响应正文。
 */
export async function testConnection(
  settings: ModelSettings,
): Promise<{ ok: true; diagnostics: SafeDiagnostics } | SafeError> {
  if (!isTextConfigured(settings)) {
    return createSafeError(
      'not-configured',
      '请先填写文本通道的 API Key 和 Endpoint',
      baseDiagOf(settings),
    );
  }
  if (!isValidEndpoint(settings.seedEndpoint)) {
    return createSafeError(
      'illegal-endpoint',
      'Endpoint 不合法：只允许模型/接入点 ID，不允许填写 URL 或路径',
      baseDiagOf(settings),
    );
  }
  if (!isValidBaseUrl(settings.baseUrl)) {
    return createSafeError(
      'illegal-endpoint',
      'Base URL 不合法：仅允许火山方舟官方 https 域名（.volces.com）',
      baseDiagOf(settings),
    );
  }
  const result = await postToProxy(
    settings,
    [{ role: 'user', content: 'ping' }],
    { maxTokens: 1, jsonMode: false, timeoutMs: ARK_TEST_TIMEOUT_MS },
  );
  // 最小请求可能因 max_tokens 等返回业务错误，这里仅用于连通性判断
  if (result.ok) return { ok: true, diagnostics: result.body.diagnostics };
  return result.error;
}

/* ----------------------- 图片生成（阶段2） ----------------------- */

export type ImageGenerateResult =
  | {
      ok: true;
      /** 首图兼容字段；新代码应优先读取 images。 */
      b64Json: string;
      mediaType: string;
      images?: Array<{ b64Json: string; mediaType: string }>;
      diagnostics: SafeDiagnostics;
    }
  | SafeError;

export type ImageGenerateOptions = {
  size?: string;
  count?: number;
  productImages?: UploadedImage[];
  timeoutMs?: number;
};

/**
 * 调用图片生成（OpenAI 兼容 /images/generations，经同源代理）。
 * - 只使用已配置的图片 Endpoint；Key 仍只在请求头；
 * * - 强制 b64_json，代理不跟随外部 URL；
 * - 负向约束已折叠进 prompt 文本（不依赖兼容性不确定的 negative_prompt）。
 */
export async function generateImage(
  settings: ModelSettings | null,
  prompt: string,
  opts: ImageGenerateOptions = {},
): Promise<ImageGenerateResult> {
  const imageApiKey = imageApiKeyOf(settings);
  if (!settings || !imageApiKey) {
    return createSafeError(
      'not-configured',
      '尚未配置图片生成 API Key，当前为等待或只读样例状态',
      buildSafeDiagnostics({ model: '(none)', endpointMasked: '(none)' }),
    );
  }
  if (!isImageConfigured(settings)) {
    return createSafeError(
      'not-configured',
      '尚未配置图片生成 Endpoint，请在模型设置中填写（如 Seedream 接入点/模型 ID）',
      buildSafeDiagnostics({ model: '(none)', endpointMasked: '(none)' }),
    );
  }
  if (!isValidEndpoint(settings.imageEndpoint)) {
    return createSafeError(
      'illegal-endpoint',
      '图片 Endpoint 不合法：只允许模型/接入点 ID，不允许 URL 或路径',
      buildSafeDiagnostics({
        model: settings.imageEndpoint,
        endpointMasked: maskEndpoint(settings.imageEndpoint),
      }),
    );
  }
  const imageBaseUrl = settings.imageBaseUrl || ARK_IMAGE_DEFAULT_BASE_URL;
  if (!isValidBaseUrl(imageBaseUrl)) {
    return createSafeError(
      'illegal-endpoint',
      '图片 Base URL 不合法：仅允许火山方舟官方 https 域名（.volces.com）',
      buildSafeDiagnostics({
        model: settings.imageEndpoint,
        endpointMasked: maskEndpoint(settings.imageEndpoint),
      }),
    );
  }

  const serverTimeout = Math.min(opts.timeoutMs ?? ARK_IMAGE_TIMEOUT_MS, ARK_MAX_TIMEOUT_MS);
  const clientTimeout = serverTimeout + 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clientTimeout);

  let res: Response;
  try {
    res = await fetch(IMAGES_PROXY_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [API_KEY_HEADER]: imageApiKey,
      },
      body: JSON.stringify({
        imageEndpoint: settings.imageEndpoint,
        protocol: settings.protocol,
        imageBaseUrl,
        prompt,
        timeoutMs: serverTimeout,
        ...(opts.size ? { size: opts.size } : {}),
        ...(opts.count ? { count: opts.count } : {}),
        ...(opts.productImages?.length
          ? { images: opts.productImages.map((image) => image.dataUri) }
          : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === 'AbortError';
    return createSafeError(
      aborted ? 'timeout' : 'network',
      aborted
        ? `客户端等待超时（>${clientTimeout}ms）`
        : `无法连接本地图片代理：${(err as Error)?.message ?? '网络错误'}`,
      buildSafeDiagnostics({
        model: settings.imageEndpoint,
        endpointMasked: maskEndpoint(settings.imageEndpoint),
      }),
      imageApiKey,
    );
  }
  clearTimeout(timer);

  let json: any;
  try {
    json = await res.json();
  } catch {
    return createSafeError(
      'illegal-json',
      '图片代理返回了无法解析的响应',
      buildSafeDiagnostics({
        model: settings.imageEndpoint,
        endpointMasked: maskEndpoint(settings.imageEndpoint),
      }),
    );
  }
  if (res.ok && json?.ok === true && typeof json?.b64Json === 'string') {
    const images = Array.isArray(json.images)
      ? json.images.filter(
          (image: unknown): image is { b64Json: string; mediaType: string } =>
            !!image &&
            typeof image === 'object' &&
            typeof (image as { b64Json?: unknown }).b64Json === 'string' &&
            typeof (image as { mediaType?: unknown }).mediaType === 'string',
        )
      : [{ b64Json: json.b64Json, mediaType: json.mediaType ?? 'image/png' }];
    return {
      ok: true,
      b64Json: json.b64Json,
      mediaType: typeof json.mediaType === 'string' ? json.mediaType : 'image/png',
      images,
      diagnostics: json.diagnostics,
    };
  }
  return {
    ok: false,
    errorClass: json?.errorClass ?? 'unknown',
    message: typeof json?.message === 'string' ? json.message : `图片生成失败 HTTP ${res.status}`,
    diagnostics: json?.diagnostics ?? buildSafeDiagnostics({
      model: settings.imageEndpoint,
      endpointMasked: maskEndpoint(settings.imageEndpoint),
    }),
  };
}
