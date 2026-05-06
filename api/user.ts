import type { VercelRequest, VercelResponse } from '@vercel/node';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from './lib/mongodb';
import { sendPasswordChangeNotification, sendPasswordResetEmail } from './lib/email';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;

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
      
      case 'debug-reset-token':
        return await handleDebugResetToken(req, res);
      
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    /*console.error(`Error in user API for action ${action}:`, error);*/
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

  // Verify CAPTCHA
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
    // SECURITY: Still track failed attempts even for non-existent users to prevent enumeration
    await trackFailedLoginAttempt(usersCollection, email.toLowerCase(), req);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // SECURITY: Check if account is locked due to too many failed attempts
  const lockoutResult = await checkAccountLockout(user);
  if (lockoutResult.isLocked) {
/*console.log(`Login attempt blocked for locked account: ${email}. Unlock time: ${lockoutResult.unlockTime}`);*/ 
    return res.status(423).json({ 
      error: `Account temporarily locked due to multiple failed login attempts. Try again after ${lockoutResult.unlockTime?.toLocaleTimeString() || '15 minutes'}.`,
      lockoutInfo: {
        isLocked: true,
        unlockTime: lockoutResult.unlockTime,
        attemptsRemaining: 0
      }
    });
  }

  const isValidPassword = await bcrypt.compare(password, user.password);
  if (!isValidPassword) {
    // SECURITY: Track failed login attempt and update lockout status
    const updatedUser = await trackFailedLoginAttempt(usersCollection, email.toLowerCase(), req, user._id);
    
    // SECURITY FIX: Handle case where trackFailedLoginAttempt might return null
    if (!updatedUser) {
      // Fallback: use original user object if tracking failed
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const newLockoutResult = await checkAccountLockout(updatedUser);
    
    if (newLockoutResult.isLocked) {
/*console.log(`Account locked after failed login attempt: ${email}`);*/ 
      return res.status(423).json({ 
        error: `Account temporarily locked due to multiple failed login attempts. Try again after ${newLockoutResult.unlockTime?.toLocaleTimeString() || '15 minutes'}.`,
        lockoutInfo: {
          isLocked: true,
          unlockTime: newLockoutResult.unlockTime,
          attemptsRemaining: 0
        }
      });
    }

    // Return remaining attempts warning if close to lockout
    const attemptsRemaining = Math.max(0, 5 - (updatedUser.failedLoginAttempts?.length || 0));
    const baseError = 'Invalid credentials';
    const warningMessage = attemptsRemaining <= 2 && attemptsRemaining > 0 
      ? ` (${attemptsRemaining} attempts remaining before account lockout)`
      : '';

    return res.status(401).json({ 
      error: baseError + warningMessage,
      lockoutInfo: {
        isLocked: false,
        attemptsRemaining: attemptsRemaining
      }
    });
  }

  // SECURITY: Successful login - clear failed attempts and update security tracking
  await usersCollection.updateOne(
    { _id: new ObjectId(user._id) },
    { 
      $unset: { 
        failedLoginAttempts: 1,
        accountLockedUntil: 1,
        lockoutCount: 1
      },
      $set: { 
        lastLoginAt: new Date(),
        lastLoginIP: getClientIP(req)
      },
      $inc: {
        totalLoginCount: 1
      }
    } as any
  );

  const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });

/*console.log(`Successful login for user: ${email} from IP: ${getClientIP(req)}`);*/ 
  return res.status(200).json({
    message: 'Login successful',
    token,
    user: {
      id: user._id,
      email: user.email,
      name: user.name
    }
  });
}

