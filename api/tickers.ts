import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from './lib/mongodb';
import { getActiveTickers } from './lib/tickers';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const db = await connectToDatabase();
    const tickers = await getActiveTickers(db);
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return res.status(200).json({ tickers });
  } catch (error) {
    console.error('Tickers error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
