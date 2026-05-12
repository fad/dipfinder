import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenerSummary } from '../api/lib/personalOpener.js';

// Helpers for readable test data
const dip  = (symbol: string) => ({ symbol, relativePrice: -0.10 }); // 10% below SMA
const hot  = (symbol: string) => ({ symbol, relativePrice: +0.10 }); // 10% above SMA
const flat = (symbol: string) => ({ symbol, relativePrice:  0.00 }); // at SMA

// Just inside/outside threshold boundary values
const justDip  = (symbol: string) => ({ symbol, relativePrice: -0.051 }); // just below -5%
const justOver = (symbol: string) => ({ symbol, relativePrice: -0.049 }); // just above -5%

describe('buildOpenerSummary', () => {

  // --- Empty watchlist ---
  it('returns empty string for empty watchlist', () => {
    assert.equal(buildOpenerSummary([], null), '');
  });

  // --- Mixed week (dipping + extended) — branch 1, highest precedence ---
  it('mixed: describes split when both dipping and hot stocks exist', () => {
    const result = buildOpenerSummary([dip('AAPL'), hot('MSFT')], null);
    assert.match(result, /Mixed week/);
    assert.match(result, /1 dipping/);
    assert.match(result, /1 still extended/);
  });

  it('mixed: counts are correct with multiple in each bucket', () => {
    const result = buildOpenerSummary([dip('A'), dip('B'), hot('C'), hot('D'), hot('E')], null);
    assert.match(result, /2 dipping/);
    assert.match(result, /3 still extended/);
  });

  it('mixed: fires even when previous snapshot exists', () => {
    // Mixed should win over new-dip delta logic
    const result = buildOpenerSummary([dip('AAPL'), hot('MSFT')], [flat('AAPL'), flat('MSFT')]);
    assert.match(result, /Mixed week/);
  });

  // --- With previous snapshot: new dip detection ---
  it('2+ new dips: names count when two stocks newly crossed threshold', () => {
    const current  = [dip('AAPL'), dip('MSFT'), flat('GOOG')];
    const previous = [flat('AAPL'), flat('MSFT'), flat('GOOG')];
    const result = buildOpenerSummary(current, previous);
    assert.match(result, /2 of your stocks moved into dip territory/);
  });

  it('1 new dip: names the symbol when exactly one crossed threshold', () => {
    const current  = [dip('AAPL'), flat('MSFT')];
    const previous = [flat('AAPL'), flat('MSFT')];
    const result = buildOpenerSummary(current, previous);
    assert.match(result, /AAPL moved into dip territory/);
  });

  it('no new dips: quiet when stock was already dipping last week', () => {
    const current  = [dip('AAPL')];
    const previous = [dip('AAPL')]; // already was a dip — not new
    const result = buildOpenerSummary(current, previous);
    assert.match(result, /Quiet week/);
  });

  it('new dip: counts stock as new when absent from previous snapshot', () => {
    const current  = [dip('AAPL'), dip('TSLA')];
    const previous = [flat('AAPL')]; // TSLA not in previous — treated as new
    const result = buildOpenerSummary(current, previous);
    assert.match(result, /2 of your stocks moved into dip territory/);
  });

  it('quiet when all stocks are flat with previous snapshot', () => {
    const result = buildOpenerSummary([flat('AAPL'), flat('MSFT')], [flat('AAPL'), flat('MSFT')]);
    assert.match(result, /Quiet week/);
  });

  // --- Without previous snapshot: current-state language ---
  it('no snapshot: uses current-state language for 2+ dips', () => {
    const result = buildOpenerSummary([dip('AAPL'), dip('MSFT')], null);
    assert.match(result, /2 of your stocks are in dip territory/);
    assert.doesNotMatch(result, /moved/);
  });

  it('no snapshot: names single dipping stock without delta language', () => {
    const result = buildOpenerSummary([dip('AAPL'), flat('MSFT')], null);
    assert.match(result, /AAPL is in dip territory/);
    assert.doesNotMatch(result, /moved/);
  });

  it('no snapshot: quiet when no dips and no hot stocks', () => {
    const result = buildOpenerSummary([flat('AAPL')], null);
    assert.match(result, /Quiet week/);
  });

  // --- Threshold boundary ---
  it('stock just below -5% counts as dip', () => {
    const result = buildOpenerSummary([justDip('AAPL')], null);
    assert.match(result, /AAPL is in dip territory/);
  });

  it('stock just above -5% does not count as dip', () => {
    const result = buildOpenerSummary([justOver('AAPL')], null);
    assert.match(result, /Quiet week/);
  });

});
