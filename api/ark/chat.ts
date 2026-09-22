import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = { maxDuration: 300 };

const ALLOWED_HOST_RE = /(^|\.)volces\.com$/;

function json(res: VercelResponse, status: number, body: unknown) {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

/**
 * 自包含同源代理（不依赖 src/ 打包，规避 @vercel/node 对项目 TS 模块链的编译问题）。
 * 安全：仅允许 https + volces.com 主机；Key 经 x-ark-api-key 头传入；仅转发白名单字段。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, message: '仅支持 POST' });

  const apiKey = String(req.headers['x-ark-api-key'] ?? '').trim();
  if (!apiKey) return json(res, 400, { ok: false, errorClass: 'not-configured', message: '未配置 API Key' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const protocol = body.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const baseRaw = typeof body.baseUrl === 'string' && body.baseUrl.trim()
    ? body.baseUrl.trim()
    : 'https://ark.cn-beijing.volces.com/api/v3';

  let base: URL;
  try {
    base = new URL(baseRaw);
  } catch {
    return json(res, 400, { ok: false, message: 'Base URL 不合法' });
  }
  if (base.protocol !== 'https:' || !ALLOWED_HOST_RE.test(base.hostname)) {
    return json(res, 400, { ok: false, message: 'Base URL 必须是火山官方 https 域名（volces.com）' });
  }

  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) return json(res, 400, { ok: false, message: 'model 不能为空' });
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return json(res, 400, { ok: false, message: 'messages 必须是非空数组' });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  let upstreamBody: Record<string, unknown>;
  let target: string;
  if (protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    upstreamBody = {
      model,
      max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 4096,
      messages: messages
        .filter((m: any) => m.role !== 'system')
        .map((m: any) => ({ role: m.role, content: m.content })),
    };
    const sys = messages
      .filter((m: any) => m.role === 'system')
      .map((m: any) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n\n');
    if (sys) upstreamBody.system = sys;
    target = base.toString().replace(/\/+$/, '') + '/v1/messages';
  } else {
    headers.authorization = `Bearer ${apiKey}`;
    upstreamBody = {
      model,
      messages,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.2,
    };
    if (body.response_format) upstreamBody.response_format = body.response_format;
    if (typeof body.max_tokens === 'number') upstreamBody.max_tokens = body.max_tokens;
    target = base.toString().replace(/\/+$/, '') + '/chat/completions';
  }

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
    res.send(text);
  } catch (err) {
    json(res, 502, {
      ok: false,
      errorClass: 'network',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