// Handle user registration
async function handleRegister(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email: rawEmail, password, name: rawName, captchaToken, termsAccepted, newsletterSubscribed } = req.body;

  // Sanitize inputs (but keep password as-is)
  const email = sanitizeInput(rawEmail || '');
  const name = sanitizeInput(rawName || '');

  // Comprehensive input validation
  const validationError = validateRegistrationInputs(email, password, termsAccepted);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  // Verify CAPTCHA
  if (!captchaToken) {
    return res.status(400).json({ error: 'CAPTCHA verification is required' });
  }

  const isCaptchaValid = await verifyCaptcha(captchaToken);
  if (!isCaptchaValid) {
    return res.status(400).json({ error: 'CAPTCHA verification failed' });
  }

  const db = await connectToDatabase();
  const usersCollection = db.collection('users');

  // Check if user already exists
  const existingUser = await usersCollection.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    return res.status(409).json({ error: 'User already exists' });
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  // Create user with terms acceptance and newsletter subscription
  const newUser = {
    email: email.toLowerCase(),
    password: hashedPassword,
    name: name || email.split('@')[0],
    createdDate: new Date(), // Use createdDate to match existing schema
    isVerified: false,
    termsAccepted: true, // Must be true to reach this point
    termsAcceptedDate: new Date(),
    newsletterSubscribed: Boolean(newsletterSubscribed)
  };

  const result = await usersCollection.insertOne(newUser);
  const token = jwt.sign({ userId: result.insertedId, email: newUser.email }, JWT_SECRET, { expiresIn: '24h' });

  return res.status(201).json({
    message: 'Registration successful',
    token,
    user: {
      id: result.insertedId,
      email: newUser.email,
      name: newUser.name
    }
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

  // Verify CAPTCHA
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
    // Don't reveal if user exists or not
    return res.status(200).json({ message: 'If the email exists, a reset link has been sent' });
  }

  // SECURITY ENHANCEMENT: Check if there's already a recent reset request
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  
  if (user.resetTokenExpiry && new Date(user.resetTokenExpiry) > now) {
    // Check if reset token was created recently (within last 5 minutes)
    const tokenCreatedTime = new Date(user.resetTokenExpiry.getTime() - 3600000); // 1 hour before expiry
    if (tokenCreatedTime > fiveMinutesAgo) {
/*console.log(`Rate limiting password reset request for ${email} - recent request exists`);*/ 
      return res.status(200).json({ message: 'If the email exists, a reset link has been sent' });
    }
  }

  // SECURITY ENHANCEMENT: Track failed reset attempts in the last 24 hours
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentResetAttempts = user.passwordResetAttempts || [];
  const recentAttempts = recentResetAttempts.filter((attempt: Date) => new Date(attempt) > oneDayAgo);
  
  if (recentAttempts.length >= 5) {
/*console.log(`Too many password reset attempts for ${email} in last 24 hours`);*/ 
    return res.status(429).json({ error: 'Too many password reset attempts. Please try again later.' });
  }

  // Generate reset token with additional entropy
  const tokenPayload = {
    userId: user._id,
    type: 'password-reset',
    timestamp: now.getTime(),
    email: user.email // Add email to token for additional verification
  };
  const resetToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '1h' });

  // Store reset token in database and update attempt tracking
  await usersCollection.updateOne(
    { _id: new ObjectId(user._id) },
    { 
      $set: { 
        resetToken,
        resetTokenExpiry: new Date(Date.now() + 3600000), // 1 hour
        resetTokenCreated: now
      } as any,
      $push: {
        passwordResetAttempts: {
          $each: [now],
          $slice: -10 // Keep only last 10 attempts
        }
      } as any
    }
  );

  // Send email (implement this based on your email service)
  try {
    const emailSent = await sendPasswordResetEmail(email, resetToken);
    if (emailSent) {
/*console.log('Password reset email sent to:', email);*/ 
    } else {
      console.warn('Failed to send password reset email to:', email);
    }
  } catch (emailError) {
    console.error('Email sending failed:', emailError);
    // Continue anyway - don't expose email service errors
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

/*console.log(`[${requestId}] Password reset attempt started:`, { tokenProvided: !!token, passwordLength: newPassword?.length });*/ 

  if (!token || !newPassword) {
/*console.log(`[${requestId}] Missing token or password`);*/ 
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  if (newPassword.length < 8) {
/*console.log(`[${requestId}] Password too short: ${newPassword.length} characters`);*/ 
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  let decoded: any;
  try {
/*console.log(`[${requestId}] Password reset JWT verification starting for token: ${token.substring(0, 20)}...`);*/ 
    decoded = jwt.verify(token, JWT_SECRET) as any;
    /*console.log(`[${requestId}] JWT verification successful. Token data:`, { 
      type: decoded.type, 
      email: decoded.email, 
      userId: decoded.userId, 
      timestamp: decoded.timestamp 
    });*/
    
    if (decoded.type !== 'password-reset') {
/*console.log(`[${requestId}] Invalid token type: ${decoded.type}`);*/ 
      throw new Error('Invalid token type');
    }

    if (!decoded.email || !decoded.timestamp || !decoded.userId) {
      /*console.log(`[${requestId}] Invalid token format. Missing fields:`, {
        hasEmail: !!decoded.email,
        hasTimestamp: !!decoded.timestamp,
        hasUserId: !!decoded.userId
      });*/
      throw new Error('Invalid token format');
    }

    const tokenAge = Date.now() - decoded.timestamp;
    const maxTokenAge = 60 * 60 * 1000; // 1 hour
/*console.log(`[${requestId}] Token age check: ${tokenAge}ms (max: ${maxTokenAge}ms)`);*/ 
    if (tokenAge > maxTokenAge) {
/*console.log(`[${requestId}] Token too old: ${tokenAge}ms > ${maxTokenAge}ms`);*/ 
      throw new Error('Token too old');
    }
    
/*console.log(`[${requestId}] JWT verification completed successfully`);*/ 
  } catch (jwtError) {
    console.error(`[${requestId}] JWT validation failed:`, {
      error: jwtError instanceof Error ? jwtError.message : 'Unknown error',
      tokenLength: token?.length,
      tokenStart: token?.substring(0, 20),
      jwtSecret: JWT_SECRET ? 'Present' : 'Missing'
    });
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }

  const db = await connectToDatabase();
  const usersCollection = db.collection('users');
  const now = new Date();

  // Cleanup any stale in-use markers before processing
  await cleanupStaleTokenMarkers();

  try {
    // Generate unique update identifier to prevent any possibility of duplicate processing
    const updateId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
/*console.log(`[${requestId}] Processing password reset with updateId: ${updateId}`);*/ 

    // STEP 1: First verify the token exists and is valid without modifying anything
/*console.log(`STEP 1: Verifying token in database for user ${decoded.userId}`);*/ 
    const tokenVerification = await usersCollection.findOne({
      _id: new ObjectId(decoded.userId),
      resetToken: token,
      resetTokenExpiry: { $gt: now },
      email: decoded.email.toLowerCase()
    });

    if (!tokenVerification) {
      /*console.log(`Token verification failed for updateId: ${updateId}`, {
        userId: decoded.userId,
        email: decoded.email,
        tokenProvided: !!token,
        now: now.toISOString()
      });*/
      
      // Additional debugging - check what's actually in the database
      const userInDb = await usersCollection.findOne({
        _id: new ObjectId(decoded.userId),
        email: decoded.email.toLowerCase()
      });
      
      if (userInDb) {
        /*console.log(`User found in DB but token mismatch:`, {
          hasResetToken: !!userInDb.resetToken,
          tokenMatches: userInDb.resetToken === token,
          tokenExpiry: userInDb.resetTokenExpiry?.toISOString(),
          isExpired: userInDb.resetTokenExpiry ? new Date(userInDb.resetTokenExpiry) <= now : 'No expiry set'
        });*/
      } else {
/*console.log(`User not found in database for ID: ${decoded.userId}, email: ${decoded.email}`);*/ 
      }
      
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }
    
/*console.log(`STEP 1 SUCCESS: Token verified in database for user ${tokenVerification.email}`);*/ 

    // STEP 1.5: Check if this token is already being processed (prevent concurrent usage)
    if (tokenVerification.resetTokenInUse) {
/*console.log(`Token already in use for updateId: ${updateId}`);*/ 
      return res.status(400).json({ error: 'This reset link is already being processed. Please wait a moment and try again.' });
    }

    // STEP 1.6: Mark token as in use to prevent concurrent processing
/*console.log(`STEP 1.6: Marking token as in use for updateId: ${updateId}`);*/ 
    const markInUse = await usersCollection.updateOne(
      {
        _id: new ObjectId(decoded.userId),
        resetToken: token,
        resetTokenExpiry: { $gt: now },
        email: decoded.email.toLowerCase(),
        resetTokenInUse: { $exists: false } // Only mark if not already marked
      },
      {
        $set: { 
          resetTokenInUse: true,
          resetTokenInUseAt: now,
          resetTokenUpdateId: updateId
        }
      }
    );

    if (markInUse.matchedCount === 0) {
/*console.log(`Failed to mark token as in use for updateId: ${updateId} - possibly already in use or token changed`);*/ 
      return res.status(400).json({ error: 'This reset link is already being processed or has been used. Please request a new password reset.' });
    }
    
/*console.log(`STEP 1.6 SUCCESS: Token marked as in use for updateId: ${updateId}`);*/ 

    // STEP 2: Check cooldown period using the original token verification data
    if (tokenVerification.lastPasswordReset) {
      const timeSinceLastReset = now.getTime() - new Date(tokenVerification.lastPasswordReset).getTime();
      if (timeSinceLastReset < 5 * 60 * 1000) {
        // Cleanup: Remove the in-use marker since we're not proceeding
        await usersCollection.updateOne(
          { _id: new ObjectId(decoded.userId) },
          { $unset: { resetTokenInUse: 1, resetTokenInUseAt: 1, resetTokenUpdateId: 1 } }
        );
        
        const minutesRemaining = Math.ceil((5 * 60 * 1000 - timeSinceLastReset) / (60 * 1000));
/*console.log(`Recent reset cooldown for updateId: ${updateId}: ${minutesRemaining} minutes remaining`);*/ 
        return res.status(429).json({ 
          error: `Password was recently changed. Please wait ${minutesRemaining} more minute${minutesRemaining !== 1 ? 's' : ''} before resetting again.` 
        });
      }
    }

    // STEP 3: Hash password BEFORE the atomic operation
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // STEP 4: Atomic operation - this MUST succeed if we reach this point
    const result = await usersCollection.findOneAndUpdate(
      { 
        _id: new ObjectId(decoded.userId),
        resetToken: token, // Exact token match
        resetTokenExpiry: { $gt: now }, // Token not expired
        email: decoded.email.toLowerCase() // Email matches
        // Note: We already checked cooldown above, so no need to check again here
      },
      { 
        $set: { 
          password: hashedPassword,
          passwordChangedAt: now,
          lastPasswordReset: now,
          lastResetUpdateId: updateId // Track this specific update
        },
        $unset: { 
          resetToken: 1, 
          resetTokenExpiry: 1,
          resetTokenCreated: 1
        },
        $inc: { 
          passwordResetCount: 1
        }
      } as any,
      { 
        returnDocument: 'before'
      }
    );

    // STEP 5: Verify the atomic operation succeeded
    if (!result || !result.value) {
      console.error(`CRITICAL: Password reset atomic operation failed for updateId: ${updateId} despite passing verification`);
      
      // Cleanup: Remove the in-use marker since the operation failed
      await usersCollection.updateOne(
        { _id: new ObjectId(decoded.userId) },
        { $unset: { resetTokenInUse: 1, resetTokenInUseAt: 1, resetTokenUpdateId: 1 } }
      );
      
      // This should never happen if our verification above was correct
      // Check if someone else used the token in the meantime
      const finalCheck = await usersCollection.findOne({
        _id: new ObjectId(decoded.userId),
        email: decoded.email.toLowerCase()
      });

      if (finalCheck && finalCheck.resetToken !== token) {
/*console.log(`Token was used by another request for updateId: ${updateId}`);*/ 
        return res.status(400).json({ error: 'This reset link has already been used. Please request a new password reset.' });
      }

      console.error(`Unknown atomic operation failure for updateId: ${updateId}`, finalCheck);
      return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
    }

    const user = result.value;
/*console.log(`[${requestId}] Password reset successful for user: ${user.email}, updateId: ${updateId}`);*/ 

    // STEP 6: Double-check that the password was actually changed and clear the in-use marker
    const verifyUpdate = await usersCollection.findOneAndUpdate(
      {
        _id: new ObjectId(decoded.userId),
        email: decoded.email.toLowerCase(),
        lastResetUpdateId: updateId
      },
      {
        $unset: { 
          resetTokenInUse: 1, 
          resetTokenInUseAt: 1, 
          resetTokenUpdateId: 1 
        }
      },
      { returnDocument: 'after' }
    );

    if (!verifyUpdate || !verifyUpdate.value) {
      console.error(`[${requestId}] CRITICAL: Password reset verification failed for updateId: ${updateId}`);
      return res.status(500).json({ error: 'Password reset verification failed. Please try logging in or request a new reset.' });
    }

/*console.log(`[${requestId}] Password reset verification successful for updateId: ${updateId}`);*/ 

    // Send confirmation email (non-blocking)
    try {
      await sendPasswordChangeNotification(user.email);
/*console.log('Password reset confirmation email sent to:', user.email);*/ 
    } catch (emailError) {
      console.error('Failed to send password reset confirmation email:', emailError);
      // Don't fail the reset if email fails
    }

    return res.status(200).json({ message: 'Password reset successful' });

  } catch (error) {
    console.error('Password reset critical error:', error);
    
    // Cleanup: Remove the in-use marker in case of any error
    try {
      const db = await connectToDatabase();
      const usersCollection = db.collection('users');
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
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ _id: new ObjectId(decoded.userId) });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    return res.status(200).json({
      valid: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    console.error('Token verification error:', error);
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
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ _id: new ObjectId(decoded.userId) });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json({
      id: user._id,
      email: user.email,
      name: user.name,
      createdDate: user.createdDate, // Use the correct field name from MongoDB
      isVerified: user.isVerified,
      newsletterSubscribed: user.newsletterSubscribed || false // Add newsletter subscription status
    });
  } catch (error) {
    console.error('Get profile error:', error);
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
    const { name, currentPassword, newPassword } = req.body;

    const db = await connectToDatabase();
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ _id: new ObjectId(decoded.userId) });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updateData: any = {};

    // Update name if provided
    if (name && name !== user.name) {
      updateData.name = name;
    }

    // Update password if provided
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

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    // Update password in database
    await usersCollection.updateOne(
      { _id: new ObjectId(decoded.userId) },
      { 
        $set: { 
          password: hashedNewPassword,
          passwordChangedAt: new Date()
        } 
      }
    );

    // Send email notification
    try {
      const emailSent = await sendPasswordChangeNotification(user.email);
      if (emailSent) {
/*console.log('Password change notification sent to:', user.email);*/ 
      } else {
        console.warn('Failed to send password change notification to:', user.email);
      }
    } catch (emailError) {
      console.error('Failed to send password change notification:', emailError);
      // Don't fail the password change if email fails
    }

    return res.status(200).json({ 
      message: 'Password changed successfully',
      emailSent: true // Always return true to avoid revealing email configuration issues
    });
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
    const { newsletterSubscribed } = req.body;

    const db = await connectToDatabase();
    const usersCollection = db.collection('users');
    
    const user = await usersCollection.findOne({ _id: new ObjectId(decoded.userId) });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update email preferences
    const updateData = {
      newsletterSubscribed: Boolean(newsletterSubscribed),
      emailPreferencesUpdatedAt: new Date()
    };

    await usersCollection.updateOne(
      { _id: new ObjectId(decoded.userId) }, 
      { $set: updateData }
    );

    return res.status(200).json({ 
      message: 'Email preferences updated successfully',
      newsletterSubscribed: updateData.newsletterSubscribed
    });
  } catch (error) {
    console.error('Email preferences update error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Handle captcha verification using Cloudflare Turnstile
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
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
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

// Utility function to verify CAPTCHA for authentication functions
async function verifyCaptcha(captchaToken: string): Promise<boolean> {
  if (!captchaToken) {
/*console.log('CAPTCHA Debug: No captcha token provided');*/ 
    return false;
  }

  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    console.error('CAPTCHA Debug: Turnstile secret key not configured. Available env vars:', Object.keys(process.env).filter(key => key.includes('CAPTCHA') || key.includes('TURNSTILE')));
    return false;
  }

  // For development with test keys, always return true
  if (secretKey === '1x0000000000000000000000000000000AA') {
/*console.log('CAPTCHA Debug: Using test key - always passes');*/ 
    return true;
  }

/*console.log('CAPTCHA Debug: Using production secret key:', secretKey.substring(0, 10) + '...');*/ 
/*console.log('CAPTCHA Debug: Received token:', captchaToken.substring(0, 20) + '...');*/ 

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `secret=${secretKey}&response=${captchaToken}`,
    });

    const data = await response.json();
