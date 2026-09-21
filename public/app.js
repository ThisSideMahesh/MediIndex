const loginView = document.querySelector('#login-view');
const appView = document.querySelector('#app-view');
const errorBox = document.querySelector('#login-error');
const metrics = document.querySelector('#metrics');

const labels = {
  totalMedicines: 'Total medicines',
  totalStock: 'Total units in stock',
  expired: 'Expired batches',
  expiringSoon: 'Expiring within 30 days',
  lowStock: 'Low-stock medicines',
  todaySales: "Today's sales"
};

let currentUser = null;
let medicines = [];
let billingCart = [];
let currentMedicineBatches = [];

const formatCurrency = (val) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(val || 0);
const formatValue = (key, value) => key === 'todaySales' ? formatCurrency(value) : value;

async function api(path, options) {
  const response = await fetch(path, options);

  // Read the body as text first — never assume it's JSON. A non-2xx response
  // from an auth gateway, a Vercel error page, or an unhandled crash can return
  // HTML or plain text, and calling response.json() directly on that throws a
  // misleading "Unexpected token..." parse error instead of a useful message.
  const raw = await response.text();
  const contentType = response.headers.get('content-type') || '';
  const looksLikeJson = contentType.includes('application/json');

  let data = null;
  if (looksLikeJson && raw) {
    try { data = JSON.parse(raw); } catch { data = null; }
  }

  if (!response.ok) {
    // Prefer the server's own error message when we successfully parsed JSON.
    if (data && typeof data.error === 'string' && data.error) throw new Error(data.error);
    if (response.status === 401) throw new Error('Your session has expired. Please sign in again.');
    if (response.status === 403) throw new Error('You do not have permission for this action.');
    if (response.status === 404) throw new Error('The requested resource was not found.');
    if (response.status >= 500) throw new Error('The server is temporarily unavailable. Please try again.');
    throw new Error(`Request failed (HTTP ${response.status}).`);
  }

  // Success status but the body wasn't parseable JSON — never expose raw
  // HTML/text to the user; fail with a clear, generic message instead.
  if (!looksLikeJson || data === null) {
    throw new Error('The server returned an unexpected response.');
  }

  return data;
}

function openDialog(id) {
  document.querySelector(`#${id}`).showModal();
}

function closeDialog(id) {
  document.querySelector(`#${id}`).close();
}

// ----------------------------------------------------
// SERVER TIMESTAMP NORMALIZATION
//
// The API returns two timestamp shapes depending on the database engine:
//   * engine-written values (expiresAt, respondBy) are always full ISO-8601 UTC
//     e.g. "2026-09-24T17:57:25.064Z"
//   * database-generated values (createdAt, updatedAt, contactedAt, requestedAt)
//     come from CURRENT_TIMESTAMP. PostgreSQL returns ISO-8601 UTC, but SQLite
//     returns a NAIVE UTC string e.g. "2026-09-21 17:57:25" with no zone marker.
//
// `new Date("2026-09-21 17:57:25")` is interpreted as LOCAL time by the browser,
// which silently shifts the value by the viewer's UTC offset. Everything that
// needs a timestamp must therefore go through parseServerTime().
// ----------------------------------------------------
function parseServerTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  // Already carries a zone designator (Z or ±HH:MM / ±HHMM) — safe to parse.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
  const iso = hasZone ? text.replace(' ', 'T') : `${text.replace(' ', 'T')}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "23h 41m", "7h 12m", "18m", or null when already elapsed/unknown. */
function formatRemaining(value, now = Date.now()) {
  const date = parseServerTime(value);
  if (!date) return null;
  const ms = date.getTime() - now;
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Local-time display string for a server timestamp, or an em dash. */
function formatServerTime(value) {
  const date = parseServerTime(value);
  if (!date) return '—';
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

async function refreshDashboard() {
  const data = await api('/api/dashboard');
  metrics.innerHTML = Object.entries(labels).map(([key, label]) => `
    <article class="metric">
      <p>${label}</p>
      <strong>${formatValue(key, data[key])}</strong>
    </article>
  `).join('');
}

async function showApp(user) {
  currentUser = user;
  document.querySelector('#user-name').textContent = `${user.full_name || user.fullName} · ${user.role}`;
  await refreshDashboard();
  loginView.hidden = true;
  appView.hidden = false;

  // Show admin-only nav items
  document.querySelectorAll('.admin-only-nav').forEach(btn => {
    btn.hidden = (user.role !== 'ADMIN');
  });

  // In-app incoming medicine-request indicator. Fetched once on sign-in using the
  // existing request pattern — no polling loop, timer or background worker.
  refreshMedicineRequestBadge();

  // Initialise client-side sync module
  if (window.MediSync) {
    document.querySelector('#sync-status').hidden = false;
    await window.MediSync.init(({ status, pending, failed }) => {
      const el = document.querySelector('#sync-status');
      const icon = document.querySelector('#sync-icon');
      const label = document.querySelector('#sync-label');
      const pendingEl = document.querySelector('#sync-pending');

      // Remove all state classes
      el.classList.remove('is-online', 'is-offline', 'is-syncing', 'is-synced', 'is-failed');

      switch (status) {
        case 'online':
          el.classList.add('is-online');
          icon.textContent = '●';
          label.textContent = 'Online';
          pendingEl.hidden = true;
          break;
        case 'offline':
          el.classList.add('is-offline');
          icon.textContent = '◌';
          label.textContent = pending > 0 ? 'Offline — changes will sync automatically' : 'Offline';
          if (pending > 0) { pendingEl.textContent = `${pending} pending`; pendingEl.hidden = false; }
          else pendingEl.hidden = true;
          break;
        case 'syncing':
          el.classList.add('is-syncing');
          icon.textContent = '↻';
          label.textContent = `Syncing${pending > 0 ? ` ${pending} change${pending === 1 ? '' : 's'}` : ''}…`;
          pendingEl.hidden = true;
          break;
        case 'synced':
          el.classList.add('is-synced');
          icon.textContent = '✓';
          label.textContent = 'Synced';
          pendingEl.hidden = true;
          break;
        case 'failed':
          el.classList.add('is-failed');
          icon.textContent = '✕';
          label.textContent = `Sync failed`;
          const cnt = (pending || 0) + (failed || 0);
          if (cnt > 0) { pendingEl.textContent = `${cnt} pending`; pendingEl.hidden = false; }
          else pendingEl.hidden = true;
          break;
      }
    });
  }
}

function switchView(view) {
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  document.querySelector('#dashboard-view').hidden = view !== 'dashboard';
  document.querySelector('#inventory-view').hidden = view !== 'inventory';
  document.querySelector('#billing-view').hidden = view !== 'billing';
  document.querySelector('#analytics-view').hidden = view !== 'analytics';
  document.querySelector('#store-map-view').hidden = view !== 'store-map';
  document.querySelector('#expiry-view').hidden = view !== 'expiry';
  document.querySelector('#redistribution-view').hidden = view !== 'redistribution';
  document.querySelector('#medicine-requests-view').hidden = view !== 'medicine-requests';

  if (view === 'inventory') loadMedicines();
  if (view === 'billing') loadBillingView();
  if (view === 'analytics') loadAnalyticsView();
  if (view === 'store-map') loadStoreMapView();
  if (view === 'expiry') loadAlerts();
  if (view === 'redistribution') loadRedistributionRequests();
  if (view === 'medicine-requests') loadMedicineRequestsView();
}

// ----------------------------------------------------
// INVENTORY & BATCHES
// ----------------------------------------------------

function medicineCard(medicine) {
  const adminActions = currentUser.role === 'ADMIN'
    ? `<button class="secondary" data-edit="${medicine.id}">Edit</button><button class="danger" data-delete="${medicine.id}">Deactivate</button>`
    : '';

  return `
    <article class="medicine-card">
      <div class="medicine-main">
        <div>
          <h3>${escapeHtml(medicine.name)}</h3>
          <p>${escapeHtml(medicine.generic_name || 'No generic name')} · ${escapeHtml(medicine.manufacturer || 'Manufacturer not specified')}</p>
        </div>
        <span class="stock ${medicine.total_stock <= medicine.minimum_stock ? 'low' : ''}">${medicine.total_stock} units</span>
      </div>
      <div class="medicine-meta">
        <span>${escapeHtml(medicine.category || 'Uncategorised')}</span>
        <span>Minimum: ${medicine.minimum_stock}</span>
      </div>
      <div class="card-actions">
        <button data-batches="${medicine.id}">View batches</button>
        <button class="secondary" data-add-batch="${medicine.id}">Add batch</button>
        ${adminActions}
      </div>
      <div id="batches-${medicine.id}" class="batch-list" hidden></div>
    </article>
  `;
}

async function loadMedicines() {
  const query = document.querySelector('#medicine-search').value.trim();
  try {
    const response = await api(`/api/medicines?q=${encodeURIComponent(query)}`);
    medicines = response.medicines;
    document.querySelector('#medicine-count').textContent = `${medicines.length} medicine${medicines.length === 1 ? '' : 's'}`;
    document.querySelector('#medicine-list').innerHTML = medicines.length
      ? medicines.map(medicineCard).join('')
      : '<section class="panel empty"><h3>No medicines yet</h3><p>Add a medicine, then add its batch stock.</p></section>';
  } catch (error) {
    document.querySelector('#inventory-error').textContent = error.message;
  }
  // Show/hide inactive toggle for admins
  const toggleRow = document.querySelector('#inactive-toggle-row');
  if (toggleRow) toggleRow.style.display = currentUser && currentUser.role === 'ADMIN' ? 'block' : 'none';
}

function inactiveMedicineCard(medicine) {
  return `
    <article class="medicine-card inactive-medicine-card">
      <div class="medicine-main">
        <div>
          <h3>${escapeHtml(medicine.name)} <span class="badge warning" style="font-size:0.65rem;vertical-align:middle">INACTIVE</span></h3>
          <p>${escapeHtml(medicine.generic_name || 'No generic name')} · ${escapeHtml(medicine.manufacturer || 'Manufacturer not specified')}</p>
        </div>
        <span class="stock">${medicine.total_stock} units on-hand</span>
      </div>
      <div class="medicine-meta">
        <span>${escapeHtml(medicine.category || 'Uncategorised')}</span>
        <span>Minimum: ${medicine.minimum_stock}</span>
        <span class="muted">Deactivated</span>
      </div>
      <div class="card-actions">
        <button class="secondary" data-reactivate="${medicine.id}">Reactivate</button>
      </div>
    </article>
  `;
}

async function loadInactiveMedicines() {
  const container = document.querySelector('#inactive-medicine-list');
  try {
    const response = await api('/api/medicines/inactive');
    container.innerHTML = response.medicines.length
      ? response.medicines.map(inactiveMedicineCard).join('')
      : '<section class="panel empty"><h3>No inactive medicines</h3><p>Deactivated medicines will appear here.</p></section>';
  } catch (error) {
    document.querySelector('#inventory-error').textContent = error.message;
  }
}

async function toggleBatches(id) {
  const section = document.querySelector(`#batches-${id}`);
  if (!section.hidden) {
    section.hidden = true;
    return;
  }
  try {
    const response = await api(`/api/medicines/${id}/batches`);
    section.innerHTML = response.batches.length
      ? response.batches.map(batch => `
          <div class="batch-row">
            <strong>${escapeHtml(batch.batch_number)}</strong>
            <span>${batch.quantity} units</span>
            <span class="badge ${batch.expiry_status.toLowerCase()}">${batch.expiry_status.replace('_', ' ')}</span>
            <span>Expires ${batch.expiry_date}</span>
            <span>${escapeHtml(batch.location || 'No shelf')}</span>
            <button type="button" class="secondary small-btn" data-locate-shelf="${escapeHtml(batch.location || '')}">Map</button>
            <button type="button" class="secondary small-btn" data-qr-batch="${batch.id}">QR Sticker</button>
          </div>
        `).join('')
      : '<p class="muted">No batches added yet.</p>';
    section.hidden = false;
  } catch (error) {
    document.querySelector('#inventory-error').textContent = error.message;
  }
}

