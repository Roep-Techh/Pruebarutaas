import { supabase } from './supabase-config.js';
import { initPushNotifications } from './push-notifications.js';

let currentUser = null;
let currentOwner = null;
let map = null;
let driverMarkers = {};
let locationChannel = null;
let routeChannel = null;
let alertChannel = null;
let checadorEventsChannel = null;
let driversStatusChannel = null;
let vueltasChannel = null;
let mapInitialized = false; // Evita que el mapa se duplique

// Caché en memoria de la última carga, para alimentar el drawer y las búsquedas sin volver a pedir datos
let lastDrivers = [];
let lastChecadorEvents = [];
let lastRouteEvents = []; // checkpoints que reporta el propio conductor (salió/llegó), para mostrarlos en su ficha
let lastVueltas = {}; // driver_id -> vueltas de hoy (lo asigna el checador)
let driverSearchTerm = '';

// Elementos DOM
const loginScreen = document.getElementById('loginScreen');
const mainScreen = document.getElementById('mainScreen');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginError = document.getElementById('loginError');

// ----- LOGIN CON CORREO Y CONTRASEÑA -----
document.getElementById('loginSubmit').addEventListener('click', tryLogin);
emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

async function tryLogin() {
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email,
    password: password,
  });

  if (error || !data.user) {
    loginError.classList.remove('hidden');
    return;
  }

  const { data: owner, error: ownerError } = await supabase
    .from('owners')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (ownerError || !owner) {
    loginError.textContent = 'Tu cuenta no está registrada como dueño.';
    loginError.classList.remove('hidden');
    return;
  }

  enterApp(data.user, owner);
}

// ----- ENTRAR AL PANEL (login manual o sesión ya guardada) -----
function enterApp(user, owner) {
  currentUser = user;
  currentOwner = owner;
  loginError.classList.add('hidden');
  loginScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  mainScreen.classList.add('md:flex');

  // Mostrar el nombre del dueño en el panel, para que quede claro que
  // ese panel es suyo.
  const displayName = owner.full_name || owner.name || user.email || 'Dueño';
  window.__rssWalkieName = displayName; // usado por el botón de radio
  document.querySelectorAll('.owner-name-text').forEach((el) => { el.textContent = displayName; });

  // Inicializar mapa SOLO si no se ha creado antes
  if (!mapInitialized) {
    initMap();
  }

  initRealtimeListeners();
  if (window.lucide) lucide.createIcons();

  // Notificaciones push forzosas: que le lleguen las alertas aunque tenga
  // el panel cerrado o el celular bloqueado (requiere que el panel esté
  // instalado desde Chrome). Ver push-notifications.js para la config.
  initPushNotifications('dueno', owner.id, owner.name || currentUser.email);
}

// ----- SESIÓN GUARDADA: no volver a pedir correo/contraseña al recargar -----
// Supabase Auth ya guarda el token de sesión solo; aquí nada más
// revisamos si sigue siendo válido y, si sí, entramos directo sin
// mostrar la pantalla de login.
async function tryAutoLogin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || !session.user) return; // no hay sesión guardada: se queda en login

  const { data: owner, error: ownerError } = await supabase
    .from('owners')
    .select('*')
    .eq('id', session.user.id)
    .single();

  if (ownerError || !owner) return; // token válido pero no es cuenta de dueño: se queda en login

  enterApp(session.user, owner);
}

// ----- CIERRE DE SESIÓN -----
async function doLogout() {
  await supabase.auth.signOut();
  if (locationChannel) supabase.removeChannel(locationChannel);
  if (routeChannel) supabase.removeChannel(routeChannel);
  if (alertChannel) supabase.removeChannel(alertChannel);
  if (checadorEventsChannel) supabase.removeChannel(checadorEventsChannel);
  if (driversStatusChannel) supabase.removeChannel(driversStatusChannel);
  if (vueltasChannel) supabase.removeChannel(vueltasChannel);
  currentUser = null;
  currentOwner = null;
  mapInitialized = false; // Reiniciamos el flag al cerrar sesión
  lastDrivers = [];
  lastChecadorEvents = [];
  lastRouteEvents = [];
  lastVueltas = {};
  closeDriverDrawer();
  closeMobileNav();
  document.querySelectorAll('.owner-name-text').forEach((el) => { el.textContent = '—'; });
  mainScreen.classList.add('hidden');
  mainScreen.classList.remove('md:flex');
  loginScreen.classList.remove('hidden');
  emailInput.value = '';
  passwordInput.value = '';
}
document.getElementById('logoutBtn').addEventListener('click', doLogout);
document.getElementById('logoutBtnDesktop').addEventListener('click', doLogout);
document.getElementById('logoutBtnMobileNav').addEventListener('click', doLogout);

