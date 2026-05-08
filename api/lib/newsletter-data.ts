import axios from 'axios';
import { calculateSma, CACHE_EXPIRY_STOCKS, yahooAxios } from './stocks';

export const NEWSLETTER_SMA_DEFAULT = 200;
const CACHE_EXPIRY_NEWS = 3 * 60 * 60 * 1000; // 3 hours
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

export type NewsItem = { headline: string; url: string; source: string; datetime: number };

export type DashboardStockCache = {
  companyName: string;
  currentPrice: number;
  previousPrice: number;
  closes: number[];
};

export type StockResult = {
  symbol: string;
  companyName: string;
  currentPrice: number;
  sma: number;
  relativePrice: number;
  topNews: NewsItem[];
};

export async function fetchNewsForSymbol(symbol: string, db: any): Promise<NewsItem[]> {
  const cacheKey = `news-${symbol.toUpperCase()}`;
  const col = db.collection('news');
  const doc = await col.findOne({ cacheKey });

  if (doc && Date.now() - doc.timestamp < CACHE_EXPIRY_NEWS) {
    return (doc.data?.news || []).slice(0, 2);
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
      { $set: { cacheKey, data: { news }, timestamp: Date.now() } },
      { upsert: true }
    );
    return news.slice(0, 2);
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

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=200d`;
  const response = await yahooAxios.get(url);
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

export async function buildStockResults(watchlist: string[], db: any, smaPeriod: number = NEWSLETTER_SMA_DEFAULT): Promise<StockResult[]> {
  const results: StockResult[] = [];
  for (const symbol of watchlist) {
    try {
      const data = await fetchStockData(symbol, db);
      if (data.closes.length >= smaPeriod) {
        const sma = calculateSma(data.closes, smaPeriod);
        const topNews = await fetchNewsForSymbol(symbol, db);
        results.push({
          symbol: symbol.toUpperCase(),
          companyName: data.companyName,
          currentPrice: data.currentPrice,
          sma,
          relativePrice: data.currentPrice / sma - 1,
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
