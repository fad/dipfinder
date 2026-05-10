import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from './lib/mongodb';
import { sendEmail, buildEmailHtml } from './lib/email';
import { verifyJWT } from './lib/auth';
import { shouldCronRun, recordCronRun } from './lib/cron-schedule';

const CRON_SECRET = process.env.CRON_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';

const CRON_NAMES: Record<string, string> = {
  'morning-report':          'Morning Report',
  'health-check':            'Health Check',
  'newsletter-onboarding':   'Onboarding Emails',
  'newsletter-snapshot':     'Weekly Snapshot',
  'newsletter-send':         'Weekly Newsletter',
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: Vercel cron secret OR admin JWT
  let isAuthed = false;
  const authHeader = req.headers.authorization;
  if (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) {
    isAuthed = true;
  } else if (authHeader?.startsWith('Bearer ')) {
    try {
      const decoded = verifyJWT(authHeader.slice(7)) as any;
      if (ADMIN_EMAIL && decoded.email?.toLowerCase() === ADMIN_EMAIL) isAuthed = true;
    } catch {}
  }
  if (!isAuthed) return res.status(401).json({ error: 'Unauthorized' });

  const isCronInvocation = !!req.headers['x-vercel-cron'];
  const db = await connectToDatabase();
  const run = await shouldCronRun(db, 'morning-report', { enabled: true, hour: 7 }, isCronInvocation);
  if (!run) return res.status(200).json({ skipped: true, reason: 'outside scheduled window' });

  if (!ADMIN_EMAIL) return res.status(500).json({ error: 'ADMIN_EMAIL not set' });

  // ── Gather stats ─────────────────────────────────────────────────────────────
  const oneDayAgo   = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    newToday,
    newThisWeek,
    sundayBriefSubs,
    newsletterSubs,
    activeTickerCount,
  ] = await Promise.all([
    db.collection('users').countDocuments({}),
    db.collection('users').countDocuments({ createdDate: { $gte: oneDayAgo } }),
    db.collection('users').countDocuments({ createdDate: { $gte: sevenDaysAgo } }),
    db.collection('users').countDocuments({ sundayBriefSubscribed: true }),
    db.collection('users').countDocuments({ newsletterSubscribed: true }),
    db.collection('tickers').countDocuments({ active: true }),
  ]);

  // Cron last-run statuses
  const cronIds = Object.keys(CRON_NAMES);
  const cronDocs = await db.collection('settings')
    .find({ key: { $in: cronIds.map(id => `cron-last-run-${id}`) } })
    .toArray();
  const cronByKey: Record<string, any> = {};
  for (const doc of cronDocs) cronByKey[doc.key] = doc.value;

  // ── Build email ───────────────────────────────────────────────────────────────
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const statItems = [
    { label: 'Total Users',        value: totalUsers.toLocaleString() },
    { label: 'New Today',          value: newToday.toLocaleString() },
    { label: 'New This Week',      value: newThisWeek.toLocaleString() },
    { label: 'Sunday Brief Subs',  value: sundayBriefSubs.toLocaleString() },
    { label: 'Newsletter Subs',    value: newsletterSubs.toLocaleString() },
    { label: 'Active Tickers',     value: activeTickerCount.toLocaleString() },
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
        <td style="padding:9px 14px; font-size:0.875em; color:#1e293b; font-weight:600;">${CRON_NAMES[id]}</td>
        <td style="padding:9px 14px; font-size:0.875em; color:#94a3b8;" colspan="2">Never run</td>
      </tr>`;
    }
    const ranAt = new Date(last.ranAt).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'UTC', timeZoneName: 'short',
    });
    const failed = last.result?.anyFailed === true;
    const badge = failed
      ? '<span style="background:#FEE2E2;color:#DC2626;font-weight:700;font-size:0.75em;padding:2px 8px;border-radius:999px;">FAILED</span>'
      : '';
    return `<tr style="border-top:1px solid #f1f5f9;">
      <td style="padding:9px 14px; font-size:0.875em; color:#1e293b; font-weight:600;">${CRON_NAMES[id]}</td>
      <td style="padding:9px 14px; font-size:0.875em; color:#64748b;">${ranAt}${last.manual ? ' (manual)' : ''}</td>
      <td style="padding:9px 14px; text-align:right;">${badge}</td>
    </tr>`;
  }).join('');

  const bodyHtml = `
<h2 style="font-size:1.05rem; font-weight:700; color:#1e293b; margin:0 0 4px;">Good morning - daily report</h2>
<p style="font-size:13px; color:#94a3b8; margin:0 0 22px;">${dateLabel}</p>

<table style="border-collapse:collapse; margin-bottom:24px; width:100%;">
  <tr>${statCells}</tr>
</table>

<h3 style="font-size:0.72em; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.08em; margin:0 0 8px;">Cron Last Run</h3>
<table style="width:100%; border-collapse:collapse; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; font-family:Arial,Helvetica,sans-serif; margin-bottom:24px;">
  <tbody>${cronRows}</tbody>
</table>

<div style="text-align:center; margin-top:8px;">
  <a href="${FRONTEND_URL}/admin" style="display:inline-block; background:linear-gradient(135deg,#2563EB,#4F46E5); color:#FFFFFF; padding:12px 28px; border-radius:8px; text-decoration:none; font-weight:700; font-size:14px; font-family:Arial,Helvetica,sans-serif;">Open Admin &rarr;</a>
</div>`;

  const html = buildEmailHtml(bodyHtml);
  const shortDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const subject = `DipFinder Morning Report - ${shortDate}`;

  const emailSent = await sendEmail({ to: ADMIN_EMAIL, subject, html });

  const result = { totalUsers, newToday, newThisWeek, sundayBriefSubs, newsletterSubs, activeTickerCount, emailSent };
  await recordCronRun(db, 'morning-report', result, !isCronInvocation);
  return res.status(200).json(result);
}
