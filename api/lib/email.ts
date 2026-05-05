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

    const result = await response.json();
/*console.log('Email sent successfully:', result.id);*/ 
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
