import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { connectToDatabase } from '../lib/mongodb';
import {
  calculateSma,
  calculateSmaTimeSeries,
  CACHE_EXPIRY_STOCKS,
  CACHE_EXPIRY_FUNDAMENTALS,
  CACHE_EXPIRY_NEWS,
  CACHE_EXPIRY_COMPANY,
  yahooFinance,
} from '../lib/stocks';

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// Get current and last week dates for news
function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

function getLastWeekDate() {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return date.toISOString().split('T')[0];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { symbol } = req.query;
  const action = req.query.action as string || 'price'; // Default to price data
  const period = parseInt(req.query.period as string) || 200;

  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid symbol' });
  }

  if (!FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Missing Finnhub API key' });
  }

  try {
    const db = await connectToDatabase();

    switch (action) {
      case 'fundamentals':
        return await handleFundamentals(db, symbol, res);
      
      case 'news':
        return await handleNews(db, symbol, res);
      
      case 'company-name':
        return await handleCompanyName(db, symbol, res);
      
      case 'price':
      case 'timeseries':
        return await handleStockPrice(db, symbol, res);
      
      case 'sma':
        return await handleSMA(db, symbol, period, res);
      
      case 'sma-timeseries':
        return await handleSMATimeSeries(symbol, period, res);
      
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    console.error(`Error in stock-data API for ${symbol}:`, error);
    return res.status(500).json({ error: `Error processing request for ${symbol}` });
  }
}

