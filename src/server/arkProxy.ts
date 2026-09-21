/**
 * 火山方舟同构代理处理器（Web Fetch API，可在 Node 中间件 / 独立服务器 / 测试中复用）。
 *
 * 安全合同（docs/04、docs/07、docs/09）：
 * - Base URL 允许用户在“模型设置”中修改，但主机名必须命中火山官方域名白名单（.volces.com）
 *   且必须 https；指向任意外部主机的地址一律拒绝（防 SSRF）；
 * - 支持两种协议：OpenAI 兼容（{base}/chat/completions，Bearer 鉴权）
 *   与 Anthropic 兼容（{base}/v1/messages，x-api-key 鉴权）；协议差异在代理侧归一化；
 * - 仅转发白名单字段（model/messages/温度等），其余字段（尤其任何外部 URL）一律丢弃；
 *   Anthropic 图片仅接受 data: base64，不接受会触发服务端抓取的外部图片 URL；
 * - model(Endpoint) 必须通过保守字符白名单校验；
 * - API Key 只用于组装上游鉴权头，不写日志、不出现在错误/响应里；
 * - 默认不记录任何请求头与请求体；诊断回调只收到脱敏后的 SafeDiagnostics；
 * - 模型输出不决定任何 URL/文件/命令。
 */
import {
  ANTHROPIC_VERSION,
  ARK_DEFAULT_BASE_URLS,
  ARK_REQUEST_TIMEOUT_MS,
  PROXY_PATH,
  buildArkUpstreamUrl,
  clampTimeoutMs,
  type ArkProtocol,
} from '../shared/constants';
import {
  buildSafeDiagnostics,
  classifyHttpStatus,
  createSafeError,
  isValidBaseUrl,
  isValidEndpoint,
  maskEndpoint,
  redactSecret,
} from '../shared/security';
import type { SafeDiagnostics } from '../shared/types';

export const API_KEY_HEADER = 'x-ark-api-key';

export type ProxyDeps = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 仅接收脱敏诊断；不接收 Key/请求头/请求体 */
  onDiagnostic?: (d: SafeDiagnostics) => void;
};

const OPENAI_OUTGOING_FIELDS = [
  'temperature',
  'top_p',
  'max_tokens',
  'response_format',
] as const;

type ChatPart = { type?: string; text?: string; image_url?: { url?: string } };
type ChatMsg = { role?: string; content?: string | ChatPart[] };

/* ------------------------- 出站消息深度净化（纵深防御） ------------------------- */

const ALLOWED_MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'developer']);

/**
 * 图片仅允许内联 data: base64，且 MIME 限定为常见位图类型。
 * - 拒绝 http(s) 等外部 URL：模型侧/上游不得据此发起任何服务端回源（SSRF）；
 * - 拒绝 svg/html 等可携带脚本或嵌套外部引用的媒体；
 * - base64 字母表 + 空白字符，锚定首尾。
 */
const IMAGE_DATA_URI_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/;

type SafePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type SafeMessage = { role: string; content: string | SafePart[] };

/** 把任意入站 part 收敛到白名单形态；无法识别（外部 URL、工具调用、多余字段）一律丢弃 */
function sanitizeContentPart(part: unknown): SafePart | null {
  if (!part || typeof part !== 'object') return null;
  const p = part as ChatPart;
  if (p.type === 'text') {
    return typeof p.text === 'string' && p.text.length > 0
      ? { type: 'text', text: p.text }
      : null;
  }
  if (p.type === 'image_url') {
    const url = p.image_url?.url;
    if (typeof url === 'string' && IMAGE_DATA_URI_RE.test(url)) {
      return { type: 'image_url', image_url: { url } };
    }
    return null;
  }
  return null;
}

/**
 * 递归净化 messages（OpenAI 与 Anthropic 出站前统一调用）：
 * - role 仅保留白名单，未知角色收敛为 user；
 * - content 只接受字符串或白名单 part 数组；
 * - image_url 只接受内联 base64 位图，外部 URL/未知 part 被深度丢弃；
 * - 消息上的其他任意字段（工具调用、注入参数等）不会进入出站对象。
 */
function sanitizeMessages(raw: unknown): SafeMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: SafeMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const rawRole = (m as ChatMsg).role;
    const role =
      typeof rawRole === 'string' && ALLOWED_MESSAGE_ROLES.has(rawRole) ? rawRole : 'user';
    const content = (m as ChatMsg).content;
    if (typeof content === 'string') {
      if (content.length === 0) continue;
      out.push({ role, content });
    } else if (Array.isArray(content)) {
      const parts = content
        .map(sanitizeContentPart)
        .filter((x): x is SafePart => x !== null);
      if (parts.length === 0) continue;
      out.push({ role, content: parts });
    }
  }
  return out;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function diag(model: string, extra: Partial<SafeDiagnostics> = {}): SafeDiagnostics {
  return buildSafeDiagnostics({
    model,
    endpointMasked: maskEndpoint(model),
    ...extra,
  });
}

function normalizeProtocol(p: unknown): ArkProtocol {
  return p === 'anthropic' ? 'anthropic' : 'openai';
}

