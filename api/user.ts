import type { VercelRequest, VercelResponse } from '@vercel/node';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { ObjectId } from 'mongodb';
import Stripe from 'stripe';
import { connectToDatabase } from './lib/mongodb';
import { sendPasswordChangeNotification, sendPasswordResetEmail, sendMagicLinkEmail, sendOnboardingEmail, sendAccountExistsEmail } from './lib/email';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID   = process.env.STRIPE_PRICE_ID   || '';
const FOUNDING_MEMBER_LIMIT = 250;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;

  if (!action) {
    return res.status(400).json({ error: 'Missing action parameter' });
  }

  try {
    switch (action) {
      case 'login':
        return await handleLogin(req, res);

      case 'register':
        return await handleRegister(req, res);

      case 'forgot-password':
        return await handleForgotPassword(req, res);

      case 'reset-password':
        return await handleResetPassword(req, res);

      case 'verify-reset-token':
        return await handleVerifyResetToken(req, res);

      case 'verify-token':
        return await handleVerifyToken(req, res);

      case 'get-profile':
      case 'profile': // Alias for backward compatibility
        return await handleGetProfile(req, res);

      case 'update-profile':
        return await handleUpdateProfile(req, res);

      case 'update-email-preferences':
        return await handleUpdateEmailPreferences(req, res);

      case 'change-password':
        return await handleChangePassword(req, res);

      case 'verify-captcha':
        return await handleVerifyCaptcha(req, res);

      case 'request-magic-link':
        return await handleRequestMagicLink(req, res);

      case 'verify-magic-link':
        return await handleVerifyMagicLink(req, res);

      case 'newsletter-subscribe':
        return await handleNewsletterSubscribe(req, res);

      case 'initial-stocks':
        return await handleInitialStocks(req, res);

      case 'set-initial-password':
        return await handleSetInitialPassword(req, res);

      case 'founding-stats':
        return await handleFoundingStats(req, res);

      case 'subscription-status':
        return await handleSubscriptionStatus(req, res);

      case 'create-checkout-session':
        return await handleCreateCheckoutSession(req, res);

      case 'create-portal-session':
        return await handleCreatePortalSession(req, res);

      case 'dismiss-founder-banner':
        return await handleDismissFounderBanner(req, res);

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Handle user login
async function handleLogin(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password, captchaToken } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (!captchaToken) {
    return res.status(400).json({ error: 'CAPTCHA verification is required' });
  }

  const isCaptchaValid = await verifyCaptcha(captchaToken);
  if (!isCaptchaValid) {
    return res.status(400).json({ error: 'CAPTCHA verification failed' });
  }

  const db = await connectToDatabase();
  const usersCollection = db.collection('users');

  const user = await usersCollection.findOne({ email: email.toLowerCase() });
  if (!user) {
    await trackFailedLoginAttempt(usersCollection, email.toLowerCase(), req);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const lockoutResult = await checkAccountLockout(user);
  if (lockoutResult.isLocked) {
    return res.status(423).json({
      error: `Account temporarily locked due to multiple failed login attempts. Try again after ${lockoutResult.unlockTime?.toLocaleTimeString() || '15 minutes'}.`,
      lockoutInfo: { isLocked: true, unlockTime: lockoutResult.unlockTime, attemptsRemaining: 0 }
    });
  }

  const isValidPassword = await bcrypt.compare(password, user.password);
  if (!isValidPassword) {
    const updatedUser = await trackFailedLoginAttempt(usersCollection, email.toLowerCase(), req, user._id);

    if (!updatedUser) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const newLockoutResult = await checkAccountLockout(updatedUser);
    if (newLockoutResult.isLocked) {
      return res.status(423).json({
        error: `Account temporarily locked due to multiple failed login attempts. Try again after ${newLockoutResult.unlockTime?.toLocaleTimeString() || '15 minutes'}.`,
        lockoutInfo: { isLocked: true, unlockTime: newLockoutResult.unlockTime, attemptsRemaining: 0 }
      });
    }

    const attemptsRemaining = Math.max(0, 5 - (updatedUser.failedLoginAttempts?.length || 0));
    const warningMessage = attemptsRemaining <= 2 && attemptsRemaining > 0
      ? ` (${attemptsRemaining} attempts remaining before account lockout)`
      : '';

    return res.status(401).json({
      error: 'Invalid credentials' + warningMessage,
      lockoutInfo: { isLocked: false, attemptsRemaining }
    });
  }

  await usersCollection.updateOne(
    { _id: new ObjectId(user._id) },
    {
      $unset: { failedLoginAttempts: 1, accountLockedUntil: 1, lockoutCount: 1 },
      $set: { lastLoginAt: new Date(), lastLoginIP: getClientIP(req) },
      $inc: { totalLoginCount: 1 }
    } as any
  );

  const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });

  return res.status(200).json({
    message: 'Login successful',
    token,
    user: { id: user._id, email: user.email, name: user.name }
  });
}