// Handle fundamentals data
async function handleFundamentals(db: any, symbol: string, res: VercelResponse) {
  const cacheKey = `fundamentals-v7-${symbol}`;
  const collection = db.collection('fundamentals');
  
  // Check cache
  const cached = await collection.findOne({ cacheKey });
  if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY_FUNDAMENTALS) {
    return res.status(200).json(cached.data);
  }

  // Fetch from Finnhub API
  const [profileResponse, metricsResponse, quoteResponse, financialsResponse] = await Promise.all([
    axios.get(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${FINNHUB_API_KEY}`),
    axios.get(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${FINNHUB_API_KEY}`),
    axios.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`),
    axios.get(`https://finnhub.io/api/v1/stock/financials-reported?symbol=${symbol}&token=${FINNHUB_API_KEY}`)
  ]);

  const profile = profileResponse.data;
  const metrics = metricsResponse.data?.metric || {};
  const quote = quoteResponse.data;
  const financials = financialsResponse.data?.data?.[0] || {};

  // ── Financial history from annual filings ──────────────────────────────────
  // Helper: find a value in a report section (ic / bs) by concept name
  function findReportVal(items: any[], ...concepts: string[]): number | null {
    if (!Array.isArray(items)) return null;
    for (const concept of concepts) {
      const found = items.find((i: any) => i.concept === concept);
      if (found?.value != null && found.value !== 0) return found.value as number;
    }
    return null;
  }

  const annualFilings = (financialsResponse.data?.data || [])
    .filter((f: any) => f.quarter === 0)
    .sort((a: any, b: any) => b.year - a.year)
    .slice(0, 5);

  const history = annualFilings.map((filing: any) => {
    const ic: any[] = filing.report?.ic || [];
    const bs: any[] = filing.report?.bs || [];

    const revenue = findReportVal(ic,
      'us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax',
      'us-gaap_Revenues',
      'us-gaap_SalesRevenueNet',
      'us-gaap_RevenueFromContractWithCustomerIncludingAssessedTax',
      'us-gaap_RevenueFromContractWithCustomer'
    );
    const grossProfit  = findReportVal(ic, 'us-gaap_GrossProfit');
    const opIncome     = findReportVal(ic, 'us-gaap_OperatingIncomeLoss', 'us-gaap_OperatingIncome');
    const netIncome    = findReportVal(ic, 'us-gaap_NetIncomeLoss', 'us-gaap_NetIncome', 'us-gaap_ProfitLoss');
    const epsRaw       = findReportVal(ic, 'us-gaap_EarningsPerShareBasic', 'us-gaap_EarningsPerShareDiluted');
    const shares       = findReportVal(bs,
      'us-gaap_CommonStockSharesOutstanding',
      'us-gaap_CommonStockSharesIssued',
      'us-gaap_WeightedAverageNumberOfSharesOutstandingBasic'
    );

    const eps             = epsRaw ?? (netIncome != null && shares != null && shares > 0 ? netIncome / shares : null);
    const revenuePerShare = revenue != null && shares != null && shares > 0 ? revenue / shares : null;
    const grossMargin     = revenue != null && grossProfit  != null && revenue > 0 ? (grossProfit  / revenue) * 100 : null;
    const operatingMargin = revenue != null && opIncome     != null && revenue > 0 ? (opIncome     / revenue) * 100 : null;
    const netMargin       = revenue != null && netIncome    != null && revenue > 0 ? (netIncome    / revenue) * 100 : null;

    return {
      year:             filing.year as number,
      eps:              eps             != null ? parseFloat(eps.toFixed(2))             : null,
      revenuePerShare:  revenuePerShare != null ? parseFloat(revenuePerShare.toFixed(2)) : null,
      grossMargin:      grossMargin     != null ? parseFloat(grossMargin.toFixed(1))     : null,
      operatingMargin:  operatingMargin != null ? parseFloat(operatingMargin.toFixed(1)) : null,
      netMargin:        netMargin       != null ? parseFloat(netMargin.toFixed(1))       : null,
      sharesMillions:   shares          != null ? parseFloat((shares / 1e6).toFixed(0))  : null,
    };
  }).filter((d: any) => d.year).reverse(); // oldest→newest for left-to-right charts
  // ─────────────────────────────────────────────────────────────────────────────

  if (!profile.name && !quote.c) {
    return res.status(404).json({ error: `No data found for symbol ${symbol}` });
  }

  // Format the comprehensive data
  const fundamentalData = {
    // Company Info
    symbol: symbol.toUpperCase(),
    name: profile.name || symbol,
    exchange: profile.exchange || 'N/A',
    sector: profile.finnhubIndustry || 'N/A',
    industry: profile.industry || 'N/A',
    country: profile.country || 'N/A',
    employees: profile.employeeTotal || null,
    
    // Market Data
    currentPrice: quote.c || null,
    dayChange: quote.d || null,
    dayChangePercent: quote.dp || null,
    marketCap: profile.marketCapitalization ? `$${(profile.marketCapitalization / 1000).toFixed(2)}B` : null,
    volume: quote.volume || null,
    fiftyTwoWeekHigh: metrics['52WeekHigh'] || null,
    fiftyTwoWeekLow: metrics['52WeekLow'] || null,
    
    // Valuation Metrics
    peRatio: metrics.peBasicExclExtraTTM || metrics.peTTM || null,
    forwardPE: metrics.peNormalizedAnnual || null,
    pegRatio: metrics.pegRatio || null,
    priceToBook: metrics.pbQuarterly || null,
    priceToSales: metrics.psQuarterly || null,
    evToRevenue: metrics.evToRevenueTTM || null,
    evToEbitda: metrics.evToEbitdaTTM || null,
    
    // Financial Performance (convert decimal to percentage - only if value seems to be in decimal format)
    revenue: profile.marketCapitalization ? `$${(profile.marketCapitalization * (metrics.psQuarterly || 1) / 1000).toFixed(2)}B` : null,
    revenueGrowth: metrics.revenueGrowthTTMYoy ? (metrics.revenueGrowthTTMYoy < 10 ? metrics.revenueGrowthTTMYoy * 100 : metrics.revenueGrowthTTMYoy) : null,
    grossMargin: metrics.grossMarginTTM ? (metrics.grossMarginTTM <= 1 ? metrics.grossMarginTTM * 100 : metrics.grossMarginTTM) : null,
    operatingMargin: metrics.operatingMarginTTM ? (metrics.operatingMarginTTM <= 1 ? metrics.operatingMarginTTM * 100 : metrics.operatingMarginTTM) : null,
    profitMargin: metrics.netProfitMarginTTM ? (metrics.netProfitMarginTTM <= 1 ? metrics.netProfitMarginTTM * 100 : metrics.netProfitMarginTTM) : null,
    eps: metrics.epsBasicExclExtraItemsTTM || null,
    forwardEps: metrics.epsNormalizedAnnual || null,
    
    // Dividend & Risk (convert decimal to percentage - only if value seems to be in decimal format)
    dividendYield: metrics.dividendYieldIndicatedAnnual ? (metrics.dividendYieldIndicatedAnnual <= 0.2 ? metrics.dividendYieldIndicatedAnnual * 100 : metrics.dividendYieldIndicatedAnnual) : null,
    dividendRate: metrics.dividendPerShareAnnual || null,
    payoutRatio: metrics.payoutRatioTTM ? (metrics.payoutRatioTTM <= 1 ? metrics.payoutRatioTTM * 100 : metrics.payoutRatioTTM) : null,
    beta: metrics.beta || null,
    bookValue: metrics.bookValuePerShareQuarterly || null,

    // Annual filing history (oldest → newest, up to 5 years)
    history: history.length > 0 ? history : null,
  };

  // Cache the result
  await collection.updateOne(
    { cacheKey },
    { $set: { cacheKey, data: fundamentalData, timestamp: Date.now() } },
    { upsert: true }
  );

  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  return res.status(200).json(fundamentalData);
}

