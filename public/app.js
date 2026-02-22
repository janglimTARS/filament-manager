const MATERIAL_DENSITY = { PLA: 1.24, PETG: 1.27, ABS: 1.04, TPU: 1.21, ASA: 1.07, Other: 1.2 };
const ADD_LOCATION_VALUE = '__add_new_location__';
const PRINTER_STATUS_REFRESH_MS = 15000;

let spools = [];
let locations = [];
let currentEditId = null;
let amsMappingBySlot = {};
let pendingPrintEvent = null;

const els = {
  statsGrid: document.getElementById('statsGrid'),
  printCompleteBanner: document.getElementById('printCompleteBanner'),
  printCompleteText: document.getElementById('printCompleteText'),
  filamentUsedInput: document.getElementById('filamentUsedInput'),
  deductFilamentBtn: document.getElementById('deductFilamentBtn'),
  dismissPrintEventBtn: document.getElementById('dismissPrintEventBtn'),
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
  printerStateDot: document.getElementById('printerStateDot'),
  printerStateText: document.getElementById('printerStateText'),
  printerNozzle: document.getElementById('printerNozzle'),
  printerBed: document.getElementById('printerBed'),
  printerChamber: document.getElementById('printerChamber'),
  printerFile: document.getElementById('printerFile'),
  printerRemaining: document.getElementById('printerRemaining'),
  printerLayers: document.getElementById('printerLayers'),
  printerFan: document.getElementById('printerFan'),
  printerProgressBar: document.getElementById('printerProgressBar'),
  printerProgressText: document.getElementById('printerProgressText'),
  printerErrors: document.getElementById('printerErrors'),
  amsSection: document.getElementById('amsSection'),
  amsHumidity: document.getElementById('amsHumidity'),
  amsSlots: document.getElementById('amsSlots'),
  amsLinkModal: document.getElementById('amsLinkModal'),
  amsLinkTitle: document.getElementById('amsLinkTitle'),
  amsLinkOptions: document.getElementById('amsLinkOptions'),
};

init();

async function init() {
  bindEvents();
  await refreshAll();
  await loadPrinterStatus();
  setInterval(loadPrinterStatus, PRINTER_STATUS_REFRESH_MS);
}

function bindEvents() {
  document.getElementById('addSpoolBtn').onclick = () => openSpoolModal();
  document.getElementById('closeModalBtn').onclick = () => els.spoolModal.close();
  document.getElementById('configurePrinterBtn').onclick = () => openPrinterModal();
  document.getElementById('refreshPrinterBtn').onclick = () => loadPrinterStatus();
  document.getElementById('closePrinterModalBtn').onclick = () => els.printerModal.close();
  document.getElementById('closeAmsLinkModalBtn').onclick = () => els.amsLinkModal.close();
  document.getElementById('exportBtn').onclick = exportJson;
  document.getElementById('importInput').onchange = importJson;
  els.deductFilamentBtn.onclick = onDeductPendingPrintEvent;
  els.dismissPrintEventBtn.onclick = onDismissPendingPrintEvent;

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

async function loadAmsMapping() {
  const rows = await api('/api/ams-mapping');
  amsMappingBySlot = {};
  for (const row of rows || []) {
    const slot = Number(row.slot);
    if (!Number.isFinite(slot)) continue;
    amsMappingBySlot[slot] = String(row.spoolId || '');
  }
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
    document.getElementById('printerSerial').value = data.serial || '';
    const msg = document.getElementById('printerSaveMsg');
    msg.classList.add('hidden');
    msg.textContent = '';
    els.printerModal.showModal();
  } catch (err) {
    alert(err.message || 'Failed to load printer settings.');
  }
}

async function onSavePrinter(e) {
  e.preventDefault();
  const config = { ip: v('printerIp'), token: v('printerToken'), serial: v('printerSerial') };
  const msg = document.getElementById('printerSaveMsg');
  try {
    await api('/api/printer', { method: 'PUT', body: JSON.stringify(config) });
    msg.textContent = 'Saved! The printer bridge will pick this up shortly.';
    msg.classList.remove('hidden');
    await loadPrinterConfig();
    setTimeout(() => { els.printerModal.close(); msg.classList.add('hidden'); }, 2000);
  } catch (err) {
    alert(err.message || 'Failed to save printer settings.');
  }
}

async function loadPrinterConfig() {
  const data = await api('/api/printer');
  if (!data.ip) {
    setPrinterState('offline', 'Not configured');
  }
}

async function loadPrinterStatus() {
  try {
    const [status, pendingEvents] = await Promise.all([
      api('/api/printer-status'),
      api('/api/print-events?status=pending'),
      loadAmsMapping(),
    ]);
    renderPrinterStatus(status || {});
    updatePrintCompleteBanner(Array.isArray(pendingEvents) ? pendingEvents[0] : null);
  } catch {
    setPrinterState('offline', 'Offline');
    renderAms({});
    updatePrintCompleteBanner(null);
  }
}