// Handle user registration
async function handleRegister(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email: rawEmail, password, name: rawName, captchaToken, termsAccepted, newsletterSubscribed, sundayBriefSubscribed: rawSundayBriefReg, watchlist: rawWatchlist, timezone: rawTimezone } = req.body;

  const email = sanitizeInput(rawEmail || '');
  const name = sanitizeInput(rawName || '');

  const validationError = validateRegistrationInputs(email, password, termsAccepted);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  if (!captchaToken) {
    return res.status(400).json({ error: 'CAPTCHA verification is required' });
  }

  const isCaptchaValid = await verifyCaptcha(captchaToken);
  if (!isCaptchaValid) {
    return res.status(400).json({ error: 'CAPTCHA verification failed' });
  }

  const db = await connectToDatabase();
  const usersCollection = db.collection('users');

  const existingUser = await usersCollection.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    // Don't reveal whether the email is registered - send a notice instead
    sendAccountExistsEmail(email.toLowerCase()).catch(() => {});
    return res.status(200).json({ message: 'If this email is not yet registered, check your inbox to complete sign-up.' });
  }

  // Use localStorage watchlist if provided; otherwise fall back to admin initial stocks
  const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
  let watchlist: string[] = Array.isArray(rawWatchlist)
    ? (rawWatchlist as any[])
        .filter((s: any) => typeof s === 'string' && TICKER_RE.test(s.toUpperCase()))
        .map((s: any) => (s as string).toUpperCase())
        .slice(0, 10)
    : [];

  const [stocksDoc, smaDoc, orientationDoc] = await Promise.all([
    watchlist.length === 0 ? db.collection('settings').findOne({ key: 'initialStocks' }) : Promise.resolve(null),
    db.collection('settings').findOne({ key: 'defaultSmaPeriod' }),
    db.collection('settings').findOne({ key: 'defaultChartOrientation' }),
  ]);
  if (watchlist.length === 0) watchlist = stocksDoc?.value ?? ['CRM', 'MSFT', 'AAPL', 'INTU'];
  const defaultSmaPeriod: number = smaDoc?.value ?? 200;
  const defaultChartOrientation: string = orientationDoc?.value ?? 'x';

  const hashedPassword = await bcrypt.hash(password, 10);

  // Validate IANA timezone string from browser
  let timezone: string | undefined;
  if (rawTimezone && typeof rawTimezone === 'string') {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: rawTimezone });
      timezone = rawTimezone;
    } catch { /* invalid timezone — omit */ }
  }

  const newUser = {
    email: email.toLowerCase(),
    password: hashedPassword,
    name: name || email.split('@')[0],
    createdDate: new Date(),
    timezone,
    termsAccepted: true,
    termsAcceptedDate: new Date(),
    newsletterSubscribed: Boolean(newsletterSubscribed),
    sundayBriefSubscribed: rawSundayBriefReg !== false,
    sundayBriefSubscribedAt: rawSundayBriefReg !== false ? new Date() : undefined,
    watchlist,
    smaPeriod: defaultSmaPeriod,
    chartOrientation: defaultChartOrientation,
  };

  const result = await usersCollection.insertOne(newUser);
  const token = jwt.sign({ userId: result.insertedId, email: newUser.email }, JWT_SECRET, { expiresIn: '24h' });

  return res.status(201).json({
    message: 'Registration successful',
    token,
    user: { id: result.insertedId, email: newUser.email, name: newUser.name }
  });
}

