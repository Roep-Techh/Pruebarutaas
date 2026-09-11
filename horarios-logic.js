// horarios-logic.js (v2)
// Pestaña "Horarios" del panel del checador: tabla completa del día por
// ramal (Capilla / Secundaria), de hora_inicio a hora_fin cada X minutos.
// Cambiar el intervalo, la hora de inicio/fin, o el tiempo de vuelta
// redondo, regenera/recalcula toda la tabla sola. La asignación de unidad
// y conductor por renglón la sigue haciendo el checador a mano.

import { supabase } from './supabase-config.js';

const RAMALES = ['capilla', 'secundaria'];
let ramalesConfig = {}; // { capilla: {nombre, hora_inicio, hora_fin, intervalo, tiempo_vuelta}, ... }
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

/* ======================= CARGA INICIAL ======================= */
async function loadRamalesConfig() {
  const { data, error } = await supabase.from('ramales_config').select('*');
  if (error) { console.error('Error cargando ramales_config:', error); return; }
  ramalesConfig = {};
  (data || []).forEach((r) => { ramalesConfig[r.ramal] = r; });
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

/* ======================= GENERACIÓN DE LA TABLA ======================= */

// Reconstruye la tabla completa del ramal según su config actual. Conserva
// la unidad/conductor que ya tenía cada renglón (por posición), nada más
// mueve los horarios. Si el nuevo intervalo da menos renglones que antes,
// sobran filas viejas — se borran.
// Reconstruye la tabla del ramal según su config actual. Lo que ya pasó
// (hora_salida menor a ahorita) se queda tal cual quedó registrado — nunca
// se le mueve la hora a algo que ya salió, ni al checador ni al conductor.
// Nada más se recorren/regeneran los horarios que todavía faltan por salir.
async function regenerarRamal(key) {
  const cfg = ramalesConfig[key];
  const hoy = todayStr();
  const now = nowMinutes();
  const existentes = corridasPorRamal[key]; // ya vienen ordenadas por slot_index

  const pasadas = existentes.filter((c) => c.hora_salida < now);
  const futurasViejas = existentes.filter((c) => c.hora_salida >= now);

  // Punto de arranque para lo nuevo: si ya hubo salidas hoy, sigue el
  // intervalo justo después de la última — si no, arranca desde "desde".
  const inicioFuturo = pasadas.length
    ? pasadas[pasadas.length - 1].hora_salida + cfg.intervalo
    : cfg.hora_inicio;

  const timesFuturas = [];
  for (let t = Math.max(inicioFuturo, cfg.hora_inicio); t <= cfg.hora_fin; t += cfg.intervalo) timesFuturas.push(t);

  const rows = timesFuturas.map((horaSalida, i) => ({
    ramal: key,
    slot_index: pasadas.length + i,
    fecha: hoy,
    unit_id: futurasViejas[i]?.unit_id ?? null,
    driver_id: futurasViejas[i]?.driver_id ?? null,
    hora_salida: horaSalida,
    hora_llega: horaSalida + cfg.tiempo_vuelta,
  }));

  if (rows.length) {
    const { error: upErr } = await supabase.from('corridas').upsert(rows, { onConflict: 'ramal,fecha,slot_index' });
    if (upErr) { console.error('Error regenerando tabla:', upErr); throw upErr; }
  }

  const totalNuevo = pasadas.length + timesFuturas.length;
  if (existentes.length > totalNuevo) {
    const { error: delErr } = await supabase.from('corridas').delete()
      .eq('ramal', key).eq('fecha', hoy).gte('slot_index', totalNuevo);
    if (delErr) console.error('Error limpiando renglones sobrantes:', delErr);
  }

  await loadCorridasHoy();
}

// Solo cambió el tiempo de vuelta: no hay que mover horas de salida, nada
// más recalcular la columna de llegada de cada renglón que ya existe.
async function recalcularLlegadas(key) {
  const cfg = ramalesConfig[key];
  corridasPorRamal[key].forEach((c) => {
    c.hora_llega = c.hora_salida + cfg.tiempo_vuelta;
    queueSave(c);
  });
}

async function ensureTablasGeneradas() {
  for (const key of RAMALES) {
    if (corridasPorRamal[key].length === 0) {
      try {
        await regenerarRamal(key);
      } catch (err) {
        console.error(`[horarios] No se pudo generar la tabla de "${key}" sola:`, err);
      }
    }
  }
}

/* ======================= PERSISTENCIA POR RENGLÓN ======================= */
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

function unidadNombre(id) { return unidadesH.find((u) => u.id === id)?.numero || '—'; }
function conductorNombre(id) { return conductoresH.find((c) => c.id === id)?.nombre || '—'; }
function findCorrida(key, id) { return corridasPorRamal[key].find((c) => c.id === id); }

/* ======================= RENDER ======================= */
function unidadOptions(selectedId) {
  return '<option value="">—</option>' + unidadesH.map((u) => `<option value="${u.id}" ${u.id === selectedId ? 'selected' : ''}>${u.numero}</option>`).join('');
}
function conductorOptions(selectedId) {
  return '<option value="">—</option>' + conductoresH.map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${c.nombre}</option>`).join('');
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

function renderRamalCol(key) {
  const cfg = ramalesConfig[key] || {};
  const lista = corridasPorRamal[key];
  const now = nowMinutes();
  const siguienteIdx = lista.findIndex((c) => c.hora_salida >= now);

  const col = document.createElement('div');
  col.className = 'hz-ramal-col hz-' + key;
  col.innerHTML = `
    <div class="hz-ramal-head">
      <div class="hz-ramal-name">${cfg.nombre || key}</div>
      <div class="hz-config-row">
        <label>Desde <input type="text" class="hz-cfg-input" data-ramal="${key}" data-field="hora_inicio" value="${formatHora(cfg.hora_inicio)}"></label>
        <label>hasta <input type="text" class="hz-cfg-input" data-ramal="${key}" data-field="hora_fin" value="${formatHora(cfg.hora_fin)}"></label>
        <label>cada <input type="number" min="1" class="hz-cfg-input" data-ramal="${key}" data-field="intervalo" value="${cfg.intervalo}"> min</label>
        <label>vuelta redonda <input type="number" min="1" class="hz-cfg-input" data-ramal="${key}" data-field="tiempo_vuelta" value="${cfg.tiempo_vuelta}"> min</label>
      </div>
    </div>
    <div class="hz-table-wrap" data-wrap="${key}">
      <table class="hz-table">
        <thead><tr><th>Sale</th><th>Llega</th><th>Unidad</th><th>Conductor</th></tr></thead>
        <tbody data-body="${key}"></tbody>
      </table>
    </div>
  `;

  const tbody = col.querySelector(`[data-body="${key}"]`);
  lista.forEach((c, i) => tbody.appendChild(renderCorridaRow(key, c, i === siguienteIdx, c.hora_salida < now)));
  if (lista.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4"><div class="hz-empty-note">Sin tabla generada todavía.</div>
      <button type="button" class="hz-btn-generar" data-action="generar-tabla" data-ramal="${key}">Generar tabla</button></td>`;
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
    <td><select class="hz-sel" data-field="driver_id" data-ramal="${key}" data-id="${c.id}">${conductorOptions(c.driver_id)}</select></td>
  `;
  return row;
}

/* ======================= EVENTOS ======================= */
function parseHoraTexto(txt) {
  const m = String(txt).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

async function handleHorariosChange(e) {
  const t = e.target;
  if (!t.matches('.hz-cfg-input')) return;
  if (!document.getElementById('horarios')?.contains(t)) return;

  const key = t.dataset.ramal;
  const field = t.dataset.field;
  const cfg = ramalesConfig[key];

  if (field === 'hora_inicio' || field === 'hora_fin') {
    const val = parseHoraTexto(t.value);
    if (val === null) { t.value = formatHora(cfg[field]); return; }
    cfg[field] = val;
    await supabase.from('ramales_config').update({ [field]: val }).eq('ramal', key);
    await regenerarRamal(key);
    renderHorarios();
    return;
  }

  if (field === 'intervalo') {
    const val = parseInt(t.value, 10);
    if (!val || val <= 0) { t.value = cfg.intervalo; return; }
    cfg.intervalo = val;
    await supabase.from('ramales_config').update({ intervalo: val }).eq('ramal', key);
    await regenerarRamal(key);
    renderHorarios();
    return;
  }

  if (field === 'tiempo_vuelta') {
    const val = parseInt(t.value, 10);
    if (!val || val <= 0) { t.value = cfg.tiempo_vuelta; return; }
    cfg.tiempo_vuelta = val;
    await supabase.from('ramales_config').update({ tiempo_vuelta: val }).eq('ramal', key);
    await recalcularLlegadas(key);
    renderHorarios();
    return;
  }
}

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

  if (t.dataset.action === 'generar-tabla') {
    t.disabled = true; t.textContent = 'Generando…';
    try {
      await regenerarRamal(t.dataset.ramal);
      renderHorarios();
    } catch (err) {
      alert('No se pudo generar la tabla. Revisa tu conexión e intenta de nuevo.');
      console.error(err);
      renderHorarios();
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
  document.addEventListener('change', handleHorariosChange);
  document.addEventListener('change', handleHorariosSelectChange);
  document.addEventListener('click', handleHorariosClick);
  document.getElementById('confirmarHorariosBtn')?.addEventListener('click', confirmarHorarios);
  initCorridasRealtime(() => renderHorarios());
  setInterval(tickHorarios, 20000);
}
