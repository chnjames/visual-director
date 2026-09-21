/**
 * 图片生成同构代理（阶段2）：OpenAI 兼容 /images/generations。
 *
 * 安全合同：
 * - 图片生成只走 OpenAI 兼容面；Anthropic 协议设置下自动改用 OpenAI 兼容基址；
 * - 主机仍限火山官方域名白名单、必须 https（SSRF 防护）；
 * - 仅转发白名单字段（model/prompt/image/size/组图参数），强制 b64_json，
 *   不接受也不回传任意外部图片 URL（避免服务端抓取不可信地址）；
 * - API Key 仅用于 Bearer 头，不记录、不出现在错误/响应；模型输出不决定任何 URL/文件/命令。
 */
import {
  ARK_IMAGE_TIMEOUT_MS,
  IMAGES_PROXY_PATH,
  buildArkImageUrl,
  clampTimeoutMs,
  resolveOpenaiBaseUrl,
  type ArkProtocol,
} from '../shared/constants';
import {
  buildSafeDiagnostics,
  classifyHttpStatus,
  createSafeError,
  describeNetworkFailure,
  localizeUpstreamError,
  isValidBaseUrl,
  isValidEndpoint,
  maskEndpoint,
  redactSecret,
} from '../shared/security';
import type { SafeDiagnostics } from '../shared/types';
import { API_KEY_HEADER } from './arkProxy';

export type ImageProxyDeps = {
  fetchImpl?: typeof fetch;
  onDiagnostic?: (d: SafeDiagnostics) => void;
};

const IMAGE_DATA_URI_RE =
  /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/;
const MAX_REFERENCE_IMAGES = 10;
const MAX_OUTPUT_IMAGES = 4;
/** 官方图片生成 POST 体约 20MB 上限，留出 JSON 字段余量。 */
const MAX_UPSTREAM_BODY_CHARS = 18 * 1024 * 1024;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function fetchUpstreamOnce(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      lastErr = err;
      if ((err as Error)?.name === 'AbortError' || attempt === 1) throw err;
    }
  }
  throw lastErr;
}

