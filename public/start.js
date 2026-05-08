// ── Parallax on scroll ──────────────────────────────────────────────────
const heroSection  = document.getElementById('hero-section');
const heroText     = document.getElementById('hero-text');
const heroPreview  = document.getElementById('hero-preview-wrap');

if (heroSection && heroText && heroPreview) {
    let ticking = false;

    window.addEventListener('scroll', () => {
        if (ticking) return;
        requestAnimationFrame(() => {
            const scrollY    = window.scrollY;
            const heroHeight = heroSection.offsetHeight;
            if (scrollY > heroHeight) { ticking = false; return; }

            // Text drifts up gently; image lags slightly behind
            heroText.style.transform    = `translateY(${scrollY * 0.12}px)`;
            heroPreview.style.transform = `translateY(${scrollY * 0.05}px)`;
            ticking = false;
        });
        ticking = true;
    });
}

// ── Landing page newsletter signup ──────────────────────────────────────
const lpForm = document.getElementById('lp-newsletter-form');
const lpMsg  = document.getElementById('lp-newsletter-msg');

if (lpForm) {
    lpForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('lp-newsletter-email').value.trim();
        if (!email) return;

        const btn = lpForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Subscribing...';

        try {
            const res  = await fetch('/api/user?action=newsletter-subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, watchlist: [] })
            });
            const data = await res.json();

            if (data.userExists) {
                lpMsg.textContent = 'You already have an account - sign in to manage your subscription.';
                lpMsg.className = 'mt-4 text-sm font-semibold text-amber-600';
            } else {
                if (data.token) localStorage.setItem('token', data.token);
                lpMsg.textContent = 'You\'re in! Check your inbox for a welcome email.';
                lpMsg.className = 'mt-4 text-sm font-semibold text-green-600';
                lpForm.classList.add('hidden');
            }
            lpMsg.classList.remove('hidden');
        } catch {
            lpMsg.textContent = 'Something went wrong. Please try again.';
            lpMsg.className = 'mt-4 text-sm font-semibold text-red-500';
            lpMsg.classList.remove('hidden');
            btn.disabled = false;
            btn.textContent = 'Subscribe free';
        }
    });
}

// ── Scroll reveal ───────────────────────────────────────────────────────
const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            revealObserver.unobserve(entry.target);
        }
    });
}, { threshold: 0.12 });

document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
