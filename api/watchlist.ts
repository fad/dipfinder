import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from './lib/mongodb';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const WATCHLIST_LIMIT = 10;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (req.method === 'POST') {
    const { stocks, smaPeriod } = req.body || {};
    if (!Array.isArray(stocks)) return res.status(400).json({ error: 'stocks must be an array' });

    const sanitized = (stocks as any[])
      .filter(s => typeof s === 'string' && TICKER_RE.test(s.toUpperCase()))
      .map(s => (s as string).toUpperCase())
      .slice(0, WATCHLIST_LIMIT);

    const update: Record<string, any> = { watchlist: sanitized, watchlistUpdatedAt: new Date() };
    const period = Number(smaPeriod);
    if (Number.isFinite(period) && period > 0) update.smaPeriod = period;

    const db = await connectToDatabase();
    await db.collection('users').updateOne(
      { _id: new ObjectId(decoded.userId) },
      { $set: update }
    );

    return res.status(200).json({ success: true });
  }

  if (req.method === 'GET') {
    const db = await connectToDatabase();
    const user = await db.collection('users').findOne(
      { _id: new ObjectId(decoded.userId) },
      { projection: { watchlist: 1 } }
    );
    return res.status(200).json({ stocks: user?.watchlist || [] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
