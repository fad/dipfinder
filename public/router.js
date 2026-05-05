
document.addEventListener('DOMContentLoaded', () => {
    const mainContent = document.getElementById('main-content');
    const routes = {
        '/': 'dipfinder-content.html',
        '/screener': 'screener-content.html',
        '/profile': 'profile-content.html',
        '/contact': 'contact-content.html'
    };

    const loadContent = async (path) => {
        const route = routes[path];
        if (route) {
            try {
                const response = await fetch(route);
                if (response.ok) {
                    mainContent.innerHTML = await response.text();
                } else {
                    mainContent.innerHTML = '<p>Error loading page</p>';
                }
            } catch (error) {
                mainContent.innerHTML = '<p>Error loading page</p>';
            }
        }
    };

    const navigate = (path) => {
        window.history.pushState({}, path, window.location.origin + path);
        loadContent(path);
    };

    window.onpopstate = () => {
        loadContent(window.location.pathname);
    };

    document.body.addEventListener('click', e => {
        if (e.target.matches('[data-link]')) {
            e.preventDefault();
            navigate(e.target.getAttribute('href'));
        }
    });

    loadContent(window.location.pathname);
});
