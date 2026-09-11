import { supabase } from './supabase-config.js';

// El cliente de supabase-js v2 expone estas propiedades públicamente,
// así que no hace falta tocar supabase-config.js para tener la URL/key.
const supabaseUrl = supabase.supabaseUrl;
const supabaseAnonKey = supabase.supabaseKey;

/* ============================================================
   ADMIN PANEL — Ruta San Simón (R-18)
   Acceso restringido a filas de "owners" con role = 'developer'.
   (No usamos 'admin' aquí a propósito: ese rol ya lo usan dueno.html/
   checador.html para su propia lógica de "ver todo". 'developer' es
   un rol nuevo, exclusivo de este panel.)

   IMPORTANTE — creación/borrado de dueños:
   Crear un usuario con correo/contraseña requiere la
   "service_role key" de Supabase, que NUNCA debe vivir en el
   navegador. Por eso esas dos acciones llaman a una Edge Function
   (admin-owners) que corre del lado del servidor. Ver
   supabase/functions/admin-owners/index.ts
   ============================================================ */

let currentAdmin = null;
let ownersCache = [];
let unitsCache = [];

// ----- DOM -----
const loginScreen = document.getElementById('loginScreen');
const mainScreen = document.getElementById('mainScreen');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginError = document.getElementById('loginError');
const globalMsg = document.getElementById('globalMsg');

// ----- MENSAJE GLOBAL -----
let msgTimer = null;
function showMsg(text, type = 'ok') {
  globalMsg.textContent = text;
  globalMsg.classList.remove('hidden');
  globalMsg.style.background = type === 'error' ? 'var(--alerta-bg)' : 'color-mix(in srgb, var(--agave) 18%, var(--surface))';
  globalMsg.style.color = type === 'error' ? 'var(--alerta)' : 'var(--agave)';
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => globalMsg.classList.add('hidden'), 4000);
}

// ----- LOGIN -----
document.getElementById('loginSubmit').addEventListener('click', tryLogin);
emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

async function tryLogin() {
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();
  if (!email || !password) return;

  loginError.classList.add('hidden');

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    loginError.textContent = 'Correo, contraseña, o permisos incorrectos.';
    loginError.classList.remove('hidden');
    return;
  }

  const { data: owner, error: ownerError } = await supabase
    .from('owners')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (ownerError || !owner || owner.role !== 'developer') {
    await supabase.auth.signOut();
    loginError.textContent = 'Tu cuenta no tiene permisos de desarrollador.';
    loginError.classList.remove('hidden');
    return;
  }

  currentAdmin = owner;
  loginScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  emailInput.value = '';
  passwordInput.value = '';

  await loadAll();
  if (window.lucide) lucide.createIcons();
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  currentAdmin = null;
  mainScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
});

// ----- TABS -----
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
  });
});

// ----- CARGA INICIAL -----
async function loadAll() {
  await Promise.all([loadOwners(), loadUnits()]); // primero, porque alimentan los <select>
  await Promise.all([loadDrivers(), loadCheckadores()]);
}

// Helper para llamar a Supabase con manejo de error uniforme
async function safeCall(promise, okMsg, errPrefix) {
  const { error } = await promise;
  if (error) {
    console.error(errPrefix, error);
    showMsg(`${errPrefix}: ${error.message}`, 'error');
    return false;
  }
  if (okMsg) showMsg(okMsg);
  return true;
}

/* ============================================================
   DUEÑOS (owners)
   Crear/borrar pasa por la Edge Function porque implica cuentas
   de Auth. Editar nombre/rol sí se hace directo (fila normal).
   ============================================================ */
async function loadOwners() {
  const { data, error } = await supabase.from('owners').select('*').order('full_name', { ascending: true });
  if (error) { console.error('Error cargando owners:', error); return; }
  ownersCache = data || [];
  renderOwnersTable();
  populateOwnerSelects();
}

