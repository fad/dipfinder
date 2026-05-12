import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTimeToSendAt, getSendQuery, shouldSkipUser } from '../api/lib/send-schedule.js';

// Helper: build a Date for a given UTC weekday+hour
// weekday: 0=Sun, 1=Mon, …, 6=Sat
function utcDate(weekday: number, hourUTC: number): Date {
  // Start from a known Sunday: 2025-05-04T00:00:00Z
  const base = new Date('2025-05-04T00:00:00Z'); // Sunday
  const offset = ((weekday - 0 + 7) % 7) * 24 * 60 * 60 * 1000;
  return new Date(base.getTime() + offset + hourUTC * 60 * 60 * 1000);
}

describe('isTimeToSendAt', () => {

  // --- UTC timezone ---
  it('sends for UTC user at Sunday 07:00 UTC', () => {
    assert.equal(isTimeToSendAt('UTC', utcDate(0, 7)), true);
  });
  it('sends for UTC user at Sunday 09:00 UTC', () => {
    assert.equal(isTimeToSendAt('UTC', utcDate(0, 9)), true);
  });
  it('does not send for UTC user at Sunday 11:00 UTC (outside window)', () => {
    assert.equal(isTimeToSendAt('UTC', utcDate(0, 11)), false);
  });
  it('does not send for UTC user at Sunday 05:00 UTC (before window)', () => {
    assert.equal(isTimeToSendAt('UTC', utcDate(0, 5)), false);
  });
  it('does not send for UTC user on Saturday', () => {
    assert.equal(isTimeToSendAt('UTC', utcDate(6, 8)), false);
  });
  it('does not send for UTC user on Monday', () => {
    assert.equal(isTimeToSendAt('UTC', utcDate(1, 8)), false);
  });

  // --- undefined timezone defaults to UTC ---
  it('defaults to UTC when timezone is undefined', () => {
    assert.equal(isTimeToSendAt(undefined, utcDate(0, 8)), true);
  });

  // --- Europe/Berlin (UTC+2 in summer / CEST) ---
  // Sunday 07:00 UTC = Sunday 09:00 CEST → in window
  it('sends for Berlin user at Sunday 07:00 UTC (09:00 local)', () => {
    assert.equal(isTimeToSendAt('Europe/Berlin', utcDate(0, 7)), true);
  });
  // Sunday 04:00 UTC = Sunday 06:00 CEST → edge of window (inclusive)
  it('sends for Berlin user at Sunday 04:00 UTC (06:00 local — window edge)', () => {
    assert.equal(isTimeToSendAt('Europe/Berlin', utcDate(0, 4)), true);
  });
  // Sunday 09:00 UTC = Sunday 11:00 CEST → outside window
  it('does not send for Berlin user at Sunday 09:00 UTC (11:00 local)', () => {
    assert.equal(isTimeToSendAt('Europe/Berlin', utcDate(0, 9)), false);
  });

  // --- America/New_York (UTC-4 in summer / EDT) ---
  // Sunday 14:00 UTC = Sunday 10:00 EDT → edge of window (inclusive)
  it('sends for New York user at Sunday 14:00 UTC (10:00 local — window edge)', () => {
    assert.equal(isTimeToSendAt('America/New_York', utcDate(0, 14)), true);
  });
  // Sunday 15:00 UTC = Sunday 11:00 EDT → outside window
  it('does not send for New York user at Sunday 15:00 UTC (11:00 local)', () => {
    assert.equal(isTimeToSendAt('America/New_York', utcDate(0, 15)), false);
  });
  // Sunday 11:00 UTC = Sunday 07:00 EDT → in window
  it('sends for New York user at Sunday 11:00 UTC (07:00 local)', () => {
    assert.equal(isTimeToSendAt('America/New_York', utcDate(0, 11)), true);
  });

  // --- Asia/Tokyo (UTC+9) ---
  // Sunday 23:00 UTC Saturday = Sunday 08:00 JST → in window
  it('sends for Tokyo user at Saturday 23:00 UTC (Sunday 08:00 JST)', () => {
    assert.equal(isTimeToSendAt('Asia/Tokyo', utcDate(6, 23)), true);
  });
  // Sunday 00:00 UTC = Sunday 09:00 JST → in window
  it('sends for Tokyo user at Sunday 00:00 UTC (Sunday 09:00 JST)', () => {
    assert.equal(isTimeToSendAt('Asia/Tokyo', utcDate(0, 0)), true);
  });
  // Sunday 02:00 UTC = Sunday 11:00 JST → outside window
  it('does not send for Tokyo user at Sunday 02:00 UTC (Sunday 11:00 JST)', () => {
    assert.equal(isTimeToSendAt('Asia/Tokyo', utcDate(0, 2)), false);
  });

  // --- Invalid timezone falls back gracefully ---
  it('falls back without throwing for an invalid timezone', () => {
    assert.doesNotThrow(() => isTimeToSendAt('Not/AReal_Zone', utcDate(0, 8)));
  });

});