// ----- BUSCADOR DE CONDUCTORES -----
const driverSearchInput = document.getElementById('driverSearchInput');
const driverSearchInputMobile = document.getElementById('driverSearchInputMobile');
function onDriverSearch(e) {
  driverSearchTerm = e.target.value.trim().toLowerCase();
  // Mantenemos ambos campos sincronizados (escritorio/móvil)
  if (driverSearchInput && driverSearchInput.value !== e.target.value) driverSearchInput.value = e.target.value;
  if (driverSearchInputMobile && driverSearchInputMobile.value !== e.target.value) driverSearchInputMobile.value = e.target.value;
  renderDriversList();
}
if (driverSearchInput) driverSearchInput.addEventListener('input', onDriverSearch);
if (driverSearchInputMobile) driverSearchInputMobile.addEventListener('input', onDriverSearch);

// ----- MAPA (Leaflet) -----
function initMap() {
  if (mapInitialized) return; // Si ya existe, no hacer nada

  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([19.272, -98.455], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  L.control.attribution({ prefix: false })
    .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
    .addTo(map);

  mapInitialized = true; // Marcamos que ya se creó
}

// ----- VISIBILIDAD: la define la UNIDAD, no el conductor -----
// Un dueño ve a un conductor si y solo si la unidad que trae elegida en
// ese momento es una unidad suya (units.owner_id). Ya no importa quién
// dio de alta al conductor (drivers.owner_id) — ese campo queda solo para
// organizar el panel de Admin, no para decidir qué ve cada dueño.
function ownerCanSee(currentOwnerId, unitOwnerId) {
  return unitOwnerId === currentOwnerId;
}

function routeLabelFor(route) {
  return route === 'capilla' ? 'Por Capilla' : route === 'secundaria' ? 'Por Secundaria' : 'Sin ramal';
}
function routeColorFor(route) {
  return route === 'capilla' ? 'var(--cempasuchil)' : route === 'secundaria' ? 'var(--agave)' : 'var(--ink-faint)';
}

// ----- TURNO / REPOSO (lo reporta el propio conductor desde su panel) -----
// Se lee directo de la tabla "drivers": on_shift, shift_started_at, resting_until.
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

// ----- VUELTAS DEL DÍA (las va asignando el checador desde su panel) -----
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

function vueltasBadgeHtml(driverId) {
  const n = lastVueltas[driverId] ?? 0;
  return `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1" style="background:var(--surface-2); border:1px solid var(--border); color:var(--ink-soft);"><i data-lucide="repeat" class="w-3 h-3"></i> ${n} vuelta${n === 1 ? '' : 's'} hoy</span>`;
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

// ----- MENSAJE FLOTANTE (TOAST) -----
let toastTimeout = null;
function showToast(message) {
  let toast = document.getElementById('rssToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'rssToast';
    toast.style.cssText = `
      position:fixed; left:50%; bottom:28px; transform:translateX(-50%) translateY(20px);
      background:var(--surface-3); color:var(--ink); border:1px solid var(--border);
      font-family:'Plus Jakarta Sans', sans-serif;
      font-size:13px; font-weight:600; padding:10px 16px; border-radius:999px;
      box-shadow:0 10px 30px -10px rgba(0,0,0,.6); z-index:200; opacity:0;
      transition:opacity .25s ease, transform .25s ease; pointer-events:none; max-width:85vw;
      text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    `;
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  clearTimeout(toastTimeout);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });

  toastTimeout = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 2200);
}

// ----- CENTRAR MAPA EN UN CONDUCTOR ESPECÍFICO -----
function goToDriverOnMap(driverId) {
  const marker = driverMarkers[driverId];
  if (!map || !marker) return;

  map._rssCentered = true; // evita que el auto-ajuste general le gane a este zoom
  map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.75 });
  marker.openPopup();

  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ----- DRAWER: FICHA RÁPIDA DEL CONDUCTOR -----
