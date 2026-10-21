// Selector IOARR — pestaña «Expediente» (Etapa 1: estructura de costos).
// El cálculo lo hace el servidor (src/selector-ioarr/costos.js), el mismo que
// arma el Excel: así la pantalla y el Excel dan lo mismo.
import { RUBROS, BASES, FUENTES_PRECIO, LIMITE_UIT } from '/selector-ioarr/costos.js';
import { ITEMS } from '/selector-ioarr/calculo.js';

const NF = new Intl.NumberFormat('es-PE');
const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ent = n => NF.format(Math.round(n || 0));
const soles = n => n == null ? '—' : 'S/ ' + NS.format(n);
const dec = n => NS.format(n || 0);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fechaPe = s => s ? s.split('-').reverse().join('/') : '';
const PAGE = 40;

let ctx = null;        // { el, proyecto, api, toast, guardarYa }
let datos = null;      // respuesta de /costos
let catalogo = null;   // precios del catálogo por tipo
let pagLoc = 0, tGuardar = null, version = 0, filtroLoc = '';
const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export async function renderExpediente(c) {
  ctx = c;
  const el = c.el;
  if (!c.proyecto) {
    el.innerHTML = `<div class="panel vacio"><h3 class="vacio-tit">Guarda la selección como proyecto</h3><p>El expediente (costos y documentos) se arma sobre un proyecto guardado.</p><button class="btn btn-primary" data-exp-nuevo type="button">Nuevo proyecto</button></div>`;
    return;
  }
  el.innerHTML = '<div class="panel vacio">Calculando la estructura de costos…</div>';
  const mio = ++version;
  try {
    await c.guardarYa();
    const [d, cat] = await Promise.all([c.api(`/proyectos/${c.proyecto.id}/costos`), c.api('/catalogo')]);
    if (mio !== version) return;
    datos = d; catalogo = agrupar(cat.precios); pagLoc = 0;
    pintar();
  } catch (e) {
    if (mio !== version) return;
    el.innerHTML = `<div class="panel vacio"><p class="err">${esc(e.message)}</p></div>`;
  }
}

function agrupar(precios) {
  const g = Object.fromEntries(ITEMS.map(x => [x.k, []]));
  for (const p of precios) g[p.tipo_bien]?.push(p);
  return g;
}

// ─── Pintado ─────────────────────────────────────────────────────────────────
function pintar() {
  ctx.el.innerHTML = `
    <div id="exp-kpis"></div>
    <div id="exp-avisos"></div>
    <div class="exportar">
      <div><h3>Excel de costos</h3><p>Parámetros, partidas, metrado y costos por local, y distribución por distrito. Todo con fórmulas de Excel: si el evaluador cambia un precio o un porcentaje, el libro se recalcula.</p></div>
      <button class="btn btn-primary" id="exp-excel" type="button">Exportar costos a Excel</button>
    </div>
    <div class="cols">
      <div class="panel" id="exp-precios"></div>
      <div class="panel" id="exp-rubros"></div>
    </div>
    <div id="exp-resultados"></div>`;
  pintarPrecios(); pintarRubros(); pintarResultados();
}

function pintarKpis() {
  const T = datos.totales, U = datos.uitCalc;
  const reg = U.valor == null ? '<span class="chip-est pend">UIT sin cargar</span>'
    : U.supera ? '<span class="chip-est alerta">Registro completo · supera 75 UIT</span>' : '<span class="chip-est ok">Registro abreviado · hasta 75 UIT</span>';
  document.getElementById('exp-kpis').innerHTML = `
    <div class="kpis kpis-montos">
      <div class="kpi destacado"><div class="v">${soles(T.total)}</div><div class="l">total de inversión</div></div>
      <div class="kpi"><div class="v">${soles(T.cd)}</div><div class="l">costo directo · ${ent(T.rep)} bienes a reponer</div></div>
      <div class="kpi"><div class="v">${T.porEstudiante == null ? '—' : soles(T.porEstudiante)}</div><div class="l">por estudiante · ${ent(T.est)} estudiantes</div></div>
      <div class="kpi"><div class="v">${U.enUit == null ? '—' : dec(U.enUit) + ' UIT'}</div><div class="l">${reg}</div></div>
    </div>`;
}

