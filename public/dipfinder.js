// dipfinder.js — Dashboard: data helpers, display helpers, lifecycle + chart wiring

// ── Shared globals (var so other scripts can access via window scope) ─────────
var stocks = [];  // populated from localStorage in initializeDipfinder
var chart;        // Chart.js instance; created/destroyed in renderDashboardData
var scatterChart; // Admin-only scatter chart instance
var chartOrientation = 'y'; // 'y' = horizontal bars, 'x' = vertical bars
var lastRenderCache = { data: null, period: null, tableBody: null };
var aiSummariesCache = {};  // symbol → { summary, weekOf, companyName }

// Pro multi-watchlist state
var activeWatchlistId = 'primary';
var namedWatchlists = [];
var primaryWatchlistName = 'Main';
// Cache of primary stocks separately so tab-switches can restore them
var primaryStocksCache = [];

// Drag-and-drop state (suppresses click-to-navigate on dragend)
var isDragging = false;

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

async function fetchAiSummaries(symbolList) {
    if (!symbolList || !symbolList.length) return {};
    try {
        const params = new URLSearchParams({ action: 'ai-summaries', symbols: symbolList.join(',') });
        const res = await fetch(`${BASE_URL}/api/batch-stocks?${params}`);
        if (!res.ok) return {};
        const data = await res.json();
        return data.summaries || {};
    } catch { return {}; }
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
    const token = localStorage.getItem('token');
    if (token) {
        fetch('/api/watchlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ action: 'save-watchlist', stocks, watchlistId: activeWatchlistId, smaPeriod: Number(localStorage.getItem('selectedPeriod') || '200'), chartOrientation })
        }).catch(() => {});
    }
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
            <tr class="stock-row grid gap-3 px-4 py-2 transition-colors duration-200 hover:bg-gray-50" style="grid-template-columns: 14px minmax(0, 1fr) auto 40px; align-items: center; cursor: pointer;" data-stock="${escapeHtml(data.stock)}" draggable="true">
                <td class="drag-handle" style="display:flex;align-items:center;padding:0;cursor:grab;">
                    <svg width="8" height="14" viewBox="0 0 8 14" fill="#d1d5db" style="flex-shrink:0;">
                        <circle cx="2" cy="2" r="1.5"/><circle cx="6" cy="2" r="1.5"/>
                        <circle cx="2" cy="7" r="1.5"/><circle cx="6" cy="7" r="1.5"/>
                        <circle cx="2" cy="12" r="1.5"/><circle cx="6" cy="12" r="1.5"/>
                    </svg>
                </td>
                <td class="min-w-0">
                    <div class="flex items-baseline gap-2">
                        <div class="text-sm font-medium text-gray-900">${escapeHtml(data.stock)}</div>
                        ${data.peRatio != null ? `<div class="text-xs text-gray-400 font-normal">P/E ${data.peRatio}</div>` : ''}
                    </div>
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
                    <button class="remove-stock relative z-10 inline-flex h-11 w-11 items-center justify-center rounded-lg bg-red-50 text-red-600 transition hover:bg-red-100 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-200" data-stock="${escapeHtml(data.stock)}" title="Remove ${escapeHtml(data.stock)}" aria-label="Remove ${escapeHtml(data.stock)}" onclick="event.stopPropagation();">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </td>
            </tr>
        `);
    });
}

// ── AI summary helpers ────────────────────────────────────────────────────────

function renderAiSummaries(newsFeed, stockDataArray) {
    newsFeed.empty();
    const smaPeriod = lastRenderCache.period || localStorage.getItem('selectedPeriod') || '200';
    const withSummaries = (stockDataArray || []).filter(s => aiSummariesCache[s.stock]);

    if (!withSummaries.length) {
        newsFeed.html(`
            <div class="rounded-xl border border-gray-100 bg-gray-50 px-5 py-6 text-center">
                <p class="text-sm font-medium text-gray-500">No brief summaries for your watchlist stocks yet.</p>
                <p class="mt-1 text-xs text-gray-400">AI insights are generated each Saturday night before Sunday's brief.</p>
            </div>
        `);
        return;
    }

    const cards = withSummaries.map(s => {
        const entry = aiSummariesCache[s.stock];
        const diffPercent = getSmaDiffPercent(s);
        const diffClasses = getSmaDiffClasses(diffPercent);
        const sign = Number.isFinite(diffPercent) && diffPercent > 0 ? '+' : '';
        const pct = Number.isFinite(diffPercent) ? `${sign}${diffPercent.toFixed(1)}%` : '--';
        const weekLabel = entry.weekOf
            ? new Date(entry.weekOf).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '';
        const href = `/screener?stock=${encodeURIComponent(s.stock)}`;
        return `
        <div class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div class="flex items-center gap-2 min-w-0">
                    <a href="${href}" class="text-sm font-bold text-gray-900 hover:text-blue-600 transition-colors">${escapeHtml(s.stock)}</a>
                    <span class="truncate text-xs text-gray-500">${escapeHtml(s.companyName || entry.companyName || '')}</span>
                </div>
                <span class="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${diffClasses}">${pct} vs ${smaPeriod}d SMA</span>
            </div>
            <p class="text-sm text-gray-700 leading-relaxed">${escapeHtml(entry.summary)}</p>
            ${weekLabel ? `<p class="mt-2.5 text-xs text-gray-400">Week of ${escapeHtml(weekLabel)} &middot; <a href="${href}" class="text-blue-500 hover:text-blue-700 transition-colors">View in screener &rarr;</a></p>` : ''}
        </div>`;
    }).join('');

    newsFeed.html(`<div class="grid grid-cols-1 gap-4 md:grid-cols-2">${cards}</div>`);
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

// ── Floating toast ────────────────────────────────────────────────────────────
// showToast(msg, opts)
//   opts.type: 'success' | 'error' | 'info'  (default 'success')
//   opts.html: true to treat msg as HTML (for upgrade links)
//   opts.duration: ms before auto-dismiss (default 5000)
// Returns a dismiss() function so callers can close the toast early.
function showToast(msg, opts = {}) {
    const { type = 'success', html = false, duration = 5000 } = opts;
    const colors = {
        success: { bg: '#f0fdf4', border: '#86efac', text: '#15803d' },
        error:   { bg: '#fef2f2', border: '#fca5a5', text: '#b91c1c' },
        info:    { bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8' },
    };
    const c = colors[type] || colors.success;

    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;max-width:340px;padding:12px 16px;border-radius:10px;border:1px solid ${c.border};background:${c.bg};color:${c.text};font-size:0.875rem;font-weight:600;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,0.10);transition:opacity 0.3s;`;
    if (html) toast.innerHTML = msg; else toast.textContent = msg;
    document.body.appendChild(toast);

    let timer;
    const remove = () => {
        clearTimeout(timer);
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    };
    toast.addEventListener('click', remove);
    timer = setTimeout(remove, duration);
    return remove; // caller can dismiss early
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
            body: JSON.stringify({ action: 'save-watchlist', stocks, watchlistId: activeWatchlistId, smaPeriod: Number(period) })
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
            body: JSON.stringify({ action: 'save-watchlist', stocks, watchlistId: activeWatchlistId })
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

// ── Limit modal ───────────────────────────────────────────────────────────────

function showLimitModal() {
    const modal = document.getElementById('limit-modal');
    if (modal) modal.classList.remove('hidden'), modal.classList.add('flex');
}

