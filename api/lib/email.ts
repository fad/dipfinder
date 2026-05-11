// Email service for DipFinder notifications
// Using Resend API with EMAIL_NOREPLY_API_KEY

import { connectToDatabase } from './mongodb';
import { buildStockResults } from './newsletter-data';

const RESEND_API_KEY = process.env.EMAIL_NOREPLY_API_KEY;
const FROM_EMAIL = 'noreply@dipfinder.com';
const SITE_URL = 'https://dipfinder.com';

// ── Themed email wrapper ──────────────────────────────────────────────────────
// All transactional emails share this branded shell.
// bodyHtml: the main content area; footerHtml: overrides the default footer.
/**
 * Build the hidden preheader element that email clients show as inbox preview text.
 * Padded with non-breaking spaces so clients don't bleed body text into the snippet.
 */
function buildPreheader(text: string): string {
  const padding = '&nbsp;&zwnj;'.repeat(120);
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(text)}${padding}</div>`;
}

export function buildEmailHtml(bodyHtml: string, footerHtml?: string, previewText?: string): string {
  const baseUrl = process.env.FRONTEND_URL || SITE_URL;
  const footer = footerHtml ?? `<p style="margin:0 0 4px;">Dip Finder &bull; <a href="${baseUrl}" style="color:#94A3B8;text-decoration:none;">dipfinder.com</a></p><p style="margin:0;">Please do not reply to this email.</p>`;
  const preheader = previewText ? buildPreheader(previewText) : '';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Arial,Helvetica,sans-serif;">${preheader}
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08);">
<tr>
  <td style="background:linear-gradient(135deg,#2563EB 0%,#4F46E5 55%,#7C3AED 100%);padding:28px 40px;text-align:center;">
    <table cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>
      <td style="padding-right:10px;vertical-align:middle;">
        <img src="${baseUrl}/img/logo.png" width="36" height="36" alt="" style="border-radius:8px;display:block;">
      </td>
      <td style="vertical-align:middle;">
        <span style="color:#FFFFFF;font-size:18px;font-weight:800;letter-spacing:0.5px;font-family:Arial,sans-serif;">Dip Finder</span>
      </td>
    </tr></table>
  </td>
</tr>
<tr>
  <td style="padding:36px 40px 32px;">${bodyHtml}</td>
</tr>
<tr>
  <td style="padding:20px 40px 28px;border-top:1px solid #E2E8F0;text-align:center;color:#94A3B8;font-size:12px;line-height:1.8;font-family:Arial,sans-serif;">${footer}</td>
</tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// Escape user-supplied text before injecting into HTML templates
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Replace {{varName}} placeholders with values from vars map.
// Values that contain user-supplied text must be escaped with escapeHtml() before being passed in.
// Values that are pre-built HTML blocks must NOT be escaped.
export function renderTemplate(html: string, vars: Record<string, string>): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// ── Default template bodies (inner HTML only, no outer wrapper) ───────────────
const DEFAULT_TEMPLATES: Record<string, { name: string; subject: string; body: string; fullHtml?: boolean }> = {
  onboarding: {
    name: 'Welcome / Onboarding',
    subject: 'Welcome to Dip Finder - your Sunday brief starts now',
    body: `
<p style="font-family:Arial,sans-serif;font-size:16px;color:#0F172A;line-height:1.6;margin:0 0 20px;"><strong>Welcome to Dip Finder, {{name}}.</strong></p>
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;">It's a weird time to be an investor. Rate swings, macro headlines, AI booms and busts - the market feels more unpredictable than ever.</p>
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;font-weight:700;">That's where Dip Finder comes in.</p>
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;">We rank the stocks on your watchlist by how far they're trading below their moving average. Every Sunday morning, your brief shows you the best opportunities at a glance - the stocks you already want to own, on sale.</p>
{{setPasswordBlock}}
{{watchlistChartBlock}}
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 28px;">To make sure our emails land in your inbox, just reply with a quick "hello". It tells the email gods you want to hear from us.</p>
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0;">Talk to you on Sunday,<br><strong>The Dip Finder Team</strong></p>
`,
  },
  'password-reset': {
    name: 'Password Reset',
    subject: 'Reset Your Password - Dip Finder',
    body: `
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;">We received a request to reset the password for your Dip Finder account (<strong>{{email}}</strong>).</p>
<div style="text-align:center;margin:28px 0;">
  <a href="{{resetUrl}}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#4F46E5);color:#FFFFFF;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;font-family:Arial,sans-serif;">Reset Password</a>
</div>
<div style="background:#FEF9C3;border-left:4px solid #EAB308;border-radius:0 8px 8px 0;padding:14px 18px;margin:0 0 20px;">
  <p style="font-family:Arial,sans-serif;font-size:13px;color:#713F12;margin:0;line-height:1.6;">This link expires in 1 hour. If you didn't request a reset, ignore this email - your password won't change.</p>
