import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({ status: 'API is working correctly', timestamp: new Date().toISOString() });
}
