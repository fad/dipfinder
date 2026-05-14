// share.js — Public shared watchlist page

(function () {
    'use strict';

    // ── Auth helpers ──────────────────────────────────────────────────────────

    function getStoredToken() {
        try {
            const token = localStorage.getItem('token');
            if (!token) return null;
            const payload = JSON.parse(atob(token.split('.')[1]));
            if (payload.exp && payload.exp * 1000 < Date.now()) return null;
            return token;
        } catch { return null; }
    }

    const isLoggedIn = !!getStoredToken();

    // ── Color helpers ─────────────────────────────────────────────────────────

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

    function getBadgeStyle(pct) {
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
        return (val >= 0 ? '+' : '') + val.toFixed(1) + '%';
    }

    function formatPrice(p) {
        if (!Number.isFinite(p)) return '-';
        return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Token extraction ──────────────────────────────────────────────────────

    function getShareToken() {
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

    // ── Screener link ─────────────────────────────────────────────────────────

    function screenerUrl(symbol) {
        return '/screener?symbol=' + encodeURIComponent(symbol);
    }

    // ── Main ──────────────────────────────────────────────────────────────────

    document.getElementById('share-year').textContent = new Date().getFullYear();

    // Store share data for subscribe button
    let _shareStocks = [];
    let _sharePeriod = 50;

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

        _shareStocks = stocks;
        _sharePeriod = smaPeriod;

        // 2. Fetch live stock data
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
        } catch { /* non-fatal */ }

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
        setupAuthUI(stocks, smaPeriod, watchlistName);
    }

    function renderShare(ownerName, watchlistName, smaPeriod, stockResults, summaries) {
        document.getElementById('share-title').textContent = watchlistName;
        document.getElementById('share-subtitle').textContent =
            ownerName + '\'s watchlist - ranked by distance from ' + smaPeriod + '-day SMA';
        document.getElementById('share-chart-caption').textContent =
            'Bars show how far each stock is trading below (negative) or above (positive) its ' + smaPeriod + '-day SMA.';

        const sorted = [...stockResults].sort((a, b) => a.relativePrice - b.relativePrice);

        renderMetrics(sorted);
        renderChart(sorted, smaPeriod);
        renderScatter(sorted);
        renderTable(sorted);
        renderSummaries(sorted, summaries);
    }

    function renderMetrics(sorted) {
        const el = document.getElementById('share-metrics');
        if (!el) return;
        let deepDip = 0, dipping = 0, fair = 0, hot = 0;
        for (const s of sorted) {
            const st = getDiffStatus(s.relativePrice * 100);
            if (st === 'deep-dip') deepDip++;
            else if (st === 'dipping') dipping++;
            else if (st === 'fair') fair++;
            else hot++;
        }
        const total = sorted.length;
        const cards = [
            { label: 'Deep Dip', value: deepDip, color: '#0F766E' },
            { label: 'Dipping',  value: dipping,  color: '#14B8A6' },
            { label: 'Fair',     value: fair,      color: '#64748B' },
            { label: 'Hot',      value: hot,       color: '#F97316' },
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
        const height = Math.max(200, labels.length * 32 + 60);
        canvas.parentElement.style.height = height + 'px';
        new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: { labels, datasets: [{ data: values, backgroundColor: bgColors, borderColor: bdColors, borderWidth: 1, borderRadius: 4 }] },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => (ctx.parsed.x >= 0 ? '+' : '') + ctx.parsed.x.toFixed(1) + '% vs SMA' + smaPeriod,
                            title: ctx => {
                                const s = sorted[ctx[0].dataIndex];
                                return s ? s.stock + (s.companyName ? ' - ' + s.companyName : '') : ctx[0].label;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: { callback: v => (v >= 0 ? '+' : '') + v + '%', color: '#6b7280', font: { size: 11 } },
                        grid: { color: 'rgba(0,0,0,0.06)' },
                    },
                    y: { ticks: { color: '#374151', font: { size: 12, weight: 'bold' } }, grid: { display: false } },
                },
                onClick: (evt, elements) => {
                    if (elements.length) {
                        const s = sorted[elements[0].index];
                        if (s) window.open(screenerUrl(s.stock), '_blank');
                    }
                },
            },
        });
    }

    function renderScatter(sorted) {
        const section = document.getElementById('share-scatter-section');
        const canvas  = document.getElementById('share-scatter-chart');
        if (!section || !canvas || !window.Chart) return;

        const included = sorted.filter(s =>
            Number.isFinite(s.relativePrice) &&
            Number.isFinite(s.peRatio) &&
            s.peRatio > 0
        ).map(s => ({
            stock: s.stock,
            x: +(s.relativePrice * 100).toFixed(2),
            y: s.peRatio,
            diffPercent: s.relativePrice * 100,
        }));

        const excluded = sorted.filter(s => !Number.isFinite(s.peRatio) || s.peRatio <= 0);

        if (included.length < 2) return; // not enough data to be useful

        section.classList.remove('hidden');

        const excludedEl = document.getElementById('share-scatter-excluded');
        if (excludedEl && excluded.length) {
            excludedEl.textContent = 'Not shown: ' + excluded.map(e => e.stock).join(', ') + ' - no P/E data or negative earnings';
            excludedEl.classList.remove('hidden');
        }

        const pointColors = included.map(p => getBarColor(p.diffPercent).bg);

        // Custom label plugin
        const labelPlugin = {
            id: 'tickerLabels',
            afterDatasetsDraw(ch) {
                const ctx2 = ch.ctx;
                ch.data.datasets[0].data.forEach((pt, i) => {
                    const meta = ch.getDatasetMeta(0);
                    const el = meta.data[i];
                    if (!el) return;
                    const { x, y } = el.getProps(['x', 'y'], true);
                    ctx2.save();
                    ctx2.font = 'bold 10px Arial,sans-serif';
                    ctx2.fillStyle = '#374151';
                    ctx2.textAlign = 'center';
                    ctx2.fillText(included[i].stock, x, y - 10);
                    ctx2.restore();
                });
            },
        };

        new Chart(canvas.getContext('2d'), {
            type: 'scatter',
            plugins: [labelPlugin],
            data: {
                datasets: [{
                    data: included.map(p => ({ x: p.x, y: p.y })),
                    backgroundColor: pointColors,
                    borderColor: pointColors,
                    pointRadius: 8,
                    pointHoverRadius: 10,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const p = included[ctx.dataIndex];
                                return p.stock + ': SMA ' + (p.x >= 0 ? '+' : '') + p.x + '%, P/E ' + p.y.toFixed(1) + 'x';
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        title: { display: true, text: '% vs SMA', color: '#6b7280', font: { size: 11 } },
                        ticks: { callback: v => (v >= 0 ? '+' : '') + v + '%', color: '#6b7280', font: { size: 11 } },
                        grid: { color: 'rgba(0,0,0,0.06)' },
                    },
                    y: {
                        title: { display: true, text: 'Trailing P/E', color: '#6b7280', font: { size: 11 } },
                        ticks: { callback: v => v + 'x', color: '#6b7280', font: { size: 11 } },
                        grid: { color: 'rgba(0,0,0,0.06)' },
                    },
                },
                onClick: (evt, elements) => {
                    if (elements.length) {
                        const p = included[elements[0].index];
                        if (p) window.open(screenerUrl(p.stock), '_blank');
                    }
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
            const badge = `<span class="inline-block rounded-full px-2 py-0.5 text-xs font-semibold" style="${getBadgeStyle(pct)}">${formatPct(pct)}</span>`;
            const pe = s.peRatio ? s.peRatio.toFixed(1) + 'x' : '<span class="text-gray-400">-</span>';
            const name = s.companyName ? `<span class="ml-2 hidden sm:inline text-xs text-gray-400">${escHtml(s.companyName)}</span>` : '';
            return `<tr class="hover:bg-gray-50 cursor-pointer" onclick="window.open('${escHtml(screenerUrl(s.stock))}','_blank')">
                <td class="px-4 py-3">
                    <a href="${escHtml(screenerUrl(s.stock))}" target="_blank" rel="noopener"
                       class="font-bold text-indigo-600 hover:underline"
                       onclick="event.stopPropagation();">${escHtml(s.stock)}</a>${name}
                </td>
                <td class="px-4 py-3 text-right text-gray-700 whitespace-nowrap">${formatPrice(s.currentPrice)}${dayHtml}</td>
                <td class="px-4 py-3 text-right text-gray-500">${formatPrice(s.sma)}</td>
                <td class="px-4 py-3 text-right">${badge}</td>
                <td class="px-4 py-3 text-right text-gray-500 hidden sm:table-cell">${pe}</td>
            </tr>`;
        }).join('');
    }

    function renderSummaries(sorted, summaries) {
        const section = document.getElementById('share-summaries-section');
        const list    = document.getElementById('share-summaries-list');
        if (!section || !list) return;
        const entries = sorted
            .filter(s => summaries[s.stock])
            .map(s => ({ stock: s.stock, ...summaries[s.stock] }));
        if (!entries.length) return;
        section.classList.remove('hidden');
        list.innerHTML = entries.map(e => `
            <div>
                <div class="flex items-center gap-2 mb-1">
                    <a href="${escHtml(screenerUrl(e.stock))}" target="_blank" rel="noopener"
                       class="font-bold text-indigo-600 hover:underline text-sm">${escHtml(e.stock)}</a>
                    <span class="text-xs text-gray-400">${escHtml(e.companyName || '')}</span>
                </div>
                <p class="text-sm text-gray-700 leading-relaxed">${escHtml(e.summary)}</p>
            </div>
        `).join('');
    }

    // ── Auth-sensitive UI ─────────────────────────────────────────────────────

    function setupAuthUI(stocks, smaPeriod, watchlistName) {
        if (isLoggedIn) {
            // Swap promo for "Go to Dashboard"
            document.getElementById('share-visitor-promo')?.classList.add('hidden');
            document.getElementById('share-loggedin-cta')?.classList.remove('hidden');
            // No subscribe banner for logged-in users
        } else {
            // Show subscribe banner
            const banner = document.getElementById('share-subscribe-banner');
            if (banner) banner.classList.remove('hidden');

            // Subscribe button: store watchlist then redirect to signup
            const btn = document.getElementById('share-subscribe-btn');
            if (btn) {
                btn.addEventListener('click', () => {
                    sessionStorage.setItem('pendingShareWatchlist', JSON.stringify({ stocks, smaPeriod }));
                    window.location.href = '/app?signup=1';
                });
            }

            // Promo "Create free account" button also stores watchlist before redirect
            const promoCta = document.getElementById('share-promo-cta');
            if (promoCta) {
                promoCta.addEventListener('click', () => {
                    sessionStorage.setItem('pendingShareWatchlist', JSON.stringify({ stocks, smaPeriod }));
                    window.location.href = '/app?signup=1';
                });
            }
        }
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    loadShare();

})();
