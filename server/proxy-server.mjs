/**
 * Visual Recipe 探针台 - 零依赖独立服务器（自部署用）。
 *
 * 用法：
 *   1) npm run build        先构建前端到 dist/
 *   2) node server/proxy-server.mjs
 *
 * 安全约束（权威、被单测覆盖的实现见 src/server/arkProxy.ts，本文件保持同构）：
 * - Base URL 可由用户修改，但主机必须命中火山官方域名白名单（.volces.com）且 https（防 SSRF）；
 * - 支持 OpenAI（{base}/chat/completions，Bearer）与
 *   Anthropic（{base}/v1/messages，x-api-key）两种协议，并在服务端归一化响应；
 * - 只转发白名单字段；Anthropic 图片仅接受 data: base64；
 * - API Key 仅用于上游鉴权头，本服务器【不记录】Key、请求头或请求体；
 * - 日志只输出方法、路径、状态码、耗时（不含任何敏感信息）。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 5173);

const DEFAULT_BASE = {
  openai: 'https://ark.cn-beijing.volces.com/api/v3',
  anthropic: 'https://ark.cn-beijing.volces.com/api/plan',
};
const IMAGE_DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const API_PATH = { openai: '/chat/completions', anthropic: '/v1/messages' };
const ANTHROPIC_VERSION = '2023-06-01';
const ALLOWED_SUFFIXES = ['volces.com', '.volces.com'];
const TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 180_000;
function clampTimeoutMs(value, fallback = TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}
const ENDPOINT_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const PROXY_PATH = '/api/ark/chat';
const IMAGES_PROXY_PATH = '/api/ark/images';
const IMAGE_PATH = '/images/generations';
const IMAGE_TIMEOUT_MS = 180_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function safeLog(method, urlPath, status, durationMs) {
  console.log(`${new Date().toISOString()} ${method} ${urlPath} -> ${status} (${durationMs}ms)`);
}

// 主机白名单：以“.”开头的条目做点边界后缀匹配；裸条目仅精确相等。
// 裸后缀直接 endsWith 会放行 evilvolces.com 这类前缀仿冒（SSRF）。
function isAllowedHost(rawHost) {
  const host = rawHost.toLowerCase();
  return ALLOWED_SUFFIXES.some((entry) =>
    entry.startsWith('.') ? host.endsWith(entry) : host === entry,
  );
}

function isValidBaseUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password || u.search || u.hash) return false;
    return isAllowedHost(u.hostname);
  } catch {
    return false;
  }
}

function describeFetchError(err) {
  const parts = [];
  let current = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (typeof current !== 'object') break;
    if (typeof current.code === 'string') parts.push(current.code);
    if (typeof current.message === 'string') parts.push(current.message);
    current = current.cause;
  }
  return [...new Set(parts.filter(Boolean))].join(' · ') || '网络错误';
}

const IMAGE_DATA_URI_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/;
const MAX_REFERENCE_IMAGES = 10;
const MAX_OUTPUT_IMAGES = 4;
const ALLOWED_MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'developer']);

function dataUriBlock(url) {
  if (typeof url !== 'string' || !IMAGE_DATA_URI_RE.test(url)) return null;
  const m = /^data:([^;,]+)?;base64,/.exec(url);
  let media = (m?.[1] || 'image/png').trim();
  if (media === 'image/jpg') media = 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: media, data: url.slice(url.indexOf(',') + 1) } };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  }
  return '';
}

/** 出站 part 白名单：文本或内联 base64 位图；外部 URL/工具调用等一律丢弃 */
function sanitizeContentPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') {
    return typeof part.text === 'string' && part.text.length > 0 ? { type: 'text', text: part.text } : null;
  }
  if (part.type === 'image_url') {
    const url = part.image_url?.url;
    if (typeof url === 'string' && IMAGE_DATA_URI_RE.test(url)) {
      return { type: 'image_url', image_url: { url } };
    }
    return null;
  }
  return null;
}

