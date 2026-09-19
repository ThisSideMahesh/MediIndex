const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handler } = require('../core');

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

test('Point of Sale (POS) FEFO multi-batch sale, stock deduction, and invoice generation', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // 1. Create a test medicine
  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Amoxicillin 500mg', genericName: 'Amoxicillin', manufacturer: 'Cipla', category: 'Capsule', minimumStock: 5 }
  });
  assert.equal(medRes.status, 201);
  const medId = medRes.body.medicine.id;

  // 2. Add two batches with different expiry dates:
  // Batch 1: Expiring in 2 months (quantity 10, sellingPrice 12.5)
  // Batch 2: Expiring in 12 months (quantity 20, sellingPrice 12.5)
  const batch1Res = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: { batchNumber: 'AMOX-2026-EARLY', quantity: 10, purchasePrice: 8, sellingPrice: 12.5, expiryDate: '2026-11-01', location: 'Rack A1' }
  });
  assert.equal(batch1Res.status, 201);
  const batch1Id = batch1Res.body.batch.id;

  const batch2Res = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: { batchNumber: 'AMOX-2027-LATE', quantity: 20, purchasePrice: 8, sellingPrice: 12.5, expiryDate: '2027-11-01', location: 'Rack A2' }
  });
  assert.equal(batch2Res.status, 201);
  const batch2Id = batch2Res.body.batch.id;

  // 3. Perform a sale of 15 units without specifying batch (FEFO should take 10 from Batch 1, 5 from Batch 2)
  const saleRes = await callApi({
    method: 'POST',
    url: '/api/sales',
    cookie,
    body: {
      customerName: 'Anil Sharma',
      customerPhone: '9822012345',
      paymentMethod: 'UPI',
      items: [{ medicineId: medId, quantity: 15 }]
    }
  });

  assert.equal(saleRes.status, 201);
  assert.ok(saleRes.body.sale.invoice_number.startsWith('INV-'));
  assert.equal(saleRes.body.sale.total_amount, 187.5);
  assert.equal(saleRes.body.sale.items.length, 2);
  assert.equal(saleRes.body.sale.items[0].batchNumber, 'AMOX-2026-EARLY');
  assert.equal(saleRes.body.sale.items[0].quantity, 10);
  assert.equal(saleRes.body.sale.items[1].batchNumber, 'AMOX-2027-LATE');
  assert.equal(saleRes.body.sale.items[1].quantity, 5);

  // 4. Verify batch stock balances
  const batchesRes = await callApi({ url: `/api/medicines/${medId}/batches`, cookie });
  const b1 = batchesRes.body.batches.find(b => b.id === batch1Id);
  const b2 = batchesRes.body.batches.find(b => b.id === batch2Id);
  assert.equal(b1.quantity, 0);
  assert.equal(b2.quantity, 15);

  // 5. Test overselling rollback: request 25 units when only 15 exist
  const failedSale = await callApi({
    method: 'POST',
    url: '/api/sales',
    cookie,
    body: {
      customerName: 'Failed Order',
      items: [{ medicineId: medId, quantity: 25 }]
    }
  });
  assert.equal(failedSale.status, 400);
  assert.match(failedSale.body.error, /Insufficient stock/);

  // Stock should remain unchanged (15 units)
  const batchesAfterFailed = await callApi({ url: `/api/medicines/${medId}/batches`, cookie });
  const b2After = batchesAfterFailed.body.batches.find(b => b.id === batch2Id);
  assert.equal(b2After.quantity, 15);

  // 6. Test Sales History & Invoice details retrieval
  const salesList = await callApi({ url: '/api/sales', cookie });
  assert.equal(salesList.status, 200);
  assert.ok(salesList.body.sales.length >= 1);
  const foundSale = salesList.body.sales.find(s => s.id === saleRes.body.sale.id);
  assert.equal(foundSale.customer_name, 'Anil Sharma');

  const saleDetail = await callApi({ url: `/api/sales/${saleRes.body.sale.id}`, cookie });
  assert.equal(saleDetail.status, 200);
  assert.equal(saleDetail.body.sale.items.length, 2);

  // Clean up test medicine
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});

test('Point of Sale prevents selling expired batches', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Expired Drug Test', minimumStock: 1 }
  });
  const medId = medRes.body.medicine.id;

  const expiredBatch = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: { batchNumber: 'EXP-BATCH-99', quantity: 5, sellingPrice: 50, expiryDate: '2021-01-01' }
  });
  const expiredBatchId = expiredBatch.body.batch.id;

  // Auto FEFO should see 0 valid non-expired stock
  const fefoSale = await callApi({
    method: 'POST',
    url: '/api/sales',
    cookie,
    body: { items: [{ medicineId: medId, quantity: 2 }] }
  });
  assert.equal(fefoSale.status, 400);

  // Explicit expired batch request should be rejected with expired error
  const directSale = await callApi({
    method: 'POST',
    url: '/api/sales',
    cookie,
    body: { items: [{ medicineId: medId, batchId: expiredBatchId, quantity: 1 }] }
  });
  assert.equal(directSale.status, 400);
  assert.match(directSale.body.error, /expired/i);

  // Clean up
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});
