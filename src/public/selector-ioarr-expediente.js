// Selector IOARR — pestaña «Expediente» (Etapa 1: estructura de costos).
// El cálculo lo hace el servidor (src/selector-ioarr/costos.js), el mismo que
// arma el Excel: así la pantalla y el Excel dan lo mismo.
import { RUBROS, BASES, FUENTES_PRECIO, LIMITE_UIT, TIPOS_ARCHIVO } from '/selector-ioarr/costos.js';
import { ITEMS, CLAVES_PRECIO } from '/selector-ioarr/calculo.js';
import { renderDocumentos, enlazarDocumentos } from '/selector-ioarr-documentos.js';
import { renderVerificacion, enlazarVerificacion } from '/selector-ioarr-verificacion.js';
import { renderFichas, enlazarFichas } from '/selector-ioarr-fichas.js';

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
let vistaExp = 'costos';   // sub-pestaña: 'costos' | 'fichas' | 'docs' | 'verif'
let costosViejos = false;  // se importaron fichas: al volver a Costos se recalcula
let nivelExp = null;       // IOARR a la vista con «Una IOARR por nivel»: 'I' | 'P' | 'S' | 'E'
let proyectoExp = null;    // al cambiar de proyecto se vuelve a la primera IOARR
const qn = () => nivelExp ? `?nivel=${nivelExp}` : '';
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
    if (proyectoExp !== c.proyecto.id) { proyectoExp = c.proyecto.id; nivelExp = null; }
    const [d, cat] = await Promise.all([c.api(`/proyectos/${c.proyecto.id}/costos${qn()}`), c.api('/catalogo')]);
    if (mio !== version) return;
    datos = d; catalogo = agrupar(cat.precios); pagLoc = 0; nivelExp = d.nivel; ctx.nivel = d.nivel; costosViejos = false;
    pintar();
  } catch (e) {
    if (mio !== version) return;
    el.innerHTML = `<div class="panel vacio"><p class="err">${esc(e.message)}</p></div>`;
  }
}

function agrupar(precios) {
  const g = Object.fromEntries(CLAVES_PRECIO.map(k => [k, []]));
  for (const p of precios) g[p.tipo_bien]?.push(p);
  return g;
}

// ─── Pintado ─────────────────────────────────────────────────────────────────
function pintar() {
  ctx.el.innerHTML = `
    <div id="exp-ioarr"></div>
    <div class="subtabs" role="tablist" aria-label="Expediente">
      <button type="button" role="tab" data-exp-vista="costos" aria-selected="${vistaExp === 'costos'}">Costos</button>
      <button type="button" role="tab" data-exp-vista="fichas" aria-selected="${vistaExp === 'fichas'}">Fichas de verificación</button>
      <button type="button" role="tab" data-exp-vista="docs" aria-selected="${vistaExp === 'docs'}">Documentos: Formato 07-C y memoria</button>
      <button type="button" role="tab" data-exp-vista="verif" aria-selected="${vistaExp === 'verif'}">Verificación</button>
    </div>
    <div id="exp-v-fichas" ${vistaExp === 'fichas' ? '' : 'hidden'}></div>
    <div id="exp-v-docs" ${vistaExp === 'docs' ? '' : 'hidden'}></div>
    <div id="exp-v-verif" ${vistaExp === 'verif' ? '' : 'hidden'}></div>
    <div id="exp-v-costos" ${vistaExp === 'costos' ? '' : 'hidden'}>
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
    <div id="exp-resultados"></div>
    </div>`;
  pintarIoarr(); pintarPrecios(); pintarRubros(); pintarResultados();
  if (vistaExp === 'fichas') abrirFichas();
  if (vistaExp === 'docs') abrirDocumentos();
  if (vistaExp === 'verif') abrirVerificacion();
}

