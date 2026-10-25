// Selector IOARR — Expediente › Bases OxI: ficha del proceso y borrador de bases en Word.
// El servidor arma todo (src/selector-ioarr/bases.js y word-bases.js): aquí se llena la
// ficha (se guarda sola), se ven las validaciones y se exporta. Una ficha = una IOARR
// (un nivel). El documento equivalente y su supervisión son siempre obligatorios.

const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const soles = n => n == null ? '—' : 'S/ ' + NS.format(n);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fechaHora = s => s ? new Date(s).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '';
const NOMBRE_NIVEL = { I: 'Inicial', P: 'Primaria', S: 'Secundaria', E: 'Básica Especial' };

let ctx = null, lista = null, vista = null, fichaId = null, proyectoBases = null, versiones = [], comparacion = null;
let tGuardar = null, version = 0, pendientes = {};

export async function renderBases(c) {
  ctx = c;
  if (proyectoBases !== c.proyecto.id) { proyectoBases = c.proyecto.id; fichaId = null; comparacion = null; }
  c.el.innerHTML = '<div class="panel vacio">Cargando las fichas de bases…</div>';
  const mio = ++version;
  try {
    lista = await c.api(`/proyectos/${c.proyecto.id}/bases`);
    if (mio !== version) return;
    if (!lista.fichas.some(f => f.id === fichaId)) fichaId = lista.fichas[0]?.id || null;
    if (fichaId) await abrir(fichaId, mio); else pintar();
  } catch (e) { if (mio === version) c.el.innerHTML = `<div class="panel vacio"><p class="err">${esc(e.message)}</p></div>`; }
}
async function abrir(id, mio = ++version) {
  fichaId = id; comparacion = null;
  const [v, vs] = await Promise.all([ctx.api(`/bases/${id}`), ctx.api(`/bases/${id}/versiones`)]);
  if (mio !== version) return;
  vista = v; versiones = vs; pintar();
}

// ─── Pintado ─────────────────────────────────────────────────────────────────

const opcionesNivel = (sel) => lista.niveles.map(n => `<option value="${n.nivel}" ${n.nivel === sel ? 'selected' : ''}>IOARR ${esc(n.nombre)}</option>`).join('');

function pintar() {
  const L = lista;
  const cab = `
    <div class="avisos"><div class="aviso" role="note"><b>Generador de bases de Obras por Impuestos.</b> Arma el borrador de bases con las plantillas estandarizadas (${esc(L.reglamento)}): la Sección II y los formatos son texto fijo; solo se reemplazan los datos de la ficha. El Word lleva como primera página una hoja de transparencia: <i>«${esc(L.declaracion)}»</i></div>
    ${L.sin_migracion ? '<div class="aviso alerta" role="alert">Falta ejecutar supabase/migrations/028_ioarr_bases_oxi.sql en Supabase: las fichas no se pueden guardar.</div>' : ''}</div>`;
  if (!L.niveles.length) { ctx.el.innerHTML = cab + '<div class="panel vacio"><p>El proyecto no tiene IOARR calculadas todavía: elige locales con mobiliario a reponer.</p></div>'; return; }
  const nueva = `<div class="bx-nueva"><select id="bx-nivel" aria-label="Nivel de la IOARR">${opcionesNivel(lista.niveles[0]?.nivel)}</select><button class="btn btn-primary btn-sm" id="bx-crear" type="button">Nueva ficha</button></div>`;
  if (!L.fichas.length || !vista) {
    ctx.el.innerHTML = cab + `<div class="panel vacio"><h3 class="vacio-tit">Crea la ficha de bases</h3><p>Una ficha por IOARR, es decir, por nivel. Se precarga con lo que la app ya conoce (nombre, CUI, entidad, montos y cantidades).</p>${nueva}</div>`;
    return;
  }
  const f = vista.ficha;
  ctx.el.innerHTML = cab + `
    <div class="panel"><div class="panel-cab">
      <div class="bx-sel"><label for="bx-ficha" class="lbl">Ficha</label>
        <select id="bx-ficha">${L.fichas.map(x => `<option value="${x.id}" ${x.id === f.id ? 'selected' : ''}>${esc(x.nombre)} · ${NOMBRE_NIVEL[x.nivel]}</option>`).join('')}</select></div>
      <div class="bx-acc">
        <input id="bx-nombre" type="text" maxlength="200" value="${esc(f.nombre)}" aria-label="Nombre de la ficha">
        <button class="btn btn-ghost btn-sm" id="bx-precargar" type="button" title="Llena con datos de la app solo los campos vacíos">Tomar datos de la app</button>
        <select id="bx-dup-nivel" aria-label="Nivel de la copia">${opcionesNivel(f.nivel)}</select>
        <button class="btn btn-ghost btn-sm" id="bx-duplicar" type="button">Duplicar</button>
        <button class="btn btn-ghost btn-sm btn-peligro" id="bx-borrar" type="button">Borrar</button>
        ${nueva}
      </div>
      <span class="guardado" id="bx-guardado"></span>
    </div></div>
    <div id="bx-estado"></div>
    <form class="panel doc-form" id="bx-form" autocomplete="off">${L.campos.map(seccion).join('')}${tecnico()}</form>
    <div id="bx-versiones"></div>`;
  actualizar();
}