window.hideLimitModal = function() {
    const modal = document.getElementById('limit-modal');
    if (modal) modal.classList.add('hidden'), modal.classList.remove('flex');
};

// ── Stock limit helpers ───────────────────────────────────────────────────────

function getCurrentStockLimit() {
    return window.IS_PRO ? 50 : 10;
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
            showWatchlistNotice(`Watchlist trimmed to ${limit} stocks (your limit).`, true);
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
        return {
            success: false,
            limitReached: true,
            error: `Stock limit reached (${limit} stocks). You have reached your limit.`
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

    delete aiSummariesCache[stockToRemove];
    const remainingData = (lastRenderCache.data || []).filter(s => s.stock !== stockToRemove);
    lastRenderCache.data = remainingData;
    renderScatterChart(remainingData);
    renderAiSummaries($('#news-feed'), remainingData);

    $('#stock-limit-message').addClass('hidden');
    saveDipfinderContentState();
    updateNewsletterEmptyState();
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
    attachDragToReorder();
    $('#stocks-table').off('click.dipfinderRows', '.stock-row');
    $('#stocks-table').on('click.dipfinderRows', '.stock-row', function() {
        if (isDragging) return;
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

// ── Admin scatter: Dip vs Valuation ──────────────────────────────────────────

function renderScatterChart(stockDataArray) {
    const section = document.getElementById('admin-scatter-section');
    if (!section) return;

    if (!window.IS_ADMIN) {
        section.classList.add('hidden');
        return;
    }

    // Re-show admin tools panel if it was hidden by an empty-watchlist transition
    document.getElementById('admin-tools-section')?.classList.remove('hidden');

    const included = [];
    const excluded = [];

    for (const d of stockDataArray) {
        const diffPercent = getSmaDiffPercent(d);
        if (!Number.isFinite(diffPercent)) continue;
        const pe = d.peRatio;
        if (pe === null || pe === undefined || pe <= 0) {
            excluded.push({ stock: d.stock, reason: (typeof pe === 'number' && pe <= 0) ? 'negative' : 'null' });
            continue;
        }
        included.push({ d, diffPercent, pe: Math.min(pe, 50), clipped: pe > 50 });
    }

    // Show/hide excluded note
    const excludedEl = document.getElementById('scatter-excluded');
    if (excludedEl) {
        if (excluded.length) {
            excludedEl.textContent = `Not shown: ${excluded.map(e => e.stock).join(', ')} - no PE data or negative earnings`;
            excludedEl.classList.remove('hidden');
        } else {
            excludedEl.classList.add('hidden');
        }
    }

    section.classList.remove('hidden');

    const isDark   = document.documentElement.classList.contains('dark-mode');
    const axisColor = isDark ? '#9ca3af' : '#6b7280';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
    const refColor  = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)';
    const labelBg   = isDark ? 'rgba(31,41,55,0.85)' : 'rgba(255,255,255,0.85)';

    const pointColors = included.map(({ diffPercent }) => getBarColor(diffPercent).bg);

    const canvasEl = document.getElementById('scatter-chart');
    if (!canvasEl) return;

    if (scatterChart) scatterChart.destroy();

    // Quadrant label plugin
    const quadrantPlugin = {
        id: 'quadrantLabels',
        afterDraw(ch) {
            const { ctx, chartArea: { left, right, top, bottom }, scales: { x, y } } = ch;
            const cx = x.getPixelForValue(0);
            const cy = y.getPixelForValue(15);
            const labels = [
                { text: 'Dipping + Cheap',     px: (left + cx) / 2,    py: (cy + bottom) / 2 },
                { text: 'Dipping + Expensive', px: (left + cx) / 2,    py: (top + cy) / 2    },
                { text: 'Hot + Cheap',         px: (cx + right) / 2,   py: (cy + bottom) / 2 },
                { text: 'Hot + Expensive',     px: (cx + right) / 2,   py: (top + cy) / 2    },
            ];
            ctx.save();
            ctx.font = '10px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = isDark ? 'rgba(156,163,175,0.45)' : 'rgba(100,116,139,0.4)';
            labels.forEach(({ text, px, py }) => ctx.fillText(text, px, py));
            ctx.restore();
        }
    };

    scatterChart = new Chart(canvasEl.getContext('2d'), {
        type: 'scatter',
        plugins: [quadrantPlugin],
        data: {
            datasets: [{
                data: included.map(({ diffPercent, pe, clipped }) => ({
                    x: Number(diffPercent.toFixed(2)),
                    y: pe,
                    clipped,
                })),
                pointBackgroundColor: pointColors,
                pointBorderColor:     pointColors.map(c => c + 'cc'),
                pointRadius:          7,
                pointHoverRadius:     9,
                pointBorderWidth:     1.5,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick(event, elements) {
                if (elements.length > 0) {
                    const symbol = included[elements[0].index]?.d?.stock;
                    if (symbol) window.spaNavigate(`/screener?stock=${encodeURIComponent(symbol)}`);
                }
            },
            onHover(event, elements) {
                if (event.native) event.native.target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label(ctx) {
                            const { x, y, clipped } = ctx.raw;
                            const ticker = included[ctx.dataIndex]?.d?.stock || '';
                            return `${ticker}  ${x > 0 ? '+' : ''}${x}% vs SMA  |  P/E ${clipped ? '>50' : y}`;
                        }
                    }
                },
            },
            scales: {
                x: {
                    title: { display: true, text: '% vs SMA', color: axisColor, font: { size: 11 } },
                    grid: {
                        color: ctx => ctx.tick.value === 0 ? refColor : gridColor,
                        lineWidth: ctx => ctx.tick.value === 0 ? 2 : 1,
                    },
                    ticks: { color: axisColor, font: { size: 11 }, callback: v => `${v > 0 ? '+' : ''}${v}%` },
                },
                y: {
                    title: { display: true, text: 'Trailing P/E', color: axisColor, font: { size: 11 } },
                    min: 0,
                    max: 52,
                    grid: {
                        color: ctx => ctx.tick.value === 15 ? refColor : gridColor,
                        lineWidth: ctx => ctx.tick.value === 15 ? 2 : 1,
                    },
                    ticks: { color: axisColor, font: { size: 11 } },
                },
            },
        },
    });

    // Draw ticker labels manually via afterDraw
    const labelPlugin = {
        id: 'tickerLabels',
        afterDatasetsDraw(ch) {
            const { ctx, scales: { x, y } } = ch;
            ctx.save();
            ctx.font = 'bold 10px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            included.forEach(({ d, diffPercent, pe }, i) => {
                const px = x.getPixelForValue(Number(diffPercent.toFixed(2))) + 9;
                const py = y.getPixelForValue(Math.min(pe, 50));
                ctx.fillStyle = isDark ? '#e5e7eb' : '#374151';
                ctx.fillText(d.stock, px, py);
            });
            ctx.restore();
        }
    };

    // Re-register label plugin on this instance
    scatterChart.config.plugins.push(labelPlugin);
    scatterChart.update();
}

// ── Admin tools panel ─────────────────────────────────────────────────────────

let adminToolsInitialized = false;

function initAdminTools() {
    const section = document.getElementById('admin-tools-section');
    if (!section || adminToolsInitialized) return;
    adminToolsInitialized = true;
    section.classList.remove('hidden');

    const statusEl = document.getElementById('admin-tools-status');

    function setStatus(msg, isError) {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.classList.remove('hidden', 'text-red-600', 'text-gray-600');
        statusEl.classList.add(isError ? 'text-red-600' : 'text-gray-600');
    }

    // ── Snapshot button ──────────────────────────────────────────────────────
    const snapshotBtn = document.getElementById('admin-snapshot-btn');
    if (snapshotBtn) {
        snapshotBtn.addEventListener('click', async () => {
            const currentSymbols = stocks.slice();
            if (!currentSymbols.length) { setStatus('No stocks in watchlist.', true); return; }
            snapshotBtn.disabled = true;
            snapshotBtn.innerHTML = '<i class="fas fa-spinner fa-spin text-gray-400"></i> Running...';
            try {
                const token = localStorage.getItem('token');
                const r = await fetch(`/api/newsletter?action=snapshot&symbols=${encodeURIComponent(currentSymbols.join(','))}`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                });
                const data = await r.json();
                setStatus(r.ok ? `Snapshot saved for ${data.saved} stock${data.saved === 1 ? '' : 's'}.` : `Error: ${data.error || 'Unknown error'}`, !r.ok);
            } catch (e) {
                setStatus('Network error — snapshot failed.', true);
            }
            snapshotBtn.disabled = false;
            snapshotBtn.innerHTML = '<i class="fas fa-camera text-gray-400"></i> Run Snapshot';
        });
    }

    // ── AI Summaries button ──────────────────────────────────────────────────
    const aiBtn = document.getElementById('admin-ai-btn');
    if (aiBtn) {
        aiBtn.addEventListener('click', async () => {
            const currentSymbols = stocks.slice();
            if (!currentSymbols.length) { setStatus('No stocks in watchlist.', true); return; }
            aiBtn.disabled = true;
            aiBtn.innerHTML = '<i class="fas fa-spinner fa-spin text-gray-400"></i> Generating...';
            try {
                const token = localStorage.getItem('token');
                const r = await fetch(`/api/newsletter?action=ai-summaries&symbols=${encodeURIComponent(currentSymbols.join(','))}`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                });
                const data = await r.json();
                if (!r.ok) {
                    setStatus(`Error: ${data.error || 'Unknown error'}`, true);
                } else if (data.skipped) {
                    setStatus(`AI summaries: ${data.reason || 'all already done this week'}.`, false);
                } else {
                    const parts = [];
                    if (data.aiGenerated > 0) parts.push(`${data.aiGenerated} generated`);
                    if (data.aiSkipped > 0) parts.push(`${data.aiSkipped} skipped (no news)`);
                    const alreadyDone = currentSymbols.length - (data.aiGenerated + data.aiSkipped);
                    if (alreadyDone > 0) parts.push(`${alreadyDone} already had summaries`);
                    setStatus(`AI summaries: ${parts.join(', ') || 'nothing to do'}.`, false);
                }
            } catch (e) {
                setStatus('Network error — AI summaries failed.', true);
            }
            aiBtn.disabled = false;
            aiBtn.innerHTML = '<i class="fas fa-magic text-gray-400"></i> Generate AI Summaries';
            await loadWlSummaries();
        });
    }

    // ── Summaries review panel ───────────────────────────────────────────────

    let wlSummariesData = []; // all this week's summaries for current watchlist symbols

    const summariesWrap = document.getElementById('admin-summaries-wrap');
    const summariesList = document.getElementById('admin-summaries-list');
    const refreshBtn    = document.getElementById('admin-summaries-refresh');

    async function loadWlSummaries() {
        if (!summariesWrap || !summariesList) return;
        summariesList.innerHTML = '<p class="text-xs text-gray-400 py-2">Loading...</p>';
        summariesWrap.classList.remove('hidden');
        try {
            const token = localStorage.getItem('token');
            const r = await fetch('/api/admin?action=list-ai-summaries', {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await r.json();
            if (!r.ok) { summariesList.innerHTML = `<p class="text-xs text-red-500">Error: ${data.error || r.status}</p>`; return; }
            const symbolSet = new Set(stocks.map(s => s.toUpperCase()));
            wlSummariesData = (data.summaries || []).filter(s => symbolSet.has(s.symbol.toUpperCase()));
            renderWlSummaries();
        } catch (e) {
            summariesList.innerHTML = '<p class="text-xs text-red-500">Network error.</p>';
        }
    }

    function renderWlSummaries() {
        if (!summariesList) return;
        if (!wlSummariesData.length) {
            summariesList.innerHTML = '<p class="text-xs text-gray-400 py-1">No summaries found for this watchlist this week. Use "Generate AI Summaries" above to create them.</p>';
            return;
        }
        summariesList.innerHTML = wlSummariesData.map((s, idx) => {
            const statusBadge = s.reviewed
                ? (s.approved
                    ? `<span class="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">Approved</span>`
                    : `<span class="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-600">Rejected</span>`)
                : `<span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Pending</span>`;
            const editedBadge = s.editedSummary
                ? `<span class="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-600">Edited</span>`
                : '';
            const displayText = escapeHtml(s.editedSummary || s.summary || '');
            const headlines = (s.headlines || []).map(h => `<li>${escapeHtml(h)}</li>`).join('');
            return `<div class="rounded-lg border border-gray-200 overflow-hidden mb-2" id="wl-sum-card-${idx}">
  <div class="flex flex-wrap items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100">
    <span class="font-bold text-xs text-gray-900">${escapeHtml(s.symbol)}</span>
    <span class="text-xs text-gray-400">${escapeHtml(s.companyName || '')}</span>
    ${statusBadge}${editedBadge}
    <div class="ml-auto flex gap-1.5">
      <button onclick="wlApprove(${idx})" class="rounded px-2 py-0.5 text-xs font-semibold bg-green-100 text-green-700 hover:bg-green-200 transition">Approve</button>
      <button onclick="wlEdit(${idx})" class="rounded px-2 py-0.5 text-xs font-semibold bg-blue-100 text-blue-700 hover:bg-blue-200 transition">Edit</button>
      <button onclick="wlReject(${idx})" class="rounded px-2 py-0.5 text-xs font-semibold bg-red-100 text-red-600 hover:bg-red-200 transition">Reject</button>
      <button id="wl-regen-${idx}" onclick="wlRegen(${idx})" class="rounded px-2 py-0.5 text-xs font-semibold bg-gray-100 text-gray-600 hover:bg-gray-200 transition">Regen</button>
    </div>
  </div>
  <div class="px-3 py-2">
    <div id="wl-sum-display-${idx}">
      <p class="text-xs text-gray-700 leading-relaxed mb-1.5">${displayText}</p>
      <details class="text-xs text-gray-400"><summary class="cursor-pointer font-medium">Headlines (${(s.headlines || []).length})</summary><ul class="mt-1 pl-4 space-y-0.5 list-disc">${headlines}</ul></details>
    </div>
    <div id="wl-sum-edit-${idx}" style="display:none;">
      <textarea id="wl-sum-ta-${idx}" class="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 leading-relaxed resize-y focus:outline-none focus:border-blue-400" rows="4">${displayText}</textarea>
      <div class="flex gap-2 mt-1.5">
        <button onclick="wlSaveEdit(${idx})" class="rounded px-2 py-0.5 text-xs font-semibold bg-green-100 text-green-700 hover:bg-green-200 transition">Save &amp; Approve</button>
        <button onclick="wlCancelEdit(${idx})" class="rounded px-2 py-0.5 text-xs font-semibold bg-gray-100 text-gray-500 hover:bg-gray-200 transition">Cancel</button>
      </div>
    </div>
  </div>
</div>`;
        }).join('');
    }

    async function wlUpdateSummary(idx, reviewed, approved, editedSummary) {
        const s = wlSummariesData[idx];
        if (!s) return false;
        const body = { symbol: s.symbol, weekOf: s.weekOf, reviewed, approved };
        if (editedSummary !== undefined) body.editedSummary = editedSummary;
        const token = localStorage.getItem('token');
        const r = await fetch('/api/admin?action=update-ai-summary', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) { const d = await r.json(); alert(`Error: ${d.error || r.status}`); return false; }
        return true;
    }

    window.wlApprove = async function(idx) {
        if (!await wlUpdateSummary(idx, true, true, undefined)) return;
        wlSummariesData[idx].reviewed = true;
        wlSummariesData[idx].approved = true;
        renderWlSummaries();
    };

    window.wlReject = async function(idx) {
        if (!await wlUpdateSummary(idx, true, false, undefined)) return;
        wlSummariesData[idx].reviewed = true;
        wlSummariesData[idx].approved = false;
        renderWlSummaries();
    };

    window.wlEdit = function(idx) {
        document.getElementById(`wl-sum-display-${idx}`).style.display = 'none';
        document.getElementById(`wl-sum-edit-${idx}`).style.display = 'block';
        const ta = document.getElementById(`wl-sum-ta-${idx}`);
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    };

    window.wlCancelEdit = function(idx) {
        document.getElementById(`wl-sum-display-${idx}`).style.display = 'block';
        document.getElementById(`wl-sum-edit-${idx}`).style.display = 'none';
    };

    window.wlSaveEdit = async function(idx) {
        const ta = document.getElementById(`wl-sum-ta-${idx}`);
        const edited = ta ? ta.value.trim() : '';
        if (!edited) { alert('Summary cannot be empty.'); return; }
        if (!await wlUpdateSummary(idx, true, true, edited)) return;
        wlSummariesData[idx].reviewed = true;
        wlSummariesData[idx].approved = true;
        wlSummariesData[idx].editedSummary = edited;
        renderWlSummaries();
    };

    window.wlRegen = async function(idx) {
        const s = wlSummariesData[idx];
        if (!s) return;
        const btn = document.getElementById(`wl-regen-${idx}`);
        if (btn) { btn.disabled = true; btn.textContent = '...'; }
        try {
            const token = localStorage.getItem('token');
            const r = await fetch('/api/admin?action=regenerate-ai-summary', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol: s.symbol }),
            });
            const data = await r.json();
            if (!r.ok) { alert(`Error: ${data.error || r.status}`); return; }
            wlSummariesData[idx] = Object.assign({}, wlSummariesData[idx], {
                summary: data.summary,
                editedSummary: undefined,
                reviewed: false,
                approved: false,
            });
            renderWlSummaries();
        } catch (e) {
            alert(`Request failed: ${e.message}`);
        } finally {
            const b = document.getElementById(`wl-regen-${idx}`);
            if (b) { b.disabled = false; b.textContent = 'Regen'; }
        }
    };

    if (refreshBtn) refreshBtn.addEventListener('click', loadWlSummaries);

    // Load summaries on init
    loadWlSummaries();
}

