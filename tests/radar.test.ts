import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRadarSuggestions, type TickerTag, type RadarUniverseEntry } from '../api/lib/radar.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function tag(overrides: Partial<TickerTag> & { ticker: string }): TickerTag {
  return {
    name: overrides.ticker,
    sector: 'Technology',
    industry: 'Software',
    factors: [],
    themes: [],
    market_cap_tier: 'large',
    ...overrides,
  };
}

function entry(ticker: string, overrides: Partial<RadarUniverseEntry> = {}): RadarUniverseEntry {
  return {
    ticker,
    name: ticker,
    sector: 'Technology',
    industry: 'Software',
    relativePrice: -0.08,  // 8% below SMA — qualifies as moved
    weeklyChange: -0.05,   // 5% weekly move — qualifies as moved
    ...overrides,
  };
}

function makeTagMap(tags: TickerTag[]): Map<string, TickerTag> {
  return new Map(tags.map(t => [t.ticker, t]));
}

// ── getRadarSuggestions ───────────────────────────────────────────────────────

describe('getRadarSuggestions', () => {

  // --- Basic filtering ---

  it('returns empty array when watchlist has no tag data', () => {
    const tagMap = makeTagMap([]);
    const universe = [entry('AAPL')];
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    assert.deepEqual(result, []);
  });

  it('excludes watchlist tickers from suggestions', () => {
    const watchlist = ['AAPL'];
    const tagMap = makeTagMap([tag({ ticker: 'AAPL' }), tag({ ticker: 'MSFT' })]);
    const universe = [entry('AAPL'), entry('MSFT')];
    const result = getRadarSuggestions(watchlist, tagMap, universe, true);
    assert.ok(result.every(r => r.ticker !== 'AAPL'));
  });

  it('excludes tickers with null relativePrice or weeklyChange', () => {
    const tagMap = makeTagMap([tag({ ticker: 'AAPL' }), tag({ ticker: 'MSFT' })]);
    const universe = [
      entry('MSFT', { relativePrice: null as any }),
      entry('MSFT', { weeklyChange: null as any }),
    ];
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    assert.deepEqual(result, []);
  });

  it('excludes tickers that have not moved (flat price, tiny weekly change)', () => {
    const tagMap = makeTagMap([tag({ ticker: 'AAPL' }), tag({ ticker: 'MSFT' })]);
    const universe = [entry('MSFT', { relativePrice: -0.01, weeklyChange: 0.01 })]; // below thresholds
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    assert.deepEqual(result, []);
  });

  it('excludes tickers with no tag in tagMap', () => {
    const tagMap = makeTagMap([tag({ ticker: 'AAPL' })]); // MSFT has no tag
    const universe = [entry('MSFT')];
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    assert.deepEqual(result, []);
  });

  // --- hasMoved threshold ---

  it('includes ticker when weeklyChange exceeds 3% threshold', () => {
    const tagMap = makeTagMap([tag({ ticker: 'AAPL' }), tag({ ticker: 'MSFT' })]);
    const universe = [entry('MSFT', { relativePrice: 0.0, weeklyChange: 0.04 })]; // flat SMA, 4% weekly
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    // May or may not appear depending on score, but should not be excluded by hasMoved
    // With same sector/industry, score ≥ 2 so should appear
    assert.equal(result.length, 1);
  });

  it('includes ticker when relativePrice is more than 5% below SMA', () => {
    const tagMap = makeTagMap([tag({ ticker: 'AAPL' }), tag({ ticker: 'MSFT' })]);
    const universe = [entry('MSFT', { relativePrice: -0.06, weeklyChange: 0.0 })]; // deep dip, flat week
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    assert.equal(result.length, 1);
  });

  // --- Scoring ---

  it('same industry scores higher than same sector only', () => {
    const watchlistTag = tag({ ticker: 'AAPL', sector: 'Tech', industry: 'Software' });
    const sameIndustry = tag({ ticker: 'MSFT', sector: 'Tech', industry: 'Software' });
    const sameSector   = tag({ ticker: 'GOOG', sector: 'Tech', industry: 'Search' });
    const tagMap = makeTagMap([watchlistTag, sameIndustry, sameSector]);
    const universe = [entry('MSFT'), entry('GOOG')];

    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    assert.equal(result[0].ticker, 'MSFT'); // industry match wins
    assert.ok(result[0].score > result[1].score);
  });

  it('factor overlap adds +1 per shared factor', () => {
    const watchlistTag = tag({ ticker: 'AAPL', sector: 'Tech', industry: 'Software', factors: ['growth', 'quality'] });
    const candidate    = tag({ ticker: 'MSFT', sector: 'Tech', industry: 'Software', factors: ['growth', 'quality'] });
    const tagMap = makeTagMap([watchlistTag, candidate]);
    const universe = [entry('MSFT')];
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    // industry=3, factor growth=1, factor quality=1, total=5 (plus possible cap bonus)
    assert.ok(result[0].score >= 5);
  });

  it('theme overlap adds +1 per shared theme', () => {
    const watchlistTag = tag({ ticker: 'AAPL', sector: 'Tech', industry: 'Software', themes: ['AI', 'cloud'] });
    const candidate    = tag({ ticker: 'MSFT', sector: 'Tech', industry: 'Software', themes: ['AI', 'cloud'] });
    const tagMap = makeTagMap([watchlistTag, candidate]);
    const universe = [entry('MSFT')];
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    assert.ok(result[0].score >= 5); // 3 (industry) + 2 (themes)
  });

  it('candidate below MIN_SCORE of 2.0 is excluded', () => {
    // Different sector and industry, no shared factors/themes = score 0
    const watchlistTag = tag({ ticker: 'AAPL', sector: 'Tech',   industry: 'Software' });
    const candidate    = tag({ ticker: 'XOM',  sector: 'Energy', industry: 'Oil' });
    const tagMap = makeTagMap([watchlistTag, candidate]);
    const universe = [entry('XOM', { sector: 'Energy', industry: 'Oil' })];
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    assert.deepEqual(result, []);
  });

  it('cap tier match adds +0.5 bonus', () => {
    const watchlistTag = tag({ ticker: 'AAPL', sector: 'Tech', industry: 'Hardware', market_cap_tier: 'mega' });
    const withTier    = tag({ ticker: 'MSFT', sector: 'Tech', industry: 'Hardware', market_cap_tier: 'mega' });
    const withoutTier = tag({ ticker: 'GOOG', sector: 'Tech', industry: 'Hardware', market_cap_tier: 'mid' });
    const tagMap = makeTagMap([watchlistTag, withTier, withoutTier]);
    const universe = [entry('MSFT'), entry('GOOG')];
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    const msft = result.find(r => r.ticker === 'MSFT')!;
    const goog = result.find(r => r.ticker === 'GOOG')!;
    assert.ok(msft.score > goog.score);
  });

  // --- Limits ---

  it('returns at most 2 suggestions for free users', () => {
    const watchlistTag = tag({ ticker: 'AAPL' });
    const candidates = ['B', 'C', 'D'].map(t => tag({ ticker: t }));
    const tagMap = makeTagMap([watchlistTag, ...candidates]);
    const universe = ['B', 'C', 'D'].map(t => entry(t));
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, false);
    assert.ok(result.length <= 2);
  });

  it('returns at most 3 suggestions for pro users', () => {
    const watchlistTag = tag({ ticker: 'AAPL' });
    const candidates = ['B', 'C', 'D', 'E'].map(t => tag({ ticker: t }));
    const tagMap = makeTagMap([watchlistTag, ...candidates]);
    const universe = ['B', 'C', 'D', 'E'].map(t => entry(t));
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    assert.ok(result.length <= 3);
  });

  // --- Sorting ---

  it('sorts by score descending, then by relativePrice ascending (deepest dip first)', () => {
    const watchlistTag = tag({ ticker: 'AAPL' });
    const candidateA = tag({ ticker: 'B' }); // same industry → score 3
    const candidateB = tag({ ticker: 'C' }); // same industry → score 3
    const tagMap = makeTagMap([watchlistTag, candidateA, candidateB]);
    const universe = [
      entry('B', { relativePrice: -0.05 }), // less deep
      entry('C', { relativePrice: -0.15 }), // deeper dip
    ];
    const result = getRadarSuggestions(['AAPL'], tagMap, universe, true);
    assert.equal(result[0].ticker, 'C'); // deeper dip wins tiebreak
  });

  // --- similarTo ---

  it('sets similarTo to the watchlist ticker that drove the best score', () => {
    const w1 = tag({ ticker: 'AAPL', industry: 'Software' });
    const w2 = tag({ ticker: 'TSLA', industry: 'Auto', sector: 'Consumer' });
    const candidate = tag({ ticker: 'MSFT', industry: 'Software' }); // matches AAPL
    const tagMap = makeTagMap([w1, w2, candidate]);
    const universe = [entry('MSFT')];
    const result = getRadarSuggestions(['AAPL', 'TSLA'], tagMap, universe, true);
    assert.equal(result[0].similarTo, 'AAPL');
  });

});