const driverDrawer = document.getElementById('driverDrawer');
const driverDrawerOverlay = document.getElementById('driverDrawerOverlay');
const driverDrawerContent = document.getElementById('driverDrawerContent');

// Helpers para mostrar teléfonos de forma segura (evitan inyectar HTML)
function phoneText(phone) {
  return String(phone).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function phoneHref(phone) {
  return String(phone).replace(/[^\d+]/g, '');
}

function openDriverDrawer(driverId) {
  const d = lastDrivers.find(x => x.id === driverId);
  if (!d) return;

  const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
  const fresh = location && location.updated_at && (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);

  const todaysEvents = lastChecadorEvents.filter(ev => ev.driver_id === d.id || ev.driver?.name === d.name);
  const ownEvents = lastRouteEvents.filter(ev => ev.driver_id === d.id);

  const statusInfo = {
    a_tiempo: { label: 'A tiempo', icon: 'check-circle-2', color: 'var(--agave)' },
    retraso: { label: 'Llegó tarde', icon: 'clock', color: 'var(--cempasuchil)' },
    no_se_presento: { label: 'No se presentó', icon: 'alert-triangle', color: 'var(--alerta)' },
  };

  const eventsHtml = todaysEvents.length
    ? todaysEvents.map(ev => {
        const info = statusInfo[ev.status] || { label: ev.status || '—', icon: 'circle', color: 'var(--ink-soft)' };
        const time = ev.created_at ? new Date(ev.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
        return `
          <div class="flex items-center gap-2.5 py-1.5">
            <span class="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, ${info.color} 16%, var(--surface)); color:${info.color};"><i data-lucide="${info.icon}" class="w-3.5 h-3.5"></i></span>
            <p class="text-xs" style="color:var(--ink-soft);"><span class="font-semibold" style="color:${info.color};">${info.label}</span> · ${time}${ev.ubicacion ? ' · ' + ev.ubicacion : ''}</p>
          </div>`;
      }).join('')
    : `<p class="text-xs" style="color:var(--ink-faint);">Sin registros del checador hoy.</p>`;

  // "Registros propios": lo último que el conductor reportó él mismo desde su panel
  // (salió/llegó de cada base). route_events guarda un solo renglón por conductor
  // (se sobrescribe cada vez que reporta), así que mostramos su último aviso.
  const ownEventsHtml = ownEvents.length
    ? ownEvents.map(ev => {
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
        ${d.phone ? `<a href="tel:${phoneHref(d.phone)}" class="text-xs font-mono flex items-center gap-1" style="color:var(--talavera);"><i data-lucide="phone" class="w-3.5 h-3.5"></i> ${phoneText(d.phone)}</a>` : ''}
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-[11px] font-semibold px-2.5 py-1 rounded-full" style="background:${routeColorFor(d.route)}; color:#08131c;">${routeLabelFor(d.route)}</span>
      <span class="flex items-center gap-1.5 text-xs font-semibold" style="color:var(--ink-soft);"><span class="status-dot ${fresh ? 'on' : 'off'}"></span> ${fresh ? 'En ruta' : 'Sin conexión'}</span>
    </div>

    <div class="flex flex-wrap items-center gap-1.5">
      ${turnoReposoBadgeHtml(d)}
      ${vueltasBadgeHtml(d.id)}
    </div>

    <div class="card-soft p-3">
      <p class="text-[10px] font-mono uppercase tracking-wide mb-1" style="color:var(--ink-faint);">Última ubicación</p>
      <p class="text-xs font-mono" style="color:var(--ink-soft);">${locText}</p>
    </div>

    <div>
      <p class="text-[10px] font-mono uppercase tracking-wide mb-1.5" style="color:var(--ink-faint);">Checador hoy</p>
      <div class="card-soft p-3">${eventsHtml}</div>
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

  const goBtn = document.getElementById('drawerGoToMap');
  if (goBtn && fresh) {
    goBtn.addEventListener('click', () => {
      closeDriverDrawer();
      goToDriverOnMap(d.id);
    });
  } else if (goBtn) {
    goBtn.style.opacity = '.5';
    goBtn.style.cursor = 'not-allowed';
  }

  driverDrawer.classList.remove('hidden');
  driverDrawerOverlay.classList.remove('hidden');
  // Forzamos reflow para que la transición de apertura se anime siempre, incluso si ya estaba montado
  void driverDrawer.offsetHeight;
  driverDrawer.classList.add('open');
  if (window.lucide) lucide.createIcons();
}

let drawerCloseTimeout = null;
function closeDriverDrawer() {
  driverDrawer.classList.remove('open');
  driverDrawerOverlay.classList.add('hidden');
  clearTimeout(drawerCloseTimeout);
  drawerCloseTimeout = setTimeout(() => {
    driverDrawer.classList.add('hidden');
  }, 300);
}
document.getElementById('driverDrawerClose').addEventListener('click', closeDriverDrawer);
driverDrawerOverlay.addEventListener('click', closeDriverDrawer);

// ----- ESCUCHAR DATOS EN TIEMPO REAL -----
function initRealtimeListeners() {
  locationChannel = supabase
    .channel('locations-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_locations' },
      () => { renderDriversAndMap(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] live_locations:', status, err || '');
    });

  routeChannel = supabase
    .channel('route-events-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'route_events' },
      () => { renderRouteEvents(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] route_events:', status, err || '');
    });

  alertChannel = supabase
    .channel('alerts-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'panic_alerts' },
      () => { renderAlerts(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] panic_alerts:', status, err || '');
    });

  checadorEventsChannel = supabase
    .channel('checador-events-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'checador_events' },
      () => { renderChecadorEvents(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] checador_events:', status, err || '');
    });

  // Turno / reposo: los cambia el propio conductor desde su panel (drivers.on_shift, resting_until)
  driversStatusChannel = supabase
    .channel('drivers-status-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' },
      () => { renderDriversAndMap(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] drivers (turno/reposo):', status, err || '');
    });

  // Vueltas del día: las asigna el checador desde su panel
  vueltasChannel = supabase
    .channel('driver-vueltas-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_vueltas' },
      () => { renderDriversAndMap(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] driver_vueltas:', status, err || '');
    });

  // Carga inicial
  renderDriversAndMap();
  renderRouteEvents();
  renderAlerts();
  renderChecadorEvents();
}

// Refresca cada 30s nada más para que la cuenta regresiva de "Reposo · X min"
// no se quede pegada entre eventos de tiempo real.
setInterval(() => {
  if (currentOwner) renderDriversList();
}, 30000);

// ----- RENDERIZAR CONDUCTORES Y MAPA (CON FILTRO ADMIN/OWNER) -----
async function renderDriversAndMap() {
  if (!currentOwner) return;

  const isAdmin = currentOwner.role === 'admin' || currentOwner.role === 'developer';

  // OJO: ya no filtramos por owner_id aquí abajo con .eq() — la visibilidad
  // ya no depende del dueño fijo del conductor, depende de qué unidad trae
  // elegida ahora mismo. Por eso pedimos unit.owner_id y filtramos en JS
  // con ownerCanSee(), que solo compara contra el dueño de esa unidad.
  let query = supabase
    .from('drivers')
    .select(`
      *,
      unit:unit_id ( unit_number, owner_id ),
      live_location:live_locations ( lat, lng, heading, speed, updated_at )
    `)
    .eq('active', true);

  const { data: drivers, error } = await query;

  if (error) {
    console.error("Error al cargar conductores:", error);
    return;
  }

  lastDrivers = isAdmin
    ? (drivers || [])
    : (drivers || []).filter(d => ownerCanSee(currentOwner.id, d.unit?.owner_id));
  await loadVueltasToday();
  renderDriversList();
  renderFleetPulse();
}

// ----- LISTA DE CONDUCTORES (separado para poder filtrar por búsqueda sin recargar datos) -----
function renderDriversList() {
  const list = document.getElementById('driversList');
  const emptyMsg = document.getElementById('driversEmpty');
  list.innerHTML = '';

  const term = driverSearchTerm;
  const visibleDrivers = term
    ? lastDrivers.filter(d => (d.name || '').toLowerCase().includes(term))
    : lastDrivers;

  let onlineCount = 0;
  let capillaCount = 0;
  let secundariaCount = 0;

  // Recalculamos siempre sobre el total (no solo lo filtrado) para que el contador sea real
  lastDrivers.forEach(d => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    const fresh = location && location.updated_at &&
      (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);
    if (fresh) onlineCount++;
    if (d.route === 'capilla') capillaCount++;
    else if (d.route === 'secundaria') secundariaCount++;
  });

  document.getElementById('driversOnlineCount').textContent =
    onlineCount + ' en ruta · ' + capillaCount + ' Capilla · ' + secundariaCount + ' Sec.';
  document.getElementById('kpiOnRoute').textContent = `${onlineCount}/${lastDrivers.length}`;
  document.getElementById('liveBadgeText').textContent = `${onlineCount} en ruta`;

  if (visibleDrivers.length === 0) {
    emptyMsg.classList.remove('hidden');
  } else {
    emptyMsg.classList.add('hidden');
  }

  visibleDrivers.forEach(d => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    const fresh = location && location.updated_at &&
      (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);

    const routeLabel = routeLabelFor(d.route);
    const routeColor = routeColorFor(d.route);

    let locText = 'Sin conexión';
    if (fresh) {
      const lat = location.lat.toFixed(5);
      const lng = location.lng.toFixed(5);
      locText = `📍 ${lat}, ${lng} · ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
    } else if (location && location.updated_at) {
      locText = `Última vez: ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
    }

    const row = document.createElement('div');
    row.className = 'driver-row py-3 flex items-center justify-between gap-1.5 sm:gap-2 cursor-pointer';
    row.dataset.driverId = d.id;

    row.innerHTML = `
      <div class="min-w-0 flex items-center gap-2 sm:gap-2.5 flex-1">
        <span class="w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center shrink-0 font-display font-bold text-sm" style="background:color-mix(in srgb, var(--talavera) 16%, var(--surface)); color:var(--talavera);">${(d.name || '?').trim().charAt(0).toUpperCase()}</span>
        <div class="min-w-0">
          <p class="font-display font-semibold text-sm truncate">${d.name} <span class="text-[10px] font-mono" style="color:var(--ink-soft);">(U.${d.unit?.unit_number || '?'})</span></p>
          ${d.phone ? `<a href="tel:${phoneHref(d.phone)}" class="text-[10px] sm:text-[11px] font-mono truncate flex items-center gap-1" style="color:var(--talavera);" onclick="event.stopPropagation()"><i data-lucide="phone" class="w-3 h-3"></i> ${phoneText(d.phone)}</a>` : ''}
          <p class="text-[10px] sm:text-[11px] font-mono truncate" style="color:var(--ink-soft);">${locText}</p>
          <div class="flex flex-wrap items-center gap-1 mt-1">
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full inline-block" style="background:${routeColor}; color:#08131c;">${routeLabel}</span>
            ${turnoReposoBadgeHtml(d)}
            ${vueltasBadgeHtml(d.id)}
          </div>
        </div>
      </div>
      <span class="flex items-center gap-1.5 sm:gap-2.5 text-xs font-semibold shrink-0">
        <span class="hidden sm:flex items-center gap-1.5"><span class="status-dot ${fresh ? 'on' : 'off'}"></span> ${fresh ? 'En ruta' : 'Sin conexión'}</span>
        <span class="status-dot sm:hidden ${fresh ? 'on' : 'off'}"></span>
        <button class="driver-map-btn btn-lift w-8 h-8 rounded-full flex items-center justify-center shrink-0" style="background:var(--surface-2); border:1px solid var(--border); color:var(--talavera);" title="Ver en el mapa">
          <i data-lucide="map-pin" class="w-3.5 h-3.5"></i>
        </button>
      </span>
    `;

    // Click en la fila: abre la ficha rápida (drawer)
    row.addEventListener('click', () => openDriverDrawer(d.id));

    // Click en el botón de mapa: va directo al mapa (o avisa si no hay ubicación)
    const mapBtn = row.querySelector('.driver-map-btn');
    mapBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (fresh) {
        goToDriverOnMap(d.id);
      } else {
        showToast(`${d.name}: sin ubicación disponible.`);
      }
    });

    list.appendChild(row);

    if (fresh && location && location.lat && location.lng) {
      const latlng = [location.lat, location.lng];
      if (!driverMarkers[d.id]) {
        driverMarkers[d.id] = L.marker(latlng, { icon: driverIcon(d.route) }).addTo(map).bindPopup(`${d.name} · ${routeLabel}`);
      } else {
        driverMarkers[d.id].setLatLng(latlng);
        driverMarkers[d.id].setPopupContent(`${d.name} · ${routeLabel}`);
      }
    } else if (driverMarkers[d.id]) {
      map.removeLayer(driverMarkers[d.id]);
      delete driverMarkers[d.id];
    }
  });

  const activeMarkers = Object.values(driverMarkers);
  if (activeMarkers.length > 0 && !map._rssCentered) {
    const group = L.featureGroup(activeMarkers);
    map.fitBounds(group.getBounds().pad(0.2));
    map._rssCentered = true;
  }

  if (window.lucide) lucide.createIcons();
}

