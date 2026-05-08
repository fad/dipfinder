import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import { connectToDatabase } from './lib/mongodb';
import { yahooFinance } from './lib/stocks';
import { getEmailTemplate, saveEmailTemplate, listTemplateKeys, sendEmail, buildEmailHtml, renderTemplate } from './lib/email';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Login action is unauthenticated (has its own credential check)
  if (req.query.action === 'login') {
    return await handleAdminLogin(req, res);
  }

  // All other actions require a valid admin JWT
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
      case 'list-templates':
        return await handleListTemplates(req, res);
      case 'get-template':
        return await handleGetTemplate(req, res);
      case 'save-template':
        return await handleSaveTemplate(req, res);
      case 'preview-template':
        return await handlePreviewTemplate(req, res);
      case 'send-test-template':
        return await handleSendTestTemplate(req, res);
      case 'trigger-onboarding':
        return await handleTriggerOnboarding(req, res);
      case 'delete-user':
        return await handleDeleteUser(req, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'Internal server error', detail: err?.message });
  }
}

async function handleAdminLogin(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (!ADMIN_EMAIL || email.toLowerCase() !== ADMIN_EMAIL) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const db = await connectToDatabase();
  const user = await db.collection('users').findOne({ email: ADMIN_EMAIL });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
  return res.status(200).json({ token, user: { id: user._id, email: user.email, name: user.name } });
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
    const ok = r.ok || r.status === 401;
    results.resend = { ok, httpStatus: r.status, note: r.status === 401 ? 'send-only key (expected)' : undefined };
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

// ── Email template management ─────────────────────────────────────────────────

async function handleListTemplates(_req: VercelRequest, res: VercelResponse) {
  const keys = listTemplateKeys();
  const db = await connectToDatabase();
  const docs = await db.collection('emailTemplates').find({}).toArray();
  const savedKeys = new Set(docs.map((d: any) => d.key));
  return res.status(200).json({
    templates: keys.map(k => ({ ...k, saved: savedKeys.has(k.key) }))
  });
}

async function handleGetTemplate(req: VercelRequest, res: VercelResponse) {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: 'key required' });
  const db = await connectToDatabase();
  const template = await getEmailTemplate(db, key);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  return res.status(200).json(template);
}

async function handleSaveTemplate(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { key, subject, html, _delete } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  const db = await connectToDatabase();
  if (_delete) {
    await db.collection('emailTemplates').deleteOne({ key });
    return res.status(200).json({ ok: true });
  }
  if (!subject || !html) return res.status(400).json({ error: 'subject and html required' });
  await saveEmailTemplate(db, key, subject, html);
  return res.status(200).json({ ok: true });
}

async function handlePreviewTemplate(req: VercelRequest, res: VercelResponse) {
  const key = (req.query.key || req.body?.key) as string;
  if (!key) return res.status(400).json({ error: 'key required' });
  const db = await connectToDatabase();
  const template = await getEmailTemplate(db, key);
  if (!template) return res.status(404).send('<p>Template not found</p>');

  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';
  const dummyVars: Record<string, string> = {
    name: 'Frank',
    email: ADMIN_EMAIL || 'admin@dipfinder.com',
    resetUrl: `${FRONTEND_URL}/reset-password.html?token=PREVIEW_TOKEN`,
    magicUrl: `${FRONTEND_URL}/app?magic=PREVIEW_TOKEN`,
    unsubscribeUrl: `${FRONTEND_URL}/api/newsletter-unsubscribe?token=PREVIEW_TOKEN`,
  };
  const html = renderTemplate(template.html, dummyVars);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

async function handleSendTestTemplate(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  if (!ADMIN_EMAIL) return res.status(500).json({ error: 'ADMIN_EMAIL not set' });

  const db = await connectToDatabase();
  const template = await getEmailTemplate(db, key);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';
  const dummyVars: Record<string, string> = {
    name: 'Frank',
    email: ADMIN_EMAIL,
    resetUrl: `${FRONTEND_URL}/reset-password.html?token=TEST_TOKEN`,
    magicUrl: `${FRONTEND_URL}/app?magic=TEST_TOKEN`,
    unsubscribeUrl: `${FRONTEND_URL}/api/newsletter-unsubscribe?token=TEST_TOKEN`,
  };
  const html = renderTemplate(template.html, dummyVars);
  const ok = await sendEmail({ to: ADMIN_EMAIL, subject: `[TEST] ${template.subject}`, html });
  return res.status(200).json({ ok, to: ADMIN_EMAIL });
}

async function handleTriggerOnboarding(_req: VercelRequest, res: VercelResponse) {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET not set' });
  try {
    const r = await fetch(`${FRONTEND_URL}/api/newsletter-onboarding`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CRON_SECRET}` }
    });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
}

async function handleDeleteUser(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  if (email.toLowerCase() === ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Cannot delete the admin account' });
  }
  const db = await connectToDatabase();
  const result = await db.collection('users').deleteOne({ email: email.toLowerCase() });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'User not found' });
  return res.status(200).json({ ok: true });
}
