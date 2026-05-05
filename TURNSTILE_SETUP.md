# Cloudflare Turnstile CAPTCHA Setup

## Overview
The application has been migrated from hCaptcha to Cloudflare Turnstile for better reliability and user experience.

## Current Configuration

### Frontend (Test Keys)
- **Site Key**: `1x00000000000000000000AA` (Test key - always passes)
- **Pages**: `index.html`, `screener.html`
- **Integration**: Handled in `auth.js` with global callback functions

### Backend 
- **Secret Key Environment Variable**: `TURNSTILE_SECRET_KEY`
- **Test Secret Key**: `1x0000000000000000000000000000000AA` (corresponds to test site key)
- **Verification Endpoint**: `https://challenges.cloudflare.com/turnstile/v0/siteverify`

## Production Setup

### 1. Get Cloudflare Turnstile Keys
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to Turnstile section
3. Create a new site
4. Get your site key and secret key

### 2. Update Environment Variables
Add to your `.env` file:
```
TURNSTILE_SECRET_KEY=your_actual_secret_key_here
```

### 3. Update Frontend
Replace the test site key in `index.html` and `screener.html`:
```html
<div class="cf-turnstile" data-sitekey="your_actual_site_key_here"
     data-callback="onTurnstileSuccess" data-expired-callback="onTurnstileExpired"></div>
```

## Test vs Production Keys

### Test Keys (Currently Used)
- **Site Key**: `1x00000000000000000000AA`
- **Secret Key**: `1x0000000000000000000000000000000AA`
- **Behavior**: Always passes validation (for testing)

### Production Keys
- Must be obtained from Cloudflare Turnstile dashboard
- Validate real user interactions
- Required for production deployment

## Integration Details

### Frontend (`auth.js`)
- Checks `turnstile.getResponse()` for token
- Resets widget with `turnstile.reset()`
- Sends token as `captchaToken` in API requests

### Backend (`api/user.ts`)
- Validates token using Cloudflare's verification endpoint
- Required for login, register, and forgot password actions
- Returns validation errors if CAPTCHA fails

## Benefits of Turnstile
- Free Cloudflare service
- Better user experience (often invisible)
- More reliable than other CAPTCHA providers
- Privacy-focused approach
