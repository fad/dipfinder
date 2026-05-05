// Auth helpers: password hashing, comparison, JWT
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateJWT(payload: object): string {
  // Set expiry to 4 hours
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '4h' });
}

export function verifyJWT(token: string): any {
  return jwt.verify(token, JWT_SECRET);
}