</div>
<p style="font-family:Arial,sans-serif;font-size:13px;color:#94A3B8;line-height:1.6;margin:0;">Link not working? Copy and paste: <span style="color:#2563EB;word-break:break-all;">{{resetUrl}}</span></p>
`,
  },
  'magic-link': {
    name: 'Sign-in Link',
    subject: 'Your Dip Finder sign-in link',
    body: `
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;">Click below to sign in to Dip Finder. This link expires in 15 minutes and can only be used once.</p>
<div style="text-align:center;margin:28px 0;">
  <a href="{{magicUrl}}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#4F46E5);color:#FFFFFF;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;font-family:Arial,sans-serif;">Sign In to Dip Finder</a>
</div>
<div style="background:#FEF9C3;border-left:4px solid #EAB308;border-radius:0 8px 8px 0;padding:14px 18px;">
  <p style="font-family:Arial,sans-serif;font-size:13px;color:#713F12;margin:0;line-height:1.6;">If you didn't request this link, you can safely ignore this email. Someone may have entered your email by mistake.</p>
</div>
`,
  },
  'sunday-brief': {
    name: 'Sunday Brief',
    subject: 'Your Weekly Dip Report - {{shortDate}}',
    fullHtml: true,
    body: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,Arial,sans-serif;">
<div style="max-width:620px;margin:0 auto;background:#f8fafc;">

  <div style="padding:8px 16px;display:table;width:100%;box-sizing:border-box;">
    <span style="display:table-cell;color:#94a3b8;font-size:0.75em;">{{dateLabel}}</span>
    {{viewOnlineBlock}}
  </div>

  <a href="https://dipfinder.com" style="display:block;text-decoration:none;background:linear-gradient(135deg,#2563eb,#7c3aed);padding:32px 32px 28px;text-align:center;">
    <img src="https://dipfinder.com/img/logo.png" width="32" height="32" alt="" style="display:inline-block;vertical-align:middle;border-radius:6px;margin-right:10px;">
    <span style="font-size:1.6rem;color:#ffffff;font-weight:800;letter-spacing:-0.02em;vertical-align:middle;">Dip Finder</span>
  </a>

  <div style="padding:28px 32px;">
    <p style="color:#1e293b;margin:0 0 16px;line-height:1.6;font-size:0.9em;"><strong>Good morning, {{name}}</strong><br><span style="color:#475569;">{{openerSummary}}</span></p>

    {{chartBlock}}

    {{watchlistTable}}

    {{newsSummaries}}

    <div style="margin-top:28px;text-align:center;">
      <a href="https://dipfinder.com/app" style="display:inline-block;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.9em;letter-spacing:0.01em;">Open Dip Finder &#x2197;</a>
    </div>
  </div>

  <div style="padding:16px 32px;background:#1e293b;text-align:center;">
    <p style="color:#64748b;font-size:0.73em;margin:0;line-height:1.7;">
      You're receiving this because you subscribed to the Dip Finder Sunday Brief.<br>
      <a href="{{unsubscribeUrl}}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a>
    </p>
  </div>

</div>
</body>
</html>`,
  },
};

// Get a template from DB; auto-seeds the default if not found
export async function getEmailTemplate(db: any, key: string): Promise<{ subject: string; html: string; name: string } | null> {
  const doc = await db.collection('emailTemplates').findOne({ key });
  if (doc) return { subject: doc.subject, html: doc.html, name: doc.name };

  const def = DEFAULT_TEMPLATES[key];
  if (!def) return null;

  const html = def.fullHtml ? def.body : buildEmailHtml(def.body);
  await db.collection('emailTemplates').insertOne({
    key, name: def.name, subject: def.subject, html, createdAt: new Date(), updatedAt: new Date(),
  });
  return { subject: def.subject, html, name: def.name };
}

// Save (upsert) a template to DB
export async function saveEmailTemplate(db: any, key: string, subject: string, html: string): Promise<void> {
  const name = DEFAULT_TEMPLATES[key]?.name ?? key;
  await db.collection('emailTemplates').updateOne(
    { key },
    { $set: { name, subject, html, updatedAt: new Date() }, $setOnInsert: { key, createdAt: new Date() } },
    { upsert: true }
  );
}

// Return a list of all known template keys + names (for admin UI)
export function listTemplateKeys(): { key: string; name: string }[] {
  return Object.entries(DEFAULT_TEMPLATES).map(([key, def]) => ({ key, name: def.name }));
}

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Send email using Resend API
 */
export async function sendEmail({ to, subject, html, text }: EmailOptions): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.error('EMAIL_NOREPLY_API_KEY not configured');
    return false;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject,
        html,
        text: text || stripHtml(html)
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Failed to send email:', response.status, errorData);
      return false;
    }

    await response.json();
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

/**
 * Send password change notification email
 */
