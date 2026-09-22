/**
 * QR Parser Tests
 * 
 * Tests the mobile QR parser that reuses backend semantics.
 * Validates both JSON and pipe formats as supported by the backend.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Since we're testing the mobile TypeScript code from Node.js,
// we need to load the compiled JavaScript or simulate the behavior
// For now, we'll test the backend QR parser which has the same logic

const { parseAndValidateQrPayload } = require('../../core.js');

test('QR-TEST-001: valid JSON QR parses correctly', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 123,
    batchNumber: 'BATCH001'
  };
  
  const result = parseAndValidateQrPayload(qrPayload);
  assert.equal(result.medicineId, 123);
  assert.equal(result.batchNumber, 'BATCH001');
});

test('QR-TEST-002: correct app accepted', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 456,
    batchNumber: 'BATCH002'
  };
  
  const result = parseAndValidateQrPayload(qrPayload);
  assert.equal(result.medicineId, 456);
});

test('QR-TEST-003: supported version accepted', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 789,
    batchNumber: 'BATCH003'
  };
  
  const result = parseAndValidateQrPayload(qrPayload);
  assert.equal(result.medicineId, 789);
});

test('QR-TEST-004: medicineId extracted correctly', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 42,
    batchNumber: 'TEST'
  };
  
  const result = parseAndValidateQrPayload(qrPayload);
  assert.equal(result.medicineId, 42);
});

test('QR-TEST-005: batchNumber extracted correctly', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 1,
    batchNumber: 'SPECIAL_BATCH_123'
  };
  
  const result = parseAndValidateQrPayload(qrPayload);
  assert.equal(result.batchNumber, 'SPECIAL_BATCH_123');
});

test('QR-TEST-006: malformed JSON rejected', () => {
  assert.throws(() => {
    parseAndValidateQrPayload('{ invalid json');
  }, /not recognized as a valid MediIndex code/);
});

test('QR-TEST-007: non-object rejected', () => {
  assert.throws(() => {
    parseAndValidateQrPayload('just a string');
  }, /not recognized as a valid MediIndex code/);
});

test('QR-TEST-008: wrong app rejected', () => {
  const qrPayload = {
    app: 'WRONG_APP',
    v: 1,
    medicineId: 1,
    batchNumber: 'BATCH'
  };
  
  assert.throws(() => {
    parseAndValidateQrPayload(qrPayload);
  }, /Unrecognized application tag/);
});

test('QR-TEST-009: unsupported version rejected', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 2,
    medicineId: 1,
    batchNumber: 'BATCH'
  };
  
  assert.throws(() => {
    parseAndValidateQrPayload(qrPayload);
  }, /Unsupported QR version: 2/);
});

test('QR-TEST-010: missing medicineId rejected', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    batchNumber: 'BATCH'
  };
  
  assert.throws(() => {
    parseAndValidateQrPayload(qrPayload);
  }, /Invalid medicine ID/);
});

test('QR-TEST-011: invalid medicineId rejected', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 'not_a_number',
    batchNumber: 'BATCH'
  };
  
  assert.throws(() => {
    parseAndValidateQrPayload(qrPayload);
  }, /Invalid medicine ID/);
});

test('QR-TEST-012: missing batch rejected', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 1
  };
  
  assert.throws(() => {
    parseAndValidateQrPayload(qrPayload);
  }, /Batch number is required/);
});

test('QR-TEST-013: empty batch rejected', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 1,
    batchNumber: ''
  };
  
  assert.throws(() => {
    parseAndValidateQrPayload(qrPayload);
  }, /Batch number is required/);  // Fixed: matches actual backend error
});

test('QR-TEST-014: pipe format parses correctly', () => {
  const pipeFormat = 'MEDIINDEX|v1|123|BATCH001';
  const result = parseAndValidateQrPayload(pipeFormat);
  
  assert.equal(result.medicineId, 123);
  assert.equal(result.batchNumber, 'BATCH001');
});

test('QR-TEST-015: pipe format with extra fields ignored', () => {
  const pipeFormat = 'MEDIINDEX|v1|456|BATCH002|extra|fields|ignored';
  const result = parseAndValidateQrPayload(pipeFormat);
  
  assert.equal(result.medicineId, 456);
  assert.equal(result.batchNumber, 'BATCH002');
});

test('QR-TEST-016: invalid pipe format rejected', () => {
  assert.throws(() => {
    parseAndValidateQrPayload('WRONG|v1|123|BATCH');
  }, /not recognized as a valid MediIndex code/);
});

test('QR-TEST-017: short pipe format rejected', () => {
  assert.throws(() => {
    parseAndValidateQrPayload('MEDIINDEX|v1|123');
  }, /not recognized as a valid MediIndex code/);
});

test('QR-TEST-018: zero medicineId rejected', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 0,
    batchNumber: 'BATCH'
  };
  
  assert.throws(() => {
    parseAndValidateQrPayload(qrPayload);
  }, /Invalid medicine ID/);
});

test('QR-TEST-019: negative medicineId rejected', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: -1,
    batchNumber: 'BATCH'
  };
  
  assert.throws(() => {
    parseAndValidateQrPayload(qrPayload);
  }, /Invalid medicine ID/);
});

test('QR-TEST-020: float medicineId rejected', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 1.5,
    batchNumber: 'BATCH'
  };
  
  assert.throws(() => {
    parseAndValidateQrPayload(qrPayload);
  }, /Invalid medicine ID/);
});

test('QR-TEST-021: batch number length limit enforced', () => {
  const longBatch = 'B'.repeat(81); // Exceeds 80 char limit
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 1,
    batchNumber: longBatch
  };
  
  assert.throws(() => {
    parseAndValidateQrPayload(qrPayload);
  }, /must be valid text up to 80 characters/);  // Fixed: matches actual backend error
});

test('QR-TEST-022: whitespace in batch number trimmed', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 1,
    batchNumber: '  BATCH123  '
  };
  
  const result = parseAndValidateQrPayload(qrPayload);
  assert.equal(result.batchNumber, 'BATCH123');
});

test('QR-TEST-023: case sensitivity preserved in batch number', () => {
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 1,
    batchNumber: 'Batch123ABC'
  };
  
  const result = parseAndValidateQrPayload(qrPayload);
  assert.equal(result.batchNumber, 'Batch123ABC');
});

test('QR-TEST-024: null payload rejected', () => {
  assert.throws(() => {
    parseAndValidateQrPayload(null);
  }, /Invalid QR payload structure/);
});

test('QR-TEST-025: undefined payload rejected', () => {
  assert.throws(() => {
    parseAndValidateQrPayload(undefined);
  }, /Invalid QR payload structure/);
});

test('QR-TEST-026: numeric string medicineId accepted in pipe format', () => {
  const pipeFormat = 'MEDIINDEX|v1|999|BATCH999';
  const result = parseAndValidateQrPayload(pipeFormat);
  
  assert.equal(result.medicineId, 999);
  assert.equal(result.batchNumber, 'BATCH999');
});

test('QR-TEST-027: version without v prefix accepted in pipe format', () => {
  const pipeFormat = 'MEDIINDEX|1|888|BATCH888';
  const result = parseAndValidateQrPayload(pipeFormat);
  
  assert.equal(result.medicineId, 888);
  assert.equal(result.batchNumber, 'BATCH888');
});

test('QR-TEST-028: JSON string input parsed correctly', () => {
  const jsonString = JSON.stringify({
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 777,
    batchNumber: 'BATCH777'
  });
  
  const result = parseAndValidateQrPayload(jsonString);
  assert.equal(result.medicineId, 777);
  assert.equal(result.batchNumber, 'BATCH777');
});

test('QR-TEST-029: whitespace around JSON string handled', () => {
  const jsonString = '  \n' + JSON.stringify({
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 666,
    batchNumber: 'BATCH666'
  }) + '\n  ';
  
  const result = parseAndValidateQrPayload(jsonString);
  assert.equal(result.medicineId, 666);
  assert.equal(result.batchNumber, 'BATCH666');
});

test('QR-TEST-030: QR cannot contain malicious code', () => {
  // Ensure QR parsing doesn't execute any code
  const maliciousPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: 1,
    batchNumber: 'BATCH',
    // Additional fields that might contain malicious content are ignored
    script: '<script>alert("xss")</script>',
    eval: 'process.exit(1)',
    constructor: 'Function("return process")().exit(1)'
  };
  
  const result = parseAndValidateQrPayload(maliciousPayload);
  assert.equal(result.medicineId, 1);
  assert.equal(result.batchNumber, 'BATCH');
  // Only medicineId and batchNumber should be returned
  assert.equal(Object.keys(result).length, 2);
});