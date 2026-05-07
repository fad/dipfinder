// Email service for DipFinder notifications
// Using Resend API with EMAIL_NOREPLY_API_KEY

const RESEND_API_KEY = process.env.EMAIL_NOREPLY_API_KEY;
const FROM_EMAIL = 'noreply@dipfinder.com';

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
  const resetUrl = `${process.env.FRONTEND_URL || 'https://dipfinder.com'}/reset-password.html?token=${resetToken}`;
  const subject = 'Reset Your Password - DipFinder';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1a365d; margin: 0;">DipFinder</h1>
      </div>
      
      <div style="background-color: #f7fafc; padding: 20px; border-radius: 8px; border-left: 4px solid #4299e1;">
        <h2 style="color: #2d3748; margin-top: 0;">Password Reset Request</h2>
        <p style="color: #4a5568; line-height: 1.6;">
          We received a request to reset the password for your DipFinder account.
        </p>
        <p style="color: #4a5568; line-height: 1.6;">
          <strong>Account:</strong> ${email}
        </p>
      </div>
      
      <div style="margin-top: 30px; text-align: center;">
        <a href="${resetUrl}" 
           style="display: inline-block; background-color: #4299e1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Reset Your Password
        </a>
      </div>
      
      <div style="margin-top: 30px; padding: 20px; background-color: #fff5f5; border-radius: 8px; border-left: 4px solid #f56565;">
        <h3 style="color: #c53030; margin-top: 0;">Important</h3>
        <p style="color: #4a5568; line-height: 1.6;">
          • This link will expire in 1 hour<br>
          • If you didn't request this reset, please ignore this email<br>
          • For security, don't share this link with anyone
        </p>
      </div>
      
      <div style="margin-top: 30px; text-align: center; color: #718096; font-size: 14px;">
        <p>
          This is an automated email from DipFinder.<br>
          Please do not reply to this email.
        </p>
        <p style="margin-top: 10px;">
          Link not working? Copy and paste: ${resetUrl}
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

export interface NewsletterStockRow {
  symbol: string;
  companyName: string;
  currentPrice: number;
  sma: number;
  relativePrice: number;
  topNews?: { headline: string; url: string; source: string; datetime: number }[];
}

function generateBarChartUrl(stocks: NewsletterStockRow[]): string {
  const labels = stocks.map(s => s.symbol);
  const data = stocks.map(s => Math.round(s.relativePrice * 1000) / 10);
  const colors = stocks.map(s => s.relativePrice < 0 ? '#ef4444' : '#22c55e');

  const cfg = {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors }],
    },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { fontColor: '#475569', fontSize: 11 }, gridLines: { display: false } }],
        yAxes: [{ ticks: { fontColor: '#64748b', fontSize: 10 }, gridLines: { color: '#e2e8f0' } }],
      },
    },
  };

  return `https://quickchart.io/chart?w=556&h=200&bkg=%23ffffff&c=${encodeURIComponent(JSON.stringify(cfg))}`;
}

/**
 * Send weekly newsletter email with watchlist dip rankings
 */
