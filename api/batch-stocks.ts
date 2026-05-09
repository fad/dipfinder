import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from './lib/mongodb';
import { calculateSma, CACHE_EXPIRY_STOCKS, yahooFinance } from './lib/stocks';
import { verifyJWT } from './lib/auth';
import { getActiveTickers, upsertTicker } from './lib/tickers';

const GUEST_STOCK_LIMIT = 5;
const AUTH_STOCK_LIMIT = 10;

type DashboardStockCache = {
  companyName: string;
  currentPrice: number;
  previousPrice: number;
  closes: number[];
};

type MemoryCacheEntry = {
  data: DashboardStockCache;
  timestamp: number;
};

declare global {
  // eslint-disable-next-line no-var
  var _dashboardStockCache: Record<string, MemoryCacheEntry> | undefined;
}

const memoryCache = globalThis._dashboardStockCache || {};
globalThis._dashboardStockCache = memoryCache;

function getCachedDashboardStock(data: any): DashboardStockCache | null {
  // yahoo-finance2 chart() response: { meta, quotes: [{close, ...}] }
  const closes: number[] = (data?.quotes ?? [])
    .map((q: any) => q.close)
    .filter((p: unknown) => Number.isFinite(p));

  if (closes.length < 2) return null;

  const meta = data?.meta ?? {};
  return {
    companyName: meta.longName || meta.shortName || meta.symbol || 'Unknown',
    currentPrice: closes[closes.length - 1],
    previousPrice: closes[closes.length - 2],
    closes,
  };
}


export default async function handler(req: VercelRequest, res: VercelResponse) {
  // GET /api/batch-stocks?action=tickers — used by stock autocomplete
  if (req.method === 'GET' && req.query.action === 'tickers') {
    try {
      const db = await connectToDatabase();
      const tickers = await getActiveTickers(db);
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      return res.status(200).json({ tickers });
    } catch (error) {
      console.error('Tickers error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { stocks, period } = req.body;
  const smaPeriod = Number(period);
  if (!Array.isArray(stocks) || !Number.isFinite(smaPeriod) || smaPeriod <= 0) {
    return res.status(400).json({ error: 'Missing stocks array or period' });
  }

  // Enforce stock limit server-side
  const authHeader = req.headers.authorization;
  let stockLimit = GUEST_STOCK_LIMIT;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      verifyJWT(authHeader.slice(7));
      stockLimit = AUTH_STOCK_LIMIT;
    } catch {
      // invalid/expired token — apply guest limit
    }
  }
  if (stocks.length > stockLimit) {
    return res.status(400).json({ error: `Stock limit exceeded (max ${stockLimit})` });
  }

  const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
  const validatedStocks = (stocks as any[]).filter(
    s => typeof s === 'string' && TICKER_RE.test(s.toUpperCase())
  );
  if (validatedStocks.length !== stocks.length) {
    return res.status(400).json({ error: 'Invalid ticker symbol in request' });
  }

  try {
    let stockCollectionPromise: Promise<any> | null = null;
    const getStockCollection = async () => {
      if (!stockCollectionPromise) {
        stockCollectionPromise = connectToDatabase().then(db => db.collection('dashboardStocks'));
      }
      return stockCollectionPromise;
    };

    const stockResults = await Promise.all(stocks.map(async (symbol: string) => {
      const normalizedSymbol = symbol.toUpperCase();
      const stockCacheKey = `dashboard-stock-${normalizedSymbol}`;
      const memoryEntry = memoryCache[stockCacheKey];
      let dashboardStock = memoryEntry ? memoryEntry.data : null;
      let stockTimestamp = memoryEntry ? memoryEntry.timestamp : 0;

      if (!dashboardStock || Date.now() - stockTimestamp > CACHE_EXPIRY_STOCKS) {
        const stockCollection = await getStockCollection();
        const stockDataDoc = await stockCollection.findOne({ cacheKey: stockCacheKey });
        dashboardStock = stockDataDoc ? stockDataDoc.data as DashboardStockCache : null;
        stockTimestamp = stockDataDoc ? stockDataDoc.timestamp : 0;

        if (dashboardStock && Date.now() - stockTimestamp <= CACHE_EXPIRY_STOCKS) {
          memoryCache[stockCacheKey] = { data: dashboardStock, timestamp: stockTimestamp };
        }
      }

      if (!dashboardStock || Date.now() - stockTimestamp > CACHE_EXPIRY_STOCKS) {
        // 290 calendar days ≈ 200 trading days (accounts for weekends + holidays)
        const period1 = new Date(Date.now() - 290 * 24 * 60 * 60 * 1000);
        const chartData = await yahooFinance.chart(normalizedSymbol, { period1, interval: '1d' });
        dashboardStock = getCachedDashboardStock(chartData);

        if (!dashboardStock) {
          throw new Error(`No chart data found for ${symbol}`);
        }

        // Teach the autocomplete about this ticker
        const db = await connectToDatabase();
        const name = dashboardStock.companyName !== 'Unknown' ? dashboardStock.companyName : normalizedSymbol;
        upsertTicker(db, normalizedSymbol, name).catch(() => {});

        const stockCollection = await getStockCollection();
        await stockCollection.updateOne(
          { cacheKey: stockCacheKey },
          { $set: { cacheKey: stockCacheKey, data: dashboardStock, timestamp: Date.now() } },
          { upsert: true }
        );
        memoryCache[stockCacheKey] = { data: dashboardStock, timestamp: Date.now() };
      }

      if (!dashboardStock || dashboardStock.closes.length < smaPeriod) {
        throw new Error(`Not enough data for ${symbol} ${smaPeriod}-day SMA`);
      }

      const sma = calculateSma(dashboardStock.closes, smaPeriod);
      const relativePrice = dashboardStock.currentPrice / sma - 1;

      return {
        stock: normalizedSymbol,
        companyName: dashboardStock.companyName,
        currentPrice: dashboardStock.currentPrice,
        previousPrice: dashboardStock.previousPrice,
        sma,
        relativePrice
      };
    }));
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.status(200).json({ results: stockResults });
  } catch (error) {
    console.error('Error in /api/batch-stocks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
