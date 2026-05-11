/**
 * Weekly macro recap — "The week in macro" newsletter section.
 *
 * Generated Saturday night by the newsletter-snapshot cron.
 * Stored in `weeklyMacroRecaps` collection, keyed by ISO week (e.g. "2026-W20").
 * Retrieved Sunday morning by newsletter-send and injected via {{weekInMacro}} placeholder.
 *
 * Three sentences:
 *   1. Mechanical: "S&P +1.2%, Nasdaq +2.1%, Russell -0.3%, 10-yr yield down 8bps to 4.21%."
 *   2. AI-generated: one sentence from Claude Haiku (temp 0.2, max_tokens 60) contextualizing the driver.
 *   3. Mechanical: "Tech led, Energy lagged."
 *
 * Fallback if anything breaks: "Markets ended the week mixed. No single driver dominated. Sector moves were muted."
 */

import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { fetchStockData } from './newsletter-data';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const FALLBACK_TEXT = 'Markets ended the week mixed. No single driver dominated. Sector moves were muted.';

const SECTOR_ETFs: Record<string, string> = {
  XLK: 'Tech',
  XLE: 'Energy',
  XLF: 'Financials',
  XLV: 'Healthcare',
  XLY: 'Consumer Discretionary',
  XLP: 'Consumer Staples',
  XLI: 'Industrials',
  XLB: 'Materials',
  XLU: 'Utilities',
  XLRE: 'Real Estate',
  XLC: 'Communication',
};

/** ISO week key, e.g. "2026-W20" (Monday-anchored per ISO 8601). */
export function getISOWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO week: set to nearest Thursday (Thu determines the year for ISO weeks)
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function fmtPct(change: number): string {
  const sign = change > 0 ? '+' : '';
  return `${sign}${(change * 100).toFixed(1)}%`;
}

type IndexData = {
  spy: number | null;
  qqq: number | null;
  iwm: number | null;
  tnxChangeBps: number | null;
  tnxLevel: number | null;
};

type SectorMove = {
  name: string;
  change: number;
};

async function fetchWeeklyChange(symbol: string, db: any): Promise<number | null> {
  try {
    const data = await fetchStockData(symbol, db);
    if (data.closes.length < 6) return null;
    return data.closes[data.closes.length - 1] / data.closes[data.closes.length - 6] - 1;
  } catch {
    return null;
  }
}

async function fetchYieldData(db: any): Promise<{ changeBps: number | null; level: number | null }> {
  try {
    const data = await fetchStockData('^TNX', db);
    if (data.closes.length < 6) return { changeBps: null, level: null };
    const current = data.closes[data.closes.length - 1];
    const prev = data.closes[data.closes.length - 6];
    // ^TNX quotes are already in percent (e.g. 4.21 = 4.21%); difference * 100 = bps
    const bps = Math.round((current - prev) * 100);
    return { changeBps: bps, level: current };
  } catch {
    return { changeBps: null, level: null };
  }
}

function buildSentence1(index: IndexData): string {
  const parts: string[] = [];
  if (index.spy !== null) parts.push(`S&P ${fmtPct(index.spy)}`);
  if (index.qqq !== null) parts.push(`Nasdaq ${fmtPct(index.qqq)}`);
  if (index.iwm !== null) parts.push(`Russell ${fmtPct(index.iwm)}`);
  if (index.tnxChangeBps !== null && index.tnxLevel !== null) {
    const dir = index.tnxChangeBps >= 0 ? 'up' : 'down';
    parts.push(`10-yr yield ${dir} ${Math.abs(index.tnxChangeBps)}bps to ${index.tnxLevel.toFixed(2)}%`);
  }
  if (!parts.length) return '';
  return parts.join(', ') + '.';
}

function buildSentence3(sectors: SectorMove[]): string {
  if (sectors.length < 2) return '';
  const sorted = [...sectors].sort((a, b) => b.change - a.change);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  return `${best.name} led, ${worst.name} lagged.`;
}