// ─── Una IOARR o una por nivel ──────────────────────────────────────────────
const REG = r => r == null ? '<span class="chip-est pend">UIT sin cargar</span>' : r === 'completo' ? '<span class="chip-est alerta">Registro completo · supera 75 UIT</span>' : '<span class="chip-est ok">Registro abreviado · hasta 75 UIT</span>';
function pintarIoarr() {
  const K = datos.comparativo, porNiv = datos.modo === 'por_nivel', U = K.uit;
  const fila = (txt, x, activa) => `<tr class="${activa ? 'activa' : ''}"><td>${txt}</td><td class="num">${ent(x.locales)}</td><td class="num">${ent(x.rep)}</td><td class="num"><b>${soles(x.total)}</b></td><td class="num">${x.en_uit == null ? '—' : dec(x.en_uit) + ' UIT'}</td><td>${REG(x.registro)}</td></tr>`;
  const pestanas = porNiv && datos.ioarrs.length ? `<div class="subtabs ioarr-tabs" role="tablist" aria-label="IOARR por nivel">${datos.ioarrs.map(x =>
    `<button type="button" role="tab" data-exp-nivel="${x.nivel}" aria-selected="${x.nivel === datos.nivel}">IOARR ${esc(x.nombre)} <span class="sub">${soles(x.total)}</span></button>`).join('')}</div>` : '';
  document.getElementById('exp-ioarr').innerHTML = `
    <div class="panel"><div class="panel-cab"><h3>Una IOARR o una por nivel</h3>
      <div class="seg" role="radiogroup" aria-label="Organización del proyecto">
        <label class="chk"><input type="radio" name="exp-modo" value="por_nivel" ${porNiv ? 'checked' : ''}> Una IOARR por nivel</label>
        <label class="chk"><input type="radio" name="exp-modo" value="una" ${porNiv ? '' : 'checked'}> Una IOARR</label></div></div>
      <p class="sub pad">La norma permite una reposición masiva en varias UP si los activos son homogéneos y el servicio y la entidad son los mismos, pero no aclara si Inicial, Primaria y Secundaria cuentan como un mismo servicio: confírmalo con la OPMI. Un expediente de Huánuco (2023) presentó una IOARR por nivel. Compara los totales con el límite de 75 UIT${U ? ` (S/ ${NF.format(U.limite)}, UIT ${U.anio})` : ''}:</p>
      <div class="tabla-wrap borde-0"><table class="tabla tabla-ioarr"><thead><tr><th>Opción</th><th class="num">Locales</th><th class="num">A reponer</th><th class="num">Total</th><th class="num">En UIT</th><th>Registro del 07-C</th></tr></thead><tbody>
        ${fila('<b>Una IOARR</b> (todos los niveles)', K.una, !porNiv)}
        ${K.niveles.map(x => fila(`IOARR ${esc(x.nombre)}`, x, porNiv)).join('')}
      </tbody>${K.niveles.length > 1 ? `<tfoot><tr><td>Suma de las IOARR por nivel</td><td></td><td class="num">${ent(K.niveles.reduce((a, x) => a + x.rep, 0))}</td><td class="num">${soles(K.suma)}</td><td colspan="2"></td></tr></tfoot>` : ''}</table></div>
      ${K.niveles.length > 1 ? '<p class="sub pad">Un local con varios niveles entra en cada IOARR con sus estudiantes, aulas y mobiliario de ese nivel. Los rubros en monto fijo se reparten entre las IOARR según su base, así la suma da el total del proyecto.</p>' : ''}
    </div>${pestanas}`;
}
async function cambiarModo(modo) {
  try {
    await ctx.api(`/proyectos/${ctx.proyecto.id}`, { method: 'PATCH', body: { modo_ioarr: modo } });
    ctx.proyecto.modo_ioarr = modo; nivelExp = null;
    ctx.toast(modo === 'una' ? 'El proyecto es ahora una sola IOARR.' : 'El proyecto es ahora una IOARR por nivel.');
  } catch (e) { ctx.toast('No se pudo cambiar: ' + e.message); }
  await renderExpediente(ctx);
}
async function cambiarNivel(n) {
  if (n === nivelExp) return;
  nivelExp = n;
  await renderExpediente(ctx);
}

function pintarKpis() {
  const T = datos.totales, U = datos.uitCalc;
  const reg = U.valor == null ? '<span class="chip-est pend">UIT sin cargar</span>'
    : U.supera ? '<span class="chip-est alerta">Registro completo · supera 75 UIT</span>' : '<span class="chip-est ok">Registro abreviado · hasta 75 UIT</span>';
  document.getElementById('exp-kpis').innerHTML = `
    <div class="kpis kpis-montos">
      <div class="kpi destacado"><div class="v">${soles(T.total)}</div><div class="l">total de inversión${datos.nivel ? ` · IOARR ${esc(datos.nombre_ioarr)}` : ''}</div></div>
      <div class="kpi"><div class="v">${soles(T.cd)}</div><div class="l">costo directo · ${ent(T.rep)} bienes a reponer</div></div>
      <div class="kpi"><div class="v">${T.porEstudiante == null ? '—' : soles(T.porEstudiante)}</div><div class="l">por estudiante · ${ent(T.est)} estudiantes</div></div>
      <div class="kpi"><div class="v">${U.enUit == null ? '—' : dec(U.enUit) + ' UIT'}</div><div class="l">${reg}</div></div>
    </div>`;
}

function pintarAvisos() {
  const clase = { uit75: 'aviso alerta', precio: 'aviso', faltante: 'aviso', uit: 'aviso', rubros: 'aviso', inventario: 'aviso', sustento: 'aviso' };
  document.getElementById('exp-avisos').innerHTML = datos.avisos.length
    ? `<div class="avisos">${datos.avisos.map(a => `<div class="${a.alerta ? 'aviso alerta' : clase[a.tipo] || 'aviso'}" role="${a.tipo === 'uit75' || a.alerta ? 'alert' : 'note'}">${esc(a.texto)}</div>`).join('')}</div>` : '';
}