// Handle news data
async function handleNews(db: any, symbol: string, res: VercelResponse) {
  const cacheKey = `news-${symbol}`;
  const collection = db.collection('news');
  
  const cached = await collection.findOne({ cacheKey });
  if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY_NEWS) {
    return res.status(200).json(cached.data);
  }

  const url = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${getLastWeekDate()}&to=${getCurrentDate()}&token=${FINNHUB_API_KEY}`;
  const response = await axios.get(url);
  const result = { news: response.data };

  await collection.updateOne(
    { cacheKey },
    { $set: { cacheKey, data: result, timestamp: Date.now() } },
    { upsert: true }
  );

  res.setHeader('Cache-Control', 'public, max-age=180, stale-while-revalidate=1800');
  return res.status(200).json(result);
}

// Handle company name
async function handleCompanyName(db: any, symbol: string, res: VercelResponse) {
  const cacheKey = `company-name-${symbol}`;
  const collection = db.collection('companyNames');
  
  const cached = await collection.findOne({ cacheKey });
  if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY_COMPANY) {
    return res.status(200).json(cached.data);
  }

  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
  const response = await axios.get(url);
  const companyName = response.data.name || symbol;
  const result = { name: companyName };

  await collection.updateOne(
    { cacheKey },
    { $set: { cacheKey, data: result, timestamp: Date.now() } },
    { upsert: true }
  );

  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res.status(200).json(result);
}

// Handle stock price data
async function handleStockPrice(db: any, symbol: string, res: VercelResponse) {
  const data = await handleStockPriceInternal(db, symbol);
  if (!data) return res.status(404).json({ error: `No data found for symbol ${symbol}` });
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res.status(200).json(data);
}

// Handle SMA calculation
async function handleSMA(db: any, symbol: string, period: number, res: VercelResponse) {
  const stockData = await handleStockPriceInternal(db, symbol);
  
  if (!stockData?.chart?.result?.[0]) {
    return res.status(404).json({ error: `No data found for symbol ${symbol}` });
  }

  const prices = stockData.chart.result[0].indicators.quote[0].close;
  if (prices.length < period) {
    return res.status(400).json({ error: `Not enough data for ${period}-day SMA` });
  }

  const sma = calculateSma(prices, period);

  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res.status(200).json({ sma: parseFloat(sma.toFixed(2)) });
}

// Handle SMA time series
async function handleSMATimeSeries(symbol: string, period: number, res: VercelResponse) {
  try {
    const db = await connectToDatabase();
    const cacheKey = `sma-timeseries-${symbol}-${period}`;
    const collection = db.collection('smaTimeseries');

    const cached = await collection.findOne({ cacheKey });
    if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY_STOCKS) {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      return res.status(200).json(cached.data);
    }

    const priceData = await handleStockPriceInternal(db, symbol);
    if (!priceData?.chart?.result?.[0]) {
      return res.status(404).json({ error: `No data found for symbol ${symbol}` });
    }

    const result = priceData.chart.result[0];
    const timestamps: number[] = result.timestamp;
    const prices: number[] = result.indicators.quote[0].close;

    if (prices.length < period) {
      return res.status(400).json({ error: `Not enough data for ${period}-day SMA` });
    }

    const smaValues = calculateSmaTimeSeries(prices, period);
    const smaData = timestamps.map((ts: number, i: number) => ({
      date: new Date(ts * 1000).toISOString().split('T')[0],
      value: isNaN(smaValues[i]) ? null : parseFloat(smaValues[i].toFixed(2))
    })).filter((item: any) => item.value !== null);

    const responseData = { values: smaData };
    await collection.updateOne(
      { cacheKey },
      { $set: { cacheKey, data: responseData, timestamp: Date.now() } },
      { upsert: true }
    );

    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.status(200).json(responseData);
  } catch (error) {
    console.error(`Error in handleSMATimeSeries for ${symbol}:`, error);
    return res.status(500).json({ error: `Error calculating SMA timeseries for ${symbol}` });
  }
}

// Internal helper — fetches/caches stock price in the Yahoo v8 wire format
// (screener.js parses chart.result[0].timestamp + indicators.quote[0].close directly)
async function handleStockPriceInternal(db: any, symbol: string) {
  const cacheKey = `stock-${symbol}`;
  const collection = db.collection('stocks');

  const cached = await collection.findOne({ cacheKey });
  if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY_STOCKS) {
    return cached.data;
  }

  // Use yahoo-finance2 to avoid Yahoo Finance's 429 on plain HTTP requests
  const period1 = new Date(Date.now() - 548 * 24 * 60 * 60 * 1000); // ~18 months
  const chartData = await yahooFinance.chart(symbol, { period1, interval: '1d' });
  const quotes: any[] = chartData?.quotes ?? [];
  const closes = quotes.map((q: any) => q.close);
  const timestamps = quotes.map((q: any) => Math.floor(new Date(q.date).getTime() / 1000));

  if (quotes.length === 0) return null;

  // Build a shape compatible with what the screener expects
  const data = {
    chart: {
      result: [{
        meta: chartData?.meta ?? {},
        timestamp: timestamps,
        indicators: { quote: [{ close: closes }] },
      }],
      error: null,
    },
  };

  await collection.updateOne(
    { cacheKey },
    { $set: { cacheKey, data, timestamp: Date.now() } },
    { upsert: true }
  );

  return data;
}