async function fetchGeneralNews(): Promise<string[]> {
  if (!FINNHUB_API_KEY) return [];
  try {
    const url = `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`;
    const response = await axios.get(url, { timeout: 8000 });
    const items: any[] = response.data || [];
    return items
      .sort((a: any, b: any) => (b.datetime || 0) - (a.datetime || 0))
      .slice(0, 5)
      .map((n: any) => (n.headline || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function generateSentence2(
  indexData: IndexData,
  sectorMoves: SectorMove[],
  headlines: string[],
): Promise<string> {
  if (!ANTHROPIC_API_KEY) return '';

  const indexLines: string[] = [];
  if (indexData.spy !== null) indexLines.push(`S&P 500: ${fmtPct(indexData.spy)}`);
  if (indexData.qqq !== null) indexLines.push(`Nasdaq: ${fmtPct(indexData.qqq)}`);
  if (indexData.iwm !== null) indexLines.push(`Russell 2000: ${fmtPct(indexData.iwm)}`);
  if (indexData.tnxChangeBps !== null && indexData.tnxLevel !== null) {
    const dir = indexData.tnxChangeBps >= 0 ? 'rose' : 'fell';
    indexLines.push(`10-yr yield ${dir} ${Math.abs(indexData.tnxChangeBps)}bps to ${indexData.tnxLevel.toFixed(2)}%`);
  }

  const sortedSectors = [...sectorMoves].sort((a, b) => b.change - a.change);
  const sectorSummary = sortedSectors.map(s => `${s.name}: ${fmtPct(s.change)}`).join(', ');
  const headlinesList = headlines.length
    ? headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : '(no headlines available)';

  const prompt = `You are writing one sentence for a brief macro market recap in a stock newsletter. Write exactly one sentence (15-25 words) explaining the main driver or theme of this week's market moves. Be specific and factual. Do not start with "Markets" or repeat information already in the mechanical sentences.

Weekly index moves: ${indexLines.join('; ')}.
Sector moves (best to worst): ${sectorSummary || '(no sector data)'}.
Top general news headlines this week:
${headlinesList}

One sentence:`;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      temperature: 0.2 as any,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = message.content[0];
    const raw = block.type === 'text' ? block.text.trim() : '';
    // Keep only the first sentence
    const match = raw.match(/^[^.!?]*[.!?]/);
    return match ? match[0].trim() : raw.trim();
  } catch (err) {
    console.error('generateSentence2: Claude call failed:', err);
    return '';
  }
}

function validateRecap(text: string): boolean {
  const words = text.trim().split(/\s+/).length;
  if (words < 20 || words > 100) return false;
  const BANNED = ['as of', 'please note', 'I cannot', "I'm sorry", 'as an AI'];
  if (BANNED.some(b => text.toLowerCase().includes(b.toLowerCase()))) return false;
  const sentenceEnds = (text.match(/[.!?]/g) || []).length;
  if (sentenceEnds < 2) return false;
  return true;
}

async function storeMacroRecap(db: any, weekKey: string, text: string, isFallback: boolean): Promise<void> {
  try {
    await db.collection('weeklyMacroRecaps').updateOne(
      { weekKey },
      { $set: { weekKey, text, isFallback, generatedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    console.error('storeMacroRecap: DB write failed:', err);
  }
}

/**
 * Generate and store the week-in-macro recap text.
 * Called from the Saturday newsletter-snapshot cron.
 * Returns the final recap text (or fallback on failure).
 */
export async function generateMacroRecap(db: any): Promise<string> {
  const weekKey = getISOWeekKey(new Date());

  // Idempotent: if already generated this week, return cached version
  try {
    const existing = await db.collection('weeklyMacroRecaps').findOne({ weekKey });
    if (existing?.text) return existing.text;
  } catch { /* fall through */ }

  try {
    // Fetch index data (parallel)
    const [spy, qqq, iwm, tnx] = await Promise.all([
      fetchWeeklyChange('SPY', db),
      fetchWeeklyChange('QQQ', db),
      fetchWeeklyChange('IWM', db),
      fetchYieldData(db),
    ]);

    const indexData: IndexData = {
      spy,
      qqq,
      iwm,
      tnxChangeBps: tnx.changeBps,
      tnxLevel: tnx.level,
    };

    // If all index fetches failed, go to fallback early
    if (spy === null && qqq === null && iwm === null) {
      await storeMacroRecap(db, weekKey, FALLBACK_TEXT, true);
      return FALLBACK_TEXT;
    }

    // Fetch sector ETFs (parallel, best-effort)
    const sectorMoves: SectorMove[] = [];
    await Promise.all(
      Object.entries(SECTOR_ETFs).map(async ([symbol, name]) => {
        const change = await fetchWeeklyChange(symbol, db);
        if (change !== null) sectorMoves.push({ name, change });
      }),
    );

    const sentence1 = buildSentence1(indexData);
    const sentence3 = buildSentence3(sectorMoves);

    // Fetch general news, then generate AI middle sentence
    const headlines = await fetchGeneralNews();
    const aiSentence = await generateSentence2(indexData, sectorMoves, headlines);

    const parts: string[] = [];
    if (sentence1) parts.push(sentence1);
    if (aiSentence) parts.push(aiSentence);
    if (sentence3) parts.push(sentence3);

    const recap = parts.join(' ');
    const final = validateRecap(recap) ? recap : FALLBACK_TEXT;
    await storeMacroRecap(db, weekKey, final, final === FALLBACK_TEXT);
    return final;
  } catch (err) {
    console.error('generateMacroRecap: failed:', err);
    await storeMacroRecap(db, weekKey, FALLBACK_TEXT, true);
    return FALLBACK_TEXT;
  }
}

/**
 * Retrieve the current week's macro recap text for the Sunday send.
 * Returns empty string if not yet generated (send falls back to hiding the section).
 */
export async function fetchCurrentWeekMacroRecap(db: any): Promise<string> {
  const weekKey = getISOWeekKey(new Date());
  try {
    const doc = await db.collection('weeklyMacroRecaps').findOne({ weekKey });
    return doc?.text ?? '';
  } catch {
    return '';
  }
}