function pintarAvisos() {
  const clase = { uit75: 'aviso alerta', precio: 'aviso', faltante: 'aviso', uit: 'aviso', rubros: 'aviso', inventario: 'aviso' };
  document.getElementById('exp-avisos').innerHTML = datos.avisos.length
    ? `<div class="avisos">${datos.avisos.map(a => `<div class="${clase[a.tipo] || 'aviso'}" role="${a.tipo === 'uit75' ? 'alert' : 'note'}">${esc(a.texto)}</div>`).join('')}</div>` : '';
}

function pintarPrecios() {
  const filas = ITEMS.map((x, t) => {
    const p = datos.precios[x.k], part = datos.partidas[t], lista = catalogo[x.k] || [];
    const origen = p.origen === 'proyecto' ? '<span class="chip-est ok">Fijado en el proyecto</span>'
      : p.origen === 'vigente' ? '<span class="chip-est">Vigente del catálogo</span>' : '<span class="chip-est pend">Sin precio</span>';
    const opciones = lista.map(c => `<option value="${c.id}" ${p.origen === 'proyecto' && p.precio_id === c.id ? 'selected' : ''}>${soles(Number(c.precio))} · ${esc(c.descripcion)} · ${esc(FUENTES_PRECIO[c.fuente])} ${fechaPe(c.fecha)}${c.vigente ? ' · vigente' : ''}</option>`).join('');
    const distinto = p.vigente_distinto ? `<div class="sub aviso-linea">El vigente del catálogo ahora es ${soles(p.vigente_distinto.precio)} (${esc(p.vigente_distinto.descripcion)}).</div>` : '';
    return `<tr>
      <td><b>${x.n}</b><br><span class="sub">${ent(part.rep)} ${x.u} a reponer</span></td>
      <td class="num"><b>${soles(p.precio)}</b><br>${origen}</td>
      <td>${p.descripcion ? `${esc(p.descripcion)}<br><span class="sub">${esc(FUENTES_PRECIO[p.fuente] || '')} ${fechaPe(p.fecha)}</span>` : '<span class="sub">—</span>'}${distinto}
        <div class="precio-acc">${lista.length ? `<select data-precio="${x.k}" aria-label="Precio de ${x.n}"><option value="">${p.origen === 'proyecto' ? 'Usar el vigente del catálogo' : 'Fijar un precio del catálogo…'}</option>${opciones}</select>` : '<span class="sub">No hay precios de este tipo en el catálogo.</span>'}</div></td>
    </tr>`;
  }).join('');
  document.getElementById('exp-precios').innerHTML = `
    <div class="panel-cab"><h3>Precios unitarios (sin IGV)</h3><a class="btn btn-ghost btn-sm" href="selector-ioarr-precios.html" target="_blank" rel="noopener">Catálogo de precios ↗</a></div>
    <p class="sub pad">Se usa el precio vigente del catálogo, salvo que fijes uno para este proyecto. Al fijarlo se guarda una copia: si el catálogo cambia, el proyecto no cambia sin aviso.</p>
    <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Tipo de bien</th><th class="num">Precio</th><th>Origen</th></tr></thead><tbody>${filas}</tbody></table></div>`;
}

