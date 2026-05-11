/**
 * On Your Radar — personalized stock discovery for the Sunday Brief.
 *
 * Saturday snapshot cron:
 *   1. Loads all ticker_tags from DB.
 *   2. Fetches weekly price data for the full universe (15-concurrent batches).
 *   3. Stores a universe entry per ticker in `weekly_radar_universe` (weekKey-keyed).
 *   4. For each subscriber, runs getRadarSuggestions() and stores in `weekly_radar_suggestions`.
 *
 * Sunday send:
 *   Fetches pre-computed suggestions from `weekly_radar_suggestions` and injects
 *   the {{onYourRadar}} block into the newsletter template.
 *
 * Scoring (higher = more relevant):
 *   - Same dominant industry as a watchlist stock:   +3
 *   - Same sector (different industry):              +2
 *   - Factor overlap per shared factor:              +1
 *   - Theme overlap per shared theme:                +1
 *   - Same market_cap_tier as majority of watchlist: +0.5
 *
 * A candidate needs a minimum score of 2.0 to appear.
 * Candidates are deduplicated against the user's watchlist.
 * Up to 3 suggestions are returned (free tier: 2).
 */

import { fetchStockData } from './newsletter-data';
import { getISOWeekKey } from './macro-recap';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TickerTag = {
  ticker: string;
  name: string;
  sector: string;
  industry: string;
  factors: string[];
  themes: string[];
  market_cap_tier: 'mega' | 'large' | 'mid';
};

export type RadarCandidate = {
  ticker: string;
  name: string;
  sector: string;
  industry: string;
  relativePrice: number;       // vs SMA (e.g. -0.082 = 8.2% below)
  weeklyChange: number;        // weekly % change (e.g. -0.035)
  similarTo: string;           // watchlist ticker that drove the match
  reason: string;              // human-readable similarity reason
  score: number;
};

export type RadarUniverseEntry = {
  ticker: string;
  name: string;
  sector: string;
  industry: string;
  relativePrice: number | null;
  weeklyChange: number | null;
};

// ── Scoring ───────────────────────────────────────────────────────────────────

const MIN_SCORE = 2.0;
const MAX_SUGGESTIONS_PRO  = 3;
const MAX_SUGGESTIONS_FREE = 2;

// Moved threshold: either moved >3% in the week OR is >5% below its SMA
function hasMoved(entry: RadarUniverseEntry): boolean {
  if (entry.weeklyChange !== null && Math.abs(entry.weeklyChange) > 0.03) return true;
  if (entry.relativePrice !== null && entry.relativePrice < -0.05) return true;
  return false;
}