export async function sendPasswordChangeNotification(email: string): Promise<boolean> {
  const subject = 'Password Changed - DipFinder';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1a365d; margin: 0;">DipFinder</h1>
      </div>
      
      <div style="background-color: #f7fafc; padding: 20px; border-radius: 8px; border-left: 4px solid #4299e1;">
        <h2 style="color: #2d3748; margin-top: 0;">Password Changed Successfully</h2>
        <p style="color: #4a5568; line-height: 1.6;">
          Your password for your DipFinder account has been successfully changed.
        </p>
        <p style="color: #4a5568; line-height: 1.6;">
          <strong>Account:</strong> ${email}
        </p>
        <p style="color: #4a5568; line-height: 1.6;">
          <strong>Changed at:</strong> ${new Date().toLocaleString()}
        </p>
      </div>
      
      <div style="margin-top: 30px; padding: 20px; background-color: #fff5f5; border-radius: 8px; border-left: 4px solid #f56565;">
        <h3 style="color: #c53030; margin-top: 0;">Important Security Notice</h3>
        <p style="color: #4a5568; line-height: 1.6;">
          If you did not change your password, please contact our support team immediately.
        </p>
      </div>
      
      <div style="margin-top: 30px; text-align: center; color: #718096; font-size: 14px;">
        <p>
          This is an automated notification from DipFinder.<br>
          Please do not reply to this email.
        </p>
        <p style="margin-top: 20px;">
          <a href="https://dipfinder.com" style="color: #4299e1; text-decoration: none;">Visit DipFinder</a>
        </p>
      </div>
    </div>
  `;

  return await sendEmail({
    to: email,
    subject,
    html
  });
}

/**
 * Send password reset email with reset link
 */
export async function sendPasswordResetEmail(email: string, resetToken: string): Promise<boolean> {
  const baseUrl = process.env.FRONTEND_URL || SITE_URL;
  const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}`;

  try {
    const db = await connectToDatabase();
    const template = await getEmailTemplate(db, 'password-reset');
    if (template) {
      const html = renderTemplate(template.html, { email: escapeHtml(email), resetUrl });
      return sendEmail({ to: email, subject: template.subject, html });
    }
  } catch { /* fall through to hardcoded */ }

  const html = buildEmailHtml(`
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;">We received a request to reset the password for your Dip Finder account (<strong>${escapeHtml(email)}</strong>).</p>
<div style="text-align:center;margin:28px 0;">
  <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#4F46E5);color:#FFFFFF;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;font-family:Arial,sans-serif;">Reset Password</a>
</div>
<div style="background:#FEF9C3;border-left:4px solid #EAB308;border-radius:0 8px 8px 0;padding:14px 18px;margin:0 0 20px;">
  <p style="font-family:Arial,sans-serif;font-size:13px;color:#713F12;margin:0;line-height:1.6;">This link expires in 1 hour. If you didn't request a reset, ignore this email.</p>
</div>
<p style="font-family:Arial,sans-serif;font-size:13px;color:#94A3B8;line-height:1.6;margin:0;">Link not working? Copy and paste: <span style="color:#2563EB;word-break:break-all;">${resetUrl}</span></p>
`);
  return sendEmail({ to: email, subject: 'Reset Your Password - Dip Finder', html });
}

/**
 * Sent when someone tries to register with an email that already has an account.
 * Avoids leaking account existence in the registration API response.
 */
export async function sendAccountExistsEmail(email: string): Promise<boolean> {
  const baseUrl = process.env.FRONTEND_URL || SITE_URL;
  const loginUrl = `${baseUrl}/app`;
  const resetUrl = `${baseUrl}/forgot-password.html`;
  const html = buildEmailHtml(`
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;">Someone tried to create a Dip Finder account using your email address (<strong>${escapeHtml(email)}</strong>).</p>
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 24px;">You already have an account - no action is needed. If this was you and you were trying to log in, you can do so here:</p>
<div style="text-align:center;margin:28px 0;">
  <a href="${loginUrl}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#4F46E5);color:#FFFFFF;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;font-family:Arial,sans-serif;">Log In</a>
</div>
<p style="font-family:Arial,sans-serif;font-size:14px;color:#6B7280;line-height:1.75;margin:0;">Forgot your password? <a href="${resetUrl}" style="color:#2563EB;">Reset it here</a>. If you did not attempt to register, you can safely ignore this email.</p>
`);
  return sendEmail({ to: email, subject: 'Someone tried to register with your email - Dip Finder', html });
}

/**
 * Send welcome email to new users
 */
