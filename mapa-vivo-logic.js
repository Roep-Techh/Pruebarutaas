import { supabase } from './supabase-config.js';

let map = null;
let driverMarkers = {}; // driver_id -> L.Marker
let centeredOnce = false;

// ----- SEGURIDAD: exigir sesión de checador -----
// mapa-vivo.html se abre en pestaña aparte (target="_blank" desde el panel)
// y antes no checaba nada — cualquiera que se supiera o adivinara el
// nombre del archivo lo abría directo, sin haber entrado nunca con el PIN,
// y veía la ubicación en vivo de todos los conductores. Ahora exige que ya
// exista una sesión de checador válida (la misma que guarda checador.html
// al entrar con el PIN) antes de cargar mapa o datos.
async function requireChecadorSession() {
  const checadorId = localStorage.getItem('rss_checador_id');
  if (!checadorId) return false;

  // No basta con que exista el valor en localStorage (alguien lo podría
  // poner a mano desde la consola) — se valida contra la base para
  // confirmar que es un checador real y sigue existiendo.
  const { data, error } = await supabase
    .from('checadores')
    .select('id')
    .eq('id', checadorId)
    .single();

  if (error || !data) {
    localStorage.removeItem('rss_checador_id');
    return false;
  }
  return true;
}

function showLoginRequired() {
  document.body.innerHTML = `
    <div style="min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1.1rem; text-align:center; padding:2rem; font-family:'Plus Jakarta Sans', sans-serif; color:#EDF1F5; background:#0A0E13;">
      <div style="width:52px; height:52px; border-radius:999px; background:#171E27; border:1px solid #232B36; display:flex; align-items:center; justify-content:center;">
        <i data-lucide="lock" style="width:22px; height:22px; color:#FFAE33;"></i>
      </div>
      <p style="font-size:15px; font-weight:600; max-width:280px;">Necesitas iniciar sesión como checador para ver el mapa en vivo.</p>
      <a href="checador.html" style="background:#3FB0F0; color:#08131c; padding:.75rem 1.5rem; border-radius:999px; font-weight:700; font-family:'Sora',sans-serif; text-decoration:none; font-size:14px;">Ir a iniciar sesión</a>
    </div>`;
  if (window.lucide) lucide.createIcons();
}

function routeColor(route) {
  return route === 'secundaria' ? '#2FD98A' : (route === 'capilla' ? '#FFAE33' : '#3FB0F0');
}

function routeLabel(route) {
  return route === 'capilla' ? 'Por Capilla' : (route === 'secundaria' ? 'Por Secundaria' : 'Sin ramal');
}

function driverIcon(route) {
  const color = routeColor(route);
  return L.divIcon({
    className: '',
    html: `<div style="width:34px;height:34px;border-radius:50%;background:${color};border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 10px rgba(0,0,0,.45);">🚐</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function escapeHtml(str) {
  return (str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function centerOnDriver(id) {
  const marker = driverMarkers[id];
  if (!marker || !map) return;
  map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 16), { duration: 0.6 });
  marker.openPopup();
}

// Chips con el nombre de cada conductor en vivo, junto al título "Mapa en
// vivo". Al darles click centran el mapa en la posición actual de ese
// conductor en ese momento (misma lógica que el click sobre el pin).
function renderDriverChips(onlineDrivers) {
  const container = document.getElementById('driverChips');
  if (!container) return;

  container.innerHTML = onlineDrivers.map((d) => `
    <button class="driver-chip" data-driver-id="${d.id}">
      <span class="chip-dot" style="background:${routeColor(d.route)};"></span>
      ${escapeHtml(d.name || 'Conductor')}
    </button>
  `).join('');

  container.querySelectorAll('.driver-chip').forEach((chip) => {
    chip.addEventListener('click', () => centerOnDriver(chip.dataset.driverId));
  });
}

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([19.272, -98.455], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  L.control.attribution({ prefix: false })
    .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
    .addTo(map);
}

async function renderDrivers() {
  const { data: drivers, error } = await supabase
    .from('drivers')
    .select(`
      id, name, route,
      live_location:live_locations ( lat, lng, updated_at )
    `);

  if (error) { console.error('Error cargando conductores para el mapa:', error); return; }

  let onlineCount = 0;
  const seenIds = new Set();
  const onlineDrivers = [];

  (drivers || []).forEach((d) => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    const fresh = location && location.updated_at && (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);

    if (fresh && location.lat && location.lng) {
      onlineCount++;
      seenIds.add(d.id);
      onlineDrivers.push(d);
      const latlng = [location.lat, location.lng];
      const popupText = `${d.name || 'Conductor'} · ${routeLabel(d.route)}`;
      if (!driverMarkers[d.id]) {
        driverMarkers[d.id] = L.marker(latlng, { icon: driverIcon(d.route) }).addTo(map).bindPopup(popupText);
        driverMarkers[d.id].on('click', () => centerOnDriver(d.id));
      } else {
        driverMarkers[d.id].setLatLng(latlng);
        driverMarkers[d.id].setPopupContent(popupText);
        driverMarkers[d.id].setIcon(driverIcon(d.route));
      }
    }
  });

  // Quitar del mapa a los conductores que ya no tienen ubicación fresca
  Object.keys(driverMarkers).forEach((id) => {
    if (!seenIds.has(id)) {
      map.removeLayer(driverMarkers[id]);
      delete driverMarkers[id];
    }
  });

  const onlineCountText = document.getElementById('onlineCountText');
  if (onlineCountText) onlineCountText.textContent = `${onlineCount} en ruta`;
  const liveDot = document.getElementById('liveDot');
  if (liveDot) liveDot.classList.toggle('stale', onlineCount === 0);

  renderDriverChips(onlineDrivers);

  const activeMarkers = Object.values(driverMarkers);
  if (activeMarkers.length > 0 && !centeredOnce) {
    const group = L.featureGroup(activeMarkers);
    map.fitBounds(group.getBounds().pad(0.2));
    centeredOnce = true;
  }
}

(async () => {
  const hasSession = await requireChecadorSession();
  if (!hasSession) {
    showLoginRequired();
    return;
  }

  initMap();
  renderDrivers();

  supabase
    .channel('mapa-vivo-locations-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_locations' }, () => renderDrivers())
    .subscribe();

  supabase
    .channel('mapa-vivo-drivers-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' }, () => renderDrivers())
    .subscribe();

  setInterval(renderDrivers, 30000);

  if (window.lucide) lucide.createIcons();
})();
