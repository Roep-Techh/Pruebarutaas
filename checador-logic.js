import { supabase } from './supabase-config.js';
import { initPushNotifications } from './push-notifications.js';
import { initHorarios } from './horarios-logic.js';

// ----- HELPER: enganchar eventos sin tronar si el elemento no existe -----
function on(el, event, handler, label) {
  if (!el) {
    console.warn('[checador] Elemento no encontrado para el evento:', event, label ? `(${label})` : '');
    return;
  }
  el.addEventListener(event, handler);
}

// ----- ELEMENTOS DOM -----
const pinScreen = document.getElementById('pinScreen');
const mainScreen = document.getElementById('mainScreen');
const pinInput = document.getElementById('pinInput');
const pinError = document.getElementById('pinError');
const checadorNameText = document.getElementById('checadorNameText');
const unitsGrid = document.getElementById('unitsGrid');
const unitsEmpty = document.getElementById('unitsEmpty');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toastText');

const unitDriversOverlay = document.getElementById('unitDriversOverlay');
const unitDriversTitle = document.getElementById('unitDriversTitle');
const unitDriversList = document.getElementById('unitDriversList');
const unitDriversCancelBtn = document.getElementById('unitDriversCancelBtn');

const incidentOverlay = document.getElementById('incidentOverlay');
const incidentUnitLabel = document.getElementById('incidentUnitLabel');
const incidentCancelBtn = document.getElementById('incidentCancelBtn');
const incidentTardeBtn = document.getElementById('incidentTardeBtn');
const incidentNoPresentoBtn = document.getElementById('incidentNoPresentoBtn');

const pinSubmitBtn = document.getElementById('pinSubmit');
const backToPinBtn = document.getElementById('backToPinBtn');
const switchChecadorBtn = document.getElementById('switchChecadorBtn'); // puede no existir, es opcional
const sendSummaryBtn = document.getElementById('sendSummaryBtn');

let currentChecador = null;
let driversChannel = null;
let toastTimer = null;
let pendingIncidentDriver = null; // objeto {driverId, unitId, driverName, route, ownerId, unitNumber}
let unitsById = {}; // { unitId: { unit_number, drivers: [...] } }

// ----- PANEL AMPLIADO (mapa + conductores + alertas, como el del dueño) -----
let map = null;
let mapInitialized = false;
let driverMarkers = {};
let locationChannel = null;
let routeChannel = null;
let alertChannel = null;
let driversStatusChannel = null;
let vueltasChannel = null;

let lastDrivers = [];
let lastRouteEvents = [];
let lastVueltas = {}; // driver_id -> vueltas de hoy

// ----- LOGIN CON PIN -----
on(pinSubmitBtn, 'click', tryPin);
on(pinInput, 'keydown', (e) => { if (e.key === 'Enter') tryPin(); });

async function tryPin() {
  const pin = pinInput.value.trim();
  if (!pin) return;

  const { data: checador, error } = await supabase
    .from('checadores')
    .select('*')
    .eq('pin', pin)
    .single();

  if (checador && !error) {
    localStorage.setItem('rss_checador_id', checador.id);
    localStorage.setItem('rss_checador_session_date', todayKey());
    pinError.classList.add('hidden');
    pinInput.value = '';
    unlock(checador);
  } else {
    pinError.classList.remove('hidden');
  }
}

function unlock(checador) {
  currentChecador = checador;
  pinScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  mainScreen.classList.add('md:flex');
  checadorNameText.textContent = checador.name;
  window.__rssWalkieName = checador.name || 'Checador'; // usado por el botón de radio
  loadUnits();
  initRealtime();

  // Notificaciones push forzosas: que le lleguen las alertas aunque tenga
  // el panel cerrado o el celular bloqueado (requiere que el panel esté
  // instalado desde Chrome). Ver push-notifications.js para la config.
  initPushNotifications('checador', checador.id, checador.name);

  // Panel ampliado: conductores + alertas (mismo que ve el dueño).
  // El mapa incrustado solo se usa en celular; en escritorio "Mapa" abre
  // mapa-vivo.html en una pestaña aparte, así que ahí no hace falta cargarlo.
  const isDesktop = window.matchMedia('(min-width: 768px)').matches;
  if (!isDesktop && !mapInitialized) initMap();
  initFleetRealtimeListeners();
  initHorarios();

  if (window.lucide) lucide.createIcons();
}

// ----- SESIÓN DEL DÍA (no volver a pedir PIN mientras sea el mismo día) -----
// Igual que en conductor-logic.js: mientras siga siendo el mismo día, si
// recargas la página no te vuelve a pedir el PIN. Al día siguiente, por
// seguridad, sí se vuelve a pedir (por si cambió el checador de turno).
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

async function tryAutoLogin() {
  const savedId = localStorage.getItem('rss_checador_id');
  const savedDate = localStorage.getItem('rss_checador_session_date');
  if (!savedId || !savedDate || savedDate !== todayKey()) return;

  const { data: checador, error } = await supabase
    .from('checadores')
    .select('*')
    .eq('id', savedId)
    .single();

  if (checador && !error) {
    unlock(checador);
  } else {
    // El id guardado ya no es válido (p.ej. lo borraron): limpiamos para
    // que la próxima vez sí pida PIN normal.
    localStorage.removeItem('rss_checador_id');
    localStorage.removeItem('rss_checador_session_date');
  }
}

