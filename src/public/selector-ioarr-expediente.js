// Selector IOARR — pestaña «Expediente» (Etapa 1: estructura de costos).
// El cálculo lo hace el servidor (src/selector-ioarr/costos.js), el mismo que
// arma el Excel: así la pantalla y el Excel dan lo mismo.
import { LIMITE_UIT, TIPOS_ARCHIVO } from '/selector-ioarr/costos.js';
import { ITEMS, CLAVES_PRECIO, TALLAS, AVISO_CAPACIDAD, NIVN, NIVELES_PCT, ROTULO_UMBRAL, LIM_UMBRAL } from '/selector-ioarr/calculo.js';
import { renderOferta, enlazarOferta } from '/selector-ioarr-oferta.js';
import { renderDocumentos, enlazarDocumentos } from '/selector-ioarr-documentos.js';
import { renderVerificacion, enlazarVerificacion } from '/selector-ioarr-verificacion.js';
import { renderFichas, enlazarFichas } from '/selector-ioarr-fichas.js';
import { renderColegios, enlazarColegios } from '/selector-ioarr-colegios.js';

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
let vistaExp = 'costos';   // sub-pestaña: 'costos' | 'colegios' | 'fichas' | 'docs' | 'verif' | 'oferta'
let costosViejos = false;  // se importaron fichas: al volver a Costos se recalcula
let nivelExp = null;       // IOARR (nivel) a la vista: 'I' | 'P' | 'S' | 'E'
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
      <button type="button" role="tab" data-exp-vista="colegios" aria-selected="${vistaExp === 'colegios'}">Por colegio (Lineamientos)</button>
      <button type="button" role="tab" data-exp-vista="fichas" aria-selected="${vistaExp === 'fichas'}">Fichas de verificación</button>
      <button type="button" role="tab" data-exp-vista="docs" aria-selected="${vistaExp === 'docs'}">Documentos: Formato 07-C y memoria</button>
      <button type="button" role="tab" data-exp-vista="verif" aria-selected="${vistaExp === 'verif'}">Verificación</button>
      <button type="button" role="tab" data-exp-vista="oferta" aria-selected="${vistaExp === 'oferta'}" class="tab-interna">Oferta (uso interno)</button>
    </div>
    <div id="exp-v-oferta" ${vistaExp === 'oferta' ? '' : 'hidden'}></div>
    <div id="exp-v-fichas" ${vistaExp === 'fichas' ? '' : 'hidden'}></div>
    <div id="exp-v-colegios" ${vistaExp === 'colegios' ? '' : 'hidden'}></div>
    <div id="exp-v-docs" ${vistaExp === 'docs' ? '' : 'hidden'}></div>
    <div id="exp-v-verif" ${vistaExp === 'verif' ? '' : 'hidden'}></div>
    <div id="exp-v-costos" ${vistaExp === 'costos' ? '' : 'hidden'}>
    <div id="exp-kpis"></div>
    <div id="exp-avisos"></div>
    <div class="panel" id="exp-escenarios"></div>
    <div class="exportar">
      <div><h3>Excel de costos</h3><p>Parámetros, partidas, metrado y costos por local, y distribución por distrito, con el escenario elegido. Todo con fórmulas de Excel: si el evaluador cambia un precio o un porcentaje, el libro se recalcula. No incluye la oferta interna.</p></div>
      <button class="btn btn-primary" id="exp-excel" type="button">Exportar costos a Excel</button>
    </div>
    <div class="cols">
      <div class="panel" id="exp-precios"></div>
      <div class="panel" id="exp-rubros"></div>
    </div>
    <div id="exp-resultados"></div>
    </div>`;
  pintarIoarr(); pintarEscenarios(); pintarPrecios(); pintarEstructura(); pintarResultados();
  if (vistaExp === 'fichas') abrirFichas();
  if (vistaExp === 'colegios') abrirColegios();
  if (vistaExp === 'oferta') abrirOferta();
  if (vistaExp === 'docs') abrirDocumentos();
  if (vistaExp === 'verif') abrirVerificacion();
}

// ─── Una IOARR por nivel ─────────────────────────────────────────────────────
// Cada 07-C es de un solo nivel. «Una IOARR» con todos los niveles es solo una cifra de comparación.
const REG = (r, masiva) => masiva ? '<span class="chip-est alerta">Registro completo (masiva)</span>' : r == null ? '<span class="chip-est pend">UIT sin cargar</span>' : r === 'completo' ? '<span class="chip-est alerta">Registro completo · supera 75 UIT</span>' : '<span class="chip-est ok">Registro abreviado · hasta 75 UIT</span>';
function pintarIoarr() {
  const K = datos.comparativo, U = K.uit;
  const fila = (txt, x, o = {}) => `<tr class="${o.activa ? 'activa' : ''}${o.tenue ? ' sub' : ''}"><td>${txt}</td><td class="num">${ent(x.locales)}</td><td class="num">${ent(x.rep)}</td><td class="num"><b>${soles(x.total)}</b></td><td class="num">${x.en_uit == null ? '—' : dec(x.en_uit) + ' UIT'}</td><td>${o.reg ?? REG(x.registro, x.masiva)}</td></tr>`;
  const pestanas = datos.ioarrs.length > 1 ? `<div class="subtabs ioarr-tabs" role="tablist" aria-label="IOARR por nivel">${datos.ioarrs.map(x =>
    `<button type="button" role="tab" data-exp-nivel="${x.nivel}" aria-selected="${x.nivel === datos.nivel}">IOARR ${esc(x.nombre)} <span class="sub">${soles(x.total)}</span></button>`).join('')}</div>` : '';
  const ctrl = K.control && !K.control.ok ? `<div class="avisos pad"><div class="aviso alerta" role="alert">${esc(K.control.errores.slice(0, 3).join(' '))}</div></div>` : '';
  document.getElementById('exp-ioarr').innerHTML = `
    <div class="panel"><div class="panel-cab"><h3>Una IOARR por nivel</h3><span class="sub">${ent(K.colegios || 0)} colegios en el paquete</span></div>
      <p class="sub pad">Cada Formato 07-C es de un solo nivel (Inicial, Primaria o Secundaria), como en las IOARR masivas publicadas: nunca se mezclan niveles. Un colegio con varios niveles entra en una IOARR por nivel, con sus estudiantes, aulas y mobiliario de ese nivel (cada aula cuenta en un solo nivel). Límite de 75 UIT${U ? `: S/ ${NF.format(U.limite)} (UIT ${U.anio})` : ''}.</p>
      ${ctrl}
      <div class="tabla-wrap borde-0"><table class="tabla tabla-ioarr"><thead><tr><th>IOARR</th><th class="num">Colegios</th><th class="num">A reponer</th><th class="num">Monto</th><th class="num">En UIT</th><th>Registro del 07-C</th></tr></thead><tbody>
        ${K.niveles.map(x => fila(`IOARR ${esc(x.nombre)}`, x, { activa: x.nivel === datos.nivel })).join('')}
      </tbody><tfoot><tr><td>Total del paquete${K.niveles.length > 1 ? ` (${K.niveles.length} IOARR)` : ''}</td><td class="num">${ent(K.colegios || 0)}</td><td class="num">${ent(K.niveles.reduce((a, x) => a + x.rep, 0))}</td><td class="num">${soles(K.suma)}</td><td colspan="2"></td></tr>
        ${fila('Solo comparación: una IOARR con todos los niveles (no se exporta)', K.una, { tenue: true, reg: '<span class="sub">—</span>' })}</tfoot></table></div>
      ${K.niveles.length > 1 ? '<p class="sub pad">Un colegio con varios niveles se cuenta una vez en el total del paquete y una vez en cada IOARR de sus niveles. Los rubros en monto fijo se reparten entre las IOARR según su base, así la suma da el total del paquete.</p>' : ''}
    </div>${pestanas}`;
}
async function cambiarNivel(n) {
  if (n === nivelExp) return;
  nivelExp = n;
  await renderExpediente(ctx);
}

function pintarKpis() {
  const T = datos.totales, U = datos.uitCalc;
  const reg = REG(U.registro ?? (U.valor == null ? null : U.supera ? 'completo' : 'abreviado'), U.masiva);
  document.getElementById('exp-kpis').innerHTML = `
    <div class="kpis kpis-montos">
      <div class="kpi destacado"><div class="v">${soles(T.total)}</div><div class="l">monto de inversión${datos.nivel ? ` · IOARR ${esc(datos.nombre_ioarr)}` : ''}</div></div>
      <div class="kpi"><div class="v">${soles(T.cd)}</div><div class="l">costo directo · ${datos.estructura?.kit ? `${ent(T.kits)} kits` : `${ent(T.rep)} bienes a reponer`}</div></div>
      <div class="kpi"><div class="v">${T.porEstudiante == null ? '—' : soles(T.porEstudiante)}</div><div class="l">por estudiante · ${ent(T.est)} estudiantes</div></div>
      <div class="kpi"><div class="v">${U.enUit == null ? '—' : dec(U.enUit) + ' UIT'}</div><div class="l">${reg}</div></div>
    </div>`;
}

function pintarAvisos() {
  const clase = { uit75: 'aviso alerta', precio: 'aviso', faltante: 'aviso', uit: 'aviso', inventario: 'aviso', sustento: 'aviso', escenario: 'aviso', kit: 'aviso' };
  document.getElementById('exp-avisos').innerHTML = datos.avisos.length
    ? `<div class="avisos">${datos.avisos.map(a => `<div class="${a.alerta ? 'aviso alerta' : clase[a.tipo] || 'aviso'}" role="${a.tipo === 'uit75' || a.alerta ? 'alert' : 'note'}">${esc(a.texto)}</div>`).join('')}</div>` : '';
}

// ─── Escenarios de cantidad, lado a lado ────────────────────────────────────
const ESC_AYUDA = {
  malo: 'Lo Malo del censo, por tipo de bien. Escenario base.',
  malo_regular: 'Malo y un % del Regular, por aula (100 % = cota superior; 0 % = Solo Malo).',
  capacidad: `Aulas × ocupación × %. ${AVISO_CAPACIDAD}`
};
function pintarEscenarios() {
  const E = datos.escenarios || [], act = datos.escenario || { k: 'malo' };
  const base = E.find(x => x.k === 'malo') || E[0];
  const tipos = ITEMS.filter(x => !datos.muebles || datos.muebles.includes(x.k));
  const dif = (v, b) => { if (v == null || b == null) return ''; const d = v - b; return d ? `<span class="sub">${d > 0 ? '+' : '−'}${ent(Math.abs(d))}</span>` : '<span class="sub">=</span>'; };
  const difS = (v, b) => { const d = v - b; return d ? `<span class="sub">${d > 0 ? '+' : '−'}${soles(Math.abs(d))}</span>` : '<span class="sub">=</span>'; };
  const celda = (x, v, b, fmt = ent, fd = dif) => `<td class="num${x.actual ? ' activa' : ''}">${fmt(v)}${x.k !== 'malo' ? '<br>' + fd(v, b) : ''}</td>`;
  const filas = tipos.map(t => `<tr><td>${esc(t.n)}<br><span class="sub">${t.u}</span></td>${E.map(x => celda(x, x.partidas[t.k], base.partidas[t.k])).join('')}</tr>`).join('')
    + `<tr><td>Kits (mesa + silla)<br><span class="sub">mayor entre mesas y sillas, por aula</span></td>${E.map(x => celda(x, x.kits, base.kits)).join('')}</tr>`
    + `<tr class="fuerte"><td><b>Monto de inversión</b><br><span class="sub">con los precios y la estructura de abajo</span></td>${E.map(x => celda(x, x.total, base.total, soles, difS)).join('')}</tr>`;
  document.getElementById('exp-escenarios').innerHTML = `
    <div class="panel-cab"><h3>Escenario de cantidad</h3><span class="guardado" id="esc-guardado"></span></div>
    <div class="pad esc-opciones" role="radiogroup" aria-label="Escenario de cantidad">
      ${E.map(x => `<label class="chk esc-op${x.k === 'capacidad' ? ' esc-cap' : ''}"><input type="radio" name="exp-esc" value="${x.k}" ${x.k === act.k ? 'checked' : ''}> <b>${esc(x.n)}</b><br><span class="sub">${esc(ESC_AYUDA[x.k])}</span></label>`).join('')}
    </div>
    <div class="form-grid pad">
      <div class="campo"><label for="esc-ocup">Ocupación (estudiantes por aula)</label><input id="esc-ocup" type="number" min="1" max="60" step="1" value="${act.capOcup ?? 30}"></div>
      <div class="campo"><label for="esc-pct">Porcentaje (%)</label><input id="esc-pct" type="number" min="1" max="100" step="1" value="${act.capPct ?? 80}"></div>
      <div class="campo ancho"><span class="sub">Parámetros del escenario «Por capacidad». ${esc(AVISO_CAPACIDAD)}</span></div>
    </div>
    ${panelRegular(act)}
    <div class="tabla-wrap borde-0"><table class="tabla tabla-esc"><thead><tr><th>Cantidad a reponer</th>${E.map(x => `<th class="num${x.actual ? ' activa' : ''}">${esc(x.n)}${x.pct ? `<br><span class="sub">${esc(x.pct)}</span>` : ''}${x.actual ? '<br><span class="chip-est ok">Elegido</span>' : ''}${x.k === 'capacidad' ? '<br><span class="chip-est alerta">Solo para comparar</span>' : ''}</th>`).join('')}</tr></thead>
      <tbody>${filas}</tbody></table></div>
    <p class="sub pad">Debajo de cada cifra, la diferencia con «Solo Malo». El faltante (brecha de dotación) es informativo y no entra en ningún escenario. Los documentos (07-C, memoria, fichas y Excel) usan el escenario elegido y lo declaran en una línea.</p>`;
}

// Parámetros de «Malo + % de Regular»: % global, % por nivel, umbral de vida útil y la muestra de campo
function panelRegular(act) {
  const niv = (act.niveles || []).filter(n => NIVELES_PCT.includes(n)), g = act.pctRegular ?? 100;
  const C = act.campo || {}, o = act.pctOrigen || {};
  const origen = o.tipo === 'observado' ? `% observado en ${ent(o.n)} ${o.n === 1 ? 'local verificado' : 'locales verificados'} (umbral ${o.umbral} años)` : 'valor manual';
  const obs = C.observado;
  return `<div class="form-grid pad borde-sup">
      <div class="campo"><label for="esc-pctreg">% de Regular que se repone${niv.length > 1 ? ' (global)' : ''}</label><input id="esc-pctreg" type="number" min="0" max="100" step="1" value="${g}"></div>
      ${niv.length > 1 ? niv.map(n => `<div class="campo"><label for="esc-pctniv-${n}">% de Regular – ${esc(NIVN[n])}</label><input id="esc-pctniv-${n}" data-pct-niv="${n}" type="number" min="0" max="100" step="1" value="${act.pctRegularNivel?.[n] ?? ''}" placeholder="${g} (global)"></div>`).join('') : ''}
      <div class="campo"><label for="esc-umbral">Umbral de vida útil (años)</label><input id="esc-umbral" type="number" min="${LIM_UMBRAL[0]}" max="${LIM_UMBRAL[1]}" step="1" value="${act.umbralVida ?? 10}"><span class="sub">${esc(ROTULO_UMBRAL)}</span></div>
      <div class="campo ancho"><span class="sub">Parámetros del escenario «Malo + % de Regular». Por aula y tipo de bien: Regular a reponer = redondeo hacia arriba de Regular × %, sin pasar del Regular. Con 0 % da lo mismo que «Solo Malo». Origen del %: <b>${esc(origen)}</b>.${niv.length > 1 ? ' Un nivel vacío usa el global.' : ''}</span></div>
    </div>
    <div class="pad resumen-campo">
      <h4>Regular con vida útil cumplida en los locales verificados</h4>
      <p class="sub">Un local con ficha de verificación con antigüedad usa su Regular con antigüedad de ${ent(act.umbralVida ?? 10)} años o más en lugar del %: «Regular por dato verificado». Los demás: «Regular por estimación (%)».</p>
      <ul class="lista-corta">
        <li>Locales con dato verificado: <b>${ent(C.conDato || 0)}</b> de ${ent(C.locales || 0)}${C.conDato && C.completos !== C.conDato ? ` (${ent(C.completos)} con todo su Regular verificado)` : ''}</li>
        <li>% observado de Regular con vida útil cumplida: <b>${obs == null ? '—' : obs.toLocaleString('es-PE') + ' %'}</b>${C.conocido ? ` <span class="sub">(${ent(C.vida)} de ${ent(C.conocido)} bienes regulares con antigüedad)</span>` : ''}</li>
      </ul>
      <button class="btn btn-ghost" id="esc-usar-obs" type="button" ${obs == null ? 'disabled' : ''}>Usar el % observado como porcentaje global</button>
    </div>`;
}

// ─── Precios unitarios de mercado (tabla editable) ──────────────────────────
const ORIGEN = { editado: '<span class="chip-est ok">Editado</span>', catalogo: '<span class="chip-est">Catálogo</span>', referencia: '<span class="chip-est pend">Referencia Loreto 2026</span>' };
function pintarPrecios() {
  const lt = datos.lineasTalla || [], kit = datos.estructura?.kit, tallasKit = (datos.lineasKit || []).map(x => x.talla);
  const fila = (k, nombre, cant, general) => {
    const p = datos.precios[k] || { precio: null, origen: null };
    const usaGeneral = general && p.precio == null;
    const origen = p.origen ? ORIGEN[p.origen] : usaGeneral ? `<span class="chip-est">${general.precio == null ? 'Sin precio' : 'Usa el general'}</span>` : '<span class="chip-est alerta">Sin precio</span>';
    return `<tr${general ? ' class="fila-talla"' : ''}>
      <td>${general ? `<span class="sangria">${esc(nombre)}</span>` : `<b>${esc(nombre)}</b>`}${cant ? `<br><span class="sub">${cant}</span>` : ''}</td>
      <td class="num"><input class="precio-in" data-precio-k="${k}" type="number" min="0" step="0.01" inputmode="decimal" value="${p.origen === 'editado' ? p.precio : ''}" placeholder="${usaGeneral ? (general.precio ?? '') : (p.precio ?? '')}" aria-label="Precio de ${esc(nombre)}"></td>
      <td>${origen}${p.origen === 'editado' ? ` <button class="x" type="button" data-precio-reset="${k}">Restablecer</button>` : ''}</td>
    </tr>`;
  };
  const filas = datos.partidas.filter(part => !part.excluido).map(part => {
    const x = ITEMS.find(y => y.k === part.k), conTalla = x.k === 'mesa' || x.k === 'silla';
    if (!conTalla) return fila(x.k, x.n, `${ent(part.rep)} ${x.u} a reponer`);
    // Tallas con algo que reponer o que entran a un kit (aunque no tengan fila de diagnóstico)
    const ks = [...new Set([...lt.filter(y => y.tipo === x.k && y.talla && y.rep > 0).map(y => y.talla), ...(kit ? tallasKit : [])])]
      .sort((a, b) => TALLAS.findIndex(z => z.k === a) - TALLAS.findIndex(z => z.k === b));
    const general = datos.precios[x.k] || { precio: null };
    return fila(x.k, `${x.n} – precio general`, ks.length ? 'vale para las tallas sin precio propio' : `${ent(part.rep)} ${x.u} a reponer`)
      + ks.map(z => {
        const y = lt.find(v => v.k === `${x.k}_${z}`), kz = (datos.lineasKit || []).find(v => v.talla === z);
        const cant = kit ? (kz ? `${ent(kz.rep)} kits` : '') : y?.rep ? `${ent(y.rep)} ${x.u} a reponer` : '';
        return fila(`${x.k}_${z}`, TALLAS.find(t => t.k === z).n, cant, general);
      }).join('');
  }).join('');
  const kits = kit ? `<p class="sub pad">Precio del kit = mesa + silla de su talla.</p>` : '';
  document.getElementById('exp-precios').innerHTML = `
    <div class="panel-cab"><h3>Precios unitarios de mercado (sin IGV)</h3><a class="btn btn-ghost btn-sm" href="selector-ioarr-precios.html" target="_blank" rel="noopener">Catálogo de precios ↗</a></div>
    <p class="sub pad"><b>${esc(datos.referencia.leyenda)}.</b> Escribe tu precio en la casilla: se guarda en el proyecto. Vacía = el precio del catálogo (fijado en el proyecto o vigente) o, si no hay, la referencia. Una talla sin precio usa el precio general de su tipo.</p>
    <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Bien</th><th class="num">Precio (S/)</th><th>Origen</th></tr></thead><tbody>${filas}</tbody></table></div>${kits}`;
}

// ─── Estructura de costos del 07-C (sin utilidad) y kit ─────────────────────
function pintarEstructura() {
  const S = datos.estructura, g = S.guardada || S.params, prim = (datos.lineasKit || []).some(x => ['p12', 'p34', 'p56'].includes(x.talla)) || (datos.lineasTalla || []).some(x => ['p12', 'p34', 'p56'].includes(x.talla));
  const sumaDist = (g.kit_dist || [1, 1, 1]).reduce((a, b) => a + b, 0) || 1;
  const pctDist = (g.kit_dist || [1, 1, 1]).map(v => Math.round(v / sumaDist * 10000) / 100);
  const num = (id, etiqueta, valor, o = {}) => `<div class="campo"><label for="${id}">${etiqueta}</label><input id="${id}" data-est="${o.k}" type="number" min="0" ${o.max ? `max="${o.max}"` : ''} step="${o.step || 0.01}" inputmode="decimal" value="${valor}"></div>`;
  const kitsPorGrupo = (datos.lineasKit || []).filter(x => ['p12', 'p34', 'p56'].includes(x.talla));
  document.getElementById('exp-rubros').innerHTML = `
    <div class="panel-cab"><h3>Estructura de costos (07-C)</h3><span class="guardado" id="exp-guardado"></span></div>
    ${datos.sin_migracion_estructura ? '<div class="avisos pad"><div class="aviso alerta" role="alert">Falta ejecutar supabase/migrations/027_ioarr_estructura_oferta.sql en Supabase: se usan los valores por defecto y los cambios no se guardan.</div></div>' : ''}
    <p class="sub pad">Estructura referencial de adquisición de bienes, sin gastos generales ni utilidad. ${esc(datos.referencia.nota_porcentajes)}</p>
    <div class="form-grid pad">
      ${num('est-tp', 'Transporte por pieza (S/)', g.transporte_pieza, { k: 'transporte_pieza' })}
      ${num('est-igv', 'IGV (%)', g.igv, { k: 'igv', max: 100 })}
      ${num('est-doc', 'Documento equivalente (% del costo directo sin IGV)', g.doc_pct, { k: 'doc_pct', max: 100 })}
      ${num('est-sup', 'Supervisión (% del costo directo sin IGV)', g.sup_pct, { k: 'sup_pct', max: 100 })}
      ${num('est-liq', 'Liquidación (S/, monto fijo)', g.liquidacion, { k: 'liquidacion' })}
    </div>
    <div class="form-grid pad">
      <div class="campo"><label for="est-cc">Control concurrente (Ley 31358)</label><select id="est-cc"><option value="" ${!g.cc_aplica ? 'selected' : ''}>Según el umbral / sin indicar</option><option value="si" ${g.cc_aplica === 'si' ? 'selected' : ''}>Corresponde</option><option value="no" ${g.cc_aplica === 'no' ? 'selected' : ''}>No corresponde</option></select><span class="sub">Va en B. Otros costos de inversión.</span></div>
      <div class="campo"><label for="est-ccpct">% del control concurrente</label><input id="est-ccpct" data-est-cc="cc_pct" type="number" min="0" max="100" step="0.01" inputmode="decimal" value="${g.cc_pct ?? ''}" placeholder="Lo fija la entidad"></div>
      <div class="campo"><label for="est-ccumb">Umbral de monto (S/, opcional)</label><input id="est-ccumb" data-est-cc="cc_umbral" type="number" min="0" step="1" inputmode="decimal" value="${g.cc_umbral ?? ''}" placeholder="Corresponde si el monto lo supera"><span class="sub">Solo si arriba dice «según el umbral».</span></div>
    </div>
    <div class="pad">
      <label class="chk"><input type="checkbox" id="est-kit" ${g.kit ? 'checked' : ''}> <b>Presentar como kit (mesa + silla del estudiante)</b></label>
      <p class="sub">Kits por aula = el mayor entre mesas y sillas a reponer; el local suma sus aulas (no se toma el mayor de los totales). En el 07-C sale una línea «MOBILIARIO DE AULA», unidad «Kit de mobiliario»; escritorio, silla docente y armario siguen aparte si entran a la IOARR.</p>
      ${g.kit && prim ? `<div class="form-grid kit-dist">
        ${['1.° y 2.°', '3.° y 4.°', '5.° y 6.°'].map((t, j) => `<div class="campo"><label for="est-kd${j}">Primaria ${t} (%)</label><input id="est-kd${j}" data-kit-dist="${j}" type="number" min="0" max="100" step="0.01" value="${pctDist[j]}"><span class="sub">${ent(kitsPorGrupo.find(x => x.talla === ['p12', 'p34', 'p56'][j])?.rep || 0)} kits</span></div>`).join('')}
        <div class="campo"><span class="lbl">&nbsp;</span><button class="btn btn-ghost btn-sm" id="est-kd-iguales" type="button">Partes iguales</button></div>
      </div><p class="sub">Distribución de los kits de Primaria por grupo de grado (por defecto, partes iguales). Los demás niveles se reparten según el grado de cada aula.</p>` : ''}
    </div>
    <div class="uit-fila">
      <div class="campo"><label for="exp-anio">Año de la UIT</label><input id="exp-anio" type="number" min="2000" max="2100" step="1" value="${datos.anio_uit}"></div>
      <div class="sub">${datos.uit ? `UIT ${datos.uit.anio}: <b>${soles(Number(datos.uit.valor))}</b>${datos.uit.fuente ? ' · ' + esc(datos.uit.fuente) : ''} · límite de ${LIMITE_UIT} UIT = ${soles(datos.uitCalc.limite)}` : `No hay UIT cargada para ${datos.anio_uit}. Cárgala en el <a href="selector-ioarr-precios.html#uit" target="_blank" rel="noopener">catálogo</a>.`}</div>
    </div>`;
}

function pintarResultados() {
  pintarKpis(); pintarAvisos();
  const T = datos.totales, S = datos.estructura;
  const lineas = datos.lineas || [];
  const partidas = lineas.filter(p => p.rep > 0).map(p => `<tr><td>${esc(p.n)}</td><td>${p.u}</td><td class="num">${ent(p.rep)}</td><td class="num">${soles(p.pu)}</td><td class="num">${soles(p.parcial)}</td></tr>`).join('')
    + `<tr><td>Transporte</td><td>piezas</td><td class="num">${ent(T.piezas)}</td><td class="num">${soles(S.params.transporte_pieza)}</td><td class="num">${soles(T.transporte)}</td></tr>`;
  const estructura = S.filas.map(f => `<tr class="${f.total ? 'total' : f.fuerte ? 'fuerte' : ''}"><td>${f.fuerte || f.total ? `<b>${esc(f.nombre)}</b>` : `<span class="sangria">${esc(f.nombre)}</span>`}</td><td class="num">${soles(f.monto)}</td></tr>`).join('');
  const lf = (datos.lineasTalla || []);
  const falt = lf.filter(p => p.fal > 0 || !p.talla).map(p => `<tr><td>${esc(p.n)}</td><td class="num">${ent(p.fal)}</td><td class="num">${soles(p.falValor)}</td></tr>`).join('');
  const dist = datos.distritos.map(d => `<tr><td>${esc(d.nom)}<br><span class="sub">${esc(d.prov)} · ${d.ubigeo}</span></td><td class="num">${ent(d.n)}</td><td class="num">${ent(d.est)}</td><td class="num">${ent(S.kit ? d.kits : d.rep)}</td><td class="num">${soles(d.total)}</td><td class="num">${d.porEstudiante == null ? '—' : soles(d.porEstudiante)}</td><td class="num sub">${ent(d.fal)}</td></tr>`).join('');
  const q = norm(filtroLoc).trim();
  const locs = [...datos.locales].filter(l => !q || l.cod.includes(q) || norm(l.nom).includes(q) || norm(l.dist).includes(q))
    .sort((a, b) => b.total - a.total || a.cod.localeCompare(b.cod));
  const pags = Math.max(1, Math.ceil(locs.length / PAGE)); pagLoc = Math.min(pagLoc, pags - 1);
  const desde = pagLoc * PAGE;
  const lrows = locs.slice(desde, desde + PAGE).map(l => `<tr><td class="mono">${l.cod}</td><td><span class="nm">${esc(l.nom)}</span><span class="sub">${esc(l.dist)}${l.rural ? ' · rural' : ''}</span>${l.duplicidad?.estado === 'si' ? `<br><span class="chip-est alerta" title="Otra inversión vigente o reciente: riesgo de duplicidad">Otra inversión${l.duplicidad.codigo ? ' ' + esc(l.duplicidad.codigo) : ''}</span>` : ''}${datos.escenario?.k === 'malo_regular' && l.regular ? `<br><span class="chip-est${l.regular.origen === 'dato' ? ' ok' : ''}" title="${l.regular.parcial ? 'Parte del Regular tiene antigüedad verificada; el resto se estima con el %' : ''}">${l.regular.origen === 'dato' ? 'Regular por dato verificado' : `Regular por estimación (${l.regular.pct} %)`}${l.regular.parcial ? ' · dato parcial' : ''}</span>` : ''}</td><td class="num">${ent(l.est)}</td><td class="num">${ent(l.rep)}</td><td class="num">${ent(l.kits)}</td><td class="num">${ent(l.fal)}</td><td class="num">${soles(l.cd)}</td><td class="num"><b>${soles(l.total)}</b></td>
    <td>${l.verificado ? `<span class="chip-est ok">Verificado ${fechaPe(l.verificado.fecha_visita)}</span><br>${l.verificado.ficha ? '<span class="sub">con ficha</span><br>' : ''}${l.archivos ? `<span class="sub">${l.archivos} archivo${l.archivos === 1 ? '' : 's'}</span><br>` : '<span class="chip-est pend">Sin sustento</span><br>'}` : ''}<button class="x" data-inv="${esc(l.cod)}" type="button">${l.verificado ? 'Editar' : 'Corregir inventario'}</button></td></tr>`).join('');

  document.getElementById('exp-resultados').innerHTML = `
    <div class="cols">
      <div class="panel"><div class="panel-cab"><h3>Estructura de costos</h3></div>
        <p class="sub pad">${esc(datos.escenario.texto)}${S.kit ? ' Mesas y sillas como kit.' : ''}</p>
        <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Partida</th><th>Unidad</th><th class="num">Metrado</th><th class="num">P. unitario</th><th class="num">Parcial</th></tr></thead><tbody>${partidas}</tbody>
        <tfoot><tr><td colspan="4">Costo directo</td><td class="num">${soles(T.cd)}</td></tr></tfoot></table></div>
        <div class="tabla-wrap borde-0"><table class="tabla tabla-estructura"><tbody>${estructura}</tbody></table></div>
        <p class="sub pad">Sin gastos generales, utilidad, gestión ni imprevistos. ${esc(datos.referencia.nota_porcentajes)}</p></div>
      <div class="panel"><div class="panel-cab"><h3>Faltante (brecha de dotación, no reposición)</h3></div>
        <p class="sub pad">Matrícula − mobiliario existente: <b>corresponde a ampliación marginal, no a reposición</b>. Es solo informativo: no suma a lo que se repone, al costo ni al Formato 07-C, en ningún escenario (Lineamientos IOARR del MEF, 2.4.C.c). Lo que se repone tampoco pasa de la matrícula ni de la capacidad de diseño de cada colegio. Se valoriza con los mismos precios, solo como referencia.</p>
        <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Tipo</th><th class="num">Faltante</th><th class="num">Valor referencial</th></tr></thead><tbody>${falt}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${ent(T.fal)}</td><td class="num">${soles(T.falValor)}</td></tr></tfoot></table></div>
      </div>
    </div>
    <div class="panel"><div class="panel-cab"><h3>Por distrito</h3></div>
      <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Distrito</th><th class="num">Locales</th><th class="num">Estudiantes</th><th class="num">${S.kit ? 'Kits' : 'Bienes a reponer'}</th><th class="num">Monto</th><th class="num">Por estudiante</th><th class="num" title="Faltante (brecha de dotación, no reposición): no suma al total">Faltante (no reposición)</th></tr></thead><tbody>${dist}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${ent(T.locales)}</td><td class="num">${ent(T.est)}</td><td class="num">${ent(S.kit ? T.kits : T.rep)}</td><td class="num">${soles(T.total)}</td><td class="num">${T.porEstudiante == null ? '—' : soles(T.porEstudiante)}</td><td class="num sub">${ent(T.fal)}</td></tr></tfoot></table></div></div>
    <div class="panel"><div class="panel-cab"><h3>Por local</h3><span class="sub">Ordenados por monto</span></div>
      <div class="pad"><input id="exp-buscar" type="search" placeholder="Buscar por código de local, nombre o distrito" value="${esc(filtroLoc)}" autocomplete="off" aria-label="Buscar local"></div>
      <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Código de local</th><th>Instituciones</th><th class="num">Estudiantes</th><th class="num">A reponer</th><th class="num" title="Mayor entre mesas y sillas, por aula">Kits</th><th class="num" title="Faltante (brecha de dotación, no reposición): no suma al total">Faltante (no reposición)</th><th class="num">Costo directo</th><th class="num">Monto</th><th>Inventario</th></tr></thead><tbody>${lrows || '<tr><td colspan="9" class="vacio">Ningún local coincide con la búsqueda.</td></tr>'}</tbody></table></div>
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
// Oferta (uso interno): no se exporta
function abrirOferta() {
  return renderOferta({ ...ctx, el: document.getElementById('exp-v-oferta') });
}
// Por colegio: lo que se guarda cambia el costo (uso, entregas, capacidad) y quién entra al 07-C
function abrirColegios() {
  return renderColegios({ ...ctx, el: document.getElementById('exp-v-colegios'), alCambiar: () => { costosViejos = true; } });
}
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
  document.getElementById('exp-v-colegios').hidden = v !== 'colegios';
  document.getElementById('exp-v-oferta').hidden = v !== 'oferta';
  if (v === 'costos' && costosViejos) { costosViejos = false; renderExpediente(ctx); return; }
  if (v === 'oferta') abrirOferta();
  if (v === 'fichas') abrirFichas();
  if (v === 'colegios') abrirColegios();
  if (v === 'docs') abrirDocumentos();
  if (v === 'verif') abrirVerificacion();
}

