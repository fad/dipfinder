// share.js — Public shared watchlist page

(function () {
    'use strict';

    // ── Helpers ───────────────────────────────────────────────────────────────

    function getDiffStatus(pct) {
        if (!Number.isFinite(pct)) return 'fair';
        if (pct <= -10) return 'deep-dip';
        if (pct < 0)    return 'dipping';
        if (pct < 5)    return 'fair';
        if (pct < 15)   return 'warm';
        return 'hot';
    }

    function getBarColor(pct) {
        switch (getDiffStatus(pct)) {
            case 'deep-dip': return { bg: '#0F766E', border: '#0D6561' };
            case 'dipping':  return { bg: '#14B8A6', border: '#0F9E8E' };
            case 'fair':     return { bg: '#94A3B8', border: '#7B8FA3' };
            case 'warm':     return { bg: '#FBBF24', border: '#D97706' };
            case 'hot':      return { bg: '#F97316', border: '#EA580C' };
            default:         return { bg: '#94A3B8', border: '#7B8FA3' };
        }
    }

    function getBadgeClass(pct) {
        switch (getDiffStatus(pct)) {
            case 'deep-dip': return 'background:#0F766E;color:#f0fdfa;';
            case 'dipping':  return 'background:#CCFBF1;color:#0F766E;';
            case 'fair':     return 'background:#F1F5F9;color:#475569;';
            case 'warm':     return 'background:#FEF9C3;color:#B45309;';
            case 'hot':      return 'background:#FFEDD5;color:#C2410C;';
            default:         return 'background:#F1F5F9;color:#475569;';
        }
    }

    function formatPct(val) {
        if (!Number.isFinite(val)) return '-';
        const sign = val >= 0 ? '+' : '';
        return sign + val.toFixed(1) + '%';
    }

    function formatPrice(p) {
        if (!Number.isFinite(p)) return '-';
        return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // ── Token extraction ──────────────────────────────────────────────────────

    function getShareToken() {
        // URL is /share/<token>
        const parts = window.location.pathname.split('/');
        return parts[parts.length - 1] || '';
    }

    // ── DOM refs ──────────────────────────────────────────────────────────────

    const loading  = document.getElementById('share-loading');
    const errorEl  = document.getElementById('share-error');
    const content  = document.getElementById('share-content');

    function showError() {
        loading.classList.add('hidden');
        errorEl.classList.remove('hidden');
    }

    function showContent() {
        loading.classList.add('hidden');
        content.classList.remove('hidden');
    }

    // ── Main ──────────────────────────────────────────────────────────────────

    document.getElementById('share-year').textContent = new Date().getFullYear();

    async function loadShare() {
        const token = getShareToken();
        if (!token || !/^[a-f0-9]{24}$/.test(token)) { showError(); return; }

        // 1. Fetch share metadata
        let shareData;
        try {
            const r = await fetch('/api/watchlist?action=get-share&token=' + token);
            if (!r.ok) { showError(); return; }
            shareData = await r.json();
        } catch { showError(); return; }

        const { watchlistName, ownerName, stocks, smaPeriod } = shareData;
        if (!Array.isArray(stocks) || !stocks.length) { showError(); return; }

        // 2. Fetch live stock data (no auth — guest limit is 5, but share pages are public;
        //    we send up to 20 symbols and let the API enforce its own limit gracefully)
        let stockResults = [];
        try {
            const r = await fetch('/api/batch-stocks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stocks: stocks.slice(0, 20), period: smaPeriod }),
            });
            if (r.ok) {
                const json = await r.json();
                stockResults = json.results || [];
            }
        } catch { /* non-fatal — show table even if prices fail */ }

        // 3. Fetch AI summaries (best-effort)
        let summaries = {};
        try {
            const params = new URLSearchParams({
                action: 'ai-summaries',
                symbols: stocks.slice(0, 20).join(','),
                _t: String(Date.now()),
            });
            const r = await fetch('/api/batch-stocks?' + params, { cache: 'no-store' });
            if (r.ok) {
                const json = await r.json();
                summaries = json.summaries || {};
            }
        } catch { /* non-fatal */ }

        // 4. Render
        renderShare(ownerName, watchlistName, smaPeriod, stockResults, summaries);
        showContent();
    }

    function renderShare(ownerName, watchlistName, smaPeriod, stockResults, summaries) {
        // Header
        document.getElementById('share-title').textContent = watchlistName;
        document.getElementById('share-subtitle').textContent =
            ownerName + '\'s watchlist - ranked by distance from ' + smaPeriod + '-day SMA';

        // Chart caption
        document.getElementById('share-chart-caption').textContent =
            'Bars show how far each stock is trading below (negative) or above (positive) its ' + smaPeriod + '-day SMA.';

        // Sort: biggest dip first
        const sorted = [...stockResults].sort((a, b) => {
            const da = a.relativePrice * 100;
            const db = b.relativePrice * 100;
            return da - db;
        });

        renderMetrics(sorted, smaPeriod);
        renderChart(sorted, smaPeriod);
        renderTable(sorted);
        renderSummaries(sorted, summaries);
    }

    function renderMetrics(sorted, smaPeriod) {
        const el = document.getElementById('share-metrics');
        if (!el) return;

        let deepDip = 0, dipping = 0, fair = 0, hot = 0;
        for (const s of sorted) {
            const pct = s.relativePrice * 100;
            const st = getDiffStatus(pct);
            if (st === 'deep-dip') deepDip++;
            else if (st === 'dipping') dipping++;
            else if (st === 'fair') fair++;
            else hot++;
        }
        const total = sorted.length;

        const cards = [
            { label: 'Deep Dip', value: deepDip, color: '#0F766E', bg: '#F0FDFA' },
            { label: 'Dipping',  value: dipping,  color: '#14B8A6', bg: '#CCFBF1' },
            { label: 'Fair',     value: fair,      color: '#64748B', bg: '#F1F5F9' },
            { label: 'Hot',      value: hot,       color: '#F97316', bg: '#FFEDD5' },
        ];

        el.innerHTML = cards.map(c => `
            <div class="rounded-xl border border-gray-200 bg-white p-4 text-center shadow-sm" style="border-top:3px solid ${c.color};">
                <div class="text-2xl font-bold" style="color:${c.color};">${c.value}</div>
                <div class="mt-0.5 text-xs font-medium text-gray-500">${c.label} <span class="text-gray-400">/ ${total}</span></div>
            </div>
        `).join('');
    }

    function renderChart(sorted, smaPeriod) {
        const canvas = document.getElementById('share-chart');
        if (!canvas || !window.Chart) return;

        const labels = sorted.map(s => s.stock);
        const values = sorted.map(s => Number.isFinite(s.relativePrice) ? +(s.relativePrice * 100).toFixed(2) : null);
        const bgColors = sorted.map(s => getBarColor(s.relativePrice * 100).bg);
        const bdColors = sorted.map(s => getBarColor(s.relativePrice * 100).border);

        // Adjust canvas height for number of bars
        const barH = 32;
        const height = Math.max(200, labels.length * barH + 60);
        canvas.parentElement.style.height = height + 'px';

        new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: bgColors,
                    borderColor: bdColors,
                    borderWidth: 1,
                    borderRadius: 4,
                }],
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const v = ctx.parsed.x;
                                return (v >= 0 ? '+' : '') + v.toFixed(1) + '% vs SMA' + smaPeriod;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: {
                            callback: v => (v >= 0 ? '+' : '') + v + '%',
                            color: '#6b7280',
                            font: { size: 11 },
                        },
                        grid: { color: 'rgba(0,0,0,0.06)' },
                    },
                    y: {
                        ticks: { color: '#374151', font: { size: 12, weight: 'bold' } },
                        grid: { display: false },
                    },
                },
            },
        });
    }

    function renderTable(sorted) {
        const tbody = document.getElementById('share-table-body');
        if (!tbody) return;

        tbody.innerHTML = sorted.map(s => {
            const pct = s.relativePrice * 100;
            const dayChange = s.currentPrice && s.previousPrice
                ? ((s.currentPrice - s.previousPrice) / s.previousPrice * 100)
                : null;
            const dayHtml = Number.isFinite(dayChange)
                ? `<span class="ml-1 text-xs ${dayChange >= 0 ? 'text-green-600' : 'text-red-500'}">(${dayChange >= 0 ? '+' : ''}${dayChange.toFixed(1)}%)</span>`
                : '';
            const badge = `<span class="inline-block rounded-full px-2 py-0.5 text-xs font-semibold" style="${getBadgeClass(pct)}">${formatPct(pct)}</span>`;
            const pe = s.peRatio ? s.peRatio.toFixed(1) + 'x' : '<span class="text-gray-400">-</span>';

            return `<tr class="hover:bg-gray-50">
                <td class="px-4 py-3">
                    <span class="font-bold text-gray-900">${s.stock}</span>
                    <span class="ml-2 hidden sm:inline text-xs text-gray-400">${escHtml(s.companyName || '')}</span>
                </td>
                <td class="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                    ${formatPrice(s.currentPrice)}${dayHtml}
                </td>
                <td class="px-4 py-3 text-right text-gray-500">${formatPrice(s.sma)}</td>
                <td class="px-4 py-3 text-right">${badge}</td>
                <td class="px-4 py-3 text-right text-gray-500 hidden sm:table-cell">${pe}</td>
            </tr>`;
        }).join('');
    }

    function renderSummaries(sorted, summaries) {
        const section = document.getElementById('share-summaries-section');
        const list = document.getElementById('share-summaries-list');
        if (!section || !list) return;

        const entries = sorted
            .filter(s => summaries[s.stock])
            .map(s => ({ stock: s.stock, ...summaries[s.stock] }));

        if (!entries.length) return;

        section.classList.remove('hidden');
        list.innerHTML = entries.map(e => `
            <div>
                <div class="flex items-center gap-2 mb-1">
                    <span class="font-bold text-gray-900 text-sm">${e.stock}</span>
                    <span class="text-xs text-gray-400">${e.companyName || ''}</span>
                </div>
                <p class="text-sm text-gray-700 leading-relaxed">${escHtml(e.summary)}</p>
            </div>
        `).join('');
    }

    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    loadShare();

})();