// ----- CIERRE DE SESIÓN -----
function goToPinScreen() {
  if (driversChannel) supabase.removeChannel(driversChannel);
  if (locationChannel) supabase.removeChannel(locationChannel);
  if (routeChannel) supabase.removeChannel(routeChannel);
  if (alertChannel) supabase.removeChannel(alertChannel);
  if (driversStatusChannel) supabase.removeChannel(driversStatusChannel);
  if (vueltasChannel) supabase.removeChannel(vueltasChannel);
  localStorage.removeItem('rss_checador_id');
  localStorage.removeItem('rss_checador_session_date');
  currentChecador = null;
  lastDrivers = [];
  lastRouteEvents = [];
  lastVueltas = {};
  mapInitialized = false;
  driverMarkers = {};
  closeDriverDrawer();
  closeMobileNav();
  mainScreen.classList.add('hidden');
  mainScreen.classList.remove('md:flex');
  pinScreen.classList.remove('hidden');
  pinInput.value = '';
}

on(backToPinBtn, 'click', goToPinScreen);
on(switchChecadorBtn, 'click', goToPinScreen, 'switchChecadorBtn - opcional, normal que no exista');
on(document.getElementById('logoutBtnDesktop'), 'click', goToPinScreen, 'logoutBtnDesktop');
on(document.getElementById('logoutBtnMobileNav'), 'click', goToPinScreen, 'logoutBtnMobileNav');

// ----- CARGAR UNIDADES (todas las unidades activas, de todos los dueños) -----
// Antes esto se armaba solo a partir de "drivers" (uniendo con unit_id), así
// que cualquier unidad sin conductor asignado nunca aparecía en la cuadrícula.
// Ahora se parte de la tabla "units" (igual que el panel de admin) y luego se
// le "cuelgan" los conductores que le tocan, si es que tiene.
async function loadUnits() {
  const [{ data: units, error: unitsError }, { data: drivers, error: driversError }] = await Promise.all([
    supabase.from('units').select('id, unit_number, active').order('unit_number', { ascending: true }),
    supabase.from('drivers').select('id, name, phone, route, owner_id, unit_id'),
  ]);

  if (unitsError || driversError) {
    console.error('Error cargando unidades:', unitsError || driversError);
    unitsEmpty.textContent = 'No se pudieron cargar las unidades. Revisa tu conexión.';
    unitsEmpty.classList.remove('hidden');
    unitsGrid.innerHTML = '';
    return;
  }

  renderUnitsGrid(units || [], drivers || []);
}

function routeColor(route) {
  return route === 'capilla' ? 'var(--cempasuchil)' : (route === 'secundaria' ? 'var(--agave)' : 'var(--ink-soft)');
}

function routeLabel(route) {
  return route === 'capilla' ? 'Por Capilla' : (route === 'secundaria' ? 'Por Secundaria' : 'Sin ramal');
}

// Parte de TODAS las unidades activas (aunque no tengan conductor asignado
// todavía) y les cuelga los conductores que les tocan. Una misma unidad puede
// tener más de un conductor (turnos / días distintos).
function renderUnitsGrid(units, drivers) {
  unitsById = {};

  units
    .filter((u) => u.active !== false && u.unit_number != null)
    .forEach((u) => {
      unitsById[u.id] = { unit_number: u.unit_number, drivers: [] };
    });

  drivers
    .filter((d) => d.unit_id && unitsById[d.unit_id])
    .forEach((d) => {
      unitsById[d.unit_id].drivers.push({
        driverId: d.id,
        driverName: d.name || 'Conductor',
        driverPhone: d.phone || '',
        route: d.route || '',
        ownerId: d.owner_id,
        unitId: d.unit_id,
        unitNumber: unitsById[d.unit_id].unit_number,
      });
    });

  const unitsList = Object.entries(unitsById).map(([id, val]) => ({ id, ...val }));
  unitsList.sort((a, b) => Number(a.unit_number) - Number(b.unit_number));

  if (unitsList.length === 0) {
    unitsEmpty.classList.remove('hidden');
    unitsGrid.innerHTML = '';
    return;
  }
  unitsEmpty.classList.add('hidden');

  unitsGrid.innerHTML = unitsList.map((u) => {
    const dotColor = u.drivers.length === 1 ? routeColor(u.drivers[0].route) : 'var(--ink-soft)';
    return `
      <button class="unit-btn" data-unit-id="${u.id}">
        <span class="unit-number">${u.unit_number}</span>
        <span class="unit-dot" style="background:${dotColor};"></span>
        ${u.drivers.length > 1 ? `<span class="text-[10px] font-display font-semibold" style="color:var(--ink-soft);">${u.drivers.length} choferes</span>` : ''}
        ${u.drivers.length === 0 ? `<span class="text-[10px] font-display font-semibold" style="color:var(--ink-faint);">Sin conductor</span>` : ''}
      </button>
    `;
  }).join('');

  attachUnitButtonHandlers();
  if (window.lucide) lucide.createIcons();
}

// ----- REALTIME: refrescar la cuadrícula si cambian conductores/ramales/unidades -----
function initRealtime() {
  driversChannel = supabase
    .channel('checador-drivers-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' }, () => loadUnits())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'units' }, () => loadUnits())
    .subscribe();
}

// ----- TOCAR UNA UNIDAD -> ABRIR LISTA DE CONDUCTORES -----
function attachUnitButtonHandlers() {
  document.querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openUnitDriversOverlay(btn.dataset.unitId));
  });
}

