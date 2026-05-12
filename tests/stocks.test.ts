import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSma, calculateSmaTimeSeries } from '../api/lib/stocks.js';

describe('calculateSma', () => {

  it('returns the average of exactly `period` prices', () => {
    assert.equal(calculateSma([10, 20, 30], 3), 20);
  });

  it('uses only the most recent `period` values when array is longer', () => {
    // First 3 values (1,2,3) should be ignored; SMA = (4+5+6)/3 = 5
    assert.equal(calculateSma([1, 2, 3, 4, 5, 6], 3), 5);
  });

  it('handles period of 1 (returns last price)', () => {
    assert.equal(calculateSma([10, 99], 1), 99);
  });

  it('handles period equal to array length', () => {
    assert.equal(calculateSma([2, 4, 6, 8], 4), 5);
  });

  it('handles decimal prices', () => {
    const result = calculateSma([1.1, 2.2, 3.3], 3);
    assert.ok(Math.abs(result - 2.2) < 0.0001);
  });

  it('handles a single-element array', () => {
    assert.equal(calculateSma([42], 1), 42);
  });

});

describe('calculateSmaTimeSeries', () => {

  it('returns NaN for indices before the first full window', () => {
    const result = calculateSmaTimeSeries([1, 2, 3, 4, 5], 3);
    assert.ok(Number.isNaN(result[0]));
    assert.ok(Number.isNaN(result[1]));
  });

  it('returns correct SMA at the first complete window', () => {
    // period=3: first valid index is 2, SMA = (1+2+3)/3
    const result = calculateSmaTimeSeries([1, 2, 3, 4, 5], 3);
    assert.equal(result[2], 2);
  });

  it('slides the window correctly across the series', () => {
    const result = calculateSmaTimeSeries([1, 2, 3, 4, 5], 3);
    assert.equal(result[2], 2); // (1+2+3)/3
    assert.equal(result[3], 3); // (2+3+4)/3
    assert.equal(result[4], 4); // (3+4+5)/3
  });

  it('returns the same length array as input', () => {
    const data = [10, 20, 30, 40, 50];
    assert.equal(calculateSmaTimeSeries(data, 3).length, data.length);
  });

  it('handles period of 1 (every value equals itself)', () => {
    const data = [5, 10, 15];
    const result = calculateSmaTimeSeries(data, 1);
    assert.deepEqual(result, [5, 10, 15]);
  });

  it('handles period equal to array length (one valid value at the end)', () => {
    const result = calculateSmaTimeSeries([2, 4, 6], 3);
    assert.ok(Number.isNaN(result[0]));
    assert.ok(Number.isNaN(result[1]));
    assert.equal(result[2], 4);
  });

});
