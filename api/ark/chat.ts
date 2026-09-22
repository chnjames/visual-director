import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleArkRequest } from '../../src/server/arkProxy';

export const config = {
  maxDuration: 300,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await run(req, res);
  } catch (err) {
    res.status(500).setHeader('content-type', 'application/json');
    res.send(
      JSON.stringify({
        ok: false,
        errorClass: 'function-fatal',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 1200) : undefined,
      }),
    );
  }
}

async function run(req: VercelRequest, res: VercelResponse) {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  const url = `${proto}://${host}/api/ark/chat`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value != null) headers.set(key, String(value));
  }

  const request = new Request(url, {
    method: req.method,
    headers,
    body: req.body ? JSON.stringify(req.body) : undefined,
  });

  const response = await handleArkRequest(request);

  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(Buffer.from(await response.arrayBuffer()));
}
