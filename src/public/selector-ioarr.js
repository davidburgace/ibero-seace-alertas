// Selector IOARR — interfaz. Los datos y el cálculo viven en selector-ioarr-worker.js;
// los proyectos se guardan en Supabase vía /api/selector-ioarr/* (sesión de sesion.js).
import { CRIT, DEF, ITEMS, NIVN, NIVS, NIVB, FILTRO_VACIO, limpiarParams, coordValidas, urlGoogleMaps, urlMapaEmbed, piTexto } from '/selector-ioarr/calculo.js';
import { renderExpediente, enlazarExpediente } from '/selector-ioarr-expediente.js';
import { limitarN, MAX_PUNTOS } from '/selector-ioarr/cercania.js';
import { crearMapa as crearMapaLocales, fmtKm } from '/selector-ioarr-mapa.js';
import { htmlListado } from '/selector-ioarr-listado.js';
import { limitarPorDia, colorDia, generarKML, AVISO_VISITAS } from '/selector-ioarr/visitas.js';

const ANIO = 2025;
const BASE_DATOS = `/data/selector-ioarr/${ANIO}/`;
const PAGE = 40;
const FALTANTE = 'Faltante (brecha de dotación, no reposición)';
const DUP = 'Otra inversión vigente o reciente';
const ESTADO_DUP = { si: 'Sí', no: 'No', sin_verificar: 'Sin verificar' };
const dupDe = cod => S.dup[cod] || { estado: 'sin_verificar', codigo: null, nota: null, excluir: false };
const LS = 'selector-ioarr:';
const NF = new Intl.NumberFormat('es-PE');
const fmt = n => NF.format(Math.round(n || 0));
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function store(k, v) {
  try {
    if (v === undefined) { const r = localStorage.getItem(LS + k); return r == null ? null : JSON.parse(r); }
    if (v === null) localStorage.removeItem(LS + k); else localStorage.setItem(LS + k, JSON.stringify(v));
  } catch { return null; }
}
function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3800); }

// ─── Worker ──────────────────────────────────────────────────────────────────
const worker = new Worker('/selector-ioarr-worker.js', { type: 'module' });
const pendientes = new Map(); let sigId = 0;
worker.onmessage = ({ data }) => { const p = pendientes.get(data.id); if (!p) return; pendientes.delete(data.id); data.ok ? p.ok(data.r) : p.mal(new Error(data.error)); };
worker.onerror = e => { console.error('Worker', e); toast('Error en el cálculo: ' + (e.message || 'recarga la página')); };
const w = (tipo, args = {}) => new Promise((ok, mal) => { const id = ++sigId; pendientes.set(id, { ok, mal }); worker.postMessage({ id, tipo, ...args }); });

// ─── API ─────────────────────────────────────────────────────────────────────
async function api(ruta, { method = 'GET', body } = {}) {
  const r = await fetch('/api/selector-ioarr' + ruta, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'Error ' + r.status); e.status = r.status; throw e; }
  return data;
}

// ─── Estado ──────────────────────────────────────────────────────────────────
const S = {
  idx: null, region: null, meta: null, cargando: false,
  proyectos: [], proyecto: null, sinBase: false,       // proyecto null = borrador (solo en este navegador)
  params: { ...DEF }, sel: new Set(),
  f: FILTRO_VACIO(), sort: { key: 'rep', dir: -1 }, page: 0, open: new Set(), detalles: new Map(),
  mapas: new Set(), mapsKey: null,                     // mapas satelitales abiertos (índice de local) y llave de Maps Embed
  tab: 'elegir', seq: 0, selPage: 0,
  dup: {}, sinMigDup: false,                           // otra inversión vigente o reciente por local (solo proyectos guardados)
  revSit: {}, sit: null,                               // estado situacional: advertencias explicadas y último cuadro calculado
  near: null,                                          // búsqueda por cercanía: { lat, lon, n, label }
  pick: false, mapaOn: false, mapa: null, mapaCreando: null, ajustarMapa: false,  // mapa de locales (Leaflet)
  listaOn: false,                                      // listado con direcciones de los N cercanos
  vis: null                                            // días de visita: { porDia, dia (0 = todos), R: resultado del worker }
};
const nearArg = () => S.near ? { lat: S.near.lat, lon: S.near.lon, n: S.near.n } : null;

// ─── Guardado (borrador en localStorage, proyecto en Supabase) ──────────────
const guardado = { sel: null, crit: null, enCurso: 0, error: false };
function pintarGuardado() {
  const el = $('estado-guardado');
  if (!S.proyecto) {
    el.className = 'guardado';
    el.textContent = S.sinBase ? 'Borrador en este navegador · los proyectos no están disponibles (falta la migración 011 en Supabase)'
      : 'Borrador en este navegador · crea un proyecto para guardarlo y exportarlo';
    return;
  }
  const pend = guardado.sel || guardado.crit || guardado.enCurso;
  el.className = 'guardado ' + (guardado.error ? 'error' : pend ? 'pend' : 'ok');
  el.textContent = guardado.error ? 'No se pudo guardar. Revisa tu conexión; se reintentará con el próximo cambio.' : pend ? 'Guardando…' : 'Guardado';
}
function programar(tipo) {
  if (!S.proyecto) return;
  clearTimeout(guardado[tipo]);
  guardado[tipo] = setTimeout(() => ejecutar(tipo), 700);
  pintarGuardado();
}
async function ejecutar(tipo) {
  clearTimeout(guardado[tipo]); guardado[tipo] = null;
  const p = S.proyecto; if (!p) return;
  guardado.enCurso++; pintarGuardado();
  try {
    if (tipo === 'sel') await api(`/proyectos/${p.id}/locales`, { method: 'PUT', body: { locales: [...S.sel] } });
    else await api(`/proyectos/${p.id}`, { method: 'PATCH', body: { criterios: S.params } });
    guardado.error = false;
  } catch (e) { console.error(e); guardado.error = true; }
  finally { guardado.enCurso--; pintarGuardado(); }
}
async function guardarYa() {
  const tareas = [];
  if (guardado.sel) tareas.push(ejecutar('sel'));
  if (guardado.crit) tareas.push(ejecutar('crit'));
  await Promise.all(tareas);
  while (guardado.enCurso) await new Promise(r => setTimeout(r, 100));
  if (guardado.error) throw new Error('No se pudieron guardar los últimos cambios');
}
window.addEventListener('beforeunload', e => { if (guardado.sel || guardado.crit || guardado.enCurso) { e.preventDefault(); e.returnValue = ''; } });

function persistirSel() { if (S.proyecto) programar('sel'); else store('sel:' + S.region, [...S.sel]); }
function persistirCrit() { if (S.proyecto) programar('crit'); else store('params', S.params); }

