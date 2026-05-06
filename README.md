# DipFinder

Watchlist monitor that shows which stocks are trading furthest below their selected simple moving average. Deployed on Vercel with MongoDB Atlas for caching and user accounts.

## Local development

```bash
npm install
npm run local        # starts vercel dev on port 3000
npm run watch:css    # in a second terminal — rebuilds styles.css on every class change
```

Copy `.env.example` to `.env` (or set env vars in your shell) before starting:

| Variable | Description |
|---|---|
| `JWT_SECRET` | Secret for signing/verifying auth tokens |
| `MONGODB_URI` | MongoDB Atlas connection string |
| `EMAIL_USER` | SMTP sender address (password reset emails) |
| `EMAIL_PASS` | SMTP password |
| `TURNSTILE_SECRET` | Cloudflare Turnstile secret (registration captcha) |

## Build

```bash
npm run build        # TypeScript compile + Tailwind CSS
npm run build:css    # CSS only — regenerate styles.css from input.css
npm run watch:css    # CSS watch mode for active development
```

Tailwind scans `public/**/*.html` and `public/**/*.js` for class names and removes unused ones from the output. Run `build:css` (or keep `watch:css` running) after adding new utility classes — otherwise the new classes will be missing from `styles.css` and only visible in local dev if you notice the gap before deploying.

Tailwind class names must appear as complete strings in source files. Dynamically constructed class names (e.g. `'bg-' + color + '-100'`) will be silently dropped from the build output.

## Deploy

Push to `master` — Vercel auto-deploys. Set the env vars above in the Vercel project dashboard under Settings → Environment Variables.

## Project structure

```
api/
  batch-stocks.ts       POST /api/batch-stocks — fetch SMA data for a list of tickers
  stock-data/
    [symbol].ts         GET /api/stock-data — price, SMA, news, company name, fundamentals
  user.ts               auth: register, login, verify-token, password reset
  lib/
    auth.ts             bcrypt + JWT helpers
    mongodb.ts          MongoDB connection
    stocks.ts           calculateSma, calculateSmaTimeSeries, cache TTL constants
    email.ts            password reset email sender

public/
  index.html            SPA shell — nav, header, shared scripts
  app.js                SPA router (History API, page lifecycle)
  dipfinder.js          Dashboard page — watchlist, chart, news
  screener.js           Stock screener page
  auth.js               AuthManager (login state, token refresh)
  stock-autocomplete.js Ticker search autocomplete
  styles/
    input.css           Tailwind source — edit this, not styles.css
    styles.css          Generated output (do not edit by hand)
```

## Stock limits

- Guest: 5 stocks (enforced client-side and server-side in `/api/batch-stocks`)
- Authenticated: 8 stocks
- JWT tokens expire after 4 hours

## Auth security

- Passwords hashed with bcrypt (10 rounds)
- Progressive login lockout: 5 failed attempts → 15 min, 8 → 1 hr, 10+ → 4 hrs
- Password reset tokens are one-time use with a 5-minute minimum interval between requests
- Registration protected by Cloudflare Turnstile captcha
