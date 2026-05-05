// Test script for email functionality
// Run this to test the email service

import { sendPasswordChangeNotification, sendEmail } from './lib/email';

// Set to true to actually send emails, false for dry run
const SEND_REAL_EMAILS = false;

async function testEmailService() {
/*console.log('Testing email service...');*/ 
  
  if (!SEND_REAL_EMAILS) {
/*console.log('🔵 DRY RUN MODE - No emails will actually be sent');*/ 
/*console.log('✅ Email configuration test passed (dry run)');*/ 
    return;
  }
  
/*console.log('🔴 LIVE MODE - Real emails will be sent!');*/ 
  
  // Test basic email sending
  const basicEmailTest = await sendEmail({
    to: 'your-email@example.com', // Replace with your actual email for testing
    subject: 'DipFinder Email Test',
    html: '<h1>Email service is working!</h1><p>This is a test email from DipFinder.</p>'
  });
  
/*console.log('Basic email test result:', basicEmailTest);*/ 
  
  // Test password change notification
  const passwordChangeTest = await sendPasswordChangeNotification('your-email@example.com');
/*console.log('Password change notification test result:', passwordChangeTest);*/ 
  
  if (basicEmailTest && passwordChangeTest) {
/*console.log('✅ All email tests passed!');*/ 
  } else {
/*console.log('❌ Some email tests failed. Check your EMAIL_NOREPLY_API_KEY configuration.');*/ 
  }
}

// Run the test
testEmailService().catch(console.error);