export async function sendWelcomeEmail(email: string, name: string): Promise<boolean> {
  const subject = 'Welcome to DipFinder!';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1a365d; margin: 0;">DipFinder</h1>
      </div>
      
      <div style="background-color: #f7fafc; padding: 20px; border-radius: 8px; border-left: 4px solid #48bb78;">
        <h2 style="color: #2d3748; margin-top: 0;">Welcome to DipFinder, ${name}!</h2>
        <p style="color: #4a5568; line-height: 1.6;">
          Thank you for joining DipFinder, your comprehensive stock screening and analysis platform.
        </p>
        <p style="color: #4a5568; line-height: 1.6;">
          You can now access powerful tools to identify market opportunities and make informed investment decisions.
        </p>
      </div>
      
      <div style="margin-top: 30px; text-align: center;">
        <a href="https://dipfinder.com/screener.html" 
           style="display: inline-block; background-color: #48bb78; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin-right: 10px;">
          Start Screening
        </a>
        <a href="https://dipfinder.com/profile.html" 
           style="display: inline-block; background-color: #4299e1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Manage Profile
        </a>
      </div>
      
      <div style="margin-top: 30px; text-align: center; color: #718096; font-size: 14px;">
        <p>
          Get started with DipFinder and discover your next investment opportunity!
        </p>
        <p style="margin-top: 20px;">
          <a href="https://dipfinder.com" style="color: #4299e1; text-decoration: none;">Visit DipFinder</a>
        </p>
      </div>
    </div>
  `;

  return await sendEmail({
    to: email,
    subject,
    html
  });
}

/**
 * Send magic sign-in link email
 */
export async function sendMagicLinkEmail(email: string, magicUrl: string): Promise<boolean> {
  try {
    const db = await connectToDatabase();
    const template = await getEmailTemplate(db, 'magic-link');
    if (template) {
      const html = renderTemplate(template.html, { magicUrl });
      return sendEmail({ to: email, subject: template.subject, html });
    }
  } catch { /* fall through to hardcoded */ }

  const html = buildEmailHtml(`
<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;">Click below to sign in to Dip Finder. This link expires in 15 minutes and can only be used once.</p>
<div style="text-align:center;margin:28px 0;">
  <a href="${magicUrl}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#4F46E5);color:#FFFFFF;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;font-family:Arial,sans-serif;">Sign In to Dip Finder</a>
</div>
<div style="background:#FEF9C3;border-left:4px solid #EAB308;border-radius:0 8px 8px 0;padding:14px 18px;">
  <p style="font-family:Arial,sans-serif;font-size:13px;color:#713F12;margin:0;line-height:1.6;">If you didn't request this link, you can safely ignore this email.</p>
</div>
`);
  return sendEmail({ to: email, subject: 'Your Dip Finder sign-in link', html });
}

/**
 * Send onboarding welcome email using the DB-backed 'onboarding' template.
 * When setPasswordUrl is provided the template's {{setPasswordBlock}} placeholder
 * is replaced with a "gift 10 slots + set password" CTA block.
 * When watchlist + db are provided the template's {{watchlistChartBlock}} placeholder
 * is replaced with a bar chart of the user's watchlist.
 */
export async function sendOnboardingEmail(
  toEmail: string,
  name: string,
  options?: { setPasswordUrl?: string; watchlist?: string[]; db?: any; smaPeriod?: number }
): Promise<boolean> {
  try {
    const db = options?.db ?? await connectToDatabase();
    const template = await getEmailTemplate(db, 'onboarding');
    if (!template) return false;

    const setPasswordBlock = options?.setPasswordUrl
      ? `<p style="font-family:Arial,sans-serif;font-size:15px;color:#374151;line-height:1.75;margin:0 0 16px;">As a welcome gift, we've upgraded your watchlist to <strong>10 stock slots</strong> - double the usual free limit. Set a password to keep your account.</p>
<div style="text-align:center;margin:28px 0;">
  <a href="${options.setPasswordUrl}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#4F46E5);color:#FFFFFF;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;font-family:Arial,sans-serif;">Set My Password &rarr;</a>
</div>
<div style="background:#DCFCE7;border-left:4px solid #16A34A;border-radius:0 8px 8px 0;padding:14px 18px;margin:0 0 24px;">
  <p style="font-family:Arial,sans-serif;font-size:13px;color:#14532D;margin:0;line-height:1.6;">This link expires in 7 days. You can also sign in at any time using a magic link from the login page.</p>
</div>`
      : '';

    // Build watchlist chart block if watchlist data is available
    let watchlistChartBlock = '';
    if (options?.watchlist?.length) {
      try {
        const smaPeriod = options.smaPeriod || 50;
        const stockResults = await buildStockResults(options.watchlist, db, smaPeriod);
        if (stockResults.length > 0) {
          const chartUrl = generateBarChartUrl(stockResults, 'y');
          watchlistChartBlock = `
<div style="margin:24px 0;">
  <p style="font-family:Arial,sans-serif;font-size:12px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 10px;">Your Watchlist vs ${smaPeriod}-day SMA</p>
  <img src="${chartUrl}" width="100%" alt="Your watchlist dip chart" style="display:block;border-radius:8px;border:1px solid #e2e8f0;max-width:556px;">
</div>`;
        }
      } catch (chartErr) {
        console.error('sendOnboardingEmail: chart generation failed:', chartErr);
      }
    }

    const subject = options?.setPasswordUrl
      ? 'Welcome to Dip Finder - claim your free upgrade'
      : template.subject;

    const html = renderTemplate(template.html, { name: escapeHtml(name || 'there'), setPasswordBlock, watchlistChartBlock });
    return sendEmail({ to: toEmail, subject, html });
  } catch (err) {
    console.error('sendOnboardingEmail error:', err);
    return false;
  }
}

export interface NewsletterStockRow {
  symbol: string;
  companyName: string;
  currentPrice: number;
  sma: number;
  relativePrice: number;
  topNews?: { headline: string; url: string; source: string; datetime: number }[];
}

function getBarColor(diffPercent: number): string {
  if (!Number.isFinite(diffPercent)) return '#94A3B8';
  if (diffPercent < -15) return '#0F766E';
  if (diffPercent <  -5) return '#14B8A6';
  if (diffPercent <   5) return '#94A3B8';
  if (diffPercent <  15) return '#FBBF24';
  return '#F97316';
}

function getBadgeColors(diffPercent: number): { bg: string; color: string } {
  if (!Number.isFinite(diffPercent)) return { bg: '#F1F5F9', color: '#475569' };
  if (diffPercent < -15) return { bg: '#CCFBF1', color: '#0F766E' };
  if (diffPercent <  -5) return { bg: '#CCFBF1', color: '#0F766E' };
  if (diffPercent <   5) return { bg: '#F1F5F9', color: '#475569' };
  if (diffPercent <  15) return { bg: '#FEF3C7', color: '#B45309' };
  return { bg: '#FFEDD5', color: '#C2410C' };
}

function generateBarChartUrl(stocks: NewsletterStockRow[], orientation: 'x' | 'y' = 'y'): string {
  const labels = stocks.map(s => s.symbol);
  const data = stocks.map(s => Math.round(s.relativePrice * 1000) / 10);
  const colors = stocks.map(s => getBarColor(s.relativePrice * 100));

  // QuickChart uses Chart.js 2.x: 'bar' = vertical, 'horizontalBar' = horizontal (indexAxis:'y')
  const isHorizontal = orientation === 'y';
  const chartType = isHorizontal ? 'horizontalBar' : 'bar';
  const categoryAxis = { ticks: { fontColor: '#64748b', fontSize: 11 }, gridLines: { display: false } };
  const valueAxis   = { ticks: { fontColor: '#94a3b8', fontSize: 10 }, gridLines: { color: '#e2e8f0' } };

  const cfg = {
    type: chartType,
    data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [isHorizontal ? valueAxis   : categoryAxis],
        yAxes: [isHorizontal ? categoryAxis : valueAxis],
      },
    },
  };

  const h = isHorizontal ? Math.max(160, stocks.length * 26) : 200;
  return `https://quickchart.io/chart?w=556&h=${h}&bkg=%23ffffff&c=${encodeURIComponent(JSON.stringify(cfg))}`;
}

