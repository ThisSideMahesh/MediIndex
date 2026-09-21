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
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function openDialog(id) {
  document.querySelector(`#${id}`).showModal();
}

function closeDialog(id) {
  document.querySelector(`#${id}`).close();
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

  if (view === 'inventory') loadMedicines();
  if (view === 'billing') loadBillingView();
  if (view === 'analytics') loadAnalyticsView();
  if (view === 'store-map') loadStoreMapView();
  if (view === 'expiry') loadAlerts();
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

// Initial session check
api('/api/auth/me').then(({ user }) => showApp(user)).catch(() => {});
