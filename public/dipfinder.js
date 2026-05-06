// dipfinder.js — Dashboard lifecycle, orchestration, chart wiring
// Depends on: dashboard-data.js, dashboard-render.js

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
        if (diffPercent < 0) {
            backgroundColors.push('rgba(239, 68, 68, 0.7)');
            borderColors.push('rgba(220, 38, 38, 1)');
        } else {
            backgroundColors.push('rgba(16, 185, 129, 0.7)');
            borderColors.push('rgba(5, 150, 105, 1)');
        }
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
            if (diffPercent < 0) {
                ds.backgroundColor.push('rgba(239, 68, 68, 0.7)');
                ds.borderColor.push('rgba(220, 38, 38, 1)');
            } else {
                ds.backgroundColor.push('rgba(16, 185, 129, 0.7)');
                ds.borderColor.push('rgba(5, 150, 105, 1)');
            }
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
