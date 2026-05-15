import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { connectToDatabase } from './lib/mongodb';
import { yahooFinance, calculateSma } from './lib/stocks';
import { getEmailTemplate, saveEmailTemplate, listTemplateKeys, sendEmail, buildEmailHtml, renderTemplate } from './lib/email';
import Anthropic from '@anthropic-ai/sdk';
import { fetchStockData, fetchNewsForSymbol, NEWSLETTER_SMA_DEFAULT } from './lib/newsletter-data';
import { generateAiSummary, upsertAiSummary, getAiPromptTemplate, DEFAULT_NEWS_SUMMARY_PROMPT, deduplicateNewsItems } from './lib/ai-summaries';
import { verifyJWT } from './lib/auth';
import { shouldCronRun, recordCronRun } from './lib/cron-schedule';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL?.toLowerCase();
const CRON_SECRET    = process.env.CRON_SECRET;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const RESEND_API_KEY = process.env.EMAIL_NOREPLY_API_KEY;
const FRONTEND_URL   = process.env.FRONTEND_URL || 'https://dipfinder.com';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Public ping — no auth required
  if (req.query.action === 'ping') {
    return res.status(200).json({ status: 'API is working correctly', timestamp: new Date().toISOString() });
  }

  // Login action is unauthenticated (has its own credential check)
  if (req.query.action === 'login') {
    return await handleAdminLogin(req, res);
  }

  // Cron-secret auth — only for cron-invocable actions
  if (CRON_SECRET && req.headers.authorization === `Bearer ${CRON_SECRET}`) {
    const action = req.query.action as string;
    if (action === 'health-check') return await handleHealthCheck(req, res);
    if (action === 'morning-report') return await handleMorningReport(req, res);
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
      case 'health-check':
      case 'trigger-health-check':
        return await handleHealthCheck(req, res);
      case 'morning-report':
        return await handleMorningReport(req, res);
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
      case 'list-tickers':
        return await handleListTickers(req, res);
      case 'toggle-ticker':
        return await handleToggleTicker(req, res);
      case 'toggle-subscription':
        return await handleToggleSubscription(req, res);
      case 'list-ai-summaries':
        return await handleListAiSummaries(req, res);
      case 'update-ai-summary':
        return await handleUpdateAiSummary(req, res);
      case 'generate-ai-summaries':
        return await handleGenerateAiSummaries(req, res);
      case 'regenerate-ai-summary':
        return await handleRegenerateAiSummary(req, res);
      case 'list-ai-cost-history':
        return await handleListAiCostHistory(res);
      case 'get-ai-prompt':
        return await handleGetAiPrompt(res);
      case 'save-ai-prompt':
        return await handleSaveAiPrompt(req, res);
      case 'test-ai':
        return await handleTestAi(res);
      case 'list-shared-watchlists':
        return await handleListSharedWatchlists(res);
      case 'youtube-process':
        return await handleYoutubeProcess(req, res);
      case 'youtube-save':
        return await handleYoutubeSave(req, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err: any) {
    console.error(`Admin action "${action}" failed:`, err);
    return res.status(500).json({ error: 'Internal server error' });
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

async function handleHealthCheck(req: VercelRequest, res: VercelResponse) {
  const isCronInvocation = !!req.headers['x-vercel-cron'];
  const db0 = await connectToDatabase();
  const run = await shouldCronRun(db0, 'health-check', { enabled: true, hour: 9 }, isCronInvocation);
  if (!run) return res.status(200).json({ skipped: true, reason: 'outside scheduled window' });

  const results: Record<string, any> = { checkedAt: new Date().toISOString() };

  // 1. MongoDB
  try {
    const db = await connectToDatabase();
    const userCount = await db.collection('users').countDocuments();
    results.mongodb = { ok: true, userCount };
  } catch (err: any) {
    results.mongodb = { ok: false, error: err?.message };
  }

  // 2. Yahoo Finance
  try {
    const period1 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const chart = await yahooFinance.chart('AAPL', { period1, interval: '1d' });
    const quotes: any[] = chart?.quotes ?? [];
    results.yahooFinance = { ok: quotes.length > 0, quotesReturned: quotes.length, symbol: chart?.meta?.symbol };
  } catch (err: any) {
    results.yahooFinance = { ok: false, error: err?.message };
  }

  // 3. Finnhub
  try {
    if (!FINNHUB_API_KEY) throw new Error('FINNHUB_API_KEY not set');
    const today    = new Date().toISOString().split('T')[0];
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const r = await axios.get(
      `https://finnhub.io/api/v1/company-news?symbol=AAPL&from=${lastWeek}&to=${today}&token=${FINNHUB_API_KEY}`
    );
    results.finnhub = { ok: Array.isArray(r.data), itemsReturned: Array.isArray(r.data) ? r.data.length : 0 };
  } catch (err: any) {
    results.finnhub = { ok: false, error: err?.message };
  }

  // 4. Resend — 401 on /domains means send-only key (valid), 403/5xx = real problem
  try {
    if (!RESEND_API_KEY) throw new Error('EMAIL_NOREPLY_API_KEY not set');
    const r = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` }
    });
    const ok = r.ok || r.status === 401;
    results.resend = { ok, httpStatus: r.status, note: r.status === 401 ? 'send-only key (expected)' : undefined };
  } catch (err: any) {
    results.resend = { ok: false, error: err?.message };
  }

  // 5. Anthropic AI
  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    const start  = Date.now();
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg    = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with just: ok' }],
    });
    const reply = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    results.anthropic = { ok: true, reply, latencyMs: Date.now() - start };
  } catch (err: any) {
    results.anthropic = { ok: false, error: err?.message };
  }

  const anyFailed = Object.entries(results)
    .filter(([k]) => k !== 'checkedAt')
    .some(([, v]) => v?.ok === false);
  results.anyFailed = anyFailed;

  const isCron = isCronInvocation;
  const shouldEmail = !isCron || anyFailed;
  let emailSent = false;

  if (shouldEmail && ADMIN_EMAIL) {
    const checks = ['mongodb', 'yahooFinance', 'finnhub', 'resend', 'anthropic'];
    const rows = checks.map(key => {
      const v = results[key] ?? {};
      const detail = v.error ?? v.httpStatus ?? v.quotesReturned ?? v.itemsReturned ?? v.userCount ?? '';
      return `<tr>
        <td style="padding:8px 16px;font-weight:600;text-transform:capitalize;">${key}</td>
        <td style="padding:8px 16px;color:${v.ok ? '#16a34a' : '#dc2626'};font-weight:700;">${v.ok ? 'OK' : 'FAILED'}</td>
        <td style="padding:8px 16px;font-family:monospace;font-size:12px;color:#6b7280;">${detail}</td>
      </tr>`;
    }).join('');

    const subject = anyFailed
      ? 'DipFinder Health Check - ISSUES DETECTED'
      : 'DipFinder Health Check - All systems OK';

    emailSent = await sendEmail({
      to: ADMIN_EMAIL,
      subject,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;color:#111827;">
          <h2 style="margin:0 0 4px;color:${anyFailed ? '#dc2626' : '#16a34a'};">
            ${anyFailed ? '&#9888;&#65039; Issues detected' : '&#9989; All systems OK'}
          </h2>
          <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">${results.checkedAt}</p>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:8px 16px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Service</th>
                <th style="padding:8px 16px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Status</th>
                <th style="padding:8px 16px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Detail</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin-top:24px;">
            <a href="${FRONTEND_URL}/admin" style="color:#3b82f6;">Open Admin &rarr;</a>
          </p>
        </div>
      `
    });
  }

  results.emailSent = emailSent;
  await recordCronRun(db0, 'health-check', { anyFailed: results.anyFailed, emailSent }, !isCronInvocation);
  return res.status(200).json(results);
}