// ----------------------------------------------------
// BILLING & POINT OF SALE (POS)
// ----------------------------------------------------

async function loadBillingView() {
  document.querySelector('#pos-item-error').textContent = '';
  document.querySelector('#pos-checkout-error').textContent = '';
  
  // Load medicine options
  try {
    const response = await api('/api/medicines');
    medicines = response.medicines;
    const select = document.querySelector('#pos-medicine-select');
    select.innerHTML = '<option value="">-- Choose medicine --</option>' + medicines.map(m => `
      <option value="${m.id}" data-stock="${m.total_stock}">
        ${escapeHtml(m.name)} (Stock: ${m.total_stock})
      </option>
    `).join('');
  } catch (err) {
    document.querySelector('#pos-item-error').textContent = err.message;
  }

  await loadSalesHistory();
  renderCart();
}

async function onMedicineChange() {
  const medId = document.querySelector('#pos-medicine-select').value;
  const batchSelect = document.querySelector('#pos-batch-select');
  batchSelect.innerHTML = '<option value="">FEFO (Nearest expiry first)</option>';
  currentMedicineBatches = [];
  
  if (!medId) return;

  try {
    const res = await api(`/api/medicines/${medId}/batches`);
    currentMedicineBatches = (res.batches || []).filter(b => b.quantity > 0 && b.expiry_status !== 'EXPIRED');
    currentMedicineBatches.forEach(b => {
      batchSelect.innerHTML += `
        <option value="${b.id}">
          Batch ${escapeHtml(b.batch_number)} · ${b.quantity} left · Exp: ${b.expiry_date} · ₹${b.selling_price}
        </option>
      `;
    });
  } catch (err) {
    document.querySelector('#pos-item-error').textContent = err.message;
  }
}

function addCartItem() {
  const errorEl = document.querySelector('#pos-item-error');
  errorEl.textContent = '';

  const medId = Number(document.querySelector('#pos-medicine-select').value);
  if (!medId) {
    errorEl.textContent = 'Please select a medicine.';
    return;
  }

  const medicine = medicines.find(m => m.id === medId);
  if (!medicine) {
    errorEl.textContent = 'Selected medicine not found.';
    return;
  }

  const quantity = Number(document.querySelector('#pos-quantity').value);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    errorEl.textContent = 'Quantity must be a positive number.';
    return;
  }

  const batchId = document.querySelector('#pos-batch-select').value ? Number(document.querySelector('#pos-batch-select').value) : null;
  let batchLabel = 'FEFO (Auto-selected)';
  let unitPrice = 0;

  if (batchId) {
    const chosenBatch = currentMedicineBatches.find(b => b.id === batchId);
    if (!chosenBatch) {
      errorEl.textContent = 'Selected batch not found or out of stock.';
      return;
    }
    if (quantity > chosenBatch.quantity) {
      errorEl.textContent = `Only ${chosenBatch.quantity} units available in Batch ${chosenBatch.batch_number}.`;
      return;
    }
    batchLabel = `Batch ${chosenBatch.batch_number}`;
    unitPrice = chosenBatch.selling_price;
  } else {
    // FEFO check
    if (medicine.total_stock < quantity) {
      errorEl.textContent = `Insufficient stock. Total available: ${medicine.total_stock} units.`;
      return;
    }
    unitPrice = currentMedicineBatches.length > 0 ? currentMedicineBatches[0].selling_price : 0;
  }

  // Check if item already exists in cart with same batch
  const existingIndex = billingCart.findIndex(item => item.medicineId === medId && item.batchId === batchId);
  if (existingIndex > -1) {
    billingCart[existingIndex].quantity += quantity;
  } else {
    billingCart.push({
      medicineId: medId,
      medicineName: medicine.name,
      batchId: batchId,
      batchLabel: batchLabel,
      quantity: quantity,
      estimatedUnitPrice: unitPrice
    });
  }

  document.querySelector('#pos-quantity').value = 1;
  renderCart();
}

function removeCartItem(index) {
  billingCart.splice(index, 1);
  renderCart();
}

function renderCart() {
  const tbody = document.querySelector('#pos-items-body');
  const checkoutBtn = document.querySelector('#pos-checkout-btn');

  if (billingCart.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted text-center">No items added to bill yet.</td></tr>';
    document.querySelector('#pos-total-items').textContent = '0';
    document.querySelector('#pos-total-units').textContent = '0';
    document.querySelector('#pos-grand-total').textContent = '₹0.00';
    checkoutBtn.disabled = true;
    return;
  }

  let totalUnits = 0;
  let estimatedGrandTotal = 0;

  tbody.innerHTML = billingCart.map((item, idx) => {
    totalUnits += item.quantity;
    const estLineTotal = item.estimatedUnitPrice ? item.estimatedUnitPrice * item.quantity : 0;
    estimatedGrandTotal += estLineTotal;

    return `
      <tr>
        <td><strong>${escapeHtml(item.medicineName)}</strong></td>
        <td><span class="badge ${item.batchId ? 'safe' : ''}">${escapeHtml(item.batchLabel)}</span></td>
        <td>${item.quantity}</td>
        <td>${item.estimatedUnitPrice ? formatCurrency(item.estimatedUnitPrice) : 'FEFO Calc'}</td>
        <td>${item.estimatedUnitPrice ? formatCurrency(estLineTotal) : 'At checkout'}</td>
        <td><button type="button" class="danger small-btn" data-remove-cart="${idx}">Remove</button></td>
      </tr>
    `;
  }).join('');

  document.querySelector('#pos-total-items').textContent = String(billingCart.length);
  document.querySelector('#pos-total-units').textContent = String(totalUnits);
  document.querySelector('#pos-grand-total').textContent = estimatedGrandTotal > 0 ? formatCurrency(estimatedGrandTotal) : 'Calculated on submit';
  checkoutBtn.disabled = false;
}

