import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from './lib/mongodb';
import { calculateSma } from './lib/stocks';

const FALLBACK_IMAGE = 'https://dipfinder.com/img/preview.png';
const SHARE_TOKEN_RE = /^([a-f0-9]{24}|[A-Za-z0-9]{6})$/;

function getBarColor(pct: number): string {
  if (!Number.isFinite(pct)) return '#94A3B8';
  if (pct < -15) return '#0F766E';
  if (pct <  -5) return '#14B8A6';
  if (pct <   5) return '#94A3B8';
  if (pct <  15) return '#FBBF24';
  return '#F97316';
}

async function serveFallback(res: VercelResponse) {
  try {
    const r = await fetch(FALLBACK_IMAGE);
    const buf = await r.arrayBuffer();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(Buffer.from(buf));
  } catch {
    return res.redirect(302, FALLBACK_IMAGE);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token || !SHARE_TOKEN_RE.test(token)) return serveFallback(res);

  try {
    const db = await connectToDatabase();

    const share = await db.collection('sharedWatchlists').findOne(
      { token },
      { projection: { stocks: 1, smaPeriod: 1, watchlistName: 1, ownerName: 1 } }
    );
    if (!share) return serveFallback(res);

    const { stocks, smaPeriod, watchlistName, ownerName } = share;
    if (!Array.isArray(stocks) || stocks.length < 2) return serveFallback(res);

    // Read from dashboardStocks cache — no live fetches
    const cacheKeys = stocks.map((s: string) => `dashboard-stock-${s.toUpperCase()}`);
    const cachedDocs = await db.collection('dashboardStocks')
      .find({ cacheKey: { $in: cacheKeys } }, { projection: { cacheKey: 1, data: 1 } })
      .toArray();

    if (cachedDocs.length < 2) return serveFallback(res);

    const dataMap: Record<string, any> = {};
    for (const doc of cachedDocs) {
      const sym = (doc.cacheKey as string).replace('dashboard-stock-', '');
      dataMap[sym] = doc.data;
    }

    const rows: { symbol: string; pct: number; color: string }[] = [];
    for (const s of stocks) {
      const sym = (s as string).toUpperCase();
      const d = dataMap[sym];
      if (!d || !Array.isArray(d.closes) || d.closes.length < smaPeriod) continue;
      const sma = calculateSma(d.closes, smaPeriod);
      if (!sma) continue;
      const rel = d.currentPrice / sma - 1;
      const pct = Math.round(rel * 1000) / 10;
      rows.push({ symbol: sym, pct, color: getBarColor(rel * 100) });
    }

    if (rows.length < 2) return serveFallback(res);
    rows.sort((a, b) => a.pct - b.pct);

    const cfg = {
      type: 'horizontalBar',
      data: {
        labels: rows.map(r => r.symbol),
        datasets: [{
          data: rows.map(r => r.pct),
          backgroundColor: rows.map(r => r.color),
          barThickness: 28,
        }],
      },
      options: {
        title: {
          display: true,
          text: [watchlistName, `by ${ownerName} on Dip Finder  •  vs ${smaPeriod}-day SMA (%)`],
          fontColor: '#1e293b',
          fontSize: 18,
          fontStyle: 'bold',
          padding: 20,
        },
        legend: { display: false },
        scales: {
          xAxes: [{ ticks: { fontColor: '#64748b', fontSize: 11 }, gridLines: { color: '#e2e8f0' } }],
          yAxes: [{ ticks: { fontColor: '#1e293b', fontSize: 13, fontStyle: 'bold' }, gridLines: { display: false } }],
        },
      },
    };

    const h = Math.min(630, Math.max(280, rows.length * 52 + 110));
    const chartUrl = `https://quickchart.io/chart?w=1200&h=${h}&bkg=%23ffffff&c=${encodeURIComponent(JSON.stringify(cfg))}`;

    const imgRes = await fetch(chartUrl, { signal: AbortSignal.timeout(8000) });
    if (!imgRes.ok) return serveFallback(res);

    const imgBuf = await imgRes.arrayBuffer();
    res.setHeader('Content-Type', imgRes.headers.get('Content-Type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return res.send(Buffer.from(imgBuf));

  } catch (err) {
    console.error('OG image error:', err);
    return serveFallback(res);
  }
}