export async function sendNewsletterEmail({
  to,
  name,
  stocks,
  smaPeriod,
  unsubscribeUrl,
}: {
  to: string;
  name: string;
  stocks: NewsletterStockRow[];
  smaPeriod: number;
  unsubscribeUrl: string;
}): Promise<boolean> {
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const shortDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const subject = `Your Weekly Dip Report — ${shortDate}`;

  const barChartUrl = generateBarChartUrl(stocks);

  const rows = stocks.map(s => {
    const pct = (s.relativePrice * 100).toFixed(1);
    const dipColor = s.relativePrice < 0 ? '#dc2626' : '#16a34a';
    const dipBg = s.relativePrice < 0 ? '#fef2f2' : '#f0fdf4';
    const sign = s.relativePrice > 0 ? '+' : '';
    return `<tr>
      <td style="padding:10px 14px; font-weight:700; color:#1e293b; border-bottom:1px solid #f1f5f9; white-space:nowrap;">${s.symbol}</td>
      <td style="padding:10px 14px; color:#64748b; font-size:0.85em; border-bottom:1px solid #f1f5f9;">${s.companyName}</td>
      <td style="padding:10px 14px; color:#1e293b; text-align:right; border-bottom:1px solid #f1f5f9; white-space:nowrap;">$${s.currentPrice.toFixed(2)}</td>
      <td style="padding:10px 14px; color:#64748b; text-align:right; border-bottom:1px solid #f1f5f9; white-space:nowrap;">$${s.sma.toFixed(2)}</td>
      <td style="padding:10px 14px; text-align:right; border-bottom:1px solid #f1f5f9; white-space:nowrap;">
        <span style="background:${dipBg}; color:${dipColor}; font-weight:700; font-size:0.82em; padding:3px 8px; border-radius:999px;">${sign}${pct}%</span>
      </td>
    </tr>`;
  }).join('');

  const newsCards = stocks.filter(s => s.topNews?.length).map(s => {
    const items = (s.topNews || []).map(n => `
      <a href="${n.url}" style="display:block; text-decoration:none; padding:10px 0; border-bottom:1px solid #f1f5f9;">
        <span style="font-size:0.78em; font-weight:600; color:#2563eb; text-transform:uppercase; letter-spacing:0.05em;">${n.source}</span>
        <p style="margin:3px 0 0; color:#1e293b; font-size:0.875em; line-height:1.4;">${n.headline}</p>
      </a>`).join('');

    const pct = (s.relativePrice * 100).toFixed(1);
    const dipColor = s.relativePrice < 0 ? '#dc2626' : '#16a34a';
    const sign = s.relativePrice > 0 ? '+' : '';

    return `
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; margin-bottom:12px; overflow:hidden;">
      <div style="padding:12px 16px; background:#f8fafc; border-bottom:1px solid #e2e8f0; display:flex; align-items:center;">
        <span style="font-weight:800; color:#1e293b; font-size:0.95em; margin-right:8px;">${s.symbol}</span>
        <span style="color:#64748b; font-size:0.8em; flex:1;">${s.companyName}</span>
        <span style="font-weight:700; color:${dipColor}; font-size:0.85em;">${sign}${pct}%</span>
      </div>
      <div style="padding:0 16px;">${items}</div>
    </div>`;
  }).join('');

  const html = `
<div style="font-family:system-ui,-apple-system,Arial,sans-serif; max-width:620px; margin:0 auto; background:#f8fafc;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#2563eb,#7c3aed); padding:28px 32px;">
    <h1 style="margin:0; font-size:1.5rem; color:#ffffff; font-weight:800; letter-spacing:-0.02em;">Dip Finder</h1>
    <p style="margin:6px 0 0; color:#bfdbfe; font-size:0.82em;">Weekly Dip Report &nbsp;·&nbsp; ${dateLabel}</p>
  </div>

  <!-- Body -->
  <div style="padding:28px 32px;">
    <p style="color:#475569; margin:0 0 24px; line-height:1.6; font-size:0.9em;">Hi ${name}, here are your watchlist stocks ranked by distance from their ${smaPeriod}-day SMA — biggest dips first.</p>

    <!-- Chart -->
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; margin-bottom:24px;">
      <img src="${barChartUrl}" width="556" height="200" alt="Watchlist dip chart" style="display:block;">
    </div>

    <!-- Table -->
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; margin-bottom:28px;">
      <table style="width:100%; border-collapse:collapse; font-size:0.875rem;">
        <thead>
          <tr style="background:#f8fafc; border-bottom:1px solid #e2e8f0;">
            <th style="padding:10px 14px; text-align:left; color:#94a3b8; font-weight:600; text-transform:uppercase; font-size:0.68em; letter-spacing:0.06em;">Ticker</th>
            <th style="padding:10px 14px; text-align:left; color:#94a3b8; font-weight:600; text-transform:uppercase; font-size:0.68em; letter-spacing:0.06em;">Company</th>
            <th style="padding:10px 14px; text-align:right; color:#94a3b8; font-weight:600; text-transform:uppercase; font-size:0.68em; letter-spacing:0.06em;">Price</th>
            <th style="padding:10px 14px; text-align:right; color:#94a3b8; font-weight:600; text-transform:uppercase; font-size:0.68em; letter-spacing:0.06em;">${smaPeriod}d SMA</th>
            <th style="padding:10px 14px; text-align:right; color:#94a3b8; font-weight:600; text-transform:uppercase; font-size:0.68em; letter-spacing:0.06em;">vs SMA</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${newsCards ? `
    <!-- News -->
    <h2 style="margin:0 0 14px; font-size:0.75em; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.08em;">This Week's News</h2>
    ${newsCards}` : ''}

    <!-- CTA -->
    <div style="margin-top:28px; text-align:center;">
      <a href="https://dipfinder.com/app" style="display:inline-block; background:linear-gradient(135deg,#2563eb,#7c3aed); color:#ffffff; padding:12px 32px; border-radius:8px; text-decoration:none; font-weight:700; font-size:0.9em; letter-spacing:0.01em;">Open Dip Finder ↗</a>
    </div>
  </div>

  <!-- Footer -->
  <div style="padding:16px 32px; background:#1e293b; text-align:center;">
    <p style="color:#64748b; font-size:0.73em; margin:0; line-height:1.7;">
      You're receiving this because you subscribed to the Dip Finder newsletter.<br>
      <a href="${unsubscribeUrl}" style="color:#94a3b8; text-decoration:underline;">Unsubscribe</a>
    </p>
  </div>

</div>`;

  return sendEmail({ to, subject, html });
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
