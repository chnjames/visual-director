/**
 * 浏览器侧模型客户端：直接请求模型设置里的 Base URL。
 * - 文本：{baseUrl}/chat/completions 或 Anthropic {baseUrl}/v1/messages
 * - 图片：{imageBaseUrl}/images/generations
 * - API Key 只放在鉴权头（Bearer 或 x-api-key），不进 URL、不进请求体、不进日志；
 * - Base URL 仍限火山方舟官方 https 域名；
 * - 失败、超时、非法 JSON、Schema 违规都转为安全的 SafeError，绝不抛进 UI。
 */
import {
  ANTHROPIC_VERSION,
  ARK_IMAGE_DEFAULT_BASE_URL,
  ARK_IMAGE_TIMEOUT_MS,
  ARK_MAX_TIMEOUT_MS,
  ARK_PROBE_TIMEOUT_MS,
  ARK_REQUEST_TIMEOUT_MS,
  ARK_TEST_TIMEOUT_MS,
  buildArkImageUrl,
  buildArkUpstreamUrl,
} from '../shared/constants';
import {
  buildSafeDiagnostics,
  classifyHttpStatus,
  createSafeError,
  describeNetworkFailure,
  imageApiKeyOf,
  isImageConfigured,
  isTextConfigured,
  isValidBaseUrl,
  isValidEndpoint,
  localizeUpstreamError,
  maskEndpoint,
  redactSecret,
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

const IMAGE_DATA_URI_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/;

function planCorsHint(targetUrl: string): string {
  return targetUrl.includes('/api/plan')
    ? ' 这个 Agent Plan 地址不允许浏览器携带鉴权头。文本 Base URL 请改成 https://ark.cn-beijing.volces.com/api/v3'
    : '';
}

function upstreamErrorMessage(json: unknown, status: number): string {
  const row = json as { error?: { message?: unknown }; message?: unknown } | null;
  if (typeof row?.error?.message === 'string' && row.error.message) return row.error.message;
  if (typeof row?.message === 'string' && row.message) return row.message;
  return `上游返回 HTTP ${status}`;
}

function readChatContent(protocol: ModelSettings['protocol'], json: unknown): string {
  const row = json as {
    choices?: Array<{ message?: { content?: unknown } }>;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (protocol === 'anthropic') {
    return Array.isArray(row?.content)
      ? row.content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('')
      : '';
  }
  const content = row?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function anthropicBlocks(parts: ChatMessage['content']): unknown[] {
  if (typeof parts === 'string') return [{ type: 'text', text: parts }];
  const blocks: unknown[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url' && IMAGE_DATA_URI_RE.test(part.image_url.url)) {
      const media = /^data:([^;,]+);base64,/.exec(part.image_url.url)?.[1] || 'image/png';
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: media === 'image/jpg' ? 'image/jpeg' : media,
          data: part.image_url.url.slice(part.image_url.url.indexOf(',') + 1),
        },
      });
    }
  }
  return blocks;
}

async function postToArk(
  settings: ModelSettings,
  messages: ChatMessage[],
  opts: { maxTokens?: number; jsonMode?: boolean; timeoutMs?: number } = {},
): Promise<
  | { ok: true; status: number; body: ProxySuccess }
  | { ok: false; status: number; error: SafeError }
