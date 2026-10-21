// Selector IOARR — interfaz. Los datos y el cálculo viven en selector-ioarr-worker.js;
// los proyectos se guardan en Supabase vía /api/selector-ioarr/* (sesión de sesion.js).
import { CRIT, DEF, ITEMS, NIVN, NIVS, NIVB, FILTRO_VACIO, limpiarParams, coordValidas, urlGoogleMaps, urlMapaEmbed } from '/selector-ioarr/calculo.js';
import { renderExpediente, enlazarExpediente } from '/selector-ioarr-expediente.js';

const ANIO = 2025;
const BASE_DATOS = `/data/selector-ioarr/${ANIO}/`;
const PAGE = 40;
const FALTANTE = 'Faltante (brecha de dotación, no reposición)';
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
  tab: 'elegir', seq: 0, selPage: 0
};

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
  S.proyecto = null; store('proyecto', null);
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
  pintarProyectos();
  await cargarRegion(p.region, limpiarParams(p.criterios), p.locales || []);
}

async function cargarRegion(nombre, params, codigos) {
  const g = S.idx.regiones.find(r => r.nombre === nombre);
  if (!g) { toast('No hay datos para la región ' + nombre); return; }
  S.cargando = true; $('region').value = nombre;
  S.params = params; S.sel = new Set(codigos);
  S.f = FILTRO_VACIO(); S.page = 0; S.open.clear(); S.detalles.clear(); S.mapas.clear();
  renderCrit();
  if (S.region !== nombre || !S.meta) {
    $('count').textContent = `Cargando ${g.nombre}…`; $('tbody').innerHTML = ''; document.body.classList.add('cargando');
    try { S.meta = await w('cargar', { url: BASE_DATOS + g.archivo, params }); }
    catch (e) { $('count').innerHTML = `<span class="err">No se pudo cargar ${esc(g.nombre)}: ${esc(e.message)}</span>`; S.cargando = false; return; }
    finally { document.body.classList.remove('cargando'); }
    S.region = nombre;
  } else await w('params', { params });
  await w('sel', { codigos: [...S.sel] });
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
}
function fillDist() {
  $('fdist').innerHTML = '<option value="-1">Todos</option>' + S.meta.dists.map((d, i) => [d, i]).filter(([d]) => S.f.prov < 0 || d[1] === S.f.prov)
    .map(([d, i]) => `<option value="${i}">${esc(d[0])}</option>`).join('');
  $('fdist').value = String(S.f.dist);
}

// ─── Tabla ───────────────────────────────────────────────────────────────────
const COLS = [['', '', 0, 'ck'], ['Código de local', 'cod', 0, 'cod'], ['Instituciones', 'nom', 0, 'nom'], ['Distrito · centro poblado', 'dist', 0, 'dist'],
  ['Área', '', 0, 'area'], ['Estudiantes', 'est', 1, 'est'], ['Aulas', 'aul', 1, 'aul'], ['A reponer', 'rep', 1, 'rep'], ['% del requerido', 'pct', 1, 'pct'], ['', '', 0, 'x']];