/*console.log('CAPTCHA Debug: Cloudflare response:', data);*/ 
    
    return data.success === true;
  } catch (error) {
    console.error('CAPTCHA Debug: Verification error:', error);
    return false;
  }
}

// Input validation functions
function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validatePassword(password: string): { isValid: boolean; minLength: boolean; hasLetter: boolean; hasNumber: boolean } {
  // Password must be at least 8 characters long and contain at least one letter and one number
  const minLength = 8;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /\d/.test(password);
  
  return {
    isValid: password.length >= minLength && hasLetter && hasNumber,
    minLength: password.length >= minLength,
    hasLetter: hasLetter,
    hasNumber: hasNumber
  };
}

function validateRegistrationInputs(email: string, password: string, termsAccepted: boolean): string | null {
  // Check if fields are empty or null
  if (!email || !password) {
    return "Email and password are required";
  }

  // Trim and validate email
  const trimmedEmail = email.trim();
  
  // Validate email format
  if (!validateEmail(trimmedEmail)) {
    return "Please enter a valid email address";
  }
  
  // Check email length
  if (trimmedEmail.length > 254) {
    return "Email address is too long";
  }
  
  // Validate password
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.isValid) {
    let errorMessage = "Password must be at least 8 characters long";
    if (!passwordValidation.hasLetter) {
      errorMessage += " and contain at least one letter";
    }
    if (!passwordValidation.hasNumber) {
      errorMessage += " and contain at least one number";
    }
    return errorMessage;
  }
  
  // Check password length (max 128 characters for security)
  if (password.length > 128) {
    return "Password is too long (maximum 128 characters)";
  }
  
  // Validate terms acceptance
  if (!termsAccepted) {
    return "You must accept the Terms of Service and Privacy Policy to register";
  }
  
  // All validations passed
  return null;
}