/** 递归净化 messages：角色白名单 + content 白名单，深度丢弃任何外部图片 URL */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' && ALLOWED_MESSAGE_ROLES.has(m.role) ? m.role : 'user';
    if (typeof m.content === 'string') {
      if (m.content.length === 0) continue;
      out.push({ role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const parts = m.content.map(sanitizeContentPart).filter(Boolean);
      if (parts.length === 0) continue;
      out.push({ role, content: parts });
    }
  }
  return out;
}

function toAnthropicContent(content) {
  const blocks = [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return blocks;
  for (const p of content) {
    if (p?.type === 'text' && typeof p.text === 'string') blocks.push({ type: 'text', text: p.text });
    else if (p?.type === 'image_url') {
      const img = dataUriBlock(p.image_url?.url);
      if (img) blocks.push(img);
    }
  }
  return blocks;
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'invalid-key';
  if (status === 404 || status === 405) return 'endpoint-not-found';
  if (status === 429) return 'quota';
  if (status === 400 || status === 422) return 'bad-request';
  if (status >= 500) return 'server';
  return 'unknown';
}

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

async function handleProxy(req, res) {
  const started = Date.now();
  const apiKey = (req.headers['x-ark-api-key'] || '').trim();
  if (!apiKey) {
    sendJson(res, 400, { ok: false, errorClass: 'not-configured', message: '未配置 API Key', diagnostics: { model: '(none)', endpointMasked: '(none)' } });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, errorClass: 'bad-request', message: '请求体不是合法 JSON' });
    return;
  }

  const protocol = body?.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const baseUrl = typeof body?.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : DEFAULT_BASE[protocol];
  if (!isValidBaseUrl(baseUrl)) {
    sendJson(res, 400, { ok: false, errorClass: 'illegal-endpoint', message: 'Base URL 不合法：仅允许火山方舟官方 https 域名（.volces.com）' });
    return;
  }
  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  if (!ENDPOINT_RE.test(model)) {
    sendJson(res, 400, { ok: false, errorClass: 'illegal-endpoint', message: 'Endpoint 不合法：只允许模型/接入点 ID，不允许填写 URL 或路径' });
    return;
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    sendJson(res, 400, { ok: false, errorClass: 'bad-request', message: 'messages 必须是非空数组' });
    return;
  }
  // 出站前深度净化：外部图片 URL/未知 part/工具调用一律不转发（OpenAI 面此前原样透传）
  const safeMessages = sanitizeMessages(body.messages);
  if (safeMessages.length === 0) {
    sendJson(res, 400, { ok: false, errorClass: 'bad-request', message: 'messages 中没有可转发的合法内容（仅接受文本与内联 base64 图片）' });
    return;
  }

  const timeoutMs = clampTimeoutMs(body?.timeoutMs);

  const target = `${baseUrl.replace(/\/+$/, '')}${API_PATH[protocol]}`;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  let upstreamBody;
  if (protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    const system = safeMessages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).filter(Boolean).join('\n\n');
    const convo = safeMessages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(m.content) }))
      .filter((m) => m.content.length > 0);
    upstreamBody = { model, max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 4096, messages: convo };
    if (system) upstreamBody.system = system;
    if (typeof body.temperature === 'number') upstreamBody.temperature = body.temperature;
  } else {
    headers.authorization = `Bearer ${apiKey}`;
    upstreamBody = { model, messages: safeMessages };
    for (const f of ['temperature', 'top_p', 'max_tokens', 'response_format']) {
      if (body[f] !== undefined) upstreamBody[f] = body[f];
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(target, { method: 'POST', headers, body: JSON.stringify(upstreamBody), signal: controller.signal });
    clearTimeout(timer);
    const text = await upstream.text();

    if (!upstream.ok) {
      let message = `上游返回 HTTP ${upstream.status}`;
      try {
        const j = JSON.parse(text);
        message = j?.error?.message || message;
      } catch { /* ignore */ }
      if (message.includes(apiKey)) message = message.split(apiKey).join('[REDACTED]');
      sendJson(res, classifyStatus(upstream.status) === 'server' ? 502 : upstream.status, {
        ok: false, errorClass: classifyStatus(upstream.status), message,
      });
      safeLog('POST', PROXY_PATH, upstream.status, Date.now() - started);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendJson(res, 502, { ok: false, errorClass: 'server', message: '上游返回了无法解析的响应体' });
      return;
    }

    let content = '';
    let usage;
    let requestId;
    if (protocol === 'anthropic') {
      content = Array.isArray(parsed.content) ? parsed.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('') : '';
      const i = parsed.usage?.input_tokens;
      const o = parsed.usage?.output_tokens;
      if (i != null || o != null) usage = { prompt_tokens: i, completion_tokens: o, total_tokens: (i || 0) + (o || 0) };
      requestId = parsed.request_id || parsed.id;
    } else {
      content = parsed?.choices?.[0]?.message?.content || '';
      usage = parsed.usage;
      requestId = parsed.id;
    }
    if (!content) {
      sendJson(res, 502, { ok: false, errorClass: 'server', message: '上游成功响应中缺少文本内容' });
      return;
    }
    sendJson(res, 200, { ok: true, content, usage, requestId, diagnostics: { model, endpointMasked: model, protocol, targetUrlMasked: target } });
    safeLog('POST', PROXY_PATH, 200, Date.now() - started);
  } catch (err) {
    clearTimeout(timer);
    const aborted = err?.name === 'AbortError';
    sendJson(res, aborted ? 504 : 502, {
      ok: false,
      errorClass: aborted ? 'timeout' : 'network',
      message: aborted ? `模型请求超时（>${timeoutMs}ms）` : '网络错误，无法连接模型服务',
    });
    safeLog('POST', PROXY_PATH, aborted ? 504 : 502, Date.now() - started);
  }
}

