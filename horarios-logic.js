// horarios-logic.js (v3)
// Pestaña "Horarios" del panel del checador.
//
// Antes: el checador ponía "desde/hasta/cada cuánto/vuelta redonda" y el
// sistema calculaba una tabla con intervalo parejo. Ahora: hay tablas de
// horario YA HECHAS (plantillas, ej. 6x45, 7x45 — ver plantillas-horarios.js)
// con los horarios reales de cada corrida. El checador nada más:
//   1) elige qué tabla usar hoy (por ramal: Capilla / Secundaria),
//   2) dice qué unidades y conductores andan hoy en ese ramal (tantos como
//      pida la tabla — "6x45" pide 6, "7x45" pide 7, etc.),
//   3) aprieta "Aplicar tabla" y el sistema reparte solo cada corrida de la
//      tabla entre esas unidades/conductores, rotando en orden.
// Debajo se sigue viendo el desglose completo del día por si hace falta
// corregir a mano una corrida suelta (por ejemplo, un cambio de última
// hora nada más en una salida).

import { supabase } from './supabase-config.js';
import { PLANTILLAS } from './plantillas-horarios.js';

const RAMALES = ['capilla', 'secundaria'];
let ramalesConfig = {}; // { capilla: {ramal, nombre, plantilla_id, slots:[{unit_id,driver_id}, ...]}, ... }
let corridasPorRamal = { capilla: [], secundaria: [] }; // ordenadas por slot_index
let unidadesH = [];
let conductoresH = [];
let corridasChannel = null;
let saveQueue = new Map(); // corridaId -> timeout
let loadedDateStr = null;

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function formatHora(m) {
  if (m === null || m === undefined) return '--:--';
  let mm = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(mm / 60), mi = mm % 60;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getPlantilla(key, plantillaId) {
  if (!plantillaId) return null;
  return (PLANTILLAS[key] || []).find((p) => p.id === plantillaId) || null;
}

/* ======================= CARGA INICIAL ======================= */

// ramales_config ahora solo guarda, por ramal: qué plantilla está activa y
// qué unidad/conductor va en cada "cupo" de esa plantilla (slots).
// Requiere en Supabase las columnas: ramales_config.plantilla_id (text),
// ramales_config.slots (jsonb, default '[]').
async function loadRamalesConfig() {
  const { data, error } = await supabase.from('ramales_config').select('*');
  if (error) { console.error('Error cargando ramales_config:', error); return; }
  ramalesConfig = {};
  (data || []).forEach((r) => {
    ramalesConfig[r.ramal] = {
      ...r,
      plantilla_id: r.plantilla_id || null,
      slots: Array.isArray(r.slots) ? r.slots : [],
    };
  });
  RAMALES.forEach((key) => {
    if (!ramalesConfig[key]) ramalesConfig[key] = { ramal: key, plantilla_id: null, slots: [] };
  });
}

async function loadRosterH() {
  const [{ data: units }, { data: drivers }] = await Promise.all([
    supabase.from('units').select('id, unit_number, active').eq('active', true).order('unit_number'),
    supabase.from('drivers').select('id, name, route'),
  ]);
  unidadesH = (units || []).map((u) => ({ id: u.id, numero: u.unit_number }));
  conductoresH = (drivers || []).map((d) => ({ id: d.id, nombre: d.name || 'Conductor', route: d.route }));
}

async function loadCorridasHoy() {
  const hoy = todayStr();
  const { data, error } = await supabase.from('corridas').select('*').eq('fecha', hoy).order('slot_index');
  if (error) { console.error('Error cargando corridas:', error); return; }
  loadedDateStr = hoy;
  corridasPorRamal = { capilla: [], secundaria: [] };
  (data || []).forEach((c) => { if (corridasPorRamal[c.ramal]) corridasPorRamal[c.ramal].push(c); });
}

async function checkDayRollover() {
  if (loadedDateStr && loadedDateStr !== todayStr()) {
    await loadCorridasHoy();
    await ensureTablasGeneradas();
    renderHorarios();
  }
}

function initCorridasRealtime(onChange) {
  if (corridasChannel) supabase.removeChannel(corridasChannel);
  corridasChannel = supabase
    .channel('corridas-horarios-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'corridas' }, async () => {
      await loadCorridasHoy();
      onChange();
    })
    .subscribe();
}

