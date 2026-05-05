// Your list of stocks
let stocks = []; // Initialize as empty array, will be populated in document ready
let chart; // Global variable to hold the chart instance
let notificationCache = {}; // Cache for notifications
let MAX_STOCKS = 10; // Default for guests
const BASE_URL = window.location.origin;

// Function to save stocks to localStorage
function saveStocks() {
    // Only save if we have valid stocks array and we're on a page that manages stocks
    if (Array.isArray(stocks) && stocks.length >= 0) {
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

// Initialize the table and chart on page load
$(document).ready(function() {
    // Initialize stocks from localStorage first
    try {
        const storedStocks = localStorage.getItem('stocks');
        if (storedStocks) {
            stocks = JSON.parse(storedStocks);
/*console.log('Loaded stocks from localStorage:', stocks);*/ 
        } else {
            // Only set defaults if we're on the main Dip Finder page (has stocks table)
            const isMainPage = document.getElementById('stocks-table') !== null;
            stocks = isMainPage ? ["CRM", "MSFT", "AAPL", "INTU"] : [];
/*console.log('Initialized stocks - isMainPage:', isMainPage, 'stocks:', stocks);*/ 
            
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

    // Initiliaze user profile
    loadProfile();
});

// --- Begin user functions ---
// Show the modal
document.getElementById("auth-button").addEventListener("click", function () {
    document.getElementById("auth-modal").classList.remove("hidden");
});

// --- Enhanced Login/Register Modal Logic ---

// Helper: Reset all auth forms and errors
function resetAuthForms() {
    document.getElementById("login-email").value = '';
    document.getElementById("login-password").value = '';
    document.getElementById("register-email").value = '';
    document.getElementById("register-password").value = '';
    document.getElementById("auth-error").textContent = '';
    document.getElementById("auth-success").textContent = '';
    if (window.hcaptcha) {
        try { hcaptcha.reset(); } catch(e){}
    }
}

// Helper: Show error inline
function showAuthError(msg) {
    document.getElementById("auth-error").textContent = msg;
    document.getElementById("auth-success").textContent = '';
}
// Helper: Show success inline
function showAuthSuccess(msg) {
    document.getElementById("auth-success").textContent = msg;
    document.getElementById("auth-error").textContent = '';
}

// Add error/success containers if not present
if (!document.getElementById("auth-error")) {
    const err = document.createElement('div');
    err.id = "auth-error";
    err.style.color = 'red';
    err.style.margin = '8px 0';
    document.getElementById("auth-modal").querySelector(".modal-content").prepend(err);
}
if (!document.getElementById("auth-success")) {
    const succ = document.createElement('div');
    succ.id = "auth-success";
    succ.style.color = 'green';
    succ.style.margin = '8px 0';
    document.getElementById("auth-modal").querySelector(".modal-content").prepend(succ);
}

// Show the modal
const authButton = document.getElementById("auth-button");
authButton.addEventListener("click", function () {
    resetAuthForms();
    document.getElementById("auth-modal").classList.remove("hidden");
    document.getElementById("auth-options").classList.remove("hidden");
    document.getElementById("login-form").classList.add("hidden");
    document.getElementById("register-form").classList.add("hidden");
    document.getElementById("captcha-container").classList.add("hidden");
});

function showLoginForm() {
    resetAuthForms();
    document.getElementById("auth-options").classList.add("hidden");
    document.getElementById("register-form").classList.add("hidden");
    document.getElementById("forgot-form").classList.add("hidden"); // Hide forgot form if visible
    document.getElementById("login-form").classList.remove("hidden");
    document.getElementById("captcha-container").classList.remove("hidden");
}

function showRegisterForm() {
    resetAuthForms();
    document.getElementById("auth-options").classList.add("hidden");
    document.getElementById("login-form").classList.add("hidden");
    document.getElementById("register-form").classList.remove("hidden");
    document.getElementById("captcha-container").classList.remove("hidden");
}

function closeAuthModal() {
    document.getElementById("auth-modal").classList.add("hidden");
    document.getElementById("login-form").classList.add("hidden");
    document.getElementById("register-form").classList.add("hidden");
    document.getElementById("auth-options").classList.remove("hidden");
    document.getElementById("captcha-container").classList.add("hidden");
    resetAuthForms();
}

// Add event listener for auth modal close button
const authModalCloseBtn = document.getElementById("auth-modal-close");
if (authModalCloseBtn) {
    authModalCloseBtn.addEventListener("click", function() {
        closeAuthModal();
    });
}

// Handle Login
async function login() {
    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;
    const captchaResponse = hcaptcha.getResponse();
    if (!captchaResponse) {
        showAuthError("Please complete the CAPTCHA");
        return;
    }
    const loginBtn = document.getElementById("login-btn");
    loginBtn.disabled = true;
    loginBtn.textContent = "Logging in...";
    try {
        const res = await fetch(`${BASE_URL}/api/user?action=login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, captchaResponse }),
        });
        const data = await res.json();
        if (res.ok) {
            localStorage.setItem("token", data.token);
            
            // Cache the authenticated state immediately for faster UI next time
            const userData = data.user || { email: email, name: email.split('@')[0] };
            localStorage.setItem("lastAuthState", JSON.stringify({ 
                isAuthenticated: true, 
                user: userData 
            }));
            
            await loadProfile();
            showAuthSuccess("Login successful!");
            setTimeout(() => {
                closeAuthModal();
                showLoggedInUI(userData);
            }, 800);
        } else {
            showAuthError(data.error || data.msg || "Login failed. Please try again.");
        }
    } catch (e) {
        showAuthError("Network error. Please try again.");
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = "Login";
    }
}

// Handle Registration
async function register() {
    const email = document.getElementById("register-email").value;
    const password = document.getElementById("register-password").value;
    const captchaResponse = hcaptcha.getResponse();
    if (!captchaResponse) {
        showAuthError("Please complete the CAPTCHA");
        return;
    }
    const regBtn = document.getElementById("register-btn");
    regBtn.disabled = true;
    regBtn.textContent = "Registering...";
    try {
        const res = await fetch(`${BASE_URL}/api/user?action=register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, captchaResponse }),
        });
        const data = await res.json();
        if (res.ok) {
            showAuthSuccess(data.msg || "Registration successful! Please log in.");
            setTimeout(() => showLoginForm(), 1200);
        } else {
            showAuthError(data.error || data.msg || "Registration failed. Please try again.");
        }
    } catch (e) {
        showAuthError("Network error. Please try again.");
    } finally {
        regBtn.disabled = false;
        regBtn.textContent = "Register";
    }
}

// --- Forgot Password Logic ---
let forgotCaptchaOk = false;
document.getElementById("forgot-password-link").addEventListener("click", function() {
    resetAuthForms();
    document.getElementById("login-form").classList.add("hidden");
    document.getElementById("forgot-form").classList.remove("hidden");
    forgotCaptchaOk = false;
    document.getElementById("forgot-btn").disabled = true;
});

async function forgotPassword() {
    const captchaResponse = hcaptcha.getResponse();
    if (!captchaResponse) {
        showAuthError("Please complete the CAPTCHA");
        return;
    }
    const email = document.getElementById("forgot-email").value;
    const btn = document.getElementById("forgot-btn");
    btn.disabled = true;
    btn.textContent = "Sending...";
    try {
        const res = await fetch(`${BASE_URL}/api/user?action=forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, captchaResponse })
        });
        const data = await res.json();
        if (res.ok) {
            showAuthSuccess("If this email exists, a reset link has been sent.");
            document.getElementById("forgot-form").classList.add("hidden");
            document.getElementById("forgot-ok-btn").classList.remove("hidden"); // Show OK button
        } else {
            showAuthError(data.error || "Failed to send reset link.");
        }
    } catch (e) {
        showAuthError("Network error. Please try again.");
    } finally {
        btn.disabled = false;
        btn.textContent = "Send Reset Link";
    }
}

// Add event listener for OK button to close modal and reset forms
const forgotOkBtn = document.getElementById("forgot-ok-btn");
if (forgotOkBtn) {
    forgotOkBtn.addEventListener("click", function() {
        closeAuthModal();
        forgotOkBtn.classList.add("hidden");
    });
}

// Load User Profile - Enhanced version
async function loadProfile() {
/*console.log("loadProfile() called");*/ 
    return await checkAuthStatus();
}

// Logout
function logout() {
    localStorage.removeItem("token");
    localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));
    showGuestUI();
}

// Toggle profile menu on click
const profileDropdown = document.getElementById("profile-dropdown");
const profileMenu = document.getElementById("profile-menu");
if (profileDropdown && profileMenu) {
    profileDropdown.addEventListener("click", function (e) {
        e.stopPropagation();
        profileMenu.classList.toggle("hidden");
    });
    // Hide menu when clicking outside
    document.addEventListener("click", function (e) {
        if (!profileDropdown.contains(e.target)) {
            profileMenu.classList.add("hidden");
        }
    });
}
// --- End user functions ---

// --- Initialize Ticker Auto-complete ---
// Initialize auto-complete for the main page stock input
const newStockInput = document.getElementById('new-stock');
if (newStockInput) {
    initStockAutocomplete('new-stock');
}

// --- hCaptcha button enable/disable logic ---
function setAuthButtonsEnabled(enabled) {
    const loginBtn = document.getElementById("login-btn");
    const regBtn = document.getElementById("register-btn");
    const forgotBtn = document.getElementById("forgot-btn");
    // Only enable the button for the visible form
    if (enabled) {
        if (document.getElementById("login-form") && !document.getElementById("login-form").classList.contains("hidden")) {
            loginBtn.disabled = false;
            loginBtn.classList.remove("bg-gray-400", "cursor-not-allowed");
            loginBtn.classList.add("bg-blue-500");
        }
        if (document.getElementById("register-form") && !document.getElementById("register-form").classList.contains("hidden")) {
            regBtn.disabled = false;
            regBtn.classList.remove("bg-gray-400", "cursor-not-allowed");
            regBtn.classList.add("bg-green-500");
        }
        if (document.getElementById("forgot-form") && !document.getElementById("forgot-form").classList.contains("hidden")) {
            forgotBtn.disabled = false;
            forgotBtn.classList.remove("bg-gray-400", "cursor-not-allowed");
            forgotBtn.classList.add("bg-blue-500");
        }
    } else {
        if (loginBtn) {
            loginBtn.disabled = true;
            loginBtn.classList.remove("bg-blue-500");
            loginBtn.classList.add("bg-gray-400", "cursor-not-allowed");
        }
        if (regBtn) {
            regBtn.disabled = true;
            regBtn.classList.remove("bg-green-500");
            regBtn.classList.add("bg-gray-400", "cursor-not-allowed");
        }
        if (forgotBtn) {
            forgotBtn.disabled = true;
            forgotBtn.classList.remove("bg-blue-500");
            forgotBtn.classList.add("bg-gray-400", "cursor-not-allowed");
        }
    }
}

// Called by hCaptcha callback
document.onCaptchaSuccess = window.onCaptchaSuccess = function() {
    setAuthButtonsEnabled(true);
};
document.onCaptchaExpired = window.onCaptchaExpired = function() {
    setAuthButtonsEnabled(false);
};

// Patch resetAuthForms to always disable buttons until captcha
const _resetAuthForms = resetAuthForms;
resetAuthForms = function() {
    _resetAuthForms();
    setAuthButtonsEnabled(false);
};

// On DOMContentLoaded, disable buttons until captcha
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setAuthButtonsEnabled(false));
} else {
    setAuthButtonsEnabled(false);
}

// Enhanced authentication check with fast client-side validation and instant UI
async function checkAuthStatus() {
    const token = localStorage.getItem("token");
    const lastAuthState = localStorage.getItem("lastAuthState");
    
/*console.log("Checking auth status, token exists:", !!token, "last state:", lastAuthState);*/ 
    
    // If we have a stored auth state, show it immediately for instant UI
    if (lastAuthState) {
        try {
            const cachedState = JSON.parse(lastAuthState);
            if (cachedState.isAuthenticated && cachedState.user) {
/*console.log("Showing cached authenticated state instantly");*/ 
                showLoggedInUI(cachedState.user);
            } else {
/*console.log("Showing cached guest state instantly");*/ 
                showGuestUI();
            }
        } catch (e) {
/*console.log("Invalid cached state, clearing");*/ 
            localStorage.removeItem("lastAuthState");
        }
    }
    
    if (!token) {
/*console.log("No token found, confirming guest UI");*/ 
        localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));
        showGuestUI();
        return false;
    }

    // Fast client-side token validation (check if expired)
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const currentTime = Math.floor(Date.now() / 1000);
        
        if (payload.exp && payload.exp < currentTime) {
/*console.log("Token expired, clearing and showing guest UI");*/ 
            localStorage.removeItem("token");
            localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));
            showGuestUI();
            return false;
        }
        
        // Token seems valid, show logged-in UI immediately with cached user info
        if (payload.email) {
            const userData = { 
                email: payload.email, 
                name: payload.name || payload.email.split('@')[0] 
            };
/*console.log("Token valid, showing logged in UI with cached data");*/ 
            
            // Cache the authenticated state
            localStorage.setItem("lastAuthState", JSON.stringify({ 
                isAuthenticated: true, 
                user: userData 
            }));
            
            showLoggedInUI(userData);
            
            // Then verify with server in background (don't await, let it run async)
            verifyTokenWithServer(token);
            return true;
        }
    } catch (e) {
/*console.log("Token format invalid, clearing and showing guest UI");*/ 
        localStorage.removeItem("token");
        localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));
        showGuestUI();
        return false;
    }

    // Fallback to server validation if client-side validation fails
    return await verifyTokenWithServer(token);
}

// Background server verification (doesn't block UI)
async function verifyTokenWithServer(token) {
    try {
        const res = await fetch(`${BASE_URL}/api/user?action=verify-token`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        
/*console.log("Server token verification response:", res.status, data);*/ 
        
        if (res.ok && data.valid) {
/*console.log("Server confirmed token valid");*/ 
            const userData = data.user;
            
            // Update cached state with fresh server data
            localStorage.setItem("lastAuthState", JSON.stringify({ 
                isAuthenticated: true, 
                user: userData 
            }));
            
            showLoggedInUI(userData);
            return true;
        } else {
/*console.log("Server says token invalid, clearing and showing guest UI");*/ 
            localStorage.removeItem("token");
            localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));
            showGuestUI();
            return false;
        }
    } catch (error) {
        console.error("Server auth check failed:", error);
        // Don't change UI or cached state on network error, keep current state
        return false;
    }
}

function showGuestUI() {
    // Hide loading state
    if (document.getElementById("auth-loading")) {
        document.getElementById("auth-loading").classList.add("hidden");
    }
    
    // Show login button
    if (document.getElementById("auth-button")) {
        document.getElementById("auth-button").classList.remove("hidden");
    }
    
    // Hide profile dropdown
    if (document.getElementById("profile-dropdown")) {
        document.getElementById("profile-dropdown").classList.add("hidden");
    }
    if (document.getElementById("profile-menu")) {
        document.getElementById("profile-menu").classList.add("hidden");
    }
    
    // Update stock limits
    if (typeof MAX_STOCKS !== 'undefined') {
        MAX_STOCKS = 10;
    }
    if (document.getElementById("stock-limit-message")) {
        document.getElementById("stock-limit-message").textContent = "You can only have up to 10 stocks. To increase this limit to 20, please log in.";
    }
}

function showLoggedInUI(user) {
    // Hide loading state
    if (document.getElementById("auth-loading")) {
        document.getElementById("auth-loading").classList.add("hidden");
    }
    
    // Hide login button
    if (document.getElementById("auth-button")) {
        document.getElementById("auth-button").classList.add("hidden");
    }
    
    // Show profile dropdown
    if (document.getElementById("profile-dropdown")) {
        document.getElementById("profile-dropdown").classList.remove("hidden");
    }
    if (document.getElementById("profile-email")) {
        document.getElementById("profile-email").innerText = user.email;
    }
    
    // Update stock limits
    if (typeof MAX_STOCKS !== 'undefined') {
        MAX_STOCKS = 20;
    }
    if (document.getElementById("stock-limit-message")) {
        document.getElementById("stock-limit-message").textContent = "You can only have up to 20 stocks.";
    }
}

// Call auth check on initial load
// Pre-check authentication state to minimize flicker
(function() {
    const token = localStorage.getItem("token");
    const lastAuthState = localStorage.getItem("lastAuthState");
    
    // If we have cached state, apply it immediately to minimize flicker
    if (lastAuthState) {
        try {
            const cachedState = JSON.parse(lastAuthState);
            // Set a data attribute on the body to indicate expected auth state
            document.addEventListener('DOMContentLoaded', function() {
                if (cachedState.isAuthenticated && cachedState.user) {
                    showLoggedInUI(cachedState.user);
                } else {
                    showGuestUI();
                }
                
                // Then run the full auth check
                checkAuthStatus();
            });
        } catch (e) {
            // If cache is invalid, just run normal flow
            document.addEventListener('DOMContentLoaded', function() {
                checkAuthStatus();
            });
        }
    } else {
        // No cache, run normal flow
        document.addEventListener('DOMContentLoaded', function() {
            checkAuthStatus();
        });
    }
})();