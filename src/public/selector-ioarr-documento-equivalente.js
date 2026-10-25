// Selector IOARR — Expediente › Documento equivalente: borrador del expediente técnico de la IOARR
// (después de la buena pro). El servidor arma todo (src/selector-ioarr/documento-equivalente.js y
// word-documento-equivalente.js): aquí se llena la ficha (se guarda sola), el legajo de cotizaciones
// con sus PDF, se ven el presupuesto y las validaciones y se exporta. Una ficha = una IOARR (un nivel).

const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const soles = n => n == null ? '—' : 'S/ ' + NS.format(n);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fechaHora = s => s ? new Date(s).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '';
const NOMBRE_NIVEL = { I: 'Inicial', P: 'Primaria', S: 'Secundaria', E: 'Básica Especial' };
const CHIP = { APP: 'ok', PARCIAL: 'pend', MANUAL: '' };
const TOMO = { PT: 'Plan de trabajo', I: 'Tomo I', II: 'Tomo II', III: 'Tomo III' };

let ctx = null, lista = null, vista = null, fichaId = null, proyectoDe = null, versiones = [];
let tGuardar = null, version = 0, pendientes = {}, cots = [], secs = null;

export async function renderDocumentoEquivalente(c) {
  ctx = c;
  if (proyectoDe !== c.proyecto.id) { proyectoDe = c.proyecto.id; fichaId = null; }
  c.el.innerHTML = '<div class="panel vacio">Cargando el documento equivalente…</div>';
  const mio = ++version;
  try {
    lista = await c.api(`/proyectos/${c.proyecto.id}/documento-equivalente`);
    if (mio !== version) return;
    if (!lista.fichas.some(f => f.id === fichaId)) fichaId = lista.fichas[0]?.id || null;
    if (fichaId) await abrir(fichaId, mio); else pintar();
  } catch (e) { if (mio === version) c.el.innerHTML = `<div class="panel vacio"><p class="err">${esc(e.message)}</p></div>`; }
}
async function abrir(id, mio = ++version) {
  fichaId = id;
  const [v, vs] = await Promise.all([ctx.api(`/documento-equivalente/${id}`), ctx.api(`/documento-equivalente/${id}/versiones`)]);
  if (mio !== version) return;
  recibir(v); versiones = vs; pintar();
}
function recibir(v) {
  vista = v;
  cots = structuredClone(v.datos.cotizaciones || []);
  secs = structuredClone(v.datos.secciones || { quitar: [], titulos: {}, extras: [] });
}

// ─── Pintado ─────────────────────────────────────────────────────────────────
const opcionesNivel = sel => lista.niveles.map(n => `<option value="${n.nivel}" ${n.nivel === sel ? 'selected' : ''}>IOARR ${esc(n.nombre)}</option>`).join('');
const nivelSugerido = actual => (lista.niveles.find(n => !lista.fichas.some(f => f.nivel === n.nivel)) || lista.niveles.find(n => n.nivel !== actual) || lista.niveles[0])?.nivel;