// ── Morning Report (daily admin email) ────────────────────────────────────────

const MORNING_REPORT_CRON_NAMES: Record<string, string> = {
  'morning-report':            'Morning Report',
  'health-check':              'Health Check',
  'newsletter-onboarding':     'Onboarding Emails',
  'newsletter-snapshot':       'Weekly Snapshot',
  'newsletter-ai-summaries':   'AI Summaries',
  'newsletter-send':           'Weekly Newsletter',
};

async function handleMorningReport(req: VercelRequest, res: VercelResponse) {
  const isCronInvocation = !!req.headers['x-vercel-cron'];
  const db = await connectToDatabase();
  const run = await shouldCronRun(db, 'morning-report', { enabled: true, hour: 7 }, isCronInvocation);
  if (!run) return res.status(200).json({ skipped: true, reason: 'outside scheduled window' });

  if (!ADMIN_EMAIL) return res.status(500).json({ error: 'ADMIN_EMAIL not set' });

  const oneDayAgo    = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const isSunday = new Date().getUTCDay() === 0;

  const [totalUsers, newToday, newThisWeek, sundayBriefSubs, newsletterSubs, activeTickerCount, pendingSummaries] = await Promise.all([
    db.collection('users').countDocuments({}),
    db.collection('users').countDocuments({ createdDate: { $gte: oneDayAgo } }),
    db.collection('users').countDocuments({ createdDate: { $gte: sevenDaysAgo } }),
    db.collection('users').countDocuments({ sundayBriefSubscribed: true }),
    db.collection('users').countDocuments({ newsletterSubscribed: true }),
    db.collection('tickers').countDocuments({ active: true }),
    isSunday ? db.collection('aiSummaries').countDocuments({ reviewed: false }) : Promise.resolve(0),
  ]);

  const cronIds  = Object.keys(MORNING_REPORT_CRON_NAMES);
  const cronDocs = await db.collection('settings')
    .find({ key: { $in: cronIds.map(id => `cron-last-run-${id}`) } })
    .toArray();
  const cronByKey: Record<string, any> = {};
  for (const doc of cronDocs) cronByKey[doc.key] = doc.value;

  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const statItems = [
    { label: 'Total Users',       value: totalUsers.toLocaleString() },
    { label: 'New Today',         value: newToday.toLocaleString() },
    { label: 'New This Week',     value: newThisWeek.toLocaleString() },
    { label: 'Sunday Brief Subs', value: sundayBriefSubs.toLocaleString() },
    { label: 'Newsletter Subs',   value: newsletterSubs.toLocaleString() },
    { label: 'Active Tickers',    value: activeTickerCount.toLocaleString() },
    ...(isSunday ? [{ label: 'Pending Summaries', value: pendingSummaries.toLocaleString() }] : []),
  ];

  const statCells = statItems.map(s => `
    <td style="padding:0 8px 0 0; vertical-align:top; min-width:90px;">
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px 14px; text-align:center;">
        <div style="font-size:1.5rem; font-weight:700; color:#1e293b; line-height:1;">${s.value}</div>
        <div style="font-size:0.68rem; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; margin-top:5px;">${s.label}</div>
      </div>
    </td>`).join('');

  const cronRows = cronIds.map(id => {
    const last = cronByKey[`cron-last-run-${id}`];
    if (!last) {
      return `<tr style="border-top:1px solid #f1f5f9;">
        <td style="padding:9px 14px; font-size:0.875em; color:#1e293b; font-weight:600;">${MORNING_REPORT_CRON_NAMES[id]}</td>
        <td style="padding:9px 14px; font-size:0.875em; color:#94a3b8;" colspan="2">Never run</td>
      </tr>`;
    }
    const ranAt = new Date(last.ranAt).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'UTC', timeZoneName: 'short',
    });
    const failed = last.result?.anyFailed === true;
    const badge  = failed
      ? '<span style="background:#FEE2E2;color:#DC2626;font-weight:700;font-size:0.75em;padding:2px 8px;border-radius:999px;">FAILED</span>'
      : '';
    return `<tr style="border-top:1px solid #f1f5f9;">
      <td style="padding:9px 14px; font-size:0.875em; color:#1e293b; font-weight:600;">${MORNING_REPORT_CRON_NAMES[id]}</td>
      <td style="padding:9px 14px; font-size:0.875em; color:#64748b;">${ranAt}${last.manual ? ' (manual)' : ''}</td>
      <td style="padding:9px 14px; text-align:right;">${badge}</td>
    </tr>`;
  }).join('');

  const pendingBanner = isSunday && pendingSummaries > 0 ? `
<div style="background:#FEF9C3; border-left:4px solid #EAB308; border-radius:6px; padding:12px 16px; margin-bottom:20px;">
  <strong style="color:#92400E;">Action required:</strong>
  <span style="color:#78350F;"> ${pendingSummaries} AI ${pendingSummaries === 1 ? 'summary needs' : 'summaries need'} review before today's newsletter send.</span>
  <a href="${FRONTEND_URL}/admin" style="color:#1d4ed8; font-weight:700; margin-left:6px;">Review now &rarr;</a>
</div>` : '';

  const bodyHtml = `
<h2 style="font-size:1.05rem; font-weight:700; color:#1e293b; margin:0 0 4px;">Good morning - daily report</h2>
<p style="font-size:13px; color:#94a3b8; margin:0 0 22px;">${dateLabel}</p>
${pendingBanner}
<table style="border-collapse:collapse; margin-bottom:24px; width:100%;"><tr>${statCells}</tr></table>
<h3 style="font-size:0.72em; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.08em; margin:0 0 8px;">Cron Last Run</h3>
<table style="width:100%; border-collapse:collapse; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; font-family:Arial,Helvetica,sans-serif; margin-bottom:24px;">
  <tbody>${cronRows}</tbody>
</table>
<div style="text-align:center; margin-top:8px;">
  <a href="${FRONTEND_URL}/admin" style="display:inline-block; background:linear-gradient(135deg,#2563EB,#4F46E5); color:#FFFFFF; padding:12px 28px; border-radius:8px; text-decoration:none; font-weight:700; font-size:14px; font-family:Arial,Helvetica,sans-serif;">Open Admin &rarr;</a>
</div>`;

  const html      = buildEmailHtml(bodyHtml);
  const shortDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const subject   = `DipFinder Morning Report - ${shortDate}`;

  const emailSent = await sendEmail({ to: ADMIN_EMAIL, subject, html });
  const result    = { totalUsers, newToday, newThisWeek, sundayBriefSubs, newsletterSubs, activeTickerCount, emailSent };
  await recordCronRun(db, 'morning-report', result, !isCronInvocation);
  return res.status(200).json(result);
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
    openerSummary: '2 of your stocks moved into dip territory this week. Here\'s what changed and why.',
    viewOnlineBlock: `<span style="display:table-cell;text-align:right;"><a href="${FRONTEND_URL}/newsletter/${token}" style="color:#64748b;font-size:0.75em;text-decoration:none;">View Online</a></span>`,
    weekAhead: `<div style="margin-top:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:4px 16px 14px;"><h2 style="margin:14px 0 10px;padding-bottom:8px;font-size:0.7em;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid #f1f5f9;text-align:left;">The week ahead</h2><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;"><tr><td style="font-size:0.875em;font-weight:700;color:#1e293b;white-space:nowrap;padding:3px 16px 3px 0;vertical-align:top;">AAPL</td><td style="font-size:0.875em;color:#374151;padding:3px 0;vertical-align:top;">Wednesday earnings <span style="color:#94a3b8;">after close</span></td></tr><tr><td style="font-size:0.875em;font-weight:700;color:#1e293b;white-space:nowrap;padding:3px 16px 3px 0;vertical-align:top;">MSFT</td><td style="font-size:0.875em;color:#374151;padding:3px 0;vertical-align:top;">Thursday earnings <span style="color:#94a3b8;">after close</span></td></tr><tr><td style="font-size:0.875em;font-weight:700;color:#1e293b;white-space:nowrap;padding:3px 16px 3px 0;vertical-align:top;">V</td><td style="font-size:0.875em;color:#374151;padding:3px 0;vertical-align:top;">Friday earnings <span style="color:#94a3b8;">before open</span></td></tr></table></div>`,
    tierCounts: `<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;border-collapse:separate;border-spacing:0;"><tr><td style="width:25%;padding:0 4px;"><div style="background:#CCFBF1;border:1px solid #99F6E4;border-radius:8px;padding:12px 8px;text-align:center;"><div style="font-size:1.4em;font-weight:800;color:#0F766E;line-height:1;">2</div><div style="font-size:0.62em;font-weight:700;color:#0F766E;text-transform:uppercase;letter-spacing:0.07em;margin-top:4px;">Deep Dip</div></div></td><td style="width:25%;padding:0 4px;"><div style="background:#F0FDFA;border:1px solid #CCFBF1;border-radius:8px;padding:12px 8px;text-align:center;"><div style="font-size:1.4em;font-weight:800;color:#0D9488;line-height:1;">1</div><div style="font-size:0.62em;font-weight:700;color:#0D9488;text-transform:uppercase;letter-spacing:0.07em;margin-top:4px;">Dipping</div></div></td><td style="width:25%;padding:0 4px;"><div style="background:#F1F5F9;border:1px solid #E2E8F0;border-radius:8px;padding:12px 8px;text-align:center;"><div style="font-size:1.4em;font-weight:800;color:#475569;line-height:1;">1</div><div style="font-size:0.62em;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.07em;margin-top:4px;">Fair</div></div></td><td style="width:25%;padding:0 4px;"><div style="background:#FEF3C7;border:1px solid #FDE68A;border-radius:8px;padding:12px 8px;text-align:center;"><div style="font-size:1.4em;font-weight:800;color:#B45309;line-height:1;">0</div><div style="font-size:0.62em;font-weight:700;color:#B45309;text-transform:uppercase;letter-spacing:0.07em;margin-top:4px;">Hot</div></div></td></tr></table>`,
    chartBlock: `<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:24px;"><img src="https://quickchart.io/chart?w=556&h=104&bkg=%23ffffff&c=%7Btype%3A%27horizontalBar%27%2Cdata%3A%7Blabels%3A%5B%27INTU%27%2C%27MSFT%27%2C%27AAPL%27%2C%27CRM%27%5D%2Cdatasets%3A%5B%7Bdata%3A%5B-8.2%2C-3.1%2C1.4%2C5.7%5D%2CbackgroundColor%3A%5B%27%230F766E%27%2C%27%2314B8A6%27%2C%2794A3B8%27%2C%27%23FBBF24%27%5D%7D%5D%7D%2Coptions%3A%7Blegend%3A%7Bdisplay%3Afalse%7D%7D%7D" width="556" height="104" alt="Watchlist dip chart" style="display:block;"></div>`,
    watchlistTable: `<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:28px;"><table style="width:100%;border-collapse:collapse;font-size:0.875rem;"><thead><tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;"><th style="padding:10px 14px;text-align:left;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;">Ticker</th><th style="padding:10px 14px;text-align:left;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;">Company</th><th style="padding:10px 14px;text-align:right;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;">Price</th><th style="padding:10px 14px;text-align:right;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;">50d SMA</th><th style="padding:10px 14px;text-align:right;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;">vs SMA</th></tr></thead><tbody><tr><td style="padding:0;border-bottom:1px solid #f1f5f9;white-space:nowrap;"><a href="#" style="display:block;padding:10px 14px;font-weight:700;color:#1e293b;text-decoration:none;">INTU</a></td><td style="padding:0;border-bottom:1px solid #f1f5f9;"><a href="#" style="display:block;padding:10px 14px;color:#64748b;font-size:0.85em;text-decoration:none;">Intuit Inc.</a></td><td style="padding:0;border-bottom:1px solid #f1f5f9;"><a href="#" style="display:block;padding:10px 14px;color:#1e293b;text-align:right;text-decoration:none;">$580.00</a></td><td style="padding:0;border-bottom:1px solid #f1f5f9;"><a href="#" style="display:block;padding:10px 14px;color:#64748b;text-align:right;text-decoration:none;">$631.74</a></td><td style="padding:0;border-bottom:1px solid #f1f5f9;text-align:right;"><a href="#" style="display:block;padding:10px 14px;text-align:right;text-decoration:none;"><span style="background:#CCFBF1;color:#0F766E;font-weight:700;font-size:0.82em;padding:3px 8px;border-radius:999px;">-8.2%</span></a></td></tr><tr><td style="padding:0;white-space:nowrap;"><a href="#" style="display:block;padding:10px 14px;font-weight:700;color:#1e293b;text-decoration:none;">MSFT</a></td><td style="padding:0;"><a href="#" style="display:block;padding:10px 14px;color:#64748b;font-size:0.85em;text-decoration:none;">Microsoft Corp.</a></td><td style="padding:0;"><a href="#" style="display:block;padding:10px 14px;color:#1e293b;text-align:right;text-decoration:none;">$388.00</a></td><td style="padding:0;"><a href="#" style="display:block;padding:10px 14px;color:#64748b;text-align:right;text-decoration:none;">$400.31</a></td><td style="padding:0;text-align:right;"><a href="#" style="display:block;padding:10px 14px;text-align:right;text-decoration:none;"><span style="background:#CCFBF1;color:#0F766E;font-weight:700;font-size:0.82em;padding:3px 8px;border-radius:999px;">-3.1%</span></a></td></tr></tbody></table></div>`,
    newsBlock: `<h2 style="margin:0 0 14px;font-size:0.75em;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">This Week's News</h2><div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:12px;overflow:hidden;"><div style="padding:12px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;"><a href="#" style="font-weight:800;color:#1e293b;font-size:0.95em;margin-right:8px;text-decoration:none;">INTU</a><a href="#" style="color:#64748b;font-size:0.8em;text-decoration:none;">Intuit Inc.</a><span style="float:right;font-weight:700;color:#0F766E;font-size:0.85em;">-8.2%</span></div><div style="padding:0 16px;"><a href="#" style="display:block;text-decoration:none;padding:10px 0;border-bottom:1px solid #f1f5f9;"><span style="font-size:0.78em;font-weight:600;color:#2563eb;text-transform:uppercase;letter-spacing:0.05em;">Reuters</span><p style="margin:3px 0 0;color:#1e293b;font-size:0.875em;line-height:1.4;">Intuit beats Q2 estimates as AI-powered tax features drive adoption</p></a></div></div>`,
    newsSummaries: `<div style="margin-top:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:4px 16px 2px;"><h2 style="margin:14px 0 2px;font-size:0.7em;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">This Week's News</h2><div style="padding:14px 0;border-top:1px solid #f1f5f9;"><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:6px;"><tr><td style="vertical-align:top;padding-right:10px;"><a href="https://dipfinder.com/screener?stock=INTU" style="font-weight:800;color:#1e293b;text-decoration:none;font-size:0.9em;margin-right:8px;">INTU</a><span style="color:#64748b;font-size:0.8em;">Intuit Inc.</span></td><td style="white-space:nowrap;text-align:right;vertical-align:top;"><span style="background:#CCFBF1;color:#0F766E;font-weight:700;font-size:0.78em;padding:2px 7px;border-radius:999px;display:inline-block;">-8.2% vs 50d SMA</span><div style="margin-top:3px;font-size:0.75em;font-weight:600;color:#dc2626;text-align:right;">-4.1% this week</div></td></tr></table><p style="margin:0;color:#374151;font-size:0.875em;line-height:1.65;">Intuit shares dipped this week as investors weighed mixed signals from the broader software sector. Management reaffirmed full-year guidance, citing strong adoption of AI-powered features in TurboTax and QuickBooks. (Sample - real content is injected from approved AI summaries.)</p></div><div style="padding:14px 0;border-top:1px solid #f1f5f9;"><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:6px;"><tr><td style="vertical-align:top;padding-right:10px;"><a href="https://dipfinder.com/screener?stock=MSFT" style="font-weight:800;color:#1e293b;text-decoration:none;font-size:0.9em;margin-right:8px;">MSFT</a><span style="color:#64748b;font-size:0.8em;">Microsoft Corp.</span></td><td style="white-space:nowrap;text-align:right;vertical-align:top;"><span style="background:#CCFBF1;color:#0F766E;font-weight:700;font-size:0.78em;padding:2px 7px;border-radius:999px;display:inline-block;">-3.1% vs 50d SMA</span><div style="margin-top:3px;font-size:0.75em;font-weight:600;color:#dc2626;text-align:right;">-2.8% this week</div></td></tr></table><p style="margin:0;color:#374151;font-size:0.875em;line-height:1.65;">Microsoft pulled back modestly alongside the broader tech sector. Azure growth remained strong and Copilot momentum continued to build across enterprise customers. (Sample - real content is injected from approved AI summaries.)</p></div></div>`,
    weekInMacro: `<div style="margin-top:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:4px 16px 14px;"><h2 style="margin:14px 0 10px;padding-bottom:8px;font-size:0.7em;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid #f1f5f9;text-align:left;">The week in macro</h2><p style="margin:0;font-size:0.875em;color:#374151;line-height:1.65;">S&amp;P +1.2%, Nasdaq +2.1%, Russell -0.3%, 10-yr yield down 8bps to 4.21%. Trade deal optimism and better-than-expected earnings drove the broad rally, with small-caps lagging on continued rate sensitivity. Tech led, Energy lagged.</p></div>`,
    onYourRadar: `<div style="margin-top:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:4px 16px 14px;"><h2 style="margin:14px 0 4px;font-size:0.7em;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;text-align:left;">On Your Radar</h2><p style="margin:0 0 10px;padding-bottom:8px;font-size:0.78em;color:#94a3b8;border-bottom:1px solid #f1f5f9;">Stocks that might interest you based on your watchlist. SMA position uses a fixed 50-day SMA.</p><div style="padding:12px 0;border-top:1px solid #f1f5f9;"><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td style="vertical-align:top;padding-right:10px;"><a href="https://dipfinder.com/app?stock=LRCX" style="text-decoration:none;"><span style="font-weight:800;color:#1e293b;font-size:0.9em;">LRCX</span><span style="color:#64748b;font-size:0.78em;margin-left:6px;">Lam Research Corp.</span></a><div style="margin-top:3px;font-size:0.78em;color:#64748b;">Semiconductor Equipment - same industry as ASML</div><div style="margin-top:5px;"><a href="https://dipfinder.com/app?add=LRCX&amp;source=brief_radar" style="font-size:0.75em;color:#6366f1;text-decoration:none;font-weight:600;">+ Add to Watchlist</a></div></td><td style="white-space:nowrap;text-align:right;vertical-align:top;"><span style="background:#CCFBF1;color:#0F766E;font-weight:700;font-size:0.78em;padding:2px 7px;border-radius:999px;display:inline-block;">-6.4% vs 50d SMA</span><div style="margin-top:3px;font-size:0.75em;font-weight:600;color:#dc2626;text-align:right;">-4.1% this week</div></td></tr></table></div><div style="padding:12px 0;border-top:1px solid #f1f5f9;"><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td style="vertical-align:top;padding-right:10px;"><a href="https://dipfinder.com/app?stock=ADBE" style="text-decoration:none;"><span style="font-weight:800;color:#1e293b;font-size:0.9em;">ADBE</span><span style="color:#64748b;font-size:0.78em;margin-left:6px;">Adobe Inc.</span></a><div style="margin-top:3px;font-size:0.78em;color:#64748b;">Software - Application - same industry as INTU</div><div style="margin-top:5px;"><a href="https://dipfinder.com/app?add=ADBE&amp;source=brief_radar" style="font-size:0.75em;color:#6366f1;text-decoration:none;font-weight:600;">+ Add to Watchlist</a></div></td><td style="white-space:nowrap;text-align:right;vertical-align:top;"><span style="background:#CCFBF1;color:#0F766E;font-weight:700;font-size:0.78em;padding:2px 7px;border-radius:999px;display:inline-block;">-9.1% vs 50d SMA</span><div style="margin-top:3px;font-size:0.75em;font-weight:600;color:#dc2626;text-align:right;">-3.8% this week</div></td></tr></table></div><div style="padding:12px 0;border-top:1px solid #f1f5f9;"><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td style="vertical-align:top;padding-right:10px;"><a href="https://dipfinder.com/app?stock=DASH" style="text-decoration:none;"><span style="font-weight:800;color:#1e293b;font-size:0.9em;">DASH</span><span style="color:#64748b;font-size:0.78em;margin-left:6px;">DoorDash Inc.</span></a><div style="margin-top:3px;font-size:0.78em;color:#64748b;">E-Commerce + AI - similar to UBER</div><div style="margin-top:5px;"><a href="https://dipfinder.com/app?add=DASH&amp;source=brief_radar" style="font-size:0.75em;color:#6366f1;text-decoration:none;font-weight:600;">+ Add to Watchlist</a></div></td><td style="white-space:nowrap;text-align:right;vertical-align:top;"><span style="background:#CCFBF1;color:#0F766E;font-weight:700;font-size:0.78em;padding:2px 7px;border-radius:999px;display:inline-block;">-7.2% vs 50d SMA</span><div style="margin-top:3px;font-size:0.75em;font-weight:600;color:#dc2626;text-align:right;">-5.3% this week</div></td></tr></table></div><p style="margin:12px 0 0;padding-top:10px;border-top:1px solid #f1f5f9;font-size:0.75em;color:#94a3b8;text-align:center;">Pro members see 3 picks each week. <a href="https://dipfinder.com/founding" style="color:#6366f1;text-decoration:none;font-weight:600;">See Pro -&gt;</a></p></div>`,
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
    const r = await fetch(`${FRONTEND_URL}/api/newsletter?action=onboarding`, {
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
    endpoint: '/api/newsletter?action=onboarding',
    method: 'POST',
    vercelSchedule: 'Daily at 10:00 UTC',
    defaultSchedule: { enabled: true, hour: 10 },
  },
  {
    id: 'newsletter-snapshot',
    name: 'Weekly Snapshot',
    description: 'Snapshots each subscriber\'s watchlist SMA status, generates macro recap, and runs the Radar universe sweep. Runs Saturday 22:45 UTC.',
    endpoint: '/api/newsletter?action=snapshot',
    method: 'POST',
    vercelSchedule: 'Saturdays at 18:00 UTC',
    defaultSchedule: { enabled: true, dayOfWeek: 6, hour: 18 },
  },
  {
    id: 'newsletter-ai-summaries',
    name: 'AI Summaries',
    description: 'Generates AI news summaries for all subscriber watchlist symbols in batches of 50. Runs 4 times Saturday afternoon (18:15-19:00 UTC). Each run skips already-generated symbols. Alert email sent after first successful run.',
    endpoint: '/api/newsletter?action=ai-summaries',
    method: 'POST',
    vercelSchedule: 'Saturdays at 18:15, 18:30, 18:45, 19:00 UTC',
    defaultSchedule: { enabled: true, dayOfWeek: 6, hour: 18 },
  },
  {
    id: 'morning-report',
    name: 'Morning Report',
    description: 'Sends a daily admin summary email with user counts, subscriber totals, and cron last-run statuses.',
    endpoint: '/api/morning-report',
    method: 'POST',
    vercelSchedule: 'Daily at 07:00 UTC',
    defaultSchedule: { enabled: true, hour: 7 },
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
  // Only flip isPro. Never touch foundingMember — that is set exclusively by Stripe webhook.
  const result = await db.collection('users').updateOne(
    { email: email.toLowerCase() },
    { $set: { isPro: !!isPro } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'User not found' });
  return res.status(200).json({ ok: true, isPro: !!isPro });
}

async function handleToggleSubscription(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, field, value } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const allowed = ['newsletterSubscribed', 'sundayBriefSubscribed'];
  if (!allowed.includes(field)) return res.status(400).json({ error: 'invalid field' });
  const db = await connectToDatabase();
  const update: Record<string, any> = { [field]: !!value };
  if (field === 'sundayBriefSubscribed' && !!value) {
    const existing = await db.collection('users').findOne({ email: email.toLowerCase() }, { projection: { sundayBriefSubscribedAt: 1 } });
    if (!existing?.sundayBriefSubscribedAt) update.sundayBriefSubscribedAt = new Date();
  }
  const result = await db.collection('users').updateOne(
    { email: email.toLowerCase() },
    { $set: update }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'User not found' });
  return res.status(200).json({ ok: true, field, value: !!value });
}

