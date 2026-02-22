const MATERIAL_DENSITY = { PLA: 1.24, PETG: 1.27, ABS: 1.04, TPU: 1.21, ASA: 1.07, Other: 1.2 };
const ADD_LOCATION_VALUE = '__add_new_location__';

let spools = [];
let locations = [];
let currentEditId = null;

const els = {
  statsGrid: document.getElementById('statsGrid'),
  spoolList: document.getElementById('spoolList'),
  emptyState: document.getElementById('emptyState'),
  searchInput: document.getElementById('searchInput'),
  materialFilter: document.getElementById('materialFilter'),
  brandFilter: document.getElementById('brandFilter'),
  spoolModal: document.getElementById('spoolModal'),
  spoolForm: document.getElementById('spoolForm'),
  modalTitle: document.getElementById('modalTitle'),
  printerModal: document.getElementById('printerModal'),
  locationSelect: document.getElementById('locationSelect'),
};

init();

async function init() {
  bindEvents();
  await refreshAll();
}

function bindEvents() {
  document.getElementById('addSpoolBtn').onclick = () => openSpoolModal();
  document.getElementById('closeModalBtn').onclick = () => els.spoolModal.close();
  document.getElementById('configurePrinterBtn').onclick = () => openPrinterModal();
  document.getElementById('closePrinterModalBtn').onclick = () => els.printerModal.close();
  document.getElementById('exportBtn').onclick = exportJson;
  document.getElementById('importInput').onchange = importJson;

  els.searchInput.oninput = render;
  els.materialFilter.onchange = render;
  els.brandFilter.onchange = render;
  els.locationSelect.onchange = onLocationSelect;

  els.spoolForm.onsubmit = onSubmitSpool;
  document.getElementById('printerForm').onsubmit = onSavePrinter;
}

async function refreshAll() {
  await Promise.all([loadSpools(), loadLocations(), loadPrinterConfig()]);
  populateFilters();
  refreshLocationSelect();
  render();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }

  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : null;
}

async function loadSpools() {
  spools = await api('/api/spools');
}

async function loadLocations() {
  locations = await api('/api/locations');
}

function refreshLocationSelect(selected = '') {
  const options = ['<option value="">No location</option>'];
  for (const loc of locations) {
    options.push(`<option value="${escapeHtml(loc.name)}">${escapeHtml(loc.name)}</option>`);
  }
  options.push(`<option value="${ADD_LOCATION_VALUE}">➕ Add new location...</option>`);
  els.locationSelect.innerHTML = options.join('');
  els.locationSelect.value = selected || '';
}

