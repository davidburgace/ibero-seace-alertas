// Visitas de campo — mapa y listado de colegios por cercanía (proveedor y supervisor de campo).
// Solo lectura: usa los datos estáticos de la región y el mismo Web Worker del Selector IOARR.
// De la API solo lee la sesión y los proyectos del Selector (/api/campo/*, src/selector-ioarr/campo.js):
// con un proyecto elegido, la búsqueda por cercanía se limita a sus colegios. No guarda nada en el servidor.
import { DEF, NIVN, NIVS, NIVB, FILTRO_VACIO, coordValidas } from '/selector-ioarr/calculo.js';
import { limitarN, N_MAX } from '/selector-ioarr/cercania.js';
import { limitarPorDia, colorDia, tramosRutaDia, AVISO_VISITAS } from '/selector-ioarr/visitas.js';
import { crearMapa, fmtKm } from '/selector-ioarr-mapa.js';
import { htmlListado, itemListado } from '/selector-ioarr-listado.js';

const BASE_DATOS = '/data/selector-ioarr/2025/';
const LS = 'campo:';
const LEJOS_KM = 30;      // si el colegio más cercano está más lejos, quizá la región no es la correcta
const NF = new Intl.NumberFormat('es-PE');
const fmt = n => NF.format(Math.round(n || 0));
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, uno, varios) => `${fmt(n)} ${n === 1 ? uno : varios}`;
function store(k, v) {
  try {
    if (v === undefined) { const r = localStorage.getItem(LS + k); return r == null ? null : JSON.parse(r); }
    localStorage.setItem(LS + k, JSON.stringify(v));
  } catch { return null; }
}
async function api(ruta) {
  const r = await fetch(ruta);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `error ${r.status}`);
  return b;
}
function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 4200); }

// ─── Worker (el mismo del Selector) ──────────────────────────────────────────
const worker = new Worker('/selector-ioarr-worker.js', { type: 'module' });
const pendientes = new Map(); let sigId = 0;
worker.onmessage = ({ data }) => { const p = pendientes.get(data.id); if (!p) return; pendientes.delete(data.id); data.ok ? p.ok(data.r) : p.mal(new Error(data.error)); };
worker.onerror = e => { console.error('Worker', e); toast('Error al procesar los datos: recarga la página.'); };
const w = (tipo, args = {}) => new Promise((ok, mal) => { const id = ++sigId; pendientes.set(id, { ok, mal }); worker.postMessage({ id, tipo, ...args }); });

// ─── Estado ──────────────────────────────────────────────────────────────────
const S = {
  idx: null, region: null, meta: null, f: FILTRO_VACIO(),
  proys: [],                // proyectos del Selector que el usuario puede ver
  proy: null,               // proyecto elegido: { id, nombre, n } (n = colegios del proyecto en la región)
  near: null,               // { lat, lon, n, label, gps }
  filas: [],                // listado actual (de más cerca a más lejos)
  vis: null,                // { porDia, dias, sinCoord }
  mapa: null, mapaCreando: null, mapaFalla: false, pick: false, vista: 'lista'
};

