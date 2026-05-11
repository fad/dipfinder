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
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Call Claude Haiku to produce a 1-2 sentence newsletter summary.
 * Returns an empty string if no API key or no headlines.
 */
export async function generateAiSummary(
  symbol: string,
  companyName: string,
  headlines: string[],
  relativePrice: number,
  smaPeriod: number,
): Promise<string> {
  if (!ANTHROPIC_API_KEY || !headlines.length) return '';

  const position =
    relativePrice < -0.05 ? 'in dip territory (below trend)'
    : relativePrice > 0.05 ? 'above its long-term trend'
    : 'near its long-term trend';
  const pct = `${relativePrice > 0 ? '+' : ''}${(relativePrice * 100).toFixed(1)}%`;

  const prompt = `You are a concise financial newsletter writer. Given a stock's current market position and recent news headlines, write 1-2 sentences that explain what is happening. Be factual and specific to the provided headlines. Do not make buy/sell recommendations. Do not start with the stock ticker or company name.

Stock: ${symbol} (${companyName})
Current position: ${pct} vs ${smaPeriod}-day SMA (${position})
Recent headlines:
${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}

Write a 1-2 sentence summary for a Sunday investor newsletter:`;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = message.content[0];
    return block.type === 'text' ? block.text.trim() : '';
  } catch (err) {
    console.error(`generateAiSummary: failed for ${symbol}:`, err);
    return '';
  }
}

/**
 * Store (or refresh) an AI summary for a symbol+week.
 * On conflict (same symbol + weekOf) it refreshes the summary but resets
 * reviewed/approved so the admin must re-approve updated content.
 */
export async function upsertAiSummary(
  db: any,
  symbol: string,
  companyName: string,
  headlines: string[],
  summary: string,
  weekOf: Date,
): Promise<void> {
  const col = db.collection('aiSummaries');
  await col.updateOne(
    { symbol: symbol.toUpperCase(), weekOf },
    {
      $set: {
        companyName,
        summary,
        headlines,
        reviewed: false,
        approved: false,
        editedSummary: undefined,
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
 * Return a map of symbol → final approved text for the given week window.
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
