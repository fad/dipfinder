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

    // Convert plain-text notes to safe HTML: URLs become clickable links, newlines become <br>
    function linkifyText(text) {
        return text.split(/(https?:\/\/[^\s<>"]+)/).map((part, i) => {
            if (i % 2 === 1) {
                const safe = escHtml(part);
                return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 underline hover:text-indigo-800 break-all">${safe}</a>`;
            }
            return escHtml(part).replace(/\n/g, '<br>');
        }).join('');
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
        // Reveal the fixed sidebar (xl+ only — CSS hides it below xl)
        document.getElementById('share-sma-sidebar')?.classList.remove('hidden');
    }

    // ── Screener link ─────────────────────────────────────────────────────────

    function screenerUrl(symbol) {
        return '/screener?symbol=' + encodeURIComponent(symbol);
    }

    // ── State ─────────────────────────────────────────────────────────────────

    document.getElementById('share-year').textContent = new Date().getFullYear();

    let _shareStocks    = [];
    let _shareOwnerPeriod = 50;
    let _activePeriod   = 50;
    let _cachedSummaries = {};
    let _barChart       = null;
    let _scatterChart   = null;
    let _isRefetching   = false;

    // ── SMA pills ─────────────────────────────────────────────────────────────

    const SMA_OPTIONS = [20, 50, 100, 200];

    // Sidebar pills are full-width vertical; mobile pills are horizontal rounded pills
    function renderPillsInto(container, activePeriod, vertical) {
        if (!container) return;
        container.innerHTML = SMA_OPTIONS.map(p => {
            const isActive = p === activePeriod;
            const base = vertical
                ? `w-full text-left px-3 py-2 text-sm font-semibold rounded-lg border transition`
                : `rounded-full px-3 py-1 text-xs font-semibold border transition`;
            return `<button data-period="${p}" class="${base} ${isActive
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-400 hover:text-indigo-600'
            }">${p}-day</button>`;
        }).join('');
        container.addEventListener('click', e => {
            const btn = e.target.closest('button[data-period]');
            if (!btn) return;
            const period = Number(btn.dataset.period);
            if (period !== _activePeriod) changeSmaPeriod(period);
        });
    }

    function setupSmaPills(ownerPeriod) {
        // Fixed sidebar (xl+): vertical full-width buttons
        const sidebar = document.getElementById('share-sma-pills');
        const ownerSpan = document.getElementById('share-owner-period');
        if (ownerSpan) ownerSpan.textContent = ownerPeriod;
        renderPillsInto(sidebar, _activePeriod, true);

        // Header inline (below xl): horizontal rounded pills
        const inline = document.getElementById('share-sma-pills-mobile');
        const ownerSpanMobile = document.getElementById('share-owner-period-mobile');
        if (ownerSpanMobile) ownerSpanMobile.textContent = ownerPeriod;
        renderPillsInto(inline, _activePeriod, false);
    }

    function updateSmaPills(activePeriod) {
        ['share-sma-pills', 'share-sma-pills-mobile'].forEach(id => {
            const container = document.getElementById(id);
            if (!container) return;
            container.querySelectorAll('button[data-period]').forEach(btn => {
                const isActive = Number(btn.dataset.period) === activePeriod;
                // Preserve vertical vs horizontal class by checking if it has w-full
                const isVertical = btn.classList.contains('w-full');
                const base = isVertical
                    ? `w-full text-left px-3 py-2 text-sm font-semibold rounded-lg border transition`
                    : `rounded-full px-3 py-1 text-xs font-semibold border transition`;
                btn.className = `${base} ${isActive
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-400 hover:text-indigo-600'
                }`;
            });
        });
    }

    async function changeSmaPeriod(period) {
        if (_isRefetching) return;
        _activePeriod = period;
        updateSmaPills(period);
        updatePeriodLabels(period);

        _isRefetching = true;
        // Show subtle loading on chart area
        const chartWrap = document.getElementById('share-chart-wrap');
        if (chartWrap) chartWrap.style.opacity = '0.4';

        try {
            const stockResults = await fetchStockData(_shareStocks, period);
            renderDynamic(stockResults, period);
        } finally {
            _isRefetching = false;
            if (chartWrap) chartWrap.style.opacity = '1';
        }
    }

    // ── Period labels ─────────────────────────────────────────────────────────

    function updatePeriodLabels(period) {
        const chartTitle = document.getElementById('share-chart-title');
        if (chartTitle) chartTitle.textContent = `Distance from ${period}-day SMA`;

        const chartCaption = document.getElementById('share-chart-caption');
        if (chartCaption) chartCaption.textContent =
            `Bars show how far each stock is trading below (negative) or above (positive) its ${period}-day SMA.`;

        const scatterCaption = document.getElementById('share-scatter-caption');
        if (scatterCaption) scatterCaption.textContent =
            `Distance from ${period}-day SMA (X) vs trailing P/E ratio (Y). Stocks without P/E data are excluded.`;

        const thSma = document.getElementById('share-th-sma');
        if (thSma) thSma.textContent = `${period}d SMA`;

        const thVsSma = document.getElementById('share-th-vs-sma');
        if (thVsSma) thVsSma.textContent = `vs ${period}d SMA`;
    }

    // ── Data fetching ─────────────────────────────────────────────────────────

    async function fetchStockData(stocks, period) {
        try {
            const r = await fetch('/api/batch-stocks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stocks: stocks.slice(0, 20), period }),
            });
            if (r.ok) {
                const json = await r.json();
                return json.results || [];
            }
        } catch { /* non-fatal */ }
        return [];
    }

    async function fetchSummaries(stocks) {
        try {
            const params = new URLSearchParams({
                action: 'ai-summaries',
                symbols: stocks.slice(0, 20).join(','),
                _t: String(Date.now()),
            });
            const r = await fetch('/api/batch-stocks?' + params, { cache: 'no-store' });
            if (r.ok) {
                const json = await r.json();
                return json.summaries || {};
            }
        } catch { /* non-fatal */ }
        return {};
    }

    // ── Main ──────────────────────────────────────────────────────────────────

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

        const { watchlistName, ownerName, stocks, smaPeriod, notes } = shareData;
        if (!Array.isArray(stocks) || !stocks.length) { showError(); return; }

        _shareStocks      = stocks;
        _shareOwnerPeriod = smaPeriod;
        _activePeriod     = smaPeriod;

        // 2. Render static header parts
        document.getElementById('share-title').textContent = watchlistName;
        const subtitleEl = document.getElementById('share-subtitle');
        if (subtitleEl) {
            if (notes && notes.trim()) {
                subtitleEl.innerHTML = linkifyText(notes);
                subtitleEl.className = 'mt-2 text-sm text-gray-700 leading-relaxed';
            } else {
                subtitleEl.textContent = ownerName + '\'s watchlist - ranked by distance from their moving average';
            }
        }
        updatePeriodLabels(smaPeriod);
        setupSmaPills(smaPeriod);
        setupShareButton();

        // 3. Fetch live stock data + summaries in parallel
        const [stockResults, summaries] = await Promise.all([
            fetchStockData(stocks, smaPeriod),
            fetchSummaries(stocks),
        ]);
        _cachedSummaries = summaries;

        // 4. Render dynamic content
        const sorted = renderDynamic(stockResults, smaPeriod);
        renderSummaries(sorted, summaries);

        showContent();
        setupAuthUI(stocks, smaPeriod, watchlistName);
    }

    // ── Dynamic render (re-used on period change) ─────────────────────────────

    function renderDynamic(stockResults, period) {
        const sorted = [...stockResults].sort((a, b) => a.relativePrice - b.relativePrice);
        renderMetrics(sorted);
        renderChart(sorted, period);
        renderScatter(sorted, period);
        renderTable(sorted, period);
        return sorted;
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

    function renderChart(sorted, period) {
        if (_barChart) { _barChart.destroy(); _barChart = null; }
        const canvas = document.getElementById('share-chart');
        if (!canvas || !window.Chart) return;
        const labels   = sorted.map(s => s.stock);
        const values   = sorted.map(s => Number.isFinite(s.relativePrice) ? +(s.relativePrice * 100).toFixed(2) : null);
        const bgColors = sorted.map(s => getBarColor(s.relativePrice * 100).bg);
        const bdColors = sorted.map(s => getBarColor(s.relativePrice * 100).border);
        const height   = Math.max(200, labels.length * 32 + 60);
        canvas.parentElement.style.height = height + 'px';
        _barChart = new Chart(canvas.getContext('2d'), {
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
                            label: ctx => (ctx.parsed.x >= 0 ? '+' : '') + ctx.parsed.x.toFixed(1) + '% vs ' + period + '-day SMA',
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

    function renderScatter(sorted, period) {
        if (_scatterChart) { _scatterChart.destroy(); _scatterChart = null; }
        const section = document.getElementById('share-scatter-section');
        const canvas  = document.getElementById('share-scatter-chart');
        if (!section || !canvas || !window.Chart) return;

        // Hide section first; show only if enough data
        section.classList.add('hidden');

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

        if (included.length < 2) return;

        section.classList.remove('hidden');

        const excludedEl = document.getElementById('share-scatter-excluded');
        if (excludedEl && excluded.length) {
            excludedEl.textContent = 'Not shown: ' + excluded.map(e => e.stock).join(', ') + ' - no P/E data or negative earnings';
            excludedEl.classList.remove('hidden');
        } else if (excludedEl) {
            excludedEl.classList.add('hidden');
        }

        const pointColors = included.map(p => getBarColor(p.diffPercent).bg);

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

        _scatterChart = new Chart(canvas.getContext('2d'), {
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
                                return p.stock + ': ' + (p.x >= 0 ? '+' : '') + p.x + '% vs ' + period + 'd SMA, P/E ' + p.y.toFixed(1) + 'x';
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        title: { display: true, text: '% vs ' + period + '-day SMA', color: '#6b7280', font: { size: 11 } },
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

    function renderTable(sorted, period) {
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
            const pe    = s.peRatio ? s.peRatio.toFixed(1) + 'x' : '<span class="text-gray-400">-</span>';
            const name  = s.companyName ? `<span class="ml-2 hidden sm:inline text-xs text-gray-400">${escHtml(s.companyName)}</span>` : '';
            return `<tr class="hover:bg-gray-50 cursor-pointer" onclick="window.open('${escHtml(screenerUrl(s.stock))}','_blank')">
                <td class="px-4 py-3">
                    <a href="${escHtml(screenerUrl(s.stock))}" target="_blank" rel="noopener"
                       class="font-bold text-indigo-600 hover:underline"
                       onclick="event.stopPropagation();">${escHtml(s.stock)}</a>${name}
                </td>
                <td class="px-4 py-3 text-right text-gray-700 whitespace-nowrap">${formatPrice(s.currentPrice)}${dayHtml}</td>
                <td class="px-4 py-3 text-right text-gray-500" title="${period}-day SMA">${formatPrice(s.sma)}</td>
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

    // ── Share modal ───────────────────────────────────────────────────────────

    function setupShareButton() {
        const btn = document.getElementById('share-share-btn');
        if (!btn) return;
        btn.addEventListener('click', showShareModal);
    }

    function showShareModal() {
        const url = window.location.href;
        const existing = document.getElementById('_share-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = '_share-modal-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

        const modal = document.createElement('div');
        modal.style.cssText = 'background:white;border-radius:16px;padding:24px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3);';
        modal.addEventListener('click', e => e.stopPropagation());

        const enc = encodeURIComponent(url);
        const socials = [
            { label: 'X',         bg: '#000',     icon: 'fab fa-x-twitter',       href: 'https://x.com/intent/tweet?url=' + enc },
            { label: 'WhatsApp',  bg: '#25D366',  icon: 'fab fa-whatsapp',         href: 'https://wa.me/?text=' + enc },
            { label: 'LinkedIn',  bg: '#0A66C2',  icon: 'fab fa-linkedin-in',      href: 'https://www.linkedin.com/sharing/share-offsite/?url=' + enc },
            { label: 'Facebook',  bg: '#1877F2',  icon: 'fab fa-facebook-f',       href: 'https://www.facebook.com/sharer/sharer.php?u=' + enc },
            { label: 'Reddit',    bg: '#FF4500',  icon: 'fab fa-reddit-alien',     href: 'https://reddit.com/submit?url=' + enc },
            { label: 'Telegram',  bg: '#2CA5E0',  icon: 'fab fa-telegram-plane',   href: 'https://t.me/share/url?url=' + enc },
            { label: 'Bluesky',   bg: '#0085ff',  icon: 'fas fa-cloud',            href: 'https://bsky.app/intent/compose?text=' + encodeURIComponent(window.location.href) },
            { label: 'Email',     bg: '#6B7280',  icon: 'fas fa-envelope',         href: 'mailto:?body=' + enc },
        ];

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;';
        const title = document.createElement('h3');
        title.style.cssText = 'font-size:16px;font-weight:700;color:#111827;margin:0;';
        title.textContent = 'Share this watchlist';
        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:#9ca3af;font-size:20px;line-height:1;padding:4px;';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => overlay.remove());
        header.append(title, closeBtn);

        // URL row
        const urlRow = document.createElement('div');
        urlRow.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.value = url;
        urlInput.readOnly = true;
        urlInput.style.cssText = 'flex:1;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;font-size:13px;color:#374151;background:#f9fafb;outline:none;min-width:0;';
        const copyBtn = document.createElement('button');
        copyBtn.style.cssText = 'background:linear-gradient(135deg,#2563EB,#4F46E5);color:white;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(url).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            }).catch(() => {
                urlInput.select();
                document.execCommand('copy');
            });
        });
        urlRow.append(urlInput, copyBtn);

        // Social grid
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;';
        socials.forEach(s => {
            const a = document.createElement('a');
            a.href = s.href;
            a.target = '_blank';
            a.rel = 'noopener';
            a.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 6px;border-radius:10px;background:${s.bg};color:white;text-decoration:none;font-size:11px;font-weight:600;`;
            const ico = document.createElement('i');
            ico.className = s.icon;
            ico.style.cssText = 'font-size:18px;';
            const lbl = document.createTextNode(s.label);
            a.append(ico, lbl);
            grid.appendChild(a);
        });

        modal.append(header, urlRow, grid);
        overlay.appendChild(modal);
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    }

    // ── Auth-sensitive UI ─────────────────────────────────────────────────────

    function setupAuthUI(stocks, smaPeriod, watchlistName) {
        if (isLoggedIn) {
            // Swap nav button to "Go to Dashboard"
            const navCta = document.getElementById('share-nav-cta');
            if (navCta) {
                navCta.href = '/app';
                navCta.innerHTML = 'Go to Dashboard <i class="fas fa-arrow-right text-xs"></i>';
                navCta.removeAttribute('data-umami-event');
            }
            // Hide the entire promo section
            document.getElementById('share-promo-section')?.classList.add('hidden');
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
