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

/**
 * Normalise a headline to a short key for deduplication.
 * Lowercases, strips punctuation, takes first 7 words.
 */
function headlineKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).slice(0, 7).join(' ');
}

/**
 * Deduplicate a list of news items by headline similarity (first-7-words key),
 * newest-first, returning up to maxCount unique items.
 */
export function deduplicateNewsItems(
  items: Array<{ headline: string; datetime: number }>,
  maxCount = 5,
): Array<{ headline: string; datetime: number }> {
  const seen = new Set<string>();
  const result: Array<{ headline: string; datetime: number }> = [];
  for (const item of [...items].sort((a, b) => b.datetime - a.datetime)) {
    const key = headlineKey(item.headline);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
      if (result.length >= maxCount) break;
    }
  }
  return result;
}

/** Format a Unix timestamp (seconds) as a human-readable age string. */
function headlineAge(datetimeSec: number): string {
  const ageDays = (Date.now() / 1000 - datetimeSec) / 86400;
  if (ageDays < 1) return 'today';
  if (ageDays < 2) return 'yesterday';
  return `${Math.floor(ageDays)}d ago`;
}

/** Week-over-week price change (last 5 trading days). Always included — velocity matters. */
function getWeekChange(closes: number[]): string {
  if (closes.length < 6) return '';
  const change = closes[closes.length - 1] / closes[closes.length - 6] - 1;
  const pct = `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
  return `\nWeek change: ${pct}.`;
}

/** Flag when price is in the top or bottom 10% of its 52-week range. */
function getRangeContext(closes: number[]): string {
  const window = closes.slice(-252);
  if (window.length < 50) return '';
  const high = Math.max(...window);
  const low = Math.min(...window);
  const current = closes[closes.length - 1];
  const range = high - low;
  if (range === 0) return '';
  const position = (current - low) / range;
  if (position <= 0.1) return `\nNear 52-week low ($${low.toFixed(2)}).`;
  if (position >= 0.9) return `\nNear 52-week high ($${high.toFixed(2)}).`;
  return '';
}

/** Count consecutive down days (close < prior close) from the most recent session. */
function getRedDaysContext(closes: number[]): string {
  if (closes.length < 4) return '';
  let streak = 0;
  for (let i = closes.length - 1; i > 0 && streak < 10; i--) {
    if (closes[i] < closes[i - 1]) streak++;
    else break;
  }
  if (streak < 3) return '';
  return `\n${streak} consecutive down days.`;
}

/**
 * Trim Claude's output to at most `max` sentences.
 * Splits on punctuation followed by a space and an uppercase letter to avoid
 * breaking on decimal numbers or common abbreviations mid-sentence.
 */
function enforceMaxSentences(text: string, max = 2): string {
  const parts = text.split(/(?<=[.!?]) +(?=[A-Z])/);
  if (parts.length <= max) return text.trim();
  return parts.slice(0, max).join(' ').trim();
}

/**
 * Return false if fewer than min(2, headlines.length) headlines mention the
 * ticker or a key word from the company name. Catches market-roundup articles
 * that reference the stock in passing rather than covering it directly.
 */
function hasEnoughRelevantHeadlines(symbol: string, companyName: string, headlines: string[]): boolean {
  if (!headlines.length) return false;
  const needle = symbol.toLowerCase();
  const firstName = companyName.split(/[\s,()/]+/)[0]?.toLowerCase() ?? '';
  const nameWord = firstName.length >= 4 ? firstName : '';
  const matches = headlines.filter(h => {
    const hl = h.toLowerCase();
    return hl.includes(needle) || (nameWord && hl.includes(nameWord));
  }).length;
  return matches >= Math.min(2, headlines.length);
}

/**
 * Detect unusual volume vs. the 20-day average.
 * Returns a one-line context string if volume is notably elevated or suppressed,
 * empty string otherwise (so it adds nothing to the prompt on normal weeks).
 */
function getVolumeContext(volumes: number[]): string {
  const nonZero = volumes.filter(v => v > 0);
  if (nonZero.length < 20) return '';
  const avg20 = nonZero.slice(-20).reduce((a, b) => a + b, 0) / 20;
  if (avg20 === 0) return '';
  const recent5avg = nonZero.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ratio = recent5avg / avg20;
  if (ratio >= 1.5) return `\nVolume: ${ratio.toFixed(1)}x 20-day average (elevated this week).`;
  if (ratio <= 0.5) return `\nVolume: ${ratio.toFixed(1)}x 20-day average (unusually quiet this week).`;
  return '';
}

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
 * Default prompt template. Variables substituted at call time:
 * {{symbol}}, {{companyName}}, {{pct}}, {{smaPeriod}}, {{position}},
 * {{weekChange}}, {{rangeContext}}, {{redDays}},
 * {{dipContext}}, {{volumeContext}}, {{macroContext}}, {{headlines}}
 *
 * Context variables start with \n when present, are empty strings otherwise,
 * so they collapse cleanly when not applicable.
 */
export const DEFAULT_NEWS_SUMMARY_PROMPT =
`You are a concise financial newsletter writer. Given a stock's current market position and recent news headlines, write 1-2 sentences that explain what is happening. Be factual and specific to the provided headlines. Only mention macro context if the broad market moved enough (e.g. >2%) to plausibly explain part of this stock's move - skip it if the market is flat or only slightly up/down. Only mention volume if it is notably elevated. Do not make buy/sell recommendations. Do not start with the stock ticker or company name.

Here are examples of the style and format I want:

---

Stock: INTU (Intuit Inc.)
Current position: -8.2% vs 200-day SMA (in dip territory)
Week change: -6.1%.
Dip duration: 14 consecutive trading days below the 200-day SMA, deepening.
Recent headlines:
1. [today] Intuit cuts full-year revenue forecast citing macro headwinds
2. [2d ago] Intuit misses Q2 estimates on weak small-business spending
3. [3d ago] CFO flags cautious outlook for tax season

Summary: Intuit cut its full-year forecast and missed Q2 estimates on weak small-business spending, triggering a two-week sell-off that continues to deepen. Management's cautious tax season commentary gave investors no near-term catalyst to reverse the trend.

---

Stock: AAPL (Apple Inc.)
Current position: +5.7% vs 200-day SMA (above its long-term trend)
Week change: +3.2%.
Near 52-week high ($237.50).
Recent headlines:
1. [today] Apple expands India manufacturing to reduce China dependency
2. [2d ago] Analysts raise price targets ahead of iPhone 17 launch
3. [4d ago] Apple services revenue hits all-time quarterly record

Summary: Apple pushed to a 52-week high after record services revenue and analyst upgrades ahead of the iPhone 17 cycle. The India manufacturing expansion adds a supply-chain resilience angle that strengthens the bull case further.

---

Stock: CRM (Salesforce Inc.)
Current position: -4.1% vs 200-day SMA (in dip territory)
Week change: -3.8%.
Market context: S&P 500 -3.2% this week, Nasdaq -4.1% this week.
Recent headlines:
1. [today] Tech stocks slide as Fed signals rates higher for longer
2. [2d ago] Salesforce maintains full-year guidance at investor day
3. [3d ago] Enterprise software spending holds steady per Gartner survey

Summary: Salesforce's dip this week mirrors the broader tech sell-off after the Fed's hawkish signal, with no company-specific bad news - it actually reaffirmed guidance at its investor day. This looks like a macro-driven pullback rather than a fundamental problem.

---

Now write a summary for:

Stock: {{symbol}} ({{companyName}})
Current position: {{pct}} vs {{smaPeriod}}-day SMA ({{position}}){{weekChange}}{{rangeContext}}{{redDays}}{{dipContext}}{{volumeContext}}{{macroContext}}
Recent headlines:
{{headlines}}

Summary:`;

/**
 * Fetch the admin-edited prompt template from the settings collection,
 * falling back to DEFAULT_NEWS_SUMMARY_PROMPT if none is saved.
 */
export async function getAiPromptTemplate(db: any): Promise<string> {
  try {
    const doc = await db.collection('settings').findOne({ key: 'ai-prompt-news-summary' });
    if (doc?.value && typeof doc.value === 'string') return doc.value;
  } catch { /* fall through */ }
  return DEFAULT_NEWS_SUMMARY_PROMPT;
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
    volumes?: number[];
    headlineDates?: number[];  // Unix timestamps (seconds), parallel to headlines[]
    macro?: MacroContext;
    promptTemplate?: string;
  },
): Promise<SummaryResult> {
  if (!ANTHROPIC_API_KEY || !headlines.length) {
    return { summary: '', inputTokens: 0, outputTokens: 0 };
  }

  // Skip Claude call if headlines aren't actually about this company
  if (!hasEnoughRelevantHeadlines(symbol, companyName, headlines)) {
    return { summary: '', inputTokens: 0, outputTokens: 0 };
  }

  const position =
    relativePrice < -0.05 ? 'in dip territory (below trend)'
    : relativePrice > 0.05 ? 'above its long-term trend'
    : 'near its long-term trend';
  const pct = `${relativePrice > 0 ? '+' : ''}${(relativePrice * 100).toFixed(1)}%`;

  // New price-action contexts (all derived from closes[])
  const weekChange = options?.closes ? getWeekChange(options.closes) : '';
  const rangeContext = options?.closes ? getRangeContext(options.closes) : '';
  const redDays = options?.closes ? getRedDaysContext(options.closes) : '';

  // Dip duration context
  let dipContext = '';
  if (options?.closes && options.closes.length >= smaPeriod) {
    const { streak, trend } = getDipContext(options.closes, smaPeriod);
    if (streak > 1) {
      const trendLabel = trend === 'deepening' ? ', deepening' : trend === 'recovering' ? ', recovering' : '';
      dipContext = `\nDip duration: ${streak} consecutive trading days below the ${smaPeriod}-day SMA${trendLabel}.`;
    }
  }

  // Volume anomaly context
  const volumeContext = options?.volumes ? getVolumeContext(options.volumes) : '';

  // Macro context — only include if at least one index moved meaningfully (>1%)
  // so Claude doesn't waste words noting a flat market
  let macroContext = '';
  if (options?.macro) {
    const parts: string[] = [];
    const MACRO_THRESHOLD = 0.01;
    if (options.macro.spyWeekly !== undefined && Math.abs(options.macro.spyWeekly) >= MACRO_THRESHOLD) {
      parts.push(`S&P 500 (SPY) ${options.macro.spyWeekly > 0 ? '+' : ''}${options.macro.spyWeekly.toFixed(1)}% this week`);
    }
    if (options.macro.qqqWeekly !== undefined && Math.abs(options.macro.qqqWeekly) >= MACRO_THRESHOLD) {
      parts.push(`Nasdaq (QQQ) ${options.macro.qqqWeekly > 0 ? '+' : ''}${options.macro.qqqWeekly.toFixed(1)}% this week`);
    }
    if (parts.length) macroContext = `\nMarket context: ${parts.join(', ')}.`;
  }

  const headlinesList = headlines.slice(0, 5).map((h, i) => {
    const age = options?.headlineDates?.[i] ? ` [${headlineAge(options.headlineDates[i])}]` : '';
    return `${i + 1}.${age} ${h}`;
  }).join('\n');
  const template = options?.promptTemplate || DEFAULT_NEWS_SUMMARY_PROMPT;
  const prompt = template
    .replace('{{symbol}}', symbol)
    .replace('{{companyName}}', companyName)
    .replace('{{pct}}', pct)
    .replace('{{smaPeriod}}', String(smaPeriod))
    .replace('{{position}}', position)
    .replace('{{weekChange}}', weekChange)
    .replace('{{rangeContext}}', rangeContext)
    .replace('{{redDays}}', redDays)
    .replace('{{dipContext}}', dipContext)
    .replace('{{volumeContext}}', volumeContext)
    .replace('{{macroContext}}', macroContext)
    .replace('{{headlines}}', headlinesList);

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = message.content[0];
    const raw = block.type === 'text' ? block.text.trim() : '';
    const summary = enforceMaxSentences(raw, 2);
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
  const docs = await db.collection('aiSummaries')
    .find({ reviewed: true, approved: true })
    .sort({ weekOf: -1 })
    .toArray();

  // Most recent approved summary per symbol (sort guarantees newest-first)
  const result: Record<string, string> = {};
  for (const doc of docs) {
    if (!result[doc.symbol]) {
      result[doc.symbol] = doc.editedSummary || doc.summary;
    }
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