function renderPrinterStatus(status) {
  const state = String(status.state || 'offline').toLowerCase();
  const progress = clamp(Number(status.progress || 0), 0, 100);
  const errors = Array.isArray(status.errors) ? status.errors : [];

  setPrinterState(state, prettyState(state));
  els.printerNozzle.textContent = `${fmt(status.nozzleTemp)} / ${fmt(status.nozzleTarget)} °C`;
  els.printerBed.textContent = `${fmt(status.bedTemp)} / ${fmt(status.bedTarget)} °C`;
  els.printerChamber.textContent = `${fmt(status.chamberTemp)} °C`;
  els.printerFile.textContent = status.currentFile || 'No active job';
  els.printerRemaining.textContent = `${Math.max(0, Math.round(Number(status.remainingMinutes || 0)))} min left`;
  els.printerLayers.textContent = `${Math.max(0, Math.round(Number(status.currentLayer || 0)))} / ${Math.max(0, Math.round(Number(status.totalLayers || 0)))}`;
  els.printerFan.textContent = `${Math.max(0, Math.round(Number(status.fanSpeed || 0)))}`;
  els.printerProgressBar.style.width = `${progress}%`;
  els.printerProgressText.textContent = `${Math.round(progress)}%`;

  if (errors.length) {
    els.printerErrors.classList.remove('hidden');
    els.printerErrors.innerHTML = `<strong class="block mb-1">Errors</strong>${errors.map((e) => `<div>• ${escapeHtml(typeof e === 'string' ? e : JSON.stringify(e))}</div>`).join('')}`;
  } else {
    els.printerErrors.classList.add('hidden');
    els.printerErrors.innerHTML = '';
  }

  renderAms(status.ams || {});
}

function renderAms(ams) {
  const trays = Array.isArray(ams?.trays) ? ams.trays : [];
  if (!trays.length) {
    els.amsSection.classList.add('hidden');
    els.amsHumidity.textContent = '';
    els.amsSlots.innerHTML = '';
    return;
  }

  const currentTray = Number(ams?.currentTray);
  const humidity = Number(ams?.humidity);
  els.amsSection.classList.remove('hidden');
  els.amsHumidity.textContent = Number.isFinite(humidity) ? `Humidity: ${Math.max(0, Math.round(humidity))}%` : '';

  els.amsSlots.innerHTML = trays.map((tray, idx) => {
    const slot = Number.isFinite(Number(tray?.slot)) ? Number(tray.slot) : idx;
    const material = String(tray?.material || 'Unknown').trim() || 'Unknown';
    const colorHexRaw = String(tray?.color || '').trim();
    const colorHex = normalizeHex(colorHexRaw);
    const isActive = slot === currentTray;
    const activeBadge = isActive ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">ACTIVE</span>' : '';

    const linkedSpoolId = amsMappingBySlot[slot] || '';
    const linkedSpool = linkedSpoolId ? spools.find((s) => s.id === linkedSpoolId) : null;
    const displayColor = normalizeHex(linkedSpool?.colorHex || '') || colorHex;
    const borderStyle = isActive && displayColor ? `border-color:${displayColor}; box-shadow: inset 0 0 0 1px ${displayColor}55;` : '';
    const linkedText = linkedSpool
      ? `${escapeHtml(linkedSpool.brand)} — ${escapeHtml(linkedSpool.colorName)}`
      : 'No linked spool';

    return `<div class="rounded-xl border border-border bg-slate-900/40 p-3 space-y-2" style="${borderStyle}">
      <div class="flex items-center justify-between">
        <div class="w-5 h-5 rounded-full border border-slate-500" style="background:${displayColor || '#64748b'}"></div>
        ${activeBadge}
      </div>
      <div class="text-sm font-semibold">${escapeHtml(material)}</div>
      <div class="text-xs text-slate-400">Slot ${slot + 1}</div>
      <div class="text-xs text-slate-400">${linkedText}</div>
      <div>
        ${linkedSpool
          ? `<button data-unlink-slot="${slot}" class="text-xs text-slate-400 hover:text-rose-300 underline-offset-2 hover:underline">Unlink</button>`
          : `<button data-link-slot="${slot}" class="btn-secondary text-xs py-1 px-2">Link Spool</button>`}
      </div>
    </div>`;
  }).join('');

  els.amsSlots.querySelectorAll('[data-link-slot]').forEach((btn) => {
    btn.addEventListener('click', () => openAmsLinkModal(Number(btn.getAttribute('data-link-slot'))));
  });

  els.amsSlots.querySelectorAll('[data-unlink-slot]').forEach((btn) => {
    btn.addEventListener('click', () => unlinkAmsSlot(Number(btn.getAttribute('data-unlink-slot'))));
  });
}