async function handleCheckout(event) {
  event.preventDefault();
  const errorEl = document.querySelector('#pos-checkout-error');
  const submitBtn = document.querySelector('#pos-checkout-btn');
  errorEl.textContent = '';

  // POS/billing is intentionally online-only — FEFO requires live server inventory
  if (window.MediSync) {
    const { status } = window.MediSync.getStatus();
    if (status === 'offline') {
      errorEl.textContent = 'This operation requires an Internet connection. Billing and sales cannot be processed offline.';
      return;
    }
  }

  if (billingCart.length === 0) {
    errorEl.textContent = 'Cart is empty.';
    return;
  }

  const payload = {
    customerName: document.querySelector('#pos-customer-name').value.trim() || undefined,
    customerPhone: document.querySelector('#pos-customer-phone').value.trim() || undefined,
    paymentMethod: document.querySelector('#pos-payment-method').value,
    items: billingCart.map(item => ({
      medicineId: item.medicineId,
      batchId: item.batchId || undefined,
      quantity: item.quantity
    }))
  };

  submitBtn.disabled = true;
  submitBtn.textContent = 'Processing Sale...';

  try {
    const result = await api('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // Reset Cart & Form
    billingCart = [];
    document.querySelector('#pos-checkout-form').reset();
    renderCart();

    // Show Invoice Modal
    renderReceipt(result.sale);
    openDialog('receipt-dialog');

    // Refresh Background Data
    await refreshDashboard();
    await loadSalesHistory();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Complete Sale & Print Bill';
  }
}

async function loadSalesHistory() {
  try {
    const res = await api('/api/sales');
    const tbody = document.querySelector('#sales-history-body');
    if (!res.sales || res.sales.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted text-center">No sales recorded yet.</td></tr>';
      return;
    }

    tbody.innerHTML = res.sales.map(s => `
      <tr>
        <td><strong>${escapeHtml(s.invoice_number)}</strong></td>
        <td>${escapeHtml(s.created_at)}</td>
        <td>${escapeHtml(s.customer_name || 'Walk-in')}</td>
        <td>${s.total_items} items (${s.total_units} units)</td>
        <td><span class="badge">${escapeHtml(s.payment_method)}</span></td>
        <td><strong>${formatCurrency(s.total_amount)}</strong></td>
        <td>${escapeHtml(s.cashier_name)}</td>
        <td><button type="button" class="secondary small-btn" data-view-receipt="${s.id}">View Bill</button></td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load sales history:', err);
  }
}

async function viewReceipt(saleId) {
  try {
    const res = await api(`/api/sales/${saleId}`);
    renderReceipt(res.sale);
    openDialog('receipt-dialog');
  } catch (err) {
    alert('Failed to load invoice: ' + err.message);
  }
}

function renderReceipt(sale) {
  document.querySelector('#receipt-invoice-no').textContent = sale.invoice_number;
  document.querySelector('#receipt-date').textContent = sale.created_at;
  document.querySelector('#receipt-cashier').textContent = sale.cashier || sale.cashier_name || 'Staff';
  document.querySelector('#receipt-customer').textContent = sale.customer_name ? `${sale.customer_name} ${sale.customer_phone ? `(${sale.customer_phone})` : ''}` : 'Walk-in Customer';
  document.querySelector('#receipt-payment').textContent = sale.payment_method;
  document.querySelector('#receipt-grand-total').textContent = formatCurrency(sale.total_amount);

  const tbody = document.querySelector('#receipt-items-body');
  tbody.innerHTML = (sale.items || []).map(item => `
    <tr>
      <td>${escapeHtml(item.medicineName || item.medicine_name)}</td>
      <td>${escapeHtml(item.batchNumber || item.batch_number)}</td>
      <td>${item.quantity}</td>
      <td>${formatCurrency(item.unitPrice || item.unit_price)}</td>
      <td>${formatCurrency(item.lineTotal || item.line_total)}</td>
    </tr>
  `).join('');
}

// ----------------------------------------------------
// DEMAND FORECASTING & ANALYTICS
// ----------------------------------------------------

let forecastData = { summary: {}, items: [] };

async function loadAnalyticsView() {
  const errorEl = document.querySelector('#analytics-error');
  errorEl.textContent = '';
  try {
    const data = await api('/api/analytics/demand');
    forecastData = data;
    
    document.querySelector('#ana-total-meds').textContent = data.summary.totalMedicines || '0';
    document.querySelector('#ana-reliable-count').textContent = data.summary.reliableCount || '0';
    document.querySelector('#ana-insufficient-count').textContent = data.summary.insufficientDataCount || '0';
    document.querySelector('#ana-reorder-count').textContent = data.summary.reorderNeededCount || '0';
    document.querySelector('#ana-risk-count').textContent = data.summary.highRiskCount || '0';

    renderForecasts();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function renderForecasts() {
  const filter = document.querySelector('#forecast-status-filter').value;
  const search = (document.querySelector('#forecast-search').value || '').trim().toLowerCase();
  const tbody = document.querySelector('#forecast-body');

  let items = forecastData.items || [];
  if (filter === 'REORDER_NEEDED') items = items.filter(i => i.recommendedReorder > 0);
  if (filter === 'RELIABLE') items = items.filter(i => i.status === 'RELIABLE');
  if (filter === 'INSUFFICIENT_DATA') items = items.filter(i => i.status === 'INSUFFICIENT_DATA');

  if (search) {
    items = items.filter(i => i.medicineName.toLowerCase().includes(search) || (i.genericName && i.genericName.toLowerCase().includes(search)));
  }

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted text-center">No medicines match the selected filter.</td></tr>';
    return;
  }

  tbody.innerHTML = items.map(item => {
    const isReliable = item.status === 'RELIABLE';
    const statusBadge = isReliable
      ? '<span class="badge safe">RELIABLE FORECAST</span>'
      : '<span class="badge warning" title="Need at least 3 historical sales periods">INSUFFICIENT DATA</span>';

    const demandDisplay = isReliable
      ? `<strong>${item.forecast.monthly30DayDemand} units</strong> <span class="muted font-xs">(${item.forecast.weeklyDemand}/wk)</span>`
      : '<span class="muted">N/A (&lt;3 periods)</span>';

    const riskBadgeClass = {
      'OUT_OF_STOCK': 'expired',
      'HIGH_RUNOUT_RISK': 'expired',
      'LOW_STOCK': 'expiring_soon',
      'REORDER_NEEDED': 'expiring_soon',
      'OPTIMAL_STOCK': 'safe',
      'MONITORING': ''
    }[item.riskLevel] || '';

    const riskLabel = item.riskLevel.replace(/_/g, ' ');

    return `
      <tr>
        <td>
          <strong>${escapeHtml(item.medicineName)}</strong>
          <div class="muted font-xs">${escapeHtml(item.genericName || '')} · ${escapeHtml(item.category || 'Uncategorised')}</div>
        </td>
        <td>
          <strong>${item.currentStock} units</strong>
          <div class="muted font-xs">Min: ${item.minimumStock}</div>
        </td>
        <td>${statusBadge}</td>
        <td>${demandDisplay}</td>
        <td>${item.safetyStock} units</td>
        <td>
          <strong class="${item.recommendedReorder > 0 ? 'text-danger' : 'text-success'}">
            ${item.recommendedReorder} units
          </strong>
        </td>
        <td><span class="badge ${riskBadgeClass}">${riskLabel}</span></td>
        <td><button type="button" class="secondary small-btn" data-view-forecast="${item.medicineId}">Details</button></td>
      </tr>
    `;
  }).join('');
}

function openForecastDetails(medicineId) {
  const item = (forecastData.items || []).find(i => i.medicineId === medicineId);
  if (!item) return;

  document.querySelector('#forecast-dialog-title').textContent = item.medicineName;
  document.querySelector('#forecast-dialog-subtitle').textContent = `Category: ${item.category || 'N/A'} · Current Stock: ${item.currentStock} units · Minimum Stock: ${item.minimumStock} units`;

  const container = document.querySelector('#forecast-dialog-content');
  if (item.status === 'INSUFFICIENT_DATA') {
    container.innerHTML = `
      <div class="alert-card expiring_soon" style="margin: 14px 0;">
        <div>
          <h3>Insufficient Data For Reliable Forecast</h3>
          <p>The statistical Weighted Moving Average (WMA) method requires sales data across at least 3 distinct calendar periods (weeks) to compute a meaningful trend and variance. Currently, only <strong>${item.periodsFound} of ${item.periodsRequired}</strong> required periods exist in the database.</p>
        </div>
      </div>
      <div class="pos-summary">
        <div class="summary-row"><span>Total units sold to date:</span><strong>${item.totalSold}</strong></div>
        <div class="summary-row"><span>Baseline safety stock:</span><strong>${item.safetyStock} units (Minimum stock threshold)</strong></div>
        <div class="summary-row"><span>Recommended replenishment:</span><strong>${item.recommendedReorder} units</strong></div>
      </div>
    `;
  } else {
    const f = item.forecast;
    container.innerHTML = `
      <div class="pos-summary" style="margin: 14px 0;">
        <div class="summary-row"><span>Forecast Method:</span><strong>3-Period Weighted Moving Average</strong></div>
        <div class="summary-row"><span>Weights Applied:</span><strong>w₁ = 50% (latest), w₂ = 30%, w₃ = 20%</strong></div>
        <div class="summary-row"><span>Weighted Weekly Demand:</span><strong>${f.weeklyDemand} units / week</strong></div>
        <div class="summary-row"><span>30-Day Monthly Forecast:</span><strong>${f.monthly30DayDemand} units</strong></div>
        <div class="summary-row"><span>Historical Std Dev (σ):</span><strong>${f.historicalStdDev} units</strong></div>
        <div class="summary-row"><span>Safety Stock (Z = 1.65):</span><strong>${item.safetyStock} units</strong></div>
        <div class="summary-row grand-total"><span>Recommended Reorder (R):</span><strong>${item.recommendedReorder} units</strong></div>
      </div>
      <h4>Historical Sales Contribution</h4>
      <div class="table-responsive">
        <table class="pos-table">
          <thead>
            <tr>
              <th>Period (Week)</th>
              <th>Weight</th>
              <th>Quantity Sold</th>
              <th>Weighted Contribution</th>
            </tr>
          </thead>
          <tbody>
            ${f.periodData.map(p => `
              <tr>
                <td>${escapeHtml(p.period)}</td>
                <td>${Math.round(p.weight * 100)}%</td>
                <td>${p.quantity} units</td>
                <td><strong>${(p.quantity * p.weight).toFixed(2)} units</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  openDialog('forecast-dialog');
}

// ----------------------------------------------------
// QR IDENTIFICATION & SCANNING
// ----------------------------------------------------

let currentQrData = null;
let currentScannerMode = 'POS';
let qrCameraStream = null;

async function openQrSticker(batchId) {
  try {
    const res = await api(`/api/batches/${batchId}/qr`);
    currentQrData = res;
    
    document.querySelector('#qr-sticker-med-name').textContent = res.sticker.medicineName;
    document.querySelector('#qr-sticker-gen-name').textContent = `${res.sticker.genericName || 'No generic name'} · ${res.sticker.category || 'Medicine'}`;
    document.querySelector('#qr-sticker-batch-no').textContent = res.sticker.batchNumber;
    document.querySelector('#qr-sticker-expiry').textContent = res.sticker.expiryDate;
    document.querySelector('#qr-sticker-price').textContent = formatCurrency(res.sticker.sellingPrice);
    document.querySelector('#qr-sticker-location').textContent = res.sticker.location || 'Unassigned';
    document.querySelector('#qr-sticker-raw-payload').textContent = res.payloadString;

    const svgWrapper = document.querySelector('#qr-sticker-svg-wrapper');
    svgWrapper.innerHTML = window.QRCodeGenerator ? window.QRCodeGenerator.generateSVG(res.payloadString, 4) : '<span>QR Generator Ready</span>';

    openDialog('qr-sticker-dialog');
  } catch (err) {
    alert('Failed to generate batch QR code: ' + err.message);
  }
}

async function openQrScanner(mode = 'POS') {
  currentScannerMode = mode;
  document.querySelector('#qr-scan-input').value = '';
  document.querySelector('#qr-scan-error').textContent = '';
  document.querySelector('#qr-scan-result-card').hidden = true;
  currentQrData = null;

  document.querySelector('#qr-scanner-dialog-title').textContent = mode === 'POS' ? 'Scan QR Code for Point of Sale' : 'Scan QR to Locate in Inventory';
  document.querySelector('#qr-apply-action-btn').textContent = mode === 'POS' ? 'Add Item to Bill' : 'View in Inventory';

  // Load sample test buttons for quick evaluation
  try {
    const medRes = await api('/api/medicines');
    const sampleContainer = document.querySelector('#qr-quick-samples');
    sampleContainer.innerHTML = '';
    const sampleMeds = (medRes.medicines || []).slice(0, 3);
    for (const m of sampleMeds) {
      const bRes = await api(`/api/medicines/${m.id}/batches`);
      if (bRes.batches && bRes.batches.length > 0) {
        const b = bRes.batches[0];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary small-btn';
        btn.textContent = `${m.name} (${b.batch_number})`;
        btn.addEventListener('click', () => {
          const samplePayload = JSON.stringify({ app: 'MEDIINDEX', v: 1, medicineId: m.id, batchNumber: b.batch_number });
          document.querySelector('#qr-scan-input').value = samplePayload;
          verifyQrPayload(samplePayload);
        });
        sampleContainer.appendChild(btn);
      }
    }
  } catch {}

  openDialog('qr-scanner-dialog');
}

async function verifyQrPayload(payloadText) {
  const errorEl = document.querySelector('#qr-scan-error');
  errorEl.textContent = '';
  document.querySelector('#qr-scan-result-card').hidden = true;

  if (!payloadText || !payloadText.trim()) {
    errorEl.textContent = 'Please enter or scan a valid QR payload string.';
    return;
  }

  try {
    const res = await api('/api/qr/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: payloadText.trim() })
    });

    currentQrData = res;
    document.querySelector('#qr-result-med-name').textContent = res.medicine.name;
    document.querySelector('#qr-result-batch-details').textContent = `Batch Lot: ${res.batch.batchNumber} · Expiry: ${res.batch.expiryDate} (${res.batch.expiryStatus.replace('_', ' ')})`;
    document.querySelector('#qr-result-med-id').textContent = res.medicine.id;
    document.querySelector('#qr-result-stock').textContent = `${res.batch.quantity} units in this batch`;
    document.querySelector('#qr-result-price').textContent = formatCurrency(res.batch.sellingPrice);
    document.querySelector('#qr-result-expiry').textContent = res.batch.expiryStatus.replace('_', ' ');

    document.querySelector('#qr-scan-result-card').hidden = false;
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

async function applyQrResult() {
  if (!currentQrData || !currentQrData.valid) return;
  const { medicine, batch } = currentQrData;

  stopCamera();
  closeDialog('qr-scanner-dialog');

  if (currentScannerMode === 'POS') {
    switchView('billing');
    await loadBillingView();
    const medSelect = document.querySelector('#pos-medicine-select');
    medSelect.value = medicine.id;
    await onMedicineChange();
    const batchSelect = document.querySelector('#pos-batch-select');
    batchSelect.value = batch.id;
    document.querySelector('#pos-quantity').value = 1;
    addCartItem();
  } else {
    switchView('inventory');
    document.querySelector('#medicine-search').value = medicine.name;
    await loadMedicines();
    await toggleBatches(medicine.id);
  }
}

async function toggleCamera() {
  const video = document.querySelector('#qr-camera-video');
  const placeholder = document.querySelector('#qr-camera-placeholder');
  const btn = document.querySelector('#qr-toggle-camera-btn');
  const statusText = document.querySelector('#qr-camera-status-text');

  if (qrCameraStream) {
    stopCamera();
    return;
  }

  try {
    statusText.textContent = 'Requesting camera access...';
    qrCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = qrCameraStream;
    await video.play();
    video.style.display = 'block';
    placeholder.style.display = 'none';
    btn.textContent = 'Stop Camera';
    statusText.textContent = 'Camera active. Point at physical QR code sticker.';
  } catch (err) {
    statusText.textContent = 'Camera access unavailable or denied. Please use the instant simulation / paste input.';
    btn.textContent = 'Camera Unavailable';
    btn.disabled = true;
  }
}

function stopCamera() {
  if (qrCameraStream) {
    qrCameraStream.getTracks().forEach(track => track.stop());
    qrCameraStream = null;
  }
  const video = document.querySelector('#qr-camera-video');
  const placeholder = document.querySelector('#qr-camera-placeholder');
  const btn = document.querySelector('#qr-toggle-camera-btn');
  const statusText = document.querySelector('#qr-camera-status-text');
  if (video) video.style.display = 'none';
  if (placeholder) placeholder.style.display = 'flex';
  if (btn) {
    btn.textContent = 'Start Live Camera';
    btn.disabled = false;
  }
  if (statusText) statusText.textContent = 'Webcam scanner ready. Click below to start camera or use instant code simulation.';
}

// ----------------------------------------------------
// 2D PHARMACY STORE & SHELF MAP (MOD-11)
// ----------------------------------------------------

let storeMapData = { shelves: [], unassigned: { batches: [] } };
let selectedShelfId = null;

async function loadStoreMapView() {
  try {
    const res = await api('/api/layout/shelves');
    storeMapData = res;
    renderShelvesOnMap();
    if (selectedShelfId) {
      selectShelf(selectedShelfId);
    } else if (res.shelves && res.shelves.length > 0) {
      selectShelf(res.shelves[0].id);
    }
  } catch (err) {
    console.error('Failed to load store map:', err);
  }
}

function renderShelvesOnMap() {
  const shelfMap = new Map();
  (storeMapData.shelves || []).forEach(s => shelfMap.set(s.id.toLowerCase(), s));

  document.querySelectorAll('.shelf-node').forEach(node => {
    const shelfId = node.dataset.shelfId;
    if (!shelfId) return;

    if (shelfId === 'unassigned') {
      const u = storeMapData.unassigned || { totalBatches: 0, totalUnits: 0 };
      const badge = document.querySelector('#badge-unassigned');
      if (badge) badge.textContent = `${u.totalBatches} batches (${u.totalUnits}u)`;
      node.classList.toggle('occupied', u.totalUnits > 0);
      node.classList.toggle('empty-shelf', u.totalUnits === 0);
      return;
    }

    const shelf = shelfMap.get(shelfId.toLowerCase());
    const badgeId = `#badge-${shelfId.toLowerCase().replace(/[\s_]+/g, '-')}`;
    const badgeEl = document.querySelector(badgeId);

    if (shelf) {
      if (badgeEl) {
        badgeEl.textContent = `${shelf.totalBatches} batch${shelf.totalBatches === 1 ? '' : 'es'} (${shelf.totalUnits}u)`;
      }

      node.classList.remove('occupied', 'empty-shelf', 'has-expiring', 'has-expired');
      if (shelf.totalUnits === 0) {
        node.classList.add('empty-shelf');
      } else {
        node.classList.add('occupied');
        if (shelf.expiredBatches > 0) node.classList.add('has-expired');
        else if (shelf.expiringSoonBatches > 0) node.classList.add('has-expiring');
      }
    }
  });
}

function selectShelf(shelfId) {
  selectedShelfId = shelfId;

  document.querySelectorAll('.shelf-node').forEach(node => {
    node.classList.toggle('active-shelf', (node.dataset.shelfId || '').toLowerCase() === shelfId.toLowerCase());
  });

  const isUnassigned = shelfId === 'unassigned';
  const shelf = isUnassigned
    ? {
        id: 'Unassigned Storage Bay',
        label: 'Receiving & Quarantine Bay',
        zone: 'Custom / Unassigned',
        description: 'Batches without standard rack labels',
        totalBatches: storeMapData.unassigned ? storeMapData.unassigned.totalBatches : 0,
        totalUnits: storeMapData.unassigned ? storeMapData.unassigned.totalUnits : 0,
        expiredBatches: (storeMapData.unassigned ? storeMapData.unassigned.batches : []).filter(b => b.expiryStatus === 'EXPIRED').length,
        expiringSoonBatches: (storeMapData.unassigned ? storeMapData.unassigned.batches : []).filter(b => b.expiryStatus === 'EXPIRING_SOON').length,
        batches: storeMapData.unassigned ? storeMapData.unassigned.batches : []
      }
    : (storeMapData.shelves || []).find(s => s.id.toLowerCase() === shelfId.toLowerCase());

  if (!shelf) return;

  document.querySelector('#inspector-shelf-zone').textContent = `ZONE: ${shelf.zone ? shelf.zone.toUpperCase() : 'MAIN'}`;
  document.querySelector('#inspector-shelf-title').textContent = `${shelf.id} — ${shelf.label || ''}`;
  document.querySelector('#inspector-shelf-desc').textContent = shelf.description || 'Standard Storage Shelf';

  document.querySelector('#inspector-batch-count').textContent = shelf.totalBatches || 0;
  document.querySelector('#inspector-unit-count').textContent = `${shelf.totalUnits || 0} units`;
  
  const alertCount = (shelf.expiredBatches || 0) + (shelf.expiringSoonBatches || 0);
  const alertEl = document.querySelector('#inspector-alert-count');
  alertEl.textContent = `${alertCount} alert${alertCount === 1 ? '' : 's'}`;
  alertEl.className = alertCount > 0 ? 'text-danger' : 'text-success';

  const tbody = document.querySelector('#inspector-body');
  const batches = shelf.batches || [];

  if (batches.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted text-center">No medicine batches currently stocked in this shelf.</td></tr>';
    return;
  }

  tbody.innerHTML = batches.map(b => `
    <tr>
      <td>
        <strong>${escapeHtml(b.medicine.name)}</strong>
        <div class="muted font-xs">${escapeHtml(b.medicine.genericName || '')}</div>
      </td>
      <td><code>${escapeHtml(b.batchNumber)}</code></td>
      <td><strong>${b.quantity}u</strong></td>
      <td><span class="badge ${b.expiryStatus.toLowerCase()}">${b.expiryDate}</span></td>
      <td>
        <button type="button" class="secondary small-btn" data-bill-batch="${b.id}" data-med-id="${b.medicine.id}">Bill</button>
      </td>
    </tr>
  `).join('');
}

function highlightMedicineOnMap(query) {
  query = (query || '').trim().toLowerCase();
  document.querySelectorAll('.shelf-node').forEach(n => n.classList.remove('pulsing-highlight'));

  if (!query) return;

  let firstMatchShelf = null;
  (storeMapData.shelves || []).forEach(shelf => {
    const hasMatch = (shelf.batches || []).some(b => 
      b.medicine.name.toLowerCase().includes(query) || 
      (b.medicine.genericName && b.medicine.genericName.toLowerCase().includes(query)) ||
      b.batchNumber.toLowerCase().includes(query)
    );

    if (hasMatch) {
      const node = document.querySelector(`.shelf-node[data-shelf-id="${shelf.id}"]`);
      if (node) {
        node.classList.add('pulsing-highlight');
        if (!firstMatchShelf) firstMatchShelf = shelf.id;
      }
    }
  });

  const unassignedMatch = (storeMapData.unassigned ? storeMapData.unassigned.batches : []).some(b =>
    b.medicine.name.toLowerCase().includes(query) ||
    (b.medicine.genericName && b.medicine.genericName.toLowerCase().includes(query)) ||
    b.batchNumber.toLowerCase().includes(query)
  );
  if (unassignedMatch) {
    const node = document.querySelector('.shelf-node[data-shelf-id="unassigned"]');
    if (node) {
      node.classList.add('pulsing-highlight');
      if (!firstMatchShelf) firstMatchShelf = 'unassigned';
    }
  }

  if (firstMatchShelf) {
    selectShelf(firstMatchShelf);
  }
}

async function locateAndHighlightShelf(locationStr) {
  switchView('store-map');
  await loadStoreMapView();

  locationStr = (locationStr || '').trim().toLowerCase();
  let matchedShelf = null;

  for (const s of (storeMapData.shelves || [])) {
    if (locationStr === s.id.toLowerCase() || locationStr.includes(s.id.toLowerCase()) || s.id.toLowerCase().includes(locationStr)) {
      matchedShelf = s.id;
      break;
    }
  }

  const targetId = matchedShelf || 'unassigned';
  selectShelf(targetId);
  const node = document.querySelector(`.shelf-node[data-shelf-id="${targetId}"]`);
  if (node) {
    node.classList.add('pulsing-highlight');
    setTimeout(() => node.classList.remove('pulsing-highlight'), 3500);
  }
}

// ----------------------------------------------------
// EXPIRY ALERTS
// ----------------------------------------------------

async function loadAlerts() {
  const status = document.querySelector('#alert-status').value;
  const acknowledged = document.querySelector('#alert-ack').value;
  try {
    const response = await api(`/api/expiry-alerts?status=${status}&acknowledged=${acknowledged}`);
    document.querySelector('#alert-list').innerHTML = response.alerts.length
      ? response.alerts.map(alert => `
          <article class="alert-card ${alert.alert_type.toLowerCase()}">
            <div>
              <span class="badge ${alert.alert_type.toLowerCase()}">${alert.alert_type === 'EXPIRED' ? 'EXPIRED' : `${alert.days_to_expiry} DAYS LEFT`}</span>
              <h3>${escapeHtml(alert.medicine_name)}</h3>
              <p>Batch ${escapeHtml(alert.batch_number)} · ${alert.quantity} units · Expires ${alert.expiry_date}${alert.location ? ` · ${escapeHtml(alert.location)}` : ''}</p>
            </div>
            <div>
              ${alert.acknowledged ? '<span class="muted">Acknowledged</span>' : `<button class="secondary" data-ack-alert="${alert.id}">Acknowledge</button>`}
            </div>
          </article>
        `).join('')
      : '<section class="panel empty"><h3>No matching alerts</h3><p>Expiry alerts are generated from active batch quantities and expiry dates.</p></section>';
  } catch (error) {
    document.querySelector('#alert-error').textContent = error.message;
  }
}

// ----------------------------------------------------
// EVENT LISTENERS & INITIALIZATION
// ----------------------------------------------------

document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  errorBox.textContent = '';
  const button = event.submitter;
  button.disabled = true;
  button.textContent = 'Signing in...';
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value, password: password.value })
    });
    await showApp(result.user);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