function openUnitDriversOverlay(unitId) {
  const unit = unitsById[unitId];
  if (!unit) return;

  unitDriversTitle.innerHTML = `<i data-lucide="users"></i> Unidad ${unit.unit_number}`;

  if (unit.drivers.length === 0) {
    unitDriversList.innerHTML = `<p class="text-sm text-center py-2" style="color:var(--ink-soft);">Esta unidad todavía no tiene conductor asignado.</p>`;
    unitDriversOverlay.classList.add('show');
    if (window.lucide) lucide.createIcons();
    return;
  }

  unitDriversList.innerHTML = unit.drivers.map((d, idx) => `
    <button class="driver-row" data-driver-idx="${idx}">
      <span class="min-w-0 flex-1 text-left">
        <span class="driver-name truncate block">${escapeAttr(d.driverName)}</span>
        ${d.driverPhone ? `<span class="text-[11px] font-mono block" style="color:var(--ink-soft);">${escapeAttr(d.driverPhone)}</span>` : ''}
      </span>
      ${d.route ? `<span class="route-badge shrink-0" style="background:color-mix(in srgb, ${routeColor(d.route)} 18%, var(--paper-2)); color:${routeColor(d.route)};">${routeLabel(d.route)}</span>` : ''}
    </button>
  `).join('');

  // Tocar el nombre del conductor abre directo la hoja de incidencia
  // (llegó tarde / no se presentó). Ya no hay registro de "pasó a tiempo".
  unitDriversList.querySelectorAll('.driver-row').forEach((row) => {
    const driverData = unit.drivers[Number(row.dataset.driverIdx)];
    row.addEventListener('click', () => {
      if (navigator.vibrate) navigator.vibrate(15);
      closeUnitDriversOverlay();
      openIncidentOverlay(driverData);
    });
  });

  unitDriversOverlay.classList.add('show');
  if (window.lucide) lucide.createIcons();
}

function closeUnitDriversOverlay() {
  unitDriversOverlay.classList.remove('show');
}

on(unitDriversCancelBtn, 'click', closeUnitDriversOverlay);
on(unitDriversOverlay, 'click', (e) => {
  if (e.target.id === 'unitDriversOverlay') closeUnitDriversOverlay();
});

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// ----- REGISTRAR CHECADA -----
async function registerCheckpoint(driverData, status) {
  if (navigator.vibrate) navigator.vibrate(20);

  const { driverId, unitId, driverName, route, ownerId, unitNumber } = driverData;

  const { error } = await supabase
    .from('checador_events')
    .insert({
      checador_id: currentChecador.id,
      driver_id: driverId,
      unit_id: unitId,
      owner_id: ownerId,
      route: route || null,
      status,
    });

  if (error) {
    console.error('Error guardando checador_events:', error);
    showToast(`No se pudo registrar la incidencia de la unidad ${unitNumber}. Intenta de nuevo.`, 'error');
    return;
  }

  const time = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

  if (status === 'retraso') {
    showToast(`Unidad ${unitNumber} — ${driverName} — Llegó tarde — ${time}`, 'warn');
  } else if (status === 'no_se_presento') {
    showToast(`Unidad ${unitNumber} — ${driverName} — No se presentó — ${time}`, 'warn');
  }
}