function openAmsLinkModal(slot) {
  els.amsLinkTitle.textContent = `Link Spool to AMS Slot ${slot + 1}`;

  if (!spools.length) {
    els.amsLinkOptions.innerHTML = '<div class="text-sm text-slate-400">No spools in inventory yet.</div>';
    els.amsLinkModal.showModal();
    return;
  }

  els.amsLinkOptions.innerHTML = spools.map((s) => {
    return `<button data-select-spool="${escapeHtml(s.id)}" data-slot="${slot}" class="w-full text-left rounded-lg border border-border bg-slate-900/50 hover:border-slate-500 px-3 py-2 text-sm">
      <div class="flex items-center gap-2">
        <span class="swatch" style="background:${escapeHtml(s.colorHex || '#ffffff')}"></span>
        <span class="font-medium">${escapeHtml(s.brand)} — ${escapeHtml(s.colorName)}</span>
      </div>
      <div class="text-xs text-slate-400 mt-1">${escapeHtml(s.material)} • ${Math.round(Number(s.remainingWeight || 0))}g left</div>
    </button>`;
  }).join('');

  els.amsLinkOptions.querySelectorAll('[data-select-spool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const spoolId = btn.getAttribute('data-select-spool');
      const targetSlot = Number(btn.getAttribute('data-slot'));
      linkAmsSlot(targetSlot, spoolId);
    });
  });

  els.amsLinkModal.showModal();
}

async function linkAmsSlot(slot, spoolId) {
  try {
    await api(`/api/ams-mapping/${slot}`, {
      method: 'PUT',
      body: JSON.stringify({ spoolId }),
    });
    els.amsLinkModal.close();
    await loadPrinterStatus();
  } catch (err) {
    alert(err.message || 'Failed to link spool.');
  }
}

async function unlinkAmsSlot(slot) {
  try {
    await api(`/api/ams-mapping/${slot}`, { method: 'DELETE' });
    await loadPrinterStatus();
  } catch (err) {
    alert(err.message || 'Failed to unlink spool.');
  }
}

function updatePrintCompleteBanner(event) {
  pendingPrintEvent = event || null;

  if (!pendingPrintEvent) {
    els.printCompleteBanner.classList.add('hidden');
    els.printCompleteText.textContent = '';
    els.filamentUsedInput.value = '';
    return;
  }

  const fileName = String(pendingPrintEvent.fileName || '').trim() || 'Unknown file';
  const spool = pendingPrintEvent.spool;
  const spoolLabel = spool
    ? `${spool.brand || 'Unknown brand'} — ${spool.colorName || 'Unknown color'}`
    : 'the linked spool';

  els.printCompleteText.textContent = `Print completed: ${fileName}. Deduct filament from ${spoolLabel}?`;
  els.printCompleteBanner.classList.remove('hidden');
}

async function onDeductPendingPrintEvent() {
  if (!pendingPrintEvent?.id) return;

  const filamentUsedG = Number(els.filamentUsedInput.value || 0);
  if (!Number.isFinite(filamentUsedG) || filamentUsedG < 0) {
    alert('Enter a valid filament usage in grams.');
    return;
  }

  try {
    await api(`/api/print-events/${encodeURIComponent(pendingPrintEvent.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ filament_used_g: filamentUsedG }),
    });
    els.filamentUsedInput.value = '';
    await refreshAll();
    await loadPrinterStatus();
  } catch (err) {
    alert(err.message || 'Failed to deduct filament.');
  }
}

async function onDismissPendingPrintEvent() {
  if (!pendingPrintEvent?.id) return;

  try {
    await api(`/api/print-events/${encodeURIComponent(pendingPrintEvent.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ filament_used_g: 0, status: 'dismissed' }),
    });
    els.filamentUsedInput.value = '';
    await loadPrinterStatus();
  } catch (err) {
    alert(err.message || 'Failed to dismiss print event.');
  }
}

function setPrinterState(state, text) {
  const colors = {
    printing: 'bg-emerald-400',
    idle: 'bg-amber-400',
    paused: 'bg-amber-400',
    error: 'bg-red-500',
    offline: 'bg-slate-500',
  };

  els.printerStateDot.className = `inline-block w-2.5 h-2.5 rounded-full ${colors[state] || colors.offline}`;
  els.printerStateText.textContent = text;
}

function prettyState(state) {
  if (state === 'printing') return 'Printing';
  if (state === 'idle') return 'Idle';
  if (state === 'paused') return 'Paused';
  if (state === 'error') return 'Error';
  return 'Offline';
}

function fmt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toFixed(1) : '0.0';
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

function normalizeHex(value = '') {
  const raw = String(value).trim().replace(/^#/, '');
  if (!raw) return '';
  const withoutAlpha = raw.length === 8 ? raw.slice(0, 6) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(withoutAlpha)) return '';
  return `#${withoutAlpha}`;
}

function escapeHtml(str = '') {
  return str.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
