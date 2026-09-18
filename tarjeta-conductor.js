// tarjeta-conductor.js (v2 — compacta, al lado del botón de ubicación)
// Antes se mostraba como una tabla completa arriba de todo el panel, lo
// cual en celular se veía mal (empujaba todo hacia abajo). Ahora se muestra
// como un "chip" compacto justo al lado del botón de encender ubicación
// (dentro de #toggleRow), con nada más la próxima salida. Al tocarlo, se
// abre una hoja (bottom sheet) con el horario completo del día — sigue
// actualizándose sola en tiempo real, esté abierta o cerrada la hoja.

import { supabase } from './supabase-config.js';

let tarjetaChannel = null;
let ultimasCorridas = [];
let sheetAbierta = false;

function formatHora(m) {
  if (m === null || m === undefined) return '--:--';
  let mm = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(mm / 60), mi = mm % 60;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
function ramalNombre(r) { return r === 'capilla' ? 'Por Capilla' : 'Por Secundaria'; }
function ramalColorVar(r) { return r === 'capilla' ? 'var(--cempasuchil)' : 'var(--agave)'; }
// "Día operativo": igual que en el panel del checador, la fecha no cambia
// justo a medianoche sino hasta las 5:00am (cuando arranca el servicio) —
// así lo que el checador programa para "mañana" le aparece al conductor
// exactamente a esa hora, no desde las 12:00am.
function todayStr() {
  const d = new Date();
  if (d.getHours() < 5) d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/* ======================= MONTAJE ======================= */
// Se monta dentro de #toggleRow (al lado del botón de encender ubicación).
// Si por alguna razón ese contenedor no existe todavía (orden de carga),
// se cae de vuelta a después del header, para nunca perder la tarjeta.
function ensureTarjetaMount() {
  let el = document.getElementById('miTarjetaHoy');
  if (el) return el;

  el = document.createElement('div');
  el.id = 'miTarjetaHoy';
  el.className = 'hidden';
  el.innerHTML = `
    <style>
      #miTarjetaHoy{ flex:1 1 150px; min-width:130px; max-width:220px; }
      #miTarjetaHoy .mt-chip{
        width:100%; box-sizing:border-box; height:100%;
        background:var(--surface); border:1px solid var(--border-soft); border-radius:1rem;
        padding:12px 12px; cursor:pointer; text-align:left;
        display:flex; flex-direction:column; gap:4px; justify-content:center;
        transition: all .25s cubic-bezier(.2,.8,.2,1);
      }
      #miTarjetaHoy .mt-chip:hover{ transform: translateY(-1px); box-shadow: var(--shadow-md); }
      #miTarjetaHoy .mt-chip:active{ transform: translateY(0) scale(.98); }
      #miTarjetaHoy .mt-chip-label{ font-size:9.5px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--ink-faint); display:flex; align-items:center; justify-content:space-between; gap:6px; }
      #miTarjetaHoy .mt-chip-ramal{ font-size:11.5px; font-weight:600; color:var(--ink-soft); display:flex; align-items:center; gap:5px; }
      #miTarjetaHoy .mt-dot{ display:inline-block; width:7px; height:7px; border-radius:50%; flex-shrink:0; }
      #miTarjetaHoy .mt-chip-times{ font-size:14px; font-weight:700; font-family:'Sora', sans-serif; color:var(--ink); line-height:1.25; }
      #miTarjetaHoy .mt-chip-times small{ font-weight:500; font-size:10.5px; color:var(--ink-faint); }
      #miTarjetaHoy .mt-chip-empty{ font-size:12px; color:var(--ink-faint); }
      #miTarjetaHoy .mt-chevron{ width:12px; height:12px; color:var(--ink-faint); flex-shrink:0; }
    </style>
    <button type="button" id="miTarjetaHoyChip" class="mt-chip" aria-haspopup="dialog">
      <span class="mt-chip-label">
        <span>Mi horario de hoy</span>
        <i data-lucide="chevron-right" class="mt-chevron"></i>
      </span>
      <div id="miTarjetaHoyChipBody"><span class="mt-chip-empty">Cargando…</span></div>
    </button>
  `;

  const toggleRow = document.getElementById('toggleRow');
  if (toggleRow) {
    toggleRow.appendChild(el);
  } else {
    // Respaldo por si el HTML no trae #toggleRow todavía.
    const main = document.getElementById('mainScreen');
    const header = main ? main.querySelector('header') : null;
    if (header) header.insertAdjacentElement('afterend', el);
    else if (main) main.insertBefore(el, main.firstChild);
  }

  el.querySelector('#miTarjetaHoyChip').addEventListener('click', abrirHoja);
  if (window.lucide) lucide.createIcons();
  return el;
}

/* ======================= HOJA (bottom sheet) CON EL DÍA COMPLETO ======================= */
function ensureSheet() {
  let overlay = document.getElementById('miHorarioOverlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'miHorarioOverlay';
  overlay.innerHTML = `
    <style>
      #miHorarioOverlay{
        position:fixed; inset:0; z-index:70;
        background:rgba(5,7,10,.68); backdrop-filter: blur(2px);
        display:none; align-items:flex-end; justify-content:center;
      }
      #miHorarioOverlay.show{ display:flex; }
      #miHorarioSheet{
        width:100%; max-width:28rem; max-height:75vh; overflow-y:auto;
        background:var(--surface); border-radius:1.75rem 1.75rem 0 0;
        padding:1.25rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom));
        border-top:1px solid var(--border);
        box-shadow: 0 -20px 50px -18px rgba(0,0,0,.7);
      }
      #miHorarioSheet .mh-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
      #miHorarioSheet .mh-close{ width:30px; height:30px; border-radius:9999px; display:flex; align-items:center; justify-content:center; background:var(--surface-2); border:1px solid var(--border); color:var(--ink); flex-shrink:0; }
      #miHorarioSheet table{ width:100%; border-collapse:collapse; }
      #miHorarioSheet th{ text-align:left; font-size:10px; font-weight:600; color:var(--ink-faint); text-transform:uppercase; letter-spacing:.03em; padding:4px 6px; border-bottom:1px solid var(--border-soft); }
      #miHorarioSheet th.mh-th-r, #miHorarioSheet td.mh-td-r{ text-align:right; }
      #miHorarioSheet td{ padding:9px 6px; border-bottom:1px solid var(--border-soft); font-size:14px; color:var(--ink); }
      #miHorarioSheet tr:last-child td{ border-bottom:none; }
      #miHorarioSheet .mh-time.pasada{ color:var(--ink-faint); text-decoration:line-through; }
      #miHorarioSheet .mh-ramal{ font-size:11.5px; color:var(--ink-soft); white-space:nowrap; }
      #miHorarioSheet .mh-dot{ display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px; }
      #miHorarioSheet .mh-empty{ font-size:13px; color:var(--ink-faint); text-align:center; padding:14px 0; }
      #miHorarioSheet .mh-next-tag{ font-size:9px; font-weight:700; color:var(--agave); display:block; margin-top:2px; }
    </style>
    <div id="miHorarioSheet" role="dialog" aria-label="Mi horario de hoy">
      <div class="mh-head">
        <p class="font-display font-semibold text-base" style="color:var(--ink);">Mi horario de hoy</p>
        <button type="button" id="miHorarioCloseBtn" class="mh-close" aria-label="Cerrar"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div id="miHorarioBody"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#miHorarioCloseBtn').addEventListener('click', cerrarHoja);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrarHoja(); });
  if (window.lucide) lucide.createIcons();
  return overlay;
}

function abrirHoja() {
  const overlay = ensureSheet();
  sheetAbierta = true;
  renderHoja(ultimasCorridas);
  overlay.classList.add('show');
}
function cerrarHoja() {
  sheetAbierta = false;
  document.getElementById('miHorarioOverlay')?.classList.remove('show');
}

/* ======================= RENDER ======================= */
function renderChip(corridas) {
  ensureTarjetaMount();
  const body = document.getElementById('miTarjetaHoyChipBody');
  document.getElementById('miTarjetaHoy')?.classList.remove('hidden');
  if (!body) return;

  if (!corridas.length) {
    body.innerHTML = '<span class="mt-chip-empty">Sin salidas asignadas hoy</span>';
    return;
  }
  const now = nowMin();
  const siguiente = corridas.find((c) => c.hora_salida >= now) || corridas[corridas.length - 1];
  const yaTerminaron = !corridas.some((c) => c.hora_salida >= now);
  body.innerHTML = `
    <span class="mt-chip-ramal"><span class="mt-dot" style="background:${ramalColorVar(siguiente.ramal)}"></span>${ramalNombre(siguiente.ramal)}</span>
    <span class="mt-chip-times">${formatHora(siguiente.hora_salida)} <small>sale de base</small>${yaTerminaron ? ' <small>· ya pasó</small>' : ''}</span>
  `;
}

function renderHoja(corridas) {
  const body = document.getElementById('miHorarioBody');
  if (!body) return;
  if (!corridas.length) {
    body.innerHTML = '<div class="mh-empty">Todavía no tienes salidas asignadas hoy.</div>';
    return;
  }
  const now = nowMin();
  const siguienteIdx = corridas.findIndex((c) => c.hora_salida >= now);
  const filas = corridas.map((c, i) => {
    const pasada = c.hora_salida < now;
    const esSiguiente = i === siguienteIdx;
    return `
      <tr>
        <td>
          <span class="mh-ramal"><span class="mh-dot" style="background:${ramalColorVar(c.ramal)}"></span>${ramalNombre(c.ramal)}</span>
          ${esSiguiente ? '<span class="mh-next-tag">SIGUIENTE</span>' : ''}
        </td>
        <td class="mh-td-r"><span class="mh-time ${pasada ? 'pasada' : ''}">${formatHora(c.hora_salida)}</span></td>
        <td class="mh-td-r"><span class="mh-time ${pasada ? 'pasada' : ''}">${formatHora(c.hora_llega)}</span></td>
      </tr>
    `;
  }).join('');
  body.innerHTML = `
    <table>
      <thead><tr><th>Ramal</th><th class="mh-th-r">Sale de base</th><th class="mh-th-r">Sale del asta</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
  `;
}

async function loadYRender(driverId) {
  const { data, error } = await supabase
    .from('corridas')
    .select('*')
    .eq('driver_id', driverId)
    .eq('fecha', todayStr())
    .order('hora_salida', { ascending: true });
  if (error) { console.error('Error cargando mi horario:', error); return; }
  ultimasCorridas = data || [];
  renderChip(ultimasCorridas);
  if (sheetAbierta) renderHoja(ultimasCorridas);
}

export function initTarjetaConductor(driverId) {
  if (!driverId) return;
  ensureTarjetaMount();
  loadYRender(driverId);
  if (tarjetaChannel) supabase.removeChannel(tarjetaChannel);
  tarjetaChannel = supabase
    .channel('tarjeta-conductor-' + driverId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'corridas', filter: `driver_id=eq.${driverId}` }, () => {
      loadYRender(driverId);
    })
    .subscribe();
  // Respaldo: refresca sola de vez en cuando, no depende solo del
  // realtime — así aunque algo falle en la suscripción, el conductor la ve
  // tarde o temprano. 45s en vez de cada pocos segundos porque esto es
  // nada más un respaldo (el tiempo real ya avisa al instante) y así no
  // gasta datos de más a lo tonto durante todo el turno.
  setInterval(() => loadYRender(driverId), 45000);
}
