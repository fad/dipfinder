import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import { connectToDatabase } from './lib/mongodb';
import { yahooFinance } from './lib/stocks';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify JWT and confirm admin email
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (!ADMIN_EMAIL || decoded.email?.toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const action = req.query.action as string;

  try {
    switch (action) {
      case 'list-users':
        return await handleListUsers(req, res);
      case 'test-stocks':
        return await handleTestStocks(req, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'Internal server error', detail: err?.message });
  }
}

async function handleListUsers(_req: VercelRequest, res: VercelResponse) {
  const db = await connectToDatabase();

  const users = await db
    .collection('users')
    .find(
      {},
      {
        projection: {
          password: 0,
          resetToken: 0,
          resetTokenExpiry: 0,
          resetTokenCreated: 0,
          resetTokenInUse: 0,
          resetTokenInUseAt: 0,
          resetTokenUpdateId: 0,
          lastResetUpdateId: 0,
          passwordResetAttempts: 0,
          failedLoginAttempts: 0,
        },
      }
    )
    .sort({ createdDate: -1 })
    .toArray();

  return res.status(200).json({ users });
}

async function handleTestStocks(_req: VercelRequest, res: VercelResponse) {
  const results: Record<string, any> = {};

  // 1. MongoDB connectivity
  try {
    const db = await connectToDatabase();
    const colNames = (await db.listCollections().toArray()).map((c: any) => c.name);
    results.mongodb = { ok: true, collections: colNames };
  } catch (err: any) {
    results.mongodb = { ok: false, error: err?.message };
  }

  // 2. Yahoo Finance via yahoo-finance2
  const period1 = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
  try {
    const chart = await yahooFinance.chart('AAPL', { period1, interval: '1d' });
    const quotes: any[] = chart?.quotes ?? [];
    const closes = quotes.map((q: any) => q.close).filter((p: any) => Number.isFinite(p));
    results.yahooFinance = {
      ok: true,
      symbol: chart?.meta?.symbol,
      quotesReturned: quotes.length,
      closesFiltered: closes.length,
      lastClose: closes[closes.length - 1] ?? null,
      metaKeys: Object.keys(chart?.meta ?? {}),
    };
  } catch (err: any) {
    results.yahooFinance = {
      ok: false,
      error: err?.message,
      stack: err?.stack?.split('\n').slice(0, 6).join('\n'),
    };
  }

  // 3. batch-stocks cache check
  try {
    const db = await connectToDatabase();
    const doc = await db.collection('dashboardStocks').findOne({ cacheKey: 'dashboard-stock-AAPL' });
    results.dashboardCache = doc
      ? { ok: true, age_minutes: Math.round((Date.now() - doc.timestamp) / 60000), keys: Object.keys(doc.data ?? {}) }
      : { ok: false, note: 'no cache entry for AAPL' };
  } catch (err: any) {
    results.dashboardCache = { ok: false, error: err?.message };
  }

  return res.status(200).json(results);
}
