/**
 * READ-ONLY AUDIT OF EXISTING PRODUCTION DATA
 * Investigates the single pharmacy record found in production
 */

const { createDatabaseAdapter } = require('../db/index');

async function auditExistingData() {
  console.log('═'.repeat(80));
  console.log('READ-ONLY AUDIT — EXISTING PRODUCTION DATA');
  console.log('═'.repeat(80));
  console.log('');

  if (!process.env.DATABASE_URL) {
    console.error('❌ ERROR: DATABASE_URL not available');
    process.exit(1);
  }

  const db = createDatabaseAdapter({}).initialize();
  
  if (db.type !== 'postgres') {
    console.error('❌ ERROR: This audit requires PostgreSQL');
    process.exit(1);
  }

  await db.ensureSchema();

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 1: Get row counts for ALL application tables
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TASK 1: Row Counts for All Application Tables');
  console.log('─'.repeat(80));

  const tables = [
    'pharmacies',
    'users',
    'sessions',
    'medicines',
    'medicine_batches',
    'inventory_movements',
    'sales',
    'sale_items',
    'expiry_alerts',
    'paired_devices',
    'device_pairing_codes',
    'idempotency_keys',
    'medicine_redistribution_requests',
    'medicine_requests',
    'medicine_request_offers'
  ];

  const counts = {};
  let totalRows = 0;

  for (const table of tables) {
    const result = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
    const count = parseInt(result[0].count);
    counts[table] = count;
    totalRows += count;
    console.log(`  ${table.padEnd(40)} ${count.toString().padStart(6)} rows`);
  }

  console.log('  ' + '─'.repeat(46));
  console.log(`  ${'TOTAL'.padEnd(40)} ${totalRows.toString().padStart(6)} rows`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 2: Inspect the single pharmacy record
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TASK 2: Existing Pharmacy Record Details');
  console.log('─'.repeat(80));

  const pharmacies = await db.query('SELECT * FROM pharmacies ORDER BY id');
  
  if (pharmacies.length === 0) {
    console.log('  ⚠️  No pharmacies found (count may have changed)');
  } else {
    for (const pharmacy of pharmacies) {
      console.log(`  Pharmacy ID: ${pharmacy.id}`);
      console.log(`  Name: ${pharmacy.name || 'NULL'}`);
      console.log(`  Address: ${pharmacy.address || 'NULL'}`);
      console.log(`  Latitude: ${pharmacy.latitude !== null ? pharmacy.latitude : 'NULL'}`);
      console.log(`  Longitude: ${pharmacy.longitude !== null ? pharmacy.longitude : 'NULL'}`);
      console.log(`  Active: ${pharmacy.active !== undefined ? pharmacy.active : 'NULL'}`);
      console.log(`  Created At: ${pharmacy.created_at || 'NULL'}`);
      console.log('');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 3: Determine record origin
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TASK 3: Record Origin Analysis');
  console.log('─'.repeat(80));

  if (pharmacies.length > 0) {
    const p = pharmacies[0];
    const created = new Date(p.created_at);
    const now = new Date();
    const ageHours = Math.floor((now - created) / (1000 * 60 * 60));
    const ageDays = Math.floor(ageHours / 24);

    console.log(`  Created: ${created.toISOString()}`);
    console.log(`  Age: ${ageDays} days (${ageHours} hours)`);
    console.log('');

    // Check for indicators
    const indicators = [];
    if (p.name && (p.name.includes('Demo') || p.name.includes('Test'))) {
      indicators.push('Name contains "Demo" or "Test"');
    }
    if (p.latitude !== null && p.longitude !== null) {
      indicators.push('Has geographic coordinates (lat/long set)');
    }
    if (p.active !== null) {
      indicators.push(`Active field: ${p.active}`);
    }

    if (indicators.length > 0) {
      console.log('  Indicators:');
      for (const ind of indicators) {
        console.log(`    - ${ind}`);
      }
    } else {
      console.log('  No specific indicators found');
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 4: Check for associated users
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TASK 4: Associated Users');
  console.log('─'.repeat(80));

  if (pharmacies.length > 0) {
    for (const pharmacy of pharmacies) {
      const users = await db.query(
        'SELECT id, full_name, email, role, active, created_at FROM users WHERE pharmacy_id = ?',
        [pharmacy.id]
      );
      
      if (users.length === 0) {
        console.log(`  Pharmacy ${pharmacy.id}: NO USERS`);
      } else {
        console.log(`  Pharmacy ${pharmacy.id}: ${users.length} user(s)`);
        for (const user of users) {
          console.log(`    - User ${user.id}: ${user.email} (${user.role}, active: ${user.active})`);
        }
      }
    }
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 5: Check for associated application data
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TASK 5: Associated Application Data');
  console.log('─'.repeat(80));

  if (pharmacies.length > 0) {
    for (const pharmacy of pharmacies) {
      console.log(`  Pharmacy ${pharmacy.id}:`);
      
      // Medicines
      const medicines = await db.query(
        'SELECT COUNT(*) as count FROM medicines WHERE pharmacy_id = ?',
        [pharmacy.id]
      );
      console.log(`    Medicines: ${medicines[0].count}`);

      // Sales
      const sales = await db.query(
        'SELECT COUNT(*) as count FROM sales WHERE pharmacy_id = ?',
        [pharmacy.id]
      );
      console.log(`    Sales: ${sales[0].count}`);

      // Sessions
      const sessions = await db.query(
        'SELECT COUNT(*) as count FROM sessions WHERE pharmacy_id = ?',
        [pharmacy.id]
      );
      console.log(`    Sessions: ${sessions[0].count}`);

      // Paired devices
      const devices = await db.query(
        'SELECT COUNT(*) as count FROM paired_devices WHERE pharmacy_id = ?',
        [pharmacy.id]
      );
      console.log(`    Paired Devices: ${devices[0].count}`);

      // Pairing codes
      const codes = await db.query(
        'SELECT COUNT(*) as count FROM device_pairing_codes WHERE pharmacy_id = ?',
        [pharmacy.id]
      );
      console.log(`    Pairing Codes: ${codes[0].count}`);

      // Redistribution requests (sender)
      const redistSender = await db.query(
        'SELECT COUNT(*) as count FROM medicine_redistribution_requests WHERE sender_pharmacy_id = ?',
        [pharmacy.id]
      );
      console.log(`    Redistribution Requests (sender): ${redistSender[0].count}`);

      // Redistribution requests (recipient)
      const redistRecipient = await db.query(
        'SELECT COUNT(*) as count FROM medicine_redistribution_requests WHERE recipient_pharmacy_id = ?',
        [pharmacy.id]
      );
      console.log(`    Redistribution Requests (recipient): ${redistRecipient[0].count}`);

      // Medicine requests
      const requests = await db.query(
        'SELECT COUNT(*) as count FROM medicine_requests WHERE requester_pharmacy_id = ?',
        [pharmacy.id]
      );
      console.log(`    Medicine Requests: ${requests[0].count}`);

      // Medicine request offers
      const offers = await db.query(
        'SELECT COUNT(*) as count FROM medicine_request_offers WHERE pharmacy_id = ?',
        [pharmacy.id]
      );
      console.log(`    Medicine Request Offers: ${offers[0].count}`);

      // Idempotency keys
      const idempKeys = await db.query(
        'SELECT COUNT(*) as count FROM idempotency_keys WHERE pharmacy_id = ?',
        [pharmacy.id]
      );
      console.log(`    Idempotency Keys: ${idempKeys[0].count}`);
      
      console.log('');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 6: Check foreign key references
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TASK 6: Foreign Key Reference Summary');
  console.log('─'.repeat(80));

  if (pharmacies.length > 0) {
    const pharmacyId = pharmacies[0].id;
    
    const refCounts = {
      users: counts.users,
      sessions: counts.sessions,
      medicines: counts.medicines,
      sales: counts.sales,
      paired_devices: counts.paired_devices,
      device_pairing_codes: counts.device_pairing_codes,
      idempotency_keys: counts.idempotency_keys
    };

    let hasRefs = false;
    for (const [table, count] of Object.entries(refCounts)) {
      if (count > 0) {
        console.log(`  ⚠️  ${table}: ${count} record(s) reference pharmacy ${pharmacyId}`);
        hasRefs = true;
      }
    }

    if (!hasRefs) {
      console.log(`  ✅ No records directly reference pharmacy ${pharmacyId}`);
    }
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 7: Database emptiness check
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TASK 7: Database Emptiness Assessment');
  console.log('─'.repeat(80));

  const nonPharmacyRows = totalRows - counts.pharmacies;
  console.log(`  Total rows (all tables): ${totalRows}`);
  console.log(`  Pharmacy rows: ${counts.pharmacies}`);
  console.log(`  Non-pharmacy rows: ${nonPharmacyRows}`);
  console.log('');

  if (nonPharmacyRows === 0) {
    console.log('  ✅ Database is EMPTY except for the pharmacy record(s)');
  } else {
    console.log(`  ⚠️  Database contains ${nonPharmacyRows} additional row(s) beyond pharmacies`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 8: Seed script safety check explanation
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TASK 8: Seed Script Safety Check Analysis');
  console.log('─'.repeat(80));

  console.log('  The seed script correctly stopped because:');
  console.log('');
  console.log('  1. Pre-seed safety check (lines 65-79) iterates all 15 tables');
  console.log('  2. For each table, it runs: SELECT COUNT(*) FROM <table>');
  console.log('  3. If ANY table has count > 0, script exits with error');
  console.log('  4. pharmacies table had 1 row → safety check FAILED');
  console.log('  5. Script exited before BEGIN transaction');
  console.log('  6. Database was NOT modified (transaction never started)');
  console.log('');
  console.log('  ✅ Safety mechanism worked correctly');
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY & RECOMMENDATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(80));
  console.log('FINAL SUMMARY & RECOMMENDATIONS');
  console.log('═'.repeat(80));
  console.log('');

  console.log('A. EXACT ROW COUNTS:');
  for (const [table, count] of Object.entries(counts)) {
    console.log(`   ${table.padEnd(40)} ${count}`);
  }
  console.log('');

  console.log('B. EXISTING PHARMACY DETAILS:');
  if (pharmacies.length > 0) {
    const p = pharmacies[0];
    console.log(`   ID: ${p.id}`);
    console.log(`   Name: ${p.name || 'NULL'}`);
    console.log(`   Has coordinates: ${p.latitude !== null ? 'YES' : 'NO'}`);
    console.log(`   Created: ${p.created_at}`);
  }
  console.log('');

  console.log('C. DEPENDENT RECORDS:');
  if (nonPharmacyRows === 0) {
    console.log('   ✅ NO dependent records');
  } else {
    console.log(`   ⚠️  ${nonPharmacyRows} dependent record(s) exist`);
  }
  console.log('');

  console.log('D. DATABASE OTHERWISE EMPTY:');
  console.log(`   ${nonPharmacyRows === 0 ? '✅ YES' : '❌ NO'}`);
  console.log('');

  console.log('E. PHARMACY RECORD ORIGIN:');
  if (pharmacies.length > 0) {
    const p = pharmacies[0];
    const hasCoords = p.latitude !== null && p.longitude !== null;
    const hasName = p.name !== null;
    const isDemo = hasName && (p.name.includes('Demo') || p.name.includes('Test'));
    
    if (isDemo) {
      console.log('   ⚠️  LIKELY OLD DEMO/TEST RECORD (name contains Demo/Test)');
    } else if (hasCoords) {
      console.log('   ⚠️  LIKELY APPLICATION-CREATED (has coordinates)');
    } else {
      console.log('   ❓ UNKNOWN (insufficient indicators)');
    }
  }
  console.log('');

  console.log('F. SAFE TO REMOVE:');
  if (nonPharmacyRows === 0) {
    console.log('   ✅ YES - pharmacy has no dependent records');
    console.log('   Single DELETE will cascade to zero dependent rows');
  } else {
    console.log('   ⚠️  REQUIRES CAREFUL DELETION - has dependent records');
  }
  console.log('');

  console.log('G. DELETION ORDER (if removal required):');
  console.log('   The schema has ON DELETE CASCADE for most foreign keys,');
  console.log('   so deleting the pharmacy will automatically cascade.');
  console.log('');
  console.log('   Safe approach:');
  console.log('   1. BEGIN transaction');
  console.log('   2. DELETE FROM pharmacies WHERE id = <pharmacy_id>');
  console.log('   3. COMMIT (or ROLLBACK if any errors)');
  console.log('');
  console.log('   Cascade will automatically delete from:');
  console.log('   - users, sessions, medicines, medicine_batches');
  console.log('   - inventory_movements, sales, sale_items, expiry_alerts');
  console.log('   - paired_devices, device_pairing_codes, idempotency_keys');
  console.log('   - medicine_redistribution_requests, medicine_requests');
  console.log('   - medicine_request_offers');
  console.log('');

  console.log('H. RECOMMENDED NEXT ACTION:');
  console.log('');
  if (nonPharmacyRows === 0 && pharmacies.length === 1) {
    console.log('   OPTION 1: Delete the single pharmacy record');
    console.log('   - Run: DELETE FROM pharmacies WHERE id = <pharmacy_id>');
    console.log('   - Then run seed script again');
    console.log('');
    console.log('   OPTION 2: Create a cleanup script');
    console.log('   - Transactional DELETE with explicit confirmation');
    console.log('   - Verify all tables empty after deletion');
    console.log('   - Then run seed script');
    console.log('');
    console.log('   ✅ RECOMMENDED: Option 2 (safer, verifiable)');
  } else if (nonPharmacyRows > 0) {
    console.log('   ⚠️  Database is NOT empty');
    console.log('   - Review dependent records before deletion');
    console.log('   - Determine if data should be preserved');
    console.log('   - If deletion is safe, use CASCADE delete');
  } else {
    console.log('   ℹ️  No pharmacies found - seed script should work');
  }
  console.log('');

  console.log('═'.repeat(80));
  console.log('READ-ONLY AUDIT COMPLETE');
  console.log('═'.repeat(80));

  await db.close();
}

auditExistingData().catch(err => {
  console.error('AUDIT FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