document.querySelector('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  appView.hidden = true;
  loginView.hidden = false;
});

document.querySelectorAll('.nav').forEach(button => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});

document.querySelector('#medicine-search').addEventListener('input', () => {
  clearTimeout(window.searchTimer);
  window.searchTimer = setTimeout(loadMedicines, 180);
});

document.querySelector('#toggle-inactive-btn').addEventListener('click', async () => {
  const section = document.querySelector('#inactive-medicines-section');
  const btn = document.querySelector('#toggle-inactive-btn');
  if (!section.hidden) {
    section.hidden = true;
    btn.textContent = 'Show inactive medicines';
  } else {
    await loadInactiveMedicines();
    section.hidden = false;
    btn.textContent = 'Hide inactive medicines';
  }
});

document.querySelector('#inactive-medicine-list').addEventListener('click', async event => {
  const id = Number(event.target.dataset.reactivate);
  if (!id) return;
  if (!confirm('Reactivate this medicine? It will be restored to the active catalogue.')) return;
  try {
    await api(`/api/medicines/${id}/reactivate`, { method: 'POST' });
    await loadMedicines();
    await loadInactiveMedicines();
    await refreshDashboard();
  } catch (error) {
    document.querySelector('#inventory-error').textContent = error.message;
  }
});

document.querySelector('#add-medicine').addEventListener('click', () => {
  if (currentUser.role !== 'ADMIN') {
    document.querySelector('#inventory-error').textContent = 'Only an administrator can create medicines.';
    return;
  }
  document.querySelector('#medicine-form').reset();
  document.querySelector('#medicine-id').value = '';
  document.querySelector('#medicine-form-title').textContent = 'Add medicine';
  openDialog('medicine-dialog');
});