function renderOwnersTable() {
  const tbody = document.getElementById('ownersTbody');
  tbody.innerHTML = ownersCache.map((o) => `
    <tr data-id="${o.id}">
      <td><input class="field owner-name-input" value="${escapeAttr(o.full_name || '')}" style="min-width:140px"></td>
      <td><input class="field owner-phone-input" value="${escapeAttr(o.phone || '')}" style="min-width:120px" type="tel" placeholder="Teléfono"></td>
      <td class="font-mono text-xs">${escapeHtml(o.email || '—')}</td>
      <td>
        <select class="field owner-role-input" style="min-width:130px">
          <option value="owner" ${o.role === 'owner' ? 'selected' : ''}>Dueño</option>
          <option value="admin" ${o.role === 'admin' ? 'selected' : ''}>Admin</option>
          <option value="developer" ${o.role === 'developer' ? 'selected' : ''}>Desarrollador</option>
        </select>
      </td>
      <td class="whitespace-nowrap">
        <button class="btn btn-ghost text-xs owner-save-btn">Guardar</button>
        <button class="btn btn-ghost text-xs owner-reset-btn">Reset pass</button>
        <button class="btn btn-danger text-xs owner-delete-btn">Borrar</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.owner-save-btn').forEach((btn) => btn.addEventListener('click', (e) => saveOwner(e)));
  tbody.querySelectorAll('.owner-reset-btn').forEach((btn) => btn.addEventListener('click', (e) => resetOwnerPassword(e)));
  tbody.querySelectorAll('.owner-delete-btn').forEach((btn) => btn.addEventListener('click', (e) => deleteOwner(e)));
}

async function saveOwner(e) {
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;
  const full_name = tr.querySelector('.owner-name-input').value.trim();
  const phone = tr.querySelector('.owner-phone-input').value.trim();
  const role = tr.querySelector('.owner-role-input').value;

  const ok = await safeCall(
    supabase.from('owners').update({ full_name, phone, role }).eq('id', id),
    'Dueño actualizado.',
    'Error al actualizar dueño'
  );
  if (ok) await loadOwners();
}

async function resetOwnerPassword(e) {
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;
  const owner = ownersCache.find((o) => o.id === id);
  if (!owner || !owner.email) { showMsg('Este dueño no tiene correo registrado.', 'error'); return; }

  const { error } = await supabase.auth.resetPasswordForEmail(owner.email);
  if (error) { showMsg('Error al enviar el correo de reseteo: ' + error.message, 'error'); return; }
  showMsg(`Correo de restablecimiento enviado a ${owner.email}.`);
}

async function deleteOwner(e) {
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;
  const owner = ownersCache.find((o) => o.id === id);
  if (!confirm(`¿Borrar al dueño "${owner?.full_name || owner?.email}"? Esto también borra su acceso.`)) return;

  const result = await callAdminOwnersFunction({ action: 'delete', id });
  if (result.ok) {
    showMsg('Dueño borrado.');
    await loadOwners();
  } else {
    showMsg('Error al borrar dueño: ' + result.error, 'error');
  }
}

document.getElementById('addOwnerBtn').addEventListener('click', async () => {
  const full_name = document.getElementById('ownerFullName').value.trim();
  const phone = document.getElementById('ownerPhone').value.trim();
  const email = document.getElementById('ownerEmail').value.trim();
  const password = document.getElementById('ownerPassword').value.trim();
  const role = document.getElementById('ownerRole').value;

  if (!full_name || !email || !password) {
    showMsg('Llena nombre, correo y contraseña.', 'error');
    return;
  }
  if (password.length < 6) {
    showMsg('La contraseña debe tener al menos 6 caracteres.', 'error');
    return;
  }

  const result = await callAdminOwnersFunction({ action: 'create', full_name, phone, email, password, role });
  if (result.ok) {
    showMsg('Dueño creado.');
    document.getElementById('ownerFullName').value = '';
    document.getElementById('ownerPhone').value = '';
    document.getElementById('ownerEmail').value = '';
    document.getElementById('ownerPassword').value = '';
    document.getElementById('ownerRole').value = 'owner';
    await loadOwners();
  } else {
    showMsg('Error al crear dueño: ' + result.error, 'error');
  }
});

// Llama a la Edge Function admin-owners (crear/borrar), mandando el
// token de sesión del admin actual para que la función verifique permisos.
async function callAdminOwnersFunction(body) {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) return { ok: false, error: 'Sesión no válida, vuelve a iniciar sesión.' };

    const res = await fetch(`${supabaseUrl}/functions/v1/admin-owners`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json.error || `Error HTTP ${res.status}` };
    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err.message || 'Error de red' };
  }
}

function populateOwnerSelects() {
  const opts = ownersCache.map((o) => `<option value="${o.id}">${escapeHtml(o.full_name || o.email || o.id)}</option>`).join('');
  ['driverOwner', 'unitOwner'].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="">Sin dueño</option>${opts}`;
    if (current) sel.value = current;
  });
}

