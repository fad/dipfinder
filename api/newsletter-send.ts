import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { connectToDatabase } from './lib/mongodb';
import { calculateSma, CACHE_EXPIRY_STOCKS } from './lib/stocks';
import { verifyJWT } from './lib/auth';
import { sendNewsletterEmail } from './lib/email';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();
const CRON_SECRET = process.env.CRON_SECRET;
const NEWSLETTER_SMA_PERIOD = 50;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';

type DashboardStockCache = {
  companyName: string;
  currentPrice: number;
  previousPrice: number;
  closes: number[];
};

async function fetchStockData(symbol: string, db: any): Promise<DashboardStockCache> {
  const cacheKey = `dashboard-stock-${symbol.toUpperCase()}`;
  const col = db.collection('dashboardStocks');
  const doc = await col.findOne({ cacheKey });

  if (doc && Date.now() - doc.timestamp <= CACHE_EXPIRY_STOCKS) {
    return doc.data as DashboardStockCache;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=200d`;
  const response = await axios.get(url);
  const result = response.data?.chart?.result?.[0];
  const closes: number[] = (result?.indicators?.quote?.[0]?.close ?? []).filter(
    (p: unknown) => Number.isFinite(p)
  );

  if (closes.length < 2) throw new Error(`No chart data for ${symbol}`);

  const meta = result.meta || {};
  const data: DashboardStockCache = {
    companyName: meta.longName || meta.shortName || meta.symbol || symbol,
    currentPrice: closes[closes.length - 1],
    previousPrice: closes[closes.length - 2],
    closes,
  };

  await col.updateOne(
    { cacheKey },
    { $set: { cacheKey, data, timestamp: Date.now() } },
    { upsert: true }
  );

  return data;
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

  try {
    const db = await connectToDatabase();

    // Only send to admin for now; skip users with empty watchlists
    const users = await db.collection('users').find({
      email: ADMIN_EMAIL,
      newsletterSubscribed: true,
    }).toArray();

    let sent = 0, failed = 0, skipped = 0;

    for (const user of users) {
      const watchlist: string[] = user.watchlist || [];
      if (watchlist.length === 0) {
        skipped++;
        continue;
      }

      const stockResults: {
        symbol: string;
        companyName: string;
        currentPrice: number;
        sma: number;
        relativePrice: number;
      }[] = [];

      for (const symbol of watchlist) {
        try {
          const data = await fetchStockData(symbol, db);
          if (data.closes.length >= NEWSLETTER_SMA_PERIOD) {
            const sma = calculateSma(data.closes, NEWSLETTER_SMA_PERIOD);
            stockResults.push({
              symbol: symbol.toUpperCase(),
              companyName: data.companyName,
              currentPrice: data.currentPrice,
              sma,
              relativePrice: data.currentPrice / sma - 1,
            });
          }
        } catch (err) {
          console.error(`Newsletter: failed to fetch ${symbol}:`, err);
        }
      }

      if (stockResults.length === 0) {
        skipped++;
        continue;
      }

      // Rank by dip: most negative (biggest dip) first
      stockResults.sort((a, b) => a.relativePrice - b.relativePrice);

      const unsubToken = jwt.sign(
        { email: user.email, purpose: 'unsubscribe' },
        JWT_SECRET,
        { expiresIn: '365d' }
      );
      const unsubscribeUrl = `${FRONTEND_URL}/api/newsletter-unsubscribe?token=${unsubToken}`;

      const ok = await sendNewsletterEmail({
        to: user.email,
        name: user.name || 'there',
        stocks: stockResults,
        smaPeriod: NEWSLETTER_SMA_PERIOD,
        unsubscribeUrl,
      });

      if (ok) sent++;
      else failed++;
    }

    return res.status(200).json({ sent, failed, skipped });
  } catch (error) {
    console.error('Newsletter send error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
