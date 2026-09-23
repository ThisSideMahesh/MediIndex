/**
 * ONE-TIME CLEANUP SCRIPT
 * Removes the audited old MediIndex Demo Pharmacy dataset
 * 
 * SAFETY: Multiple verification checks before deletion
 * SCOPE: Deletes ONLY the known demo pharmacy (id=1)
 * CASCADE: Relies on schema ON DELETE CASCADE for dependent records
 * TRANSACTION: All-or-nothing deletion with rollback on failure
 * 
 * WARNING: This script permanently deletes data. Use with caution.
 */

const { createDatabaseAdapter } = require('../db/index');

// Expected state from read-only audit (2026-09-19)
const EXPECTED_STATE = {
  pharmacy: {
    id: 1,
    name: 'MediIndex Demo Pharmacy',
    address: 'Chhatrapati Sambhajinagar',
    latitude: null,
    longitude: null
  },
  users: [
    'admin@mediindex.local',
    'staff@mediindex.local'
  ],
  counts: {
    pharmacies: 1,
    users: 2,
    sessions: 30,
    medicines: 2,
    medicine_batches: 3,
    inventory_movements: 6,
    sales: 3,
    sale_items: 3,
    expiry_alerts: 1,
    paired_devices: 0,
    device_pairing_codes: 1,
    idempotency_keys: 0,
    medicine_redistribution_requests: 0,
    medicine_requests: 2,
    medicine_request_offers: 0
  }
};

