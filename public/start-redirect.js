// Redirect logged-in users straight to the app (runs blocking before paint)
try {
    const token = localStorage.getItem('token');
    if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload && payload.exp * 1000 > Date.now()) {
            window.location.replace('/app');
        }
    }
} catch (e) { /* invalid token — show landing page */ }
