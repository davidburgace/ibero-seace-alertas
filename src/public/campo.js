// Visitas de campo — mapa y listado de colegios por cercanía (proveedor y supervisor de campo).
// Usa los datos estáticos de la región y el mismo Web Worker del Selector IOARR.
// De la API (/api/campo/*, src/selector-ioarr/campo.js) lee los proyectos del Selector (con uno elegido,
// la búsqueda por cercanía se limita a sus colegios), el reparto de esos colegios entre supervisores y los
// colegios visitados. Lo que guarda en el servidor: marcar o desmarcar un colegio como visitado
// (/api/campo/visitas/:codigo) y, el proveedor, el reparto entre supervisores (/api/campo/proyectos/:id/asignaciones).
import { DEF, NIVN, NIVS, NIVB, FILTRO_VACIO, coordValidas } from '/selector-ioarr/calculo.js';
import { limitarN, N_MAX } from '/selector-ioarr/cercania.js';
import { limitarPorDia, colorDia, tramosRutaDia, cuotasIguales, AVISO_VISITAS } from '/selector-ioarr/visitas.js';
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
async function api(ruta, opts) {
  const r = await fetch(ruta, opts);
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
  proy: null,               // proyecto elegido: { id, nombre, n, nVer, locales, asig, sups }
                            //   n = colegios del proyecto en la región; nVer = los que muestra «Colegios del proyecto»
                            //   asig = { cod: supervisorId } (null = falta la migración 022); sups = { supervisorId: correo }
  ver: 'todo',              // «Colegios del proyecto»: 'todo', 'sin' (sin asignar) o el id de un supervisor
  sups: [],                 // proveedor: todos los usuarios con rol supervisor [{ id, email }]
  cuotas: new Map(),        // panel de reparto: supervisorId → colegios (solo los marcados)
  near: null,               // { lat, lon, n, label, gps }
  filas: [],                // listado actual (de más cerca a más lejos)
  vis: null,                // { porDia, dias, sinCoord }
  rol: null, yo: null,
  visitas: null,            // { códigoLocal: { fecha, por, mia } }; null = no disponible (falta la migración 021)
  ocultar: false,           // «Ocultar visitados»: no se listan los colegios ya visitados
  mapa: null, mapaCreando: null, mapaFalla: false, pick: false, vista: 'lista'
};