// Input sanitization function
function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return '';
  return input.trim()
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, ''); // Remove event handlers
}

// SECURITY HELPER FUNCTIONS FOR BRUTE FORCE PROTECTION

/**
 * Get client IP address from request headers
 */
function getClientIP(req: VercelRequest): string {
  // Check various headers that might contain the real IP
  const forwarded = req.headers['x-forwarded-for'] as string;
  const realIP = req.headers['x-real-ip'] as string;
  const cfIP = req.headers['cf-connecting-ip'] as string; // Cloudflare
  
  if (forwarded) {
    // x-forwarded-for can contain multiple IPs, get the first one
    return forwarded.split(',')[0].trim();
  }
  
  return cfIP || realIP || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

/**
 * Track failed login attempts with progressive lockout
 */
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

  // If user doesn't exist, create a temporary tracking record
  if (!userId) {
    // For non-existent users, we still want to track attempts to prevent enumeration attacks
    // But we don't actually store this in the database for privacy reasons
/*console.log(`Failed login attempt for non-existent user: ${email} from IP: ${clientIP}`);*/ 
    return null;
  }

  try {
    // Update existing user with failed attempt
    const result = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(userId) },
      {
        $push: {
          failedLoginAttempts: {
            $each: [failedAttempt],
            $slice: -10 // Keep only last 10 failed attempts
          }
        },
        $set: {
          lastFailedLoginAt: now,
          lastFailedLoginIP: clientIP
        }
      } as any,
      { returnDocument: 'after' }
    );

