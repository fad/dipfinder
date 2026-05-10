# Feature Ideas

## High value, low complexity

**Dip alerts via email**
User sets a threshold (e.g. "alert me when AAPL drops 8%+ below SMA"). Triggers a one-off email instead of waiting for Sunday. Infrastructure already there — needs a daily cron, a threshold field on the watchlist, and a new email template.

**"Last week" delta on the dashboard**
The `weeklySnapshots` collection already exists for this. Show each stock's change in SMA distance since last week (↑2.3% / ↓1.1%) alongside the current bar. Data pipeline is built — just not surfaced in the UI.

**Watchlist notes**
A small text field per stock — "bought at $142", "watching for earnings". Stored in the watchlist document. No API changes needed beyond adding a field; the screener page is a natural place to show/edit it.

**Sort and filter on dashboard**
Currently sorted by dip %. Let users sort by price, by change since last week, or filter to "only stocks in dip" (below SMA). Pure frontend change.

---

## Medium value, medium complexity

**Per-stock SMA period**
SMA period is currently global per user. Some stocks (fast-moving tech) make more sense at 50-day; others (slow cyclicals) at 200-day. Storing per-stock overrides in the watchlist array requires a schema change and UI update but no new infrastructure.

**Sector tagging**
Finnhub's fundamentals endpoint already returns sector/industry data (already cached). Group the dashboard by sector so users can see "all my tech stocks are in dip, financials are above SMA." Display-only change.

**Price target / buy zone**
Let users annotate a stock with a target buy price. Dashboard shows how far current price is from their target, not just from SMA. Gives the SMA ranking a second axis to compare against.

**Screener comparison mode**
Plot two stocks' SMA-distance over time on the same chart. Useful for deciding which of two dipping stocks is the better entry. Requires a UI addition to the screener but uses existing data.

---

## Higher effort, higher reward

**Email digest frequency options**
Let users choose daily (market days) vs. weekly. Daily would be a lightweight "any new dips today?" email rather than the full Sunday Brief. Requires a new cron + condensed template.

**Recovery notifications**
"AAPL has recovered from -9% to -2% below SMA since last week." Inverse of the dip alert — tells users when a stock they were watching as a dip is now normalizing. Useful as a "did I miss it?" signal.

**Public watchlist / share link**
Generate a read-only shareable URL for a watchlist. No auth required to view. Good for referrals and social proof. Requires a tokenized read-only endpoint and a stripped-down view page.

**Browser push notifications**
PWA-style push for dip alerts without needing email. Requires a service worker and a push subscription store in MongoDB. Higher effort but higher engagement than email for time-sensitive dips.

---

## Quick wins

- **Drag to reorder watchlist** — users want control over order beyond SMA rank
- **"Add to watchlist" button from the screener** — currently have to go back to dashboard
- **Empty watchlist onboarding** — new users see a blank dashboard; a "suggested stocks to watch" prompt would reduce churn