// ─── Arranque ────────────────────────────────────────────────────────────────
async function boot() {
  bind();
  const u = await window.radarSesion?.usuario().catch(() => null);
  if (u) {
    $('cUsuario').textContent = u.email || '';
    S.rol = u.rol; S.yo = u.id;
    const prov = u.rol === 'proveedor';
    $('lnkInicio').hidden = !prov;
    if (!prov) $('lnkLogo').removeAttribute('href');
  }
  $('cN').value = limitarN(store('n') ?? 20);
  $('cPorDia').value = limitarPorDia(store('porDia') ?? 8);
  try { S.idx = await fetch(BASE_DATOS + 'index.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  catch { $('cInfo').innerHTML = '<span class="err">No se pudo cargar la lista de regiones. Revisa tu conexión y recarga.</span>'; return; }
  $('cRegion').innerHTML = S.idx.regiones.map(g => `<option value="${esc(g.nombre)}">${esc(g.nombre)}</option>`).join('');
  $('cFuente').textContent = `Fuente: ${S.idx.fuente}. Ubicaciones y direcciones declaradas en el padrón de ESCALE; pueden tener error. Las distancias son en línea recta.`;
  await Promise.all([cargarProyectos(), cargarVisitas(), cargarSupervisores()]);
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

// ─── Reparto entre supervisores ─────────────────────────────────────────────
async function cargarSupervisores() {
  if (S.rol !== 'proveedor') return;
  try { S.sups = await api('/api/campo/supervisores'); }
  catch (e) { console.warn('Supervisores', e); S.sups = []; }
}
const corto = email => String(email || '').split('@')[0] || 'supervisor';
const correoSup = id => S.proy?.sups?.[id] || S.sups.find(u => u.id === id)?.email || '';
// Conteo del reparto actual: { porSup: Map(id → n), sin }
function conteoAsig() {
  const porSup = new Map(); let sin = 0;
  for (const c of S.proy?.locales || []) { const id = S.proy.asig?.[c]; if (id) porSup.set(id, (porSup.get(id) || 0) + 1); else sin++; }
  return { porSup, sin };
}
function codigosVer() {
  const P = S.proy; if (!P) return null;
  if (S.ver === 'todo' || !P.asig) return P.locales;
  if (S.ver === 'sin') return P.locales.filter(c => !P.asig[c]);
  return P.locales.filter(c => P.asig[c] === S.ver);
}
const etiquetaVer = () => S.ver === 'sin' ? 'sin asignar' : S.ver === S.yo ? 'tus colegios' : `de ${corto(correoSup(S.ver))}`;

function pintarVer() {
  const P = S.proy, { porSup, sin } = conteoAsig();
  const hay = !!P?.asig && (porSup.size > 0 || S.rol === 'proveedor');
  $('cVerCampo').hidden = !hay;
  if (!hay) return;
  const ids = [...porSup.keys()].sort((a, b) => (b === S.yo) - (a === S.yo) || correoSup(a).localeCompare(correoSup(b)));
  const op = (v, t) => `<option value="${esc(v)}"${S.ver === v ? ' selected' : ''}>${esc(t)}</option>`;
  $('cVer').innerHTML = op('todo', `Todo el proyecto (${fmt(P.locales.length)})`)
    + ids.map(id => op(id, `${id === S.yo ? 'Mis colegios' : corto(correoSup(id))} (${fmt(porSup.get(id))})`)).join('')
    + (sin ? op('sin', `Sin asignar (${fmt(sin)})`) : '');
}

// Limita la búsqueda a los colegios de «Colegios del proyecto» y busca desde el centro de esos colegios
async function aplicarVer() {
  const P = S.proy; if (!P) return;
  const r = await w('limitar', { codigos: codigosVer() });
  P.nVer = r.n;
  S.near = null; S.filas = []; S.vis = null;
  $('cDist').value = '-1'; $('cCod').value = '';
  $('cN').value = limitarN(r.n || 1);
  if (r.n > N_MAX) toast(`Hay ${fmt(r.n)} colegios: se listan los ${fmt(N_MAX)} más cercanos al centro que elijas.`);
  if (!r.n) { $('cInfo').textContent = `El proyecto «${P.nombre}» no tiene colegios ${S.ver === 'todo' ? 'en ' + P.region : etiquetaVer()}.`; pintarTodo(true); return; }
  const c = await w('centro', { proyecto: P.nombre });
  if (c.error) { $('cInfo').textContent = c.error; pintarTodo(true); return; }
  await buscar(c);
}

function pintarReparto() {
  const P = S.proy, panel = $('cReparto');
  panel.hidden = !(P && S.rol === 'proveedor');
  if (panel.hidden) return;
  const { porSup, sin } = conteoAsig();
  $('cRepResumen').textContent = !P.asig ? '· falta la migración 022'
    : porSup.size ? `· ${plural(porSup.size, 'supervisor', 'supervisores')}${sin ? ` · ${fmt(sin)} sin asignar` : ' · todos asignados'}` : '· sin repartir';
  const aviso = !P.asig ? 'Para repartir colegios entre supervisores falta ejecutar supabase/migrations/022_campo_asignaciones.sql en Supabase.'
    : !S.sups.length ? 'No hay usuarios con rol de supervisor de campo. Invítalos en Admin → Usuarios.' : '';
  $('cRepAviso').hidden = !aviso; $('cRepAviso').textContent = aviso;
  const ok = !aviso;
  $('cRepSups').hidden = !ok; $('cRepartir').disabled = !ok; $('cRepIguales').disabled = !ok;
  if (!ok) { $('cRepSuma').textContent = ''; return; }
  const vis = c => S.visitas?.[c] ? 1 : 0;
  $('cRepSups').innerHTML = S.sups.map(u => {
    const on = S.cuotas.has(u.id), n = porSup.get(u.id) || 0;
    const nv = n ? P.locales.filter(c => P.asig[c] === u.id).reduce((a, c) => a + vis(c), 0) : 0;
    return `<div class="rep-fila">
      <label class="check"><input type="checkbox" data-sup="${esc(u.id)}"${on ? ' checked' : ''}> ${esc(u.email)}</label>
      <input type="number" min="0" step="1" inputmode="numeric" data-cuota="${esc(u.id)}" value="${on ? S.cuotas.get(u.id) : ''}"${on ? '' : ' disabled'} aria-label="Colegios para ${esc(u.email)}">
      <span class="sub rep-actual">${n ? `Hoy: ${plural(n, 'colegio', 'colegios')}${nv ? ` · ${fmt(nv)} ${nv === 1 ? 'visitado' : 'visitados'}` : ''}` : 'Sin colegios'}</span>
    </div>`;
  }).join('');
  pintarSuma();
}
function pintarSuma() {
  const suma = [...S.cuotas.values()].reduce((a, b) => a + b, 0), n = S.proy?.n || 0, el = $('cRepSuma');
  el.className = 'sub';
  if (!S.cuotas.size) { el.textContent = `Marca los supervisores y la cantidad para cada uno (${plural(n, 'colegio', 'colegios')} en el proyecto).`; return; }
  if (suma > n) { el.className = 'err'; el.textContent = `Suma ${fmt(suma)}: el proyecto tiene ${fmt(n)} colegios. Baja ${fmt(suma - n)}.`; return; }
  el.textContent = `Suma ${fmt(suma)} de ${fmt(n)} colegios${suma < n ? ` · ${fmt(n - suma)} quedan sin asignar` : ''}.`;
}
function partesIguales() {
  const ids = [...S.cuotas.keys()];
  cuotasIguales(S.proy?.n || 0, ids.length).forEach((q, i) => S.cuotas.set(ids[i], q));
  pintarReparto();
}
// Al abrir un proyecto: marca los supervisores que ya tienen colegios, con su cantidad actual
function cuotasDelReparto() {
  S.cuotas = new Map();
  const { porSup } = conteoAsig();
  for (const u of S.sups) if (porSup.has(u.id)) S.cuotas.set(u.id, porSup.get(u.id));
}

async function repartir() {
  const P = S.proy, ids = [...S.cuotas.keys()], cuotas = ids.map(id => S.cuotas.get(id) || 0);
  const suma = cuotas.reduce((a, b) => a + b, 0);
  if (!ids.length || !suma) { toast('Marca al menos un supervisor y la cantidad de colegios que le das.'); return; }
  if (suma > P.n) { toast(`La suma (${fmt(suma)}) pasa los ${fmt(P.n)} colegios del proyecto.`); return; }
  const { porSup } = conteoAsig();
  if (porSup.size && !confirm(`Esto reemplaza el reparto actual del proyecto «${P.nombre}». ¿Seguir?`)) return;
  const b = $('cRepartir'); b.disabled = true; b.textContent = 'Repartiendo…';
  try {
    const r = await w('repartir', { codigos: P.locales, cuotas });
    const asignaciones = {};
    r.zonas.forEach((z, i) => z.forEach(c => { asignaciones[c] = ids[i]; }));
    const g = await guardarAsig(asignaciones, true);
    P.asig = g.asignaciones; P.sups = g.supervisores;
    cuotasDelReparto(); pintarVer(); pintarReparto();
    toast('Reparto guardado: ' + ids.map((id, i) => `${corto(correoSup(id))} ${fmt(r.zonas[i].length)}`).join(' · ') + (r.sobran.length + r.fuera.length ? ` · ${fmt(r.sobran.length + r.fuera.length)} sin asignar` : '') + '.');
    if (S.ver !== 'todo') { S.ver = 'todo'; pintarVer(); await aplicarVer(); } else pintarLista();
  } catch (e) { toast(`No se pudo guardar el reparto: ${e.message}`); }
  finally { b.disabled = false; b.textContent = 'Repartir por zonas'; }
}

// Pasar un colegio suelto a otro supervisor (desde el listado)
async function asignarUno(cod, id, sel) {
  const P = S.proy; sel.disabled = true;
  try {
    const g = await guardarAsig({ [cod]: id || null });
    P.asig = g.asignaciones; P.sups = g.supervisores;
    const nom = S.filas.find(f => f.cod === cod)?.nom || `Local ${cod}`;
    toast(id ? `${nom}: ahora es de ${corto(correoSup(id))}.` : `${nom}: sin asignar.`);
    pintarVer(); pintarReparto(); pintarInfoVisitas();
  } catch (e) { toast(`No se pudo cambiar el supervisor: ${e.message}`); sel.value = P.asig?.[cod] || ''; }
  finally { sel.disabled = false; }
}
// Guarda asignaciones en partes de 500 (el servidor acepta cuerpos de hasta 100 KB: ~2000 colegios).
// Con reemplazar, solo la primera parte borra el reparto anterior. Devuelve el reparto final del servidor
const POR_ENVIO = 500;
async function guardarAsig(asignaciones, reemplazar = false) {
  const P = S.proy, filas = Object.entries(asignaciones);
  let g = null;
  for (let i = 0; i < filas.length || i === 0; i += POR_ENVIO) {
    g = await api(`/api/campo/proyectos/${encodeURIComponent(P.id)}/asignaciones`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asignaciones: Object.fromEntries(filas.slice(i, i + POR_ENVIO)), reemplazar: reemplazar && i === 0 }) });
  }
  return g;
}

