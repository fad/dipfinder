// Your list of stocks
let stocks = []; // Initialize as empty array, will be populated in document ready
let chart; // Global variable to hold the chart instance
let notificationCache = {}; // Cache for notifications
let MAX_STOCKS = 10; // Default for guests, updated by auth.js
const BASE_URL = window.location.origin;

// Function to save stocks to localStorage
function saveStocks() {
    // Only save if we have valid stocks array and we're on a page that manages stocks
    if (Array.isArray(stocks) && stocks.length >= 0) {
        // Enforce limit before saving
        stocks = enforceStockLimit(stocks);
        localStorage.setItem('stocks', JSON.stringify(stocks));
    }
}

// Function to get current stock limit based on authentication status
function getCurrentStockLimit() {
    // Check if user is authenticated and what their limit should be
    try {
        if (window.AuthManager && window.AuthManager.isAuthenticated) {
            return 20; // Authenticated users get 20 stocks
        }
    } catch (error) {
        console.warn('Error checking authentication status:', error);
    }
    return 10; // Guest users get 10 stocks (fallback)
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

// Function to validate stocks array against current limits
function validateStocksArray() {
    const originalLength = stocks.length;
    stocks = enforceStockLimit(stocks);
    
    if (stocks.length !== originalLength) {
/*console.log(`Stocks array trimmed from ${originalLength} to ${stocks.length} due to limit enforcement`);*/ 
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
            alert(`Your stock list has been trimmed to ${limit} stocks (${authStatus} user limit). Please log in to increase your limit to 20 stocks.`);
        }
        
        return true; // Array was modified
    }
    return false; // Array unchanged
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
    const response = await fetch(`${BASE_URL}/sma/${stock}?period=${period}`);
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
    const res = await fetch(`${BASE_URL}/batch-stocks`, {
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

// Function to update the table and chart
async function updateTableAndChart(period) {
    // Show loading indicators
    let stocksLoading = startLoadingDots('stocks-loading');
    let smaLoading = startLoadingDots('sma-loading');
    let newsLoading = startLoadingDots('news-loading');

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

    // Sort the stock data array alphabetically for the table
    stockDataArray.sort((a, b) => a.stock.localeCompare(b.stock));

    // Append the sorted data to the table
    stockDataArray.forEach(data => {
        const dailyChangeColor = data.dailyChange < 0 ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600';
        const dailyChangeSign = data.dailyChange < 0 ? '-' : '+';

        tableBody.append(`
            <tr>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="text-sm font-medium text-gray-900">${data.stock}</div>
                    <div class="text-sm text-gray-500">${truncateString(data.companyName, 30)}</div>
                </td>
                <td class="px-1 py-4 whitespace-nowrap text-center">
                    ${data.currentPrice.toFixed(2)}$
                    <div class="text-xs ${dailyChangeColor} p-1 rounded mt-1">
                        ${dailyChangeSign}${Math.abs(data.dailyChange).toFixed(2)}%
                    </div>
                </td>
                <td class="px-1 py-4 whitespace-nowrap text-center">
                    <button class="remove-stock text-red-600 hover:text-red-900" data-stock="${data.stock}">
                        <i class="fas fa-trash-alt"></i>                        
                    </button>
                </td>
            </tr>
        `);
    });

    // Sort the stock data array by relative price for the chart
    stockDataArray.sort((a, b) => a.relativePrice - b.relativePrice);

    const chartLabels = [];
    const relativePrices = [];
    const backgroundColors = [];
    const borderColors = [];

    for (const data of stockDataArray) {
        chartLabels.push(data.stock);
        relativePrices.push((data.relativePrice * 100).toFixed(2));

        // Set the color based on the relative price value
        if (data.relativePrice < 0) {
            backgroundColors.push('rgba(255, 99, 132, 0.2)'); // Red for negative values
            borderColors.push('rgba(255, 99, 132, 1)');
        } else {
            backgroundColors.push('rgba(75, 192, 192, 0.2)'); // Green for positive values
            borderColors.push('rgba(75, 192, 192, 1)');
        }
    }

    // Destroy the existing chart instance if it exists
    if (chart) {
        chart.destroy();
    }

    // Update chart
    const ctx = document.getElementById('stocks-chart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: chartLabels,
            datasets: [
                {
                    label: `Price relative to ${period}-Day SMA`,
                    data: relativePrices,
                    backgroundColor: backgroundColors,
                    borderColor: borderColors,
                    borderWidth: 1
                }
            ]
        },
        options: {
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) {
                            return value + '%'; // Add '%' sign to y-axis labels
                        }
                    }
                }
            }
        }
    });

    // Fetch and display news (after main data is loaded)
    const newsFeed = $("#news-feed");
    newsFeed.empty();
    const newsPromises = stocks.map(stock => fetchNews(stock));
    const newsResults = await Promise.all(newsPromises);
    const allNews = newsResults.flat();

    // Sort news by date in descending order
    allNews.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

    // Limit to 20 news articles
    const limitedNews = allNews.slice(0, 20);

    limitedNews.forEach(article => {
        const date = new Date(article.datetime * 1000).toLocaleDateString();
        newsFeed.append(`
            <div class="p-4 border-b border-gray-200">
                <h3 class="text-lg font-semibold">${article.headline}</h3>
                <p class="text-sm text-gray-500">${date} - ${article.source}</p>
                <p class="text-sm mt-2">${article.summary}</p>
                <a href="${article.url}" target="_blank" class="text-blue-500 hover:underline">Read more</a>
            </div>
        `);
    });

    stopLoadingDots(newsLoading, 'news-loading', 'Loaded');

    // Add event listeners to remove buttons
    $(".remove-stock").click(function() {
        const stockToRemove = $(this).data("stock");
        stocks = stocks.filter(stock => stock !== stockToRemove);
        saveStocks();
        updateTableAndChart(period);
        $("#stock-limit-message").addClass("hidden");
    });
}

