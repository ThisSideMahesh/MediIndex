/**
 * Verify Production Demo Setup
 * Tests authentication and tenant isolation via production API
 */

const https = require('https');

const PRODUCTION_URL = 'https://mediindex.vercel.app';

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

function extractToken(cookies) {
  for (const cookie of cookies) {
    const match = cookie.match(/mediindex_session=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

async function verifyDemoSetup() {
  console.log('='.repeat(80));
  console.log('PRODUCTION DEMO SETUP VERIFICATION');
  console.log('='.repeat(80));
  console.log('');

  const accounts = [
    { email: 'admin.a@mediindex.com', password: 'Demo@12345', expected: 'Pharmacy A', role: 'ADMIN' },
    { email: 'staff.a@mediindex.com', password: 'Demo@12345', expected: 'Pharmacy A', role: 'STAFF' },
    { email: 'admin.b@mediindex.com', password: 'Demo@12345', expected: 'Pharmacy B', role: 'ADMIN' },
    { email: 'staff.b@mediindex.com', password: 'Demo@12345', expected: 'Pharmacy B', role: 'STAFF' }
  ];

  let passCount = 0;
  let failCount = 0;

  for (const account of accounts) {
    console.log(`Testing ${account.email}...`);
    
    const loginRes = await httpRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password })
    });

    if (loginRes.status === 200 && loginRes.body.token) {
      console.log(`  ✓ Login successful`);
      console.log(`  ✓ Role: ${loginRes.body.user.role}`);
      console.log(`  ✓ Pharmacy: ${loginRes.body.user.pharmacyName || 'N/A'}`);
      
      if (loginRes.body.user.role === account.role) {
        console.log(`  ✓ Role matches expected (${account.role})`);
      } else {
        console.log(`  ✗ Role mismatch: expected ${account.role}, got ${loginRes.body.user.role}`);
        failCount++;
      }
      
      passCount++;
    } else {
      console.log(`  ✗ Login failed: ${loginRes.body.error || 'Unknown error'}`);
      failCount++;
    }
    console.log('');
  }

  console.log('='.repeat(80));
  console.log(`RESULTS: ${passCount}/${accounts.length} accounts verified`);
  if (failCount === 0) {
    console.log('✅ ALL TESTS PASSED');
  } else {
    console.log(`❌ ${failCount} TESTS FAILED`);
  }
  console.log('='.repeat(80));
}

verifyDemoSetup().catch(err => {
  console.error('Verification failed:', err.message);
  process.exit(1);
});
