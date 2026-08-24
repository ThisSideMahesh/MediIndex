# Test Results

| Test ID | Module | Test case | Expected | Actual | Status |
|---|---|---|---|---|---|
| AUTH-001 | Authentication | Valid administrator login | Session cookie and dashboard access | Pass via in-process API handler test | Pass |
| AUTH-002 | Authentication | Invalid password | HTTP 401 | Pass via in-process API handler test | Pass |
| AUTH-003 | Authorization | Dashboard without session | HTTP 401 | Pass via in-process API handler test | Pass |
| AUTH-004 | Authentication | Password storage | Hash is not plaintext; correct password only validates | Pass via scrypt unit test | Pass |
| INV-001 | Inventory | Create medicine, create batch, calculate stock, list batch status and deactivate medicine | Correct stock and SAFE expiry status | Pass via API handler test | Pass |
| EXP-001 | Expiry | Generate expired-batch alert and acknowledge it | Expired alert appears and acknowledgement persists | Pass via API handler test | Pass |