// ── Chart build ───────────────────────────────────────────────────────────────

function renderDashboardData(stockDataArray, period, tableBody) {
    lastRenderCache = { data: stockDataArray, period, tableBody };
    tableBody.empty();
    renderSummaryMetrics(stockDataArray, period);
    renderStockTableRows(tableBody, stockDataArray);
    renderScatterChart(stockDataArray);

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
    const isDark = document.documentElement.classList.contains('dark-mode');
    const axisColor = isDark ? '#e5e7eb' : '#374151';
    const valueAxisCfg = {
        beginAtZero: true,
        grid: {
            color:     ctx => ctx.tick.value === 0
                ? (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(17,24,39,0.55)')
                : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'),
            lineWidth: ctx => ctx.tick.value === 0 ? 2 : 1
        },
        ticks: { color: axisColor, font: { size: 12 }, callback: v => `${v}%` }
    };
    const labelAxisCfg = {
        grid: { display: false },
        ticks: { color: axisColor, font: { size: 12 } }
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
    updateNewsletterEmptyState();
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

    // Kick off AI summaries fetch immediately — it's independent of SMA data
    const newsFeed = $('#news-feed');
    newsFeed.html(`
        <div class="flex items-center gap-2 py-6 text-gray-400">
            <div class="animate-spin rounded-full h-4 w-4 border-2 border-blue-400 border-t-transparent shrink-0"></div>
            <span class="text-sm">Loading summaries…</span>
        </div>
    `);
    const summariesPromise = fetchAiSummaries(stocks);

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
            relativePrice: Number.isFinite(batch.relativePrice) ? batch.relativePrice : currentPrice / batch.sma - 1,
            peRatio:      batch.peRatio ?? null,
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

    aiSummariesCache = await summariesPromise;
    renderAiSummaries(newsFeed, stockDataArray);
    stopLoadingDots(newsLoading, null, '');
    saveDipfinderContentState();
}

// ── Pro: named watchlist tabs ─────────────────────────────────────────────────

function renderWatchlistTabs() {
    const container = document.getElementById('watchlist-tabs');
    if (!container) return;
    if (!window.IS_PRO) {
        container.style.display = 'none';
        return;
    }
    container.style.display = '';

    const allTabs = [
        { id: 'primary', name: primaryWatchlistName || 'Main', isPrimary: true },
        ...namedWatchlists.map(w => ({ id: w.id, name: w.name || 'Watchlist', isPrimary: false }))
    ];

    const tabsHtml = allTabs.map(tab => {
        const isActive = tab.id === activeWatchlistId;
        const starHtml = tab.isPrimary ? '<span style="color:#f59e0b;margin-right:3px;">&#9733;</span>' : '';
        const deleteHtml = !tab.isPrimary
            ? `<button class="wl-tab-del" data-id="${escapeHtml(tab.id)}" title="Delete watchlist" style="margin-left:4px;line-height:1;background:none;border:none;color:#9ca3af;cursor:pointer;font-size:14px;padding:0;">&#215;</button>`
            : '';
        const dragHandleHtml = !tab.isPrimary
            ? `<span class="wl-tab-drag-handle" title="Drag to reorder" style="cursor:grab;margin-right:4px;color:#9ca3af;font-size:11px;line-height:1;">&#8942;</span>`
            : '';
        return `<div class="wl-tab${isActive ? ' wl-tab--active' : ''}" data-id="${escapeHtml(tab.id)}" data-primary="${tab.isPrimary}" title="Double-click to rename"
            style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;user-select:none;transition:background 0.1s,color 0.1s,border-color 0.1s;">
            ${dragHandleHtml}${starHtml}<span class="wl-tab-name">${escapeHtml(tab.name)}</span>${deleteHtml}
        </div>`;
    }).join('');

    const newBtnHtml = namedWatchlists.length < 9
        ? `<button id="wl-new-btn" title="Create new watchlist" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;border:1px dashed #d1d5db;color:#9ca3af;background:none;transition:all 0.1s;">+ New</button>`
        : '';

    container.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:4px;">${tabsHtml}${newBtnHtml}</div>`;

    let tabDragSrc = null;

    container.querySelectorAll('.wl-tab').forEach(tabEl => {
        const tabId = tabEl.dataset.id;
        const isPrimary = tabEl.dataset.primary === 'true';

        tabEl.addEventListener('click', e => {
            if (e.target.classList.contains('wl-tab-del')) return;
            if (e.target.tagName === 'INPUT') return;
            switchWatchlist(tabId);
        });
        tabEl.addEventListener('dblclick', e => {
            if (e.target.tagName === 'INPUT') return;
            startRenameTab(tabEl, tabId);
        });

        // ── Tab is a drag source (named tabs only, via handle) ────────────
        if (!isPrimary) {
            const handle = tabEl.querySelector('.wl-tab-drag-handle');
            if (handle) {
                handle.addEventListener('mousedown', () => { tabEl.draggable = true; });
                handle.addEventListener('mouseup', () => { tabEl.draggable = false; });
            }
            tabEl.addEventListener('dragstart', e => {
                if (!tabEl.draggable) { e.preventDefault(); return; }
                tabDragSrc = tabEl;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('application/wl-tab', tabId);
                // Also set text/plain so stock-drop on THIS tab still works after dragend
                e.dataTransfer.setData('text/plain', '');
                setTimeout(() => { tabEl.style.opacity = '0.4'; }, 0);
            });
            tabEl.addEventListener('dragend', () => {
                tabEl.draggable = false;
                tabEl.style.opacity = '';
                container.querySelectorAll('.wl-tab').forEach(t => {
                    t.style.boxShadow = '';
                    t.style.outline = '';
                });
                tabDragSrc = null;
            });
        }

        // ── Tab is a drop target (stock-move OR tab-reorder) ──────────────
        const restoreTabStyle = () => {
            const isActive = tabId === activeWatchlistId;
            tabEl.classList.toggle('wl-tab--active', isActive);
            tabEl.classList.remove('wl-tab--draghover');
            tabEl.style.boxShadow = '';
        };

        tabEl.addEventListener('dragover', e => {
            const isTabDrag = e.dataTransfer.types.includes('application/wl-tab');

            if (isTabDrag) {
                // Tab reorder: accept on any tab except the source itself
                if (tabEl === tabDragSrc) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // Indicate insert-before or insert-after
                const mid = tabEl.getBoundingClientRect().left + tabEl.getBoundingClientRect().width / 2;
                container.querySelectorAll('.wl-tab').forEach(t => { t.style.boxShadow = ''; });
                if (e.clientX < mid) tabEl.style.boxShadow = '-3px 0 0 #3b82f6';
                else tabEl.style.boxShadow = '3px 0 0 #3b82f6';
                return;
            }

            // Stock move: highlight target tab
            if (tabId === activeWatchlistId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            tabEl.classList.add('wl-tab--draghover');
        });

        tabEl.addEventListener('dragleave', () => {
            restoreTabStyle();
            tabEl.style.boxShadow = '';
        });

        tabEl.addEventListener('drop', e => {
            e.preventDefault();

            // Tab reorder
            const draggedTabId = e.dataTransfer.getData('application/wl-tab');
            if (draggedTabId) {
                container.querySelectorAll('.wl-tab').forEach(t => { t.style.boxShadow = ''; });
                if (!tabDragSrc || tabEl === tabDragSrc) return;
                const tabs = [...container.querySelectorAll('.wl-tab')];
                const srcIdx = tabs.indexOf(tabDragSrc);
                const tgtIdx = tabs.indexOf(tabEl);
                const mid = tabEl.getBoundingClientRect().left + tabEl.getBoundingClientRect().width / 2;
                const insertBefore = e.clientX < mid;

                // Reorder namedWatchlists in memory (primary is not in namedWatchlists)
                const srcWlIdx = namedWatchlists.findIndex(w => w.id === draggedTabId);
                if (srcWlIdx === -1) return;
                const [moved] = namedWatchlists.splice(srcWlIdx, 1);

                // tgtIdx accounts for the primary tab at index 0, so named list index = tgtIdx - 1
                let insertAtNamed = tgtIdx - 1; // position in namedWatchlists
                if (!insertBefore) insertAtNamed++;
                insertAtNamed = Math.max(0, Math.min(namedWatchlists.length, insertAtNamed));
                namedWatchlists.splice(insertAtNamed, 0, moved);

                renderWatchlistTabs();

                // Persist
                const token = localStorage.getItem('token');
                if (token) {
                    fetch(`${BASE_URL}/api/watchlist`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({ action: 'reorder-watchlists', order: namedWatchlists.map(w => w.id) })
                    }).catch(() => {});
                }
                return;
            }

            // Stock move
            restoreTabStyle();
            const symbol = e.dataTransfer.getData('text/plain');
            if (!symbol || tabId === activeWatchlistId) return;
            moveStockToWatchlist(symbol, tabId);
        });
    });

    container.querySelectorAll('.wl-tab-del').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); deleteWatchlist(btn.dataset.id); });
    });

    const newBtn = container.querySelector('#wl-new-btn');
    if (newBtn) newBtn.addEventListener('click', createWatchlist);
}

