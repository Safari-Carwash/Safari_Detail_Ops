## Job Number Feature - Testing Guide

### Environment: QA (Sandbox)
**Status**: Ready for testing (backfill complete, 41 jobs now have Job #10001-#10041)

---

## Phase 1: Manual UI Testing

### 1.1 Verify Existing Jobs Display Job Numbers

**Steps:**
1. Open Safari Detail Ops QA
2. Go to **Calendar** view
3. ✅ Verify each job card shows format: `"Job #10001 - Customer Name"`
4. Click on any job
5. ✅ Verify orange banner at top shows `"Job #10001"` prominently

**Expected Results:**
- Job numbers display correctly on all job cards
- Job detail page has prominent orange banner
- Format is consistent: `Job #XXXXX`

---

### 1.2 Create New Website Booking

**Steps:**
1. Go to website booking flow (customer-facing)
2. Complete a booking through Square
3. Wait for job to sync to Detail Ops (or check immediately)
4. Navigate to the job detail page
5. ✅ Verify it shows `"Job #10042"` (next sequential number)
6. Check calendar - card should show job number

**Expected Results:**
- New job gets next sequential job number (10042)
- Job number appears in both detail page and calendar
- Number never changes (even if job is edited)

---

### 1.3 Create Manager Phone Booking

**Steps:**
1. Log in as Manager
2. Go to **Manager** → **Phone Booking**
3. Create a new phone booking
4. Verify customer details populated
5. Go to the created job
6. ✅ Verify it shows `"Job #10043"` (next after website booking)

**Expected Results:**
- Phone booking also gets sequential job number
- Number is next in sequence regardless of booking source
- No duplicate numbers

---

### 1.4 Rapid Concurrent Bookings (Race Condition Test)

**Steps:**
1. Open 2 separate browser windows (incognito mode for clean session)
2. In Window 1: Start website booking → get to payment screen (don't complete)
3. In Window 2: Start website booking → get to payment screen (don't complete)
4. In both windows: Click "Complete Booking" at same time
5. Wait for both jobs to sync
6. Check both jobs' detail pages
7. ✅ Verify they have different job numbers (e.g., #10044 and #10045)
8. ✅ Verify no duplicate numbers

**Expected Results:**
- Even with concurrent bookings, each gets a unique number
- Numbers are sequential with no gaps or duplicates
- Atomic counter prevents race conditions

---

## Phase 2: API Testing

### 2.1 Test Job Creation API

**Test: Create job via manager phone booking API**

```bash
curl -X POST http://localhost:3000/api/manager/create-booking \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_MANAGER_TOKEN" \
  -d '{
    "customer": {
      "name": "Test Customer",
      "phone": "+1-555-0100",
      "email": "test@example.com"
    },
    "service": {
      "serviceName": "Full Detail",
      "serviceVariationId": "YOUR_SERVICE_ID",
      "durationMinutes": 120,
      "amountCents": 17450
    },
    "appointmentTime": {
      "startAt": "2026-06-04T14:00:00Z"
    },
    "vehicle": {
      "year": 2024,
      "make": "Honda",
      "model": "Civic",
      "color": "Blue"
    }
  }'
```

**Verify Response:**
```json
{
  "success": true,
  "data": {
    "job": {
      "jobId": "...",
      "jobNumber": 10044,  // ✅ Should have jobNumber
      "customerName": "Test Customer",
      ...
    }
  }
}
```

**Expected:**
- ✅ Response includes `jobNumber` field
- ✅ Number is unique and sequential

---

### 2.2 Test Job Detail API

**Test: Fetch job and verify jobNumber in response**

```bash
curl http://localhost:3000/api/jobs/JOBID
```

**Verify Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "...",
    "jobNumber": 10001,  // ✅ Should be present
    "customerName": "...",
    ...
  }
}
```

**Expected:**
- ✅ `jobNumber` field present in response
- ✅ Number matches what's displayed in UI

---

### 2.3 Test Job List API

**Test: List jobs and verify all have jobNumbers**

```bash
curl "http://localhost:3000/api/jobs"
```

**Verify Response:**
```json
{
  "success": true,
  "data": {
    "jobs": [
      {
        "jobId": "...",
        "jobNumber": 10001,  // ✅ All jobs should have this
        ...
      },
      {
        "jobId": "...",
        "jobNumber": 10002,
        ...
      }
    ]
  }
}
```

**Expected:**
- ✅ All jobs in list have jobNumber
- ✅ Numbers are unique

---

## Phase 3: Functional Testing

### 3.1 Verify Job Number Immutability

**Steps:**
1. Open a job detail page
2. Note the job number (e.g., #10015)
3. Edit job details:
   - Change customer name
   - Update vehicle info
   - Add notes
   - Update status
4. Save changes
5. Refresh page
6. ✅ Verify job number is unchanged

**Expected Results:**
- Job number NEVER changes after creation
- Edits don't affect the job number

---

### 3.2 Verify Payment/Deposit Logic Unaffected

**Steps:**
1. Open a job with deposit info
2. ✅ Verify payment section still shows:
   - Total Job Amount
   - Deposit Collected
   - Remaining Balance
3. Update payment status
4. ✅ Verify payment logic works correctly
5. Edit payment amount
6. ✅ Verify amount updates correctly

**Expected Results:**
- Payment/deposit logic unchanged
- Job number doesn't interfere with payment calculations
- Square Booking ID still stored separately

---

### 3.3 Verify Square Booking ID Still Stored

**Steps:**
1. Open job created from website booking
2. Look for job details/debug section (may need to add if not visible)
3. ✅ Verify Square Booking ID is still stored as separate field
4. ✅ Verify it's different from Job Number

**Expected Results:**
- Square Booking ID exists: `bookingId` field
- Different from Job Number
- Still mapped correctly to Square

---

### 3.4 Verify Add-Ons Not Affected

**Steps:**
1. Create booking with add-ons
2. Complete the booking (becomes a job)
3. ✅ Verify job displays correctly with job number
4. ✅ Verify add-on details still visible in notes
5. ✅ Verify add-on pricing still calculated correctly

**Expected Results:**
- Add-ons still work
- Pricing calculations unchanged
- Job number displayed alongside add-ons

---

## Phase 4: Edge Cases

### 4.1 Test Job Creation After Long Delay

**Steps:**
1. Create job (note job number, e.g., #10050)
2. Wait 5+ minutes
3. Create another job
4. ✅ Verify it gets #10051 (counter still works)

**Expected Results:**
- Counter persists across time delays
- Numbers remain sequential

---

### 4.2 Test Counter Initialization

**Steps:**
1. (Simulate production environment)
2. First job created
3. ✅ Verify it gets #10001 (counter initialized)
4. Second job gets #10002

**Expected Results:**
- Counter auto-initializes if not present
- Numbering starts at 10001
- No errors if counter doesn't exist

---

### 4.3 Test with Different User Roles

**Steps:**
1. **TECH role**: View job → ✅ See job number
2. **QC role**: View job → ✅ See job number
3. **MANAGER role**: Create job → ✅ Job gets number
4. Different roles should all see same number

**Expected Results:**
- All user roles can see job numbers
- Numbers consistent across roles
- Access control unchanged

---

## Phase 5: Performance Testing

### 5.1 Test Large Job List Performance

**Steps:**
1. Calendar view with many jobs
2. ✅ Page loads quickly
3. ✅ No lag displaying job numbers
4. ✅ No N+1 query issues

**Expected Results:**
- Calendar renders quickly
- Job numbers load without performance impact
- No additional API calls per job

---

### 5.2 Test Job Search/Filter Performance

**Steps:**
1. Filter jobs by status
2. ✅ Results display with job numbers
3. ✅ Performance acceptable (< 2 seconds)

**Expected Results:**
- Filtering works with job numbers
- No performance degradation

---

## Phase 6: Rollback Testing

### 6.1 Prepare Rollback Plan

**In case of issues:**

```bash
# If jobs need to be un-backfilled (shouldn't be necessary):
# Remove jobNumber field from all jobs
# (Would need custom script)

# To revert code:
git revert COMMIT_HASH
npm run build
# Redeploy
```

**Mitigation:**
- jobNumber field is optional (backward compatible)
- Old code will ignore it if present
- No breaking database changes

---

## Testing Checklist

```
Phase 1: Manual UI Testing
  ☐ Existing jobs display job numbers on calendar
  ☐ Job detail page shows orange banner with job number
  ☐ Create website booking → gets next job number
  ☐ Create phone booking → gets next job number
  ☐ Rapid concurrent bookings → no duplicates
  
Phase 2: API Testing
  ☐ POST /api/manager/create-booking returns jobNumber
  ☐ GET /api/jobs/[jobId] returns jobNumber
  ☐ GET /api/jobs returns all jobNumbers
  
Phase 3: Functional Testing
  ☐ Job number immutable after creation
  ☐ Payment/deposit logic unaffected
  ☐ Square Booking ID still stored separately
  ☐ Add-ons still work and price correctly
  
Phase 4: Edge Cases
  ☐ Counter persists across time delays
  ☐ Counter auto-initializes in new environment
  ☐ All user roles see job numbers
  
Phase 5: Performance
  ☐ Calendar loads quickly with numbers
  ☐ Search/filter performance acceptable
  
Phase 6: Rollback
  ☐ Rollback plan documented
  ☐ No data corruption risk
```

---

## Sign-Off for Production

✅ **Ready for Prod When:**
1. All phases pass (or acceptably fail with mitigation)
2. No duplicate job numbers generated
3. No performance degradation
4. Existing functionality still works
5. Team approves

**Then deploy to production:**
```bash
git push origin main
# CI/CD deploys to prod
# Monitor logs for errors
# If issues: git revert and redeploy
```

---

## Monitoring in Production

**After production deployment, monitor:**
1. **Error logs** for job creation failures
2. **Job numbers** to verify they're sequential
3. **Performance** of calendar/job list views
4. **Payment processing** unaffected
5. **Counter value** stays in sync

**SQL/DynamoDB Query to Check:**
```
# DynamoDB - Check a few random jobs
Get jobs and verify jobNumber present and unique

# Scan for duplicates:
Query all jobs with same jobNumber (should be 0 results)
```