/* ------------------------- Anthropic 协议转换 ------------------------- */

function dataUriToAnthropicBlock(url: string): unknown | null {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(url);
  if (!m || !m[2]) return null; // 仅接受 base64 data URI，拒绝外部 URL
  let mediaType = (m[1] || 'image/png').trim();
  if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: m[3] },
  };
}

function textOf(content: string | ChatPart[] | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n');
  }
  return '';
}

function toAnthropicContent(content: string | ChatPart[] | undefined): unknown[] {
  const blocks: unknown[] = [];
  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part?.type === 'image_url' && part.image_url?.url) {
      const img = dataUriToAnthropicBlock(part.image_url.url);
      if (img) blocks.push(img);
    }
  }
  return blocks;
}

/** 把内部统一的 OpenAI 风格 messages（已完成深度净化）转为 Anthropic 请求要素 */
function buildAnthropicRequest(model: string, messages: SafeMessage[], extra: Record<string, unknown>) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join('\n\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(m.content) }))
    .filter((m) => m.content.length > 0);

  const body: Record<string, unknown> = {
    model,
    max_tokens: typeof extra.max_tokens === 'number' ? extra.max_tokens : 4096,
    messages: convo,
  };
  if (system) body.system = system;
  if (typeof extra.temperature === 'number') body.temperature = extra.temperature;
  if (typeof extra.top_p === 'number') body.top_p = extra.top_p;
  return body;
}

function buildOpenAiRequest(model: string, messages: SafeMessage[], raw: Record<string, unknown>) {
  // messages 已经过递归净化（仅文本/内联 base64 图片），其余字段继续走顶层白名单
  const body: Record<string, unknown> = { model, messages };
  for (const field of OPENAI_OUTGOING_FIELDS) {
    if (raw[field] !== undefined) body[field] = raw[field];
  }
  return body;
}

type ParsedUpstream = {
  content: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  requestId?: string;
};

function parseUpstreamSuccess(protocol: ArkProtocol, parsed: any, headerId?: string): ParsedUpstream {
  if (protocol === 'anthropic') {
    const text = Array.isArray(parsed?.content)
      ? parsed.content
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b?.text ?? '')
          .join('')
      : '';
    const inT = parsed?.usage?.input_tokens;
    const outT = parsed?.usage?.output_tokens;
    return {
      content: text,
      usage:
        inT != null || outT != null
          ? {
              prompt_tokens: inT,
              completion_tokens: outT,
              total_tokens: (inT ?? 0) + (outT ?? 0),
            }
          : undefined,
      requestId: headerId ?? parsed?.request_id ?? parsed?.id,
    };
  }
  return {
    content: parsed?.choices?.[0]?.message?.content ?? '',
    usage: parsed?.usage,
    requestId: headerId ?? parsed?.id,
  };
}

function extractUpstreamErrorMessage(protocol: ArkProtocol, rawText: string, fallback: string): string {
  try {
    const j = JSON.parse(rawText);
    if (protocol === 'anthropic') return j?.error?.message || fallback;
    return j?.error?.message || j?.message || fallback;
  } catch {
    return fallback;
  }
}

/**
 * 处理一次同源代理请求。
 * JSON body：{ protocol?, baseUrl?, model, messages, temperature?, ... }
 * API Key 通过请求头 x-ark-api-key 传入（不进 URL、不进日志）。
 */
