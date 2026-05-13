import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, escapeHtml } from '../api/lib/email.js';
import { filterEarningsByWatchlist, type EarningsItem } from '../api/lib/newsletter-data.js';
import { getISOWeekKey } from '../api/lib/macro-recap.js';

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {

  it('escapes ampersand', () => {
    assert.equal(escapeHtml('AT&T'), 'AT&amp;T');
  });

  it('escapes less-than and greater-than', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  });

  it('escapes double quotes', () => {
    assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  });

  it('escapes single quotes', () => {
    assert.equal(escapeHtml("it's"), 'it&#39;s');
  });

  it('escapes all special chars in one string', () => {
    assert.equal(escapeHtml(`<b class="x">O'Neil & Co</b>`), '&lt;b class=&quot;x&quot;&gt;O&#39;Neil &amp; Co&lt;/b&gt;');
  });

  it('returns plain text unchanged', () => {
    assert.equal(escapeHtml('Hello world'), 'Hello world');
  });

  it('returns empty string unchanged', () => {
    assert.equal(escapeHtml(''), '');
  });

});

// ── renderTemplate ────────────────────────────────────────────────────────────

describe('renderTemplate', () => {

  it('replaces a single literal placeholder', () => {
    assert.equal(renderTemplate('Hello {{name}}!', { name: 'Frank' }), 'Hello Frank!');
  });

  it('replaces multiple different placeholders', () => {
    const result = renderTemplate('Hi {{name}}, your SMA is {{smaPeriod}}.', { name: 'Frank', smaPeriod: '50' });
    assert.equal(result, 'Hi Frank, your SMA is 50.');
  });

  it('replaces the same placeholder multiple times', () => {
    const result = renderTemplate('{{name}} {{name}}', { name: 'Frank' });
    assert.equal(result, 'Frank Frank');
  });

  it('replaces WYSIWYG HTML-encoded placeholders (&#123;&#123;var&#125;&#125;)', () => {
    const html = 'Hello &#123;&#123;name&#125;&#125;!';
    assert.equal(renderTemplate(html, { name: 'Frank' }), 'Hello Frank!');
  });

  it('replaces both literal and HTML-encoded placeholders in the same template', () => {
    const html = '{{greeting}} &#123;&#123;name&#125;&#125;';
    assert.equal(renderTemplate(html, { greeting: 'Hi', name: 'Frank' }), 'Hi Frank');
  });

  it('replaces missing placeholder with empty string', () => {
    assert.equal(renderTemplate('Hello {{missing}}!', {}), 'Hello !');
  });

  it('leaves unrelated HTML intact', () => {
    const html = '<p style="color:red;">{{name}}</p>';
    assert.equal(renderTemplate(html, { name: 'Frank' }), '<p style="color:red;">Frank</p>');
  });

  it('handles empty template', () => {
    assert.equal(renderTemplate('', { name: 'Frank' }), '');
  });

  it('handles template with no placeholders', () => {
    assert.equal(renderTemplate('<p>No vars here.</p>', { name: 'Frank' }), '<p>No vars here.</p>');
  });

});

// ── filterEarningsByWatchlist ─────────────────────────────────────────────────

function earning(symbol: string): EarningsItem {
  return { symbol, date: '2026-05-15', hour: 'amc', name: symbol };
}

describe('filterEarningsByWatchlist', () => {

  it('returns only earnings for symbols on the watchlist', () => {
    const all = [earning('AAPL'), earning('MSFT'), earning('GOOG')];
    const result = filterEarningsByWatchlist(all, ['AAPL', 'GOOG']);
    assert.deepEqual(result.map(e => e.symbol), ['AAPL', 'GOOG']);
  });

  it('returns empty array when no watchlist symbols match', () => {
    const all = [earning('AAPL'), earning('MSFT')];
    const result = filterEarningsByWatchlist(all, ['TSLA']);
    assert.deepEqual(result, []);
  });

  it('returns empty array for empty earnings list', () => {
    assert.deepEqual(filterEarningsByWatchlist([], ['AAPL']), []);
  });

  it('returns empty array for empty watchlist', () => {
    assert.deepEqual(filterEarningsByWatchlist([earning('AAPL')], []), []);
  });

  it('is case-insensitive — matches lowercase watchlist against uppercase symbols', () => {
    const all = [earning('AAPL')];
    const result = filterEarningsByWatchlist(all, ['aapl']);
    assert.equal(result.length, 1);
  });

});

// ── getISOWeekKey ─────────────────────────────────────────────────────────────

describe('getISOWeekKey', () => {

  it('returns correct key for a known Monday', () => {
    // 2026-05-11 is a Monday — W20
    assert.equal(getISOWeekKey(new Date('2026-05-11T00:00:00Z')), '2026-W20');
  });

  it('returns same week key for all days in the same ISO week', () => {
    const days = ['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-16', '2026-05-17'];
    const keys = days.map(d => getISOWeekKey(new Date(`${d}T12:00:00Z`)));
    assert.ok(keys.every(k => k === '2026-W20'), `Expected all W20, got: ${keys.join(', ')}`);
  });

  it('week boundary: Sunday 2026-05-10 belongs to W19 (prior week)', () => {
    assert.equal(getISOWeekKey(new Date('2026-05-10T12:00:00Z')), '2026-W19');
  });

  it('returns correct key for Jan 1 that belongs to prior year week (ISO edge case)', () => {
    // 2016-01-01 is a Friday — belongs to 2015-W53
    assert.equal(getISOWeekKey(new Date('2016-01-01T12:00:00Z')), '2015-W53');
  });

  it('pads single-digit week numbers with a leading zero', () => {
    // 2026-01-05 is W02
    assert.match(getISOWeekKey(new Date('2026-01-05T12:00:00Z')), /W\d{2}$/);
  });

  it('format is always YYYY-WNN', () => {
    const key = getISOWeekKey(new Date('2026-05-13T12:00:00Z'));
    assert.match(key, /^\d{4}-W\d{2}$/);
  });

});