// ─── Asignar en bloque ──────────────────────────────────────────────────────
// El proveedor asigna de una vez todos los colegios del listado, o los de un día de visita.
// Para armar el grupo: «Colegios a visitar» (p. ej. 30) + un centro, o «Colegios del proyecto → Sin asignar»
const puedeAsignar = () => S.rol === 'proveedor' && !!S.proy?.asig && S.sups.length > 0;
const bloques = new Map();   // clave → códigos del bloque (se rearma en cada pintarLista)
function barraBloque(clave, cods, texto) {
  if (!puedeAsignar() || !cods.length) return '';
  bloques.set(clave, cods);
  const ops = '<option value="">Elegir supervisor…</option>' + S.sups.map(u => `<option value="${esc(u.id)}">${esc(corto(u.email))}</option>`).join('') + '<option value="sin">Sin asignar</option>';
  return `<div class="asig-bloque" data-bloque="${esc(clave)}">
    <label><span class="sub">${esc(texto)} a</span> <select data-bloque-sup aria-label="${esc(texto)}: supervisor">${ops}</select></label>
    <button class="btn btn-primary btn-sm" type="button" data-bloque-ir>Asignar</button></div>`;
}
async function asignarBloque(caja, boton) {
  const P = S.proy, cods = bloques.get(caja.dataset.bloque) || [], v = caja.querySelector('[data-bloque-sup]').value;
  if (!v) { toast('Elige el supervisor.'); return; }
  const id = v === 'sin' ? null : v;
  const deOtro = cods.filter(c => P.asig[c] && P.asig[c] !== id).length;
  if (deOtro && !confirm(`${plural(deOtro, 'colegio ya tiene', 'colegios ya tienen')} otro supervisor. ¿${id ? `Pasarlos a ${corto(correoSup(id))}` : 'Dejarlos sin asignar'}?`)) return;
  boton.disabled = true;
  try {
    const asignaciones = Object.fromEntries(cods.map(c => [c, id]));
    const g = await guardarAsig(asignaciones);
    P.asig = g.asignaciones; P.sups = g.supervisores;
    toast(`${plural(cods.length, 'colegio', 'colegios')} ${id ? `asignados a ${corto(correoSup(id))}` : 'sin asignar'}.`);
    pintarLista(); pintarVer(); pintarReparto(); pintarInfoVisitas();
  } catch (e) { toast(`No se pudo asignar: ${e.message}`); boton.disabled = false; }
}

