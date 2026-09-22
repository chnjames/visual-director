import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleArkRequest } from '../../src/server/arkProxy';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({ ok: true, imported: typeof handleArkRequest });
}
