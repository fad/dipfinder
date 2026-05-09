import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import { connectToDatabase } from './lib/mongodb';
import { buildNewsletterHtml } from './lib/email';
import { NEWSLETTER_SMA_DEFAULT, buildStockResults } from './lib/newsletter-data';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).send('<p>Method not allowed</p>');
  }

  const action = req.query.action as string;

  if (action === 'unsubscribe') return handleUnsubscribe(req, res);
  if (action === 'view') return handleView(req, res);

  return res.status(400).send('<p>Missing action</p>');
}

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

async function handleUnsubscribe(req: VercelRequest, res: VercelResponse) {
  const token = req.query.token as string;
  if (!token) {
    return res.status(400).send('Missing token');
  }

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