function pintarPrecios() {
  // Una fila por mueble que entra; en mesa y silla, el precio general y debajo cada talla
  // con reposición o faltante (una talla sin precio propio usa el general)
  const fila = (k, nombre, cant, u, general) => {
    const p = datos.precios[k] || { origen: null, precio: null }, lista = catalogo[k] || [];
    const usaGeneral = general && p.origen == null;
    const origen = p.origen === 'proyecto' ? '<span class="chip-est ok">Fijado en el proyecto</span>'
      : p.origen === 'vigente' ? '<span class="chip-est">Vigente del catálogo</span>'
      : usaGeneral ? `<span class="chip-est">${general.precio == null ? 'Sin precio' : 'Usa el general'}</span>` : '<span class="chip-est pend">Sin precio</span>';
    const opciones = lista.map(c => `<option value="${c.id}" ${p.origen === 'proyecto' && p.precio_id === c.id ? 'selected' : ''}>${soles(Number(c.precio))} · ${esc(c.descripcion)} · ${esc(FUENTES_PRECIO[c.fuente])} ${fechaPe(c.fecha)}${c.vigente ? ' · vigente' : ''}</option>`).join('');
    const distinto = p.vigente_distinto ? `<div class="sub aviso-linea">El vigente del catálogo ahora es ${soles(p.vigente_distinto.precio)} (${esc(p.vigente_distinto.descripcion)}).</div>` : '';
    const vacio = general ? 'No hay precios de esta talla en el catálogo: usa el precio general.' : 'No hay precios de este tipo en el catálogo.';
    return `<tr${general ? ' class="fila-talla"' : ''}>
      <td>${general ? `<span class="sangria">${esc(nombre)}</span>` : `<b>${esc(nombre)}</b>`}<br><span class="sub">${cant}</span></td>
      <td class="num"><b>${soles(usaGeneral ? general.precio : p.precio)}</b><br>${origen}</td>
      <td>${p.descripcion ? `${esc(p.descripcion)}<br><span class="sub">${esc(FUENTES_PRECIO[p.fuente] || '')} ${fechaPe(p.fecha)}</span>` : '<span class="sub">—</span>'}${distinto}
        <div class="precio-acc">${lista.length ? `<select data-precio="${k}" aria-label="Precio de ${esc(nombre)}"><option value="">${p.origen === 'proyecto' ? 'Usar el vigente del catálogo' : 'Fijar un precio del catálogo…'}</option>${opciones}</select>` : `<span class="sub">${vacio}</span>`}</div></td>
    </tr>`;
  };
  const lineas = datos.lineas || [];
  const filas = datos.partidas.filter(part => !part.excluido).map(part => {
    const x = ITEMS.find(y => y.k === part.k), tallas = lineas.filter(y => y.tipo === x.k && y.talla);
    const general = datos.precios[x.k] || { precio: null };
    return fila(x.k, tallas.length ? `${x.n} – precio general` : x.n, tallas.length ? `${ent(part.rep)} ${x.u} a reponer · vale para las tallas sin precio propio` : `${ent(part.rep)} ${x.u} a reponer`, x.u, null)
      + tallas.map(y => fila(y.k, y.n.split(' – ')[1], `${ent(y.rep)} ${y.u} a reponer`, y.u, general)).join('');
  }).join('');
  document.getElementById('exp-precios').innerHTML = `
    <div class="panel-cab"><h3>Precios unitarios (sin IGV)</h3><a class="btn btn-ghost btn-sm" href="selector-ioarr-precios.html" target="_blank" rel="noopener">Catálogo de precios ↗</a></div>
    <p class="sub pad">Se usa el precio vigente del catálogo, salvo que fijes uno para este proyecto. Al fijarlo se guarda una copia: si el catálogo cambia, el proyecto no cambia sin aviso. La mesa y la silla se costean por talla, según el grado del aula (las aulas multigrado se reparten en partes iguales entre las tallas de su nivel); una talla sin precio propio usa el precio general.</p>
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
  // Una línea por talla en mesa y silla
  const lineas = datos.lineas || datos.partidas.filter(p => !p.excluido);
  const partidas = lineas.filter(p => p.rep > 0 || !p.talla).map(p => `<tr><td>${p.n}</td><td>${p.u}</td><td class="num">${ent(p.rep)}</td><td class="num">${soles(p.pu)}</td><td class="num">${soles(p.parcial)}</td></tr>`).join('');
  const falt = lineas.filter(p => p.fal > 0 || !p.talla).map(p => `<tr><td>${p.n}</td><td class="num">${ent(p.fal)}</td><td class="num">${soles(p.falValor)}</td></tr>`).join('');
  const dist = datos.distritos.map(d => `<tr><td>${esc(d.nom)}<br><span class="sub">${esc(d.prov)} · ${d.ubigeo}</span></td><td class="num">${ent(d.n)}</td><td class="num">${ent(d.est)}</td><td class="num">${ent(d.rep)}</td><td class="num">${soles(d.total)}</td><td class="num">${d.porEstudiante == null ? '—' : soles(d.porEstudiante)}</td><td class="num sub">${ent(d.fal)}</td></tr>`).join('');
  const q = norm(filtroLoc).trim();
  const locs = [...datos.locales].filter(l => !q || l.cod.includes(q) || norm(l.nom).includes(q) || norm(l.dist).includes(q))
    .sort((a, b) => b.total - a.total || a.cod.localeCompare(b.cod));
  const pags = Math.max(1, Math.ceil(locs.length / PAGE)); pagLoc = Math.min(pagLoc, pags - 1);
  const desde = pagLoc * PAGE;
  const lrows = locs.slice(desde, desde + PAGE).map(l => `<tr><td class="mono">${l.cod}</td><td><span class="nm">${esc(l.nom)}</span><span class="sub">${esc(l.dist)}${l.rural ? ' · rural' : ''}</span>${l.duplicidad?.estado === 'si' ? `<br><span class="chip-est alerta" title="Otra inversión vigente o reciente: riesgo de duplicidad">Otra inversión${l.duplicidad.codigo ? ' ' + esc(l.duplicidad.codigo) : ''}</span>` : ''}</td><td class="num">${ent(l.est)}</td><td class="num">${ent(l.rep)}</td><td class="num">${ent(l.fal)}</td><td class="num">${l.zona.flete || l.zona.instalacion ? `+${dec(l.zona.flete * 100)} % / +${dec(l.zona.instalacion * 100)} %` : '<span class="sub">—</span>'}</td><td class="num">${soles(l.cd)}</td><td class="num"><b>${soles(l.total)}</b></td>
    <td>${l.verificado ? `<span class="chip-est ok">Verificado ${fechaPe(l.verificado.fecha_visita)}</span><br>${l.verificado.ficha ? '<span class="sub">con ficha</span><br>' : ''}${l.archivos ? `<span class="sub">${l.archivos} archivo${l.archivos === 1 ? '' : 's'}</span><br>` : '<span class="chip-est pend">Sin sustento</span><br>'}` : ''}<button class="x" data-inv="${esc(l.cod)}" type="button">${l.verificado ? 'Editar' : 'Corregir inventario'}</button></td></tr>`).join('');

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
      <div class="panel"><div class="panel-cab"><h3>Faltante (brecha de dotación, no reposición)</h3></div>
        <p class="sub pad">Lo que falta para llegar a lo requerido. No suma a lo que se repone, al costo ni al Formato 07-C. Amplía la capacidad de la UP: no se sustentan como reposición (Lineamientos IOARR del MEF, 2.4.C). Se valorizan con los mismos precios, solo como referencia para evaluarlos como ampliación marginal.</p>
        <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Tipo</th><th class="num">Faltante</th><th class="num">Valor referencial</th></tr></thead><tbody>${falt}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${ent(T.fal)}</td><td class="num">${soles(T.falValor)}</td></tr></tfoot></table></div>
      </div>
    </div>
    <div class="panel"><div class="panel-cab"><h3>Por distrito</h3></div>
      <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Distrito</th><th class="num">Locales</th><th class="num">Estudiantes</th><th class="num">Bienes a reponer</th><th class="num">Total</th><th class="num">Por estudiante</th><th class="num" title="Faltante (brecha de dotación, no reposición): no suma al total">Faltante (no reposición)</th></tr></thead><tbody>${dist}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${ent(T.locales)}</td><td class="num">${ent(T.est)}</td><td class="num">${ent(T.rep)}</td><td class="num">${soles(T.total)}</td><td class="num">${T.porEstudiante == null ? '—' : soles(T.porEstudiante)}</td><td class="num sub">${ent(T.fal)}</td></tr></tfoot></table></div></div>
    <div class="panel"><div class="panel-cab"><h3>Por local</h3><span class="sub">Ordenados por total</span></div>
      <div class="pad"><input id="exp-buscar" type="search" placeholder="Buscar por código de local, nombre o distrito" value="${esc(filtroLoc)}" autocomplete="off" aria-label="Buscar local"></div>
      <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Código de local</th><th>Instituciones</th><th class="num">Estudiantes</th><th class="num">Reposición</th><th class="num" title="Faltante (brecha de dotación, no reposición): no suma al total">Faltante (no reposición)</th><th class="num">Zona (flete / instal.)</th><th class="num">Costo directo</th><th class="num">Total</th><th>Inventario</th></tr></thead><tbody>${lrows || '<tr><td colspan="9" class="vacio">Ningún local coincide con la búsqueda.</td></tr>'}</tbody></table></div>
      ${datos.excluidos?.length ? `<p class="sub pad">Excluidos por otra inversión vigente o reciente (no entran al costo ni a los documentos): ${datos.excluidos.map(x => `<span class="mono">${esc(x.cod)}</span>${x.codigo ? ` (${esc(x.codigo)})` : ''}`).join(', ')}. Se cambia en «Mi selección».</p>` : ''}
      ${pags > 1 ? `<div class="paginacion pad-pag"><span class="sub">${ent(desde + 1)}–${ent(Math.min(locs.length, desde + PAGE))} de ${ent(locs.length)}</span><div class="pg-btns"><button class="btn btn-ghost btn-sm" data-exp-pag="-1" type="button" ${pagLoc === 0 ? 'disabled' : ''}>Anterior</button><span class="mono">${pagLoc + 1} / ${pags}</span><button class="btn btn-ghost btn-sm" data-exp-pag="1" type="button" ${pagLoc >= pags - 1 ? 'disabled' : ''}>Siguiente</button></div></div>` : ''}</div>`;
}

