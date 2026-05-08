import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { randomBytes } from 'crypto';
import { connectToDatabase } from './lib/mongodb';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const LIMIT_PRO  = 50;
const LIMIT_AUTH = 10;
const MAX_NAMED_WATCHLISTS = 9; // 9 extra + 1 primary = 10 total

function sanitizeTickers(stocks: any[], limit: number): string[] {
  return (stocks as any[])
    .filter(s => typeof s === 'string' && TICKER_RE.test(s.toUpperCase()))
    .map(s => (s as string).toUpperCase())
    .slice(0, limit);
}

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

  const db = await connectToDatabase();
  const user = await db.collection('users').findOne(
    { _id: new ObjectId(decoded.userId) },
    { projection: { watchlist: 1, isPro: 1, namedWatchlists: 1, activeWatchlistId: 1, primaryWatchlistName: 1, smaPeriod: 1, chartOrientation: 1 } }
  );
  if (!user) return res.status(404).json({ error: 'User not found' });

  const isPro = !!user.isPro;
  const stockLimit = isPro ? LIMIT_PRO : LIMIT_AUTH;

  // ── GET ───────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    return res.status(200).json({
      stocks: user.watchlist || [],
      isPro,
      primaryWatchlistName: user.primaryWatchlistName || 'Main',
      namedWatchlists: user.namedWatchlists || [],
      activeWatchlistId: user.activeWatchlistId || 'primary',
      smaPeriod: user.smaPeriod,
      chartOrientation: user.chartOrientation,
    });
  }

  // ── POST ──────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, stocks, smaPeriod, chartOrientation, watchlistId, name } = req.body || {};

    // Legacy / primary save (no action or explicit save-primary)
    if (!action || action === 'save-primary') {
      if (!Array.isArray(stocks)) return res.status(400).json({ error: 'stocks must be an array' });
      const sanitized = sanitizeTickers(stocks, stockLimit);
      const update: Record<string, any> = { watchlist: sanitized, watchlistUpdatedAt: new Date() };
      const period = Number(smaPeriod);
      if (Number.isFinite(period) && period > 0) update.smaPeriod = period;
      if (chartOrientation === 'x' || chartOrientation === 'y') update.chartOrientation = chartOrientation;
      await db.collection('users').updateOne({ _id: new ObjectId(decoded.userId) }, { $set: update });
      return res.status(200).json({ success: true });
    }

    // Save stocks to a specific watchlist (primary or named)
    if (action === 'save-watchlist') {
      if (!Array.isArray(stocks)) return res.status(400).json({ error: 'stocks must be an array' });
      const sanitized = sanitizeTickers(stocks, stockLimit);

      if (!watchlistId || watchlistId === 'primary') {
        const update: Record<string, any> = { watchlist: sanitized, watchlistUpdatedAt: new Date() };
        const period = Number(smaPeriod);
        if (Number.isFinite(period) && period > 0) update.smaPeriod = period;
        if (chartOrientation === 'x' || chartOrientation === 'y') update.chartOrientation = chartOrientation;
        await db.collection('users').updateOne({ _id: new ObjectId(decoded.userId) }, { $set: update });
        return res.status(200).json({ success: true });
      }

      if (!isPro) return res.status(403).json({ error: 'Pro account required' });
      const existing: any[] = user.namedWatchlists || [];
      const idx = existing.findIndex((w: any) => w.id === watchlistId);
      if (idx === -1) return res.status(404).json({ error: 'Watchlist not found' });
      existing[idx] = { ...existing[idx], stocks: sanitized, updatedAt: new Date() };
      await db.collection('users').updateOne({ _id: new ObjectId(decoded.userId) }, { $set: { namedWatchlists: existing } });
      return res.status(200).json({ success: true });
    }

    // Create a new named watchlist (pro only)
    if (action === 'create-watchlist') {
      if (!isPro) return res.status(403).json({ error: 'Pro account required' });
      const existing: any[] = user.namedWatchlists || [];
      if (existing.length >= MAX_NAMED_WATCHLISTS) return res.status(400).json({ error: 'Maximum 10 watchlists reached' });
      const newId = randomBytes(8).toString('hex');
      const newWl = { id: newId, name: (name || 'New Watchlist').slice(0, 40), stocks: [], createdAt: new Date() };
      await db.collection('users').updateOne(
        { _id: new ObjectId(decoded.userId) },
        { $push: { namedWatchlists: newWl } as any }
      );
      return res.status(200).json({ success: true, watchlist: newWl });
    }

    // Delete a named watchlist (pro only, cannot delete primary)
    if (action === 'delete-watchlist') {
      if (!isPro) return res.status(403).json({ error: 'Pro account required' });
      if (!watchlistId || watchlistId === 'primary') return res.status(400).json({ error: 'Cannot delete primary watchlist' });
      const update: Record<string, any> = { $pull: { namedWatchlists: { id: watchlistId } } };
      await db.collection('users').updateOne({ _id: new ObjectId(decoded.userId) }, update as any);
      // If the deleted watchlist was active, reset to primary
      if (user.activeWatchlistId === watchlistId) {
        await db.collection('users').updateOne({ _id: new ObjectId(decoded.userId) }, { $set: { activeWatchlistId: 'primary' } });
      }
      return res.status(200).json({ success: true });
    }

    // Rename a watchlist (primary or named, pro only for named)
    if (action === 'rename-watchlist') {
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!watchlistId || watchlistId === 'primary') {
        await db.collection('users').updateOne({ _id: new ObjectId(decoded.userId) }, { $set: { primaryWatchlistName: name.slice(0, 40) } });
        return res.status(200).json({ success: true });
      }
      if (!isPro) return res.status(403).json({ error: 'Pro account required' });
      const existing: any[] = user.namedWatchlists || [];
      const idx = existing.findIndex((w: any) => w.id === watchlistId);
      if (idx === -1) return res.status(404).json({ error: 'Watchlist not found' });
      existing[idx].name = name.slice(0, 40);
      await db.collection('users').updateOne({ _id: new ObjectId(decoded.userId) }, { $set: { namedWatchlists: existing } });
      return res.status(200).json({ success: true });
    }

    // Set the active watchlist for the dashboard
    if (action === 'set-active') {
      if (!watchlistId) return res.status(400).json({ error: 'watchlistId required' });
      await db.collection('users').updateOne({ _id: new ObjectId(decoded.userId) }, { $set: { activeWatchlistId: watchlistId } });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
