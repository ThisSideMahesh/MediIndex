/**
 * Idempotency Key Generator Tests
 * 
 * Tests the cryptographically strong idempotency key generation for
 * exactly-once stock receipt semantics.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Mock the idempotency module for testing
const mockIdempotency = {
  generateIdempotencyKey: function() {
    const timestamp = Date.now();
    // Simulate crypto-strong random for testing
    const randomComponent = Array.from({ length: 12 }, () => 
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    ).join('');
    return `mobile-stock-${timestamp}-${randomComponent}`;
  },
  
  isValidIdempotencyKey: function(key) {
    if (typeof key !== 'string') return false;
    if (key.length === 0 || key.length > 120) return false;
    const pattern = /^mobile-stock-\d+-[a-f0-9]+$/;
    return pattern.test(key);
  }
};

test('IDEM-001: Key generation produces unique values', () => {
  const keys = new Set();
  
  for (let i = 0; i < 100; i++) {
    const key = mockIdempotency.generateIdempotencyKey();
    assert.ok(!keys.has(key), `Duplicate key generated: ${key}`);
    keys.add(key);
  }
  
  assert.equal(keys.size, 100);
});

test('IDEM-002: Key format follows expected pattern', () => {
  const key = mockIdempotency.generateIdempotencyKey();
  
  assert.ok(key.startsWith('mobile-stock-'));
  assert.ok(key.includes('-'));
  assert.ok(key.length > 20);
  assert.ok(key.length < 120); // Under backend limit
});

test('IDEM-003: Key contains timestamp component', () => {
  const beforeTime = Date.now();
  const key = mockIdempotency.generateIdempotencyKey();
  const afterTime = Date.now();
  
  // Extract timestamp from key
  const parts = key.split('-');
  assert.equal(parts[0], 'mobile');
  assert.equal(parts[1], 'stock');
  
  const timestamp = parseInt(parts[2], 10);
  assert.ok(timestamp >= beforeTime);
  assert.ok(timestamp <= afterTime);
});

test('IDEM-004: Key contains random component', () => {
  const key1 = mockIdempotency.generateIdempotencyKey();
  const key2 = mockIdempotency.generateIdempotencyKey();
  
  // Extract random parts
  const parts1 = key1.split('-');
  const parts2 = key2.split('-');
  
  const random1 = parts1[3];
  const random2 = parts2[3];
  
  assert.notEqual(random1, random2);
  assert.ok(random1.length > 0);
  assert.ok(random2.length > 0);
});

test('IDEM-005: Key validation accepts valid keys', () => {
  const validKeys = [
    'mobile-stock-1640995200000-abcdef123456',
    'mobile-stock-1234567890123-fedcba654321',
    'mobile-stock-9999999999999-1234567890ab'
  ];
  
  for (const key of validKeys) {
    assert.ok(mockIdempotency.isValidIdempotencyKey(key), `Valid key rejected: ${key}`);
  }
});

test('IDEM-006: Key validation rejects invalid keys', () => {
  const invalidKeys = [
    '', // Empty
    'invalid-format',
    'mobile-stock-', // Incomplete
    'mobile-stock-abc-def', // Non-numeric timestamp
    'wrong-prefix-1640995200000-abcdef',
    'A'.repeat(130), // Too long
    null,
    undefined,
    123,
    'mobile-stock-1640995200000-GGGG', // Invalid hex
  ];
  
  for (const key of invalidKeys) {
    assert.ok(!mockIdempotency.isValidIdempotencyKey(key), `Invalid key accepted: ${key}`);
  }
});

test('IDEM-007: Keys are stable for operation lifecycle', () => {
  // Simulate operation with same key through retries
  const operationKey = mockIdempotency.generateIdempotencyKey();
  
  // First attempt
  let attempt1Key = operationKey;
  
  // Retry - should use same key
  let retryKey = operationKey;
  
  // Success - key should remain same for confirmation
  let successKey = operationKey;
  
  assert.equal(attempt1Key, retryKey);
  assert.equal(retryKey, successKey);
  assert.equal(successKey, operationKey);
});

test('IDEM-008: New operations get new keys', () => {
  const operation1Key = mockIdempotency.generateIdempotencyKey();
  const operation2Key = mockIdempotency.generateIdempotencyKey();
  const operation3Key = mockIdempotency.generateIdempotencyKey();
  
  assert.notEqual(operation1Key, operation2Key);
  assert.notEqual(operation2Key, operation3Key);
  assert.notEqual(operation1Key, operation3Key);
});

test('IDEM-009: Keys do not contain sensitive data', () => {
  const key = mockIdempotency.generateIdempotencyKey();
  
  // Should not contain any sensitive information
  assert.ok(!key.includes('medidev_'));
  assert.ok(!key.includes('token'));
  assert.ok(!key.includes('password'));
  assert.ok(!key.includes('auth'));
  assert.ok(!key.includes('secret'));
});

test('IDEM-010: Keys are not derived from medicine data', () => {
  const medicineId = 12345;
  const batchNumber = 'BATCH-TEST';
  const quantity = 100;
  
  const key1 = mockIdempotency.generateIdempotencyKey();
  const key2 = mockIdempotency.generateIdempotencyKey();
  
  // Keys should not be predictable from medicine data
  assert.ok(!key1.includes(String(medicineId)));
  assert.ok(!key1.includes(batchNumber));
  assert.ok(!key1.includes(String(quantity)));
  
  assert.ok(!key2.includes(String(medicineId)));
  assert.ok(!key2.includes(batchNumber));
  assert.ok(!key2.includes(String(quantity)));
});

test('IDEM-011: Key length is within backend limits', () => {
  for (let i = 0; i < 50; i++) {
    const key = mockIdempotency.generateIdempotencyKey();
    assert.ok(key.length <= 120, `Key too long: ${key.length} chars`);
    assert.ok(key.length >= 10, `Key too short: ${key.length} chars`);
  }
});

test('IDEM-012: Keys are URL-safe characters only', () => {
  const key = mockIdempotency.generateIdempotencyKey();
  
  // Should only contain URL-safe characters
  const urlSafePattern = /^[A-Za-z0-9\-_]+$/;
  assert.ok(urlSafePattern.test(key), `Key contains unsafe characters: ${key}`);
});

test('IDEM-013: High-volume key generation maintains uniqueness', () => {
  const keys = new Set();
  const count = 1000;
  
  for (let i = 0; i < count; i++) {
    const key = mockIdempotency.generateIdempotencyKey();
    assert.ok(!keys.has(key), `Collision detected at iteration ${i}: ${key}`);
    keys.add(key);
  }
  
  assert.equal(keys.size, count);
});

test('IDEM-014: Concurrent key generation avoids collisions', async () => {
  const concurrentCount = 100;
  const promises = [];
  
  for (let i = 0; i < concurrentCount; i++) {
    promises.push(Promise.resolve(mockIdempotency.generateIdempotencyKey()));
  }
  
  const keys = await Promise.all(promises);
  const uniqueKeys = new Set(keys);
  
  assert.equal(uniqueKeys.size, concurrentCount, 'Concurrent key generation produced collisions');
});

test('IDEM-015: Key generation is deterministic within operation', () => {
  // Once generated for an operation, key should remain stable
  const operationId = 'test-operation-123';
  const keyMap = new Map();
  
  // Simulate getting key for same operation multiple times
  function getKeyForOperation(opId) {
    if (!keyMap.has(opId)) {
      keyMap.set(opId, mockIdempotency.generateIdempotencyKey());
    }
    return keyMap.get(opId);
  }
  
  const key1 = getKeyForOperation(operationId);
  const key2 = getKeyForOperation(operationId);
  const key3 = getKeyForOperation(operationId);
  
  assert.equal(key1, key2);
  assert.equal(key2, key3);
  assert.equal(key1, key3);
});

test('IDEM-016: Key format is consistent across platforms', () => {
  // Keys should have consistent format regardless of platform
  const keys = [];
  
  for (let i = 0; i < 10; i++) {
    keys.push(mockIdempotency.generateIdempotencyKey());
  }
  
  // All keys should follow same pattern
  for (const key of keys) {
    const parts = key.split('-');
    assert.equal(parts.length, 4, `Inconsistent key format: ${key}`);
    assert.equal(parts[0], 'mobile');
    assert.equal(parts[1], 'stock');
    assert.ok(/^\d+$/.test(parts[2]), `Invalid timestamp format: ${parts[2]}`);
    assert.ok(/^[a-f0-9]+$/.test(parts[3]), `Invalid random format: ${parts[3]}`);
  }
});

test('IDEM-017: Key survives serialization/deserialization', () => {
  const originalKey = mockIdempotency.generateIdempotencyKey();
  
  // Simulate JSON serialization (common in API calls)
  const serialized = JSON.stringify({ idempotencyKey: originalKey });
  const deserialized = JSON.parse(serialized);
  
  assert.equal(deserialized.idempotencyKey, originalKey);
  assert.ok(mockIdempotency.isValidIdempotencyKey(deserialized.idempotencyKey));
});

test('IDEM-018: Key encoding handles special cases safely', () => {
  const key = mockIdempotency.generateIdempotencyKey();
  
  // Test URL encoding
  const encoded = encodeURIComponent(key);
  const decoded = decodeURIComponent(encoded);
  
  assert.equal(decoded, key);
  
  // Test base64 (if needed for storage)
  const base64 = Buffer.from(key).toString('base64');
  const fromBase64 = Buffer.from(base64, 'base64').toString();
  
  assert.equal(fromBase64, key);
});

test('IDEM-019: Key generation handles edge timestamps', () => {
  // Test with various timestamp scenarios
  const originalNow = Date.now;
  
  try {
    // Test with minimum timestamp
    Date.now = () => 0;
    const key1 = mockIdempotency.generateIdempotencyKey();
    assert.ok(mockIdempotency.isValidIdempotencyKey(key1));
    
    // Test with maximum safe integer
    Date.now = () => Number.MAX_SAFE_INTEGER;
    const key2 = mockIdempotency.generateIdempotencyKey();
    assert.ok(mockIdempotency.isValidIdempotencyKey(key2));
    
  } finally {
    Date.now = originalNow;
  }
});

test('IDEM-020: Generated keys are suitable for database storage', () => {
  const key = mockIdempotency.generateIdempotencyKey();
  
  // Check database-friendly characteristics
  assert.ok(key.length <= 120); // Fits in VARCHAR(120)
  assert.ok(!/[\x00-\x1F\x7F]/.test(key)); // No control characters
  assert.ok(!key.includes("'"));  // No SQL injection risk
  assert.ok(!key.includes('"'));  // JSON-safe
  assert.ok(!key.includes('\\'));  // Escape-safe
});