export async function handleArkImageRequest(
  request: Request,
  deps: ImageProxyDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const started = Date.now();
  const emit = (d: SafeDiagnostics) => {
    try {
      deps.onDiagnostic?.(d);
    } catch {
      /* noop */
    }
  };
  const diag = (model: string, extra: Partial<SafeDiagnostics> = {}): SafeDiagnostics =>
    buildSafeDiagnostics({ model, endpointMasked: maskEndpoint(model), ...extra });

  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, errorClass: 'bad-request', message: '仅支持 POST' });
  }
  const url = new URL(request.url);
  if (url.pathname !== IMAGES_PROXY_PATH) {
    return jsonResponse(404, { ok: false, errorClass: 'bad-request', message: '未知代理路径' });
  }

  const apiKey = request.headers.get(API_KEY_HEADER)?.trim() ?? '';
  if (!apiKey) {
    return jsonResponse(400, {
      ok: false,
      errorClass: 'not-configured',
      message: '未配置 API Key',
      diagnostics: diag('(none)'),
    });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { ok: false, errorClass: 'bad-request', message: '请求体不是合法 JSON' });
  }

  const protocol: ArkProtocol = body?.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const openaiBase = resolveOpenaiBaseUrl(
    protocol,
    typeof body?.imageBaseUrl === 'string' ? body.imageBaseUrl : '',
  );
  if (!isValidBaseUrl(openaiBase)) {
    const safe = createSafeError(
      'illegal-endpoint',
      '图片生成 Base URL 不合法：仅允许火山方舟官方 https 域名',
      diag('(none)', { httpStatus: 400, errorClass: 'illegal-endpoint' }),
      apiKey,
    );
    emit(safe.diagnostics);
    return jsonResponse(400, safe);
  }

  const model = typeof body?.imageEndpoint === 'string' ? body.imageEndpoint.trim() : '';
  if (!isValidEndpoint(model)) {
    const safe = createSafeError(
      'illegal-endpoint',
      '图片 Endpoint 不合法：只允许模型/接入点 ID，不允许 URL/路径；请在模型设置中配置图片 Endpoint',
      diag(model || '(empty)', { httpStatus: 400, errorClass: 'illegal-endpoint' }),
      apiKey,
    );
    emit(safe.diagnostics);
    return jsonResponse(400, safe);
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return jsonResponse(400, { ok: false, errorClass: 'bad-request', message: '缺少生成 prompt' });
  }

  const timeoutMs = clampTimeoutMs(body?.timeoutMs, ARK_IMAGE_TIMEOUT_MS);
  const targetUrl = buildArkImageUrl(openaiBase);
  const referenceImages = Array.isArray(body?.images)
    ? body.images
        .filter((value: unknown): value is string =>
          typeof value === 'string' && IMAGE_DATA_URI_RE.test(value),
        )
        .slice(0, MAX_REFERENCE_IMAGES)
    : [];
  const count = Math.min(
    MAX_OUTPUT_IMAGES,
    Math.max(1, Number.isInteger(body?.count) ? body.count : 1),
  );

  // 白名单字段：商品图只允许内联 base64，拒绝服务端回源；组图参数限制为 1–4。
  const upstreamBody: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    output_format: 'png',
    response_format: 'b64_json',
    watermark: false,
  };
  if (referenceImages.length) upstreamBody.image = referenceImages;
  if (typeof body?.size === 'string' && /^\d{2,4}x\d{2,4}$/.test(body.size)) {
    upstreamBody.size = body.size;
  }
  if (count > 1) {
    upstreamBody.sequential_image_generation = 'auto';
    upstreamBody.sequential_image_generation_options = { max_images: count };
  }
  const payload = JSON.stringify(upstreamBody);
  if (payload.length > MAX_UPSTREAM_BODY_CHARS) {
    return jsonResponse(400, {
      ok: false,
      errorClass: 'bad-request',
      message: '参考图总体积过大，超过图片接口限制。请减少商品图张数或换更小的图片后再试。',
      diagnostics: diag(model, { errorClass: 'bad-request', targetUrlMasked: targetUrl }),
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetchUpstreamOnce(fetchImpl, targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        connection: 'close',
      },
      body: payload,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const durationMs = Date.now() - started;
    const rawText = await upstream.text();

    if (!upstream.ok) {
      let message = `上游返回 HTTP ${upstream.status}`;
      try {
        const j = JSON.parse(rawText);
        message = j?.error?.message || message;
      } catch {
        /* ignore */
      }
      const errorClass = classifyHttpStatus(upstream.status);
      const localized = localizeUpstreamError(errorClass, message);
      const safe = createSafeError(
        errorClass,
        localized.message,
        diag(model, {
          httpStatus: upstream.status,
          errorClass,
          durationMs,
          protocol: 'openai',
          targetUrlMasked: targetUrl,
          requestId: localized.requestId,
        }),
        apiKey,
      );
      emit(safe.diagnostics);
      return jsonResponse(errorClass === 'server' ? 502 : upstream.status, safe);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const safe = createSafeError('server', '图片上游返回了无法解析的响应', diag(model, { errorClass: 'server' }), apiKey);
      emit(safe.diagnostics);
      return jsonResponse(502, safe);
    }

    const images = Array.isArray(parsed?.data)
      ? parsed.data
          .map((item: unknown) => {
            const row = item as { b64_json?: unknown };
            return typeof row?.b64_json === 'string' ? row.b64_json : null;
          })
          .filter((value: string | null): value is string => value !== null)
      : [];
    if (!images.length) {
      // 只接受 base64，不跟随外部 URL，避免 SSRF / 不可信回源
      const safe = createSafeError(
        'server',
        '图片上游未返回 b64_json（可能未开启 base64 返回），为安全起见不跟随外部图片 URL',
        diag(model, { httpStatus: upstream.status, errorClass: 'server', durationMs }),
        apiKey,
      );
      emit(safe.diagnostics);
      return jsonResponse(502, safe);
    }

    const diagnostics = diag(model, {
      httpStatus: 200,
      durationMs,
      protocol: 'openai',
      targetUrlMasked: targetUrl,
      requestId: parsed?.id ?? upstream.headers.get('x-request-id') ?? undefined,
    });
    emit(diagnostics);
    return jsonResponse(200, {
      ok: true,
      b64Json: images[0],
      images: images.map((b64Json: string) => ({ b64Json, mediaType: 'image/png' })),
      mediaType: 'image/png',
      diagnostics,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === 'AbortError';
    const safe = createSafeError(
      aborted ? 'timeout' : 'network',
      aborted
        ? `图片生成超时（>${timeoutMs}ms）`
        : `网络错误，无法连接图片生成服务：${redactSecret(describeNetworkFailure(err), apiKey)}。请确认本机可访问 ark.cn-beijing.volces.com，或稍后重试。`,
      diag(model, {
        errorClass: aborted ? 'timeout' : 'network',
        durationMs: Date.now() - started,
        targetUrlMasked: targetUrl,
      }),
      apiKey,
    );
    emit(safe.diagnostics);
    return jsonResponse(aborted ? 504 : 502, safe);
  }
}