// Lo que el listado muestra del reparto: el proveedor elige el supervisor; el supervisor ve de quién es
function extraAsig(f) {
  const P = S.proy; if (!P?.asig || !f?.cod) return {};
  const id = P.asig[f.cod];
  if (S.rol === 'proveedor') {
    if (!S.sups.length) return {};
    const ops = '<option value="">Sin asignar</option>' + S.sups.map(u => `<option value="${esc(u.id)}"${u.id === id ? ' selected' : ''}>${esc(corto(u.email))}</option>`).join('');
    return { acc: `<label class="asig-sel"><span class="sr">Supervisor de ${esc(f.nom)}</span><select data-asignar="${esc(f.cod)}">${ops}</select></label>` };
  }
  return {
    clase: id && id !== S.yo ? 'de-otro' : '',
    cuerpo: `<div class="lst-asig">${id ? (id === S.yo ? 'Asignado a ti' : `Asignado a ${esc(corto(correoSup(id)))}`) : '<span class="sub">Sin asignar</span>'}</div>`
  };
}
function extraItem(f) {
  const a = extraVisita(f), b = extraAsig(f);
  return { clase: [a.clase, b.clase].filter(Boolean).join(' '), cuerpo: (b.cuerpo || '') + (a.cuerpo || ''), acc: (a.acc || '') + (b.acc || '') };
}

