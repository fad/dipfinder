/**
 * Shared cron schedule helpers.
 *
 * All three cron endpoints run hourly in vercel.json so the admin can
 * pick an arbitrary day/hour without needing a redeploy. Each handler
 * calls shouldCronRun() on the way in; manual triggers (no x-vercel-cron
 * header) always proceed regardless of schedule.
 */

export interface CronSchedule {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. Omit for daily jobs. */
  dayOfWeek?: number;
  /** UTC hour (0–23) */
  hour: number;
}

export interface CronLastRun {
  ranAt: string;   // ISO string
  result: Record<string, any>;
  manual: boolean;
}

/** Returns true when the cron job should execute its real work. */
export async function shouldCronRun(
  db: any,
  cronId: string,
  defaults: CronSchedule,
  isCronInvocation: boolean,
): Promise<boolean> {
  // Manual trigger always runs
  if (!isCronInvocation) return true;

  const doc = await db.collection('settings').findOne({ key: `cron-schedule-${cronId}` });
  const schedule: CronSchedule = doc?.value ?? defaults;

  if (schedule.enabled === false) return false;

  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentDay  = now.getUTCDay();

  if (schedule.dayOfWeek !== undefined && schedule.dayOfWeek !== currentDay) return false;
  if (schedule.hour !== currentHour) return false;

  // Deduplicate: skip if already ran in the past 60 minutes
  const lastRun = await db.collection('settings').findOne({ key: `cron-last-run-${cronId}` });
  if (lastRun?.value?.ranAt) {
    const lastAt = new Date(lastRun.value.ranAt);
    if (Date.now() - lastAt.getTime() < 60 * 60 * 1000) return false;
  }

  return true;
}

/** Records the result of a cron run to MongoDB. */
export async function recordCronRun(
  db: any,
  cronId: string,
  result: Record<string, any>,
  manual: boolean,
): Promise<void> {
  const entry: CronLastRun = { ranAt: new Date().toISOString(), result, manual };
  await db.collection('settings').updateOne(
    { key: `cron-last-run-${cronId}` },
    { $set: { key: `cron-last-run-${cronId}`, value: entry, updatedAt: new Date() } },
    { upsert: true },
  );
}