function startRenameTab(tabEl, id) {
    const nameSpan = tabEl.querySelector('.wl-tab-name');
    if (!nameSpan) return;
    const current = nameSpan.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.maxLength = 40;
    input.style.cssText = 'font-size:11px;font-weight:600;border:none;outline:none;background:transparent;width:' + Math.max(60, current.length * 8) + 'px;color:inherit;padding:0;';
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
        const newName = input.value.trim() || current;
        await renameWatchlist(id, newName);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = current; input.blur(); }
    });
}

async function switchWatchlist(id) {
    if (id === activeWatchlistId) return;

    await saveWatchlistToDb();

    const token = localStorage.getItem('token');
    if (!token) return;

    // Persist active watchlist server-side (fire and forget)
    fetch(`${BASE_URL}/api/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'set-active', watchlistId: id })
    }).catch(() => {});

    activeWatchlistId = id;

    // Determine stocks for the new active watchlist
    let newStocks;
    if (id === 'primary') {
        newStocks = primaryStocksCache.slice();
    } else {
        const wl = namedWatchlists.find(w => w.id === id);
        newStocks = wl ? (wl.stocks || []) : [];
    }

    stocks = newStocks;
    localStorage.setItem('stocks', JSON.stringify(stocks));

    renderWatchlistTabs();

    const period = $('#sma-period').val() || '200';
    try { localStorage.removeItem(getDashboardCacheKey(period)); } catch (e) {}

    if (stocks.length > 0) {
        updateTableAndChart(period);
    } else {
        $('#stocks-table tbody').empty();
        if (chart) { chart.destroy(); chart = null; }
        if (scatterChart) { scatterChart.destroy(); scatterChart = null; }
        document.getElementById('admin-scatter-section')?.classList.add('hidden');
        document.getElementById('admin-tools-section')?.classList.add('hidden');
        lastRenderCache = { data: [], period, tableBody: $('#stocks-table tbody') };
        renderSummaryMetrics([], period);
        hideChartLoading();
    }
}

async function createWatchlist() {
    const token = localStorage.getItem('token');
    if (!token) return;
    const name = prompt('Name for new watchlist:', 'New Watchlist');
    if (!name) return;
    try {
        const res = await fetch(`${BASE_URL}/api/watchlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ action: 'create-watchlist', name: name.trim() })
        });
        const data = await res.json();
        if (!res.ok) { alert(data.error || 'Failed to create watchlist'); return; }
        namedWatchlists.push(data.watchlist);
        renderWatchlistTabs();
        await switchWatchlist(data.watchlist.id);
    } catch (e) { alert('Network error'); }
}

