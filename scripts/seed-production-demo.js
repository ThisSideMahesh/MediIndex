/**
 * MediIndex Production Demo Database Seeding Script
 * B.Tech Major Project Presentation
 * 
 * SAFETY:
 * - Uses transactions (ROLLBACK on error)
 * - Validates empty database before seeding
 * - No schema modifications
 * - Maintains tenant isolation
 * - Passwords properly hashed
 * - No secrets exposed
 */

const crypto = require('crypto');
const { createDatabaseAdapter } = require('../db/index');

// Password hashing (from core.js)
function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Date helpers
function getDate(daysOffset) {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  return date.toISOString().split('T')[0];
}

async function seedProductionDemo() {
  console.log('='.repeat(80));
  console.log('MEDIINDEX PRODUCTION DEMO DATABASE SEEDING');
  console.log('B.Tech Major Project Presentation');
  console.log('='.repeat(80));
  console.log('');

  if (!process.env.DATABASE_URL) {
    console.error('❌ ERROR: DATABASE_URL is required for production seeding');
    process.exit(1);
  }

  const db = createDatabaseAdapter({}).initialize();
  
  if (db.type !== 'postgres') {
    console.error('❌ ERROR: This script requires PostgreSQL');
    process.exit(1);
  }

  await db.ensureSchema();

  console.log('✓ Connected to PostgreSQL');
  console.log('');

  // PHASE 1: Safety Check
  console.log('PHASE 1: Pre-Seed Safety Check');
  console.log('-'.repeat(80));

  const tables = [
    'pharmacies', 'users', 'sessions', 'medicines', 'medicine_batches',
    'inventory_movements', 'sales', 'sale_items', 'expiry_alerts',
    'paired_devices', 'device_pairing_codes', 'idempotency_keys',
    'medicine_redistribution_requests', 'medicine_requests', 'medicine_request_offers'
  ];

  for (const table of tables) {
    const count = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
    const rowCount = parseInt(count[0].count);
    console.log(`  ${table}: ${rowCount} rows`);
    
    if (rowCount > 0) {
      console.error(`❌ ERROR: Table ${table} is not empty (${rowCount} rows exist)`);
      console.error('Database must be empty before seeding. Aborting.');
      await db.close();
      process.exit(1);
    }
  }

  console.log('✓ All tables empty - safe to proceed');
  console.log('');

  // Begin transaction
  console.log('Starting transactional seed...');
  console.log('');

  const client = await db.getClient();
  
  try {
    await client.exec('BEGIN');

    // PHASE 2: Create Pharmacies
    console.log('PHASE 2: Creating Two Pharmacies');
    console.log('-'.repeat(80));

    const pharmacyA = await client.run(`
      INSERT INTO pharmacies (name, address, latitude, longitude, active)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `, [
      'MediIndex Pharmacy A',
      'Shop 12, Shivaji Nagar, Pune, Maharashtra 411016',
      18.530537,
      73.846474,
      1
    ]);
    const pharmacyAId = pharmacyA.rows[0].id;
    console.log(`✓ Created Pharmacy A (ID: ${pharmacyAId})`);
    console.log(`  Location: Shivaji Nagar, Pune`);
    console.log(`  Coordinates: 18.530537, 73.846474`);

    const pharmacyB = await client.run(`
      INSERT INTO pharmacies (name, address, latitude, longitude, active)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `, [
      'MediIndex Pharmacy B',
      'Plot 45, Kothrud, Pune, Maharashtra 411038',
      18.506403,
      73.808005,
      1
    ]);
    const pharmacyBId = pharmacyB.rows[0].id;
    console.log(`✓ Created Pharmacy B (ID: ${pharmacyBId})`);
    console.log(`  Location: Kothrud, Pune`);
    console.log(`  Coordinates: 18.506403, 73.808005`);
    console.log(`  Distance: ~5.2 km`);
    console.log('');

    // PHASE 3: Create Users
    console.log('PHASE 3: Creating Four Demo Users');
    console.log('-'.repeat(80));

    const demoPassword = 'Demo@12345';
    const passwordHashValue = passwordHash(demoPassword);

    const users = [
      { email: 'admin.a@mediindex.com', name: 'Admin User A', role: 'ADMIN', pharmacy: pharmacyAId },
      { email: 'staff.a@mediindex.com', name: 'Staff User A', role: 'STAFF', pharmacy: pharmacyAId },
      { email: 'admin.b@mediindex.com', name: 'Admin User B', role: 'ADMIN', pharmacy: pharmacyBId },
      { email: 'staff.b@mediindex.com', name: 'Staff User B', role: 'STAFF', pharmacy: pharmacyBId }
    ];

    const userIds = {};
    for (const user of users) {
      const result = await client.run(`
        INSERT INTO users (pharmacy_id, full_name, email, password_hash, role, active)
        VALUES (?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [user.pharmacy, user.name, user.email, passwordHashValue, user.role, 1]);
      
      userIds[user.email] = result.rows[0].id;
      console.log(`✓ Created ${user.email} (${user.role}, Pharmacy ${user.pharmacy === pharmacyAId ? 'A' : 'B'})`);
    }
    console.log('');

    // PHASE 4: Create Medicines
    console.log('PHASE 4: Creating Medicine Catalogue');
    console.log('-'.repeat(80));

    const medicineTemplate = [
      { name: 'Paracetamol 500mg', generic: 'Acetaminophen', category: 'Analgesic', manufacturer: 'Apollo Pharma', minStock: 100 },
      { name: 'Amoxicillin 500mg', generic: 'Amoxicillin', category: 'Antibiotic', manufacturer: 'Cipla Ltd', minStock: 50 },
      { name: 'Ibuprofen 400mg', generic: 'Ibuprofen', category: 'Anti-inflammatory', manufacturer: 'Sun Pharma', minStock: 80 },
      { name: 'Azithromycin 500mg', generic: 'Azithromycin', category: 'Antibiotic', manufacturer: 'Lupin Ltd', minStock: 30 },
      { name: 'Pantoprazole 40mg', generic: 'Pantoprazole', category: 'Proton Pump Inhibitor', manufacturer: 'Dr. Reddy\'s', minStock: 60 },
      { name: 'Cetirizine 10mg', generic: 'Cetirizine', category: 'Antihistamine', manufacturer: 'Torrent Pharma', minStock: 100 },
      { name: 'ORS Sachet', generic: 'Electrolyte Mix', category: 'Rehydration', manufacturer: 'Cipla Ltd', minStock: 200 },
      { name: 'Metformin 500mg', generic: 'Metformin', category: 'Antidiabetic', manufacturer: 'USV Ltd', minStock: 50 }
    ];

    const medicineIds = { A: [], B: [] };

    // Pharmacy A medicines
    for (const med of medicineTemplate) {
      const result = await client.run(`
        INSERT INTO medicines (pharmacy_id, name, generic_name, category, manufacturer, minimum_stock, active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [pharmacyAId, med.name, med.generic, med.category, med.manufacturer, med.minStock, 1]);
      medicineIds.A.push({ ...med, id: result.rows[0].id });
    }
    console.log(`✓ Created 8 medicines for Pharmacy A`);

    // Pharmacy B medicines
    for (const med of medicineTemplate) {
      const result = await client.run(`
        INSERT INTO medicines (pharmacy_id, name, generic_name, category, manufacturer, minimum_stock, active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [pharmacyBId, med.name, med.generic, med.category, med.manufacturer, med.minStock, 1]);
      medicineIds.B.push({ ...med, id: result.rows[0].id });
    }
    console.log(`✓ Created 8 medicines for Pharmacy B`);
    console.log('');

    // PHASE 5-6: Create Batches with Store Layout
    console.log('PHASE 5-6: Creating Batches and Store Layout');
    console.log('-'.repeat(80));

    const batchesA = [
      { medicine: 0, batch: 'PAR-A-2601', qty: 500, purchase: 8.00, selling: 12.00, expiry: 365, mfg: -30, location: 'Rack A / Shelf A1' },
      { medicine: 0, batch: 'PAR-A-2602', qty: 200, purchase: 8.50, selling: 12.00, expiry: 180, mfg: -15, location: 'Rack A / Shelf A2' },
      { medicine: 1, batch: 'AMX-A-2601', qty: 15, purchase: 45.00, selling: 65.00, expiry: 15, mfg: -60, location: 'Rack B / Shelf B1' },
      { medicine: 2, batch: 'IBU-A-2601', qty: 250, purchase: 6.00, selling: 10.00, expiry: 270, mfg: -20, location: 'Rack A / Shelf A3' },
      { medicine: 3, batch: 'AZI-A-2601', qty: 8, purchase: 85.00, selling: 120.00, expiry: 120, mfg: -45, location: 'Rack C / Shelf C1' },
      { medicine: 4, batch: 'PAN-A-2601', qty: 75, purchase: 15.00, selling: 25.00, expiry: 300, mfg: -25, location: 'Rack B / Shelf B2' },
      { medicine: 5, batch: 'CET-A-2601', qty: 400, purchase: 3.50, selling: 6.00, expiry: 400, mfg: -10, location: 'Rack D / Shelf D1' },
      { medicine: 5, batch: 'CET-A-2602', qty: 50, purchase: 3.50, selling: 6.00, expiry: -15, mfg: -200, location: 'Rack D / Shelf D2' },
      { medicine: 6, batch: 'ORS-A-2601', qty: 250, purchase: 5.00, selling: 8.00, expiry: 200, mfg: -5, location: 'Rack C / Shelf C2' },
      { medicine: 7, batch: 'MET-A-2601', qty: 30, purchase: 4.50, selling: 8.00, expiry: 150, mfg: -40, location: 'Rack D / Shelf D3' }
    ];

    const batchIdsA = [];
    for (const b of batchesA) {
      const result = await client.run(`
        INSERT INTO medicine_batches (medicine_id, batch_number, quantity, purchase_price, selling_price, 
                                       expiry_date, manufacturing_date, location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [
        medicineIds.A[b.medicine].id,
        b.batch,
        b.qty,
        b.purchase,
        b.selling,
        getDate(b.expiry),
        getDate(b.mfg),
        b.location
      ]);
      batchIdsA.push({ ...b, id: result.rows[0].id, medicineId: medicineIds.A[b.medicine].id });
      
      // Create initial RECEIPT inventory movement
      await client.run(`
        INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by)
        VALUES (?, ?, 'RECEIPT', ?)
      `, [result.rows[0].id, b.qty, userIds['admin.a@mediindex.com']]);
    }
    console.log(`✓ Created 10 batches for Pharmacy A`);

    const batchesB = [
      { medicine: 0, batch: 'PAR-B-2601', qty: 250, purchase: 8.00, selling: 12.00, expiry: 300, mfg: -20, location: 'Rack A / Shelf A1' },
      { medicine: 1, batch: 'AMX-B-2601', qty: 100, purchase: 45.00, selling: 65.00, expiry: 240, mfg: -30, location: 'Rack B / Shelf B1' },
      { medicine: 2, batch: 'IBU-B-2601', qty: 90, purchase: 6.00, selling: 10.00, expiry: 220, mfg: -25, location: 'Rack A / Shelf A2' },
      { medicine: 3, batch: 'AZI-B-2601', qty: 45, purchase: 85.00, selling: 120.00, expiry: 180, mfg: -35, location: 'Rack C / Shelf C1' },
      { medicine: 4, batch: 'PAN-B-2601', qty: 25, purchase: 15.00, selling: 25.00, expiry: 160, mfg: -40, location: 'Rack B / Shelf B2' },
      { medicine: 5, batch: 'CET-B-2601', qty: 180, purchase: 3.50, selling: 6.00, expiry: 350, mfg: -15, location: 'Rack D / Shelf D1' },
      { medicine: 6, batch: 'ORS-B-2601', qty: 300, purchase: 5.00, selling: 8.00, expiry: 250, mfg: -10, location: 'Rack C / Shelf C2' },
      { medicine: 7, batch: 'MET-B-2601', qty: 65, purchase: 4.50, selling: 8.00, expiry: 200, mfg: -30, location: 'Rack D / Shelf D2' }
    ];

    const batchIdsB = [];
    for (const b of batchesB) {
      const result = await client.run(`
        INSERT INTO medicine_batches (medicine_id, batch_number, quantity, purchase_price, selling_price, 
                                       expiry_date, manufacturing_date, location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [
        medicineIds.B[b.medicine].id,
        b.batch,
        b.qty,
        b.purchase,
        b.selling,
        getDate(b.expiry),
        getDate(b.mfg),
        b.location
      ]);
      batchIdsB.push({ ...b, id: result.rows[0].id, medicineId: medicineIds.B[b.medicine].id });
      
      // Create initial RECEIPT inventory movement
      await client.run(`
        INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by)
        VALUES (?, ?, 'RECEIPT', ?)
      `, [result.rows[0].id, b.qty, userIds['admin.b@mediindex.com']]);
    }
    console.log(`✓ Created 8 batches for Pharmacy B`);
    console.log('');

    // PHASE 7: Create Expiry Alerts
    console.log('PHASE 7: Creating Expiry Demo Scenarios');
    console.log('-'.repeat(80));

    // Expired: CET-A-2602
    const expiredBatch = batchIdsA.find(b => b.batch === 'CET-A-2602');
    await client.run(`
      INSERT INTO expiry_alerts (batch_id, alert_type, acknowledged)
      VALUES (?, 'EXPIRED', 0)
    `, [expiredBatch.id]);
    console.log(`✓ Created EXPIRED alert for CET-A-2602`);

    // Near-expiry: AMX-A-2601
    const nearExpiryBatch = batchIdsA.find(b => b.batch === 'AMX-A-2601');
    await client.run(`
      INSERT INTO expiry_alerts (batch_id, alert_type, acknowledged)
      VALUES (?, 'EXPIRING_SOON', 0)
    `, [nearExpiryBatch.id]);
    console.log(`✓ Created EXPIRING_SOON alert for AMX-A-2601`);

    // Low stock: AZI-A-2601
    const lowStockBatch = batchIdsA.find(b => b.batch === 'AZI-A-2601');
    await client.run(`
      INSERT INTO expiry_alerts (batch_id, alert_type, acknowledged)
      VALUES (?, 'LOW_STOCK', 0)
    `, [lowStockBatch.id]);
    console.log(`✓ Created LOW_STOCK alert for AZI-A-2601`);

    // Acknowledged alert: PAR-A-2602
    const ackBatch = batchIdsA.find(b => b.batch === 'PAR-A-2602');
    await client.run(`
      INSERT INTO expiry_alerts (batch_id, alert_type, acknowledged)
      VALUES (?, 'EXPIRING_SOON', 1)
    `, [ackBatch.id]);
    console.log(`✓ Created acknowledged EXPIRING_SOON alert for PAR-A-2602`);
    console.log('');

    // PHASE 8-9: Create Historical Sales for Forecasting
    console.log('PHASE 8-9: Creating Historical Sales for Demand Forecasting');
    console.log('-'.repeat(80));

    const salesData = [
      // Pharmacy A - 4 weeks of sales
      { week: -28, pharmacy: pharmacyAId, user: userIds['admin.a@mediindex.com'], items: [
        { medicine: 0, batch: 'PAR-A-2601', qty: 120, price: 12.00 },
        { medicine: 2, batch: 'IBU-A-2601', qty: 45, price: 10.00 },
        { medicine: 5, batch: 'CET-A-2601', qty: 80, price: 6.00 }
      ]},
      { week: -21, pharmacy: pharmacyAId, user: userIds['staff.a@mediindex.com'], items: [
        { medicine: 0, batch: 'PAR-A-2601', qty: 135, price: 12.00 },
        { medicine: 2, batch: 'IBU-A-2601', qty: 50, price: 10.00 },
        { medicine: 5, batch: 'CET-A-2601', qty: 75, price: 6.00 }
      ]},
      { week: -14, pharmacy: pharmacyAId, user: userIds['admin.a@mediindex.com'], items: [
        { medicine: 0, batch: 'PAR-A-2601', qty: 110, price: 12.00 },
        { medicine: 2, batch: 'IBU-A-2601', qty: 55, price: 10.00 },
        { medicine: 5, batch: 'CET-A-2601', qty: 90, price: 6.00 }
      ]},
      { week: -7, pharmacy: pharmacyAId, user: userIds['staff.a@mediindex.com'], items: [
        { medicine: 0, batch: 'PAR-A-2602', qty: 140, price: 12.00 },
        { medicine: 2, batch: 'IBU-A-2601', qty: 40, price: 10.00 },
        { medicine: 5, batch: 'CET-A-2601', qty: 85, price: 6.00 }
      ]},
      // Pharmacy B - 3 weeks of sales
      { week: -21, pharmacy: pharmacyBId, user: userIds['admin.b@mediindex.com'], items: [
        { medicine: 0, batch: 'PAR-B-2601', qty: 60, price: 12.00 },
        { medicine: 1, batch: 'AMX-B-2601', qty: 25, price: 65.00 },
        { medicine: 6, batch: 'ORS-B-2601', qty: 80, price: 8.00 }
      ]},
      { week: -14, pharmacy: pharmacyBId, user: userIds['staff.b@mediindex.com'], items: [
        { medicine: 0, batch: 'PAR-B-2601', qty: 70, price: 12.00 },
        { medicine: 1, batch: 'AMX-B-2601', qty: 30, price: 65.00 },
        { medicine: 6, batch: 'ORS-B-2601', qty: 95, price: 8.00 }
      ]},
      { week: -7, pharmacy: pharmacyBId, user: userIds['admin.b@mediindex.com'], items: [
        { medicine: 0, batch: 'PAR-B-2601', qty: 55, price: 12.00 },
        { medicine: 1, batch: 'AMX-B-2601', qty: 20, price: 65.00 },
        { medicine: 6, batch: 'ORS-B-2601', qty: 75, price: 8.00 }
      ]}
    ];

    let saleCount = 0;
    let itemCount = 0;

    for (const sale of salesData) {
      const saleDate = new Date();
      saleDate.setDate(saleDate.getDate() + sale.week);
      
      const total = sale.items.reduce((sum, item) => sum + (item.qty * item.price), 0);
      const invoiceNum = `INV-${sale.pharmacy}-${saleDate.getTime()}`;

      const saleResult = await client.run(`
        INSERT INTO sales (pharmacy_id, invoice_number, customer_name, payment_method, total_amount, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [sale.pharmacy, invoiceNum, 'Demo Customer', 'CASH', total, sale.user, saleDate.toISOString()]);

      const saleId = saleResult.rows[0].id;
      saleCount++;

      for (const item of sale.items) {
        const batch = sale.pharmacy === pharmacyAId 
          ? batchIdsA.find(b => b.batch === item.batch)
          : batchIdsB.find(b => b.batch === item.batch);

        const lineTotal = item.qty * item.price;

        await client.run(`
          INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total)
          VALUES (?, ?, ?, ?, ?)
        `, [saleId, batch.id, item.qty, item.price, lineTotal]);

        // Create SALE inventory movement
        await client.run(`
          INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by, created_at)
          VALUES (?, ?, 'SALE', ?, ?)
        `, [batch.id, -item.qty, sale.user, saleDate.toISOString()]);

        // Update batch quantity
        await client.run(`
          UPDATE medicine_batches SET quantity = quantity - ? WHERE id = ?
        `, [item.qty, batch.id]);

        itemCount++;
      }
    }

    console.log(`✓ Created ${saleCount} historical sales with ${itemCount} line items`);
    console.log(`  Pharmacy A: 4 weeks of data (Paracetamol, Ibuprofen, Cetirizine)`);
    console.log(`  Pharmacy B: 3 weeks of data (Paracetamol, Amoxicillin, ORS)`);
    console.log('');

    // PHASE 10-11: Inter-Pharmacy Scenarios
    console.log('PHASE 10-11: Creating Inter-Pharmacy Demo Scenarios');
    console.log('-'.repeat(80));

    // Near-expiry redistribution
    const idempKey = crypto.createHash('sha256')
      .update(`${pharmacyAId}|${pharmacyBId}|${medicineIds.A[1].id}|${nearExpiryBatch.id}`)
      .digest('hex');

    await client.run(`
      INSERT INTO medicine_redistribution_requests (
        idempotency_key, sender_pharmacy_id, recipient_pharmacy_id,
        medicine_id, source_batch_id, requested_quantity, reason, request_type,
        status, automatic_request, days_until_expiry, distance_km
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      idempKey,
      pharmacyAId,
      pharmacyBId,
      medicineIds.A[1].id, // Amoxicillin
      nearExpiryBatch.id,
      15,
      'NEAR_EXPIRY_REDISTRIBUTION',
      'NEAR_EXPIRY',
      'PENDING',
      1, // automatic
      15,
      5.2
    ]);
    console.log(`✓ Created near-expiry redistribution request (Amoxicillin, 15 days to expiry)`);

    // Manual medicine request
    const reqIdempKey = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 72);

    const reqResult = await client.run(`
      INSERT INTO medicine_requests (
        idempotency_key, requester_pharmacy_id, medicine_id, medicine_name,
        requested_quantity, covered_quantity, status, priority, reason,
        current_zone_index, current_radius_km, created_by, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      reqIdempKey,
      pharmacyAId,
      medicineIds.A[3].id, // Azithromycin
      'Azithromycin 500mg',
      30,
      25, // Will be partially covered
      'PARTIALLY_COVERED',
      'URGENT',
      'Low stock - below minimum threshold',
      0,
      10.0,
      userIds['admin.a@mediindex.com'],
      expiresAt.toISOString()
    ]);

    const requestId = reqResult.rows[0].id;

    // Offer from Pharmacy B
    const respondBy = new Date();
    respondBy.setHours(respondBy.getHours() + 24);

    await client.run(`
      INSERT INTO medicine_request_offers (
        request_id, pharmacy_id, zone_index, distance_km, usable_stock_at_contact,
        status, offered_quantity, responded_by, responded_at, respond_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      requestId,
      pharmacyBId,
      0,
      5.2,
      45, // Azithromycin stock at Pharmacy B
      'ACCEPTED',
      25,
      userIds['admin.b@mediindex.com'],
      new Date().toISOString(),
      respondBy.toISOString()
    ]);

    console.log(`✓ Created manual medicine request (Azithromycin, PARTIALLY_COVERED)`);
    console.log(`  Requester: Pharmacy A (needs 30 units)`);
    console.log(`  Provider: Pharmacy B (offered 25 units)`);
    console.log('');

    // COMMIT
    await client.exec('COMMIT');
    console.log('✓ Transaction committed successfully');
    console.log('');

  } catch (error) {
    await client.exec('ROLLBACK');
    console.error('❌ ERROR during seeding:', error.message);
    console.error('Transaction rolled back - database unchanged');
    client.release();
    await db.close();
    process.exit(1);
  }

  client.release();

  // PHASE 14: Post-Seed Validation
  console.log('PHASE 14: Post-Seed Validation');
  console.log('-'.repeat(80));

  const pharmacyCount = await db.query('SELECT COUNT(*) as count FROM pharmacies');
  const userCount = await db.query('SELECT COUNT(*) as count FROM users');
  const medicineCount = await db.query('SELECT COUNT(*) as count FROM medicines');
  const batchCount = await db.query('SELECT COUNT(*) as count FROM medicine_batches');
  const alertCount = await db.query('SELECT COUNT(*) as count FROM expiry_alerts');
  const salesCount = await db.query('SELECT COUNT(*) as count FROM sales');
  const saleItemCount = await db.query('SELECT COUNT(*) as count FROM sale_items');
  const movementCount = await db.query('SELECT COUNT(*) as count FROM inventory_movements');
  const redistCount = await db.query('SELECT COUNT(*) as count FROM medicine_redistribution_requests');
  const requestCount = await db.query('SELECT COUNT(*) as count FROM medicine_requests');
  const offerCount = await db.query('SELECT COUNT(*) as count FROM medicine_request_offers');

  console.log(`✓ Pharmacies: ${pharmacyCount[0].count}`);
  console.log(`✓ Users: ${userCount[0].count}`);
  console.log(`✓ Medicines: ${medicineCount[0].count}`);
  console.log(`✓ Batches: ${batchCount[0].count}`);
  console.log(`✓ Expiry Alerts: ${alertCount[0].count}`);
  console.log(`✓ Historical Sales: ${salesCount[0].count}`);
  console.log(`✓ Sale Items: ${saleItemCount[0].count}`);
  console.log(`✓ Inventory Movements: ${movementCount[0].count}`);
  console.log(`✓ Redistribution Requests: ${redistCount[0].count}`);
  console.log(`✓ Medicine Requests: ${requestCount[0].count}`);
  console.log(`✓ Request Offers: ${offerCount[0].count}`);
  console.log('');

  // Validate no negative stock
  const negativeStock = await db.query('SELECT COUNT(*) as count FROM medicine_batches WHERE quantity < 0');
  if (parseInt(negativeStock[0].count) > 0) {
    console.error(`❌ WARNING: ${negativeStock[0].count} batches have negative stock!`);
  } else {
    console.log(`✓ No negative stock`);
  }

  // Validate foreign keys
  const orphanBatches = await db.query('SELECT COUNT(*) as count FROM medicine_batches WHERE medicine_id NOT IN (SELECT id FROM medicines)');
  const orphanMovements = await db.query('SELECT COUNT(*) as count FROM inventory_movements WHERE batch_id NOT IN (SELECT id FROM medicine_batches)');
  
  console.log(`✓ No orphan batches: ${orphanBatches[0].count === '0' ? 'PASS' : 'FAIL'}`);
  console.log(`✓ No orphan movements: ${orphanMovements[0].count === '0' ? 'PASS' : 'FAIL'}`);
  console.log('');

  await db.close();

  console.log('='.repeat(80));
  console.log('✅ PRODUCTION DEMO DATABASE SEEDING COMPLETE');
  console.log('='.repeat(80));
  console.log('');
  console.log('DEMO CREDENTIALS:');
  console.log('  admin.a@mediindex.com / Demo@12345 (Pharmacy A, ADMIN)');
  console.log('  staff.a@mediindex.com / Demo@12345 (Pharmacy A, STAFF)');
  console.log('  admin.b@mediindex.com / Demo@12345 (Pharmacy B, ADMIN)');
  console.log('  staff.b@mediindex.com / Demo@12345 (Pharmacy B, STAFF)');
  console.log('');
  console.log('Ready for B.Tech Major Project presentation and Android production testing.');
  console.log('');
}

seedProductionDemo().catch(err => {
  console.error('FATAL ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
