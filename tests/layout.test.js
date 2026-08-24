const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handler } = require('../server');

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

test('Store Layout: Unauthenticated access is rejected', async () => {
  const res = await callApi({ url: '/api/layout/shelves' });
  assert.equal(res.status, 401);
});

test('Store Layout: Returns standard shelf layout schema and maps batches to spatial coordinates', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // Create medicine and batch with specific location
  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Pantoprazole 40mg', genericName: 'Pantoprazole', category: 'Tablet', minimumStock: 10 }
  });
  assert.equal(medRes.status, 201);
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: { batchNumber: 'PAN-RACK-C3', quantity: 75, purchasePrice: 4, sellingPrice: 8.5, expiryDate: '2027-12-31', location: 'Rack C3' }
  });
  assert.equal(batchRes.status, 201);

  // Query layout endpoint
  const layoutRes = await callApi({ url: '/api/layout/shelves', cookie });
  assert.equal(layoutRes.status, 200);
  assert.equal(typeof layoutRes.body.layoutName, 'string');
  assert.ok(Array.isArray(layoutRes.body.shelves));
  assert.ok(layoutRes.body.shelves.length >= 14);

  // Check Rack C3 mapping
  const rackC3 = layoutRes.body.shelves.find(s => s.id === 'Rack C3');
  assert.ok(rackC3, 'Rack C3 must exist in standard pharmacy layout');
  assert.ok(rackC3.totalUnits >= 75);
  assert.ok(rackC3.totalBatches >= 1);

  const mappedBatch = rackC3.batches.find(b => b.batchNumber === 'PAN-RACK-C3');
  assert.ok(mappedBatch);
  assert.equal(mappedBatch.medicine.name, 'Pantoprazole 40mg');
  assert.equal(mappedBatch.quantity, 75);
  assert.equal(mappedBatch.expiryStatus, 'SAFE');

  // Clean up
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});

test('Store Layout: Unassigned custom locations are grouped in fallback bay', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Temporary Ingest Sample', genericName: 'Sample', minimumStock: 5 }
  });
  const medId = medRes.body.medicine.id;

  await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: { batchNumber: 'TEMP-LOT-001', quantity: 12, sellingPrice: 50, expiryDate: '2028-01-01', location: 'Backyard Quarantine Box' }
  });

  const layoutRes = await callApi({ url: '/api/layout/shelves', cookie });
  assert.equal(layoutRes.status, 200);

  const unassigned = layoutRes.body.unassigned;
  assert.ok(unassigned);
  const found = unassigned.batches.find(b => b.batchNumber === 'TEMP-LOT-001');
  assert.ok(found, 'Custom location should be present in unassigned storage bay');

  // Clean up
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});