// ─── Arranque ────────────────────────────────────────────────────────────────
async function boot() {
  bind();
  window.radarSesion?.usuario().then(u => {
    $('cUsuario').textContent = u.email || '';
    const prov = u.rol === 'proveedor';
    $('lnkInicio').hidden = !prov;
    if (!prov) $('lnkLogo').removeAttribute('href');
  }).catch(() => {});
  $('cN').value = limitarN(store('n') ?? 20);
  $('cPorDia').value = limitarPorDia(store('porDia') ?? 8);
  try { S.idx = await fetch(BASE_DATOS + 'index.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  catch { $('cInfo').innerHTML = '<span class="err">No se pudo cargar la lista de regiones. Revisa tu conexión y recarga.</span>'; return; }
  $('cRegion').innerHTML = S.idx.regiones.map(g => `<option value="${esc(g.nombre)}">${esc(g.nombre)}</option>`).join('');
  $('cFuente').textContent = `Fuente: ${S.idx.fuente}. Ubicaciones y direcciones declaradas en el padrón de ESCALE; pueden tener error. Las distancias son en línea recta.`;
  await cargarProyectos();
  const p = store('proyecto');
  if (p && S.proys.some(x => x.id === p)) { $('cProy').value = p; await elegirProyecto(p); return; }
  const r = store('region');
  await cargarRegion(S.idx.regiones.some(g => g.nombre === r) ? r : (S.idx.regiones.find(g => g.nombre === 'Moquegua') || S.idx.regiones[0]).nombre);
}

// ─── Proyectos del Selector IOARR ───────────────────────────────────────────
async function cargarProyectos() {
  try { S.proys = await api('/api/campo/proyectos'); }
  catch (e) { console.warn('Proyectos', e); S.proys = []; }
  $('cProyCampo').hidden = !S.proys.length;
  $('cProy').innerHTML = '<option value="">Ninguno: toda la región</option>' + S.proys.map(p =>
    `<option value="${esc(p.id)}">${esc(p.nombre)} · ${esc(p.region)} · ${plural(p.n_locales, 'colegio', 'colegios')}</option>`).join('');
}

// Carga la región del proyecto, limita la búsqueda a sus colegios y trae su cantidad a «Colegios a visitar»
async function elegirProyecto(id) {
  if (!id) { await quitarProyecto(); return; }
  const sel = $('cProy'); sel.disabled = true;
  try {
    let p;
    try { p = await api('/api/campo/proyectos/' + encodeURIComponent(id)); }
    catch (e) { toast(`No se pudo abrir el proyecto: ${e.message}`); sel.value = S.proy?.id || ''; return; }
    if (p.region !== S.region) await cargarRegion(p.region);
    if (p.region !== S.region) { toast(`No se pudo cargar la región ${p.region} del proyecto.`); sel.value = ''; S.proy = null; return; }
    const r = await w('limitar', { codigos: p.locales });
    S.proy = { id: p.id, nombre: p.nombre, n: r.n }; store('proyecto', p.id);
    S.near = null; S.filas = []; S.vis = null;
    $('cDist').value = '-1'; $('cCod').value = '';
    $('cN').value = limitarN(r.n || 1);
    const avisos = [];
    if (r.n > N_MAX) avisos.push(`El proyecto tiene ${fmt(r.n)} colegios: se listan los ${fmt(N_MAX)} más cercanos al centro que elijas.`);
    if (r.fuera) avisos.push(`${plural(r.fuera, 'código del proyecto no está', 'códigos del proyecto no están')} en el padrón de ${p.region}.`);
    if (avisos.length) toast(avisos.join(' '));
    if (!r.n) { $('cInfo').textContent = `El proyecto «${p.nombre}» no tiene colegios en ${p.region}.`; pintarTodo(true); return; }
    const c = await w('centro', { proyecto: p.nombre });
    if (c.error) { $('cInfo').textContent = c.error; pintarTodo(true); return; }
    await buscar(c);
  } finally { sel.disabled = false; }
}

// Vuelve a toda la región (sin recargarla) y a la cantidad de colegios que el usuario tenía
async function quitarProyecto({ rebuscar = true } = {}) {
  const habia = !!S.proy;
  S.proy = null; store('proyecto', null); $('cProy').value = '';
  if (!habia) return;
  await w('limitar', { codigos: null });
  $('cN').value = limitarN(store('n') ?? 20);
  if (rebuscar && S.near) await buscar(null);
  else if (rebuscar) $('cInfo').textContent = `${fmt(S.meta.codigos)} colegios en ${S.region}. Elige un centro: tu ubicación, un distrito o un código de local.`;
}

async function cargarRegion(nombre) {
  const g = S.idx.regiones.find(x => x.nombre === nombre); if (!g) return;
  $('cRegion').value = nombre; $('cRegion').disabled = true;
  $('cInfo').textContent = `Cargando ${nombre}…`;
  try { S.meta = await w('cargar', { url: BASE_DATOS + g.archivo, params: DEF }); }
  catch (e) { $('cInfo').innerHTML = `<span class="err">No se pudo cargar ${esc(nombre)}: ${esc(e.message)}</span>`; return; }
  finally { $('cRegion').disabled = false; }
  S.region = nombre; store('region', nombre);
  S.near = null; S.filas = []; S.vis = null;
  const ds = S.meta.dists.map((d, i) => [d[0], i]).sort((a, b) => a[0].localeCompare(b[0], 'es'));
  $('cDist').innerHTML = '<option value="-1">Elegir distrito…</option>' + ds.map(([n, i]) => `<option value="${i}">${esc(n)} · ${esc(S.meta.provs[S.meta.dists[i][1]] || '')}</option>`).join('');
  $('cCod').value = '';
  $('cNiv').innerHTML = Object.keys(NIVN).map(k => `<button type="button" class="chip" data-n="${k}" aria-pressed="${!!(S.f.niv & NIVB[k])}">${NIVS[k]}</button>`).join('');
  $('cInfo').textContent = `${fmt(S.meta.codigos)} colegios en ${nombre}. Elige un centro: tu ubicación, un distrito o un código de local.`;
  pintarTodo(true);
}

// ─── Búsqueda ────────────────────────────────────────────────────────────────
async function buscar(centro, { ajustar = true } = {}) {
  if (centro) S.near = { ...centro, n: limitarN($('cN').value) };
  if (!S.near) return;
  S.near.n = limitarN($('cN').value); $('cN').value = S.near.n;
  if (!S.proy) store('n', S.near.n);      // la cantidad que trae un proyecto no reemplaza la del usuario
  S.pick = false; S.mapa?.modoElegir(false); $('cPick').setAttribute('aria-pressed', 'false');
  const R = await w('consulta', { f: S.f, sort: { key: 'rep', dir: -1 }, page: 0, size: 1, near: { lat: S.near.lat, lon: S.near.lon, n: S.near.n } });
  S.filas = await w('listado');
  await w('sel', { codigos: S.filas.map(f => f.cod) });          // los días de visita agrupan el listado
  if (S.vis) await agrupar(false);
  const c = R.cerca;
  const om = c.omitidos ? ` · ${plural(c.omitidos, 'colegio', 'colegios')} sin coordenadas no se consideran` : '';
  const pr = S.proy ? `Proyecto «${esc(S.proy.nombre)}» (${plural(S.proy.n, 'colegio', 'colegios')}): ` : '';
  $('cInfo').innerHTML = pr + (c.n
    ? `<b>${fmt(c.n)}</b> ${c.n === 1 ? 'colegio más cercano' : 'colegios más cercanos'} ${esc(aCentro(S.near.label))} · el más lejano a <b>${fmtKm(c.max)} km</b> en línea recta${om}`
    : `Ningún colegio con coordenadas cumple los filtros cerca ${esc(aCentro(S.near.label)).replace(/^al /, 'del ').replace(/^a /, 'de ')}${om}`);
  if (S.near.gps && S.filas[0]?.km > LEJOS_KM) toast(`El colegio más cercano está a ${fmtKm(S.filas[0].km)} km de ti: ¿elegiste la región correcta?`);
  $('cAgrupar').disabled = !S.filas.length;
  pintarTodo(ajustar);
}

function centroDistrito() {
  const di = +$('cDist').value, cod = $('cCod').value.trim();
  if (cod) return w('centro', { cod });
  if (di >= 0) return w('centro', { dist: di });
  return Promise.resolve({ error: 'Elige un distrito, escribe un código de local o usa tu ubicación.' });
}
// «a tu ubicación», «al distrito de X», «al local X», «al punto elegido en el mapa»
const aCentro = label => (label.startsWith('tu ') ? 'a ' : 'al ') + label;

function usarUbicacion() {
  if (!('geolocation' in navigator)) { toast('Este navegador no da la ubicación. Elige un distrito o un código de local.'); return; }
  if (!window.isSecureContext) { toast('La ubicación solo funciona en una conexión segura (https).'); return; }
  const b = $('cUbic'), txt = b.textContent; b.disabled = true; b.textContent = 'Buscando tu ubicación…';
  navigator.geolocation.getCurrentPosition(pos => {
    b.disabled = false; b.textContent = txt;
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    if (!coordValidas(lat, lon)) { toast('Tu ubicación está fuera de Perú. Elige un distrito o un código de local.'); return; }
    $('cDist').value = '-1'; $('cCod').value = '';
    buscar({ lat, lon, label: `tu ubicación${accuracy > 200 ? ` (precisión de ±${fmt(accuracy)} m)` : ''}`, gps: true });
  }, err => {
    b.disabled = false; b.textContent = txt;
    toast({ 1: 'No diste permiso para usar tu ubicación. Actívalo en el navegador o elige un distrito.', 2: 'No se pudo obtener tu ubicación. Prueba al aire libre o elige un distrito.', 3: 'La ubicación tardó demasiado. Vuelve a intentarlo o elige un distrito.' }[err.code] || 'No se pudo obtener tu ubicación.');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

// ─── Días de visita ─────────────────────────────────────────────────────────
async function agrupar(pintar = true) {
  const porDia = limitarPorDia($('cPorDia').value); $('cPorDia').value = porDia; store('porDia', porDia);
  const R = await w('visitas', { porDia });
  S.vis = { porDia, dias: R.dias, sinCoord: R.sinCoord };
  if (pintar) pintarTodo(true);
}

// ─── Pintar ──────────────────────────────────────────────────────────────────
function pintarTodo(ajustar) {
  pintarLista(); pintarVisitas(); pintarMapa(ajustar);
}
function pintarLista() {
  if (!S.near) { $('cLista').innerHTML = '<p class="sub lst-vacio">Aún no hay búsqueda. Usa tu ubicación, elige un distrito o escribe un código de local.</p>'; return; }
  if (!S.vis) { $('cLista').innerHTML = htmlListado(S.filas); return; }
  // Agrupado por día: cada día en su orden de visita, con los datos completos del listado
  const porCod = new Map(S.filas.map(f => [f.cod, f])), total = S.vis.dias.length;
  $('cLista').innerHTML = S.vis.dias.map(d => {
    const rep = d.puntos.reduce((a, p) => a + p.rep, 0);
    return `<h3 class="dia-titulo" style="--c:${colorDia(d.dia, total)}"><span class="sw"></span>Día ${d.dia} <span class="sub">${plural(d.puntos.length, 'colegio', 'colegios')} · ~${fmtKm(d.km)} km · ${fmt(rep)} a reponer</span></h3>
      ${botonesRuta(d)}
      <ol class="lst">${d.puntos.map(p => itemListado({ ...porCod.get(p.cod), orden: p.orden, km: null }, { numero: x => x.orden })).join('')}</ol>`;
  }).join('') + (S.vis.sinCoord.length ? `<h3 class="dia-titulo">Sin coordenadas</h3><ol class="lst">${S.vis.sinCoord.map(p => itemListado({ ...porCod.get(p.cod), km: null }, { numero: () => '–' })).join('')}</ol>` : '');
}
// «Ruta del día en Google Maps»: un enlace, o uno por tramo si el día pasa de 10 colegios
function botonesRuta(d) {
  const tramos = tramosRutaDia(d.puntos);
  if (!tramos.length) return '';
  const enlace = (t, texto) => `<a class="btn btn-primary btn-sm" href="${esc(t.url)}" target="_blank" rel="noopener" aria-label="${esc(texto)} del día ${d.dia} en Google Maps">${esc(texto)}</a>`;
  return `<div class="dia-ruta">${tramos.length === 1
    ? enlace(tramos[0], 'Ruta del día en Google Maps')
    : `<span class="sub">Ruta en Google Maps, por tramos:</span> ${tramos.map(t => enlace(t, `Paradas ${t.desde}–${t.hasta}`)).join('')}`}</div>`;
}
function pintarVisitas() {
  const V = S.vis;
  $('cVisRes').hidden = !V; $('cDesagrupar').hidden = !V;
  $('cAgrupar').textContent = V ? 'Volver a agrupar' : 'Agrupar por días';
  $('cAgrupar').disabled = !S.filas.length;
  if (!V) return;
  const n = V.dias.reduce((a, d) => a + d.puntos.length, 0);
  $('cVisAviso').innerHTML = `<b>${fmt(n)}</b> ${n === 1 ? 'colegio' : 'colegios'} en <b>${fmt(V.dias.length)}</b> ${V.dias.length === 1 ? 'día' : 'días'} de hasta ${fmt(V.porDia)}. ${esc(AVISO_VISITAS)} El listado de arriba queda ordenado por día y parada, con la ruta de cada día en Google Maps.`;
}

async function asegurarMapa() {
  if (S.mapa) return S.mapa;
  S.mapaCreando ||= crearMapa($('cMapa'), { onPunto: (lat, lon) => { $('cDist').value = '-1'; $('cCod').value = ''; buscar({ lat, lon, label: 'punto elegido en el mapa' }); } })
    .then(m => { S.mapa = m; return m; }).finally(() => { S.mapaCreando = null; });
  return S.mapaCreando;
}
async function pintarMapa(ajustar) {
  let m;
  try { m = await asegurarMapa(); }
  catch (e) {
    console.error('Mapa', e); S.mapaFalla = true;
    $('cMapa').hidden = true; $('cBase').hidden = true;
    const a = $('cAviso'); a.hidden = false; a.className = 'mapa-aviso alerta';
    a.textContent = `No se pudo cargar el mapa (${e.message}). El listado sigue funcionando; revisa tu conexión y recarga.`;
    return;
  }
  $('cBase').hidden = false;
  m.modoElegir(S.pick);
  if (S.vis) {
    m.pintarVisitas(S.vis.dias, 0, ajustar);
    $('cMapaInfo').textContent = 'Número = orden de visita; línea punteada = ruta aproximada.';
  } else {
    const P = S.near ? await w('puntos') : { puntos: [], centro: null };
    m.pintar(P.puntos, P.centro, ajustar, S.near?.gps ? 'Tu ubicación' : 'Centro de la búsqueda');
    if (ajustar && !P.puntos.length && !P.centro) m.encuadrarPeru();
    $('cMapaInfo').textContent = S.pick ? 'Toca el mapa para fijar el centro.' : S.near ? `${plural(P.puntos.length, 'colegio', 'colegios')} · círculo rojo: ${S.near.gps ? 'tu ubicación' : 'centro'}` : '';
  }
}

function setVista(v) {
  S.vista = v;
  $('cCuerpo').dataset.vista = v;
  document.querySelectorAll('.vista-tabs .tab-btn').forEach(b => { const on = b.dataset.vista === v; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
  if (v === 'mapa') S.mapa?.invalidar();
}
const esCelular = () => matchMedia('(max-width:900px)').matches;

function filtrosSum() {
  const p = [];
  if (S.f.niv) p.push(Object.keys(NIVN).filter(k => S.f.niv & NIVB[k]).map(k => NIVS[k]).join(', '));
  if (S.f.area >= 0) p.push(S.f.area ? 'Rural' : 'Urbana');
  if (S.f.rep) p.push(`≥ ${fmt(S.f.rep)} a reponer`);
  $('cFiltSum').textContent = p.length ? '· ' + p.join(' · ') : '· ninguno';
}

// ─── Eventos ─────────────────────────────────────────────────────────────────
function bind() {
  $('btnSalir').onclick = () => window.radarSesion?.salir();
  $('cRegion').onchange = async e => { await quitarProyecto({ rebuscar: false }); cargarRegion(e.target.value); };
  $('cProy').onchange = e => elegirProyecto(e.target.value);
  $('cUbic').onclick = usarUbicacion;
  $('cGo').onclick = async () => { const c = await centroDistrito(); if (c.error) { toast(c.error); return; } buscar(c); };
  $('cCod').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('cGo').click(); } });
  $('cDist').onchange = async () => { if (+$('cDist').value < 0) return; $('cCod').value = ''; const c = await w('centro', { dist: +$('cDist').value }); if (c.error) toast(c.error); else buscar(c); };
  $('cN').onchange = () => { $('cN').value = limitarN($('cN').value); if (S.near) buscar(null); else store('n', +$('cN').value); };
  $('cPick').onclick = async () => {
    S.pick = !S.pick; $('cPick').setAttribute('aria-pressed', S.pick);
    if (S.pick) { if (esCelular()) setVista('mapa'); toast('Toca el mapa para fijar el centro de la búsqueda.'); }
    const m = await asegurarMapa().catch(() => null);
    if (!m) { S.pick = false; $('cPick').setAttribute('aria-pressed', 'false'); toast('El mapa no está disponible.'); return; }
    m.modoElegir(S.pick); $('cMapaInfo').textContent = S.pick ? 'Toca el mapa para fijar el centro.' : '';
    if (S.pick) { m.invalidar(); $('cMapa').scrollIntoView({ behavior: 'smooth', block: esCelular() ? 'end' : 'nearest' }); }
  };
  $('cBase').onclick = () => { if (!S.mapa) return; const b = S.mapa.alternarCapa(); $('cBase').textContent = b === 'sat' ? 'Ver calles' : 'Ver satélite'; };
  const filtro = fn => e => { fn(e); filtrosSum(); if (S.near) buscar(null); };
  $('cNiv').addEventListener('click', filtro(e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on);
    S.f.niv = on ? S.f.niv | NIVB[b.dataset.n] : S.f.niv & ~NIVB[b.dataset.n];
  }));
  $('cArea').onchange = filtro(e => { S.f.area = +e.target.value; });
  let t; $('cRep').oninput = e => { clearTimeout(t); t = setTimeout(filtro(() => { S.f.rep = Math.max(0, +e.target.value || 0); }), 250); };
  document.querySelector('.vista-tabs').addEventListener('click', e => { const b = e.target.closest('[data-vista]'); if (b) setVista(b.dataset.vista); });
  $('cLista').addEventListener('click', async e => {
    const b = e.target.closest('[data-vermapa]'); if (!b) return;
    if (esCelular()) setVista('mapa'); else $('cMapa').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!S.mapa) { toast('El mapa no está disponible.'); return; }
    setTimeout(() => { if (!S.mapa.enfocar(b.dataset.vermapa)) toast('Ese colegio no está en el mapa.'); }, 50);
  });
  $('cAgrupar').onclick = () => agrupar(true);
  $('cPorDia').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); agrupar(true); } });
  $('cDesagrupar').onclick = () => { S.vis = null; pintarTodo(true); };
  filtrosSum();
}

boot();