async function cleanupOldDemo() {
  console.log('═'.repeat(80));
  console.log('⚠️  ONE-TIME CLEANUP: REMOVES AUDITED OLD MEDIINDEX DEMO PHARMACY DATASET');
  console.log('═'.repeat(80));
  console.log('');
  console.log('This script will permanently delete:');
  console.log('  - Pharmacy: "MediIndex Demo Pharmacy" (id=1)');
  console.log('  - 2 users (admin@mediindex.local, staff@mediindex.local)');
  console.log('  - 30 sessions');
  console.log('  - 2 medicines, 3 batches, 6 movements');
  console.log('  - 3 sales, 3 sale items, 1 alert');
  console.log('  - 1 pairing code, 2 medicine requests');
  console.log('');
  console.log('Press Ctrl+C within 5 seconds to abort...');
  console.log('');

  // 5-second safety delay
  await new Promise(resolve => setTimeout(resolve, 5000));

  console.log('Proceeding with cleanup...');
  console.log('');

  if (!process.env.DATABASE_URL) {
    console.error('❌ SAFETY CHECK FAILED: DATABASE_URL is not configured');
    process.exit(1);
  }

  const db = createDatabaseAdapter({}).initialize();
  
  if (db.type !== 'postgres') {
    console.error('❌ SAFETY CHECK FAILED: This script requires PostgreSQL');
    process.exit(1);
  }

  await db.ensureSchema();

  // ═══════════════════════════════════════════════════════════════════════════
  // SAFETY CHECK 1: Verify pharmacy exists with exact expected attributes
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('SAFETY CHECK 1: Verify Pharmacy Record');
  console.log('─'.repeat(80));

  const pharmacy = await db.get(
    'SELECT id, name, address, latitude, longitude, active FROM pharmacies WHERE id = ?',
    [EXPECTED_STATE.pharmacy.id]
  );

  if (!pharmacy) {
    console.error('❌ SAFETY CHECK FAILED: Pharmacy id=1 not found');
    console.error('   Database state may have changed since audit.');
    await db.close();
    process.exit(1);
  }

  if (pharmacy.name !== EXPECTED_STATE.pharmacy.name) {
    console.error('❌ SAFETY CHECK FAILED: Pharmacy name mismatch');
    console.error(`   Expected: "${EXPECTED_STATE.pharmacy.name}"`);
    console.error(`   Found: "${pharmacy.name}"`);
    await db.close();
    process.exit(1);
  }

  if (pharmacy.address !== EXPECTED_STATE.pharmacy.address) {
    console.error('❌ SAFETY CHECK FAILED: Pharmacy address mismatch');
    console.error(`   Expected: "${EXPECTED_STATE.pharmacy.address}"`);
    console.error(`   Found: "${pharmacy.address}"`);
    await db.close();
    process.exit(1);
  }

  if (pharmacy.latitude !== null) {
    console.error('❌ SAFETY CHECK FAILED: Pharmacy latitude is not NULL');
    console.error(`   Expected: NULL`);
    console.error(`   Found: ${pharmacy.latitude}`);
    await db.close();
    process.exit(1);
  }

  if (pharmacy.longitude !== null) {
    console.error('❌ SAFETY CHECK FAILED: Pharmacy longitude is not NULL');
    console.error(`   Expected: NULL`);
    console.error(`   Found: ${pharmacy.longitude}`);
    await db.close();
    process.exit(1);
  }

  console.log('✅ Pharmacy verified:');
  console.log(`   ID: ${pharmacy.id}`);
  console.log(`   Name: "${pharmacy.name}"`);
  console.log(`   Address: "${pharmacy.address}"`);
  console.log(`   Coordinates: NULL, NULL`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // SAFETY CHECK 2: Verify users belong to pharmacy 1 and match expected emails
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('SAFETY CHECK 2: Verify Associated Users');
  console.log('─'.repeat(80));

  const users = await db.query(
    'SELECT email FROM users WHERE pharmacy_id = ? ORDER BY email',
    [EXPECTED_STATE.pharmacy.id]
  );

  const userEmails = users.map(u => u.email).sort();
  const expectedEmails = [...EXPECTED_STATE.users].sort();

  if (userEmails.length !== expectedEmails.length) {
    console.error('❌ SAFETY CHECK FAILED: User count mismatch');
    console.error(`   Expected: ${expectedEmails.length} users`);
    console.error(`   Found: ${userEmails.length} users`);
    await db.close();
    process.exit(1);
  }

  for (let i = 0; i < userEmails.length; i++) {
    if (userEmails[i] !== expectedEmails[i]) {
      console.error('❌ SAFETY CHECK FAILED: User email mismatch');
      console.error(`   Expected: ${expectedEmails[i]}`);
      console.error(`   Found: ${userEmails[i]}`);
      await db.close();
      process.exit(1);
    }
  }

  console.log('✅ Users verified:');
  for (const email of userEmails) {
    console.log(`   - ${email}`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // SAFETY CHECK 3: Verify current row counts match audited dataset exactly
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('SAFETY CHECK 3: Verify Current Row Counts');
  console.log('─'.repeat(80));

  const tables = Object.keys(EXPECTED_STATE.counts);
  const currentCounts = {};
  let countMismatch = false;

  for (const table of tables) {
    const result = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
    const count = parseInt(result[0].count);
    currentCounts[table] = count;

    const expected = EXPECTED_STATE.counts[table];
    const status = count === expected ? '✅' : '❌';
    
    if (count !== expected) {
      console.error(`${status} ${table.padEnd(40)} Expected: ${expected.toString().padStart(3)}, Found: ${count.toString().padStart(3)}`);
      countMismatch = true;
    } else {
      console.log(`${status} ${table.padEnd(40)} ${count.toString().padStart(3)} rows`);
    }
  }

  if (countMismatch) {
    console.error('');
    console.error('❌ SAFETY CHECK FAILED: Row counts do not match audit');
    console.error('   Database state has changed since audit.');
    console.error('   Re-run audit script to verify current state.');
    await db.close();
    process.exit(1);
  }

  console.log('');
  console.log('✅ All row counts match audited dataset');
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // ALL SAFETY CHECKS PASSED - PROCEED WITH DELETION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(80));
  console.log('✅ ALL SAFETY CHECKS PASSED');
  console.log('═'.repeat(80));
  console.log('');
  console.log('Proceeding with transactional deletion...');
  console.log('');

  const client = await db.getClient();
  const deletionCounts = {};

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // BEGIN TRANSACTION
    // ─────────────────────────────────────────────────────────────────────────
    await client.exec('BEGIN');
    console.log('✅ Transaction started');
    console.log('');

    // ─────────────────────────────────────────────────────────────────────────
    // DEPENDENCY-SAFE DELETION ORDER (derived from actual PostgreSQL FK graph)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('Executing sequential deletion (respecting FK constraints)...');
    console.log('─'.repeat(80));

    // STEP 1: Delete medicine_request_offers (references users & pharmacies)
    let result = await client.run(
      'DELETE FROM medicine_request_offers WHERE pharmacy_id = ?',
      [1]
    );
    deletionCounts.medicine_request_offers = result.changes;
    console.log(`  1. medicine_request_offers: ${result.changes} rows deleted`);

    // STEP 2: Delete medicine_requests (references users.created_by [NO ACTION])
    result = await client.run(
      'DELETE FROM medicine_requests WHERE requester_pharmacy_id = ?',
      [1]
    );
    deletionCounts.medicine_requests = result.changes;
    console.log(`  2. medicine_requests: ${result.changes} rows deleted`);

    // STEP 3: Delete medicine_redistribution_requests (references pharmacies)
    result = await client.run(
      'DELETE FROM medicine_redistribution_requests WHERE sender_pharmacy_id = ? OR recipient_pharmacy_id = ?',
      [1, 1]
    );
    deletionCounts.medicine_redistribution_requests = result.changes;
    console.log(`  3. medicine_redistribution_requests: ${result.changes} rows deleted`);

    // STEP 4: Delete device_pairing_codes (references users.created_by [NO ACTION])
    result = await client.run(
      'DELETE FROM device_pairing_codes WHERE pharmacy_id = ?',
      [1]
    );
    deletionCounts.device_pairing_codes = result.changes;
    console.log(`  4. device_pairing_codes: ${result.changes} rows deleted`);

    // STEP 5: Delete idempotency_keys (references pharmacies)
    result = await client.run(
      'DELETE FROM idempotency_keys WHERE pharmacy_id = ?',
      [1]
    );
    deletionCounts.idempotency_keys = result.changes;
    console.log(`  5. idempotency_keys: ${result.changes} rows deleted`);

    // STEP 6: Delete sale_items BEFORE sales (references batches [NO ACTION])
    result = await client.run(
      'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE pharmacy_id = ?)',
      [1]
    );
    deletionCounts.sale_items = result.changes;
    console.log(`  6. sale_items: ${result.changes} rows deleted`);

    // STEP 7: Delete sales (references users.created_by [NO ACTION])
    result = await client.run(
      'DELETE FROM sales WHERE pharmacy_id = ?',
      [1]
    );
    deletionCounts.sales = result.changes;
    console.log(`  7. sales: ${result.changes} rows deleted`);

    // STEP 8: CRITICAL - Delete inventory_movements BEFORE users
    // (inventory_movements.created_by → users.id [NO ACTION])
    result = await client.run(
      'DELETE FROM inventory_movements WHERE created_by IN (SELECT id FROM users WHERE pharmacy_id = ?)',
      [1]
    );
    deletionCounts.inventory_movements = result.changes;
    console.log(`  8. inventory_movements: ${result.changes} rows deleted (CRITICAL: unblocks users)`);

    // STEP 9: Delete expiry_alerts (references batches [CASCADE])
    result = await client.run(
      `DELETE FROM expiry_alerts WHERE batch_id IN (
        SELECT mb.id FROM medicine_batches mb
        JOIN medicines m ON m.id = mb.medicine_id
        WHERE m.pharmacy_id = ?
      )`,
      [1]
    );
    deletionCounts.expiry_alerts = result.changes;
    console.log(`  9. expiry_alerts: ${result.changes} rows deleted`);

    // STEP 10: Delete medicine_batches (sale_items [NO ACTION] already deleted)
    result = await client.run(
      'DELETE FROM medicine_batches WHERE medicine_id IN (SELECT id FROM medicines WHERE pharmacy_id = ?)',
      [1]
    );
    deletionCounts.medicine_batches = result.changes;
    console.log(` 10. medicine_batches: ${result.changes} rows deleted`);

    // STEP 11: Delete medicines (batches now deleted)
    result = await client.run(
      'DELETE FROM medicines WHERE pharmacy_id = ?',
      [1]
    );
    deletionCounts.medicines = result.changes;
    console.log(` 11. medicines: ${result.changes} rows deleted`);

    // STEP 12: Delete sessions (references users & pharmacies [CASCADE])
    result = await client.run(
      'DELETE FROM sessions WHERE pharmacy_id = ?',
      [1]
    );
    deletionCounts.sessions = result.changes;
    console.log(` 12. sessions: ${result.changes} rows deleted`);

    // STEP 13: Delete paired_devices (references users.paired_by [NO ACTION])
    result = await client.run(
      'DELETE FROM paired_devices WHERE pharmacy_id = ?',
      [1]
    );
    deletionCounts.paired_devices = result.changes;
    console.log(` 13. paired_devices: ${result.changes} rows deleted`);

    // STEP 14: Delete users (now safe - all NO ACTION references removed)
    result = await client.run(
      'DELETE FROM users WHERE pharmacy_id = ?',
      [1]
    );
    deletionCounts.users = result.changes;
    console.log(` 14. users: ${result.changes} rows deleted (now safe)`);

    // STEP 15: Delete pharmacies (all dependents removed)
    result = await client.run(
      'DELETE FROM pharmacies WHERE id = ?',
      [1]
    );
    deletionCounts.pharmacies = result.changes;
    console.log(` 15. pharmacies: ${result.changes} rows deleted`);

    console.log('');

    // ─────────────────────────────────────────────────────────────────────────
    // VERIFY ALL TABLES ARE NOW EMPTY
    // ─────────────────────────────────────────────────────────────────────────
    console.log('Verifying cascade deletion (inside transaction)...');
    console.log('─'.repeat(80));

    const afterCounts = {};
    let hasNonZero = false;

    for (const table of tables) {
      const result = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
      const count = parseInt(result[0].count);
      afterCounts[table] = count;

      const status = count === 0 ? '✅' : '❌';
      console.log(`${status} ${table.padEnd(40)} ${count.toString().padStart(3)} rows`);

      if (count > 0) {
        hasNonZero = true;
      }
    }

    console.log('');

    if (hasNonZero) {
      // ───────────────────────────────────────────────────────────────────────
      // ROLLBACK - Cascade did not complete as expected
      // ───────────────────────────────────────────────────────────────────────
      console.error('❌ VERIFICATION FAILED: Some tables are not empty after deletion');
      console.error('   CASCADE may not be configured correctly in schema.');
      console.error('   Rolling back transaction...');
      
      await client.exec('ROLLBACK');
      console.error('✅ Transaction rolled back - database unchanged');
      
      client.release();
      await db.close();
      process.exit(1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COMMIT - All tables are empty
    // ─────────────────────────────────────────────────────────────────────────
    console.log('✅ All tables are empty - cascade deletion successful');
    console.log('');
    console.log('Committing transaction...');
    
    await client.exec('COMMIT');
    console.log('✅ Transaction committed');
    console.log('');

  } catch (error) {
    // ───────────────────────────────────────────────────────────────────────
    // ERROR HANDLING - Rollback on any failure
    // ───────────────────────────────────────────────────────────────────────
    console.error('');
    console.error('❌ ERROR during deletion:', error.message);
    console.error('   Rolling back transaction...');
    
    try {
      await client.exec('ROLLBACK');
      console.error('✅ Transaction rolled back - database unchanged');
    } catch (rollbackError) {
      console.error('❌ ROLLBACK FAILED:', rollbackError.message);
    }
    
    client.release();
    await db.close();
    process.exit(1);
  }

  client.release();

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL VERIFICATION - Confirm database is empty (outside transaction)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(80));
  console.log('FINAL VERIFICATION (outside transaction)');
  console.log('═'.repeat(80));

  const finalCounts = {};
  let finalTotalRows = 0;

  for (const table of tables) {
    const result = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
    const count = parseInt(result[0].count);
    finalCounts[table] = count;
    finalTotalRows += count;
    console.log(`  ${table.padEnd(40)} ${count.toString().padStart(3)} rows`);
  }

  console.log('  ' + '─'.repeat(46));
  console.log(`  ${'TOTAL'.padEnd(40)} ${finalTotalRows.toString().padStart(3)} rows`);
  console.log('');

  await db.close();

  // ═══════════════════════════════════════════════════════════════════════════
  // SUCCESS SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(80));
  console.log('✅ CLEANUP COMPLETE');
  console.log('═'.repeat(80));
  console.log('');
  console.log('DELETION SUMMARY:');
  console.log('─'.repeat(80));
  for (const [table, count] of Object.entries(deletionCounts)) {
    console.log(`  ${table.padEnd(40)} ${count.toString().padStart(3)} rows deleted`);
  }
  console.log('');
  console.log('BEFORE (audited state):');
  console.log(`  Pharmacies: ${EXPECTED_STATE.counts.pharmacies}`);
  console.log(`  Users: ${EXPECTED_STATE.counts.users}`);
  console.log(`  Total application records: ${Object.values(EXPECTED_STATE.counts).reduce((a, b) => a + b, 0)}`);
  console.log('');
  console.log('AFTER (current state):');
  console.log(`  All tables: 0 rows`);
  console.log('');
  console.log('✅ Database is now empty and ready for production demo seed');
  console.log('');
  console.log('⚠️  SEED SCRIPT WAS NOT EXECUTED AUTOMATICALLY');
  console.log('');
  console.log('NEXT STEP:');
  console.log('  Run: node scripts/seed-production-demo.js');
  console.log('');
  console.log('═'.repeat(80));
}

// ═════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═════════════════════════════════════════════════════════════════════════════
cleanupOldDemo().catch(err => {
  console.error('');
  console.error('═'.repeat(80));
  console.error('❌ CLEANUP FAILED');
  console.error('═'.repeat(80));
  console.error('');
  console.error('Error:', err.message);
  console.error('');
  console.error('Database was NOT modified (transaction rolled back).');
  console.error('');
  process.exit(1);
});
