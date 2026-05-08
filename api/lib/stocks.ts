// Shared stock calculation utilities

import YahooFinanceClass from 'yahoo-finance2';
// yahoo-finance2 v3 exports the class as default; instantiate once and share
export const yahooFinance = new (YahooFinanceClass as any)();

/**
 * Calculate a simple moving average over the most recent `period` prices.
 */
export function calculateSma(closes: number[], period: number): number {
  const recentPrices = closes.slice(-period);
  return recentPrices.reduce((sum, price) => sum + price, 0) / recentPrices.length;
}

/**
 * Calculate a full SMA time series. Returns NaN for indices before the first
 * complete window.
 */
export function calculateSmaTimeSeries(data: number[], period: number): number[] {
  const sma: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      sma.push(NaN);
    } else {
      const sum = data.slice(i - period + 1, i + 1).reduce((acc, val) => acc + val, 0);
      sma.push(sum / period);
    }
  }
  return sma;
}

// Shared cache TTL constants (ms)
export const CACHE_EXPIRY_STOCKS = 30 * 60 * 1000;       // 30 minutes
export const CACHE_EXPIRY_FUNDAMENTALS = 60 * 60 * 1000; // 1 hour
export const CACHE_EXPIRY_NEWS = 50 * 60 * 1000;         // 50 minutes
export const CACHE_EXPIRY_COMPANY = 5 * 60 * 1000;       // 5 minutes