/* ======================= APLICAR PLANTILLA ======================= */

// Reparte las corridas de la plantilla elegida entre los cupos (slots) que
// el checador llenó, rotando en orden: corrida 0 -> slot 0, corrida 1 ->
// slot 1, ... y al llegar al último cupo vuelve a empezar por el 0. Lo que
// ya salió hoy (hora_salida < ahorita) se queda tal cual quedó registrado
// — nunca se le mueve ni la hora ni el conductor a algo que ya salió.
async function aplicarPlantilla(key) {
  const cfg = ramalesConfig[key];
  const plantilla = getPlantilla(key, cfg.plantilla_id);
  if (!plantilla) { alert('Elige primero qué tabla de horarios se va a usar hoy.'); return; }

  const slots = cfg.slots || [];
  // Ya no hay tope: se rota entre TODOS los cupos que tengan unidad Y
  // conductor puestos, sean menos o más de los que "pide" la tabla.
  const cuposLlenos = slots.filter((s) => s && s.unit_id && s.driver_id);
  if (cuposLlenos.length === 0) {
    alert(`Pon por lo menos una unidad con su conductor para aplicar la tabla ${plantilla.nombre}.`);
    return;
  }

  const hoy = todayStr();
  const now = nowMinutes();
  const existentesPorIdx = new Map(corridasPorRamal[key].map((c) => [c.slot_index, c]));

  const rows = [];
  plantilla.corridas.forEach(([salida, asta], idx) => {
    const existente = existentesPorIdx.get(idx);
    // Solo se protege una corrida pasada si de verdad ya se fue con alguien
    // (ya tenía conductor). Si quedó vacía (nunca se le asignó nadie),
    // aplicar la tabla sí la debe poder llenar, aunque la hora ya haya
    // pasado en el reloj.
    if (existente && existente.hora_salida < now && existente.driver_id) return;
    const slot = cuposLlenos[idx % cuposLlenos.length];
    rows.push({
      ramal: key,
      fecha: hoy,
      slot_index: idx,
      unit_id: slot.unit_id,
      driver_id: slot.driver_id,
      hora_salida: salida,
      hora_llega: asta,
    });
  });

  if (rows.length) {
    const { error: upErr } = await supabase.from('corridas').upsert(rows, { onConflict: 'ramal,fecha,slot_index' });
    if (upErr) { console.error('Error aplicando plantilla:', upErr); throw upErr; }
  }

  // Si antes había una tabla más larga (o corridas sueltas) más allá de lo
  // que cubre esta plantilla, se borra lo que sobra — pero solo lo que no
  // ha salido, lo que ya pasó se respeta igual.
  const maxIdx = plantilla.corridas.length - 1;
  const aBorrar = corridasPorRamal[key].filter((c) => c.slot_index > maxIdx && c.hora_salida >= now);
  if (aBorrar.length) {
    const { error: delErr } = await supabase.from('corridas').delete().in('id', aBorrar.map((c) => c.id));
    if (delErr) console.error('Error limpiando renglones sobrantes:', delErr);
  }

  const { error: cfgErr } = await supabase.from('ramales_config')
    .upsert({ ramal: key, nombre: nombreRamal(key), plantilla_id: plantilla.id, slots }, { onConflict: 'ramal' });
  if (cfgErr) console.error('Error guardando la tabla elegida:', cfgErr);

  await loadCorridasHoy();
}

async function ensureTablasGeneradas() {
  for (const key of RAMALES) {
    const cfg = ramalesConfig[key];
    const plantilla = getPlantilla(key, cfg.plantilla_id);
    const listoParaAutoAplicar = plantilla && (cfg.slots || []).some((s) => s && s.unit_id && s.driver_id);
    if (corridasPorRamal[key].length === 0 && listoParaAutoAplicar) {
      try {
        await aplicarPlantilla(key);
      } catch (err) {
        console.error(`[horarios] No se pudo aplicar la tabla de "${key}" sola:`, err);
      }
    }
  }
}

