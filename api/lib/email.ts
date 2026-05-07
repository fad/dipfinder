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
}

function generateBarChartUrl(stocks: NewsletterStockRow[], smaPeriod: number): string {
  const labels = stocks.map(s => s.symbol);
  const data = stocks.map(s => Math.round(s.relativePrice * 1000) / 10);
  const colors = stocks.map(s => s.relativePrice < 0 ? '#f87171' : '#4ade80');

  const cfg = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderRadius: 4,
      }],
    },
    options: {
      scales: {
        x: {
          ticks: { color: '#94a3b8', font: { size: 11 } },
          grid: { display: false },
          border: { color: '#334155' },
        },
        y: {
          ticks: { color: '#94a3b8', font: { size: 10 }, callback: "function(v){return v+'%'}" },
          grid: { color: '#1e293b' },
          border: { color: '#334155' },
        },
      },
      plugins: { legend: { display: false } },
    },
  };

  return `https://quickchart.io/chart?w=556&h=220&bkg=%230f172a&c=${encodeURIComponent(JSON.stringify(cfg))}`;
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

  const barChartUrl = generateBarChartUrl(stocks, smaPeriod);

  const rows = stocks.map(s => {
    const pct = (s.relativePrice * 100).toFixed(1);
    const color = s.relativePrice < 0 ? '#f87171' : '#4ade80';
    const sign = s.relativePrice > 0 ? '+' : '';
    return `<tr>
      <td style="padding:10px 14px; font-weight:700; color:#f1f5f9; border-bottom:1px solid #1e293b;">${s.symbol}</td>
      <td style="padding:10px 14px; color:#94a3b8; font-size:0.85em; border-bottom:1px solid #1e293b;">${s.companyName}</td>
      <td style="padding:10px 14px; color:#e2e8f0; text-align:right; border-bottom:1px solid #1e293b;">$${s.currentPrice.toFixed(2)}</td>
      <td style="padding:10px 14px; color:#e2e8f0; text-align:right; border-bottom:1px solid #1e293b;">$${s.sma.toFixed(2)}</td>
      <td style="padding:10px 14px; text-align:right; font-weight:700; color:${color}; border-bottom:1px solid #1e293b;">${sign}${pct}%</td>
    </tr>`;
  }).join('');

  const html = `
<div style="font-family:system-ui,Arial,sans-serif; max-width:620px; margin:0 auto; background:#0f172a; color:#e2e8f0; border-radius:12px; overflow:hidden; border:1px solid #1e293b;">
  <div style="padding:24px 32px; background:#1e293b; border-bottom:1px solid #334155;">
    <h1 style="margin:0; font-size:1.4rem; color:#f8fafc; font-weight:800;">Dip Finder</h1>
    <p style="margin:4px 0 0; color:#94a3b8; font-size:0.82em;">Weekly Dip Report &nbsp;·&nbsp; ${dateLabel}</p>
  </div>

  <div style="padding:28px 32px;">
    <p style="color:#cbd5e1; margin:0 0 20px; line-height:1.5;">Hi ${name}, here are your watchlist stocks ranked by distance from their ${smaPeriod}-day SMA — biggest dips first.</p>

    <div style="margin-bottom:24px; border-radius:8px; overflow:hidden; border:1px solid #1e293b;">
      <img src="${barChartUrl}" width="556" height="220" alt="Watchlist dip chart" style="display:block;">
    </div>

    <table style="width:100%; border-collapse:collapse; font-size:0.875rem; background:#0f172a; border-radius:8px; overflow:hidden; border:1px solid #1e293b;">
      <thead>
        <tr style="background:#1e293b;">
          <th style="padding:8px 14px; text-align:left; color:#64748b; font-weight:600; text-transform:uppercase; font-size:0.7em; letter-spacing:0.05em;">Ticker</th>
          <th style="padding:8px 14px; text-align:left; color:#64748b; font-weight:600; text-transform:uppercase; font-size:0.7em; letter-spacing:0.05em;">Company</th>
          <th style="padding:8px 14px; text-align:right; color:#64748b; font-weight:600; text-transform:uppercase; font-size:0.7em; letter-spacing:0.05em;">Price</th>
          <th style="padding:8px 14px; text-align:right; color:#64748b; font-weight:600; text-transform:uppercase; font-size:0.7em; letter-spacing:0.05em;">${smaPeriod}d SMA</th>
          <th style="padding:8px 14px; text-align:right; color:#64748b; font-weight:600; text-transform:uppercase; font-size:0.7em; letter-spacing:0.05em;">vs SMA</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <div style="margin-top:28px; text-align:center;">
      <a href="https://dipfinder.com/app" style="display:inline-block; background:#38bdf8; color:#0f172a; padding:11px 28px; border-radius:7px; text-decoration:none; font-weight:700; font-size:0.9em;">Open Dip Finder ↗</a>
    </div>
  </div>

  <div style="padding:16px 32px; background:#1e293b; border-top:1px solid #334155; text-align:center;">
    <p style="color:#475569; font-size:0.75em; margin:0; line-height:1.6;">
      You're receiving this because you subscribed to the Dip Finder newsletter.<br>
      <a href="${unsubscribeUrl}" style="color:#64748b; text-decoration:underline;">Unsubscribe</a>
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