async function handleListTickers(_req: VercelRequest, res: VercelResponse) {
  const db = await connectToDatabase();
  const tickers = await db.collection('tickers')
    .find({})
    .project({ ticker: 1, name: 1, active: 1, failCount: 1, lastSeen: 1, source: 1, _id: 0 })
    .sort({ ticker: 1 })
    .toArray();
  return res.status(200).json({ tickers, total: tickers.length });
}

async function handleToggleTicker(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { ticker, active } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const db = await connectToDatabase();
  const result = await db.collection('tickers').updateOne(
    { ticker: ticker.toUpperCase() },
    { $set: { active: !!active, failCount: active ? 0 : 3 } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Ticker not found' });
  return res.status(200).json({ ok: true, ticker: ticker.toUpperCase(), active: !!active });
}

async function handleListAiSummaries(_req: VercelRequest, res: VercelResponse) {
  const db = await connectToDatabase();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const summaries = await db.collection('aiSummaries')
    .find({ weekOf: { $gte: sevenDaysAgo } })
    .project({ symbol: 1, companyName: 1, summary: 1, headlines: 1, reviewed: 1, approved: 1, editedSummary: 1, weekOf: 1, createdAt: 1, inputTokens: 1, outputTokens: 1 })
    .sort({ approved: 1, reviewed: 1, symbol: 1 })
    .toArray();
  const totalInputTokens: number = summaries.reduce((sum: number, s: any) => sum + (s.inputTokens || 0), 0);
  const totalOutputTokens: number = summaries.reduce((sum: number, s: any) => sum + (s.outputTokens || 0), 0);
  const { estimateCost } = await import('./lib/ai-summaries');
  const estimatedCost = estimateCost(totalInputTokens, totalOutputTokens);
  return res.status(200).json({ summaries, total: summaries.length, totalInputTokens, totalOutputTokens, estimatedCost });
}

async function handleUpdateAiSummary(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { symbol, weekOf, reviewed, approved, editedSummary } = req.body || {};
  if (!symbol || !weekOf) return res.status(400).json({ error: 'symbol and weekOf required' });

  const db = await connectToDatabase();
  const update: Record<string, any> = { reviewed: !!reviewed, approved: !!approved, updatedAt: new Date() };
  if (typeof editedSummary === 'string') {
    update.editedSummary = editedSummary.trim() || undefined;
  }

  const result = await db.collection('aiSummaries').updateOne(
    { symbol: symbol.toUpperCase(), weekOf: new Date(weekOf) },
    { $set: update },
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Summary not found' });
  return res.status(200).json({ ok: true });
}

async function handleGenerateAiSummaries(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set in environment' });
  }

  // force=true regenerates summaries that already exist this week (resets reviewed/approved)
  const force = req.body?.force === true;

  const db = await connectToDatabase();

  // Collect unique symbols + their preferred SMA period from all brief subscribers
  const users = await db.collection('users')
    .find({ sundayBriefSubscribed: true, watchlist: { $exists: true, $not: { $size: 0 } } })
    .project({ watchlist: 1, smaPeriod: 1 })
    .toArray();

  const symbolSmaPeriod = new Map<string, number>();
  for (const user of users) {
    const period = user.smaPeriod || NEWSLETTER_SMA_DEFAULT;
    for (const sym of (user.watchlist as string[] || [])) {
      const normalized = sym.toUpperCase();
      if (!symbolSmaPeriod.has(normalized)) symbolSmaPeriod.set(normalized, period);
    }
  }

  if (symbolSmaPeriod.size === 0) {
    return res.status(200).json({ generated: 0, skipped: 0, errors: 0, total: 0 });
  }

  // weekOf = today at midnight UTC (matches the snapshot convention)
  const now = new Date();
  const weekOf = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const summaryCol = db.collection('aiSummaries');

  // Fetch macro context (SPY/QQQ weekly %) once for the whole batch
  const macro: { spyWeekly?: number; qqqWeekly?: number } = {};
  try {
    const spy = await fetchStockData('SPY', db);
    if (spy.closes.length >= 6) macro.spyWeekly = spy.closes[spy.closes.length - 1] / spy.closes[spy.closes.length - 6] - 1;
  } catch { /* best-effort */ }
  try {
    const qqq = await fetchStockData('QQQ', db);
    if (qqq.closes.length >= 6) macro.qqqWeekly = qqq.closes[qqq.closes.length - 1] / qqq.closes[qqq.closes.length - 6] - 1;
  } catch { /* best-effort */ }

  // Step 1: fetch stock + news data in parallel (all cached after snapshot ran)
  type SymbolPayload = {
    symbol: string;
    smaPeriod: number;
    companyName: string;
    headlines: string[];
    headlineDates: number[];
    relativePrice: number;
    closes: number[];
    volumes: number[];
  };

  const payloads = (await Promise.all(
    Array.from(symbolSmaPeriod.entries()).map(async ([symbol, smaPeriod]) => {
      try {
        if (!force) {
          const existing = await summaryCol.findOne({ symbol, weekOf: { $gte: sevenDaysAgo } });
          if (existing) return null;
        }
        const [stockData, newsRaw] = await Promise.all([
          fetchStockData(symbol, db),
          fetchNewsForSymbol(symbol, db, 10),
        ]);
        const deduped = deduplicateNewsItems(newsRaw as any[], 5);
        const headlines = deduped.map((n: any) => n.headline);
        const headlineDates = deduped.map((n: any) => n.datetime);
        if (!headlines.length || stockData.closes.length < smaPeriod) return null;
        const sma = calculateSma(stockData.closes, smaPeriod);
        return {
          symbol, smaPeriod, companyName: stockData.companyName,
          headlines, headlineDates, closes: stockData.closes, volumes: stockData.volumes || [],
          relativePrice: stockData.currentPrice / sma - 1,
        } as SymbolPayload;
      } catch {
        return null;
      }
    })
  )).filter((p): p is SymbolPayload => p !== null);

  const skipped = symbolSmaPeriod.size - payloads.length;

  // Step 2: fetch prompt template once, then run Claude calls in parallel
  const promptTemplate = await getAiPromptTemplate(db);
  let generated = 0, errors = 0, totalInputTokens = 0, totalOutputTokens = 0;
  await Promise.all(payloads.map(async ({ symbol, smaPeriod, companyName, headlines, headlineDates, relativePrice, closes, volumes }) => {
    try {
      const result = await generateAiSummary(symbol, companyName, headlines, relativePrice, smaPeriod, { closes, volumes, headlineDates, macro, promptTemplate });
      if (!result.summary) return;
      await upsertAiSummary(db, symbol, companyName, headlines, result, weekOf);
      generated++;
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
    } catch (err) {
      console.error(`generate-ai-summaries: Claude call failed for ${symbol}:`, err);
      errors++;
    }
  }));

  const { estimateCost } = await import('./lib/ai-summaries');
  return res.status(200).json({
    generated, skipped, errors, total: symbolSmaPeriod.size,
    totalInputTokens, totalOutputTokens,
    estimatedCost: estimateCost(totalInputTokens, totalOutputTokens),
  });
}

async function handleGetAiPrompt(res: VercelResponse) {
  const db = await connectToDatabase();
  const doc = await db.collection('settings').findOne({ key: 'ai-prompt-news-summary' });
  return res.status(200).json({
    prompt: doc?.value ?? null,
    default: DEFAULT_NEWS_SUMMARY_PROMPT,
    isCustom: !!doc?.value,
  });
}

async function handleSaveAiPrompt(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { prompt, reset } = req.body || {};
  const db = await connectToDatabase();
  if (reset) {
    await db.collection('settings').deleteOne({ key: 'ai-prompt-news-summary' });
    return res.status(200).json({ ok: true, reset: true });
  }
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' });
  await db.collection('settings').updateOne(
    { key: 'ai-prompt-news-summary' },
    { $set: { key: 'ai-prompt-news-summary', value: prompt.trim(), updatedAt: new Date() } },
    { upsert: true },
  );
  return res.status(200).json({ ok: true });
}

async function handleRegenerateAiSummary(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { symbol } = req.body || {};
  if (!symbol || typeof symbol !== 'string') return res.status(400).json({ error: 'symbol required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set in environment' });
  }

  const db = await connectToDatabase();

  // Determine SMA period from subscribers (first match wins, fallback to default)
  const user = await db.collection('users').findOne(
    { sundayBriefSubscribed: true, watchlist: symbol.toUpperCase() },
    { projection: { smaPeriod: 1 } },
  );
  const smaPeriod: number = (user?.smaPeriod) || NEWSLETTER_SMA_DEFAULT;

  // Fetch data in parallel
  const [stockData, newsRaw] = await Promise.all([
    fetchStockData(symbol.toUpperCase(), db),
    fetchNewsForSymbol(symbol.toUpperCase(), db, 10),
  ]);

  const deduped = deduplicateNewsItems(newsRaw as any[], 5);
  const headlines = deduped.map((n: any) => n.headline);
  const headlineDates = deduped.map((n: any) => n.datetime);
  if (!headlines.length) return res.status(400).json({ error: 'No headlines available for this symbol' });
  if (stockData.closes.length < smaPeriod) return res.status(400).json({ error: 'Not enough price history for SMA calculation' });

  const sma = calculateSma(stockData.closes, smaPeriod);
  const relativePrice = stockData.currentPrice / sma - 1;

  // Fetch macro context
  const macro: { spyWeekly?: number; qqqWeekly?: number } = {};
  try {
    const spy = await fetchStockData('SPY', db);
    if (spy.closes.length >= 6) macro.spyWeekly = spy.closes[spy.closes.length - 1] / spy.closes[spy.closes.length - 6] - 1;
  } catch { /* best-effort */ }
  try {
    const qqq = await fetchStockData('QQQ', db);
    if (qqq.closes.length >= 6) macro.qqqWeekly = qqq.closes[qqq.closes.length - 1] / qqq.closes[qqq.closes.length - 6] - 1;
  } catch { /* best-effort */ }

  const promptTemplate = await getAiPromptTemplate(db);
  const result = await generateAiSummary(
    symbol.toUpperCase(), stockData.companyName, headlines, relativePrice, smaPeriod,
    { closes: stockData.closes, volumes: stockData.volumes || [], headlineDates, macro, promptTemplate },
  );
  if (!result.summary) return res.status(500).json({ error: 'Claude returned an empty summary' });

  const now = new Date();
  const weekOf = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  await upsertAiSummary(db, symbol.toUpperCase(), stockData.companyName, headlines, result, weekOf);

  const { estimateCost } = await import('./lib/ai-summaries');
  return res.status(200).json({
    ok: true,
    symbol: symbol.toUpperCase(),
    summary: result.summary,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCost: estimateCost(result.inputTokens, result.outputTokens),
  });
}

async function handleListAiCostHistory(res: VercelResponse) {
  const db = await connectToDatabase();
  const { estimateCost } = await import('./lib/ai-summaries');

  const rows = await db.collection('aiSummaries').aggregate([
    {
      $group: {
        _id: '$weekOf',
        count: { $sum: 1 },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
      },
    },
    { $sort: { _id: -1 } },
    { $limit: 12 },
  ]).toArray();

  const weeks = rows.map((r: any) => ({
    weekOf: r._id,
    count: r.count,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    estimatedCost: estimateCost(r.inputTokens, r.outputTokens),
  }));

  return res.status(200).json({ weeks });
}

async function handleTestAi(res: VercelResponse) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set' });
  }
  const start = Date.now();
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with just: ok' }],
    });
    const reply = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    return res.status(200).json({ ok: true, reply, latencyMs: Date.now() - start, model: msg.model });
  } catch (err: any) {
    return res.status(200).json({ ok: false, error: err.message, latencyMs: Date.now() - start });
  }
}