function pintarRubros() {
  const filas = datos.rubros.map(r => {
    const def = RUBROS.find(x => x.clave === r.clave);
    const base = def.bases.length > 1
      ? `<select data-rubro="${r.clave}" data-campo="base" aria-label="Base de ${def.nombre}">${def.bases.map(b => `<option value="${b}" ${r.base === b ? 'selected' : ''}>${esc(BASES[b])}</option>`).join('')}</select>`
      : `<span class="sub">${esc(BASES[def.bases[0]])}</span>`;
    return `<tr>
      <td><b>${def.nombre}</b>${def.zona ? `<br><span class="sub">+ factor por zona (${def.zona === 'flete' ? 'flete' : 'instalación'})</span>` : ''}</td>
      <td><div class="rubro-val">
        <select data-rubro="${r.clave}" data-campo="modo" aria-label="Modo de ${def.nombre}"><option value="pct" ${r.modo === 'pct' ? 'selected' : ''}>%</option><option value="monto" ${r.modo === 'monto' ? 'selected' : ''}>S/</option></select>
        <input data-rubro="${r.clave}" data-campo="valor" type="number" inputmode="decimal" min="0" step="0.01" value="${r.valor}" aria-label="Valor de ${def.nombre}">
      </div></td>
      <td>${base}</td>
      <td class="num" data-monto="${r.clave}">${soles(r.monto)}</td>
    </tr>`;
  }).join('');
  document.getElementById('exp-rubros').innerHTML = `
    <div class="panel-cab"><h3>Rubros</h3><span class="guardado" id="exp-guardado"></span></div>
    <p class="sub pad">Cada rubro va en % (sobre la base de cada local) o como monto fijo (se reparte entre los locales según su base). Carga tú cada valor: el sistema no propone porcentajes.</p>
    <div class="tabla-wrap borde-0"><table class="tabla tabla-rubros"><thead><tr><th>Rubro</th><th>Valor</th><th>Base</th><th class="num">Monto</th></tr></thead><tbody>${filas}</tbody></table></div>
    <div class="uit-fila">
      <div class="campo"><label for="exp-anio">Año de la UIT</label><input id="exp-anio" type="number" min="2000" max="2100" step="1" value="${datos.anio_uit}"></div>
      <div class="sub">${datos.uit ? `UIT ${datos.uit.anio}: <b>${soles(Number(datos.uit.valor))}</b>${datos.uit.fuente ? ' · ' + esc(datos.uit.fuente) : ''} · límite de ${LIMITE_UIT} UIT = ${soles(datos.uitCalc.limite)}` : `No hay UIT cargada para ${datos.anio_uit}. Cárgala en el <a href="selector-ioarr-precios.html#uit" target="_blank" rel="noopener">catálogo</a>.`}</div>
    </div>`;
}

