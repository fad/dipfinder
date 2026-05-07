import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import { connectToDatabase } from './lib/mongodb';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const token = req.query.token as string;
  if (!token) {
    return res.status(400).send('Missing token');
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return res.status(400).send('Invalid or expired unsubscribe link.');
  }

  if (decoded.purpose !== 'unsubscribe' || !decoded.email) {
    return res.status(400).send('Invalid token');
  }

  try {
    const db = await connectToDatabase();
    await db.collection('users').updateOne(
      { email: decoded.email },
      { $set: { newsletterSubscribed: false } }
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribed – Dip Finder</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; text-align: center; padding: 80px 20px; }
    h1 { color: #f8fafc; margin-bottom: 0.5rem; }
    p { color: #94a3b8; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Unsubscribed</h1>
  <p>You've been unsubscribed from the Dip Finder newsletter.</p>
  <p style="margin-top: 2rem;"><a href="https://dipfinder.com/app">Back to Dip Finder</a></p>
</body>
</html>`);
  } catch {
    return res.status(500).send('Something went wrong. Please try again.');
  }
}
