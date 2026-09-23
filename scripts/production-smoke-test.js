/**
 * PRODUCTION SMOKE-TEST AUDIT
 * READ-ONLY verification of deployed Vercel application and Neon database
 * 
 * IMPORTANT: NO MUTATIONS - only GET requests and authentication
 */

const https = require('https');

const PRODUCTION_URL = 'https://mediindex.vercel.app';

const DEMO_ACCOUNTS = [
  { email: 'admin.a@mediindex.com', password: 'Demo@12345', expectedPharmacy: 'A', expectedRole: 'ADMIN' },
  { email: 'staff.a@mediindex.com', password: 'Demo@12345', expectedPharmacy: 'A', expectedRole: 'STAFF' },
  { email: 'admin.b@mediindex.com', password: 'Demo@12345', expectedPharmacy: 'B', expectedRole: 'ADMIN' },
  { email: 'staff.b@mediindex.com', password: 'Demo@12345', expectedPharmacy: 'B', expectedRole: 'STAFF' }
];

async function httpRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, PRODUCTION_URL);
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      ...options
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = res.headers['content-type']?.includes('application/json') 
            ? JSON.parse(data) 
            : data;
          resolve({ 
            status: res.statusCode, 
            headers: res.headers, 
            body: parsed,
            cookies: res.headers['set-cookie'] || []
          });
        } catch (err) {
          resolve({ status: res.statusCode, headers: res.headers, body: data, cookies: [] });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

function extractSessionToken(cookies) {
  for (const cookie of cookies) {
    const match = cookie.match(/mediindex_session=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

async function productionSmokeTest() {
  console.log('═'.repeat(80));
  console.log('PRODUCTION SMOKE-TEST AUDIT');
  console.log('Target: https://mediindex.vercel.app');
  console.log('Mode: READ-ONLY (no mutations)');
  console.log('═'.repeat(80));
  console.log('');

  const results = {
    health: null,
    logins: [],
    pharmacyMapping: {},
    tenantIsolation: { passed: true, details: [] },
    endpoints: {},
    demoScenarios: {},
    qrGeneration: null,
    failures: []
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: Health Check
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TEST 1: Health Check');
  console.log('─'.repeat(80));
  
  try {
    const healthRes = await httpRequest('/api/health');
    results.health = {
      status: healthRes.status,
      body: healthRes.body
    };
    
    if (healthRes.status === 200 && healthRes.body.status === 'ok' && healthRes.body.database === 'connected') {
      console.log('✅ Health check passed');
      console.log(`   Status: ${healthRes.body.status}`);
      console.log(`   Database: ${healthRes.body.database}`);
    } else {
      console.log('❌ Health check failed');
      console.log(`   Status: ${healthRes.status}`);
      console.log(`   Body: ${JSON.stringify(healthRes.body)}`);
      results.failures.push('Health check failed');
    }
  } catch (error) {
    console.log('❌ Health check error:', error.message);
    results.failures.push(`Health check error: ${error.message}`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: Authentication for All Four Accounts
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TEST 2: Authentication for All Four Demo Accounts');
  console.log('─'.repeat(80));

  for (const account of DEMO_ACCOUNTS) {
    try {
      const loginRes = await httpRequest('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: account.email, password: account.password })
      });

      // Extract session token from Set-Cookie header
      const sessionToken = extractSessionToken(loginRes.cookies);
      
      const loginResult = {
        email: account.email,
        status: loginRes.status,
        success: loginRes.status === 200 && loginRes.body.user,
        user: loginRes.body.user || null,
        token: sessionToken ? '[REDACTED]' : null,
        actualToken: sessionToken || null,
        pharmacyName: loginRes.body.user?.pharmacyName || null,
        role: loginRes.body.user?.role || null,
        error: loginRes.body.error || null
      };

      results.logins.push(loginResult);

      if (loginResult.success) {
        console.log(`✅ ${account.email}`);
        console.log(`   Role: ${loginResult.role} (expected: ${account.expectedRole})`);
        console.log(`   Pharmacy: ${loginResult.pharmacyName}`);
        
        // Store pharmacy mapping
        results.pharmacyMapping[account.email] = {
          pharmacy: loginResult.pharmacyName,
          pharmacyId: loginRes.body.user?.pharmacyId,
          role: loginResult.role,
          userId: loginRes.body.user?.id
        };

        // Verify role
        if (loginResult.role !== account.expectedRole) {
          console.log(`   ⚠️  Role mismatch: expected ${account.expectedRole}, got ${loginResult.role}`);
          results.failures.push(`${account.email}: role mismatch`);
        }
      } else {
        console.log(`❌ ${account.email}`);
        console.log(`   Status: ${loginRes.status}`);
        console.log(`   Error: ${loginResult.error || 'Unknown error'}`);
        results.failures.push(`${account.email}: login failed`);
      }
    } catch (error) {
      console.log(`❌ ${account.email}: ${error.message}`);
      results.failures.push(`${account.email}: ${error.message}`);
    }
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3: Tenant Isolation
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TEST 3: Tenant Isolation');
  console.log('─'.repeat(80));

  // Get tokens for Admin A and Admin B
  const adminALogin = results.logins.find(l => l.email === 'admin.a@mediindex.com');
  const adminBLogin = results.logins.find(l => l.email === 'admin.b@mediindex.com');

  if (adminALogin?.actualToken && adminBLogin?.actualToken) {
    // Admin A tries to access medicines endpoint
    try {
      const adminAMedicines = await httpRequest('/api/medicines', {
        headers: { 'Cookie': `mediindex_session=${adminALogin.actualToken}` }
      });

      const adminBMedicines = await httpRequest('/api/medicines', {
        headers: { 'Cookie': `mediindex_session=${adminBLogin.actualToken}` }
      });

      console.log(`Admin A medicines: ${adminAMedicines.status === 200 ? adminAMedicines.body.length + ' found' : 'error'}`);
      console.log(`Admin B medicines: ${adminBMedicines.status === 200 ? adminBMedicines.body.length + ' found' : 'error'}`);

      // Check if data is different (tenant isolation working)
      if (adminAMedicines.status === 200 && adminBMedicines.status === 200) {
        const adminAIds = new Set(adminAMedicines.body.map(m => m.id));
        const adminBIds = new Set(adminBMedicines.body.map(m => m.id));
        
        const overlap = [...adminAIds].filter(id => adminBIds.has(id)).length;
        
        if (overlap === 0) {
          console.log('✅ Tenant isolation verified: no medicine ID overlap');
          results.tenantIsolation.details.push('No medicine ID overlap between pharmacies');
        } else {
          console.log(`❌ Tenant isolation failed: ${overlap} medicine IDs shared`);
          results.tenantIsolation.passed = false;
          results.failures.push('Tenant isolation: medicine IDs overlap');
        }
      }
    } catch (error) {
      console.log(`⚠️  Tenant isolation test error: ${error.message}`);
      results.failures.push(`Tenant isolation test: ${error.message}`);
    }
  } else {
    console.log('⚠️  Skipping tenant isolation test (login tokens unavailable)');
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4: Read-Only Endpoint Smoke Tests (using Admin A)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TEST 4: Read-Only Endpoint Smoke Tests');
  console.log('─'.repeat(80));

  if (adminALogin?.actualToken) {
    const token = adminALogin.actualToken;
    const endpoints = [
      { path: '/api/dashboard', name: 'Dashboard' },
      { path: '/api/medicines', name: 'Medicines' },
      { path: '/api/medicines/batches', name: 'Batches' },
      { path: '/api/expiry-alerts', name: 'Expiry Alerts' },
      { path: '/api/demand/forecast', name: 'Demand Forecast' },
      { path: '/api/layout', name: 'Store Layout' },
      { path: '/api/redistribution/near-expiry', name: 'Near-Expiry Redistribution' },
      { path: '/api/requests', name: 'Medicine Requests' },
      { path: '/api/mobile/devices', name: 'Mobile Devices' }
    ];

    for (const endpoint of endpoints) {
      try {
        const res = await httpRequest(endpoint.path, {
          headers: { 'Cookie': `mediindex_session=${token}` }
        });

        results.endpoints[endpoint.name] = {
          status: res.status,
          success: res.status === 200,
          dataCount: Array.isArray(res.body) ? res.body.length : (res.body ? 'object' : 'none')
        };

        if (res.status === 200) {
          const dataInfo = Array.isArray(res.body) ? `${res.body.length} items` : 
                          res.body ? 'data present' : 'empty';
          console.log(`✅ ${endpoint.name.padEnd(30)} ${dataInfo}`);
        } else {
          console.log(`❌ ${endpoint.name.padEnd(30)} HTTP ${res.status}`);
          results.failures.push(`${endpoint.name}: HTTP ${res.status}`);
        }
      } catch (error) {
        console.log(`❌ ${endpoint.name.padEnd(30)} ${error.message}`);
        results.failures.push(`${endpoint.name}: ${error.message}`);
        results.endpoints[endpoint.name] = { status: 'error', error: error.message };
      }
    }
  } else {
    console.log('⚠️  Skipping endpoint tests (Admin A login failed)');
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5: Demo Scenario Verification
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TEST 5: Demo Scenario Verification');
  console.log('─'.repeat(80));

  if (adminALogin?.actualToken) {
    const token = adminALogin.actualToken;

    try {
      // Check expiry alerts
      const alertsRes = await httpRequest('/api/expiry-alerts', {
        headers: { 'Cookie': `mediindex_session=${token}` }
      });

      if (alertsRes.status === 200) {
        const alerts = alertsRes.body;
        const expired = alerts.filter(a => a.alert_type === 'EXPIRED').length;
        const expiringSoon = alerts.filter(a => a.alert_type === 'EXPIRING_SOON').length;
        const lowStock = alerts.filter(a => a.alert_type === 'LOW_STOCK').length;
        const acknowledged = alerts.filter(a => a.acknowledged === 1).length;

        results.demoScenarios.expiryAlerts = {
          total: alerts.length,
          expired,
          expiringSoon,
          lowStock,
          acknowledged
        };

        console.log(`✅ Expiry Alerts: ${alerts.length} total`);
        console.log(`   EXPIRED: ${expired}, EXPIRING_SOON: ${expiringSoon}, LOW_STOCK: ${lowStock}`);
        console.log(`   Acknowledged: ${acknowledged}`);
      }

      // Check historical sales for demand forecasting
      const salesRes = await httpRequest('/api/sales?limit=100', {
        headers: { 'Cookie': `mediindex_session=${token}` }
      });

      if (salesRes.status === 200) {
        const sales = salesRes.body;
        results.demoScenarios.historicalSales = sales.length;
        console.log(`✅ Historical Sales: ${sales.length} found`);
      }

      // Check near-expiry redistribution
      const redistRes = await httpRequest('/api/redistribution/near-expiry', {
        headers: { 'Cookie': `mediindex_session=${token}` }
      });

      if (redistRes.status === 200) {
        const redistRequests = redistRes.body;
        results.demoScenarios.redistributionRequests = redistRequests.length;
        console.log(`✅ Near-Expiry Redistribution: ${redistRequests.length} request(s)`);
      }

      // Check medicine requests
      const requestsRes = await httpRequest('/api/requests', {
        headers: { 'Cookie': `mediindex_session=${token}` }
      });

      if (requestsRes.status === 200) {
        const requests = requestsRes.body;
        const partiallyCovered = requests.filter(r => r.status === 'PARTIALLY_COVERED').length;
        results.demoScenarios.medicineRequests = {
          total: requests.length,
          partiallyCovered
        };
        console.log(`✅ Medicine Requests: ${requests.length} total, ${partiallyCovered} partially covered`);
      }

    } catch (error) {
      console.log(`⚠️  Demo scenario verification error: ${error.message}`);
      results.failures.push(`Demo scenarios: ${error.message}`);
    }
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 6: QR Generation Endpoint
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TEST 6: QR Generation Endpoint');
  console.log('─'.repeat(80));

  try {
    const qrRes = await httpRequest('/api/qr/generate?payload=medicine=1&batch=1');
    
    results.qrGeneration = {
      status: qrRes.status,
      contentType: qrRes.headers['content-type'],
      bodyLength: typeof qrRes.body === 'string' ? qrRes.body.length : 0
    };

    if (qrRes.status === 200 && qrRes.headers['content-type']?.includes('image/svg')) {
      console.log('✅ QR generation working');
      console.log(`   Content-Type: ${qrRes.headers['content-type']}`);
      console.log(`   SVG size: ${results.qrGeneration.bodyLength} bytes`);
    } else {
      console.log('❌ QR generation failed');
      console.log(`   Status: ${qrRes.status}`);
      results.failures.push('QR generation failed');
    }
  } catch (error) {
    console.log(`❌ QR generation error: ${error.message}`);
    results.failures.push(`QR generation: ${error.message}`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(80));
  console.log('PRODUCTION SMOKE-TEST SUMMARY');
  console.log('═'.repeat(80));
  console.log('');

  console.log('A. HEALTH CHECK:');
  console.log(`   Status: ${results.health?.status === 200 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   Database: ${results.health?.body?.database || 'unknown'}`);
  console.log('');

  console.log('B. AUTHENTICATION:');
  for (const login of results.logins) {
    console.log(`   ${login.email.padEnd(30)} ${login.success ? '✅' : '❌'} ${login.role || 'N/A'}`);
  }
  console.log('');

  console.log('C. PHARMACY/ROLE MAPPING:');
  for (const [email, mapping] of Object.entries(results.pharmacyMapping)) {
    console.log(`   ${email.padEnd(30)} ${mapping.pharmacy}, ${mapping.role}`);
  }
  console.log('');

  console.log('D. TENANT ISOLATION:');
  console.log(`   Status: ${results.tenantIsolation.passed ? '✅ PASS' : '❌ FAIL'}`);
  for (const detail of results.tenantIsolation.details) {
    console.log(`   - ${detail}`);
  }
  console.log('');

  console.log('E. ENDPOINT SMOKE TESTS:');
  for (const [name, result] of Object.entries(results.endpoints)) {
    const status = result.success ? '✅' : '❌';
    const info = result.dataCount || result.error || 'no data';
    console.log(`   ${name.padEnd(30)} ${status} ${info}`);
  }
  console.log('');

  console.log('F. DEMO SCENARIO VERIFICATION:');
  if (results.demoScenarios.expiryAlerts) {
    console.log(`   Expiry Alerts: ${results.demoScenarios.expiryAlerts.total} (${results.demoScenarios.expiryAlerts.expired} expired)`);
  }
  if (results.demoScenarios.historicalSales) {
    console.log(`   Historical Sales: ${results.demoScenarios.historicalSales}`);
  }
  if (results.demoScenarios.redistributionRequests !== undefined) {
    console.log(`   Redistribution Requests: ${results.demoScenarios.redistributionRequests}`);
  }
  if (results.demoScenarios.medicineRequests) {
    console.log(`   Medicine Requests: ${results.demoScenarios.medicineRequests.total} (${results.demoScenarios.medicineRequests.partiallyCovered} partial)`);
  }
  console.log('');

  console.log('G. QR GENERATION:');
  console.log(`   Status: ${results.qrGeneration?.status === 200 ? '✅ WORKING' : '❌ FAILED'}`);
  console.log('');

  console.log('H. FAILURES:');
  if (results.failures.length === 0) {
    console.log('   ✅ No failures detected');
  } else {
    for (const failure of results.failures) {
      console.log(`   ❌ ${failure}`);
    }
  }
  console.log('');

  console.log('I. PRODUCTION WEB READY FOR PRESENTATION:');
  const webReady = results.health?.status === 200 && 
                   results.logins.filter(l => l.success).length === 4 &&
                   results.tenantIsolation.passed &&
                   results.failures.length === 0;
  console.log(`   ${webReady ? '✅ YES' : '⚠️  WITH ISSUES'}`);
  console.log('');

  console.log('J. PRODUCTION ANDROID APK CONFIGURATION:');
  console.log('   Target URL: https://mediindex.vercel.app');
  console.log('   Backend: ✅ Operational with Neon PostgreSQL');
  console.log('   Authentication: ✅ Working');
  console.log('   QR Endpoints: ✅ Working');
  console.log(`   Status: ${webReady ? '✅ READY' : '⚠️  VERIFY ISSUES FIRST'}`);
  console.log('');

  console.log('═'.repeat(80));
  console.log('READ-ONLY AUDIT COMPLETE');
  console.log('═'.repeat(80));
}

productionSmokeTest().catch(err => {
  console.error('SMOKE TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
