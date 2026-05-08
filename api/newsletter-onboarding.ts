import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from './lib/mongodb';
import { verifyJWT } from './lib/auth';
import { sendOnboardingEmail } from './lib/email';
import { shouldCronRun, recordCronRun } from './lib/cron-schedule';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: Vercel cron Bearer token OR admin JWT
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
    } catch { /* invalid token */ }
  }

  if (!isAuthed) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isCronInvocation = !!req.headers['x-vercel-cron'];

  try {
    const db = await connectToDatabase();

    const run = await shouldCronRun(db, 'newsletter-onboarding', { enabled: true, hour: 10 }, isCronInvocation);
    if (!run) return res.status(200).json({ skipped: true, reason: 'outside scheduled window' });

    // Find subscribers who haven't received an onboarding email yet
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
      // Brief pause to stay within Resend rate limits (100/day)
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