export async function handleArkRequest(
  request: Request,
  deps: ProxyDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let timeoutMs = deps.timeoutMs ?? ARK_REQUEST_TIMEOUT_MS;
  const started = Date.now();
  const emit = (d: SafeDiagnostics) => {
    try {
      deps.onDiagnostic?.(d);
    } catch {
      /* 诊断回调失败不影响主流程 */
    }
  };

  if (request.method !== 'POST') {
    return jsonResponse(405, {
      ok: false,
      errorClass: 'bad-request',
      message: '仅支持 POST',
      diagnostics: diag('(none)'),
    });
  }
  const url = new URL(request.url);
  if (url.pathname !== PROXY_PATH) {
    return jsonResponse(404, {
      ok: false,
      errorClass: 'bad-request',
      message: '未知代理路径',
      diagnostics: diag('(none)'),
    });
  }

  const apiKey = request.headers.get(API_KEY_HEADER)?.trim() ?? '';
  if (!apiKey) {
    return jsonResponse(400, {
      ok: false,
      errorClass: 'not-configured',
      message: '未配置 API Key（只读/等待状态下不会发起真实调用）',
      diagnostics: diag('(none)'),
    });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, {
      ok: false,
      errorClass: 'bad-request',
      message: '请求体不是合法 JSON',
      diagnostics: diag('(none)'),
    });
  }

  // 客户端可按探针/测试连接请求不同超时；服务端钳制到允许区间
  if (deps.timeoutMs == null) {
    timeoutMs = clampTimeoutMs(body?.timeoutMs);
  }

  const protocol = normalizeProtocol(body?.protocol);
  const baseUrl =
    typeof body?.baseUrl === 'string' && body.baseUrl.trim()
      ? body.baseUrl.trim()
      : ARK_DEFAULT_BASE_URLS[protocol];

  if (!isValidBaseUrl(baseUrl)) {
    const safe = createSafeError(
      'illegal-endpoint',
      'Base URL 不合法：仅允许火山方舟官方 https 域名（.volces.com），不能指向任意主机',
      diag('(none)', { httpStatus: 400, errorClass: 'illegal-endpoint', protocol }),
      apiKey,
    );
    emit(safe.diagnostics);
    return jsonResponse(400, safe);
  }

  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  if (!isValidEndpoint(model)) {
    const safe = createSafeError(
      'illegal-endpoint',
      'Endpoint 不合法：只允许模型/接入点 ID，不允许填写 URL 或路径',
      diag(model || '(empty)', { httpStatus: 400, errorClass: 'illegal-endpoint', protocol }),
      apiKey,
    );
    emit(safe.diagnostics);
    return jsonResponse(400, safe);
  }

  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return jsonResponse(400, {
      ok: false,
      errorClass: 'bad-request',
      message: 'messages 必须是非空数组',
      diagnostics: diag(model, { errorClass: 'bad-request', protocol }),
    });
  }

  // 出站前深度净化：未知角色/part、外部图片 URL、工具调用等一律不转发。
  // 原始 messages 非空但净化后为空（例如全部是外部 URL 图片）同样拒绝，
  // 避免向上游发出语义为空或仅含不可信载荷的请求。
  const messages = sanitizeMessages(body.messages);
  if (messages.length === 0) {
    return jsonResponse(400, {
      ok: false,
      errorClass: 'bad-request',
      message: 'messages 中没有可转发的合法内容（仅接受文本与内联 base64 图片）',
      diagnostics: diag(model, { errorClass: 'bad-request', protocol }),
    });
  }

  const targetUrl = buildArkUpstreamUrl(protocol, baseUrl);
  const extra: Record<string, unknown> = {};
  for (const f of ['temperature', 'top_p', 'max_tokens', 'response_format'] as const) {
    if (body[f] !== undefined) extra[f] = body[f];
  }

  const upstreamHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  let upstreamBody: Record<string, unknown>;
  if (protocol === 'anthropic') {
    upstreamHeaders['x-api-key'] = apiKey;
    upstreamHeaders['anthropic-version'] = ANTHROPIC_VERSION;
    upstreamBody = buildAnthropicRequest(model, messages, extra);
  } else {
    upstreamHeaders.authorization = `Bearer ${apiKey}`;
    upstreamBody = buildOpenAiRequest(model, messages, extra);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetchImpl(targetUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const durationMs = Date.now() - started;
    const headerId =
      upstream.headers.get('x-request-id') ??
      upstream.headers.get('request-id') ??
      upstream.headers.get('x-tt-logid') ??
      undefined;
    const rawText = await upstream.text();

    if (!upstream.ok) {
      const errorClass = classifyHttpStatus(upstream.status);
      const upstreamMessage = extractUpstreamErrorMessage(
        protocol,
        rawText,
        `上游返回 HTTP ${upstream.status}`,
      );
      const safe = createSafeError(
        errorClass,
        upstreamMessage,
        diag(model, {
          httpStatus: upstream.status,
          errorClass,
          durationMs,
          protocol,
          targetUrlMasked: targetUrl,
          requestId: headerId,
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
      const safe = createSafeError(
        'server',
        '上游返回了无法解析的响应体',
        diag(model, { httpStatus: upstream.status, errorClass: 'server', durationMs, protocol }),
        apiKey,
      );
      emit(safe.diagnostics);
      return jsonResponse(502, safe);
    }

    const normalized = parseUpstreamSuccess(protocol, parsed, headerId);
    if (!normalized.content) {
      const safe = createSafeError(
        'server',
        '上游成功响应中缺少文本内容',
        diag(model, { httpStatus: upstream.status, errorClass: 'server', durationMs, protocol }),
        apiKey,
      );
      emit(safe.diagnostics);
      return jsonResponse(502, safe);
    }

    const diagnostics = diag(model, {
      httpStatus: 200,
      durationMs,
      protocol,
      targetUrlMasked: targetUrl,
      requestId: normalized.requestId,
      promptTokens: normalized.usage?.prompt_tokens,
      completionTokens: normalized.usage?.completion_tokens,
      totalTokens: normalized.usage?.total_tokens,
    });
    emit(diagnostics);

    return jsonResponse(200, {
      ok: true,
      content: normalized.content,
      usage: normalized.usage,
      requestId: diagnostics.requestId,
      diagnostics,
    });
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Date.now() - started;
    const aborted = (err as Error)?.name === 'AbortError';
    const errorClass = aborted ? 'timeout' : 'network';
    const safe = createSafeError(
      errorClass,
      aborted
        ? `模型请求超时（>${timeoutMs}ms）`
        : `网络错误，无法连接模型服务：${redactSecret((err as Error)?.message ?? '', apiKey)}`,
      diag(model, { errorClass, durationMs, protocol, targetUrlMasked: targetUrl }),
      apiKey,
    );
    emit(safe.diagnostics);
    return jsonResponse(aborted ? 504 : 502, safe);
  }
}
