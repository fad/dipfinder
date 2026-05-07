// dipfinder.js — Dashboard: data helpers, display helpers, lifecycle + chart wiring

// ── Shared globals (var so other scripts can access via window scope) ─────────
var stocks = [];  // populated from localStorage in initializeDipfinder
var chart;        // Chart.js instance; created/destroyed in renderDashboardData
var chartOrientation = 'y'; // 'y' = horizontal bars, 'x' = vertical bars
var lastRenderCache = { data: null, period: null, tableBody: null };
var newsCache = {};  // ticker → articles[], kept in sync with add/remove

window.MAX_STOCKS = 10; // default, updated by auth.js

// ── SPA lifecycle state ───────────────────────────────────────────────────────
let dipfinderAuthCheckInterval;
let dipfinderLocalStorageCheckInterval;
let dipfinderEventListeners = [];
let dipfinderAutocompleteInstance = null;

window.dipfinderContentCache = window.dipfinderContentCache || {
    stocksTableHtml: null,
    chartData: null,
    newsFeedHtml: null,
    isInitialized: false,
    lastUpdated: null
};

// ── API fetch helpers ─────────────────────────────────────────────────────────

const BASE_URL = window.location.origin;
const DASHBOARD_CACHE_TTL = 15 * 60 * 1000;

function stockDataUrl(stock, params = {}) {
    const urlParams = new URLSearchParams({ symbol: stock, ...params });
    return `${BASE_URL}/api/stock-data?${urlParams.toString()}`;
}

async function fetchStockData(stock) {
    let response;
    try {
        response = await fetch(stockDataUrl(stock, { action: 'price' }));
        if (!response.ok) {
            throw new Error(`Error fetching data for ${stock}: ${response.statusText}`);
        }
        const data = await response.json();
        if (data.error) return null;
        return data;
    } catch (error) {
        console.error(`Error fetching data for ${stock}: ${response ? response.statusText : 'No response'} Error: ${error}`);
        return null;
    }
}

async function fetchSMA(stock, period) {
    const response = await fetch(stockDataUrl(stock, { action: 'sma', period }));
    const data = await response.json();
    return data;
}

async function fetchCompanyName(stock) {
    const response = await fetch(stockDataUrl(stock, { action: 'company-name' }));
    const data = await response.json();
    return data.name;
}

async function fetchNews(stock) {
    try {
        const response = await fetch(stockDataUrl(stock, { action: 'news' }));
        if (!response.ok) {
            throw new Error(`Error fetching news for ${stock}: ${response.statusText}`);
        }
        const data = await response.json();
        return data.news;
    } catch (error) {
        console.error(error);
        return [];
    }
}

async function fetchBatchStockSMA(stocks, period) {
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('token');
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE_URL}/api/batch-stocks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ stocks, period })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Batch fetch failed');
    return data.results;
}

function getDashboardCacheKey(period) {
    return `dipfinder-dashboard:${period}:${[...stocks].sort().join(',')}`;
}

function loadCachedDashboardData(period) {
    try {
        const raw = localStorage.getItem(getDashboardCacheKey(period));
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (!cached || !Array.isArray(cached.rows) || !cached.timestamp) return null;
        if (Date.now() - cached.timestamp > DASHBOARD_CACHE_TTL) return null;
        return cached.rows;
    } catch (error) {
        console.warn('Error reading cached dashboard data:', error);
        return null;
    }
}

function saveCachedDashboardData(period, rows) {
    try {
        localStorage.setItem(getDashboardCacheKey(period), JSON.stringify({
            timestamp: Date.now(),
            rows
        }));
    } catch (error) {
        console.warn('Error saving cached dashboard data:', error);
    }
}

// ── String / number formatters ────────────────────────────────────────────────

