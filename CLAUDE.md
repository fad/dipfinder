# Project: DipFinder

DipFinder is a stock watchlist monitor that ranks user-selected equities by how far each is trading below its Simple Moving Average (SMA). The core idea: you pick the stocks you'd buy — DipFinder tells you when they're "on sale" relative to their long-term trend. Users get a color-coded dashboard, a detailed screener with price/SMA charts and news, and a weekly email digest. The app runs as a Vercel-deployed SPA with TypeScript serverless functions and MongoDB Atlas for persistence and caching.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Vercel Functions (Node.js, TypeScript) |
| Frontend | Vanilla JS + HTML + Tailwind CSS + Chart.js 3.x |
| Database | MongoDB Atlas (users, caching) |
| Email | Resend API (`noreply@dipfinder.com`) |
| Chart images | QuickChart.io (Chart.js **2.x** syntax — see Gotchas) |
| Price data | Yahoo Finance (`query1.finance.yahoo.com`) — no key needed |
| News data | Finnhub API (key required) |
| AI summaries | Anthropic API — Claude Haiku (`claude-haiku-4-5-20251001`) — key required |
| CAPTCHA | Cloudflare Turnstile |
| CSS build | Tailwind CLI |
| Deployment | `git push master` → Vercel auto-deploy |

## Architecture

```
public/               ← Frontend SPA
  app.html            ← SPA shell (loads for /app, /screener, /profile)
  *-content.html      ← Content fragments, dynamically loaded by router.js
  dipfinder.js        ← Dashboard page: watchlist table + bar chart
  screener.js         ← Screener page: price/SMA chart + news
  router.js           ← History API SPA router
  auth.js             ← AuthManager singleton (token validation, UI state)
  app.js              ← SPA lifecycle, nav, theme toggle
  start.html/js       ← Landing page (separate from SPA shell)
  styles/input.css    ← Tailwind source ← EDIT THIS
  styles/styles.css   ← Generated output ← DO NOT EDIT

api/                  ← Serverless functions (one file = one route, 11 total — Hobby plan limit is 12)
  lib/
    mongodb.ts        ← Singleton DB connection (globalThis caching)
    auth.ts           ← bcrypt + JWT helpers
    email.ts          ← Resend API + all email templates + newsletter HTML builder
    newsletter-data.ts← buildStockResults(), fetchStockData(), fetchNewsForSymbol()
    stocks.ts         ← calculateSma(), calculateSmaTimeSeries(), cache TTL constants
    tickers.ts        ← upsertTicker(), markTickerFailed(), getActiveTickers()
    ai-summaries.ts   ← generateAiSummary(), upsertAiSummary(), getApprovedSummaries()
  user.ts             ← Auth: login, register, password reset, profile, captcha
  watchlist.ts        ← GET/POST watchlist (also saves smaPeriod, chartOrientation)
  batch-stocks.ts     ← POST: multi-stock SMA fetch for dashboard; GET ?action=tickers for autocomplete
  stock-data.ts       ← All per-stock data: price+SMA (Yahoo→Finnhub fallback), news, fundamentals
  newsletter-send.ts  ← 3 cron triggers (Sat 23:00, Sun 07:00, Sun 14:00 UTC) + admin preview
  newsletter.ts       ← GET ?action=view (tokenized view-online) + ?action=unsubscribe
  newsletter-onboarding.ts ← Daily cron (10:00 UTC): sends welcome email to new brief subscribers
  newsletter-snapshot.ts ← Weekly cron (Saturday 23:00 UTC): snapshots each user's watchlist SMA status into weeklySnapshots collection for opener delta computation; also generates AI summaries for unique symbols via Claude Haiku and stores them in aiSummaries (reviewed:false)
  admin.ts            ← Admin: list users, template management, cron triggers
  health-check.ts     ← System health check (MongoDB, Yahoo, Finnhub, Resend) + ping
  morning-report.ts   ← Daily cron (07:00 UTC): emails admin a summary of user counts, subscriber totals, cron last-run statuses

scripts/
  setup-indexes.js    ← One-time MongoDB index creation (run once per environment)
```

**Data flow — dashboard:**
`dipfinder.js` → POST `/batch-stocks` → `batch-stocks.ts` checks memory cache → MongoDB `dashboardStocks` cache → Yahoo Finance → returns ranked list → Chart.js bar chart + table render.