/*console.log(`Failed login attempt for user: ${email} from IP: ${clientIP}. Total recent attempts: ${result.value?.failedLoginAttempts?.length || 0}`);*/ 
    
    // SECURITY FIX: Ensure we always return a valid user object
    if (!result || !result.value) {
      console.error(`Failed to update user ${email} with failed login attempt - user not found`);
      // Return a minimal user object to prevent null reference errors
      return {
        _id: userId,
        email: email,
        failedLoginAttempts: [failedAttempt]
      };
    }
    
    return result.value;
  } catch (error) {
    console.error(`Error tracking failed login attempt for user ${email}:`, error);
    // Return a minimal user object to prevent null reference errors
    return {
      _id: userId,
      email: email,
      failedLoginAttempts: [failedAttempt]
    };
  }
}

/**
 * Check if account should be locked based on failed attempts
 */
async function checkAccountLockout(user: any): Promise<{
  isLocked: boolean;
  unlockTime?: Date;
  attemptsCount: number;
}> {
  if (!user) {
    return { isLocked: false, attemptsCount: 0 };
  }

  const now = new Date();
  
  // Check if account is currently locked
  if (user.accountLockedUntil && new Date(user.accountLockedUntil) > now) {
    return { 
      isLocked: true, 
      unlockTime: new Date(user.accountLockedUntil),
      attemptsCount: user.failedLoginAttempts?.length || 0
    };
  }

  const failedAttempts = user.failedLoginAttempts || [];
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  
  // Count failed attempts in the last 15 minutes
  const recentFailedAttempts = failedAttempts.filter((attempt: any) => 
    new Date(attempt.timestamp) > fifteenMinutesAgo
  );

  // Progressive lockout strategy:
  // 5 attempts = 15 minutes lockout
  // 8 attempts = 1 hour lockout  
  // 10+ attempts = 4 hours lockout
  if (recentFailedAttempts.length >= 5) {
    let lockoutDuration = 15 * 60 * 1000; // 15 minutes default
    
    if (recentFailedAttempts.length >= 10) {
      lockoutDuration = 4 * 60 * 60 * 1000; // 4 hours
    } else if (recentFailedAttempts.length >= 8) {
      lockoutDuration = 60 * 60 * 1000; // 1 hour
    }

    const unlockTime = new Date(now.getTime() + lockoutDuration);
    
    // Update user with lockout timestamp
    const db = await connectToDatabase();
    const usersCollection = db.collection('users');
    await usersCollection.updateOne(
      { _id: new ObjectId(user._id) },
      { 
        $set: { 
          accountLockedUntil: unlockTime,
          lockoutReason: `${recentFailedAttempts.length} failed login attempts`
        },
        $inc: {
          lockoutCount: 1
        }
      } as any
    );

/*console.log(`Account locked for user: ${user.email}. Unlock time: ${unlockTime}. Lockout count: ${(user.lockoutCount || 0) + 1}`);*/ 
    
    return { 
      isLocked: true, 
      unlockTime: unlockTime,
      attemptsCount: recentFailedAttempts.length
    };
  }

  return { 
    isLocked: false, 
    attemptsCount: recentFailedAttempts.length
  };
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
/*console.log(`Token verification JWT check starting for token: ${token.substring(0, 20)}...`);*/ 
    // Verify JWT token structure and signature - SAME LOGIC AS RESET
    decoded = jwt.verify(token as string, JWT_SECRET) as any;
    /*console.log(`Token verification JWT successful. Token data:`, { 
      type: decoded.type, 
      email: decoded.email, 
      userId: decoded.userId, 
      timestamp: decoded.timestamp 
    });*/

    if (decoded.type !== 'password-reset') {
/*console.log(`Token verification failed - invalid token type: ${decoded.type}`);*/ 
      return res.status(400).json({ error: 'Invalid token type', valid: false });
    }

    // Additional validation of token contents - SAME LOGIC AS RESET
    if (!decoded.email || !decoded.timestamp || !decoded.userId) {
      /*console.log(`Token verification failed - invalid token format. Missing fields:`, {
        hasEmail: !!decoded.email,
        hasTimestamp: !!decoded.timestamp,
        hasUserId: !!decoded.userId
      });*/
      return res.status(400).json({ error: 'Invalid token format', valid: false });
    }

    // Check if token is too old (additional check beyond JWT expiry) - SAME LOGIC AS RESET
    const tokenAge = Date.now() - decoded.timestamp;
    const maxTokenAge = 60 * 60 * 1000; // 1 hour in milliseconds
/*console.log(`Token verification age check: ${tokenAge}ms (max: ${maxTokenAge}ms)`);*/ 
    if (tokenAge > maxTokenAge) {
/*console.log(`Token verification failed - token too old: ${tokenAge}ms > ${maxTokenAge}ms`);*/ 
      return res.status(400).json({ error: 'Token too old', valid: false });
    }
    
/*console.log(`Token verification JWT validation completed successfully`);*/ 
  } catch (jwtError) {
    console.error('Token verification JWT failed:', {
      error: jwtError instanceof Error ? jwtError.message : 'Unknown error',
      tokenLength: token?.length,
      tokenStart: token?.substring(0, 20),
      jwtSecret: JWT_SECRET ? 'Present' : 'Missing'
    });
    return res.status(400).json({ error: 'Invalid or expired reset token', valid: false });
  }

  try {
    const db = await connectToDatabase();
    const usersCollection = db.collection('users');
    
/*console.log(`Token verification database check for user ${decoded.userId}`);*/ 
    const user = await usersCollection.findOne({ 
      _id: new ObjectId(decoded.userId),
      resetToken: token,
      resetTokenExpiry: { $gt: new Date() }, // Token must be valid and not expired
      email: decoded.email.toLowerCase() // Verify email matches token
    });

    if (!user) {
/*console.log('Token verification failed: User not found or token invalid/expired');*/ 
      
      // Additional debugging - check what's actually in the database
      const userInDb = await usersCollection.findOne({
        _id: new ObjectId(decoded.userId),
        email: decoded.email.toLowerCase()
      });
      
      if (userInDb) {
        /*console.log(`Token verification debug - User found but token issue:`, {
          hasResetToken: !!userInDb.resetToken,
          tokenMatches: userInDb.resetToken === token,
          tokenExpiry: userInDb.resetTokenExpiry?.toISOString(),
          isExpired: userInDb.resetTokenExpiry ? new Date(userInDb.resetTokenExpiry) <= new Date() : null,
          lastPasswordReset: userInDb.lastPasswordReset?.toISOString(),
          resetTokenInUse: userInDb.resetTokenInUse,
          resetTokenInUseAt: userInDb.resetTokenInUseAt?.toISOString()
        });*/
      } else {
/*console.log(`Token verification debug - User not found in database for ID: ${decoded.userId}, email: ${decoded.email}`);*/ 
      }
      
      return res.status(400).json({ error: 'Invalid or expired reset token', valid: false });
    }

/*console.log(`Token verification database check successful for user: ${user.email}`);*/ 

    // Check for recent password reset (same logic as actual reset)
    let canResetNow = true;
    let waitTimeMinutes = 0;
    
    if (user.lastPasswordReset) {
      const timeSinceLastReset = Date.now() - new Date(user.lastPasswordReset).getTime();
      if (timeSinceLastReset < 5 * 60 * 1000) {
        canResetNow = false;
        waitTimeMinutes = Math.ceil((5 * 60 * 1000 - timeSinceLastReset) / (60 * 1000));
      }
    }

    // Mark the token as being verified to help with debugging
/*console.log(`Token verification successful for user: ${user.email}, canResetNow: ${canResetNow}`);*/ 

    return res.status(200).json({ 
      valid: true, 
      message: 'Token is valid',
      canResetNow,
      waitTimeMinutes: canResetNow ? 0 : waitTimeMinutes
    });
  } catch (error) {
    console.error('Reset token verification error:', error);
    return res.status(500).json({ error: 'Internal server error', valid: false });
  }
}

