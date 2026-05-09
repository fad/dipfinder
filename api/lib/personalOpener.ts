export type OpenerStock = { symbol: string; relativePrice: number };

/** Stock is ≥5% below its SMA — dip territory. */
const DIP_THRESHOLD = -0.05;
/** Stock is ≥5% above its SMA — extended / "hot". */
const HOT_THRESHOLD = 0.05;

/**
 * Returns a one-line opener sentence for the Sunday Brief greeting.
 *
 * Branch precedence (applied in order):
 * 1. MIXED  — watchlist currently has BOTH dipping AND extended stocks.
 *             Describes the current split; no delta language.
 * 2. 2+ NEW — two or more stocks crossed into dip territory vs last week.
 * 3. 1 NEW  — exactly one stock crossed into dip territory.
 * 4. QUIET  — nothing notable; no new dips this week.
 *
 * "Moved into dip" means the stock was at or above DIP_THRESHOLD last week
 * and is below it now. When no previous snapshot is available the function
 * falls back to current-state language (no delta words like "moved").
 *
 * Returns '' for an empty watchlist so the caller can omit the line.
 */
export function buildOpenerSummary(
  current: OpenerStock[],
  previous: OpenerStock[] | null,
): string {
  if (current.length === 0) return '';

  const currentDips = current.filter(s => s.relativePrice < DIP_THRESHOLD);
  const currentHot  = current.filter(s => s.relativePrice > HOT_THRESHOLD);

  // 1. Mixed: both dipping and extended stocks exist in the watchlist right now
  if (currentDips.length > 0 && currentHot.length > 0) {
    return `Mixed week - ${currentDips.length} dipping, ${currentHot.length} still extended. Here's the picture.`;
  }

  if (previous !== null) {
    const prevMap = new Map(previous.map(s => [s.symbol, s.relativePrice]));

    // Stocks that crossed INTO dip territory since last week's snapshot
    const newDips = currentDips.filter(s => {
      const prevRel = prevMap.get(s.symbol);
      // "New" if the stock wasn't in last week's snapshot OR was above the threshold
      return prevRel === undefined || prevRel >= DIP_THRESHOLD;
    });

    // 2. Two or more new dips
    if (newDips.length >= 2) {
      return `${newDips.length} of your stocks moved into dip territory this week. Here's what changed and why.`;
    }

    // 3. Exactly one new dip
    if (newDips.length === 1) {
      return `${newDips[0].symbol} moved into dip territory this week. Here's what changed.`;
    }
  } else {
    // No previous snapshot available — describe current state without delta language
    if (currentDips.length >= 2) {
      return `${currentDips.length} of your stocks are in dip territory this week. Here's what to watch.`;
    }
    if (currentDips.length === 1) {
      return `${currentDips[0].symbol} is in dip territory this week. Here's what to watch.`;
    }
  }

  // 4. Quiet — nothing moved into dip territory
  return `Quiet week on your watchlist. Here's what's still moving.`;
}