// Handle forgot password
async function handleForgotPassword(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, captchaToken } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  if (!captchaToken) {
    return res.status(400).json({ error: 'CAPTCHA verification is required' });
  }

  const isCaptchaValid = await verifyCaptcha(captchaToken);
  if (!isCaptchaValid) {
    return res.status(400).json({ error: 'CAPTCHA verification failed' });
  }

  const db = await connectToDatabase();
  const usersCollection = db.collection('users');

  // Run cleanup here too so stale markers don't accumulate between reset attempts
  await cleanupStaleTokenMarkers();

  const user = await usersCollection.findOne({ email: email.toLowerCase() });
  if (!user) {
    return res.status(200).json({ message: 'If the email exists, a reset link has been sent' });
  }

  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  if (user.resetTokenExpiry && new Date(user.resetTokenExpiry) > now) {
    const tokenCreatedTime = new Date(user.resetTokenExpiry.getTime() - 3600000);
    if (tokenCreatedTime > fiveMinutesAgo) {
      return res.status(200).json({ message: 'If the email exists, a reset link has been sent' });
    }
  }

  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentResetAttempts = user.passwordResetAttempts || [];
  const recentAttempts = recentResetAttempts.filter((attempt: Date) => new Date(attempt) > oneDayAgo);

  if (recentAttempts.length >= 5) {
    return res.status(429).json({ error: 'Too many password reset attempts. Please try again later.' });
  }

  const resetToken = jwt.sign(
    { userId: user._id, type: 'password-reset', timestamp: now.getTime(), email: user.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  await usersCollection.updateOne(
    { _id: new ObjectId(user._id) },
    {
      $set: { resetToken, resetTokenExpiry: new Date(Date.now() + 3600000), resetTokenCreated: now } as any,
      $push: { passwordResetAttempts: { $each: [now], $slice: -10 } } as any
    }
  );

  try {
    const emailSent = await sendPasswordResetEmail(email, resetToken);
    if (!emailSent) {
      console.warn('Failed to send password reset email to:', email);
    }
  } catch (emailError) {
    console.error('Email sending failed:', emailError);
  }

  return res.status(200).json({ message: 'If the email exists, a reset link has been sent' });
}

// Handle password reset
async function handleResetPassword(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, newPassword } = req.body;
  const requestId = `reset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as any;

    if (decoded.type !== 'password-reset') {
      throw new Error('Invalid token type');
    }

    if (!decoded.email || !decoded.timestamp || !decoded.userId) {
      throw new Error('Invalid token format');
    }

    const tokenAge = Date.now() - decoded.timestamp;
    if (tokenAge > 60 * 60 * 1000) {
      throw new Error('Token too old');
    }
  } catch (jwtError) {
    console.error(`[${requestId}] JWT validation failed:`, {
      error: jwtError instanceof Error ? jwtError.message : 'Unknown error',
      tokenLength: token?.length,
    });
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }

  const db = await connectToDatabase();
  const usersCollection = db.collection('users');
  const now = new Date();

  await cleanupStaleTokenMarkers();

  try {
    const updateId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // STEP 1: Verify token exists and is valid
    const tokenVerification = await usersCollection.findOne({
      _id: new ObjectId(decoded.userId),
      resetToken: token,
      resetTokenExpiry: { $gt: now },
      email: decoded.email.toLowerCase()
    });

    if (!tokenVerification) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // STEP 1.5: Check for concurrent processing
    if (tokenVerification.resetTokenInUse) {
      return res.status(400).json({ error: 'This reset link is already being processed. Please wait a moment and try again.' });
    }

    // STEP 1.6: Mark token as in use atomically
    const markInUse = await usersCollection.updateOne(
      {
        _id: new ObjectId(decoded.userId),
        resetToken: token,
        resetTokenExpiry: { $gt: now },
        email: decoded.email.toLowerCase(),
        resetTokenInUse: { $exists: false }
      },
      { $set: { resetTokenInUse: true, resetTokenInUseAt: now, resetTokenUpdateId: updateId } }
    );

    if (markInUse.matchedCount === 0) {
      return res.status(400).json({ error: 'This reset link is already being processed or has been used. Please request a new password reset.' });
    }

    // STEP 2: Check cooldown
    if (tokenVerification.lastPasswordReset) {
      const timeSinceLastReset = now.getTime() - new Date(tokenVerification.lastPasswordReset).getTime();
      if (timeSinceLastReset < 5 * 60 * 1000) {
        await usersCollection.updateOne(
          { _id: new ObjectId(decoded.userId) },
          { $unset: { resetTokenInUse: 1, resetTokenInUseAt: 1, resetTokenUpdateId: 1 } }
        );
        const minutesRemaining = Math.ceil((5 * 60 * 1000 - timeSinceLastReset) / (60 * 1000));
        return res.status(429).json({
          error: `Password was recently changed. Please wait ${minutesRemaining} more minute${minutesRemaining !== 1 ? 's' : ''} before resetting again.`
        });
      }
    }

    // STEP 3: Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // STEP 4: Atomic update
    const result = await usersCollection.findOneAndUpdate(
      {
        _id: new ObjectId(decoded.userId),
        resetToken: token,
        resetTokenExpiry: { $gt: now },
        email: decoded.email.toLowerCase()
      },
      {
        $set: { password: hashedPassword, passwordChangedAt: now, lastPasswordReset: now, lastResetUpdateId: updateId },
        $unset: { resetToken: 1, resetTokenExpiry: 1, resetTokenCreated: 1 },
        $inc: { passwordResetCount: 1 }
      } as any,
      { returnDocument: 'before' }
    );

    // STEP 5: Verify atomic operation succeeded
    if (!result || !result.value) {
      console.error(`[${requestId}] Password reset atomic operation failed for updateId: ${updateId}`);
      await usersCollection.updateOne(
        { _id: new ObjectId(decoded.userId) },
        { $unset: { resetTokenInUse: 1, resetTokenInUseAt: 1, resetTokenUpdateId: 1 } }
      );
      return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
    }

    const user = result.value;

    // STEP 6: Clear in-use marker and verify
    const verifyUpdate = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(decoded.userId), email: decoded.email.toLowerCase(), lastResetUpdateId: updateId },
      { $unset: { resetTokenInUse: 1, resetTokenInUseAt: 1, resetTokenUpdateId: 1 } },
      { returnDocument: 'after' }
    );

    if (!verifyUpdate || !verifyUpdate.value) {
      console.error(`[${requestId}] Password reset verification failed for updateId: ${updateId}`);
      return res.status(500).json({ error: 'Password reset verification failed. Please try logging in or request a new reset.' });
    }

    try {
      await sendPasswordChangeNotification(user.email);
    } catch (emailError) {
      console.error('Failed to send password reset confirmation email:', emailError);
    }

    return res.status(200).json({ message: 'Password reset successful' });

  } catch (error) {
    console.error('Password reset critical error:', error);
    try {
      await usersCollection.updateOne(
        { _id: new ObjectId(decoded.userId) },
        { $unset: { resetTokenInUse: 1, resetTokenInUseAt: 1, resetTokenUpdateId: 1 } }
      );
    } catch (cleanupError) {
      console.error('Failed to cleanup in-use marker:', cleanupError);
    }
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
}

// Handle token verification
async function handleVerifyToken(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    const db = await connectToDatabase();
    const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    return res.status(200).json({
      valid: true,
      user: { id: user._id, email: user.email, name: user.name, isPro: !!user.isPro }
    });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token', valid: false });
  }
}

// Handle get profile
async function handleGetProfile(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    const db = await connectToDatabase();
    const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json({
      id: user._id,
      email: user.email,
      name: user.name,
      createdDate: user.createdDate,
      timezone: user.timezone || null,
      newsletterSubscribed: user.newsletterSubscribed || false,
      sundayBriefSubscribed: user.sundayBriefSubscribed || false,
      isPro:                        !!user.isPro,
      foundingMember:               !!user.foundingMember,
      foundingMemberJoinedAt:       user.foundingMemberJoinedAt || null,
      subscriptionStatus:           user.subscriptionStatus || null,
      subscriptionCurrentPeriodEnd: user.subscriptionCurrentPeriodEnd || null,
      hasStripeSubscription:        !!user.stripeSubscriptionId,
    });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Handle update profile
async function handleUpdateProfile(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const { name, currentPassword, newPassword, timezone: rawTz } = req.body;

    const db = await connectToDatabase();
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ _id: new ObjectId(decoded.userId) });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updateData: any = {};

    if (name && name !== user.name) {
      updateData.name = name;
    }

    if (rawTz && typeof rawTz === 'string') {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: rawTz });
        updateData.timezone = rawTz;
      } catch { /* invalid timezone — ignore */ }
    }

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required to change password' });
      }
      const isValidPassword = await bcrypt.compare(currentPassword, user.password);
      if (!isValidPassword) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
      updateData.password = await bcrypt.hash(newPassword, 10);
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid updates provided' });
    }

    await usersCollection.updateOne({ _id: new ObjectId(decoded.userId) }, { $set: updateData });

    return res.status(200).json({ message: 'Profile updated successfully' });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Handle change password
async function handleChangePassword(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    const db = await connectToDatabase();
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ _id: new ObjectId(decoded.userId) });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    await usersCollection.updateOne(
      { _id: new ObjectId(decoded.userId) },
      { $set: { password: hashedNewPassword, passwordChangedAt: new Date() } }
    );

    try {
      const emailSent = await sendPasswordChangeNotification(user.email);
      if (!emailSent) {
        console.warn('Failed to send password change notification to:', user.email);
      }
    } catch (emailError) {
      console.error('Failed to send password change notification:', emailError);
    }

    return res.status(200).json({ message: 'Password changed successfully', emailSent: true });
  } catch (error) {
    console.error('Change password error:', error);
    if (error instanceof Error && error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Handle update email preferences
async function handleUpdateEmailPreferences(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const { newsletterSubscribed, sundayBriefSubscribed, email: newEmail } = req.body;

    const db = await connectToDatabase();
    const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updateData: Record<string, any> = { emailPreferencesUpdatedAt: new Date() };
    if (typeof newsletterSubscribed === 'boolean') updateData.newsletterSubscribed = newsletterSubscribed;
    if (typeof sundayBriefSubscribed === 'boolean') {
      updateData.sundayBriefSubscribed = sundayBriefSubscribed;
      // Record the first-subscribe timestamp so the onboarding cron can find new subscribers
      if (sundayBriefSubscribed && !user.sundayBriefSubscribedAt) {
        updateData.sundayBriefSubscribedAt = new Date();
      }
    }

    if (newEmail && typeof newEmail === 'string') {
      const trimmedEmail = newEmail.trim().toLowerCase();
      if (!validateEmail(trimmedEmail)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      if (trimmedEmail !== user.email) {
        const existing = await db.collection('users').findOne({ email: trimmedEmail });
        if (existing) {
          return res.status(409).json({ error: 'Email already in use' });
        }
        updateData.email = trimmedEmail;
      }
    }

    await db.collection('users').updateOne({ _id: new ObjectId(decoded.userId) }, { $set: updateData });

    return res.status(200).json({
      message: 'Email preferences updated successfully',
      newsletterSubscribed: updateData.newsletterSubscribed ?? user.newsletterSubscribed ?? false,
      sundayBriefSubscribed: updateData.sundayBriefSubscribed ?? user.sundayBriefSubscribed ?? false,
      ...(updateData.email ? { email: updateData.email } : {})
    });
  } catch (error) {
    console.error('Email preferences update error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Handle captcha verification endpoint
async function handleVerifyCaptcha(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { captchaToken } = req.body;

  if (!captchaToken) {
    return res.status(400).json({ error: 'Captcha token is required' });
  }

  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Captcha service not configured' });
  }

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${secretKey}&response=${captchaToken}`,
    });

    const data = await response.json();

    if (data.success) {
      return res.status(200).json({ success: true, message: 'Captcha verified successfully' });
    } else {
      return res.status(400).json({ success: false, error: 'Captcha verification failed' });
    }
  } catch (error) {
    console.error('Captcha verification error:', error);
    return res.status(500).json({ error: 'Captcha verification service error' });
  }
}

