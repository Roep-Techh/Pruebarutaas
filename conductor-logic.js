import { supabase } from './supabase-config.js';
import { initPushNotifications } from './push-notifications.js';
import { initTarjetaConductor } from './tarjeta-conductor.js';

// Capacitor se inyecta como objeto global (window.Capacitor) dentro de la app nativa.
// Los plugins ya sincronizados quedan disponibles en window.Capacitor.Plugins — no
// se usa "import" de npm porque este proyecto no usa bundler.
const Capacitor = window.Capacitor || { isNativePlatform: () => false, Plugins: {} };
const BackgroundGeolocation = Capacitor.Plugins ? Capacitor.Plugins.BackgroundGeolocation : null;

// Elementos DOM
const pinScreen = document.getElementById('pinScreen');
const mainScreen = document.getElementById('mainScreen');
const pinInput = document.getElementById('pinInput');
const pinError = document.getElementById('pinError');
const checkpointBtn = document.getElementById('checkpointBtn');
const checkpointSavedText = document.getElementById('checkpointSavedText');
const toggleBtn = document.getElementById('toggleBtn');
const toggleLabel = document.getElementById('toggleLabel');
const statusText = document.getElementById('statusText');
const coordsText = document.getElementById('coordsText');
const updatedText = document.getElementById('updatedText');
const panicBtn = document.getElementById('panicBtn');
const panicOverlay = document.getElementById('panicOverlay');
const headerDriverName = document.getElementById('headerDriverName');
const headerDriverSub = document.getElementById('headerDriverSub');
const headerShiftDot = document.getElementById('headerShiftDot');
const nameDisplayRow = document.getElementById('nameDisplayRow');
const checkpointBtnLabel = document.getElementById('checkpointBtnLabel');
const turnoBtn = document.getElementById('turnoBtn');
const turnoReposoStatus = document.getElementById('turnoReposoStatus');
const reposoBtn = document.getElementById('reposoBtn');
const unitPickerOverlay = document.getElementById('unitPickerOverlay');
const unitPickerGrid = document.getElementById('unitPickerGrid');
const unitPickerEmpty = document.getElementById('unitPickerEmpty');
const unitPickerSkipBtn = document.getElementById('unitPickerSkipBtn');

let currentDriver = null;
let watchId = null; // se sigue usando como "bandera" de que hay tracking activo en modo navegador
let pollIntervalId = null;
let locationChannel = null;
let eventChannel = null;