// Documentos (etapa 2): se recalculan al abrir, así toman los últimos costos e inventario
function abrirDocumentos() {
  return renderDocumentos({ ...ctx, el: document.getElementById('exp-v-docs') });
}
function abrirVerificacion() {
  return renderVerificacion({ ...ctx, el: document.getElementById('exp-v-verif') });
}
// Fichas: son por local (no por IOARR); al importar, los costos quedan por recalcular
function abrirFichas() {
  return renderFichas({ ...ctx, el: document.getElementById('exp-v-fichas'), alCambiarInventario: () => { costosViejos = true; } });
}
function cambiarVista(v) {
  vistaExp = v;
  ctx.el.querySelectorAll('[data-exp-vista]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.expVista === v)));
  document.getElementById('exp-v-costos').hidden = v !== 'costos';
  document.getElementById('exp-v-docs').hidden = v !== 'docs';
  document.getElementById('exp-v-verif').hidden = v !== 'verif';
  document.getElementById('exp-v-fichas').hidden = v !== 'fichas';
  if (v === 'costos' && costosViejos) { costosViejos = false; renderExpediente(ctx); return; }
  if (v === 'fichas') abrirFichas();
  if (v === 'docs') abrirDocumentos();
  if (v === 'verif') abrirVerificacion();
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
    const d = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos${qn()}`, { method: 'PATCH', body });
    if (mio !== version) return;
    const cambioAnio = d.anio_uit !== datos.anio_uit || (d.uit?.valor ?? null) !== (datos.uit?.valor ?? null);
    datos = d;
    pintarIoarr(); pintarResultados();
    if (cambioAnio) pintarRubros();
    estado('Guardado', 'ok');
  } catch (e) { if (mio === version) estado('No se pudo guardar: ' + e.message, 'error'); }
}

async function cambiarPrecio(tipo, precioId) {
  const mio = ++version;
  try {
    const ruta = `/proyectos/${ctx.proyecto.id}/costos/precios/${tipo}${qn()}`;
    const d = precioId ? await ctx.api(ruta, { method: 'PUT', body: { precio_id: precioId } }) : await ctx.api(ruta, { method: 'DELETE' });
    if (mio !== version) return;
    datos = d; pintarIoarr(); pintarPrecios(); pintarResultados();
    ctx.toast(precioId ? 'Precio fijado en el proyecto.' : 'Se usa el precio vigente del catálogo.');
  } catch (e) { ctx.toast('No se pudo cambiar el precio: ' + e.message); }
}

async function exportar(btn) {
  btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Generando…';
  try {
    clearTimeout(tGuardar);
    const r = await fetch(`/api/selector-ioarr/proyectos/${ctx.proyecto.id}/costos/excel${qn()}`);
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
    if (e.target.name === 'exp-modo') { cambiarModo(e.target.value); return; }
    const c = e.target.dataset.campo;
    if (c === 'modo' || c === 'base') { clearTimeout(tGuardar); guardar({ rubros: leerRubros() }); }
    if (e.target.dataset.precio) cambiarPrecio(e.target.dataset.precio, e.target.value || null);
  });
  enlazarDocumentos(el);
  enlazarVerificacion(el);
  enlazarFichas(el);
  el.addEventListener('click', e => {
    const sv = e.target.closest('[data-exp-vista]');
    if (sv) cambiarVista(sv.dataset.expVista);
    const nv = e.target.closest('[data-exp-nivel]');
    if (nv) cambiarNivel(nv.dataset.expNivel);
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
    <p class="sub">Marca los tipos de bien que verificaste y escribe lo que encontraste. En esos tipos, el expediente usa tus cantidades en lugar del Censo Educativo: reposición = malo; faltante (brecha de dotación, no reposición) = requerido − existente. El Selector sigue mostrando el censo.</p>
    <div class="tabla-wrap"><table class="tabla tabla-inv"><thead><tr><th>Tipo de bien</th><th class="num">Requerido</th><th class="num">Censo (B / R / M)</th><th>Corregir</th><th>Bueno</th><th>Regular</th><th>Malo</th><th>Año de adquisición</th></tr></thead><tbody id="inv-tbody"></tbody></table></div>
    <p class="sub">El año de adquisición sale del inventario patrimonial o de la placa del bien. Se usa para la antigüedad del Formato 07-C y la memoria; puedes cargarlo aunque no corrijas las cantidades.</p>
    <div class="form-grid">
      <div class="campo"><label for="inv-fecha">Fecha de la visita</label><input id="inv-fecha" type="date" required></div>
      <div class="campo"><label for="inv-resp">Responsable</label><input id="inv-resp" type="text" maxlength="200" placeholder="Quién hizo la visita"></div>
      <div class="campo ancho"><label for="inv-obs">Sustento</label><textarea id="inv-obs" maxlength="1000" required placeholder="Ej.: acta de verificación firmada por el director, 32 fotos; las mesas existen pero están rotas"></textarea></div>
    </div>
    <p class="err" id="inv-err" hidden></p>
    <div class="modal-acts">
      <button class="btn btn-primary" type="submit" id="inv-ok">Guardar</button>
    </div>
    <section class="inv-sustento" id="inv-sustento">
      <h3>Sustento de la visita</h3>
      <p class="sub" id="inv-sus-ayuda"></p>
      <div id="inv-sus-subir" hidden>
        <div class="form-grid">
          <div class="campo"><label for="inv-a-tipo">Tipo</label><select id="inv-a-tipo">
            <option value="">Automático (PDF = acta, imagen = foto)</option>${Object.entries(TIPOS_ARCHIVO).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="campo ancho"><label for="inv-a-desc">Descripción (opcional)</label><input id="inv-a-desc" type="text" maxlength="300" placeholder="Ej.: aula 3° A, mesas con tablero roto"></div>
          <div class="campo ancho"><label for="inv-a-file">Archivos (PDF o fotos, hasta 15 MB cada uno)</label><input id="inv-a-file" type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"></div>
        </div>
        <p class="sub" id="inv-a-estado" role="status"></p>
      </div>
      <div class="tabla-wrap borde-0"><table class="tabla"><tbody id="inv-a-lista"></tbody></table></div>
    </section>
    <div class="modal-acts">
      <button class="btn btn-ghost btn-peligro" type="button" id="inv-quitar" hidden>Quitar corrección (usar el censo)</button>
      <button class="btn btn-ghost" type="button" data-cerrar>Cerrar</button>
    </div>
  </form>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-cerrar]')) m.classList.remove('open'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') m.classList.remove('open'); });
  m.querySelector('#inv-tbody').addEventListener('change', e => {
    const k = e.target.dataset.invChk, n = e.target.dataset.niv ?? '';
    if (k) m.querySelectorAll(`[data-inv-k="${k}"][data-niv="${n}"]`).forEach(i => { i.disabled = !e.target.checked; });
  });
  m.querySelector('#f-inv').addEventListener('submit', guardarInventario);
  m.querySelector('#inv-quitar').addEventListener('click', quitarInventario);
  m.querySelector('#inv-a-file').addEventListener('change', e => subirArchivos([...e.target.files]));
  m.querySelector('#inv-a-lista').addEventListener('click', e => {
    const ab = e.target.closest('[data-a-abrir]'), del = e.target.closest('[data-a-del]');
    if (ab) abrirArchivo(ab.dataset.aAbrir);
    if (del) borrarArchivo(del.dataset.aDel);
  });
  return m;
}

let invCod = null, invArchivos = [], invGuardado = false;
async function abrirInventario(cod) {
  const m = modalInventario();
  invCod = cod;
  try {
    const d = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos/inventario/${encodeURIComponent(cod)}`);
    if (d.sin_migracion) { ctx.toast('Falta ejecutar supabase/migrations/013_ioarr_expediente_inventario.sql en Supabase'); return; }
    const v = d.verificado;
    m.querySelector('#inv-local').innerHTML = `<b>${esc(d.cod)}</b> · ${esc(d.nom)}${d.por_nivel ? `<br>Local con ${d.niveles.length} niveles: carga lo de cada nivel por separado; cada IOARR por nivel usa lo suyo.` : ''}`
      + (d.sin_nivel ? '<br><b class="aviso-linea">Lo cargado antes no tiene nivel: vuelve a cargarlo por nivel (al guardar se reemplaza).</b>' : '')
      + (d.por_nivel && d.sin_migracion_niveles ? '<br><b class="aviso-linea">Falta ejecutar supabase/migrations/018_ioarr_por_nivel.sql para guardar por nivel.</b>' : '')
      + (v?.ficha ? `<br>Cargado desde la ficha de verificación «${esc(v.ficha.archivo)}» (visita del ${fechaPe(v.ficha.fecha)}). Si cambias las cantidades aquí, cuentan como corrección a mano; para volver a la ficha, impórtala de nuevo en «Fichas de verificación».` : '');
    // Un solo nivel: bienes / adquisicion (niv = ''). Varios niveles: un bloque por nivel (por_nivel)
    const bloques = d.por_nivel ? d.niveles.map(x => ({ niv: x.nivel, titulo: x.nombre, censo: x.censo, f: v?.por_nivel?.[x.nivel] || {} }))
      : [{ niv: '', titulo: null, censo: d.censo, f: { bienes: v?.bienes, adquisicion: v?.adquisicion } }];
    m.querySelector('#inv-tbody').innerHTML = bloques.map(B => (B.titulo ? `<tr class="fila-nivel"><td colspan="8"><b>${esc(B.titulo)}</b></td></tr>` : '') + ITEMS.filter(x => !datos.muebles || datos.muebles.includes(x.k)).map(x => {
      const c = B.censo[x.k], f = B.f.bienes?.[x.k], on = !!f, val = (k) => f ? f[k] : c[k];
      const lbl = `${x.n}${B.titulo ? ' (' + B.titulo + ')' : ''}`;
      const inp = k => `<input type="number" min="0" step="1" inputmode="numeric" data-inv-k="${x.k}" data-niv="${B.niv}" data-c="${k}" value="${val(k)}" ${on ? '' : 'disabled'} required aria-label="${lbl}: ${{ b: 'bueno', r: 'regular', m: 'malo' }[k]}">`;
      return `<tr><td><b>${x.n}</b></td><td class="num">${ent(c.req)}</td><td class="num">${ent(c.b)} / ${ent(c.r)} / ${ent(c.m)}${c.b + c.r + c.m < c.req ? '<br><span class="sub aviso-linea">faltan ' + ent(c.req - c.b - c.r - c.m) + '</span>' : ''}</td>
        <td><label class="chk"><input type="checkbox" data-inv-chk="${x.k}" data-niv="${B.niv}" ${on ? 'checked' : ''}> Corregir</label></td><td>${inp('b')}</td><td>${inp('r')}</td><td>${inp('m')}</td>
        <td><input type="number" min="1950" max="${new Date().getFullYear()}" step="1" inputmode="numeric" data-inv-anio="${x.k}" data-niv="${B.niv}" value="${B.f.adquisicion?.[x.k] ?? ''}" placeholder="AAAA" aria-label="${lbl}: año de adquisición"></td></tr>`;
    }).join('')).join('');
    m.querySelector('#inv-fecha').value = v?.fecha_visita || '';
    m.querySelector('#inv-fecha').max = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    m.querySelector('#inv-resp').value = v?.responsable || '';
    m.querySelector('#inv-obs').value = v?.observacion || '';
    m.querySelector('#inv-quitar').hidden = !v;
    m.querySelector('#inv-err').hidden = true;
    invArchivos = d.archivos || []; invGuardado = !!v;
    pintarSustento();
    m.classList.add('open');
  } catch (e) { ctx.toast('No se pudo abrir el inventario: ' + e.message); }
}

