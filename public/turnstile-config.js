// Turnstile configuration utility
// Automatically selects the right keys based on environment

const TurnstileConfig = {
    // Site keys (these are safe to be public - they're meant for frontend use)
    KEYS: {
        test: '1x00000000000000000000AA',        // Official Cloudflare test key
        production: '0x4AAAAAABjHRopXtUY1Z6Lz'  // Your production key for dipfinder.com
    },

    // Get the appropriate site key based on current hostname
    getSiteKey() {
        const hostname = window.location.hostname;
        
        // Use test key for local development
        if (hostname === 'localhost' || 
            hostname === '127.0.0.1' || 
            hostname.startsWith('localhost:') ||
            hostname.includes('.local')) {
            return this.KEYS.test;
        }
        
        // Use production key for dipfinder.com and its subdomains
        if (hostname === 'dipfinder.com' || 
            hostname.endsWith('.dipfinder.com') ||
            hostname.includes('vercel.app')) {
            return this.KEYS.production;
        }
        
        // Fallback to test key for unknown domains (safer default)
        console.warn(`Unknown hostname: ${hostname}, using test key`);
        return this.KEYS.test;
    },

    // Initialize all Turnstile widgets on the page with the correct site key
    initializeWidgets() {
        const widgets = document.querySelectorAll('.cf-turnstile');
        const siteKey = this.getSiteKey();
        
        widgets.forEach(widget => {
            widget.setAttribute('data-sitekey', siteKey);
        });

/*console.log(`Turnstile initialized with site key: ${siteKey} for hostname: ${window.location.hostname}`);*/ 
    },

    loadScript() {
        if (window.turnstile) {
            return Promise.resolve(window.turnstile);
        }

        if (this.scriptPromise) {
            return this.scriptPromise;
        }

        this.scriptPromise = new Promise((resolve, reject) => {
            const existingScript = document.querySelector('script[data-turnstile-api]');
            if (existingScript) {
                existingScript.addEventListener('load', () => resolve(window.turnstile));
                existingScript.addEventListener('error', reject);
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
            script.async = true;
            script.defer = true;
            script.dataset.turnstileApi = 'true';
            script.onload = () => resolve(window.turnstile);
            script.onerror = reject;
            document.head.appendChild(script);
        });

        return this.scriptPromise;
    },

    ensureLoaded() {
        this.initializeWidgets();
        return this.loadScript().catch(error => {
            console.error('Failed to load Cloudflare Turnstile:', error);
            throw error;
        });
    },

    // Check if we're in development mode
    isDevelopment() {
        const hostname = window.location.hostname;
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.includes('localhost');
    }
};

// Auto-initialize when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TurnstileConfig.initializeWidgets());
} else {
    TurnstileConfig.initializeWidgets();
}

// Make it globally available
window.TurnstileConfig = TurnstileConfig;