// ============================================================
// ENVÍO CONFIABLE — timeout + reintentos + cola local.
// Problema que resuelve: con señal mala, las llamadas a Supabase se
// podían quedar esperando sin límite (botones "trabados"), y si de
// plano fallaban, el aviso/ubicación se perdía sin más. Con esto:
//   1) Ninguna llamada espera más de REQUEST_TIMEOUT_MS.
//   2) Si falla (por señal o lo que sea), se guarda en localStorage
//      y se reintenta solo — cuando regrese la conexión ('online') o
//      cada FLUSH_INTERVAL_MS mientras haya pendientes.
//   3) Nada se pierde silenciosamente: el chip de "Sin señal" en el
//      header muestra cuántos reportes están esperando.
// ============================================================
const RETRY_QUEUE_KEY = 'rss_pending_queue';
const REQUEST_TIMEOUT_MS = 10000;
const FLUSH_INTERVAL_MS = 15000;

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout: sin respuesta del servidor')), ms)),
  ]);
}

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(RETRY_QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function saveQueue(queue) {
  localStorage.setItem(RETRY_QUEUE_KEY, JSON.stringify(queue));
  renderSyncIndicator();
}

// Cada tipo de operación sabe reconstruir su propia llamada a Supabase,
// así se puede reintentar después aunque haya pasado tiempo o se haya
// recargado la página.
function runOp(op) {
  switch (op.type) {
    case 'live_location':
      return supabase.from('live_locations').upsert(op.payload, { onConflict: 'driver_id' });
    case 'live_location_off':
      return supabase.from('live_locations').update({ updated_at: null }).eq('driver_id', op.driverId);
    case 'route_event':
      return supabase.from('route_events').upsert(op.payload, { onConflict: 'driver_id' });
    case 'panic_alert':
      return supabase.from('panic_alerts').insert(op.payload);
    case 'driver_update':
      return supabase.from('drivers').update(op.payload).eq('id', op.driverId);
    default:
      return Promise.resolve({ error: new Error('tipo de operación desconocido: ' + op.type) });
  }
}

// Intenta mandar algo YA. Si falla por red/timeout lo deja en la cola
// para reintentarlo solo y regresa queued:true — quien llamó puede
// decidir si avisa "pendiente" o simplemente sigue adelante.
//
// IMPORTANTE: cada op lleva una "key" (ej. "route_event:driverId").
// Antes de mandar o encolar, se quita de la cola cualquier op VIEJO
// con la misma key. Así, si un reintento atrasado de "Salió de San
// Simón" sigue esperando turno cuando ya diste "Llegué a San Martín",
// el reintento viejo se cancela solo en vez de sobrescribir el dato
// más nuevo cuando por fin le toque su turno.
function opKey(op) {
  return op.key || `${op.type}:${op.driverId || op.payload?.driver_id || ''}`;
}

// Intenta mandar algo YA. Si falla por red/timeout lo deja en la cola
// para reintentarlo solo y regresa queued:true.
async function attemptOp(op) {
  // Limpia cualquier copia vieja en cola de esta misma acción (por si
  // quedó algo pendiente de antes).
  saveQueue(loadQueue().filter((q) => q.key !== op.key));

  try {
    const { error } = await withTimeout(runOp(op));
    if (!error) return { ok: true, queued: false };
    console.error(`Error enviando ${op.type}:`, error);
  } catch (e) {
    console.error(`Sin respuesta enviando ${op.type} (posible falta de señal):`, e.message || e);
  }

  const queue = loadQueue();
  queue.push({ ...op, ts: Date.now() });
  saveQueue(queue);
  scheduleFlush(op.type === 'panic_alert' ? 2000 : 4000); // el pánico se reintenta más rápido
  return { ok: false, queued: true };
}

// CANDADO POR "KEY": si mandas dos avisos del mismo conductor muy
// seguido (ej. dos checkpoints casi al mismo tiempo), NUNCA deben
// viajar juntos a la red — porque internet no garantiza que lleguen
// en el mismo orden en que los mandaste, y el que llegue AL FINAL es
// el que se queda guardado (se sobrescriben). Por eso cada key tiene
// su propia fila: la petición #2 espera a que la #1 termine (aunque
// tarde hasta el timeout) antes de siquiera salir a la red.
const pendingChains = {};

function withKeyLock(key, fn) {
  const prevChain = pendingChains[key] || Promise.resolve();
  const nextChain = prevChain.then(fn, fn);
  pendingChains[key] = nextChain.catch(() => {});
  return nextChain;
}

async function sendConfiable(op) {
  const key = opKey(op);
  op = { ...op, key };
  return withKeyLock(key, () => attemptOp(op));
}

let flushTimer = null;
let flushing = false;

function scheduleFlush(delayMs = FLUSH_INTERVAL_MS) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushQueue(); }, delayMs);
}

async function flushQueue() {
  if (flushing) return;
  const queue = loadQueue();
  if (!queue.length) { renderSyncIndicator(); return; }
  flushing = true;

  // También pasa por el mismo candado por key, para que un reintento
  // de la cola nunca se cruce en el aire con un tap nuevo del usuario
  // para esa misma acción.
  await Promise.all(queue.map((op) => withKeyLock(op.key, () => attemptOp(op))));
  flushing = false;

  const remaining = loadQueue();
  if (remaining.length) {
    const hasPanic = remaining.some((o) => o.type === 'panic_alert');
    scheduleFlush(hasPanic ? 3000 : FLUSH_INTERVAL_MS);
  }
}

window.addEventListener('online', () => flushQueue());
setInterval(() => { if (loadQueue().length) flushQueue(); }, FLUSH_INTERVAL_MS);

// ----- Chip de "Sin señal" en el header -----
function renderSyncIndicator() {
  const chip = document.getElementById('syncStatusChip');
  if (!chip) return;
  const pending = loadQueue().length;
  const offline = !navigator.onLine;

  if (!offline && pending === 0) {
    chip.classList.add('hidden');
    return;
  }
  chip.classList.remove('hidden');
  chip.textContent = pending > 0
    ? `Sin señal · ${pending} pendiente${pending === 1 ? '' : 's'}`
    : 'Sin señal';
}

window.addEventListener('online', renderSyncIndicator);
window.addEventListener('offline', renderSyncIndicator);


// Wake Lock: evita que la pantalla se apague sola mientras se comparte
// ubicación. En varios Android, si se apaga la pantalla el sistema es más
// agresivo pausando todo, así que esto ayuda bastante.
// El navegador libera el wake lock automáticamente al ocultar la pestaña,
// por eso lo volvemos a pedir en el listener de "visibilitychange" de abajo.
let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (e) {
    console.warn('No se pudo obtener wake lock:', e);
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch (e) {
      // no pasa nada si ya se había liberado solo
    }
    wakeLock = null;
  }
}

// Recuperación automática: cuando el chofer regresa a la pestaña (venía de
// otra app, o encendió la pantalla), si la ubicación sigue "encendida" del
// lado de la UI, reforzamos el wake lock por si el navegador lo soltó.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Capacitor.isNativePlatform()) return;
  if (!toggleBtn.classList.contains('on')) return;

  if (!wakeLock) requestWakeLock();
});