function pintar() {
  const L = lista;
  const cab = `<div class="avisos"><div class="aviso" role="note"><b>Documento equivalente (después de la buena pro).</b> Borrador del expediente técnico de la IOARR con la estructura de la plantilla de mobiliario escolar: plan de trabajo y tomos I a III. Cada dato indica su fuente: <span class="chip-est ok">APP</span> lo da la app, <span class="chip-est pend">PARCIAL</span> se prellena y sale marcado «[REVISAR]» hasta que lo revises, <span class="chip-est">MANUAL</span> lo completas tú (mientras falte, sale resaltado). La oferta interna no entra en este documento. <i>${esc(L.aviso)}</i></div>
    ${L.sin_migracion ? '<div class="aviso alerta" role="alert">Falta ejecutar supabase/migrations/034_ioarr_documento_equivalente.sql en Supabase: el documento no se puede guardar.</div>' : ''}</div>`;
  if (!L.niveles.length) { ctx.el.innerHTML = cab + '<div class="panel vacio"><p>El proyecto no tiene IOARR calculadas todavía: elige locales con mobiliario a reponer.</p></div>'; return; }
  if (!L.fichas.length || !vista) {
    ctx.el.innerHTML = cab + `<div class="panel vacio"><h3 class="vacio-tit">Crea el documento equivalente</h3><p>Uno por IOARR, es decir, por nivel. Se precarga con la app y con la ficha de bases del mismo nivel.</p>
      <div class="bx-nueva"><label for="de-nivel" class="lbl">Nivel</label><select id="de-nivel">${opcionesNivel(nivelSugerido())}</select>
      <button class="btn btn-primary btn-sm" id="de-crear" type="button">Crear documento</button></div></div>`;
    return;
  }
  const f = vista.ficha;
  ctx.el.innerHTML = cab + `
    <div class="panel"><div class="panel-cab">
      <div class="bx-sel"><label for="de-ficha" class="lbl">Documento</label>
        <select id="de-ficha">${L.fichas.map(x => `<option value="${x.id}" ${x.id === f.id ? 'selected' : ''}>${esc(x.nombre)} · ${NOMBRE_NIVEL[x.nivel]}</option>`).join('')}</select>
        <span class="bx-nivel-fijo" title="Cada documento es de una sola IOARR: su nivel no cambia">IOARR ${esc(NOMBRE_NIVEL[f.nivel])}</span></div>
      <div class="bx-acc">
        <input id="de-nombre" type="text" maxlength="200" value="${esc(f.nombre)}" aria-label="Nombre del documento">
        <button class="btn btn-ghost btn-sm" id="de-precargar" type="button" title="Llena con datos de la app solo los campos vacíos">Tomar datos de la app</button>
        <button class="btn btn-ghost btn-sm btn-peligro" id="de-borrar" type="button">Borrar</button>
      </div>
      <span class="guardado" id="de-guardado"></span>
    </div>
    <details class="bx-otra"><summary>Documento para otro nivel</summary>
      <div class="bx-nueva"><label for="de-nivel" class="lbl">Nivel</label><select id="de-nivel">${opcionesNivel(nivelSugerido(f.nivel))}</select>
        <button class="btn btn-primary btn-sm" id="de-crear" type="button">Crear documento</button></div>
    </details></div>
    <div id="de-estado"></div>
    <form class="panel doc-form" id="de-form" autocomplete="off">
      ${origen()}
      ${montos()}
      <fieldset class="bx-sec"><legend>Legajo de cotizaciones (Tomo III)</legend><div id="de-legajo"></div></fieldset>
      <fieldset class="bx-sec"><legend>Presupuesto referencial (2.17)</legend><div id="de-presupuesto"></div></fieldset>
      ${datosPorTomo()}
      ${especificaciones()}
    </form>
    <div id="de-versiones"></div>`;
  pintarLegajo(); actualizar();
}

const errDe = k => (vista.validacion.errores || []).filter(e => e.k === k);
const deApp = k => vista.datos._precarga && k in vista.datos._precarga && vista.datos._precarga[k] === vista.datos[k];
const errSpan = k => `<span class="err" data-de-err="${k}" hidden></span>`;

