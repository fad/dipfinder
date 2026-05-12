import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import { connectToDatabase } from './lib/mongodb';
import { verifyJWT } from './lib/auth';
import { buildNewsletterHtml, sendEmail, buildEmailHtml, sendOnboardingEmail } from './lib/email';
import { NEWSLETTER_SMA_DEFAULT, buildStockResults, fetchStockData, fetchNewsForSymbol } from './lib/newsletter-data';
import { shouldCronRun, recordCronRun } from './lib/cron-schedule';
import { generateAiSummary, upsertAiSummary, estimateCost, getAiPromptTemplate, deduplicateNewsItems, type MacroContext } from './lib/ai-summaries';
import { generateMacroRecap, getISOWeekKey } from './lib/macro-recap';
import {
  fetchUniverseBatch,
  storeRadarUniverse,
  storeRadarSuggestions,
  getRadarSuggestions,
  loadTagMap,
  type RadarUniverseEntry,
} from './lib/radar';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET   = process.env.JWT_SECRET as string;
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL?.toLowerCase();
const CRON_SECRET  = process.env.CRON_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';

// ── Auth helper for cron/admin actions ───────────────────────────────────────

function isCronOrAdmin(req: VercelRequest): boolean {
  const authHeader = req.headers.authorization;
  if (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) return true;
  if (CRON_SECRET && req.headers['x-cron-secret'] === CRON_SECRET) return true;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const decoded = verifyJWT(authHeader.slice(7)) as any;
      if (ADMIN_EMAIL && decoded.email?.toLowerCase() === ADMIN_EMAIL) return true;
    } catch { /* invalid token */ }
  }
  return false;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;

  // Public GET actions — no auth
  if (req.method === 'GET') {
    if (action === 'view')        return handleView(req, res);
    if (action === 'unsubscribe') return handleUnsubscribe(req, res);
  }

  // Cron/admin actions — GET or POST
  if (req.method === 'GET' || req.method === 'POST') {
    if (action === 'snapshot' || action === 'onboarding') {
      if (!isCronOrAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      if (action === 'snapshot')   return handleSnapshot(req, res);
      if (action === 'onboarding') return handleOnboarding(req, res);
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── View online ──────────────────────────────────────────────────────────────

async function handleView(req: VercelRequest, res: VercelResponse) {
  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).send('<p>Missing token</p>');
  }

  let email: string;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.purpose !== 'newsletter-view') throw new Error('Wrong purpose');
    email = decoded.email;
  } catch {
    return res.status(403).send('<p>Invalid or expired link</p>');
  }

  try {
    const db = await connectToDatabase();
    const user = await db.collection('users').findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).send('<p>User not found</p>');

    const watchlist: string[] = user.watchlist || [];
    if (watchlist.length === 0) {
      return res.status(200).send('<p>No watchlist stocks to display</p>');
    }

    const smaPeriod: number = user.smaPeriod || NEWSLETTER_SMA_DEFAULT;
    const chartOrientation: 'x' | 'y' = user.chartOrientation === 'x' ? 'x' : 'y';
    const stockResults = await buildStockResults(watchlist, db, smaPeriod);
    if (stockResults.length === 0) {
      return res.status(200).send('<p>No stock data available</p>');
    }

    const unsubToken = jwt.sign(
      { email: user.email, purpose: 'unsubscribe' },
      JWT_SECRET,
      { expiresIn: '365d' }
    );
    const unsubscribeUrl = `${FRONTEND_URL}/api/newsletter-unsubscribe?token=${unsubToken}`;

    const html = buildNewsletterHtml({
      name: user.name || 'there',
      stocks: stockResults,
      smaPeriod,
      unsubscribeUrl,
      chartOrientation,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (error) {
    console.error('Newsletter view error:', error);
    return res.status(500).send('<p>Internal server error</p>');
  }
}

// ── Unsubscribe ──────────────────────────────────────────────────────────────

async function handleUnsubscribe(req: VercelRequest, res: VercelResponse) {
  const token = req.query.token as string;
  if (!token) return res.status(400).send('Missing token');

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return res.status(400).send('Invalid or expired unsubscribe link.');
  }

  if (decoded.purpose !== 'unsubscribe' || !decoded.email) {
    return res.status(400).send('Invalid token');
  }

  try {
    const db = await connectToDatabase();
    await db.collection('users').updateOne(
      { email: decoded.email },
      { $set: { newsletterSubscribed: false } }
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribed - Dip Finder</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; text-align: center; padding: 80px 20px; }
    h1 { color: #f8fafc; margin-bottom: 0.5rem; }
    p { color: #94a3b8; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Unsubscribed</h1>
  <p>You've been unsubscribed from the Dip Finder newsletter.</p>
  <p style="margin-top: 2rem;"><a href="https://dipfinder.com/app">Back to Dip Finder</a></p>
</body>
</html>`);
  } catch {
    return res.status(500).send('Something went wrong. Please try again.');
  }
}

// ── Onboarding emails (daily cron) ───────────────────────────────────────────

async function handleOnboarding(req: VercelRequest, res: VercelResponse) {
  const isCronInvocation = !!req.headers['x-vercel-cron'];

  try {
    const db = await connectToDatabase();
    const run = await shouldCronRun(db, 'newsletter-onboarding', { enabled: true, hour: 10 }, isCronInvocation);
    if (!run) return res.status(200).json({ skipped: true, reason: 'outside scheduled window' });

    const pending = await db.collection('users').find({
      sundayBriefSubscribed: true,
      onboardingEmailSentAt: { $exists: false },
    }).toArray();

    let sent = 0, failed = 0;

    for (const user of pending) {
      const ok = await sendOnboardingEmail(
        user.email,
        user.name || user.email.split('@')[0],
        { watchlist: user.watchlist || [], db }
      );
      if (ok) {
        await db.collection('users').updateOne(
          { _id: user._id },
          { $set: { onboardingEmailSentAt: new Date() } }
        );
        sent++;
      } else {
        failed++;
      }
      if (pending.length > 1) await new Promise(r => setTimeout(r, 400));
    }

    const result = { sent, failed, pending: pending.length };
    await recordCronRun(db, 'newsletter-onboarding', result, !isCronInvocation);
    return res.status(200).json(result);
  } catch (err) {
    console.error('newsletter-onboarding error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Weekly snapshot (Saturday cron) ──────────────────────────────────────────

/** Midnight UTC for today — used as the weeklySnapshots.weekOf key. */
function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Fetch SPY and QQQ weekly % change from cached stock data. */
async function fetchMacroContext(db: any): Promise<MacroContext> {
  const macro: MacroContext = {};
  try {
    const spy = await fetchStockData('SPY', db);
    if (spy.closes.length >= 6) {
      macro.spyWeekly = spy.closes[spy.closes.length - 1] / spy.closes[spy.closes.length - 6] - 1;
    }
  } catch { /* best-effort */ }
  try {
    const qqq = await fetchStockData('QQQ', db);
    if (qqq.closes.length >= 6) {
      macro.qqqWeekly = qqq.closes[qqq.closes.length - 1] / qqq.closes[qqq.closes.length - 6] - 1;
    }
  } catch { /* best-effort */ }
  return macro;
}

async function handleSnapshot(req: VercelRequest, res: VercelResponse) {
  const isCronInvocation = !!req.headers['x-vercel-cron'];

  try {
    const db = await connectToDatabase();

    const run = await shouldCronRun(
      db,
      'newsletter-snapshot',
      { enabled: true, dayOfWeek: 6, hour: 23 },
      isCronInvocation,
    );
    if (!run) return res.status(200).json({ skipped: true, reason: 'outside scheduled window' });

    const users = await db.collection('users')
      .find({ sundayBriefSubscribed: true, watchlist: { $exists: true, $not: { $size: 0 } } })
      .toArray();

    const weekOf = todayUtc();
    let saved = 0, failed = 0;

    // Collect unique symbol data across all users for AI summary generation
    type SymbolMeta = { companyName: string; headlines: string[]; headlineDates: number[]; relativePrice: number; smaPeriod: number; closes: number[]; volumes: number[] };
    const symbolData = new Map<string, SymbolMeta>();

    for (const user of users) {
      try {
        const smaPeriod: number = user.smaPeriod || NEWSLETTER_SMA_DEFAULT;
        const stockResults = await buildStockResults(user.watchlist, db, smaPeriod);
        if (stockResults.length === 0) continue;

        for (const s of stockResults) {
          if (!symbolData.has(s.symbol)) {
            symbolData.set(s.symbol, {
              companyName: s.companyName,
              headlines: (s.topNews || []).map(n => n.headline),
              headlineDates: [],
              relativePrice: s.relativePrice,
              smaPeriod,
              closes: [],
              volumes: [],
            });
          }
        }

        const stocks = stockResults.map(s => ({ symbol: s.symbol, relativePrice: s.relativePrice }));
        const col = db.collection('weeklySnapshots');
        await col.updateOne(
          { userId: user._id.toString(), weekOf },
          {
            $set:         { stocks, updatedAt: new Date() },
            $setOnInsert: { userId: user._id.toString(), weekOf, createdAt: new Date() },
          },
          { upsert: true },
        );

        // Keep only the 2 most recent snapshots per user
        const keep = await col
          .find({ userId: user._id.toString() })
          .sort({ weekOf: -1 })
          .limit(2)
          .project({ _id: 1 })
          .toArray();
        if (keep.length === 2) {
          const keepIds = keep.map((d: any) => d._id);
          await col.deleteMany({ userId: user._id.toString(), _id: { $nin: keepIds } });
        }

        saved++;
      } catch (err) {
        console.error(`Snapshot failed for ${user.email}:`, err);
        failed++;
      }
    }

    // Fetch closes + fresh headlines for each symbol
    if (symbolData.size > 0) {
      await Promise.all(Array.from(symbolData.entries()).map(async ([symbol, meta]) => {
        try {
          const stockData = await fetchStockData(symbol, db);
          meta.closes = stockData.closes;
          meta.volumes = stockData.volumes || [];
          const news = await fetchNewsForSymbol(symbol, db, 10);
          const deduped = deduplicateNewsItems(news, 5);
          meta.headlines = deduped.map(n => n.headline);
          meta.headlineDates = deduped.map(n => n.datetime);
        } catch { /* best-effort */ }
      }));
    }

    // Generate AI summaries for unique symbols not yet summarized this week
    let aiGenerated = 0, aiSkipped = 0, totalInputTokens = 0, totalOutputTokens = 0;

    if (process.env.ANTHROPIC_API_KEY && symbolData.size > 0) {
      const summaryCol = db.collection('aiSummaries');
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [macro, promptTemplate] = await Promise.all([
        fetchMacroContext(db),
        getAiPromptTemplate(db),
      ]);

      await Promise.all(Array.from(symbolData.entries()).map(async ([symbol, meta]) => {
        try {
          const existing = await summaryCol.findOne({ symbol, weekOf: { $gte: sevenDaysAgo } });
          if (existing) { aiSkipped++; return; }
          if (!meta.headlines.length) { aiSkipped++; return; }

          const result = await generateAiSummary(
            symbol, meta.companyName, meta.headlines, meta.relativePrice, meta.smaPeriod,
            { closes: meta.closes, volumes: meta.volumes, headlineDates: meta.headlineDates, macro, promptTemplate },
          );
          if (!result.summary) { aiSkipped++; return; }

          await upsertAiSummary(db, symbol, meta.companyName, meta.headlines, result, weekOf);
          aiGenerated++;
          totalInputTokens += result.inputTokens;
          totalOutputTokens += result.outputTokens;
        } catch (err) {
          console.error(`AI summary failed for ${symbol}:`, err);
          aiSkipped++;
        }
      }));

      console.log(`AI summaries: ${aiGenerated} generated, ${aiSkipped} skipped, ${totalInputTokens + totalOutputTokens} total tokens`);

      // Alert admin to review pending summaries before Sunday send
      if (aiGenerated > 0 && ADMIN_EMAIL) {
        try {
          const cost = estimateCost(totalInputTokens, totalOutputTokens);
          const symbolList = Array.from(symbolData.keys())
            .filter(sym => !['SPY', 'QQQ'].includes(sym))
            .map(sym => `<li style="margin:2px 0;">${sym}</li>`)
            .join('');
          const body = `
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;">
  <strong>${aiGenerated} AI news summaries</strong> are ready for your review before Sunday's newsletter send.
</p>
<ul style="font-family:Arial,sans-serif;font-size:14px;color:#374151;line-height:1.8;margin:0 0 20px;padding-left:1.25rem;">${symbolList}</ul>
<div style="text-align:center;margin:24px 0;">
  <a href="${FRONTEND_URL}/admin" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#4F46E5);color:#FFFFFF;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;font-family:Arial,sans-serif;">Review in Admin Panel &rarr;</a>
</div>
<p style="font-family:Arial,sans-serif;font-size:12px;color:#94a3b8;margin:0;">
  Estimated cost this run: $${cost.toFixed(4)} &bull; ${totalInputTokens} input + ${totalOutputTokens} output tokens (Claude Haiku)
</p>`;
          await sendEmail({
            to: ADMIN_EMAIL,
            subject: `${aiGenerated} AI summaries ready for review - Dip Finder`,
            html: buildEmailHtml(body),
          });
        } catch (err) {
          console.error('Failed to send snapshot alert email:', err);
        }
      }
    }

    // Generate this week's macro recap
    try {
      await generateMacroRecap(db);
    } catch (err) {
      console.error('Macro recap generation failed (non-fatal):', err);
    }

    // On Your Radar universe sweep
    let radarTickers = 0, radarErrors = 0;
    try {
      const tagMap = await loadTagMap(db);
      const weekKey = getISOWeekKey(new Date());

      if (tagMap.size > 0) {
        const allTickers = Array.from(tagMap.keys());
        const rawEntries = await fetchUniverseBatch(allTickers, db);

        const universeEntries: (RadarUniverseEntry & { name: string; sector: string; industry: string })[] =
          rawEntries.map(e => {
            const tag = tagMap.get(e.ticker)!;
            return {
              ticker: e.ticker,
              name: tag.name,
              sector: tag.sector,
              industry: tag.industry,
              relativePrice: (e as any).relativePrice ?? null,
              weeklyChange: (e as any).weeklyChange ?? null,
            };
          });

        await storeRadarUniverse(db, weekKey, universeEntries);
        radarTickers = universeEntries.length;

        const universeMap = new Map(universeEntries.map(e => [e.ticker, e]));
        const universe = Array.from(universeMap.values());

        for (const user of users) {
          try {
            const watchlist: string[] = user.watchlist || [];
            if (!watchlist.length) continue;
            const isPro = !!user.isPro;
            const suggestions = getRadarSuggestions(watchlist, tagMap, universe, isPro);
            await storeRadarSuggestions(db, user._id.toString(), weekKey, suggestions);
          } catch (err) {
            console.error(`Radar suggestions failed for ${user.email}:`, err);
            radarErrors++;
          }
        }
      }
    } catch (err) {
      console.error('Radar universe sweep failed (non-fatal):', err);
    }

    const result = { saved, failed, weekOf, aiGenerated, aiSkipped, totalInputTokens, totalOutputTokens, radarTickers, radarErrors };
    await recordCronRun(db, 'newsletter-snapshot', result, !isCronInvocation);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Newsletter snapshot error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