**Data flow — stock price:**
`stock-data.ts` → check MongoDB `stocks` cache → miss: try Yahoo Finance → fail: try Finnhub `/stock/candle` → fail: `markTickerFailed()` + 404. On success: `upsertTicker()` (self-learning autocomplete) + cache result.

**Data flow — newsletter:**
3 Vercel crons (Sat 23:00, Sun 07:00, Sun 14:00 UTC) → `newsletter-send.ts` → fetches admin-approved AI summaries from `aiSummaries` collection → for each `sundayBriefSubscribed` user, checks `isTimeToSend(user.timezone)` (Sunday 6-10am in user's local time) and `lastNewsletterSentAt` (skip if sent within 7 days) → `buildStockResults()` (Yahoo Finance + Finnhub, cached in MongoDB) → `buildNewsletterEmailHtml()` (checks DB for `sunday-brief` template, falls back to hardcoded; injects approved AI summaries into news block) → Resend API. View-online link points to `/newsletter/:token` → `newsletter.ts?action=view`.

**Data flow — AI summaries (Saturday night):**
`newsletter-snapshot.ts` cron → after saving weekly snapshots, collects unique symbols across all subscribers → for each symbol without a summary this week, fetches cached Finnhub news headlines → calls Claude Haiku via `generateAiSummary()` → stores in `aiSummaries` with `reviewed:false`. Admin opens "AI Summaries" tab in admin panel, reviews each summary (Approve / Edit+Approve / Reject), then the Sunday send picks up only approved ones. Stocks without an approved summary fall back to raw Finnhub headlines.

**MongoDB collections:**

| Collection | Purpose | TTL |
|---|---|---|
| `users` | Auth, watchlist, preferences, subscription flags | permanent |
| `tickers` | Self-learning autocomplete — upserted on every successful stock fetch | permanent |
| `stocks` | Yahoo/Finnhub price+OHLC cache | 2h (MongoDB TTL index) |
| `dashboardStocks` | Batch dashboard price/SMA cache | 2h (MongoDB TTL index) |
| `smaTimeseries` | SMA chart series cache | 2h (MongoDB TTL index) |
| `news` | Finnhub news cache | 6h (MongoDB TTL index) |
| `fundamentals` | Finnhub fundamentals cache | 7d (MongoDB TTL index) |
| `companyNames` | Finnhub company name cache | 7d (MongoDB TTL index) |
| `emailTemplates` | Editable email templates — auto-seeded on first use | permanent |
| `weeklySnapshots` | Per-user watchlist SMA snapshot (Saturday night) — powers opener delta logic | permanent (keep last 2 per user) |
| `aiSummaries` | Per-symbol AI news summaries (Saturday night) — admin reviews before Sunday send | permanent (weekly cadence, small) |
| `settings` | Key-value store: app config + cron last-run tracking | permanent |

TTL indexes are live on Atlas — MongoDB auto-deletes expired docs. App-level TTL checks at read time provide an additional fast-path guard.

**`users` document shape:**
```
email, password (bcrypt hash), name
createdDate: date
timezone: string (IANA, e.g. 'America/New_York') ← controls Sunday Brief delivery window
watchlist: string[]
smaPeriod: number
chartOrientation: 'x'|'y'
newsletterSubscribed: bool
sundayBriefSubscribed: bool
sundayBriefSubscribedAt: date
onboardingEmailSentAt: date
lastNewsletterSentAt: date  ← prevents double-send across cron windows
isPro: bool
namedWatchlists, activeWatchlistId   ← pro features
failedLoginAttempts, accountLockedUntil  ← brute-force lockout
termsAccepted: bool, termsAcceptedDate: date
```

**`tickers` document shape:**
```
ticker: string (uppercase, unique)
name: string
active: bool          ← set false after 3 consecutive Yahoo/Finnhub failures
failCount: number
lastSeen: date
source: 'seed'|'user'
```

## Key files & entry points

Read these first:

1. `vercel.json` — all routes, rewrites, cron schedule, security headers
2. `api/lib/email.ts` — newsletter HTML builder (`buildNewsletterHtml`), all email templates, QuickChart integration
3. `api/lib/newsletter-data.ts` — `buildStockResults()` is the core data pipeline
4. `api/batch-stocks.ts` — dashboard data fetch with two-level caching (memory + MongoDB)
5. `public/dipfinder.js` — dashboard render, chart orientation toggle, SMA period persistence
6. `public/screener.js` — race-condition-safe stock loading, timeframe slicing, chart lifecycle
7. `public/auth.js` — AuthManager: token state, guest vs. authenticated UI, `window.MAX_STOCKS`
8. `api/user.ts` — all auth endpoints: login lockout logic, password reset flow, captcha

## Conventions

**File naming:** kebab-case for everything. API files map 1:1 to routes. Shared utilities live in `api/lib/`.

**Frontend modules:** No bundler. Each page has a corresponding `.js` file. The SPA shell (`app.html`) loads global scripts; page-specific scripts are loaded via `<script>` tags in the content HTML fragments. Functions that need to be callable from inline `onclick` must be on `window.*`.

**Secrets:** All loaded via `process.env.*`. Pattern at top of each API file:
```ts
if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set');
const JWT_SECRET = process.env.JWT_SECRET as string;
```
See `.env.example` for all required vars.

**Error handling:** API functions return `res.status(4xx/5xx).json({ error: '...' })` for JSON endpoints, `res.status(...).send('<p>...</p>')` for HTML endpoints. `try/catch` at the handler level with `console.error()` logging.

**TypeScript:** Strict mode. `tsconfig.json` targets ES2020, outputs to `dist/`. Type checking only — no runtime transpilation in Vercel (functions are compiled on deploy).

**CSS:** Edit `public/styles/input.css`. Run `npm run build:css` to regenerate `styles/styles.css`. Tailwind scans `public/**/*.html` and `public/**/*.js` — Tailwind class names must be complete strings (no string concatenation or dynamic construction).

**Caching:** Two-level: `globalThis._*` in-memory (survives warm serverless invocations) + MongoDB TTL documents. Pattern: check memory → check DB → fetch upstream → write to both.

**Commit style:** Plain English, imperative, short. No conventional commits prefix. Co-authored with Claude on many recent commits.

**Git workflow:** After every change, commit and push to `origin master`. Do not leave changes uncommitted. Vercel auto-deploys on push.

**No test suite.** `npm test` runs `tsc --noEmit` (type check only).

## Common tasks

```bash
# Install deps
npm install

# Local dev (Vercel dev server, port 3000)
npm run local

# Watch CSS (run in a second terminal alongside local dev)
npm run watch:css

# Type check
npm run check         # or: npm test

# Build (TS compile + CSS)
npm run build

# Build CSS only
npm run build:css

# Deploy
git push origin master   # Vercel auto-deploys on push to master

# Trigger newsletter manually (admin JWT required)
curl -X POST https://dipfinder.com/api/newsletter-send \
  -H "Authorization: Bearer <admin-jwt>"

# Preview newsletter as HTML (admin JWT)
curl "https://dipfinder.com/api/newsletter-send?preview=true" \
  -H "Authorization: Bearer <admin-jwt>"

# Trigger newsletter via cron secret
curl -X POST https://dipfinder.com/api/newsletter-send \
  -H "Authorization: Bearer <CRON_SECRET>"

# Health check
curl https://dipfinder.com/api/check

# Create all MongoDB indexes (run once per environment — safe to re-run)
MONGODB_URI=<uri> MONGODB_DB=<db> npm run setup-indexes
```

## SOPs

### Writing copy

Always use a regular hyphen (`-`) instead of an em dash (`—`) in all user-facing text. No exceptions — apply this when writing or editing any copy in HTML, JS, or email templates.

### Email theme

All transactional emails share a single branded shell built by `buildEmailHtml(bodyHtml, footerHtml?)` in `api/lib/email.ts`. The shell has:
- **Header**: gradient banner (`#2563EB → #4F46E5 → #7C3AED`) with logo image + "Dip Finder" wordmark, centered
- **Body area**: white card with 36px padding, `font-family: Arial, Helvetica, sans-serif`
- **Footer**: `#94A3B8` small text, border-top separator
- **Wrapper background**: `#F1F5F9` slate-100

Body copy style: `font-size:15px; color:#374151; line-height:1.75`  
CTA buttons: `background: linear-gradient(135deg,#2563EB,#4F46E5); color:#FFFFFF; padding:14px 32px; border-radius:8px; font-weight:700`  
Warning/notice boxes: `background:#FEF9C3; border-left:4px solid #EAB308`

**Template variable substitution**: use `{{varName}}` placeholders in HTML (e.g. `{{name}}`, `{{resetUrl}}`, `{{magicUrl}}`). `renderTemplate(html, vars)` replaces them at send time. **All user-supplied values (name, email) must be wrapped in `escapeHtml()` before being passed to `renderTemplate()` or interpolated into HTML strings.** Pre-built HTML blocks (chart images, table HTML) must NOT be escaped.

**DB-backed templates**: templates are stored in the MongoDB `emailTemplates` collection (key, name, subject, html, updatedAt). `getEmailTemplate(db, key)` auto-seeds the default if no DB record exists. Admin can edit all templates in the "Email Templates" tab of the admin panel. When updating the visual theme, update `buildEmailHtml` in `email.ts` AND delete the affected DB docs so they re-seed with the new shell next time (or resave via admin panel).

**Known templates** (keys): `onboarding`, `password-reset`, `magic-link`

### Adding a new API endpoint

1. Create `api/<name>.ts` with a default export `handler(req, res)`.
2. Add auth guard at top (JWT verify or cron secret check as appropriate).
3. Add route rewrite in `vercel.json` if the public URL differs from `/api/<name>`.
4. Add security headers in `vercel.json` `headers` array if needed.
5. Run `npm run check` to confirm types pass.
6. Test locally with `npm run local`.

### Debugging a failed newsletter send

1. Check Vercel function logs for the Sat 23:00, Sun 07:00, or Sun 14:00 UTC invocations of `newsletter-send`.
2. Confirm `EMAIL_NOREPLY_API_KEY` is valid — check Resend dashboard for bounces/errors.
3. Check `CRON_SECRET` matches what Vercel sends as the `Authorization: Bearer` header.
4. Try admin preview endpoint (`?preview=true`) to isolate whether the issue is data or sending.
5. If preview HTML renders but send fails: Resend API issue.
6. If preview returns 404/empty: admin user doc doesn't match criteria (not subscribed, empty watchlist).
7. If a subscriber isn't getting mail: check `sundayBriefSubscribed: true`, non-empty `watchlist`, correct `timezone`, and `lastNewsletterSentAt` (if set within the last 7 days they'll be skipped).

