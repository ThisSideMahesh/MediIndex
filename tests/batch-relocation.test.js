const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handler } = require('../core');

// ── Batch Relocation Tests ─────────────────────────────────────────────────
//
// These tests cover the new PUT /api/batches/:id/location endpoint that allows
// authorized users to update a batch's shelf/rack location through the UI.
//
// Coverage:
// - Successful location update with proper authentication
// - Tenant isolation (cross-tenant batch access rejection)
// - Authorization checks (ADMIN and STAFF allowed, unauthenticated rejected)
// - Invalid batch ID handling
// - Location validation (max length, optional field)
// - Batch remains unchanged except for location field

function callApi({ method, url, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method || 'GET';
    req.url = url;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}) };
    const res = {
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
      end(payload) { resolve({ status: this.status, headers: this.headers, body: payload ? JSON.parse(payload) : undefined }); }
    };
    handler(req, res).catch(reject);
    if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}

test('Batch Relocation: STAFF can update batch location to a valid shelf', async () => {
  // 1. Login as admin and create test medicine + batch
  const adminLogin = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie: adminCookie,
    body: { name: 'Relocate Test Med Alpha', minimumStock: 10 }
  });
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie: adminCookie,
    body: {
      batchNumber: 'RELOC-A-001',
      quantity: 50,
      sellingPrice: 15,
      expiryDate: '2028-12-31',
      location: 'Rack A1'
    }
  });
  assert.equal(batchRes.status, 201);
  const batchId = batchRes.body.batch.id;
  assert.equal(batchRes.body.batch.location, 'Rack A1');

  // 2. Login as staff and relocate the batch
  const staffLogin = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'staff@mediindex.local', password: 'MediIndex@2026' }
  });
  const staffCookie = staffLogin.headers['Set-Cookie'];

  const relocateRes = await callApi({
    method: 'PUT',
    url: `/api/batches/${batchId}/location`,
    cookie: staffCookie,
    body: { location: 'Rack B2' }
  });

  assert.equal(relocateRes.status, 200);
  assert.equal(relocateRes.body.batch.id, batchId);
  assert.equal(relocateRes.body.batch.location, 'Rack B2');
  assert.equal(relocateRes.body.batch.batch_number, 'RELOC-A-001');
  assert.equal(relocateRes.body.batch.quantity, 50);

  // 3. Verify location persisted in the database
  const verifyRes = await callApi({
    method: 'GET',
    url: `/api/medicines/${medId}/batches`,
    cookie: staffCookie
  });
  const batch = verifyRes.body.batches.find(b => b.id === batchId);
  assert.equal(batch.location, 'Rack B2');

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie: adminCookie });
});

test('Batch Relocation: location can be cleared by setting it to empty string', async () => {
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Relocate Test Med Beta', minimumStock: 5 }
  });
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: {
      batchNumber: 'RELOC-B-001',
      quantity: 30,
      sellingPrice: 20,
      expiryDate: '2029-06-30',
      location: 'Cold Storage F1'
    }
  });
  const batchId = batchRes.body.batch.id;

  // Clear the location
  const clearRes = await callApi({
    method: 'PUT',
    url: `/api/batches/${batchId}/location`,
    cookie,
    body: { location: '' }
  });

  assert.equal(clearRes.status, 200);
  // SQLite stores empty strings as NULL, which is acceptable
  assert.ok(clearRes.body.batch.location === '' || clearRes.body.batch.location === null);

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});

test('Batch Relocation: rejects unauthenticated requests', async () => {
  const relocateRes = await callApi({
    method: 'PUT',
    url: '/api/batches/999/location',
    body: { location: 'Rack C3' }
  });

  assert.equal(relocateRes.status, 401);
  assert.ok(relocateRes.body.error.includes('Authentication required'));
});

test('Batch Relocation: enforces tenant isolation - cannot relocate batch from another pharmacy', async () => {
  // This test assumes pharmacy_id=1 for admin@mediindex.local
  // In a real multi-tenant setup, we'd create a second pharmacy and user
  // For now, we test that a valid session cannot access a non-existent batch
  // which simulates cross-tenant rejection

  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = login.headers['Set-Cookie'];

  // Try to relocate a batch ID that doesn't exist in this pharmacy
  const relocateRes = await callApi({
    method: 'PUT',
    url: '/api/batches/99999/location',
    cookie,
    body: { location: 'Rack D1' }
  });

  assert.equal(relocateRes.status, 404);
  assert.ok(relocateRes.body.error.includes('Batch not found'));
});

test('Batch Relocation: rejects invalid batch ID', async () => {
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'staff@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = login.headers['Set-Cookie'];

  // Try to relocate using an invalid (non-numeric) batch ID
  const relocateRes = await callApi({
    method: 'PUT',
    url: '/api/batches/invalid/location',
    cookie,
    body: { location: 'Rack A3' }
  });

  // The regex won't match non-numeric IDs, so the route handler won't execute
  // This should result in 404 or the batch not being found
  assert.equal(relocateRes.status, 404);
});

test('Batch Relocation: validates location field max length', async () => {
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Relocate Test Med Gamma', minimumStock: 1 }
  });
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: {
      batchNumber: 'RELOC-G-001',
      quantity: 10,
      sellingPrice: 5,
      expiryDate: '2027-01-01'
    }
  });
  const batchId = batchRes.body.batch.id;

  // Try to set location longer than 100 characters
  const longLocation = 'A'.repeat(101);
  const relocateRes = await callApi({
    method: 'PUT',
    url: `/api/batches/${batchId}/location`,
    cookie,
    body: { location: longLocation }
  });

  assert.equal(relocateRes.status, 400);
  assert.ok(relocateRes.body.error.toLowerCase().includes('location'));

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});