function control(c) {
  const v = vista.datos[c.k];
  if (c.tipo === 'parrafo') return `<textarea data-de="${c.k}" rows="2" maxlength="4000">${esc(v)}</textarea>`;
  if (c.tipo === 'dias') return `<input data-de="${c.k}" type="number" min="1" max="3650" step="1" inputmode="numeric" value="${v ?? ''}">`;
  return `<input data-de="${c.k}" type="text" maxlength="500" value="${esc(v)}">`;
}
function campo(c) {
  const rev = c.fuente === 'PARCIAL', d = vista.datos;
  return `<div class="campo${c.tipo === 'parrafo' ? ' ancho' : ''}" data-de-campo="${c.k}">
    <label>${esc(c.etiqueta)}${c.fuente === 'APP' ? ' <span class="bx-req" title="Obligatorio">*</span>' : ''} <span class="chip-est ${CHIP[c.fuente]}">${c.fuente}</span> <span class="chip-est ok bx-app" ${deApp(c.k) ? '' : 'hidden'}>de la app</span></label>
    ${control(c)}
    ${rev ? `<label class="chk"><input data-de-rev="${c.k}" type="checkbox" ${d.revisados?.[c.k] ? 'checked' : ''}> Revisado (quita la marca «[REVISAR]»)</label>` : ''}
    ${c.k === 'NORMAS_TECNICAS' ? `<label class="chk"><input data-de="normas_verificadas" type="checkbox" ${d.normas_verificadas ? 'checked' : ''}> Verifiqué que están vigentes y aplican a este nivel</label>${errSpan('normas_verificadas')}` : ''}
    ${c.ayuda ? `<span class="sub">${esc(c.ayuda)}</span>` : ''}
    ${d._precarga_notas?.[c.k] && deApp(c.k) ? `<span class="sub">Fuente: ${esc(d._precarga_notas[c.k])}</span>` : ''}
    ${errSpan(c.k)}
  </div>`;
}
// Los campos de cada tomo, en el orden de sus secciones (los de secciones quitadas no se muestran)
function datosPorTomo() {
  const porK = Object.fromEntries(lista.campos.map(c => [c.k, c])), vistos = new Set();
  return lista.tomos.map(t => {
    const cs = t.secciones.filter(s => !secs.quitar.includes(s.id)).flatMap(s => s.campos).filter(k => porK[k] && !vistos.has(k) && vistos.add(k)).map(k => porK[k]);
    return cs.length ? `<fieldset class="bx-sec"><legend>${esc(t.titulo)}</legend><div class="form-grid">${cs.map(campo).join('')}</div></fieldset>` : '';
  }).join('');
}
function origen() {
  const d = vista.datos;
  return `<fieldset class="bx-sec"><legend>Contenido mínimo y secciones</legend>
    <p class="sub">Las bases de cada proceso pueden pedir otro contenido mínimo: quita, renombra o agrega secciones y registra de qué bases proviene. 2.17 (presupuesto) y 3.4 (legajo) no se pueden quitar.</p>
    <div class="form-grid">
      <div class="campo ancho"><label>Bases de las que proviene el contenido mínimo (proceso y numeral)</label><input data-de="bases_origen" type="text" maxlength="300" value="${esc(d.bases_origen)}" placeholder="Ej.: Bases del Proceso de Selección N° 015-2026-GRLL-CE-EF-OXI, Anexo 3-A">${errSpan('bases_origen')}</div>
      <div class="campo"><label>N° de proceso de selección (portada)</label><input data-de="N_PROCESO" type="text" maxlength="120" value="${esc(d.N_PROCESO)}"></div>
    </div>
    <details class="de-secciones"><summary>Secciones del documento (${lista.tomos.reduce((a, t) => a + t.secciones.length, 0) - secs.quitar.length + secs.extras.length})</summary>
      ${lista.tomos.map(t => `<h4>${esc(t.titulo)}</h4><div class="de-lista-sec">${t.secciones.map(s => `<div class="de-sec">
        <label class="chk"><input type="checkbox" data-de-incluir="${s.id}" ${secs.quitar.includes(s.id) ? '' : 'checked'} ${lista.obligatorias.includes(s.id) ? 'disabled title="Obligatoria"' : ''}> <span class="mono">${esc(s.id)}</span></label>
        <input type="text" data-de-titulo="${s.id}" maxlength="200" value="${esc(secs.titulos[s.id] || '')}" placeholder="${esc(s.titulo)}" aria-label="Título de la sección ${esc(s.id)}"></div>`).join('')}</div>`).join('')}
      <h4>Secciones agregadas (van al final de su tomo)</h4>
      ${secs.extras.map((e, i) => `<div class="de-extra" data-de-extra="${i}">
        <select data-de-extra-tomo="${i}" aria-label="Tomo">${Object.entries(TOMO).map(([k, n]) => `<option value="${k}" ${e.tomo === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <input type="text" data-de-extra-titulo="${i}" maxlength="200" value="${esc(e.titulo)}" placeholder="Título" aria-label="Título">
        <textarea data-de-extra-texto="${i}" rows="2" maxlength="4000" placeholder="Contenido (vacío: sale «[COMPLETAR]»)" aria-label="Contenido">${esc(e.texto)}</textarea>
        <button class="btn btn-ghost btn-sm btn-peligro" type="button" data-de-extra-quitar="${i}">Quitar</button></div>`).join('') || '<p class="sub">Ninguna.</p>'}
      <button class="btn btn-ghost btn-sm" type="button" id="de-extra-agregar">Agregar sección</button>
    </details></fieldset>`;
}
function montos() {
  const d = vista.datos, C = lista.controles;
  const m = (k, o = {}) => `<div class="campo" data-de-campo="${k}"><label>${esc(C[k])}${o.req ? ' <span class="bx-req" title="Obligatorio">*</span>' : ''} <span class="chip-est bx-app ok" ${deApp(k) ? '' : 'hidden'}>de la app</span></label>
    <input data-de="${k}" type="number" min="0" ${o.pct ? 'max="100" step="0.1"' : 'step="0.01"'} inputmode="decimal" value="${d[k] ?? ''}">${o.ayuda ? `<span class="sub">${esc(o.ayuda)}</span>` : ''}${errSpan(k)}</div>`;
  return `<fieldset class="bx-sec"><legend>Montos y topes</legend><div class="form-grid">
    ${m('MONTO_CONVENIO_EJECUCION', { req: true, ayuda: 'El presupuesto referencial (2.17) no puede superarlo.' })}
    ${m('MONTO_DOC_EQUIVALENTE', { req: true })}${m('MONTO_SUPERVISION', { req: true })}${m('MONTO_TOTAL_DECLARADO', { ayuda: 'Si lo llenas, la suma de los componentes del resumen (1.9) debe ser igual.' })}
    ${m('GG_PCT', { pct: true, ayuda: 'La estructura de costos de la app no tiene gastos generales: 0 % salvo que las bases los pidan.' })}${m('UTILIDAD_PCT', { pct: true, ayuda: 'Igual: 0 % salvo que las bases la pidan.' })}
  </div></fieldset>`;
}
function especificaciones() {
  const metas = vista.app.metas;
  if (!metas.length) return '';
  return `<fieldset class="bx-sec"><legend>Especificaciones técnicas (2.21) <span class="chip-est ok">APP</span></legend>
    <p class="sub">Biblioteca neutral (sin marcas, modelos ni fabricantes). Deja el texto vacío para usar el de la biblioteca.</p>
    <div class="form-grid">${metas.map(m => `<div class="campo ancho"><label>${esc(lista.especificaciones[m.k]?.nombre || m.nombre)}</label>
      <textarea data-de-esp="${m.k}" rows="3" maxlength="3000" placeholder="${esc(lista.especificaciones[m.k]?.texto || '')}">${esc(vista.datos.especificaciones?.[m.k] || '')}</textarea></div>`).join('')}</div>${errSpan('especificaciones')}
  </fieldset>`;
}

// Legajo: la tabla se repinta solo al agregar, quitar o adjuntar (mientras se escribe no se pierde el foco)
function pintarLegajo() {
  const el = document.getElementById('de-legajo'), metas = vista.app.metas;
  if (!el) return;
  const fila = (c, i) => `<tr data-de-cot="${i}">
    <td><input type="text" data-de-c="proveedor" maxlength="200" value="${esc(c.proveedor)}" aria-label="Proveedor"><input type="text" data-de-c="ruc" maxlength="11" inputmode="numeric" value="${esc(c.ruc)}" placeholder="RUC" aria-label="RUC"></td>
    <td><input type="date" data-de-c="fecha" value="${esc(c.fecha || '')}" aria-label="Fecha"></td>
    <td><input type="number" data-de-c="vigencia_dias" min="1" step="1" value="${c.vigencia_dias ?? ''}" aria-label="Vigencia en días"></td>
    <td><label class="chk"><input type="checkbox" data-de-c="incluye_igv" ${c.incluye_igv ? 'checked' : ''}> Sí</label></td>
    <td><input type="number" data-de-c="plazo_entrega_dias" min="1" step="1" value="${c.plazo_entrega_dias ?? ''}" aria-label="Plazo de entrega en días"></td>
    ${metas.map(m => `<td><input type="number" data-de-p="${m.k}" min="0" step="0.01" value="${c.precios?.[m.k] ?? ''}" aria-label="Precio: ${esc(m.nombre)}"></td>`).join('')}
    <td>${!c.id ? '<span class="sub">Guardando…</span>' : c.archivo_nombre
      ? `<button class="btn-link" type="button" data-de-pdf="${c.id}">${esc(c.archivo_nombre)}</button> <button class="btn-link" type="button" data-de-pdf-quitar="${c.id}">quitar</button>`
      : `<label class="btn btn-ghost btn-sm">Adjuntar PDF<input type="file" accept="application/pdf" data-de-subir="${c.id}" hidden></label>`}</td>
    <td><button class="btn btn-ghost btn-sm btn-peligro" type="button" data-de-cot-quitar="${i}" aria-label="Quitar cotización">✕</button></td></tr>`;
  el.innerHTML = `<p class="sub">Precio por ítem, en soles, tal como figura en la cotización. Marca «IGV» si el precio lo incluye: el promedio se calcula sin IGV (÷ 1,18). Solo cuentan las cotizaciones vigentes (fecha + vigencia ≥ hoy). Se piden ${lista.min_cotizaciones} por ítem o una justificación escrita.</p>
    <div class="tabla-wrap borde-0"><table class="tabla de-legajo"><thead><tr><th>Proveedor / RUC</th><th>Fecha</th><th>Vigencia (días)</th><th>IGV</th><th>Plazo de entrega (días)</th>
      ${metas.map(m => `<th class="num">${esc(m.nombre)}</th>`).join('')}<th>PDF firmado</th><th></th></tr></thead>
    <tbody>${cots.map(fila).join('') || `<tr><td colspan="${7 + metas.length}" class="vacio">Sin cotizaciones.</td></tr>`}</tbody></table></div>
    <button class="btn btn-ghost btn-sm" type="button" id="de-cot-agregar">Agregar cotización</button>${errSpan('cotizaciones')}`;
}

function pintarPresupuesto() {
  const el = document.getElementById('de-presupuesto'), P = vista.presupuesto, d = vista.datos;
  if (!el || el.contains(document.activeElement)) return;   // se está escribiendo una cantidad o justificación
  const cmp = vista.catalogo;
  el.innerHTML = `<p class="sub">Cantidades del Formato 07-C × precio unitario promedio sin IGV del legajo. Las cantidades deben ser las del 07-C.</p>
    <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Ítem</th><th class="num">Cantidad</th><th class="num">Cotizaciones vigentes</th><th class="num">Promedio sin IGV</th><th class="num">Promedio con IGV</th><th class="num">Parcial</th></tr></thead><tbody>
    ${P.items.map(x => `<tr><td>${esc(x.nombre)}<span class="sub">${esc(x.unidad)}</span>
        ${x.promedio.proveedores < lista.min_cotizaciones ? `<textarea data-de-just="${x.k}" rows="2" maxlength="2000" placeholder="Justificación: por qué hay menos de ${lista.min_cotizaciones} cotizaciones vigentes (al menos ${lista.min_justificacion} caracteres)" aria-label="Justificación: ${esc(x.nombre)}">${esc(d.justificaciones?.[x.k] || '')}</textarea>` : ''}</td>
      <td class="num"><input type="number" data-de-cant="${x.k}" min="0" step="1" value="${d.cantidades?.[x.k] ?? x.cantidad_07c}" aria-label="Cantidad: ${esc(x.nombre)}"><span class="sub">07-C: ${x.cantidad_07c}</span></td>
      <td class="num">${x.promedio.vigentes}${x.promedio.filas.length > x.promedio.vigentes ? `<span class="sub">${x.promedio.filas.length - x.promedio.vigentes} vencidas</span>` : ''}</td>
      <td class="num">${soles(x.promedio.sin_igv)}</td><td class="num">${soles(x.promedio.con_igv)}</td><td class="num">${soles(x.parcial)}</td></tr>`).join('') || '<tr><td colspan="6" class="vacio">La IOARR no tiene metas en el 07-C.</td></tr>'}
    </tbody><tfoot>
      <tr><td colspan="5">Costo directo</td><td class="num">${soles(P.cd)}</td></tr>
      <tr><td colspan="5">Gastos generales (${P.gg_pct} %)</td><td class="num">${soles(P.gg)}</td></tr>
      <tr><td colspan="5">Utilidad (${P.ut_pct} %)</td><td class="num">${soles(P.ut)}</td></tr>
      <tr><td colspan="5">Subtotal</td><td class="num">${soles(P.subtotal)}</td></tr>
      <tr><td colspan="5">IGV (${P.igv_pct} %)</td><td class="num">${soles(P.igv)}</td></tr>
      <tr><td colspan="5"><b>Total del presupuesto referencial</b></td><td class="num"><b>${soles(P.total)}</b></td></tr>
    </tfoot></table></div>
    ${cmp ? `<div class="aviso" role="note"><b>Catálogo de precios referenciales:</b> ${soles(cmp.catalogo)} por kit sin IGV; el promedio del legajo (${soles(cmp.promedio)}) ${cmp.dif_pct === 0 ? 'es igual' : `está ${Math.abs(cmp.dif_pct)} % ${cmp.dif_pct > 0 ? 'por encima' : 'por debajo'}`}. La referencia se elige en «Precios referenciales».</div>`
      : vista.app.precio_ref ? '<div class="aviso" role="note">Catálogo de precios referenciales: sin referencia comparable para el kit de este nivel.</div>' : ''}
    ${errSpan('cantidades')}${errSpan('justificaciones')}${errSpan('presupuesto')}`;
}

// Lo que cambia al guardar, sin repintar el formulario
function actualizar() {
  const V = vista.validacion, P = vista.presupuesto, A = vista.app, d = vista.datos;
  document.getElementById('de-estado').innerHTML = `
    ${A.aviso ? `<div class="avisos"><div class="aviso alerta" role="alert">Cálculo de la app: ${esc(A.aviso)}</div></div>` : ''}
    <div class="kpis kpis-montos">
      <div class="kpi destacado"><div class="v">${soles(P.total)}</div><div class="l">presupuesto referencial (2.17), con IGV</div></div>
      <div class="kpi"><div class="v">${soles(P.resumen.total)}</div><div class="l">presupuesto resumen (1.9): ejecución + documento equivalente + supervisión</div></div>
      <div class="kpi"><div class="v">${soles(d.MONTO_CONVENIO_EJECUCION)}</div><div class="l">ejecución según el convenio (tope)</div></div>
      <div class="kpi"><div class="v">${soles(A.total_activos)}</div><div class="l">costo de los activos del 07-C (tope) · IOARR ${esc(A.nivel_nombre || '')}</div></div>
    </div>
    <div class="panel"><div class="panel-cab"><h3>${V.ok ? 'Listo para exportar' : `${V.errores.length} ${V.errores.length === 1 ? 'problema bloquea' : 'problemas bloquean'} la exportación`}</h3>
      <div class="bx-acc">
        <button class="btn btn-ghost btn-sm" id="de-previa" type="button" title="Word con lo pendiente resaltado; no guarda versión">Vista previa (Word)</button>
        <button class="btn btn-primary btn-sm" id="de-exportar" type="button" ${V.ok ? '' : 'disabled'}>Exportar documento equivalente (Word, versión ${vista.versiones + 1})</button>
      </div></div>
      <div class="avisos pad">
        ${V.errores.slice(0, 12).map(e => `<div class="aviso alerta" role="alert">${esc(e.texto)}</div>`).join('')}
        ${V.errores.length > 12 ? `<div class="aviso alerta">…y ${V.errores.length - 12} más (marcados en la ficha).</div>` : ''}
        ${V.advertencias.map(a => `<div class="aviso" role="note">${esc(a.texto)}</div>`).join('')}
      </div></div>`;
  for (const el of ctx.el.querySelectorAll('[data-de-campo]')) {
    const k = el.dataset.deCampo, es = errDe(k);
    el.classList.toggle('bx-con-error', es.length > 0);
    const ap = el.querySelector('.bx-app'); if (ap) ap.hidden = !deApp(k);
  }
  pintarPresupuesto();
  for (const e of ctx.el.querySelectorAll('[data-de-err]')) { const es = errDe(e.dataset.deErr); e.hidden = !es.length; e.textContent = es.map(x => x.texto).join(' '); }
  pintarVersiones();
}

function pintarVersiones() {
  const el = document.getElementById('de-versiones');
  if (!el) return;
  el.innerHTML = `<div class="panel"><div class="panel-cab"><h3>Versiones exportadas</h3><span class="sub">Cada exportación guarda la ficha, el legajo, la fecha y el usuario</span></div>
    ${versiones.length ? `<div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Versión</th><th>Fecha</th><th>Usuario</th><th class="num">Presupuesto referencial</th><th></th></tr></thead><tbody>
      ${versiones.map(v => `<tr><td class="mono">v${v.version}</td><td>${esc(fechaHora(v.fecha))}</td><td>${esc(v.usuario || '—')}</td><td class="num">${soles(v.total)}</td>
        <td><button class="btn btn-ghost btn-sm" data-de-bajar="${v.version}" type="button">Descargar</button>${v.plantillas_cambiaron ? ' <span class="chip-est pend" title="Las plantillas cambiaron desde esta versión">plantillas distintas</span>' : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="sub pad">Todavía no se exportó ninguna versión.</p>'}</div>`;
}

// ─── Guardado ────────────────────────────────────────────────────────────────
function estado(t, cls = '') { const s = document.getElementById('de-guardado'); if (s) { s.className = 'guardado ' + cls; s.textContent = t; } }
const numOVacio = v => v === '' ? null : Number(v);
function leer(e) {
  const d = vista.datos;
  if (e.dataset.deRev) return ['revisados', { ...d.revisados, ...pendientes.revisados, [e.dataset.deRev]: e.checked }];
  if (e.dataset.deCant) return ['cantidades', { ...d.cantidades, ...pendientes.cantidades, [e.dataset.deCant]: numOVacio(e.value) }];
  if (e.dataset.deJust) return ['justificaciones', { ...d.justificaciones, ...pendientes.justificaciones, [e.dataset.deJust]: e.value }];
  if (e.dataset.deEsp) return ['especificaciones', { ...d.especificaciones, ...pendientes.especificaciones, [e.dataset.deEsp]: e.value }];
  return [e.dataset.de, e.type === 'checkbox' ? e.checked : e.type === 'number' ? numOVacio(e.value) : e.value];
}
// Una celda del legajo o de las secciones cambia la copia local; se manda entera
function leerLegajo(e) {
  const i = Number(e.closest('[data-de-cot]').dataset.deCot), c = cots[i];
  if (e.dataset.deP) c.precios = { ...c.precios, [e.dataset.deP]: numOVacio(e.value) };
  else c[e.dataset.deC] = e.type === 'checkbox' ? e.checked : e.type === 'number' ? numOVacio(e.value) : e.value;
  pendientes.cotizaciones = cots;
}
function leerSeccion(e) {
  if (e.dataset.deIncluir) { const id = e.dataset.deIncluir; secs.quitar = e.checked ? secs.quitar.filter(x => x !== id) : [...secs.quitar, id]; }
  else if (e.dataset.deTitulo) secs.titulos = { ...secs.titulos, [e.dataset.deTitulo]: e.value };
  else if (e.dataset.deExtraTomo) secs.extras[Number(e.dataset.deExtraTomo)].tomo = e.value;
  else if (e.dataset.deExtraTitulo) secs.extras[Number(e.dataset.deExtraTitulo)].titulo = e.value;
  else if (e.dataset.deExtraTexto) secs.extras[Number(e.dataset.deExtraTexto)].texto = e.value;
  pendientes.secciones = secs;
}
async function guardar({ repintar = false } = {}) {
  const cambios = pendientes; pendientes = {};
  const mio = ++version;
  estado('Guardando…', 'pend');
  try {
    const v = await ctx.api(`/documento-equivalente/${fichaId}`, { method: 'PATCH', body: { datos: cambios } });
    if (mio !== version) return;
    // Las cotizaciones nuevas reciben su id del servidor: si cambió la cantidad de filas o faltaba un id, se repinta el legajo
    const ids = cots.map(c => c.id).join();
    vista = v;
    if (repintar) { recibir(v); pintar(); }
    else { cots = cots.map((c, i) => ({ ...c, id: v.datos.cotizaciones[i]?.id ?? c.id, archivo_ruta: v.datos.cotizaciones[i]?.archivo_ruta, archivo_nombre: v.datos.cotizaciones[i]?.archivo_nombre }));
      if (ids !== cots.map(c => c.id).join()) pintarLegajo();
      actualizar(); }
    estado('Guardado', 'ok');
  } catch (e) {
    pendientes = { ...cambios, ...pendientes };
    if (mio === version) estado('No se pudo guardar: ' + e.message, 'error');
  }
}
const programar = ms => { clearTimeout(tGuardar); estado('Cambios sin guardar', 'pend'); tGuardar = setTimeout(guardar, ms); };
async function guardarYa(o) { clearTimeout(tGuardar); if (Object.keys(pendientes).length || o?.repintar) await guardar(o); }

// ─── Acciones ────────────────────────────────────────────────────────────────
async function bajar(url, opciones, btn) {
  const txt = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = 'Generando…'; }
  try {
    await guardarYa();
    const r = await fetch('/api/selector-ioarr' + url, opciones);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error + (j.errores?.length ? ': ' + j.errores.slice(0, 3).map(e => e.texto).join(' ') : ''));
    }
    const cd = r.headers.get('Content-Disposition') || '', nombre = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'Documento_equivalente.docx');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: nombre });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return r;
  } finally { if (btn) { btn.disabled = false; btn.textContent = txt; } }
}
async function accion(fn, okMsg) {
  try { await guardarYa(); const r = await fn(); if (okMsg) ctx.toast(okMsg); return r; }
  catch (e) { ctx.toast('No se pudo: ' + e.message); }
}

