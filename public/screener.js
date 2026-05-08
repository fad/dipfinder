// screener.js - Stock Screener page logic

// --- State preservation for SPA navigation ---
window.screenerContentCache = window.screenerContentCache || {
    searchFormState: null,
    companyOverviewHtml: null,
    chartData: null,
    fundamentalsGridHtml: null,
    historyData: null,
    newsContainerHtml: null,
    currentStock: null,
    isInitialized: false,
    lastUpdated: null
};
// ---

window.initializeScreener = function(params) {
    const BASE_URL = window.location.origin;
    let screenerChart;
    let historyCharts = [];
    let lastHistoryData = null;
    let currentLoadId = 0;
    let storedAllDates = [];
    let storedAllPrices = [];
    let storedSmaData = null;
    let currentTimeframe = '1Y';

    function destroyScreenerChart() {
        if (screenerChart) {
            screenerChart.destroy();
            screenerChart = null;
        }
        // Belt-and-suspenders: clear any chart Chart.js still tracks on the canvas
        const canvas = document.getElementById('screener-chart');
        if (canvas) {
            const orphan = Chart.getChart(canvas);
            if (orphan) orphan.destroy();
        }
    }
    let eventListeners = []; // Keep track of added event listeners
    let autocompleteInstance = null; // To hold the autocomplete instance

    function stockDataUrl(stock, params = {}) {
        const urlParams = new URLSearchParams({ symbol: stock, ...params });
        return `${BASE_URL}/api/stock-data?${urlParams.toString()}`;
    }
    
    async function fetchFundamentals(stock) {
        try {
            // Use consolidated stock-data endpoint with fundamentals action
            const apiUrl = stockDataUrl(stock, { action: 'fundamentals' });
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
        const url = stockDataUrl(stock, { action: 'price' });
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
        const res = await fetch(stockDataUrl(stock, { action: 'sma', period }));
        if (!res.ok) return null;
        return await res.json();
    }

    async function fetchSMATimeSeries(stock, period = 200) {
        // Use consolidated stock-data endpoint with SMA time series action
/*console.log(`Fetching SMA data for ${stock} with period ${period}`);*/ 
        const url = stockDataUrl(stock, { action: 'sma-timeseries', period });
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
        const res = await fetch(stockDataUrl(stock, { action: 'news' }));
        if (!res.ok) return [];
        const data = await res.json();
        return data.news || [];
    }

    function computePERange(timeseries, eps, currentPE) {
        if (!eps || eps <= 0) return null;
        const result = timeseries?.chart?.result?.[0];
        if (!result) return null;
        const prices = result.indicators?.quote?.[0]?.close || [];
        const peValues = prices
            .filter(p => p != null && p > 0)
            .map(p => p / eps)
            .filter(pe => pe > 0 && pe < 500); // filter outliers / negative-eps spikes
        if (peValues.length < 20) return null;
        const peMin = Math.min(...peValues);
        const peMax = Math.max(...peValues);
        const current = currentPE > 0 ? currentPE : (peValues[peValues.length - 1] ?? null);
        if (!current) return null;
        const pct = Math.round(Math.max(0, Math.min(100, (current - peMin) / (peMax - peMin) * 100)));
        return { current, min: peMin, max: peMax, pct };
    }

    function renderFundamentals(fundamentals, timeseries) {
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

        const isDark = document.documentElement.classList.contains('dark-mode');
        const peRange = computePERange(timeseries, fundamentals.eps, fundamentals.peRatio);
        const peRowHtml = (() => {
            if (!peRange) {
                return `<div class="flex justify-between">
                    <span class="text-gray-600">P/E Ratio:</span>
                    <span class="font-medium">${formatNumber(fundamentals.peRatio)}</span>
                </div>`;
            }
            const barColor = peRange.pct < 30 ? '#16a34a' : peRange.pct > 70 ? '#dc2626' : '#d97706';
            const label    = peRange.pct < 30 ? 'Historically cheap' : peRange.pct > 70 ? 'Historically expensive' : 'Near average';
            const track    = isDark ? 'rgba(255,255,255,0.10)' : '#e2e8f0';
            return `<div>
                <div class="flex justify-between mb-0.5">
                    <span class="text-gray-600">P/E Ratio:</span>
                    <span class="font-medium">${peRange.current.toFixed(1)}</span>
                </div>
                <div class="text-xs text-gray-400 mb-1.5">1Y range ${peRange.min.toFixed(1)} - ${peRange.max.toFixed(1)}</div>
                <div style="background:${track};border-radius:4px;height:5px;width:100%;margin-bottom:4px;">
                    <div style="background:${barColor};border-radius:4px;height:5px;width:${peRange.pct}%;"></div>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:10px;">
                    <span class="text-gray-400">Low</span>
                    <span style="color:${barColor};font-weight:600;">${label}</span>
                    <span class="text-gray-400">High</span>
                </div>
            </div>`;
        })();
        
        // Render Company Overview in the search section
        $("#company-overview").html(`
            <div class="bg-gray-50 p-4 rounded-lg border">
                <h3 class="font-bold text-lg text-blue-600 mb-3">Company Overview</h3>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Company:</span>
                        <span class="font-medium text-right ml-4">${fundamentals.name || fundamentals.symbol}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Symbol:</span>
                        <span class="font-medium text-right ml-4">${fundamentals.symbol || ''}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Exchange:</span>
                        <span class="font-medium text-right ml-4">${fundamentals.exchange || 'N/A'}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Sector:</span>
                        <span class="font-medium text-right ml-4">${fundamentals.sector || 'N/A'}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Industry:</span>
                        <span class="font-medium text-right ml-4">${fundamentals.industry || 'N/A'}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Country:</span>
                        <span class="font-medium text-right ml-4">${fundamentals.country || 'N/A'}</span>
                    </div>
                    ${fundamentals.employees ? `
                    <div class="flex justify-between">
                        <span class="text-gray-600">Employees:</span>
                        <span class="font-medium text-right ml-4">${fundamentals.employees.toLocaleString()}</span>
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
                    ${peRowHtml}
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

        renderFundamentalsHistory(fundamentals.history || null);
    }

    function renderFundamentalsHistory(history) {
        const container = document.getElementById('fundamentals-history');
        if (!container) return;

        // Destroy any previous history chart instances
        historyCharts.forEach(c => c.destroy());
        historyCharts = [];

        if (!history || history.length === 0) {
            container.innerHTML = '';
            return;
        }

        lastHistoryData = history;

        const years = history.map(d => String(d.year));

        // ── chart config helpers ──────────────────────────────────────────────
        const isDarkMode = document.documentElement.classList.contains('dark-mode');
        const axisTickColor = isDarkMode ? '#e5e7eb' : '#6B7280';
        const gridLineColor = isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)';

        const baseOptions = (yLabel, isPercent) => ({
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => isPercent ? `${ctx.parsed.y.toFixed(1)}%` : `$${ctx.parsed.y.toFixed(2)}`
                    }
                }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: axisTickColor, font: { size: 11 } } },
                y: {
                    grid: { color: gridLineColor },
                    ticks: {
                        color: axisTickColor, font: { size: 11 },
                        callback: v => isPercent ? `${v}%` : `$${v}`
                    }
                }
            }
        });

        const barColors = (values, posColor, negColor) =>
            values.map(v => v == null ? '#E5E7EB' : v >= 0 ? posColor : negColor);

        // ── four chart definitions ────────────────────────────────────────────
        const charts = [
            {
                id: 'hc-eps', title: 'Earnings Per Share', subtitle: 'Annual basic EPS (USD)',
                icon: 'fa-dollar-sign',
                data: history.map(d => d.eps),
                colors: () => barColors(history.map(d => d.eps), '#6366F1', '#EF4444'),
                isPercent: false,
            },
            {
                id: 'hc-rps', title: 'Revenue Per Share', subtitle: 'Annual revenue ÷ shares (USD)',
                icon: 'fa-chart-bar',
                data: history.map(d => d.revenuePerShare),
                colors: () => history.map(() => '#3B82F6'),
                isPercent: false,
            },
            {
                id: 'hc-margins', title: 'Margins', subtitle: '',
                icon: 'fa-percentage',
                isMulti: true,
                datasets: [
                    { label: 'Gross',     data: history.map(d => d.grossMargin),     color: '#6366F1' },
                    { label: 'Operating', data: history.map(d => d.operatingMargin), color: '#8B5CF6' },
                    { label: 'Net',       data: history.map(d => d.netMargin),       color: '#14B8A6' },
                ],
                isPercent: true,
            },
            {
                id: 'hc-shares', title: 'Shares Outstanding', subtitle: 'Basic shares (millions)',
                icon: 'fa-users',
                data: history.map(d => d.sharesMillions),
                colors: () => history.map(() => '#94A3B8'),
                isPercent: false,
                isRaw: true,
            },
        ];

        // ── render container ─────────────────────────────────────────────────
        container.innerHTML = `
            <div class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <h2 class="mb-1 text-xl font-bold text-gray-900">Financial History</h2>
                <p class="mb-5 text-sm text-gray-500">Annual figures from SEC filings.</p>
                <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
                    ${charts.map(c => `
                        <div class="rounded-xl border border-gray-100 bg-gray-50 p-4">
                            <div class="mb-3 flex items-center gap-2">
                                <div class="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 text-xs">
                                    <i class="fas ${c.icon}"></i>
                                </div>
                                <div>
                                    <p class="text-sm font-semibold text-gray-800">${c.title}</p>
                                    ${c.isMulti ? `<div class="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                                        ${c.datasets.map(ds => `<span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-full" style="background:${ds.color}"></span>${ds.label}</span>`).join('')}
                                    </div>` : `<p class="text-xs text-gray-400">${c.subtitle}</p>`}
                                </div>
                            </div>
                            <div style="height:200px"><canvas id="${c.id}"></canvas></div>
                        </div>
                    `).join('')}
                </div>
                <p class="mt-3 text-xs text-gray-400"><i class="fas fa-info-circle mr-1"></i>Source: Finnhub (SEC filings). Data may be unavailable for non-US or recently listed companies.</p>
            </div>
        `;

        // ── instantiate charts ────────────────────────────────────────────────
        charts.forEach(def => {
            const canvas = document.getElementById(def.id);
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            let cfg;

            if (def.isMulti) {
                cfg = {
                    type: 'bar',
                    data: {
                        labels: years,
                        datasets: def.datasets.map(ds => ({
                            label: ds.label,
                            data: ds.data,
                            backgroundColor: ds.color + 'CC',
                            borderColor: ds.color,
                            borderWidth: 1,
                            borderRadius: 4,
                        }))
                    },
                    options: { ...baseOptions('', true), plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) + '%' : 'N/A'}` } } } }
                };
            } else {
                const values = def.data;
                const opts = baseOptions('', def.isPercent);
                if (def.isRaw) {
                    opts.scales.y.ticks.callback = v => v >= 1000 ? `${(v/1000).toFixed(1)}B` : `${v}M`;
                    opts.plugins.tooltip.callbacks.label = ctx => `${ctx.parsed.y >= 1000 ? (ctx.parsed.y/1000).toFixed(2) + 'B' : ctx.parsed.y + 'M'} shares`;
                }
                cfg = {
                    type: 'bar',
                    data: {
                        labels: years,
                        datasets: [{
                            data: values,
                            backgroundColor: def.colors(),
                            borderColor: def.colors().map(c => c.replace(/CC$/, '')),
                            borderWidth: 1,
                            borderRadius: 4,
                        }]
                    },
                    options: opts
                };
            }

            historyCharts.push(new Chart(ctx, cfg));
        });
    }

    function cutoffForTimeframe(tf) {
        const now = new Date();
        if (tf === 'MAX') return new Date(0);
        const map = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 };
        const months = map[tf] || 12;
        return new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
    }

    function tickFormatForTimeframe(dateStr, tf) {
        const d = new Date(dateStr);
        if (tf === '1M' || tf === '3M') {
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    }

    function applyTimeframe(tf) {
        currentTimeframe = tf;
        if (!storedAllDates.length || !screenerChart) return;

        const cutoff = cutoffForTimeframe(tf);
        const dates = [], prices = [];
        storedAllDates.forEach((d, i) => {
            if (new Date(d) >= cutoff) { dates.push(d); prices.push(storedAllPrices[i]); }
        });

        let smaValues = new Array(dates.length).fill(null);
        if (storedSmaData && storedSmaData.values) {
            const smaMap = new Map();
            storedSmaData.values.forEach(item => {
                if (item.date && item.value !== null && !isNaN(item.value)) smaMap.set(item.date, item.value);
            });
            smaValues = dates.map(d => smaMap.get(d) ?? null);
        }

        screenerChart.data.labels = dates;
        screenerChart.data.datasets[0].data = prices;
        screenerChart.data.datasets[1].data = smaValues;
        // Update tick format to match new timeframe
        screenerChart.options.scales.x.ticks.callback = function(val) {
            return tickFormatForTimeframe(this.getLabelForValue(val), tf);
        };
        screenerChart.update('none');

        // Update button active states
        document.querySelectorAll('.tf-btn').forEach(b => {
            b.classList.toggle('bg-blue-500', b.dataset.tf === tf);
            b.classList.toggle('text-white', b.dataset.tf === tf);
            b.classList.toggle('bg-white', b.dataset.tf !== tf);
            b.classList.toggle('text-gray-600', b.dataset.tf !== tf);
        });
    }

    function renderChart(timeseries, smaData) {
        if (!timeseries || !timeseries.chart || !timeseries.chart.result) {
            $("#screener-sma-loading").text('No price data found.');
            return;
        }

        const result = timeseries.chart.result[0];
        storedAllDates = result.timestamp.map(ts => new Date(ts * 1000).toISOString().split('T')[0]);
        storedAllPrices = result.indicators.quote[0].close;
        storedSmaData = smaData;

        const cutoff = cutoffForTimeframe(currentTimeframe);
        const dates = [], prices = [];
        storedAllDates.forEach((d, i) => {
            if (new Date(d) >= cutoff) { dates.push(d); prices.push(storedAllPrices[i]); }
        });

        let smaValues = new Array(dates.length).fill(null);
        if (smaData && smaData.values) {
            const smaMap = new Map();
            smaData.values.forEach(item => {
                if (item.date && item.value !== null && !isNaN(item.value)) smaMap.set(item.date, item.value);
            });
            smaValues = dates.map(d => smaMap.get(d) ?? null);
        }

        destroyScreenerChart();

        const canvasElement = document.getElementById('screener-chart');
        if (!canvasElement) { console.error('Canvas element screener-chart not found'); return; }

        screenerChart = new Chart(canvasElement.getContext('2d'), {
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
                        label: 'SMA',
                        data: smaValues,
                        borderColor: '#f59e42',
                        backgroundColor: 'transparent',
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
                    legend: { display: true, position: 'top' },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: function(context) {
                                const value = context.parsed.y;
                                if (value === null || value === undefined) return null;
                                return `${context.dataset.label}: $${value.toFixed(2)}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'category',
                        ticks: {
                            maxTicksLimit: 12,
                            maxRotation: 0,
                            color: document.documentElement.classList.contains('dark-mode') ? '#e5e7eb' : '#6B7280',
                            callback: function(val) {
                                return tickFormatForTimeframe(this.getLabelForValue(val), currentTimeframe);
                            }
                        },
                        grid: {
                            color: document.documentElement.classList.contains('dark-mode') ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'
                        }
                    },
                    y: {
                        display: true,
                        beginAtZero: false,
                        ticks: {
                            color: document.documentElement.classList.contains('dark-mode') ? '#e5e7eb' : '#6B7280'
                        },
                        grid: {
                            color: document.documentElement.classList.contains('dark-mode') ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)'
                        }
                    }
                }
            }
        });

        // Sync timeframe button active states
        document.querySelectorAll('.tf-btn').forEach(b => {
            b.classList.toggle('bg-blue-500', b.dataset.tf === currentTimeframe);
            b.classList.toggle('text-white', b.dataset.tf === currentTimeframe);
            b.classList.toggle('bg-white', b.dataset.tf !== currentTimeframe);
            b.classList.toggle('text-gray-600', b.dataset.tf !== currentTimeframe);
        });

        $("#screener-sma-loading").hide();
    }


    function formatNewsDate(value) {
        if (!value) return '';
        const ms = typeof value === 'number' ? value * 1000 : new Date(value).getTime();
        const diff = Date.now() - ms;
        if (diff < 60000)       return 'just now';
        if (diff < 3600000)     return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000)    return `${Math.floor(diff / 3600000)}h ago`;
        if (diff < 2592000000)  return `${Math.floor(diff / 86400000)}d ago`;
        return new Date(ms).toLocaleDateString();
    }

    function renderNews(news) {
        const newsContainer = $('#news-container');
        newsContainer.empty();

        const currentStock = $("#screener-stock-input").val().toUpperCase() || window.screenerContentCache.currentStock;
        $('#news-title').text(currentStock ? `Latest News for ${currentStock}` : 'Latest News');

        if (!news || news.length === 0) {
            newsContainer.html('<p class="text-gray-500">No news found for this stock.</p>');
            return;
        }

        const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

        const cards = news.slice(0, 10).map(item => `
            <article class="rounded-xl border border-gray-200 bg-white p-3.5 shadow-sm transition hover:shadow-md hover:border-blue-100">
                <a href="${escHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="block">
                    <p class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-blue-500">${escHtml(item.source || 'News')}</p>
                    <p class="text-sm font-semibold leading-snug text-gray-900">${escHtml(item.headline || 'Untitled article')}</p>
                    <p class="mt-2 text-xs text-gray-400">${formatNewsDate(item.datetime)}</p>
                </a>
            </article>
        `).join('');

        newsContainer.html(`<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">${cards}</div>`);
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
        $("#fundamentals-history").html('');
        $("#news-container").html('');
        historyCharts.forEach(c => c.destroy()); historyCharts = [];
        lastHistoryData = null;
        destroyScreenerChart();
        $("#screener-sma-loading").text(`Loading chart data for ${stock}...`).show();

        const loadId = ++currentLoadId;

        try {
            const [fundamentals, timeseries, smaData, news] = await Promise.all([
                fetchFundamentals(stock),
                fetchStockTimeseries(stock),
                fetchSMATimeSeries(stock, 200),
                fetchNews(stock)
            ]);

            // Discard if a newer loadStockData call was made while we were awaiting
            if (loadId !== currentLoadId) return;

            // Render all sections
            renderFundamentals(fundamentals, timeseries);
            renderChart(timeseries, smaData);
            renderNews(news);
            
            // Save the state after everything is rendered
            saveScreenerContentState();

            // Scroll to news if requested (e.g. from dashboard "More news" link)
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('scrollTo') === 'news') {
                setTimeout(() => {
                    const newsEl = document.getElementById('news-container');
                    if (newsEl) newsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 300);
            }

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

        window.screenerContentCache.historyData = lastHistoryData;

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
        
        destroyScreenerChart();

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

        // Restore financial history charts
        if (window.screenerContentCache.historyData) {
            renderFundamentalsHistory(window.screenerContentCache.historyData);
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

    // Initialize autocomplete — lazy-load the ticker list only when the screener is active
    function setupScreenerAutocomplete() {
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
    if (window.initStockAutocomplete) {
        setupScreenerAutocomplete();
    } else {
        const s = document.createElement('script');
        s.src = '/stock-autocomplete.js?v=3';
        s.onload = setupScreenerAutocomplete;
        document.head.appendChild(s);
    }

    window.applyTimeframe = applyTimeframe;

    // Re-render charts when theme changes
    function onThemeChange() {
        if (storedAllDates.length) applyTimeframe(currentTimeframe);
        if (lastHistoryData) renderFundamentalsHistory(lastHistoryData);
    }
    document.addEventListener('themechange', onThemeChange);

    window.destroyScreener = function() {
/*console.log("Destroying Screener page...");*/ 
        
        // Save the current state before destroying
        saveScreenerContentState();
        
        destroyScreenerChart();
        document.removeEventListener('themechange', onThemeChange);
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
