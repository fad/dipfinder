// Redirect logged-in users straight to the app (runs blocking before paint)
// Skip redirect if ?noredirect is present (e.g. navigating from the app intentionally)
if (!new URLSearchParams(window.location.search).has('noredirect')) {
    try {
        const token = localStorage.getItem('token');
        if (token) {
            const payload = JSON.parse(atob(token.split('.')[1]));
            if (payload && payload.exp * 1000 > Date.now()) {
                window.location.replace('/app');
            }
        }
    } catch (e) { /* invalid token — show landing page */ }
}