// Handle magic link request
async function handleRequestMagicLink(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email: rawEmail, captchaToken } = req.body;
  const email = sanitizeInput(rawEmail || '').toLowerCase();

  if (!email || !validateEmail(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  if (!captchaToken) {
    return res.status(400).json({ error: 'CAPTCHA verification is required' });
  }

  const isCaptchaValid = await verifyCaptcha(captchaToken);
  if (!isCaptchaValid) {
    return res.status(400).json({ error: 'CAPTCHA verification failed' });
  }

  const db = await connectToDatabase();
  const user = await db.collection('users').findOne({ email });

  // Always respond with success — don't leak whether email exists
  if (!user) {
    return res.status(200).json({ msg: 'If that email exists, a sign-in link is on its way.' });
  }

  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';
  const token = jwt.sign({ email, purpose: 'magic-link' }, JWT_SECRET, { expiresIn: '15m' });
  const magicUrl = `${FRONTEND_URL}/app?magic=${token}`;

  await sendMagicLinkEmail(email, magicUrl);

  return res.status(200).json({ msg: 'If that email exists, a sign-in link is on its way.' });
}

// Handle magic link verification
async function handleVerifyMagicLink(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token: magicToken } = req.body;
  if (!magicToken) {
    return res.status(400).json({ error: 'Token is required' });
  }

  let decoded: any;
  try {
    decoded = jwt.verify(magicToken, JWT_SECRET) as any;
  } catch {
    return res.status(401).json({ error: 'Sign-in link is invalid or has expired. Please request a new one.' });
  }

  if (decoded.purpose !== 'magic-link') {
    return res.status(401).json({ error: 'Invalid token purpose' });
  }

  const db = await connectToDatabase();
  const user = await db.collection('users').findOne({ email: decoded.email });
  if (!user) {
    return res.status(401).json({ error: 'Account not found' });
  }

  const authToken = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });

  return res.status(200).json({
    token: authToken,
    user: { id: user._id, email: user.email, name: user.name }
  });
}