function pintarResultados() {
  pintarKpis(); pintarAvisos();
  for (const r of datos.rubros) { const td = document.querySelector(`[data-monto="${r.clave}"]`); if (td) td.textContent = soles(r.monto); }
  const T = datos.totales, R = Object.fromEntries(datos.rubros.map(r => [r.clave, r]));
  const lin = (txt, v, cls = '') => `<tr class="${cls}"><td>${txt}</td><td class="num">${soles(v)}</td></tr>`;
  const rub = k => lin(`<span class="sangria">${esc(R[k].nombre)}</span>`, R[k].monto);
  const partidas = datos.partidas.map(p => `<tr><td>${p.n}</td><td>${p.u}</td><td class="num">${ent(p.rep)}</td><td class="num">${soles(p.pu)}</td><td class="num">${soles(p.parcial)}</td></tr>`).join('');
  const falt = datos.partidas.map(p => `<tr><td>${p.n}</td><td class="num">${ent(p.fal)}</td><td class="num">${soles(p.falValor)}</td></tr>`).join('');
  const dist = datos.distritos.map(d => `<tr><td>${esc(d.nom)}<br><span class="sub">${esc(d.prov)} · ${d.ubigeo}</span></td><td class="num">${ent(d.n)}</td><td class="num">${ent(d.est)}</td><td class="num">${ent(d.rep)}</td><td class="num">${soles(d.total)}</td><td class="num">${d.porEstudiante == null ? '—' : soles(d.porEstudiante)}</td></tr>`).join('');
  const q = norm(filtroLoc).trim();
  const locs = [...datos.locales].filter(l => !q || l.cod.includes(q) || norm(l.nom).includes(q) || norm(l.dist).includes(q))
    .sort((a, b) => b.total - a.total || a.cod.localeCompare(b.cod));
  const pags = Math.max(1, Math.ceil(locs.length / PAGE)); pagLoc = Math.min(pagLoc, pags - 1);
  const desde = pagLoc * PAGE;
  const lrows = locs.slice(desde, desde + PAGE).map(l => `<tr><td class="mono">${l.cod}</td><td><span class="nm">${esc(l.nom)}</span><span class="sub">${esc(l.dist)}${l.rural ? ' · rural' : ''}</span></td><td class="num">${ent(l.est)}</td><td class="num">${ent(l.rep)}</td><td class="num">${ent(l.fal)}</td><td class="num">${l.zona.flete || l.zona.instalacion ? `+${dec(l.zona.flete * 100)} % / +${dec(l.zona.instalacion * 100)} %` : '<span class="sub">—</span>'}</td><td class="num">${soles(l.cd)}</td><td class="num"><b>${soles(l.total)}</b></td>
    <td>${l.verificado ? `<span class="chip-est ok">Verificado ${fechaPe(l.verificado.fecha_visita)}</span><br>` : ''}<button class="x" data-inv="${esc(l.cod)}" type="button">${l.verificado ? 'Editar' : 'Corregir inventario'}</button></td></tr>`).join('');

  document.getElementById('exp-resultados').innerHTML = `
    <div class="cols">
      <div class="panel"><div class="panel-cab"><h3>Estructura de costos</h3></div>
        <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Partida</th><th>Unidad</th><th class="num">Metrado</th><th class="num">P. unitario</th><th class="num">Parcial</th></tr></thead><tbody>${partidas}</tbody>
        <tfoot><tr><td colspan="2">Costo directo</td><td class="num">${ent(T.rep)}</td><td></td><td class="num">${soles(T.cd)}</td></tr></tfoot></table></div>
        <div class="tabla-wrap borde-0"><table class="tabla tabla-estructura"><tbody>
          ${lin('<b>Costo directo</b>', T.cd, 'fuerte')}${rub('transporte')}${rub('instalacion')}${rub('embalaje')}
          ${lin('<b>Subtotal</b>', T.subtotal, 'fuerte')}${rub('gg')}${rub('utilidad')}
          ${lin('<b>Subtotal + GG + utilidad</b>', T.neto, 'fuerte')}${rub('igv')}
          ${lin('<b>Costo de los bienes (con IGV)</b>', T.bienes, 'fuerte')}${rub('supervision')}${rub('expediente')}${rub('gestion')}${rub('imprevistos')}
          ${lin('<b>TOTAL DE INVERSIÓN</b>', T.total, 'total')}
        </tbody></table></div></div>
      <div class="panel"><div class="panel-cab"><h3>Faltante, no incluido en el total</h3></div>
        <p class="sub pad">Bienes por encima de los existentes. Amplían la capacidad de la UP: no se sustentan como reposición (Lineamientos IOARR del MEF, 2.4.C). Se valorizan con los mismos precios, solo como referencia para evaluarlos como ampliación marginal.</p>
        <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Tipo</th><th class="num">Faltante</th><th class="num">Valor referencial</th></tr></thead><tbody>${falt}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${ent(T.fal)}</td><td class="num">${soles(T.falValor)}</td></tr></tfoot></table></div>
        <p class="sub pad">Metrado total del Selector: ${ent(T.rep)} de reposición + ${ent(T.fal)} de faltante = <b>${ent(T.rep + T.fal)}</b> bienes.</p></div>
    </div>
    <div class="panel"><div class="panel-cab"><h3>Por distrito</h3></div>
      <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Distrito</th><th class="num">Locales</th><th class="num">Estudiantes</th><th class="num">Bienes a reponer</th><th class="num">Total</th><th class="num">Por estudiante</th></tr></thead><tbody>${dist}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${ent(T.locales)}</td><td class="num">${ent(T.est)}</td><td class="num">${ent(T.rep)}</td><td class="num">${soles(T.total)}</td><td class="num">${T.porEstudiante == null ? '—' : soles(T.porEstudiante)}</td></tr></tfoot></table></div></div>
    <div class="panel"><div class="panel-cab"><h3>Por local</h3><span class="sub">Ordenados por total</span></div>
      <div class="pad"><input id="exp-buscar" type="search" placeholder="Buscar por código de local, nombre o distrito" value="${esc(filtroLoc)}" autocomplete="off" aria-label="Buscar local"></div>
      <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Código de local</th><th>Instituciones</th><th class="num">Estudiantes</th><th class="num">Reposición</th><th class="num">Faltante</th><th class="num">Zona (flete / instal.)</th><th class="num">Costo directo</th><th class="num">Total</th><th>Inventario</th></tr></thead><tbody>${lrows || '<tr><td colspan="9" class="vacio">Ningún local coincide con la búsqueda.</td></tr>'}</tbody></table></div>
      ${pags > 1 ? `<div class="paginacion pad-pag"><span class="sub">${ent(desde + 1)}–${ent(Math.min(locs.length, desde + PAGE))} de ${ent(locs.length)}</span><div class="pg-btns"><button class="btn btn-ghost btn-sm" data-exp-pag="-1" type="button" ${pagLoc === 0 ? 'disabled' : ''}>Anterior</button><span class="mono">${pagLoc + 1} / ${pags}</span><button class="btn btn-ghost btn-sm" data-exp-pag="1" type="button" ${pagLoc >= pags - 1 ? 'disabled' : ''}>Siguiente</button></div></div>` : ''}</div>`;
}

