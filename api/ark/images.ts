import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = { maxDuration: 300 };

const ALLOWED_HOST_RE = /(^|\.)volces\.com$/;
const DATA_URI_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/;

function json(res: VercelResponse, status: number, body: unknown) {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

/**
 * 自包含图片生成同源代理：POST 到 {base}/images/generations。
 * 安全：仅允许 https + volces.com；商品图只接受内联 base64；强制 b64_json。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, message: '仅支持 POST' });

  const apiKey = String(req.headers['x-ark-api-key'] ?? '').trim();
  if (!apiKey) return json(res, 400, { ok: false, errorClass: 'not-configured', message: '未配置 API Key' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const baseRaw = typeof body.imageBaseUrl === 'string' && body.imageBaseUrl.trim()
    ? body.imageBaseUrl.trim()
    : 'https://ark.cn-beijing.volces.com/api/v3';

  let base: URL;
  try {
    base = new URL(baseRaw);
  } catch {
    return json(res, 400, { ok: false, message: '图片 Base URL 不合法' });
  }
  if (base.protocol !== 'https:' || !ALLOWED_HOST_RE.test(base.hostname)) {
    return json(res, 400, { ok: false, message: '图片 Base URL 必须是火山官方 https 域名（volces.com）' });
  }

  const model = typeof body.imageEndpoint === 'string' ? body.imageEndpoint.trim() : '';
  if (!model) return json(res, 400, { ok: false, message: '图片 Endpoint 不能为空' });
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json(res, 400, { ok: false, message: 'prompt 不能为空' });

  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((v): v is string => typeof v === 'string' && DATA_URI_RE.test(v))
    .slice(0, 10);
  const count = Math.min(4, Math.max(1, Number.isInteger(body.count) ? Number(body.count) : 1));

  const upstreamBody: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    output_format: 'png',
    response_format: 'b64_json',
    watermark: false,
  };
  if (images.length) upstreamBody.image = images;
  if (typeof body.size === 'string' && /^\d{2,4}x\d{2,4}$/.test(body.size)) {
    upstreamBody.size = body.size;
  }
  if (count > 1) {
    upstreamBody.sequential_image_generation = 'auto';
    upstreamBody.sequential_image_generation_options = { max_images: count };
  }

  const target = base.toString().replace(/\/+$/, '') + '/images/generations';

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
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