// ----- LOGIN CON PIN -----
document.getElementById('pinSubmit').addEventListener('click', tryPin);
pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPin(); });

async function tryPin() {
  const pin = pinInput.value.trim();
  if (!pin) return;

  const { data: driver, error } = await supabase
    .from('drivers')
    .select('*, unit:unit_id ( unit_number )')
    .eq('pin', pin)
    .single();

  if (driver && !error) {
    driver.unit_number = driver.unit ? driver.unit.unit_number : null;
    localStorage.setItem('rss_driver_id', driver.id);
    localStorage.setItem('rss_driver_session_date', todayKey());
    pinError.classList.add('hidden');
    pinInput.value = '';
    pinScreen.classList.add('hidden');
    await promptUnitForToday(driver);
    unlock(driver);
  } else {
    pinError.classList.remove('hidden');
  }
}

// ----- SESIÓN DEL DÍA (no volver a pedir PIN mientras sea el mismo día) -----
// Cada vez que el conductor cierra/reabre la app (o recarga la página), no
// tiene que volver a escribir su PIN — mientras siga siendo el mismo día.
// Al día siguiente, por seguridad, sí se le vuelve a pedir (por si cambió
// de chofer en esa unidad).
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

async function tryAutoLogin() {
  const savedId = localStorage.getItem('rss_driver_id');
  const savedDate = localStorage.getItem('rss_driver_session_date');
  if (!savedId || !savedDate || savedDate !== todayKey()) return;

  const { data: driver, error } = await supabase
    .from('drivers')
    .select('*, unit:unit_id ( unit_number )')
    .eq('id', savedId)
    .single();

  if (driver && !error) {
    driver.unit_number = driver.unit ? driver.unit.unit_number : null;
    // Ya contestó "en qué unidad andas hoy" cuando puso su PIN la primera
    // vez en el día, así que aquí no se lo volvemos a preguntar.
    unlock(driver);
  } else {
    // El id guardado ya no es válido (p.ej. lo borraron): limpiamos para
    // que la próxima vez sí pida PIN normal.
    localStorage.removeItem('rss_driver_id');
    localStorage.removeItem('rss_driver_session_date');
  }
}

// ----- ¿EN QUÉ UNIDAD ANDAS HOY? -----
// Se pregunta cada vez que el conductor entra con su PIN, para que el
// dueño y el checador siempre vean la unidad correcta ese día (útil
// cuando hay conductores de relevo que no siempre traen la misma combi).
// No bloquea al conductor si falla la carga o no hay unidades activas.
async function promptUnitForToday(driver) {
  return new Promise(async (resolve) => {
    let units = [];
    try {
      const { data, error } = await supabase
        .from('units')
        .select('id, unit_number')
        .neq('active', false)
        .order('unit_number', { ascending: true });
      if (error) throw error;
      units = data || [];
    } catch (e) {
      console.error('Error cargando unidades:', e);
      resolve();
      return;
    }

    if (units.length === 0) {
      resolve();
      return;
    }

    unitPickerEmpty.classList.add('hidden');
    unitPickerGrid.innerHTML = units.map((u) => `
      <button class="unit-pick-btn ${u.id === driver.unit_id ? 'current' : ''}" data-unit-id="${u.id}">
        <span>${u.unit_number}</span>
        ${u.id === driver.unit_id ? '<span class="unit-pick-tag">ACTUAL</span>' : ''}
      </button>
    `).join('');

    // Si ya trae una unidad asignada, le damos la opción de continuar
    // sin volver a tocar nada (por si solo quiere confirmar rápido).
    unitPickerSkipBtn.classList.toggle('hidden', !driver.unit_id);

    unitPickerOverlay.classList.add('show');
    if (window.lucide) lucide.createIcons();

    async function finish(unitId) {
      unitPickerOverlay.classList.remove('show');
      unitPickerGrid.querySelectorAll('.unit-pick-btn').forEach((b) => b.removeEventListener('click', onBtnClick));
      unitPickerSkipBtn.removeEventListener('click', onSkipClick);

      if (unitId && unitId !== driver.unit_id) {
        const { error: updErr } = await supabase.from('drivers').update({ unit_id: unitId }).eq('id', driver.id);
        if (!updErr) {
          driver.unit_id = unitId;
        } else {
          console.error('Error al guardar la unidad del día:', updErr);
        }
      }

      // Guardamos el número de unidad (no solo el id) para poder mostrarlo
      // en el encabezado sin tener que volver a consultar Supabase.
      const chosen = units.find((u) => u.id === driver.unit_id);
      driver.unit_number = chosen ? chosen.unit_number : null;

      resolve();
    }

    function onBtnClick(e) {
      if (navigator.vibrate) navigator.vibrate(15);
      finish(e.currentTarget.dataset.unitId);
    }
    function onSkipClick() {
      finish(driver.unit_id || null);
    }

    unitPickerGrid.querySelectorAll('.unit-pick-btn').forEach((b) => b.addEventListener('click', onBtnClick));
    unitPickerSkipBtn.addEventListener('click', onSkipClick);
  });
}

