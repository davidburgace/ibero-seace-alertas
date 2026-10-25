// Selector IOARR — Expediente › Precios referenciales: catálogo de precios de mobiliario
// tomados de IOARR publicadas (compartido entre proveedores), normalizados a precio por
// kit sin IGV. Arriba, la referencia que usa este proyecto, el monto del convenio estimado
// y el riesgo del precio propio. El cálculo lo hace el servidor (src/selector-ioarr/catalogo-ref.js).
// El precio propio es de uso interno: no sale en ningún exportable.

const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const soles = n => n == null ? '—' : 'S/ ' + NS.format(n);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ctx = null, cat = null, proy = null, version = 0, editando = null, informe = null;
const filtro = { material: '', nivel: '', region: '', anio: '' };

export async function renderPreciosRef(c) {
  ctx = c;
  c.el.innerHTML = '<div class="panel vacio">Cargando el catálogo de precios referenciales…</div>';
  const mio = ++version;
  try {
    const [a, b] = await Promise.all([c.api('/precios-ref'), c.api(`/proyectos/${c.proyecto.id}/precios-ref`)]);
    if (mio !== version) return;
    cat = a; proy = b; pintar();
  } catch (e) { if (mio === version) c.el.innerHTML = `<div class="panel vacio"><p class="err">${esc(e.message)}</p></div>`; }
}
const recargar = async () => { const [a, b] = await Promise.all([ctx.api('/precios-ref'), ctx.api(`/proyectos/${ctx.proyecto.id}/precios-ref`)]); cat = a; proy = b; pintar(); };
const O = () => cat.opciones;
const sel = (attr, E, v, vacio) => `<select ${attr}>${vacio != null ? `<option value="">${vacio}</option>` : ''}${Object.entries(E).map(([k, t]) => `<option value="${esc(k)}" ${String(v ?? '') === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;

function pintar() {
  ctx.el.innerHTML = `
    <div class="avisos"><div class="aviso" role="note"><b>Catálogo de precios referenciales.</b> Precios de mobiliario tomados de IOARR publicadas, llevados a <b>precio por kit sin IGV</b> (IGV ${cat.igv} %). Sirve para estimar el monto del convenio; no cambia la estructura de costos del 07-C. El precio propio es de uso interno: no entra a los estadísticos ni a ningún documento.</div></div>
    <div id="pr-proyecto">${pintarProyecto()}</div>
    <div class="panel"><div class="panel-cab"><h3>Estadísticos por material y nivel</h3><span class="sub">Solo fuentes comparables, sin el precio propio</span></div>${pintarEstadisticos()}</div>
    <div class="panel" id="pr-registros">${pintarRegistros()}</div>
    <div class="panel" id="pr-form">${pintarForm()}</div>
    <div class="panel" id="pr-csv">${pintarCsv()}</div>`;
}

// ─── Este proyecto ──────────────────────────────────────────────────────────
// Fuentes publicadas del material elegido (todas, para que se vea por qué una no se puede usar)
const fuentesDe = material => cat.registros.filter(r => !r.propio && (!material || material === 'todos' || r.material === material));
function pintarProyecto() {
  const S = proy.seleccion, fuentes = fuentesDe(S.material), comparables = fuentes.filter(r => r.comparable);
  const cards = proy.ioarrs.map(x => {
    const R = x.referencia, rg = x.riesgo;
    return `<div class="panel pr-ioarr"><div class="panel-cab"><h3>IOARR ${esc(x.nombre)}</h3><span class="sub">${x.kits ? x.kits.toLocaleString('es-PE') + ' kits' : 'sin kits'}</span></div>
      <div class="kpis kpis-montos pad">
        <div class="kpi destacado"><div class="v">${soles(R.precio)}</div><div class="l">precio por kit sin IGV · ${esc(R.modo === 'registro' ? 'fuente elegida' : `mediana de ${R.n}`)}</div></div>
        <div class="kpi"><div class="v">${soles(x.actual.convenio)}</div><div class="l">convenio con la estructura de costos actual</div></div>
        <div class="kpi"><div class="v">${soles(x.estimado?.convenio)}</div><div class="l">convenio estimado con el precio de referencia</div></div>
        <div class="kpi ${rg?.fuera ? 'kpi-alerta' : ''}"><div class="v">${rg ? rg.pct + ' %' : '—'}</div><div class="l">monto con el precio propio / referencial (rango ${proy.rango.min}–${proy.rango.max} %)</div></div>
      </div>
      ${R.fuente ? `<p class="sub pad">Fuente: ${esc(R.fuente)}</p>` : ''}
      <div class="avisos pad">
        ${rg ? `<div class="aviso${rg.fuera ? ' alerta' : ''}" role="${rg.fuera ? 'alert' : 'note'}">${esc(rg.texto)}${rg.fuera === 'encima' ? ` Límite: S/ ${NS.format(rg.limite_max)}.` : ''}</div>` : ''}
        ${x.avisos.map(a => `<div class="aviso">${esc(a)}</div>`).join('')}
      </div></div>`;
  }).join('');
  return `<div class="panel"><div class="panel-cab"><h3>Referencia de este proyecto</h3><span class="guardado" id="pr-guardado"></span></div>
    <div class="form-grid pad">
      <div class="campo"><label>Material del mobiliario</label>${S.material_propuesta
        ? `<output class="bx-calc">${esc(O().materiales[S.material_propuesta])}</output><span class="sub">Es el material de la propuesta, elegido en Costos: se cambia allí.</span>`
        : sel('id="pr-material"', { todos: 'Todos los materiales', ...O().materiales }, S.material)}</div>
      <div class="campo"><label>Precio de referencia</label>${sel('id="pr-modo"', { mediana: 'Mediana del catálogo', registro: 'Una fuente específica' }, S.modo)}</div>
      ${S.modo === 'registro'
        ? `<div class="campo ancho"><label>Fuente${S.material !== 'todos' ? ' de ' + esc(O().materiales[S.material].toLowerCase()) : ''}</label><select id="pr-registro"><option value="">${comparables.length ? 'Elige una fuente' : 'No hay fuentes comparables de este material'}</option>
            ${fuentes.map(r => `<option value="${r.id}" ${r.id === S.registro_id ? 'selected' : ''} ${r.comparable ? '' : 'disabled'}>${esc(etiqueta(r))} · ${r.comparable ? soles(r.precio_kit_sin_igv) : 'no comparable: ' + esc(r.motivo)}</option>`).join('')}</select>
            ${fuentes.some(r => !r.comparable) ? '<span class="sub">Las fuentes en gris no se pueden usar todavía: corrígelas con «Editar» en la tabla de registros (por ejemplo, indica si el monto incluye IGV).</span>' : ''}</div>`
        : ''}
    </div>
    ${S.modo === 'registro' && !S.registro_id ? `<div class="avisos pad"><div class="aviso alerta" role="alert">${comparables.length ? 'Elige la fuente.' : `No hay fuentes comparables${S.material !== 'todos' ? ' de ' + esc(O().materiales[S.material].toLowerCase()) : ''}. Mientras tanto, la estimación usa la mediana de ese material, si la hay.`}</div></div>` : ''}
    </div>${cards || '<div class="panel vacio"><p>El proyecto no tiene IOARR calculadas.</p></div>'}`;
}
const etiqueta = r => [r.entidad || r.region || 'Precio propio', r.anio, O().materiales[r.material], O().tipos[r.tipo_documento], O().niveles[r.nivel], r.cui ? 'CUI ' + r.cui : ''].filter(Boolean).join(' · ');

// ─── Estadísticos ───────────────────────────────────────────────────────────
function pintarEstadisticos() {
  if (!cat.estadisticos.length) return `<p class="sub pad">No hay fuentes comparables todavía. Confirma el IGV y la composición del kit de los registros para poder compararlos.</p>`;
  return `<div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Material</th><th>Nivel</th><th class="num">Fuentes</th><th class="num">Mínimo</th><th class="num">Mediana</th><th class="num">Máximo</th><th>Precio propio (${soles(cat.propio?.precio_kit_sin_igv)})</th></tr></thead><tbody>
    ${cat.estadisticos.map(g => `<tr class="${g.pocas ? 'fila-alerta' : ''}"><td>${esc(O().materiales[g.material])}</td><td>${esc(O().niveles[g.nivel])}</td>
      <td class="num">${g.n}${g.pocas ? ` <span class="chip-est pend" title="Menos de ${cat.min_fuentes} fuentes comparables">pocas</span>` : ''}</td>
      <td class="num">${soles(g.min)}</td><td class="num"><b>${soles(g.mediana)}</b></td><td class="num">${soles(g.max)}</td><td>${g.propio ? esc(g.propio.texto) : '—'}</td></tr>`).join('')}
  </tbody></table></div>${cat.estadisticos.some(g => g.pocas) ? `<p class="sub pad">Con menos de ${cat.min_fuentes} fuentes comparables, la mediana no es una referencia confiable.</p>` : ''}`;
}

// ─── Registros ──────────────────────────────────────────────────────────────
function pintarRegistros() {
  const R = cat.registros, unicos = k => [...new Set(R.map(r => r[k]).filter(Boolean))].sort();
  const vis = R.filter(r => (!filtro.material || r.material === filtro.material) && (!filtro.nivel || r.nivel === filtro.nivel)
    && (!filtro.region || r.region === filtro.region) && (!filtro.anio || String(r.anio) === filtro.anio));
  return `<div class="panel-cab"><h3>Registros (${vis.length} de ${R.length})</h3>
      <div class="bx-acc">
        ${sel('data-pr-f="material"', O().materiales, filtro.material, 'Todo material')}
        ${sel('data-pr-f="nivel"', O().niveles, filtro.nivel, 'Todo nivel')}
        ${sel('data-pr-f="region"', Object.fromEntries(unicos('region').map(x => [x, x])), filtro.region, 'Toda región')}
        ${sel('data-pr-f="anio"', Object.fromEntries(unicos('anio').map(x => [String(x), String(x)])), filtro.anio, 'Todo año')}
      </div></div>
    <div class="tabla-wrap borde-0"><table class="tabla"><thead><tr><th>Fuente</th><th>Producto</th><th class="num">Monto</th><th class="num">Por kit sin IGV</th><th>Confianza</th><th></th></tr></thead><tbody>
    ${vis.map(r => `<tr class="${r.propio ? 'pr-propio' : ''}">
      <td>${r.propio ? '<span class="chip-est alerta">Precio propio · uso interno</span><br>' : ''}<b>${esc(r.entidad || r.region || '—')}</b> · ${r.anio}<span class="sub">${esc(O().tipos[r.tipo_documento])}${r.cui ? ' · CUI ' + esc(r.cui) : ''}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">enlace</a>` : ''}${r.tiene_archivo ? ` · <button class="btn-link" data-pr-pdf="${r.id}" type="button">PDF</button>` : ''}</span></td>
      <td>${esc(O().unidades[r.unidad])}<span class="sub">${esc(O().niveles[r.nivel])} · ${esc(O().materiales[r.material])}${r.composicion.length ? ' · kit = ' + esc(r.composicion.map(x => `${x.cantidad} ${x.unidad}${x.precio != null ? ' (S/ ' + x.precio + ')' : ''}`).join(' + ')) : ''}</span></td>
      <td class="num">${soles(r.monto)}${r.monto_hasta != null ? ' a ' + soles(r.monto_hasta) : ''}<span class="sub">${r.incluye_igv == null ? 'IGV por confirmar' : r.incluye_igv ? 'con IGV' : 'sin IGV'}${r.cotizaciones ? ` · ${r.cotizaciones.n ?? r.cotizaciones.valores.length} cotizaciones, promedio ${soles(r.cotizaciones.promedio)}` : ''}${r.flete_transporte != null ? ` · flete ${soles(r.flete_transporte)}` : ''}</span></td>
      <td class="num">${r.comparable ? `<b>${soles(r.precio_kit_sin_igv)}</b>${r.precio_alternativo_sin_igv != null ? `<span class="sub">alternativa ${soles(r.precio_alternativo_sin_igv)}</span>` : ''}` : `<span class="chip-est pend">No comparable</span><span class="sub">${esc(r.motivo)}</span>`}
        ${r.formula ? `<span class="sub pr-formula">${esc(r.formula)}</span>` : ''}${r.componentes ? `<span class="sub">07-C: total ${soles(r.componentes.total)}</span>` : ''}</td>
      <td>${esc(O().confianzas[r.confianza])}${r.notas ? `<span class="sub">${esc(r.notas)}</span>` : ''}</td>
      <td><div class="pr-acc"><button class="btn btn-ghost btn-sm" data-pr-editar="${r.id}" type="button">Editar</button>
        <label class="btn btn-ghost btn-sm">${r.tiene_archivo ? 'Cambiar PDF' : 'Adjuntar PDF'}<input type="file" accept="application/pdf" data-pr-subir="${r.id}" hidden></label>
        <button class="btn btn-ghost btn-sm btn-peligro" data-pr-borrar="${r.id}" type="button">Borrar</button></div></td></tr>`).join('') || '<tr><td colspan="6" class="vacio">Sin registros con esos filtros.</td></tr>'}
    </tbody></table></div>`;
}

// ─── Formulario ─────────────────────────────────────────────────────────────
function pintarForm() {
  const r = editando ? cat.registros.find(x => x.id === editando) || {} : { confianza: 'media', material: 'por_confirmar', nivel: 'por_confirmar', unidad: 'kit', incluye_igv: false };
  const inp = (k, et, o = {}) => `<div class="campo${o.ancho ? ' ancho' : ''}"><label>${et}${o.req ? ' <span class="bx-req">*</span>' : ''}</label><input name="${k}" type="${o.tipo || 'text'}" ${o.tipo === 'number' ? 'step="0.01" min="0"' : ''} value="${esc(o.v ?? r[k] ?? '')}" placeholder="${esc(o.ph || '')}">${o.ayuda ? `<span class="sub">${esc(o.ayuda)}</span>` : ''}</div>`;
  const s = (k, et, E) => `<div class="campo"><label>${et} <span class="bx-req">*</span></label>${sel(`name="${k}"`, E, r[k])}</div>`;
  return `<div class="panel-cab"><h3>${editando ? 'Editar registro' : 'Nuevo registro'}</h3>${editando ? '<button class="btn btn-ghost btn-sm" id="pr-cancelar" type="button">Cancelar</button>' : ''}</div>
    <form id="pr-f" class="doc-form pad" autocomplete="off">
      <div class="form-grid">
        ${s('tipo_documento', 'Tipo de documento', O().tipos)}${inp('cui', 'CUI', { ph: '2512345' })}${inp('entidad', 'Entidad')}${inp('region', 'Región', { req: true, ayuda: 'No obligatoria en el precio propio' })}
        ${inp('anio', 'Año', { tipo: 'number', req: true })}${inp('url', 'Enlace al documento', { ancho: true, ph: 'https://…' })}
        ${s('nivel', 'Nivel', O().niveles)}${s('unidad', 'Unidad', O().unidades)}${s('material', 'Material', O().materiales)}
        ${inp('monto', 'Monto (S/)', { tipo: 'number', req: true, ayuda: 'En «estimado derivado» se calcula con la fórmula' })}${inp('monto_hasta', 'Hasta (si es un rango)', { tipo: 'number', ayuda: 'Se compara el punto medio' })}
        <div class="campo"><label>¿Incluye IGV? <span class="bx-req">*</span></label>${sel('name="incluye_igv"', { no: 'No (sin IGV)', si: 'Sí (con IGV)', '': 'Por confirmar (no comparable)' }, r.incluye_igv == null ? '' : r.incluye_igv ? 'si' : 'no')}</div>
        ${inp('composicion', 'Composición del kit (si la unidad no es kit)', { v: (r.composicion || []).map(x => `${x.unidad}:${x.cantidad}${x.precio != null ? ':' + x.precio : ''}`).join(';'), ph: 'mesa:1;silla:1:150', ancho: true,
          ayuda: 'unidad:cantidad[:precio], separados por «;». El precio de la unidad del registro es el monto; los demás, en la misma condición de IGV.' })}
        ${inp('cotizaciones_valores', 'Cotizaciones usadas (opcional)', { v: (r.cotizaciones?.valores || []).join(';'), ph: '340;350;360', ayuda: 'Separadas por «;»: se calcula el promedio' })}
        ${inp('cotizaciones_n', 'N.° de cotizaciones', { tipo: 'number', v: r.cotizaciones?.valores?.length ? '' : r.cotizaciones?.n ?? '' })}
        ${inp('flete_transporte', 'Flete o transporte por kit (S/)', { tipo: 'number', ayuda: 'Se muestra aparte: no se suma al precio' })}
        ${s('confianza', 'Confianza', O().confianzas)}
      </div>
      <h3>Componentes del total (07-C o bases)</h3>
      <p class="sub">Opcional. Si los escribes, deben sumar exactamente el total declarado: si no, no se guarda. Obligatorio en «estimado derivado».</p>
      <div class="form-grid">
        ${Object.entries(cat.componentes).map(([k, et]) => inp('c_' + k, et + ' (S/)', { tipo: 'number', v: r.componentes?.[k] ?? '' })).join('')}
        ${inp('c_total', 'Total declarado (S/)', { tipo: 'number', v: r.componentes?.total ?? '' })}
      </div>
      <h3>Fórmula (solo «estimado derivado»)</h3>
      <p class="sub">Precio = ejecución física / cantidad. Con IGV si los montos del 07-C lo incluyen.</p>
      <div class="form-grid">
        ${inp('d_divisor', 'Dividir entre (cantidad)', { tipo: 'number', v: r.derivacion?.divisor ?? '', ph: '1045' })}
        ${inp('d_divisor_alternativo', 'Cantidad alternativa (opcional)', { tipo: 'number', v: r.derivacion?.divisor_alternativo ?? '', ph: '1087' })}
        ${inp('d_detalle', 'Detalle de las cantidades', { v: r.derivacion?.detalle ?? '', ancho: true, ph: '1,045 mesas y 1,045 sillas de alumno (420 + 420 + 205)' })}
        <div class="campo ancho"><label>Notas</label><textarea name="notas" rows="2" maxlength="1000">${esc(r.notas || '')}</textarea></div>
      </div>
      <p class="err" id="pr-err" hidden></p>
      <div class="modal-acts"><button class="btn btn-primary" type="submit">${editando ? 'Guardar cambios' : 'Agregar al catálogo'}</button></div>
    </form>`;
}
function leerForm(f) {
  const v = Object.fromEntries(new FormData(f));
  const comp = String(v.composicion || '').trim();
  const compTotal = Object.fromEntries(Object.keys(cat.componentes).concat('total').map(k => [k, v['c_' + k]]));
  const deriv = { divisor: v.d_divisor === '' ? null : Number(v.d_divisor), divisor_alternativo: v.d_divisor_alternativo === '' ? null : Number(v.d_divisor_alternativo), detalle: v.d_detalle };
  return { ...v, incluye_igv: v.incluye_igv === '' ? null : v.incluye_igv,
    componentes: Object.values(compTotal).some(x => x !== '' && x != null) ? compTotal : null,
    derivacion: deriv.divisor != null || deriv.divisor_alternativo != null ? deriv : null,
    composicion: comp ? comp.split(';').map(x => x.trim()).filter(Boolean).map(x => { const [unidad, cantidad, precio] = x.split(':').map(y => y.trim()); return { unidad, cantidad: Number(cantidad), precio: precio === undefined ? null : Number(precio) }; }) : [],
    cotizaciones: v.cotizaciones_valores || v.cotizaciones_n ? { valores: String(v.cotizaciones_valores || '').split(';').map(x => x.trim()).filter(Boolean).map(Number), n: v.cotizaciones_n ? Number(v.cotizaciones_n) : null } : null };
}

// ─── CSV ────────────────────────────────────────────────────────────────────
function pintarCsv() {
  return `<div class="panel-cab"><h3>Importar CSV</h3><button class="btn btn-ghost btn-sm" id="pr-plantilla" type="button">Descargar plantilla</button></div>
    <div class="pad"><p class="sub">Primero se revisa el archivo y se muestra un reporte por fila. Si alguna fila tiene errores no se importa nada: corrígela y vuelve a subirlo.</p>
      <div class="bx-acc"><input type="file" id="pr-csv-f" accept=".csv,text/csv"><button class="btn btn-ghost btn-sm" id="pr-revisar" type="button">Revisar</button>
        ${informe?.ok ? `<button class="btn btn-primary btn-sm" id="pr-importar" type="button">Importar ${informe.registros.length} ${informe.registros.length === 1 ? 'registro' : 'registros'}</button>` : ''}</div>
      ${informe ? `<div class="avisos" style="margin-top:10px">${informe.ok ? `<div class="aviso">${informe.total} ${informe.total === 1 ? 'fila revisada' : 'filas revisadas'}: todas correctas.${informe.columnas_ignoradas?.length ? ' Columnas ignoradas: ' + esc(informe.columnas_ignoradas.join(', ')) + '.' : ''}</div>`
        : `<div class="aviso alerta" role="alert">${informe.errores.length} ${informe.errores.length === 1 ? 'fila con errores' : 'filas con errores'} de ${informe.total}. No se importó nada.</div>
           <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Fila</th><th>Errores</th></tr></thead><tbody>${informe.errores.map(e => `<tr><td class="mono">${e.fila}</td><td>${e.errores.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table></div>`}</div>` : ''}
    </div>`;
}
async function enviarCsv(confirmar) {
  const f = document.getElementById('pr-csv-f').files[0];
  if (!f) return ctx.toast('Elige el archivo CSV');
  const fd = new FormData(); fd.append('archivo', f);
  const r = await fetch(`/api/selector-ioarr/precios-ref/importar${confirmar ? '?confirmar=1' : ''}`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (r.status >= 500 || (!j.errores && !r.ok)) throw new Error(j.error || 'Error ' + r.status);
  informe = j;
  if (j.importados) { informe = null; ctx.toast(`Se importaron ${j.importados} registros.`); await recargar(); return; }
  document.getElementById('pr-csv').innerHTML = pintarCsv();
}

// ─── Eventos ────────────────────────────────────────────────────────────────
async function guardarSeleccion(cambios) {
  const s = document.getElementById('pr-guardado'); if (s) { s.className = 'guardado pend'; s.textContent = 'Guardando…'; }
  try { proy = await ctx.api(`/proyectos/${ctx.proyecto.id}/precios-ref`, { method: 'PUT', body: { ...proy.seleccion, ...cambios } }); document.getElementById('pr-proyecto').innerHTML = pintarProyecto(); }
  catch (e) { if (s) { s.className = 'guardado error'; s.textContent = 'No se pudo guardar: ' + e.message; } }
}
// Fuente específica del material elegido: la que ya estaba si sigue siendo de ese material; si hay
// una sola comparable, esa; si no, queda por elegir (la estimación sigue con la mediana hasta guardarla)
async function elegirFuente(material) {
  const comp = fuentesDe(material).filter(r => r.comparable), actual = comp.find(r => r.id === proy.seleccion.registro_id);
  const id = actual?.id || (comp.length === 1 ? comp[0].id : null);
  if (id) return guardarSeleccion({ modo: 'registro', registro_id: id, material });
  // Sin fuente elegida, se guarda la mediana de ese material (no queda guardada una fuente de otro material)
  await guardarSeleccion({ modo: 'mediana', registro_id: null, material });
  proy.seleccion = { ...proy.seleccion, modo: 'registro', registro_id: null, material };
  document.getElementById('pr-proyecto').innerHTML = pintarProyecto();
}
export function enlazarPreciosRef(el) {
  el.addEventListener('change', async e => {
    const t = e.target;
    if (t.id === 'pr-modo') {
      if (t.value === 'registro') await elegirFuente(proy.seleccion.material);
      else await guardarSeleccion({ modo: 'mediana', registro_id: null });
    }
    if (t.id === 'pr-registro' && t.value) await guardarSeleccion({ modo: 'registro', registro_id: t.value });
    if (t.id === 'pr-material') {
      if (proy.seleccion.modo === 'registro') await elegirFuente(t.value);
      else await guardarSeleccion({ material: t.value });
    }
    if (t.dataset.prF) { filtro[t.dataset.prF] = t.value; document.getElementById('pr-registros').innerHTML = pintarRegistros(); }
    if (t.dataset.prSubir && t.files[0]) {
      const fd = new FormData(); fd.append('archivo', t.files[0]);
      const r = await fetch(`/api/selector-ioarr/precios-ref/${t.dataset.prSubir}/archivo`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) ctx.toast('No se pudo adjuntar: ' + (j.error || r.status)); else { ctx.toast('PDF adjuntado.'); await recargar(); }
    }
  });
  el.addEventListener('submit', async e => {
    if (e.target.id !== 'pr-f') return;
    e.preventDefault();
    const err = document.getElementById('pr-err');
    try {
      await ctx.api(editando ? `/precios-ref/${editando}` : '/precios-ref', { method: editando ? 'PATCH' : 'POST', body: leerForm(e.target) });
      ctx.toast(editando ? 'Registro actualizado.' : 'Registro agregado.'); editando = null; await recargar();
    } catch (x) { err.hidden = false; err.textContent = x.message; }
  });
  el.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.prEditar) { editando = t.dataset.prEditar; document.getElementById('pr-form').innerHTML = pintarForm(); document.getElementById('pr-form').scrollIntoView({ behavior: 'smooth' }); }
      if (t.id === 'pr-cancelar') { editando = null; document.getElementById('pr-form').innerHTML = pintarForm(); }
      if (t.dataset.prBorrar && confirm('¿Borrar este registro del catálogo (y su PDF)? Lo ven todos los proveedores.')) { await ctx.api(`/precios-ref/${t.dataset.prBorrar}`, { method: 'DELETE' }); await recargar(); }
      if (t.dataset.prPdf) { const { url } = await ctx.api(`/precios-ref/${t.dataset.prPdf}/archivo`); window.open(url, '_blank', 'noopener'); }
      if (t.id === 'pr-plantilla') {
        const r = await fetch('/api/selector-ioarr/precios-ref/plantilla.csv'), a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: 'plantilla_precios_referenciales.csv' });
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }
      if (t.id === 'pr-revisar') await enviarCsv(false);
      if (t.id === 'pr-importar') await enviarCsv(true);
    } catch (x) { ctx.toast('No se pudo: ' + x.message); }
  });
}