// ─── Colegios visitados ─────────────────────────────────────────────────────
async function cargarVisitas() {
  try { S.visitas = await api('/api/campo/visitas'); }
  catch (e) { console.warn('Visitas', e); S.visitas = null; toast(e.message); }
  $('cOcultarCampo').hidden = !S.visitas;
  S.ocultar = !!S.visitas && !!store('ocultarVisitados'); $('cOcultar').checked = S.ocultar;
  filtrosSum();
  await omitirVisitados();
}
const omitirVisitados = () => w('omitir', { codigos: S.ocultar && S.visitas ? Object.keys(S.visitas) : null });
const fechaPe = f => f ? f.split('-').reverse().join('/') : '';
const visitados = filas => S.visitas ? filas.filter(f => S.visitas[f.cod]).length : 0;
// Lo que el listado agrega a cada colegio: «Visitado el …» y el botón para marcar o desmarcar
function extraVisita(f) {
  if (!S.visitas || !f?.cod) return {};
  const v = S.visitas[f.cod];
  if (!v) return { acc: `<button class="btn btn-ghost btn-sm" type="button" data-visita="${esc(f.cod)}" aria-label="Marcar ${esc(f.nom)} como visitado">Marcar visitado</button>` };
  const puede = v.mia || S.rol === 'proveedor';
  return {
    clase: 'visitado',
    cuerpo: `<div class="lst-visita">✓ Visitado el ${esc(fechaPe(v.fecha))}${v.por && !v.mia ? ` · ${esc(v.por)}` : ''}</div>`,
    acc: puede ? `<button class="btn btn-ghost btn-sm" type="button" data-desmarcar="${esc(f.cod)}" aria-label="Desmarcar la visita a ${esc(f.nom)}">Desmarcar</button>` : ''
  };
}
async function cambiarVisita(cod, marcar, boton) {
  const nom = S.filas.find(f => f.cod === cod)?.nom || `el local ${cod}`;
  if (!marcar && !confirm(`¿Desmarcar la visita a ${nom}?`)) return;
  boton.disabled = true;
  try {
    const r = await api('/api/campo/visitas/' + encodeURIComponent(cod), marcar
      ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
      : { method: 'DELETE' });
    if (marcar) S.visitas[cod] = { fecha: r.fecha, por: r.por, mia: true }; else delete S.visitas[cod];
    // El listado no cambia hasta la próxima búsqueda (así no se reordenan los días); la próxima ya omite los visitados
    await omitirVisitados();
    toast(marcar ? `${nom}: visitado el ${fechaPe(r.fecha)}.` : `${nom}: visita desmarcada.`);
    pintarLista(); pintarInfoVisitas();
  } catch (e) { toast(`No se pudo ${marcar ? 'marcar' : 'desmarcar'} la visita: ${e.message}`); boton.disabled = false; }
}
function pintarInfoVisitas() {
  const el = $('cInfoVis'); if (!el) return;
  const n = visitados(S.filas);
  el.textContent = n ? ` · ${plural(n, 'ya visitado', 'ya visitados')}` : '';
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
    S.proy = { id: p.id, nombre: p.nombre, region: p.region, n: r.n, nVer: r.n, locales: p.locales, asig: p.asignaciones ?? null, sups: p.supervisores || {} };
    store('proyecto', p.id);
    if (r.fuera) toast(`${plural(r.fuera, 'código del proyecto no está', 'códigos del proyecto no están')} en el padrón de ${p.region}.`);
    // El supervisor arranca con sus colegios, si tiene; el proveedor, con todo el proyecto
    S.ver = S.rol === 'supervisor' && S.proy.asig && Object.values(S.proy.asig).includes(S.yo) ? S.yo : 'todo';
    cuotasDelReparto(); pintarVer(); pintarReparto();
    await aplicarVer();
  } finally { sel.disabled = false; }
}

