/**
 * READ-ONLY INVESTIGATION: PostgreSQL Foreign Key Constraints
 * Analyzes the actual FK graph to understand deletion failure
 */

const { createDatabaseAdapter } = require('../db/index');

async function investigateForeignKeys() {
  console.log('═'.repeat(80));
  console.log('READ-ONLY INVESTIGATION: PostgreSQL Foreign Key Constraints');
  console.log('═'.repeat(80));
  console.log('');

  if (!process.env.DATABASE_URL) {
    console.error('❌ ERROR: DATABASE_URL not available');
    process.exit(1);
  }

  const db = createDatabaseAdapter({}).initialize();
  
  if (db.type !== 'postgres') {
    console.error('❌ ERROR: This investigation requires PostgreSQL');
    process.exit(1);
  }

  await db.ensureSchema();

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 1: Inspect ALL foreign keys
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TASK 1: Complete Foreign Key Constraint Inventory');
  console.log('─'.repeat(80));

  const fkQuery = `
    SELECT
      tc.constraint_name,
      tc.table_name AS child_table,
      kcu.column_name AS child_column,
      ccu.table_name AS parent_table,
      ccu.column_name AS parent_column,
      rc.delete_rule AS on_delete,
      rc.update_rule AS on_update
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints AS rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = current_schema()
    ORDER BY tc.table_name, tc.constraint_name;
  `;

  const foreignKeys = await db.query(fkQuery);

  console.log(`Found ${foreignKeys.length} foreign key constraints:`);
  console.log('');

  for (const fk of foreignKeys) {
    console.log(`Constraint: ${fk.constraint_name}`);
    console.log(`  Child:  ${fk.child_table}.${fk.child_column}`);
    console.log(`  Parent: ${fk.parent_table}.${fk.parent_column}`);
    console.log(`  ON DELETE: ${fk.on_delete}`);
    console.log(`  ON UPDATE: ${fk.on_update}`);
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 2: Focus on the failing constraint
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('─'.repeat(80));
  console.log('TASK 2: Failing Constraint Analysis');
  console.log('─'.repeat(80));

  const failingConstraint = foreignKeys.find(
    fk => fk.constraint_name === 'inventory_movements_created_by_fkey'
  );

  if (!failingConstraint) {
    console.log('⚠️  Constraint "inventory_movements_created_by_fkey" not found');
  } else {
    console.log('Failing Constraint: inventory_movements_created_by_fkey');
    console.log(`  Child Table:  ${failingConstraint.child_table}`);
    console.log(`  Child Column: ${failingConstraint.child_column}`);
    console.log(`  Parent Table: ${failingConstraint.parent_table}`);
    console.log(`  Parent Column: ${failingConstraint.parent_column}`);
    console.log(`  ON DELETE: ${failingConstraint.on_delete}`);
    console.log('');

    // Get the user IDs from pharmacy 1
    const users = await db.query(
      'SELECT id FROM users WHERE pharmacy_id = ? ORDER BY id',
      [1]
    );
    const userIds = users.map(u => u.id);

    console.log(`Users belonging to pharmacy 1: ${userIds.join(', ')}`);
    console.log('');

    // Count inventory movements referencing these users
    if (userIds.length > 0) {
      const movementCount = await db.query(
        `SELECT COUNT(*) as count FROM inventory_movements WHERE created_by IN (${userIds.map(() => '?').join(',')})`,
        userIds
      );
      console.log(`Inventory movements created by these users: ${movementCount[0].count}`);
      console.log('');

      // Get batch ownership of those movements
      const movementDetails = await db.query(
        `
        SELECT 
          im.id as movement_id,
          im.batch_id,
          im.created_by,
          im.change_quantity,
          im.reason,
          mb.medicine_id,
          m.pharmacy_id
        FROM inventory_movements im
        JOIN medicine_batches mb ON mb.id = im.batch_id
        JOIN medicines m ON m.id = mb.medicine_id
        WHERE im.created_by IN (${userIds.map(() => '?').join(',')})
        ORDER BY im.id
        `,
        userIds
      );

      console.log('Movement details:');
      for (const mov of movementDetails) {
        console.log(`  Movement ${mov.movement_id}: batch ${mov.batch_id}, created_by user ${mov.created_by}, pharmacy ${mov.pharmacy_id}, reason: ${mov.reason}`);
      }
      console.log('');

      // Check if all movements belong to pharmacy 1
      const allPharmacy1 = movementDetails.every(m => m.pharmacy_id === 1);
      console.log(`All movements belong to pharmacy 1: ${allPharmacy1 ? 'YES ✅' : 'NO ❌'}`);
      console.log('');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 3: Inspect ALL cross-reference dependencies
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('─'.repeat(80));
  console.log('TASK 3: Cross-Reference Dependency Analysis');
  console.log('─'.repeat(80));

  // Group FKs by parent table
  const fksByParent = {};
  for (const fk of foreignKeys) {
    if (!fksByParent[fk.parent_table]) {
      fksByParent[fk.parent_table] = [];
    }
    fksByParent[fk.parent_table].push(fk);
  }

  console.log('Dependencies grouped by parent table:');
  console.log('');

  for (const [parent, fks] of Object.entries(fksByParent)) {
    console.log(`${parent}:`);
    for (const fk of fks) {
      const deleteAction = fk.on_delete === 'CASCADE' ? '🔄 CASCADE' : 
                          fk.on_delete === 'NO ACTION' ? '🚫 NO ACTION' :
                          fk.on_delete === 'RESTRICT' ? '🛑 RESTRICT' :
                          fk.on_delete === 'SET NULL' ? '∅ SET NULL' : fk.on_delete;
      console.log(`  ← ${fk.child_table}.${fk.child_column} [${deleteAction}]`);
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 4: Produce the actual dependency graph
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('─'.repeat(80));
  console.log('TASK 4: Actual Dependency Graph');
  console.log('─'.repeat(80));
  console.log('');

  // Build tree structure
  function buildTree(tableName, indent = 0, visited = new Set()) {
    if (visited.has(tableName)) {
      console.log('  '.repeat(indent) + `└── ${tableName} (circular reference)`);
      return;
    }
    visited.add(tableName);

    const children = fksByParent[tableName] || [];
    for (let i = 0; i < children.length; i++) {
      const fk = children[i];
      const isLast = i === children.length - 1;
      const prefix = isLast ? '└──' : '├──';
      const deleteAction = fk.on_delete === 'CASCADE' ? '[CASCADE]' : 
                          fk.on_delete === 'NO ACTION' ? '[NO ACTION]' :
                          fk.on_delete === 'RESTRICT' ? '[RESTRICT]' : `[${fk.on_delete}]`;
      
      console.log('  '.repeat(indent) + `${prefix} ${fk.child_table}.${fk.child_column} → ${fk.parent_table}.${fk.parent_column} ${deleteAction}`);
      
      // Recursively show children of this child table
      if (fksByParent[fk.child_table] && fk.child_table !== tableName) {
        buildTree(fk.child_table, indent + 1, new Set(visited));
      }
    }
  }

  console.log('pharmacies (root):');
  buildTree('pharmacies', 1);
  console.log('');

  console.log('users (critical node):');
  buildTree('users', 1);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 5: Determine SAFE deletion strategy
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('─'.repeat(80));
  console.log('TASK 5: Safe Deletion Strategy');
  console.log('─'.repeat(80));
  console.log('');

  console.log('Problem Analysis:');
  console.log('  1. pharmacies → users has CASCADE');
  console.log('  2. users → inventory_movements.created_by has NO ACTION/RESTRICT');
  console.log('  3. Deleting pharmacies triggers CASCADE to users');
  console.log('  4. Deleting users is blocked by inventory_movements reference');
  console.log('  5. Result: DELETE fails, transaction rolls back');
  console.log('');

  console.log('Solution:');
  console.log('  DELETE child records BEFORE their parents, in dependency order.');
  console.log('');

  console.log('Required Deletion Order (transactional):');
  console.log('');

  // Analyze which tables need explicit deletion
  const tablesWithNoAction = new Set();
  for (const fk of foreignKeys) {
    if (fk.on_delete !== 'CASCADE' && fk.on_delete !== 'SET NULL') {
      tablesWithNoAction.add(fk.child_table);
    }
  }

  let step = 1;
  
  console.log(`  ${step++}. BEGIN transaction`);
  console.log('');

  // Determine leaf tables (tables that aren't parents to any NO ACTION constraint)
  const leafTables = [];
  const parentTables = new Set(foreignKeys.filter(fk => fk.on_delete !== 'CASCADE').map(fk => fk.parent_table));
  
  for (const table of tablesWithNoAction) {
    const isParent = parentTables.has(table);
    if (!isParent) {
      leafTables.push(table);
    }
  }

  // Build ordered deletion list
  const deletionOrder = [];

  // Tables to explicitly delete (children with NO ACTION/RESTRICT constraints)
  const explicitDeletes = [
    'medicine_request_offers',
    'medicine_requests', 
    'medicine_redistribution_requests',
    'idempotency_keys',
    'device_pairing_codes',
    'expiry_alerts',
    'sale_items',
    'sales',
    'inventory_movements',  // CRITICAL: Must delete before users
    'medicine_batches',
    'medicines',
    'sessions',
    'paired_devices'
  ];

  for (const table of explicitDeletes) {
    console.log(`  ${step++}. DELETE FROM ${table} (explicit, breaks NO ACTION references)`);
    deletionOrder.push(table);
  }

  console.log('');
  console.log(`  ${step++}. DELETE FROM users (now safe, no references)`);
  deletionOrder.push('users');
  console.log('');
  console.log(`  ${step++}. DELETE FROM pharmacies (now safe, CASCADE only)`);
  deletionOrder.push('pharmacies');
  console.log('');
  console.log(`  ${step++}. Verify all tables = 0`);
  console.log('');
  console.log(`  ${step++}. COMMIT`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 6: Review cleanup script
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('─'.repeat(80));
  console.log('TASK 6: Cleanup Script Analysis');
  console.log('─'.repeat(80));
  console.log('');

  console.log('Current Script Strategy:');
  console.log('  DELETE FROM pharmacies WHERE id = 1');
  console.log('  (relies on CASCADE to delete all dependent records)');
  console.log('');

  console.log('Why It Failed:');
  console.log('  1. pharmacies → users has ON DELETE CASCADE');
  console.log('  2. PostgreSQL attempts to CASCADE delete users');
  console.log('  3. users → inventory_movements.created_by has NO ACTION');
  console.log('  4. PostgreSQL checks: can we delete these users?');
  console.log('  5. Answer: NO, inventory_movements still references them');
  console.log('  6. Constraint violation raised, transaction rolled back');
  console.log('');

  console.log('Required Script Changes:');
  console.log('  1. Delete child records FIRST (inventory_movements, sales, etc.)');
  console.log('  2. Delete users SECOND (after children removed)');
  console.log('  3. Delete pharmacies LAST (after users removed)');
  console.log('');

  console.log('Corrected Deletion Sequence:');
  let seqStep = 1;
  for (const table of deletionOrder) {
    if (table === 'users' || table === 'pharmacies') {
      console.log(`  ${seqStep++}. DELETE FROM ${table} WHERE ${table === 'users' ? 'pharmacy_id = 1' : 'id = 1'}`);
    } else {
      // Determine how to scope the delete
      const fkToPharmacy = foreignKeys.find(fk => fk.child_table === table && fk.parent_table === 'pharmacies');
      const fkToUsers = foreignKeys.find(fk => fk.child_table === table && fk.parent_table === 'users');
      const fkToMedicines = foreignKeys.find(fk => fk.child_table === table && fk.parent_table === 'medicines');
      
      if (fkToPharmacy) {
        console.log(`  ${seqStep++}. DELETE FROM ${table} WHERE ${fkToPharmacy.child_column} = 1`);
      } else if (fkToUsers) {
        console.log(`  ${seqStep++}. DELETE FROM ${table} WHERE ${fkToUsers.child_column} IN (SELECT id FROM users WHERE pharmacy_id = 1)`);
      } else if (fkToMedicines) {
        console.log(`  ${seqStep++}. DELETE FROM ${table} WHERE ${fkToMedicines.child_column} IN (SELECT id FROM medicines WHERE pharmacy_id = 1)`);
      } else {
        console.log(`  ${seqStep++}. DELETE FROM ${table} (via appropriate subquery)`);
      }
    }
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 7: Verify current database state (rollback confirmation)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('─'.repeat(80));
  console.log('TASK 7: Current Database State (Post-Rollback Verification)');
  console.log('─'.repeat(80));
  console.log('');

  const tables = [
    'pharmacies', 'users', 'sessions', 'medicines', 'medicine_batches',
    'inventory_movements', 'sales', 'sale_items', 'expiry_alerts',
    'paired_devices', 'device_pairing_codes', 'idempotency_keys',
    'medicine_redistribution_requests', 'medicine_requests', 'medicine_request_offers'
  ];

  const expectedCounts = {
    pharmacies: 1, users: 2, sessions: 30, medicines: 2, medicine_batches: 3,
    inventory_movements: 6, sales: 3, sale_items: 3, expiry_alerts: 1,
    paired_devices: 0, device_pairing_codes: 1, idempotency_keys: 0,
    medicine_redistribution_requests: 0, medicine_requests: 2, medicine_request_offers: 0
  };

  let stateChanged = false;
  console.log('Current row counts:');
  for (const table of tables) {
    const result = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
    const count = parseInt(result[0].count);
    const expected = expectedCounts[table];
    const match = count === expected;
    const status = match ? '✅' : '❌';
    
    console.log(`  ${status} ${table.padEnd(40)} ${count.toString().padStart(3)} (expected ${expected})`);
    
    if (!match) stateChanged = true;
  }

  console.log('');
  if (stateChanged) {
    console.log('⚠️  WARNING: Database state has changed since audit!');
  } else {
    console.log('✅ Database state unchanged (rollback successful)');
  }
  console.log('');

  await db.close();

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(80));
  console.log('INVESTIGATION COMPLETE');
  console.log('═'.repeat(80));
}

investigateForeignKeys().catch(err => {
  console.error('INVESTIGATION FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