async function renameWatchlist(id, name) {
    if (id === 'primary') primaryWatchlistName = name;
    else {
        const wl = namedWatchlists.find(w => w.id === id);
        if (wl) wl.name = name;
    }
    renderWatchlistTabs();

    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${BASE_URL}/api/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'rename-watchlist', watchlistId: id, name })
    }).catch(() => {});
}

async function deleteWatchlist(id) {
    const wl = namedWatchlists.find(w => w.id === id);
    if (!confirm(`Delete watchlist "${wl ? wl.name : id}"? This cannot be undone.`)) return;

    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${BASE_URL}/api/watchlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ action: 'delete-watchlist', watchlistId: id })
        });
        const data = await res.json();
        if (!res.ok) { alert(data.error || 'Failed to delete watchlist'); return; }
        namedWatchlists = namedWatchlists.filter(w => w.id !== id);
        if (activeWatchlistId === id) {
            activeWatchlistId = 'primary';
            stocks = primaryStocksCache.slice();
            localStorage.setItem('stocks', JSON.stringify(stocks));
            const period = $('#sma-period').val() || '200';
            try { localStorage.removeItem(getDashboardCacheKey(period)); } catch (e) {}
            if (stocks.length > 0) updateTableAndChart(period);
            else {
                $('#stocks-table tbody').empty();
                if (chart) { chart.destroy(); chart = null; }
                if (scatterChart) { scatterChart.destroy(); scatterChart = null; }
                document.getElementById('admin-scatter-section')?.classList.add('hidden');
                document.getElementById('admin-tools-section')?.classList.add('hidden');
                hideChartLoading();
            }
        }
        renderWatchlistTabs();
    } catch (e) { alert('Network error'); }
}

