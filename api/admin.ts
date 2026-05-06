import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import { connectToDatabase } from './lib/mongodb';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.toLowerCase();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify JWT and confirm admin email
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (!ADMIN_EMAIL || decoded.email?.toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const action = req.query.action as string;

  try {
    switch (action) {
      case 'list-users':
        return await handleListUsers(req, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleListUsers(_req: VercelRequest, res: VercelResponse) {
  const db = await connectToDatabase();

  const users = await db
    .collection('users')
    .find(
      {},
      {
        projection: {
          password: 0,
          resetToken: 0,
          resetTokenExpiry: 0,
          resetTokenCreated: 0,
          resetTokenInUse: 0,
          resetTokenInUseAt: 0,
          resetTokenUpdateId: 0,
          lastResetUpdateId: 0,
          passwordResetAttempts: 0,
          failedLoginAttempts: 0,
        },
      }
    )
    .sort({ createdDate: -1 })
    .toArray();

  return res.status(200).json({ users });
}