/* ============================================================
   UNIDADES (units)
   ============================================================ */
async function loadUnits() {
  const { data, error } = await supabase.from('units').select('*, owner:owner_id ( full_name )').order('unit_number', { ascending: true });
  if (error) { console.error('Error cargando units:', error); return; }
  unitsCache = data || [];
  renderUnitsTable();
  populateUnitSelect();
}

function renderUnitsTable() {
  const tbody = document.getElementById('unitsTbody');
  tbody.innerHTML = unitsCache.map((u) => `
    <tr data-id="${u.id}">
      <td><input class="field unit-number-input" value="${escapeAttr(u.unit_number ?? '')}" style="max-width:90px"></td>
      <td>
        <select class="field unit-owner-input" style="min-width:150px">
          <option value="">Sin dueño</option>
          ${ownersCache.map((o) => `<option value="${o.id}" ${u.owner_id === o.id ? 'selected' : ''}>${escapeHtml(o.full_name || o.email)}</option>`).join('')}
        </select>
      </td>
      <td>
        <label class="inline-flex items-center gap-1.5 text-xs" style="color:var(--ink-soft);">
          <input type="checkbox" class="unit-active-input" ${u.active !== false ? 'checked' : ''}> Activa
        </label>
      </td>
      <td class="whitespace-nowrap">
        <button class="btn btn-ghost text-xs unit-save-btn">Guardar</button>
        <button class="btn btn-danger text-xs unit-delete-btn">Borrar</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.unit-save-btn').forEach((btn) => btn.addEventListener('click', (e) => saveUnit(e)));
  tbody.querySelectorAll('.unit-delete-btn').forEach((btn) => btn.addEventListener('click', (e) => deleteUnit(e)));
}

async function saveUnit(e) {
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;
  const unit_number = tr.querySelector('.unit-number-input').value.trim();
  const owner_id = tr.querySelector('.unit-owner-input').value || null;
  const active = tr.querySelector('.unit-active-input').checked;

  const ok = await safeCall(
    supabase.from('units').update({ unit_number, owner_id, active }).eq('id', id),
    'Unidad actualizada.',
    'Error al actualizar unidad'
  );
  if (ok) await loadUnits();
}

async function deleteUnit(e) {
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;
  if (!confirm('¿Borrar esta unidad? Los conductores asignados quedarán sin unidad.')) return;
  const ok = await safeCall(supabase.from('units').delete().eq('id', id), 'Unidad borrada.', 'Error al borrar unidad');
  if (ok) { await loadUnits(); await loadDrivers(); }
}

document.getElementById('addUnitBtn').addEventListener('click', async () => {
  const unit_number = document.getElementById('unitNumber').value.trim();
  const owner_id = document.getElementById('unitOwner').value || null;
  if (!unit_number) { showMsg('Escribe el número de unidad.', 'error'); return; }

  const ok = await safeCall(
    supabase.from('units').insert({ unit_number, owner_id }),
    'Unidad creada.',
    'Error al crear unidad'
  );
  if (ok) {
    document.getElementById('unitNumber').value = '';
    await loadUnits();
  }
});

function populateUnitSelect() {
  const sel = document.getElementById('driverUnit');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">Sin unidad</option>${unitsCache.map((u) => `<option value="${u.id}">Unidad ${escapeHtml(String(u.unit_number))}</option>`).join('')}`;
  if (current) sel.value = current;
}

/* ============================================================
   CONDUCTORES (drivers)
   ============================================================ */
async function loadDrivers() {
  const { data, error } = await supabase
    .from('drivers')
    .select('*, unit:unit_id ( unit_number ), owner:owner_id ( full_name )')
    .order('name', { ascending: true });
  if (error) { console.error('Error cargando drivers:', error); return; }
  renderDriversTable(data || []);
}

function renderDriversTable(drivers) {
  const tbody = document.getElementById('driversTbody');
  tbody.innerHTML = drivers.map((d) => `
    <tr data-id="${d.id}">
      <td><input class="field driver-name-input" value="${escapeAttr(d.name || '')}" style="min-width:130px"></td>
      <td><input class="field driver-phone-input" value="${escapeAttr(d.phone || '')}" style="min-width:110px" type="tel" placeholder="Teléfono"></td>
      <td><input class="field driver-pin-input" value="${escapeAttr(d.pin || '')}" style="max-width:90px" inputmode="numeric"></td>
      <td>
        <select class="field driver-unit-input" style="min-width:120px">
          <option value="">Sin unidad</option>
          ${unitsCache.map((u) => `<option value="${u.id}" ${d.unit_id === u.id ? 'selected' : ''}>Unidad ${escapeHtml(String(u.unit_number))}</option>`).join('')}
        </select>
      </td>
      <td>
        <select class="field driver-owner-input" style="min-width:130px">
          <option value="">Sin dueño</option>
          ${ownersCache.map((o) => `<option value="${o.id}" ${d.owner_id === o.id ? 'selected' : ''}>${escapeHtml(o.full_name || o.email)}</option>`).join('')}
        </select>
      </td>
      <td>
        <label class="inline-flex items-center gap-1.5 text-xs" style="color:var(--ink-soft);">
          <input type="checkbox" class="driver-active-input" ${d.active !== false ? 'checked' : ''}> Activo
        </label>
      </td>
      <td class="whitespace-nowrap">
        <button class="btn btn-ghost text-xs driver-save-btn">Guardar</button>
        <button class="btn btn-ghost text-xs driver-unassign-btn" ${d.unit_id ? '' : 'disabled style="opacity:.4;cursor:not-allowed;"'}>Quitar de unidad</button>
        <button class="btn btn-danger text-xs driver-delete-btn">Borrar</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.driver-save-btn').forEach((btn) => btn.addEventListener('click', (e) => saveDriver(e)));
  tbody.querySelectorAll('.driver-unassign-btn').forEach((btn) => btn.addEventListener('click', (e) => unassignDriver(e)));
  tbody.querySelectorAll('.driver-delete-btn').forEach((btn) => btn.addEventListener('click', (e) => deleteDriver(e)));
}

// Quita al conductor de su unidad actual con un solo click, sin tocar
// el resto de sus datos y sin desactivarlo — sigue existiendo y activo
// en el sistema, listo para reasignarse a otra unidad cuando haga falta.
async function unassignDriver(e) {
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;

  const ok = await safeCall(
    supabase.from('drivers').update({ unit_id: null }).eq('id', id),
    'Conductor quitado de su unidad.',
    'Error al quitar conductor de la unidad'
  );
  if (ok) await loadDrivers();
}

async function saveDriver(e) {
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;
  const name = tr.querySelector('.driver-name-input').value.trim();
  const phone = tr.querySelector('.driver-phone-input').value.trim();
  const pin = tr.querySelector('.driver-pin-input').value.trim();
  const unit_id = tr.querySelector('.driver-unit-input').value || null;
  const owner_id = tr.querySelector('.driver-owner-input').value || null;
  const active = tr.querySelector('.driver-active-input').checked;

  const ok = await safeCall(
    supabase.from('drivers').update({ name, phone, pin, unit_id, owner_id, active }).eq('id', id),
    'Conductor actualizado.',
    'Error al actualizar conductor'
  );
  if (ok) await loadDrivers();
}

async function deleteDriver(e) {
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;
  if (!confirm('¿Borrar este conductor?')) return;
  const ok = await safeCall(supabase.from('drivers').delete().eq('id', id), 'Conductor borrado.', 'Error al borrar conductor');
  if (ok) await loadDrivers();
}

document.getElementById('addDriverBtn').addEventListener('click', async () => {
  const name = document.getElementById('driverName').value.trim();
  const phone = document.getElementById('driverPhone').value.trim();
  const pin = document.getElementById('driverPin').value.trim();
  const routeRaw = document.getElementById('driverRoute').value.trim();
  const unit_id = document.getElementById('driverUnit').value || null;
  const owner_id = document.getElementById('driverOwner').value || null;

  if (!name || !pin) { showMsg('Escribe nombre y PIN.', 'error'); return; }

  const ok = await safeCall(
    supabase.from('drivers').insert({ name, phone, pin, route: routeRaw || null, unit_id, owner_id }),
    'Conductor creado.',
    'Error al crear conductor'
  );
  if (ok) {
    document.getElementById('driverName').value = '';
    document.getElementById('driverPhone').value = '';
    document.getElementById('driverPin').value = '';
    document.getElementById('driverRoute').value = '';
    await loadDrivers();
  }
});

/* ============================================================
   CHECADORES
   ============================================================ */
async function loadCheckadores() {
  const { data, error } = await supabase.from('checadores').select('*').order('name', { ascending: true });
  if (error) { console.error('Error cargando checadores:', error); return; }
  renderCheckadoresTable(data || []);
}

function renderCheckadoresTable(checadores) {
  const tbody = document.getElementById('checadoresTbody');
  tbody.innerHTML = checadores.map((c) => `
    <tr data-id="${c.id}">
      <td><input class="field checador-name-input" value="${escapeAttr(c.name || '')}" style="min-width:140px"></td>
      <td><input class="field checador-phone-input" value="${escapeAttr(c.phone || '')}" style="min-width:110px" type="tel" placeholder="Teléfono"></td>
      <td><input class="field checador-pin-input" value="${escapeAttr(c.pin || '')}" style="max-width:90px" inputmode="numeric"></td>
      <td class="whitespace-nowrap">
        <button class="btn btn-ghost text-xs checador-save-btn">Guardar</button>
        <button class="btn btn-danger text-xs checador-delete-btn">Borrar</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.checador-save-btn').forEach((btn) => btn.addEventListener('click', (e) => saveChecador(e)));
  tbody.querySelectorAll('.checador-delete-btn').forEach((btn) => btn.addEventListener('click', (e) => deleteChecador(e)));
}

async function saveChecador(e) {
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;
  const name = tr.querySelector('.checador-name-input').value.trim();
  const phone = tr.querySelector('.checador-phone-input').value.trim();
  const pin = tr.querySelector('.checador-pin-input').value.trim();

  const ok = await safeCall(
    supabase.from('checadores').update({ name, phone, pin }).eq('id', id),
    'Checador actualizado.',
    'Error al actualizar checador'
  );
  if (ok) await loadCheckadores();
}

async function deleteChecador(e) {
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;
  if (!confirm('¿Borrar este checador?')) return;
  const ok = await safeCall(supabase.from('checadores').delete().eq('id', id), 'Checador borrado.', 'Error al borrar checador');
  if (ok) await loadCheckadores();
}

document.getElementById('addChecadorBtn').addEventListener('click', async () => {
  const name = document.getElementById('checadorName').value.trim();
  const phone = document.getElementById('checadorPhone').value.trim();
  const pin = document.getElementById('checadorPin').value.trim();
  if (!name || !pin) { showMsg('Escribe nombre y PIN.', 'error'); return; }

  const ok = await safeCall(
    supabase.from('checadores').insert({ name, phone, pin }),
    'Checador creado.',
    'Error al crear checador'
  );
  if (ok) {
    document.getElementById('checadorName').value = '';
    document.getElementById('checadorPhone').value = '';
    document.getElementById('checadorPin').value = '';
    await loadCheckadores();
  }
});

// ----- HELPERS -----
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}

if (window.lucide) lucide.createIcons();