// ── Drag-to-reorder (within watchlist) ───────────────────────────────────────

function attachDragToReorder() {
    const tbody = document.querySelector('#stocks-table tbody');
    if (!tbody) return;

    let dragSrc = null;

    const clearIndicators = () => {
        tbody.querySelectorAll('tr.stock-row').forEach(r => {
            r.style.borderTop = '';
            r.style.borderBottom = '';
        });
    };

    tbody.querySelectorAll('tr.stock-row').forEach(row => {
        let mousedownTarget = null;
        row.addEventListener('mousedown', e => { mousedownTarget = e.target; });

        row.addEventListener('dragstart', e => {
            // Only allow drag when initiated from the drag handle
            const handle = row.querySelector('.drag-handle');
            if (!handle || !handle.contains(mousedownTarget)) { e.preventDefault(); return; }
            isDragging = true;
            dragSrc = row;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', row.dataset.stock);
            setTimeout(() => { if (dragSrc) dragSrc.style.opacity = '0.4'; }, 0);
        });

        row.addEventListener('dragend', () => {
            if (dragSrc) dragSrc.style.opacity = '';
            clearIndicators();
            dragSrc = null;
            // Keep isDragging true briefly to swallow the immediate click event
            setTimeout(() => { isDragging = false; }, 80);
        });

        row.addEventListener('dragover', e => {
            if (!dragSrc || dragSrc === row) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            clearIndicators();
            const midY = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
            if (e.clientY < midY) row.style.borderTop = '2px solid #3b82f6';
            else row.style.borderBottom = '2px solid #3b82f6';
        });

        row.addEventListener('dragleave', () => {
            row.style.borderTop = '';
            row.style.borderBottom = '';
        });

        row.addEventListener('drop', e => {
            e.preventDefault();
            e.stopPropagation();
            if (!dragSrc || dragSrc === row) return;

            const midY = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
            if (e.clientY < midY) tbody.insertBefore(dragSrc, row);
            else tbody.insertBefore(dragSrc, row.nextSibling);

            clearIndicators();

            // Sync stocks array to new DOM order and persist
            const newOrder = [...tbody.querySelectorAll('tr.stock-row')].map(r => r.dataset.stock);
            stocks = newOrder;
            if (activeWatchlistId === 'primary') primaryStocksCache = stocks.slice();
            localStorage.setItem('stocks', JSON.stringify(stocks));
            saveWatchlistToDb();

            // Keep lastRenderCache in sync so theme toggle re-renders correctly
            if (lastRenderCache.data) {
                const pos = Object.fromEntries(newOrder.map((s, i) => [s, i]));
                lastRenderCache.data = [...lastRenderCache.data].sort((a, b) =>
                    (pos[a.stock] ?? 999) - (pos[b.stock] ?? 999));
            }
        });
    });
}

// ── Move stock to a different watchlist (pro, drag-to-tab) ────────────────────