async function handleListSharedWatchlists(res: VercelResponse) {
  const db = await connectToDatabase();
  const shares = await db.collection('sharedWatchlists')
    .find({}, { projection: { token: 1, ownerName: 1, watchlistId: 1, watchlistName: 1, stocks: 1, smaPeriod: 1, viewCount: 1, notes: 1, createdAt: 1, _id: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
  return res.status(200).json({ shares });
}

// ── YouTube Watchlist Wizard ──────────────────────────────────────────────────

function extractYouTubeVideoId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    return null;
  } catch { return null; }
}

async function fetchVideoMetadata(videoId: string): Promise<{ videoTitle: string; creatorName: string; thumbnailUrl: string }> {
  const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const r = await axios.get(oembedUrl, { timeout: 8000 });
  return {
    videoTitle: r.data.title || 'Unknown Video',
    creatorName: r.data.author_name || 'Unknown',
    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  };
}

async function fetchYouTubeTranscript(videoId: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { YoutubeTranscript } = require('youtube-transcript');
  const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
  return (segments as any[]).map((s: any) => s.text).join(' ');
}

async function ytExtractTickers(transcript: string, videoTitle: string): Promise<any[]> {
  const truncated = transcript.slice(0, 18000);
  const prompt = `You are analyzing a YouTube finance video transcript to identify stocks the creator is actively discussing, watching, or recommending.

TRANSCRIPT:
${truncated}

VIDEO TITLE: ${videoTitle}

TASK:
Extract every stock ticker the creator is actively discussing as a pick, recommendation, watchlist item, or focus of analysis. Include both stocks mentioned by ticker symbol (e.g., "AAPL") and stocks mentioned by company name (e.g., "Apple") — for company names, infer the ticker.

DO NOT INCLUDE:
- Stocks mentioned only in passing comparison
- Stocks mentioned only as historical reference
- Indices (S&P 500, Nasdaq, etc.)
- ETFs unless the creator is specifically discussing them as a pick

OUTPUT FORMAT:
JSON array of objects, each with:
- ticker: the stock symbol (US exchange, uppercase)
- company_name: the full company name
- confidence: "high" if mentioned by ticker symbol explicitly, "medium" if mentioned only by company name
- justification: a short phrase from the transcript that justifies inclusion (1-2 sentences max)

If no clear picks found, return empty array.
OUTPUT: only the JSON array, no other text.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      temperature: 0.3 as any,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = message.content[0].type === 'text' ? message.content[0].text.trim() : '[]';
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('ytExtractTickers error:', err);
    return [];
  }
}

async function ytExtractTheme(transcript: string, videoTitle: string): Promise<string> {
  const truncated = transcript.slice(0, 18000);
  const prompt = `Analyze this YouTube finance video transcript and identify the primary theme of the stocks discussed.

TRANSCRIPT:
${truncated}

VIDEO TITLE: ${videoTitle}

TASK:
Return a 2-4 word phrase describing the theme of the stocks discussed. Examples:
- "value picks"
- "AI infrastructure plays"
- "dividend aristocrats"
- "quality compounders"
- "small-cap growth"
- "high-conviction picks"

OUTPUT: only the phrase, no other text. Lowercase unless proper noun.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      temperature: 0.5 as any,
      messages: [{ role: 'user', content: prompt }],
    });
    return message.content[0].type === 'text' ? message.content[0].text.trim().toLowerCase() : 'stock picks';
  } catch { return 'stock picks'; }
}