function unlock(driver) {
  currentDriver = driver;
  window.__rssWalkieName = driver.name || 'Conductor'; // usado por el botón de radio
  pinScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  setupDriverNameField();
  setupDriverRoute();
  setupCheckpointButton();
  setupTurnoState();
  setupReposoState();
  initTarjetaConductor(driver.id);
  if (window.lucide) lucide.createIcons();

  // Notificaciones push forzosas (solo cuando el panel corre como PWA
  // instalada desde Chrome; en la app nativa empacada con Capacitor esto
  // se maneja con el plugin de notificaciones nativo, no con Web Push).
  if (!Capacitor.isNativePlatform()) {
    initPushNotifications('conductor', driver.id, driver.name);
  }
}

// ----- CIERRE DE SESIÓN -----
function goToPinScreen() {
  if (watchId !== null) stopSharing();
  if (locationChannel) supabase.removeChannel(locationChannel);
  if (eventChannel) supabase.removeChannel(eventChannel);
  stopReposoCountdown();
  reposoUntil = null;
  localStorage.removeItem('rss_driver_id');
  localStorage.removeItem('rss_driver_session_date');
  currentDriver = null;
  mainScreen.classList.add('hidden');
  pinScreen.classList.remove('hidden');
  pinInput.value = '';
}

document.getElementById('backToPinBtn').addEventListener('click', goToPinScreen);

// ----- NOMBRE DEL CONDUCTOR -----
// Solo lectura: el conductor no puede editar su nombre desde este panel.
// Lo asigna el dueño o el checador.
function updateHeaderDriverName() {
  if (!headerDriverName) return;
  const shown = (currentDriver.name || '').trim();
  headerDriverName.textContent = shown || 'Panel del Conductor';

  if (headerDriverSub) {
    const unitTxt = currentDriver.unit_number != null ? `Unidad ${currentDriver.unit_number} · ` : '';
    headerDriverSub.textContent = `${unitTxt}R-18`;
    headerDriverSub.classList.remove('hidden');
  }
}

function setupDriverNameField() {
  updateHeaderDriverName();
}

// ----- RAMAL ASIGNADO -----
// A partir de ahora el ramal NO se hereda solo de ayer: cada día el chofer
// tiene que tocar "Por Capilla" o "Por Secundaria" aunque sea el mismo de
// ayer. Mientras no lo haga, el botón de checkpoint queda bloqueado, para
// que de una forma u otra quede puesto antes de reportar nada.
let currentDriverRoute = null;
const ramalLabel = document.getElementById('ramalLabel');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function ramalStorageKey() {
  return 'rss_driver_route_' + currentDriver.id;
}

function updateRamalButtons() {
  document.querySelectorAll('.ramal-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.route === currentDriverRoute);
    b.classList.toggle('needs-choice', !currentDriverRoute);
  });
  if (ramalLabel) {
    ramalLabel.textContent = currentDriverRoute ? 'Tu ramal hoy' : '⚠ Elige tu ramal de hoy';
    ramalLabel.classList.toggle('needs-choice', !currentDriverRoute);
  }
}

function updateRamalGate() {
  // Sin ramal elegido HOY, no se puede reportar checkpoint.
  const blocked = !currentDriverRoute;
  checkpointBtn.disabled = blocked;
  checkpointBtn.style.opacity = blocked ? '.45' : '';
  checkpointBtn.style.pointerEvents = blocked ? 'none' : '';
}

function setupDriverRoute() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(ramalStorageKey()));
  } catch (e) {
    saved = null;
  }
  // Solo cuenta si es de HOY; si es de otro día (o no hay nada), se pide
  // elegir de nuevo aunque currentDriver.route en la base traiga algo viejo.
  currentDriverRoute = (saved && saved.date === todayStr() && saved.route) ? saved.route : null;
  updateRamalButtons();
  updateRamalGate();
}

function setDriverRoute(route) {
  currentDriverRoute = route;
  updateRamalButtons();
  updateRamalGate();
  if (navigator.vibrate) navigator.vibrate(15);
  localStorage.setItem(ramalStorageKey(), JSON.stringify({ route, date: todayStr() }));
}

document.querySelectorAll('.ramal-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    setDriverRoute(btn.dataset.route);

    const { error } = await supabase
      .from('drivers')
      .update({ route: currentDriverRoute })
      .eq('id', currentDriver.id);

    if (error) console.error('Error actualizando ramal:', error);
  });
});