### Rolling back a bad deploy

1. In Vercel dashboard → Deployments → find last known-good deployment → "Promote to Production".
2. Or: `git revert HEAD && git push origin master` to trigger a new clean deploy.
3. Do NOT force-push master.

### Investigating a dip-detection false positive

1. Check the stock's Yahoo Finance data directly: `GET /stocks/<SYMBOL>` (action=price).
2. Verify the SMA calculation: `GET /sma/<SYMBOL>` — confirm the period matches what the user has set.
3. Check `dashboardStocks` MongoDB collection for stale cache (TTL = 30 min). Delete the doc to force a fresh fetch.
4. Confirm Yahoo Finance returned a full `closes` array (≥ smaPeriod values). Insufficient history returns `sma: null`.

### Cache purge SOP

Cache collections (`stocks`, `dashboardStocks`, `smaTimeseries`, `news`, `fundamentals`, `companyNames`) use `timestamp: new Date()` (BSON Date) on every write. MongoDB TTL indexes on the live Atlas cluster auto-delete expired documents. App-level TTL checks at read time provide a fast-path guard so warm-cache reads never see stale data even before MongoDB's background reaper runs.

**Active TTLs:** stocks/dashboard/SMA = 2h, news = 6h, fundamentals/companyNames = 7d.

To force a manual cache clear (e.g. bad data stuck in cache): use Admin panel → "Clear Stock Cache", or delete documents directly in Atlas.