async function guardarInventario(e) {
  e.preventDefault();
  const m = modalInventario(), err = m.querySelector('#inv-err');
  // Por bloque: '' = el local (un solo nivel), 'P' = Primaria, etc.
  const bloque = {};
  const de = n => bloque[n] ??= { bienes: {}, adquisicion: {} };
  m.querySelectorAll('[data-inv-chk]:checked').forEach(chk => {
    const k = chk.dataset.invChk, n = chk.dataset.niv, val = c => Number(m.querySelector(`[data-inv-k="${k}"][data-niv="${n}"][data-c="${c}"]`).value);
    de(n).bienes[k] = { b: val('b'), r: val('r'), m: val('m') };
  });
  m.querySelectorAll('[data-inv-anio]').forEach(i => { if (i.value) de(i.dataset.niv).adquisicion[i.dataset.invAnio] = Number(i.value); });
  const { '': local = { bienes: {}, adquisicion: {} }, ...por_nivel } = bloque;
  const vacio = x => !Object.keys(x.bienes).length && !Object.keys(x.adquisicion).length;
  if (vacio(local) && Object.values(por_nivel).every(vacio)) { err.textContent = 'Corrige al menos un tipo de bien o indica un año de adquisición.'; err.hidden = false; return; }
  const { bienes, adquisicion } = local;
  const btn = m.querySelector('#inv-ok'); btn.disabled = true;
  try {
    datos = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos/inventario/${encodeURIComponent(invCod)}${qn()}`, { method: 'PUT', body: {
      bienes, adquisicion, por_nivel, fecha_visita: m.querySelector('#inv-fecha').value, responsable: m.querySelector('#inv-resp').value, observacion: m.querySelector('#inv-obs').value } });
    pintarIoarr(); pintarPrecios(); pintarResultados();
    m.querySelector('#inv-quitar').hidden = false;
    const primera = !invGuardado; invGuardado = true; pintarSustento();
    ctx.toast(primera ? 'Inventario guardado. Ahora adjunta el acta y las fotos.' : 'Inventario verificado guardado.');
  } catch (x) { err.textContent = x.message; err.hidden = false; }
  finally { btn.disabled = false; }
}

async function quitarInventario() {
  if (!confirm(`¿Quitar la corrección? El local vuelve a calcularse con el Censo Educativo${invArchivos.length ? ` y se borran sus ${invArchivos.length} archivos de sustento` : ''}.`)) return;
  const m = modalInventario();
  try {
    datos = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos/inventario/${encodeURIComponent(invCod)}${qn()}`, { method: 'DELETE' });
    m.classList.remove('open');
    pintarIoarr(); pintarPrecios(); pintarResultados();
    ctx.toast('Se usa otra vez el censo.');
  } catch (x) { ctx.toast('No se pudo quitar: ' + x.message); }
}