async function ytGenerateNotes(videoTitle: string, creatorName: string, uploadDate: string, videoUrl: string, tickerList: string): Promise<string> {
  const prompt = `Write a 2-3 sentence summary description for a public DipFinder watchlist based on a YouTube finance video.

VIDEO TITLE: ${videoTitle}
CREATOR: ${creatorName}
DATE: ${uploadDate}
VIDEO URL: ${videoUrl}
STOCKS DISCUSSED: ${tickerList || 'various stocks'}

TASK:
Write a brief, factual description for the watchlist page that:
- Mentions the creator name and date of the video
- Briefly describes what the video discussed
- Includes the video URL as a clickable reference
- Notes that the watchlist tracks these stocks against their long-term price trends
- Does NOT use marketing language, exclamation marks, or hype

Length: 2-3 sentences.
Example output: "From Daniel Pronk's May 14, 2026 video discussing five stocks he considers undervalued. Original video: https://www.youtube.com/watch?v=xyz. Tracking each pick against its 200-day price trend and current valuation."

OUTPUT: only the description text, no other text.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      temperature: 0.5 as any,
      messages: [{ role: 'user', content: prompt }],
    });
    return message.content[0].type === 'text' ? message.content[0].text.trim() : '';
  } catch { return ''; }
}

async function ytGenerateComment(videoTitle: string, creatorName: string, tickerList: string, shareUrl: string, transcriptExcerpt: string): Promise<string> {
  const prompt = `You are an experienced patient investor commenting on a YouTube finance video. Your goal is to add substantive value to the discussion while subtly referencing a public watchlist as supporting evidence.

VIDEO TITLE: ${videoTitle}
CREATOR: ${creatorName}
STOCKS DISCUSSED IN VIDEO: ${tickerList || 'various stocks'}
WATCHLIST URL: ${shareUrl}

TRANSCRIPT (key excerpts):
${transcriptExcerpt}

TASK:
Write a 2-3 paragraph YouTube comment that:
- Engages substantively with at least one specific stock or argument from the video (be specific — name the stock, reference what the creator said about it)
- Adds your own observation or insight that goes beyond what the video said
- Mentions the watchlist URL at the end framed as "I tracked the stocks discussed against their 200-day moving averages" or similar

VOICE:
- Dry, observational, calm
- No exclamation marks
- No emoji
- No "great video!" or compliments to the creator
- No hype phrases
- Sound like someone who genuinely watched the video
- Plain language

LENGTH: 50-120 words total.
OUTPUT: only the comment text, no other text.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      temperature: 0.6 as any,
      messages: [{ role: 'user', content: prompt }],
    });
    return message.content[0].type === 'text' ? message.content[0].text.trim() : '';
  } catch { return ''; }
}

