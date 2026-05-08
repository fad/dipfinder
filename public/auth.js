// auth.js - Centralized Authentication Management
// This file handles all authentication-related functionality across the app

const AuthManager = (function() {
    // For development, use local origin. For production, use the deployed backend.
    const BASE_URL = window.location.origin;
    
    // Authentication state management
    let currentUser = null;
    let isAuthenticated = false;
    
    // Initialize authentication on page load
    function init() {
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
                return false;
            }
            
            // Token seems valid, show logged-in UI immediately with cached user info
            if (payload.email) {
                const userData = { 
                    email: payload.email, 
                    name: payload.name || payload.email.split('@')[0] 
                };
/*console.log("Token valid, showing logged in UI with cached data");*/ 
                
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
            window.MAX_STOCKS = isPro ? 50 : (authenticated ? 10 : 5);
        }

        // Update stock limit message if it exists
        const stockLimitMessage = document.getElementById("stock-limit-message");
        if (stockLimitMessage) {
            stockLimitMessage.textContent = isPro
                ? "You can have up to 50 stocks per watchlist."
                : authenticated
                    ? "You can only have up to 10 stocks."
                    : "You can only have up to 5 stocks. Log in to track up to 10.";
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

        // Show inline save button
        const saveInline = document.getElementById("save-watchlist-btn-wrap");
        if (saveInline) saveInline.classList.remove("hidden");

        // Show sample watchlist box
        const sampleBox = document.getElementById("sample-watchlist-box");
        if (sampleBox) sampleBox.classList.remove("hidden");

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

        // Hide inline save button (user is already logged in)
        const saveInline = document.getElementById("save-watchlist-btn-wrap");
        if (saveInline) saveInline.classList.add("hidden");

        // Hide sample watchlist box
        const sampleBox = document.getElementById("sample-watchlist-box");
        if (sampleBox) sampleBox.classList.add("hidden");

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
        
        try {
            const res = await fetch(`${BASE_URL}/api/user?action=register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    email, 
                    password, 
                    captchaToken: captchaResponse,
                    termsAccepted,
                    newsletterSubscribed
                }),
            });
            const data = await res.json();
            
            if (res.ok) {
                showAuthSuccess(data.msg || "Registration successful! Please log in.");
                setTimeout(() => showLoginForm(), 1200);
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
                    namedWatchlists: data.namedWatchlists || [],
                    activeWatchlistId: data.activeWatchlistId || 'primary',
                }
            }));
        } catch (e) { /* silent — local stocks remain */ }
    }

    // Logout
    function logout() {
        localStorage.removeItem("token");
        localStorage.setItem("lastAuthState", JSON.stringify({ isAuthenticated: false }));
        showGuestUI();
        
        // Close profile menu if open
        const profileMenu = document.getElementById("profile-menu");
        if (profileMenu) profileMenu.classList.add("hidden");
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
        document.getElementById("auth-options").classList.remove("hidden");
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
        if (termsCheckbox) termsCheckbox.checked = false;
        if (newsletterCheckbox) newsletterCheckbox.checked = false;
        
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
        document.getElementById("auth-options").classList.add("hidden");
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
        document.getElementById("auth-options").classList.add("hidden");
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
        document.getElementById("auth-options").classList.add("hidden");
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
        document.getElementById("auth-options").classList.add("hidden");
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

    // Close on backdrop click (but not on content click)
    const authModal = document.getElementById('auth-modal');
    const authModalContent = document.getElementById('auth-modal-content');
    if (authModal) {
        authModal.addEventListener('click', function(e) {
            if (e.target === authModal) AuthManager.closeAuthModal();
        });
    }
    if (authModalContent) {
        authModalContent.addEventListener('click', function(e) { e.stopPropagation(); });
    }

    const authModalClose = document.getElementById('auth-modal-close');
    if (authModalClose) authModalClose.addEventListener('click', AuthManager.closeAuthModal);

    // ── Auth-options screen ───────────────────────────────────────────────────
    const authOptionsLogin    = document.getElementById('auth-options-login');
    const authOptionsRegister = document.getElementById('auth-options-register');
    if (authOptionsLogin)    authOptionsLogin.addEventListener('click', AuthManager.showLoginForm);
    if (authOptionsRegister) authOptionsRegister.addEventListener('click', AuthManager.showRegisterForm);

    // ── Login form ────────────────────────────────────────────────────────────
    const loginForm      = document.getElementById('login-form');
    const loginBtn       = document.getElementById('login-btn');
    const loginCancelBtn = document.getElementById('login-cancel-btn');
    if (loginForm)      loginForm.addEventListener('submit', function(e) { e.preventDefault(); AuthManager.login(); });
    if (loginBtn)       loginBtn.addEventListener('click', AuthManager.login);
    if (loginCancelBtn) loginCancelBtn.addEventListener('click', AuthManager.closeAuthModal);

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
    if (registerCancelBtn) registerCancelBtn.addEventListener('click', AuthManager.closeAuthModal);

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