// Vuelve a toda la región (sin recargarla) y a la cantidad de colegios que el usuario tenía
async function quitarProyecto({ rebuscar = true } = {}) {
  const habia = !!S.proy;
  S.proy = null; S.ver = 'todo'; store('proyecto', null); $('cProy').value = '';
  $('cVerCampo').hidden = true; $('cReparto').hidden = true;
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
  const pr = S.proy ? `Proyecto «${esc(S.proy.nombre)}» (${plural(S.proy.n, 'colegio', 'colegios')}${S.ver !== 'todo' ? ` · ${esc(etiquetaVer())}: ${fmt(S.proy.nVer)}` : ''}): ` : '';
  $('cInfo').innerHTML = pr + (c.n
    ? `<b>${fmt(c.n)}</b> ${c.n === 1 ? 'colegio más cercano' : 'colegios más cercanos'} ${esc(aCentro(S.near.label))} · el más lejano a <b>${fmtKm(c.max)} km</b> en línea recta${om}`
    : `Ningún colegio con coordenadas cumple los filtros cerca ${esc(aCentro(S.near.label)).replace(/^al /, 'del ').replace(/^a /, 'de ')}${om}`);
  if (S.near.gps && S.filas[0]?.km > LEJOS_KM) toast(`El colegio más cercano está a ${fmtKm(S.filas[0].km)} km de ti: ¿elegiste la región correcta?`);
  $('cInfo').insertAdjacentHTML('beforeend', '<span id="cInfoVis"></span>'); pintarInfoVisitas();
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
  const opts = { extra: extraItem };
  bloques.clear();
  const todos = barraBloque('lista', S.filas.map(f => f.cod), `Asignar ${S.filas.length === 1 ? 'el colegio' : `los ${fmt(S.filas.length)} colegios`} del listado`);
  // El listado llega a N_MAX (200): con más colegios en «Colegios del proyecto», también se asignan todos de una vez
  const ver = S.proy ? codigosVer() : [];
  const nombreVer = { todo: 'todo el proyecto', sin: 'los sin asignar' }[S.ver] || (S.ver === S.yo ? 'mis colegios' : corto(correoSup(S.ver)));
  const todosVer = ver.length > S.filas.length ? barraBloque('ver', ver, `O asignar los ${fmt(ver.length)} colegios de «${nombreVer}»`) : '';
  if (!S.vis) { $('cLista').innerHTML = todos + todosVer + htmlListado(S.filas, opts); return; }
  // Agrupado por día: cada día en su orden de visita, con los datos completos del listado
  const porCod = new Map(S.filas.map(f => [f.cod, f])), total = S.vis.dias.length;
  $('cLista').innerHTML = todos + todosVer + S.vis.dias.map(d => {
    const rep = d.puntos.reduce((a, p) => a + p.rep, 0), nv = visitados(d.puntos);
    return `<h3 class="dia-titulo" style="--c:${colorDia(d.dia, total)}"><span class="sw"></span>Día ${d.dia} <span class="sub">${plural(d.puntos.length, 'colegio', 'colegios')}${nv ? ` (${fmt(nv)} ${nv === 1 ? 'visitado' : 'visitados'})` : ''} · ~${fmtKm(d.km)} km · ${fmt(rep)} a reponer</span></h3>
      ${botonesRuta(d)}
      ${barraBloque('dia-' + d.dia, d.puntos.map(p => p.cod), `Asignar el día ${d.dia}`)}
      <ol class="lst">${d.puntos.map(p => itemListado({ ...porCod.get(p.cod), orden: p.orden, km: null }, { ...opts, numero: x => x.orden })).join('')}</ol>`;
  }).join('') + (S.vis.sinCoord.length ? `<h3 class="dia-titulo">Sin coordenadas</h3><ol class="lst">${S.vis.sinCoord.map(p => itemListado({ ...porCod.get(p.cod), km: null }, { ...opts, numero: () => '–' })).join('')}</ol>` : '');
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
  if (S.ocultar) p.push('sin visitados');
  $('cFiltSum').textContent = p.length ? '· ' + p.join(' · ') : '· ninguno';
}

