/**
 * Helpers for the self-learning tickers collection.
 *
 * The tickers collection grows automatically: every successful stock-data
 * fetch upserts the ticker + name. Every failure increments failCount.
 * At failCount >= 3 the ticker is marked inactive and drops out of autocomplete.
 */

export async function upsertTicker(db: any, ticker: string, name: string): Promise<void> {
  try {
    await db.collection('tickers').updateOne(
      { ticker: ticker.toUpperCase() },
      {
        $set: {
          ticker: ticker.toUpperCase(),
          name,
          active: true,
          failCount: 0,
          lastSeen: new Date(),
        },
      },
      { upsert: true }
    );
  } catch {
    // non-fatal — never break the main request
  }
}

export async function markTickerFailed(db: any, ticker: string): Promise<void> {
  try {
    const coll = db.collection('tickers');
    // Only penalise tickers already known (don't create garbage entries)
    const doc = await coll.findOne({ ticker: ticker.toUpperCase() });
    if (!doc) return;
    const newCount = (doc.failCount || 0) + 1;
    await coll.updateOne(
      { ticker: ticker.toUpperCase() },
      { $set: { failCount: newCount, ...(newCount >= 3 ? { active: false } : {}) } }
    );
  } catch {
    // non-fatal
  }
}

export async function getActiveTickers(db: any): Promise<Array<{ ticker: string; name: string }>> {
  const docs = await db
    .collection('tickers')
    .find({ active: true })
    .project({ ticker: 1, name: 1, _id: 0 })
    .toArray();
  return docs as Array<{ ticker: string; name: string }>;
}