// ----- TARJETA DE CONFIRMACIÓN (toast) -----
function showToast(message, kind) {
  clearTimeout(toastTimer);
  toastText.textContent = message;
  toast.classList.remove('ok', 'warn', 'error');
  toast.classList.add(kind);
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

// ----- INCIDENCIAS (long-press sobre el nombre del conductor) -----
function openIncidentOverlay(driverData) {
  pendingIncidentDriver = driverData;
  incidentUnitLabel.textContent = `Unidad ${driverData.unitNumber} — ${driverData.driverName}`;
  incidentOverlay.classList.add('show');
}

function closeIncidentOverlay() {
  incidentOverlay.classList.remove('show');
  pendingIncidentDriver = null;
}

on(incidentCancelBtn, 'click', closeIncidentOverlay);
on(incidentOverlay, 'click', (e) => {
  if (e.target.id === 'incidentOverlay') closeIncidentOverlay();
});
on(incidentTardeBtn, 'click', () => {
  const driverData = pendingIncidentDriver;
  closeIncidentOverlay();
  if (driverData) registerCheckpoint(driverData, 'retraso');
});
on(incidentNoPresentoBtn, 'click', () => {
  const driverData = pendingIncidentDriver;
  closeIncidentOverlay();
  if (driverData) registerCheckpoint(driverData, 'no_se_presento');
});

// ============================================================
// PANEL AMPLIADO — mapa, conductores (turno/reposo/vueltas) y
// alertas, con el mismo alcance que ve el dueño (todas las
// unidades/dueños). Pensado para usarse también desde una PC de
// escritorio con el mapa en grande.
// ============================================================

// ----- MAPA (Leaflet) -----
function initMap() {
  if (mapInitialized) return;
  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([19.272, -98.455], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  L.control.attribution({ prefix: false })
    .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
    .addTo(map);
  mapInitialized = true;
}

function driverIcon(route) {
  const color = route === 'secundaria' ? '#2FD98A' : (route === 'capilla' ? '#FFAE33' : '#3FB0F0');
  return L.divIcon({
    className: '',
    html: `<div style="width:34px;height:34px;border-radius:50%;background:${color};border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 10px rgba(0,0,0,.45);">🚐</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function goToDriverOnMap(driverId) {
  const marker = driverMarkers[driverId];
  if (!map || !marker) return;
  map._rssCentered = true;
  map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.75 });
  marker.openPopup();
  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ----- TURNO / REPOSO (lo reporta el propio conductor desde su panel) -----
function turnoReposoInfo(d) {
  const restingUntil = d.resting_until ? new Date(d.resting_until) : null;
  const resting = !!(restingUntil && restingUntil.getTime() > Date.now());
  return { onShift: !!d.on_shift, resting, restingUntil };
}

function turnoReposoBadgeHtml(d) {
  const { onShift, resting, restingUntil } = turnoReposoInfo(d);
  if (resting) {
    const mins = Math.max(0, Math.ceil((restingUntil.getTime() - Date.now()) / 60000));
    return `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1" style="background:color-mix(in srgb, var(--cempasuchil) 20%, var(--surface)); color:var(--cempasuchil);"><i data-lucide="coffee" class="w-3 h-3"></i> Reposo · ${mins} min</span>`;
  }
  if (onShift) {
    return `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1" style="background:color-mix(in srgb, var(--agave) 20%, var(--surface)); color:var(--agave);"><i data-lucide="play-circle" class="w-3 h-3"></i> En turno</span>`;
  }
  return `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1" style="background:var(--surface-2); color:var(--ink-faint);"><i data-lucide="pause-circle" class="w-3 h-3"></i> Fuera de turno</span>`;
}

// ----- VUELTAS DEL DÍA (las asigna el checador aquí mismo) -----
async function loadVueltasToday() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('driver_vueltas')
    .select('driver_id, vueltas')
    .eq('date', today);

  if (error) { console.error('Error cargando vueltas del día:', error); return; }

  lastVueltas = {};
  (data || []).forEach((v) => { lastVueltas[v.driver_id] = v.vueltas; });
}

async function setVueltas(driverId, newValue) {
  const value = Math.max(0, newValue);
  const today = new Date().toISOString().slice(0, 10);

  const { error } = await supabase
    .from('driver_vueltas')
    .upsert({
      driver_id: driverId,
      date: today,
      vueltas: value,
      updated_by: currentChecador ? currentChecador.id : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'driver_id,date' });

  if (error) {
    console.error('Error guardando vueltas:', error);
    showToast('No se pudo guardar la vuelta. Intenta de nuevo.', 'error');
    return;
  }

  lastVueltas[driverId] = value;
  renderDriversList();
}

function vueltasStepperHtml(driverId) {
  const n = lastVueltas[driverId] ?? 0;
  return `
    <span class="vueltas-stepper" data-driver-id="${driverId}">
      <button type="button" class="vueltas-minus" aria-label="Quitar una vuelta"><i data-lucide="minus" class="w-3 h-3"></i></button>
      <span class="vueltas-count">${n}</span>
      <button type="button" class="vueltas-plus" aria-label="Agregar una vuelta"><i data-lucide="plus" class="w-3 h-3"></i></button>
    </span>
  `;
}

// ----- REALTIME DEL PANEL AMPLIADO -----
function initFleetRealtimeListeners() {
  locationChannel = supabase
    .channel('checador-locations-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_locations' }, () => renderDriversAndMap())
    .subscribe((status, err) => console.log('[Realtime] live_locations:', status, err || ''));

  routeChannel = supabase
    .channel('checador-route-events-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'route_events' }, () => renderRouteEvents())
    .subscribe((status, err) => console.log('[Realtime] route_events:', status, err || ''));

  alertChannel = supabase
    .channel('checador-alerts-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'panic_alerts' }, () => renderAlerts())
    .subscribe((status, err) => console.log('[Realtime] panic_alerts:', status, err || ''));

  driversStatusChannel = supabase
    .channel('checador-drivers-status-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' }, () => renderDriversAndMap())
    .subscribe((status, err) => console.log('[Realtime] drivers (turno/reposo):', status, err || ''));

  vueltasChannel = supabase
    .channel('checador-driver-vueltas-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_vueltas' }, () => {
      loadVueltasToday().then(renderDriversList);
    })
    .subscribe((status, err) => console.log('[Realtime] driver_vueltas:', status, err || ''));

  renderDriversAndMap();
  renderRouteEvents();
  renderAlerts();
}

setInterval(() => { if (currentChecador) renderDriversList(); }, 30000);

// ----- CONDUCTORES Y MAPA (todas las unidades, de todos los dueños) -----
async function renderDriversAndMap() {
  if (!currentChecador) return;

  const { data: drivers, error } = await supabase
    .from('drivers')
    .select(`
      *,
      unit:unit_id ( unit_number ),
      live_location:live_locations ( lat, lng, heading, speed, updated_at )
    `);

  if (error) { console.error('Error al cargar conductores:', error); return; }

  lastDrivers = drivers || [];
  await loadVueltasToday();
  renderDriversList();
}

function renderDriversList() {
  const list = document.getElementById('driversList');
  const emptyMsg = document.getElementById('driversEmpty');
  if (!list) return;
  list.innerHTML = '';

  let onlineCount = 0;
  let restingCount = 0;
  let vueltasTotal = 0;

  lastDrivers.forEach((d) => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    const fresh = location && location.updated_at && (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);
    if (fresh) onlineCount++;
    if (turnoReposoInfo(d).resting) restingCount++;
    vueltasTotal += (lastVueltas[d.id] ?? 0);
  });

  const driversOnlineCount = document.getElementById('driversOnlineCount');
  if (driversOnlineCount) driversOnlineCount.textContent = `${onlineCount} en ruta de ${lastDrivers.length}`;

  const kpiOnRoute = document.getElementById('kpiOnRoute');
  if (kpiOnRoute) kpiOnRoute.textContent = `${onlineCount}/${lastDrivers.length}`;
  const kpiReposo = document.getElementById('kpiReposo');
  if (kpiReposo) kpiReposo.textContent = String(restingCount);
  const kpiVueltas = document.getElementById('kpiVueltas');
  if (kpiVueltas) kpiVueltas.textContent = String(vueltasTotal);

  if (lastDrivers.length === 0) {
    if (emptyMsg) emptyMsg.classList.remove('hidden');
  } else if (emptyMsg) {
    emptyMsg.classList.add('hidden');
  }

  lastDrivers.forEach((d) => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    const fresh = location && location.updated_at && (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);
    const rLabel = routeLabel(d.route);
    const rColor = routeColor(d.route);

    let locText = 'Sin conexión';
    if (fresh) {
      locText = `📍 ${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} · ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
    } else if (location && location.updated_at) {
      locText = `Última vez: ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
    }

    const row = document.createElement('div');
    row.className = 'fleet-row py-3 flex items-center justify-between gap-1.5 sm:gap-2';
    row.dataset.driverId = d.id;

    row.innerHTML = `
      <div class="min-w-0 flex items-center gap-2 sm:gap-2.5 flex-1 cursor-pointer">
        <span class="w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center shrink-0 font-display font-bold text-sm" style="background:color-mix(in srgb, var(--talavera) 16%, var(--surface)); color:var(--talavera);">${(d.name || '?').trim().charAt(0).toUpperCase()}</span>
        <div class="min-w-0">
          <p class="font-display font-semibold text-sm truncate">${d.name} <span class="text-[10px] font-mono" style="color:var(--ink-soft);">(U.${d.unit?.unit_number || '?'})</span></p>
          ${d.phone ? `<a href="tel:${phoneHref(d.phone)}" class="text-[10px] sm:text-[11px] font-mono truncate flex items-center gap-1" style="color:var(--talavera);" onclick="event.stopPropagation()"><i data-lucide="phone" class="w-3 h-3"></i> ${escapeAttr(d.phone)}</a>` : ''}
          <p class="text-[10px] sm:text-[11px] font-mono truncate" style="color:var(--ink-soft);">${locText}</p>
          <div class="flex flex-wrap items-center gap-1 mt-1">
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full inline-block" style="background:${rColor}; color:#08131c;">${rLabel}</span>
            ${turnoReposoBadgeHtml(d)}
          </div>
        </div>
      </div>
      <span class="flex flex-col items-end gap-1.5 shrink-0">
        <span class="flex items-center gap-1.5 text-xs font-semibold"><span class="status-dot ${fresh ? 'on' : 'off'}"></span> <button class="driver-map-btn btn-lift w-7 h-7 rounded-full flex items-center justify-center shrink-0" style="background:var(--surface-2); border:1px solid var(--border); color:var(--talavera);" title="Ver en el mapa"><i data-lucide="map-pin" class="w-3.5 h-3.5"></i></button></span>
        ${vueltasStepperHtml(d.id)}
      </span>
    `;

    row.querySelector('.min-w-0.flex').addEventListener('click', () => openDriverDrawer(d.id));

    const mapBtn = row.querySelector('.driver-map-btn');
    mapBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (fresh) goToDriverOnMap(d.id);
      else showToast(`${d.name}: sin ubicación disponible.`, 'warn');
    });

    const minusBtn = row.querySelector('.vueltas-minus');
    const plusBtn = row.querySelector('.vueltas-plus');
    minusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (navigator.vibrate) navigator.vibrate(15);
      setVueltas(d.id, (lastVueltas[d.id] ?? 0) - 1);
    });
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (navigator.vibrate) navigator.vibrate(15);
      setVueltas(d.id, (lastVueltas[d.id] ?? 0) + 1);
    });

    list.appendChild(row);

    if (fresh && location && location.lat && location.lng && map) {
      const latlng = [location.lat, location.lng];
      if (!driverMarkers[d.id]) {
        driverMarkers[d.id] = L.marker(latlng, { icon: driverIcon(d.route) }).addTo(map).bindPopup(`${d.name} · ${rLabel}`);
      } else {
        driverMarkers[d.id].setLatLng(latlng);
        driverMarkers[d.id].setPopupContent(`${d.name} · ${rLabel}`);
      }
    } else if (driverMarkers[d.id] && map) {
      map.removeLayer(driverMarkers[d.id]);
      delete driverMarkers[d.id];
    }
  });

  if (map) {
    const activeMarkers = Object.values(driverMarkers);
    if (activeMarkers.length > 0 && !map._rssCentered) {
      const group = L.featureGroup(activeMarkers);
      map.fitBounds(group.getBounds().pad(0.2));
      map._rssCentered = true;
    }
  }

  if (window.lucide) lucide.createIcons();
}