function scoreCandidate(
  candidate: TickerTag,
  watchlistTags: TickerTag[],
): { score: number; similarTo: string; reason: string } {
  let bestScore = 0;
  let bestSimilarTo = '';
  let bestReason = '';

  // Majority sector among watchlist (for cap-tier bonus)
  const capCounts: Record<string, number> = {};
  for (const wt of watchlistTags) capCounts[wt.market_cap_tier] = (capCounts[wt.market_cap_tier] || 0) + 1;
  const majorityTier = Object.entries(capCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  for (const wt of watchlistTags) {
    let score = 0;

    // Industry / sector match
    if (candidate.industry === wt.industry) {
      score += 3;
    } else if (candidate.sector === wt.sector) {
      score += 2;
    } else {
      // No sector overlap — this pair can't reach MIN_SCORE through factors/themes alone
      // unless there are 2+ shared factors or themes, which is still possible
    }

    // Factor overlap
    for (const f of candidate.factors) {
      if (wt.factors.includes(f)) score += 1;
    }

    // Theme overlap
    for (const th of candidate.themes) {
      if (wt.themes.includes(th)) score += 1;
    }

    // Cap tier bonus
    if (candidate.market_cap_tier === majorityTier) score += 0.5;

    if (score > bestScore) {
      bestScore = score;
      bestSimilarTo = wt.ticker;
      bestReason = buildReason(candidate, wt);
    }
  }

  return { score: bestScore, similarTo: bestSimilarTo, reason: bestReason };
}

function buildReason(candidate: TickerTag, watchlistTag: TickerTag): string {
  // Priority: industry > sector > shared themes > shared factors
  if (candidate.industry === watchlistTag.industry) {
    return `${candidate.industry} — same industry as ${watchlistTag.ticker}`;
  }
  if (candidate.sector === watchlistTag.sector) {
    // Check for a shared theme to give a more specific reason
    const sharedTheme = candidate.themes.find(t => watchlistTag.themes.includes(t));
    if (sharedTheme) {
      const label = THEME_LABELS[sharedTheme] ?? sharedTheme;
      return `${candidate.sector} / ${label} — like ${watchlistTag.ticker}`;
    }
    return `${candidate.sector} — same sector as ${watchlistTag.ticker}`;
  }
  // Cross-sector: themes drive it
  const sharedThemes = candidate.themes.filter(t => watchlistTag.themes.includes(t));
  if (sharedThemes.length) {
    const labels = sharedThemes.slice(0, 2).map(t => THEME_LABELS[t] ?? t).join(' + ');
    return `${labels} — similar to ${watchlistTag.ticker}`;
  }
  const sharedFactors = candidate.factors.filter(f => watchlistTag.factors.includes(f));
  if (sharedFactors.length) {
    const labels = sharedFactors.slice(0, 2).map(f => FACTOR_LABELS[f] ?? f).join(' + ');
    return `${labels} play — similar to ${watchlistTag.ticker}`;
  }
  return `Related to ${watchlistTag.ticker}`;
}

const THEME_LABELS: Record<string, string> = {
  AI: 'AI',
  cloud: 'Cloud',
  semiconductors: 'Semiconductors',
  consumer_tech: 'Consumer Tech',
  cybersecurity: 'Cybersecurity',
  biotech: 'Biotech',
  fintech: 'Fintech',
  clean_energy: 'Clean Energy',
  infrastructure: 'Infrastructure',
  housing: 'Housing',
  commodities: 'Commodities',
  e_commerce: 'E-Commerce',
  e_dash_commerce: 'E-Commerce',
  streaming: 'Streaming',
  enterprise_software: 'Enterprise Software',
  healthcare_it: 'Healthcare IT',
  autonomous_vehicles: 'Auto / EV',
  genomics: 'Genomics',
  defense: 'Defense',
  payments: 'Payments',
};

const FACTOR_LABELS: Record<string, string> = {
  growth: 'Growth',
  value: 'Value',
  quality: 'Quality',
  momentum: 'Momentum',
  dividend: 'Income',
  defensive: 'Defensive',
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score and rank universe entries relative to a user's watchlist tags.
 * Returns up to MAX_SUGGESTIONS candidates, excluding watchlist tickers.
 */
export function getRadarSuggestions(
  userWatchlist: string[],
  tagMap: Map<string, TickerTag>,
  universe: RadarUniverseEntry[],
  isPro: boolean,
): RadarCandidate[] {
  const watchlistSet = new Set(userWatchlist.map(t => t.toUpperCase()));
  const watchlistTags = userWatchlist
    .map(t => tagMap.get(t.toUpperCase()))
    .filter((t): t is TickerTag => !!t);

  if (!watchlistTags.length) return [];

  const limit = isPro ? MAX_SUGGESTIONS_PRO : MAX_SUGGESTIONS_FREE;
  const scored: RadarCandidate[] = [];

  for (const entry of universe) {
    if (watchlistSet.has(entry.ticker)) continue;
    if (entry.relativePrice === null || entry.weeklyChange === null) continue;
    if (!hasMoved(entry)) continue;

    const tag = tagMap.get(entry.ticker);
    if (!tag) continue;

    const { score, similarTo, reason } = scoreCandidate(tag, watchlistTags);
    if (score < MIN_SCORE) continue;

    scored.push({
      ticker: entry.ticker,
      name: entry.name,
      sector: entry.sector,
      industry: entry.industry,
      relativePrice: entry.relativePrice,
      weeklyChange: entry.weeklyChange,
      similarTo,
      reason,
      score,
    });
  }

  // Sort by score desc, then by relativePrice asc (deepest dip first)
  scored.sort((a, b) => b.score - a.score || a.relativePrice - b.relativePrice);
  return scored.slice(0, limit);
}

// ── Universe fetch ────────────────────────────────────────────────────────────

/**
 * Fetch price data for a batch of tickers (15 concurrent).
 * Skips tickers that fail silently.
 */
export async function fetchUniverseBatch(
  tickers: string[],
  db: any,
): Promise<RadarUniverseEntry[]> {
  const BATCH_SIZE = 15;
  const results: RadarUniverseEntry[] = [];

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async ticker => {
        try {
          const data = await fetchStockData(ticker, db);
          if (!data.closes || data.closes.length < 6) return null;

          const closes = data.closes;
          const smaLen = Math.min(50, closes.length);
          const smaSlice = closes.slice(-smaLen);
          const sma = smaSlice.reduce((a, b) => a + b, 0) / smaSlice.length;
          const current = closes[closes.length - 1];
          const weekAgo = closes[closes.length - 6];
          const relativePrice = (current - sma) / sma;
          const weeklyChange = (current - weekAgo) / weekAgo;

          return { ticker, relativePrice, weeklyChange };
        } catch {
          return null;
        }
      }),
    );

    for (const r of batchResults) {
      if (r) results.push(r as any);
    }
  }

  return results;
}

// ── DB persistence ────────────────────────────────────────────────────────────

export async function storeRadarUniverse(
  db: any,
  weekKey: string,
  entries: (RadarUniverseEntry & { name: string; sector: string; industry: string })[],
): Promise<void> {
  if (!entries.length) return;
  const col = db.collection('weekly_radar_universe');
  const ops = entries.map(e => ({
    updateOne: {
      filter: { weekKey, ticker: e.ticker },
      update: { $set: { ...e, weekKey, updatedAt: new Date() } },
      upsert: true,
    },
  }));
  // Run in chunks to avoid oversized bulkWrite
  const CHUNK = 200;
  for (let i = 0; i < ops.length; i += CHUNK) {
    await col.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
  }
}

