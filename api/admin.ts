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
      case 'toggle-pro':
        return await handleTogglePro(req, res);
      case 'get-settings':
        return await handleGetSettings(req, res);
      case 'save-settings':
        return await handleSaveSettings(req, res);
      case 'get-crons':
        return await handleGetCrons(req, res);
      case 'save-cron-schedule':
        return await handleSaveCronSchedule(req, res);
      case 'trigger-cron':
        return await handleTriggerCron(req, res);
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
  // Ensure admin always has pro status
  if (!user.isPro) {
    await db.collection('users').updateOne({ email: ADMIN_EMAIL }, { $set: { isPro: true } });
  }
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

function buildDummyVars(token: string): Record<string, string> {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';
  const shortDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return {
    name: 'Frank',
    email: ADMIN_EMAIL || 'admin@dipfinder.com',
    resetUrl: `${FRONTEND_URL}/reset-password.html?token=${token}`,
    magicUrl: `${FRONTEND_URL}/app?magic=${token}`,
    unsubscribeUrl: `${FRONTEND_URL}/api/newsletter-unsubscribe?token=${token}`,
    setPasswordBlock: `<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;">As a welcome gift, we've upgraded your watchlist to <strong>10 stock slots</strong> - double the usual free limit. Set a password to keep your account.</p><div style="text-align:center;margin:28px 0;"><a href="${FRONTEND_URL}/reset-password.html?setup=${token}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#4F46E5);color:#FFFFFF;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;font-family:Arial,sans-serif;">Set My Password &rarr;</a></div><div style="background:#DCFCE7;border-left:4px solid #16A34A;border-radius:0 8px 8px 0;padding:14px 18px;margin:0 0 24px;"><p style="font-family:Arial,sans-serif;font-size:13px;color:#14532D;margin:0;line-height:1.6;">This link expires in 7 days. You can also sign in at any time using a magic link from the login page.</p></div>`,
    watchlistChartBlock: `<div style="margin:24px 0;"><p style="font-family:Arial,sans-serif;font-size:12px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 10px;">Your Watchlist vs 50-day SMA</p><img src="https://quickchart.io/chart?w=556&h=130&bkg=%23ffffff&c=%7Btype%3A%27horizontalBar%27%2Cdata%3A%7Blabels%3A%5B%27INTU%27%2C%27MSFT%27%2C%27AAPL%27%2C%27CRM%27%5D%2Cdatasets%3A%5B%7Bdata%3A%5B-8.2%2C-3.1%2C1.4%2C5.7%5D%2CbackgroundColor%3A%5B%27%230F766E%27%2C%27%2314B8A6%27%2C%2394A3B8%27%2C%27%23FBBF24%27%5D%7D%5D%7D%2Coptions%3A%7Blegend%3A%7Bdisplay%3Afalse%7D%7D%7D" width="100%" alt="Watchlist dip chart (preview)" style="display:block;border-radius:8px;border:1px solid #e2e8f0;max-width:556px;"></div>`,
    shortDate,
    dateLabel,
    smaPeriod: '50',
    viewOnlineBlock: `<span style="display:table-cell;text-align:right;"><a href="${FRONTEND_URL}/newsletter/${token}" style="color:#64748b;font-size:0.75em;text-decoration:none;">View Online</a></span>`,
    chartBlock: `<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:24px;"><img src="https://quickchart.io/chart?w=556&h=104&bkg=%23ffffff&c=%7Btype%3A%27horizontalBar%27%2Cdata%3A%7Blabels%3A%5B%27INTU%27%2C%27MSFT%27%2C%27AAPL%27%2C%27CRM%27%5D%2Cdatasets%3A%5B%7Bdata%3A%5B-8.2%2C-3.1%2C1.4%2C5.7%5D%2CbackgroundColor%3A%5B%27%230F766E%27%2C%27%2314B8A6%27%2C%2794A3B8%27%2C%27%23FBBF24%27%5D%7D%5D%7D%2Coptions%3A%7Blegend%3A%7Bdisplay%3Afalse%7D%7D%7D" width="556" height="104" alt="Watchlist dip chart" style="display:block;"></div>`,
    watchlistTable: `<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:28px;"><table style="width:100%;border-collapse:collapse;font-size:0.875rem;"><thead><tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;"><th style="padding:10px 14px;text-align:left;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;">Ticker</th><th style="padding:10px 14px;text-align:left;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;">Company</th><th style="padding:10px 14px;text-align:right;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;">Price</th><th style="padding:10px 14px;text-align:right;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;">50d SMA</th><th style="padding:10px 14px;text-align:right;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;">vs SMA</th></tr></thead><tbody><tr><td style="padding:0;border-bottom:1px solid #f1f5f9;white-space:nowrap;"><a href="#" style="display:block;padding:10px 14px;font-weight:700;color:#1e293b;text-decoration:none;">INTU</a></td><td style="padding:0;border-bottom:1px solid #f1f5f9;"><a href="#" style="display:block;padding:10px 14px;color:#64748b;font-size:0.85em;text-decoration:none;">Intuit Inc.</a></td><td style="padding:0;border-bottom:1px solid #f1f5f9;"><a href="#" style="display:block;padding:10px 14px;color:#1e293b;text-align:right;text-decoration:none;">$580.00</a></td><td style="padding:0;border-bottom:1px solid #f1f5f9;"><a href="#" style="display:block;padding:10px 14px;color:#64748b;text-align:right;text-decoration:none;">$631.74</a></td><td style="padding:0;border-bottom:1px solid #f1f5f9;text-align:right;"><a href="#" style="display:block;padding:10px 14px;text-align:right;text-decoration:none;"><span style="background:#CCFBF1;color:#0F766E;font-weight:700;font-size:0.82em;padding:3px 8px;border-radius:999px;">-8.2%</span></a></td></tr><tr><td style="padding:0;white-space:nowrap;"><a href="#" style="display:block;padding:10px 14px;font-weight:700;color:#1e293b;text-decoration:none;">MSFT</a></td><td style="padding:0;"><a href="#" style="display:block;padding:10px 14px;color:#64748b;font-size:0.85em;text-decoration:none;">Microsoft Corp.</a></td><td style="padding:0;"><a href="#" style="display:block;padding:10px 14px;color:#1e293b;text-align:right;text-decoration:none;">$388.00</a></td><td style="padding:0;"><a href="#" style="display:block;padding:10px 14px;color:#64748b;text-align:right;text-decoration:none;">$400.31</a></td><td style="padding:0;text-align:right;"><a href="#" style="display:block;padding:10px 14px;text-align:right;text-decoration:none;"><span style="background:#CCFBF1;color:#0F766E;font-weight:700;font-size:0.82em;padding:3px 8px;border-radius:999px;">-3.1%</span></a></td></tr></tbody></table></div>`,
    newsBlock: `<h2 style="margin:0 0 14px;font-size:0.75em;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">This Week's News</h2><div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:12px;overflow:hidden;"><div style="padding:12px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;"><a href="#" style="font-weight:800;color:#1e293b;font-size:0.95em;margin-right:8px;text-decoration:none;">INTU</a><a href="#" style="color:#64748b;font-size:0.8em;text-decoration:none;">Intuit Inc.</a><span style="float:right;font-weight:700;color:#0F766E;font-size:0.85em;">-8.2%</span></div><div style="padding:0 16px;"><a href="#" style="display:block;text-decoration:none;padding:10px 0;border-bottom:1px solid #f1f5f9;"><span style="font-size:0.78em;font-weight:600;color:#2563eb;text-transform:uppercase;letter-spacing:0.05em;">Reuters</span><p style="margin:3px 0 0;color:#1e293b;font-size:0.875em;line-height:1.4;">Intuit beats Q2 estimates as AI-powered tax features drive adoption</p></a></div></div>`,
  };
}

