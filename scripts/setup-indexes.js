/**
 * setup-indexes.js
 *
 * Creates all MongoDB indexes and TTL expiry rules for DipFinder.
 * Safe to re-run — MongoDB ignores indexes that already exist.
 *
 * Usage:
 *   MONGODB_URI=<uri> MONGODB_DB=<db> node scripts/setup-indexes.js
 *
 * Or with a local .env file:
 *   node -e "require('fs').readFileSync('.env','utf8').split('\n').forEach(l=>{const[k,...v]=l.split('=');if(k)process.env[k.trim()]=v.join('=').trim()})" scripts/setup-indexes.js
 */

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB;

if (!MONGODB_URI) { console.error('Missing MONGODB_URI'); process.exit(1); }
if (!MONGODB_DB)  { console.error('Missing MONGODB_DB');  process.exit(1); }

// ── Index definitions ─────────────────────────────────────────────────────────

const QUERY_INDEXES = [
  // users — hit on every auth request and newsletter send
  { col: 'users',          spec: { email: 1 },                   opts: { unique: true,  name: 'users_email_unique' } },
  { col: 'users',          spec: { newsletterSubscribed: 1 },    opts: { name: 'users_newsletterSubscribed' } },
  { col: 'users',          spec: { sundayBriefSubscribed: 1 },   opts: { name: 'users_sundayBriefSubscribed' } },

  // cache collections — hit on every stock data request
  { col: 'stocks',         spec: { cacheKey: 1 },                opts: { unique: true,  name: 'stocks_cacheKey_unique' } },
  { col: 'dashboardStocks',spec: { cacheKey: 1 },                opts: { unique: true,  name: 'dashboardStocks_cacheKey_unique' } },
  { col: 'smaTimeseries',  spec: { cacheKey: 1 },                opts: { unique: true,  name: 'smaTimeseries_cacheKey_unique' } },
  { col: 'news',           spec: { cacheKey: 1 },                opts: { unique: true,  name: 'news_cacheKey_unique' } },
  { col: 'fundamentals',   spec: { cacheKey: 1 },                opts: { unique: true,  name: 'fundamentals_cacheKey_unique' } },
  { col: 'companyNames',   spec: { cacheKey: 1 },                opts: { unique: true,  name: 'companyNames_cacheKey_unique' } },

  // tickers — autocomplete lookups
  { col: 'tickers',        spec: { ticker: 1 },                  opts: { unique: true,  name: 'tickers_ticker_unique' } },
  { col: 'tickers',        spec: { active: 1 },                  opts: { name: 'tickers_active' } },

  // weekly snapshots — keyed by (userId, weekOf) for opener delta computation
  { col: 'weeklySnapshots', spec: { userId: 1, weekOf: -1 },     opts: { name: 'weeklySnapshots_userId_weekOf' } },
  { col: 'weeklySnapshots', spec: { userId: 1, weekOf: 1 },      opts: { unique: true,  name: 'weeklySnapshots_userId_weekOf_unique' } },

  // earnings calendar cache — keyed by date range, one doc per week
  { col: 'earningsCalendar', spec: { cacheKey: 1 }, opts: { unique: true, name: 'earningsCalendar_cacheKey_unique' } },

  // AI summaries — one per symbol per week, keyed for fast admin review lookups
  { col: 'aiSummaries',     spec: { symbol: 1, weekOf: 1 },      opts: { unique: true,  name: 'aiSummaries_symbol_weekOf_unique' } },
  { col: 'aiSummaries',     spec: { reviewed: 1, approved: 1, weekOf: -1 }, opts: { name: 'aiSummaries_reviewed_approved_weekOf' } },

  // macro recaps — one per ISO week, keyed for fast lookup at send time
  { col: 'weeklyMacroRecaps', spec: { weekKey: 1 },              opts: { unique: true,  name: 'weeklyMacroRecaps_weekKey_unique' } },

  // ticker tags — static tag data used for radar scoring
  { col: 'ticker_tags',        spec: { ticker: 1 },              opts: { unique: true,  name: 'ticker_tags_ticker_unique' } },

  // radar universe — weekly price snapshot for all tagged tickers
  { col: 'weekly_radar_universe', spec: { weekKey: 1, ticker: 1 }, opts: { unique: true, name: 'weekly_radar_universe_weekKey_ticker_unique' } },

  // radar suggestions — per-user, per-week recommendation list
  { col: 'weekly_radar_suggestions', spec: { userId: 1, weekKey: 1 }, opts: { unique: true, name: 'weekly_radar_suggestions_userId_weekKey_unique' } },

  // key-value stores
  { col: 'settings',       spec: { key: 1 },                     opts: { unique: true,  name: 'settings_key_unique' } },
  { col: 'emailTemplates', spec: { key: 1 },                     opts: { unique: true,  name: 'emailTemplates_key_unique' } },
];

