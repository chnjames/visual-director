/**
 * Vercel Serverless 入口：复用同源图片代理处理器（Web Fetch API 合同）。
 */
import { handleArkImageRequest } from '../../../src/server/arkImageProxy';

export const config = {
  api: {
    bodyParser: false,
  },
  runtime: 'nodejs20.x',
  maxDuration: 300,
};

export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  const url = `${proto}://${host}/api/ark/images`;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value != null) headers.set(key, String(value));
  }

  const request = new Request(url, {
    method: req.method,
    headers,
    body: body.length ? body : undefined,
  });

  const response = await handleArkImageRequest(request);

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}
