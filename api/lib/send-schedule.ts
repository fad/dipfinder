/**
 * Send-gating logic for the Sunday Brief newsletter.
 * Extracted as pure functions so they can be unit-tested independently of the handler.
 */

/**
 * Returns true when the user's local time is Sunday 6-10am.
 * The wide window absorbs DST shifts and cron timing imprecision.
 * Users without a stored timezone default to UTC (Sunday 07:00 cron window).
 */
export function isTimeToSend(timezone: string | undefined): boolean {
  const tz = timezone || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '-1', 10);
    return weekday === 'Sun' && hour >= 6 && hour <= 10;
  } catch {
    const now = new Date();
    return now.getUTCDay() === 0 && now.getUTCHours() >= 7 && now.getUTCHours() <= 9;
  }
}

/**
 * Returns true when the user's local time is Sunday 6-10am for the given Date.
 * Useful for testing with a fixed reference time.
 */
export function isTimeToSendAt(timezone: string | undefined, at: Date): boolean {
  const tz = timezone || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(at);
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '-1', 10);
    return weekday === 'Sun' && hour >= 6 && hour <= 10;
  } catch {
    return at.getUTCDay() === 0 && at.getUTCHours() >= 7 && at.getUTCHours() <= 9;
  }
}

/**
 * Returns the MongoDB query to use for fetching users in a send run.
 *
 * - Preview:           target user only (admin by default, or previewEmail if specified)
 * - Cron live send:    all sundayBriefSubscribed users (timezone-filtered later)
 * - Admin live send:   admin account only (bypasses timezone check — for manual testing)
 */
export function getSendQuery(opts: {
  isPreview: boolean;
  isCronInvocation: boolean;
  previewEmail: string | undefined;
  adminEmail: string | undefined;
}): Record<string, unknown> {
  const { isPreview, isCronInvocation, previewEmail, adminEmail } = opts;
  if (isPreview) return { email: previewEmail };
  if (isCronInvocation) return { sundayBriefSubscribed: true };
  return { email: adminEmail };
}

/**
 * Returns true if this user should be skipped during a cron live send.
 * Always returns false for preview or admin-triggered sends.
 */
export function shouldSkipUser(opts: {
  isPreview: boolean;
  isCronInvocation: boolean;
  timezone: string | undefined;
  lastNewsletterSentAt: Date | undefined;
  at?: Date;
}): boolean {
  if (opts.isPreview || !opts.isCronInvocation) return false;
  const at = opts.at ?? new Date();
  if (!isTimeToSendAt(opts.timezone, at)) return true;
  if (opts.lastNewsletterSentAt) {
    const sevenDaysAgo = new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (new Date(opts.lastNewsletterSentAt) > sevenDaysAgo) return true;
  }
  return false;
}
