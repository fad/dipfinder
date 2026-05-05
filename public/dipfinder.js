// Your list of stocks
let stocks = []; // Initialize as empty array, will be populated in document ready
let chart; // Global variable to hold the chart instance
let notificationCache = {}; // Cache for notifications
window.MAX_STOCKS = 10; // Default for guests, updated by auth.js
const BASE_URL = window.location.origin;

// --- SPA Lifecycle variables ---
let dipfinderAuthCheckInterval;
let dipfinderLocalStorageCheckInterval;
let dipfinderEventListeners = [];
let dipfinderAutocompleteInstance = null;

// --- State preservation for SPA navigation ---
window.dipfinderContentCache = window.dipfinderContentCache || {
    stocksTableHtml: null,
    chartData: null,
    newsFeedHtml: null,
    isInitialized: false,
    lastUpdated: null
};
// ---

// Function to save stocks to localStorage
function saveStocks() {
    // Only save if we have valid stocks array and we're on a page that manages stocks
    if (Array.isArray(stocks) && stocks.length >= 0) {
        // Enforce limit before saving
        stocks = enforceStockLimit(stocks);
        localStorage.setItem('stocks', JSON.stringify(stocks));
    }
}

// Function to save selected SMA period to localStorage
function saveSelectedPeriod(period) {
    localStorage.setItem('selectedPeriod', period);
}

// Function to truncate a string
function truncateString(str, num) {
    if (str.length <= num) {
        return str;
    }
    return str.slice(0, num) + '...';
}

// Function to fetch stock data from the Node.js proxy server
async function fetchStockData(stock) {
    let response;
    try {
        response = await fetch(`${BASE_URL}/api/stock-data/${stock}?action=price`);
        if (!response.ok) {
            throw new Error(`Error fetching data for ${stock}: ${response.statusText}`);
        }
        const data = await response.json();
        // If the API returns an error property, treat as invalid
        if (data.error) return null;
        return data;
    } catch (error) {
        console.error(`Error fetching data for ${stock}: ${response ? response.statusText : 'No response'} Error: ${error}`);
        return null; // Return null if there's an error
    }
}

// Function to fetch SMA data from the Node.js proxy server
async function fetchSMA(stock, period) {
    const response = await fetch(`${BASE_URL}/api/stock-data/${stock}?action=sma&period=${period}`);
    const data = await response.json();
    return data;
}

// Function to fetch company name from the Node.js proxy server
async function fetchCompanyName(stock) {
    const response = await fetch(`${BASE_URL}/api/stock-data/${stock}?action=company-name`);
    const data = await response.json();
    return data.name;
}

// Function to fetch news from the Node.js proxy server
async function fetchNews(stock) {
    try {
        const response = await fetch(`${BASE_URL}/api/stock-data/${stock}?action=news`);
        if (!response.ok) {
            throw new Error(`Error fetching news for ${stock}: ${response.statusText}`);
        }
        const data = await response.json();
        return data.news;
    } catch (error) {
        console.error(error);
        return []; // Return an empty array if the news fetch fails
    }
}