/* ======================= PERSISTENCIA POR RENGLÓN (ajustes sueltos) ======================= */
function queueSave(corrida) {
  clearTimeout(saveQueue.get(corrida.id));
  saveQueue.set(corrida.id, setTimeout(async () => {
    const { error } = await supabase.from('corridas').update({
      unit_id: corrida.unit_id,
      driver_id: corrida.driver_id,
      hora_salida: corrida.hora_salida,
      hora_llega: corrida.hora_llega,
      updated_at: new Date().toISOString(),
    }).eq('id', corrida.id);
    if (error) console.error('Error guardando corrida:', error);
  }, 400));
}

function findCorrida(key, id) { return corridasPorRamal[key].find((c) => c.id === id); }

/* ======================= RENDER ======================= */
function unidadOptions(selectedId) {
  return '<option value="">—</option>' + unidadesH.map((u) => `<option value="${u.id}" ${u.id === selectedId ? 'selected' : ''}>${u.numero}</option>`).join('');
}
// Por comodidad se muestran primero los conductores de este ramal, pero se
// puede elegir cualquiera (a veces un conductor de otro ramal cubre un día).
function conductorOptions(selectedId, ramal) {
  const propios = conductoresH.filter((c) => c.route === ramal);
  const otros = conductoresH.filter((c) => c.route !== ramal);
  const opt = (c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${c.nombre}</option>`;
  let html = '<option value="">—</option>';
  if (propios.length) html += propios.map(opt).join('');
  if (otros.length) html += `<optgroup label="Otro ramal">${otros.map(opt).join('')}</optgroup>`;
  return html;
}

function renderHorarios() {
  const grid = document.getElementById('horariosGrid');
  if (!grid) return;
  // Guarda cuánto había bajado cada tabla antes de redibujar, para no
  // regresarlo a la fila 1 cada vez que llega una actualización.
  const scrollPos = {};
  RAMALES.forEach((key) => {
    const wrap = grid.querySelector(`.hz-table-wrap[data-wrap="${key}"]`);
    if (wrap) scrollPos[key] = wrap.scrollTop;
  });

  grid.innerHTML = '';
  RAMALES.forEach((key) => grid.appendChild(renderRamalCol(key)));

  RAMALES.forEach((key) => {
    const wrap = grid.querySelector(`.hz-table-wrap[data-wrap="${key}"]`);
    if (wrap && scrollPos[key]) wrap.scrollTop = scrollPos[key];
  });
  if (window.lucide) lucide.createIcons();
}

function nombreRamal(key) { return key === 'capilla' ? 'Por Capilla' : 'Por Secundaria'; }

function renderSlotsPicker(key, plantilla, slots) {
  const lista = slots.length ? slots : Array.from({ length: plantilla.unidades }, () => ({ unit_id: null, driver_id: null }));
  const filas = lista.map((slot, i) => `
    <div class="hz-slot-row">
      <span class="hz-slot-num">#${i + 1}</span>
      <select class="hz-slot-sel" data-ramal="${key}" data-slot="${i}" data-field="unit_id">${unidadOptions(slot.unit_id)}</select>
      <select class="hz-slot-sel" data-ramal="${key}" data-slot="${i}" data-field="driver_id">${conductorOptions(slot.driver_id, key)}</select>
      <button type="button" class="hz-slot-quitar" data-action="quitar-cupo" data-ramal="${key}" data-slot="${i}" title="Quitar esta unidad">×</button>
    </div>
  `).join('');
  return `
    <div class="hz-slots-wrap">
      <div class="hz-slots-label">Unidades y conductores de hoy (${lista.length})</div>
      <div class="hz-slots-grid">${filas}</div>
      <button type="button" class="hz-btn-agregar" data-action="agregar-cupo" data-ramal="${key}">+ Agregar unidad</button>
      <button type="button" class="hz-btn-aplicar" data-action="aplicar-plantilla" data-ramal="${key}">Aplicar tabla ${plantilla.nombre}</button>
    </div>
  `;
}

function renderRamalCol(key) {
  const cfg = ramalesConfig[key] || {};
  const plantillasDisponibles = PLANTILLAS[key] || [];
  const plantillaActual = getPlantilla(key, cfg.plantilla_id);
  const lista = corridasPorRamal[key];
  const now = nowMinutes();
  const siguienteIdx = lista.findIndex((c) => c.hora_salida >= now);

  const col = document.createElement('div');
  col.className = 'hz-ramal-col hz-' + key;
  col.innerHTML = `
    <div class="hz-ramal-head">
      <div class="hz-ramal-name">${nombreRamal(key)}</div>
      <div class="hz-config-row">
        <label>Tabla de horarios
          <select class="hz-plantilla-sel" data-ramal="${key}">
            <option value="">— Elegir —</option>
            ${plantillasDisponibles.map((p) => `<option value="${p.id}" ${p.id === cfg.plantilla_id ? 'selected' : ''}>${p.nombre}</option>`).join('')}
          </select>
        </label>
      </div>
      ${plantillaActual
        ? renderSlotsPicker(key, plantillaActual, cfg.slots || [])
        : '<div class="hz-empty-note">Elige una tabla (6x45, 7x45…) para asignar unidades y conductores.</div>'}
    </div>
    <div class="hz-table-wrap" data-wrap="${key}">
      <table class="hz-table">
        <thead><tr><th>Sale de base</th><th>Sale del asta</th><th>Unidad</th><th>Conductor</th></tr></thead>
        <tbody data-body="${key}"></tbody>
      </table>
    </div>
  `;

  const tbody = col.querySelector(`[data-body="${key}"]`);
  lista.forEach((c, i) => tbody.appendChild(renderCorridaRow(key, c, i === siguienteIdx, c.hora_salida < now)));
  if (lista.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4"><div class="hz-empty-note">Sin tabla aplicada todavía hoy.</div></td>`;
    tbody.appendChild(tr);
  }

  return col;
}

