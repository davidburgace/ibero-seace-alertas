// Selector IOARR — Expediente › Documentos (Etapa 2): borrador del Formato 07-C
// y memoria descriptiva en Word. El servidor arma los dos con los datos del
// proyecto (src/selector-ioarr/documentos.js); aquí se cargan los datos que no
// salen de ahí (UF, UEI, plazo, mantenimiento…). Se guardan solos.

const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF = new Intl.NumberFormat('es-PE');
const soles = n => n == null ? '—' : 'S/ ' + NS.format(n);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ctx = null, vista = null, tGuardar = null, version = 0;

export async function renderDocumentos(c) {
  ctx = c;
  c.el.innerHTML = '<div class="panel vacio">Preparando los documentos…</div>';
  const mio = ++version;
  try {
    const v = await c.api(`/proyectos/${c.proyecto.id}/documentos`);
    if (mio !== version) return;
    vista = v; pintar();
  } catch (e) { if (mio === version) c.el.innerHTML = `<div class="panel vacio"><p class="err">${esc(e.message)}</p></div>`; }
}

// ─── Pintado ─────────────────────────────────────────────────────────────────
const campo = (k, etiqueta, { tipo = 'text', ph = '', ancho, max = 300, ayuda, ...o } = {}) => {
  const v = vista.datos[k] ?? '';
  const ctrl = tipo === 'area'
    ? `<textarea data-doc="${k}" maxlength="${o.maxlength || 4000}" rows="${o.rows || 3}" placeholder="${esc(ph)}">${esc(v)}</textarea>`
    : tipo === 'select'
      ? `<select data-doc="${k}">${o.opciones.map(([val, txt]) => `<option value="${val}" ${String(v) === val ? 'selected' : ''}>${txt}</option>`).join('')}</select>`
      : `<input data-doc="${k}" type="${tipo}" value="${esc(v)}" placeholder="${esc(ph)}" ${tipo === 'number' ? `min="${o.min ?? 0}" max="${o.max ?? ''}" step="${o.step ?? 1}" inputmode="decimal"` : `maxlength="${max}"`}>`;
  return `<div class="campo${ancho ? ' ancho' : ''}"><label>${etiqueta}</label>${ctrl}${ayuda ? `<span class="sub">${ayuda}</span>` : ''}</div>`;
};
const SINO = [['', 'Sin indicar'], ['si', 'Sí'], ['no', 'No']];