// Handle newsletter guest subscribe: create account if new, return userExists if already registered
async function handleNewsletterSubscribe(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email: rawEmail, name: rawName, watchlist } = req.body;
  const email = sanitizeInput(rawEmail || '').toLowerCase();

  if (!email || !validateEmail(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  const db = await connectToDatabase();
  const existing = await db.collection('users').findOne({ email });

  if (existing) {
    return res.status(200).json({ userExists: true });
  }

  const randomPass = randomBytes(24).toString('hex');
  const hashedPassword = await bcrypt.hash(randomPass, 10);
  const name = sanitizeInput(rawName || '') || email.split('@')[0];
  let safeWatchlist: string[] = Array.isArray(watchlist)
    ? watchlist.slice(0, 10).map((s: any) => String(s).toUpperCase().trim()).filter(Boolean)
    : [];
  const [stocksDoc, smaDoc, orientationDoc] = await Promise.all([
    safeWatchlist.length === 0 ? db.collection('settings').findOne({ key: 'initialStocks' }) : Promise.resolve(null),
    db.collection('settings').findOne({ key: 'defaultSmaPeriod' }),
    db.collection('settings').findOne({ key: 'defaultChartOrientation' }),
  ]);
  if (safeWatchlist.length === 0) safeWatchlist = stocksDoc?.value ?? ['CRM', 'MSFT', 'AAPL', 'INTU'];
  const defaultSmaPeriod: number = smaDoc?.value ?? 200;
  const defaultChartOrientation: string = orientationDoc?.value ?? 'x';

  const newUser = {
    email,
    password: hashedPassword,
    name,
    createdDate: new Date(),
    termsAccepted: true,
    termsAcceptedDate: new Date(),
    newsletterSubscribed: true,
    sundayBriefSubscribed: true,
    sundayBriefSubscribedAt: new Date(),
    watchlist: safeWatchlist,
    smaPeriod: defaultSmaPeriod,
    chartOrientation: defaultChartOrientation,
    onboardingEmailSentAt: new Date(), // prevent cron duplication
  };

  const result = await db.collection('users').insertOne(newUser);

  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dipfinder.com';
  const setupToken = jwt.sign({ email, purpose: 'set-password' }, JWT_SECRET, { expiresIn: '7d' });
  const setPasswordUrl = `${FRONTEND_URL}/reset-password.html?setup=${setupToken}`;

  await sendOnboardingEmail(email, name, { setPasswordUrl }).catch((err: any) =>
    console.error('sendOnboardingEmail failed:', err?.message)
  );

  const authToken = jwt.sign({ userId: result.insertedId, email }, JWT_SECRET, { expiresIn: '24h' });

  return res.status(201).json({
    token: authToken,
    user: { id: result.insertedId, email, name },
  });
}

// Handle set-initial-password: called from the setup link in the welcome email
async function handleSetInitialPassword(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token: setupToken, newPassword } = req.body;
  if (!setupToken || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  let decoded: any;
  try {
    decoded = jwt.verify(setupToken, JWT_SECRET) as any;
  } catch {
    return res.status(401).json({ error: 'Setup link is invalid or has expired. Please request a new one.' });
  }

  if (decoded.purpose !== 'set-password') {
    return res.status(401).json({ error: 'Invalid token purpose' });
  }

  const db = await connectToDatabase();
  const user = await db.collection('users').findOne({ email: decoded.email });
  if (!user) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await db.collection('users').updateOne(
    { email: decoded.email },
    { $set: { password: hashedPassword, passwordSetAt: new Date() } }
  );

  const authToken = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });

  return res.status(200).json({
    message: 'Password set successfully',
    token: authToken,
    user: { id: user._id, email: user.email, name: user.name },
  });
}

