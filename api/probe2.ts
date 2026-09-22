import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleArkImageRequest } from '../../src/server/arkImageProxy';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({ ok: true, imported: typeof handleArkImageRequest });
}