function renderCorridaRow(key, c, esSiguiente, yaPaso) {
  const row = document.createElement('tr');
  row.className = esSiguiente ? 'hz-row-siguiente' : (yaPaso ? 'hz-row-pasada' : '');
  row.innerHTML = `
    <td class="hz-corrida-time">${formatHora(c.hora_salida)}${esSiguiente ? '<span class="hz-next-tag">SIGUIENTE</span>' : ''}</td>
    <td class="hz-corrida-time">${formatHora(c.hora_llega)}</td>
    <td><select class="hz-sel" data-field="unit_id" data-ramal="${key}" data-id="${c.id}">${unidadOptions(c.unit_id)}</select></td>
    <td><select class="hz-sel" data-field="driver_id" data-ramal="${key}" data-id="${c.id}">${conductorOptions(c.driver_id, key)}</select></td>
  `;
  return row;
}

/* ======================= EVENTOS ======================= */

// Cambiar la tabla elegida: nada más actualiza el estado en memoria (no
// escribe corridas todavía) y ajusta el arreglo de cupos al nuevo tamaño de
// la plantilla, conservando lo que ya se había puesto donde alcance.
function handlePlantillaChange(e) {
  const t = e.target;
  if (!t.matches('.hz-plantilla-sel')) return;
  if (!document.getElementById('horarios')?.contains(t)) return;

  const key = t.dataset.ramal;
  const cfg = ramalesConfig[key];
  const nuevaId = t.value || null;
  const plantilla = getPlantilla(key, nuevaId);

  cfg.plantilla_id = nuevaId;
  const cuposAnteriores = cfg.slots || [];
  // Arranca con tantos cupos como pida la tabla, pero si ya había más
  // agregados a mano (de una tabla anterior) no se los quita.
  const nuevoLargo = plantilla ? Math.max(plantilla.unidades, cuposAnteriores.length) : 0;
  cfg.slots = plantilla
    ? Array.from({ length: nuevoLargo }, (_, i) => cuposAnteriores[i] || { unit_id: null, driver_id: null })
    : [];

  renderHorarios();
}