// ----- CHECKPOINTS (SALIÓ / LLEGÓ) -----
const CHECKPOINTS = [
  { key: 'salio_san_simon',  label: 'Salí de base San Simón' },
  { key: 'llego_san_martin', label: 'Llegué a San Martín' },
  { key: 'salio_san_martin', label: 'Salí de base San Martín' },
  { key: 'llego_san_simon',  label: 'Llegué a San Simón' },
];

let checkpointIdx = 0;
function updateCheckpointButtonLabel() {
  checkpointBtnLabel.textContent = CHECKPOINTS[checkpointIdx].label;
}

function setupCheckpointButton() {
  const saved = localStorage.getItem('rss_checkpoint_idx_' + currentDriver.id);
  const parsed = saved !== null ? parseInt(saved, 10) : 0;
  checkpointIdx = (Number.isInteger(parsed) && parsed >= 0 && parsed < CHECKPOINTS.length) ? parsed : 0;
  updateCheckpointButtonLabel();
}

let checkpointSending = false;

checkpointBtn.addEventListener('click', () => {
  if (checkpointSending) return; // evita doble tap mientras se procesa
  if (!currentDriverRoute) return; // respaldo: sin ramal elegido hoy, no reporta
  checkpointSending = true;

  if (navigator.vibrate) navigator.vibrate(20);
  const cp = CHECKPOINTS[checkpointIdx];

  // Optimista: avanza al siguiente aviso YA, sin esperar respuesta del
  // servidor — así el botón nunca se siente atrasado/trabado. El envío
  // real (con reintentos si hace falta) corre de fondo.
  checkpointIdx = (checkpointIdx + 1) % CHECKPOINTS.length;
  localStorage.setItem('rss_checkpoint_idx_' + currentDriver.id, String(checkpointIdx));
  updateCheckpointButtonLabel();

  checkpointSavedText.classList.remove('hidden');
  checkpointSavedText.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Enviando...';
  if (window.lucide) lucide.createIcons();

  sendConfiable({
    type: 'route_event',
    payload: {
      driver_id: currentDriver.id,
      event_key: cp.key,
      label: cp.label,
      route: currentDriverRoute,
      created_at: new Date().toISOString(),
    },
  }).then(({ queued }) => {
    checkpointSavedText.innerHTML = queued
      ? '<i data-lucide="clock" class="w-3.5 h-3.5"></i> Sin señal por ahora — se enviará solo en cuanto regrese.'
      : '<i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> Reportado. El dueño y el checador ya lo ven.';
    if (window.lucide) lucide.createIcons();
    setTimeout(() => checkpointSavedText.classList.add('hidden'), queued ? 5000 : 2500);
    checkpointSending = false;
  });
});

// ----- ESTATUS COMPARTIDO (debajo de Turno/Reposo) -----
// Un solo renglón chiquito: si está en reposo (tiene cuenta regresiva) eso
// manda, porque es lo más urgente/temporal; si no, muestra el estatus del
// turno; si no hay nada que avisar, se oculta para no estorbar la vista.
function renderTurnoReposoStatus() {
  if (!turnoReposoStatus) return;

  if (reposoUntil && reposoUntil.getTime() - Date.now() > 0) {
    const remaining = reposoUntil.getTime() - Date.now();
    turnoReposoStatus.textContent = 'En reposo · vuelve en ' + formatMMSS(remaining) + ' · toca "Reposo" para cancelar';
    turnoReposoStatus.classList.remove('hidden');
  } else if (onShift) {
    turnoReposoStatus.textContent = 'Turno en curso.';
    turnoReposoStatus.classList.remove('hidden');
  } else {
    turnoReposoStatus.classList.add('hidden');
  }
}

// ----- TURNO (INICIAR / TERMINAR) -----
// Es independiente del botón de ubicación: solo lleva registro de cuándo
// el chofer empieza y termina su jornada. NO prende ni apaga el GPS.
// Requiere en Supabase, tabla "drivers": columnas on_shift (bool) y
// shift_started_at (timestamptz).
let onShift = false;

function renderTurnoBtn() {
  if (onShift) {
    turnoBtn.classList.add('on');
    turnoBtn.innerHTML = 'Terminar<br>mi turno';
    if (headerShiftDot) headerShiftDot.classList.remove('hidden');
  } else {
    turnoBtn.classList.remove('on');
    turnoBtn.innerHTML = 'Iniciar<br>mi turno';
    if (headerShiftDot) headerShiftDot.classList.add('hidden');
  }
  renderTurnoReposoStatus();
}

function setupTurnoState() {
  onShift = !!currentDriver.on_shift;
  renderTurnoBtn();
}

let turnoSending = false;