document.querySelector('#medicine-list').addEventListener('click', async event => {
  const qrBatchId = Number(event.target.dataset.qrBatch);
  if (qrBatchId) return openQrSticker(qrBatchId);

  const id = Number(event.target.dataset.batches || event.target.dataset.addBatch || event.target.dataset.edit || event.target.dataset.delete);
  if (!id) return;
  const medicine = medicines.find(item => item.id === id);

  if (event.target.dataset.batches) return toggleBatches(id);

  if (event.target.dataset.addBatch) {
    document.querySelector('#batch-form').reset();
    document.querySelector('#batch-medicine-id').value = id;
    document.querySelector('#batch-medicine-label').textContent = medicine.name;
    return openDialog('batch-dialog');
  }

  if (event.target.dataset.edit) {
    document.querySelector('#medicine-id').value = id;
    document.querySelector('#medicine-name').value = medicine.name;
    document.querySelector('#medicine-generic').value = medicine.generic_name || '';
    document.querySelector('#medicine-manufacturer').value = medicine.manufacturer || '';
    document.querySelector('#medicine-category').value = medicine.category || '';
    document.querySelector('#medicine-minimum').value = medicine.minimum_stock;
    document.querySelector('#medicine-form-title').textContent = 'Edit medicine';
    return openDialog('medicine-dialog');
  }

  if (event.target.dataset.delete && confirm(`Deactivate ${medicine.name}? Existing sales data will be preserved.`)) {
    try {
      await api(`/api/medicines/${id}`, { method: 'DELETE' });
      await loadMedicines();
      await refreshDashboard();
    } catch (error) {
      document.querySelector('#inventory-error').textContent = error.message;
    }
  }
});

document.querySelector('#medicine-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = document.querySelector('#medicine-id').value;
  const body = {
    name: document.querySelector('#medicine-name').value,
    genericName: document.querySelector('#medicine-generic').value,
    manufacturer: document.querySelector('#medicine-manufacturer').value,
    category: document.querySelector('#medicine-category').value,
    minimumStock: document.querySelector('#medicine-minimum').value
  };
  try {
    await api(id ? `/api/medicines/${id}` : '/api/medicines', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    closeDialog('medicine-dialog');
    await loadMedicines();
    await refreshDashboard();
  } catch (error) {
    document.querySelector('#medicine-form-error').textContent = error.message;
  }
});