/**
 * Cleanup stale reset token in-use markers (older than 5 minutes)
 */
async function cleanupStaleTokenMarkers(): Promise<void> {
  try {
    const db = await connectToDatabase();
    const usersCollection = db.collection('users');
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const result = await usersCollection.updateMany(
      { 
        resetTokenInUse: true,
        resetTokenInUseAt: { $lt: fiveMinutesAgo }
      },
      { 
        $unset: { 
          resetTokenInUse: 1, 
          resetTokenInUseAt: 1, 
          resetTokenUpdateId: 1 
        } 
      }
    );
    
    if (result.modifiedCount > 0) {
/*console.log(`Cleaned up ${result.modifiedCount} stale reset token markers`);*/ 
    }
  } catch (error) {
    console.error('Failed to cleanup stale token markers:', error);
  }
}

/**
 * Debug endpoint for troubleshooting reset token issues
 */
async function handleDebugResetToken(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    // Try to decode the JWT
    let decoded: any;
    try {
      decoded = jwt.verify(token as string, JWT_SECRET) as any;
    } catch (jwtError) {
      return res.status(200).json({
        debug: 'JWT_DECODE_FAILED',
        error: jwtError instanceof Error ? jwtError.message : 'Unknown JWT error',
        tokenLength: token.length,
        tokenStart: token.substring(0, 30)
      });
    }

    // Check if user exists in database
    const db = await connectToDatabase();
    const usersCollection = db.collection('users');
    
    const user = await usersCollection.findOne({
      _id: new ObjectId(decoded.userId),
      email: decoded.email.toLowerCase()
    });

    if (!user) {
      return res.status(200).json({
        debug: 'USER_NOT_FOUND',
        decoded: { 
          userId: decoded.userId, 
          email: decoded.email, 
          type: decoded.type,
          timestamp: decoded.timestamp
        }
      });
    }

    return res.status(200).json({
      debug: 'TOKEN_ANALYSIS',
      decoded: { 
        userId: decoded.userId, 
        email: decoded.email, 
        type: decoded.type,
        timestamp: decoded.timestamp,
        tokenAge: Date.now() - decoded.timestamp
      },
      userInDb: {
        hasResetToken: !!user.resetToken,
        tokenMatches: user.resetToken === token,
        tokenExpiry: user.resetTokenExpiry?.toISOString(),
        isExpired: user.resetTokenExpiry ? new Date(user.resetTokenExpiry) <= new Date() : null,
        lastPasswordReset: user.lastPasswordReset?.toISOString(),
        resetTokenInUse: user.resetTokenInUse,
        resetTokenInUseAt: user.resetTokenInUseAt?.toISOString()
      }
    });
  } catch (error) {
    return res.status(200).json({
      debug: 'UNEXPECTED_ERROR',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