// ─── Cambios ────────────────────────────────────────────────────────────────
function estado(t, cls = '') { const s = document.getElementById('exp-guardado'); if (s) { s.className = 'guardado ' + cls; s.textContent = t; } }

function leerRubros() {
  return datos.rubros.map(r => {
    const q = c => document.querySelector(`[data-rubro="${r.clave}"][data-campo="${c}"]`);
    const v = parseFloat(q('valor')?.value);
    return { clave: r.clave, modo: q('modo')?.value || r.modo, valor: Number.isFinite(v) && v >= 0 ? v : 0, base: q('base')?.value || r.base };
  });
}

async function guardar(body) {
  const mio = ++version;
  estado('Guardando…', 'pend');
  try {
    const d = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos`, { method: 'PATCH', body });
    if (mio !== version) return;
    const cambioAnio = d.anio_uit !== datos.anio_uit || (d.uit?.valor ?? null) !== (datos.uit?.valor ?? null);
    datos = d;
    pintarResultados();
    if (cambioAnio) pintarRubros();
    estado('Guardado', 'ok');
  } catch (e) { if (mio === version) estado('No se pudo guardar: ' + e.message, 'error'); }
}

async function cambiarPrecio(tipo, precioId) {
  const mio = ++version;
  try {
    const ruta = `/proyectos/${ctx.proyecto.id}/costos/precios/${tipo}`;
    const d = precioId ? await ctx.api(ruta, { method: 'PUT', body: { precio_id: precioId } }) : await ctx.api(ruta, { method: 'DELETE' });
    if (mio !== version) return;
    datos = d; pintarPrecios(); pintarResultados();
    ctx.toast(precioId ? 'Precio fijado en el proyecto.' : 'Se usa el precio vigente del catálogo.');
  } catch (e) { ctx.toast('No se pudo cambiar el precio: ' + e.message); }
}

async function exportar(btn) {
  btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Generando…';
  try {
    clearTimeout(tGuardar);
    const r = await fetch(`/api/selector-ioarr/proyectos/${ctx.proyecto.id}/costos/excel`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error ' + r.status);
    const blob = await r.blob(), cd = r.headers.get('Content-Disposition') || '';
    const nombre = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'Costos_IOARR.xlsx');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    ctx.toast('Excel de costos descargado.');
  } catch (e) { ctx.toast('No se pudo exportar: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = txt; }
}

// Eventos delegados: se enganchan una vez sobre el contenedor
export function enlazarExpediente(el, abrirNuevo) {
  el.addEventListener('input', e => {
    if (e.target.id === 'exp-buscar') {
      filtroLoc = e.target.value; pagLoc = 0;
      const pos = e.target.selectionStart; pintarResultados();
      const b = document.getElementById('exp-buscar'); b.focus(); b.setSelectionRange(pos, pos);
      return;
    }
    if (e.target.dataset.campo === 'valor') { clearTimeout(tGuardar); estado('Cambios sin guardar', 'pend'); tGuardar = setTimeout(() => guardar({ rubros: leerRubros() }), 700); }
    if (e.target.id === 'exp-anio') {
      clearTimeout(tGuardar);
      const a = Number(e.target.value);
      if (Number.isInteger(a) && a >= 2000 && a <= 2100) tGuardar = setTimeout(() => guardar({ anio_uit: a }), 700);
    }
  });
  el.addEventListener('change', e => {
    const c = e.target.dataset.campo;
    if (c === 'modo' || c === 'base') { clearTimeout(tGuardar); guardar({ rubros: leerRubros() }); }
    if (e.target.dataset.precio) cambiarPrecio(e.target.dataset.precio, e.target.value || null);
  });
  el.addEventListener('click', e => {
    if (e.target.id === 'exp-excel') exportar(e.target);
    if (e.target.closest('[data-exp-nuevo]')) abrirNuevo();
    const pg = e.target.closest('[data-exp-pag]');
    if (pg) { pagLoc += +pg.dataset.expPag; pintarResultados(); }
    const inv = e.target.closest('[data-inv]');
    if (inv) abrirInventario(inv.dataset.inv);
  });
}

// ─── Inventario verificado en campo ──────────────────────────────────────────
// Reemplaza el censo de un local en el expediente (costos y Excel). El Selector sigue con el censo.
function modalInventario() {
  let m = document.getElementById('m-inv');
  if (m) return m;
  m = document.createElement('div');
  m.className = 'modal-overlay'; m.id = 'm-inv';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'm-inv-tit');
  m.innerHTML = `<form class="modal" id="f-inv">
    <button class="cerrar" type="button" data-cerrar aria-label="Cerrar">×</button>
    <h2 id="m-inv-tit">Inventario verificado en campo</h2>
    <p class="sub" id="inv-local"></p>
    <p class="sub">Marca los tipos de bien que verificaste y escribe lo que encontraste. En esos tipos, el expediente usa tus cantidades en lugar del Censo Educativo: reposición = malo + % de regular; faltante = requerido − existente. El Selector sigue mostrando el censo.</p>
    <div class="tabla-wrap"><table class="tabla tabla-inv"><thead><tr><th>Tipo de bien</th><th class="num">Requerido</th><th class="num">Censo (B / R / M)</th><th>Corregir</th><th>Bueno</th><th>Regular</th><th>Malo</th></tr></thead><tbody id="inv-tbody"></tbody></table></div>
    <div class="form-grid">
      <div class="campo"><label for="inv-fecha">Fecha de la visita</label><input id="inv-fecha" type="date" required></div>
      <div class="campo"><label for="inv-resp">Responsable</label><input id="inv-resp" type="text" maxlength="200" placeholder="Quién hizo la visita"></div>
      <div class="campo ancho"><label for="inv-obs">Sustento</label><textarea id="inv-obs" maxlength="1000" required placeholder="Ej.: acta de verificación firmada por el director, 32 fotos; las mesas existen pero están rotas"></textarea></div>
    </div>
    <p class="err" id="inv-err" hidden></p>
    <div class="modal-acts">
      <button class="btn btn-ghost btn-peligro" type="button" id="inv-quitar" hidden>Quitar corrección (usar el censo)</button>
      <button class="btn btn-ghost" type="button" data-cerrar>Cancelar</button>
      <button class="btn btn-primary" type="submit" id="inv-ok">Guardar</button>
    </div>
  </form>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-cerrar]')) m.classList.remove('open'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') m.classList.remove('open'); });
  m.querySelector('#inv-tbody').addEventListener('change', e => {
    const k = e.target.dataset.invChk;
    if (k) m.querySelectorAll(`[data-inv-k="${k}"]`).forEach(i => { i.disabled = !e.target.checked; });
  });
  m.querySelector('#f-inv').addEventListener('submit', guardarInventario);
  m.querySelector('#inv-quitar').addEventListener('click', quitarInventario);
  return m;
}

