import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFileSync } from 'fs';
import { join } from 'path';
import { connectToDatabase } from './lib/mongodb';

function escAttr(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';

  // Read the static share.html as the base template
  let html: string;
  try {
    html = readFileSync(join(process.cwd(), 'public', 'share.html'), 'utf-8');
  } catch {
    return res.status(500).send('<p>Error loading page</p>');
  }

  // Defaults
  let title       = 'Shared Watchlist - Dip Finder';
  let description = 'See which stocks on this watchlist are trading below their moving average.';
  const image     = 'https://dipfinder.com/img/preview.png';
  const isShortToken = /^[A-Za-z0-9]{6}$/.test(token);
  const isLongToken  = /^[a-f0-9]{24}$/.test(token);
  const sharePrefix  = isShortToken ? '/s/' : '/share/';
  let canonical      = 'https://dipfinder.com' + sharePrefix + (token || '');

  // Try to personalise from DB
  if (token && (isShortToken || isLongToken)) {
    try {
      const db    = await connectToDatabase();
      const share = await db.collection('sharedWatchlists').findOne({ token });

      if (share) {
        const stocks: string[] = share.stocks || [];
        const shown  = stocks.slice(0, 6).join(', ');
        const more   = stocks.length > 6 ? ` +${stocks.length - 6} more` : '';

        title       = `${share.watchlistName} - shared by ${share.ownerName} on Dip Finder`;
        description = `${stocks.length} stocks tracked vs ${share.smaPeriod}-day SMA: ${shown}${more}. See which are dipping below their moving average.`;
        canonical   = `https://dipfinder.com${sharePrefix}${token}`;
      }
    } catch {
      // Fall through with defaults
    }
  }

  // Replace static OG / meta tags with dynamic values
  // Use named-placeholder approach: match up to the content= value, replace the whole tag
  const setMeta = (h: string, attr: string, name: string, val: string) =>
    h.replace(new RegExp(`(<meta\\s+${attr}="${name}"\\s+content=")[^"]*`), `$1${val}`);

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`);
  html = setMeta(html, 'name',     'description',        escAttr(description));
  html = setMeta(html, 'property', 'og:title',           escAttr(title));
  html = setMeta(html, 'property', 'og:description',     escAttr(description));
  html = setMeta(html, 'name',     'twitter:title',      escAttr(title));
  html = setMeta(html, 'name',     'twitter:description', escAttr(description));

  // Inject og:url, og:image, and twitter:image/card before </head>
  const extraMeta = [
    `<meta property="og:url" content="${escAttr(canonical)}">`,
    `<meta property="og:image" content="${escAttr(image)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${escAttr(image)}">`,
  ].join('\n    ');

  // Replace the existing twitter:card (summary → summary_large_image already covered above)
  html = html.replace(/<meta\s+name="twitter:card"\s+content="[^"]*">/, '');
  html = html.replace('</head>', `    ${extraMeta}\n</head>`);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res.status(200).send(html);
}