/**
 * Build a short personalized preview text for the newsletter.
 * Shows the top 2 dipping stocks, e.g. "INTU -8.2%, CRM -4.1% - 2 stocks dipping this week"
 */
function buildNewsletterPreviewText(stocks: NewsletterStockRow[]): string {
  const dipping = stocks.filter(s => s.relativePrice < 0);
  if (!dipping.length) {
    const top = stocks[0];
    return top
      ? `${top.symbol} ${top.relativePrice > 0 ? '+' : ''}${(top.relativePrice * 100).toFixed(1)}% vs SMA - your weekly dip report`
      : 'Your weekly Dip Finder report is ready';
  }
  const top2 = dipping.slice(0, 2).map(s => `${s.symbol} ${(s.relativePrice * 100).toFixed(1)}%`).join(', ');
  const count = dipping.length;
  return `${top2} - ${count} stock${count !== 1 ? 's' : ''} dipping in your watchlist this week`;
}

// ── Newsletter block builders ─────────────────────────────────────────────────

function buildNewsSummariesBlock(
  stocks: NewsletterStockRow[],
  smaPeriod: number,
  aiSummaries?: Record<string, string>,
): string {
  if (!aiSummaries) return '';
  const cards = stocks
    .filter(s => aiSummaries[s.symbol])
    .map(s => {
      const summary = aiSummaries[s.symbol];
      const pct = (s.relativePrice * 100).toFixed(1);
      const sign = s.relativePrice > 0 ? '+' : '';
      const { color: dipColor } = getBadgeColors(s.relativePrice * 100);
      const href = `https://dipfinder.com/screener?stock=${s.symbol}`;
      return `
<div style="padding:14px 0;border-top:1px solid #f1f5f9;">
  <p style="margin:0 0 6px;line-height:1.4;">
    <a href="${href}" style="font-weight:800;color:#1e293b;text-decoration:none;font-size:0.9em;margin-right:8px;">${s.symbol}</a><span style="color:#64748b;font-size:0.8em;">${escapeHtml(s.companyName)}</span><span style="float:right;font-weight:700;color:${dipColor};font-size:0.85em;">${sign}${pct}% vs ${smaPeriod}d SMA</span>
  </p>
  <p style="margin:0;color:#374151;font-size:0.875em;line-height:1.65;">${escapeHtml(summary)}</p>
</div>`;
    });
  if (!cards.length) return '';
  return `
<div style="margin-top:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:4px 16px 2px;">
  <h2 style="margin:14px 0 2px;font-size:0.7em;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">This Week's News</h2>
  ${cards.join('')}
</div>`;
}

