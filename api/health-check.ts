import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { connectToDatabase } from './lib/mongodb';
import { yahooFinance } from './lib/stocks';
import { sendEmail } from './lib/email';
import { verifyJWT } from './lib/auth';
import { shouldCronRun, recordCronRun } from './lib/cron-schedule';

const CRON_SECRET = process.env.CRON_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const RESEND_API_KEY = process.env.EMAIL_NOREPLY_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Public ping — no auth required
  if (req.query.action === 'ping') {
    return res.status(200).json({ status: 'API is working correctly', timestamp: new Date().toISOString() });
  }

  // Auth: Vercel cron OR admin JWT
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
  const db0 = await connectToDatabase();
  const run = await shouldCronRun(db0, 'health-check', { enabled: true, hour: 9 }, isCronInvocation);
  if (!run) return res.status(200).json({ skipped: true, reason: 'outside scheduled window' });

  const isCron = isCronInvocation;
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
    const today = new Date().toISOString().split('T')[0];
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const r = await axios.get(
      `https://finnhub.io/api/v1/company-news?symbol=AAPL&from=${lastWeek}&to=${today}&token=${FINNHUB_API_KEY}`
    );
    results.finnhub = { ok: Array.isArray(r.data), itemsReturned: Array.isArray(r.data) ? r.data.length : 0 };
  } catch (err: any) {
    results.finnhub = { ok: false, error: err?.message };
  }

  // 4. Resend — 401 on /domains means send-only key (valid for our use), 403/5xx = real problem
  try {
    if (!RESEND_API_KEY) throw new Error('EMAIL_NOREPLY_API_KEY not set');
    const r = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` }
    });
    // 401 = key exists but has send-only scope, still functional for email sending
    const ok = r.ok || r.status === 401;
    results.resend = { ok, httpStatus: r.status, note: r.status === 401 ? 'send-only key (expected)' : undefined };
  } catch (err: any) {
    results.resend = { ok: false, error: err?.message };
  }

  const anyFailed = Object.entries(results)
    .filter(([k]) => k !== 'checkedAt')
    .some(([, v]) => v?.ok === false);

  results.anyFailed = anyFailed;

  // Send email: always when triggered manually; only on failure when triggered by cron
  const shouldEmail = !isCron || anyFailed;
  let emailSent = false;

  if (shouldEmail && ADMIN_EMAIL) {
    const checks = ['mongodb', 'yahooFinance', 'finnhub', 'resend'];
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
      ? `DipFinder Health Check - ISSUES DETECTED`
      : `DipFinder Health Check - All systems OK`;

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