function renderHead() {
  $('thead').innerHTML = COLS.map(([t, k, n]) => {
    if (!k) return `<th class="${n ? 'num' : ''}">${t}</th>`;
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
  const R = await w('consulta', { f: S.f, sort: S.sort, page: S.page, size: PAGE });
  if (seq !== S.seq) return;          // llegó una consulta más nueva
  S.page = R.page;
  const det = new Map();
  for (const r of R.filas) if (S.open.has(r.i)) det.set(r.i, await detalleHTML(r.i));
  if (seq !== S.seq) return;
  $('tbody').classList.remove('cargando-tabla');
  // Guarda los mapas abiertos antes de redibujar, para devolverlos a su fila
  for (const f of $('tbody').querySelectorAll('iframe[data-mapa]')) if (S.mapas.has(+f.dataset.mapa)) mover(reservaMapas, f);
  if (!R.filas.length) $('tbody').innerHTML = `<tr><td colspan="10" class="vacio">Ningún local cumple los filtros. Prueba con menos condiciones.</td></tr>`;
  else $('tbody').innerHTML = R.filas.map(r => {
    const sel = S.sel.has(r.cod), open = S.open.has(r.i);
    const pills = r.niv.map(n => `<span class="pill">${n}</span>`).join('') + (r.conv ? '<span class="pill conv">Convenio</span>' : '');
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
      <td class="c-x"><button class="x" data-x="${r.i}" type="button" aria-expanded="${open}" aria-label="Ver detalle del local ${r.cod}">${open ? 'Ocultar' : 'Detalle'}</button></td></tr>`
      + (open ? `<tr class="det"><td colspan="10">${det.get(r.i)}</td></tr>` : '');
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
}

async function renderDock() {
  const T = await w('resumen', { completo: false });
  $('dockTxt').innerHTML = T.n ? `<b>${fmt(T.n)}</b> locales · <b>${fmt(T.est)}</b> estudiantes · <b>${fmt(T.rep)}</b> bienes a reponer` : 'Sin locales seleccionados';
  $('dockBtn').disabled = !T.n; $('selBadge').textContent = fmt(T.n);
}

async function refresh() {
  if (S.cargando || !S.meta) return;
  renderHead();
  await Promise.all([renderTable(), renderDock(), S.tab === 'sel' ? renderSel() : null, S.tab === 'exp' ? abrirExpediente() : null]);
}

async function cambioSel() {
  await w('sel', { codigos: [...S.sel] });
  persistirSel();
}

// ─── Mi selección ────────────────────────────────────────────────────────────
function stackBar(o) {
  const ex = o.b + o.r + o.m; if (!ex) return '<div class="stack"></div>';
  return `<div class="stack" title="Bueno ${fmt(o.b)} · Regular ${fmt(o.r)} · Malo ${fmt(o.m)}"><i style="width:${o.b / ex * 100}%;background:var(--bueno)"></i><i style="width:${o.r / ex * 100}%;background:var(--regular)"></i><i style="width:${o.m / ex * 100}%;background:var(--malo)"></i></div>`;
}
async function renderSel() {
  const T = await w('resumen', { completo: true }), el = $('v-sel');
  if (!T.n) {
    el.innerHTML = `<div class="panel vacio"><h3 style="color:var(--text);margin-bottom:6px;font-family:var(--font-display)">Aún no hay locales seleccionados</h3><p style="margin:0 0 14px">Vuelve a «Elegir locales» y marca los locales que intervendrás.</p><button class="btn btn-primary" data-ir="elegir" type="button">Elegir locales</button></div>`;
    return;
  }
  const trows = T.tipos.map(o => `<tr><td>${o.n}<br><span class="sub">${o.u}</span>${stackBar(o)}</td><td class="num">${fmt(o.b + o.r + o.m)}</td><td class="num">${fmt(o.b)}</td><td class="num">${fmt(o.r)}</td><td class="num">${fmt(o.m)}</td><td class="num"><b>${fmt(o.rep)}</b></td><td class="num">${fmt(o.req)}</td><td class="num col-fal">${fmt(o.fal)}</td></tr>`).join('');
  const drows = T.distritos.map(r => `<tr><td>${esc(r.nom)}</td><td class="num">${fmt(r.n)}</td><td class="num">${fmt(r.est)}</td><td class="num">${fmt(r.aul)}</td><td class="num"><b>${fmt(r.rep)}</b></td><td class="num col-fal">${fmt(r.fal)}</td></tr>`).join('');
  const pags = Math.max(1, Math.ceil(T.locales.length / PAGE));
  S.selPage = Math.min(S.selPage || 0, pags - 1);
  const desde = S.selPage * PAGE;
  const lrows = T.locales.slice(desde, desde + PAGE).map(r => `<tr><td class="mono">${r.cod}</td><td><span class="nm">${esc(r.nom)}</span></td><td>${esc(r.dist)}</td><td class="num">${fmt(r.est)}</td><td class="num">${fmt(r.aul)}</td>${r.t.map(v => `<td class="num">${fmt(v)}</td>`).join('')}<td class="num"><b>${fmt(r.rep)}</b></td><td class="num col-fal">${fmt(r.fal)}</td><td>${coordValidas(r.lat, r.lon) ? `<a class="x" href="${urlGoogleMaps(r.lat, r.lon)}" target="_blank" rel="noopener" aria-label="Ver el local ${r.cod} en Google Maps">Mapa</a>` : '<span class="sub">—</span>'}</td><td><button class="x" data-rm="${r.cod}" type="button" aria-label="Quitar el local ${r.cod}">Quitar</button></td></tr>`).join('');
  const sum = k => fmt(T.tipos.reduce((a, o) => a + o[k], 0));
  el.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="v">${fmt(T.n)}</div><div class="l">locales seleccionados</div></div>
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
    <div class="panel"><div class="panel-cab"><h3>Locales seleccionados</h3><button class="btn btn-ghost btn-sm btn-peligro" id="clrSel" type="button">Quitar todos</button></div>
      <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Código de local</th><th>Instituciones</th><th>Distrito</th><th class="num">Estudiantes</th><th class="num">Aulas</th>${ITEMS.map(x => `<th class="num">${x.n}</th>`).join('')}<th class="num">A reponer</th><th class="num col-fal" title="${FALTANTE}">Faltante (no reposición)</th><th>Ubicación</th><th></th></tr></thead><tbody>${lrows}</tbody></table></div>
      ${pags > 1 ? `<div class="paginacion pad-pag"><span class="sub">Mostrando ${fmt(desde + 1)}–${fmt(Math.min(T.locales.length, desde + PAGE))} de ${fmt(T.locales.length)} · ordenados por bienes a reponer</span><div class="pg-btns"><button class="btn btn-ghost btn-sm" data-selpag="-1" type="button" ${S.selPage === 0 ? 'disabled' : ''}>Anterior</button><span class="mono">${S.selPage + 1} / ${pags}</span><button class="btn btn-ghost btn-sm" data-selpag="1" type="button" ${S.selPage >= pags - 1 ? 'disabled' : ''}>Siguiente</button></div></div>` : ''}</div>`;
}

async function exportar(btn) {
  if (!S.proyecto) { abrirModalProyecto('nuevo'); return; }
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
    const R = await w('consulta', { f: S.f, sort: S.sort, page: S.page, size: PAGE });
    $('count').innerHTML = `<b>${fmt(R.total)}</b> locales · ${fmt(R.est)} estudiantes · ${fmt(R.aul)} aulas en el censo · <span class="sub">${fmt(R.nsel)} ya seleccionados</span>`;
    $('unselAll').disabled = !R.nsel;
  });
  $('tbody').addEventListener('click', e => {
    const mb = e.target.closest('[data-mapa-btn]'); if (mb) { toggleMapa(mb); return; }
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
    const pg = e.target.closest('[data-selpag]');
    if (pg) { S.selPage = (S.selPage || 0) + +pg.dataset.selpag; await renderSel(); document.querySelector('#v-sel .panel:last-of-type')?.scrollIntoView({ block: 'start' }); return; }
    if (e.target.closest('[data-ir]')) setTab('elegir');
  });
  $('tab-elegir').onclick = () => setTab('elegir'); $('tab-sel').onclick = () => setTab('sel'); $('tab-exp').onclick = () => setTab('exp');
  enlazarExpediente($('v-exp'), () => abrirModalProyecto('nuevo'));
  $('dockBtn').onclick = () => { setTab('sel'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
}

boot();