async function moveStockToWatchlist(symbol, targetId) {
    const limit = window.IS_PRO ? 50 : 10;

    // Check target capacity
    const targetStocksNow = targetId === 'primary'
        ? primaryStocksCache
        : (namedWatchlists.find(w => w.id === targetId)?.stocks || []);
    if (targetStocksNow.length >= limit) {
        showWatchlistNotice(`Target watchlist is full (${limit} stocks).`, true);
        return;
    }

    // Remove from current watchlist in memory
    stocks = stocks.filter(s => s !== symbol);
    if (activeWatchlistId === 'primary') primaryStocksCache = stocks.slice();
    else {
        const cur = namedWatchlists.find(w => w.id === activeWatchlistId);
        if (cur) cur.stocks = stocks.slice();
    }
    localStorage.setItem('stocks', JSON.stringify(stocks));

    // Add to target watchlist in memory
    if (targetId === 'primary') {
        if (!primaryStocksCache.includes(symbol)) primaryStocksCache.push(symbol);
    } else {
        const tgt = namedWatchlists.find(w => w.id === targetId);
        if (tgt && !tgt.stocks.includes(symbol)) tgt.stocks.push(symbol);
    }

    // Remove row from DOM
    $(`tr.stock-row[data-stock="${CSS.escape(symbol)}"]`).remove();

    // Update chart
    if (chart) {
        const idx = chart.data.labels.indexOf(symbol);
        if (idx !== -1) {
            chart.data.labels.splice(idx, 1);
            const ds = chart.data.datasets[0];
            ds.data.splice(idx, 1);
            ds.backgroundColor.splice(idx, 1);
            ds.borderColor.splice(idx, 1);
            if (ds.stockData) {
                ds.stockData.splice(idx, 1);
                renderSummaryMetrics(ds.stockData, lastRenderCache.period || '200');
            }
            chart.update();
        }
    }

    // Update brief summaries
    delete aiSummariesCache[symbol];
    const remainingData = (lastRenderCache.data || []).filter(s => s.stock !== symbol);
    renderAiSummaries($('#news-feed'), remainingData);

    // Persist: save current watchlist
    await saveWatchlistToDb();

    // Persist: save target watchlist
    const token = localStorage.getItem('token');
    if (!token) return;
    const targetStocks = targetId === 'primary'
        ? primaryStocksCache
        : (namedWatchlists.find(w => w.id === targetId)?.stocks || []);
    fetch(`${BASE_URL}/api/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'save-watchlist', stocks: targetStocks, watchlistId: targetId })
    }).catch(() => {});
}

// ── Re-render chart on theme change ──────────────────────────────────────────
document.addEventListener('themechange', function() {
    if (lastRenderCache.data) {
        renderDashboardData(lastRenderCache.data, lastRenderCache.period, lastRenderCache.tableBody);
    }
});

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
            stocks = [];
        }
    } catch (error) {
        console.warn('Error reading stocks from localStorage:', error);
        stocks = [];
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
                // Restore news
                if (window.dipfinderContentCache.newsFeedHtml && newsFeed) {
                    newsFeed.innerHTML = window.dipfinderContentCache.newsFeedHtml;
                }
                if (window.dipfinderContentCache.newsTitleHtml && newsTitle) {
                    newsTitle.innerHTML = window.dipfinderContentCache.newsTitleHtml;
                }
            } else if (stocks.length > 0) {
                // HTML cache said rows exist but localStorage data is gone — fetch fresh
                const periodSelect = $('#sma-period');
                periodSelect.val(savedPeriod);
                updateTableAndChart(savedPeriod);
                return;
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
            if (validation.limitReached) {
                showLimitModal();
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
            relativePrice: Number.isFinite(batch.relativePrice) ? batch.relativePrice : (batch.currentPrice / batch.sma - 1),
            peRatio:       batch.peRatio ?? null,
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

        if (!chart) {
            // First stock in a newly created empty watchlist — full render to initialize bar chart
            renderDashboardData([...(lastRenderCache.data || []), newStockData], period, $('#stocks-table tbody'));
        } else {
            const updatedData = [...(lastRenderCache.data || []), newStockData];
            lastRenderCache.data = updatedData;
            renderScatterChart(updatedData);
        }

        if (input) { input.value = ''; input.disabled = false; }
        if (loadingEl) loadingEl.textContent = '';

        fetchAiSummaries([newStock]).then(newSummaries => {
            Object.assign(aiSummariesCache, newSummaries);
            renderAiSummaries($('#news-feed'), updatedData);
        });

        saveDipfinderContentState();
        updateNewsletterEmptyState();
    });

    $('#new-stock').keypress(function(event) {
        if (event.which === 13) $('#add-stock').click();
    });


    $(document).on('click.dipfinder', '.stock-row', function() {
        const stockSymbol = $(this).data('stock');
        if (stockSymbol) window.spaNavigate(`/screener?stock=${encodeURIComponent(stockSymbol)}`);
    });

    let lastAuthStatus = !!(window.AuthManager && window.AuthManager.isAuthenticated);
    renderWatchlistTabs();
    initNewsletterPromo();
    initFounderBanner();
    dipfinderAuthCheckInterval = setInterval(() => {
        try {
            const currentAuthStatus = !!(window.AuthManager && window.AuthManager.isAuthenticated);
            if (currentAuthStatus !== lastAuthStatus) {
                lastAuthStatus = currentAuthStatus;
                initNewsletterPromo();
                initFounderBanner();
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
    window.addEventListener('dipfinder:watchlistRestored', function(e) {
        try {
            const detail = (e && e.detail) || {};

            // Update pro globals
            if (detail.isPro !== undefined) window.IS_PRO = !!detail.isPro;
            if (detail.namedWatchlists) namedWatchlists = detail.namedWatchlists;
            if (detail.primaryWatchlistName) primaryWatchlistName = detail.primaryWatchlistName;
            if (detail.activeWatchlistId) activeWatchlistId = detail.activeWatchlistId;

            // Cache primary stocks so tab-switches can restore them
            const primaryStocks = detail.stocks || [];
            primaryStocksCache = primaryStocks.slice();

            // Load the right stocks for the active watchlist
            let activeStocks = primaryStocks;
            if (activeWatchlistId !== 'primary') {
                const activeWl = namedWatchlists.find(w => w.id === activeWatchlistId);
                if (activeWl) activeStocks = activeWl.stocks || [];
            }

            // Always persist the active watchlist stocks to localStorage so that a
            // hard reload picks up the right watchlist. auth.js overwrites
            // localStorage.stocks with primary stocks on every server verify;
            // if stocks in memory were already correct we'd skip this and leave
            // localStorage pointing at primary, breaking the next hard reload.
            localStorage.setItem('stocks', JSON.stringify(activeStocks));

            if (JSON.stringify(activeStocks) !== JSON.stringify(stocks)) {
                stocks = activeStocks;
                const period = $('#sma-period').val() || '200';
                try { localStorage.removeItem(getDashboardCacheKey(period)); } catch (e) {}
                if (document.getElementById('stocks-table')) updateTableAndChart(period);
            }

            renderWatchlistTabs();
        } catch (e) { console.warn('Error handling watchlistRestored:', e); }
    });

    // ── ?add=TICKER deep-link handler ─────────────────────────────────────────
    // Links like /app?add=AAPL&source=brief_radar pre-add a ticker on landing.
    // Strips the param from the URL immediately so refresh doesn't re-trigger.
    (function handleAddParam() {
        const urlParams = new URLSearchParams(window.location.search);
        const rawTicker = (urlParams.get('add') || '').toUpperCase().trim();
        const source    = urlParams.get('source') || '';
        if (!rawTicker) return;

        // Validate ticker format: 1-5 letters, optional .X or .XX suffix (e.g. BRK.B)
        if (!/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(rawTicker)) return;

        // Strip ?add and ?source from URL immediately
        urlParams.delete('add');
        urlParams.delete('source');
        const qs = urlParams.toString();
        history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);

        if (source) console.log('[radar-cta] add:', rawTicker, 'source:', source);

        // Show "Adding…" immediately so the user gets feedback before the 2s wait.
        const dismissPending = showToast(`Adding ${rawTicker} to your watchlist…`, { type: 'info', duration: 10000 });

        function doAdd() {
            const token = localStorage.getItem('token');

            // Not logged in — prompt sign-in
            if (!token) {
                dismissPending();
                showToast(`Sign in to add ${rawTicker} to your watchlist.`, { type: 'info', duration: 6000 });
                const modal = document.getElementById('auth-modal');
                if (modal) modal.classList.remove('hidden');
                return;
            }

            // Already in watchlist
            if (stocks.includes(rawTicker)) {
                dismissPending();
                showToast(`${rawTicker} is already in your watchlist.`, { type: 'info' });
                return;
            }

            // At tier limit
            const limit = getCurrentStockLimit();
            if (stocks.length >= limit) {
                dismissPending();
                if (!window.IS_PRO) {
                    showLimitModal();
                } else {
                    showToast(`Watchlist full (${limit} stocks). Remove a ticker to add ${rawTicker}.`, { type: 'error' });
                }
                return;
            }

            // Happy path: watch for the new row to appear, then confirm + highlight it.
            const tbody = document.querySelector('#stocks-table tbody');
            if (tbody) {
                const observer = new MutationObserver(() => {
                    const newRow = tbody.querySelector(`tr[data-stock="${rawTicker}"]`);
                    if (!newRow) return;
                    observer.disconnect();
                    dismissPending();
                    showToast(`${rawTicker} added to your watchlist.`, { type: 'success' });
                    // Highlight the new row briefly
                    newRow.style.transition = 'background 0.4s';
                    newRow.style.background = '#eff6ff';
                    setTimeout(() => { newRow.style.background = ''; }, 1800);
                    // Scroll it into view
                    newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                });
                observer.observe(tbody, { childList: true });
                // Safety: disconnect after 8s if add never completes (e.g. bad ticker)
                setTimeout(() => { observer.disconnect(); dismissPending(); }, 8000);
            }

            // Inject ticker into input and trigger existing add flow
            const input = document.getElementById('new-stock');
            if (input) input.value = rawTicker;
            $('#add-stock').click();
        }

        // Wait for dipfinder:watchlistRestored so IS_PRO and the accurate stocks
        // array are in place. Fall back after 2s if the event already fired or is slow.
        let handled = false;
        const handle = () => { if (!handled) { handled = true; doAdd(); } };
        window.addEventListener('dipfinder:watchlistRestored', handle, { once: true });
        setTimeout(handle, 2000);
    })();

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

// ── Newsletter promo: auth-aware init ────────────────────────────────────────

let newsletterPromoInitialized = false;

function initNewsletterPromo() {
    if (newsletterPromoInitialized) return;
    const promo = document.getElementById('newsletter-promo');
    if (!promo) return;

    const token = localStorage.getItem('token');
    if (!token) return; // not logged in — app requires auth

    newsletterPromoInitialized = true;

    fetch('/api/user?action=profile', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => {
            const promo = document.getElementById('newsletter-promo');
            if (!promo) return;

            if (data.sundayBriefSubscribed) {
                promo.remove();
                return;
            }

            // Not yet subscribed — reveal promo and prefill email
            promo.style.display = '';

            // Prefill email, disable input, show edit link
            const input = document.getElementById('newsletter-email-v2');
            if (input && data.email) {
                input.value = data.email;
                input.dataset.originalEmail = data.email;
                input.disabled = true;
                input.classList.add('bg-gray-100', 'text-gray-400', 'cursor-not-allowed', 'opacity-60', 'select-none');
                input.classList.remove('bg-white', 'border-gray-300');

                const editLink = document.createElement('button');
                editLink.type = 'button';
                editLink.textContent = 'Update my email';
                editLink.className = 'mt-1.5 text-xs text-teal-700 hover:text-teal-900 underline underline-offset-2 block w-full text-center';
                editLink.addEventListener('click', () => {
                    input.disabled = false;
                    input.classList.remove('bg-gray-100', 'text-gray-400', 'cursor-not-allowed', 'opacity-60', 'select-none');
                    input.classList.add('bg-white', 'border-gray-300');
                    editLink.remove();
                    input.focus();
                    input.select();
                });
                const errorEl = document.getElementById('newsletter-email-error');
                if (errorEl) errorEl.insertAdjacentElement('afterend', editLink);
            }
        })
        .catch(() => {});
}

// ── Founder banner: show for free users who haven't dismissed ────────────────

let founderBannerInitialized = false;

function initFounderBanner() {
    if (founderBannerInitialized) return;
    const banner = document.getElementById('founder-banner');
    if (!banner) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    founderBannerInitialized = true;

    fetch('/api/user?action=subscription-status', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => {
            // Set admin flag and re-render scatter if data already loaded
            window.IS_ADMIN = !!data.isAdmin;
            if (window.IS_ADMIN) {
                if (lastRenderCache.data) renderScatterChart(lastRenderCache.data);
                initAdminTools();
            }

            // Don't show founder banner to Pro or founding members
            if (data.isPro || data.foundingMember) return;
            // Don't show if already dismissed
            if (data.founderBannerDismissedAt) return;

            const banner = document.getElementById('founder-banner');
            if (!banner) return;
            banner.classList.remove('hidden');

            const dismissBtn = document.getElementById('founder-banner-dismiss');
            if (dismissBtn) {
                dismissBtn.addEventListener('click', () => {
                    banner.remove();
                    fetch('/api/user?action=dismiss-founder-banner', {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}` },
                    }).catch(() => {});
                });
            }
        })
        .catch(() => {});
}