// ─── Arranque ────────────────────────────────────────────────────────────────
async function boot() {
  bind();
  // Llave de Maps Embed (opcional); sin ella el mapa usa el embed sin llave
  api('/config').then(c => { S.mapsKey = c.mapsKey || null; }).catch(() => {});
  try { S.idx = await fetch(BASE_DATOS + 'index.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  catch { $('count').innerHTML = '<span class="err">No se pudo cargar la lista de regiones.</span>'; return; }
  const opts = S.idx.regiones.map(g => `<option value="${esc(g.nombre)}">${esc(g.nombre)} (${fmt(g.locales)} locales)</option>`).join('');
  $('region').innerHTML = opts; $('m-region').innerHTML = opts;
  $('foot').textContent = `Fuentes: ${S.idx.fuente}. Son datos declarados por cada colegio y no están validados. Incluye servicios públicos escolarizados de Inicial, Primaria, Secundaria y Básica Especial. No hay datos de antigüedad ni de costos.`;
  await listarProyectos();
  // ?proyecto=<id>&tab=exp abre un proyecto y su pestaña (enlace desde Radar IOARR)
  const q = new URLSearchParams(location.search), pedido = q.get('proyecto');
  const ultimo = pedido && S.proyectos.some(p => p.id === pedido) ? pedido : store('proyecto');
  if (pedido && ultimo !== pedido) toast('Ese proyecto no está entre los tuyos: solo su dueño puede abrirlo.');
  if (ultimo && S.proyectos.some(p => p.id === ultimo)) await abrirProyecto(ultimo);
  else await abrirBorrador(store('region'));
  if (q.get('tab') && ['elegir', 'sel', 'exp'].includes(q.get('tab'))) setTab(q.get('tab'));
  if (pedido) history.replaceState(null, '', location.pathname);
}

async function listarProyectos() {
  try { S.proyectos = await api('/proyectos'); S.sinBase = false; }
  catch (e) { S.proyectos = []; S.sinBase = e.status === 503; if (!S.sinBase) toast('No se pudieron leer tus proyectos: ' + e.message); }
  pintarProyectos();
}
function pintarProyectos() {
  $('proy').innerHTML = '<option value="">— Borrador sin guardar —</option>' + S.proyectos.map(p =>
    `<option value="${p.id}">${esc(p.nombre)} · ${esc(p.region)} (${fmt(p.n_locales)})</option>`).join('');
  $('proy').value = S.proyecto?.id || '';
  const hay = !!S.proyecto;
  for (const id of ['btn-renombrar', 'btn-duplicar', 'btn-borrar']) $(id).disabled = !hay;
  $('btn-nuevo').disabled = S.sinBase;
  $('proy').disabled = S.sinBase;
  $('region').disabled = hay;
  $('region').title = hay ? 'La región es parte del proyecto. Para otra región, crea un proyecto nuevo.' : '';
  const v = $('btn-vinculo'); v.hidden = !hay;
  if (hay) {
    const io = S.proyecto.ioarr;
    v.classList.toggle('activo', !!io);
    v.textContent = io ? `Radar IOARR: CUI ${io.cui} — ${io.nombre.length > 60 ? io.nombre.slice(0, 60) + '…' : io.nombre}` : '+ Vincular con Radar IOARR';
  }
  pintarGuardado();
}

async function abrirBorrador(region) {
  await guardarYa().catch(() => {});
  S.proyecto = null; store('proyecto', null); S.dup = {}; S.sinMigDup = false; S.revSit = {};
  const nombre = S.idx.regiones.some(g => g.nombre === region) ? region : (S.idx.regiones.find(g => g.nombre === 'Moquegua') || S.idx.regiones[0]).nombre;
  pintarProyectos();
  await cargarRegion(nombre, limpiarParams(store('params')), store('sel:' + nombre) || []);
  store('region', nombre);
}

async function abrirProyecto(id) {
  try { await guardarYa(); } catch (e) { if (!confirm(e.message + '. ¿Cambiar de proyecto de todas formas?')) { $('proy').value = S.proyecto?.id || ''; return; } }
  let p;
  try { p = await api('/proyectos/' + id); }
  catch (e) { toast('No se pudo abrir el proyecto: ' + e.message); $('proy').value = S.proyecto?.id || ''; return; }
  S.proyecto = p; guardado.error = false; store('proyecto', p.id);
  S.dup = p.duplicidad || {}; S.sinMigDup = !!p.sin_migracion_dup; S.revSit = p.revisiones_situacional || {};
  pintarProyectos();
  await cargarRegion(p.region, limpiarParams(p.criterios), p.locales || []);
}

async function cargarRegion(nombre, params, codigos) {
  const g = S.idx.regiones.find(r => r.nombre === nombre);
  if (!g) { toast('No hay datos para la región ' + nombre); return; }
  S.cargando = true; $('region').value = nombre;
  S.params = params; S.sel = new Set(codigos);
  S.f = FILTRO_VACIO(); S.page = 0; S.open.clear(); S.detalles.clear(); S.mapas.clear();
  S.near = null; S.pick = false; S.ajustarMapa = true; S.mapa?.modoElegir(false);
  S.vis = null; renderVisitas();
  renderCrit();
  if (S.region !== nombre || !S.meta) {
    $('count').textContent = `Cargando ${g.nombre}…`; $('tbody').innerHTML = ''; document.body.classList.add('cargando');
    try { S.meta = await w('cargar', { url: BASE_DATOS + g.archivo, params }); }
    catch (e) { $('count').innerHTML = `<span class="err">No se pudo cargar ${esc(g.nombre)}: ${esc(e.message)}</span>`; S.cargando = false; return; }
    finally { document.body.classList.remove('cargando'); }
    S.region = nombre;
  } else await w('params', { params });
  await w('sel', { codigos: [...S.sel] });
  await w('duplicidad', { mapa: S.dup });
  fillFilters();
  S.cargando = false;
  await refresh();
}

// ─── Filtros ─────────────────────────────────────────────────────────────────
function fillFilters() {
  const M = S.meta;
  $('fprov').innerHTML = '<option value="-1">Todas</option>' + M.provs.map((p, i) => `<option value="${i}">${esc(p)}</option>`).join('');
  $('fugel').innerHTML = '<option value="-1">Todas</option>' + M.ugels.map((p, i) => `<option value="${i}">${esc(p)}</option>`).join('');
  fillDist();
  $('fniv').innerHTML = Object.keys(NIVN).map(k => `<button type="button" class="chip" data-n="${k}" aria-pressed="${!!(S.f.niv & NIVB[k])}">${NIVS[k]}</button>`).join('');
  $('q').value = S.f.q; $('fprov').value = S.f.prov; $('fugel').value = S.f.ugel; $('farea').value = S.f.area; $('fges').value = S.f.ges;
  $('frep').value = S.f.rep || ''; $('fest').value = S.f.est || ''; $('fcenso').checked = S.f.censo;
  const ds = M.dists.map((d, i) => [d[0], i]).sort((a, b) => a[0].localeCompare(b[0], 'es'));
  $('nDist').innerHTML = '<option value="-1">Elegir distrito…</option>' + ds.map(([n, i]) => `<option value="${i}">${esc(n)} · ${esc(M.provs[M.dists[i][1]] || '')}</option>`).join('');
  $('nCod').value = '';
}
function fillDist() {
  $('fdist').innerHTML = '<option value="-1">Todos</option>' + S.meta.dists.map((d, i) => [d, i]).filter(([d]) => S.f.prov < 0 || d[1] === S.f.prov)
    .map(([d, i]) => `<option value="${i}">${esc(d[0])}</option>`).join('');
  $('fdist').value = String(S.f.dist);
}

// ─── Tabla ───────────────────────────────────────────────────────────────────
const COLS = [['', '', 0, 'ck'], ['Código de local', 'cod', 0, 'cod'], ['Instituciones', 'nom', 0, 'nom'], ['Distrito · centro poblado', 'dist', 0, 'dist'],
  ['Área', '', 0, 'area'], ['Estudiantes', 'est', 1, 'est'], ['Aulas', 'aul', 1, 'aul'], ['A reponer', 'rep', 1, 'rep'], ['% del requerido', 'pct', 1, 'pct'], ['', '', 0, 'x']];
// Con cercanía: columna de distancia y orden fijo por distancia (los encabezados no ordenan)
const cols = () => S.near ? [...COLS.slice(0, -1), ['Distancia (km)', '', 1, 'km'], COLS[COLS.length - 1]] : COLS;
function renderHead() {
  $('thead').innerHTML = cols().map(([t, k, n]) => {
    if (!k || S.near) return `<th class="${n ? 'num' : ''}">${t}</th>`;
    const s = S.sort.key === k ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none';
    return `<th class="s ${n ? 'num' : ''}" data-k="${k}" aria-sort="${s}" tabindex="0">${t}</th>`;
  }).join('');
}

async function detalleHTML(i) {
  if (!S.detalles.has(i)) S.detalles.set(i, await w('detalle', { i }));
  const d = S.detalles.get(i);
  const sv = d.servicios.map(s => `<tr><td class="mono">${esc(s.mod)}</td><td>${s.niv}</td><td>${esc(s.nom)}</td><td>${s.conv ? 'Convenio' : 'Directa'}</td><td class="num">${fmt(s.est)}</td><td class="num">${fmt(s.sec)}</td><td class="num">${fmt(s.aulas)}</td><td>${esc(s.tur)}</td></tr>`).join('');
  const au = d.aulas.map(a => `<tr><td>${esc(a.aula)}</td><td>${esc(a.edif)} · piso ${a.piso}</td><td>${esc(a.grado)}${a.secc ? ' ' + esc(a.secc) : ''}</td><td>${esc(a.tur)}${a.comp ? ' (compartida)' : ''}</td><td class="num">${a.est}</td>` +
    a.t.map(o => `<td class="num"><span title="Bueno / Regular / Malo">${fmt(o.b)} / ${fmt(o.r)} / <b>${fmt(o.m)}</b></span>${o.fal ? `<br><span class="sub" title="${FALTANTE}">faltan ${fmt(o.fal)}</span>` : ''}</td>`).join('') + '</tr>').join('');
  return `<div class="detalle">
    ${ubicacionHTML(i, d)}
    <div><h4>Servicios educativos del local</h4><div class="tabla-wrap"><table class="tabla"><thead><tr><th>Cód. modular</th><th>Nivel</th><th>Institución</th><th>Gestión</th><th class="num">Estudiantes</th><th class="num">Secciones</th><th class="num">Aulas (censo)</th><th>Turno</th></tr></thead><tbody>${sv}</tbody></table></div></div>
    <div><h4>Aulas en uso (bueno / regular / <b>malo = a reponer</b>)</h4><p class="sub">«Faltan» es el faltante: brecha de dotación, no reposición.</p>${au ? `<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Aula</th><th>Ubicación</th><th>Grado y sección</th><th>Turno</th><th class="num">Estud.</th>${ITEMS.map(x => `<th class="num">${x.n}</th>`).join('')}</tr></thead><tbody>${au}</tbody></table></div>` : '<p class="sub">El censo no registra aulas en uso para este local.</p>'}</div>
  </div>`;
}

// ─── Ubicación y mapa satelital ─────────────────────────────────────────────
function ubicacionHTML(i, d) {
  if (!coordValidas(d.lat, d.lon)) return `<div class="ubic"><h4>Ubicación</h4><p class="sub">Este local no tiene coordenadas válidas en el padrón</p></div>`;
  const abierto = S.mapas.has(i);
  return `<div class="ubic"><h4>Ubicación</h4>
    <p class="coords">Latitud <span class="mono">${d.lat}</span> · Longitud <span class="mono">${d.lon}</span></p>
    <div class="ubic-acc">
      <button class="btn btn-ghost btn-sm" type="button" data-mapa-btn="${i}" aria-expanded="${abierto}" aria-controls="mapa-${i}">${abierto ? 'Ocultar vista satelital' : 'Ver vista satelital'}</button>
      <a class="btn btn-ghost btn-sm" href="${urlGoogleMaps(d.lat, d.lon)}" target="_blank" rel="noopener">Abrir en Google Maps</a>
    </div>
    <p class="sub">Coordenadas declaradas en el padrón de ESCALE; pueden tener error.</p>
    <div class="mapa" id="mapa-${i}" data-mapa="${i}" ${abierto ? '' : 'hidden'}></div></div>`;
}
// El iframe se crea solo al pedir la vista satelital (nunca al abrir el detalle)
function crearMapa(cont) {
  const d = S.detalles.get(+cont.dataset.mapa), f = document.createElement('iframe');
  f.dataset.mapa = cont.dataset.mapa;
  f.src = urlMapaEmbed(d.lat, d.lon, S.mapsKey);
  f.loading = 'lazy'; f.title = `Vista satelital del local ${d.cod}`;
  f.referrerPolicy = 'no-referrer-when-downgrade';   // la llave está restringida por referrer
  f.allowFullscreen = true;
  cont.append(f);
}
// moveBefore conserva el iframe sin recargarlo; sin él, el navegador lo recarga al moverlo
const reservaMapas = Object.assign(document.createElement('div'), { hidden: true });
document.body.append(reservaMapas);
const mover = (padre, nodo) => { try { if (padre.moveBefore) return padre.moveBefore(nodo, null); } catch { /* sigue con append */ } padre.append(nodo); };
function toggleMapa(btn) {
  const i = +btn.dataset.mapaBtn, cont = $('mapa-' + i), abrir = !S.mapas.has(i);
  abrir ? S.mapas.add(i) : S.mapas.delete(i);
  btn.setAttribute('aria-expanded', abrir); btn.textContent = abrir ? 'Ocultar vista satelital' : 'Ver vista satelital';
  cont.hidden = !abrir;
  if (abrir && !cont.querySelector('iframe')) crearMapa(cont);
  if (!abrir) cont.replaceChildren();               // libera el mapa al ocultarlo
}

async function renderTable() {
  const seq = ++S.seq;
  $('tbody').classList.add('cargando-tabla');
  const R = await w('consulta', { f: S.f, sort: S.sort, page: S.page, size: PAGE, near: nearArg() });
  if (seq !== S.seq) return;          // llegó una consulta más nueva
  S.page = R.page;
  const det = new Map();
  for (const r of R.filas) if (S.open.has(r.i)) det.set(r.i, await detalleHTML(r.i));
  if (seq !== S.seq) return;
  $('tbody').classList.remove('cargando-tabla');
  // Guarda los mapas abiertos antes de redibujar, para devolverlos a su fila
  for (const f of $('tbody').querySelectorAll('iframe[data-mapa]')) if (S.mapas.has(+f.dataset.mapa)) mover(reservaMapas, f);
  const nc = cols().length;
  if (!R.filas.length) $('tbody').innerHTML = `<tr><td colspan="${nc}" class="vacio">${S.near ? 'Ningún local con coordenadas válidas cumple los filtros. Prueba con menos condiciones.' : 'Ningún local cumple los filtros. Prueba con menos condiciones.'}</td></tr>`;
  else $('tbody').innerHTML = R.filas.map(r => {
    const sel = S.sel.has(r.cod), open = S.open.has(r.i);
    const dup = dupDe(r.cod);
    const pills = r.niv.map(n => `<span class="pill">${n}</span>`).join('') + (r.conv ? '<span class="pill conv">Convenio</span>' : '')
      + (dup.estado === 'si' ? `<span class="pill dup" title="${DUP}${dup.codigo ? ': ' + esc(dup.codigo) : ''}">Otra inversión${dup.excluir ? ' · excluido' : ''}</span>` : '');
    return `<tr class="${sel ? 'sel' : ''}">
      <td class="c-ck"><input class="ck" type="checkbox" data-cod="${r.cod}" ${sel ? 'checked' : ''} aria-label="Seleccionar el local ${r.cod}"></td>
      <td class="c-cod mono">${r.cod}</td>
      <td class="c-nom"><span class="nm">${esc(r.nom)}</span>${pills}</td>
      <td class="c-dist">${esc(r.dist)}<br><span class="sub">${esc(r.cp)} · ${r.rural ? 'Rural' : 'Urbana'}</span></td>
      <td class="c-area">${r.rural ? 'Rural' : 'Urbana'}</td>
      <td class="c-est num" data-label="Estudiantes">${fmt(r.est)}</td>
      <td class="c-aul num" data-label="Aulas">${fmt(r.aul)}</td>
      <td class="c-rep num" data-label="A reponer"><b>${fmt(r.rep)}</b></td>
      <td class="c-pct num" data-label="% del requerido">${r.pct == null ? '<span class="sub">—</span>' : `<span class="meter"><i><b style="width:${Math.min(100, r.pct * 100)}%"></b></i>${Math.round(r.pct * 100)}%</span>`}</td>
      ${S.near ? `<td class="c-km num" data-label="Distancia (km)">${fmtKm(r.km)}</td>` : ''}
      <td class="c-x"><button class="x" data-near="${r.cod}" type="button" ${r.coord ? '' : 'disabled title="Sin coordenadas válidas en el padrón"'} aria-label="Ver los locales más cercanos al local ${r.cod}">Cercanos</button><button class="x" data-x="${r.i}" type="button" aria-expanded="${open}" aria-label="Ver detalle del local ${r.cod}">${open ? 'Ocultar' : 'Detalle'}</button></td></tr>`
      + (open ? `<tr class="det"><td colspan="${nc}">${det.get(r.i)}</td></tr>` : '');
  }).join('');
  for (const cont of $('tbody').querySelectorAll('.mapa[data-mapa]:not([hidden])')) {
    const f = reservaMapas.querySelector(`iframe[data-mapa="${cont.dataset.mapa}"]`);
    f ? mover(cont, f) : crearMapa(cont);
  }
  reservaMapas.replaceChildren();                    // mapas de filas que ya no están en esta página
  $('pgInfo').textContent = R.total ? `Mostrando ${fmt(R.page * PAGE + 1)}–${fmt(Math.min(R.total, R.page * PAGE + PAGE))} de ${fmt(R.total)}` : '';
  $('pgNum').textContent = `${R.page + 1} / ${R.pages}`;
  $('pgPrev').disabled = R.page === 0; $('pgNext').disabled = R.page >= R.pages - 1;
  $('count').innerHTML = `<b>${fmt(R.total)}</b> locales · ${fmt(R.est)} estudiantes · ${fmt(R.aul)} aulas en el censo · <span class="sub">${fmt(R.nsel)} ya seleccionados</span>`;
  $('selAll').textContent = `Seleccionar los ${fmt(R.total)} filtrados`;
  $('selAll').disabled = !R.total; $('unselAll').disabled = !R.nsel;
  S.cerca = R.cerca; renderCerca();
  renderListado();
  if (S.mapaOn) renderMapa();
}

// ─── Búsqueda por cercanía ──────────────────────────────────────────────────
function renderCerca(c = S.cerca) {
  $('nClr').hidden = !S.near && !S.pick;
  $('nPick').setAttribute('aria-pressed', S.pick);
  const el = $('nInfo');
  if (!S.near) { el.textContent = S.pick ? 'Toca el mapa para fijar el centro de la búsqueda.' : 'Sin búsqueda por cercanía.'; return; }
  const om = c?.omitidos ? ` · ${fmt(c.omitidos)} local${c.omitidos === 1 ? '' : 'es'} sin coordenadas válidas no se consideran` : '';
  el.innerHTML = c?.n
    ? `<b>${fmt(c.n)}</b> local${c.n === 1 ? '' : 'es'} más cercano${c.n === 1 ? '' : 's'} al ${esc(S.near.label)} · el más lejano a <b>${fmtKm(c.max)} km</b> en línea recta${om}`
    : `Ningún local con coordenadas cerca del ${esc(S.near.label)} cumple los filtros${om}`;
}
// Listado con direcciones de los N cercanos, en el mismo orden que la tabla y el mapa
async function renderListado() {
  $('nList').hidden = !S.near;
  if (!S.near) S.listaOn = false;
  $('listaWrap').hidden = !S.listaOn;
  $('nList').textContent = S.listaOn ? 'Ocultar listado' : 'Ver listado';
  $('nList').setAttribute('aria-expanded', S.listaOn);
  if (!S.listaOn) return;
  const filas = await w('listado');
  $('listaInfo').textContent = `${fmt(filas.length)} local${filas.length === 1 ? '' : 'es'} de más cercano a más lejano del ${S.near.label}. Distancias en línea recta. «Cómo llegar» abre la ruta en Google Maps desde tu ubicación.`;
  $('listaBox').innerHTML = htmlListado(filas);
}
async function verEnMapa(cod) {
  if (!S.mapaOn) { S.mapaOn = true; await renderMapa(); }
  $('mapaWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!S.mapa?.enfocar(cod)) toast('Ese local no está en el mapa.');
}
function setNear(c) {
  const n = limitarN($('nN').value); $('nN').value = n;
  S.near = { lat: c.lat, lon: c.lon, n, label: c.label };
  S.pick = false; S.mapa?.modoElegir(false);
  S.mapaOn = true; S.ajustarMapa = true; S.page = 0;
  refresh();
}
async function buscarCentro(args) {
  const c = await w('centro', args);
  if (c.error) { toast(c.error); return; }
  setNear(c);
}
function quitarCerca() {
  S.near = null; S.pick = false; S.mapa?.modoElegir(false); S.ajustarMapa = true; S.page = 0;
  refresh();
}

// ─── Mapa de locales ────────────────────────────────────────────────────────
function avisoMapa(txt, alerta) { const a = $('mapaAviso'); a.hidden = !txt; a.textContent = txt || ''; a.classList.toggle('alerta', !!alerta); }
async function asegurarMapa() {
  if (S.mapa) return S.mapa;
  S.mapaCreando ||= crearMapaLocales($('mapaBox'), {
    onPunto: (lat, lon) => setNear({ lat, lon, label: 'punto elegido en el mapa' }),
    onSel: async cod => { S.sel.has(cod) ? S.sel.delete(cod) : S.sel.add(cod); await cambioSel(); refresh(); }
  }).then(m => { S.mapa = m; S.ajustarMapa = true; return m; })
    .finally(() => { S.mapaCreando = null; });
  return S.mapaCreando;
}
async function renderMapa() {
  $('mapaWrap').hidden = !S.mapaOn;
  $('nMap').textContent = S.mapaOn ? 'Ocultar mapa' : 'Ver mapa de los filtrados';
  $('nMap').setAttribute('aria-expanded', S.mapaOn);
  if (!S.mapaOn) { $('nBase').hidden = true; return; }
  let m;
  try { m = await asegurarMapa(); }
  catch (e) {
    console.error('Mapa', e);
    $('mapaBox').hidden = true; $('nBase').hidden = true;
    avisoMapa(`No se pudo cargar el mapa (${e.message}). La lista por cercanía sigue funcionando; revisa tu conexión y vuelve a intentarlo.`, true);
    return;
  }
  $('mapaBox').hidden = false; $('nBase').hidden = false;
  m.modoElegir(S.pick);
  $('mapaLeyenda').hidden = !!S.vis;
  if (S.vis) {
    const clave = JSON.stringify(['vis', S.region, S.vis.dia, S.vis.porDia, S.vis.R.codigos.length]);
    const ajustar = S.ajustarMapa || clave !== S.mapaClave; S.ajustarMapa = false; S.mapaClave = clave;
    // Con todos los días a la vista, como máximo MAX_PUNTOS puntos (días completos)
    // (con un día elegido: ese día primero y los demás en gris hasta el tope)
    const todos = S.vis.R.dias, act = todos.find(d => d.dia === S.vis.dia);
    const dias = act ? [act] : []; let n = act ? act.puntos.length : 0;
    for (const d of todos) { if (d === act) continue; if (dias.length && n + d.puntos.length > MAX_PUNTOS) break; dias.push(d); n += d.puntos.length; }
    m.pintarVisitas(dias, S.vis.dia, ajustar, todos.length);
    const sc = S.vis.R.sinCoord.length;
    avisoMapa(`Mapa de los días de visita${S.vis.dia ? ` · día ${S.vis.dia} resaltado` : ''}. El número es el orden de visita; la línea punteada es la ruta aproximada en línea recta.`
      + (dias.length < todos.length ? (S.vis.dia ? ` Para no saturar el mapa, se muestran ${fmt(dias.length)} de ${fmt(todos.length)} días.` : ` Se muestran los días 1 a ${dias.length} de ${fmt(todos.length)}: elige un día en «Ver en el mapa» para ver otro.`) : '')
      + (sc ? ` ${fmt(sc)} local${sc === 1 ? '' : 'es'} sin coordenadas no aparece${sc === 1 ? '' : 'n'}.` : ''), false);
    return;
  }
  const P = await w('puntos');
  // Reencuadra al abrir, al cambiar el centro o los filtros; no al seleccionar un punto
  const clave = JSON.stringify([S.region, S.f, nearArg()]);
  const ajustar = S.ajustarMapa || clave !== S.mapaClave; S.ajustarMapa = false; S.mapaClave = clave;
  m.pintar(P.puntos, P.centro, ajustar);
  if (ajustar && !P.puntos.length && !P.centro) m.encuadrarPeru();
  const sinC = P.total - P.conCoord;
  avisoMapa([
    P.recortado ? `Se muestran los primeros ${fmt(MAX_PUNTOS)} de ${fmt(P.conCoord)} locales con coordenadas. Usa los filtros o la búsqueda por cercanía para ver el resto.` : '',
    sinC > 0 ? `${fmt(sinC)} local${sinC === 1 ? '' : 'es'} sin coordenadas válidas no aparece${sinC === 1 ? '' : 'n'} en el mapa.` : '',
    S.pick ? 'Toca el mapa para fijar el centro de la búsqueda.' : ''
  ].filter(Boolean).join(' '), false);
}

async function renderDock() {
  const T = await w('resumen', { completo: false });
  const ex = T.nExcl ? ` · <span class="sub-dock">${fmt(T.nExcl)} excluido${T.nExcl === 1 ? '' : 's'} por otra inversión</span>` : '';
  $('dockTxt').innerHTML = T.n ? `<b>${fmt(T.n)}</b> locales · <b>${fmt(T.est)}</b> estudiantes · <b>${fmt(T.rep)}</b> bienes a reponer${ex}` : T.nExcl ? `Sin locales en la propuesta${ex}` : 'Sin locales seleccionados';
  $('dockBtn').disabled = !T.n && !T.nExcl; $('selBadge').textContent = fmt(T.n + T.nExcl);
}

async function refresh() {
  if (S.cargando || !S.meta) return;
  renderHead();
  if (S.vis) await actualizarVisitas();
  await Promise.all([renderTable(), renderDock(), S.tab === 'sel' ? renderSel() : null, S.tab === 'exp' ? abrirExpediente() : null]);
}

async function cambioSel() {
  await w('sel', { codigos: [...S.sel] });
  persistirSel();
}

// ─── Días de visita ─────────────────────────────────────────────────────────
async function actualizarVisitas() {
  S.vis.R = await w('visitas', { porDia: S.vis.porDia });
  if (S.vis.dia > S.vis.R.dias.length) S.vis.dia = 0;
  renderVisitas();
}
async function agruparDias() {
  const porDia = limitarPorDia($('vPorDia').value); $('vPorDia').value = porDia;
  S.vis = { porDia, dia: 0, R: null };
  await actualizarVisitas();
  if (!S.vis.R.dias.length && !S.vis.R.sinCoord.length) { S.vis = null; renderVisitas(); toast('Primero selecciona los locales que vas a visitar.'); return; }
  S.pick = false; S.mapaOn = true; S.ajustarMapa = true;
  renderCerca(); await renderMapa();
  $('visitas').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function quitarVisitas() { S.vis = null; S.ajustarMapa = true; renderVisitas(); if (S.mapaOn) renderMapa(); }
function renderVisitas() {
  const V = S.vis;
  $('vRes').hidden = !V; $('vClr').hidden = !V;
  $('vGo').textContent = V ? 'Volver a agrupar' : 'Agrupar por días de visita';
  if (!V?.R) return;
  const { dias, sinCoord, nExcl } = V.R, total = dias.length;
  const nLoc = dias.reduce((a, d) => a + d.puntos.length, 0);
  $('vAviso').innerHTML = `<b>${fmt(nLoc)}</b> local${nLoc === 1 ? '' : 'es'} en <b>${fmt(total)}</b> día${total === 1 ? '' : 's'} de hasta ${fmt(V.porDia)} locales. ${esc(AVISO_VISITAS)}`
    + (sinCoord.length ? `<br>${fmt(sinCoord.length)} local${sinCoord.length === 1 ? '' : 'es'} sin coordenadas válidas no se agrupa${sinCoord.length === 1 ? '' : 'n'}: van al final del Excel.` : '')
    + (nExcl ? `<br>${fmt(nExcl)} local${nExcl === 1 ? '' : 'es'} excluido${nExcl === 1 ? '' : 's'} por otra inversión no se incluye${nExcl === 1 ? '' : 'n'}.` : '')
    + (total > 8 ? '<br>Con más de 8 días, el mapa muestra todos en gris: elige un día en «Ver en el mapa» para resaltarlo.' : '');
  $('vDia').innerHTML = `<option value="0">Todos los días</option>` + dias.map(d => `<option value="${d.dia}">Día ${d.dia} (${d.puntos.length} locales)</option>`).join('');
  $('vDia').value = String(V.dia);
  $('vXls').disabled = $('vKml').disabled = !nLoc && !sinCoord.length;
  $('vKml').disabled = !nLoc;
  $('vLista').innerHTML = dias.map(d => {
    const rep = d.puntos.reduce((a, p) => a + p.rep, 0);
    return `<div class="dia ${V.dia === d.dia ? 'activo' : ''}"><button class="dia-cab" type="button" data-dia="${d.dia}" aria-pressed="${V.dia === d.dia}" style="--c:${colorDia(d.dia, total)}">
      <span class="sw"></span><b>Día ${d.dia}</b><span class="sub">${d.puntos.length} local${d.puntos.length === 1 ? '' : 'es'} · ~${fmtKm(d.km)} km · ${fmt(rep)} a reponer</span></button>
      <ol>${d.puntos.map(p => `<li><span class="n">${p.orden}</span><span><span class="nm">${esc(p.nom)}</span><span class="sub"><span class="mono">${esc(p.cod)}</span> · ${esc(p.dist)}${p.cp ? ' · ' + esc(p.cp) : ''}</span></span><span class="sub num" title="Bienes a reponer">${fmt(p.rep)}</span></li>`).join('')}</ol></div>`;
  }).join('');
}
function verDia(dia) { S.vis.dia = dia; S.ajustarMapa = true; renderVisitas(); S.mapaOn = true; renderMapa(); }
function descargar(blob, nombre) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const slugNombre = s => String(s || 'Borrador').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'Borrador';
async function excelVisitas(btn) {
  const txt = btn.textContent; btn.disabled = true; btn.textContent = 'Generando…';
  try {
    const r = await fetch('/api/selector-ioarr/visitas.xlsx', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: S.region, codigos: S.vis.R.codigos, criterios: S.params, porDia: S.vis.porDia, proyecto: S.proyecto?.nombre || null }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error ' + r.status);
    const cd = r.headers.get('Content-Disposition') || '';
    descargar(await r.blob(), decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'Visitas.xlsx'));
    toast('Excel del plan de visitas descargado.');
  } catch (e) { toast('No se pudo generar el Excel: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = txt; }
}
function kmlVisitas() {
  const kml = generarKML(S.vis.R.dias, { proyecto: S.proyecto?.nombre || 'Borrador', region: S.region, porDia: S.vis.porDia });
  descargar(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }), `Visitas_${slugNombre(S.proyecto?.nombre)}_${hoy()}.kml`);
  toast('KML descargado: ábrelo en Google Earth o impórtalo en Google My Maps.');
}

// ─── Mi selección ────────────────────────────────────────────────────────────
function stackBar(o) {
  const ex = o.b + o.r + o.m; if (!ex) return '<div class="stack"></div>';
  return `<div class="stack" title="Bueno ${fmt(o.b)} · Regular ${fmt(o.r)} · Malo ${fmt(o.m)}"><i style="width:${o.b / ex * 100}%;background:var(--bueno)"></i><i style="width:${o.r / ex * 100}%;background:var(--regular)"></i><i style="width:${o.m / ex * 100}%;background:var(--malo)"></i></div>`;
}
async function renderSel() {
  const T = await w('resumen', { completo: true }), el = $('v-sel');
  S.sit = T.situacional;
  if (!T.n && !T.nExcl) {
    el.innerHTML = `<div class="panel vacio"><h3 style="color:var(--text);margin-bottom:6px;font-family:var(--font-display)">Aún no hay locales seleccionados</h3><p style="margin:0 0 14px">Vuelve a «Elegir locales» y marca los locales que intervendrás.</p><button class="btn btn-primary" data-ir="elegir" type="button">Elegir locales</button></div>`;
    return;
  }
  const trows = T.tipos.map(o => `<tr><td>${o.n}<br><span class="sub">${o.u}</span>${stackBar(o)}</td><td class="num">${fmt(o.b + o.r + o.m)}</td><td class="num">${fmt(o.b)}</td><td class="num">${fmt(o.r)}</td><td class="num">${fmt(o.m)}</td><td class="num"><b>${fmt(o.rep)}</b></td><td class="num">${fmt(o.req)}</td><td class="num col-fal">${fmt(o.fal)}</td></tr>`).join('');
  const drows = T.distritos.map(r => `<tr><td>${esc(r.nom)}</td><td class="num">${fmt(r.n)}</td><td class="num">${fmt(r.est)}</td><td class="num">${fmt(r.aul)}</td><td class="num"><b>${fmt(r.rep)}</b></td><td class="num col-fal">${fmt(r.fal)}</td></tr>`).join('');
  const pags = Math.max(1, Math.ceil(T.locales.length / PAGE));
  S.selPage = Math.min(S.selPage || 0, pags - 1);
  const desde = S.selPage * PAGE;
  const lrows = T.locales.slice(desde, desde + PAGE).map(r => `<tr class="${r.excl ? 'excluido' : ''}"><td class="mono">${r.cod}</td><td><span class="nm">${esc(r.nom)}</span></td><td>${esc(r.dist)}</td><td class="c-dup">${celdaDup(r.cod)}</td><td class="num">${fmt(r.est)}</td><td class="num">${fmt(r.aul)}</td>${r.t.map(v => `<td class="num">${fmt(v)}</td>`).join('')}<td class="num"><b>${fmt(r.rep)}</b></td><td class="num col-fal">${fmt(r.fal)}</td><td>${coordValidas(r.lat, r.lon) ? `<a class="x" href="${urlGoogleMaps(r.lat, r.lon)}" target="_blank" rel="noopener" aria-label="Ver el local ${r.cod} en Google Maps">Mapa</a>` : '<span class="sub">—</span>'}</td><td><button class="x" data-rm="${r.cod}" type="button" aria-label="Quitar el local ${r.cod}">Quitar</button></td></tr>`).join('');
  const sum = k => fmt(T.tipos.reduce((a, o) => a + o[k], 0));
  el.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="v">${fmt(T.n)}</div><div class="l">locales en la propuesta${T.nExcl ? ` · ${fmt(T.nExcl)} excluido${T.nExcl === 1 ? '' : 's'} por otra inversión` : ''}</div></div>
      <div class="kpi"><div class="v">${fmt(T.est)}</div><div class="l">estudiantes (padrón)</div></div>
      <div class="kpi"><div class="v">${fmt(T.aul)}</div><div class="l">aulas en uso (censo)</div></div>
      <div class="kpi destacado"><div class="v">${fmt(T.rep)}</div><div class="l">bienes a reponer (estado malo, suma de los 5 tipos)</div></div>
      <div class="kpi"><div class="v">${fmt(T.fal)}</div><div class="l">${FALTANTE}, solo informativo</div></div>
    </div>
    <div class="exportar">
      <div><h3>Exportar para el estudio</h3><p>Libro de Excel con el resumen (criterios, fuentes y limitaciones), los locales con ubigeo y coordenadas, el resumen por distrito, los servicios, las aulas con mobiliario por estado y la reposición masiva. Las columnas de resultado llevan fórmulas.</p></div>
      <button class="btn btn-primary" id="exp" type="button">${S.proyecto ? 'Exportar a Excel' : 'Guardar como proyecto para exportar'}</button>
    </div>
    <div class="panel"><div class="panel-cab"><h3>Mobiliario por tipo</h3><div class="leyenda"><span style="--c:var(--bueno)">Bueno</span><span style="--c:var(--regular)">Regular</span><span style="--c:var(--malo)">Malo</span></div></div>
        <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Tipo</th><th class="num">Existente</th><th class="num">Bueno</th><th class="num">Regular</th><th class="num">Malo</th><th class="num">A reponer</th><th class="num">Requerido</th><th class="num col-fal">${FALTANTE}</th></tr></thead><tbody>${trows}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${fmt(T.tipos.reduce((a, o) => a + o.b + o.r + o.m, 0))}</td><td class="num">${sum('b')}</td><td class="num">${sum('r')}</td><td class="num">${sum('m')}</td><td class="num">${fmt(T.rep)}</td><td class="num">${sum('req')}</td><td class="num col-fal">${sum('fal')}</td></tr></tfoot></table></div>
        <p class="sub pad">Se repone solo el estado malo. Bueno y regular son diagnóstico. El faltante es lo que falta para llegar a lo requerido: no suma a lo que se repone, al costo ni al Formato 07-C.</p></div>
    <div class="panel"><div class="panel-cab"><h3>Por distrito</h3></div>
        <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Distrito</th><th class="num">Locales</th><th class="num">Estudiantes</th><th class="num">Aulas</th><th class="num">A reponer</th><th class="num col-fal" title="${FALTANTE}">Faltante (no reposición)</th></tr></thead><tbody>${drows}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${fmt(T.n)}</td><td class="num">${fmt(T.est)}</td><td class="num">${fmt(T.aul)}</td><td class="num">${fmt(T.rep)}</td><td class="num col-fal">${fmt(T.fal)}</td></tr></tfoot></table></div></div>
    <div class="panel"><div class="panel-cab"><h3>Por nivel educativo</h3></div>
      <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Nivel</th><th class="num">Locales</th><th class="num">Estudiantes</th><th class="num">Aulas</th><th class="num">Bueno</th><th class="num">Regular</th><th class="num">Malo</th><th class="num">A reponer</th><th class="num col-fal" title="${FALTANTE}">Faltante (no reposición)</th></tr></thead>
        <tbody>${T.niveles.map(o => `<tr><td>${o.nombre}</td><td class="num">${fmt(o.n)}</td><td class="num">${fmt(o.est)}</td><td class="num">${fmt(o.aul)}</td><td class="num">${fmt(o.b)}</td><td class="num">${fmt(o.r)}</td><td class="num">${fmt(o.m)}</td><td class="num"><b>${fmt(o.rep)}</b></td><td class="num col-fal">${fmt(o.fal)}</td></tr>`).join('')}</tbody></table></div>
      <p class="sub pad">Un local con varios niveles cuenta en cada uno con sus estudiantes y aulas de ese nivel. Con «Una IOARR por nivel» (en Expediente), cada nivel es una IOARR con su propio total.</p></div>
    ${panelSituacional(T.situacional)}
    <div class="panel"><div class="panel-cab"><h3>Locales seleccionados</h3><div class="acc-cab">${botonesDup(T)}<button class="btn btn-ghost btn-sm btn-peligro" id="clrSel" type="button">Quitar todos</button></div></div>
      ${avisoDup(T)}
      <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Código de local</th><th>Instituciones</th><th>Distrito</th><th>${DUP}</th><th class="num">Estudiantes</th><th class="num">Aulas</th>${ITEMS.map(x => `<th class="num">${x.n}</th>`).join('')}<th class="num">A reponer</th><th class="num col-fal" title="${FALTANTE}">Faltante (no reposición)</th><th>Ubicación</th><th></th></tr></thead><tbody>${lrows}</tbody></table></div>
      ${pags > 1 ? `<div class="paginacion pad-pag"><span class="sub">Mostrando ${fmt(desde + 1)}–${fmt(Math.min(T.locales.length, desde + PAGE))} de ${fmt(T.locales.length)} · ordenados por bienes a reponer</span><div class="pg-btns"><button class="btn btn-ghost btn-sm" data-selpag="-1" type="button" ${S.selPage === 0 ? 'disabled' : ''}>Anterior</button><span class="mono">${S.selPage + 1} / ${pags}</span><button class="btn btn-ghost btn-sm" data-selpag="1" type="button" ${S.selPage >= pags - 1 ? 'disabled' : ''}>Siguiente</button></div></div>` : ''}</div>`;
}

// ─── Cuadro de estado situacional (formato del expediente de Huánuco) ────────
const PI_CHIP = { 'Sí': 'alerta', 'No': 'ok', 'Sin verificar': 'pend' };
function panelSituacional(E) {
  if (!E) return '';
  const fila = (cls, a, b, o) => `<tr class="${cls}"><td>${a}</td><td>${b}</td><td class="num">${fmt(o.n)}</td><td class="num">${fmt(o.est)}</td><td class="num">${fmt(o.aul)}</td><td class="num">${fmt(o.b)}</td><td class="num">${fmt(o.r)}</td><td class="num">${fmt(o.m)}</td>
    <td><span class="chip-est ${PI_CHIP[piTexto(o.pi)]}" title="Sí: ${o.pi.si} · No: ${o.pi.no} · Sin verificar: ${o.pi.sin_verificar}">${piTexto(o.pi)}</span></td></tr>`;
  const cuerpo = E.niveles.map(x => x.filas.map(f => fila('', x.nombre, esc(f.ugel), f)).join('') + fila('subtotal', `Subtotal ${x.nombre}`, '', x.subtotal)).join('') + fila('total', 'Total', '', E.total);
  const adv = E.advertencias.map(a => {
    const r = S.revSit[a.clave];
    return `<div class="aviso ${r ? '' : 'alerta'}" role="${r ? 'note' : 'alert'}">${esc(a.texto)}${r ? `<br><span class="sub">Explicación: ${esc(r.nota)}</span>` : ''}
      ${S.proyecto ? `<br><button class="x" type="button" data-sit-rev="${esc(a.clave)}">${r ? 'Cambiar la explicación' : 'Explicar'}</button>` : ''}</div>`;
  }).join('');
  const listas = E.listas.map(L => `<details class="lista-ugel"><summary><b>${esc(L.ugel)}</b> <span class="sub">· ${((n) => n === 1 ? '1 local' : fmt(n) + ' locales')(new Set(L.filas.map(x => x.cod)).size)} · ${fmt(L.filas.reduce((a, x) => a + x.est, 0))} estudiantes</span></summary>
    <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Código de local</th><th>Institución educativa</th><th class="num">Población</th><th>Nivel</th><th>Centro poblado</th><th>Distrito</th><th>UGEL</th></tr></thead>
    <tbody>${L.filas.map(x => `<tr><td class="mono">${esc(x.cod)}</td><td>${esc(x.inst)}<br><span class="sub mono">${esc(x.modular)}</span></td><td class="num">${fmt(x.est)}</td><td>${x.nombreNivel}</td><td>${esc(x.cp)}</td><td>${esc(x.dist)}</td><td>${esc(x.ugel)}</td></tr>`).join('')}</tbody></table></div></details>`).join('');
  return `<div class="panel"><div class="panel-cab"><h3>Estado situacional por UGEL y nivel</h3><span class="sub">Formato del expediente de Huánuco (2023)</span></div>
    <div class="tabla-wrap"><table class="tabla tabla-sit"><thead><tr><th>Nivel</th><th>UGEL</th><th class="num">Locales</th><th class="num">Población de estudiantes</th><th class="num">N.° de aulas</th><th class="num">Mobiliario Bueno</th><th class="num">Mobiliario Regular</th><th class="num">Mobiliario Malo</th><th>Cuenta con proyecto de inversión</th></tr></thead><tbody>${cuerpo}</tbody></table></div>
    <p class="sub pad">Población: matrícula del padrón. Mobiliario: Censo Educativo, los cinco tipos (mesa en puestos). Un local con varios niveles cuenta en cada nivel. «Cuenta con proyecto de inversión» sale de la columna «${DUP}» de cada local.</p>
    <div class="pad">${adv ? `<div class="avisos">${adv}</div>` : '<p class="sub">Comprobado: los totales por UGEL suman los totales por nivel y no hay dos UGEL con cifras idénticas.</p>'}</div>
    <div class="pad"><h4>Locales por UGEL</h4>${listas}</div></div>`;
}
const sitPendientes = () => (S.sit?.advertencias || []).filter(a => !S.revSit[a.clave]);
// Ventana para explicar advertencias: claves = las que se muestran; alExportar = se abrió antes de exportar
function modalSit() {
  let m = $('m-sit'); if (m) return m;
  m = Object.assign(document.createElement('div'), { className: 'modal-overlay', id: 'm-sit' });
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'm-sit-tit');
  m.innerHTML = `<form class="modal" id="f-sit"><button class="cerrar" type="button" data-cerrar aria-label="Cerrar">×</button>
    <h2 id="m-sit-tit">Revisa el cuadro de estado situacional</h2>
    <p class="sub">Un expediente real tuvo dos UGEL con cifras idénticas por error de copia. Explica cada caso (la explicación va al Excel) o corrígelo antes de exportar.</p>
    <div id="sit-lista"></div><p class="err" id="sit-err" hidden></p>
    <div class="modal-acts"><button class="btn btn-ghost" type="button" id="sit-sin" hidden>Exportar sin explicar</button><button class="btn btn-primary" type="submit" id="sit-ok">Guardar</button></div></form>`;
  document.body.append(m);
  m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-cerrar]')) cerrarModal('m-sit'); });
  m.querySelector('#f-sit').addEventListener('submit', guardarSit);
  m.querySelector('#sit-sin').addEventListener('click', () => { cerrarModal('m-sit'); exportarYa(); });
  return m;
}
let sitExportar = false;
function abrirSit(claves, alExportar) {
  const m = modalSit(); sitExportar = alExportar;
  const advs = (S.sit?.advertencias || []).filter(a => claves.includes(a.clave));
  m.querySelector('#sit-lista').innerHTML = advs.map(a => `<div class="field"><label>${esc(a.texto)}</label><textarea data-sit-nota="${esc(a.clave)}" rows="2" maxlength="500" placeholder="Ej.: dato verificado con el oficio de la UGEL; ambas UGEL tienen la misma matrícula">${esc(S.revSit[a.clave]?.nota || '')}</textarea></div>`).join('');
  m.querySelector('#sit-sin').hidden = !alExportar;
  m.querySelector('#sit-ok').textContent = alExportar ? 'Guardar y exportar' : 'Guardar';
  m.querySelector('#sit-err').hidden = true;
  abrirModal('m-sit');
}
async function guardarSit(e) {
  e.preventDefault();
  const m = modalSit(), btn = m.querySelector('#sit-ok'); btn.disabled = true;
  try {
    for (const t of m.querySelectorAll('[data-sit-nota]')) {
      const clave = t.dataset.sitNota, nota = t.value.trim();
      if ((S.revSit[clave]?.nota || '') === nota) continue;
      const r = await api(`/proyectos/${S.proyecto.id}/situacional/revisiones`, { method: 'PUT', body: { clave, nota } });
      S.revSit = r.revisiones || {};
    }
    cerrarModal('m-sit');
    if (S.tab === 'sel') await renderSel();
    if (sitExportar) exportarYa();
  } catch (x) { m.querySelector('#sit-err').textContent = x.message; m.querySelector('#sit-err').hidden = false; }
  finally { btn.disabled = false; }
}

// ─── Otra inversión vigente o reciente (duplicidad) ─────────────────────────
// Se registra a mano tras consultar el Banco de Inversiones (la consulta automática es una mejora futura)
function celdaDup(cod) {
  if (!S.proyecto) return '<span class="sub">Guarda el proyecto para registrarla</span>';
  if (S.sinMigDup) return '<span class="sub">Falta la migración 017</span>';
  const d = dupDe(cod);
  const chip = d.estado === 'si' ? `<span class="chip-est alerta">Sí${d.codigo ? ' · ' + esc(d.codigo) : ''}</span><br><span class="sub">${d.excluir ? 'Excluido de la propuesta' : 'Sigue en la propuesta'}</span>`
    : d.estado === 'no' ? '<span class="chip-est ok">No</span>' : '<span class="chip-est pend">Sin verificar</span>';
  return `${chip}<br><button class="x" type="button" data-dup="${esc(cod)}" aria-label="${DUP}: editar el local ${esc(cod)}">Editar</button>`;
}
const dupSel = () => [...S.sel].map(c => [c, dupDe(c)]);
function botonesDup() {
  if (!S.proyecto || S.sinMigDup) return '';
  const si = dupSel().filter(([, d]) => d.estado === 'si');
  return (si.some(([, d]) => !d.excluir) ? '<button class="btn btn-ghost btn-sm" id="dupExcl" type="button">Excluir los marcados «Sí»</button>' : '')
    + (si.some(([, d]) => d.excluir) ? '<button class="btn btn-ghost btn-sm" id="dupIncl" type="button">Volver a incluir los excluidos</button>' : '');
}
function avisoDup() {
  if (!S.proyecto || S.sinMigDup) return '';
  const L = dupSel(), n = e => L.filter(([, d]) => d.estado === e).length, siIn = L.filter(([, d]) => d.estado === 'si' && !d.excluir).length;
  return `${siIn ? `<div class="aviso alerta pad-aviso" role="alert">${fmt(siIn)} local${siIn === 1 ? '' : 'es'} con otra inversión vigente o reciente sigue${siIn === 1 ? '' : 'n'} en la propuesta: hay riesgo de duplicidad.</div>` : ''}
    <p class="sub pad">${DUP}: ${fmt(n('si'))} sí · ${fmt(n('no'))} no · ${fmt(n('sin_verificar'))} sin verificar. Consulta cada local en el Banco de Inversiones del MEF y regístralo con «Editar». Los excluidos siguen en la selección, pero no entran en los totales, el Excel ni el expediente.</p>`;
}
function abrirDup(cod) {
  const d = dupDe(cod);
  $('d-cod').textContent = cod;
  document.querySelector(`input[name="d-estado"][value="${d.estado}"]`).checked = true;
  $('d-codigo').value = d.codigo || ''; $('d-nota').value = d.nota || '';
  $('d-excluir').checked = d.estado === 'si' ? d.excluir : true;   // al marcar «Sí», se propone excluir
  $('d-err').hidden = true;
  $('f-dup').dataset.cod = cod;
  pintarDupModal();
  abrirModal('m-dup');
}
function pintarDupModal() {
  const si = document.querySelector('input[name="d-estado"]:checked')?.value === 'si';
  $('d-si').hidden = !si;
}
async function guardarDup(e) {
  e.preventDefault();
  const cod = $('f-dup').dataset.cod, btn = $('d-ok');
  const body = { estado: document.querySelector('input[name="d-estado"]:checked').value, codigo: $('d-codigo').value, nota: $('d-nota').value, excluir: $('d-excluir').checked };
  btn.disabled = true; $('d-err').hidden = true;
  try {
    const r = await api(`/proyectos/${S.proyecto.id}/duplicidad/${encodeURIComponent(cod)}`, { method: 'PUT', body });
    const { cod: _, ...d } = r;
    if (d.estado === 'sin_verificar' && !d.codigo && !d.nota) delete S.dup[cod]; else S.dup[cod] = d;
    await w('duplicidad', { mapa: S.dup });
    cerrarModal('m-dup'); refresh();
    toast(d.estado === 'si' ? (d.excluir ? 'Local marcado con otra inversión y excluido de la propuesta.' : 'Local marcado con otra inversión. Sigue en la propuesta.') : 'Guardado.');
  } catch (err) { $('d-err').textContent = err.message; $('d-err').hidden = false; }
  finally { btn.disabled = false; }
}
async function excluirTodosDup(excluir) {
  try {
    const r = await api(`/proyectos/${S.proyecto.id}/duplicidad/excluir`, { method: 'POST', body: { excluir } });
    S.dup = r.duplicidad || {};
    await w('duplicidad', { mapa: S.dup });
    refresh(); toast(excluir ? 'Locales con otra inversión excluidos de la propuesta.' : 'Locales con otra inversión incluidos otra vez.');
  } catch (e) { toast('No se pudo cambiar: ' + e.message); }
}

// Antes de exportar se revisa el cuadro de estado situacional
async function exportar(btn) {
  if (!S.proyecto) { abrirModalProyecto('nuevo'); return; }
  const pend = sitPendientes();
  if (pend.length) { abrirSit(pend.map(a => a.clave), true); return; }
  return exportarYa(btn);
}
async function exportarYa(btn = $('exp')) {
  if (!btn) return;
  btn.disabled = true; btn.classList.add('cargando'); const txt = btn.textContent; btn.textContent = 'Generando…';
  try {
    await guardarYa();
    const r = await fetch(`/api/selector-ioarr/proyectos/${S.proyecto.id}/excel`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error ' + r.status);
    const blob = await r.blob();
    const cd = r.headers.get('Content-Disposition') || '';
    const nombre = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'IOARR.xlsx');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Excel descargado.');
  } catch (e) { toast('No se pudo exportar: ' + e.message); }
  finally { btn.disabled = false; btn.classList.remove('cargando'); btn.textContent = txt; }
}

function setTab(t) {
  S.tab = t;
  for (const v of ['elegir', 'sel', 'exp']) {
    $('v-' + v).classList.toggle('active', v === t);
    const b = $('tab-' + v); b.classList.toggle('active', v === t); b.setAttribute('aria-selected', v === t);
  }
  $('dockBtn').hidden = t !== 'elegir';
  if (t === 'sel') renderSel();
  if (t === 'exp') abrirExpediente();
}

// Expediente (costos): lo calcula el servidor con el proyecto guardado
function abrirExpediente() {
  return renderExpediente({ el: $('v-exp'), proyecto: S.proyecto, api, toast, guardarYa });
}

// ─── Criterios ───────────────────────────────────────────────────────────────
function renderCrit() {
  const P = S.params;
  $('critGrid').innerHTML = CRIT.map(([k, l, mn, mx, st]) => `<div class="campo"><label for="c_${k}">${l}</label><input id="c_${k}" type="number" inputmode="decimal" min="${mn}" max="${mx}" step="${st}" value="${P[k]}"></div>`).join('') +
    `<div class="campo"><label for="c_carpEstado">Estado de las carpetas (vienen sin estado)</label><select id="c_carpEstado"><option value="b">Bueno</option><option value="r">Regular</option><option value="m">Malo</option></select></div>
     <div class="campo"><span class="lbl">&nbsp;</span><button class="btn btn-ghost" id="critReset" type="button">Restablecer criterios</button></div>`;
  $('c_carpEstado').value = P.carpEstado;
  critSum();
}
function critSum() {
  const P = S.params;
  $('critSum').textContent = `Mesa múltiple = ${P.kI} puestos (Inicial) o ${P.kPS} (Primaria y Secundaria) · carpeta bipersonal = ${P.carpBip} · carpetas como ${{ b: 'Bueno', r: 'Regular', m: 'Malo' }[P.carpEstado]} · a reponer = Malo (el faltante va aparte, no se repone)`;
}
let tCrit;
function onCrit(e) {
  const id = e.target.id || ''; if (!id.startsWith('c_')) return;
  const k = id.slice(2), P = { ...S.params };
  if (k === 'carpEstado') P.carpEstado = e.target.value;
  else { let v = parseFloat(e.target.value); if (!isFinite(v) || v < 0) return; P[k] = v; }
  S.params = limpiarParams(P);
  critSum();
  clearTimeout(tCrit);
  tCrit = setTimeout(async () => { S.detalles.clear(); await w('params', { params: S.params }); persistirCrit(); refresh(); }, 150);
}

// ─── Modales ─────────────────────────────────────────────────────────────────
let modoModal = 'nuevo';
function abrirModal(id) { $(id).classList.add('open'); }
function cerrarModal(id) { $(id).classList.remove('open'); }
function abrirModalProyecto(modo) {
  modoModal = modo;
  const tit = { nuevo: 'Nuevo proyecto', renombrar: 'Renombrar proyecto', duplicar: 'Duplicar proyecto' }[modo];
  $('m-proy-tit').textContent = tit;
  $('m-ok').textContent = { nuevo: 'Crear', renombrar: 'Guardar', duplicar: 'Duplicar' }[modo];
  $('m-nombre').value = modo === 'renombrar' ? S.proyecto.nombre : modo === 'duplicar' ? S.proyecto.nombre + ' (copia)' : '';
  $('m-region-f').hidden = modo !== 'nuevo';
  $('m-region').value = S.region;
  $('m-err').hidden = true;
  actualizarCopiar();
  abrirModal('m-proy');
  setTimeout(() => $('m-nombre').focus(), 30);
}
function actualizarCopiar() {
  const visible = modoModal === 'nuevo' && $('m-region').value === S.region && S.sel.size > 0;
  $('m-copiar-f').hidden = !visible;
  $('m-copiar-txt').textContent = `Partir de la selección actual (${fmt(S.sel.size)} locales) y sus criterios`;
}
async function enviarModalProyecto(e) {
  e.preventDefault();
  const nombre = $('m-nombre').value.trim(), btn = $('m-ok');
  if (!nombre) return;
  btn.disabled = true; $('m-err').hidden = true;
  try {
    if (modoModal === 'renombrar') {
      const p = await api(`/proyectos/${S.proyecto.id}`, { method: 'PATCH', body: { nombre } });
      S.proyecto = { ...S.proyecto, ...p };
      await listarProyectos();
    } else if (modoModal === 'duplicar') {
      await guardarYa();
      const p = await api(`/proyectos/${S.proyecto.id}/duplicar`, { method: 'POST', body: { nombre } });
      await listarProyectos(); await abrirProyecto(p.id);
    } else {
      const region = $('m-region').value, copiar = !$('m-copiar-f').hidden && $('m-copiar').checked;
      const p = await api('/proyectos', { method: 'POST', body: { nombre, region, criterios: copiar ? S.params : DEF, locales: copiar ? [...S.sel] : [] } });
      await listarProyectos(); await abrirProyecto(p.id);
    }
    cerrarModal('m-proy');
    toast(modoModal === 'renombrar' ? 'Nombre actualizado.' : 'Proyecto guardado.');
  } catch (err) { $('m-err').textContent = err.message; $('m-err').hidden = false; }
  finally { btn.disabled = false; }
}
async function borrarProyecto() {
  if (!S.proyecto || !confirm(`¿Borrar el proyecto «${S.proyecto.nombre}»? Esta acción no se puede deshacer.`)) return;
  try {
    clearTimeout(guardado.sel); clearTimeout(guardado.crit); guardado.sel = guardado.crit = null;
    await api(`/proyectos/${S.proyecto.id}`, { method: 'DELETE' });
    const region = S.region;
    S.proyecto = null; await listarProyectos(); await abrirBorrador(region);
    toast('Proyecto borrado.');
  } catch (e) { toast('No se pudo borrar: ' + e.message); }
}

// Seleccionar por lista de códigos pegada
async function pegarCodigos(e) {
  e.preventDefault();
  const txt = $('p-txt'), res = $('p-res'), btn = $('p-ok');
  if (!/\d/.test(txt.value)) { res.textContent = 'Pega al menos un código.'; return; }
  btn.disabled = true;
  try {
    const r = await w('pegarCodigos', { texto: txt.value });
    for (const c of r.codigos) S.sel.add(c);
    persistirSel(); refresh();
    const partes = [`${fmt(r.codigos.length)} de ${fmt(r.leidos)} códigos encontrados; ${fmt(r.nuevos)} locales agregados a la selección`
      + (r.nuevos < r.codigos.length ? ` (${fmt(r.codigos.length - r.nuevos)} ya estaban)` : '') + '.'];
    if (r.porModular) partes.push(`${fmt(r.porModular)} se reconocieron por código modular y se tomó su local.`);
    if (r.fuera) partes.push(`${fmt(r.fuera)} no están entre los filtrados ahora (otra provincia, distrito o filtro), pero igual se seleccionaron.`);
    if (r.noEncontrados.length) {
      partes.push(`${fmt(r.noEncontrados.length)} no están en el padrón de ${S.region}: se dejaron en el cuadro para que los revises.`);
      txt.value = r.noEncontrados.join('\n');
    } else txt.value = '';
    res.textContent = partes.join(' ');
  } catch (err) { res.textContent = 'No se pudo seleccionar: ' + err.message; }
  finally { btn.disabled = false; }
}

// Vínculo con Radar IOARR
let tVinc;
async function buscarIoarr() {
  const ul = $('v-lista');
  try {
    const lista = await api('/ioarr?q=' + encodeURIComponent($('v-q').value.trim()));
    ul.innerHTML = lista.length ? lista.map(p => `<li data-id="${p.id}" class="${S.proyecto?.ioarr?.id === p.id ? 'activo' : ''}"><span class="mono">CUI ${esc(p.cui)}</span> · ${esc(p.nombre)}${p.region ? ` <span class="sub">(${esc(p.region)})</span>` : ''}</li>`).join('')
      : '<li class="vacio sub">No hay registros que coincidan.</li>';
  } catch (e) { ul.innerHTML = `<li class="vacio err">${esc(e.message)}</li>`; }
}
async function vincular(id) {
  try {
    const p = await api(`/proyectos/${S.proyecto.id}`, { method: 'PATCH', body: { ioarr_proyecto_id: id } });
    S.proyecto = { ...S.proyecto, ioarr: p.ioarr, ioarr_proyecto_id: p.ioarr_proyecto_id };
    pintarProyectos(); cerrarModal('m-vinc');
    toast(id ? 'Proyecto vinculado con Radar IOARR.' : 'Vínculo quitado.');
  } catch (e) { toast('No se pudo vincular: ' + e.message); }
}

// ─── Eventos ─────────────────────────────────────────────────────────────────
function bind() {
  const filtro = fn => e => { fn(e); S.page = 0; refresh(); };
  $('proy').onchange = e => e.target.value ? abrirProyecto(e.target.value) : abrirBorrador(S.region);
  $('region').onchange = async e => { if (S.proyecto) return; const r = e.target.value; store('region', r); await cargarRegion(r, S.params, store('sel:' + r) || []); };
  $('btn-nuevo').onclick = () => abrirModalProyecto('nuevo');
  $('btn-renombrar').onclick = () => abrirModalProyecto('renombrar');
  $('btn-duplicar').onclick = () => abrirModalProyecto('duplicar');
  $('btn-borrar').onclick = borrarProyecto;
  $('m-region').onchange = actualizarCopiar;
  $('f-proy').onsubmit = enviarModalProyecto;
  $('f-dup').onsubmit = guardarDup;
  $('f-dup').addEventListener('change', e => { if (e.target.name === 'd-estado') pintarDupModal(); });
  $('btn-vinculo').onclick = () => { $('v-q').value = ''; abrirModal('m-vinc'); $('v-quitar').hidden = !S.proyecto?.ioarr; buscarIoarr(); setTimeout(() => $('v-q').focus(), 30); };
  $('v-q').oninput = () => { clearTimeout(tVinc); tVinc = setTimeout(buscarIoarr, 250); };
  $('v-lista').onclick = e => { const li = e.target.closest('li[data-id]'); if (li) vincular(li.dataset.id); };
  $('v-quitar').onclick = () => vincular(null);
  document.querySelectorAll('.modal-overlay').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-cerrar]')) cerrarModal(m.id); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => cerrarModal(m.id)); });

  $('crit').addEventListener('input', onCrit); $('crit').addEventListener('change', onCrit);
  $('critGrid').addEventListener('click', async e => {
    if (e.target.id !== 'critReset') return;
    S.params = { ...DEF }; renderCrit(); S.detalles.clear(); await w('params', { params: S.params }); persistirCrit(); refresh();
  });

  let tq; $('q').oninput = e => { clearTimeout(tq); tq = setTimeout(() => { S.f.q = e.target.value; S.page = 0; refresh(); }, 180); };
  $('fprov').onchange = filtro(e => { S.f.prov = +e.target.value; S.f.dist = -1; fillDist(); });
  $('fdist').onchange = filtro(e => { S.f.dist = +e.target.value; });
  $('fugel').onchange = filtro(e => { S.f.ugel = +e.target.value; });
  $('farea').onchange = filtro(e => { S.f.area = +e.target.value; });
  $('fges').onchange = filtro(e => { S.f.ges = +e.target.value; });
  let tn; const numero = k => e => { clearTimeout(tn); tn = setTimeout(() => { S.f[k] = Math.max(0, +e.target.value || 0); S.page = 0; refresh(); }, 200); };
  $('frep').oninput = numero('rep'); $('fest').oninput = numero('est');
  $('fcenso').onchange = filtro(e => { S.f.censo = e.target.checked; });
  $('fniv').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on);
    S.f.niv = on ? S.f.niv | NIVB[b.dataset.n] : S.f.niv & ~NIVB[b.dataset.n]; S.page = 0; refresh();
  });
  $('fclear').onclick = () => { S.f = FILTRO_VACIO(); fillFilters(); S.page = 0; refresh(); };

  $('nGo').onclick = () => {
    const cod = $('nCod').value.trim(), di = +$('nDist').value;
    if (cod) buscarCentro({ cod });
    else if (di >= 0) buscarCentro({ dist: di });
    else toast('Elige un distrito, escribe un código de local o usa «Centro en el mapa».');
  };
  $('nCod').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('nGo').click(); } });
  $('nDist').onchange = () => { if (+$('nDist').value >= 0) $('nCod').value = ''; };
  $('nN').onchange = () => {
    const n = limitarN($('nN').value); $('nN').value = n;
    if (S.near && S.near.n !== n) { S.near.n = n; S.ajustarMapa = true; S.page = 0; refresh(); }
  };
  $('nPick').onclick = () => {
    S.pick = !S.pick; S.mapaOn = true;
    if (S.pick) toast('Toca el mapa para fijar el centro de la búsqueda.');
    renderCerca(); renderMapa();
  };
  $('nClr').onclick = quitarCerca;
  $('nList').onclick = () => { S.listaOn = !S.listaOn; renderListado(); };
  $('listaBox').addEventListener('click', e => { const b = e.target.closest('[data-vermapa]'); if (b) verEnMapa(b.dataset.vermapa); });
  $('nMap').onclick = () => { S.mapaOn = !S.mapaOn; if (S.mapaOn) S.ajustarMapa = true; else { S.pick = false; renderCerca(); } renderMapa(); };
  $('nBase').onclick = () => { if (!S.mapa) return; const b = S.mapa.alternarCapa(); $('nBase').textContent = b === 'sat' ? 'Ver calles' : 'Ver satélite'; };
  $('vGo').onclick = agruparDias;
  $('vPorDia').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); agruparDias(); } });
  $('vClr').onclick = quitarVisitas;
  $('vDia').onchange = e => verDia(+e.target.value);
  $('vLista').addEventListener('click', e => { const b = e.target.closest('[data-dia]'); if (b) verDia(S.vis.dia === +b.dataset.dia ? 0 : +b.dataset.dia); });
  $('vXls').onclick = e => excelVisitas(e.currentTarget);
  $('vKml').onclick = kmlVisitas;
  $('btn-pegar').onclick = () => { $('p-res').textContent = ''; abrirModal('m-pegar'); setTimeout(() => $('p-txt').focus(), 30); };
  $('f-pegar').onsubmit = pegarCodigos;
  $('selAll').onclick = async () => { for (const c of await w('codigosVista')) S.sel.add(c); await cambioSel(); refresh(); };
  $('unselAll').onclick = async () => { for (const c of await w('codigosVista')) S.sel.delete(c); await cambioSel(); refresh(); };
  $('pgPrev').onclick = () => { S.page = Math.max(0, S.page - 1); renderTable(); };
  $('pgNext').onclick = () => { S.page++; renderTable(); };
  $('thead').addEventListener('click', e => {
    const th = e.target.closest('th.s'); if (!th) return; const k = th.dataset.k;
    S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: (k === 'cod' || k === 'nom' || k === 'dist') ? 1 : -1 };
    S.page = 0; refresh();
  });
  $('thead').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const th = e.target.closest('th.s'); if (th) { e.preventDefault(); th.click(); } } });
  $('tbody').addEventListener('change', async e => {
    const cb = e.target.closest('input[data-cod]'); if (!cb) return;
    cb.checked ? S.sel.add(cb.dataset.cod) : S.sel.delete(cb.dataset.cod);
    cb.closest('tr').classList.toggle('sel', cb.checked);
    await cambioSel(); renderDock();
    const R = await w('consulta', { f: S.f, sort: S.sort, page: S.page, size: PAGE, near: nearArg() });
    if (S.vis) await actualizarVisitas();
    if (S.mapaOn) renderMapa();
    $('count').innerHTML = `<b>${fmt(R.total)}</b> locales · ${fmt(R.est)} estudiantes · ${fmt(R.aul)} aulas en el censo · <span class="sub">${fmt(R.nsel)} ya seleccionados</span>`;
    $('unselAll').disabled = !R.nsel;
  });
  $('tbody').addEventListener('click', e => {
    const mb = e.target.closest('[data-mapa-btn]'); if (mb) { toggleMapa(mb); return; }
    const nb = e.target.closest('[data-near]');
    if (nb) { buscarCentro({ cod: nb.dataset.near }).then(() => $('cercaPanel').scrollIntoView({ behavior: 'smooth', block: 'start' })); return; }
    const x = e.target.closest('[data-x]'); if (!x) return;
    const i = +x.dataset.x;
    if (S.open.has(i)) { S.open.delete(i); S.mapas.delete(i); } else S.open.add(i);
    renderTable();
  });
  $('v-sel').addEventListener('click', async e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { S.sel.delete(rm.dataset.rm); await cambioSel(); refresh(); return; }
    if (e.target.id === 'clrSel') { if (!confirm('¿Quitar todos los locales de la selección?')) return; S.sel.clear(); await cambioSel(); refresh(); return; }
    if (e.target.id === 'exp') { exportar(e.target); return; }
    const sr = e.target.closest('[data-sit-rev]'); if (sr) { abrirSit([sr.dataset.sitRev], false); return; }
    const dp = e.target.closest('[data-dup]'); if (dp) { abrirDup(dp.dataset.dup); return; }
    if (e.target.id === 'dupExcl') { excluirTodosDup(true); return; }
    if (e.target.id === 'dupIncl') { excluirTodosDup(false); return; }
    const pg = e.target.closest('[data-selpag]');
    if (pg) { S.selPage = (S.selPage || 0) + +pg.dataset.selpag; await renderSel(); document.querySelector('#v-sel .panel:last-of-type')?.scrollIntoView({ block: 'start' }); return; }
    if (e.target.closest('[data-ir]')) setTab('elegir');
  });
  $('tab-elegir').onclick = () => setTab('elegir'); $('tab-sel').onclick = () => setTab('sel'); $('tab-exp').onclick = () => setTab('exp');
  enlazarExpediente($('v-exp'), () => abrirModalProyecto('nuevo'));
  $('dockBtn').onclick = () => { setTab('sel'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
}

boot();