export async function storeRadarSuggestions(
  db: any,
  userId: string,
  weekKey: string,
  suggestions: RadarCandidate[],
): Promise<void> {
  await db.collection('weekly_radar_suggestions').updateOne(
    { userId, weekKey },
    { $set: { userId, weekKey, suggestions, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function fetchRadarSuggestions(
  db: any,
  userId: string,
): Promise<RadarCandidate[]> {
  const weekKey = getISOWeekKey(new Date());
  try {
    const doc = await db.collection('weekly_radar_suggestions').findOne({ userId, weekKey });
    return doc?.suggestions ?? [];
  } catch {
    return [];
  }
}

export async function loadTagMap(db: any): Promise<Map<string, TickerTag>> {
  const docs = await db.collection('ticker_tags').find({}).toArray();
  const map = new Map<string, TickerTag>();
  for (const doc of docs) {
    map.set(doc.ticker.toUpperCase(), {
      ticker: doc.ticker,
      name: doc.name,
      sector: doc.sector,
      industry: doc.industry,
      factors: doc.factors || [],
      themes: doc.themes || [],
      market_cap_tier: doc.market_cap_tier,
    });
  }
  return map;
}

// ── Email block builder ───────────────────────────────────────────────────────

function getBadgeColors(diffPercent: number): { bg: string; color: string } {
  if (!Number.isFinite(diffPercent)) return { bg: '#F1F5F9', color: '#475569' };
  if (diffPercent < -15) return { bg: '#CCFBF1', color: '#0F766E' };
  if (diffPercent <  -5) return { bg: '#CCFBF1', color: '#0F766E' };
  if (diffPercent <   5) return { bg: '#F1F5F9', color: '#475569' };
  if (diffPercent <  15) return { bg: '#FEF3C7', color: '#B45309' };
  return { bg: '#FFEDD5', color: '#C2410C' };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtPct(v: number, alwaysSign = true): string {
  const sign = alwaysSign && v > 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

/**
 * Build the {{onYourRadar}} HTML block.
 * Returns '' if no suggestions.
 */
export function buildOnYourRadarBlock(candidates: RadarCandidate[], isPro: boolean): string {
  if (!candidates.length) return '';

  const baseUrl = process.env.FRONTEND_URL || 'https://dipfinder.com';
  const header = `<h2 style="margin:14px 0 4px;font-size:0.7em;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;text-align:left;">On Your Radar</h2><p style="margin:0 0 10px;padding-bottom:8px;font-size:0.78em;color:#94a3b8;border-bottom:1px solid #f1f5f9;">Stocks that might interest you based on your watchlist. SMA position uses a fixed 50-day SMA.</p>`;

  const cards = candidates.map(c => {
    const smaSign = c.relativePrice > 0 ? '+' : '';
    const smaPct = `${smaSign}${(c.relativePrice * 100).toFixed(1)}%`;
    const weekSign = c.weeklyChange > 0 ? '+' : '';
    const weekPct = `${weekSign}${(c.weeklyChange * 100).toFixed(1)}%`;
    const { bg, color } = getBadgeColors(c.relativePrice * 100);
    const href = `${baseUrl}/app?stock=${encodeURIComponent(c.ticker)}`;

    // Week-change badge style: green if up, red if down, gray if flat
    const weekColor = c.weeklyChange > 0.01 ? '#16a34a' : c.weeklyChange < -0.01 ? '#dc2626' : '#64748b';

    return `<div style="padding:12px 0;border-top:1px solid #f1f5f9;">
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
    <tr>
      <td style="vertical-align:top;padding-right:10px;">
        <a href="${href}" style="text-decoration:none;">
          <span style="font-weight:800;color:#1e293b;font-size:0.9em;">${escapeHtml(c.ticker)}</span>
          <span style="color:#64748b;font-size:0.78em;margin-left:6px;">${escapeHtml(c.name)}</span>
        </a>
        <div style="margin-top:3px;font-size:0.78em;color:#64748b;">${escapeHtml(c.reason)}</div>
      </td>
      <td style="white-space:nowrap;text-align:right;vertical-align:top;">
        <span style="background:${bg};color:${color};font-weight:700;font-size:0.78em;padding:2px 7px;border-radius:999px;display:inline-block;">${smaPct} vs SMA</span>
        <div style="margin-top:3px;font-size:0.75em;font-weight:600;color:${weekColor};text-align:right;">${weekPct} this week</div>
      </td>
    </tr>
  </table>
</div>`;
  }).join('');

  const upgradeHint = !isPro && candidates.length >= 2
    ? `<p style="margin:10px 0 0;font-size:0.75em;color:#94a3b8;text-align:right;"><a href="${baseUrl}/app" style="color:#6366f1;text-decoration:none;font-weight:600;">Upgrade to Pro</a> for more suggestions</p>`
    : '';

  return `<div style="margin-top:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:4px 16px 14px;">${header}${cards}${upgradeHint}</div>`;
}