document.querySelector('#batch-form').addEventListener('submit', async event => {
  event.preventDefault();
  const medicineId = document.querySelector('#batch-medicine-id').value;
  const body = {
    batchNumber: document.querySelector('#batch-number').value,
    quantity: document.querySelector('#batch-quantity').value,
    purchasePrice: document.querySelector('#batch-purchase').value,
    sellingPrice: document.querySelector('#batch-selling').value,
    manufacturingDate: document.querySelector('#batch-manufacturing').value,
    expiryDate: document.querySelector('#batch-expiry').value,
    location: document.querySelector('#batch-location').value
  };
  const errorEl = document.querySelector('#batch-form-error');
  errorEl.textContent = '';

  // --- Offline guard: creating a new batch requires an Internet connection.
  // The offline /api/sync/stock-receipt endpoint handles ADDITIONS to an existing batch,
  // not new batch creation (which requires selling price, expiry date, location, etc.).
  // Show a clear message rather than queuing a doomed operation.
  if (window.MediSync) {
    const { status } = window.MediSync.getStatus();
    if (status === 'offline') {
      errorEl.textContent = 'Adding a new batch requires an Internet connection. Please reconnect and try again.';
      return;
    }
  }

  // Online: use the existing batch-creation endpoint
  try {
    await api(`/api/medicines/${medicineId}/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    closeDialog('batch-dialog');
    await loadMedicines();
    await refreshDashboard();
  } catch (error) {
    errorEl.textContent = error.message;
  }
});

// POS Specific Listeners
document.querySelector('#pos-medicine-select').addEventListener('change', onMedicineChange);
document.querySelector('#pos-add-btn').addEventListener('click', addCartItem);
document.querySelector('#pos-items-table').addEventListener('click', event => {
  const removeIndex = event.target.dataset.removeCart;
  if (removeIndex !== undefined) removeCartItem(Number(removeIndex));
});
document.querySelector('#pos-checkout-form').addEventListener('submit', handleCheckout);
document.querySelector('#refresh-sales').addEventListener('click', loadSalesHistory);
document.querySelector('#sales-history-table').addEventListener('click', event => {
  const saleId = event.target.dataset.viewReceipt;
  if (saleId) viewReceipt(Number(saleId));
});
document.querySelector('#receipt-print-btn').addEventListener('click', () => window.print());

// Analytics & Forecast Listeners
document.querySelector('#refresh-analytics').addEventListener('click', loadAnalyticsView);
document.querySelector('#forecast-status-filter').addEventListener('change', renderForecasts);
document.querySelector('#forecast-search').addEventListener('input', () => {
  clearTimeout(window.forecastSearchTimer);
  window.forecastSearchTimer = setTimeout(renderForecasts, 150);
});
document.querySelector('#forecast-table').addEventListener('click', event => {
  const medicineId = Number(event.target.dataset.viewForecast);
  if (medicineId) openForecastDetails(medicineId);
});

// Store Layout (2D) Listeners
document.querySelector('#refresh-store-map').addEventListener('click', async () => {
  await loadStoreMapView();
});

document.querySelector('#map-medicine-search').addEventListener('input', () => {
  clearTimeout(window.mapSearchTimer);
  window.mapSearchTimer = setTimeout(() => {
    highlightMedicineOnMap(document.querySelector('#map-medicine-search').value);
  }, 180);
});

document.querySelector('#map-clear-search-btn').addEventListener('click', () => {
  document.querySelector('#map-medicine-search').value = '';
  highlightMedicineOnMap('');
});

// Shelf node click — select shelf and update inspector
document.querySelector('.floor-plan-panel').addEventListener('click', event => {
  const node = event.target.closest('.shelf-node');
  if (!node) return;
  const shelfId = node.dataset.shelfId;
  if (shelfId) selectShelf(shelfId);
});

// Bill button inside inspector — navigate to POS and pre-fill
document.querySelector('#inspector-body').addEventListener('click', async event => {
  const batchId = event.target.dataset.billBatch;
  const medId = event.target.dataset.medId;
  if (!batchId || !medId) return;
  switchView('billing');
  await loadBillingView();
  const medSelect = document.querySelector('#pos-medicine-select');
  medSelect.value = medId;
  await onMedicineChange();
  document.querySelector('#pos-batch-select').value = batchId;
  document.querySelector('#pos-quantity').value = 1;
  addCartItem();
});

// QR Specific Listeners
document.querySelector('#inventory-scan-qr-btn').addEventListener('click', () => openQrScanner('INVENTORY'));
document.querySelector('#pos-scan-qr-btn').addEventListener('click', () => openQrScanner('POS'));
document.querySelector('#qr-verify-btn').addEventListener('click', () => {
  verifyQrPayload(document.querySelector('#qr-scan-input').value);
});
document.querySelector('#qr-scan-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    verifyQrPayload(event.target.value);
  }
});
document.querySelector('#qr-apply-action-btn').addEventListener('click', applyQrResult);
document.querySelector('#qr-toggle-camera-btn').addEventListener('click', toggleCamera);
document.querySelector('#qr-copy-payload-btn').addEventListener('click', () => {
  if (currentQrData && currentQrData.payloadString) {
    navigator.clipboard.writeText(currentQrData.payloadString);
    alert('QR payload copied to clipboard!');
  }
});
document.querySelector('#qr-print-sticker-btn').addEventListener('click', () => window.print());

// Expiry Specific Listeners
document.querySelector('#refresh-alerts').addEventListener('click', async () => {
  await loadAlerts();
  await refreshDashboard();
});
document.querySelector('#alert-status').addEventListener('change', loadAlerts);
document.querySelector('#alert-ack').addEventListener('change', loadAlerts);
document.querySelector('#alert-list').addEventListener('click', async event => {
  const id = event.target.dataset.ackAlert;
  if (!id) return;
  try {
    await api(`/api/expiry-alerts/${id}/acknowledge`, { method: 'POST' });
    await loadAlerts();
  } catch (error) {
    document.querySelector('#alert-error').textContent = error.message;
  }
});

document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener('click', () => closeDialog(button.dataset.close));
});

// ----------------------------------------------------
// NEAR-EXPIRY REDISTRIBUTION
// ----------------------------------------------------

async function loadRedistributionRequests() {
  const role   = document.querySelector('#redistrib-role-filter').value;
  const status = document.querySelector('#redistrib-status-filter').value;
  const errorEl = document.querySelector('#redistribution-error');
  errorEl.textContent = '';
  try {
    const res = await api(`/api/inter-pharmacy/requests?role=${role}&status=${status}`);
    const tbody = document.querySelector('#redistribution-body');
    if (!res.requests || res.requests.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" class="muted text-center">No redistribution requests found.</td></tr>';
      return;
    }
    tbody.innerHTML = res.requests.map(r => {
      const autoBadge = r.automatic_request
        ? '<span class="badge badge-auto">AUTO</span>'
        : '<span class="badge">MANUAL</span>';
      const statusClass = `badge-${(r.status || '').toLowerCase()}`;
      const dist = r.distance_km != null ? `${r.distance_km} km` : '—';
      return `
        <tr>
          <td><code>#${r.id}</code></td>
          <td><strong>${escapeHtml(r.medicine_name)}</strong><div class="muted font-xs">${escapeHtml(r.generic_name || '')}</div></td>
          <td><code>${escapeHtml(r.batch_number)}</code></td>
          <td>${escapeHtml(r.sender_name)}</td>
          <td>${escapeHtml(r.recipient_name)}</td>
          <td><strong>${r.requested_quantity}u</strong></td>
          <td><span class="${r.days_until_expiry <= 7 ? 'text-danger' : ''}">${r.days_until_expiry ?? '—'}</span></td>
          <td>${dist}</td>
          <td><span class="badge ${statusClass}">${r.status}</span></td>
          <td>${autoBadge}</td>
          <td>${escapeHtml(r.created_at ? r.created_at.slice(0,10) : '')}</td>
          <td>
            ${r.status === 'ACCEPTED' ? `<button class="secondary small-btn" data-redistrib-complete="${r.id}">Complete</button>` : ''}
            ${['PENDING','ACCEPTED'].includes(r.status) ? `<button class="danger small-btn" data-redistrib-cancel="${r.id}">Cancel</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// Redistribution event listeners
document.querySelector('#run-redistribution-btn').addEventListener('click', async () => {
  const btn = document.querySelector('#run-redistribution-btn');
  const resultEl = document.querySelector('#redistribution-scan-result');
  const errorEl  = document.querySelector('#redistribution-error');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  try {
    const res = await api('/api/inter-pharmacy/near-expiry/process', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    resultEl.className = `redistrib-scan-result${res.created === 0 ? ' no-action' : ''}`;
    resultEl.innerHTML = res.created > 0
      ? `<strong>✓ ${res.created} redistribution request${res.created === 1 ? '' : 's'} created and auto-accepted.</strong> ` +
        `Skipped: ${res.skippedDuplicate} duplicates, ${res.skippedNoCoordinates} without coordinates, ${res.skippedSufficientStock} with sufficient stock. ` +
        `Threshold: ${res.nearExpiryDays} days · Radius: ${res.nearbyRadiusKm} km.`
      : `No new requests created. Skipped: ${res.skippedDuplicate} duplicates, ${res.skippedNoCoordinates} without coordinates, ${res.skippedSufficientStock} with sufficient stock. ` +
        `(Threshold: ${res.nearExpiryDays} days · Radius: ${res.nearbyRadiusKm} km)`;
    resultEl.hidden = false;
    await loadRedistributionRequests();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Near-Expiry Scan';
  }
});

document.querySelector('#refresh-redistribution-btn').addEventListener('click', loadRedistributionRequests);
document.querySelector('#redistrib-role-filter').addEventListener('change', loadRedistributionRequests);
document.querySelector('#redistrib-status-filter').addEventListener('change', loadRedistributionRequests);

document.querySelector('#redistribution-body').addEventListener('click', async event => {
  const completeId = event.target.dataset.redistribComplete;
  const cancelId   = event.target.dataset.redistribCancel;
  const id = completeId || cancelId;
  if (!id) return;
  const newStatus = completeId ? 'COMPLETED' : 'CANCELLED';
  try {
    await api(`/api/inter-pharmacy/requests/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    await loadRedistributionRequests();
  } catch (err) {
    document.querySelector('#redistribution-error').textContent = err.message;
  }
});

// Initial session check
api('/api/auth/me').then(({ user }) => showApp(user)).catch(() => {});

// ====================================================
// MANUAL MEDICINE REQUESTS (progressive geographic search)
//
// A separate workflow from the automatic Near-Expiry Redistribution view.
// All rules — eligibility, proximity, usable/offerable stock, coverage,
// zone expansion — are decided by the server. This module renders what the API
// returns and never recomputes availability locally.
//
// Offering or accepting records a COMMITMENT. No inventory is moved here.
// ====================================================

const MREQ_API = '/api/inter-pharmacy/medicine-requests';
let mreqActiveTab = 'mine';
let mreqDetailId = null;
let mreqCreateKey = null;      // reused across retries so a retry stays idempotent
let mreqBusy = false;          // guards against duplicate submissions

const MREQ_STATUS_LABELS = {
  OPEN: 'OPEN',
  PARTIALLY_COVERED: 'PARTIALLY COVERED',
  FULLY_COVERED: 'FULLY COVERED',
  NO_COVERAGE: 'NO COVERAGE',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED'
};
const MREQ_OFFER_LABELS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
  SUPERSEDED: 'SUPERSEDED',
  EXPIRED: 'EXPIRED'
};

/**
 * Whether the requester may cancel a request from the UI.
 *
 * Only the requesting pharmacy, and only while the request is still an active,
 * open search — OPEN or PARTIALLY_COVERED. Per the approved UI rules the action
 * is deliberately NOT offered for CANCELLED, EXPIRED, NO_COVERAGE or
 * FULLY_COVERED. The backend remains authoritative and re-checks on every call;
 * this is a display gate only, kept intentionally no broader than the server.
 */
function mreqCanCancel(status, isRequester) {
  return isRequester === true && ['OPEN', 'PARTIALLY_COVERED'].includes(status);
}

function mreqStatusBadge(status) {
  const key = String(status || '').toLowerCase();
  const label = MREQ_STATUS_LABELS[status] || MREQ_OFFER_LABELS[status] || status || '—';
  return `<span class="badge mreq-badge-${key}">${escapeHtml(label)}</span>`;
}

function mreqSetError(message) {
  document.querySelector('#mreq-error').textContent = message || '';
}

/** Requirement: medicine requests are not offline-capable and are never queued. */
function mreqOffline() {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const note = document.querySelector('#mreq-offline-note');
  if (note) note.hidden = !offline;
  return offline;
}

function mreqNewIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `mreq-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Progressive-search summary built strictly from server-confirmed data:
 * currentZoneIndex / currentRadiusKm / zoneCount / maxRadiusKm, plus the zones
 * that actually produced contacts. No zone is claimed as searched unless the
 * server says so, and a covered request never implies an ongoing search.
 */
function mreqSearchProgress(request, offers = []) {
  const zoneCount = Number(request.zoneCount) || 0;
  const current = Number(request.currentZoneIndex) || 0;
  const radius = request.currentRadiusKm;
  const terminal = ['FULLY_COVERED', 'NO_COVERAGE', 'CANCELLED', 'EXPIRED'].includes(request.status);

  const contactsByZone = new Map();
  for (const o of offers) {
    const z = Number(o.zoneIndex);
    contactsByZone.set(z, (contactsByZone.get(z) || 0) + 1);
  }

  let headline;
  if (request.status === 'FULLY_COVERED') headline = 'Fully covered — the search has stopped.';
  else if (request.status === 'NO_COVERAGE') headline = `No coverage found within the maximum ${escapeHtml(String(request.maxRadiusKm))} km radius.`;
  else if (request.status === 'CANCELLED') headline = 'Request cancelled — the search has stopped.';
  else if (request.status === 'EXPIRED') headline = 'Request expired — the search has stopped.';
  else if (zoneCount && current >= zoneCount - 1) headline = `Maximum search radius reached (${escapeHtml(String(radius))} km).`;
  else if (current === 0) headline = `Searching within ${escapeHtml(String(radius))} km.`;
  else headline = `Expanded search to ${escapeHtml(String(radius))} km.`;

  const rows = [];
  for (let i = 0; i < zoneCount; i++) {
    const contacts = contactsByZone.get(i) || 0;
    const reached = i < current || (i === current && (contacts > 0 || !terminal));
    let state;
    if (i === current && !terminal) state = `current${radius != null ? ` · ${escapeHtml(String(radius))} km` : ''}`;
    else if (reached) state = 'reached';
    else state = 'not reached';
    const detail = contacts > 0 ? ` · ${contacts} contacted` : '';
    rows.push(`
      <li class="mreq-zone ${reached ? 'reached' : ''}">
        <span class="mreq-zone-dot" aria-hidden="true">${reached ? '●' : '○'}</span>
        <span>Zone ${i + 1} of ${zoneCount} — ${state}${detail}</span>
      </li>`);
  }

  return `
    <div class="mreq-search">
      <p class="mreq-search-headline">${headline}</p>
      <ul class="mreq-zone-list">${rows.join('')}</ul>
    </div>`;
}

function mreqCoverageBar(request) {
  const requested = Number(request.requestedQuantity) || 0;
  const covered = Number(request.coveredQuantity) || 0;
  const pct = requested > 0 ? Math.min(100, Math.round((covered / requested) * 100)) : 0;
  return `
    <div class="mreq-coverage">
      <div class="mreq-coverage-figures">
        <span>Requested <strong>${requested}</strong></span>
        <span>Covered <strong>${covered}</strong></span>
        <span>Remaining <strong>${Number(request.remainingQuantity) || 0}</strong></span>
      </div>
      <div class="mreq-coverage-track" role="img" aria-label="${covered} of ${requested} units committed">
        <div class="mreq-coverage-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
}

