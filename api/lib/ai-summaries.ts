/**
 * AI-powered news summarization for the Sunday Brief.
 *
 * Summaries are generated during the Saturday snapshot cron, stored in the
 * `aiSummaries` collection with reviewed:false, and published to subscribers
 * only after an admin approves them in the admin panel.
 */
import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export type AiSummaryDoc = {
  weekOf: Date;
  symbol: string;
  companyName: string;
  summary: string;         // raw AI-generated text
  headlines: string[];     // Finnhub headlines used as input
  reviewed: boolean;
  approved: boolean;
  editedSummary?: string;  // admin-edited version (used instead of summary when set)
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
  updatedAt: Date;
};

export type MacroContext = {
  spyWeekly?: number;  // SPY % change over last 5 trading days
  qqqWeekly?: number;  // QQQ % change over last 5 trading days
};

export type SummaryResult = {
  summary: string;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Calculate how many consecutive trading days a stock has been below its SMA,
 * and whether the dip is deepening or recovering vs 5 days ago.
 */
function getDipContext(closes: number[], smaPeriod: number): { streak: number; trend: 'deepening' | 'recovering' | 'stable' } {
  if (closes.length < smaPeriod + 1) return { streak: 0, trend: 'stable' };

  // Streak: walk backwards from most recent close, count days below SMA
  let streak = 0;
  for (let i = closes.length - 1; i >= smaPeriod - 1 && streak <= 60; i--) {
    const slice = closes.slice(i - smaPeriod + 1, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / smaPeriod;
    if (closes[i] < sma) streak++;
    else break;
  }

  // Trend: compare dip % now vs 5 trading days ago
  let trend: 'deepening' | 'recovering' | 'stable' = 'stable';
  const fiveDaysBack = closes.length - 6;
  if (fiveDaysBack >= smaPeriod) {
    const nowSma = closes.slice(-smaPeriod).reduce((a, b) => a + b, 0) / smaPeriod;
    const nowRel = closes[closes.length - 1] / nowSma - 1;

    const pastSlice = closes.slice(fiveDaysBack - smaPeriod + 1, fiveDaysBack + 1);
    const pastSma = pastSlice.reduce((a, b) => a + b, 0) / smaPeriod;
    const pastRel = closes[fiveDaysBack] / pastSma - 1;

    const delta = nowRel - pastRel;
    if (delta < -0.01) trend = 'deepening';
    else if (delta > 0.01) trend = 'recovering';
  }

  return { streak, trend };
}

/**
 * Call Claude Haiku to produce a 1-2 sentence newsletter summary.
 * Returns empty summary with zero tokens if no API key or no headlines.
 */
export async function generateAiSummary(
  symbol: string,
  companyName: string,
  headlines: string[],
  relativePrice: number,
  smaPeriod: number,
  options?: {
    closes?: number[];
    macro?: MacroContext;
  },
): Promise<SummaryResult> {
  if (!ANTHROPIC_API_KEY || !headlines.length) {
    return { summary: '', inputTokens: 0, outputTokens: 0 };
  }

  const position =
    relativePrice < -0.05 ? 'in dip territory (below trend)'
    : relativePrice > 0.05 ? 'above its long-term trend'
    : 'near its long-term trend';
  const pct = `${relativePrice > 0 ? '+' : ''}${(relativePrice * 100).toFixed(1)}%`;

  // Dip duration context
  let dipContext = '';
  if (options?.closes && options.closes.length >= smaPeriod) {
    const { streak, trend } = getDipContext(options.closes, smaPeriod);
    if (streak > 1) {
      const trendLabel = trend === 'deepening' ? ', deepening' : trend === 'recovering' ? ', recovering' : '';
      dipContext = `\nDip duration: ${streak} consecutive trading days below the ${smaPeriod}-day SMA${trendLabel}.`;
    }
  }

  // Macro context
  let macroContext = '';
  if (options?.macro) {
    const parts: string[] = [];
    if (options.macro.spyWeekly !== undefined) {
      parts.push(`S&P 500 (SPY) ${options.macro.spyWeekly > 0 ? '+' : ''}${options.macro.spyWeekly.toFixed(1)}% this week`);
    }
    if (options.macro.qqqWeekly !== undefined) {
      parts.push(`Nasdaq (QQQ) ${options.macro.qqqWeekly > 0 ? '+' : ''}${options.macro.qqqWeekly.toFixed(1)}% this week`);
    }
    if (parts.length) macroContext = `\nMarket context: ${parts.join(', ')}.`;
  }

  const prompt = `You are a concise financial newsletter writer. Given a stock's current market position and recent news headlines, write 1-2 sentences that explain what is happening. Be factual and specific to the provided headlines. If the stock move looks macro-driven (market context shows similar broad move), say so briefly. Do not make buy/sell recommendations. Do not start with the stock ticker or company name.

Stock: ${symbol} (${companyName})
Current position: ${pct} vs ${smaPeriod}-day SMA (${position})${dipContext}${macroContext}
Recent headlines:
${headlines.slice(0, 5).map((h, i) => `${i + 1}. ${h}`).join('\n')}

Write a 1-2 sentence summary for a Sunday investor newsletter:`;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = message.content[0];
    const summary = block.type === 'text' ? block.text.trim() : '';
    return {
      summary,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  } catch (err) {
    console.error(`generateAiSummary: failed for ${symbol}:`, err);
    return { summary: '', inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * Store (or refresh) an AI summary for a symbol+week.
 * Resets reviewed/approved so the admin must re-approve updated content.
 */
export async function upsertAiSummary(
  db: any,
  symbol: string,
  companyName: string,
  headlines: string[],
  result: SummaryResult,
  weekOf: Date,
): Promise<void> {
  const col = db.collection('aiSummaries');
  await col.updateOne(
    { symbol: symbol.toUpperCase(), weekOf },
    {
      $set: {
        companyName,
        summary: result.summary,
        headlines,
        reviewed: false,
        approved: false,
        editedSummary: undefined,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        symbol: symbol.toUpperCase(),
        weekOf,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}

/**
 * Return a map of symbol → final approved text for the current week.
 * Only returns summaries that have been reviewed and approved by an admin.
 */
export async function getApprovedSummaries(db: any): Promise<Record<string, string>> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const docs = await db.collection('aiSummaries')
    .find({ reviewed: true, approved: true, weekOf: { $gte: sevenDaysAgo } })
    .toArray();

  const result: Record<string, string> = {};
  for (const doc of docs) {
    result[doc.symbol] = doc.editedSummary || doc.summary;
  }
  return result;
}

/**
 * Get the approved AI summary for a single symbol (for screener page display).
 * Returns null if none exists or not yet approved.
 */
export async function getApprovedSummaryForSymbol(db: any, symbol: string): Promise<string | null> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const doc = await db.collection('aiSummaries').findOne({
    symbol: symbol.toUpperCase(),
    reviewed: true,
    approved: true,
    weekOf: { $gte: sevenDaysAgo },
  });
  if (!doc) return null;
  return doc.editedSummary || doc.summary;
}

/** Weekly cost estimate in USD for Haiku at current pricing. */
export function estimateCost(inputTokens: number, outputTokens: number): number {
  // claude-haiku-4-5: $0.80/1M input, $4.00/1M output
  return (inputTokens * 0.80 + outputTokens * 4.00) / 1_000_000;
}