turnoBtn.addEventListener('click', async () => {
  if (turnoSending) return;
  turnoSending = true;

  if (navigator.vibrate) navigator.vibrate(20);
  const startingShift = !onShift;

  const payload = startingShift
    ? { on_shift: true, shift_started_at: new Date().toISOString() }
    : { on_shift: false };

  // Optimista: se refleja de inmediato en su pantalla (el botón nunca
  // se siente "trabado"), y de fondo se manda/reintenta solo.
  onShift = startingShift;
  currentDriver.on_shift = onShift;
  renderTurnoBtn();

  const { queued } = await sendConfiable({ type: 'driver_update', payload, driverId: currentDriver.id });
  if (queued) {
    turnoReposoStatus.classList.remove('hidden');
    turnoReposoStatus.textContent = 'Sin señal — tu turno se confirmará en cuanto regrese la conexión.';
  }

  turnoSending = false;
});

// ----- REPOSO (15 MIN) -----
// Nada más es un aviso para el dueño/checador (no es visible al público) y
// se quita solo pasados 15 minutos. No afecta la ubicación, que se queda
// prendida todo el tiempo. Requiere en Supabase, tabla "drivers": columna
// resting_until (timestamptz, nullable).
const REPOSO_MINUTES = 15;
let reposoUntil = null;
let reposoIntervalId = null;

