import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const mod = await import('../../src/server/arkProxy');
    res.status(200).json({ ok: true, type: typeof mod.handleArkRequest });
  } catch (err) {
    res.status(200).json({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined,
    });
  }
}
