// screener.js - Stock Screener page logic

// --- State preservation for SPA navigation ---
window.screenerContentCache = window.screenerContentCache || {
    searchFormState: null,
    companyOverviewHtml: null,
    chartData: null,
    fundamentalsGridHtml: null,
    newsContainerHtml: null,
    currentStock: null,
    isInitialized: false,
    lastUpdated: null
};
// ---

window.initializeScreener = function(params) {
    const BASE_URL = window.location.origin;
    let screenerChart;
    let eventListeners = []; // Keep track of added event listeners
    let autocompleteInstance = null; // To hold the autocomplete instance
    
    async function fetchFundamentals(stock) {
        try {
            // Use consolidated stock-data endpoint with fundamentals action
            const apiUrl = `${BASE_URL}/api/stock-data/${stock}?action=fundamentals`;
/*console.log(`Fetching fundamentals from: ${apiUrl}`);*/ 
            
            const res = await fetch(apiUrl);
/*console.log(`Fundamentals API response status: ${res.status}`);*/ 
            
            if (!res.ok) {
                console.error(`Fundamentals API error: ${res.status} ${res.statusText}`);
                const errorText = await res.text();
                console.error(`Error response body: ${errorText.substring(0, 200)}...`);
                return null;
            }
            
            // Try to parse as JSON with more detailed error handling
            try {
                const data = await res.json();
/*console.log('Fundamentals data received:', data);*/ 
                return data;
            } catch (parseError) {
                console.error('Error parsing fundamentals JSON:', parseError);
                const text = await res.text();
                console.error(`Raw response (first 200 chars): ${text.substring(0, 200)}...`);
                return null;
            }
        } catch (error) {
            console.error('Error fetching fundamentals:', error);
            return null;
        }
    }

    async function fetchStockTimeseries(stock) {
        // Use consolidated stock-data endpoint
/*console.log(`Fetching price data for ${stock}`);*/ 
        const url = `${BASE_URL}/api/stock-data/${stock}?action=price`;
/*console.log(`API URL: ${url}`);*/ 
        
        try {
            const res = await fetch(url);
/*console.log(`Price API response status: ${res.status}`);*/ 
            
            if (!res.ok) {
                console.error(`Price API error: ${res.status} ${res.statusText}`);
                const errorText = await res.text();
                console.error(`Error response body: ${errorText.substring(0, 200)}...`);
                return null;
            }
            
            // Try to parse as JSON with more detailed error handling
            try {
                const data = await res.json();
/*console.log('Price data received:', data);*/ 
                return data;
            } catch (parseError) {
                console.error('Error parsing price data JSON:', parseError);
                const text = await res.text();
                console.error(`Raw response (first 200 chars): ${text.substring(0, 200)}...`);
                return null;
            }
        } catch (error) {
            console.error('Error fetching price data:', error);
            return null;
        }
    }

    async function fetchSMA(stock, period = 200) {
        // Use consolidated stock-data endpoint with SMA action
        const res = await fetch(`${BASE_URL}/api/stock-data/${stock}?action=sma&period=${period}`);
        if (!res.ok) return null;
        return await res.json();
    }

    async function fetchSMATimeSeries(stock, period = 200) {
        // Use consolidated stock-data endpoint with SMA time series action
/*console.log(`Fetching SMA data for ${stock} with period ${period}`);*/ 
        const url = `${BASE_URL}/api/stock-data/${stock}?action=sma-timeseries&period=${period}`;
/*console.log(`SMA API URL: ${url}`);*/ 
        
        try {
            const res = await fetch(url);
/*console.log(`SMA API response status: ${res.status}`);*/ 
            
            if (!res.ok) {
                console.error(`SMA API error: ${res.status} ${res.statusText}`);
                const errorText = await res.text();
                console.error(`Error response body: ${errorText.substring(0, 200)}...`);
                return null;
            }
            
            // Try to parse as JSON with more detailed error handling
            try {
                const data = await res.json();
/*console.log('SMA data received:', data);*/ 
                return data;
            } catch (parseError) {
                console.error('Error parsing SMA data JSON:', parseError);
                const text = await res.text();
                console.error(`Raw response (first 200 chars): ${text.substring(0, 200)}...`);
                return null;
            }
        } catch (error) {
            console.error('Error fetching SMA data:', error);
            return null;
        }
    }

    async function fetchNews(stock) {
        const res = await fetch(`${BASE_URL}/api/stock-data/${stock}?action=news`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.news || [];
    }

    function renderFundamentals(fundamentals) {
/*console.log('renderFundamentals called with:', fundamentals);*/ 
        
        if (!fundamentals || fundamentals.error) {
            const errorMsg = fundamentals?.error || 'No fundamentals found for this ticker.';
            console.error('Fundamentals error:', errorMsg);
            $("#company-overview").html(`<div class="text-red-500">${errorMsg}</div>`);
            $("#fundamentals-grid").html(`<div class="text-red-500 text-center col-span-full">${errorMsg}</div>`);
            return;
        }
        
        // Helper function to format numbers
        const formatPercent = (val) => val !== null && val !== undefined ? `${val.toFixed(2)}%` : 'N/A';
        const formatNumber = (val, decimals = 2) => val !== null && val !== undefined ? val.toFixed(decimals) : 'N/A';
        const formatCurrency = (val) => val !== null && val !== undefined ? `$${val.toFixed(2)}` : 'N/A';
        
        // Render Company Overview in the search section
        $("#company-overview").html(`
            <div class="bg-gray-50 p-4 rounded-lg border">
                <h3 class="font-bold text-lg text-blue-600 mb-3">Company Overview</h3>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Company:</span>
                        <span class="font-medium text-right">${fundamentals.name || fundamentals.symbol}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Symbol:</span>
                        <span class="font-medium">${fundamentals.symbol || ''}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Exchange:</span>
                        <span class="font-medium">${fundamentals.exchange || 'N/A'}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Sector:</span>
                        <span class="font-medium">${fundamentals.sector || 'N/A'}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Industry:</span>
                        <span class="font-medium">${fundamentals.industry || 'N/A'}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Country:</span>
                        <span class="font-medium">${fundamentals.country || 'N/A'}</span>
                    </div>
                    ${fundamentals.employees ? `
                    <div class="flex justify-between">
                        <span class="text-gray-600">Employees:</span>
                        <span class="font-medium">${fundamentals.employees.toLocaleString()}</span>
                    </div>
                    ` : ''}
                </div>
            </div>
        `);
        
        // Render Fundamentals in the main grid (excluding company overview)
        $("#fundamentals-grid").html(`
            <!-- Price & Market Data -->
            <div class="bg-white p-4 rounded-lg shadow-sm border">
                <h3 class="font-bold text-lg text-green-600 mb-3">Price & Market Data</h3>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Current Price:</span>
                        <span class="font-medium">${formatCurrency(fundamentals.currentPrice)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Day Change:</span>
                        <span class="font-medium ${(fundamentals.dayChange || 0) >= 0 ? 'text-green-600' : 'text-red-600'}">
                            ${formatCurrency(fundamentals.dayChange)} (${formatPercent(fundamentals.dayChangePercent)})
                        </span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Market Cap:</span>
                        <span class="font-medium">${fundamentals.marketCap || 'N/A'}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Volume:</span>
                        <span class="font-medium">${(fundamentals.volume || 0).toLocaleString()}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">52W High:</span>
                        <span class="font-medium">${formatCurrency(fundamentals.fiftyTwoWeekHigh)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">52W Low:</span>
                        <span class="font-medium">${formatCurrency(fundamentals.fiftyTwoWeekLow)}</span>
                    </div>
                </div>
            </div>

            <!-- Valuation Metrics -->
            <div class="bg-white p-4 rounded-lg shadow-sm border">
                <h3 class="font-bold text-lg text-purple-600 mb-3">Valuation Metrics</h3>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-gray-600">P/E Ratio:</span>
                        <span class="font-medium">${formatNumber(fundamentals.peRatio)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Forward P/E:</span>
                        <span class="font-medium">${formatNumber(fundamentals.forwardPE)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">PEG Ratio:</span>
                        <span class="font-medium">${formatNumber(fundamentals.pegRatio)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Price/Book:</span>
                        <span class="font-medium">${formatNumber(fundamentals.priceToBook)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Price/Sales:</span>
                        <span class="font-medium">${formatNumber(fundamentals.priceToSales)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">EV/Revenue:</span>
                        <span class="font-medium">${formatNumber(fundamentals.evToRevenue)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">EV/EBITDA:</span>
                        <span class="font-medium">${formatNumber(fundamentals.evToEbitda)}</span>
                    </div>
                </div>
            </div>

            <!-- Financial Performance -->
            <div class="bg-white p-4 rounded-lg shadow-sm border">
                <h3 class="font-bold text-lg text-orange-600 mb-3">Financial Performance</h3>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Revenue (TTM):</span>
                        <span class="font-medium">${fundamentals.revenue || 'N/A'}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Revenue Growth:</span>
                        <span class="font-medium">${formatPercent(fundamentals.revenueGrowth)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Gross Margin:</span>
                        <span class="font-medium">${formatPercent(fundamentals.grossMargin)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Operating Margin:</span>
                        <span class="font-medium">${formatPercent(fundamentals.operatingMargin)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Profit Margin:</span>
                        <span class="font-medium">${formatPercent(fundamentals.profitMargin)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">EPS (TTM):</span>
                        <span class="font-medium">${formatCurrency(fundamentals.eps)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Forward EPS:</span>
                        <span class="font-medium">${formatCurrency(fundamentals.forwardEps)}</span>
                    </div>
                </div>
            </div>

            <!-- Dividend & Risk -->
            <div class="bg-white p-4 rounded-lg shadow-sm border">
                <h3 class="font-bold text-lg text-indigo-600 mb-3">Dividend & Risk</h3>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Dividend Yield:</span>
                        <span class="font-medium">${formatPercent(fundamentals.dividendYield)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Dividend Rate:</span>
                        <span class="font-medium">${formatCurrency(fundamentals.dividendRate)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Payout Ratio:</span>
                        <span class="font-medium">${formatPercent(fundamentals.payoutRatio)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Beta:</span>
                        <span class="font-medium">${formatNumber(fundamentals.beta)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Book Value:</span>
                        <span class="font-medium">${formatCurrency(fundamentals.bookValue)}</span>
                    </div>
                </div>
            </div>
        `);
    }

    function renderChart(timeseries, smaData) {
        if (!timeseries || !timeseries.chart || !timeseries.chart.result) {
            $("#screener-sma-loading").text('No price data found.');
            return;
        }

/*console.log("Rendering chart with timeseries data:", timeseries);*/ 
/*console.log("SMA data:", smaData);*/ 

        const result = timeseries.chart.result[0];
        
        // Convert Unix timestamps to formatted date strings for x-axis
        const allDates = result.timestamp.map(ts => {
            const date = new Date(ts * 1000);
            return date.toISOString().split('T')[0]; // YYYY-MM-DD format
        });
        
        const allPrices = result.indicators.quote[0].close;

        // Filter to show only the last 1 year for display
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        
        const dates = [];
        const prices = [];
        
        // Filter data to last year
        allDates.forEach((dateStr, index) => {
            const date = new Date(dateStr);
            if (date >= oneYearAgo) {
                dates.push(dateStr);
                prices.push(allPrices[index]);
            }
        });

        // Process SMA data
        let smaValues = [];
        if (smaData && smaData.values) {
            // Create a map for faster lookup
            const smaMap = new Map();
            smaData.values.forEach(item => {
                if (item.date && item.value !== null && !isNaN(item.value)) {
                    smaMap.set(item.date, item.value);
                }
            });

            // Map dates to SMA values
            smaValues = dates.map(dateStr => smaMap.get(dateStr) || null);
        } else {
            smaValues = new Array(dates.length).fill(null);
        }

        // Debug logs
/*console.log('Chart data:');*/ 
/*console.log('Date count:', dates.length);*/ 
/*console.log('Price count:', prices.length);*/ 
/*console.log('SMA count:', smaValues.length);*/ 
/*console.log('Sample dates:', dates.slice(0, 5));*/ 
/*console.log('Sample prices:', prices.slice(0, 5));*/ 
/*console.log('Sample SMA values:', smaValues.slice(0, 5));*/ 

        // Destroy previous chart
        if (screenerChart) {
            screenerChart.destroy();
        }

        // Get the canvas context
        const canvasElement = document.getElementById('screener-chart');
        if (!canvasElement) {
            console.error('Canvas element screener-chart not found');
            return;
        }
        
        const ctx = canvasElement.getContext('2d');
        
        // Create new chart with simpler configuration
        screenerChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: dates,
                datasets: [
                    {
                        label: 'Price',
                        data: prices,
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59,130,246,0.1)',
                        pointRadius: 1,
                        fill: false,
                        tension: 0.1
                    },
                    {
                        label: 'SMA-200',
                        data: smaValues,
                        borderColor: '#f59e42',
                        backgroundColor: 'rgba(245,158,66,0.1)',
                        pointRadius: 0,
                        fill: false,
                        tension: 0.1,
                        spanGaps: true,
                        borderDash: [5, 5]
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: function(context) {
                                const label = context.dataset.label || '';
                                const value = context.parsed.y;
                                if (value === null || value === undefined) {
                                    return null;
                                }
                                return `${label}: $${value.toFixed(2)}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'category',
                         display: true,
                         title: {
                             display: true,
                             text: 'Date'
                         },
                         ticks: {
                             maxTicksLimit: 12, // Show fewer ticks for readability
                             maxRotation: 45
                         }
                     },
                     y: {
                         display: true,
                         title: {
                             display: true,
                             text: 'Price ($)'
                         },
                         beginAtZero: false
                     }
                }
            }
        });

        // Hide loading indicator
        $("#screener-sma-loading").hide();
    }


    function renderNews(news) {
        const newsContainer = $('#news-container');
        newsContainer.empty(); // Clear previous news

        // Update news title with current stock
        const currentStock = $("#screener-stock-input").val().toUpperCase() || window.screenerContentCache.currentStock;
        if (currentStock) {
            $('#news-title').text(`Latest News for ${currentStock}`);
        } else {
            $('#news-title').text('Latest News');
        }

        if (!news || news.length === 0) {
            newsContainer.html('<p class="text-gray-500">No news found for this stock.</p>');
            return;
        }

        // Format news similar to dipfinder.js (title and date only)
        news.slice(0, 10).forEach(item => {
            const date = new Date(item.datetime * 1000).toLocaleDateString();
            newsContainer.append(`
                <div class="p-4 border-b border-gray-200">
                    <a href="${item.url}" target="_blank" class="text-lg font-semibold text-gray-900 hover:text-gray-700 hover:underline transition-colors block">${item.headline}</a>
                    <p class="text-sm text-gray-500 mt-1">${date} - ${item.source}</p>
                </div>
            `);
        });
    }

    async function loadStockData(stock) {
        if (!stock) {
            console.error("No stock symbol provided");
            return;
        }

/*console.log(`Loading stock data for: ${stock}`);*/ 
        
        // Show loading indicators
        $("#screener-loading").show().text(`Loading data for ${stock}...`);
        $("#company-overview").html('');
        $("#fundamentals-grid").html('');
        $("#news-container").html('');
        if (screenerChart) screenerChart.destroy();
        $("#screener-sma-loading").text(`Loading chart data for ${stock}...`).show();

        try {
/*console.log("Starting parallel data fetching");*/ 
            
            // Fetch all data in parallel
            const [fundamentals, timeseries, smaData, news] = await Promise.all([
                fetchFundamentals(stock),
                fetchStockTimeseries(stock),
                fetchSMATimeSeries(stock, 200),
                fetchNews(stock)
            ]);
            
/*console.log("All data fetched successfully");*/ 
/*console.log("Fundamentals:", fundamentals);*/ 
/*console.log("Timeseries data available:", !!timeseries);*/ 
/*console.log("SMA data available:", !!smaData);*/ 

            // Render all sections
            renderFundamentals(fundamentals);
            renderChart(timeseries, smaData);
            renderNews(news);
            
            // Save the state after everything is rendered
            saveScreenerContentState();

        } catch (error) {
            console.error("Error loading stock data:", error);
            $("#fundamentals-grid").html(`
                <div class="text-red-500 text-center col-span-full">
                    Failed to load stock data. Please try again.<br>
                    Error: ${error.message || 'Unknown error'}
                </div>
            `);
            $("#screener-sma-loading").text(`Error loading chart data: ${error.message || 'Unknown error'}`);
        } finally {
            // Hide loading indicator but keep any error messages
            $("#screener-loading").hide();
        }
    }

    function handleSearch(event) {
        event.preventDefault();
        const stock = $("#screener-stock-input").val().toUpperCase();
        if (stock) {
            loadStockData(stock);
            
            // Only modify URL for non-default stocks
            if (stock !== 'AAPL') {
                const newUrl = `/screener?stock=${stock}`;
                
                // Check if spaNavigate exists, otherwise use history API
                if (typeof window.spaNavigate === 'function') {
                    window.spaNavigate(newUrl);
                } else {
                    window.history.pushState({}, '', newUrl);
                }
            } else {
                // For AAPL, use the clean URL
                const cleanUrl = '/screener';
                if (typeof window.spaNavigate === 'function') {
                    window.spaNavigate(cleanUrl);
                } else {
                    window.history.pushState({}, '', cleanUrl);
                }
            }
        }
    }

    // Function to save the current UI state to the cache
    function saveScreenerContentState() {
        const searchForm = document.getElementById('screener-search-form');
        const companyOverview = document.getElementById('company-overview');
        const fundamentalsGrid = document.getElementById('fundamentals-grid');
        const newsContainer = document.getElementById('news-container');
        const stockInput = document.getElementById('screener-stock-input');
        
        if (searchForm) {
            window.screenerContentCache.searchFormState = {
                stockSymbol: stockInput ? stockInput.value : null
            };
        }
        
        if (companyOverview) {
            window.screenerContentCache.companyOverviewHtml = companyOverview.innerHTML;
        }
        
        if (screenerChart) {
            try {
                window.screenerContentCache.chartData = {
                    data: JSON.parse(JSON.stringify(screenerChart.data)),
                    options: JSON.parse(JSON.stringify(screenerChart.options))
                };
            } catch (error) {
                console.error('Error saving chart data:', error);
            }
        }
        
        if (fundamentalsGrid) {
            window.screenerContentCache.fundamentalsGridHtml = fundamentalsGrid.innerHTML;
        }
        
        if (newsContainer) {
            window.screenerContentCache.newsContainerHtml = newsContainer.innerHTML;
        }
        
        window.screenerContentCache.currentStock = stockInput ? stockInput.value : null;
        window.screenerContentCache.isInitialized = true;
        window.screenerContentCache.lastUpdated = Date.now();
        
/*console.log('Screener state saved:', window.screenerContentCache.currentStock);*/ 
    }

    // Function to restore chart from cached data
    function restoreScreenerChart(canvas, chartData) {
        if (!canvas || !chartData) return false;
        
        // If chart instance already exists, destroy it
        if (screenerChart) {
            screenerChart.destroy();
        }
        
        try {
            // Create a new chart with cached data
            const ctx = canvas.getContext('2d');
            screenerChart = new Chart(ctx, {
                type: 'line',
                data: JSON.parse(JSON.stringify(chartData.data)), // Deep clone to avoid reference issues
                options: JSON.parse(JSON.stringify(chartData.options))
            });
            return true;
        } catch (error) {
            console.error('Error restoring chart:', error);
            return false;
        }
    }

    // Function to restore screener content from cache
    function restoreScreenerContent() {
/*console.log('Checking screener content cache:', window.screenerContentCache);*/ 
        
        if (!window.screenerContentCache.isInitialized || !window.screenerContentCache.lastUpdated) {
/*console.log('Screener cache not initialized, cannot restore');*/ 
            return false;
        }
        
        // Check if cache is recent (less than 15 minutes old)
        const isCacheRecent = (Date.now() - window.screenerContentCache.lastUpdated < 15 * 60 * 1000);
        if (!isCacheRecent) {
/*console.log('Screener cache is too old, not restoring');*/ 
            return false;
        }
        
/*console.log('Restoring screener content for:', window.screenerContentCache.currentStock);*/ 
        
        // Restore stock input, checking if it matches URL parameters
        const stockInput = document.getElementById('screener-stock-input');
        if (stockInput) {
            // Check if there's a stock parameter in the URL
            const urlParams = new URLSearchParams(window.location.search);
            const stockFromUrl = urlParams.get('stock');
            
            if (stockFromUrl) {
                // If URL has a stock parameter, use it (prioritize URL)
                stockInput.value = stockFromUrl;
                
                // If it doesn't match cache, we should consider the cache invalid
                if (stockFromUrl !== window.screenerContentCache.currentStock) {
/*console.log('URL stock parameter differs from cache, cache may be invalid');*/ 
                    return false; // This will cause fresh data to be loaded
                }
            } else if (window.screenerContentCache.currentStock) {
                // If no stock in URL but we have one in cache, use cached value
                stockInput.value = window.screenerContentCache.currentStock;
            }
        }
        
        // Restore company overview
        const companyOverview = document.getElementById('company-overview');
        if (companyOverview && window.screenerContentCache.companyOverviewHtml) {
            companyOverview.innerHTML = window.screenerContentCache.companyOverviewHtml;
        } else {
/*console.log('Company overview element not found or no cached HTML available');*/ 
            return false;
        }

        // Restore chart
        const chartCanvas = document.getElementById('screener-chart');
        if (chartCanvas && window.screenerContentCache.chartData) {
            restoreScreenerChart(chartCanvas, window.screenerContentCache.chartData);
        } else {
/*console.log('Chart canvas element not found or no cached chart data available');*/ 
            return false;
        }

        // Restore fundamentals grid
        const fundamentalsGrid = document.getElementById('fundamentals-grid');
        if (fundamentalsGrid && window.screenerContentCache.fundamentalsGridHtml) {
            fundamentalsGrid.innerHTML = window.screenerContentCache.fundamentalsGridHtml;
        } else {
/*console.log('Fundamentals grid element not found or no cached HTML available');*/ 
            return false;
        }

        // Restore news container
        const newsContainer = document.getElementById('news-container');
        if (newsContainer && window.screenerContentCache.newsContainerHtml) {
            newsContainer.innerHTML = window.screenerContentCache.newsContainerHtml;
        } else {
/*console.log('News container element not found or no cached HTML available');*/ 
            return false;
        }
        
        // Hide any loading indicators
        $("#screener-loading").hide();
        $("#screener-sma-loading").hide();
        
        return true;
    }

    // Initial setup when the screener page is loaded
/*console.log("Initializing Screener page...");*/ 

    const searchForm = document.getElementById('screener-search-form');
    if (searchForm) {
        searchForm.addEventListener('submit', handleSearch);
        eventListeners.push({
            element: searchForm,
            type: 'submit',
            handler: handleSearch
        });
    }
    
    // Also add click handler for the search button
    const searchButton = document.getElementById('screener-search-btn');
    if (searchButton) {
        const searchButtonHandler = function(event) {
            event.preventDefault();
            const stock = $("#screener-stock-input").val().toUpperCase();
            if (stock) {
                loadStockData(stock);
                
                // Only modify URL for non-default stocks
                if (stock !== 'AAPL') {
                    const newUrl = `/screener?stock=${stock}`;
                    window.history.pushState({}, '', newUrl);
                } else {
                    // For AAPL, use the clean URL
                    window.history.pushState({}, '', '/screener');
                }
            }
        };
        
        searchButton.addEventListener('click', searchButtonHandler);
        eventListeners.push({
            element: searchButton,
            type: 'click',
            handler: searchButtonHandler
        });
    }


    // First, try to restore cached content if available
    /*console.log('Before restore attempt - Cache status:', 
               'Initialized:', window.screenerContentCache.isInitialized, 
               'Stock:', window.screenerContentCache.currentStock,
               'Updated:', window.screenerContentCache.lastUpdated ? 
                         new Date(window.screenerContentCache.lastUpdated).toLocaleTimeString() : 'never');*/
                
    const cacheRestored = restoreScreenerContent();
    
    if (!cacheRestored) {
/*console.log('No cache available, loading fresh data');*/ 
        
        // Check for stock in URL on initial load
        let stockFromUrl = params.get('stock');
        if (stockFromUrl) {
            $("#screener-stock-input").val(stockFromUrl);
            loadStockData(stockFromUrl);
        } else {
            // If no stock in URL, default to AAPL
/*console.log("No stock in URL, loading default: AAPL");*/ 
            stockFromUrl = 'AAPL';
            $("#screener-stock-input").val(stockFromUrl);
            loadStockData(stockFromUrl);
            // Don't update URL for default stock to avoid issues with page refresh
            // Just keep the clean /screener URL
        }
    } else {
/*console.log('Restored screener content from cache');*/ 
    }

    // Initialize autocomplete
    if (window.initStockAutocomplete) {
        autocompleteInstance = window.initStockAutocomplete('screener-stock-input', {
            suggestionBoxId: 'screener-autocomplete-results',
            onSelection: (ticker) => {
                $('#screener-stock-input').val(ticker);
                $('#screener-autocomplete-results').empty().hide();
                loadStockData(ticker);
                
                // Only modify URL for non-default stocks
                if (ticker !== 'AAPL') {
                    const newUrl = `/screener?stock=${ticker}`;
                    window.spaNavigate(newUrl);
                } else {
                    // For AAPL, use the clean URL
                    window.spaNavigate('/screener');
                }
            }
        });
    }

    window.destroyScreener = function() {
/*console.log("Destroying Screener page...");*/ 
        
        // Save the current state before destroying
        saveScreenerContentState();
        
        if (screenerChart) {
            screenerChart.destroy();
            screenerChart = null;
        }
        // Remove all event listeners
        eventListeners.forEach(listener => {
            listener.element.removeEventListener(listener.type, listener.handler);
        });
        eventListeners = [];

        // Destroy autocomplete instance
        if (autocompleteInstance && autocompleteInstance.destroy) {
            autocompleteInstance.destroy();
            autocompleteInstance = null;
        }
        
/*console.log('Screener state saved and listeners/intervals destroyed');*/ 
        /*console.log('Cache status after save:', window.screenerContentCache.isInitialized, 
                   'Stock:', window.screenerContentCache.currentStock,
                   'Updated:', new Date(window.screenerContentCache.lastUpdated).toLocaleTimeString());*/
    };
};
