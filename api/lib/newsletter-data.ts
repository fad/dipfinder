import axios from 'axios';
import { calculateSma, CACHE_EXPIRY_STOCKS, yahooFinance } from './stocks';

export const NEWSLETTER_SMA_DEFAULT = 200;
const CACHE_EXPIRY_NEWS = 3 * 60 * 60 * 1000; // 3 hours
const CACHE_EXPIRY_EARNINGS = 24 * 60 * 60 * 1000; // 24 hours
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

export type NewsItem = { headline: string; url: string; source: string; datetime: number };

// One upcoming earnings event as returned by Finnhub /calendar/earnings (filtered to watchlist)
export type EarningsItem = {
  symbol: string; // uppercase
  date: string;   // YYYY-MM-DD
  hour: string;   // 'bmo' | 'amc' | 'dmh' | '' (before open / after close / intraday / unknown)
};

export type DashboardStockCache = {
  companyName: string;
  currentPrice: number;
  previousPrice: number;
  closes: number[];
  volumes: number[];
};

export type StockResult = {
  symbol: string;
  companyName: string;
  currentPrice: number;
  sma: number;
  relativePrice: number;
  weeklyChange: number;
  topNews: NewsItem[];
};

export async function fetchNewsForSymbol(symbol: string, db: any, limit = 2): Promise<NewsItem[]> {
  const cacheKey = `news-${symbol.toUpperCase()}`;
  const col = db.collection('news');
  const doc = await col.findOne({ cacheKey });

  if (doc && Date.now() - doc.timestamp < CACHE_EXPIRY_NEWS) {
    return (doc.data?.news || []).slice(0, limit);
  }

  if (!FINNHUB_API_KEY) return [];

  const today = new Date().toISOString().split('T')[0];
  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const response = await axios.get(
      `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${lastWeek}&to=${today}&token=${FINNHUB_API_KEY}`
    );
    const news: NewsItem[] = response.data || [];
    await col.updateOne(
      { cacheKey },
      { $set: { cacheKey, data: { news }, timestamp: new Date() } },
      { upsert: true }
    );
    return news.slice(0, limit);
  } catch {
    return [];
  }
}

export async function fetchStockData(symbol: string, db: any): Promise<DashboardStockCache> {
  const cacheKey = `dashboard-stock-${symbol.toUpperCase()}`;
  const col = db.collection('dashboardStocks');
  const doc = await col.findOne({ cacheKey });

  if (doc && Date.now() - doc.timestamp <= CACHE_EXPIRY_STOCKS) {
    return doc.data as DashboardStockCache;
  }

  // 365 calendar days ≈ 250 trading days — gives comfortable headroom above the
  // 200-day SMA requirement after subtracting weekends (~104) and US holidays (~10).
  const period1 = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const chartData = await yahooFinance.chart(symbol.toUpperCase(), { period1, interval: '1d' });
  // Filter by valid close, keep volumes aligned to the same rows
  const validQuotes: any[] = (chartData?.quotes ?? []).filter((q: any) => Number.isFinite(q.close));
  const closes: number[] = validQuotes.map((q: any) => q.close);
  const volumes: number[] = validQuotes.map((q: any) => Number.isFinite(q.volume) ? q.volume : 0);

  if (closes.length < 2) throw new Error(`No chart data for ${symbol}`);

  const meta = chartData?.meta ?? {};
  const data: DashboardStockCache = {
    companyName: meta.longName || meta.shortName || meta.symbol || symbol,
    currentPrice: closes[closes.length - 1],
    previousPrice: closes[closes.length - 2],
    closes,
    volumes,
  };

  await col.updateOne(
    { cacheKey },
    { $set: { cacheKey, data, timestamp: new Date() } },
    { upsert: true }
  );

  return data;
}

/**
 * Fetches all earnings events in the next 7 days from Finnhub, caches the raw list
 * in MongoDB for 24 h, and returns it unfiltered. Filter per user at call-site using
 * filterEarningsByWatchlist(). Hoisting this outside the per-user send loop avoids
 * one Finnhub call + one cache lookup per subscriber.
 */
export async function fetchAllWeekEarnings(db: any): Promise<EarningsItem[]> {
  if (!FINNHUB_API_KEY) return [];

  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cacheKey = `earnings-calendar-${from}`;

  const col = db.collection('earningsCalendar');
  try {
    const cached = await col.findOne({ cacheKey });
    if (cached && Date.now() - new Date(cached.timestamp).getTime() < CACHE_EXPIRY_EARNINGS) {
      return cached.data as EarningsItem[];
    }
  } catch (err) {
    console.error('fetchAllWeekEarnings: cache read error:', err);
  }

  try {
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${FINNHUB_API_KEY}`;
    const response = await axios.get(url);
    const raw: any[] = response.data?.earningsCalendar ?? [];
    const all: EarningsItem[] = raw
      .map(e => ({
        symbol: (e.symbol || '').toUpperCase(),
        date: e.date || '',
        hour: e.hour || '',
      }))
      .filter(e => e.symbol && e.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    await col.updateOne(
      { cacheKey },
      { $set: { cacheKey, data: all, timestamp: new Date() } },
      { upsert: true }
    );
    return all;
  } catch (err) {
    console.error('fetchAllWeekEarnings: Finnhub error:', err);
    return [];
  }
}

/** Filter a full earnings list down to tickers on the given watchlist. */
export function filterEarningsByWatchlist(all: EarningsItem[], watchlist: string[]): EarningsItem[] {
  const symbols = new Set(watchlist.map(s => s.toUpperCase()));
  return all.filter(e => symbols.has(e.symbol));
}

export async function buildStockResults(watchlist: string[], db: any, smaPeriod: number = NEWSLETTER_SMA_DEFAULT): Promise<StockResult[]> {
  const results: StockResult[] = [];
  for (const symbol of watchlist) {
    try {
      const data = await fetchStockData(symbol, db);
      if (data.closes.length >= smaPeriod) {
        const sma = calculateSma(data.closes, smaPeriod);
        const topNews = await fetchNewsForSymbol(symbol, db);
        const closes = data.closes;
        const weekAgoClose = closes.length >= 6 ? closes[closes.length - 6] : closes[0];
        const weeklyChange = weekAgoClose > 0 ? (closes[closes.length - 1] - weekAgoClose) / weekAgoClose : 0;
        results.push({
          symbol: symbol.toUpperCase(),
          companyName: data.companyName,
          currentPrice: data.currentPrice,
          sma,
          relativePrice: data.currentPrice / sma - 1,
          weeklyChange,
          topNews,
        });
      }
    } catch (err) {
      console.error(`Newsletter: failed to fetch ${symbol}:`, err);
    }
  }
  results.sort((a, b) => a.relativePrice - b.relativePrice);
  return results;
}
