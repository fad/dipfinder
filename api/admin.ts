import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import axios from 'axios';
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
      case 'clear-stock-cache':
        return await handleClearStockCache(req, res);
      case 'cache-health':
        return await handleCacheHealth(req, res);
      case 'trigger-health-check':
        return await handleTriggerHealthCheck(req, res);
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

  // 2. Yahoo Finance via yahoo-finance2 — 200-day window (same as batch-stocks)
  const period1_200 = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
  try {
    const chart = await yahooFinance.chart('AAPL', { period1: period1_200, interval: '1d' });
    const quotes: any[] = chart?.quotes ?? [];
    const closes = quotes.map((q: any) => q.close).filter((p: any) => Number.isFinite(p));
    const sampleQuote = quotes[0] ?? null;
    results.yahooFinance200d = {
      ok: true,
      symbol: chart?.meta?.symbol,
      quotesReturned: quotes.length,
      closesFiltered: closes.length,
      lastClose: closes[closes.length - 1] ?? null,
      sampleQuoteKeys: sampleQuote ? Object.keys(sampleQuote) : [],
      sampleQuote,
    };
  } catch (err: any) {
    results.yahooFinance200d = {
      ok: false,
      error: err?.message,
      stack: err?.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }

  // 3. Full batch-stocks simulation for AAPL with SMA 50
  try {
    const db = await connectToDatabase();
    const cacheKey = 'dashboard-stock-AAPL';
    const doc = await db.collection('dashboardStocks').findOne({ cacheKey });
    const cacheAge = doc ? Math.round((Date.now() - doc.timestamp) / 60000) : null;
    const cacheHit = doc && (Date.now() - doc.timestamp) <= 30 * 60 * 1000;

    let dashboardStock = cacheHit ? doc.data : null;

    if (!dashboardStock) {
      // simulate fresh fetch
      const period1 = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
      const chartData = await yahooFinance.chart('AAPL', { period1, interval: '1d' });
      const quotes: any[] = chartData?.quotes ?? [];
      const closes = quotes.map((q: any) => q.close).filter((p: unknown) => Number.isFinite(p));
      if (closes.length >= 2) {
        dashboardStock = {
          companyName: chartData?.meta?.longName || 'Apple Inc.',
          currentPrice: closes[closes.length - 1],
          previousPrice: closes[closes.length - 2],
          closes,
        };
      }
    }

    if (!dashboardStock) {
      results.batchStocksSimulation = { ok: false, note: 'getCachedDashboardStock returned null', cacheAge };
    } else {
      const closes: number[] = dashboardStock.closes;
      const smaPeriod = 50;
      const enoughData = closes.length >= smaPeriod;
      const sma = enoughData ? closes.slice(-smaPeriod).reduce((a: number, b: number) => a + b, 0) / smaPeriod : null;
      results.batchStocksSimulation = {
        ok: enoughData,
        cacheHit,
        cacheAge_minutes: cacheAge,
        closesCount: closes.length,
        enoughFor50SMA: enoughData,
        currentPrice: dashboardStock.currentPrice,
        sma50: sma ? parseFloat(sma.toFixed(2)) : null,
        companyName: dashboardStock.companyName,
      };
    }
  } catch (err: any) {
    results.batchStocksSimulation = {
      ok: false,
      error: err?.message,
      stack: err?.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }

  // 4. Check admin user watchlist
  try {
    const db = await connectToDatabase();
    const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
    const user = await db.collection('users').findOne({ email: adminEmail });
    results.adminUser = user
      ? { ok: true, watchlist: user.watchlist, smaPeriod: user.smaPeriod }
      : { ok: false, note: 'admin user not found in DB' };
  } catch (err: any) {
    results.adminUser = { ok: false, error: err?.message };
  }

  // 5. Finnhub
  try {
    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) throw new Error('FINNHUB_API_KEY not set');
    const today = new Date().toISOString().split('T')[0];
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const r = await axios.get(
      `https://finnhub.io/api/v1/company-news?symbol=AAPL&from=${lastWeek}&to=${today}&token=${finnhubKey}`
    );
    results.finnhub = { ok: Array.isArray(r.data), itemsReturned: Array.isArray(r.data) ? r.data.length : 0 };
  } catch (err: any) {
    results.finnhub = { ok: false, error: err?.message };
  }

  // 6. Resend
  try {
    const resendKey = process.env.EMAIL_NOREPLY_API_KEY;
    if (!resendKey) throw new Error('EMAIL_NOREPLY_API_KEY not set');
    const r = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${resendKey}` }
    });
    results.resend = { ok: r.ok, httpStatus: r.status };
  } catch (err: any) {
    results.resend = { ok: false, error: err?.message };
  }

  return res.status(200).json(results);
}

async function handleClearStockCache(_req: VercelRequest, res: VercelResponse) {
  const db = await connectToDatabase();
  const result = await db.collection('dashboardStocks').deleteMany({});
  const g = globalThis as any;
  if (g._dashboardStockCache) g._dashboardStockCache = {};
  return res.status(200).json({ ok: true, deleted: result.deletedCount });
}

async function handleCacheHealth(_req: VercelRequest, res: VercelResponse) {
  const db = await connectToDatabase();

  // Collect all unique symbols across all user watchlists
  const users = await db.collection('users').find({}, { projection: { watchlist: 1 } }).toArray();
  const symbolSet = new Set<string>();
  for (const u of users) {
    for (const s of (u.watchlist || [])) symbolSet.add(s.toUpperCase());
  }
  const symbols = Array.from(symbolSet).sort();

  // Fetch all dashboardStocks docs in one query
  const cacheDocs = await db.collection('dashboardStocks')
    .find({ cacheKey: { $in: symbols.map(s => `dashboard-stock-${s}`) } })
    .toArray();
  const cacheByKey: Record<string, any> = {};
  for (const doc of cacheDocs) cacheByKey[doc.cacheKey] = doc;

  const CACHE_TTL_MS = 30 * 60 * 1000;
  const rows = symbols.map(symbol => {
    const doc = cacheByKey[`dashboard-stock-${symbol}`];
    if (!doc) {
      return { symbol, companyName: '-', cacheAge_minutes: null, closesCount: null, currentPrice: null, status: 'missing' };
    }
    const age = Math.round((Date.now() - doc.timestamp) / 60000);
    const data = doc.data || {};
    return {
      symbol,
      companyName: data.companyName || '-',
      cacheAge_minutes: age,
      closesCount: (data.closes || []).length,
      currentPrice: data.currentPrice ?? null,
      status: age <= 30 ? 'fresh' : 'stale',
    };
  });

  return res.status(200).json({ symbols: rows, total: rows.length, ttl_minutes: CACHE_TTL_MS / 60000 });
}

async function handleTriggerHealthCheck(_req: VercelRequest, res: VercelResponse) {
  // Forward to the health-check endpoint using internal fetch
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET not set' });

  try {
    const r = await fetch(`${FRONTEND_URL}/api/health-check`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${CRON_SECRET}` }
    });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
}