// ── My Requests ─────────────────────────────────────────────────────────────

function mreqMyCard(request) {
  const expiresIn = formatRemaining(request.expiresAt);
  const summary = request.offerSummary || {};
  const offerCount = Number(summary.contacted) || 0;
  const accepted = Number((summary.byStatus || {}).ACCEPTED) || 0;
  const priority = request.priority === 'URGENT' ? '<span class="badge mreq-badge-urgent">URGENT</span>' : '';
  return `
    <article class="mreq-card" data-mreq-card="${request.id}">
      <div class="mreq-card-head">
        <div>
          <h3>${escapeHtml(request.medicineName)} ${priority}</h3>
          <p class="muted font-xs">Request #${request.id} · created ${escapeHtml(formatServerTime(request.createdAt))}</p>
        </div>
        ${mreqStatusBadge(request.status)}
      </div>
      ${mreqCoverageBar(request)}
      <div class="mreq-meta">
        <span>Search radius: <strong>${escapeHtml(String(request.currentRadiusKm))} km</strong></span>
        <span>Zone <strong>${Number(request.currentZoneIndex) + 1} of ${request.zoneCount}</strong></span>
        <span>Responses: <strong>${offerCount}</strong>${accepted ? ` (${accepted} accepted)` : ''}</span>
        <span>${expiresIn ? `Expires in <strong>${expiresIn}</strong>` : 'Expired or closed'}</span>
      </div>
      ${request.reason ? `<p class="muted font-xs">Reason: ${escapeHtml(request.reason)}</p>` : ''}
      <div class="mreq-card-actions">
        <button type="button" class="secondary small-btn" data-mreq-detail="${request.id}">View offers</button>
        ${['OPEN', 'PARTIALLY_COVERED'].includes(request.status)
          ? `<button type="button" class="secondary small-btn" data-mreq-advance="${request.id}">Continue search</button>
             <button type="button" class="danger small-btn" data-mreq-cancel="${request.id}">Cancel Request</button>`
          : ''}
      </div>
    </article>`;
}

async function loadMyMedicineRequests() {
  const listEl = document.querySelector('#mreq-mine-list');
  const status = document.querySelector('#mreq-status-filter').value;
  const medicine = document.querySelector('#mreq-medicine-filter').value.trim();
  const params = new URLSearchParams();
  if (status && status !== 'ALL') params.set('status', status);
  if (medicine) params.set('medicine', medicine);
  const qs = params.toString();
  try {
    const res = await api(`${MREQ_API}${qs ? `?${qs}` : ''}`);
    if (!res.requests || res.requests.length === 0) {
      listEl.innerHTML = '<p class="empty">No medicine requests yet. Use “New Request” to ask nearby pharmacies for stock.</p>';
      return;
    }
    listEl.innerHTML = res.requests.map(mreqMyCard).join('');
  } catch (err) {
    listEl.innerHTML = '<p class="empty">Could not load your medicine requests.</p>';
    mreqSetError(err.message);
  }
}

// ── Incoming Requests ───────────────────────────────────────────────────────

function mreqIncomingCard(item) {
  const respondIn = formatRemaining(item.respondBy);
  // The server is authoritative about whether an offer is possible.
  const canOffer = item.canOffer === true && Number(item.maxOfferableQuantity) > 0;
  const max = Number(item.maxOfferableQuantity) || 0;
  const priority = item.priority === 'URGENT' ? '<span class="badge mreq-badge-urgent">URGENT</span>' : '';

  const offerControls = canOffer
    ? `<div class="mreq-offer-row">
         <label class="mreq-offer-label">Offer quantity
           <input type="number" class="mreq-offer-input" data-mreq-offer-input="${item.requestId}"
                  min="1" step="1" max="${max}" value="${Math.min(max, Number(item.outstandingQuantity) || max)}"
                  aria-label="Quantity to offer, maximum ${max}">
         </label>
         <span class="muted font-xs">Max ${max}</span>
         <button type="button" class="small-btn" data-mreq-offer="${item.requestId}">Offer Quantity</button>
         <button type="button" class="secondary small-btn" data-mreq-decline="${item.requestId}">Decline</button>
       </div>`
    : `<div class="mreq-offer-row">
         <p class="mreq-nostock">You don't have usable stock for this medicine.</p>
         <button type="button" class="secondary small-btn" data-mreq-decline="${item.requestId}">Decline</button>
       </div>`;

  return `
    <article class="mreq-card mreq-incoming" data-mreq-incoming="${item.requestId}">
      <div class="mreq-card-head">
        <div>
          <h3>${escapeHtml(item.medicineName)} ${priority}</h3>
          <p class="muted font-xs">
            From ${escapeHtml(item.requesterName)} · ${escapeHtml(String(item.distanceKm))} km away ·
            requested ${escapeHtml(formatServerTime(item.requestedAt))}
          </p>
        </div>
        ${mreqStatusBadge(item.requestStatus)}
      </div>
      <div class="mreq-meta">
        <span>Requested: <strong>${item.requestedQuantity}</strong></span>
        <span>Still needed: <strong>${item.outstandingQuantity}</strong></span>
        <span>Your usable stock: <strong>${item.usableStock}</strong></span>
        <span>Reserved: <strong>${item.reservedStock}</strong></span>
        <span>Offerable: <strong>${item.offerableStock}</strong></span>
        <span>${respondIn ? `Respond within <strong>${respondIn}</strong>` : 'Response window closed'}</span>
      </div>
      ${item.reason ? `<p class="muted font-xs">Reason: ${escapeHtml(item.reason)}</p>` : ''}
      <p class="muted font-xs mreq-commit-note">Offering commits stock for later fulfilment. It does not transfer inventory.</p>
      <p class="error" data-mreq-row-error="${item.requestId}" role="alert"></p>
      ${offerControls}
    </article>`;
}

async function loadIncomingMedicineRequests() {
  const listEl = document.querySelector('#mreq-incoming-list');
  try {
    const res = await api(`${MREQ_API}/incoming`);
    mreqUpdateBadge(res.count || 0);
    if (!res.incoming || res.incoming.length === 0) {
      listEl.innerHTML = '<p class="empty">No incoming medicine requests.</p>';
      return;
    }
    listEl.innerHTML = res.incoming.map(mreqIncomingCard).join('');
  } catch (err) {
    listEl.innerHTML = '<p class="empty">Could not load incoming medicine requests.</p>';
    mreqSetError(err.message);
  }
}

/** In-app indicator only — no push, email, websockets or background workers. */
function mreqUpdateBadge(count) {
  for (const id of ['#medicine-requests-badge', '#mreq-incoming-count']) {
    const el = document.querySelector(id);
    if (!el) continue;
    if (count > 0) { el.textContent = String(count); el.hidden = false; }
    else el.hidden = true;
  }
}

/** Refreshes only the badge, using the existing request/refresh pattern. */
async function refreshMedicineRequestBadge() {
  if (!currentUser) return;
  try {
    const res = await api(`${MREQ_API}/incoming`);
    mreqUpdateBadge(res.count || 0);
  } catch { /* badge is advisory only */ }
}

async function loadMedicineRequestsView() {
  mreqSetError('');
  mreqOffline();
  await Promise.all([
    mreqActiveTab === 'mine' ? loadMyMedicineRequests() : Promise.resolve(),
    loadIncomingMedicineRequests()
  ]);
  if (mreqActiveTab === 'incoming') await loadMyMedicineRequests();
  mreqPopulateMedicineOptions();
}

/** Fills the create-form datalist from the pharmacy's own catalogue. */
async function mreqPopulateMedicineOptions() {
  const list = document.querySelector('#mreq-medicine-options');
  if (!list) return;
  try {
    const source = Array.isArray(medicines) && medicines.length ? medicines : (await api('/api/medicines')).medicines || [];
    list.innerHTML = source.map(m => `<option value="${escapeHtml(m.name)}"></option>`).join('');
  } catch { /* the field remains free text */ }
}

// ── Request detail ──────────────────────────────────────────────────────────