// Return admin-configured initial stocks (no auth required)
async function handleInitialStocks(_req: VercelRequest, res: VercelResponse) {
  const db = await connectToDatabase();
  const doc = await db.collection('settings').findOne({ key: 'initialStocks' });
  const stocks: string[] = doc?.value ?? ['CRM', 'MSFT', 'AAPL', 'INTU'];
  return res.status(200).json({ stocks });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function verifyCaptcha(captchaToken: string): Promise<boolean> {
  if (!captchaToken) return false;

  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    console.error('Turnstile secret key not configured');
    return false;
  }

  if (secretKey === '1x0000000000000000000000000000000AA') {
    return true; // test key — always passes
  }

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${secretKey}&response=${captchaToken}`,
    });
    const data = await response.json();
    return data.success === true;
  } catch (error) {
    console.error('CAPTCHA verification error:', error);
    return false;
  }
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password: string): { isValid: boolean; minLength: boolean; hasLetter: boolean; hasNumber: boolean } {
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /\d/.test(password);
  return {
    isValid: password.length >= 8 && hasLetter && hasNumber,
    minLength: password.length >= 8,
    hasLetter,
    hasNumber
  };
}

function validateRegistrationInputs(email: string, password: string, termsAccepted: boolean): string | null {
  if (!email || !password) return 'Email and password are required';

  const trimmedEmail = email.trim();
  if (!validateEmail(trimmedEmail)) return 'Please enter a valid email address';
  if (trimmedEmail.length > 254) return 'Email address is too long';

  const pw = validatePassword(password);
  if (!pw.isValid) {
    let msg = 'Password must be at least 8 characters long';
    if (!pw.hasLetter) msg += ' and contain at least one letter';
    if (!pw.hasNumber) msg += ' and contain at least one number';
    return msg;
  }
  if (password.length > 128) return 'Password is too long (maximum 128 characters)';
  if (!termsAccepted) return 'You must accept the Terms of Service and Privacy Policy to register';

  return null;
}

function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return '';
  return input.trim()
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '');
}

function getClientIP(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'] as string;
  const realIP = req.headers['x-real-ip'] as string;
  const cfIP = req.headers['cf-connecting-ip'] as string;

  if (forwarded) return forwarded.split(',')[0].trim();
  return cfIP || realIP || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

async function trackFailedLoginAttempt(
  usersCollection: any,
  email: string,
  req: VercelRequest,
  userId?: any
): Promise<any> {
  const now = new Date();
  const clientIP = getClientIP(req);

  const failedAttempt = {
    timestamp: now,
    ip: clientIP,
    userAgent: req.headers['user-agent'] || 'unknown'
  };

  if (!userId) return null;

  try {
    const result = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(userId) },
      {
        $push: { failedLoginAttempts: { $each: [failedAttempt], $slice: -10 } },
        $set: { lastFailedLoginAt: now, lastFailedLoginIP: clientIP }
      } as any,
      { returnDocument: 'after' }
    );

    if (!result || !result.value) {
      console.error(`Failed to update user ${email} with failed login attempt`);
      return { _id: userId, email, failedLoginAttempts: [failedAttempt] };
    }

    return result.value;
  } catch (error) {
    console.error(`Error tracking failed login attempt for user ${email}:`, error);
    return { _id: userId, email, failedLoginAttempts: [failedAttempt] };
  }
}

async function checkAccountLockout(user: any): Promise<{
  isLocked: boolean;
  unlockTime?: Date;
  attemptsCount: number;
}> {
  if (!user) return { isLocked: false, attemptsCount: 0 };

  const now = new Date();

  if (user.accountLockedUntil && new Date(user.accountLockedUntil) > now) {
    return { isLocked: true, unlockTime: new Date(user.accountLockedUntil), attemptsCount: user.failedLoginAttempts?.length || 0 };
  }

  // If a lockout just expired, clear the stale attempt history so the user gets a fresh
  // window. Without this, the attempts that triggered the original lockout would still
  // fall inside the 15-minute window and cause immediate re-locking.
  if (user.accountLockedUntil && new Date(user.accountLockedUntil) <= now) {
    const db = await connectToDatabase();
    await db.collection('users').updateOne(
      { _id: new ObjectId(user._id) },
      { $unset: { failedLoginAttempts: 1, accountLockedUntil: 1 } } as any
    );
    return { isLocked: false, attemptsCount: 0 };
  }

  const failedAttempts = user.failedLoginAttempts || [];
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  const recentFailedAttempts = failedAttempts.filter((a: any) => new Date(a.timestamp) > fifteenMinutesAgo);

  if (recentFailedAttempts.length >= 5) {
    let lockoutDuration = 15 * 60 * 1000;
    if (recentFailedAttempts.length >= 10) lockoutDuration = 4 * 60 * 60 * 1000;
    else if (recentFailedAttempts.length >= 8) lockoutDuration = 60 * 60 * 1000;

    const unlockTime = new Date(now.getTime() + lockoutDuration);

    const db = await connectToDatabase();
    await db.collection('users').updateOne(
      { _id: new ObjectId(user._id) },
      {
        $set: { accountLockedUntil: unlockTime, lockoutReason: `${recentFailedAttempts.length} failed login attempts` },
        $inc: { lockoutCount: 1 }
      } as any
    );

    return { isLocked: true, unlockTime, attemptsCount: recentFailedAttempts.length };
  }

  return { isLocked: false, attemptsCount: recentFailedAttempts.length };
}

// Handle reset token verification
async function handleVerifyResetToken(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required', valid: false });
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token as string, JWT_SECRET) as any;

    if (decoded.type !== 'password-reset') {
      return res.status(400).json({ error: 'Invalid token type', valid: false });
    }

    if (!decoded.email || !decoded.timestamp || !decoded.userId) {
      return res.status(400).json({ error: 'Invalid token format', valid: false });
    }

    const tokenAge = Date.now() - decoded.timestamp;
    if (tokenAge > 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Token too old', valid: false });
    }
  } catch (jwtError) {
    console.error('Token verification JWT failed:', {
      error: jwtError instanceof Error ? jwtError.message : 'Unknown error',
      tokenLength: token?.length,
    });
    return res.status(400).json({ error: 'Invalid or expired reset token', valid: false });
  }

  try {
    const db = await connectToDatabase();
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({
      _id: new ObjectId(decoded.userId),
      resetToken: token,
      resetTokenExpiry: { $gt: new Date() },
      email: decoded.email.toLowerCase()
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token', valid: false });
    }

    let canResetNow = true;
    let waitTimeMinutes = 0;

    if (user.lastPasswordReset) {
      const timeSinceLastReset = Date.now() - new Date(user.lastPasswordReset).getTime();
      if (timeSinceLastReset < 5 * 60 * 1000) {
        canResetNow = false;
        waitTimeMinutes = Math.ceil((5 * 60 * 1000 - timeSinceLastReset) / (60 * 1000));
      }
    }

    return res.status(200).json({ valid: true, message: 'Token is valid', canResetNow, waitTimeMinutes: canResetNow ? 0 : waitTimeMinutes });
  } catch (error) {
    console.error('Reset token verification error:', error);
    return res.status(500).json({ error: 'Internal server error', valid: false });
  }
}

async function cleanupStaleTokenMarkers(): Promise<void> {
  try {
    const db = await connectToDatabase();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    await db.collection('users').updateMany(
      { resetTokenInUse: true, resetTokenInUseAt: { $lt: fiveMinutesAgo } },
      { $unset: { resetTokenInUse: 1, resetTokenInUseAt: 1, resetTokenUpdateId: 1 } }
    );
  } catch (error) {
    console.error('Failed to cleanup stale token markers:', error);
  }
}

// ── Founding stats (public — no auth required) ────────────────────────────────
async function handleFoundingStats(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const db    = await connectToDatabase();
  const count = await db.collection('users').countDocuments({ foundingMember: true });

  const deadlineEnv = process.env.FOUNDING_DEADLINE;
  let daysRemaining: number | null = null;
  if (deadlineEnv) {
    const deadline = new Date(deadlineEnv);
    if (!isNaN(deadline.getTime())) {
      daysRemaining = Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / 86_400_000));
    }
  }

  return res.status(200).json({ count, limit: FOUNDING_MEMBER_LIMIT, daysRemaining });
}

// ── Subscription status (auth required) ───────────────────────────────────────
async function handleSubscriptionStatus(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const db   = await connectToDatabase();
  const user = await db.collection('users').findOne(
    { _id: new ObjectId(decoded.userId) },
    { projection: { isPro: 1, foundingMember: 1, foundingMemberJoinedAt: 1, subscriptionStatus: 1, subscriptionCurrentPeriodEnd: 1, stripeSubscriptionId: 1, founderBannerDismissedAt: 1 } }
  );
  if (!user) return res.status(404).json({ error: 'User not found' });

  return res.status(200).json({
    isPro:                        !!user.isPro,
    foundingMember:               !!user.foundingMember,
    foundingMemberJoinedAt:       user.foundingMemberJoinedAt || null,
    subscriptionStatus:           user.subscriptionStatus || null,
    subscriptionCurrentPeriodEnd: user.subscriptionCurrentPeriodEnd || null,
    hasStripeSubscription:        !!user.stripeSubscriptionId,
    founderBannerDismissedAt:     user.founderBannerDismissedAt || null,
  });
}

// ── Create Stripe Checkout Session (auth required) ────────────────────────────
async function handleCreateCheckoutSession(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
    return res.status(500).json({ error: 'Payment system not configured' });
  }

  const db   = await connectToDatabase();
  const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.foundingMember) {
    return res.status(400).json({ error: 'You are already a founding member.' });
  }

  // Enforce founding member cap
  const foundingCount = await db.collection('users').countDocuments({ foundingMember: true });
  if (foundingCount >= FOUNDING_MEMBER_LIMIT) {
    return res.status(400).json({ error: 'The founding member offer is now closed.' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-04-22.dahlia' as any });

  try {
    // Create or reuse Stripe customer
    let customerId = (user.stripeCustomerId as string | undefined) || '';
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name:  user.name || undefined,
        metadata: { userId: user._id.toString() },
      });
      customerId = customer.id;
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { stripeCustomerId: customerId } }
      );
    }

    const baseUrl = process.env.FRONTEND_URL || 'https://dipfinder.com';

    const session = await stripe.checkout.sessions.create({
      customer:         customerId,
      customer_update:  { address: 'auto' },
      mode:             'subscription',
      line_items:       [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      automatic_tax:    { enabled: true },
      success_url: `${baseUrl}/profile?upgraded=1`,
      cancel_url:  `${baseUrl}/founding`,
      metadata:    { userId: user._id.toString(), offer: 'founding_member' },
      subscription_data: {
        metadata: { userId: user._id.toString(), offer: 'founding_member' },
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err: any) {
    console.error('Stripe checkout session error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
}

// ── Create Stripe Customer Portal Session (auth required) ─────────────────────
async function handleCreatePortalSession(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Payment system not configured' });

  const db   = await connectToDatabase();
  const user = await db.collection('users').findOne(
    { _id: new ObjectId(decoded.userId) },
    { projection: { stripeCustomerId: 1 } }
  );
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.stripeCustomerId) {
    return res.status(400).json({ error: 'No Stripe account linked to this user.' });
  }

  const stripe  = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-04-22.dahlia' as any });
  const baseUrl = process.env.FRONTEND_URL || 'https://dipfinder.com';

  const portalSession = await stripe.billingPortal.sessions.create({
    customer:   user.stripeCustomerId as string,
    return_url: `${baseUrl}/profile`,
  });

  return res.status(200).json({ url: portalSession.url });
}

// ── Dismiss founder banner (auth required) ────────────────────────────────────
async function handleDismissFounderBanner(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const db = await connectToDatabase();
  await db.collection('users').updateOne(
    { _id: new ObjectId(decoded.userId) },
    { $set: { founderBannerDismissedAt: new Date() } }
  );

  return res.status(200).json({ ok: true });
}