function buildChartBlock(stocks: NewsletterStockRow[], orientation: 'x' | 'y', smaPeriod: number): string {
  if (!stocks.length) return '';
  const chartUrl = generateBarChartUrl(stocks, orientation);
  const h = orientation === 'y' ? Math.max(160, stocks.length * 26) : 200;
  return `
<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:24px;">
  <img src="${chartUrl}" width="556" height="${h}" alt="Watchlist dip chart" style="display:block;">
  <div style="padding:8px 14px;border-top:1px solid #f1f5f9;background:#f8fafc;">
    <span style="font-size:0.7em;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;">% vs ${smaPeriod}-day SMA - negative = below SMA (dipping)</span>
  </div>
</div>`;
}

function buildWatchlistTableHtml(stocks: NewsletterStockRow[], smaPeriod: number): string {
  if (!stocks.length) return '';
  const rows = stocks.map(s => {
    const pct = (s.relativePrice * 100).toFixed(1);
    const { bg: dipBg, color: dipColor } = getBadgeColors(s.relativePrice * 100);
    const sign = s.relativePrice > 0 ? '+' : '';
    const href = `https://dipfinder.com/screener?stock=${s.symbol}`;
    const ls = 'display:block;padding:10px 14px;text-decoration:none;color:inherit;';
    return `<tr>
      <td style="padding:0;border-bottom:1px solid #f1f5f9;white-space:nowrap;"><a href="${href}" style="${ls}font-weight:700;color:#1e293b;">${s.symbol}</a></td>
      <td style="padding:0;border-bottom:1px solid #f1f5f9;"><a href="${href}" style="${ls}color:#64748b;font-size:0.85em;">${s.companyName}</a></td>
      <td style="padding:0;border-bottom:1px solid #f1f5f9;white-space:nowrap;"><a href="${href}" style="${ls}color:#1e293b;text-align:right;">$${s.currentPrice.toFixed(2)}</a></td>
      <td style="padding:0;border-bottom:1px solid #f1f5f9;white-space:nowrap;"><a href="${href}" style="${ls}color:#64748b;text-align:right;">$${s.sma.toFixed(2)}</a></td>
      <td style="padding:0;border-bottom:1px solid #f1f5f9;white-space:nowrap;text-align:right;"><a href="${href}" style="${ls}text-align:right;"><span style="background:${dipBg};color:${dipColor};font-weight:700;font-size:0.82em;padding:3px 8px;border-radius:999px;">${sign}${pct}%</span></a></td>
    </tr>`;
  }).join('');
  return `
<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:28px;">
  <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
    <thead>
      <tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;">
        <th style="padding:10px 14px;text-align:left;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;letter-spacing:0.06em;">Ticker</th>
        <th style="padding:10px 14px;text-align:left;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;letter-spacing:0.06em;">Company</th>
        <th style="padding:10px 14px;text-align:right;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;letter-spacing:0.06em;">Price</th>
        <th style="padding:10px 14px;text-align:right;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;letter-spacing:0.06em;">${smaPeriod}d SMA</th>
        <th style="padding:10px 14px;text-align:right;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:0.68em;letter-spacing:0.06em;">vs SMA</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

function buildNewsBlockHtml(
  stocks: NewsletterStockRow[],
  smaPeriod: number,
  aiSummaries?: Record<string, string>,
): string {
  const newsCards = stocks.filter(s => s.topNews?.length || aiSummaries?.[s.symbol]).map(s => {
    const aiSummary = aiSummaries?.[s.symbol];
    const summaryBlock = aiSummary
      ? `<p style="margin:12px 0 6px;color:#374151;font-size:0.875em;line-height:1.6;">${escapeHtml(aiSummary)}</p>`
      : '';
    const items = (s.topNews || []).map(n => `
      <a href="${n.url}" style="display:block;text-decoration:none;padding:8px 0;border-top:1px solid #f1f5f9;">
        <span style="font-size:0.78em;font-weight:600;color:#2563eb;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(n.source)}</span>
        <p style="margin:3px 0 0;color:#1e293b;font-size:0.875em;line-height:1.4;">${escapeHtml(n.headline)}</p>
      </a>`).join('');
    const pct = (s.relativePrice * 100).toFixed(1);
    const { color: dipColor } = getBadgeColors(s.relativePrice * 100);
    const sign = s.relativePrice > 0 ? '+' : '';
    const href = `https://dipfinder.com/screener?stock=${s.symbol}`;
    return `
<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:12px;overflow:hidden;">
  <div style="padding:12px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;">
    <a href="${href}" style="font-weight:800;color:#1e293b;font-size:0.95em;margin-right:8px;text-decoration:none;">${s.symbol}</a>
    <a href="${href}" style="color:#64748b;font-size:0.8em;text-decoration:none;">${s.companyName}</a>
    <span style="float:right;font-weight:700;color:${dipColor};font-size:0.85em;">${sign}${pct}% vs ${smaPeriod}d SMA</span>
  </div>
  <div style="padding:0 16px;">${summaryBlock}${items}</div>
</div>`;
  }).join('');
  if (!newsCards) return '';
  return `<h2 style="margin:0 0 14px;font-size:0.75em;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">This Week's News</h2>
${newsCards}`;
}