function formatMMSS(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function renderReposoBtn() {
  const remaining = reposoUntil ? reposoUntil.getTime() - Date.now() : 0;

  if (reposoUntil && remaining > 0) {
    reposoBtn.classList.add('active');
    reposoBtn.innerHTML = formatMMSS(remaining) + '<br>cancelar';
  } else {
    reposoBtn.classList.remove('active');
    reposoBtn.innerHTML = 'Marcar<br>reposo';
  }
  renderTurnoReposoStatus();
}

function stopReposoCountdown() {
  if (reposoIntervalId !== null) {
    clearInterval(reposoIntervalId);
    reposoIntervalId = null;
  }
}

async function clearReposo() {
  stopReposoCountdown();
  reposoUntil = null;
  renderReposoBtn();
  await sendConfiable({ type: 'driver_update', payload: { resting_until: null }, driverId: currentDriver.id });
}

function startReposoCountdown() {
  stopReposoCountdown();
  reposoIntervalId = setInterval(() => {
    if (!reposoUntil || reposoUntil.getTime() - Date.now() <= 0) {
      clearReposo();
      return;
    }
    renderReposoBtn();
  }, 1000);
}

function setupReposoState() {
  const saved = currentDriver.resting_until ? new Date(currentDriver.resting_until) : null;
  if (saved && saved.getTime() > Date.now()) {
    reposoUntil = saved;
    renderReposoBtn();
    startReposoCountdown();
  } else {
    reposoUntil = null;
    renderReposoBtn();
  }
}

reposoBtn.addEventListener('click', async () => {
  if (navigator.vibrate) navigator.vibrate(20);

  // Si ya está en reposo, tocar el botón lo cancela antes de tiempo.
  if (reposoUntil) {
    await clearReposo();
    return;
  }

  const until = new Date(Date.now() + REPOSO_MINUTES * 60 * 1000);

  // Optimista: arranca la cuenta regresiva de una vez, no hasta que
  // confirme el servidor.
  currentDriver.resting_until = until.toISOString();
  reposoUntil = until;
  renderReposoBtn();
  startReposoCountdown();

  await sendConfiable({ type: 'driver_update', payload: { resting_until: until.toISOString() }, driverId: currentDriver.id });
});

// ----- UBICACIÓN EN VIVO -----
let bgWatcherId = null; // id del watcher nativo (solo se usa dentro de la app empacada)

// ============================================================
// THROTTLE de envío — el problema real del consumo de batería no es
// leer el GPS (eso lo hace el chip solo), sino que ANTES mandábamos
// una petición a Supabase cada vez que watchPosition entregaba una
// lectura nueva (con enableHighAccuracy eso puede ser cada 1-3 seg
// en Android). Eso mantenía CPU + radio de datos despiertos todo el
// tiempo. Ahora: la pantalla del conductor se sigue actualizando al
// instante (es barato, no toca red), pero solo se manda a Supabase
// cuando pasó suficiente tiempo O el conductor se movió suficiente
// distancia — igual que ya hacía la ruta nativa con distanceFilter.
// ============================================================
const MIN_SEND_INTERVAL_MS = 8000; // no mandar más seguido que esto...
const MAX_SEND_INTERVAL_MS = 20000; // ...pero tampoco dejar el mapa más viejo que esto, aunque no se mueva
const MIN_SEND_DISTANCE_M = 15; // o si se movió esto, manda aunque no haya pasado MIN_SEND_INTERVAL_MS

let lastSentAt = 0;
let lastSentLat = null;
let lastSentLng = null;

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function debeMandarAhora(latitude, longitude) {
  const now = Date.now();
  const elapsed = now - lastSentAt;

  if (lastSentLat === null) return true; // primer fix: manda sí o sí
  if (elapsed >= MAX_SEND_INTERVAL_MS) return true; // ya se tardó mucho, refresca aunque esté parado
  if (elapsed < MIN_SEND_INTERVAL_MS) return false; // muy seguido, espérate

  const moved = distanciaMetros(lastSentLat, lastSentLng, latitude, longitude);
  return moved >= MIN_SEND_DISTANCE_M;
}

async function guardarUbicacion(latitude, longitude, heading, speed) {
  const now = Date.now();

  // Esto es barato (solo DOM), se actualiza siempre para que el
  // conductor vea su posición al instante en su propia pantalla.
  coordsText.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  updatedText.textContent = new Date(now).toLocaleTimeString('es-MX');

  // Esto es caro (red + Supabase), se manda solo si el throttle lo permite.
  if (!debeMandarAhora(latitude, longitude)) return;

  lastSentAt = now;
  lastSentLat = latitude;
  lastSentLng = longitude;

  const { queued } = await sendConfiable({
    type: 'live_location',
    payload: {
      driver_id: currentDriver.id,
      lat: latitude,
      lng: longitude,
      heading: heading ?? null,
      speed: speed ?? null,
      updated_at: new Date().toISOString(),
    },
  });

  // No mostramos error duro aquí: si se encoló, el chip de "Sin señal"
  // ya le avisa al conductor, y el siguiente watchPosition (o el
  // reintento automático) lo va a mandar solo en cuanto haya señal.
  if (!queued) {
    statusText.textContent = 'Tu combi ya está en tiempo real en el mapa.';
  }
}

// --- Ruta de navegador normal (sin cambios respecto al código original) ---
function onPos(pos) {
  const { latitude, longitude, heading, speed } = pos.coords;
  guardarUbicacion(latitude, longitude, heading, speed);
}

function onPosError(err) {
  let msg = 'No se pudo obtener tu ubicación.';
  if (err.code === err.PERMISSION_DENIED) msg = 'Activa el permiso de ubicación de este sitio.';
  statusText.textContent = msg;
  stopSharing();
}

// --- Ruta nativa (Android empacado con Capacitor) ---
async function startSharingNative() {
  if (!BackgroundGeolocation) {
    console.error('Plugin BackgroundGeolocation no disponible en window.Capacitor.Plugins');
    statusText.textContent = 'No se encontró el módulo de ubicación nativo. Reinstala la app.';
    return;
  }
  try {
    bgWatcherId = await BackgroundGeolocation.addWatcher(
      {
        backgroundMessage: 'Ruta San Simón está compartiendo tu ubicación',
        backgroundTitle: 'Compartiendo ubicación',
        requestPermissions: true,
        stale: false,
        distanceFilter: 10, // metros; baja este número si quieres updates más seguidos
      },
      (location, error) => {
        if (error) {
          console.error('Error de background-geolocation:', error);
          if (error.code === 'NOT_AUTHORIZED') {
            statusText.textContent = 'Activa el permiso de ubicación "Todo el tiempo" en Ajustes.';
          } else {
            statusText.textContent = 'No se pudo obtener tu ubicación.';
          }
          stopSharing();
          return;
        }
        if (location) {
          guardarUbicacion(location.latitude, location.longitude, location.bearing, location.speed);
        }
      }
    );

    toggleBtn.classList.add('on');
    toggleLabel.innerHTML = 'Ubicación<br>activa';
    statusText.textContent = 'Tu combi ya está en tiempo real en el mapa.';
  } catch (e) {
    console.error('No se pudo iniciar background-geolocation:', e);
    statusText.textContent = 'No se pudo activar la ubicación (revisa permisos en Ajustes).';
  }
}

async function stopSharingNative() {
  if (bgWatcherId !== null) {
    try {
      await BackgroundGeolocation.removeWatcher({ id: bgWatcherId });
    } catch (e) {
      console.error('Error quitando watcher nativo:', e);
    }
    bgWatcherId = null;
  }
}

const POLL_INTERVAL_MS = 10000; // cada cuánto se pide una lectura de GPS nueva

function pollPosition() {
  navigator.geolocation.getCurrentPosition(onPos, onPosError, {
    enableHighAccuracy: true,
    maximumAge: 8000,
    timeout: 9000,
  });
}

// --- Función pública que usa el botón: decide navegador vs nativo ---
function startSharing() {
  if (navigator.vibrate) navigator.vibrate(20);

  // Reinicia el throttle: si el conductor apagó y volvió a encender la
  // ubicación, el primer fix de la nueva sesión debe mandarse de una vez.
  lastSentAt = 0;
  lastSentLat = null;
  lastSentLng = null;

  if (Capacitor.isNativePlatform()) {
    startSharingNative();
    return;
  }

  // Navegador normal (sin cambios)
  if (!navigator.geolocation) {
    statusText.textContent = 'Tu navegador no soporta geolocalización.';
    return;
  }

  toggleBtn.classList.add('on');
  toggleLabel.innerHTML = 'Ubicación<br>activa';
  statusText.textContent = 'Tu combi ya está en tiempo real en el mapa.';

  // Antes usábamos watchPosition, que en muchos Android pide una lectura
  // nueva de GPS de alta precisión cada 1-5 seg SIN PARAR — aunque el
  // throttle de abajo (debeMandarAhora) solo mande 1 de cada 2-3 al
  // servidor, el chip de GPS y la pantalla (por el wake lock) se quedan
  // trabajando sin descanso durante todo el turno, y eso es lo que
  // calienta el teléfono y drena la pila.
  //
  // Ahora pedimos una lectura cada POLL_INTERVAL_MS en vez de dejar que
  // el navegador dispare lecturas tan seguido como pueda. Como igual solo
  // mandamos a Supabase cada 8-20 seg, no perdemos nada de "tiempo real"
  // en el mapa, pero el GPS descansa entre lectura y lectura.
  watchId = 'polling'; // solo como bandera de "hay tracking activo"
  pollPosition();
  pollIntervalId = setInterval(pollPosition, POLL_INTERVAL_MS);

  requestWakeLock();
}

async function stopSharing() {
  if (Capacitor.isNativePlatform()) {
    await stopSharingNative();
  } else if (watchId !== null) {
    if (pollIntervalId !== null) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    watchId = null;
    releaseWakeLock();
  }

  toggleBtn.classList.remove('on');
  toggleLabel.innerHTML = 'Encender<br>ubicación';
  statusText.textContent = 'Presiona el botón para activar tu ubicación en el mapa.';

  // Si el radio estaba conectado, se apaga junto con la ubicación: ya
  // terminaste tu turno, no tiene caso que el radio siga usando datos y
  // batería solo. En cuanto vuelvas a tocar HABLAR se reconecta solo.
  if (window.__rssWalkieStop) window.__rssWalkieStop();

  await sendConfiable({ type: 'live_location_off', driverId: currentDriver.id });
}

toggleBtn.addEventListener('click', () => {
  if (toggleBtn.classList.contains('on')) stopSharing();
  else startSharing();
});

// ----- BOTÓN DE AYUDA / PÁNICO -----
function openPanic() {
  // Siempre se abre desde el paso de confirmar, sin importar cómo haya
  // quedado la vez anterior (enviado, encolado, etc.) — así el botón
  // de pánico se puede volver a usar las veces que haga falta, sin
  // tener que cerrar sesión.
  document.getElementById('panicStepAsk').classList.remove('hidden');
  document.getElementById('panicStepSent').classList.add('hidden');
  document.getElementById('panicStepError').classList.add('hidden');
  panicOverlay.classList.add('show');
}
function closePanic() { panicOverlay.classList.remove('show'); }

panicBtn.addEventListener('click', () => {
  if (navigator.vibrate) navigator.vibrate(20);
  openPanic();
});

document.getElementById('panicCancelBtn').addEventListener('click', closePanic);
document.getElementById('panicCloseBtn').addEventListener('click', closePanic);
document.getElementById('panicErrorCloseBtn').addEventListener('click', closePanic);
panicOverlay.addEventListener('click', (e) => {
  if (e.target.id === 'panicOverlay') closePanic();
});

document.getElementById('panicConfirmBtn').addEventListener('click', () => {
  if (navigator.vibrate) navigator.vibrate([40, 30, 40, 30, 60]);
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => sendPanicAlert(pos.coords.latitude, pos.coords.longitude),
      () => sendPanicAlert(null, null),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  } else {
    sendPanicAlert(null, null);
  }
});

async function sendPanicAlert(lat, lng) {
  const { queued } = await sendConfiable({
    type: 'panic_alert',
    payload: {
      driver_id: currentDriver.id,
      owner_id: currentDriver.owner_id,
      unit_id: currentDriver.unit_id || null,
      lat: lat,
      lng: lng,
      status: 'pendiente',
    },
  });

  document.getElementById('panicStepAsk').classList.add('hidden');

  if (queued) {
    // No se pudo confirmar de inmediato por falta de señal, pero se
    // sigue reintentando solo de fondo cada pocos segundos hasta salir.
    document.getElementById('panicStepError').classList.remove('hidden');
  } else {
    document.getElementById('panicStepSent').classList.remove('hidden');
  }
}

// ----- ARRANQUE: si ya había sesión abierta hoy, entra directo sin PIN -----
renderSyncIndicator();
flushQueue(); // por si quedó algo pendiente de la sesión anterior (batería, cierre abrupto, etc.)
tryAutoLogin();
