import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import { connectToDatabase } from './lib/mongodb';
import { verifyJWT } from './lib/auth';
import { sendNewsletterEmail, buildNewsletterEmailHtml } from './lib/email';
import { NEWSLETTER_SMA_DEFAULT, buildStockResults, fetchAllWeekEarnings, filterEarningsByWatchlist } from './lib/newsletter-data';
import { fetchCurrentWeekMacroRecap } from './lib/macro-recap';
import { buildOpenerSummary } from './lib/personalOpener';
import { recordCronRun } from './lib/cron-schedule';
import { getApprovedSummaries } from './lib/ai-summaries';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();
const CRON_SECRET = process.env.CRON_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';

// Returns true when the user's local time is Sunday 7-9am.
// Accepts a ±1h window around 8am to absorb cron timing imprecision.
// Users without a stored timezone default to UTC, so they are included
// in the Sunday 07:00 UTC cron window.
function isTimeToSend(timezone: string | undefined): boolean {
  const tz = timezone || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '-1', 10);
    // 6-10am window: wider than ±1h to handle DST shifts at window edges
    // (e.g. America/New_York is UTC-4 in summer → 10am at the 14:00 UTC cron)
    return weekday === 'Sun' && hour >= 6 && hour <= 10;
  } catch {
    const now = new Date();
    return now.getUTCDay() === 0 && now.getUTCHours() >= 7 && now.getUTCHours() <= 9;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: Vercel cron (Authorization: Bearer <CRON_SECRET>) OR x-cron-secret header OR admin JWT
  let isAuthed = false;
  const authHeader = req.headers.authorization;
  if (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) {
    isAuthed = true;
  } else if (CRON_SECRET && req.headers['x-cron-secret'] === CRON_SECRET) {
    isAuthed = true;
  } else if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const decoded = verifyJWT(token) as any;
      if (ADMIN_EMAIL && decoded.email?.toLowerCase() === ADMIN_EMAIL) {
        isAuthed = true;
      }
    } catch {
      // invalid/expired token
    }
  }

  if (!isAuthed) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isPreview = req.query.preview === 'true';
  const isCronInvocation = !!req.headers['x-vercel-cron'];

  // Admin can preview any user's brief by passing ?previewEmail=<email>.
  // isAuthed already verified the caller; no need to re-check the token here.
  let previewEmail = ADMIN_EMAIL;
  if (isPreview && req.query.previewEmail && typeof req.query.previewEmail === 'string') {
    previewEmail = req.query.previewEmail.toLowerCase();
  }

  try {
    const db = await connectToDatabase();

    // Preview: use the target user (admin by default, or any user if previewEmail specified).
    // Live send: all sundayBriefSubscribed users — filtered per-user by timezone below.
    const query = isPreview
      ? { email: previewEmail }
      : { sundayBriefSubscribed: true };
    const users = await db.collection('users').find(query).toArray();

    if (isPreview && users.length === 0) {
      return res.status(404).send(`<p>User not found: ${previewEmail}</p>`);
    }

    // Fetch admin-approved AI summaries once — shared across all users this send run
    const aiSummaries = await getApprovedSummaries(db);

    // Fetch this week's full earnings calendar once — filtered per user inside the loop
    const allEarningsThisWeek = await fetchAllWeekEarnings(db);

    // Fetch macro recap once — same text for all users
    const weekInMacroText = await fetchCurrentWeekMacroRecap(db);

    let sent = 0, failed = 0, skipped = 0;

    for (const user of users) {
      // Timezone check: only send when it's Sunday 7-9am in the user's local time.
      // Each of the 3 weekly cron windows covers a different region; lastNewsletterSentAt
      // prevents double-sends if a user's timezone falls near a window boundary.
      if (!isPreview) {
        if (!isTimeToSend(user.timezone)) {
          skipped++;
          continue;
        }
        // Skip if already sent this week
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        if (user.lastNewsletterSentAt && new Date(user.lastNewsletterSentAt) > sevenDaysAgo) {
          skipped++;
          continue;
        }
      }

      const watchlist: string[] = user.watchlist || [];
      if (watchlist.length === 0) {
        if (isPreview) return res.status(200).send('<p>This user has no watchlist stocks.</p>');
        skipped++;
        continue;
      }

      const smaPeriod: number = user.smaPeriod || NEWSLETTER_SMA_DEFAULT;
      const chartOrientation: 'x' | 'y' = user.chartOrientation === 'x' ? 'x' : 'y';
      const weeklyEarnings = filterEarningsByWatchlist(allEarningsThisWeek, watchlist);
      const stockResults = await buildStockResults(watchlist, db, smaPeriod);

      if (stockResults.length === 0) {
        if (isPreview) return res.status(200).send(`<p>Could not load stock data for ${user.email}&apos;s watchlist (${watchlist.join(', ')}). Yahoo Finance may be temporarily unavailable or the SMA period requires more history than is cached.</p>`);
        skipped++;
        continue;
      }

      // Fetch last week's snapshot to power the personal opener.
      // Query for the most recent snapshot older than 6 days so we always
      // get the previous week's data, not Saturday's freshly-written one.
      const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
      const prevSnapshot = await db.collection('weeklySnapshots').findOne(
        { userId: user._id.toString(), weekOf: { $lt: sixDaysAgo } },
        { sort: { weekOf: -1 } },
      );
      const previousStocks = prevSnapshot?.stocks ?? null;
      const currentStocks = stockResults.map(s => ({ symbol: s.symbol, relativePrice: s.relativePrice }));
      const openerSummary = buildOpenerSummary(currentStocks, previousStocks);

      const unsubToken = jwt.sign(
        { email: user.email, purpose: 'unsubscribe' },
        JWT_SECRET,
        { expiresIn: '365d' }
      );
      const unsubscribeUrl = `${FRONTEND_URL}/api/newsletter-unsubscribe?token=${unsubToken}`;

      if (isPreview) {
        // Admin preview — no view-online link
        const { html } = await buildNewsletterEmailHtml({
          name: user.name || 'there',
          stocks: stockResults,
          smaPeriod,
          unsubscribeUrl,
          chartOrientation,
          openerSummary,
          aiSummaries,
          weeklyEarnings,
          weekInMacroText,
          db,
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(html);
      }

      const viewToken = jwt.sign(
        { email: user.email, purpose: 'newsletter-view' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      const viewOnlineUrl = `${FRONTEND_URL}/newsletter/${viewToken}`;

      const ok = await sendNewsletterEmail({
        to: user.email,
        name: user.name || 'there',
        stocks: stockResults,
        smaPeriod,
        unsubscribeUrl,
        viewOnlineUrl,
        chartOrientation,
        openerSummary,
        aiSummaries,
        weeklyEarnings,
        weekInMacroText,
        db,
      });

      if (ok) {
        sent++;
        // Record send time so subsequent cron windows skip this user this week
        await db.collection('users').updateOne(
          { _id: user._id },
          { $set: { lastNewsletterSentAt: new Date() } }
        );
      } else {
        failed++;
      }

      // Pace sends to stay within Resend rate limits (100/day free plan)
      await new Promise(r => setTimeout(r, 300));
    }

    if (isPreview) {
      return res.status(404).send('<p>No eligible user or watchlist found for preview.</p>');
    }
    const result = { sent, failed, skipped };
    await recordCronRun(db, 'newsletter-send', result, !isCronInvocation);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Newsletter send error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