// ─── Cambios ────────────────────────────────────────────────────────────────
function estado(t, cls = '') { const s = document.getElementById('exp-guardado'); if (s) { s.className = 'guardado ' + cls; s.textContent = t; } }

// Repinta todo lo de Costos sin perder el foco ni la posición del cursor
function repintar() {
  const act = document.activeElement, id = act?.id, pk = act?.dataset?.precioK, kd = act?.dataset?.kitDist;
  const pos = act && 'selectionStart' in act ? (() => { try { return act.selectionStart; } catch { return null; } })() : null;
  pintarIoarr(); pintarEscenarios(); pintarPrecios(); pintarEstructura(); pintarResultados();
  const e = id ? document.getElementById(id) : pk ? document.querySelector(`[data-precio-k="${pk}"]`) : kd != null ? document.querySelector(`[data-kit-dist="${kd}"]`) : null;
  if (e && e !== document.body) { e.focus(); if (pos != null) try { e.setSelectionRange(pos, pos); } catch { /* sin selección */ } }
}

async function guardar(body) {
  const mio = ++version;
  estado('Guardando…', 'pend');
  try {
    const d = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos${qn()}`, { method: 'PATCH', body });
    if (mio !== version) return;
    datos = d;
    repintar();
    estado('Guardado', 'ok');
  } catch (e) { if (mio === version) estado('No se pudo guardar: ' + e.message, 'error'); }
}
const guardarEstructura = (cambios, ms = 700) => { clearTimeout(tGuardar); estado('Cambios sin guardar', 'pend'); tGuardar = setTimeout(() => guardar({ estructura: cambios }), ms); };
// Distribución de kits de Primaria (en %, se guardan como pesos)
const leerDist = () => [0, 1, 2].map(j => { const v = parseFloat(document.querySelector(`[data-kit-dist="${j}"]`)?.value); return Number.isFinite(v) && v >= 0 ? v : 0; });

// Escenario y parámetros de capacidad: son criterios del proyecto (los guarda el Selector)
let tEsc = null;
async function cambiarEscenario(cambios) {
  const s = document.getElementById('esc-guardado'); if (s) { s.className = 'guardado pend'; s.textContent = 'Guardando…'; }
  try {
    await ctx.cambiarCriterios(cambios);
    await renderExpediente(ctx);
  } catch (e) { if (s) { s.className = 'guardado error'; s.textContent = 'No se pudo guardar: ' + e.message; } }
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
    if (e.target.dataset.est) { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v >= 0) guardarEstructura({ [e.target.dataset.est]: v }); return; }
    // Control concurrente: vacío = sin dato (null)
    if (e.target.dataset.estCc) { const v = e.target.value === '' ? null : parseFloat(e.target.value); if (v === null || (Number.isFinite(v) && v >= 0)) guardarEstructura({ [e.target.dataset.estCc]: v }, 900); return; }
    if (e.target.dataset.precioK) { const v = e.target.value === '' ? null : parseFloat(e.target.value); if (v === null || (Number.isFinite(v) && v >= 0)) guardarEstructura({ precios: { [e.target.dataset.precioK]: v } }, 900); return; }
    if (e.target.dataset.kitDist != null) { const d = leerDist(); if (d.some(v => v > 0)) guardarEstructura({ kit_dist: d }, 900); return; }
    if (e.target.id === 'esc-ocup' || e.target.id === 'esc-pct') {
      clearTimeout(tEsc);
      const o = Number(document.getElementById('esc-ocup').value), p = Number(document.getElementById('esc-pct').value);
      if (o >= 1 && o <= 60 && p >= 1 && p <= 100) tEsc = setTimeout(() => cambiarEscenario({ capOcup: o, capPct: p }), 900);
      return;
    }
    if (e.target.id === 'esc-pctreg' || e.target.id === 'esc-umbral' || e.target.dataset.pctNiv) {
      clearTimeout(tEsc);
      const g = document.getElementById('esc-pctreg').value, u = Number(document.getElementById('esc-umbral').value);
      const vg = Number(g), porNiv = {};
      document.querySelectorAll('[data-pct-niv]').forEach(x => { if (x.value !== '') porNiv[x.dataset.pctNiv] = Number(x.value); });
      const ok = v => Number.isInteger(v) && v >= 0 && v <= 100;
      if (g === '' || !ok(vg) || !Object.values(porNiv).every(ok) || !(Number.isInteger(u) && u >= LIM_UMBRAL[0] && u <= LIM_UMBRAL[1])) return;
      const cambios = { umbralVida: u, pctRegularNivel: porNiv };
      // Cambiar el % a mano lo vuelve «valor manual»; el umbral solo no cambia el origen
      if (e.target.id !== 'esc-umbral') { cambios.pctRegular = vg; cambios.pctOrigen = { tipo: 'manual' }; }
      tEsc = setTimeout(() => cambiarEscenario(cambios), 900);
      return;
    }
    if (e.target.id === 'exp-anio') {
      clearTimeout(tGuardar);
      const a = Number(e.target.value);
      if (Number.isInteger(a) && a >= 2000 && a <= 2100) tGuardar = setTimeout(() => guardar({ anio_uit: a }), 700);
    }
  });
  el.addEventListener('change', e => {
    if (e.target.name === 'exp-esc') { cambiarEscenario({ escenario: e.target.value }); return; }
    if (e.target.id === 'est-kit') { clearTimeout(tGuardar); guardar({ estructura: { kit: e.target.checked } }); }
    if (e.target.id === 'est-cc') { clearTimeout(tGuardar); guardar({ estructura: { cc_aplica: e.target.value } }); }
  });
  enlazarDocumentos(el);
  enlazarOferta(el);
  enlazarVerificacion(el);
  enlazarFichas(el);
  enlazarColegios(el);
  el.addEventListener('click', e => {
    const sv = e.target.closest('[data-exp-vista]');
    if (sv) cambiarVista(sv.dataset.expVista);
    const nv = e.target.closest('[data-exp-nivel]');
    if (nv) cambiarNivel(nv.dataset.expNivel);
    if (e.target.id === 'exp-excel') exportar(e.target);
    if (e.target.id === 'esc-usar-obs') {
      const C = datos.escenario?.campo;
      if (C?.observado != null) { clearTimeout(tEsc); const pct = Math.round(C.observado); cambiarEscenario({ pctRegular: pct, pctOrigen: { tipo: 'observado', n: C.conDato, umbral: datos.escenario.umbralVida, pct } }); }
    }
    const pr = e.target.closest('[data-precio-reset]');
    if (pr) { clearTimeout(tGuardar); guardar({ estructura: { precios: { [pr.dataset.precioReset]: null } } }); }
    if (e.target.id === 'est-kd-iguales') { clearTimeout(tGuardar); guardar({ estructura: { kit_dist: [1, 1, 1] } }); }
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
    repintar();
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
    repintar();
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
  try { datos = await ctx.api(`/proyectos/${ctx.proyecto.id}/costos${qn()}`); repintar(); } catch { /* se verá al recargar */ }
}