### MongoDB indexes

Indexes are defined in `scripts/setup-indexes.js`. Run once per environment after provisioning:
```bash
MONGODB_URI=<uri> MONGODB_DB=<db> npm run setup-indexes
```
Safe to re-run — existing indexes are skipped. Covers: `users.email` (unique), `users.newsletterSubscribed`, `users.sundayBriefSubscribed`, `cacheKey` (unique) on all cache collections, `tickers.ticker` (unique), `tickers.active`, `settings.key`, `emailTemplates.key`.

### Newsletter send — all subscribers

`newsletter-send.ts` queries `{ sundayBriefSubscribed: true }` for live sends. Each user is then filtered by `isTimeToSend(user.timezone)` — Sunday 6-10am in their local timezone — and `lastNewsletterSentAt` (skip if already sent this week). Three cron windows cover the globe:

| Cron (UTC) | Regions reached |
|---|---|
| Saturday 23:00 | Asia/Pacific (UTC+8 to +11) |
| Sunday 07:00 | Europe/Africa (UTC+0 to +3), UTC fallback |
| Sunday 14:00 | Americas (UTC-8 to -4) |

Users without a stored timezone default to UTC (Sunday 07:00 window). Preview (`?preview=true`) always uses the admin user regardless of timezone/subscription. A 300ms delay between sends respects Resend's free-plan rate limit (100 emails/day, 3,000/month).