function pintar() {
  const R = vista.resumen, d = vista.datos;
  const reg = R.registro === 'completo' ? '<span class="chip-est alerta">Registro completo · secciones D, E y F</span>'
    : R.registro === 'abreviado' ? '<span class="chip-est ok">Registro abreviado · sección G</span>' : '<span class="chip-est pend">Falta la UIT</span>';
  const est = { cumple: '<span class="chip-est ok">Cumple</span>', no: '<span class="chip-est alerta">No cumple</span>', pendiente: '<span class="chip-est pend">Pendiente</span>' };
  const tipos = R.tipos.map(t => `<tr>
      <td><b>${esc(t.nombre)}</b><br><span class="sub">${NF.format(t.cantidad)} a reponer</span></td>
      <td><input data-doc-t="antiguedad" data-k="${t.k}" type="number" min="0" max="100" step="1" value="${d.antiguedad[t.k] ?? ''}" placeholder="${t.antiguedad_inventario ? Math.round(t.antiguedad_inventario.promedio) : ''}" aria-label="Antigüedad de ${esc(t.nombre)}">${t.antiguedad_inventario ? `<span class="sub">Inventario: ${NS.format(t.antiguedad_inventario.promedio)} años (${t.antiguedad_inventario.con} de ${t.antiguedad_inventario.de} locales)</span>` : ''}</td>
      <td><input data-doc-t="vida_util_estimada" data-k="${t.k}" type="number" min="1" max="50" step="1" value="${d.vida_util_estimada?.[t.k] ?? ''}" aria-label="Vida útil estimada de ${esc(t.nombre)}"></td>
      <td><select data-doc-t="estado_actual" data-k="${t.k}" aria-label="Estado de ${esc(t.nombre)}"><option value=""></option>${vista.estados.map(x => `<option ${d.estado_actual[t.k] === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td><input data-doc-t="mant_actual" data-k="${t.k}" type="number" min="0" step="0.01" value="${d.mant_actual[t.k] ?? ''}" aria-label="Mantenimiento actual de ${esc(t.nombre)}"></td>
      <td><input data-doc-t="vida_util" data-k="${t.k}" type="number" min="1" max="30" step="1" value="${d.vida_util[t.k] ?? ''}" aria-label="Vida útil del nuevo: ${esc(t.nombre)}"></td>
      <td><input data-doc-t="mant_nuevo" data-k="${t.k}" type="number" min="0" step="0.01" value="${d.mant_nuevo[t.k] ?? ''}" aria-label="Mantenimiento del nuevo: ${esc(t.nombre)}"></td>
    </tr>`).join('');

  ctx.el.innerHTML = `
    ${vista.sin_migracion ? '<div class="avisos"><div class="aviso alerta" role="alert">Falta ejecutar supabase/migrations/015_ioarr_expediente_documentos.sql en Supabase: los datos no se pueden guardar.</div></div>' : ''}
    <div class="kpis kpis-montos">
      <div class="kpi destacado"><div class="v">${soles(R.total)}</div><div class="l">total de inversión</div></div>
      <div class="kpi"><div class="v">${R.masiva ? 'Masiva' : 'Individual'}</div><div class="l">${R.masiva ? `reposición masiva · ${R.ups} UP` : 'IOARR de reposición · 1 UP'}</div></div>
      <div class="kpi"><div class="v">${R.en_uit == null ? '—' : NS.format(R.en_uit) + ' UIT'}</div><div class="l">${reg}</div></div>
      <div class="kpi"><div class="v">${vista.faltan.length}</div><div class="l">${vista.faltan.length === 1 ? 'dato pendiente' : 'datos pendientes'}</div></div>
    </div>
    ${R.sin_rep.length ? `<div class="avisos"><div class="aviso">No se incluyen como UP ${R.sin_rep.length === 1 ? 'el local' : 'los locales'} sin bienes a reponer: ${R.sin_rep.map(esc).join(', ')}.</div></div>` : ''}
    <div class="exportar">
      <div><h3>Documentos en Word</h3><p>Borrador del Formato 07-C para preparar el registro en el Banco de Inversiones, y memoria descriptiva. Lo que falte sale marcado «PENDIENTE» en amarillo.</p></div>
      <div class="acciones-fila"><button class="btn btn-primary" data-doc-bajar="formato-07c" type="button">Formato 07-C (Word)</button><button class="btn btn-ghost" data-doc-bajar="memoria" type="button">Memoria descriptiva (Word)</button></div>
    </div>
    <div class="cols">
      <div class="panel"><div class="panel-cab"><h3>Pendientes</h3><span class="guardado" id="doc-guardado"></span></div>
        ${vista.faltan.length ? `<ul class="pendientes">${vista.faltan.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="pad">No falta nada. Revisa los documentos antes de registrar.</p>'}</div>
      <div class="panel"><div class="panel-cab"><h3>Condiciones de la reposición</h3></div>
        <div class="tabla-wrap borde-0"><table class="tabla"><tbody>${R.condiciones.map(x => `<tr><td>${esc(x.texto)}${x.nota ? `<br><span class="sub">${esc(x.nota)}</span>` : ''}</td><td>${est[x.estado]}</td></tr>`).join('')}</tbody></table></div></div>
    </div>

    <form class="panel doc-form" id="doc-form" autocomplete="off">
      <h3>Nombre e identificación</h3>
      <div class="form-grid">
        ${campo('nombre_inversion', 'Nombre de la inversión', { tipo: 'area', ancho: true, rows: 2, maxlength: 500, ph: R.nombre_sugerido, ayuda: 'Vacío = se usa el propuesto. En el aplicativo, el nombre se arma con la acción, el activo, la UP y la localización.' })}
        ${campo('cui', 'Código único de inversión (CUI)', { ph: R.cui || 'Se asigna al registrar', max: 8 })}
      </div>
      <h3>A. Alineamiento a la brecha</h3>
      <p class="sub">Vacío = se propone por nivel educativo. Verifícalo contra el PMI de la entidad.</p>
      <div class="form-grid">
        ${campo('servicio_brecha', 'Servicio público con brecha', { ancho: true, ph: R.alineamiento.servicio })}
        ${campo('tipologia', 'Tipología de proyecto', { ancho: true, ph: R.alineamiento.tipologia })}
        ${campo('indicador_brecha', 'Indicador de brecha', { ancho: true, max: 500, ph: R.alineamiento.indicadores.map(x => x.nombre).join(' / ') })}
      </div>
      <h3>B. Institucionalidad</h3>
      <div class="form-grid">
        ${campo('opmi', 'OPMI', { ph: 'Ej.: OPMI del Gobierno Regional' })}
        ${campo('uf', 'Unidad Formuladora (UF)')}
        ${campo('uf_responsable', 'Responsable de la UF')}
        ${campo('uei', 'Unidad Ejecutora de Inversiones (UEI)')}
        ${campo('uei_responsable', 'Responsable de la UEI')}
      </div>
      <h3>Estado del mobiliario y mantenimiento</h3>
      <div class="form-grid">
        ${campo('inventario_registrado', '¿Está registrado en el inventario de la entidad?', { tipo: 'select', opciones: SINO })}
        ${campo('codigo_inventario', 'Código del inventario o documento', { ph: 'Ej.: inventario patrimonial UGEL 2025' })}
        ${campo('en_uso', '¿El mobiliario a reponer está en uso?', { tipo: 'select', opciones: SINO, ayuda: R.masiva ? 'En una reposición masiva, el mobiliario debe estar en uso (2.5.c).' : 'Si lleva más de un año sin usarse, no procede como reposición (2.4.C.d).' })}
        ${campo('ue_mantenimiento', 'Unidad ejecutora del mantenimiento', { ph: R.mantenimiento_sugerido || 'Ej.: UGEL …' })}
      </div>
      <h3>Por tipo de bien</h3>
      <p class="sub">Antigüedad, vida útil estimada, estado y mantenimiento del mobiliario a reponer (E.3 y 2.4.C.b), y vida útil y mantenimiento anual del nuevo (F.4 o G.3). La antigüedad vacía se toma del año de adquisición registrado en cada local.</p>
      <div class="tabla-wrap"><table class="tabla tabla-doc"><thead><tr><th>Tipo de bien</th><th>Antigüedad (años)</th><th>Vida útil estimada (años)</th><th>Estado actual</th><th>Mant. anual actual (S/)</th><th>Vida útil del nuevo (años)</th><th>Mant. anual del nuevo (S/)</th></tr></thead><tbody>${tipos || '<tr><td colspan="7" class="vacio">No hay bienes a reponer.</td></tr>'}</tbody></table></div>
      <div class="form-grid">
        ${campo('informe_vida_util', 'Informe técnico de vida útil estimada', { ancho: true, ph: 'Ej.: Informe N° …-2026-UGEL…/APP, control patrimonial', ayuda: R.reg_pct > 0 ? `Obligatorio: se repone el ${Math.round(R.reg_pct * 100)} % del mobiliario en estado regular, que debe haber cumplido su vida útil estimada (2.4.C.b).` : 'Recomendable. Vacío = la antigüedad sale del año de adquisición registrado en cada local, si lo cargaste.' })}
      </div>
      <h3>Plazo de ejecución</h3>
      <div class="form-grid">
        ${campo('fecha_inicio', 'Mes de inicio', { tipo: 'month', ph: 'AAAA-MM' })}
        ${campo('meses', 'Plazo (meses)', { tipo: 'number', min: 1, max: 36 })}
        ${campo('liquidacion', 'Liquidación (S/)', { tipo: 'number', min: 0, step: 0.01, ayuda: 'Opcional. Se suma al total del 07-C.' })}
      </div>
      ${R.inicio ? `<p class="sub">Ejecución del ${R.inicio} al ${R.fin}. El cronograma reparte el costo y las metas por igual entre los meses.</p>` : ''}
      <h3>Textos</h3>
      <div class="form-grid">
        ${campo('sustento', 'Sustento adicional de la reposición', { tipo: 'area', ancho: true, rows: 4, ph: 'Se agrega al texto que arma el sistema. Ej.: el mobiliario tiene 15 años de uso; informe técnico N° … de la UGEL.' })}
        ${campo('antecedentes', 'Antecedentes (memoria descriptiva)', { tipo: 'area', ancho: true, rows: 4, ph: 'Cómo se identificó la necesidad: pedido de los directores, informe de la UGEL, priorización en el PMI, convenio de Obras por Impuestos…' })}
        ${campo('objetivo', 'Objetivo (memoria descriptiva)', { tipo: 'area', ancho: true, rows: 2, maxlength: 1500, ph: 'Vacío = se usa un objetivo propuesto con los datos del proyecto.' })}
      </div>
    </form>`;
}

// ─── Guardado ────────────────────────────────────────────────────────────────
function leer() {
  const datos = { antiguedad: {}, vida_util_estimada: {}, estado_actual: {}, mant_actual: {}, vida_util: {}, mant_nuevo: {} };
  ctx.el.querySelectorAll('[data-doc]').forEach(e => { datos[e.dataset.doc] = e.value; });
  ctx.el.querySelectorAll('[data-doc-t]').forEach(e => { if (e.value !== '') datos[e.dataset.docT][e.dataset.k] = e.value; });
  return datos;
}
function estado(t, cls = '') { const s = document.getElementById('doc-guardado'); if (s) { s.className = 'guardado ' + cls; s.textContent = t; } }

async function guardar() {
  const mio = ++version;
  estado('Guardando…', 'pend');
  try {
    const v = await ctx.api(`/proyectos/${ctx.proyecto.id}/documentos`, { method: 'PATCH', body: { datos: leer() } });
    if (mio !== version) return;
    // Se vuelve a pintar el resumen y los pendientes sin perder el foco del campo
    const activo = document.activeElement, sel = activo?.dataset?.doc ? `[data-doc="${activo.dataset.doc}"]` : activo?.dataset?.docT ? `[data-doc-t="${activo.dataset.docT}"][data-k="${activo.dataset.k}"]` : null;
    const pos = activo && 'selectionStart' in activo ? (() => { try { return activo.selectionStart; } catch { return null; } })() : null;
    vista = v; pintar();
    if (sel) { const e = ctx.el.querySelector(sel); if (e) { e.focus(); if (pos != null) try { e.setSelectionRange(pos, pos); } catch { /* inputs sin selección */ } } }
    estado('Guardado', 'ok');
  } catch (e) { if (mio === version) estado('No se pudo guardar: ' + e.message, 'error'); }
}

async function bajar(btn) {
  btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Generando…';
  try {
    if (tGuardar) { clearTimeout(tGuardar); tGuardar = null; await guardar(); }
    const r = await fetch(`/api/selector-ioarr/proyectos/${ctx.proyecto.id}/documentos/${btn.dataset.docBajar}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error ' + r.status);
    const blob = await r.blob(), cd = r.headers.get('Content-Disposition') || '';
    const nombre = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'documento.docx');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    ctx.toast('Word descargado.');
  } catch (e) { ctx.toast('No se pudo generar: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = txt; }
}

// Eventos delegados sobre el contenedor (se enganchan una vez)
export function enlazarDocumentos(el) {
  const programar = (ms) => { clearTimeout(tGuardar); estado('Cambios sin guardar', 'pend'); tGuardar = setTimeout(() => { tGuardar = null; guardar(); }, ms); };
  el.addEventListener('input', e => { if (e.target.closest('#doc-form') && e.target.tagName !== 'SELECT') programar(900); });
  el.addEventListener('change', e => { if (e.target.closest('#doc-form') && e.target.tagName === 'SELECT') programar(50); });
  el.addEventListener('submit', e => { if (e.target.id === 'doc-form') e.preventDefault(); });
  el.addEventListener('click', e => { const b = e.target.closest('[data-doc-bajar]'); if (b) bajar(b); });
}
