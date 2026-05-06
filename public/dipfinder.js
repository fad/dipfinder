// dipfinder.js — Dashboard: data helpers, display helpers, lifecycle + chart wiring

// ── Shared globals (var so other scripts can access via window scope) ─────────
var stocks = [];  // populated from localStorage in initializeDipfinder
var chart;        // Chart.js instance; created/destroyed in renderDashboardData

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
    return `dipfinder-dashboard:${period}:${stocks.join(',')}`;
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

    if (biggestDipEl)       biggestDipEl.textContent       = `${biggestDip.stock} ${formatPercent(getSmaDiffPercent(biggestDip))}`;
    if (biggestDipDetailEl) biggestDipDetailEl.textContent = `vs ${period}-Day SMA ${formatCurrency(biggestDip.sma)}`;
    if (belowSmaEl)         belowSmaEl.textContent         = `${belowCount} / ${validRows.length}`;
    if (belowSmaDetailEl)   belowSmaDetailEl.textContent   = `Trading below ${period}-Day SMA`;
    if (averageDipEl)       averageDipEl.textContent       = formatPercent(averageDiff);
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
            <tr class="stock-row grid cursor-pointer gap-3 px-4 py-4 transition-colors duration-200 hover:bg-gray-50" style="grid-template-columns: minmax(0, 1fr) auto 40px; align-items: center;" data-stock="${data.stock}">
                <td class="min-w-0">
                    <div class="text-sm font-medium text-gray-900">${data.stock}</div>
                    <div class="truncate text-sm text-gray-500">${truncateString(data.companyName, 30)}</div>
                </td>
                <td class="whitespace-nowrap text-right">
                    <div class="text-sm font-medium text-gray-900">${formatCurrency(data.currentPrice)}</div>
                    <div class="text-xs text-gray-500">SMA ${formatCurrency(data.sma)}</div>
                    <div class="mt-1 rounded px-2 py-1 text-xs font-semibold ${diffClasses}">
                        ${formatPercent(diffPercent)}
                    </div>
                </td>
                <td class="flex justify-end">
                    <button class="remove-stock relative z-10 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-red-50 text-red-600 transition hover:bg-red-100 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-200" data-stock="${data.stock}" title="Remove ${data.stock}" aria-label="Remove ${data.stock}" onclick="event.stopPropagation();">
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
    const summary = article.summary || 'Summary unavailable from this source.';
    const hiddenClass = hidden ? ' hidden' : '';
    return `
        <article class="ticker-news-item${hiddenClass}">
            <a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer" class="block text-sm font-semibold text-gray-900 transition hover:text-blue-700 hover:underline">
                ${escapeHtml(article.headline || 'Untitled article')}
            </a>
            <p class="mt-1 text-xs text-gray-500">${escapeHtml(article.source || 'Unknown source')} - ${formatNewsDate(article.datetime)}</p>
            <p class="mt-1 text-sm text-gray-600">${escapeHtml(truncateString(summary, 150))}</p>
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
    tickers.forEach(ticker => {
        appendTickerNewsSection(newsFeed, ticker, newsByTicker[ticker]);
    });
}

function appendTickerNewsSection(newsFeed, ticker, articles) {
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
    if (deduped.length === 0) return;

    const visibleHtml = deduped.slice(0, 3).map(a => renderNewsArticle(a, false)).join('');
    const hiddenHtml  = deduped.slice(3, 6).map(a => renderNewsArticle(a, true)).join('');
    const buttonHtml  = deduped.length > 3
        ? `<button type="button" class="view-more-news mt-3 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700" data-ticker="${escapeHtml(ticker)}">View more news</button>`
        : '';

    newsFeed.append(`
        <section class="mb-5 rounded-xl border border-gray-200 bg-white p-4 last:mb-0">
            <div class="mb-3 flex items-center justify-between gap-3">
                <h3 class="text-base font-bold text-gray-900">${escapeHtml(ticker)}</h3>
                <span class="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600">${deduped.length} articles</span>
            </div>
            <div class="space-y-3" data-news-group="${escapeHtml(ticker)}">
                ${visibleHtml}${hiddenHtml}
            </div>
            ${buttonHtml}
        </section>
    `);
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
        if (window.AuthManager && window.AuthManager.isAuthenticated) return 8;
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
                ? `Watchlist trimmed to ${limit} stocks. Log in to save up to 8.`
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
            error: `Stock limit reached (${limit} stocks). ${authStatus === 'guest' ? 'Please log in to increase your limit to 8 stocks.' : ''}`
        };
    }
    return { success: true };
}

// ── Remove stock in-place ─────────────────────────────────────────────────────

function removeStockFromUI(stockToRemove) {
    const period = $('#sma-period').val() || '200';

    $(`tr.stock-row[data-stock="${CSS.escape(stockToRemove)}"]`).remove();

    stocks = stocks.filter(s => s !== stockToRemove);
    saveStocks();

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

    $('#news-feed section').filter(function() {
        return $(this).find('h3').text().trim() === stockToRemove;
    }).remove();

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
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const data = context.dataset.stockData[context.dataIndex];
                            if (!data) return `${context.parsed.x}%`;
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
                x: {
                    beginAtZero: true,
                    grid: {
                        color:     ctx => ctx.tick.value === 0 ? 'rgba(17, 24, 39, 0.55)' : 'rgba(0, 0, 0, 0.08)',
                        lineWidth: ctx => ctx.tick.value === 0 ? 2 : 1
                    },
                    ticks: {
                        color: '#374151',
                        font: { size: 12 },
                        callback: value => `${value}%`
                    }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: '#374151', font: { size: 12 } }
                }
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

    const newsFeed = $('#news-feed');
    newsFeed.empty();
    if (stocks.length > 0) $('#news-title').text('News by ticker');

    const newsResults = await Promise.all(stocks.map(stock => fetchNews(stock)));
    const newsByTicker = {};
    stocks.forEach((stock, i) => {
        newsByTicker[stock] = Array.isArray(newsResults[i]) ? newsResults[i] : [];
    });
    renderNewsByTicker(newsFeed, newsByTicker);

    $(document).off('click.dipfinderNews', '.view-more-news');
    $(document).on('click.dipfinderNews', '.view-more-news', function() {
        const ticker = $(this).data('ticker');
        $(`[data-news-group="${ticker}"] .ticker-news-item.hidden`).removeClass('hidden');
        $(this).remove();
    });

    stopLoadingDots(newsLoading, 'news-loading', 'Loaded');
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

    // Autocomplete
    if (window.initStockAutocomplete) {
        dipfinderAutocompleteInstance = initStockAutocomplete('new-stock', {
            onSelection: async function() {
                $('#add-stock').click();
            }
        });
    }

    // Add stock handler
    $('#add-stock').click(async function() {
        const newStock = $('#new-stock').val().toUpperCase();
        if (!newStock) return;

        const msgBox = document.getElementById('stock-add-error');
        if (msgBox) msgBox.textContent = '';

        const validation = addStockWithValidation(newStock);
        if (!validation.success) {
            showAddError(validation.error);
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
        saveStocks();

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
            if (articles && articles.length > 0) {
                appendTickerNewsSection($('#news-feed'), newStock, articles);
            }
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
        saveStocks();
        try { localStorage.removeItem(getDashboardCacheKey(period)); } catch (e) {}
        updateTableAndChart(period);
    });

    $(document).on('click.dipfinder', '.stock-row', function() {
        const stockSymbol = $(this).data('stock');
        if (stockSymbol) window.spaNavigate(`/screener?stock=${encodeURIComponent(stockSymbol)}`);
    });

    // Auth change watcher
    let lastAuthStatus = false;
    dipfinderAuthCheckInterval = setInterval(() => {
        try {
            const currentAuthStatus = window.AuthManager && window.AuthManager.isAuthenticated;
            if (currentAuthStatus !== lastAuthStatus) {
                lastAuthStatus = currentAuthStatus;
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
