/**
 * seed-ticker-tags.js
 *
 * Seeds the `ticker_tags` MongoDB collection from data/ticker-tags-seed.json.
 * Used by the Saturday snapshot cron to score radar suggestions.
 *
 * Safe to re-run — uses upsert so existing docs are updated, not duplicated.
 *
 * Usage:
 *   MONGODB_URI=<uri> MONGODB_DB=<db> node scripts/seed-ticker-tags.js
 *
 * Or with a local .env file:
 *   node -e "require('fs').readFileSync('.env','utf8').split('\n').forEach(l=>{const[k,...v]=l.split('=');if(k)process.env[k.trim()]=v.join('=').trim()})" scripts/seed-ticker-tags.js
 */

const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB;

if (!MONGODB_URI) { console.error('Missing MONGODB_URI'); process.exit(1); }
if (!MONGODB_DB)  { console.error('Missing MONGODB_DB');  process.exit(1); }

const seedPath = path.join(__dirname, '..', 'data', 'ticker-tags-seed.json');
const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

async function run() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);
  const col = db.collection('ticker_tags');

  console.log(`\nConnected to "${MONGODB_DB}"\n`);
  console.log(`Seeding ${seedData.length} ticker tags...\n`);

  let upserted = 0, modified = 0, errors = 0;

  for (const tag of seedData) {
    try {
      const result = await col.updateOne(
        { ticker: tag.ticker },
        {
          $set: {
            ticker:          tag.ticker,
            name:            tag.name,
            sector:          tag.sector,
            industry:        tag.industry,
            factors:         tag.factors || [],
            themes:          tag.themes  || [],
            market_cap_tier: tag.market_cap_tier,
            seededAt:        new Date(),
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0) upserted++;
      else if (result.modifiedCount > 0) modified++;
    } catch (err) {
      console.error(`  ✗  ${tag.ticker}: ${err.message}`);
      errors++;
    }
  }

  console.log(`  ✓  ${upserted} inserted, ${modified} updated, ${errors} errors`);

  await client.close();
  console.log('\nDone.\n');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