// ── Newsletter empty-state toggle ─────────────────────────────────────────────

function updateNewsletterEmptyState() {
    const newsSection = document.getElementById('news-section');
    if (newsSection) newsSection.classList.remove('hidden');
}

// ── Newsletter signup ─────────────────────────────────────────────────────────

(function() {
    document.addEventListener('click', function(e) {
        if (!e.target.matches('#newsletter-submit-v2')) return;
        const input   = document.getElementById('newsletter-email-v2');
        const errMsg  = document.getElementById('newsletter-email-error');
        const form    = document.getElementById('newsletter-form-content');
        const confirm = document.getElementById('newsletter-confirm-content');
        const promo   = document.getElementById('newsletter-promo');
        if (!input || !form || !confirm || !promo) return;

        const authToken = localStorage.getItem('token');

        // Validate email format
        if (!input.value.trim() || !input.checkValidity()) {
            input.classList.add('border-red-400', 'ring-2', 'ring-red-100');
            input.classList.remove('border-gray-200');
            if (errMsg) errMsg.classList.remove('hidden');
            input.focus();
            return;
        }

        // Clear any error state
        input.classList.remove('border-red-400', 'ring-2', 'ring-red-100');
        input.classList.add('border-gray-200');
        if (errMsg) errMsg.classList.add('hidden');

        window.umami?.track('newsletter_subscribe', { hasEmail: true });

        if (authToken) {
            // Logged-in path: update email preferences, then show confirmation
            const payload = { sundayBriefSubscribed: true };
            const originalEmail = input.dataset.originalEmail;
            const currentEmail = input.value.trim();
            if (originalEmail && currentEmail !== originalEmail) {
                payload.email = currentEmail;
            }
            fetch('/api/user?action=update-email-preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify(payload)
            }).catch(() => {});
            showConfirmation();
        } else {
            // Guest path: create account via newsletter-subscribe
            const email = input.value.trim();
            const watchlistSymbols = Array.isArray(stocks) ? stocks.filter(s => typeof s === 'string') : [];
            fetch('/api/user?action=newsletter-subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, watchlist: watchlistSymbols })
            }).then(async (r) => {
                const data = await r.json();
                if (data.userExists) {
                    // Already has an account - open login modal with a message
                    const modal = document.getElementById('auth-modal');
                    if (modal) modal.classList.remove('hidden');
                    window.showLoginForm?.();
                    const loginEmailEl = document.getElementById('login-email');
                    if (loginEmailEl) loginEmailEl.value = email;
                    window.showAuthSuccess?.('You already have an account. Sign in to manage your subscription.');
                    return;
                }
                if (data.token) {
                    localStorage.setItem('token', data.token);
                    window.MAX_STOCKS = 10;
                    window.AuthManager?.checkAuthStatus?.();
                }
                showConfirmation();
            }).catch(() => showConfirmation());
        }

        function showConfirmation() {
            // Fade out form, fade in confirmation
            form.style.opacity = '0';
            form.style.pointerEvents = 'none';
            setTimeout(() => { confirm.style.opacity = '1'; }, 400);
            // Fade out and remove the whole card after a moment
            setTimeout(() => {
                promo.style.transition = 'opacity 0.6s ease';
                promo.style.opacity = '0';
                setTimeout(() => promo.remove(), 600);
            }, 4000);
        }
    });

    // Clear error state as soon as the user starts correcting the email
    document.addEventListener('input', function(e) {
        if (!e.target.matches('#newsletter-email-v2')) return;
        const input  = document.getElementById('newsletter-email-v2');
        const errMsg = document.getElementById('newsletter-email-error');
        if (input && input.checkValidity()) {
            input.classList.remove('border-red-400', 'ring-2', 'ring-red-100');
            input.classList.add('border-gray-200');
            if (errMsg) errMsg.classList.add('hidden');
        }
    });
})();

// ── SPA teardown ──────────────────────────────────────────────────────────────

window.destroyDipfinder = function() {
    newsletterPromoInitialized = false;
    saveDipfinderContentState();

    if (chart) {
        chart.destroy();
        chart = null;
    }
    if (scatterChart) {
        scatterChart.destroy();
        scatterChart = null;
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