// ----- DRAWER: FICHA RÁPIDA DEL CONDUCTOR -----
const driverDrawer = document.getElementById('driverDrawer');
const driverDrawerOverlay = document.getElementById('driverDrawerOverlay');
const driverDrawerContent = document.getElementById('driverDrawerContent');

// Helper para el href de un teléfono (solo dígitos y "+")
function phoneHref(phone) {
  return String(phone).replace(/[^\d+]/g, '');
}

function openDriverDrawer(driverId) {
  const d = lastDrivers.find((x) => x.id === driverId);
  if (!d || !driverDrawerContent) return;

  const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
  const fresh = location && location.updated_at && (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);
  const ownEvents = lastRouteEvents.filter((ev) => ev.driver_id === d.id);

  const ownEventsHtml = ownEvents.length
    ? ownEvents.map((ev) => {
        const time = ev.created_at ? new Date(ev.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
        const routeTxt = ev.route === 'capilla' ? 'Por Capilla' : (ev.route === 'secundaria' ? 'Por Secundaria' : '');
        return `
          <div class="flex items-center gap-2.5 py-1.5">
            <span class="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, var(--talavera) 16%, var(--surface)); color:var(--talavera);"><i data-lucide="flag" class="w-3.5 h-3.5"></i></span>
            <p class="text-xs" style="color:var(--ink-soft);"><span class="font-semibold" style="color:var(--talavera);">${ev.label || 'Aviso'}</span> · ${time}${routeTxt ? ' · ' + routeTxt : ''}</p>
          </div>`;
      }).join('')
    : `<p class="text-xs" style="color:var(--ink-faint);">Este conductor todavía no ha reportado ninguna parada.</p>`;

  let locText = 'Sin conexión';
  if (fresh) {
    locText = `📍 ${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} · ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
  } else if (location && location.updated_at) {
    locText = `Última vez: ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
  }

  driverDrawerContent.innerHTML = `
    <div class="flex items-center gap-3">
      <span class="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 font-display font-bold text-lg" style="background:color-mix(in srgb, var(--talavera) 16%, var(--surface)); color:var(--talavera);">${(d.name || '?').trim().charAt(0).toUpperCase()}</span>
      <div class="min-w-0">
        <p class="font-display font-semibold text-base truncate">${d.name}</p>
        <p class="text-xs font-mono" style="color:var(--ink-soft);">Unidad ${d.unit?.unit_number || '?'}</p>
        ${d.phone ? `<a href="tel:${phoneHref(d.phone)}" class="text-xs font-mono flex items-center gap-1" style="color:var(--talavera);"><i data-lucide="phone" class="w-3.5 h-3.5"></i> ${escapeAttr(d.phone)}</a>` : ''}
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-[11px] font-semibold px-2.5 py-1 rounded-full" style="background:${routeColor(d.route)}; color:#08131c;">${routeLabel(d.route)}</span>
      <span class="flex items-center gap-1.5 text-xs font-semibold" style="color:var(--ink-soft);"><span class="status-dot ${fresh ? 'on' : 'off'}"></span> ${fresh ? 'En ruta' : 'Sin conexión'}</span>
    </div>

    <div class="flex flex-wrap items-center gap-1.5">
      ${turnoReposoBadgeHtml(d)}
    </div>

    <div class="card-soft p-3">
      <p class="text-[10px] font-mono uppercase tracking-wide mb-1" style="color:var(--ink-faint);">Última ubicación</p>
      <p class="text-xs font-mono" style="color:var(--ink-soft);">${locText}</p>
    </div>

    <div>
      <p class="text-[10px] font-mono uppercase tracking-wide mb-1.5" style="color:var(--ink-faint);">Vueltas de hoy</p>
      <div class="card-soft p-3 flex items-center justify-between">
        ${vueltasStepperHtml(d.id)}
      </div>
    </div>

    <div>
      <p class="text-[10px] font-mono uppercase tracking-wide mb-1.5" style="color:var(--ink-faint);">Registros propios del conductor</p>
      <div class="card-soft p-3">${ownEventsHtml}</div>
    </div>

    <div class="flex gap-2 pt-1">
      <button id="drawerGoToMap" class="btn-lift flex-1 text-xs font-semibold px-3.5 py-2.5 rounded-full flex items-center justify-center gap-1.5" style="background:var(--talavera); color:#08131c;" ${fresh ? '' : 'disabled'}>
        <i data-lucide="map-pin" class="w-3.5 h-3.5"></i> Ver en el mapa
      </button>
    </div>
    ${!fresh ? `<p class="text-[11px] text-center" style="color:var(--ink-faint);">Este conductor no tiene ubicación en vivo disponible.</p>` : ''}
  `;

  const stepper = driverDrawerContent.querySelector('.vueltas-stepper');
  if (stepper) {
    stepper.querySelector('.vueltas-minus').addEventListener('click', () => setVueltas(d.id, (lastVueltas[d.id] ?? 0) - 1).then(() => openDriverDrawer(d.id)));
    stepper.querySelector('.vueltas-plus').addEventListener('click', () => setVueltas(d.id, (lastVueltas[d.id] ?? 0) + 1).then(() => openDriverDrawer(d.id)));
  }

  const goBtn = document.getElementById('drawerGoToMap');
  if (goBtn && fresh) {
    goBtn.addEventListener('click', () => { closeDriverDrawer(); goToDriverOnMap(d.id); });
  } else if (goBtn) {
    goBtn.style.opacity = '.5';
    goBtn.style.cursor = 'not-allowed';
  }

  driverDrawer.classList.remove('hidden');
  driverDrawerOverlay.classList.remove('hidden');
  void driverDrawer.offsetHeight;
  driverDrawer.classList.add('open');
  if (window.lucide) lucide.createIcons();
}

let drawerCloseTimeout = null;
function closeDriverDrawer() {
  if (!driverDrawer) return;
  driverDrawer.classList.remove('open');
  driverDrawerOverlay.classList.add('hidden');
  clearTimeout(drawerCloseTimeout);
  drawerCloseTimeout = setTimeout(() => driverDrawer.classList.add('hidden'), 300);
}
on(document.getElementById('driverDrawerClose'), 'click', closeDriverDrawer);
on(driverDrawerOverlay, 'click', closeDriverDrawer);

// ----- AVISOS DE RUTA (lo que reporta el propio conductor: salió/llegó) -----
async function renderRouteEvents() {
  if (!currentChecador) return;

  const { data: events, error } = await supabase
    .from('route_events')
    .select('*, driver:driver_id ( name )')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) { console.error('Error cargando route_events:', error); return; }

  lastRouteEvents = events || [];
  const list = document.getElementById('routeEventsList');
  if (!list) return;

  if (!events || events.length === 0) {
    list.innerHTML = `<p id="routeEventsEmpty" class="text-sm text-center" style="color:var(--ink-soft);">Todavía no hay avisos de los conductores hoy.</p>`;
    return;
  }

  list.innerHTML = events.map((ev) => `
    <div class="flex items-center gap-2.5">
      <span class="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, var(--agave) 16%, var(--surface)); color:var(--agave);"><i data-lucide="flag" class="w-4 h-4"></i></span>
      <div class="min-w-0">
        <p class="font-display font-semibold text-sm truncate">${ev.driver?.name || 'Conductor'} — ${ev.label || 'Aviso'}</p>
        <p class="text-[11px] font-mono truncate" style="color:var(--ink-soft);">${ev.created_at ? new Date(ev.created_at).toLocaleTimeString('es-MX') : '—'}${ev.route ? ' · ' + (ev.route === 'capilla' ? 'Por Capilla' : 'Por Secundaria') : ''}</p>
      </div>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

// ----- ALERTAS DE AYUDA -----
async function renderAlerts() {
  if (!currentChecador) return;

  const { data: alerts, error } = await supabase
    .from('panic_alerts')
    .select('*, driver:driver_id ( name )')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) { console.error('Error cargando panic_alerts:', error); return; }

  const list = document.getElementById('alertsList');
  const empty = document.getElementById('alertsEmpty');
  if (!list || !empty) return;

  if (!alerts || alerts.length === 0) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    const alarmBar = document.getElementById('alarmBar');
    if (alarmBar) alarmBar.classList.remove('show');
    const kpiAlerts = document.getElementById('kpiAlerts');
    if (kpiAlerts) kpiAlerts.textContent = '0';
    return;
  }
  empty.classList.add('hidden');

  const pendingCount = alerts.filter((a) => a.status === 'pendiente').length;
  const kpiAlerts = document.getElementById('kpiAlerts');
  if (kpiAlerts) kpiAlerts.textContent = String(pendingCount);

  const alarmBar = document.getElementById('alarmBar');
  if (alarmBar) alarmBar.classList.toggle('show', pendingCount > 0);

  list.innerHTML = alerts.map((a) => {
    const isPending = a.status === 'pendiente';
    const mapsUrl = (a.lat != null && a.lng != null) ? `https://www.google.com/maps?q=${a.lat},${a.lng}` : null;
    return `
      <div class="alert-card p-4 ${isPending ? '' : 'resolved'}">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="font-display font-semibold text-sm flex items-center gap-1.5" style="color:${isPending ? 'var(--alerta)' : 'var(--ink-soft)'};">
              <i data-lucide="${isPending ? 'siren' : 'check-circle-2'}" class="w-4 h-4"></i> ${isPending ? 'Alerta activa' : 'Atendida'} · ${a.driver?.name || 'Conductor'}
            </p>
            <p class="text-xs font-mono mt-0.5" style="color:var(--ink-soft);">${a.created_at ? new Date(a.created_at).toLocaleString('es-MX') : '—'}</p>
          </div>
        </div>
        <div class="flex gap-2 mt-3.5">
          ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-lift text-xs font-semibold px-3.5 py-2 rounded-full flex items-center gap-1.5" style="background:var(--talavera); color:#08131c;"><i data-lucide="map-pin" class="w-3.5 h-3.5"></i> Ver ubicación</a>` : `<span class="text-xs" style="color:var(--ink-soft);">Sin ubicación</span>`}
          ${isPending ? `<button class="resolve-btn btn-lift text-xs font-semibold px-3.5 py-2 rounded-full" style="background:var(--agave); color:#08131c;" data-id="${a.id}">Marcar atendida</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.resolve-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const { error } = await supabase.from('panic_alerts').update({ status: 'atendida' }).eq('id', btn.dataset.id);
      if (error) {
        console.error('Error al marcar alerta como atendida:', error);
        btn.disabled = false;
      } else {
        renderAlerts();
      }
    });
  });
  if (window.lucide) lucide.createIcons();
}

on(document.getElementById('silenceBtn'), 'click', () => {
  const alarmBar = document.getElementById('alarmBar');
  if (alarmBar) alarmBar.classList.remove('show');
});

// ----- MENÚ MÓVIL (hamburguesa) -----
const mobileNavOpenBtn = document.getElementById('mobileNavOpen');
const mobileNavCloseBtn = document.getElementById('mobileNavClose');
const mobileNavOverlay = document.getElementById('mobileNavOverlay');
const mobileNavPanel = document.getElementById('mobileNavPanel');

function openMobileNav() {
  if (!mobileNavOverlay || !mobileNavPanel) return;
  mobileNavOverlay.classList.remove('hidden');
  mobileNavPanel.classList.remove('hidden');
  void mobileNavPanel.offsetHeight;
  mobileNavPanel.classList.add('open');
}

let mobileNavCloseTimeout = null;
function closeMobileNav() {
  if (!mobileNavOverlay || !mobileNavPanel) return;
  mobileNavPanel.classList.remove('open');
  mobileNavOverlay.classList.add('hidden');
  clearTimeout(mobileNavCloseTimeout);
  mobileNavCloseTimeout = setTimeout(() => mobileNavPanel.classList.add('hidden'), 300);
}

on(mobileNavOpenBtn, 'click', openMobileNav);
on(mobileNavCloseBtn, 'click', closeMobileNav);
on(mobileNavOverlay, 'click', closeMobileNav);
document.querySelectorAll('#mobileNavPanel a.mobile-nav-item').forEach((a) => {
  a.addEventListener('click', closeMobileNav);
});

// ----- NAVEGACIÓN: marcar el enlace activo según la sección visible -----
const navLinks = Array.from(document.querySelectorAll('aside .nav-item, #mobileNavPanel .mobile-nav-item'))
  .filter((a) => a.getAttribute('href').startsWith('#'));
if (navLinks.length) {
  const sectionIds = [...new Set(navLinks.map((a) => a.getAttribute('href').slice(1)))];
  const sections = sectionIds.map((id) => document.getElementById(id)).filter(Boolean);

  const navObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

  sections.forEach((sec) => navObserver.observe(sec));
}

// ----- VUELTAS DEL DÍA -> PDF DESCARGABLE -----
on(sendSummaryBtn, 'click', downloadDaySummaryPdf);

// Espera hasta `timeoutMs` a que window.jspdf esté disponible, revisando cada 250ms.
// Sirve para cuando el CDN tarda en responder por mala señal, en vez de fallar
// de inmediato en el primer intento.
function waitForJsPdf(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (window.jspdf && window.jspdf.jsPDF) return resolve(true);
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (window.jspdf && window.jspdf.jsPDF) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 250);
  });
}

async function downloadDaySummaryPdf() {
  if (!currentChecador) return;

  if (!window.jspdf || !window.jspdf.jsPDF) {
    // No está listo todavía: puede que el CDN siga cargando por señal lenta.
    // Le damos unos segundos antes de darnos por vencidos.
    showToast('Preparando el generador de PDF…', 'warn');
    const ready = await waitForJsPdf();
    if (!ready) {
      showToast('No se pudo cargar el generador de PDF. Revisa tu conexión e intenta de nuevo.', 'error');
      return;
    }
  }

  sendSummaryBtn.disabled = true;
  const originalHtml = sendSummaryBtn.innerHTML;
  sendSummaryBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4"></i> Armando PDF…';
  if (window.lucide) lucide.createIcons();

  const now = new Date();
  const todayLabel = now.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const todayFile = now.toISOString().slice(0, 10); // YYYY-MM-DD

  // ----- VUELTAS POR CONDUCTOR (asignadas por el checador, hoy) — lo único que va en el PDF -----
  const { data: vueltasRows, error: vueltasError } = await supabase
    .from('driver_vueltas')
    .select('vueltas, driver:driver_id ( name, unit:unit_id ( unit_number ) )')
    .eq('date', todayFile)
    .order('vueltas', { ascending: false });

  sendSummaryBtn.disabled = false;
  sendSummaryBtn.innerHTML = originalHtml;
  if (window.lucide) lucide.createIcons();

  if (vueltasError) {
    console.error('Error cargando vueltas para el PDF:', vueltasError);
    showToast('No se pudo armar el resumen. Intenta de nuevo.', 'error');
    return;
  }

  if (!vueltasRows || vueltasRows.length === 0) {
    showToast('Todavía no hay vueltas registradas hoy para descargar.', 'warn');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(14, 128, 190); // azul talavera
  doc.text('Vueltas del día · Ruta San Simón (R-18)', 14, 18);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90, 82, 68);
  doc.text(`Checador: ${currentChecador.name}`, 14, 26);
  doc.text(`Fecha: ${todayLabel}`, 14, 32);

  const vueltasBody = vueltasRows.map((v) => [
    v.driver?.unit?.unit_number != null ? `Unidad ${v.driver.unit.unit_number}` : 'Unidad —',
    v.driver?.name || 'Conductor',
    String(v.vueltas ?? 0),
  ]);
  const vueltasTotal = vueltasRows.reduce((sum, v) => sum + (v.vueltas || 0), 0);

  doc.autoTable({
    head: [['Unidad', 'Conductor', 'Vueltas']],
    body: vueltasBody,
    startY: 38,
    styles: { font: 'helvetica', fontSize: 10, cellPadding: 3 },
    headStyles: { fillColor: [30, 158, 90], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [244, 238, 220] },
    columnStyles: { 2: { halign: 'center', fontStyle: 'bold' } },
  });

  const finalY = doc.lastAutoTable.finalY || 38;
  doc.setFontSize(10);
  doc.setTextColor(90, 82, 68);
  doc.text(`Total de vueltas hoy (todos los conductores): ${vueltasTotal}`, 14, finalY + 8);

  doc.save(`vueltas-checador-${todayFile}.pdf`);
}

// ----- INTENTAR ENTRAR DIRECTO SI YA HABÍA SESIÓN GUARDADA DE HOY -----
tryAutoLogin();