const errDe = k => (vista.validacion.errores || []).filter(e => e.k === k);
const deApp = k => vista.datos._precarga && k in vista.datos._precarga && vista.datos._precarga[k] === vista.datos[k];
const visibleSi = (c, d) => !c.si || (c.si === 'malo_ugel' ? d.metodo_cantidades === 'malo_ugel' : !!d[c.si]);

function control(c) {
  const d = vista.datos, v = d[c.k];
  if (c.calculado) {
    const x = vista.calculados[c.k];
    return `<output class="bx-calc" data-bx-calc="${c.k}">${esc(c.tipo === 'monto' ? soles(x) : x || '—')}</output>`;
  }
  switch (c.tipo) {
    case 'parrafo': return `<textarea data-bx="${c.k}" rows="2" maxlength="3000">${esc(v)}</textarea>`;
    case 'monto': return `<input data-bx="${c.k}" type="number" min="0" step="0.01" inputmode="decimal" value="${v ?? ''}">`;
    case 'dias': return `<input data-bx="${c.k}" type="number" min="1" max="3650" step="1" inputmode="numeric" value="${v ?? ''}">`;
    case 'pct': return `<input data-bx="${c.k}" type="number" min="0" max="200" step="1" value="${v ?? ''}">`;
    case 'fecha': return `<input data-bx="${c.k}" type="date" value="${esc(v || '')}">`;
    case 'confirmacion': case 'si_no': return `<label class="chk"><input data-bx="${c.k}" type="checkbox" ${v ? 'checked' : ''}> ${esc(c.etiqueta)}</label>`;
    case 'opcion': return `<select data-bx="${c.k}">${Object.entries(c.opciones).map(([k, t]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    default: return `<input data-bx="${c.k}" type="text" maxlength="500" value="${esc(v)}">`;
  }
}
function campo(c) {
  const chk = c.tipo === 'confirmacion' || c.tipo === 'si_no';
  const req = !c.calculado && !c.opcional && !chk && !['opcion', 'pct'].includes(c.tipo);
  const de = lista.obligatorios_de.includes(c.k);
  return `<div class="campo${c.tipo === 'parrafo' || chk ? ' ancho' : ''}" data-bx-campo="${c.k}" ${visibleSi(c, vista.datos) ? '' : 'hidden'}>
    ${chk ? '' : `<label>${esc(c.etiqueta)}${req ? ' <span class="bx-req" title="Obligatorio">*</span>' : ''}${de ? ' <span class="chip-est alerta">Documento equivalente</span>' : ''} <span class="chip-est ok bx-app" ${deApp(c.k) ? '' : 'hidden'}>de la app</span></label>`}
    ${control(c)}
    ${c.ayuda ? `<span class="sub">${esc(c.ayuda)}</span>` : ''}
    <span class="err" data-bx-err="${c.k}" hidden></span>
  </div>`;
}
const seccion = s => s.id === 'tecnico' ? '' : `<fieldset class="bx-sec"><legend>${esc(s.titulo)}</legend><div class="form-grid">${s.campos.map(campo).join('')}</div></fieldset>`;

// Cantidades, normas técnicas y especificaciones (Anexo 3-A)
function tecnico() {
  const s = lista.campos.find(x => x.id === 'tecnico');
  return `<fieldset class="bx-sec"><legend>${esc(s.titulo)}</legend>
    <div class="form-grid">${s.campos.map(campo).join('')}</div>
    <div id="bx-cantidades"></div>
    <h3>Especificaciones técnicas (biblioteca neutral)</h3>
    <p class="sub">Sin marcas, modelos ni fabricantes. Deja el texto vacío para usar el de la biblioteca; si lo editas, pasa por la misma revisión de neutralidad.</p>
    <div class="form-grid">${Object.entries(lista.especificaciones).map(([k, e]) => `<div class="campo ancho"><label>${esc(e.nombre)}</label>
      <textarea data-bx-esp="${k}" rows="3" maxlength="3000" placeholder="${esc(e.texto)}">${esc(vista.datos.especificaciones?.[k] || '')}</textarea></div>`).join('')}</div>
  </fieldset>`;
}

// Lo que cambia al guardar, sin repintar el formulario (no se pierde el foco)
function actualizar() {
  const V = vista.validacion, C = vista.calculados, A = vista.app, d = vista.datos;
  document.getElementById('bx-estado').innerHTML = `
    ${A.aviso ? `<div class="avisos"><div class="aviso alerta" role="alert">Cálculo de la app: ${esc(A.aviso)}</div></div>` : ''}
    <div class="kpis kpis-montos">
      <div class="kpi destacado"><div class="v">${soles(C.MONTO_TOTAL)}</div><div class="l">monto total referencial · ${esc(C.MONTO_TOTAL_LETRAS || '—')}</div></div>
      <div class="kpi"><div class="v">${soles(C.MONTO_SUPERVISION_TOTAL)}</div><div class="l">supervisión (documento equivalente + ejecución)</div></div>
      <div class="kpi"><div class="v">${C.propuesta.min == null ? '—' : soles(C.propuesta.min) + ' – ' + soles(C.propuesta.max)}</div><div class="l">propuesta económica válida (${lista.propuesta.min} %–${lista.propuesta.max} %)</div></div>
      <div class="kpi"><div class="v">${A.total_07c == null ? '—' : soles(A.total_07c)}</div><div class="l">costo de inversión del expediente · IOARR ${esc(A.nivel_nombre || '')}</div></div>
    </div>
    <div class="panel"><div class="panel-cab"><h3>${V.ok ? 'Lista para exportar' : `${V.errores.length} ${V.errores.length === 1 ? 'problema bloquea' : 'problemas bloquean'} la exportación`}</h3>
      <div class="bx-acc">
        <button class="btn btn-ghost btn-sm" id="bx-previa" type="button" title="Word con los datos pendientes resaltados; no guarda versión ni vale para publicar">Vista previa (Word)</button>
        <button class="btn btn-primary btn-sm" id="bx-exportar" type="button" ${V.ok ? '' : 'disabled'}>Exportar bases (Word, versión ${vista.versiones + 1})</button>
      </div></div>
      <div class="avisos pad">
        ${V.errores.slice(0, 12).map(e => `<div class="aviso alerta" role="alert">${esc(e.texto)}</div>`).join('')}
        ${V.errores.length > 12 ? `<div class="aviso alerta">…y ${V.errores.length - 12} más (marcados en la ficha).</div>` : ''}
        ${V.advertencias.map(a => `<div class="aviso" role="note">${esc(a.texto)}</div>`).join('')}
      </div></div>`;
  // Campos: errores, visibilidad, «de la app» y calculados
  for (const el of ctx.el.querySelectorAll('[data-bx-campo]')) {
    const k = el.dataset.bxCampo, c = lista.campos.flatMap(s => s.campos).find(x => x.k === k), es = errDe(k);
    el.hidden = !visibleSi(c, d);
    el.classList.toggle('bx-con-error', es.length > 0);
    const e = el.querySelector('[data-bx-err]'); e.hidden = !es.length; e.textContent = es.map(x => x.texto).join(' ');
    const ap = el.querySelector('.bx-app'); if (ap) ap.hidden = !deApp(k);
  }
  for (const o of ctx.el.querySelectorAll('[data-bx-calc]')) { const k = o.dataset.bxCalc, x = C[k]; o.textContent = k.startsWith('MONTO_') && k !== 'MONTO_TOTAL_LETRAS' ? soles(x) : x || '—'; }
  pintarCantidades(); pintarVersiones();
}

function pintarCantidades() {
  const Q = vista.cantidades, ugel = vista.datos.metodo_cantidades === 'malo_ugel', el = document.getElementById('bx-cantidades');
  if (!el) return;
  const filas = Q.filas.map(f => `<tr><td>${esc(f.nombre)}<span class="sub">${esc(f.unidad)}</span></td>
      <td class="num">${ugel ? `<input data-bx-ugel="${f.k}" type="number" min="0" step="1" value="${vista.datos.cantidades_ugel?.[f.k] ?? ''}" aria-label="Cantidad declarada por la UGEL: ${esc(f.nombre)}"><span class="sub">app: ${f.cantidad_app}</span>` : f.cantidad}</td>
      <td class="num">${soles(f.pu)}</td><td class="num">${soles(f.parcial)}</td></tr>`).join('');
  // Las cantidades de la UGEL tienen foco mientras se escriben: no se repinta esa tabla
  if (ugel && el.contains(document.activeElement)) { el.querySelector('tfoot .num:last-child').textContent = soles(Q.total); return; }
  const R = vista.app.precio_ref;
  const ref = R ? `<div class="aviso" role="note"><b>Catálogo de precios referenciales:</b> ${R.precio != null ? `${soles(R.precio)} por kit sin IGV · ${esc(R.fuente || '')}` : 'sin referencia comparable para este nivel'}.
      ${vista.datos.precio_kit_origen === 'catalogo' ? 'Se usa en el Anexo 3-A.' : 'No se usa: el Anexo 3-A toma la estructura de costos.'} La referencia se elige en «Precios referenciales». En el Word solo figura «catálogo de IOARR publicadas», sin nombres de entidades.</div>` : '';
  el.innerHTML = `${ref}<p class="sub">${esc(Q.texto)}</p>
    <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Bien</th><th class="num">Cantidad</th><th class="num">Precio unitario con IGV</th><th class="num">Parcial</th></tr></thead>
    <tbody>${filas || '<tr><td colspan="4" class="vacio">Sin bienes calculados en esta IOARR.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="3">Total de bienes (Anexo 3-A)</td><td class="num">${soles(Q.total)}</td></tr></tfoot></table></div>`;
}

function pintarVersiones() {
  const el = document.getElementById('bx-versiones');
  if (!el) return;
  const ops = sel => `<option value="actual" ${sel === 'actual' ? 'selected' : ''}>Ficha actual</option>` + versiones.map(v => `<option value="${v.version}" ${String(v.version) === String(sel) ? 'selected' : ''}>Versión ${v.version}</option>`).join('');
  el.innerHTML = `<div class="panel"><div class="panel-cab"><h3>Versiones exportadas</h3><span class="sub">Cada exportación guarda la ficha, la fecha y el usuario</span></div>
    ${versiones.length ? `<div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Versión</th><th>Fecha</th><th>Usuario</th><th class="num">Monto total</th><th></th></tr></thead><tbody>
      ${versiones.map(v => `<tr><td class="mono">v${v.version}</td><td>${esc(fechaHora(v.fecha))}</td><td>${esc(v.usuario || '—')}</td><td class="num">${soles(v.total)}</td>
        <td><button class="btn btn-ghost btn-sm" data-bx-bajar="${v.version}" type="button">Descargar</button>${v.plantillas_cambiaron ? ' <span class="chip-est pend" title="Las plantillas cambiaron desde esta versión">plantillas distintas</span>' : ''}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="pad bx-comparar"><span class="lbl">Comparar</span><select id="bx-cmp-a">${ops(comparacion?.a ?? versiones[0].version)}</select><span>con</span><select id="bx-cmp-b">${ops(comparacion?.b ?? 'actual')}</select>
      <button class="btn btn-ghost btn-sm" id="bx-comparar" type="button">Comparar</button></div>
    ${comparacion?.res ? `<div class="pad">${comparacion.res.cambios.length ? `<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Campo</th><th>${esc(comparacion.res.a)}</th><th>${esc(comparacion.res.b)}</th></tr></thead><tbody>
      ${comparacion.res.cambios.map(x => `<tr><td>${esc(x.campo)}</td><td>${esc(x.antes)}</td><td>${esc(x.despues)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="sub">Sin diferencias.</p>'}</div>` : ''}`
    : '<p class="sub pad">Todavía no se exportó ninguna versión.</p>'}</div>`;
}

// ─── Guardado ────────────────────────────────────────────────────────────────
function estado(t, cls = '') { const s = document.getElementById('bx-guardado'); if (s) { s.className = 'guardado ' + cls; s.textContent = t; } }
function leer(e) {
  if (e.dataset.bxUgel) return ['cantidades_ugel', { ...vista.datos.cantidades_ugel, ...pendientes.cantidades_ugel, [e.dataset.bxUgel]: e.value }];
  if (e.dataset.bxEsp) return ['especificaciones', { ...vista.datos.especificaciones, ...pendientes.especificaciones, [e.dataset.bxEsp]: e.value }];
  return [e.dataset.bx, e.type === 'checkbox' ? e.checked : e.value];
}
async function guardar() {
  const cambios = pendientes; pendientes = {};
  const mio = ++version;
  estado('Guardando…', 'pend');
  try {
    const v = await ctx.api(`/bases/${fichaId}`, { method: 'PATCH', body: { datos: cambios } });
    if (mio !== version) return;
    vista = v; actualizar(); estado('Guardado', 'ok');
  } catch (e) {
    // Lo no guardado se conserva para el próximo intento
    pendientes = { ...cambios, ...pendientes };
    if (mio === version) estado(/^No se guardó/.test(e.message) ? e.message : 'No se pudo guardar: ' + e.message, 'error');
  }
}
const programar = ms => { clearTimeout(tGuardar); estado('Cambios sin guardar', 'pend'); tGuardar = setTimeout(guardar, ms); };
async function guardarYa() { if (Object.keys(pendientes).length) { clearTimeout(tGuardar); await guardar(); } }

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
    const cd = r.headers.get('Content-Disposition') || '', nombre = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'Bases.docx');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: nombre });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return r;
  } finally { if (btn) { btn.disabled = false; btn.textContent = txt; } }
}
async function accion(fn, okMsg) {
  try { await guardarYa(); const r = await fn(); if (okMsg) ctx.toast(okMsg); return r; }
  catch (e) { ctx.toast('No se pudo: ' + e.message); }
}

export function enlazarBases(el) {
  el.addEventListener('input', e => {
    const t = e.target;
    if (!t.closest('#bx-form') || t.type === 'checkbox' || t.tagName === 'SELECT') return;
    const [k, v] = leer(t); pendientes[k] = v; programar(900);
  });
  el.addEventListener('change', async e => {
    const t = e.target;
    if (t.id === 'bx-ficha') { await accion(() => abrir(t.value)); return; }
    if (t.id === 'bx-nombre') { await accion(async () => { vista = await ctx.api(`/bases/${fichaId}`, { method: 'PATCH', body: { nombre: t.value } }); lista.fichas.find(f => f.id === fichaId).nombre = vista.ficha.nombre; pintar(); }, 'Nombre guardado.'); return; }
    if (t.closest('#bx-form') && (t.type === 'checkbox' || t.tagName === 'SELECT')) { const [k, v] = leer(t); pendientes[k] = v; programar(50); }
  });
  el.addEventListener('submit', e => { if (e.target.id === 'bx-form') e.preventDefault(); });
  el.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'bx-crear') {
      const nivel = document.getElementById('bx-nivel').value;
      await accion(async () => { const v = await ctx.api(`/proyectos/${ctx.proyecto.id}/bases`, { method: 'POST', body: { nivel } }); fichaId = v.ficha.id; await renderBases(ctx); }, 'Ficha creada con los datos de la app.');
    }
    if (t.id === 'bx-duplicar') {
      const nivel = document.getElementById('bx-dup-nivel').value;
      await accion(async () => { const v = await ctx.api(`/bases/${fichaId}/duplicar`, { method: 'POST', body: { nivel } }); fichaId = v.ficha.id; await renderBases(ctx);
        if (v.recargados?.length) ctx.toast('Copia creada. Lo propio del nivel (nombre, CUI, montos y plazo de ejecución) se volvió a tomar de la app.'); }, null);
    }
    if (t.id === 'bx-borrar' && confirm('¿Borrar esta ficha y sus versiones exportadas? No se puede deshacer.')) {
      await accion(async () => { await ctx.api(`/bases/${fichaId}`, { method: 'DELETE' }); fichaId = null; vista = null; await renderBases(ctx); }, 'Ficha borrada.');
    }
    if (t.id === 'bx-precargar') {
      await accion(async () => { const v = await ctx.api(`/bases/${fichaId}/precargar`, { method: 'POST' }); vista = v; pintar();
        ctx.toast(v.llenados.length ? `Se llenaron ${v.llenados.length} campos vacíos con datos de la app.` : 'No había campos vacíos que la app pudiera llenar.'); }, null);
    }
    if (t.id === 'bx-previa') await bajar(`/bases/${fichaId}/vista-previa`, {}, t).then(() => ctx.toast('Vista previa descargada (no guarda versión).')).catch(x => ctx.toast('No se pudo: ' + x.message));
    if (t.id === 'bx-exportar') {
      await bajar(`/bases/${fichaId}/exportar`, { method: 'POST' }, t)
        .then(async r => { ctx.toast(`Bases exportadas: versión ${r.headers.get('X-Bases-Version')}.`); await abrir(fichaId); })
        .catch(x => ctx.toast('No se pudo exportar: ' + x.message));
    }
    if (t.dataset.bxBajar) {
      await bajar(`/bases/${fichaId}/versiones/${t.dataset.bxBajar}/docx`, {}, t)
        .then(r => { if (r.headers.get('X-Plantillas-Cambiaron')) ctx.toast('Ojo: las plantillas cambiaron desde esa versión; el Word usa las plantillas actuales con la ficha guardada.'); })
        .catch(x => ctx.toast('No se pudo: ' + x.message));
    }
    if (t.id === 'bx-comparar') {
      const a = document.getElementById('bx-cmp-a').value, b = document.getElementById('bx-cmp-b').value;
      await accion(async () => { comparacion = { a, b, res: await ctx.api(`/bases/${fichaId}/comparar?a=${a}&b=${b}`) }; pintarVersiones(); }, null);
    }
  });
}