// Legacy authentication functions for compatibility (auth.js provides the actual implementation)
// These are here to prevent errors if called before auth.js loads
function loadProfile() {
    // Delegate to auth manager if available, otherwise just check auth status
    if (window.AuthManager) {
        return window.AuthManager.checkAuthStatus();
    } else if (typeof checkAuthStatus === 'function') {
        return checkAuthStatus();
    }
    return Promise.resolve(false);
}

// CAPTCHA callback
function onCaptchaSuccess() {
    const forgotBtn = document.getElementById("forgot-btn");
    if (forgotBtn) {
        forgotBtn.disabled = false;
    }
}

function onCaptchaExpired() {
    const forgotBtn = document.getElementById("forgot-btn");
    if (forgotBtn) {
        forgotBtn.disabled = true;
    }
}

// Initialize the table and chart on page load
$(document).ready(function() {
    // Initialize stocks from localStorage first
    try {
        const storedStocks = localStorage.getItem('stocks');
        if (storedStocks) {
            stocks = JSON.parse(storedStocks);
/*console.log('Loaded stocks from localStorage:', stocks);*/ 
            
            // Validate and enforce limits on loaded stocks
            const wasModified = validateStocksArray();
            if (wasModified) {
/*console.log('Stock array was modified due to limit enforcement');*/ 
            }
        } else {
            // Only set defaults if we're on the main Dip Finder page (has stocks table)
            const isMainPage = document.getElementById('stocks-table') !== null;
            stocks = isMainPage ? ["CRM", "MSFT", "AAPL", "INTU"] : [];
/*console.log('Initialized stocks - isMainPage:', isMainPage, 'stocks:', stocks);*/ 
            
            // Validate defaults against current limits
            stocks = enforceStockLimit(stocks);
            
            // Save defaults only if we're on main page
            if (isMainPage && stocks.length > 0) {
                localStorage.setItem('stocks', JSON.stringify(stocks));
            }
        }
    } catch (error) {
        console.warn('Error reading stocks from localStorage:', error);
        const isMainPage = document.getElementById('stocks-table') !== null;
        stocks = isMainPage ? ["CRM", "MSFT", "AAPL", "INTU"] : [];
/*console.log('Error recovery - isMainPage:', isMainPage, 'stocks:', stocks);*/ 
    }

    const periodSelect = $('#sma-period');
    
    // Debug: Log current page and stocks state
    const isMainPage = periodSelect.length > 0 && $('#stocks-table').length > 0;
/*console.log('Page loaded - isMainPage:', isMainPage, 'stocks:', stocks);*/ 
    
    // Only run table update code if we're on the main page (check for required elements)
    if (isMainPage) {
        // Load the selected period from localStorage or use the default value
        const savedPeriod = localStorage.getItem('selectedPeriod') || '200';
        periodSelect.val(savedPeriod);

        updateTableAndChart(periodSelect.val());

        // Update table and chart when the SMA period is changed
        periodSelect.change(function() {
            const selectedPeriod = $(this).val();
            saveSelectedPeriod(selectedPeriod);
            updateTableAndChart(selectedPeriod);
        });
    }

    // Add new stock to the list and update table and chart
    $('#add-stock').click(async function() {
        const newStock = $('#new-stock').val().toUpperCase();
        if (!newStock) return;

        // Check if already in list
        if (stocks.includes(newStock)) {
            // Show error below the stock input, but outside the flex/button row
            let msgBox = document.getElementById('stock-add-error');
            if (!msgBox) {
                msgBox = document.createElement('div');
                msgBox.id = 'stock-add-error';
                msgBox.style.color = 'red';
                msgBox.style.margin = '8px 0';
                // Insert after the parent div of the input/button
                const parent = document.getElementById('new-stock').parentNode;
                if (parent.nextSibling) {
                    parent.parentNode.insertBefore(msgBox, parent.nextSibling);
                } else {
                    parent.parentNode.appendChild(msgBox);
                }
            }
            msgBox.textContent = `Ticker ${newStock} is already in your list.`;
            setTimeout(() => { msgBox.textContent = ''; }, 2500);
            return;
        } else {
            // Clear error if present
            const msgBox = document.getElementById('stock-add-error');
            if (msgBox) msgBox.textContent = '';
        }

        const stockData = await fetchStockData(newStock);
        if (!stockData) {
            alert(`Failed to fetch data for ${newStock}. Please check the ticker and try again.`);
            return; // Do not add the invalid ticker to the list
        }
        // Extra safety: check for error property
        if (stockData.error) {
            alert(`Failed to fetch data for ${newStock}`);
            return;
        }

        if (stocks.length < MAX_STOCKS) {
            stocks.push(newStock);
            saveStocks();
            updateTableAndChart(periodSelect.val());
            $('#new-stock').val(''); // Clear input field
        } else if (stocks.length >= MAX_STOCKS) {
            $("#stock-limit-message").removeClass("hidden");
        }
    });

    // Handle "Enter" key press for adding stock
    $('#new-stock').keypress(function(event) {
        if (event.which == 13) {
            $('#add-stock').click();
        }
    });

    // Initialize user profile - auth.js will handle this
    loadProfile();
});