let invCod = null;
async function abrirInventario(cod) {
  const m = modalInventario();
  invCod = cod;
  try {
    const d = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos/inventario/${encodeURIComponent(cod)}`);
    if (d.sin_migracion) { ctx.toast('Falta ejecutar supabase/migrations/013_ioarr_expediente_inventario.sql en Supabase'); return; }
    const v = d.verificado;
    m.querySelector('#inv-local').innerHTML = `<b>${esc(d.cod)}</b> · ${esc(d.nom)}`;
    m.querySelector('#inv-tbody').innerHTML = ITEMS.map(x => {
      const c = d.censo[x.k], f = v?.bienes?.[x.k], on = !!f, val = (k) => f ? f[k] : c[k];
      const inp = k => `<input type="number" min="0" step="1" inputmode="numeric" data-inv-k="${x.k}" data-c="${k}" value="${val(k)}" ${on ? '' : 'disabled'} required aria-label="${x.n}: ${{ b: 'bueno', r: 'regular', m: 'malo' }[k]}">`;
      return `<tr><td><b>${x.n}</b></td><td class="num">${ent(c.req)}</td><td class="num">${ent(c.b)} / ${ent(c.r)} / ${ent(c.m)}${c.b + c.r + c.m < c.req ? '<br><span class="sub aviso-linea">faltan ' + ent(c.req - c.b - c.r - c.m) + '</span>' : ''}</td>
        <td><label class="chk"><input type="checkbox" data-inv-chk="${x.k}" ${on ? 'checked' : ''}> Corregir</label></td><td>${inp('b')}</td><td>${inp('r')}</td><td>${inp('m')}</td></tr>`;
    }).join('');
    m.querySelector('#inv-fecha').value = v?.fecha_visita || '';
    m.querySelector('#inv-fecha').max = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    m.querySelector('#inv-resp').value = v?.responsable || '';
    m.querySelector('#inv-obs').value = v?.observacion || '';
    m.querySelector('#inv-quitar').hidden = !v;
    m.querySelector('#inv-err').hidden = true;
    m.classList.add('open');
  } catch (e) { ctx.toast('No se pudo abrir el inventario: ' + e.message); }
}

async function guardarInventario(e) {
  e.preventDefault();
  const m = modalInventario(), err = m.querySelector('#inv-err'), bienes = {};
  m.querySelectorAll('[data-inv-chk]:checked').forEach(chk => {
    const k = chk.dataset.invChk, n = c => Number(m.querySelector(`[data-inv-k="${k}"][data-c="${c}"]`).value);
    bienes[k] = { b: n('b'), r: n('r'), m: n('m') };
  });
  if (!Object.keys(bienes).length) { err.textContent = 'Marca al menos un tipo de bien para corregir.'; err.hidden = false; return; }
  const btn = m.querySelector('#inv-ok'); btn.disabled = true;
  try {
    datos = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos/inventario/${encodeURIComponent(invCod)}`, { method: 'PUT', body: {
      bienes, fecha_visita: m.querySelector('#inv-fecha').value, responsable: m.querySelector('#inv-resp').value, observacion: m.querySelector('#inv-obs').value } });
    m.classList.remove('open');
    pintarPrecios(); pintarResultados();
    ctx.toast('Inventario verificado guardado.');
  } catch (x) { err.textContent = x.message; err.hidden = false; }
  finally { btn.disabled = false; }
}

async function quitarInventario() {
  if (!confirm('¿Quitar la corrección? El local vuelve a calcularse con el Censo Educativo.')) return;
  const m = modalInventario();
  try {
    datos = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos/inventario/${encodeURIComponent(invCod)}`, { method: 'DELETE' });
    m.classList.remove('open');
    pintarPrecios(); pintarResultados();
    ctx.toast('Se usa otra vez el censo.');
  } catch (x) { ctx.toast('No se pudo quitar: ' + x.message); }
}