function truncateString(str, num) {
    if (str.length <= num) return str;
    return str.slice(0, num) + '...';
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatCurrency(value) {
    if (!Number.isFinite(value)) return 'N/A';
    return `$${value.toFixed(2)}`;
}

function formatPercent(value) {
    if (!Number.isFinite(value)) return 'N/A';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
}

function formatNewsDate(value) {
    if (!value) return 'Recent';
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Recent';
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
}

// ── SMA diff helpers ──────────────────────────────────────────────────────────

function getSmaDiffPercent(data) {
    if (!Number.isFinite(data.relativePrice)) return null;
    return data.relativePrice * 100;
}

function getSortableSmaDiff(data) {
    const diffPercent = getSmaDiffPercent(data);
    return Number.isFinite(diffPercent) ? diffPercent : Number.POSITIVE_INFINITY;
}

// Status tiers: Deep Dip | Dipping | Fair | Warm | Hot
function getDiffStatus(diffPercent) {
    if (!Number.isFinite(diffPercent)) return 'fair';
    if (diffPercent < -15) return 'deep-dip';
    if (diffPercent <  -5) return 'dipping';
    if (diffPercent <   5) return 'fair';
    if (diffPercent <  15) return 'warm';
    return 'hot';
}

function getSmaDiffClasses(diffPercent) {
    switch (getDiffStatus(diffPercent)) {
        case 'deep-dip': return 'bg-teal-700 text-teal-50';
        case 'dipping':  return 'bg-teal-100 text-teal-700';
        case 'fair':     return 'bg-slate-100 text-slate-600';
        case 'warm':     return 'bg-amber-100 text-amber-700';
        case 'hot':      return 'bg-orange-100 text-orange-700';
    }
}

function getBarColor(diffPercent) {
    switch (getDiffStatus(diffPercent)) {
        case 'deep-dip': return { bg: '#0F766E', border: '#0D6561' };
        case 'dipping':  return { bg: '#14B8A6', border: '#0F9E8E' };
        case 'fair':     return { bg: '#94A3B8', border: '#7B8FA3' };
        case 'warm':     return { bg: '#FBBF24', border: '#D97706' };
        case 'hot':      return { bg: '#F97316', border: '#EA580C' };
    }
}

// ── Period display ────────────────────────────────────────────────────────────

function updatePeriodDisplay(period) {
    const el = document.getElementById('selected-period-display');
    if (el) el.textContent = `${period}-Day SMA`;
}

// ── Chart loading UI ─────────────────────────────────────────────────────────

// SVG icon for vertical bars (click to switch TO vertical)
const ICON_VERTICAL = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>';
// SVG icon for horizontal bars (click to switch TO horizontal)
const ICON_HORIZONTAL = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="14" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="10" y2="18"/></svg>';

function updateChartOrientBtn() {
    const btn = document.getElementById('chart-orient-btn');
    if (!btn) return;
    // Icon shows what you'll switch TO; title explains action
    if (chartOrientation === 'y') {
        btn.innerHTML = ICON_VERTICAL;
        btn.title = 'Switch to vertical bars';
    } else {
        btn.innerHTML = ICON_HORIZONTAL;
        btn.title = 'Switch to horizontal bars';
    }
}

function toggleChartOrientation() {
    chartOrientation = chartOrientation === 'y' ? 'x' : 'y';
    updateChartOrientBtn();
    if (lastRenderCache.data) {
        renderDashboardData(lastRenderCache.data, lastRenderCache.period, lastRenderCache.tableBody);
    }
}

function showChartLoading() {
    const el = document.getElementById('chart-loading');
    if (el) el.classList.remove('hidden');
}

function hideChartLoading() {
    const el = document.getElementById('chart-loading');
    if (el) el.classList.add('hidden');
}

// ── Summary metrics ───────────────────────────────────────────────────────────

function renderSummaryMetrics(stockDataArray, period) {
    const biggestDipEl       = document.getElementById('metric-biggest-dip');
    const biggestDipDetailEl = document.getElementById('metric-biggest-dip-detail');
    const belowSmaEl         = document.getElementById('metric-below-sma');
    const belowSmaDetailEl   = document.getElementById('metric-below-sma-detail');
    const averageDipEl       = document.getElementById('metric-average-dip');
    const averageDipDetailEl = document.getElementById('metric-average-dip-detail');
    const strongestAboveEl       = document.getElementById('metric-strongest-above');
    const strongestAboveDetailEl = document.getElementById('metric-strongest-above-detail');

    const validRows = stockDataArray.filter(data => Number.isFinite(getSmaDiffPercent(data)));
    if (validRows.length === 0) {
        [biggestDipEl, belowSmaEl, averageDipEl, strongestAboveEl].forEach(el => { if (el) el.textContent = '--'; });
        if (biggestDipDetailEl)   biggestDipDetailEl.textContent   = 'Waiting for watchlist data';
        if (belowSmaDetailEl)     belowSmaDetailEl.textContent     = `${period}-Day SMA`;
        if (averageDipDetailEl)   averageDipDetailEl.textContent   = 'Mean distance vs SMA';
        if (strongestAboveDetailEl) strongestAboveDetailEl.textContent = 'Best positive spread';
        return;
    }

    const sorted       = [...validRows].sort((a, b) => getSortableSmaDiff(a) - getSortableSmaDiff(b));
    const biggestDip   = sorted[0];
    const strongestAbove = sorted[sorted.length - 1];
    const belowCount   = validRows.filter(d => getSmaDiffPercent(d) < 0).length;
    const averageDiff  = validRows.reduce((sum, d) => sum + getSmaDiffPercent(d), 0) / validRows.length;

    const biggestDipDiff = getSmaDiffPercent(biggestDip);
    if (biggestDipEl)       biggestDipEl.textContent       = biggestDipDiff >= 0 ? '–' : `${biggestDip.stock} ${formatPercent(biggestDipDiff)}`;
    if (biggestDipDetailEl) biggestDipDetailEl.textContent = biggestDipDiff >= 0 ? 'No stocks below SMA' : `vs ${period}-Day SMA ${formatCurrency(biggestDip.sma)}`;
    if (belowSmaEl)         belowSmaEl.textContent         = `${belowCount} / ${validRows.length}`;
    if (belowSmaDetailEl)   belowSmaDetailEl.textContent   = `Trading below ${period}-Day SMA`;
    if (averageDipEl)       averageDipEl.textContent       = averageDiff >= 0 ? '–' : formatPercent(averageDiff);
    if (averageDipDetailEl) averageDipDetailEl.textContent = `Average vs ${period}-Day SMA`;
    if (strongestAboveEl)       strongestAboveEl.textContent       = `${strongestAbove.stock} ${formatPercent(getSmaDiffPercent(strongestAbove))}`;
    if (strongestAboveDetailEl) strongestAboveDetailEl.textContent = `vs ${period}-Day SMA ${formatCurrency(strongestAbove.sma)}`;
}

// ── Stock table rows ──────────────────────────────────────────────────────────

function renderStockTableRows(tableBody, stockDataArray) {
    stockDataArray.forEach(data => {
        const diffPercent = getSmaDiffPercent(data);
        const diffClasses = getSmaDiffClasses(diffPercent);

        tableBody.append(`
            <tr class="stock-row grid cursor-pointer gap-3 px-4 py-2 transition-colors duration-200 hover:bg-gray-50" style="grid-template-columns: minmax(0, 1fr) auto 40px; align-items: center;" data-stock="${escapeHtml(data.stock)}">
                <td class="min-w-0">
                    <div class="text-sm font-medium text-gray-900">${escapeHtml(data.stock)}</div>
                    <div class="truncate text-sm text-gray-500">${escapeHtml(truncateString(data.companyName, 30))}</div>
                </td>
                <td class="whitespace-nowrap text-right">
                    <div class="text-sm font-medium text-gray-900">${formatCurrency(data.currentPrice)}</div>
                    <div class="text-xs text-gray-500">SMA ${formatCurrency(data.sma)}</div>
                    <div class="mt-1 rounded px-2 py-1 text-xs font-semibold ${diffClasses}">
                        ${formatPercent(diffPercent)}
                    </div>
                </td>
                <td class="flex justify-end">
                    <button class="remove-stock relative z-10 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-red-50 text-red-600 transition hover:bg-red-100 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-200" data-stock="${escapeHtml(data.stock)}" title="Remove ${escapeHtml(data.stock)}" aria-label="Remove ${escapeHtml(data.stock)}" onclick="event.stopPropagation();">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </td>
            </tr>
        `);
    });
}

// ── News helpers ──────────────────────────────────────────────────────────────

function getNewsTimestamp(value) {
    if (!value) return 0;
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getArticleKey(article) {
    return (article.url || article.headline || '').toLowerCase().trim();
}

function renderNewsArticle(article, hidden) {
    const hiddenClass = hidden ? ' hidden' : '';
    return `
        <article class="ticker-news-item${hiddenClass} rounded-xl border border-gray-200 bg-white p-3.5 shadow-sm transition hover:shadow-md hover:border-blue-100">
            <a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer" class="block">
                <p class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-blue-500">${escapeHtml(article.source || 'News')}</p>
                <p class="text-sm font-semibold leading-snug text-gray-900 transition group-hover:text-blue-700">${escapeHtml(article.headline || 'Untitled article')}</p>
                <p class="mt-2 text-xs text-gray-400">${formatNewsDate(article.datetime)}</p>
            </a>
        </article>
    `;
}

function renderNewsByTicker(newsFeed, newsByTicker) {
    newsFeed.empty();
    const tickers = Object.keys(newsByTicker).filter(ticker => newsByTicker[ticker].length > 0);
    if (tickers.length === 0) {
        newsFeed.append(`
            <div class="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
                No recent watchlist news found.
            </div>
        `);
        return;
    }

    // Group tickers in rows of 3; each row is a 3-col grid
    const rows = [];
    for (let i = 0; i < tickers.length; i += 3) {
        rows.push(tickers.slice(i, i + 3));
    }

    const rowsHtml = rows.map(group => {
        const cells = group.map(ticker =>
            `<div>${buildTickerNewsSection(ticker, newsByTicker[ticker])}</div>`
        ).join('');
        // Pad to 3 cols so borders stay consistent
        const padding = group.length < 3
            ? Array(3 - group.length).fill('<div></div>').join('')
            : '';
        return `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;">${cells}${padding}</div>`;
    }).join('');

    newsFeed.html(`<div style="display:flex;flex-direction:column;gap:32px;">${rowsHtml}</div>`);
}

function buildTickerNewsSection(ticker, articles) {
    const deduped = [];
    const seen = new Set();
    [...articles]
        .sort((a, b) => getNewsTimestamp(b.datetime) - getNewsTimestamp(a.datetime))
        .forEach(article => {
            const key = getArticleKey(article);
            if (!key || seen.has(key)) return;
            seen.add(key);
            deduped.push(article);
        });
    if (deduped.length === 0) return '';

    const visibleHtml = deduped.slice(0, 4).map(a => renderNewsArticle(a, false)).join('');
    const hiddenHtml  = deduped.slice(4, 8).map(a => renderNewsArticle(a, true)).join('');
    const buttonHtml  = deduped.length > 4
        ? `<button type="button" class="view-more-news mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700" data-ticker="${escapeHtml(ticker)}">View more news</button>`
        : '';

    return `
        <section>
            <div class="mb-3">
                <h3 class="text-base font-bold text-gray-900"><a href="/screener?stock=${encodeURIComponent(ticker)}" class="hover:text-blue-600 transition-colors">${escapeHtml(ticker)}</a></h3>
            </div>
            <div class="space-y-3" data-news-group="${escapeHtml(ticker)}">
                ${visibleHtml}${hiddenHtml}
            </div>
            ${buttonHtml}
        </section>
    `;
}

function appendTickerNewsSection(newsFeed, ticker, articles) {
    const html = buildTickerNewsSection(ticker, articles);
    if (!html) return;
    const wrapper = newsFeed.find('.space-y-8');
    if (wrapper.length) {
        const lastRow = wrapper.children('.grid').last();
        const cells = lastRow.children('div');
        if (lastRow.length && cells.length < 3) {
            // There's room in the last row — replace an empty padding cell or append
            const emptyCell = cells.filter((_, el) => el.innerHTML.trim() === '').first();
            if (emptyCell.length) {
                emptyCell.html(html);
            } else {
                lastRow.append(`<div>${html}</div>`);
            }
        } else {
            // Start a new row
            wrapper.append(`<div class="grid grid-cols-3 gap-5"><div>${html}</div><div></div><div></div></div>`);
        }
    } else {
        newsFeed.append(html);
    }
}

// ── Inline notices ────────────────────────────────────────────────────────────

function showWatchlistNotice(msg, isError = false) {
    const el = document.getElementById('stocks-loading');
    if (!el) return;
    el.textContent = msg;
    el.className = `block text-center font-semibold ${isError ? 'text-red-500' : 'text-blue-500'}`;
    setTimeout(() => {
        el.textContent = '';
        el.className = 'block text-center text-blue-500 font-semibold';
    }, 5000);
}

function showAddError(msg) {
    let errorBox = document.getElementById('stock-add-error');
    if (!errorBox) {
        errorBox = document.createElement('div');
        errorBox.id = 'stock-add-error';
        errorBox.className = 'mt-2 text-sm text-red-600';
        document.getElementById('new-stock').parentNode.appendChild(errorBox);
    }
    errorBox.textContent = msg;
    setTimeout(() => { if (errorBox) errorBox.textContent = ''; }, 4000);
}

// ── localStorage helpers ──────────────────────────────────────────────────────

function saveStocks() {
    if (Array.isArray(stocks) && stocks.length >= 0) {
        stocks = enforceStockLimit(stocks);
        localStorage.setItem('stocks', JSON.stringify(stocks));
    }
}

function saveSelectedPeriod(period) {
    localStorage.setItem('selectedPeriod', period);
    const token = localStorage.getItem('token');
    if (token) {
        fetch('/api/watchlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ stocks, smaPeriod: Number(period) })
        }).catch(() => {});
    }
}

// ── DB watchlist sync ─────────────────────────────────────────────────────────

async function saveWatchlistToDb() {
    try {
        if (!window.AuthManager || !window.AuthManager.isAuthenticated) return;
        const token = localStorage.getItem('token');
        if (!token) return;
        await fetch(`${BASE_URL}/api/watchlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ stocks })
        });
    } catch (e) { /* silent — localStorage remains source of truth */ }
}

// ── Loading dots ──────────────────────────────────────────────────────────────

function startLoadingDots(elementId) {
    let dots = 1;
    const el = document.getElementById(elementId);
    if (!el) return null;
    el.textContent = '.';
    return setInterval(() => {
        dots = dots % 3 + 1;
        el.textContent = '.'.repeat(dots);
    }, 400);
}

function stopLoadingDots(intervalId, elementId, finalText = '') {
    if (intervalId) clearInterval(intervalId);
    if (elementId) {
        const el = document.getElementById(elementId);
        if (el) {
            if (finalText) {
                el.textContent = finalText;
                setTimeout(() => { el.textContent = ''; }, 800);
            } else {
                el.textContent = '';
            }
        }
    }
}

// ── Stock limit helpers ───────────────────────────────────────────────────────

function getCurrentStockLimit() {
    try {
        if (window.AuthManager && window.AuthManager.isAuthenticated) return 10;
    } catch (error) {
        console.warn('Error checking authentication status:', error);
    }
    return 5;
}

function enforceStockLimit(stockArray) {
    const limit = getCurrentStockLimit();
    if (stockArray.length > limit) {
        console.warn(`Stock limit exceeded. Trimming from ${stockArray.length} to ${limit} stocks.`);
        return stockArray.slice(0, limit);
    }
    return stockArray;
}

function validateStocksArray() {
    const originalLength = stocks.length;
    stocks = enforceStockLimit(stocks);
    if (stocks.length !== originalLength) {
        saveStocks();
        window.MAX_STOCKS = getCurrentStockLimit();
        if (document.getElementById('stocks-table')) {
            const limit = getCurrentStockLimit();
            let authStatus = 'guest';
            try {
                authStatus = window.AuthManager && window.AuthManager.isAuthenticated ? 'authenticated' : 'guest';
            } catch (e) {
                console.warn('Error checking auth status for message:', e);
            }
            const msg = authStatus === 'guest'
                ? `Watchlist trimmed to ${limit} stocks. Log in to save up to 10.`
                : `Watchlist trimmed to ${limit} stocks (your limit).`;
            showWatchlistNotice(msg, true);
        }
        return true;
    }
    return false;
}

function addStockWithValidation(newStock) {
    if (stocks.includes(newStock)) {
        return { success: false, error: `Ticker ${newStock} is already in your list.` };
    }
    const limit = getCurrentStockLimit();
    if (stocks.length >= limit) {
        let authStatus = 'guest';
        try {
            authStatus = window.AuthManager && window.AuthManager.isAuthenticated ? 'authenticated' : 'guest';
        } catch (e) {
            console.warn('Error checking auth status for limit message:', e);
        }
        return {
            success: false,
            limitReached: true,
            error: `Stock limit reached (${limit} stocks).${authStatus !== 'guest' ? ' You have reached your limit.' : ''}`
        };
    }
    return { success: true };
}

// ── Remove stock in-place ─────────────────────────────────────────────────────

function removeStockFromUI(stockToRemove) {
    const period = $('#sma-period').val() || '200';

    $(`tr.stock-row[data-stock="${CSS.escape(stockToRemove)}"]`).remove();

    stocks = stocks.filter(s => s !== stockToRemove);
    window.umami?.track('ticker_removed', { symbol: stockToRemove });
    saveStocks();
    saveWatchlistToDb();

    try { localStorage.removeItem(getDashboardCacheKey(period)); } catch (e) {}

    if (chart) {
        const idx = chart.data.labels.indexOf(stockToRemove);
        if (idx !== -1) {
            chart.data.labels.splice(idx, 1);
            const ds = chart.data.datasets[0];
            ds.data.splice(idx, 1);
            ds.backgroundColor.splice(idx, 1);
            ds.borderColor.splice(idx, 1);
            if (ds.stockData) ds.stockData.splice(idx, 1);
            chart.update();
            if (ds.stockData) renderSummaryMetrics(ds.stockData, period);
        }
    }

    delete newsCache[stockToRemove];
    renderNewsByTicker($('#news-feed'), newsCache);

    $('#stock-limit-message').addClass('hidden');
    saveDipfinderContentState();
}

function attachRemoveStockListeners() {
    // Direct binding (not delegated) so clicks fire even when the button's
    // onclick has already called stopPropagation() to prevent row navigation.
    $('.remove-stock').off('click.dipfinderRemove').on('click.dipfinderRemove', function(e) {
        e.stopPropagation();
        removeStockFromUI($(this).data('stock'));
    });
}

// ── Row event wiring ──────────────────────────────────────────────────────────

function attachDashboardRowListeners() {
    attachRemoveStockListeners();
    $('#stocks-table').off('click.dipfinderRows', '.stock-row');
    $('#stocks-table').on('click.dipfinderRows', '.stock-row', function() {
        const stockSymbol = $(this).data('stock');
        if (stockSymbol) window.spaNavigate(`/screener?stock=${encodeURIComponent(stockSymbol)}`);
    });
}

function attachStockRowEvents() {
    $('.stock-row').click(function() {
        const stockSymbol = $(this).data('stock');
        if (stockSymbol) window.spaNavigate(`/screener?stock=${encodeURIComponent(stockSymbol)}`);
    });
    attachRemoveStockListeners();
}

// ── Chart build ───────────────────────────────────────────────────────────────

function renderDashboardData(stockDataArray, period, tableBody) {
    lastRenderCache = { data: stockDataArray, period, tableBody };
    tableBody.empty();
    renderSummaryMetrics(stockDataArray, period);
    renderStockTableRows(tableBody, stockDataArray);

    const chartLabels      = [];
    const relativePrices   = [];
    const backgroundColors = [];
    const borderColors     = [];
    const chartPointData   = [];

    for (const data of stockDataArray) {
        const diffPercent = getSmaDiffPercent(data);
        chartLabels.push(data.stock);
        relativePrices.push(Number.isFinite(diffPercent) ? Number(diffPercent.toFixed(2)) : null);
        chartPointData.push(data);
        const barColor = getBarColor(diffPercent);
        backgroundColors.push(barColor.bg);
        borderColors.push(barColor.border);
    }

    if (chart) chart.destroy();

    const chartElement = document.getElementById('stocks-chart');
    if (!chartElement) {
        console.warn('Chart element not found - skipping chart update');
        return;
    }

    const isHorizontal = chartOrientation === 'y';
    const valueAxisCfg = {
        beginAtZero: true,
        grid: {
            color:     ctx => ctx.tick.value === 0 ? 'rgba(17, 24, 39, 0.55)' : 'rgba(0, 0, 0, 0.08)',
            lineWidth: ctx => ctx.tick.value === 0 ? 2 : 1
        },
        ticks: { color: '#374151', font: { size: 12 }, callback: v => `${v}%` }
    };
    const labelAxisCfg = {
        grid: { display: false },
        ticks: { color: '#374151', font: { size: 12 } }
    };

    chart = new Chart(chartElement.getContext('2d'), {
        type: 'bar',
        data: {
            labels: chartLabels,
            datasets: [{
                label: `% vs ${period}-Day SMA`,
                data: relativePrices,
                stockData: chartPointData,
                backgroundColor: backgroundColors,
                borderColor: borderColors,
                borderWidth: 1,
                borderRadius: 6,
                barThickness: 18,
                maxBarThickness: 22
            }]
        },
        options: {
            indexAxis: chartOrientation,
            responsive: true,
            maintainAspectRatio: false,
            onClick: function(event, elements) {
                if (elements.length > 0) {
                    const symbol = chartLabels[elements[0].index];
                    if (symbol) window.spaNavigate(`/screener?stock=${encodeURIComponent(symbol)}`);
                }
            },
            onHover: function(event, elements) {
                if (event.native) event.native.target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const data = context.dataset.stockData[context.dataIndex];
                            if (!data) return `${isHorizontal ? context.parsed.x : context.parsed.y}%`;
                            return [
                                `Current: ${formatCurrency(data.currentPrice)}`,
                                `SMA: ${formatCurrency(data.sma)}`,
                                `Difference: ${formatPercent(getSmaDiffPercent(data))}`
                            ];
                        }
                    }
                }
            },
            scales: {
                x: isHorizontal ? valueAxisCfg : labelAxisCfg,
                y: isHorizontal ? labelAxisCfg : valueAxisCfg
            }
        }
    });

    hideChartLoading();
    attachDashboardRowListeners();
}

// ── Main data-fetch + render orchestrator ─────────────────────────────────────

async function updateTableAndChart(period) {
    let stocksLoading = startLoadingDots('stocks-loading');
    let smaLoading    = startLoadingDots('sma-loading');
    let newsLoading   = startLoadingDots('news-loading');
    showChartLoading();
    updatePeriodDisplay(period);

    const tableBody = $('#stocks-table tbody');
    tableBody.empty();
    const cachedDashboardData = loadCachedDashboardData(period);
    if (cachedDashboardData) {
        renderDashboardData(cachedDashboardData, period, tableBody);
    }

    const stockDataArray = [];
    let removedStocks = [];

    // Kick off news fetch immediately — it's independent of SMA data
    const newsFeed = $('#news-feed');
    newsFeed.html(`
        <div class="flex items-center gap-2 py-6 text-gray-400">
            <div class="animate-spin rounded-full h-4 w-4 border-2 border-blue-400 border-t-transparent shrink-0"></div>
            <span class="text-sm">Loading news…</span>
        </div>
    `);
    if (stocks.length > 0) $('#news-title').text('News by ticker');
    const newsPromise = Promise.all(stocks.map(stock => fetchNews(stock)));

    let batchResults;
    try {
        batchResults = await fetchBatchStockSMA(stocks, period);
    } catch (err) {
        // Try to identify and remove problematic tickers
        const bad = [];
        for (const stock of stocks) {
            try {
                const data = await fetchStockData(stock);
                if (!data || data.error) bad.push(stock);
            } catch (e) {
                bad.push(stock);
            }
        }
        stopLoadingDots(stocksLoading, 'stocks-loading', '');
        stopLoadingDots(smaLoading, 'sma-loading', '');
        stopLoadingDots(newsLoading, 'news-loading', '');
        if (bad.length > 0) {
            stocks = stocks.filter(s => !bad.includes(s));
            saveStocks();
            updateTableAndChart(period);
        } else {
            showWatchlistNotice('Failed to fetch stock data. Try refreshing.', true);
        }
        return;
    }
    stopLoadingDots(stocksLoading, 'stocks-loading', '');
    stopLoadingDots(smaLoading, 'sma-loading', '');

    for (let i = 0; i < stocks.length; i++) {
        const batch = batchResults[i];
        if (!batch || !Number.isFinite(batch.currentPrice) || !Number.isFinite(batch.sma)) {
            removedStocks.push(stocks[i]);
            continue;
        }
        const currentPrice  = batch.currentPrice;
        const previousPrice = batch.previousPrice;
        stockDataArray.push({
            stock:        batch.stock || stocks[i],
            companyName:  batch.companyName || batch.stock || stocks[i],
            currentPrice,
            dailyChange:  ((currentPrice - previousPrice) / previousPrice) * 100,
            sma:          batch.sma,
            relativePrice: Number.isFinite(batch.relativePrice) ? batch.relativePrice : currentPrice / batch.sma - 1
        });
    }

    if (removedStocks.length > 0) {
        stocks = stocks.filter(s => !removedStocks.includes(s));
        saveStocks();
        stopLoadingDots(stocksLoading, 'stocks-loading', '');
        stopLoadingDots(smaLoading, 'sma-loading', '');
        stopLoadingDots(newsLoading, 'news-loading', '');
        updateTableAndChart(period);
        return;
    }

    stockDataArray.sort((a, b) => getSortableSmaDiff(a) - getSortableSmaDiff(b));
    saveCachedDashboardData(period, stockDataArray);
    renderDashboardData(stockDataArray, period, tableBody);

    const newsResults = await newsPromise;
    newsCache = {};
    stocks.forEach((stock, i) => {
        newsCache[stock] = Array.isArray(newsResults[i]) ? newsResults[i] : [];
    });
    renderNewsByTicker(newsFeed, newsCache);

    $(document).off('click.dipfinderNews', '.view-more-news');
    $(document).on('click.dipfinderNews', '.view-more-news', function() {
        const ticker = $(this).data('ticker');
        $(`[data-news-group="${ticker}"] .ticker-news-item.hidden`).removeClass('hidden');
        $(this).remove();
    });

    stopLoadingDots(newsLoading, null, '');
    saveDipfinderContentState();
}

// ── SPA lifecycle ─────────────────────────────────────────────────────────────

window.initializeDipfinder = function() {

    function initCustomSelect() {
        const customSelect = document.getElementById('sma-period-custom');
        if (!customSelect) return;
        const trigger = customSelect.querySelector('.custom-select-trigger');
        const options = customSelect.querySelector('.custom-select-options');
        if (!trigger || !options) return;

        const toggleDropdown = () => customSelect.classList.toggle('active');
        trigger.addEventListener('click', toggleDropdown);
        dipfinderEventListeners.push({ element: trigger, type: 'click', handler: toggleDropdown });

        const optionsHandler = e => {
            const optionEl = e.target.closest('.custom-select-option');
            if (optionEl) {
                const value = optionEl.dataset.value;
                const triggerText = customSelect.querySelector('#sma-period-text');
                if (triggerText) triggerText.textContent = optionEl.querySelector('span').textContent;
                options.querySelectorAll('.custom-select-option').forEach(opt => opt.classList.remove('active'));
                optionEl.classList.add('active');
                customSelect.classList.remove('active');
                changeSMAPeriod(value);
            }
        };
        options.addEventListener('click', optionsHandler);
        dipfinderEventListeners.push({ element: options, type: 'click', handler: optionsHandler });

        document.addEventListener('click', window.closeCustomSelectOnClickOutside);
        dipfinderEventListeners.push({ element: document, type: 'click', handler: window.closeCustomSelectOnClickOutside });
        document.addEventListener('keydown', window.closeCustomSelectOnEscape);
        dipfinderEventListeners.push({ element: document, type: 'keydown', handler: window.closeCustomSelectOnEscape });
    }

    function updateCustomSelectDisplay(value) {
        const customSelect = document.getElementById('sma-period-custom');
        if (!customSelect) return;
        const triggerText = customSelect.querySelector('#sma-period-text');
        const options = customSelect.querySelector('.custom-select-options');
        if (!triggerText || !options) return;
        const selectedOption = options.querySelector(`.custom-select-option[data-value="${value}"]`);
        if (selectedOption) {
            triggerText.textContent = selectedOption.querySelector('span').textContent;
            options.querySelectorAll('.custom-select-option').forEach(opt => opt.classList.remove('active'));
            selectedOption.classList.add('active');
        }
    }

    // 1. Load and validate stocks from localStorage
    try {
        const storedStocks = localStorage.getItem('stocks');
        if (storedStocks) {
            stocks = JSON.parse(storedStocks);
        } else {
            stocks = ['CRM', 'MSFT', 'AAPL', 'INTU'];
            localStorage.setItem('stocks', JSON.stringify(stocks));
        }
    } catch (error) {
        console.warn('Error reading stocks from localStorage, setting defaults:', error);
        stocks = ['CRM', 'MSFT', 'AAPL', 'INTU'];
    }
    validateStocksArray();

    // 2. Bail if the dashboard DOM isn't loaded
    if (!document.getElementById('stocks-table')) return;

    // 3. Restore cached content or do a fresh load
    const newsFeed  = document.getElementById('news-feed');
    const newsTitle = document.getElementById('news-title');
    const restoreCachedContent = window.dipfinderContentCache.isInitialized &&
        window.dipfinderContentCache.lastUpdated &&
        (Date.now() - window.dipfinderContentCache.lastUpdated < 15 * 60 * 1000);

    if (restoreCachedContent) {
        const cachedHtml = window.dipfinderContentCache.stocksTableHtml;
        const hasCachedRows = cachedHtml && cachedHtml.includes('stock-row');

        if (hasCachedRows) {
            // Re-render chart from localStorage data (preserves all function callbacks)
            const savedPeriod = localStorage.getItem('selectedPeriod') || '200';
            const cachedRows  = loadCachedDashboardData(savedPeriod);
            if (cachedRows && cachedRows.length > 0) {
                renderDashboardData(cachedRows, savedPeriod, $('#stocks-table tbody'));
            }
            // Restore news
            if (window.dipfinderContentCache.newsFeedHtml && newsFeed) {
                newsFeed.innerHTML = window.dipfinderContentCache.newsFeedHtml;
            }
            if (window.dipfinderContentCache.newsTitleHtml && newsTitle) {
                newsTitle.innerHTML = window.dipfinderContentCache.newsTitleHtml;
            }
        } else if (stocks.length > 0) {
            const periodSelect = $('#sma-period');
            periodSelect.val(localStorage.getItem('selectedPeriod') || '200');
            updateTableAndChart(periodSelect.val());
            return;
        }
    }

    // 4. DOM-dependent init
    const periodSelect = $('#sma-period');
    initCustomSelect();
    const savedPeriod = localStorage.getItem('selectedPeriod') || '200';
    periodSelect.val(savedPeriod);
    updateCustomSelectDisplay(savedPeriod);

    if (stocks.length > 0 && !restoreCachedContent) {
        updateTableAndChart(periodSelect.val());
    }

    periodSelect.change(function() {
        const selectedPeriod = $(this).val();
        saveSelectedPeriod(selectedPeriod);
        updateTableAndChart(selectedPeriod);
    });

    // Autocomplete — lazy-load the ticker list only when the dashboard is active
    function setupDipfinderAutocomplete() {
        dipfinderAutocompleteInstance = initStockAutocomplete('new-stock', {
            onSelection: async function() {
                $('#add-stock').click();
            }
        });
    }
    if (window.initStockAutocomplete) {
        setupDipfinderAutocomplete();
    } else {
        const s = document.createElement('script');
        s.src = '/stock-autocomplete.js?v=3';
        s.onload = setupDipfinderAutocomplete;
        document.head.appendChild(s);
    }

    // Add stock handler
    $('#add-stock').click(async function() {
        const newStock = $('#new-stock').val().toUpperCase();
        if (!newStock) return;

        const msgBox = document.getElementById('stock-add-error');
        if (msgBox) msgBox.textContent = '';

        const validation = addStockWithValidation(newStock);
        if (!validation.success) {
            const isGuest = !window.AuthManager || !window.AuthManager.isAuthenticated;
            if (isGuest && validation.limitReached && window.showLimitModal) {
                window.showLimitModal();
            } else {
                showAddError(validation.error);
            }
            return;
        }

        const loadingEl = document.getElementById('stocks-loading');
        const input     = document.getElementById('new-stock');
        if (loadingEl) loadingEl.textContent = 'Checking ticker…';
        if (input) input.disabled = true;

        const period = periodSelect.val() || '200';
        let batchResults;
        try {
            batchResults = await fetchBatchStockSMA([newStock], period);
        } catch (err) {
            if (loadingEl) loadingEl.textContent = '';
            if (input) input.disabled = false;
            showAddError(`Failed to fetch data for ${newStock}. Please check the ticker.`);
            return;
        }

        const batch = batchResults && batchResults[0];
        if (!batch || !Number.isFinite(batch.currentPrice) || !Number.isFinite(batch.sma)) {
            if (loadingEl) loadingEl.textContent = '';
            if (input) input.disabled = false;
            showAddError(`No valid data found for ${newStock}. Please check the ticker.`);
            return;
        }

        stocks.push(newStock);
        window.umami?.track('ticker_added', { symbol: newStock });
        saveStocks();
        saveWatchlistToDb();

        const newStockData = {
            stock:         batch.stock || newStock,
            companyName:   batch.companyName || newStock,
            currentPrice:  batch.currentPrice,
            dailyChange:   ((batch.currentPrice - batch.previousPrice) / batch.previousPrice) * 100,
            sma:           batch.sma,
            relativePrice: Number.isFinite(batch.relativePrice) ? batch.relativePrice : (batch.currentPrice / batch.sma - 1)
        };

        renderStockTableRows($('#stocks-table tbody'), [newStockData]);
        attachRemoveStockListeners();

        if (chart) {
            const diffPercent = getSmaDiffPercent(newStockData);
            chart.data.labels.push(newStockData.stock);
            const ds = chart.data.datasets[0];
            ds.data.push(Number.isFinite(diffPercent) ? Number(diffPercent.toFixed(2)) : null);
            const barColor = getBarColor(diffPercent);
            ds.backgroundColor.push(barColor.bg);
            ds.borderColor.push(barColor.border);
            if (ds.stockData) {
                ds.stockData.push(newStockData);
                renderSummaryMetrics(ds.stockData, period);
            }
            chart.update();
        }

        try { localStorage.removeItem(getDashboardCacheKey(period)); } catch (e) {}

        if (input) { input.value = ''; input.disabled = false; }
        if (loadingEl) loadingEl.textContent = '';

        fetchNews(newStock).then(articles => {
            newsCache[newStock] = Array.isArray(articles) ? articles : [];
            renderNewsByTicker($('#news-feed'), newsCache);
        });

        saveDipfinderContentState();
    });

    $('#new-stock').keypress(function(event) {
        if (event.which === 13) $('#add-stock').click();
    });


    // Inline "Save Watchlist" button — opens auth modal
    $(document).on('click.dipfinder', '#save-watchlist-inline', function() {
        const modal = document.getElementById('auth-modal');
        if (modal) modal.classList.remove('hidden');
    });

    // Sample watchlist buttons
    $(document).on('click.dipfinder', '.sample-watchlist', function() {
        const period = $('#sma-period').val() || '200';
        stocks = $(this).data('stocks').split(',');
        window.umami?.track('dashboard_cta_sample_watchlist', { name: $(this).text().trim() });
        saveStocks();
        saveWatchlistToDb();
        try { localStorage.removeItem(getDashboardCacheKey(period)); } catch (e) {}
        updateTableAndChart(period);
    });

    $(document).on('click.dipfinder', '.stock-row', function() {
        const stockSymbol = $(this).data('stock');
        if (stockSymbol) window.spaNavigate(`/screener?stock=${encodeURIComponent(stockSymbol)}`);
    });

    // Auth change watcher
    function updateGuestUI(isAuthenticated) {
        const wrap = document.getElementById('guest-watchlist-wrap');
        if (wrap) wrap.classList.toggle('hidden', !!isAuthenticated);
    }

    let lastAuthStatus = false;
    updateGuestUI(window.AuthManager && window.AuthManager.isAuthenticated);
    dipfinderAuthCheckInterval = setInterval(() => {
        try {
            const currentAuthStatus = window.AuthManager && window.AuthManager.isAuthenticated;
            if (currentAuthStatus !== lastAuthStatus) {
                lastAuthStatus = currentAuthStatus;
                updateGuestUI(currentAuthStatus);
                window.MAX_STOCKS = getCurrentStockLimit();
                const wasModified = validateStocksArray();
                if (wasModified && document.getElementById('stocks-table')) {
                    updateTableAndChart($('#sma-period').val() || '200');
                }
            }
        } catch (error) {
            console.warn('Error checking authentication status:', error);
        }
    }, 1000);

    // Watchlist restore: fired by auth.js after fetching DB stocks on login
    window.addEventListener('dipfinder:watchlistRestored', function() {
        try {
            const restored = JSON.parse(localStorage.getItem('stocks') || '[]');
            if (JSON.stringify(restored) !== JSON.stringify(stocks)) {
                stocks = restored;
                const period = $('#sma-period').val() || '200';
                try { localStorage.removeItem(getDashboardCacheKey(period)); } catch (e) {}
                if (document.getElementById('stocks-table')) updateTableAndChart(period);
            }
        } catch (e) { console.warn('Error handling watchlistRestored:', e); }
    });

    // localStorage sync watcher
    dipfinderLocalStorageCheckInterval = setInterval(() => {
        try {
            const storedStocks = localStorage.getItem('stocks');
            if (storedStocks) {
                const parsedStocks = JSON.parse(storedStocks);
                const limit = getCurrentStockLimit();
                if (parsedStocks.length > limit || JSON.stringify(parsedStocks) !== JSON.stringify(stocks)) {
                    stocks = parsedStocks;
                    const wasModified = validateStocksArray();
                    if (wasModified && document.getElementById('stocks-table')) {
                        updateTableAndChart($('#sma-period').val() || '200');
                    }
                }
            }
        } catch (error) {
            console.error('Error checking localStorage:', error);
        }
    }, 5000);
};

// ── Newsletter signup ─────────────────────────────────────────────────────────

(function() {
    document.addEventListener('click', function(e) {
        if (!e.target.matches('#newsletter-submit')) return;
        const input = document.getElementById('newsletter-email');
        const msg   = document.getElementById('newsletter-msg');
        if (!input || !msg) return;
        window.umami?.track('newsletter_subscribe', { hasEmail: !!input.value.trim() });
        msg.classList.remove('hidden');
    });
})();

// ── SPA teardown ──────────────────────────────────────────────────────────────

window.destroyDipfinder = function() {
    saveDipfinderContentState();

    if (chart) {
        chart.destroy();
        chart = null;
    }

    clearInterval(dipfinderAuthCheckInterval);
    clearInterval(dipfinderLocalStorageCheckInterval);

    $('#add-stock').off('click');
    $('#new-stock').off('keypress');
    $('#sma-period').off('change');
    $(document).off('click.dipfinder');

    if (dipfinderAutocompleteInstance && dipfinderAutocompleteInstance.destroy) {
        dipfinderAutocompleteInstance.destroy();
        dipfinderAutocompleteInstance = null;
    }

    dipfinderEventListeners.forEach(l => l.element.removeEventListener(l.type, l.handler));
    dipfinderEventListeners = [];

    document.removeEventListener('click', window.closeCustomSelectOnClickOutside);
    document.removeEventListener('keydown', window.closeCustomSelectOnEscape);
};

window.closeCustomSelectOnClickOutside = function(e) {
    const el = document.getElementById('sma-period-custom');
    if (el && !el.contains(e.target)) el.classList.remove('active');
};

window.closeCustomSelectOnEscape = function(e) {
    if (e.key === 'Escape') {
        const el = document.getElementById('sma-period-custom');
        if (el) el.classList.remove('active');
    }
};

function changeSMAPeriod(period) {
    const periodSelect = $('#sma-period');
    if (periodSelect.length) {
        periodSelect.val(period).trigger('change');
    } else {
        saveSelectedPeriod(period);
        updateTableAndChart(period);
    }
}

function saveDipfinderContentState() {
    const stocksTable = document.getElementById('stocks-table');
    const newsFeed    = document.getElementById('news-feed');
    const newsTitle   = document.getElementById('news-title');

    if (stocksTable) {
        const tbody = stocksTable.querySelector('tbody');
        if (tbody && stocks && stocks.length > 0) {
            window.dipfinderContentCache.stocksTableHtml = tbody.innerHTML;
        }
    }
    if (chart) {
        window.dipfinderContentCache.chartData = { data: chart.data, options: chart.options };
    }
    if (newsFeed) window.dipfinderContentCache.newsFeedHtml = newsFeed.innerHTML;
    if (newsTitle) window.dipfinderContentCache.newsTitleHtml = newsTitle.innerHTML;

    window.dipfinderContentCache.isInitialized = true;
    window.dipfinderContentCache.lastUpdated   = Date.now();
}
