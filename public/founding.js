// founding.js - Auth-state detection and Stripe checkout for the /founding page

(async function () {
    // ── Helpers ────────────────────────────────────────────────────────────────
    function show(id) { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
    function hide(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }
    function el(id)   { return document.getElementById(id); }

    // ── Load live founding-member counter ──────────────────────────────────────
    async function loadCounter() {
        try {
            const res  = await fetch('/api/user?action=founding-stats');
            const data = await res.json();
            const text = el('counter-text');
            if (!text) return;

            const taken    = data.count  ?? 0;
            const limit    = data.limit  ?? 250;
            const days     = data.daysRemaining;
            const spotsLeft = limit - taken;

            let counterStr = `${taken} of ${limit} founding spots taken`;
            if (days !== null && days > 0) {
                counterStr += ` &bull; ${days} day${days === 1 ? '' : 's'} remaining`;
            } else if (days === 0) {
                counterStr = 'Founding window has closed.';
            }
            text.innerHTML = counterStr;
        } catch {
            const text = el('counter-text');
            if (text) text.textContent = 'Spots limited to 250.';
        }
    }

    // ── Checkout handler — shared between main and final CTA buttons ────────────
    async function startCheckout(btn) {
        if (!btn) return;
        const orig = btn.innerHTML;
        btn.disabled  = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Redirecting to checkout...';

        const token = localStorage.getItem('token');
        try {
            const res  = await fetch('/api/user?action=create-checkout-session', {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${token}`,
                },
            });
            const data = await res.json();
            if (res.ok && data.url) {
                window.location.href = data.url;
            } else {
                const msg = el('cta-checkout-msg');
                if (msg) { msg.textContent = data.error || 'Something went wrong. Please try again.'; msg.classList.remove('hidden'); }
                btn.disabled  = false;
                btn.innerHTML = orig;
            }
        } catch {
            const msg = el('cta-checkout-msg');
            if (msg) { msg.textContent = 'Network error. Please try again.'; msg.classList.remove('hidden'); }
            btn.disabled  = false;
            btn.innerHTML = orig;
        }
    }

    // ── Unauth CTA handler — store redirect and send to signup ─────────────────
    function handleUnauthClick() {
        sessionStorage.setItem('postAuthRedirect', '/founding');
        window.location.href = '/app?register=1';
    }

    // ── Apply the correct page state ───────────────────────────────────────────
    function applyState(state, subData) {
        // state: 'unauth' | 'free' | 'admin-pro' | 'founding'

        // Top banners
        if (state === 'founding')   show('state-founding');
        if (state === 'admin-pro')  show('state-pro-admin');

        // CTA sections in the offer block
        hide('cta-unauth'); hide('cta-free'); hide('cta-admin-pro'); hide('cta-is-founding');
        if (state === 'unauth')     show('cta-unauth');
        if (state === 'free')       show('cta-free');
        if (state === 'admin-pro')  show('cta-admin-pro');
        if (state === 'founding')   show('cta-is-founding');

        // Final CTA section
        hide('final-cta-unauth'); hide('final-cta-free'); hide('final-cta-other');
        if (state === 'unauth')     show('final-cta-unauth');
        if (state === 'free')       show('final-cta-free');
        if (state === 'admin-pro' || state === 'founding') show('final-cta-other');

        // Founding member: show subscription details in top banner
        if (state === 'founding' && subData?.subscriptionCurrentPeriodEnd) {
            const d   = new Date(subData.subscriptionCurrentPeriodEnd);
            const fmt = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
            const stateEl = el('state-founding');
            if (stateEl) {
                const span = stateEl.querySelector('span');
                if (span) span.innerHTML = `You're already a Founding Member - next billing date: <strong>${fmt}</strong>. <a href="/profile" class="font-semibold underline">View your subscription</a>.`;
            }
        }

        // Wire up buttons
        const unauthBtns   = [el('cta-unauth-btn'), el('final-cta-unauth-btn')];
        const checkoutBtns = [el('cta-checkout-btn'), el('final-cta-checkout-btn')];

        unauthBtns.forEach(btn => {
            if (btn) btn.addEventListener('click', handleUnauthClick);
        });
        checkoutBtns.forEach(btn => {
            if (btn) btn.addEventListener('click', () => startCheckout(btn));
        });
    }

    // ── Determine auth state ───────────────────────────────────────────────────
    async function detectState() {
        const token = localStorage.getItem('token');

        if (!token) {
            applyState('unauth', null);
            return;
        }

        // Basic client-side expiry check before hitting the API
        try {
            const payload  = JSON.parse(atob(token.split('.')[1]));
            const now      = Math.floor(Date.now() / 1000);
            if (payload.exp && payload.exp < now) {
                localStorage.removeItem('token');
                applyState('unauth', null);
                return;
            }
        } catch {
            applyState('unauth', null);
            return;
        }

        // Fetch subscription status
        try {
            const res  = await fetch('/api/user?action=subscription-status', {
                headers: { 'Authorization': `Bearer ${token}` },
            });

            if (!res.ok) {
                // Token invalid server-side
                applyState('unauth', null);
                return;
            }

            const data = await res.json();

            if (data.foundingMember) {
                applyState('founding', data);
            } else if (data.isPro) {
                applyState('admin-pro', data);
            } else {
                applyState('free', data);
            }
        } catch {
            // Network error — show unauth as safe fallback
            applyState('unauth', null);
        }
    }

    // ── Init ───────────────────────────────────────────────────────────────────
    await Promise.all([detectState(), loadCounter()]);
})();
