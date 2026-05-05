document.addEventListener('DOMContentLoaded', () => {
    const mainContent = document.getElementById('main-content');
    let currentPageCleanup = null; // To hold the cleanup function for the current page

    const routes = {
        '/': {
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
            init: null, // No JS for contact page
            destroy: null
        }
    };

    // Navigation highlighting function
    const updateNavigation = (currentPath) => {
/*console.log('Updating navigation for path:', currentPath);*/ 
        
        // Direct DOM selection for each navigation button
        const homeButton = document.querySelector('a[href="/"][data-link]');
        const screenerButton = document.querySelector('a[href="/screener"][data-link]');
        
        if (homeButton && screenerButton) {
            // Active and inactive class sets
            const activeClasses = 'inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700';
            const inactiveClasses = 'inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700';
            
            // Update home button
            homeButton.className = currentPath === '/' ? activeClasses : inactiveClasses;
/*console.log('Home button updated:', homeButton.className);*/ 
            
            // Preserve icon for screener button
            let screenerIcon = '';
            if (screenerButton.querySelector('i')) {
                screenerIcon = screenerButton.querySelector('i').outerHTML;
            }
            
            // Update screener button
            screenerButton.className = currentPath === '/screener' ? activeClasses : inactiveClasses;
/*console.log('Screener button updated:', screenerButton.className);*/ 
            
            // Ensure the screener button has its icon
            if (screenerIcon && !screenerButton.querySelector('i')) {
                screenerButton.innerHTML = screenerIcon + ' Stock Screener';
            }
        } else {
            console.error('Navigation buttons not found in DOM');
        }
    };

    const loadContent = async (fullPath) => {
        // Default to '/' if path is empty or just a hash
        if (fullPath === '' || fullPath === '#') {
            fullPath = '/';
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
});
