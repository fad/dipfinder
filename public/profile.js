// profile.js - Profile page functionality
window.initializeProfile = function(params) {
/*console.log('Initializing Profile page...');*/ 
    const BASE_URL = window.location.origin;
    let eventListeners = []; // To track event listeners for cleanup

    // Helper function for formatting dates consistently
    function formatDateWithMonthName(dateStr) {
        if (!dateStr) return '-';
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return '-'; // Invalid date
            
            const options = { 
                day: 'numeric', 
                month: 'long', 
                year: 'numeric' 
            };
            return date.toLocaleDateString(undefined, options);
        } catch (e) {
            console.error('Date formatting error:', e);
            return '-';
        }
    }

    // Tab switching logic
    function setupTabSwitching() {
        const tabs = ['profile', 'settings', 'subscribe'];

        tabs.forEach(tabName => {
            const tabButton = document.getElementById(`${tabName}-tab`);
            if (tabButton) {
                const handler = function() {
                    // Hide all content
                    tabs.forEach(t => {
                        const content = document.getElementById(`${t}-content-display`);
                        if (content) content.classList.add('hidden');
                    });

                    // Show selected content
                    const selectedContent = document.getElementById(`${tabName}-content-display`);
                    if (selectedContent) {
                        selectedContent.classList.remove('hidden');
                        selectedContent.style.opacity = 0;
                        selectedContent.style.transition = 'opacity 0.5s ease-in-out';
                        setTimeout(() => {
                            selectedContent.style.opacity = 1;
                        }, 300);
                    }

                    // Update tab styles
                    tabs.forEach(t => {
                        const tab = document.getElementById(`${t}-tab`);
                        if (tab) {
                            tab.classList.remove('gradient-btn');
                            tab.classList.add('bg-gray-300', 'text-gray-800');
                        }
                    });

                    // Activate selected tab
                    this.classList.add('gradient-btn');
                    this.classList.remove('bg-gray-300', 'text-gray-800');
                };
                tabButton.addEventListener('click', handler);
                eventListeners.push({ element: tabButton, type: 'click', handler });
            }
        });
    }

    // Load profile information
    async function loadProfileInfo() {
/*console.log('Starting loadProfileInfo...');*/ 

        // Wait for AuthManager to be available and initialized
        let retryCount = 0;
        const maxRetries = 50; // 5 seconds maximum wait
        
        while (!window.AuthManager && retryCount < maxRetries) {
/*console.log('Waiting for AuthManager...', retryCount);*/ 
            await new Promise(resolve => setTimeout(resolve, 100));
            retryCount++;
        }

        if (!window.AuthManager) {
            console.error('AuthManager not available after waiting');
            const el = document.getElementById('profile-page-email');
            if (el) el.textContent = 'Auth system error.';
            return;
        }

        // Ensure AuthManager has completed its initialization
        await window.AuthManager.checkAuthStatus();

        if (!window.AuthManager.isAuthenticated || !window.AuthManager.currentUser) {
/*console.log('User not authenticated, redirecting to home.');*/
            const emailEl = document.getElementById('profile-page-email');
            const sinceEl = document.getElementById('profile-member-since');
            if (emailEl) emailEl.textContent = 'Not logged in';
            if (sinceEl) sinceEl.textContent = '-';
            setTimeout(() => { if (window.router) window.router.navigateTo('/'); }, 1500);
            return;
        }

        const user = window.AuthManager.currentUser;
        if (user && user.email) {
            const emailEl = document.getElementById('profile-page-email');
            if (emailEl) emailEl.textContent = user.email;
            const dropdownEmail = document.getElementById('dropdown-profile-email');
            if (dropdownEmail) dropdownEmail.textContent = user.email;
        }

        const token = window.AuthManager.token;
        if (token) {
            try {
                const res = await fetch(`${BASE_URL}/api/user?action=profile`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                const data = await res.json();
                const sinceEl = document.getElementById('profile-member-since');
                if (res.ok) {
                    const emailEl = document.getElementById('profile-page-email');
                    if (emailEl) emailEl.textContent = data.email || user.email || '-';
                    const dropdownEmail = document.getElementById('dropdown-profile-email');
                    if (dropdownEmail) dropdownEmail.textContent = data.email || user.email || '-';
                    if (sinceEl) sinceEl.textContent = data.createdDate ? formatDateWithMonthName(data.createdDate) : '-';
                    const tzSel = document.getElementById('timezone-select');
                    if (tzSel && data.timezone) {
                        const match = TIMEZONES.find(t => t.value === data.timezone);
                        if (match) tzSel.value = data.timezone;
                    }
                } else {
                    console.error('Profile API error:', data);
                    if (sinceEl) sinceEl.textContent = 'Error loading date';
                }
            } catch (e) {
                console.error('Profile loading error:', e);
                const sinceEl = document.getElementById('profile-member-since');
                if (sinceEl) sinceEl.textContent = 'Error loading date';
            }
        }
    }

    // Setup password change functionality
    function setupPasswordChange() {
        const changePasswordBtn = document.getElementById('change-password-btn');
        if (changePasswordBtn) {
            changePasswordBtn.addEventListener('click', handlePasswordChange);
            eventListeners.push({ element: changePasswordBtn, type: 'click', handler: handlePasswordChange });
        }
    }

    // Handle password change
    async function handlePasswordChange() {
        const currentPassword = document.getElementById('current-password');
        const newPassword = document.getElementById('new-password');
        const confirmPassword = document.getElementById('confirm-password');
        const messageDiv = document.getElementById('password-change-message');
        const submitBtn = document.getElementById('change-password-btn');

        // Clear previous messages
        messageDiv.innerHTML = '';
        messageDiv.className = 'mt-4 p-3 rounded-md';

        // Validation
        if (!currentPassword.value || !newPassword.value || !confirmPassword.value) {
            showMessage(messageDiv, 'Please fill in all fields.', 'error');
            return;
        }

        if (newPassword.value !== confirmPassword.value) {
            showMessage(messageDiv, 'New passwords do not match.', 'error');
            return;
        }

        if (newPassword.value.length < 8) {
            showMessage(messageDiv, 'New password must be at least 8 characters long.', 'error');
            return;
        }

        if (!isStrongPassword(newPassword.value)) {
            showMessage(messageDiv, 'Password must contain uppercase, lowercase, and number.', 'error');
            return;
        }

        // Disable button and show loading
        submitBtn.disabled = true;
        submitBtn.textContent = 'Changing...';

        try {
            const token = window.AuthManager?.token;
            if (!token) {
                showMessage(messageDiv, 'Authentication error. Please log in again.', 'error');
                return;
            }

            const res = await fetch(`${BASE_URL}/api/user?action=change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({
                    currentPassword: currentPassword.value,
                    newPassword: newPassword.value
                })
            });

            const data = await res.json();

            if (res.ok) {
                showMessage(messageDiv, 'Password changed successfully!', 'success');
                // Clear fields
                currentPassword.value = '';
                newPassword.value = '';
                confirmPassword.value = '';
            } else {
                showMessage(messageDiv, data.message || 'An error occurred.', 'error');
            }
        } catch (error) {
            console.error('Password change error:', error);
            showMessage(messageDiv, 'An unexpected error occurred.', 'error');
        } finally {
            // Re-enable button
            submitBtn.disabled = false;
            submitBtn.textContent = 'Change Password';
        }
    }

    // Setup email preferences functionality
    function setupEmailPreferences() {
        const savePreferencesBtn = document.getElementById('save-email-preferences-btn');
        if (savePreferencesBtn) {
            const handler = handleEmailPreferencesChange;
            savePreferencesBtn.addEventListener('click', handler);
            eventListeners.push({ element: savePreferencesBtn, type: 'click', handler });
        }
    }

    // Setup email change functionality
    function setupEmailChange() {
        const saveEmailBtn = document.getElementById('save-email-btn');
        if (saveEmailBtn) {
            const handler = handleEmailChange;
            saveEmailBtn.addEventListener('click', handler);
            eventListeners.push({ element: saveEmailBtn, type: 'click', handler });
        }
    }

    // Handle email address change
    async function handleEmailChange() {
        const emailInput = document.getElementById('settings-email');
        const messageDiv = document.getElementById('email-change-message');
        const submitBtn = document.getElementById('save-email-btn');

        const newEmail = emailInput?.value.trim();
        if (!newEmail) {
            showMessage(messageDiv, 'Please enter an email address.', 'error');
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
            showMessage(messageDiv, 'Please enter a valid email address.', 'error');
            return;
        }

        const token = window.AuthManager?.token || localStorage.getItem('token');
        if (!token) {
            showMessage(messageDiv, 'Authentication required. Please log in again.', 'error');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
        messageDiv.innerHTML = '';

        try {
            const res = await fetch(`${BASE_URL}/api/user?action=update-email-preferences`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ email: newEmail })
            });
            const data = await res.json();
            if (res.ok) {
                showMessage(messageDiv, 'Email address updated successfully!', 'success');
            } else {
                showMessage(messageDiv, data.error || 'Failed to update email. Please try again.', 'error');
            }
        } catch (e) {
            console.error('Email change error:', e);
            showMessage(messageDiv, 'Network error. Please try again.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Update Email';
        }
    }

    // Load email preferences
    async function loadEmailPreferences() {
        // Wait for AuthManager to be available
        let retryCount = 0;
        const maxRetries = 50;

        while (!window.AuthManager && retryCount < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 100));
            retryCount++;
        }

        const token = window.AuthManager?.token || localStorage.getItem('token');
        if (!token) {
            console.log('No token available for loading email preferences');
            return;
        }

        try {
            const res = await fetch(`${BASE_URL}/api/user?action=profile`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await res.json();

            if (res.ok) {
                const emailInput = document.getElementById('settings-email');
                if (emailInput && data.email) emailInput.value = data.email;

                const newsletterCheckbox = document.getElementById('newsletter-subscription');
                if (newsletterCheckbox) newsletterCheckbox.checked = data.newsletterSubscribed || false;

                const sundayBriefCheckbox = document.getElementById('sunday-brief-subscription');
                if (sundayBriefCheckbox) sundayBriefCheckbox.checked = data.sundayBriefSubscribed || false;
            } else {
                console.error('Failed to load profile data:', data);
            }
        } catch (e) {
            console.error('Error loading email preferences:', e);
        }
    }

    // Handle email preferences change
    async function handleEmailPreferencesChange() {
        const newsletterCheckbox = document.getElementById('newsletter-subscription');
        const messageDiv = document.getElementById('email-preferences-message');
        const submitBtn = document.getElementById('save-email-preferences-btn');

        const token = window.AuthManager?.token || localStorage.getItem('token');
        if (!token) {
            showMessage(messageDiv, 'Authentication required. Please log in again.', 'error');
            return;
        }

        // Show loading state
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
        messageDiv.innerHTML = '';

        try {
            const sundayBriefCheckbox = document.getElementById('sunday-brief-subscription');
            const res = await fetch(`${BASE_URL}/api/user?action=update-email-preferences`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    newsletterSubscribed: newsletterCheckbox ? newsletterCheckbox.checked : undefined,
                    sundayBriefSubscribed: sundayBriefCheckbox ? sundayBriefCheckbox.checked : undefined
                })
            });

            const data = await res.json();

            if (res.ok) {
                showMessage(messageDiv, 'Email preferences updated successfully!', 'success');
            } else {
                showMessage(messageDiv, data.error || 'Failed to update preferences. Please try again.', 'error');
            }
        } catch (e) {
            console.error('Email preferences update error:', e);
            showMessage(messageDiv, 'Network error. Please try again.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Preferences';
        }
    }

    function showMessage(element, message, type) {
        element.textContent = message;
        if (type === 'success') {
            element.className = 'mt-4 p-3 rounded-md bg-green-100 text-green-800';
        } else {
            element.className = 'mt-4 p-3 rounded-md bg-red-100 text-red-800';
        }
    }

    function isStrongPassword(password) {
        const hasUppercase = /[A-Z]/.test(password);
        const hasLowercase = /[a-z]/.test(password);
        const hasNumber = /[0-9]/.test(password);
        return hasUppercase && hasLowercase && hasNumber;
    }

    // Only zones that land in the 6-10am window on one of the 3 Sunday crons:
    //   Sat 23:00 UTC → Asia/Pacific  (UTC+8 = 7am, UTC+9 = 8am, UTC+10/+11 = 9/10am)
    //   Sun 07:00 UTC → Europe/Africa (UTC+0 = 7am, UTC+1 = 8am, UTC+2 = 9am, UTC+3 = 10am)
    //   Sun 14:00 UTC → Americas      (UTC-8 = 6am, UTC-7 = 7am, UTC-6 = 8am, UTC-5 = 9am, UTC-4 = 10am)
    const TIMEZONES = [
        { value: 'America/Los_Angeles',  label: 'Pacific Time (US)' },
        { value: 'America/Denver',       label: 'Mountain Time (US)' },
        { value: 'America/Phoenix',      label: 'Arizona (no DST)' },
        { value: 'America/Chicago',      label: 'Central Time (US)' },
        { value: 'America/New_York',     label: 'Eastern Time (US)' },
        { value: 'UTC',                  label: 'UTC' },
        { value: 'Europe/London',        label: 'London' },
        { value: 'Europe/Paris',         label: 'Paris, Berlin, Rome' },
        { value: 'Europe/Athens',        label: 'Athens, Helsinki' },
        { value: 'Europe/Moscow',        label: 'Moscow' },
        { value: 'Asia/Singapore',       label: 'Singapore, Hong Kong' },
        { value: 'Asia/Shanghai',        label: 'Beijing, Shanghai' },
        { value: 'Asia/Tokyo',           label: 'Tokyo, Seoul' },
        { value: 'Australia/Sydney',     label: 'Sydney' },
    ];

    // ── Subscription tab ──────────────────────────────────────────────────────
    async function loadSubscriptionInfo() {
        const token = window.AuthManager?.token || localStorage.getItem('token');
        if (!token) return;

        try {
            const res  = await fetch(`${BASE_URL}/api/user?action=subscription-status`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) { console.warn('subscription-status non-ok:', res.status); return; }
            const data = await res.json();
            console.log('subscription-status response:', data);

            const el = id => document.getElementById(id);
            el('sub-loading')?.classList.add('hidden');

            if (data.foundingMember) {
                // Founding member — active or canceled
                el('sub-founding')?.classList.remove('hidden');

                const canceled = data.subscriptionStatus === 'canceled';
                const pill = el('sub-status-pill');
                if (pill) {
                    pill.textContent = canceled ? 'Canceled' : 'Active';
                    pill.className   = canceled
                        ? 'inline-block rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700'
                        : 'inline-block rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700';
                }

                const periodEndEl = el('sub-period-end');
                if (periodEndEl && data.subscriptionCurrentPeriodEnd) {
                    const d = new Date(data.subscriptionCurrentPeriodEnd);
                    periodEndEl.textContent = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
                }

                if (canceled) {
                    el('sub-portal-wrap')?.classList.add('hidden');
                    el('sub-canceled-resubscribe')?.classList.remove('hidden');
                } else if (data.hasStripeSubscription) {
                    const manageBtn = el('sub-manage-btn');
                    if (manageBtn) {
                        manageBtn.addEventListener('click', async () => {
                            manageBtn.disabled   = true;
                            manageBtn.textContent = 'Opening...';
                            try {
                                const r = await fetch(`${BASE_URL}/api/user?action=create-portal-session`, {
                                    method:  'POST',
                                    headers: { Authorization: `Bearer ${token}` }
                                });
                                const d = await r.json();
                                if (r.ok && d.url) {
                                    window.location.href = d.url;
                                } else {
                                    const msg = el('sub-manage-msg');
                                    if (msg) { msg.textContent = d.error || 'Could not open portal. Try again.'; msg.classList.remove('hidden'); }
                                    manageBtn.disabled   = false;
                                    manageBtn.textContent = 'Manage subscription';
                                }
                            } catch {
                                manageBtn.disabled   = false;
                                manageBtn.textContent = 'Manage subscription';
                            }
                        });
                        eventListeners.push({ element: manageBtn, type: 'click', handler: null }); // cleaned by destroyProfile
                    }
                } else {
                    el('sub-portal-wrap')?.classList.add('hidden');
                }

            } else if (data.isPro) {
                // Admin-granted Pro
                el('sub-pro-admin')?.classList.remove('hidden');
            } else {
                // Free
                el('sub-free')?.classList.remove('hidden');
            }
        } catch (e) {
            console.error('loadSubscriptionInfo error:', e);
            document.getElementById('sub-loading')?.classList.add('hidden');
            document.getElementById('sub-free')?.classList.remove('hidden');
        }
    }

    // Show ?upgraded=1 banner and auto-navigate to Subscription tab
    const upgraded = params instanceof URLSearchParams ? params.get('upgraded') : null;
    if (upgraded === '1') {
        // Strip param from URL without page reload
        const cleanUrl = window.location.pathname;
        history.replaceState(null, '', cleanUrl);

        // Switch to Subscription tab after DOM settles
        setTimeout(() => {
            const subTab = document.getElementById('subscribe-tab');
            if (subTab) subTab.click();
            const banner = document.getElementById('upgraded-banner');
            if (banner) banner.classList.remove('hidden');
        }, 100);
    }

    // Initial setup for the profile page
    setupTabSwitching();
    initTimezoneSelect(null);
    loadProfileInfo();
    setupPasswordChange();
    setupEmailChange();
    setupEmailPreferences();
    loadEmailPreferences();
    loadSubscriptionInfo();

    function initTimezoneSelect(currentTz) {
        const sel = document.getElementById('timezone-select');
        if (!sel) return;
        sel.innerHTML = TIMEZONES.map(tz =>
            `<option value="${tz.value}">${tz.label}</option>`
        ).join('');
        // Select the matching option, or first entry if not in the list
        const match = currentTz && TIMEZONES.find(t => t.value === currentTz);
        sel.value = match ? currentTz : TIMEZONES[0].value;
    }

    window.saveTimezone = async function() {
        const sel = document.getElementById('timezone-select');
        const btn = document.getElementById('save-timezone-btn');
        const msg = document.getElementById('timezone-save-msg');
        if (!sel) return;

        let tz = sel.value;

        if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
        try {
            const token = window.AuthManager?.token;
            const res = await fetch(`${BASE_URL}/api/user?action=update-profile`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ timezone: tz }),
            });
            if (res.ok) {
                if (msg) { msg.textContent = `Saved: ${tz}`; msg.classList.remove('hidden'); }
                if (btn) { btn.textContent = 'Saved'; setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; if (msg) msg.classList.add('hidden'); }, 2000); }
            } else {
                if (msg) { msg.textContent = 'Save failed - please try again.'; msg.classList.remove('hidden'); }
                if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
            }
        } catch {
            if (msg) { msg.textContent = 'Save failed - please try again.'; msg.classList.remove('hidden'); }
            if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
        }
    };

    // Cleanup function
    window.destroyProfile = function() {
/*console.log("Destroying Profile page...");*/ 
        eventListeners.forEach(listener => {
            listener.element.removeEventListener(listener.type, listener.handler);
        });
        eventListeners = [];
    };
};