async function handlePreviewTemplate(req: VercelRequest, res: VercelResponse) {
  const key = (req.query.key || req.body?.key) as string;
  if (!key) return res.status(400).json({ error: 'key required' });
  const db = await connectToDatabase();
  const template = await getEmailTemplate(db, key);
  if (!template) return res.status(404).send('<p>Template not found</p>');

  const dummyVars = buildDummyVars('PREVIEW_TOKEN');
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

  const dummyVars = buildDummyVars('TEST_TOKEN');
  dummyVars.email = ADMIN_EMAIL;
  const html = renderTemplate(template.html, dummyVars);
  const subject = renderTemplate(`[TEST] ${template.subject}`, dummyVars);
  const ok = await sendEmail({ to: ADMIN_EMAIL, subject, html });
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

// ── Cron management ───────────────────────────────────────────────────────────

const CRON_DEFS = [
  {
    id: 'newsletter-send',
    name: 'Weekly Newsletter',
    description: 'Sends the weekly dip report to all subscribers.',
    endpoint: '/api/newsletter-send',
    method: 'POST',
    vercelSchedule: 'Sundays at 14:00 UTC',
    defaultSchedule: { enabled: true, dayOfWeek: 0, hour: 14 },
  },
  {
    id: 'health-check',
    name: 'Health Check',
    description: 'Verifies MongoDB, Yahoo Finance, Finnhub, and Resend connectivity. Emails admin on failure.',
    endpoint: '/api/health-check',
    method: 'GET',
    vercelSchedule: 'Daily at 09:00 UTC',
    defaultSchedule: { enabled: true, hour: 9 },
  },
  {
    id: 'newsletter-onboarding',
    name: 'Onboarding Emails',
    description: 'Sends welcome emails to new Sunday Brief subscribers who have not yet received one.',
    endpoint: '/api/newsletter-onboarding',
    method: 'POST',
    vercelSchedule: 'Daily at 10:00 UTC',
    defaultSchedule: { enabled: true, hour: 10 },
  },
] as const;

async function handleGetCrons(_req: VercelRequest, res: VercelResponse) {
  const db = await connectToDatabase();
  const crons = await Promise.all(CRON_DEFS.map(async def => {
    const [scheduleDoc, lastRunDoc] = await Promise.all([
      db.collection('settings').findOne({ key: `cron-schedule-${def.id}` }),
      db.collection('settings').findOne({ key: `cron-last-run-${def.id}` }),
    ]);
    return {
      ...def,
      schedule: scheduleDoc?.value ?? def.defaultSchedule,
      lastRun: lastRunDoc?.value ?? null,
    };
  }));
  return res.status(200).json({ crons });
}

async function handleSaveCronSchedule(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { id, schedule } = req.body || {};
  if (!id || !schedule) return res.status(400).json({ error: 'id and schedule required' });
  const def = CRON_DEFS.find(d => d.id === id);
  if (!def) return res.status(404).json({ error: 'Unknown cron id' });

  const { enabled, dayOfWeek, hour } = schedule;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  const parsedHour = Number(hour);
  if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23) return res.status(400).json({ error: 'hour must be 0–23' });

  const saved: Record<string, any> = { enabled, hour: parsedHour };
  if ('dayOfWeek' in def.defaultSchedule) {
    const parsedDay = Number(dayOfWeek);
    if (!Number.isInteger(parsedDay) || parsedDay < 0 || parsedDay > 6) return res.status(400).json({ error: 'dayOfWeek must be 0–6' });
    saved.dayOfWeek = parsedDay;
  }

  const db = await connectToDatabase();
  await db.collection('settings').updateOne(
    { key: `cron-schedule-${id}` },
    { $set: { key: `cron-schedule-${id}`, value: saved, updatedAt: new Date() } },
    { upsert: true }
  );
  return res.status(200).json({ ok: true, schedule: saved });
}

