const STORAGE_KEY = 'filament-manager-spools';
const PRINTER_KEY = 'filament-manager-printer';
const MATERIAL_DENSITY = { PLA: 1.24, PETG: 1.27, ABS: 1.04, TPU: 1.21, ASA: 1.07, Other: 1.2 };

let spools = loadSpools();
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
};

init();

function init() {
  bindEvents();
  populateFilters();
  loadPrinterConfig();
  render();
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

  els.spoolForm.onsubmit = onSubmitSpool;
  document.getElementById('printerForm').onsubmit = onSavePrinter;
}

function loadSpools() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveSpools() { localStorage.setItem(STORAGE_KEY, JSON.stringify(spools)); }

function openSpoolModal(spool = null) {
  currentEditId = spool?.id || null;
  els.modalTitle.textContent = spool ? 'Edit Spool' : 'Add Spool';
  const set = (id, val = '') => document.getElementById(id).value = val;

  set('spoolId', spool?.id || '');
  set('brand', spool?.brand || '');
  set('colorName', spool?.colorName || '');
  set('colorHex', spool?.colorHex || '#ffffff');
  set('material', spool?.material || 'PLA');
  set('diameter', spool?.diameter || 1.75);
  set('location', spool?.location || '');
  set('totalWeight', spool?.totalWeight || '');
  set('remainingWeight', spool?.remainingWeight || '');
  set('purchaseDate', spool?.purchaseDate || '');
  set('cost', spool?.cost || '');
  set('notes', spool?.notes || '');
  els.spoolModal.showModal();
}

function onSubmitSpool(e) {
  e.preventDefault();
  const data = {
    id: currentEditId || crypto.randomUUID(),
    brand: v('brand'), colorName: v('colorName'), colorHex: v('colorHex'),
    material: v('material'), diameter: Number(v('diameter')) || 1.75,
    totalWeight: Number(v('totalWeight')), remainingWeight: Number(v('remainingWeight')),
    location: v('location'), purchaseDate: v('purchaseDate'), cost: Number(v('cost')) || 0,
    notes: v('notes'),
  };

  if (data.remainingWeight > data.totalWeight) {
    alert('Remaining weight cannot be greater than total weight.');
    return;
  }

  const i = spools.findIndex(s => s.id === data.id);
  if (i >= 0) spools[i] = data; else spools.unshift(data);
  saveSpools();
  populateFilters();
  els.spoolModal.close();
  render();
}

function v(id) { return document.getElementById(id).value.trim(); }

function deleteSpool(id) {
  if (!confirm('Delete this spool? This cannot be undone.')) return;
  spools = spools.filter(s => s.id !== id);
  saveSpools();
  populateFilters();
  render();
}

function getFiltered() {
  const q = els.searchInput.value.toLowerCase();
  const material = els.materialFilter.value;
  const brand = els.brandFilter.value;

  return spools.filter(s => {
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

  data.forEach(s => {
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
  const density = MATERIAL_DENSITY[material] || MATERIAL_DENSITY.Other; // g/cm3
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

  const materialSummary = Object.entries(byMaterial).map(([k, v]) => `${k}: ${Math.round(v)}g`).join(' • ') || 'No data';
  els.statsGrid.innerHTML = `
    <div class="card"><p class="text-slate-400 text-sm">Total Spools</p><p class="text-2xl font-semibold">${totalSpools}</p></div>
    <div class="card"><p class="text-slate-400 text-sm">Total Remaining</p><p class="text-2xl font-semibold">${Math.round(totalWeight)}g</p></div>
    <div class="card"><p class="text-slate-400 text-sm">Estimated Value</p><p class="text-2xl font-semibold">$${totalValue.toFixed(2)}</p></div>
    <div class="card"><p class="text-slate-400 text-sm">By Material</p><p class="text-sm">${materialSummary}</p></div>
  `;
}

function populateFilters() {
  const materials = ['All materials', ...new Set(spools.map(s => s.material))];
  const brands = ['All brands', ...new Set(spools.map(s => s.brand))];
  fillSelect(els.materialFilter, materials);
  fillSelect(els.brandFilter, brands);
}
function fillSelect(el, options) {
  const current = el.value;
  el.innerHTML = options.map(o => `<option>${o}</option>`).join('');
  if (options.includes(current)) el.value = current;
}

function exportJson() {
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), spools }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'filament-inventory.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const parsed = JSON.parse(r.result);
      const incoming = Array.isArray(parsed) ? parsed : parsed.spools;
      if (!Array.isArray(incoming)) throw new Error('Invalid format');
      spools = incoming;
      saveSpools();
      populateFilters();
      render();
      alert('Import successful.');
    } catch {
      alert('Invalid JSON file.');
    }
  };
  r.readAsText(file);
  e.target.value = '';
}

function openPrinterModal() {
  const data = JSON.parse(localStorage.getItem(PRINTER_KEY) || '{}');
  document.getElementById('printerIp').value = data.ip || '';
  document.getElementById('printerToken').value = data.token || '';
  els.printerModal.showModal();
}

function onSavePrinter(e) {
  e.preventDefault();
  const config = { ip: v('printerIp'), token: v('printerToken') };
  localStorage.setItem(PRINTER_KEY, JSON.stringify(config));
  els.printerModal.close();
  loadPrinterConfig();
}

function loadPrinterConfig() {
  const data = JSON.parse(localStorage.getItem(PRINTER_KEY) || '{}');
  document.getElementById('printerStatus').textContent = data.ip ? `Configured (${data.ip})` : 'Disconnected';
}

function escapeHtml(str='') {
  return str.replace(/[&<>'\"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));
}