// ─── Archivos de sustento (acta, fotos, inventario patrimonial, baja) ────────
const kb = n => n >= 1048576 ? NS.format(n / 1048576) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const fechaHora = s => new Date(s).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' });

function pintarSustento() {
  const m = modalInventario();
  m.querySelector('#inv-sus-subir').hidden = !invGuardado;
  const actas = invArchivos.filter(a => a.tipo === 'acta').length, fotos = invArchivos.filter(a => a.tipo === 'foto').length;
  m.querySelector('#inv-sus-ayuda').innerHTML = !invGuardado
    ? 'Guarda primero el inventario; después podrás adjuntar el acta de verificación, las fotos, el inventario patrimonial y la baja.'
    : `Adjunta el acta firmada por el director, las fotos por aula, el inventario patrimonial y, si existe, la resolución o el trámite de baja. ${actas ? '' : '<b class="aviso-linea">Falta el acta.</b> '}${actas} acta${actas === 1 ? '' : 's'} · ${fotos} foto${fotos === 1 ? '' : 's'} · ${invArchivos.length} en total.`;
  m.querySelector('#inv-a-lista').innerHTML = invArchivos.map(a => `<tr>
      <td><span class="chip-est">${esc(TIPOS_ARCHIVO[a.tipo])}</span></td>
      <td><b>${esc(a.nombre_archivo)}</b>${a.descripcion ? `<br><span class="sub">${esc(a.descripcion)}</span>` : ''}</td>
      <td class="num sub">${kb(a.tamano || 0)}<br>${fechaHora(a.creado_en)}</td>
      <td><div class="acciones-fila"><button class="x" type="button" data-a-abrir="${a.id}">Abrir</button><button class="x btn-peligro" type="button" data-a-del="${a.id}">Borrar</button></div></td></tr>`).join('');
}