async function handleImages(req, res) {
  const started = Date.now();
  const apiKey = (req.headers['x-ark-api-key'] || '').trim();
  if (!apiKey) {
    sendJson(res, 400, { ok: false, errorClass: 'not-configured', message: '未配置 API Key', diagnostics: { model: '(none)', endpointMasked: '(none)' } });
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, errorClass: 'bad-request', message: '请求体不是合法 JSON' });
    return;
  }
  // 图片生成固定走独立的 Platform OpenAI 兼容基址，不复用文本/Agent Plan 基址。
  const openaiBase = typeof body?.imageBaseUrl === 'string' && body.imageBaseUrl.trim()
    ? body.imageBaseUrl.trim()
    : IMAGE_DEFAULT_BASE;
  if (!isValidBaseUrl(openaiBase)) {
    sendJson(res, 400, { ok: false, errorClass: 'illegal-endpoint', message: '图片生成 Base URL 不合法：仅允许火山方舟官方 https 域名' });
    return;
  }
  const model = typeof body?.imageEndpoint === 'string' ? body.imageEndpoint.trim() : '';
  if (!ENDPOINT_RE.test(model)) {
    sendJson(res, 400, { ok: false, errorClass: 'illegal-endpoint', message: '图片 Endpoint 不合法：只允许模型/接入点 ID；请在模型设置中配置图片 Endpoint' });
    return;
  }
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    sendJson(res, 400, { ok: false, errorClass: 'bad-request', message: '缺少生成 prompt' });
    return;
  }
  const timeoutMs = clampTimeoutMs(body?.timeoutMs, IMAGE_TIMEOUT_MS);
  const target = `${openaiBase.replace(/\/+$/, '')}${IMAGE_PATH}`;
  const referenceImages = Array.isArray(body?.images)
    ? body.images
        .filter((value) => typeof value === 'string' && IMAGE_DATA_URI_RE.test(value))
        .slice(0, MAX_REFERENCE_IMAGES)
    : [];
  const count = Math.min(
    MAX_OUTPUT_IMAGES,
    Math.max(1, Number.isInteger(body?.count) ? body.count : 1),
  );
  const upstreamBody = {
    model,
    prompt,
    n: 1,
    output_format: 'png',
    response_format: 'b64_json',
    watermark: false,
  };
  if (referenceImages.length) upstreamBody.image = referenceImages;
  if (typeof body?.size === 'string' && /^\d{2,4}x\d{2,4}$/.test(body.size)) upstreamBody.size = body.size;
  if (count > 1) {
    upstreamBody.sequential_image_generation = 'auto';
    upstreamBody.sequential_image_generation_options = { max_images: count };
  }
  const payload = JSON.stringify(upstreamBody);
  if (payload.length > 18 * 1024 * 1024) {
    sendJson(res, 400, { ok: false, errorClass: 'bad-request', message: '参考图总体积过大，超过图片接口限制。请减少商品图张数或换更小的图片后再试。' });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      connection: 'close',
    },
    body: payload,
    signal: controller.signal,
  };
  try {
    let upstream;
    try {
      upstream = await fetch(target, init);
    } catch (firstErr) {
      if (firstErr?.name === 'AbortError') throw firstErr;
      upstream = await fetch(target, init);
    }
    clearTimeout(timer);
    const text = await upstream.text();
    if (!upstream.ok) {
      let message = `上游返回 HTTP ${upstream.status}`;
      try {
        const j = JSON.parse(text);
        message = j?.error?.message || message;
      } catch { /* ignore */ }
      if (message.includes(apiKey)) message = message.split(apiKey).join('[REDACTED]');
      const cls = classifyStatus(upstream.status);
      sendJson(res, cls === 'server' ? 502 : upstream.status, { ok: false, errorClass: cls, message });
      safeLog('POST', IMAGES_PROXY_PATH, upstream.status, Date.now() - started);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendJson(res, 502, { ok: false, errorClass: 'server', message: '图片上游返回了无法解析的响应' });
      return;
    }
    const images = Array.isArray(parsed?.data)
      ? parsed.data.map((item) => item?.b64_json).filter((value) => typeof value === 'string')
      : [];
    if (!images.length) {
      // 只接受 base64，不跟随外部 URL，避免 SSRF / 不可信回源
      sendJson(res, 502, { ok: false, errorClass: 'server', message: '图片上游未返回 b64_json；为安全起见不跟随外部图片 URL' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      b64Json: images[0],
      images: images.map((b64Json) => ({ b64Json, mediaType: 'image/png' })),
      mediaType: 'image/png',
      diagnostics: { model, endpointMasked: model, protocol: 'openai', targetUrlMasked: target },
    });
    safeLog('POST', IMAGES_PROXY_PATH, 200, Date.now() - started);
  } catch (err) {
    clearTimeout(timer);
    const aborted = err?.name === 'AbortError';
    const detail = describeFetchError(err);
    sendJson(res, aborted ? 504 : 502, {
      ok: false,
      errorClass: aborted ? 'timeout' : 'network',
      message: aborted
        ? `图片生成超时（>${timeoutMs}ms）`
        : `网络错误，无法连接图片生成服务：${detail}。请确认本机可访问 ark.cn-beijing.volces.com，或稍后重试。`,
    });
    safeLog('POST', IMAGES_PROXY_PATH, aborted ? 504 : 502, Date.now() - started);
  }
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(DIST_DIR, rel));
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    createReadStream(path.join(DIST_DIR, 'index.html')).pipe(res);
  }
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && urlPath === PROXY_PATH) {
    handleProxy(req, res).catch(() => sendJson(res, 500, { ok: false, errorClass: 'server', message: '代理内部错误' }));
    return;
  }
  if (req.method === 'POST' && urlPath === IMAGES_PROXY_PATH) {
    handleImages(req, res).catch(() => sendJson(res, 500, { ok: false, errorClass: 'server', message: '代理内部错误' }));
    return;
  }
  if (req.method === 'GET') {
    serveStatic(req, res, urlPath);
    return;
  }
  res.writeHead(405);
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`Visual Recipe 探针台：http://localhost:${PORT}`);
  console.log(`OpenAI 默认：${DEFAULT_BASE.openai}${API_PATH.openai}`);
  console.log(`Anthropic 默认：${DEFAULT_BASE.anthropic}${API_PATH.anthropic}`);
  console.log('Base URL 可修改，但主机限火山官方域名（.volces.com），不接受任意主机。');
});
