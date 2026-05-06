import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from './lib/mongodb';
import axios from 'axios';
import { Document } from 'mongodb';

const CACHE_EXPIRY_STOCKS = 30 * 60 * 1000; // 30 minutes

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { stocks, period } = req.body;
  if (!Array.isArray(stocks) || !period) {
    return res.status(400).json({ error: 'Missing stocks array or period' });
  }
  try {
    const db = await connectToDatabase();
    const stockResults = await Promise.all(stocks.map(async (symbol: string) => {
      // Stock data
      const stockCacheKey = `stock-${symbol}`;
      const stockCollection = db.collection('stocks');
      let stockDataDoc = await stockCollection.findOne({ cacheKey: stockCacheKey });
      let stockData = stockDataDoc ? stockDataDoc.data : null;
      let stockTimestamp = stockDataDoc ? stockDataDoc.timestamp : 0;
      if (!stockData || Date.now() - stockTimestamp > CACHE_EXPIRY_STOCKS) {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=200d`;
        const response = await axios.get(url);
        stockData = response.data;
        await stockCollection.updateOne(
          { cacheKey: stockCacheKey },
          { $set: { cacheKey: stockCacheKey, data: stockData, timestamp: Date.now() } },
          { upsert: true }
        );
      }
      // SMA data
      const smaCacheKey = `sma-${symbol}-${period}`;
      const smaCollection = db.collection('stocksMA');
      let smaDataDoc = await smaCollection.findOne({ cacheKey: smaCacheKey });
      let sma = smaDataDoc ? smaDataDoc.data.sma : null;
      let smaTimestamp = smaDataDoc ? smaDataDoc.timestamp : 0;
      if (!sma || Date.now() - smaTimestamp > CACHE_EXPIRY_STOCKS) {
        const prices = stockData.chart.result[0].indicators.quote[0].close;
        const lastPrices = prices.slice(-Number(period));
        const total = lastPrices.reduce((sum: number, price: number) => sum + parseFloat(price as any), 0);
        sma = total / lastPrices.length;
        await smaCollection.updateOne(
          { cacheKey: smaCacheKey },
          { $set: { cacheKey: smaCacheKey, data: { sma }, timestamp: Date.now() } },
          { upsert: true }
        );
      }
      return {
        stock: symbol,
        stockData,
        sma
      };
    }));
    res.status(200).json({ results: stockResults });
  } catch (error) {
    console.error('Error in /api/batch-stocks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