// Las fotos del celular pesan varios MB: se reducen a 2400 px de lado y JPEG 85 %.
// Si el navegador no puede leer la imagen (p. ej. HEIC fuera de Safari) se sube tal cual.
async function reducirFoto(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 800 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close?.();
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

async function subirArchivos(files) {
  const m = modalInventario(), est = m.querySelector('#inv-a-estado'), input = m.querySelector('#inv-a-file');
  if (!files.length) return;
  input.disabled = true;
  const errores = [];
  for (let j = 0; j < files.length; j++) {
    const f = files[j];
    est.textContent = `Subiendo ${j + 1} de ${files.length}: ${f.name}…`;
    try {
      const file = await reducirFoto(f);
      if (file.size > 15 * 1048576) throw new Error('pasa de 15 MB');
      const tipo = m.querySelector('#inv-a-tipo').value || (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name) ? 'acta' : 'foto');
      const fd = new FormData();
      fd.append('tipo', tipo); fd.append('descripcion', m.querySelector('#inv-a-desc').value); fd.append('archivo', file, file.name);
      const r = await fetch(`/api/selector-ioarr/proyectos/${ctx.proyecto.id}/costos/inventario/${encodeURIComponent(invCod)}/archivos`, { method: 'POST', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Error ' + r.status);
      invArchivos.push(data); pintarSustento();
    } catch (e) { errores.push(`${f.name}: ${e.message}`); }
  }
  input.value = ''; input.disabled = false;
  est.textContent = errores.length ? 'No se subieron: ' + errores.join(' · ') : `Listo: ${files.length} archivo${files.length === 1 ? '' : 's'} subido${files.length === 1 ? '' : 's'}.`;
  est.className = errores.length ? 'err' : 'sub';
  await refrescarCostos();
}

async function abrirArchivo(id) {
  // La pestaña se abre antes del await para que el navegador no la bloquee
  const w = window.open('', '_blank');
  try {
    const { url } = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos/archivos/${id}/url`);
    if (w) w.location = url; else location.href = url;
  } catch (e) { w?.close(); ctx.toast('No se pudo abrir: ' + e.message); }
}

async function borrarArchivo(id) {
  const a = invArchivos.find(x => x.id === id);
  if (!a || !confirm(`¿Borrar «${a.nombre_archivo}»?`)) return;
  try {
    await ctx.api(`/proyectos/${ctx.proyecto.id}/costos/archivos/${id}`, { method: 'DELETE' });
    invArchivos = invArchivos.filter(x => x.id !== id); pintarSustento();
    await refrescarCostos();
  } catch (e) { ctx.toast('No se pudo borrar: ' + e.message); }
}

// Vuelve a pedir los costos (los avisos y el conteo de archivos por local)
async function refrescarCostos() {
  try { datos = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos${qn()}`); pintarIoarr(); pintarResultados(); } catch { /* se verá al recargar */ }
}
