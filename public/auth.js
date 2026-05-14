// auth.js - Centralized Authentication Management
// This file handles all authentication-related functionality across the app

const AuthManager = (function() {
    // For development, use local origin. For production, use the deployed backend.
    const BASE_URL = window.location.origin;
    
    // Authentication state management
    let currentUser = null;
    let isAuthenticated = false;

    // Pending deep-link form to open after auth check (read synchronously from URL params)
    let _pendingInitForm  = null; // 'login' | 'register' | null
    let _pendingInitEmail = '';

    // Initialize authentication on page load
    function init() {
        // Read deep-link params synchronously so we can open the right form immediately
        // after the auth check completes — no setTimeout flash.
        const _urlParams = new URLSearchParams(window.location.search);
        if (_urlParams.get('register') === '1') {
            _pendingInitForm  = 'register';
            _pendingInitEmail = decodeURIComponent(_urlParams.get('email') || '');
        } else if (_urlParams.get('signin') === '1') {
            _pendingInitForm = 'login';
        }
        if (_pendingInitForm) {
            const _cp = new URLSearchParams(_urlParams);
            _cp.delete('register'); _cp.delete('signin'); _cp.delete('email');
            const _qs = _cp.toString();
            history.replaceState(null, '', _qs ? `?${_qs}` : window.location.pathname);
        }

        // Pre-check authentication state to minimize flicker
        const token = localStorage.getItem("token");
        const lastAuthState = localStorage.getItem("lastAuthState");
        
        // If we have cached state, apply it immediately to minimize flicker
        if (lastAuthState) {
            try {
                const cachedState = JSON.parse(lastAuthState);
                if (cachedState.isAuthenticated && cachedState.user) {
                    showLoggedInUI(cachedState.user);
                    currentUser = cachedState.user;
                    isAuthenticated = true;
                } else {
                    showGuestUI();
                    currentUser = null;
                    isAuthenticated = false;
                }
            } catch (e) {
/*console.log("Invalid cached auth state, clearing");*/ 
                localStorage.removeItem("lastAuthState");
                showGuestUI();
            }
        }
        
        // Then run the full auth check
        checkAuthStatus();
    }
    
    // Open the auth modal to the right form based on _pendingInitForm (no setTimeout flash)
    function openModalWithInitialForm() {
        const modal = document.getElementById('auth-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        if (_pendingInitForm === 'login') {
            showLoginForm();
        } else {
            showRegisterForm();
            if (_pendingInitEmail) {
                const emailInput = document.getElementById('register-email');
                if (emailInput) {
                    emailInput.value = _pendingInitEmail;
                    emailInput.style.borderColor = '#10b981';
                }
                _pendingInitEmail = '';
            }
        }
        _pendingInitForm = null;
    }

    // Enhanced authentication check with fast client-side validation and instant UI
    async function checkAuthStatus() {
        const token = localStorage.getItem("token");
        const lastAuthState = localStorage.getItem("lastAuthState");
        
/*console.log("Checking auth status, token exists:", !!token, "last state:", lastAuthState);*/ 
        
        if (!token) {
/*console.log("No token found, confirming guest UI");*/
            localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));
            showGuestUI();
            updateGlobalAuthState(false, null);
            // App requires login — open auth modal to the appropriate form
            if (window.location.pathname.startsWith('/app') || window.location.pathname.startsWith('/screener') || window.location.pathname.startsWith('/profile')) {
                openModalWithInitialForm();
            }
            return false;
        }

        // Fast client-side token validation (check if expired)
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            const currentTime = Math.floor(Date.now() / 1000);
            
            if (payload.exp && payload.exp < currentTime) {
/*console.log("Token expired, clearing and showing guest UI");*/
                localStorage.removeItem("token");
                localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));
                showGuestUI();
                updateGlobalAuthState(false, null);
                if (window.location.pathname.startsWith('/app') || window.location.pathname.startsWith('/screener') || window.location.pathname.startsWith('/profile')) {
                    openModalWithInitialForm();
                }
                return false;
            }
            
            // Token seems valid, show logged-in UI immediately with cached user info
            if (payload.email) {
                // Carry isPro forward from the last server-verified state so IS_PRO is
                // correct before initializeDipfinder() runs (JWT payload doesn't include it)
                let cachedIsPro = false;
                try {
                    const prev = lastAuthState ? JSON.parse(lastAuthState) : null;
                    if (prev?.isAuthenticated && prev.user?.isPro) cachedIsPro = true;
                } catch (e) {}

                const userData = {
                    email: payload.email,
                    name: payload.name || payload.email.split('@')[0],
                    isPro: cachedIsPro,
                };

                // Cache the authenticated state
                localStorage.setItem("lastAuthState", JSON.stringify({
                    isAuthenticated: true,
                    user: userData
                }));

                showLoggedInUI(userData);
                updateGlobalAuthState(true, userData);
                
                // Then verify with server in background (don't await, let it run async)
                verifyTokenWithServer(token);
                return true;
            }
        } catch (e) {
/*console.log("Token format invalid, clearing and showing guest UI");*/ 
            localStorage.removeItem("token");
            localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));
            showGuestUI();
            updateGlobalAuthState(false, null);
            return false;
        }

        // Fallback to server validation if client-side validation fails
        return await verifyTokenWithServer(token);
    }
    
    // Background server verification (doesn't block UI)
    async function verifyTokenWithServer(token) {
        try {
            const res = await fetch(`${BASE_URL}/api/user?action=verify-token`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            
/*console.log("Server token verification response:", res.status, data);*/ 
            
            if (res.ok && data.valid) {
/*console.log("Server confirmed token valid");*/
                const userData = data.user;

                // Update cached state with fresh server data
                localStorage.setItem("lastAuthState", JSON.stringify({
                    isAuthenticated: true,
                    user: userData
                }));

                showLoggedInUI(userData);
                updateGlobalAuthState(true, userData);
                restoreWatchlistFromDb();
                return true;
            } else {
/*console.log("Server says token invalid, clearing and showing guest UI");*/ 
                localStorage.removeItem("token");
                localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));
                showGuestUI();
                updateGlobalAuthState(false, null);
                return false;
            }
        } catch (error) {
            console.error("Server auth check failed:", error);
            // Don't change UI or cached state on network error, keep current state
            return false;
        }
    }
    
    // Update global authentication state
    function updateGlobalAuthState(authenticated, user) {
        isAuthenticated = authenticated;
        currentUser = user;

        const isPro = authenticated && !!(user && user.isPro);
        window.IS_PRO = isPro;

        // Update MAX_STOCKS
        if (typeof window.MAX_STOCKS !== 'undefined') {
            window.MAX_STOCKS = isPro ? 50 : 10;
        }

        // Update stock limit message if it exists
        const stockLimitMessage = document.getElementById("stock-limit-message");
        if (stockLimitMessage) {
            stockLimitMessage.textContent = isPro
                ? "You can have up to 50 stocks per watchlist."
                : "You can only have up to 10 stocks.";
        }
    }
    
    // Show guest UI state
    function showGuestUI() {
        // Hide loading state
        const authLoading = document.getElementById("auth-loading");
        if (authLoading) authLoading.classList.add("hidden");

        // Show login button
        const authButton = document.getElementById("auth-button");
        if (authButton) authButton.classList.remove("hidden");

        // Hide profile dropdown
        const profileDropdown = document.getElementById("profile-dropdown");
        if (profileDropdown) profileDropdown.classList.add("hidden");

        const profileMenu = document.getElementById("profile-menu");
        if (profileMenu) profileMenu.classList.add("hidden");

        updateGlobalAuthState(false, null);
    }
    
    // Show logged-in UI state
    function showLoggedInUI(user) {
        // Hide loading state
        const authLoading = document.getElementById("auth-loading");
        if (authLoading) authLoading.classList.add("hidden");
        
        // Hide login button
        const authButton = document.getElementById("auth-button");
        if (authButton) authButton.classList.add("hidden");

        // Show profile dropdown
        const profileDropdown = document.getElementById("profile-dropdown");
        if (profileDropdown) profileDropdown.classList.remove("hidden");
        
        const profileEmail = document.getElementById("profile-email");
        if (profileEmail) profileEmail.innerText = user.email;
        
        updateGlobalAuthState(true, user);
    }
    
    // Handle Login
    async function login() {
        const email = document.getElementById("login-email").value;
        const password = document.getElementById("login-password").value;
        
        // Get Turnstile response
        let captchaResponse = null;
        if (typeof turnstile !== 'undefined') {
            captchaResponse = turnstile.getResponse();
/*console.log('Frontend Debug: Turnstile response:', captchaResponse ? captchaResponse.substring(0, 20) + '...' : 'null');*/ 
        } else {
/*console.log('Frontend Debug: Turnstile not loaded');*/ 
        }
        
        if (!captchaResponse) {
            showAuthError("Please complete the CAPTCHA verification");
            return;
        }
        
        const loginBtn = document.getElementById("login-btn");
        loginBtn.disabled = true;
        loginBtn.textContent = "Logging in...";
        
        try {
            const res = await fetch(`${BASE_URL}/api/user?action=login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password, captchaToken: captchaResponse }),
            });
            const data = await res.json();
            
            if (res.ok) {
                localStorage.setItem("token", data.token);
                
                // Cache the authenticated state immediately for faster UI next time
                const userData = data.user || { email: email, name: email.split('@')[0] };
                localStorage.setItem("lastAuthState", JSON.stringify({ 
                    isAuthenticated: true, 
                    user: userData 
                }));
                
                showAuthSuccess("Login successful!");
                setTimeout(() => {
                    closeAuthModal();
                    showLoggedInUI(userData);
                    restoreWatchlistFromDb();
                    // Handle postAuthRedirect (e.g. set by /founding page for unauthenticated visitors)
                    const redirect = sessionStorage.getItem('postAuthRedirect');
                    if (redirect) { sessionStorage.removeItem('postAuthRedirect'); window.location.href = redirect; }
                }, 800);
            } else {
                showAuthError(data.error || data.msg || "Login failed. Please try again.");
            }
        } catch (e) {
            showAuthError("Network error. Please try again.");
        } finally {
            loginBtn.disabled = false;
            loginBtn.textContent = "Login";
        }
    }
    
    // Handle Registration
    async function register() {
        const rawEmail = document.getElementById("register-email").value;
        const rawPassword = document.getElementById("register-password").value;
        const termsAccepted = document.getElementById("register-terms").checked;
        const newsletterSubscribed = document.getElementById("register-newsletter").checked;
        const sundayBriefSubscribed = document.getElementById("register-sunday-brief").checked;
        
        // Sanitize inputs (but keep password as-is for security reasons)
        const email = sanitizeInput(rawEmail);
        const password = rawPassword; // Don't sanitize password as it might contain special chars
        
        // Comprehensive input validation
        const validationError = validateRegistrationInputs(email, password, termsAccepted);
        if (validationError) {
            showAuthError(validationError);
            return;
        }
        
        // Get Turnstile response
        let captchaResponse = null;
        if (typeof turnstile !== 'undefined') {
            captchaResponse = turnstile.getResponse();
        }
        
        if (!captchaResponse) {
            showAuthError("Please complete the CAPTCHA verification");
            return;
        }
        
        const regBtn = document.getElementById("register-btn");
        regBtn.disabled = true;
        regBtn.textContent = "Registering...";
        
        // Read current localStorage watchlist to seed the new account
        let localWatchlist = [];
        try {
            const stored = localStorage.getItem('stocks');
            if (stored) localWatchlist = JSON.parse(stored);
        } catch { /* ignore */ }

        try {
            const res = await fetch(`${BASE_URL}/api/user?action=register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email,
                    password,
                    captchaToken: captchaResponse,
                    termsAccepted,
                    newsletterSubscribed,
                    sundayBriefSubscribed,
                    watchlist: localWatchlist,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                }),
            });
            const data = await res.json();

            if (res.ok) {
                if (data.token) {
                    // New account created — sign in immediately
                    localStorage.setItem("token", data.token);
                    const userData = data.user || { email: email, name: email.split('@')[0] };
                    localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: true, user: userData }));
                    showAuthSuccess("Welcome! Your account has been created.");
                    setTimeout(() => {
                        closeAuthModal();
                        showLoggedInUI(userData);

                        // Apply pending share watchlist (from /share/:token subscribe banner)
                        const pendingShare = sessionStorage.getItem('pendingShareWatchlist');
                        if (pendingShare) {
                            sessionStorage.removeItem('pendingShareWatchlist');
                            try {
                                const { stocks, smaPeriod } = JSON.parse(pendingShare);
                                const tok = localStorage.getItem('token');
                                if (tok && Array.isArray(stocks) && stocks.length) {
                                    fetch('/api/watchlist', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}` },
                                        body: JSON.stringify({ action: 'save-primary', stocks, smaPeriod }),
                                    }).then(() => restoreWatchlistFromDb()).catch(() => restoreWatchlistFromDb());
                                } else {
                                    restoreWatchlistFromDb();
                                }
                            } catch { restoreWatchlistFromDb(); }
                        } else {
                            restoreWatchlistFromDb();
                        }

                        // Handle postAuthRedirect (e.g. set by /founding page for unauthenticated visitors)
                        const redirect = sessionStorage.getItem('postAuthRedirect');
                        if (redirect) { sessionStorage.removeItem('postAuthRedirect'); window.location.href = redirect; }
                    }, 800);
                } else {
                    // Existing email — notify but don't reveal account existence
                    showAuthSuccess(data.message || "If this email is not yet registered, check your inbox to complete sign-up.");
                }
            } else {
                showAuthError(data.error || data.msg || "Registration failed. Please try again.");
            }
        } catch (e) {
            showAuthError("Network error. Please try again.");
        } finally {
            regBtn.disabled = false;
            regBtn.textContent = "Register";
        }
    }
    
    // Handle Forgot Password
    async function forgotPassword() {
        // Get Turnstile response
        let captchaResponse = null;
        if (typeof turnstile !== 'undefined') {
            captchaResponse = turnstile.getResponse();
        }
        
        if (!captchaResponse) {
            showAuthError("Please complete the CAPTCHA verification");
            return;
        }
        
        const email = document.getElementById("forgot-email").value;
        const btn = document.getElementById("forgot-btn");
        btn.disabled = true;
        btn.textContent = "Sending...";
        
        try {
            const res = await fetch(`${BASE_URL}/api/user?action=forgot-password`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, captchaToken: captchaResponse }),
            });
            const data = await res.json();
            
            if (res.ok) {
                showAuthSuccess(data.msg || "Password reset email sent!");
                document.getElementById("forgot-form").classList.add("hidden");
                document.getElementById("forgot-ok-btn").classList.remove("hidden");
            } else {
                showAuthError(data.error || data.msg || "Failed to send reset email.");
            }
        } catch (e) {
            showAuthError("Network error. Please try again.");
        } finally {
            btn.disabled = false;
            btn.textContent = "Send Reset Link";
        }
    }
    
    // Restore watchlist from DB after login and dispatch event so dipfinder.js refreshes
    async function restoreWatchlistFromDb() {
        try {
            const token = localStorage.getItem("token");
            if (!token) return;
            const res = await fetch(`${BASE_URL}/api/watchlist`, {
                headers: { "Authorization": `Bearer ${token}` }
            });
            if (!res.ok) return;
            const data = await res.json();
            // Update isPro from watchlist response
            if (data.isPro !== undefined) {
                window.IS_PRO = !!data.isPro;
                window.MAX_STOCKS = data.isPro ? 50 : 10;
            }
            if (Array.isArray(data.stocks) && data.stocks.length > 0) {
                localStorage.setItem("stocks", JSON.stringify(data.stocks));
            }
            window.dispatchEvent(new CustomEvent("dipfinder:watchlistRestored", {
                detail: {
                    stocks: data.stocks || [],
                    isPro: !!data.isPro,
                    primaryWatchlistName: data.primaryWatchlistName || 'Main',
                    primaryWatchlistNotes: data.primaryWatchlistNotes || '',
                    namedWatchlists: data.namedWatchlists || [],
                    activeWatchlistId: data.activeWatchlistId || 'primary',
                }
            }));
        } catch (e) { /* silent — local stocks remain */ }
    }

    // Logout
    function logout() {
        localStorage.removeItem("token");
        localStorage.removeItem("stocks");
        localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));

        // Close profile menu if open
        const profileMenu = document.getElementById("profile-menu");
        if (profileMenu) profileMenu.classList.add("hidden");

        // Redirect to landing page — app requires login
        window.location.replace('/');
    }
    
    // UI Helper Functions
    function showAuthError(message) {
        const errorDiv = document.getElementById("auth-error");
        const errorText = document.getElementById("auth-error-text");
        const successDiv = document.getElementById("auth-success");
        
        if (message) {
            if (errorText) errorText.textContent = message;
            if (errorDiv) errorDiv.classList.remove("hidden");
        } else {
            if (errorDiv) errorDiv.classList.add("hidden");
        }
        
        if (successDiv) successDiv.classList.add("hidden");
    }
    
    function showAuthSuccess(message) {
        const errorDiv = document.getElementById("auth-error");
        const successDiv = document.getElementById("auth-success");
        const successText = document.getElementById("auth-success-text");
        
        if (message) {
            if (successText) successText.textContent = message;
            if (successDiv) successDiv.classList.remove("hidden");
        } else {
            if (successDiv) successDiv.classList.add("hidden");
        }
        
        if (errorDiv) errorDiv.classList.add("hidden");
    }
    
    function closeAuthModal() {
        const modal = document.getElementById("auth-modal");
        if (modal) modal.classList.add("hidden");
        resetAuthForms();
    }
    
    function resetAuthForms() {
        document.getElementById("login-form").classList.add("hidden");
        document.getElementById("register-form").classList.add("hidden");
        document.getElementById("forgot-form").classList.add("hidden");
        document.getElementById("forgot-ok-btn").classList.add("hidden");
        document.getElementById("magic-form").classList.add("hidden");
        document.getElementById("magic-ok").classList.add("hidden");
        document.getElementById("captcha-container").classList.add("hidden");
        
        // Reset registration checkboxes
        const termsCheckbox = document.getElementById("register-terms");
        const newsletterCheckbox = document.getElementById("register-newsletter");
        const sundayBriefCheckbox = document.getElementById("register-sunday-brief");
        if (termsCheckbox) termsCheckbox.checked = false;
        if (newsletterCheckbox) newsletterCheckbox.checked = false;
        if (sundayBriefCheckbox) sundayBriefCheckbox.checked = true;
        
        showAuthError("");
        showAuthSuccess("");
        
        // Reset Turnstile widget
        if (typeof turnstile !== 'undefined') {
            try {
                turnstile.reset();
            } catch (e) {
/*console.log("Turnstile reset error:", e);*/ 
            }
        }
    }
    
    function showLoginForm() {
        resetAuthForms();
        document.getElementById("login-form").classList.remove("hidden");
        
        // Position CAPTCHA before the login button
        const captchaContainer = document.getElementById("captcha-container");
        const loginBtn = document.getElementById("login-btn");
        if (captchaContainer && loginBtn) {
            loginBtn.parentNode.insertBefore(captchaContainer, loginBtn);
            captchaContainer.classList.remove("hidden");
            if (window.TurnstileConfig) window.TurnstileConfig.ensureLoaded();
        }
    }
    
    function showRegisterForm() {
        resetAuthForms();
        document.getElementById("register-form").classList.remove("hidden");
        
        // Position CAPTCHA before the register button
        const captchaContainer = document.getElementById("captcha-container");
        const registerBtn = document.getElementById("register-btn");
        if (captchaContainer && registerBtn) {
            registerBtn.parentNode.insertBefore(captchaContainer, registerBtn);
            captchaContainer.classList.remove("hidden");
            if (window.TurnstileConfig) window.TurnstileConfig.ensureLoaded();
        }
        
        // Setup real-time validation
        setTimeout(setupRegistrationValidation, 100); // Small delay to ensure DOM is ready
    }
    
    function showForgotForm() {
        resetAuthForms();
        document.getElementById("forgot-form").classList.remove("hidden");

        // Position CAPTCHA before the forgot button
        const captchaContainer = document.getElementById("captcha-container");
        const forgotBtn = document.getElementById("forgot-btn");
        if (captchaContainer && forgotBtn) {
            forgotBtn.parentNode.insertBefore(captchaContainer, forgotBtn);
            captchaContainer.classList.remove("hidden");
            if (window.TurnstileConfig) window.TurnstileConfig.ensureLoaded();
        }
    }

    function showMagicForm() {
        resetAuthForms();
        document.getElementById("magic-form").classList.remove("hidden");

        // Position CAPTCHA before the magic button
        const captchaContainer = document.getElementById("captcha-container");
        const magicBtn = document.getElementById("magic-btn");
        if (captchaContainer && magicBtn) {
            magicBtn.parentNode.insertBefore(captchaContainer, magicBtn);
            captchaContainer.classList.remove("hidden");
            if (window.TurnstileConfig) window.TurnstileConfig.ensureLoaded();
        }
    }

    async function requestMagicLink() {
        let captchaResponse = null;
        if (typeof turnstile !== 'undefined') {
            captchaResponse = turnstile.getResponse();
        }

        if (!captchaResponse) {
            showAuthError("Please complete the CAPTCHA verification");
            return;
        }

        const email = document.getElementById("magic-email").value;
        const btn = document.getElementById("magic-btn");
        btn.disabled = true;
        btn.textContent = "Sending...";

        try {
            const res = await fetch(`${BASE_URL}/api/user?action=request-magic-link`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, captchaToken: captchaResponse }),
            });
            // Always show success to avoid leaking whether email exists
            document.getElementById("magic-form").classList.add("hidden");
            document.getElementById("magic-ok").classList.remove("hidden");
            showAuthSuccess("");
        } catch (e) {
            showAuthError("Network error. Please try again.");
        } finally {
            btn.disabled = false;
            btn.textContent = "Send sign-in link";
        }
    }
    
    // Input validation functions
    function validateEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }
    
    function validatePassword(password) {
        // Password must be at least 8 characters long and contain at least one letter and one number
        const minLength = 8;
        const hasLetter = /[a-zA-Z]/.test(password);
        const hasNumber = /\d/.test(password);
        
        return {
            isValid: password.length >= minLength && hasLetter && hasNumber,
            minLength: password.length >= minLength,
            hasLetter: hasLetter,
            hasNumber: hasNumber
        };
    }
    
    function validateRegistrationInputs(email, password, termsAccepted) {
        // Check if fields are empty
        if (!email || !password) {
            return "Please fill in all required fields";
        }
        
        // Validate email format
        if (!validateEmail(email)) {
            return "Please enter a valid email address";
        }
        
        // Check email length
        if (email.length > 254) {
            return "Email address is too long";
        }
        
        // Validate password
        const passwordValidation = validatePassword(password);
        if (!passwordValidation.isValid) {
            let errorMessage = "Password must be at least 8 characters long";
            if (!passwordValidation.hasLetter) {
                errorMessage += " and contain at least one letter";
            }
            if (!passwordValidation.hasNumber) {
                errorMessage += " and contain at least one number";
            }
            return errorMessage;
        }
        
        // Check password length (max 128 characters for security)
        if (password.length > 128) {
            return "Password is too long (maximum 128 characters)";
        }
        
        // Validate terms acceptance
        if (!termsAccepted) {
            return "You must accept the Terms of Service and Privacy Policy to register";
        }
        
        // All validations passed
        return null;
    }

    // Input sanitization function
    function sanitizeInput(input) {
        if (typeof input !== 'string') return '';
        return input.trim()
            .replace(/[<>]/g, '') // Remove potential HTML tags
            .replace(/javascript:/gi, '') // Remove javascript: protocol
            .replace(/on\w+=/gi, ''); // Remove event handlers
    }

    // Turnstile callback functions (global functions required by Turnstile widget)
    window.onTurnstileSuccess = function(token) {
/*console.log('Turnstile CAPTCHA completed successfully');*/ 
        // The token is automatically stored by Turnstile and can be retrieved with getResponse()
    };

    window.onTurnstileExpired = function() {
/*console.log('Turnstile CAPTCHA expired');*/ 
        // Turnstile will automatically reset the widget
    };

    // Add real-time validation for registration form
    function setupRegistrationValidation() {
        const emailInput = document.getElementById("register-email");
        const passwordInput = document.getElementById("register-password");
        
        if (emailInput) {
            emailInput.addEventListener("blur", function() {
                const email = this.value.trim();
                if (email && !validateEmail(email)) {
                    this.style.borderColor = "#ef4444";
                    showAuthError("Please enter a valid email address");
                } else if (email) {
                    this.style.borderColor = "#10b981";
                    showAuthError(""); // Clear error
                }
            });
            
            emailInput.addEventListener("input", function() {
                // Clear styling while typing
                this.style.borderColor = "";
            });
        }
        
        if (passwordInput) {
            passwordInput.addEventListener("blur", function() {
                const password = this.value;
                if (password) {
                    const validation = validatePassword(password);
                    if (!validation.isValid) {
                        this.style.borderColor = "#ef4444";
                        let errorMessage = "Password must be at least 8 characters long";
                        if (!validation.hasLetter) {
                            errorMessage += " and contain at least one letter";
                        }
                        if (!validation.hasNumber) {
                            errorMessage += " and contain at least one number";
                        }
                        showAuthError(errorMessage);
                    } else {
                        this.style.borderColor = "#10b981";
                        showAuthError(""); // Clear error
                    }
                }
            });
            
            passwordInput.addEventListener("input", function() {
                // Clear styling while typing
                this.style.borderColor = "";
            });
        }
    }

    // Public API
    return {
        init: init,
        checkAuthStatus: checkAuthStatus,
        login: login,
        register: register,
        forgotPassword: forgotPassword,
        logout: logout,
        showLoginForm: showLoginForm,
        showRegisterForm: showRegisterForm,
        showForgotForm: showForgotForm,
        showMagicForm: showMagicForm,
        requestMagicLink: requestMagicLink,
        closeAuthModal: closeAuthModal,
        resetAuthForms: resetAuthForms,
        showAuthError: showAuthError,
        showAuthSuccess: showAuthSuccess,
        showGuestUI: showGuestUI,
        showLoggedInUI: showLoggedInUI,
        
        // Getters for current state
        get isAuthenticated() { return isAuthenticated; },
        get currentUser() { return currentUser; },
        get token() { return localStorage.getItem("token"); }
    };
})();

// Make AuthManager globally available
window.AuthManager = AuthManager;

// Global functions for backward compatibility and easy access
window.checkAuthStatus = AuthManager.checkAuthStatus;
window.login = AuthManager.login;
window.register = AuthManager.register;
window.forgotPassword = AuthManager.forgotPassword;
window.logout = AuthManager.logout;
window.showLoginForm = AuthManager.showLoginForm;
window.showRegisterForm = AuthManager.showRegisterForm;
window.showForgotForm = AuthManager.showForgotForm;
window.showMagicForm = AuthManager.showMagicForm;
window.requestMagicLink = AuthManager.requestMagicLink;
window.closeAuthModal = AuthManager.closeAuthModal;
window.resetAuthForms = AuthManager.resetAuthForms;
window.showAuthError = AuthManager.showAuthError;
window.showAuthSuccess = AuthManager.showAuthSuccess;

// Initialize authentication when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    AuthManager.init();

    // ── Modal open / close ────────────────────────────────────────────────────
    const authButton = document.getElementById('auth-button');
    if (authButton) {
        authButton.addEventListener('click', function() {
            document.getElementById('auth-modal').classList.remove('hidden');
        });
    }

    // Modal is not closeable — app requires authentication

    // ── Login form ────────────────────────────────────────────────────────────
    const loginForm      = document.getElementById('login-form');
    const loginBtn       = document.getElementById('login-btn');
    const loginCancelBtn = document.getElementById('login-cancel-btn');
    if (loginForm)      loginForm.addEventListener('submit', function(e) { e.preventDefault(); AuthManager.login(); });
    if (loginBtn)       loginBtn.addEventListener('click', AuthManager.login);
    if (loginCancelBtn) loginCancelBtn.addEventListener('click', AuthManager.showRegisterForm);

    // Submit login on Enter in password field
    const loginPasswordEl = document.getElementById('login-password');
    if (loginPasswordEl) loginPasswordEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); AuthManager.login(); }
    });

    // ── Forgot password form ──────────────────────────────────────────────────
    const forgotForm    = document.getElementById('forgot-form');
    const forgotBackBtn = document.getElementById('forgot-back-btn');
    const forgotOkBack  = document.getElementById('forgot-ok-back-btn');
    const forgotLink    = document.getElementById('forgot-password-link');
    if (forgotForm)    forgotForm.addEventListener('submit', function(e) { e.preventDefault(); AuthManager.forgotPassword(); });
    if (forgotBackBtn) forgotBackBtn.addEventListener('click', AuthManager.showLoginForm);
    if (forgotOkBack)  forgotOkBack.addEventListener('click', AuthManager.showLoginForm);
    if (forgotLink)    forgotLink.addEventListener('click', AuthManager.showForgotForm);

    // ── Register form ─────────────────────────────────────────────────────────
    const registerForm      = document.getElementById('register-form');
    const registerBtn       = document.getElementById('register-btn');
    const registerCancelBtn = document.getElementById('register-cancel-btn');
    if (registerForm)      registerForm.addEventListener('submit', function(e) { e.preventDefault(); AuthManager.register(); });
    if (registerBtn)       registerBtn.addEventListener('click', AuthManager.register);
    if (registerCancelBtn) registerCancelBtn.addEventListener('click', AuthManager.showLoginForm);

    // ── Magic link form ───────────────────────────────────────────────────────
    const magicLinkBtn   = document.getElementById('magic-link-btn');
    const magicForm      = document.getElementById('magic-form');
    const magicBackBtn   = document.getElementById('magic-back-btn');
    const magicOkBackBtn = document.getElementById('magic-ok-back-btn');
    if (magicLinkBtn)   magicLinkBtn.addEventListener('click', AuthManager.showMagicForm);
    if (magicForm)      magicForm.addEventListener('submit', function(e) { e.preventDefault(); AuthManager.requestMagicLink(); });
    if (magicBackBtn)   magicBackBtn.addEventListener('click', AuthManager.showLoginForm);
    if (magicOkBackBtn) magicOkBackBtn.addEventListener('click', AuthManager.showLoginForm);

    // ── Logout ────────────────────────────────────────────────────────────────
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', AuthManager.logout);

});

// Export for module usage if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AuthManager;
}
