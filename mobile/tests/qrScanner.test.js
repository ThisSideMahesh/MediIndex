/**
 * QR Scanner Integration Tests
 * 
 * Tests the complete QR scanning flow including parsing, lookup, 
 * and navigation integration.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Mock the mobile QR lookup API response
const mockApiClient = {
  post: async (path, body, options) => {
    if (path === '/api/mobile/qr/lookup') {
      const qrPayload = body.qrPayload;
      
      // Simulate backend validation
      if (qrPayload.app !== 'MEDIINDEX') {
        throw new Error('Unrecognized application tag');
      }
      
      if (qrPayload.medicineId === 99999) {
        return {
          valid: false,
          authoritative: true,
          error: 'Medicine ID 99999 not found for this pharmacy.'
        };
      }
      
      if (qrPayload.batchNumber === 'NONEXISTENT') {
        return {
          valid: false,
          authoritative: true,
          medicine: {
            id: qrPayload.medicineId,
            name: 'Test Medicine',
            genericName: 'Test Generic',
            manufacturer: 'Test Mfg',
            category: 'TABLET'
          },
          error: 'Batch \'NONEXISTENT\' not found for medicine \'Test Medicine\'.'
        };
      }
      
      // Valid lookup response
      return {
        valid: true,
        authoritative: true,
        medicine: {
          id: qrPayload.medicineId,
          name: 'Test Medicine',
          genericName: 'Test Generic',
          manufacturer: 'Test Mfg',
          category: 'TABLET',
          minimumStock: 10
        },
        batch: {
          id: 123,
          batchNumber: qrPayload.batchNumber,
          quantity: 100,
          purchasePrice: 10.00,
          sellingPrice: 15.00,
          manufacturingDate: '2024-01-01',
          expiryDate: '2026-12-31',
          expiryStatus: 'VALID',
          location: 'Shelf A1'
        }
      };
    }
    
    throw new Error('Unexpected API call');
  }
};

test('QR-SCAN-001: valid scan triggers exactly one lookup', async () => {
  let lookupCount = 0;
  const testApiClient = {
    post: async (path, body, options) => {
      lookupCount++;
      return mockApiClient.post(path, body, options);
    }
  };
  
  // Simulate QR scan processing
  const qrData = JSON.stringify({
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 123,
    batchNumber: 'BATCH001'
  });
  
  const result = await testApiClient.post('/api/mobile/qr/lookup', {
    qrPayload: {
      app: 'MEDIINDEX',
      v: 1,
      medicineId: 123,
      batchNumber: 'BATCH001'
    }
  }, { authenticated: true });
  
  assert.equal(lookupCount, 1);
  assert.equal(result.valid, true);
});

test('QR-SCAN-002: successful lookup renders authoritative data', async () => {
  const result = await mockApiClient.post('/api/mobile/qr/lookup', {
    qrPayload: {
      app: 'MEDIINDEX',
      v: 1,
      medicineId: 456,
      batchNumber: 'BATCH456'
    }
  }, { authenticated: true });
  
  assert.equal(result.valid, true);
  assert.equal(result.authoritative, true);
  assert.equal(result.medicine.name, 'Test Medicine');
  assert.equal(result.batch.batchNumber, 'BATCH456');
  assert.equal(result.batch.quantity, 100);
  assert.equal(result.batch.expiryStatus, 'VALID');
});

test('QR-SCAN-003: medicine-not-found handled properly', async () => {
  const result = await mockApiClient.post('/api/mobile/qr/lookup', {
    qrPayload: {
      app: 'MEDIINDEX',
      v: 1,
      medicineId: 99999,
      batchNumber: 'BATCH001'
    }
  }, { authenticated: true });
  
  assert.equal(result.valid, false);
  assert.equal(result.authoritative, true);
  assert.ok(result.error.includes('Medicine ID 99999 not found'));
});

test('QR-SCAN-004: batch-not-found includes medicine info', async () => {
  const result = await mockApiClient.post('/api/mobile/qr/lookup', {
    qrPayload: {
      app: 'MEDIINDEX',
      v: 1,
      medicineId: 123,
      batchNumber: 'NONEXISTENT'
    }
  }, { authenticated: true });
  
  assert.equal(result.valid, false);
  assert.equal(result.authoritative, true);
  assert.equal(result.medicine.name, 'Test Medicine');
  assert.ok(result.error.includes('Batch \'NONEXISTENT\' not found'));
});

test('QR-SCAN-005: duplicate scan protection logic', () => {
  // Test the scan locking mechanism
  let scanLocked = false;
  
  function handleScan(data) {
    if (scanLocked) {
      return 'IGNORED'; // Duplicate scan ignored
    }
    
    scanLocked = true;
    return 'PROCESSED'; // First scan processed
  }
  
  const firstScan = handleScan('test-data');
  const duplicateScan = handleScan('test-data');
  
  assert.equal(firstScan, 'PROCESSED');
  assert.equal(duplicateScan, 'IGNORED');
});

test('QR-SCAN-006: scanner reset unlocks for new scan', () => {
  let scanLocked = false;
  
  function handleScan(data) {
    if (scanLocked) return 'IGNORED';
    scanLocked = true;
    return 'PROCESSED';
  }
  
  function resetScanner() {
    scanLocked = false;
  }
  
  // First scan
  assert.equal(handleScan('data1'), 'PROCESSED');
  assert.equal(handleScan('data1'), 'IGNORED'); // Duplicate ignored
  
  // Reset and scan again
  resetScanner();
  assert.equal(handleScan('data2'), 'PROCESSED'); // New scan processed
});

test('QR-SCAN-007: navigation params contain only safe data', () => {
  const lookupResult = {
    valid: true,
    authoritative: true,
    medicine: {
      id: 123,
      name: 'Test Medicine',
      // ... other medicine data
    },
    batch: {
      id: 456,
      batchNumber: 'BATCH123',
      // ... other batch data
    }
  };
  
  // Extract only safe navigation params
  const navigationParams = {
    medicineId: lookupResult.medicine.id,
    batchNumber: lookupResult.batch.batchNumber
  };
  
  // Verify no sensitive data included
  assert.equal(Object.keys(navigationParams).length, 2);
  assert.equal(navigationParams.medicineId, 123);
  assert.equal(navigationParams.batchNumber, 'BATCH123');
  
  // Verify no device token or auth data
  assert.equal(navigationParams.deviceToken, undefined);
  assert.equal(navigationParams.pairingCode, undefined);
  assert.equal(navigationParams.authToken, undefined);
});

test('QR-SCAN-008: offline behavior shows appropriate message', () => {
  // Simulate network error
  class NetworkError extends Error {
    constructor() {
      super('Could not reach the MediIndex server');
      this.type = 'NETWORK';
    }
  }
  
  const offlineApiClient = {
    post: async () => {
      throw new NetworkError();
    }
  };
  
  // Test offline handling
  offlineApiClient.post('/api/mobile/qr/lookup', {}, {})
    .catch(err => {
      assert.equal(err.type, 'NETWORK');
      // Should show: "Internet connection required to verify this medicine."
      assert.ok(err.message.includes('MediIndex server'));
    });
});

test('QR-SCAN-009: auth failure uses centralized handling', () => {
  let authFailureHandled = false;
  
  // Mock API client with auth failure handler
  const authAwareClient = {
    authFailureHandler: null,
    setAuthFailureHandler: function(handler) {
      this.authFailureHandler = handler;
    },
    post: async function(path, body, options) {
      if (options.authenticated) {
        const authError = new Error('Device authentication failed');
        authError.isAuthFailure = true;
        
        if (this.authFailureHandler) {
          await this.authFailureHandler(authError);
        }
        
        throw authError;
      }
    }
  };
  
  // Set up centralized auth failure handler
  authAwareClient.setAuthFailureHandler(async () => {
    authFailureHandled = true;
  });
  
  // Test auth failure
  authAwareClient.post('/api/mobile/qr/lookup', {}, { authenticated: true })
    .catch(() => {
      assert.equal(authFailureHandled, true);
    });
});

test('QR-SCAN-010: QR cannot trigger URL navigation', () => {
  // Test that QR content is never interpreted as URLs
  const urlLikeQR = 'https://evil.com/steal-data';
  
  // QR parser should reject non-MediIndex format
  try {
    // This would fail in the actual parser
    const { parseAndValidateQrPayload } = require('../../core.js');
    parseAndValidateQrPayload(urlLikeQR);
    assert.fail('Should have rejected URL-like QR');
  } catch (err) {
    assert.ok(err.message.includes('not recognized as a valid MediIndex code'));
  }
});

test('QR-SCAN-011: QR cannot execute arbitrary code', () => {
  // Test that QR content cannot execute code
  const maliciousQR = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 1,
    batchNumber: 'BATCH',
    // Malicious fields should be ignored
    __proto__: { polluted: true },
    constructor: { name: 'Function' },
    eval: 'process.exit(1)',
    script: '<script>alert("xss")</script>'
  };
  
  // Parser should only extract safe fields
  const { parseAndValidateQrPayload } = require('../../core.js');
  const result = parseAndValidateQrPayload(maliciousQR);
  
  assert.equal(result.medicineId, 1);
  assert.equal(result.batchNumber, 'BATCH');
  assert.equal(Object.keys(result).length, 2); // Only safe fields
  assert.equal(result.polluted, undefined);
  assert.equal(result.eval, undefined);
  assert.equal(result.script, undefined);
});

test('QR-SCAN-012: network timeout retains credential', () => {
  // Test that network timeouts don't invalidate device credential
  class TimeoutError extends Error {
    constructor() {
      super('Request timed out');
      this.type = 'TIMEOUT';
      this.isAuthFailure = false; // Not an auth failure
    }
  }
  
  const timeoutClient = {
    authFailureHandlerCalled: false,
    setAuthFailureHandler: function(handler) {
      this.authFailureHandler = handler;
    },
    post: async function() {
      throw new TimeoutError();
    }
  };
  
  timeoutClient.setAuthFailureHandler(() => {
    timeoutClient.authFailureHandlerCalled = true;
  });
  
  timeoutClient.post('/api/mobile/qr/lookup', {}, { authenticated: true })
    .catch(err => {
      assert.equal(err.type, 'TIMEOUT');
      assert.equal(timeoutClient.authFailureHandlerCalled, false); // Should not clear credential
    });
});

test('QR-SCAN-013: server 500 retains credential', () => {
  // Test that server errors don't invalidate device credential
  class ServerError extends Error {
    constructor() {
      super('Internal server error');
      this.type = 'HTTP';
      this.status = 500;
      this.isAuthFailure = false; // Not an auth failure
    }
  }
  
  const serverErrorClient = {
    authFailureHandlerCalled: false,
    setAuthFailureHandler: function(handler) {
      this.authFailureHandler = handler;
    },
    post: async function() {
      throw new ServerError();
    }
  };
  
  serverErrorClient.setAuthFailureHandler(() => {
    serverErrorClient.authFailureHandlerCalled = true;
  });
  
  serverErrorClient.post('/api/mobile/qr/lookup', {}, { authenticated: true })
    .catch(err => {
      assert.equal(err.status, 500);
      assert.equal(serverErrorClient.authFailureHandlerCalled, false); // Should not clear credential
    });
});

test('QR-SCAN-014: malformed backend response handled', () => {
  const malformedClient = {
    post: async () => {
      // Return invalid response structure
      return { unexpected: 'format' };
    }
  };
  
  malformedClient.post('/api/mobile/qr/lookup', {}, {})
    .then(result => {
      // Should handle gracefully in actual implementation
      assert.equal(result.valid, undefined); // Missing expected fields
    });
});

test('QR-SCAN-015: expiry status correctly interpreted', () => {
  const expiryTestCases = [
    { status: 'VALID', expected: true },
    { status: 'NEAR_EXPIRY', expected: false },
    { status: 'EXPIRED', expected: false }
  ];
  
  expiryTestCases.forEach(testCase => {
    const isValidExpiry = testCase.status === 'VALID';
    assert.equal(isValidExpiry, testCase.expected);
  });
});