function mreqOfferRow(offer) {
  const qty = offer.offeredQuantity === null || offer.offeredQuantity === undefined ? '—' : offer.offeredQuantity;
  const respondIn = formatRemaining(offer.respondBy);
  return `
    <li class="mreq-offer-item">
      <div class="mreq-offer-main">
        <strong>${escapeHtml(offer.pharmacyName || `Pharmacy #${offer.pharmacyId}`)}</strong>
        <span class="muted font-xs">${escapeHtml(String(offer.distanceKm))} km · zone ${Number(offer.zoneIndex) + 1}</span>
      </div>
      <div class="mreq-offer-figures">
        <span>Offered: <strong>${qty}</strong></span>
        ${mreqStatusBadge(offer.status)}
      </div>
      ${offer.declineReason ? `<p class="muted font-xs">Reason: ${escapeHtml(offer.declineReason)}</p>` : ''}
      ${offer.status === 'PENDING' && respondIn ? `<p class="muted font-xs">Awaiting response · ${respondIn} left</p>` : ''}
    </li>`;
}

async function openMedicineRequestDetail(id) {
  mreqDetailId = Number(id);
  const bodyEl = document.querySelector('#mreq-detail-body');
  const actionsEl = document.querySelector('#mreq-detail-actions');
  document.querySelector('#mreq-detail-error').textContent = '';
  bodyEl.innerHTML = '<p class="empty">Loading request…</p>';
  actionsEl.innerHTML = '<button class="secondary" type="button" data-close="mreq-detail-dialog">Close</button>';
  openDialog('mreq-detail-dialog');

  try {
    const res = await api(`${MREQ_API}/${mreqDetailId}`);
    const r = res.request;
    const offers = res.offers || [];
    document.querySelector('#mreq-detail-title').textContent = `${r.medicineName} — request #${r.id}`;

    const accepted = offers.filter(o => o.status === 'ACCEPTED');
    let emptyNote = '';
    if (offers.length === 0) emptyNote = '<p class="empty">No offers yet.</p>';

    bodyEl.innerHTML = `
      <div class="mreq-detail-status">
        ${mreqStatusBadge(r.status)}
        ${r.priority === 'URGENT' ? '<span class="badge mreq-badge-urgent">URGENT</span>' : ''}
        <span class="muted font-xs">${res.viewerRole === 'REQUESTER' ? 'You raised this request' : 'You were asked to help'}</span>
      </div>
      ${mreqCoverageBar(r)}
      ${mreqSearchProgress(r, offers)}
      <div class="mreq-meta">
        <span>Created: <strong>${escapeHtml(formatServerTime(r.createdAt))}</strong></span>
        <span>${formatRemaining(r.expiresAt) ? `Expires in <strong>${formatRemaining(r.expiresAt)}</strong>` : 'Lifetime elapsed'}</span>
      </div>
      ${r.reason ? `<p class="muted font-xs">Reason: ${escapeHtml(r.reason)}</p>` : ''}
      ${r.status === 'FULLY_COVERED'
        ? '<p class="mreq-notice">This request is fully covered. The committed quantities are awaiting fulfilment — no inventory has moved.</p>'
        : ''}
      ${r.status === 'EXPIRED' ? '<p class="mreq-notice">This request has expired and accepts no further offers.</p>' : ''}
      ${r.status === 'NO_COVERAGE' ? '<p class="mreq-notice">No pharmacy within the maximum radius could supply this medicine.</p>' : ''}
      ${r.status === 'CANCELLED' ? '<p class="mreq-notice">This request was cancelled.</p>' : ''}
      <h3 class="mreq-offers-heading">Offers${accepted.length ? ` · ${accepted.length} accepted` : ''}</h3>
      ${emptyNote || `<ul class="mreq-offer-list">${offers.map(mreqOfferRow).join('')}</ul>`}
      <p class="muted font-xs">An accepted offer is a commitment to supply. Physical transfer is a separate, future workflow.</p>
    `;

    const isRequester = res.viewerRole === 'REQUESTER';
    const canCancel = mreqCanCancel(r.status, isRequester);
    const canAdvance = isRequester && ['OPEN', 'PARTIALLY_COVERED'].includes(r.status);
    // Requester actions sit on the left; Close stays on the right. The
    // "Cancel Request" action is always present in the detail modal for a
    // cancellable own request — this is the action the manual review found missing.
    actionsEl.innerHTML = `
      ${canAdvance ? `<button type="button" class="secondary" data-mreq-advance="${r.id}">Continue search</button>` : ''}
      ${canCancel ? `<button type="button" class="danger" data-mreq-cancel="${r.id}">Cancel Request</button>` : ''}
      <button class="secondary" type="button" data-close="mreq-detail-dialog">Close</button>`;
  } catch (err) {
    bodyEl.innerHTML = '<p class="empty">This request could not be loaded.</p>';
    document.querySelector('#mreq-detail-error').textContent = err.message;
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** Serializes mutating actions and keeps buttons disabled while in flight. */
async function mreqRunAction(button, work) {
  if (mreqBusy) return;
  if (mreqOffline()) { mreqSetError('This action needs an internet connection.'); return; }
  mreqBusy = true;
  const label = button ? button.textContent : null;
  if (button) { button.disabled = true; button.textContent = 'Working…'; }
  try {
    await work();
  } finally {
    mreqBusy = false;
    if (button) { button.disabled = false; if (label !== null) button.textContent = label; }
  }
}

async function mreqSubmitOffer(requestId, button) {
  const input = document.querySelector(`[data-mreq-offer-input="${requestId}"]`);
  const rowError = document.querySelector(`[data-mreq-row-error="${requestId}"]`);
  if (rowError) rowError.textContent = '';
  const max = Number(input && input.max) || 0;
  const qty = Number(input && input.value);

  // Client-side validation mirrors the server's rules; the server remains authoritative.
  if (!Number.isInteger(qty) || qty <= 0) {
    if (rowError) rowError.textContent = 'Enter a whole quantity greater than zero.';
    return;
  }
  if (max > 0 && qty > max) {
    if (rowError) rowError.textContent = `You can offer at most ${max} units for this request.`;
    return;
  }

  await mreqRunAction(button, async () => {
    try {
      const res = await api(`${MREQ_API}/${requestId}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offeredQuantity: qty })
      });
      mreqSetError('');
      const covered = res.coveredQuantity;
      const remaining = res.remainingQuantity;
      mreqSetError('');
      const note = res.idempotentReplay
        ? 'This offer was already recorded.'
        : `Offer of ${qty} recorded as a commitment. Covered ${covered}, remaining ${remaining}. No inventory moved.`;
      if (rowError) { rowError.classList.add('mreq-success-text'); rowError.textContent = note; }
      await loadMedicineRequestsView();
    } catch (err) {
      if (rowError) { rowError.classList.remove('mreq-success-text'); rowError.textContent = err.message; }
      else mreqSetError(err.message);
      // A 409 usually means stock or remaining quantity changed — resync.
      await loadIncomingMedicineRequests();
    }
  });
}

async function mreqSubmitDecline(requestId, button) {
  const rowError = document.querySelector(`[data-mreq-row-error="${requestId}"]`);
  if (rowError) rowError.textContent = '';
  const reason = window.prompt('Optional reason for declining (leave blank to skip):', '');
  if (reason === null) return;   // user dismissed

  await mreqRunAction(button, async () => {
    try {
      await api(`${MREQ_API}/${requestId}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {})
      });
      mreqSetError('');
      await loadMedicineRequestsView();
    } catch (err) {
      if (rowError) rowError.textContent = err.message; else mreqSetError(err.message);
      await loadIncomingMedicineRequests();
    }
  });
}

async function mreqAdvance(requestId, button) {
  await mreqRunAction(button, async () => {
    try {
      await api(`${MREQ_API}/${requestId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      mreqSetError('');
      if (mreqDetailId === Number(requestId) && document.querySelector('#mreq-detail-dialog').open) {
        await openMedicineRequestDetail(requestId);
      }
      await loadMedicineRequestsView();
    } catch (err) { mreqSetError(err.message); }
  });
}

async function mreqCancel(requestId, button) {
  // Confirmation is mandatory — a click must never cancel outright.
  if (!window.confirm('Cancel this medicine request?\n\nAny active search or offer workflow for this request will be cancelled.')) return;
  await mreqRunAction(button, async () => {
    try {
      // The requester pharmacy is derived from the session server-side; no
      // client pharmacy identity is sent. mreqRunAction blocks duplicate submits.
      await api(`${MREQ_API}/${requestId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      mreqSetError('');
      // Close the detail modal (matches the existing convention), then refresh
      // My Requests, Incoming and the incoming badge via loadMedicineRequestsView().
      const dialog = document.querySelector('#mreq-detail-dialog');
      if (dialog && dialog.open) closeDialog('mreq-detail-dialog');
      await loadMedicineRequestsView();
    } catch (err) {
      // Never claim success on failure. Show the server's safe message (incl. 409)
      // and keep the request — and its still-valid Cancel action — visible.
      mreqSetError(err.message);
      const detailError = document.querySelector('#mreq-detail-error');
      if (detailError) detailError.textContent = err.message;
    }
  });
}

// ── Event wiring ────────────────────────────────────────────────────────────

document.querySelectorAll('[data-mreq-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    mreqActiveTab = tab.dataset.mreqTab;
    document.querySelectorAll('[data-mreq-tab]').forEach(t => {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelector('#mreq-mine-panel').hidden = mreqActiveTab !== 'mine';
    document.querySelector('#mreq-incoming-panel').hidden = mreqActiveTab !== 'incoming';
  });
});

document.querySelector('#mreq-refresh-btn').addEventListener('click', loadMedicineRequestsView);
document.querySelector('#mreq-status-filter').addEventListener('change', loadMyMedicineRequests);
document.querySelector('#mreq-medicine-filter').addEventListener('change', loadMyMedicineRequests);

document.querySelector('#mreq-new-btn').addEventListener('click', () => {
  document.querySelector('#mreq-create-error').textContent = '';
  document.querySelector('#mreq-create-form').reset();
  document.querySelector('#mreq-create-priority').value = 'NORMAL';
  mreqCreateKey = mreqNewIdempotencyKey();   // one key per dialog session
  mreqPopulateMedicineOptions();
  if (mreqOffline()) {
    document.querySelector('#mreq-create-error').textContent = 'You are offline. Creating a medicine request needs a connection.';
  }
  openDialog('mreq-create-dialog');
});

document.querySelector('#mreq-create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.querySelector('#mreq-create-error');
  const submitBtn = document.querySelector('#mreq-create-submit');
  errorEl.textContent = '';

  const medicineName = document.querySelector('#mreq-create-medicine').value.trim();
  const quantity = Number(document.querySelector('#mreq-create-quantity').value);
  const priority = document.querySelector('#mreq-create-priority').value;
  const reason = document.querySelector('#mreq-create-reason').value.trim();

  if (!medicineName) { errorEl.textContent = 'Enter the medicine name.'; return; }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    errorEl.textContent = 'Quantity must be a whole number greater than zero.';
    return;
  }
  if (mreqOffline()) { errorEl.textContent = 'You are offline. Creating a medicine request needs a connection.'; return; }
  if (!mreqCreateKey) mreqCreateKey = mreqNewIdempotencyKey();

  if (mreqBusy) return;
  mreqBusy = true;
  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = 'Creating…';
  try {
    const res = await api(MREQ_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        medicineName,
        requestedQuantity: quantity,
        priority,
        ...(reason ? { reason } : {}),
        idempotencyKey: mreqCreateKey
      })
    });
    closeDialog('mreq-create-dialog');
    mreqCreateKey = null;
    mreqSetError('');
    mreqActiveTab = 'mine';
    document.querySelector('[data-mreq-tab="mine"]').click();
    await loadMedicineRequestsView();
    // Show the freshly created request with its coverage, zone and status.
    if (res.request && res.request.id) await openMedicineRequestDetail(res.request.id);
  } catch (err) {
    // The key is intentionally retained so a retry is treated as the same request.
    errorEl.textContent = err.message;
  } finally {
    mreqBusy = false;
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});

// Delegated actions across both panels and the detail dialog.
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const detailId  = target.dataset.mreqDetail;
  const offerId   = target.dataset.mreqOffer;
  const declineId = target.dataset.mreqDecline;
  const advanceId = target.dataset.mreqAdvance;
  const cancelId  = target.dataset.mreqCancel;
  if (detailId)  { openMedicineRequestDetail(detailId); return; }
  if (offerId)   { mreqSubmitOffer(offerId, target); return; }
  if (declineId) { mreqSubmitDecline(declineId, target); return; }
  if (advanceId) { mreqAdvance(advanceId, target); return; }
  if (cancelId)  { mreqCancel(cancelId, target); return; }
});

window.addEventListener('online',  () => mreqOffline());
window.addEventListener('offline', () => mreqOffline());
