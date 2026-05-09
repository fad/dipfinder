/**
 * fix-cache-dupes.js
 *
 * Cleans up duplicate/null cacheKey docs that block unique index creation.
 * For each affected cache collection:
 *   1. Remove docs with null/missing cacheKey
 *   2. For duplicate cacheKeys, keep the most recent (highest timestamp), delete the rest
 *
 * Run before re-running setup-indexes.js.
 */

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB;

if (!MONGODB_URI) { console.error('Missing MONGODB_URI'); process.exit(1); }
if (!MONGODB_DB)  { console.error('Missing MONGODB_DB');  process.exit(1); }

const CACHE_COLLECTIONS = ['stocks', 'news', 'fundamentals', 'companyNames', 'dashboardStocks', 'smaTimeseries'];

async function run() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);
  console.log(`\nConnected to "${MONGODB_DB}"\n`);

  for (const name of CACHE_COLLECTIONS) {
    const col = db.collection(name);

    // 1. Remove docs with null/missing cacheKey
    const nullResult = await col.deleteMany({ cacheKey: { $in: [null, undefined, ''] } });
    if (nullResult.deletedCount > 0) {
      console.log(`  ${name}: removed ${nullResult.deletedCount} null-cacheKey doc(s)`);
    }

    // 2. Find and collapse duplicates — keep highest timestamp, delete the rest
    const dupes = await col.aggregate([
      { $group: { _id: '$cacheKey', count: { $sum: 1 }, ids: { $push: '$_id' }, maxTs: { $max: '$timestamp' } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();

    for (const dupe of dupes) {
      // Find the _id of the doc with the highest timestamp (the keeper)
      const keeper = await col.findOne({ cacheKey: dupe._id }, { sort: { timestamp: -1 }, projection: { _id: 1 } });
      const toDelete = dupe.ids.filter(id => id.toString() !== keeper._id.toString());
      await col.deleteMany({ _id: { $in: toDelete } });
      console.log(`  ${name}: collapsed ${toDelete.length} dupe(s) for cacheKey "${dupe._id}"`);
    }

    if (nullResult.deletedCount === 0 && dupes.length === 0) {
      console.log(`  ${name}: clean`);
    }
  }

  await client.close();
  console.log('\nDone. Re-run setup-indexes.js to create the failed indexes.\n');
}

run().catch(err => { console.error(err); process.exit(1); });
