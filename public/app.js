document.addEventListener('DOMContentLoaded', () => {
    // ── Theme toggle ──────────────────────────────────────────────────────────
    function updateThemeToggle() {
        const isDark = document.documentElement.classList.contains('dark-mode');
        const toggle = document.getElementById('theme-toggle');
        const icon   = document.getElementById('theme-toggle-icon');
        if (!toggle || !icon) return;
        toggle.setAttribute('aria-pressed', String(isDark));
        toggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
        icon.className = isDark ? 'fas fa-sun text-base' : 'fas fa-moon text-base';
    }

    updateThemeToggle();
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', function() {
            const isDark = document.documentElement.classList.toggle('dark-mode');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            updateThemeToggle();
        });
    }

    // ── Profile dropdown ──────────────────────────────────────────────────────
    const profileBtn         = document.getElementById('profile-btn');
    const profileDropdownMenu = document.getElementById('profile-dropdown-menu');

    if (profileBtn && profileDropdownMenu) {
        profileBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            profileDropdownMenu.classList.toggle('hidden');
        });
    }

    document.addEventListener('click', function(e) {
        if (!profileDropdownMenu) return;
        if (profileBtn && !profileBtn.contains(e.target) && !profileDropdownMenu.contains(e.target)) {
            profileDropdownMenu.classList.add('hidden');
        }
    });

    const profileNavLink = document.getElementById('profile-nav-link');
    if (profileNavLink) {
        profileNavLink.addEventListener('click', function() {
            if (profileDropdownMenu) profileDropdownMenu.classList.add('hidden');
        });
    }


    const mainContent = document.getElementById('main-content');
    let currentPageCleanup = null; // To hold the cleanup function for the current page

    // ── Per-route SEO metadata ────────────────────────────────────────────────
    const routeMeta = {
        '/':         { title: 'Dip Finder – Find Dips in Stocks You Already Want to Own',    description: 'Track your watchlist and instantly see which stocks are trading furthest below their moving average. Free, no account required.' },
        '/screener': { title: 'Stock Screener – Dip Finder',                                  description: 'Screen any stock by SMA distance, price, volume, and fundamentals. Powered by Dip Finder.' },
        '/about':    { title: 'About – Dip Finder',                                           description: 'Learn how Dip Finder helps you spot buying opportunities in stocks you already want to own.' },
        '/contact':  { title: 'Contact – Dip Finder',                                         description: 'Get in touch with the Dip Finder team.' },
        '/privacy':  { title: 'Privacy Policy – Dip Finder',                                  description: 'Read the Dip Finder privacy policy.' },
        '/profile':  { title: 'Profile – Dip Finder',                                         description: 'Manage your Dip Finder account and saved watchlist.' },
    };

    function updatePageMeta(path) {
        const meta = routeMeta[path] || routeMeta['/'];
        document.title = meta.title;
        const setMeta = (sel, val) => { const el = document.querySelector(sel); if (el) el.setAttribute('content', val); };
        setMeta('meta[name="description"]',         meta.description);
        setMeta('meta[property="og:title"]',        meta.title);
        setMeta('meta[property="og:description"]',  meta.description);
        setMeta('meta[name="twitter:title"]',       meta.title);
        setMeta('meta[name="twitter:description"]', meta.description);
    }

    const routes = {
        '/app': {
            file: 'dipfinder-content.html',
            init: (params) => { if (window.initializeDipfinder) window.initializeDipfinder(params); },
            destroy: () => { if (window.destroyDipfinder) window.destroyDipfinder(); }
        },
        '/screener': {
            file: 'screener-content.html',
            init: (params) => { if (window.initializeScreener) window.initializeScreener(params); },
            destroy: () => { if (window.destroyScreener) window.destroyScreener(); }
        },
        '/profile': {
            file: 'profile-content.html',
            init: (params) => { if (window.initializeProfile) window.initializeProfile(params); },
            destroy: () => { if (window.destroyProfile) window.destroyProfile(); }
        },
        '/privacy': {
            file: 'privacy.html',
            init: (params) => { if (window.initializeProfile) window.initializeProfile(params); },
            destroy: () => { if (window.destroyProfile) window.destroyProfile(); }
        },
        '/contact': {
            file: 'contact-content.html',
            init: null,
            destroy: null
        },
        '/about': {
            file: 'about-content.html',
            init: null,
            destroy: null
        }
    };

    // Navigation highlighting function
    const updateNavigation = (currentPath) => {
/*console.log('Updating navigation for path:', currentPath);*/ 
        
        // Direct DOM selection for each navigation button
        const homeButton = document.querySelector('a[href="/app"][data-link]');
        const screenerButton = document.querySelector('a[href="/screener"][data-link]');
        
        if (homeButton && screenerButton) {
            const activeClasses = 'inline-flex items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-700';
            const inactiveClasses = 'inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-100 hover:text-gray-900';

            homeButton.className = currentPath === '/app' ? activeClasses : inactiveClasses;

            let screenerIcon = '';
            if (screenerButton.querySelector('i')) {
                screenerIcon = screenerButton.querySelector('i').outerHTML;
            }
            screenerButton.className = currentPath === '/screener' ? activeClasses : inactiveClasses;
            if (screenerIcon && !screenerButton.querySelector('i')) {
                screenerButton.innerHTML = screenerIcon + ' Screener';
            }
        }
    };

    const loadContent = async (fullPath) => {
        // Default to '/app' if path is empty or just a hash
        if (fullPath === '' || fullPath === '#') {
            fullPath = '/app';
        }

        // Run cleanup for the previous page
        if (currentPageCleanup) {
            currentPageCleanup();
            currentPageCleanup = null;
        }

        const url = new URL(fullPath, window.location.origin);
        const path = url.pathname;
        const params = url.searchParams;

        const route = routes[path];
        const filename = route ? route.file : '404.html'; // A 404.html would be good to have

        try {
            const response = await fetch(filename);
            if (response.ok) {
                mainContent.innerHTML = await response.text();
                updatePageMeta(path);

                // Update navigation highlighting - call with a slight delay to ensure DOM is ready
                setTimeout(() => {
                    updateNavigation(path);
                }, 10);
                
                if (route && route.init) {
                    // Use a small timeout to ensure the DOM is updated before scripts run
                    setTimeout(() => {
                        route.init(params);
                    }, 20);
                }
                // Set the cleanup function for the new page
                if (route && route.destroy) {
                    currentPageCleanup = route.destroy;
                }
            } else {
                mainContent.innerHTML = '<p>Error: Page not found.</p>';
            }
        } catch (error) {
            console.error('Error loading page:', error);
            mainContent.innerHTML = '<p>Error loading page. Please check your connection.</p>';
        }
    };

    const navigate = (path) => {
        // Don't navigate if we are already on the same page
        if (window.location.pathname + window.location.search === path) {
            return;
        }
        window.history.pushState({ path }, '', path);
        loadContent(path);
    };

    window.addEventListener('popstate', (event) => {
        const path = (event.state && event.state.path) ? event.state.path : (window.location.pathname + window.location.search);
        loadContent(path);
    });

    document.body.addEventListener('click', (e) => {
        const anchor = e.target.closest('a');
        if (anchor && anchor.hasAttribute('data-link')) {
            e.preventDefault();
            const path = anchor.getAttribute('href');
            navigate(path);
        }
    });

    // Expose the navigate function to the global scope
    window.spaNavigate = navigate;

    // Initial load
    loadContent(window.location.pathname + window.location.search);

    // Also directly update navigation for initial load (fallback)
    setTimeout(() => {
        updateNavigation(window.location.pathname);
    }, 100);

    // Auto-open auth modal when arriving via ?signin=1
    if (new URLSearchParams(window.location.search).get('signin') === '1') {
        setTimeout(() => {
            const modal = document.getElementById('auth-modal');
            if (modal) modal.classList.remove('hidden');
        }, 150);
    }
});