async function handleTriggerCron(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { id } = req.body || {};
  const def = CRON_DEFS.find(d => d.id === id);
  if (!def) return res.status(404).json({ error: 'Unknown cron id' });

  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET not set' });

  try {
    const r = await fetch(`${FRONTEND_URL}${def.endpoint}`, {
      method: def.method,
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
}

async function handleGetSettings(_req: VercelRequest, res: VercelResponse) {
  const db = await connectToDatabase();
  const [stocksDoc, smaDoc, orientationDoc] = await Promise.all([
    db.collection('settings').findOne({ key: 'initialStocks' }),
    db.collection('settings').findOne({ key: 'defaultSmaPeriod' }),
    db.collection('settings').findOne({ key: 'defaultChartOrientation' }),
  ]);
  return res.status(200).json({
    initialStocks: stocksDoc?.value ?? ['CRM', 'MSFT', 'AAPL', 'INTU'],
    defaultSmaPeriod: smaDoc?.value ?? 200,
    defaultChartOrientation: orientationDoc?.value ?? 'x',
  });
}

const TICKER_RE_SETTINGS = /^[A-Z0-9.\-]{1,10}$/;

async function handleSaveSettings(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { initialStocks, defaultSmaPeriod, defaultChartOrientation } = req.body || {};
  const db = await connectToDatabase();
  const ops: Promise<any>[] = [];

  if (Array.isArray(initialStocks)) {
    const safe = (initialStocks as any[])
      .filter((s: any) => typeof s === 'string' && TICKER_RE_SETTINGS.test(s.toUpperCase()))
      .map((s: any) => (s as string).toUpperCase())
      .slice(0, 20);
    ops.push(db.collection('settings').updateOne(
      { key: 'initialStocks' },
      { $set: { key: 'initialStocks', value: safe, updatedAt: new Date() } },
      { upsert: true }
    ));
  }

  if (defaultSmaPeriod !== undefined) {
    const period = Number(defaultSmaPeriod);
    if (!Number.isFinite(period) || period <= 0) return res.status(400).json({ error: 'defaultSmaPeriod must be a positive number' });
    ops.push(db.collection('settings').updateOne(
      { key: 'defaultSmaPeriod' },
      { $set: { key: 'defaultSmaPeriod', value: period, updatedAt: new Date() } },
      { upsert: true }
    ));
  }

  if (defaultChartOrientation !== undefined) {
    if (defaultChartOrientation !== 'x' && defaultChartOrientation !== 'y') return res.status(400).json({ error: 'defaultChartOrientation must be x or y' });
    ops.push(db.collection('settings').updateOne(
      { key: 'defaultChartOrientation' },
      { $set: { key: 'defaultChartOrientation', value: defaultChartOrientation, updatedAt: new Date() } },
      { upsert: true }
    ));
  }

  await Promise.all(ops);
  return res.status(200).json({ ok: true });
}

async function handleTogglePro(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, isPro } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const db = await connectToDatabase();
  const result = await db.collection('users').updateOne(
    { email: email.toLowerCase() },
    { $set: { isPro: !!isPro } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'User not found' });
  return res.status(200).json({ ok: true, isPro: !!isPro });
}