> {
  const timeoutMs = Math.min(opts.timeoutMs ?? ARK_REQUEST_TIMEOUT_MS, ARK_MAX_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const targetUrl = buildArkUpstreamUrl(settings.protocol, settings.baseUrl);
  const baseDiag = () =>
    buildSafeDiagnostics({
      model: settings.seedEndpoint,
      endpointMasked: maskEndpoint(settings.seedEndpoint),
      protocol: settings.protocol,
      targetUrlMasked: targetUrl,
    });

  const apiKey = textApiKeyOf(settings);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  let payload: Record<string, unknown>;
  if (settings.protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .filter(Boolean)
      .join('\n\n');
    const convo = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content:
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : anthropicBlocks(message.content),
      }))
      .filter((message) => message.content.length > 0);
    payload = {
      model: settings.seedEndpoint,
      max_tokens: opts.maxTokens ?? 4096,
      messages: convo,
      ...(system ? { system } : {}),
    };
  } else {
    headers.authorization = `Bearer ${apiKey}`;
    payload = {
      model: settings.seedEndpoint,
      messages,
      temperature: 0.2,
      ...(opts.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    };
  }

  let res: Response;
  try {
    res = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === 'AbortError';
    const detail = redactSecret(describeNetworkFailure(err), apiKey);
    const error = createSafeError(
      aborted ? 'timeout' : 'network',
      aborted
        ? `模型在 ${(timeoutMs / 1000).toFixed(0)} 秒内未返回。参考图分析较慢，可换更小的参考图、确认文本 Endpoint 可用后再试。`
        : `无法连接 ${targetUrl}：${detail}。${planCorsHint(targetUrl)}`,
      baseDiag(),
      apiKey,
    );
    return { ok: false, status: 0, error };
  }
  clearTimeout(timer);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      status: res.status,
      error: createSafeError(
        'illegal-json',
        `模型返回了无法解析的响应。实际请求 ${targetUrl}（HTTP ${res.status}）`,
        baseDiag(),
        apiKey,
      ),
    };
  }

  if (res.ok) {
    const requestId =
      res.headers.get('x-request-id') ??
      (json as { id?: string })?.id;
    return {
      ok: true,
      status: res.status,
      body: {
        ok: true,
        content: readChatContent(settings.protocol, json),
        requestId: requestId || undefined,
        diagnostics: baseDiag(),
      },
    };
  }

  const errorClass = classifyHttpStatus(res.status);
  const localized = localizeUpstreamError(
    errorClass,
    redactSecret(upstreamErrorMessage(json, res.status), apiKey),
  );
  const error: SafeError = createSafeError(
    errorClass,
    localized.message,
    {
      ...baseDiag(),
      httpStatus: res.status,
      errorClass,
      requestId: localized.requestId,
    },
    apiKey,
  );
  return { ok: false, status: res.status, error };
}

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
  const result = await postToArk(settings, messages, { timeoutMs: ARK_PROBE_TIMEOUT_MS });
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
  const result = await postToArk(
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
 * 调用图片生成：直接 POST 到设置里的图片 Base URL + /images/generations。
 * Key 只放在 Authorization 头；只接受 b64_json，不跟随外部图片 URL。
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

  const timeoutMs = Math.min(opts.timeoutMs ?? ARK_IMAGE_TIMEOUT_MS, ARK_MAX_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const targetUrl = buildArkImageUrl(imageBaseUrl);
  const referenceImages = (opts.productImages ?? [])
    .map((image) => image.dataUri)
    .filter((uri) => IMAGE_DATA_URI_RE.test(uri))
    .slice(0, 10);
  const count = Math.min(4, Math.max(1, opts.count ?? 1));
  const payload: Record<string, unknown> = {
    model: settings.imageEndpoint,
    prompt,
    n: 1,
    output_format: 'png',
    response_format: 'b64_json',
    watermark: false,
  };
  if (referenceImages.length) payload.image = referenceImages;
  if (opts.size && /^\d{2,4}x\d{2,4}$/.test(opts.size)) payload.size = opts.size;
  if (count > 1) {
    payload.sequential_image_generation = 'auto';
    payload.sequential_image_generation_options = { max_images: count };
  }

  const diag = () =>
    buildSafeDiagnostics({
      model: settings.imageEndpoint,
      endpointMasked: maskEndpoint(settings.imageEndpoint),
      protocol: 'openai',
      targetUrlMasked: targetUrl,
    });

  let res: Response;
  try {
    res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${imageApiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === 'AbortError';
    return createSafeError(
      aborted ? 'timeout' : 'network',
      aborted
        ? `图片生成超时（>${timeoutMs}ms）。2K/3K 或多张商品图较慢，可先减商品图数量或降到 1K 后重试。`
        : `无法连接 ${targetUrl}：${redactSecret(describeNetworkFailure(err), imageApiKey)}。${planCorsHint(targetUrl)}`,
      diag(),
      imageApiKey,
    );
  }
  clearTimeout(timer);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return createSafeError(
      'illegal-json',
      `图片接口返回了无法解析的响应。实际请求 ${targetUrl}（HTTP ${res.status}）`,
      diag(),
      imageApiKey,
    );
  }

  const rows = (json as { data?: Array<{ b64_json?: unknown }> })?.data;
  const images = Array.isArray(rows)
    ? rows
        .map((item) => (typeof item?.b64_json === 'string' ? item.b64_json : ''))
        .filter(Boolean)
        .map((b64Json) => ({ b64Json, mediaType: 'image/png' }))
    : [];
  if (res.ok && images.length) {
    return {
      ok: true,
      b64Json: images[0].b64Json,
      mediaType: 'image/png',
      images,
      diagnostics: diag(),
    };
  }

  const errorClass = res.ok ? 'server' : classifyHttpStatus(res.status);
  const rawMessage = res.ok
    ? '图片接口未返回 b64_json'
    : upstreamErrorMessage(json, res.status);
  const localized = localizeUpstreamError(errorClass, rawMessage);
  return createSafeError(
    errorClass,
    redactSecret(localized.message, imageApiKey),
    { ...diag(), httpStatus: res.status, errorClass, requestId: localized.requestId },
    imageApiKey,
  );
}