async function onLocationSelect() {
  if (els.locationSelect.value !== ADD_LOCATION_VALUE) return;

  const name = prompt('New storage location name:');
  if (!name || !name.trim()) {
    els.locationSelect.value = '';
    return;
  }

  try {
    await api('/api/locations', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    await loadLocations();
    refreshLocationSelect(name.trim());
  } catch (err) {
    alert(err.message || 'Could not create location.');
    els.locationSelect.value = '';
  }
}

function openSpoolModal(spool = null) {
  currentEditId = spool?.id || null;
  els.modalTitle.textContent = spool ? 'Edit Spool' : 'Add Spool';
  const set = (id, val = '') => (document.getElementById(id).value = val);

  set('spoolId', spool?.id || '');
  set('brand', spool?.brand || '');
  set('colorName', spool?.colorName || '');
  set('colorHex', spool?.colorHex || '#ffffff');
  set('material', spool?.material || 'PLA');
  set('diameter', spool?.diameter || 1.75);
  set('totalWeight', spool?.totalWeight || '');
  set('remainingWeight', spool?.remainingWeight || '');
  set('purchaseDate', spool?.purchaseDate || '');
  set('cost', spool?.cost || '');
  set('notes', spool?.notes || '');
  refreshLocationSelect(spool?.location || '');
  els.spoolModal.showModal();
}

async function onSubmitSpool(e) {
  e.preventDefault();
  const data = {
    id: currentEditId || crypto.randomUUID(),
    brand: v('brand'),
    colorName: v('colorName'),
    colorHex: v('colorHex'),
    material: v('material'),
    diameter: Number(v('diameter')) || 1.75,
    totalWeight: Number(v('totalWeight')),
    remainingWeight: Number(v('remainingWeight')),
    location: els.locationSelect.value === ADD_LOCATION_VALUE ? '' : els.locationSelect.value,
    purchaseDate: v('purchaseDate'),
    cost: Number(v('cost')) || 0,
    notes: v('notes'),
  };

  if (data.remainingWeight > data.totalWeight) {
    alert('Remaining weight cannot be greater than total weight.');
    return;
  }

  try {
    if (currentEditId) {
      await api(`/api/spools/${encodeURIComponent(currentEditId)}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await api('/api/spools', { method: 'POST', body: JSON.stringify(data) });
    }

    await loadSpools();
    populateFilters();
    els.spoolModal.close();
    render();
  } catch (err) {
    alert(err.message || 'Failed to save spool.');
  }
}

function v(id) {
  return document.getElementById(id).value.trim();
}

async function deleteSpool(id) {
  if (!confirm('Delete this spool? This cannot be undone.')) return;
  try {
    await api(`/api/spools/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadSpools();
    populateFilters();
    render();
  } catch (err) {
    alert(err.message || 'Failed to delete spool.');
  }
}

function getFiltered() {
  const q = els.searchInput.value.toLowerCase();
  const material = els.materialFilter.value;
  const brand = els.brandFilter.value;

  return spools.filter((s) => {
    const matchesMaterial = material === 'All materials' || s.material === material;
    const matchesBrand = brand === 'All brands' || s.brand === brand;
    const searchable = Object.values(s).join(' ').toLowerCase();
    const matchesSearch = !q || searchable.includes(q);
    return matchesMaterial && matchesBrand && matchesSearch;
  });
}

function render() {
  const data = getFiltered();
  renderStats();
  els.spoolList.innerHTML = data.map(spoolCard).join('');
  els.emptyState.classList.toggle('hidden', data.length !== 0);

  data.forEach((s) => {
    document.getElementById(`edit-${s.id}`)?.addEventListener('click', () => openSpoolModal(s));
    document.getElementById(`delete-${s.id}`)?.addEventListener('click', () => deleteSpool(s.id));
  });
}

function spoolCard(s) {
  const pct = s.totalWeight ? (s.remainingWeight / s.totalWeight) * 100 : 0;
  const low = pct < 20;
  const lengthM = estimateLengthMeters(s.remainingWeight, s.material, s.diameter);

  return `<div class="card ${low ? 'low-stock' : ''}">
    <div class="flex items-start justify-between gap-2">
      <div class="space-y-1">
        <div class="flex items-center gap-2"><span class="swatch" style="background:${s.colorHex}"></span><h3 class="font-semibold">${escapeHtml(s.brand)} — ${escapeHtml(s.colorName)}</h3></div>
        <p class="text-sm text-slate-400">${s.material} • ${s.diameter}mm • ${escapeHtml(s.location || 'No location')}</p>
      </div>
      <div class="text-right text-sm">
        <p class="${low ? 'text-amber-400 font-semibold' : 'text-slate-300'}">${Math.round(s.remainingWeight)}g / ${Math.round(s.totalWeight)}g</p>
        <p class="text-slate-500">~${lengthM.toFixed(1)}m left</p>
      </div>
    </div>
    <div class="mt-2 w-full bg-slate-800 rounded-full h-2"><div class="h-2 rounded-full ${low ? 'bg-amber-400' : 'bg-cyan-400'}" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>
    <div class="mt-2 text-sm text-slate-400 flex flex-wrap gap-4">
      <span>Purchased: ${s.purchaseDate || '—'}</span>
      <span>Cost: $${(s.cost || 0).toFixed(2)}</span>
      ${s.notes ? `<span>Notes: ${escapeHtml(s.notes)}</span>` : ''}
    </div>
    <div class="mt-3 flex gap-2">
      <button id="edit-${s.id}" class="btn-secondary">Edit</button>
      <button id="delete-${s.id}" class="btn-secondary">Delete</button>
    </div>
  </div>`;
}

function estimateLengthMeters(weightG, material, diameterMm) {
  const density = MATERIAL_DENSITY[material] || MATERIAL_DENSITY.Other;
  const dCm = (diameterMm || 1.75) / 10;
  const area = Math.PI * (dCm / 2) ** 2;
  const volumeCm3 = weightG / density;
  const lengthCm = volumeCm3 / area;
  return lengthCm / 100;
}

function renderStats() {
  const totalSpools = spools.length;
  const totalWeight = spools.reduce((a, s) => a + (s.remainingWeight || 0), 0);
  const totalValue = spools.reduce((a, s) => a + (s.cost || 0), 0);
  const byMaterial = spools.reduce((acc, s) => {
    acc[s.material] = (acc[s.material] || 0) + (s.remainingWeight || 0);
    return acc;
  }, {});

  const materialSummary = Object.entries(byMaterial)
    .map(([k, v]) => `${k}: ${Math.round(v)}g`)
    .join(' • ') || 'No data';

  els.statsGrid.innerHTML = `
    <div class="card"><p class="text-slate-400 text-sm">Total Spools</p><p class="text-2xl font-semibold">${totalSpools}</p></div>
    <div class="card"><p class="text-slate-400 text-sm">Total Remaining</p><p class="text-2xl font-semibold">${Math.round(totalWeight)}g</p></div>
    <div class="card"><p class="text-slate-400 text-sm">Estimated Value</p><p class="text-2xl font-semibold">$${totalValue.toFixed(2)}</p></div>
    <div class="card"><p class="text-slate-400 text-sm">By Material</p><p class="text-sm">${materialSummary}</p></div>
  `;
}

function populateFilters() {
  const materials = ['All materials', ...new Set(spools.map((s) => s.material))];
  const brands = ['All brands', ...new Set(spools.map((s) => s.brand))];
  fillSelect(els.materialFilter, materials);
  fillSelect(els.brandFilter, brands);
}

function fillSelect(el, options) {
  const current = el.value;
  el.innerHTML = options.map((o) => `<option>${escapeHtml(o)}</option>`).join('');
  if (options.includes(current)) el.value = current;
}

async function exportJson() {
  try {
    const payload = await api('/api/export');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'filament-inventory.json';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert(err.message || 'Failed to export.');
  }
}

function importJson(e) {
  const file = e.target.files[0];
  if (!file) return;

  const r = new FileReader();
  r.onload = async () => {
    try {
      const parsed = JSON.parse(r.result);
      await api('/api/import', { method: 'POST', body: JSON.stringify(parsed) });
      await loadSpools();
      populateFilters();
      render();
      alert('Import successful.');
    } catch {
      alert('Invalid JSON file or import failed.');
    }
  };
  r.readAsText(file);
  e.target.value = '';
}

async function openPrinterModal() {
  try {
    const data = await api('/api/printer');
    document.getElementById('printerIp').value = data.ip || '';
    document.getElementById('printerToken').value = data.token || '';
    els.printerModal.showModal();
  } catch (err) {
    alert(err.message || 'Failed to load printer settings.');
  }
}

async function onSavePrinter(e) {
  e.preventDefault();
  const config = { ip: v('printerIp'), token: v('printerToken') };
  try {
    await api('/api/printer', { method: 'PUT', body: JSON.stringify(config) });
    els.printerModal.close();
    await loadPrinterConfig();
  } catch (err) {
    alert(err.message || 'Failed to save printer settings.');
  }
}

async function loadPrinterConfig() {
  const data = await api('/api/printer');
  document.getElementById('printerStatus').textContent = data.ip ? `Configured (${data.ip})` : 'Disconnected';
}

function escapeHtml(str = '') {
  return str.replace(/[&<>'\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
