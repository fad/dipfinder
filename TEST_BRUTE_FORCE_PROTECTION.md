# Testing Login Brute Force Protection

## 🧪 How to Test the Security Implementation

### Test 1: Basic Brute Force Protection

**Attempt multiple failed logins:**

```bash
# Test with wrong password (replace with your test email)
for i in {1..6}; do
  echo "Attempt $i:"
  curl -X POST https://dipfinder.com/api/user?action=login \
    -H "Content-Type: application/json" \
    -d '{
      "email": "test@example.com",
      "password": "wrongpassword",
      "captchaToken": "test-token"
    }' | jq '.'
  echo "---"
  sleep 2
done
```

**Expected Results:**
- Attempts 1-4: `{"error": "Invalid credentials"}`
- Attempt 5: `{"error": "Invalid credentials (0 attempts remaining before account lockout)"}`
- Attempt 6: `{"error": "Account temporarily locked...", "lockoutInfo": {...}}`

### Test 2: Progressive Lockout Verification

1. **Create Test Account:**
```bash
curl -X POST https://dipfinder.com/api/user?action=register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "lockout-test@example.com",
    "password": "TestPassword123!",
    "captchaToken": "test-token"
  }'
```

2. **Trigger First Lockout (15 minutes):**
```bash
# 5 failed attempts
for i in {1..5}; do
  curl -X POST https://dipfinder.com/api/user?action=login \
    -H "Content-Type: application/json" \
    -d '{
      "email": "lockout-test@example.com",
      "password": "wrong",
      "captchaToken": "test-token"
    }' | jq '.lockoutInfo'
done
```

3. **Wait 15 minutes, then trigger 1-hour lockout:**
```bash
# After 15 minutes, try 8 more failed attempts
for i in {1..8}; do
  curl -X POST https://dipfinder.com/api/user?action=login \
    -H "Content-Type: application/json" \
    -d '{
      "email": "lockout-test@example.com",
      "password": "wrong",
      "captchaToken": "test-token"
    }' | jq '.lockoutInfo'
done
```

### Test 3: Successful Login Reset

```bash
# 1. Fail 3 times
for i in {1..3}; do
  curl -X POST https://dipfinder.com/api/user?action=login \
    -H "Content-Type: application/json" \
    -d '{
      "email": "reset-test@example.com",
      "password": "wrong",
      "captchaToken": "test-token"
    }'
done

# 2. Login successfully (should reset counter)
curl -X POST https://dipfinder.com/api/user?action=login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "reset-test@example.com",
    "password": "CorrectPassword123!",
    "captchaToken": "test-token"
  }'

# 3. Try failing again (should start fresh with 5 attempts)
curl -X POST https://dipfinder.com/api/user?action=login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "reset-test@example.com",
    "password": "wrong",
    "captchaToken": "test-token"
  }' | jq '.lockoutInfo.attemptsRemaining'
```

## 📊 Monitoring Database Changes

### Check User Lockout Status
```javascript
// In MongoDB shell or MongoDB Compass
db.users.findOne(
  {email: "test@example.com"}, 
  {
    email: 1,
    failedLoginAttempts: 1,
    accountLockedUntil: 1,
    lockoutCount: 1,
    lastLoginAt: 1,
    lastLoginIP: 1,
    totalLoginCount: 1
  }
)
```

### Find All Locked Accounts
```javascript
db.users.find(
  {accountLockedUntil: {$gt: new Date()}},
  {email: 1, accountLockedUntil: 1, lockoutCount: 1}
)
```

### Failed Attempts Analysis
```javascript
db.users.aggregate([
  {$match: {failedLoginAttempts: {$exists: true}}},
  {$project: {
    email: 1,
    failedAttemptCount: {$size: "$failedLoginAttempts"},
    lastFailedAttempt: {$arrayElemAt: ["$failedLoginAttempts", -1]}
  }},
  {$sort: {failedAttemptCount: -1}}
])
```

## 🔍 Security Event Verification

### What to Look For in Logs

**Failed Login Attempt:**
```
Failed login attempt for user: test@example.com from IP: 192.168.1.100. Total recent attempts: 3
```

**Account Lockout:**
```
Account locked for user: test@example.com. Unlock time: Mon Jul 01 2025 15:45:22. Lockout count: 1
```

**Successful Login After Lockout:**
```
Successful login for user: test@example.com from IP: 192.168.1.100
```

**Lockout Check (when locked):**
```
Login attempt blocked for locked account: test@example.com. Unlock time: Mon Jul 01 2025 15:45:22
```

## 🚨 Security Verification Checklist

- [ ] **5 Failed Attempts**: Triggers 15-minute lockout
- [ ] **8 Failed Attempts**: Triggers 1-hour lockout
- [ ] **10+ Failed Attempts**: Triggers 4-hour lockout
- [ ] **Lockout Persistence**: Account stays locked until unlock time
- [ ] **Success Reset**: Successful login clears all lockout data
- [ ] **IP Tracking**: Failed attempts include IP addresses
- [ ] **Progressive Warnings**: Users warned before lockout
- [ ] **Consistent Responses**: Same error for invalid user/password

## 🛠️ Development Testing

### Local Testing Script
```bash
#!/bin/bash
# test-brute-force.sh

EMAIL="test@localhost.com"
WRONG_PASS="wrongpassword"
BASE_URL="http://localhost:3000"

echo "Testing brute force protection..."

for i in {1..6}; do
  echo "Attempt $i:"
  response=$(curl -s -X POST $BASE_URL/api/user?action=login \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$WRONG_PASS\",\"captchaToken\":\"test-token\"}")
  
  echo $response | jq '.'
  echo "---"
  
  # Check if locked
  if echo $response | grep -q "temporarily locked"; then
    echo "Account locked! Test successful."
    break
  fi
  
  sleep 1
done
```

### Python Test Script
```python
import requests
import json
import time

def test_brute_force():
    url = "https://dipfinder.com/api/user?action=login"
    headers = {"Content-Type": "application/json"}
    
    for i in range(1, 7):
        data = {
            "email": "test@example.com",
            "password": "wrongpassword",
            "captchaToken": "test-token"
        }
        
        response = requests.post(url, headers=headers, json=data)
        result = response.json()
        
        print(f"Attempt {i}: {response.status_code}")
        print(f"Response: {json.dumps(result, indent=2)}")
        print("---")
        
        if response.status_code == 423:  # Locked
            print("Account successfully locked!")
            break
            
        time.sleep(2)

if __name__ == "__main__":
    test_brute_force()
```

## 📈 Performance Testing

### Load Testing Considerations
- **Concurrent Failed Logins**: Test multiple IPs simultaneously
- **Database Load**: Monitor MongoDB performance during lockouts
- **Memory Usage**: Check for memory leaks with failed attempt arrays
- **Response Times**: Ensure lockout checks don't slow down authentication

---

✅ **Comprehensive testing ensures robust brute force protection is working correctly.**
