import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import { connectToDatabase } from './lib/mongodb';
import { verifyJWT } from './lib/auth';
import { sendNewsletterEmail, buildNewsletterEmailHtml } from './lib/email';
import { NEWSLETTER_SMA_DEFAULT, buildStockResults } from './lib/newsletter-data';
import { shouldCronRun, recordCronRun } from './lib/cron-schedule';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();
const CRON_SECRET = process.env.CRON_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';

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

  try {
    const db = await connectToDatabase();

    if (!isPreview) {
      const run = await shouldCronRun(db, 'newsletter-send', { enabled: true, dayOfWeek: 0, hour: 14 }, isCronInvocation);
      if (!run) return res.status(200).json({ skipped: true, reason: 'outside scheduled window' });
    }

    // Only send to admin for now. Admin bypasses subscription check so
    // preview/test always works regardless of profile settings.
    const users = await db.collection('users').find({
      email: ADMIN_EMAIL,
    }).toArray();

    let sent = 0, failed = 0, skipped = 0;

    for (const user of users) {
      const watchlist: string[] = user.watchlist || [];
      if (watchlist.length === 0) {
        skipped++;
        continue;
      }

      const smaPeriod: number = user.smaPeriod || NEWSLETTER_SMA_DEFAULT;
      const chartOrientation: 'x' | 'y' = user.chartOrientation === 'x' ? 'x' : 'y';
      const stockResults = await buildStockResults(watchlist, db, smaPeriod);

      if (stockResults.length === 0) {
        skipped++;
        continue;
      }

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
        db,
      });

      if (ok) sent++;
      else failed++;
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