## Gotchas

**QuickChart uses Chart.js 2.x syntax.** Horizontal bars require `type: 'horizontalBar'` (not `indexAxis: 'y'`). Axes are `xAxes`/`yAxes` arrays, not `x`/`y` objects. This affects `generateBarChartUrl()` in `api/lib/email.ts`.

**Yahoo Finance price data is capped at ~18 months.** `range=18mo` is the max for `action=price`. Max timeframe on the screener chart shows ~18 months of data, not all-time. 2Y/5Y ranges were removed because Yahoo doesn't return them.

**`styles/styles.css` is generated.** Always edit `public/styles/input.css`. Running `npm run build:css` overwrites `styles/styles.css` entirely.

**Newsletter sends to all `sundayBriefSubscribed: true` users.** Preview (`?preview=true`) uses admin user only. Resend free plan: 100 emails/day, 3,000/month — 300ms delay between sends is built in.

**Serverless cold starts and MongoDB.** `connectToDatabase()` in `api/lib/mongodb.ts` caches the connection in `globalThis`. A ping verifies the connection is alive before reuse. Race condition possible if two cold starts hit simultaneously — TODO: add mutex lock (flagged in security audit).

**JWT tokens expire in 4 hours.** The client-side `auth.js` reads expiry from the token payload and calls `checkAuthStatus()` which hits `/api/user?action=verify-token` to confirm server-side validity.

**Guest stock limit (5) is enforced client-side** via `window.MAX_STOCKS` set by `auth.js`. The server-side limit in `watchlist.ts` is 10 (authenticated). Don't rely on the guest limit for security.

**Turnstile CAPTCHA bypass is still live in `api/user.ts`.** A Cloudflare test key (`1x0000000000000000000000000000000AA`) is hardcoded as an accepted secret, which means anyone who sends that key bypasses captcha. This is a known security hole — remove it before newsletter expansion increases sign-up traffic.

**`window.*` for SPA onclick handlers.** Functions called from inline `onclick` in content HTML fragments must be explicitly assigned to `window` inside the JS module scope (e.g., `window.applyTimeframe = applyTimeframe` in `screener.js`).

**Screener canvas race condition.** Always use `destroyScreenerChart()` helper (not inline `.destroy()`) and the `currentLoadId` pattern when loading stock data asynchronously. See `screener.js` for the established pattern.

**MongoDB `timestamp` fields in cache collections are stored as BSON Date.** TTL indexes are live on Atlas — run `npm run setup-indexes` if provisioning a new environment. App-level TTL checks coerce Date to ms via arithmetic, so both layers work correctly.

## What "done" looks like

- `npm run check` passes with no type errors
- `npm run build:css` run if any HTML/JS class names changed
- Tested locally via `npm run local`
- For newsletter changes: admin preview endpoint (`?preview=true`) verified visually
- For auth changes: login, register, and token expiry flows verified manually
- No new inline `<style>` or `<script>` blocks in HTML files — extract to `.css`/`.js` files
- No secrets committed (check `.env.example` for the list of what's expected)

## Maintaining this file

When you (Claude) make a change that affects architecture, commands, gotchas, or SOPs — update this file in the same change. Don't wait to be asked. If a section becomes wrong, fixing it is part of the task.