// ── Newsletter HTML builder (fallback / legacy) ───────────────────────────────

export function buildNewsletterHtml({
  name,
  stocks,
  smaPeriod,
  unsubscribeUrl,
  viewOnlineUrl,
  chartOrientation = 'y',
  aiSummaries,
}: {
  name: string;
  stocks: NewsletterStockRow[];
  smaPeriod: number;
  unsubscribeUrl: string;
  viewOnlineUrl?: string;
  chartOrientation?: 'x' | 'y';
  aiSummaries?: Record<string, string>;
}): string {
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const chartBlock = buildChartBlock(stocks, chartOrientation as 'x' | 'y', smaPeriod);
  const watchlistTable = buildWatchlistTableHtml(stocks, smaPeriod);
  const newsSection = buildNewsBlockHtml(stocks, smaPeriod, aiSummaries);

  return `
<div style="font-family:system-ui,-apple-system,Arial,sans-serif; max-width:620px; margin:0 auto; background:#f8fafc;">

  <div style="padding:8px 16px; display:table; width:100%; box-sizing:border-box;">
    <span style="display:table-cell; color:#94a3b8; font-size:0.75em;">${dateLabel}</span>
    ${viewOnlineUrl ? `<span style="display:table-cell; text-align:right;"><a href="${viewOnlineUrl}" style="color:#64748b; font-size:0.75em; text-decoration:none;">View Online</a></span>` : ''}
  </div>

  <a href="https://dipfinder.com" style="display:block; text-decoration:none; background:linear-gradient(135deg,#2563eb,#7c3aed); padding:32px 32px 28px; text-align:center;">
    <div>
      <img src="https://dipfinder.com/img/logo.png" width="32" height="32" alt="" style="display:inline-block; vertical-align:middle; border-radius:6px; margin-right:10px;">
      <span style="font-size:1.6rem; color:#ffffff; font-weight:800; letter-spacing:-0.02em; vertical-align:middle;">Dip Finder</span>
    </div>
  </a>

  <div style="padding:28px 32px;">
    <p style="color:#1e293b; margin:0 0 24px; line-height:1.6; font-size:0.9em;"><strong>Good morning</strong><br><span style="color:#475569;">Here are your watchlist stocks ranked by distance from their ${smaPeriod}-day SMA.</span></p>
    ${chartBlock}
    ${watchlistTable}
    ${newsSection ? `<h2 style="margin:0 0 14px; font-size:0.75em; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.08em;">This Week's News</h2>${newsSection}` : ''}
    <div style="margin-top:28px; text-align:center;">
      <a href="https://dipfinder.com/app" style="display:inline-block; background:linear-gradient(135deg,#2563eb,#7c3aed); color:#ffffff; padding:12px 32px; border-radius:8px; text-decoration:none; font-weight:700; font-size:0.9em; letter-spacing:0.01em;">Open Dip Finder &#x2197;</a>
    </div>
  </div>

  <div style="padding:16px 32px; background:#1e293b; text-align:center;">
    <p style="color:#64748b; font-size:0.73em; margin:0; line-height:1.7;">
      You're receiving this because you subscribed to the Dip Finder newsletter.<br>
      <a href="${unsubscribeUrl}" style="color:#94a3b8; text-decoration:underline;">Unsubscribe</a>
    </p>
  </div>

</div>`;
}

/**
 * Build a readable plain-text version of the newsletter.
 * Used as the multipart text/plain body so email clients and spam filters
 * see structured content rather than stripped HTML.
 */
function buildNewsletterPlainText({
  stocks,
  smaPeriod,
  unsubscribeUrl,
  aiSummaries,
}: {
  stocks: NewsletterStockRow[];
  smaPeriod: number;
  unsubscribeUrl: string;
  aiSummaries?: Record<string, string>;
}): string {
  const baseUrl = process.env.FRONTEND_URL || SITE_URL;
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const lines: string[] = [];

  lines.push(`DIP FINDER - ${dateLabel}`);
  lines.push('='.repeat(50));
  lines.push('');

  // Watchlist table
  lines.push('WATCHLIST');
  lines.push('-'.repeat(30));
  for (const s of stocks) {
    const sign = s.relativePrice > 0 ? '+' : '';
    const pct = `${sign}${(s.relativePrice * 100).toFixed(1)}%`;
    lines.push(`${s.symbol} (${s.companyName})`);
    lines.push(`  Price: $${s.currentPrice.toFixed(2)}  |  ${smaPeriod}d SMA: $${s.sma.toFixed(2)}  |  vs SMA: ${pct}`);
    lines.push(`  ${baseUrl}/screener?stock=${s.symbol}`);
    lines.push('');
  }

  // News section
  const withNews = stocks.filter(s => aiSummaries?.[s.symbol] || s.topNews?.length);
  if (withNews.length) {
    lines.push('THIS WEEK\'S NEWS');
    lines.push('-'.repeat(30));
    for (const s of withNews) {
      const sign = s.relativePrice > 0 ? '+' : '';
      const pct = `${sign}${(s.relativePrice * 100).toFixed(1)}%`;
      lines.push(`${s.symbol} - ${s.companyName} (${pct} vs ${smaPeriod}d SMA)`);
      const summary = aiSummaries?.[s.symbol];
      if (summary) lines.push(summary);
      for (const n of (s.topNews || [])) {
        lines.push(`  - ${n.headline} (${n.source})`);
        if (n.url) lines.push(`    ${n.url}`);
      }
      lines.push('');
    }
  }

  lines.push('-'.repeat(50));
  lines.push(`Open Dip Finder: ${baseUrl}/app`);
  lines.push(`Unsubscribe: ${unsubscribeUrl}`);

  return lines.join('\n');
}

// ── Template-driven newsletter builder ───────────────────────────────────────
// Uses the 'sunday-brief' DB template if available; falls back to buildNewsletterHtml.

export async function buildNewsletterEmailHtml({
  name, stocks, smaPeriod, unsubscribeUrl, viewOnlineUrl, chartOrientation = 'y', openerSummary, aiSummaries, db,
}: {
  name: string;
  stocks: NewsletterStockRow[];
  smaPeriod: number;
  unsubscribeUrl: string;
  viewOnlineUrl?: string;
  chartOrientation?: 'x' | 'y';
  openerSummary?: string;
  aiSummaries?: Record<string, string>;
  db: any;
}): Promise<{ html: string; subject: string; text: string }> {
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const shortDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const template = await getEmailTemplate(db, 'sunday-brief');

  const chartBlock = buildChartBlock(stocks, chartOrientation, smaPeriod);
  const watchlistTable = buildWatchlistTableHtml(stocks, smaPeriod);
  const newsSummaries = buildNewsSummariesBlock(stocks, smaPeriod, aiSummaries);
  const newsBlock = buildNewsBlockHtml(stocks, smaPeriod, aiSummaries);
  const viewOnlineBlock = viewOnlineUrl
    ? `<span style="display:table-cell;text-align:right;"><a href="${viewOnlineUrl}" style="color:#64748b;font-size:0.75em;text-decoration:none;">View Online</a></span>`
    : '';

  const previewText = buildNewsletterPreviewText(stocks);
  const plainText = buildNewsletterPlainText({ stocks, smaPeriod, unsubscribeUrl, aiSummaries });
  const preheader = buildPreheader(previewText);

  if (template) {
    const resolvedOpener = openerSummary ||
      `Here are your watchlist stocks ranked by distance from their ${smaPeriod}-day SMA.`;
    let html = renderTemplate(template.html, {
      name: escapeHtml(name || 'there'),
      dateLabel,
      shortDate,
      smaPeriod: String(smaPeriod),
      chartBlock,
      watchlistTable,
      newsSummaries,
      newsBlock,
      viewOnlineBlock,
      unsubscribeUrl,
      openerSummary: resolvedOpener,
    });
    // Inject hidden preheader right after <body> so email clients show it as inbox preview text
    html = html.replace(/<body[^>]*>/, match => match + preheader);
    const subject = renderTemplate(template.subject, { shortDate, dateLabel });
    return { html, subject, text: plainText };
  }

  // Fallback template is a fragment (no <body>); prepend preheader div
  const html = preheader + buildNewsletterHtml({ name, stocks, smaPeriod, unsubscribeUrl, viewOnlineUrl, chartOrientation, aiSummaries });
  return { html, subject: `Your Weekly Dip Report - ${shortDate}`, text: plainText };
}

/**
 * Send weekly newsletter email using the sunday-brief template (or fallback).
 */
export async function sendNewsletterEmail({
  to,
  name,
  stocks,
  smaPeriod,
  unsubscribeUrl,
  viewOnlineUrl,
  chartOrientation = 'y',
  openerSummary,
  aiSummaries,
  db,
}: {
  to: string;
  name: string;
  stocks: NewsletterStockRow[];
  smaPeriod: number;
  unsubscribeUrl: string;
  viewOnlineUrl?: string;
  chartOrientation?: 'x' | 'y';
  openerSummary?: string;
  aiSummaries?: Record<string, string>;
  db: any;
}): Promise<boolean> {
  const { html, subject, text } = await buildNewsletterEmailHtml({ name, stocks, smaPeriod, unsubscribeUrl, viewOnlineUrl, chartOrientation, openerSummary, aiSummaries, db });
  return sendEmail({ to, subject, html, text });
}

/**
 * Strip HTML tags for text version
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}
