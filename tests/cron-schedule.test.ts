import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchesSchedule, type CronSchedule } from '../api/lib/cron-schedule.js';

// Helper: build a Date at a specific UTC weekday + hour
// weekday: 0=Sun, 1=Mon, …, 6=Sat
function utcDate(weekday: number, hourUTC: number): Date {
  // Base: 2026-05-11T00:00:00Z — a known Monday (weekday 1)
  const base = new Date('2026-05-11T00:00:00Z');
  const dayOffset = ((weekday - 1 + 7) % 7) * 24 * 60 * 60 * 1000;
  return new Date(base.getTime() + dayOffset + hourUTC * 60 * 60 * 1000);
}

describe('matchesSchedule', () => {

  // --- Disabled schedule ---
  it('returns false when schedule is disabled', () => {
    const s: CronSchedule = { enabled: false, hour: 18 };
    assert.equal(matchesSchedule(s, utcDate(6, 18)), false);
  });

  // --- Daily schedule (no dayOfWeek) ---
  it('daily: matches when hour is correct', () => {
    const s: CronSchedule = { enabled: true, hour: 7 };
    assert.equal(matchesSchedule(s, utcDate(1, 7)), true); // Monday 07:00
  });

  it('daily: does not match when hour is wrong', () => {
    const s: CronSchedule = { enabled: true, hour: 7 };
    assert.equal(matchesSchedule(s, utcDate(1, 8)), false); // Monday 08:00
  });

  it('daily: matches on any day of the week at the right hour', () => {
    const s: CronSchedule = { enabled: true, hour: 9 };
    for (let day = 0; day <= 6; day++) {
      assert.equal(matchesSchedule(s, utcDate(day, 9)), true, `should match on weekday ${day}`);
    }
  });

  // --- Weekly schedule (with dayOfWeek) ---
  it('weekly: matches on correct day and hour', () => {
    const s: CronSchedule = { enabled: true, dayOfWeek: 6, hour: 18 }; // Saturday 18:00
    assert.equal(matchesSchedule(s, utcDate(6, 18)), true);
  });

  it('weekly: does not match on correct day but wrong hour', () => {
    const s: CronSchedule = { enabled: true, dayOfWeek: 6, hour: 18 };
    assert.equal(matchesSchedule(s, utcDate(6, 19)), false);
  });

  it('weekly: does not match on wrong day but correct hour', () => {
    const s: CronSchedule = { enabled: true, dayOfWeek: 6, hour: 18 };
    assert.equal(matchesSchedule(s, utcDate(0, 18)), false); // Sunday, not Saturday
  });

  // --- Real cron schedules from vercel.json ---
  it('snapshot cron (Saturday 18:00 UTC) fires correctly', () => {
    const s: CronSchedule = { enabled: true, dayOfWeek: 6, hour: 18 };
    assert.equal(matchesSchedule(s, utcDate(6, 18)), true);
    assert.equal(matchesSchedule(s, utcDate(0, 18)), false); // Sunday
    assert.equal(matchesSchedule(s, utcDate(6, 17)), false); // one hour early
  });

  it('ai-summaries second run (Saturday 18:15 UTC rounds to hour 18) fires at 18:00', () => {
    // Vercel cron at 18:15 UTC fires the function at 18:15 — UTCHours() = 18
    const s: CronSchedule = { enabled: true, dayOfWeek: 6, hour: 18 };
    assert.equal(matchesSchedule(s, utcDate(6, 18)), true);
  });

  it('morning report cron (daily 07:00 UTC) fires every day at 07:00', () => {
    const s: CronSchedule = { enabled: true, hour: 7 };
    assert.equal(matchesSchedule(s, utcDate(1, 7)), true);  // Monday
    assert.equal(matchesSchedule(s, utcDate(6, 7)), true);  // Saturday
    assert.equal(matchesSchedule(s, utcDate(0, 7)), true);  // Sunday
    assert.equal(matchesSchedule(s, utcDate(0, 8)), false); // Wrong hour
  });

  it('health check cron (daily 09:00 UTC) does not fire at 08:00', () => {
    const s: CronSchedule = { enabled: true, hour: 9 };
    assert.equal(matchesSchedule(s, utcDate(3, 8)), false);
    assert.equal(matchesSchedule(s, utcDate(3, 9)), true);
  });

  // --- Edge: hour 0 (midnight) ---
  it('handles midnight (hour 0) correctly', () => {
    const s: CronSchedule = { enabled: true, hour: 0 };
    assert.equal(matchesSchedule(s, utcDate(1, 0)), true);
    assert.equal(matchesSchedule(s, utcDate(1, 1)), false);
  });

});