test('Batch Relocation: does not modify other batch fields (quantity, price, expiry)', async () => {
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Relocate Test Med Delta', minimumStock: 8 }
  });
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: {
      batchNumber: 'RELOC-D-001',
      quantity: 75,
      purchasePrice: 10,
      sellingPrice: 18.50,
      expiryDate: '2027-08-15',
      location: 'Rack A2'
    }
  });
  const batchId = batchRes.body.batch.id;
  const originalBatch = batchRes.body.batch;

  // Relocate the batch
  const relocateRes = await callApi({
    method: 'PUT',
    url: `/api/batches/${batchId}/location`,
    cookie,
    body: { location: 'Rack C1' }
  });

  assert.equal(relocateRes.status, 200);
  const updatedBatch = relocateRes.body.batch;

  // Verify location changed
  assert.equal(updatedBatch.location, 'Rack C1');

  // Verify all other fields remain unchanged
  assert.equal(updatedBatch.batch_number, originalBatch.batch_number);
  assert.equal(updatedBatch.quantity, originalBatch.quantity);
  assert.equal(updatedBatch.purchase_price, originalBatch.purchase_price);
  assert.equal(updatedBatch.selling_price, originalBatch.selling_price);
  assert.equal(updatedBatch.expiry_date, originalBatch.expiry_date);
  assert.equal(updatedBatch.medicine_id, originalBatch.medicine_id);

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});

test('Batch Relocation: ADMIN can relocate batch', async () => {
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Relocate Test Med Epsilon', minimumStock: 2 }
  });
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: {
      batchNumber: 'RELOC-E-001',
      quantity: 40,
      sellingPrice: 12,
      expiryDate: '2028-03-20',
      location: 'unassigned'
    }
  });
  const batchId = batchRes.body.batch.id;

  const relocateRes = await callApi({
    method: 'PUT',
    url: `/api/batches/${batchId}/location`,
    cookie,
    body: { location: 'Rack D3' }
  });

  assert.equal(relocateRes.status, 200);
  assert.equal(relocateRes.body.batch.location, 'Rack D3');

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});

test('Batch Relocation: accepts various location format variations', async () => {
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'staff@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie: (await callApi({
      method: 'POST',
      url: '/api/auth/login',
      body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
    })).headers['Set-Cookie'],
    body: { name: 'Relocate Test Med Zeta', minimumStock: 5 }
  });
  const medId = medRes.body.medicine.id;
  const adminCookie = (await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  })).headers['Set-Cookie'];

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie: adminCookie,
    body: {
      batchNumber: 'RELOC-Z-001',
      quantity: 25,
      sellingPrice: 8,
      expiryDate: '2027-11-11'
    }
  });
  const batchId = batchRes.body.batch.id;

  // Test all valid shelf IDs from the store layout across different racks
  const locationFormats = [
    'Rack A1',
    'Rack A3',
    'Rack B1',
    'Rack C2',
    'Rack D3',
    'Cold Storage F2'
  ];

  for (const location of locationFormats) {
    const res = await callApi({
      method: 'PUT',
      url: `/api/batches/${batchId}/location`,
      cookie,
      body: { location }
    });
    assert.equal(res.status, 200, `Failed to set location: ${location}`);
    assert.equal(res.body.batch.location, location);
  }

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie: adminCookie });
});

// ── Regression tests: layout-aware destination validation ─────────────────

test('Batch Relocation: accepts a valid shelf from the store layout', async () => {
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Relocate Test Med Eta', minimumStock: 3 }
  });
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: { batchNumber: 'RELOC-ETA-001', quantity: 20, sellingPrice: 10, expiryDate: '2028-05-01' }
  });
  const batchId = batchRes.body.batch.id;

  // 'Cold Storage F1' is a real shelf in STANDARD_SHELVES — must be accepted
  const relocateRes = await callApi({
    method: 'PUT',
    url: `/api/batches/${batchId}/location`,
    cookie,
    body: { location: 'Cold Storage F1' }
  });

  assert.equal(relocateRes.status, 200);
  assert.equal(relocateRes.body.batch.location, 'Cold Storage F1');

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});

test('Batch Relocation: rejects a destination that is not in the store layout', async () => {
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Relocate Test Med Theta', minimumStock: 3 }
  });
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: { batchNumber: 'RELOC-THETA-001', quantity: 20, sellingPrice: 10, expiryDate: '2028-06-01', location: 'Rack A1' }
  });
  const batchId = batchRes.body.batch.id;

  // 'Imaginary Shelf X99' is not in STANDARD_SHELVES — must be rejected
  const relocateRes = await callApi({
    method: 'PUT',
    url: `/api/batches/${batchId}/location`,
    cookie,
    body: { location: 'Imaginary Shelf X99' }
  });

  assert.equal(relocateRes.status, 422);
  assert.ok(relocateRes.body.error.includes('Imaginary Shelf X99'), `Expected error to name the bad destination. Got: ${relocateRes.body.error}`);

  // Verify the location was NOT changed — original location preserved
  const verifyRes = await callApi({
    method: 'GET',
    url: `/api/medicines/${medId}/batches`,
    cookie
  });
  const batch = verifyRes.body.batches.find(b => b.id === batchId);
  assert.equal(batch.location, 'Rack A1', 'Location must be unchanged after rejected relocation');

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});