describe('getSendQuery', () => {
  const adminEmail = 'admin@example.com';

  it('preview: returns query for admin email by default', () => {
    const q = getSendQuery({ isPreview: true, isCronInvocation: false, previewEmail: adminEmail, adminEmail });
    assert.deepEqual(q, { email: adminEmail });
  });

  it('preview: returns query for previewEmail when specified', () => {
    const q = getSendQuery({ isPreview: true, isCronInvocation: false, previewEmail: 'other@example.com', adminEmail });
    assert.deepEqual(q, { email: 'other@example.com' });
  });

  it('cron live send: returns all sundayBriefSubscribed users', () => {
    const q = getSendQuery({ isPreview: false, isCronInvocation: true, previewEmail: adminEmail, adminEmail });
    assert.deepEqual(q, { sundayBriefSubscribed: true });
  });

  it('admin live send (non-cron): returns admin email only', () => {
    const q = getSendQuery({ isPreview: false, isCronInvocation: false, previewEmail: adminEmail, adminEmail });
    assert.deepEqual(q, { email: adminEmail });
  });
});

describe('shouldSkipUser', () => {
  const sundayAt8UTC = utcDate(0, 8);  // Sunday 08:00 UTC — in window for UTC user
  const tuesdayAt8UTC = utcDate(2, 8); // Tuesday — not in window for anyone

  it('never skips during preview', () => {
    assert.equal(shouldSkipUser({ isPreview: true, isCronInvocation: false, timezone: 'UTC', lastNewsletterSentAt: undefined, at: tuesdayAt8UTC }), false);
  });

  it('never skips during admin live send (non-cron)', () => {
    assert.equal(shouldSkipUser({ isPreview: false, isCronInvocation: false, timezone: 'UTC', lastNewsletterSentAt: undefined, at: tuesdayAt8UTC }), false);
  });

  it('skips during cron when not in timezone window', () => {
    assert.equal(shouldSkipUser({ isPreview: false, isCronInvocation: true, timezone: 'UTC', lastNewsletterSentAt: undefined, at: tuesdayAt8UTC }), true);
  });

  it('sends during cron when in timezone window with no prior send', () => {
    assert.equal(shouldSkipUser({ isPreview: false, isCronInvocation: true, timezone: 'UTC', lastNewsletterSentAt: undefined, at: sundayAt8UTC }), false);
  });

  it('skips during cron when already sent within 7 days', () => {
    const sentYesterday = new Date(sundayAt8UTC.getTime() - 1 * 24 * 60 * 60 * 1000);
    assert.equal(shouldSkipUser({ isPreview: false, isCronInvocation: true, timezone: 'UTC', lastNewsletterSentAt: sentYesterday, at: sundayAt8UTC }), true);
  });

  it('sends during cron when last send was more than 7 days ago', () => {
    const sentEightDaysAgo = new Date(sundayAt8UTC.getTime() - 8 * 24 * 60 * 60 * 1000);
    assert.equal(shouldSkipUser({ isPreview: false, isCronInvocation: true, timezone: 'UTC', lastNewsletterSentAt: sentEightDaysAgo, at: sundayAt8UTC }), false);
  });
});