// ----- FRANJA DE PULSO DE FLOTA -----
function renderFleetPulse() {
  const rail = document.getElementById('fleetPulse');
  const countEl = document.getElementById('fleetPulseCount');
  if (!rail) return;

  const online = lastDrivers.filter(d => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    return location && location.updated_at && (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);
  });

  countEl.textContent = `${online.length}/${lastDrivers.length} activas`;

  if (online.length === 0) {
    rail.innerHTML = `<p class="text-xs px-1" style="color:var(--ink-faint);">Ninguna unidad en ruta por ahora.</p>`;
    return;
  }

  rail.innerHTML = online.map(d => `
    <button class="pulse-chip flex items-center gap-1.5 px-3 py-1.5" data-driver-id="${d.id}">
      <span class="status-dot on pulse-live"></span>
      <span class="text-xs font-semibold">${d.name}</span>
      <span class="text-[10px] font-mono" style="color:var(--ink-faint);">U${d.unit?.unit_number ?? '?'}</span>
    </button>
  `).join('');

  rail.querySelectorAll('.pulse-chip').forEach(chip => {
    chip.addEventListener('click', () => openDriverDrawer(chip.dataset.driverId));
  });
}

// ----- RENDERIZAR AVISOS DE RUTA -----
async function renderRouteEvents() {
  if (!currentOwner) return;

  const isAdmin = currentOwner.role === 'admin' || currentOwner.role === 'developer';
  // Igual que en renderDriversAndMap: la visibilidad depende de la unidad
  // que trae el conductor, no de quién lo dio de alta. Traemos
  // driver.unit.owner_id y filtramos con ownerCanSee() del lado del cliente.
  let query = supabase
    .from('route_events')
    .select('*, driver:driver_id!inner ( name, owner_id, unit:unit_id ( owner_id ) )')
    .order('created_at', { ascending: false })
    .limit(20);

  const { data: rawEvents, error } = await query;
  if (error) { console.error('Error cargando route_events:', error); return; }

  const events = isAdmin
    ? (rawEvents || [])
    : (rawEvents || []).filter(ev => ownerCanSee(currentOwner.id, ev.driver?.unit?.owner_id));

  lastRouteEvents = events || [];

  const list = document.getElementById('routeEventsList');
  if (!events || events.length === 0) {
    list.innerHTML = `<p id="routeEventsEmpty" class="text-sm text-center" style="color:var(--ink-soft);">Todavía no hay avisos de los conductores hoy.</p>`;
    document.getElementById('kpiAvisos').textContent = '0';
    return;
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayCount = events.filter(ev => ev.created_at && new Date(ev.created_at) >= startOfDay).length;
  document.getElementById('kpiAvisos').textContent = String(todayCount);

  list.innerHTML = events.map(ev => `
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

// ----- RENDERIZAR REGISTROS DEL CHECADOR -----
async function renderChecadorEvents() {
  if (!currentOwner) return;

  const isAdmin = currentOwner.role === 'admin' || currentOwner.role === 'developer';

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // Esta tabla ya guardaba unit_id — solo necesitamos también unit.owner_id
  // para filtrar por el dueño real de la unidad de ese momento, no por el
  // owner_id (dueño fijo del conductor) que trae guardado la fila.
  let query = supabase
    .from('checador_events')
    .select('*, driver:driver_id ( name ), unit:unit_id ( unit_number, owner_id ), checador:checador_id ( name )')
    .gte('created_at', startOfDay.toISOString())
    .order('created_at', { ascending: false })
    .limit(50);

  const { data: rawEvents, error } = await query;
  if (error) { console.error('Error cargando checador_events:', error); return; }

  const events = isAdmin
    ? rawEvents
    : (rawEvents || []).filter(ev => ownerCanSee(currentOwner.id, ev.unit?.owner_id));

  lastChecadorEvents = events || [];

  const list = document.getElementById('checadorEventsList');
  if (!events || events.length === 0) {
    list.innerHTML = `<p id="checadorEventsEmpty" class="text-sm text-center" style="color:var(--ink-soft);">Todavía no hay registros del checador hoy.</p>`;
    document.getElementById('kpiPunctuality').textContent = '—';
    return;
  }

  const statusInfo = {
    a_tiempo: { label: 'A tiempo', icon: 'check-circle-2', color: 'var(--agave)' },
    retraso: { label: 'Llegó tarde', icon: 'clock', color: 'var(--cempasuchil)' },
    no_se_presento: { label: 'No se presentó', icon: 'alert-triangle', color: 'var(--alerta)' },
  };

  // Puntualidad del día: % de "a_tiempo" sobre el total de registros con estatus conocido
  const known = events.filter(ev => statusInfo[ev.status]);
  const onTime = known.filter(ev => ev.status === 'a_tiempo').length;
  document.getElementById('kpiPunctuality').textContent = known.length
    ? `${Math.round((onTime / known.length) * 100)}%`
    : '—';

  list.innerHTML = events.map((ev) => {
    const info = statusInfo[ev.status] || { label: ev.status || '—', icon: 'circle', color: 'var(--ink-soft)' };
    const routeTxt = ev.route === 'capilla' ? 'Por Capilla' : (ev.route === 'secundaria' ? 'Por Secundaria' : '');
    const time = ev.created_at ? new Date(ev.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
    const unitNum = ev.unit?.unit_number != null ? `Unidad ${ev.unit.unit_number}` : 'Unidad —';

    return `
      <div class="flex items-center gap-2.5">
        <span class="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, ${info.color} 18%, var(--surface)); color:${info.color};"><i data-lucide="${info.icon}" class="w-4 h-4"></i></span>
        <div class="min-w-0">
          <p class="font-display font-semibold text-sm truncate">${unitNum} — ${ev.driver?.name || 'Conductor'} — <span style="color:${info.color};">${info.label}</span></p>
          <p class="text-[11px] font-mono truncate" style="color:var(--ink-soft);">${time}${routeTxt ? ' · ' + routeTxt : ''}${ev.ubicacion ? ' · pasó por ' + ev.ubicacion : ''}${ev.checador?.name ? ' · Checador: ' + ev.checador.name : ''}</p>
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

// ----- RENDERIZAR ALERTAS -----
async function renderAlerts() {
  if (!currentOwner) return;

  const isAdmin = currentOwner.role === 'admin' || currentOwner.role === 'developer';
  // Filtramos por unit.owner_id: el dueño real de la unidad que traía el
  // conductor al momento de la alerta (ver unit_id agregado en
  // sendPanicAlert, conductor-logic.js), no por el dueño fijo del conductor.
  let query = supabase
    .from('panic_alerts')
    .select('*, driver:driver_id ( name ), unit:unit_id ( unit_number, owner_id )')
    .order('created_at', { ascending: false })
    .limit(20);

  const { data: rawAlerts, error } = await query;
  if (error) { console.error('Error cargando panic_alerts:', error); return; }

  const alerts = isAdmin
    ? rawAlerts
    : (rawAlerts || []).filter(a => ownerCanSee(currentOwner.id, a.unit?.owner_id));

  const list = document.getElementById('alertsList');
  const empty = document.getElementById('alertsEmpty');

  if (!alerts || alerts.length === 0) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    document.getElementById('alarmBar').classList.remove('show');
    document.getElementById('kpiAlerts').textContent = '0';
    stopAlarmSound();
    return;
  }
  empty.classList.add('hidden');

  const pendingCount = alerts.filter(a => a.status === 'pendiente').length;
  document.getElementById('kpiAlerts').textContent = String(pendingCount);

  if (pendingCount > 0) {
    document.getElementById('alarmBar').classList.add('show');
    playAlarmSound();
  } else {
    document.getElementById('alarmBar').classList.remove('show');
    stopAlarmSound();
  }

  list.innerHTML = alerts.map(a => {
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
      const { error } = await supabase
        .from('panic_alerts')
        .update({ status: 'atendida' })
        .eq('id', btn.dataset.id);

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

// ----- SONIDO DE ALARMA (alertas de pánico) -----
// El navegador bloquea el sonido automático hasta que haya habido algún
// clic/toque del usuario en la página. Por eso "desbloqueamos" el audio
// en la primera interacción (login, clic en cualquier lado), y luego ya
// se puede reproducir solo cuando llega una alerta nueva.
const trackingAudio = document.getElementById('trackingAudio');
let audioUnlocked = false;

function unlockAlarmAudio() {
  if (audioUnlocked || !trackingAudio) return;
  trackingAudio.volume = 1;
  trackingAudio.play().then(() => {
    trackingAudio.pause();
    trackingAudio.currentTime = 0;
    audioUnlocked = true;
  }).catch(() => {
    // Todavía no hay permiso del navegador; se reintenta en el próximo clic.
  });
  document.removeEventListener('click', unlockAlarmAudio);
  document.removeEventListener('touchstart', unlockAlarmAudio);
}
document.addEventListener('click', unlockAlarmAudio);
document.addEventListener('touchstart', unlockAlarmAudio);

function playAlarmSound() {
  if (!trackingAudio) return;
  trackingAudio.play().catch(() => {
    // Si el navegador todavía no lo permite, se reproducirá en cuanto
    // el usuario toque la pantalla (ver unlockAlarmAudio arriba).
  });
}

function stopAlarmSound() {
  if (!trackingAudio) return;
  trackingAudio.pause();
  trackingAudio.currentTime = 0;
}

// ----- BOTÓN DE SILENCIAR ALARMA -----
document.getElementById('silenceBtn').addEventListener('click', () => {
  document.getElementById('alarmBar').classList.remove('show');
  stopAlarmSound();
});

// ----- MENÚ MÓVIL (hamburguesa): el sidebar de escritorio estaba oculto por completo en
// pantallas chicas (hidden md:flex) y no había forma de llegar a Conductores/Checador/etc.
// sin hacer scroll a ciegas. Este panel reutiliza los mismos enlaces como una hoja lateral.
const mobileNavOpenBtn = document.getElementById('mobileNavOpen');
const mobileNavCloseBtn = document.getElementById('mobileNavClose');
const mobileNavOverlay = document.getElementById('mobileNavOverlay');
const mobileNavPanel = document.getElementById('mobileNavPanel');

function openMobileNav() {
  mobileNavOverlay.classList.remove('hidden');
  mobileNavPanel.classList.remove('hidden');
  void mobileNavPanel.offsetHeight; // forzar reflow para que la transición siempre anime
  mobileNavPanel.classList.add('open');
}

let mobileNavCloseTimeout = null;
function closeMobileNav() {
  mobileNavPanel.classList.remove('open');
  mobileNavOverlay.classList.add('hidden');
  clearTimeout(mobileNavCloseTimeout);
  mobileNavCloseTimeout = setTimeout(() => mobileNavPanel.classList.add('hidden'), 300);
}

if (mobileNavOpenBtn) mobileNavOpenBtn.addEventListener('click', openMobileNav);
if (mobileNavCloseBtn) mobileNavCloseBtn.addEventListener('click', closeMobileNav);
if (mobileNavOverlay) mobileNavOverlay.addEventListener('click', closeMobileNav);
// Cerrar el menú al tocar cualquier enlace (ancla a una sección)
document.querySelectorAll('#mobileNavPanel a.mobile-nav-item').forEach((a) => {
  a.addEventListener('click', closeMobileNav);
});

// ----- NAVEGACIÓN: marcar el enlace activo (escritorio Y móvil) según la sección visible -----
const navLinks = Array.from(document.querySelectorAll('aside .nav-item, #mobileNavPanel .mobile-nav-item'));
if (navLinks.length) {
  const sectionIds = [...new Set(navLinks.map(a => a.getAttribute('href').slice(1)))];
  const sections = sectionIds.map(id => document.getElementById(id)).filter(Boolean);

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

  sections.forEach(sec => observer.observe(sec));
}

tryAutoLogin();