// ─── Eventos ─────────────────────────────────────────────────────────────────
function bind() {
  $('btnSalir').onclick = () => window.radarSesion?.salir();
  $('cRegion').onchange = async e => { await quitarProyecto({ rebuscar: false }); cargarRegion(e.target.value); };
  $('cProy').onchange = e => elegirProyecto(e.target.value);
  $('cVer').onchange = e => { S.ver = e.target.value; aplicarVer(); };
  $('cRepSups').addEventListener('change', e => {
    const ch = e.target.closest('[data-sup]');
    if (ch) { if (ch.checked) S.cuotas.set(ch.dataset.sup, 0); else S.cuotas.delete(ch.dataset.sup); partesIguales(); return; }
    const q = e.target.closest('[data-cuota]');
    if (q) { const v = Math.max(0, Math.round(+q.value || 0)); q.value = v; S.cuotas.set(q.dataset.cuota, v); pintarSuma(); }
  });
  $('cRepSups').addEventListener('input', e => { const q = e.target.closest('[data-cuota]'); if (q) { S.cuotas.set(q.dataset.cuota, Math.max(0, Math.round(+q.value || 0))); pintarSuma(); } });
  $('cRepIguales').onclick = partesIguales;
  $('cRepartir').onclick = repartir;
  $('cLista').addEventListener('change', e => { const s = e.target.closest('[data-asignar]'); if (s) asignarUno(s.dataset.asignar, s.value, s); });
  $('cLista').addEventListener('click', e => { const b = e.target.closest('[data-bloque-ir]'); if (b) asignarBloque(b.closest('[data-bloque]'), b); });
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
  // omitirVisitados va antes que la consulta de buscar (el worker atiende en orden)
  $('cOcultar').onchange = filtro(e => { S.ocultar = e.target.checked; store('ocultarVisitados', S.ocultar); omitirVisitados(); });
  let t; $('cRep').oninput = e => { clearTimeout(t); t = setTimeout(filtro(() => { S.f.rep = Math.max(0, +e.target.value || 0); }), 250); };
  document.querySelector('.vista-tabs').addEventListener('click', e => { const b = e.target.closest('[data-vista]'); if (b) setVista(b.dataset.vista); });
  $('cLista').addEventListener('click', async e => {
    const bv = e.target.closest('[data-visita],[data-desmarcar]');
    if (bv) { cambiarVisita(bv.dataset.visita || bv.dataset.desmarcar, !!bv.dataset.visita, bv); return; }
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
