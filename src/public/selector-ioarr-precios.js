// Selector IOARR — catálogo compartido de precios, UIT y factores por zona.
// API: /api/selector-ioarr/catalogo/* (src/selector-ioarr/expediente.js)
import { ITEMS } from '/selector-ioarr/calculo.js';
import { FUENTES_PRECIO, LIMITE_UIT, tipoDesdeDescripcion } from '/selector-ioarr/costos.js';

const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const soles = n => 'S/ ' + NS.format(Number(n) || 0);
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fechaPe = s => s ? s.split('-').reverse().join('/') : '';
const NOMBRE = Object.fromEntries(ITEMS.map(x => [x.k, x.n]));
const UNIDAD = { mesa: 'puesto', silla: 'unidad', esc: 'unidad', sdoc: 'unidad', arm: 'unidad' };
const AMBITO = { provincia: 'Provincia', distrito: 'Distrito', rural: 'Área rural' };
function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3800); }

async function api(ruta, { method = 'GET', body } = {}) {
  const r = await fetch('/api/selector-ioarr' + ruta, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Error ' + r.status);
  return data;
}

const S = { precios: [], uit: [], factores: [], editando: null, ubigeos: new Map(), regiones: [] };

async function cargar() {
  try {
    const c = await api('/catalogo');
    Object.assign(S, { precios: c.precios, uit: c.uit, factores: c.factores });
    pintarPrecios(); pintarUit(); pintarFactores();
  } catch (e) { $('p-tbody').innerHTML = `<tr><td colspan="8" class="err">${esc(e.message)}</td></tr>`; }
}

// ─── Precios ─────────────────────────────────────────────────────────────────
function pintarPrecios() {
  const f = $('p-filtro').value;
  const lista = S.precios.filter(p => !f || p.tipo_bien === f);
  $('p-tbody').innerHTML = lista.length ? lista.map(p => `<tr>
      <td><b>${esc(NOMBRE[p.tipo_bien])}</b>${p.vigente ? '<br><span class="chip-est ok">Vigente</span>' : ''}</td>
      <td>${esc(p.descripcion)}</td><td class="num"><b>${soles(p.precio)}</b></td><td>${esc(p.unidad)}</td>
      <td>${fechaPe(p.fecha)}</td><td>${esc(FUENTES_PRECIO[p.fuente])}</td><td class="sub">${esc(p.observacion || '')}</td>
      <td><div class="acciones-fila">${p.vigente ? '' : `<button class="x" data-vig="${p.id}" type="button">Marcar vigente</button>`}<button class="x" data-ed="${p.id}" type="button">Editar</button><button class="x btn-peligro" data-del="${p.id}" type="button">Borrar</button></div></td>
    </tr>`).join('') : '<tr><td colspan="8" class="vacio">Aún no hay precios cargados.</td></tr>';
}

const hayVigente = tipo => S.precios.some(x => x.tipo_bien === tipo && x.vigente);

function abrirPrecio(p, prellenado = {}) {
  S.editando = p?.id || null;
  const v = p || prellenado;
  $('m-precio-tit').textContent = p ? 'Editar precio' : 'Nuevo precio';
  $('f-tipo').value = v.tipo_bien || $('p-filtro').value || 'mesa';
  $('f-precio-v').value = v.precio ?? '';
  $('f-unidad').value = v.unidad || UNIDAD[$('f-tipo').value];
  $('f-fecha').value = v.fecha || '';
  $('f-fuente').value = v.fuente || 'cotizacion';
  $('f-desc').value = v.descripcion || '';
  $('f-obs').value = v.observacion || '';
  $('f-vigente').checked = p ? !!p.vigente : !hayVigente($('f-tipo').value);
  $('f-err').hidden = true;
  $('f-tipo-aviso').hidden = !prellenado.aviso_tipo;
  $('f-tipo-aviso').textContent = prellenado.aviso_tipo || '';
  $('m-precio').classList.add('open');
  setTimeout(() => $('f-precio-v').focus(), 30);
}

async function guardarPrecio(e) {
  e.preventDefault();
  const body = {
    tipo_bien: $('f-tipo').value, precio: Number($('f-precio-v').value), unidad: $('f-unidad').value, fecha: $('f-fecha').value,
    fuente: $('f-fuente').value, descripcion: $('f-desc').value, observacion: $('f-obs').value, vigente: $('f-vigente').checked
  };
  $('f-ok').disabled = true;
  try {
    if (S.editando) await api('/catalogo/precios/' + S.editando, { method: 'PATCH', body });
    else await api('/catalogo/precios', { method: 'POST', body });
    $('m-precio').classList.remove('open');
    toast('Precio guardado.');
    await cargar();
  } catch (err) { $('f-err').textContent = err.message; $('f-err').hidden = false; }
  finally { $('f-ok').disabled = false; }
}

// Copiar de Radar IOARR (ioarr_precios_referencia)
let tRef;
async function buscarRef() {
  const tb = $('r-tbody');
  try {
    const filas = await api('/catalogo/referencias?q=' + encodeURIComponent($('r-q').value.trim()));
    S.refs = filas;
    tb.innerHTML = filas.length ? filas.map((r, i) => `<tr><td>${esc(r.descripcion || '')}<br><span class="sub mono">${esc(r.codigo_bien)}</span>${r.cuadra ? '' : ' <span class="chip-est pend">no cuadra</span>'}</td>
      <td class="mono">${esc(r.cui_origen)}${r.anio_ficha ? ' · ' + r.anio_ficha : ''}</td><td class="num">${r.a == null ? '—' : soles(r.a)}</td><td class="num">${r.d == null ? '—' : soles(r.d)}</td>
      <td><button class="x" data-usar="${i}" type="button" ${r.a == null ? 'disabled' : ''}>Usar</button></td></tr>`).join('')
      : '<tr><td colspan="5" class="vacio">No hay precios de referencia que coincidan.</td></tr>';
  } catch (e) { tb.innerHTML = `<tr><td colspan="5" class="err">${esc(e.message)}</td></tr>`; }
}
function usarRef(r) {
  $('m-ref').classList.remove('open');
  const partes = ['a', 'b', 'c', 'd'].filter(k => r[k] != null).map(k => `${k} = ${soles(r[k])}`).join(', ');
  const tipo = tipoDesdeDescripcion(r.descripcion);
  abrirPrecio(null, {
    tipo_bien: tipo || undefined,
    aviso_tipo: tipo ? `Tipo propuesto según la descripción: ${NOMBRE[tipo]}. Revísalo.` : 'No se reconoció el tipo de bien por la descripción: elígelo.',
    precio: r.a, fuente: 'historico', descripcion: r.descripcion || r.codigo_bien,
    observacion: `Estructura de costos del CUI ${r.cui_origen}${r.anio_ficha ? ' (' + r.anio_ficha + ')' : ''}, bien ${r.codigo_bien}: ${partes}. Se copió a (costo de adquisición).${r.cuadra ? '' : ' La fila no cumple d = (a + b + c) × 1.15.'}`
  });
}

// ─── UIT ─────────────────────────────────────────────────────────────────────
function pintarUit() {
  $('u-tbody').innerHTML = S.uit.length ? S.uit.map(u => `<tr><td class="mono">${u.anio}</td><td class="num"><b>${soles(u.valor)}</b></td><td class="num">${soles(u.valor * LIMITE_UIT)}</td><td>${esc(u.fuente || '')}</td>
    <td><div class="acciones-fila"><button class="x" data-uit-ed="${u.anio}" type="button">Editar</button><button class="x btn-peligro" data-uit-del="${u.anio}" type="button">Borrar</button></div></td></tr>`).join('')
    : '<tr><td colspan="5" class="vacio">Aún no hay valores de UIT cargados.</td></tr>';
}
async function guardarUit(e) {
  e.preventDefault();
  try {
    await api('/catalogo/uit/' + Number($('u-anio').value), { method: 'PUT', body: { valor: Number($('u-valor').value), fuente: $('u-fuente').value } });
    $('u-form').reset(); toast('UIT guardada.'); await cargar();
  } catch (err) { toast('No se pudo guardar: ' + err.message); }
}

// ─── Factores por zona ───────────────────────────────────────────────────────
async function ubigeos(region) {
  if (!S.ubigeos.has(region)) S.ubigeos.set(region, await api('/ubigeos?region=' + encodeURIComponent(region)));
  return S.ubigeos.get(region);
}
async function pintarZonas() {
  const sel = $('z-codigo');
  try {
    const u = await ubigeos($('z-region').value), amb = $('z-ambito').value;
    const ops = amb === 'rural' ? [{ codigo: u.departamento, nombre: `Locales rurales de ${u.region}` }]
      : amb === 'provincia' ? u.provincias : u.distritos.map(d => ({ codigo: d.codigo, nombre: `${d.nombre} (${d.provincia})` }));
    sel.innerHTML = ops.map(o => `<option value="${o.codigo}">${esc(o.nombre)}</option>`).join('');
    llenarFactor();
  } catch (e) { sel.innerHTML = ''; toast(e.message); }
}
// Si ya hay un factor para la zona elegida, lo carga para editarlo
function llenarFactor() {
  const f = S.factores.find(x => x.ambito === $('z-ambito').value && x.codigo === $('z-codigo').value);
  $('z-flete').value = f ? Number(f.pct_flete) : 0; $('z-inst').value = f ? Number(f.pct_instalacion) : 0; $('z-obs').value = f?.observacion || '';
}
function pintarFactores() {
  $('z-tbody').innerHTML = S.factores.length ? S.factores.map(f => `<tr><td>${AMBITO[f.ambito]}</td><td>${esc(f.nombre || '')}</td><td class="mono">${f.codigo}</td>
    <td class="num">+${NS.format(f.pct_flete)} %</td><td class="num">+${NS.format(f.pct_instalacion)} %</td><td class="sub">${esc(f.observacion || '')}</td>
    <td><button class="x btn-peligro" data-z-del="${f.id}" type="button">Borrar</button></td></tr>`).join('')
    : '<tr><td colspan="7" class="vacio">Sin factores: los locales se calculan sin recargo por zona.</td></tr>';
}
async function guardarFactor(e) {
  e.preventDefault();
  const sel = $('z-codigo');
  if (!sel.value) return;
  try {
    await api('/catalogo/factores', { method: 'PUT', body: {
      ambito: $('z-ambito').value, codigo: sel.value, nombre: sel.selectedOptions[0]?.textContent,
      pct_flete: Number($('z-flete').value), pct_instalacion: Number($('z-inst').value), observacion: $('z-obs').value
    } });
    toast('Factor guardado.'); await cargar();
  } catch (err) { toast('No se pudo guardar: ' + err.message); }
}

// ─── Arranque ────────────────────────────────────────────────────────────────
async function boot() {
  $('p-filtro').innerHTML = '<option value="">Todos los tipos</option>' + ITEMS.map(x => `<option value="${x.k}">${x.n}</option>`).join('');
  $('f-tipo').innerHTML = ITEMS.map(x => `<option value="${x.k}">${x.n}</option>`).join('');
  $('f-fuente').innerHTML = Object.entries(FUENTES_PRECIO).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('p-filtro').onchange = pintarPrecios;
  $('p-nuevo').onclick = () => abrirPrecio(null);
  $('p-ref').onclick = () => { $('r-q').value = ''; $('m-ref').classList.add('open'); buscarRef(); setTimeout(() => $('r-q').focus(), 30); };
  $('r-q').oninput = () => { clearTimeout(tRef); tRef = setTimeout(buscarRef, 250); };
  $('r-tbody').onclick = e => { const b = e.target.closest('[data-usar]'); if (b) usarRef(S.refs[+b.dataset.usar]); };
  // En un precio nuevo, al cambiar el tipo se ajustan la unidad y «vigente» (si el tipo aún no tiene uno)
  $('f-tipo').onchange = () => { if (!S.editando) { $('f-unidad').value = UNIDAD[$('f-tipo').value]; $('f-vigente').checked = !hayVigente($('f-tipo').value); } };
  $('f-precio').onsubmit = guardarPrecio;
  $('p-tbody').onclick = async e => {
    const id = t => e.target.closest(`[data-${t}]`)?.dataset[t];
    try {
      if (id('vig')) { await api('/catalogo/precios/' + id('vig'), { method: 'PATCH', body: { vigente: true } }); toast('Precio marcado como vigente.'); await cargar(); }
      else if (id('ed')) abrirPrecio(S.precios.find(p => p.id === id('ed')));
      else if (id('del') && confirm('¿Borrar este precio? Los proyectos que lo fijaron conservan su copia.')) { await api('/catalogo/precios/' + id('del'), { method: 'DELETE' }); toast('Precio borrado.'); await cargar(); }
    } catch (err) { toast(err.message); }
  };
  $('u-form').onsubmit = guardarUit;
  $('u-tbody').onclick = async e => {
    const ed = e.target.closest('[data-uit-ed]'), del = e.target.closest('[data-uit-del]');
    if (ed) { const u = S.uit.find(x => String(x.anio) === ed.dataset.uitEd); $('u-anio').value = u.anio; $('u-valor').value = u.valor; $('u-fuente').value = u.fuente || ''; $('u-valor').focus(); }
    if (del && confirm(`¿Borrar la UIT de ${del.dataset.uitDel}?`)) { try { await api('/catalogo/uit/' + del.dataset.uitDel, { method: 'DELETE' }); await cargar(); } catch (err) { toast(err.message); } }
  };
  $('z-form').onsubmit = guardarFactor;
  $('z-region').onchange = pintarZonas; $('z-ambito').onchange = pintarZonas; $('z-codigo').onchange = llenarFactor;
  $('z-tbody').onclick = async e => {
    const del = e.target.closest('[data-z-del]');
    if (del && confirm('¿Borrar este factor?')) { try { await api('/catalogo/factores/' + del.dataset.zDel, { method: 'DELETE' }); await cargar(); llenarFactor(); } catch (err) { toast(err.message); } }
  };
  document.querySelectorAll('.modal-overlay').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-cerrar]')) m.classList.remove('open'); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open')); });

  await cargar();
  try {
    const idx = await fetch('/data/selector-ioarr/2025/index.json').then(r => r.json());
    $('z-region').innerHTML = idx.regiones.map(g => `<option value="${esc(g.nombre)}">${esc(g.nombre)}</option>`).join('');
    $('z-region').value = idx.regiones.some(g => g.nombre === 'Moquegua') ? 'Moquegua' : idx.regiones[0].nombre;
    await pintarZonas();
  } catch { toast('No se pudo cargar la lista de regiones.'); }
}
boot();
