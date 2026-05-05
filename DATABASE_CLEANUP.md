# Database Field Cleanup - Remove Legacy Fields

## Overview
During the security audit, we identified redundant fields in the user collection that should be removed for better data consistency and reduced storage.

## Redundant Fields Identified

### `lastLoginDate` - REMOVE
- **Status**: Legacy field, not used in current codebase
- **Current Usage**: None (confirmed via codebase search)
- **Replacement**: `lastLoginAt` field is used instead
- **Action Required**: Remove from all user documents

## Migration Strategy

### Option 1: MongoDB Script (Recommended)
```javascript
// Connect to your MongoDB instance
use your_database_name;

// Remove the lastLoginDate field from all user documents
db.users.updateMany(
  { lastLoginDate: { $exists: true } },
  { $unset: { lastLoginDate: "" } }
);

// Verify the field has been removed
db.users.findOne({ lastLoginDate: { $exists: true } });
// Should return null if successful
```

### Option 2: API Endpoint for Migration
Create a temporary admin endpoint to clean up fields:

```javascript
// Add to api/user.ts temporarily
if (request.method === 'DELETE' && url.pathname === '/api/admin/cleanup-fields') {
  // Add authentication check here for admin users only
  const result = await db.collection('users').updateMany(
    { lastLoginDate: { $exists: true } },
    { $unset: { lastLoginDate: "" } }
  );
  
  return new Response(JSON.stringify({
    success: true,
    modifiedCount: result.modifiedCount,
    message: `Removed lastLoginDate from ${result.modifiedCount} documents`
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
```

## Pre-Migration Checklist
- [ ] Backup your database
- [ ] Confirm `lastLoginDate` is not used in any legacy frontend code
- [ ] Test the migration on a development/staging environment first
- [ ] Document the current count of documents with `lastLoginDate`

## Verification Commands
```javascript
// Count documents with the legacy field
db.users.countDocuments({ lastLoginDate: { $exists: true } });

// Sample a few documents to see the field
db.users.find({ lastLoginDate: { $exists: true } }).limit(5);

// After migration - confirm removal
db.users.countDocuments({ lastLoginDate: { $exists: true } });
// Should return 0
```

## Current User Schema Analysis

### Active Fields (Keep These)
- ✅ `email` - User's email address
- ✅ `password` - Hashed password
- ✅ `name` - User's display name
- ✅ `createdDate` - Account creation timestamp
- ✅ `isVerified` - Email verification status
- ✅ `lastLoginAt` - Last successful login timestamp
- ✅ `lastLoginIP` - Last login IP address
- ✅ `totalLoginCount` - Total number of successful logins
- ✅ `resetToken` - Password reset token (temporary)
- ✅ `resetTokenExpiry` - Reset token expiration (temporary)
- ✅ `resetRequestCount` - Rate limiting for password resets
- ✅ `lastResetRequest` - Last password reset request timestamp
- ✅ `nextResetAllowed` - Earliest time for next reset request
- ✅ `failedLoginAttempts` - Failed login attempt count
- ✅ `lockoutUntil` - Account lockout expiration
- ✅ `lockoutCount` - Progressive lockout counter
- ✅ `lastFailedLoginAt` - Last failed login timestamp
- ✅ `lastFailedLoginIP` - Last failed login IP
- ✅ `lastFailedUserAgent` - Last failed login user agent

### Legacy Fields (Remove These)
- ❌ `lastLoginDate` - Redundant with `lastLoginAt`

## Impact Assessment
- **Storage**: Minimal reduction (one timestamp per user)
- **Performance**: Minimal improvement (slightly smaller documents)
- **Maintenance**: Reduced confusion, cleaner data model
- **Risk**: Low (field is unused in current code)

## Post-Migration
1. Remove any references to `lastLoginDate` from documentation
2. Update any database schema documentation to reflect the cleanup
3. Consider adding a note in the user schema comments about the cleanup date
