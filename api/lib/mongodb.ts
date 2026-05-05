// MongoDB connection helper for Vercel serverless functions
import { MongoClient, Db } from 'mongodb';

const uri = process.env.MONGODB_URI || '';
const dbName = process.env.MONGODB_DB || '';

// Add type declarations for globalThis
declare global {
  // eslint-disable-next-line no-var
  var _mongoClient: MongoClient | undefined;
  // eslint-disable-next-line no-var
  var _mongoDb: Db | undefined;
}

// Use globalThis for serverless MongoDB connection caching
let cachedClient = globalThis._mongoClient;
let cachedDb = globalThis._mongoDb;

export async function connectToDatabase(): Promise<Db> {
  if (cachedDb) return cachedDb;
  if (!uri || !dbName) throw new Error('Missing MongoDB connection env vars');
  if (!cachedClient) {
    try {
      cachedClient = new MongoClient(uri);
      await cachedClient.connect();
      globalThis._mongoClient = cachedClient;
/*console.log('MongoDB connected successfully');*/ 
    } catch (err) {
      console.error('MongoDB connection failed:', err);
      throw err;
    }
  }
  cachedDb = cachedClient.db(dbName);
  globalThis._mongoDb = cachedDb;
  return cachedDb;
}