// Cambiar unidad/conductor de un cupo: nada más actualiza el estado en
// memoria — se manda a Supabase hasta que se aprieta "Aplicar tabla".
function handleSlotChange(e) {
  const t = e.target;
  if (!t.matches('.hz-slot-sel')) return;
  if (!document.getElementById('horarios')?.contains(t)) return;

  const key = t.dataset.ramal;
  const idx = Number(t.dataset.slot);
  const cfg = ramalesConfig[key];
  if (!cfg.slots[idx]) cfg.slots[idx] = { unit_id: null, driver_id: null };
  cfg.slots[idx][t.dataset.field] = t.value || null;
}

// Ajuste suelto directo sobre una corrida ya generada (por ejemplo, cambiar
// nada más un conductor de una salida específica sin tocar toda la tabla).
function handleHorariosSelectChange(e) {
  const t = e.target;
  if (!t.matches('.hz-sel')) return;
  if (!document.getElementById('horarios')?.contains(t)) return;
  const key = t.dataset.ramal;
  const c = findCorrida(key, t.dataset.id);
  if (c) { c[t.dataset.field] = t.value || null; queueSave(c); }
}

async function handleHorariosClick(e) {
  const t = e.target.closest('[data-action]');
  if (!t || !document.getElementById('horarios')?.contains(t)) return;

  if (t.dataset.action === 'agregar-cupo') {
    const key = t.dataset.ramal;
    const cfg = ramalesConfig[key];
    cfg.slots = [...(cfg.slots || []), { unit_id: null, driver_id: null }];
    renderHorarios();
    return;
  }

  if (t.dataset.action === 'quitar-cupo') {
    const key = t.dataset.ramal;
    const idx = Number(t.dataset.slot);
    const cfg = ramalesConfig[key];
    cfg.slots = (cfg.slots || []).filter((_, i) => i !== idx);
    renderHorarios();
    return;
  }

  if (t.dataset.action === 'aplicar-plantilla') {
    const textoOriginal = t.textContent;
    t.disabled = true; t.textContent = 'Aplicando…';
    try {
      await aplicarPlantilla(t.dataset.ramal);
      renderHorarios();
    } catch (err) {
      alert('No se pudo aplicar la tabla. Revisa tu conexión e intenta de nuevo.');
      console.error(err);
      t.disabled = false; t.textContent = textoOriginal;
    }
  }
}

// "Confirmar horarios": vuelve a guardar cada renglón (toca updated_at) para
// que el cambio llegue seguro a las tarjetas de los conductores aunque el
// realtime se haya quedado dormido, y avisa visualmente que ya se mandó.
async function confirmarHorarios() {
  const btn = document.getElementById('confirmarHorariosBtn');
  const msg = document.getElementById('horariosConfirmadoMsg');
  if (btn) { btn.disabled = true; btn.textContent = 'Confirmando…'; }
  try {
    const updates = [];
    RAMALES.forEach((key) => {
      corridasPorRamal[key].forEach((c) => {
        updates.push(
          supabase.from('corridas').update({
            unit_id: c.unit_id, driver_id: c.driver_id,
            hora_salida: c.hora_salida, hora_llega: c.hora_llega,
            updated_at: new Date().toISOString(),
          }).eq('id', c.id)
        );
      });
    });
    await Promise.all(updates);
    if (msg) { msg.classList.remove('hidden'); setTimeout(() => msg.classList.add('hidden'), 4000); }
  } catch (err) {
    console.error('Error confirmando horarios:', err);
    alert('No se pudo confirmar. Revisa tu conexión e intenta de nuevo.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Confirmar horarios'; }
  }
}

/* ======================= RELOJ ======================= */
async function tickHorarios() {
  await checkDayRollover();
  if (!document.getElementById('horarios')?.classList.contains('hidden')) renderHorarios();
}

/* ======================= INIT ======================= */
export async function initHorarios() {
  await Promise.all([loadRamalesConfig(), loadRosterH()]);
  await loadCorridasHoy();
  await ensureTablasGeneradas();
  renderHorarios();
  document.addEventListener('change', handlePlantillaChange);
  document.addEventListener('change', handleSlotChange);
  document.addEventListener('change', handleHorariosSelectChange);
  document.addEventListener('click', handleHorariosClick);
  document.getElementById('confirmarHorariosBtn')?.addEventListener('click', confirmarHorarios);
  initCorridasRealtime(() => renderHorarios());
  setInterval(tickHorarios, 20000);
}