export function enlazarDocumentoEquivalente(el) {
  const enForm = t => t.closest('#de-form');
  el.addEventListener('input', e => {
    const t = e.target;
    if (!enForm(t) || t.type === 'checkbox' || t.type === 'file' || t.tagName === 'SELECT') return;
    if (t.closest('[data-de-cot]')) { leerLegajo(t); programar(900); return; }
    if (t.dataset.deTitulo || t.dataset.deExtraTitulo || t.dataset.deExtraTexto) { leerSeccion(t); programar(900); return; }
    const [k, v] = leer(t); pendientes[k] = v; programar(900);
  });
  el.addEventListener('change', async e => {
    const t = e.target;
    if (t.id === 'de-ficha') { await accion(() => abrir(t.value)); return; }
    if (t.id === 'de-nombre') { await accion(async () => { const v = await ctx.api(`/documento-equivalente/${fichaId}`, { method: 'PATCH', body: { nombre: t.value } }); lista.fichas.find(f => f.id === fichaId).nombre = v.ficha.nombre; vista = v; pintar(); }, 'Nombre guardado.'); return; }
    if (t.dataset.deSubir && t.files?.[0]) {
      await accion(async () => {
        const fd = new FormData(); fd.append('archivo', t.files[0]);
        const r = await fetch(`/api/selector-ioarr/documento-equivalente/${fichaId}/cotizaciones/${t.dataset.deSubir}/archivo`, { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'No se pudo subir el PDF');
        recibir(j); pintar();
      }, 'PDF adjuntado.');
      return;
    }
    if (!enForm(t)) return;
    // Incluir o quitar una sección cambia qué campos se muestran: se guarda y se repinta
    if (t.dataset.deIncluir || t.dataset.deExtraTomo) { leerSeccion(t); await guardarYa({ repintar: true }); return; }
    if (t.closest('[data-de-cot]') && (t.type === 'checkbox')) { leerLegajo(t); programar(50); return; }
    if (t.type === 'checkbox' || t.tagName === 'SELECT') { const [k, v] = leer(t); pendientes[k] = v; programar(50); }
  });
  el.addEventListener('submit', e => { if (e.target.id === 'de-form') e.preventDefault(); });
  el.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'de-crear') {
      const nivel = document.getElementById('de-nivel').value;
      await accion(async () => { const v = await ctx.api(`/proyectos/${ctx.proyecto.id}/documento-equivalente`, { method: 'POST', body: { nivel } }); fichaId = v.ficha.id; await renderDocumentoEquivalente(ctx); }, 'Documento creado con los datos de la app.');
    }
    if (t.id === 'de-borrar' && confirm('¿Borrar este documento, su legajo (con los PDF) y sus versiones exportadas? No se puede deshacer.')) {
      await accion(async () => { await ctx.api(`/documento-equivalente/${fichaId}`, { method: 'DELETE' }); fichaId = null; vista = null; await renderDocumentoEquivalente(ctx); }, 'Documento borrado.');
    }
    if (t.id === 'de-precargar') {
      await accion(async () => { const v = await ctx.api(`/documento-equivalente/${fichaId}/precargar`, { method: 'POST' }); recibir(v); pintar();
        ctx.toast(v.llenados.length ? `Se llenaron ${v.llenados.length} campos vacíos con datos de la app.` : 'No había campos vacíos que la app pudiera llenar.'); }, null);
    }
    if (t.id === 'de-cot-agregar') {
      cots.push({ proveedor: '', ruc: '', fecha: vista.hoy, vigencia_dias: 30, incluye_igv: false, plazo_entrega_dias: null, precios: {} });
      pendientes.cotizaciones = cots; pintarLegajo();
      await guardarYa();
    }
    if (t.dataset.deCotQuitar != null) {
      const c = cots[Number(t.dataset.deCotQuitar)];
      if (c.archivo_nombre && !confirm(`¿Quitar la cotización de ${c.proveedor || 'este proveedor'}? También se borra su PDF.`)) return;
      cots.splice(Number(t.dataset.deCotQuitar), 1); pendientes.cotizaciones = cots;
      await guardarYa({ repintar: true });
    }
    if (t.dataset.dePdf) await accion(async () => { const { url } = await ctx.api(`/documento-equivalente/${fichaId}/cotizaciones/${t.dataset.dePdf}/archivo`); window.open(url, '_blank', 'noopener'); }, null);
    if (t.dataset.dePdfQuitar && confirm('¿Quitar el PDF de esta cotización?')) {
      await accion(async () => { recibir(await ctx.api(`/documento-equivalente/${fichaId}/cotizaciones/${t.dataset.dePdfQuitar}/archivo`, { method: 'DELETE' })); pintar(); }, 'PDF quitado.');
    }
    if (t.id === 'de-extra-agregar') { secs.extras.push({ tomo: 'II', titulo: 'Nueva sección', texto: '' }); pendientes.secciones = secs; await guardarYa({ repintar: true }); }
    if (t.dataset.deExtraQuitar != null) { secs.extras.splice(Number(t.dataset.deExtraQuitar), 1); pendientes.secciones = secs; await guardarYa({ repintar: true }); }
    if (t.id === 'de-previa') await bajar(`/documento-equivalente/${fichaId}/vista-previa`, {}, t).then(() => ctx.toast('Vista previa descargada (no guarda versión).')).catch(x => ctx.toast('No se pudo: ' + x.message));
    if (t.id === 'de-exportar') {
      await bajar(`/documento-equivalente/${fichaId}/exportar`, { method: 'POST' }, t)
        .then(async r => { ctx.toast(`Documento equivalente exportado: versión ${r.headers.get('X-DE-Version')}.`); await abrir(fichaId); })
        .catch(x => ctx.toast('No se pudo exportar: ' + x.message));
    }
    if (t.dataset.deBajar) {
      await bajar(`/documento-equivalente/${fichaId}/versiones/${t.dataset.deBajar}/docx`, {}, t)
        .then(r => { if (r.headers.get('X-Plantillas-Cambiaron')) ctx.toast('Ojo: las plantillas cambiaron desde esa versión; el Word usa las plantillas actuales con la ficha guardada.'); })
        .catch(x => ctx.toast('No se pudo: ' + x.message));
    }
  });
}
