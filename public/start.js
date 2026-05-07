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
