/**
 * READ-ONLY Production Database Audit
 * 
 * Audits current production data without exposing secrets.
 * Safe for execution - performs only SELECT queries.
 */

const { createDatabaseAdapter } = require('../db/index');

async function auditProductionDatabase() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is required');
    process.exit(1);
  }

  const db = createDatabaseAdapter({}).initialize();
  
  if (db.type !== 'postgres') {
    console.error('ERROR: This script requires PostgreSQL (DATABASE_URL must be set)');
    process.exit(1);
  }

  await db.ensureSchema();

  console.log('='.repeat(80));
  console.log('MEDIINDEX PRODUCTION DATABASE AUDIT (READ-ONLY)');
  console.log('='.repeat(80));
  console.log('');

  // 1. Pharmacies
  console.log('1. PHARMACIES');
  console.log('-'.repeat(80));
  const pharmacies = await db.query('SELECT id, name, address, latitude, longitude, active, created_at FROM pharmacies ORDER BY id');
  console.log(`Total pharmacies: ${pharmacies.length}`);
  if (pharmacies.length > 0) {
    pharmacies.forEach(p => {
      console.log(`  [${p.id}] ${p.name}`);
      console.log(`      Address: ${p.address || 'N/A'}`);
      console.log(`      Coordinates: ${p.latitude}, ${p.longitude}`);
      console.log(`      Active: ${p.active === 1 ? 'Yes' : 'No'}`);
      console.log(`      Created: ${p.created_at}`);
    });
  }
  console.log('');

  // 2. Users
  console.log('2. USERS');
  console.log('-'.repeat(80));
  const users = await db.query('SELECT id, pharmacy_id, full_name, email, role, active, created_at, last_login_at FROM users ORDER BY pharmacy_id, role, id');
  console.log(`Total users: ${users.length}`);
  if (users.length > 0) {
    users.forEach(u => {
      console.log(`  [${u.id}] ${u.email} (${u.role})`);
      console.log(`      Name: ${u.full_name}`);
      console.log(`      Pharmacy ID: ${u.pharmacy_id}`);
      console.log(`      Active: ${u.active === 1 ? 'Yes' : 'No'}`);
      console.log(`      Last Login: ${u.last_login_at || 'Never'}`);
    });
  }
  console.log('');

  // 3. Sessions
  console.log('3. SESSIONS');
  console.log('-'.repeat(80));
  const sessions = await db.query('SELECT COUNT(*) as count FROM sessions');
  const activeSessions = await db.query('SELECT COUNT(*) as count FROM sessions WHERE expires_at > NOW()');
  console.log(`Total sessions: ${sessions[0].count}`);
  console.log(`Active sessions: ${activeSessions[0].count}`);
  console.log('');

  // 4. Medicines
  console.log('4. MEDICINES');
  console.log('-'.repeat(80));
  const medicinesByPharmacy = await db.query(`
    SELECT pharmacy_id, COUNT(*) as count 
    FROM medicines 
    WHERE active = 1 
    GROUP BY pharmacy_id 
    ORDER BY pharmacy_id
  `);
  const totalMedicines = await db.query('SELECT COUNT(*) as count FROM medicines WHERE active = 1');
  console.log(`Total active medicines: ${totalMedicines[0].count}`);
  medicinesByPharmacy.forEach(m => {
    console.log(`  Pharmacy ${m.pharmacy_id}: ${m.count} medicines`);
  });
  
  if (totalMedicines[0].count > 0) {
    const sampleMedicines = await db.query(`
      SELECT id, pharmacy_id, name, generic_name, category, manufacturer, minimum_stock
      FROM medicines 
      WHERE active = 1 
      ORDER BY pharmacy_id, name 
      LIMIT 10
    `);
    console.log('  Sample medicines (first 10):');
    sampleMedicines.forEach(m => {
      console.log(`    [${m.id}] ${m.name} (Pharmacy ${m.pharmacy_id})`);
      console.log(`        Generic: ${m.generic_name || 'N/A'}`);
      console.log(`        Category: ${m.category || 'N/A'}`);
      console.log(`        Manufacturer: ${m.manufacturer || 'N/A'}`);
      console.log(`        Min Stock: ${m.minimum_stock}`);
    });
  }
  console.log('');

  // 5. Medicine Batches
  console.log('5. MEDICINE BATCHES');
  console.log('-'.repeat(80));
  const batches = await db.query(`
    SELECT 
      mb.medicine_id,
      m.pharmacy_id,
      COUNT(*) as batch_count,
      SUM(mb.quantity) as total_quantity
    FROM medicine_batches mb
    JOIN medicines m ON m.id = mb.medicine_id
    GROUP BY mb.medicine_id, m.pharmacy_id
    ORDER BY m.pharmacy_id, mb.medicine_id
  `);
  const totalBatches = await db.query('SELECT COUNT(*) as count, SUM(quantity) as total_qty FROM medicine_batches');
  console.log(`Total batches: ${totalBatches[0].count}`);
  console.log(`Total stock quantity: ${totalBatches[0].total_qty || 0}`);
  
  if (batches.length > 0) {
    console.log('  Stock by pharmacy:');
    const pharmacyTotals = {};
    batches.forEach(b => {
      if (!pharmacyTotals[b.pharmacy_id]) {
        pharmacyTotals[b.pharmacy_id] = { batches: 0, quantity: 0 };
      }
      pharmacyTotals[b.pharmacy_id].batches += parseInt(b.batch_count);
      pharmacyTotals[b.pharmacy_id].quantity += parseInt(b.total_quantity);
    });
    Object.keys(pharmacyTotals).forEach(pid => {
      console.log(`    Pharmacy ${pid}: ${pharmacyTotals[pid].batches} batches, ${pharmacyTotals[pid].quantity} units`);
    });
  }
  console.log('');

  // 6. Inventory Movements
  console.log('6. INVENTORY MOVEMENTS');
  console.log('-'.repeat(80));
  const movements = await db.query(`
    SELECT reason, COUNT(*) as count, SUM(ABS(change_quantity)) as total_qty
    FROM inventory_movements
    GROUP BY reason
    ORDER BY reason
  `);
  const totalMovements = await db.query('SELECT COUNT(*) as count FROM inventory_movements');
  console.log(`Total movements: ${totalMovements[0].count}`);
  movements.forEach(m => {
    console.log(`  ${m.reason}: ${m.count} movements, ${m.total_qty} units`);
  });
  console.log('');

  // 7. Sales
  console.log('7. SALES');
  console.log('-'.repeat(80));
  const salesByPharmacy = await db.query(`
    SELECT pharmacy_id, COUNT(*) as sale_count, SUM(total_amount) as revenue
    FROM sales
    GROUP BY pharmacy_id
    ORDER BY pharmacy_id
  `);
  const totalSales = await db.query('SELECT COUNT(*) as count, SUM(total_amount) as revenue FROM sales');
  console.log(`Total sales: ${totalSales[0].count}`);
  console.log(`Total revenue: ₹${parseFloat(totalSales[0].revenue || 0).toFixed(2)}`);
  salesByPharmacy.forEach(s => {
    console.log(`  Pharmacy ${s.pharmacy_id}: ${s.sale_count} sales, ₹${parseFloat(s.revenue).toFixed(2)}`);
  });
  console.log('');

  // 8. Sale Items
  console.log('8. SALE ITEMS');
  console.log('-'.repeat(80));
  const saleItems = await db.query('SELECT COUNT(*) as count, SUM(quantity) as total_qty FROM sale_items');
  console.log(`Total sale items: ${saleItems[0].count}`);
  console.log(`Total units sold: ${saleItems[0].total_qty || 0}`);
  console.log('');

  // 9. Expiry Alerts
  console.log('9. EXPIRY ALERTS');
  console.log('-'.repeat(80));
  const alertsByType = await db.query(`
    SELECT alert_type, acknowledged, COUNT(*) as count
    FROM expiry_alerts
    GROUP BY alert_type, acknowledged
    ORDER BY alert_type, acknowledged
  `);
  const totalAlerts = await db.query('SELECT COUNT(*) as count FROM expiry_alerts');
  console.log(`Total alerts: ${totalAlerts[0].count}`);
  alertsByType.forEach(a => {
    console.log(`  ${a.alert_type} (${a.acknowledged === 1 ? 'Acknowledged' : 'Active'}): ${a.count}`);
  });
  console.log('');

  // 10. Paired Devices
  console.log('10. PAIRED DEVICES');
  console.log('-'.repeat(80));
  const devices = await db.query(`
    SELECT pharmacy_id, COUNT(*) as count, SUM(CASE WHEN revoked = 0 THEN 1 ELSE 0 END) as active_count
    FROM paired_devices
    GROUP BY pharmacy_id
    ORDER BY pharmacy_id
  `);
  const totalDevices = await db.query('SELECT COUNT(*) as count FROM paired_devices WHERE revoked = 0');
  console.log(`Total active devices: ${totalDevices[0].count}`);
  devices.forEach(d => {
    console.log(`  Pharmacy ${d.pharmacy_id}: ${d.active_count} active, ${d.count} total`);
  });
  console.log('');

  // 11. Device Pairing Codes
  console.log('11. DEVICE PAIRING CODES');
  console.log('-'.repeat(80));
  const pairingCodes = await db.query(`
    SELECT COUNT(*) as total, SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) as used_count
    FROM device_pairing_codes
  `);
  console.log(`Total pairing codes: ${pairingCodes[0].total}`);
  console.log(`Used codes: ${pairingCodes[0].used_count}`);
  console.log('');

  // 12. Idempotency Keys
  console.log('12. IDEMPOTENCY KEYS');
  console.log('-'.repeat(80));
  const idempotencyKeys = await db.query('SELECT COUNT(*) as count FROM idempotency_keys');
  console.log(`Total idempotency keys: ${idempotencyKeys[0].count}`);
  console.log('');

  // 13. Medicine Redistribution Requests
  console.log('13. MEDICINE REDISTRIBUTION REQUESTS (Near-Expiry)');
  console.log('-'.repeat(80));
  const redistRequests = await db.query(`
    SELECT status, COUNT(*) as count
    FROM medicine_redistribution_requests
    GROUP BY status
    ORDER BY status
  `);
  const totalRedist = await db.query('SELECT COUNT(*) as count FROM medicine_redistribution_requests');
  console.log(`Total redistribution requests: ${totalRedist[0].count}`);
  redistRequests.forEach(r => {
    console.log(`  ${r.status}: ${r.count}`);
  });
  console.log('');

  // 14. Medicine Requests (Manual)
  console.log('14. MEDICINE REQUESTS (Manual Inter-Pharmacy)');
  console.log('-'.repeat(80));
  const medRequests = await db.query(`
    SELECT status, COUNT(*) as count
    FROM medicine_requests
    GROUP BY status
    ORDER BY status
  `);
  const totalMedReq = await db.query('SELECT COUNT(*) as count FROM medicine_requests');
  console.log(`Total medicine requests: ${totalMedReq[0].count}`);
  medRequests.forEach(r => {
    console.log(`  ${r.status}: ${r.count}`);
  });
  console.log('');

  // 15. Medicine Request Offers
  console.log('15. MEDICINE REQUEST OFFERS');
  console.log('-'.repeat(80));
  const offers = await db.query(`
    SELECT status, COUNT(*) as count
    FROM medicine_request_offers
    GROUP BY status
    ORDER BY status
  `);
  const totalOffers = await db.query('SELECT COUNT(*) as count FROM medicine_request_offers');
  console.log(`Total offers: ${totalOffers[0].count}`);
  offers.forEach(o => {
    console.log(`  ${o.status}: ${o.count}`);
  });
  console.log('');

  // Summary
  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Pharmacies: ${pharmacies.length}`);
  console.log(`Users: ${users.length}`);
  console.log(`Active Sessions: ${activeSessions[0].count}`);
  console.log(`Medicines: ${totalMedicines[0].count}`);
  console.log(`Batches: ${totalBatches[0].count}`);
  console.log(`Inventory Movements: ${totalMovements[0].count}`);
  console.log(`Sales: ${totalSales[0].count}`);
  console.log(`Sale Items: ${saleItems[0].count}`);
  console.log(`Expiry Alerts: ${totalAlerts[0].count}`);
  console.log(`Active Devices: ${totalDevices[0].count}`);
  console.log(`Redistribution Requests: ${totalRedist[0].count}`);
  console.log(`Medicine Requests: ${totalMedReq[0].count}`);
  console.log(`Medicine Request Offers: ${totalOffers[0].count}`);
  console.log('='.repeat(80));

  await db.close();
}

auditProductionDatabase().catch(err => {
  console.error('AUDIT FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
