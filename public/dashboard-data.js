// dashboard-data.js — API fetch helpers and localStorage cache for the dashboard

const BASE_URL = window.location.origin;
const DASHBOARD_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

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

// stocks is a var declared in dipfinder.js (window-scoped)
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
