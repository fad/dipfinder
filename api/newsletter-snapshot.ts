import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from './lib/mongodb';
import { verifyJWT } from './lib/auth';
import { buildStockResults, NEWSLETTER_SMA_DEFAULT, fetchStockData } from './lib/newsletter-data';
import { shouldCronRun, recordCronRun } from './lib/cron-schedule';
import { generateAiSummary, upsertAiSummary, estimateCost, getAiPromptTemplate, deduplicateNewsItems, type MacroContext } from './lib/ai-summaries';
import { sendEmail, buildEmailHtml } from './lib/email';
import { generateMacroRecap } from './lib/macro-recap';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();
const CRON_SECRET = process.env.CRON_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: Vercel cron (Authorization: Bearer <CRON_SECRET>) OR admin JWT
  let isAuthed = false;
  const authHeader = req.headers.authorization;
  if (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) {
    isAuthed = true;
  } else if (CRON_SECRET && req.headers['x-cron-secret'] === CRON_SECRET) {
    isAuthed = true;
  } else if (authHeader?.startsWith('Bearer ')) {
    try {
      const decoded = verifyJWT(authHeader.slice(7)) as any;
      if (ADMIN_EMAIL && decoded.email?.toLowerCase() === ADMIN_EMAIL) isAuthed = true;
    } catch { /* invalid/expired token */ }
  }

  if (!isAuthed) return res.status(401).json({ error: 'Unauthorized' });

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

        // Collect symbol data for AI summaries (first user's SMA period wins per symbol)
        for (const s of stockResults) {
          if (!symbolData.has(s.symbol)) {
            symbolData.set(s.symbol, {
              companyName: s.companyName,
              headlines: (s.topNews || []).map(n => n.headline),
              headlineDates: [],  // filled below after dedup
              relativePrice: s.relativePrice,
              smaPeriod,
              closes: [],   // filled below
              volumes: [],  // filled below
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
          // Fetch up to 10 headlines then deduplicate to 5 unique stories
          const { fetchNewsForSymbol } = await import('./lib/newsletter-data');
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

      // Fetch macro context and prompt template once
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

      // Notify admin that summaries are ready for review
      if (aiGenerated > 0 && ADMIN_EMAIL) {
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
      }
    }

    // Generate this week's macro recap (stored in weeklyMacroRecaps, served via {{weekInMacro}})
    try {
      await generateMacroRecap(db);
    } catch (err) {
      console.error('Macro recap generation failed (non-fatal):', err);
    }

    const result = { saved, failed, weekOf, aiGenerated, aiSkipped, totalInputTokens, totalOutputTokens };
    await recordCronRun(db, 'newsletter-snapshot', result, !isCronInvocation);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Newsletter snapshot error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
