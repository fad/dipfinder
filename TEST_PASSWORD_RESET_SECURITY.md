# Testing Password Reset Security

## 🧪 How to Test the Security Fix

### Test 1: Token Single-Use Verification

1. **Request password reset**:
```bash
curl -X POST https://dipfinder.com/api/user?action=forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "captchaToken": "test-token"}'
```

2. **Use the token from email** (first time - should work):
```bash
curl -X POST https://dipfinder.com/api/user?action=reset-password \
  -H "Content-Type: application/json" \
  -d '{"token": "your-reset-token", "newPassword": "NewPassword123!"}'
```

3. **Try to reuse the same token** (should fail):
```bash
curl -X POST https://dipfinder.com/api/user?action=reset-password \
  -H "Content-Type: application/json" \
  -d '{"token": "your-reset-token", "newPassword": "AnotherPassword123!"}'
```

**Expected Result**: 
- ✅ First request: `{"message": "Password reset successful"}`
- ❌ Second request: `{"error": "Invalid or expired reset token"}`

### Test 2: Rate Limiting Verification

1. **Make multiple rapid reset requests** (within 5 minutes):
```bash
# Request 1
curl -X POST https://dipfinder.com/api/user?action=forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "captchaToken": "test-token"}'

# Request 2 (immediate)
curl -X POST https://dipfinder.com/api/user?action=forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "captchaToken": "test-token"}'
```

**Expected Result**: 
- ✅ First request: Email sent
- ✅ Second request: No new email (rate limited silently)

### Test 3: Rapid Password Reset Prevention

1. **Reset password**
2. **Immediately try to reset again** (within 5 minutes)

**Expected Result**: 
- ❌ Second reset: `{"error": "Password was recently changed. Please wait 5 minutes before resetting again."}`

## 🔍 Monitoring Database Changes

Check the user document after a successful password reset:

```javascript
// In MongoDB shell
db.users.findOne({email: "test@example.com"}, {
  email: 1,
  passwordChangedAt: 1,
  lastPasswordReset: 1,
  passwordResetCount: 1,
  passwordResetAttempts: 1,
  resetToken: 1,
  resetTokenExpiry: 1
})
```

**Expected Fields**:
- `resetToken`: Should be **undefined** (removed after use)
- `resetTokenExpiry`: Should be **undefined** (removed after use)
- `lastPasswordReset`: Should have **recent timestamp**
- `passwordResetCount`: Should be **incremented**
- `passwordResetAttempts`: Array of **recent attempt timestamps**

## 🚨 Security Verification Checklist

- [ ] **Token Reuse**: Same token fails on second use
- [ ] **Race Condition**: Concurrent requests with same token - only one succeeds
- [ ] **Rate Limiting**: Multiple forgot password requests are throttled
- [ ] **Reset Cooldown**: Cannot reset password immediately after a reset
- [ ] **Token Cleanup**: Tokens are removed from database after use
- [ ] **Email Validation**: Token email must match user email
- [ ] **Attempt Tracking**: Failed attempts are logged and limited

## 🛡️ What Changed

### Before (Vulnerable):
```typescript
// Separate operations - race condition possible
const user = await usersCollection.findOne({...});
if (user) {
  await usersCollection.updateOne({...}); // Token still exists during this gap
}
```

### After (Secure):
```typescript
// Atomic operation - token consumed instantly
const result = await usersCollection.findOneAndUpdate(
  { resetToken: token }, // Find with token
  { $unset: { resetToken: 1 } } // Remove token immediately
);
```

## 📈 Performance Impact

- **Minimal overhead**: Single database operation instead of two
- **Better concurrency**: No race conditions
- **Reduced queries**: Atomic operations are more efficient

---

✅ **The password reset system is now secure against token reuse and replay attacks.**