async function handleYoutubeProcess(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  const { url, transcript: manualTranscript } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const uploadDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // If manual transcript provided, skip fetch and use it directly
  const providedTranscript = typeof manualTranscript === 'string' ? manualTranscript.trim() : '';

  // Fetch metadata always; transcript only if not manually provided
  const [metaResult, transcriptResult] = await Promise.allSettled([
    fetchVideoMetadata(videoId),
    providedTranscript ? Promise.resolve(providedTranscript) : fetchYouTubeTranscript(videoId),
  ]);

  const meta = metaResult.status === 'fulfilled'
    ? metaResult.value
    : { videoTitle: 'Unknown Video', creatorName: 'Unknown', thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` };

  const transcriptAvailable = transcriptResult.status === 'fulfilled' && !!transcriptResult.value;
  const transcriptText = transcriptAvailable ? (transcriptResult.value as string) : '';

  if (!transcriptAvailable) {
    return res.status(200).json({
      videoId, videoUrl, uploadDate, ...meta,
      transcriptAvailable: false,
      tickers: [], theme: '', notes: '', commentDraft: '', suggestedTitle: '',
    });
  }

  // Tier 1: tickers + theme in parallel
  const [tickers, theme] = await Promise.all([
    ytExtractTickers(transcriptText, meta.videoTitle),
    ytExtractTheme(transcriptText, meta.videoTitle),
  ]);

  const tickerList = (tickers as any[]).map((t: any) => t.ticker).join(', ');
  const placeholderUrl = 'https://dipfinder.com/s/[link]';

  // Tier 2: notes + comment in parallel
  const [notes, commentDraft] = await Promise.all([
    ytGenerateNotes(meta.videoTitle, meta.creatorName, uploadDate, videoUrl, tickerList),
    ytGenerateComment(meta.videoTitle, meta.creatorName, tickerList, placeholderUrl, transcriptText.slice(0, 4000)),
  ]);

  const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const suggestedTitle = `${meta.creatorName}'s ${theme} - ${month}`.slice(0, 60);

  return res.status(200).json({
    videoId, videoUrl, uploadDate, ...meta,
    transcriptAvailable: true,
    transcriptExcerpt: transcriptText.slice(0, 3000),
    tickers,
    theme,
    notes,
    commentDraft,
    suggestedTitle,
  });
}

async function handleYoutubeSave(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  const { videoId, videoUrl, videoTitle, creatorName, uploadDate, tickers, title, notes, commentText } = req.body || {};

  if (!videoId || !Array.isArray(tickers) || !tickers.length || !title) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const db = await connectToDatabase();
  const adminUser = await db.collection('users').findOne({ email: ADMIN_EMAIL });
  if (!adminUser) return res.status(404).json({ error: 'Admin user not found' });

  const adminUserId = (adminUser._id as any).toString();
  const ownerName = (adminUser as any).name?.split(' ')[0] || 'DipFinder';

  const TICKER_RE_SAVE = /^[A-Z0-9.\-]{1,10}$/;
  const sanitized = (tickers as string[])
    .filter(t => typeof t === 'string' && TICKER_RE_SAVE.test(t.toUpperCase()))
    .map(t => t.toUpperCase())
    .slice(0, 50);
  if (!sanitized.length) return res.status(400).json({ error: 'No valid tickers' });

  const BASE62_YT = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const genToken = () => Array.from(randomBytes(6)).map(b => BASE62_YT[b % 62]).join('');

  const shareWatchlistId = `youtube_${videoId}`;
  const existing = await db.collection('sharedWatchlists').findOne({ ownerId: adminUserId, watchlistId: shareWatchlistId });
  const token = existing?.token || genToken();

  const watchlistName = (typeof title === 'string' ? title : 'YouTube Picks').slice(0, 60);
  const notesText = typeof notes === 'string' ? notes.slice(0, 500) : '';
  const creatorSlug = (creatorName || '').toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').slice(0, 30);
  const shareUrl = `${FRONTEND_URL}/s/${token}?source=youtube_${creatorSlug}`;

  await db.collection('sharedWatchlists').updateOne(
    { ownerId: adminUserId, watchlistId: shareWatchlistId },
    {
      $set: { token, ownerName, watchlistName, stocks: sanitized, smaPeriod: 200, notes: notesText, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date(), viewCount: 0 },
    },
    { upsert: true }
  );

  const PLACEHOLDER = 'https://dipfinder.com/s/[link]';
  const finalComment = (typeof commentText === 'string' ? commentText : '').replace(PLACEHOLDER, shareUrl);

  const logResult = await db.collection('youtube_marketing_log').insertOne({
    videoUrl: videoUrl || `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    videoTitle: videoTitle || '',
    creatorName: creatorName || '',
    uploadDate: uploadDate || '',
    tickersExtracted: tickers,
    tickersFinal: sanitized,
    watchlistId: shareWatchlistId,
    watchlistShareUrl: shareUrl,
    commentText: finalComment,
    createdAt: new Date(),
    postedAt: null,
  });

  return res.status(200).json({ shareUrl, token, finalComment, logId: logResult.insertedId.toString() });
}
