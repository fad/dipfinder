// dashboard-render.js — Pure display helpers: formatters, DOM renderers, notices

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

function getSmaDiffClasses(diffPercent) {
    if (!Number.isFinite(diffPercent)) return 'bg-gray-100 text-gray-600';
    if (diffPercent < 0) return 'bg-red-100 text-red-700';
    return 'bg-green-100 text-green-700';
}

// ── Period display ────────────────────────────────────────────────────────────

function updatePeriodDisplay(period) {
    const el = document.getElementById('selected-period-display');
    if (el) el.textContent = `${period}-Day SMA`;
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