// Function to batch fetch stock and SMA data
async function fetchBatchStockSMA(stocks, period) {
    const res = await fetch(`${BASE_URL}/api/batch-stocks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stocks, period })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Batch fetch failed');
    return data.results;
}

// Minimalistic loading animation helper
function startLoadingDots(elementId) {
    let dots = 1;
    const el = document.getElementById(elementId);
    if (!el) return null;
    el.textContent = '.';
    return setInterval(() => {
        dots = dots % 3 + 1; // 1 -> 2 -> 3 -> 1 ...
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

// Function to get current stock limit based on authentication status
function getCurrentStockLimit() {
    // Check if user is authenticated and what their limit should be
    try {
        if (window.AuthManager && window.AuthManager.isAuthenticated) {
            return 8; // Authenticated users get 8 stocks
        }
    } catch (error) {
        console.warn('Error checking authentication status:', error);
    }
    return 5; // Guest users get 10 stocks (fallback)
}

// Function to enforce stock limit on an array
function enforceStockLimit(stockArray) {
    const limit = getCurrentStockLimit();
    if (stockArray.length > limit) {
        console.warn(`Stock limit exceeded. Trimming from ${stockArray.length} to ${limit} stocks.`);
        // Keep the first 'limit' stocks, remove excess
        return stockArray.slice(0, limit);
    }
    return stockArray;
}

function attachRemoveStockListeners() {
/*console.log('Attaching remove stock listeners');*/ 
    // First remove any existing handlers to prevent duplicates
    $(document).off('click.dipfinder', '.remove-stock'); 
    
    // Add event listeners to remove buttons
    $(".remove-stock").click(function() {
/*console.log('Remove stock button clicked - 2:', $(this).data("stock"));*/ 
        const stockToRemove = $(this).data("stock");
        stocks = stocks.filter(stock => stock !== stockToRemove);
        saveStocks();
        const period = $('#sma-period').val() || '200';
        updateTableAndChart(period);
        $("#stock-limit-message").addClass("hidden");
    });
}

// Function to validate stocks array against current limits
function validateStocksArray() {
    const originalLength = stocks.length;
    stocks = enforceStockLimit(stocks);
    
    if (stocks.length !== originalLength) {
/*console.log(`Stocks array trimmed from ${originalLength} to ${stocks.length} due to limitations.`);*/ 
        saveStocks(); // Save the corrected array
        
        // Update MAX_STOCKS for UI consistency
        window.MAX_STOCKS = getCurrentStockLimit();
        
        // Show message to user if on main page
        if (document.getElementById('stocks-table')) {
            const limit = getCurrentStockLimit();
            let authStatus = 'guest';
            try {
                authStatus = window.AuthManager && window.AuthManager.isAuthenticated ? 'authenticated' : 'guest';
            } catch (error) {
                console.warn('Error checking auth status for message:', error);
            }
            alert(`Your stock list has been trimmed to ${limit} stocks (${authStatus} user limit). Please log in to increase your limit to 8 stocks.`);
        }
        
        return true; // Array was modified
    }
    return false; // Array unchanged
}

// Function to add stock with proper limit checking
function addStockWithValidation(newStock) {
    if (stocks.includes(newStock)) {
        return { success: false, error: `Ticker ${newStock} is already in your list.` };
    }
    
    const limit = getCurrentStockLimit();
    if (stocks.length >= limit) {
        let authStatus = 'guest';
        try {
            authStatus = window.AuthManager && window.AuthManager.isAuthenticated ? 'authenticated' : 'guest';
        } catch (error) {
            console.warn('Error checking auth status for limit message:', error);
        }
        return { 
            success: false, 
            error: `Stock limit reached (${limit} stocks for logged-in users). ${authStatus === 'guest' ? 'Please log in to increase your limit to 8 stocks.' : ''}` 
        };
    }
    
    // This function now only validates, it does not modify the stocks array.
    return { success: true };
}

// Helper functions for chart UI
function showChartLoading() {
    const chartLoading = document.getElementById('chart-loading');
    if (chartLoading) {
        chartLoading.classList.remove('hidden');
    }
}

function hideChartLoading() {
    const chartLoading = document.getElementById('chart-loading');
    if (chartLoading) {
        chartLoading.classList.add('hidden');
    }
}

function updatePeriodDisplay(period) {
    const periodDisplay = document.getElementById('selected-period-display');
    if (periodDisplay) {
        periodDisplay.textContent = `${period}-Day SMA`;
    }
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

function getSmaDiffPercent(data) {
    if (!Number.isFinite(data.relativePrice)) return null;
    return data.relativePrice * 100;
}

function getSortableSmaDiff(data) {
    const diffPercent = getSmaDiffPercent(data);
    return Number.isFinite(diffPercent) ? diffPercent : Number.POSITIVE_INFINITY;
}

function getSmaDiffClasses(diffPercent) {
    if (!Number.isFinite(diffPercent)) return 'bg-gray-100 text-gray-600';
    if (diffPercent < 0) return 'bg-red-100 text-red-700';
    return 'bg-green-100 text-green-700';
}

function renderSummaryMetrics(stockDataArray, period) {
    const biggestDipEl = document.getElementById('metric-biggest-dip');
    const biggestDipDetailEl = document.getElementById('metric-biggest-dip-detail');
    const belowSmaEl = document.getElementById('metric-below-sma');
    const belowSmaDetailEl = document.getElementById('metric-below-sma-detail');
    const averageDipEl = document.getElementById('metric-average-dip');
    const averageDipDetailEl = document.getElementById('metric-average-dip-detail');
    const strongestAboveEl = document.getElementById('metric-strongest-above');
    const strongestAboveDetailEl = document.getElementById('metric-strongest-above-detail');

    const validRows = stockDataArray.filter(data => Number.isFinite(getSmaDiffPercent(data)));
    if (validRows.length === 0) {
        [biggestDipEl, belowSmaEl, averageDipEl, strongestAboveEl].forEach(el => { if (el) el.textContent = '--'; });
        if (biggestDipDetailEl) biggestDipDetailEl.textContent = 'Waiting for watchlist data';
        if (belowSmaDetailEl) belowSmaDetailEl.textContent = `${period}-Day SMA`;
        if (averageDipDetailEl) averageDipDetailEl.textContent = 'Mean distance vs SMA';
        if (strongestAboveDetailEl) strongestAboveDetailEl.textContent = 'Best positive spread';
        return;
    }

    const sortedByDiff = [...validRows].sort((a, b) => getSortableSmaDiff(a) - getSortableSmaDiff(b));
    const biggestDip = sortedByDiff[0];
    const strongestAbove = sortedByDiff[sortedByDiff.length - 1];
    const belowCount = validRows.filter(data => getSmaDiffPercent(data) < 0).length;
    const averageDiff = validRows.reduce((sum, data) => sum + getSmaDiffPercent(data), 0) / validRows.length;

    if (biggestDipEl) biggestDipEl.textContent = `${biggestDip.stock} ${formatPercent(getSmaDiffPercent(biggestDip))}`;
    if (biggestDipDetailEl) biggestDipDetailEl.textContent = `vs ${period}-Day SMA ${formatCurrency(biggestDip.sma)}`;
    if (belowSmaEl) belowSmaEl.textContent = `${belowCount} / ${validRows.length}`;
    if (belowSmaDetailEl) belowSmaDetailEl.textContent = `Trading below ${period}-Day SMA`;
    if (averageDipEl) averageDipEl.textContent = formatPercent(averageDiff);
    if (averageDipDetailEl) averageDipDetailEl.textContent = `Average vs ${period}-Day SMA`;
    if (strongestAboveEl) strongestAboveEl.textContent = `${strongestAbove.stock} ${formatPercent(getSmaDiffPercent(strongestAbove))}`;
    if (strongestAboveDetailEl) strongestAboveDetailEl.textContent = `vs ${period}-Day SMA ${formatCurrency(strongestAbove.sma)}`;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatNewsDate(value) {
    if (!value) return 'Recent';
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Recent';
    return date.toLocaleDateString();
}

function getNewsTimestamp(value) {
    if (!value) return 0;
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getArticleKey(article) {
    return (article.url || article.headline || '').toLowerCase().trim();
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
        const deduped = [];
        const seen = new Set();

        newsByTicker[ticker]
            .sort((a, b) => getNewsTimestamp(b.datetime) - getNewsTimestamp(a.datetime))
            .forEach(article => {
                const key = getArticleKey(article);
                if (!key || seen.has(key)) return;
                seen.add(key);
                deduped.push(article);
            });

        const visibleArticles = deduped.slice(0, 3);
        const hiddenArticles = deduped.slice(3, 6);

        const visibleHtml = visibleArticles.map(article => renderNewsArticle(article, false)).join('');
        const hiddenHtml = hiddenArticles.map(article => renderNewsArticle(article, true)).join('');
        const buttonHtml = hiddenArticles.length > 0
            ? `<button type="button" class="view-more-news mt-3 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700" data-ticker="${ticker}">View more news</button>`
            : '';

        newsFeed.append(`
            <section class="mb-5 rounded-xl border border-gray-200 bg-white p-4 last:mb-0">
                <div class="mb-3 flex items-center justify-between gap-3">
                    <h3 class="text-base font-bold text-gray-900">${ticker}</h3>
                    <span class="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600">${deduped.length} articles</span>
                </div>
                <div class="space-y-3" data-news-group="${ticker}">
                    ${visibleHtml}
                    ${hiddenHtml}
                </div>
                ${buttonHtml}
            </section>
        `);
    });
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

// Render stock table rows
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

// Function to update the table and chart
async function updateTableAndChart(period) {
    // Show loading indicators
    let stocksLoading = startLoadingDots('stocks-loading');
    let smaLoading = startLoadingDots('sma-loading');
    let newsLoading = startLoadingDots('news-loading');
    showChartLoading();
    updatePeriodDisplay(period);

    const tableBody = $("#stocks-table tbody");
    tableBody.empty(); // Clear existing table data
    const stockDataArray = [];
    let removedStocks = [];

    // Fetch stock and SMA data in batch
    let batchResults;
    try {
        batchResults = await fetchBatchStockSMA(stocks, period);
    } catch (err) {
        // Try to identify and remove problematic tickers
        let removedStocks = [];
        for (let stock of stocks) {
            try {
                const data = await fetchStockData(stock);
                if (!data || data.error) removedStocks.push(stock);
            } catch (e) {
                removedStocks.push(stock);
            }
        }
        if (removedStocks.length > 0) {
            stocks = stocks.filter(s => !removedStocks.includes(s));
            saveStocks();
            stopLoadingDots(stocksLoading, 'stocks-loading', '');
            stopLoadingDots(smaLoading, 'sma-loading', '');
            stopLoadingDots(newsLoading, 'news-loading', '');
            alert('Removed invalid stocks: ' + removedStocks.join(', '));
            updateTableAndChart(period);
            return;
        } else {
            stopLoadingDots(stocksLoading, 'stocks-loading', 'Failed');
            stopLoadingDots(smaLoading, 'sma-loading', 'Failed');
            stopLoadingDots(newsLoading, 'news-loading', '');
            alert('Failed to fetch stock data.');
            return;
        }
    }
    stopLoadingDots(stocksLoading, 'stocks-loading', '');
    stopLoadingDots(smaLoading, 'sma-loading', '');

    // Fetch company names in parallel (can be batched if needed)
    const companyNamePromises = stocks.map(stock => fetchCompanyName(stock));
    const companyNameArray = await Promise.all(companyNamePromises);

    for (let i = 0; i < stocks.length; i++) {
        const batch = batchResults[i];
        // Remove stock if backend error or no data
        if (!batch || !batch.stockData) {
            removedStocks.push(stocks[i]);
            continue;
        }
        const stockData = batch.stockData;
        const sma = batch.sma;
        const companyName = companyNameArray[i];

        const prices = stockData.chart.result[0].indicators.quote[0].close;
        const currentPrice = prices[prices.length - 1];
        const previousPrice = prices[prices.length - 2];
        const dailyChange = ((currentPrice - previousPrice) / previousPrice) * 100;
        const relativePrice = currentPrice / sma - 1;

        stockDataArray.push({
            stock: stocks[i],
            companyName: companyName,
            currentPrice,
            dailyChange,
            sma,
            relativePrice
        });
    }

    // Remove invalid stocks and update localStorage if needed
    if (removedStocks.length > 0) {
        stocks = stocks.filter(s => !removedStocks.includes(s));
        saveStocks();
        stopLoadingDots(stocksLoading, 'stocks-loading', '');
        stopLoadingDots(smaLoading, 'sma-loading', '');
        stopLoadingDots(newsLoading, 'news-loading', '');
        // Optionally, show a message to the user
        alert('Removed invalid stocks: ' + removedStocks.join(', '));
        // Re-run updateTableAndChart to refresh UI with valid stocks only
        updateTableAndChart(period);
        return;
    }

    // Sort the watchlist by biggest dip first.
    stockDataArray.sort((a, b) => getSortableSmaDiff(a) - getSortableSmaDiff(b));
    renderSummaryMetrics(stockDataArray, period);

    // Append the sorted data to the table
    renderStockTableRows(tableBody, stockDataArray);

    const chartLabels = [];
    const relativePrices = [];
    const backgroundColors = [];
    const borderColors = [];
    const chartPointData = [];

    for (const data of stockDataArray) {
        const diffPercent = getSmaDiffPercent(data);
        chartLabels.push(data.stock);
        relativePrices.push(Number.isFinite(diffPercent) ? Number(diffPercent.toFixed(2)) : null);
        chartPointData.push(data);

        // Set the color based on the relative price value
        if (diffPercent < 0) {
            backgroundColors.push('rgba(239, 68, 68, 0.7)');
            borderColors.push('rgba(220, 38, 38, 1)');
        } else {
            backgroundColors.push('rgba(16, 185, 129, 0.7)');
            borderColors.push('rgba(5, 150, 105, 1)');
        }
    }

    // Destroy the existing chart instance if it exists
    if (chart) {
        chart.destroy();
    }

    // Update chart - check if element exists first
    const chartElement = document.getElementById('stocks-chart');
    if (!chartElement) {
        console.warn('Chart element not found - skipping chart update');
        return;
    }
    
    const ctx = chartElement.getContext('2d');
    
    chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: chartLabels,
            datasets: [
                {
                    label: `% vs ${period}-Day SMA`,
                    data: relativePrices,
                    stockData: chartPointData,
                    backgroundColor: backgroundColors,
                    borderColor: borderColors,
                    borderWidth: 1,
                    borderRadius: 6,
                    barThickness: 18,
                    maxBarThickness: 22
                }
            ]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
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
                        color: function(context) {
                            return context.tick.value === 0 ? 'rgba(17, 24, 39, 0.55)' : 'rgba(0, 0, 0, 0.08)';
                        },
                        lineWidth: function(context) {
                            return context.tick.value === 0 ? 2 : 1;
                        }
                    },
                    ticks: {
                        color: '#374151',
                        font: {
                            size: 12
                        },
                        callback: function(value) {
                            return `${value}%`;
                        }
                    }
                },
                y: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        color: '#374151',
                        font: {
                            size: 12
                        }
                    }
                }
            }
        }
    });

    // Hide chart loading indicator
    hideChartLoading();

    // Fetch and display news (after main data is loaded)
    const newsFeed = $("#news-feed");
    newsFeed.empty();
    
    // Update news title with current stocks in watchlist
    if (stocks.length > 0) {
        $("#news-title").text('News by ticker');
    }

    const newsPromises = stocks.map(stock => fetchNews(stock));
    const newsResults = await Promise.all(newsPromises);
    const newsByTicker = {};
    stocks.forEach((stock, index) => {
        newsByTicker[stock] = Array.isArray(newsResults[index]) ? newsResults[index] : [];
    });
    renderNewsByTicker(newsFeed, newsByTicker);

    $(document).off('click.dipfinderNews', '.view-more-news');
    $(document).on('click.dipfinderNews', '.view-more-news', function() {
        const ticker = $(this).data('ticker');
        $(`[data-news-group="${ticker}"] .ticker-news-item.hidden`).removeClass('hidden');
        $(this).remove();
    });

    stopLoadingDots(newsLoading, 'news-loading', 'Loaded');

    // Add event listeners to remove buttons
    attachRemoveStockListeners();

    // Add click handlers for stock rows to navigate to screener
    $("#stocks-table").off("click.dipfinderRows", ".stock-row");
    $("#stocks-table").on("click.dipfinderRows", ".stock-row", function() {
        const stockSymbol = $(this).data("stock");
        if (stockSymbol) {
            // Navigate to screener using the SPA router
            window.spaNavigate(`/screener?stock=${encodeURIComponent(stockSymbol)}`);
        }
    });
    
    // Save the content state after everything is loaded
    saveDipfinderContentState();
}

window.initializeDipfinder = function() {
    // Helper functions for the custom select dropdown. These need to be defined
    // before they are used.
    function initCustomSelect() {
        const customSelect = document.getElementById('sma-period-custom');
        if (!customSelect) return;

        const trigger = customSelect.querySelector('.custom-select-trigger');
        const options = customSelect.querySelector('.custom-select-options');
        
        if (!trigger || !options) return;

        // Toggle dropdown when clicking the trigger
        const toggleDropdown = () => {
            customSelect.classList.toggle('active');
        };
        trigger.addEventListener('click', toggleDropdown);
        dipfinderEventListeners.push({ element: trigger, type: 'click', handler: toggleDropdown });

        // Handle option selection
        const optionsHandler = e => {
            // Target the custom-select-option div elements or their child spans
            const optionEl = e.target.closest('.custom-select-option');
            if (optionEl) {
                const value = optionEl.dataset.value;
                
                // Update the trigger text
                const triggerText = customSelect.querySelector('#sma-period-text');
                if (triggerText) {
                    triggerText.textContent = optionEl.querySelector('span').textContent;
                }
                
                // Remove active class from all options and add to selected
                const allOptions = options.querySelectorAll('.custom-select-option');
                allOptions.forEach(opt => opt.classList.remove('active'));
                optionEl.classList.add('active');
                
                // Close dropdown
                customSelect.classList.remove('active');
                
                // Trigger period change event
                changeSMAPeriod(value);
            }
        };
        options.addEventListener('click', optionsHandler);
        dipfinderEventListeners.push({ element: options, type: 'click', handler: optionsHandler });

        // Close dropdown when clicking outside - using the global function
        document.addEventListener('click', window.closeCustomSelectOnClickOutside);
        dipfinderEventListeners.push({ element: document, type: 'click', handler: window.closeCustomSelectOnClickOutside });
        
        // Close dropdown when pressing Escape - using the global function
        document.addEventListener('keydown', window.closeCustomSelectOnEscape);
        dipfinderEventListeners.push({ element: document, type: 'keydown', handler: window.closeCustomSelectOnEscape });
    }

    function updateCustomSelectDisplay(value) {
        const customSelect = document.getElementById('sma-period-custom');
        if (!customSelect) return;
        
        const triggerText = customSelect.querySelector('#sma-period-text');
        if (!triggerText) return;
        
        const options = customSelect.querySelector('.custom-select-options');
        if (!options) return;
        
        // Find the option with matching value
        const selectedOption = options.querySelector(`.custom-select-option[data-value="${value}"]`);
        
        if (selectedOption) {
            // Update trigger text
            const optionText = selectedOption.querySelector('span').textContent;
            triggerText.textContent = optionText;
            
            // Update active class
            const allOptions = options.querySelectorAll('.custom-select-option');
            allOptions.forEach(opt => opt.classList.remove('active'));
            selectedOption.classList.add('active');
        }
    }

    // 1. Load and validate stocks from localStorage. This is independent of the DOM.
    try {
        const storedStocks = localStorage.getItem('stocks');
        if (storedStocks) {
            stocks = JSON.parse(storedStocks);
        } else {
            stocks = ["CRM", "MSFT", "AAPL", "INTU"];
            localStorage.setItem('stocks', JSON.stringify(stocks));
        }
    } catch (error) {
        console.warn('Error reading stocks from localStorage, setting defaults:', error);
        stocks = ["CRM", "MSFT", "AAPL", "INTU"];
    }

    const wasModified = validateStocksArray();
    if (wasModified) {
/*console.log('Stock array was modified due to limit enforcement during initialization.');*/ 
    }

    // 2. Check if the dipfinder page content is actually in the DOM.
    const isMainPage = document.getElementById('stocks-table');
    if (!isMainPage) {
        return; // Exit if the page isn't loaded
    }

    // 3. Check for cached content and restore it if it exists and is recent
    const stocksTable = document.getElementById('stocks-table');
    const stocksChart = document.getElementById('stocks-chart');
    const newsFeed = document.getElementById('news-feed');
    const newsTitle = document.getElementById('news-title');
    const restoreCachedContent = window.dipfinderContentCache.isInitialized && 
                                window.dipfinderContentCache.lastUpdated && 
                                (Date.now() - window.dipfinderContentCache.lastUpdated < 15 * 60 * 1000); // Less than 15 minutes old
    
    if (restoreCachedContent) {
/*console.log('Restoring cached dipfinder content, number of stocks:', stocks.length);*/ 
        
        // Restore stocks table
        if (window.dipfinderContentCache.stocksTableHtml && stocksTable) {
            const tbody = stocksTable.querySelector('tbody');
/*console.log('Restoring stocks table HTML from cache');*/ 
            
            if (tbody) {
                // Check if the cached HTML content actually has rows before restoring
                if (window.dipfinderContentCache.stocksTableHtml && 
                    window.dipfinderContentCache.stocksTableHtml.includes('stock-row')) {
/*console.log('Restoring cached tbody content');*/ 
                    tbody.innerHTML = window.dipfinderContentCache.stocksTableHtml;
                } else if (stocks.length > 0) {
/*console.log('No valid rows in cache, will render stock rows');*/ 
                    const periodSelect = $('#sma-period');
                    const savedPeriod = localStorage.getItem('selectedPeriod') || '200';
                    periodSelect.val(savedPeriod);
                    updateTableAndChart(periodSelect.val());
                    attachStockRowEvents();
                    return;
                }
            }
        } else if (stocks.length > 0 && stocksTable) {
/*console.log('No cached table content, preparing table structure');*/ 
            const periodSelect = $('#sma-period');
            const savedPeriod = localStorage.getItem('selectedPeriod') || '200';
            periodSelect.val(savedPeriod);
            updateTableAndChart(periodSelect.val());
            attachStockRowEvents();
            return;
        }

        // Re-attach event listeners to restored stock rows
        attachStockRowEvents();
        // Re-attach remove stock listeners
        attachRemoveStockListeners();

        // Restore chart
        if (window.dipfinderContentCache.chartData && stocksChart) {
            restoreChart(stocksChart, window.dipfinderContentCache.chartData);
        }
        
        // Restore news feed
        if (window.dipfinderContentCache.newsFeedHtml && newsFeed) {
            newsFeed.innerHTML = window.dipfinderContentCache.newsFeedHtml;
        }
        
        // Restore news title
        if (window.dipfinderContentCache.newsTitleHtml && newsTitle) {
            newsTitle.innerHTML = window.dipfinderContentCache.newsTitleHtml;
        }
    }

    // 4. All DOM-dependent initialization goes here.
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

    // Initialize auto-complete for the stock input
    if (window.initStockAutocomplete) {
        dipfinderAutocompleteInstance = initStockAutocomplete('new-stock', {
            onSelection: async function(ticker, match) {
                const addButton = $('#add-stock');
                addButton.prop('disabled', true);
                addButton.text('Add');
                addButton.click();
            }
        });
    }

    function resetAddButton() {
        const addButton = $('#add-stock');
        addButton.prop('disabled', false);
        addButton.text('Add');
    }

    $('#add-stock').click(async function() {
        const newStock = $('#new-stock').val().toUpperCase();
        if (!newStock) {
            resetAddButton();
            return;
        }

        const msgBox = document.getElementById('stock-add-error');
        if (msgBox) msgBox.textContent = '';

        const validation = addStockWithValidation(newStock);
        if (!validation.success) {
            let errorBox = document.getElementById('stock-add-error');
            if (!errorBox) {
                errorBox = document.createElement('div');
                errorBox.id = 'stock-add-error';
                errorBox.style.color = 'red';
                errorBox.style.margin = '8px 0';
                errorBox.style.fontSize = '14px';
                const parent = document.getElementById('new-stock').parentNode;
                if (parent.nextSibling) {
                    parent.parentNode.insertBefore(errorBox, parent.nextSibling);
                } else {
                    parent.parentNode.appendChild(errorBox);
                }
            }
            errorBox.textContent = validation.error;
            setTimeout(() => { if(errorBox) errorBox.textContent = ''; }, 4000);
            resetAddButton();
            return;
        }

        const stockData = await fetchStockData(newStock);
        if (!stockData || stockData.error) {
            let errorBox = document.getElementById('stock-add-error');
            if (!errorBox) {
                errorBox = document.createElement('div');
                errorBox.id = 'stock-add-error';
                errorBox.style.color = 'red';
                errorBox.style.margin = '8px 0';
                errorBox.style.fontSize = '14px';
                const parent = document.getElementById('new-stock').parentNode;
                if (parent.nextSibling) {
                    parent.parentNode.insertBefore(errorBox, parent.nextSibling);
                } else {
                    parent.parentNode.appendChild(errorBox);
                }
            }
            errorBox.textContent = `Failed to fetch data for ${newStock}. Please check the ticker and try again.`;
            setTimeout(() => { if(errorBox) errorBox.textContent = ''; }, 4000);
            resetAddButton();
            return;
        }

        stocks.push(newStock);
        saveStocks();
        updateTableAndChart(periodSelect.val());
        $('#new-stock').val('');
        resetAddButton();
    });

    $('#new-stock').keypress(function(event) {
        if (event.which == 13) {
            $('#add-stock').click();
        }
    });

    $(document).off('click.dipfinder', '.remove-stock'); // Remove any existing handlers
    $(document).on('click.dipfinder', '.remove-stock', function(e) {
/*console.log('Remove stock button clicked:', $(this).data("stock"));*/ 
        e.stopPropagation();
        const stockToRemove = $(this).data("stock");
        stocks = stocks.filter(stock => stock !== stockToRemove);
        saveStocks();
        const period = $('#sma-period').val() || '200';
        updateTableAndChart(period);
        $("#stock-limit-message").addClass("hidden");
    });

    $(document).on('click.dipfinder', '.stock-row', function() {
        const stockSymbol = $(this).data("stock");
        if (stockSymbol) {
            window.spaNavigate(`/screener?stock=${encodeURIComponent(stockSymbol)}`);
        }
    });

    let lastAuthStatus = false;
    dipfinderAuthCheckInterval = setInterval(() => {
        try {
            const currentAuthStatus = window.AuthManager && window.AuthManager.isAuthenticated;
            if (currentAuthStatus !== lastAuthStatus) {
                lastAuthStatus = currentAuthStatus;
                window.MAX_STOCKS = getCurrentStockLimit();
                const wasModified = validateStocksArray();
                if (wasModified) {
                    if (document.getElementById('stocks-table')) {
                        const periodSelect = $("#sma-period");
                        updateTableAndChart(periodSelect.val() || '200');
                    }
                }
            }
        } catch (error) {
            console.warn('Error checking authentication status:', error);
        }
    }, 1000);

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
                        const periodSelect = $("#sma-period");
                        updateTableAndChart(periodSelect.val() || '200');
                    }
                }
            }
        } catch (error) {
            console.error('Error checking localStorage:', error);
        }
    }, 5000);
}

// Function to change the SMA period and update the chart
function changeSMAPeriod(period) {
    // Update the hidden select element value (for compatibility)
    const periodSelect = $('#sma-period');
    if (periodSelect.length) {
        periodSelect.val(period).trigger('change');
    } else {
        // If the select doesn't exist, handle the change directly
        saveSelectedPeriod(period);
        updateTableAndChart(period);
    }
}

window.destroyDipfinder = function() {
    // Save current state before destroying
    saveDipfinderContentState();
    
    // Only destroy the chart instance, but keep the chart data cached
    if (chart) {
        chart.destroy();
        chart = null;
    }
    
    clearInterval(dipfinderAuthCheckInterval);
    clearInterval(dipfinderLocalStorageCheckInterval);

    // Remove event listeners
    $('#add-stock').off('click');
    $('#new-stock').off('keypress');
    $('#sma-period').off('change');
    $(document).off('click.dipfinder'); // Remove namespaced listeners

    // Destroy autocomplete instance
    if (dipfinderAutocompleteInstance && dipfinderAutocompleteInstance.destroy) {
        dipfinderAutocompleteInstance.destroy();
        dipfinderAutocompleteInstance = null;
    }
    
    // Cleanup for custom select
    dipfinderEventListeners.forEach(listener => {
        listener.element.removeEventListener(listener.type, listener.handler);
    });
    dipfinderEventListeners = []; // Clear for next init

    document.removeEventListener('click', window.closeCustomSelectOnClickOutside);
    document.removeEventListener('keydown', window.closeCustomSelectOnEscape);

/*console.log('Dipfinder state saved and listeners/intervals destroyed');*/ 
}

window.closeCustomSelectOnClickOutside = function(e) {
    const customSelect = document.getElementById('sma-period-custom');
    if (customSelect && !customSelect.contains(e.target)) {
        customSelect.classList.remove('active');
    }
};

window.closeCustomSelectOnEscape = function(e) {
    if (e.key === 'Escape') {
        const customSelect = document.getElementById('sma-period-custom');
        if(customSelect) customSelect.classList.remove('active');
    }
};


// Keep this for now for backward compatibility if any other script calls it.
$(document).ready(function() {
    if (window.location.pathname === '/' || window.location.pathname === '/index.html') {
        // initializeDipfinder();
    }
});

// Function to save the current UI state to the cache
function saveDipfinderContentState() {
    const stocksTable = document.getElementById('stocks-table');
    const stocksChart = document.getElementById('stocks-chart');
    const newsFeed = document.getElementById('news-feed');
    const newsTitle = document.getElementById('news-title');
    
    if (stocksTable) {
        const tbody = stocksTable.querySelector('tbody');
        if (tbody) {
            if (stocks && stocks.length > 0) {
                window.dipfinderContentCache.stocksTableHtml = tbody.innerHTML;
            } else {
                // Don't overwrite existing cached content with empty/loading state
/*console.log('Not caching empty stock table');*/ 
            }
        }
    }
    
    if (chart) {
        window.dipfinderContentCache.chartData = {
            data: chart.data,
            options: chart.options
        };
    }
    
    if (newsFeed) {
        window.dipfinderContentCache.newsFeedHtml = newsFeed.innerHTML;
    }
    
    if (newsTitle) {
        window.dipfinderContentCache.newsTitleHtml = newsTitle.innerHTML;
    }
    
    window.dipfinderContentCache.isInitialized = true;
    window.dipfinderContentCache.lastUpdated = Date.now();
    
/*console.log('Dipfinder state saved');*/ 
}

// Function to restore chart from cached data
function restoreChart(canvas, chartData) {
    if (!canvas || !chartData) return;
    
    // If chart instance already exists, destroy it
    if (chart) {
        chart.destroy();
    }
    
    // Create a new chart with cached data
    const ctx = canvas.getContext('2d');
    chart = new Chart(ctx, {
        type: 'bar',
        data: JSON.parse(JSON.stringify(chartData.data)), // Deep clone to avoid reference issues
        options: JSON.parse(JSON.stringify(chartData.options))
    });
}

// Re-attach event listeners to stock rows
function attachStockRowEvents() {
    // Attach click events to stock rows
    $('.stock-row').click(function() {
        const stockSymbol = $(this).data('stock');
        if (stockSymbol) {
            // Navigate to screener with stock symbol
            window.spaNavigate(`/screener?stock=${encodeURIComponent(stockSymbol)}`);
        }
    });
    
    // Attach delete button events
    $('.delete-stock').click(function(e) {
        e.stopPropagation();
        const symbol = $(this).closest('tr').data('symbol');
        removeStock(symbol);
    });
}
