import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from './lib/mongodb';
import { verifyJWT } from './lib/auth';
import { buildStockResults, NEWSLETTER_SMA_DEFAULT } from './lib/newsletter-data';
import { shouldCronRun, recordCronRun } from './lib/cron-schedule';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();
const CRON_SECRET = process.env.CRON_SECRET;

/** Midnight UTC for today — used as the weeklySnapshots.weekOf key. */
function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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

    for (const user of users) {
      try {
        const smaPeriod: number = user.smaPeriod || NEWSLETTER_SMA_DEFAULT;
        const stockResults = await buildStockResults(user.watchlist, db, smaPeriod);
        if (stockResults.length === 0) continue;

        const stocks = stockResults.map(s => ({ symbol: s.symbol, relativePrice: s.relativePrice }));

        await db.collection('weeklySnapshots').updateOne(
          { userId: user._id.toString(), weekOf },
          {
            $set:         { stocks, updatedAt: new Date() },
            $setOnInsert: { userId: user._id.toString(), weekOf, createdAt: new Date() },
          },
          { upsert: true },
        );
        saved++;
      } catch (err) {
        console.error(`Snapshot failed for ${user.email}:`, err);
        failed++;
      }
    }

    const result = { saved, failed, weekOf };
    await recordCronRun(db, 'newsletter-snapshot', result, !isCronInvocation);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Newsletter snapshot error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