// TTL indexes — MongoDB auto-deletes documents after expireAfterSeconds
// expireAfterSeconds is applied to the `timestamp` field (milliseconds epoch —
// MongoDB TTL requires a BSON Date, so we store timestamp as Date where TTL applies,
// but our app stores it as Date.now() ms number. For TTL to work the field must be
// a Date type. These indexes are defined here for reference; if your timestamp fields
// are stored as numbers (ms) use the health-check cron to purge instead (see CLAUDE.md).
const TTL_SECONDS = {
  stocks:          2  * 60 * 60,   //  2h
  dashboardStocks: 2  * 60 * 60,   //  2h
  smaTimeseries:   2  * 60 * 60,   //  2h
  news:            6  * 60 * 60,   //  6h
  fundamentals:    7  * 24 * 60 * 60, // 7d
  companyNames:    7  * 24 * 60 * 60, // 7d
};

async function run() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  console.log(`\nConnected to "${MONGODB_DB}"\n`);

  // ── Query indexes ───────────────────────────────────────────────────────────
  console.log('── Query indexes ───────────────────────────────────');
  for (const { col, spec, opts } of QUERY_INDEXES) {
    try {
      await db.collection(col).createIndex(spec, opts);
      console.log(`  ✓  ${col}.${opts.name}`);
    } catch (err) {
      // Code 85 = index already exists with different options (safe to skip)
      // Code 86 = index already exists with same options
      if (err.code === 85 || err.code === 86 || err.codeName === 'IndexOptionsConflict') {
        console.log(`  –  ${col}.${opts.name} (already exists)`);
      } else {
        console.error(`  ✗  ${col}.${opts.name}: ${err.message}`);
      }
    }
  }

  // ── TTL indexes ─────────────────────────────────────────────────────────────
  // timestamp fields are now stored as BSON Date (new Date()), so MongoDB TTL
  // indexes work correctly. Existing numeric-timestamp docs are harmless —
  // they expire via app-level TTL checks and are naturally replaced over time.
  console.log('\n── TTL indexes ─────────────────────────────────────');
  const TTL_INDEX_DEFS = [
    { col: 'stocks',          expireAfterSeconds: TTL_SECONDS.stocks },
    { col: 'dashboardStocks', expireAfterSeconds: TTL_SECONDS.dashboardStocks },
    { col: 'smaTimeseries',   expireAfterSeconds: TTL_SECONDS.smaTimeseries },
    { col: 'news',            expireAfterSeconds: TTL_SECONDS.news },
    { col: 'fundamentals',    expireAfterSeconds: TTL_SECONDS.fundamentals },
    { col: 'companyNames',    expireAfterSeconds: TTL_SECONDS.companyNames },
  ];
  for (const { col, expireAfterSeconds } of TTL_INDEX_DEFS) {
    try {
      await db.collection(col).createIndex({ timestamp: 1 }, { expireAfterSeconds, name: `${col}_timestamp_ttl` });
      const human = expireAfterSeconds >= 86400 ? `${expireAfterSeconds/86400}d` : `${expireAfterSeconds/3600}h`;
      console.log(`  ✓  ${col}.timestamp TTL (${human})`);
    } catch (err) {
      if (err.code === 85 || err.code === 86 || err.codeName === 'IndexOptionsConflict') {
        console.log(`  –  ${col}.timestamp TTL (already exists)`);
      } else {
        console.error(`  ✗  ${col}.timestamp TTL: ${err.message}`);
      }
    }
  }

  await client.close();
  console.log('\nDone.\n');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
