// Selector IOARR — Expediente › Documentos (Etapa 2): borrador del Formato 07-C
// y memoria descriptiva en Word. El servidor arma los dos con los datos del
// proyecto (src/selector-ioarr/documentos.js); aquí se cargan los datos que no
// salen de ahí (UF, UEI, plazo, mantenimiento…). Se guardan solos.

import { bajarZip } from '/selector-ioarr-verificacion.js';

const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF = new Intl.NumberFormat('es-PE');
const soles = n => n == null ? '—' : 'S/ ' + NS.format(n);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ctx = null, vista = null, tGuardar = null, version = 0;
// Borrador: los documentos incluyen los colegios con el checklist de inventario y baja incompleto
let modoBorrador = false;
const qn = () => { const q = new URLSearchParams(ctx?.nivel ? { nivel: ctx.nivel } : {}); if (modoBorrador) q.set('borrador', '1'); return q.size ? '?' + q : ''; };

export async function renderDocumentos(c) {
  ctx = c;
  c.el.innerHTML = '<div class="panel vacio">Preparando los documentos…</div>';
  const mio = ++version;
  try {
    const v = await c.api(`/proyectos/${c.proyecto.id}/documentos${qn()}`);
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
      : `<input data-doc="${k}" type="${tipo}" value="${esc(v)}" placeholder="${esc(ph)}" ${tipo === 'number' ? `min="${o.min ?? 0}" max="${o.max ?? ''}" step="${o.step ?? 1}" inputmode="decimal"` : `maxlength="${max}"`}${o.lista ? ` list="${o.lista}"` : ''}>`;
  return `<div class="campo${ancho ? ' ancho' : ''}"><label>${etiqueta}</label>${ctrl}${ayuda ? `<span class="sub">${ayuda}</span>` : ''}</div>`;
};
const SINO = [['', 'Sin indicar'], ['si', 'Sí'], ['no', 'No']];
// Nombre y CUI de la IOARR del nivel a la vista (datos.por_nivel[nivel])
const campoNivel = (k, etiqueta, { area, ph = '', ayuda } = {}) => {
  const v = vista.datos.por_nivel?.[vista.nivel]?.[k] ?? '';
  const ctrl = area ? `<textarea data-doc-niv="${k}" maxlength="500" rows="2" placeholder="${esc(ph)}">${esc(v)}</textarea>`
    : `<input data-doc-niv="${k}" type="text" maxlength="8" value="${esc(v)}" placeholder="${esc(ph)}">`;
  return `<div class="campo${area ? ' ancho' : ''}"><label>${etiqueta}</label>${ctrl}${ayuda ? `<span class="sub">${ayuda}</span>` : ''}</div>`;
};

function pintar() {
  const R = vista.resumen, d = vista.datos;
  const reg = R.registro === 'completo' ? `<span class="chip-est alerta">${R.masiva ? 'Registro completo (masiva)' : 'Registro completo'} · secciones D, E y F</span>`
    : R.registro === 'abreviado' ? '<span class="chip-est ok">Registro abreviado · sección G</span>' : '<span class="chip-est pend">Falta la UIT</span>';
  const est = { cumple: '<span class="chip-est ok">Cumple</span>', no: '<span class="chip-est alerta">No cumple</span>', pendiente: '<span class="chip-est pend">Pendiente</span>' };
  // Mobiliario nuevo: vida útil y mantenimiento anual por meta (con kit, el kit; el costo puede ser 0)
  const metas = R.metas.map(m => `<tr>
      <td><b>${esc(m.nombre)}</b><br><span class="sub">${NF.format(m.cantidad)} · ${esc(m.unidad)}</span></td>
      <td><input data-doc-t="vida_util" data-k="${m.k}" type="number" min="1" max="30" step="1" value="${d.vida_util[m.k] ?? ''}" aria-label="Vida útil del nuevo: ${esc(m.nombre)}"></td>
      <td><input data-doc-t="mant_nuevo" data-k="${m.k}" type="number" min="0" step="0.01" value="${d.mant_nuevo[m.k] ?? ''}" placeholder="0" aria-label="Mantenimiento del nuevo: ${esc(m.nombre)}"></td>
    </tr>`).join('');
  const tipos = R.tipos.map(t => `<tr>
      <td><b>${esc(t.nombre)}</b><br><span class="sub">${NF.format(t.cantidad)} a reponer</span></td>
      <td><input data-doc-t="antiguedad" data-k="${t.k}" type="number" min="0" max="100" step="1" value="${d.antiguedad[t.k] ?? ''}" placeholder="${t.antiguedad_inventario ? Math.round(t.antiguedad_inventario.promedio) : ''}" aria-label="Antigüedad de ${esc(t.nombre)}">${t.antiguedad_inventario ? `<span class="sub">Inventario: ${NS.format(t.antiguedad_inventario.promedio)} años (${t.antiguedad_inventario.con} de ${t.antiguedad_inventario.de} locales)</span>` : ''}</td>
      <td><input data-doc-t="vida_util_estimada" data-k="${t.k}" type="number" min="1" max="50" step="1" value="${d.vida_util_estimada?.[t.k] ?? ''}" aria-label="Vida útil estimada de ${esc(t.nombre)}"></td>
      <td><select data-doc-t="estado_actual" data-k="${t.k}" aria-label="Estado de ${esc(t.nombre)}"><option value=""></option>${vista.estados.map(x => `<option ${d.estado_actual[t.k] === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td><input data-doc-t="mant_actual" data-k="${t.k}" type="number" min="0" step="0.01" value="${d.mant_actual[t.k] ?? ''}" aria-label="Mantenimiento actual de ${esc(t.nombre)}"></td>
    </tr>`).join('');

  ctx.el.innerHTML = `
    ${vista.sin_migracion ? '<div class="avisos"><div class="aviso alerta" role="alert">Falta ejecutar supabase/migrations/015_ioarr_expediente_documentos.sql en Supabase: los datos no se pueden guardar.</div></div>' : ''}
    <div class="kpis kpis-montos">
      <div class="kpi destacado"><div class="v">${soles(R.total)}</div><div class="l">total de inversión${vista.nivel ? ` · IOARR ${esc(vista.nombre_ioarr)}` : ''}</div></div>
      <div class="kpi"><div class="v">${R.masiva ? 'Masiva' : 'Individual'}</div><div class="l">${R.masiva ? `reposición masiva · ${R.ups} UP` : 'IOARR de reposición · 1 UP'}</div></div>
      <div class="kpi"><div class="v">${R.en_uit == null ? '—' : NS.format(R.en_uit) + ' UIT'}</div><div class="l">${reg}</div></div>
      <div class="kpi"><div class="v">${vista.faltan.length}</div><div class="l">${vista.faltan.length === 1 ? 'dato pendiente' : 'datos pendientes'}</div></div>
    </div>
    <div class="avisos"><div class="aviso">${esc(vista.escenario)}${vista.kit ? ' Mesas y sillas presentadas como kit.' : ''} Se cambia en Costos.</div></div>
    ${R.sin_rep.length ? `<div class="avisos"><div class="aviso">No se incluyen como UP ${R.sin_rep.length === 1 ? 'el local' : 'los locales'} sin bienes a reponer: ${R.sin_rep.map(esc).join(', ')}.</div></div>` : ''}
    ${(vista.bloqueados || []).length ? `<div class="avisos"><div class="aviso alerta" role="alert">${modoBorrador
      ? `Borrador con todos los colegios: ${vista.bloqueados.length === 1 ? '1 colegio tiene' : vista.bloqueados.length + ' colegios tienen'} el checklist de inventario y baja incompleto y no ${vista.bloqueados.length === 1 ? 'entraría' : 'entrarían'} al 07-C final.`
      : `No ${vista.bloqueados.length === 1 ? 'entra' : 'entran'} al 07-C ${vista.bloqueados.length === 1 ? '1 colegio' : vista.bloqueados.length + ' colegios'} con el checklist de inventario y baja incompleto (${vista.bloqueados.slice(0, 15).map(b => esc(b.cod)).join(', ')}${vista.bloqueados.length > 15 ? '…' : ''}). Complétalo en «Por colegio» o marca «Borrador con todos los colegios».`}</div></div>` : ''}
    <div class="exportar">
      <div><h3>Documentos en Word</h3><p>Borrador del Formato 07-C para preparar el registro en el Banco de Inversiones, y memoria descriptiva. Lo que falte sale marcado «PENDIENTE» en amarillo.</p>
        <label class="chk"><input type="checkbox" id="doc-borrador" ${modoBorrador ? 'checked' : ''}> Borrador con todos los colegios (también los que tienen el checklist de inventario y baja incompleto)</label></div>
      <div class="acciones-fila"><button class="btn btn-primary" data-doc-bajar="formato-07c" type="button">Formato 07-C (Word)</button><button class="btn btn-ghost" data-doc-bajar="memoria" type="button">Memoria descriptiva (Word)</button><button class="btn btn-ghost" data-doc-bajar="formato-05b" type="button">Formato 05-B (Word)</button><button class="btn btn-ghost" data-doc-bajar="lineamientos/anexos" type="button">Anexos de Lineamientos (Excel)</button><button class="btn btn-ghost" data-doc-bajar="paquete/up-activos" type="button">Listado de UP y consolidado (Excel)</button><button class="btn btn-ghost" data-doc-zip type="button">Expediente completo (ZIP)</button></div>
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
        ${vista.nivel ? campoNivel('nombre_inversion', `Nombre de la IOARR ${esc(vista.nombre_ioarr)}`, { area: true, ph: R.nombre_sugerido, ayuda: 'Cada IOARR por nivel tiene su nombre. Vacío = se usa el propuesto.' })
          : campo('nombre_inversion', 'Nombre de la inversión', { tipo: 'area', ancho: true, rows: 2, maxlength: 500, ph: R.nombre_sugerido, ayuda: 'Vacío = se usa el propuesto. En el aplicativo, el nombre se arma con la acción, el activo, la UP y la localización.' })}
        ${vista.nivel ? campoNivel('cui', `CUI de la IOARR ${esc(vista.nombre_ioarr)}`, { ph: R.cui || 'Se asigna al registrar', ayuda: 'Si coincide con el CUI vinculado en Radar IOARR, se compara su monto.' })
          : campo('cui', 'Código único de inversión (CUI)', { ph: R.cui || 'Se asigna al registrar', max: 8 })}
      </div>
      <h3>A. Alineamiento a la brecha</h3>
      <p class="sub">Función ${esc(R.funcion)} · división ${esc(R.division)} · grupo ${esc(R.grupos.join('; '))}. Vacío = se propone por nivel educativo. Verifícalo contra el PMI de la entidad. ${esc(R.alineamiento.contribucion)}</p>
      <div class="form-grid">
        ${campo('cadena_funcional', 'Cadena funcional', { ancho: true, ph: R.alineamiento.cadena, ayuda: 'Función / división funcional / grupo funcional del PMI.' })}
        ${(R.niveles_k || []).map(n => `<div class="campo"><label for="doc-gf-${n}">Código del grupo funcional – ${esc(R.nombres_nivel[n])}</label><input id="doc-gf-${n}" data-doc-gf="${n}" type="text" maxlength="5" inputmode="numeric" value="${esc(d.grupo_funcional?.[n] ?? '')}" placeholder="${esc(R.grupos_conocidos[n] || 'Sin código conocido')}"><span class="sub">${R.grupos_conocidos[n] ? 'Vacío = ' + esc(R.grupos_conocidos[n]) + '.' : '<b class="aviso-linea">Escríbelo: no se propone un código que no se conoce.</b>'}</span></div>`).join('')}
        ${campo('servicio_brecha', 'Servicio público con brecha', { ancho: true, ph: R.alineamiento.servicio })}
        ${campo('tipologia', 'Tipología de proyecto', { ancho: true, ph: R.alineamiento.tipologia })}
        ${campo('indicador_brecha', 'Indicador de brecha', { ancho: true, max: 500, ph: R.alineamiento.indicadores.map(x => x.nombre).join(' / '), ayuda: 'Verifícalo contra el PMI.' })}
        ${campo('unidad_indicador', 'Unidad de medida del indicador', { ph: 'Ej.: LOCAL EDUCATIVO', ayuda: 'Verifícala contra el PMI.' })}
        ${campo('contribucion_brecha', 'Contribución a la brecha', { tipo: 'number', min: 0, step: 1, ayuda: 'Vacía por defecto: escríbela cuando la confirmes con el PMI.' })}
      </div>
      <h3>Formato 05-B: idea de la inversión</h3>
      <p class="sub">Idea: <b>${esc(R.b05.idea)}</b> (tipo de IOARR + nombre genérico de las UP + ámbito geográfico). Montos por año para la programación en el PMI${vista.nivel ? ` de la IOARR ${esc(vista.nombre_ioarr)}` : ''}; vacíos = todo en el año t.</p>
      <div class="form-grid">
        ${campo('anio_t', 'Año t', { tipo: 'number', min: 2020, max: 2100, ph: String(R.b05.anioT) })}
        ${R.b05.programacion.map(x => `<div class="campo"><label for="doc-05b-${x.k}">${x.rotulo} (${x.anio}), S/</label><input id="doc-05b-${x.k}" data-doc-05b="${x.k}" type="number" min="0" step="0.01" inputmode="decimal" value="${vista.datos.por_nivel?.[vista.nivel]?.montos_05b?.[x.k] ?? ''}" placeholder="${R.b05.propuesto ? x.monto : ''}"></div>`).join('')}
      </div>
      ${R.b05.cuadra ? '' : `<p class="sub aviso-linea">La programación suma ${soles(R.b05.suma)} y el monto de inversión es ${soles(R.total)}.</p>`}
      <h3>Unidades productoras</h3>
      <div class="form-grid">
        ${campo('up_por', 'Listar las UP por', { tipo: 'select', opciones: [['local', 'Código de local (solo los locales con bienes a reponer)'], ['modular', 'Código modular (todos los servicios, aunque el local no reponga)']], ayuda: `${R.ups} UP en el 07-C · ${R.locales_con_bienes} locales con bienes a reponer.` })}
      </div>
      <h3>Descripción técnica</h3>
      <p class="sub">Sale según el nivel y el grupo de grado de lo que se repone, e incluye: «El material debe respetar la ficha técnica aplicable; la entidad convocante puede exigir madera».</p>
      <div class="form-grid">
        ${campo('ref_tecnica', 'Referencia técnica aplicable', { ancho: true, max: 500, ph: 'Ej.: la ficha técnica o norma que exige la entidad convocante', ayuda: 'Vacía por defecto. El sistema no propone normas.' })}
      </div>
      <h3>Ejecución</h3>
      <datalist id="doc-modalidades">${vista.modalidades.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      <datalist id="doc-fuentes">${vista.fuentes.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      <div class="form-grid">
        ${campo('modalidad', 'Modalidad de ejecución', { lista: 'doc-modalidades', max: 200, ph: 'Ej.: Administración indirecta – Obras por Impuestos' })}
        ${campo('fuente_financiamiento', 'Fuente de financiamiento', { lista: 'doc-fuentes', max: 200 })}
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
        ${campo('ue_mantenimiento', 'Entidad responsable del mantenimiento (nombre)', { ph: R.mantenimiento_sugerido ? 'Ej.: ' + R.mantenimiento_sugerido : 'Ej.: UGEL …' })}
        ${campo('ue_mantenimiento_codigo', 'Código de la entidad (unidad ejecutora)', { max: 50 })}
      </div>
      <h3>Por tipo de bien</h3>
      <p class="sub">Antigüedad, vida útil estimada, estado y mantenimiento del mobiliario a reponer (E.3 y 2.4.C.b), y vida útil y mantenimiento anual del nuevo (F.4 o G.3). La antigüedad vacía se toma del año de adquisición registrado en cada local.</p>
      <div class="tabla-wrap"><table class="tabla tabla-doc"><thead><tr><th>Tipo de bien</th><th>Antigüedad (años)</th><th>Vida útil estimada (años)</th><th>Estado actual</th><th>Mant. anual actual (S/)</th></tr></thead><tbody>${tipos || '<tr><td colspan="5" class="vacio">No hay bienes a reponer.</td></tr>'}</tbody></table></div>
      <p class="sub">Mobiliario nuevo, por meta del 07-C: vida útil y costo anual de mantenimiento (puede ser 0). El cronograma de mantenimiento del 07-C repite el monto anual durante los años indicados.</p>
      <div class="form-grid">${campo('mant_anios', 'Años del cronograma de mantenimiento', { tipo: 'number', min: 1, max: 20, ph: '3' })}</div>
      <div class="tabla-wrap"><table class="tabla tabla-doc"><thead><tr><th>Meta</th><th>Vida útil del nuevo (años)</th><th>Mant. anual del nuevo (S/)</th></tr></thead><tbody>${metas || '<tr><td colspan="3" class="vacio">No hay metas.</td></tr>'}</tbody></table></div>
      <div class="form-grid">
        ${campo('informe_vida_util', 'Documento de sustento de la vida útil', { ancho: true, ph: 'Ej.: Informe N° …-2026-UGEL…/APP, control patrimonial', ayuda: 'Va en el informe técnico de vida útil. Vacío = la antigüedad sale del año de adquisición registrado en cada local, si lo cargaste.' })}
      </div>
      <h3>Informe técnico de vida útil</h3>
      <p class="sub">Fuentes admitidas por la Directiva 005-2016-EF/51.01 (marca las que usa la entidad). 10 años para mobiliario es referencial, no automático: la vida útil estimada se carga por tipo de bien arriba. El Regular solo entra con antigüedad o daño documentado.</p>
      <fieldset class="campo-muebles">${Object.entries(vista.fuentes_vida_util).map(([k, t]) => `<label class="chk"><input type="checkbox" data-doc-fuente="${k}" ${(d.fuentes_vida_util || []).includes(k) ? 'checked' : ''}> ${esc(t)}</label>`).join('')}</fieldset>
      <div class="form-grid">
        ${campo('patrimonial_nombre', 'Responsable de control patrimonial (firma)', { max: 200 })}
        ${campo('patrimonial_cargo', 'Cargo', { max: 200 })}
      </div>
      ${vista.vida_util.faltan.length ? `<ul class="pendientes">${vista.vida_util.faltan.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <div class="acciones-fila"><button class="btn btn-ghost" data-doc-bajar="vida-util" type="button">Informe de vida útil consolidado (Word)</button>
        ${vista.vida_util.colegios.length ? `<select id="doc-vida-cod" aria-label="Colegio">${vista.vida_util.colegios.map(x => `<option value="${esc(x.cod)}">${esc(x.cod)} · ${esc(x.colegio)}</option>`).join('')}</select><button class="btn btn-ghost" data-doc-bajar="vida-util" data-doc-cod type="button">De este colegio (Word)</button>` : ''}</div>
      <h3>Plazo de ejecución</h3>
      <div class="form-grid">
        ${campo('fecha_inicio', 'Mes de inicio', { tipo: 'month', ph: 'AAAA-MM' })}
        ${campo('plazo_unidad', 'Plazo en', { tipo: 'select', opciones: [['meses', 'Meses'], ['dias', 'Días']] })}
        ${d.plazo_unidad === 'dias' ? campo('dias', 'Plazo (días)', { tipo: 'number', min: 1, max: 1095 }) : campo('meses', 'Plazo (meses)', { tipo: 'number', min: 1, max: 36 })}
      </div>
      <p class="sub">La liquidación es parte de la estructura de costos (pestaña Costos).${R.inicio ? ` Ejecución del ${R.inicio} al ${R.fin}. El cronograma es mensual: reparte el costo y las metas por igual entre los meses${d.plazo_unidad === 'dias' ? ' (meses de 30 días)' : ''}.` : ''}</p>
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
  datos.fuentes_vida_util = [...ctx.el.querySelectorAll('[data-doc-fuente]:checked')].map(e => e.dataset.docFuente);
  datos.grupo_funcional = { ...(vista.datos.grupo_funcional || {}) };
  ctx.el.querySelectorAll('[data-doc-gf]').forEach(e => { if (e.value.trim()) datos.grupo_funcional[e.dataset.docGf] = e.value.trim(); else delete datos.grupo_funcional[e.dataset.docGf]; });
  if (vista.nivel) {
    const propio = {}; ctx.el.querySelectorAll('[data-doc-niv]').forEach(e => { propio[e.dataset.docNiv] = e.value; });
    propio.montos_05b = {}; ctx.el.querySelectorAll('[data-doc-05b]').forEach(e => { if (e.value !== '') propio.montos_05b[e.dataset.doc05b] = e.value; });
    datos.por_nivel = { ...(vista.datos.por_nivel || {}), [vista.nivel]: propio };
  }
  return datos;
}
function estado(t, cls = '') { const s = document.getElementById('doc-guardado'); if (s) { s.className = 'guardado ' + cls; s.textContent = t; } }

async function guardar() {
  const mio = ++version;
  estado('Guardando…', 'pend');
  try {
    const v = await ctx.api(`/proyectos/${ctx.proyecto.id}/documentos${qn()}`, { method: 'PATCH', body: { datos: leer() } });
    if (mio !== version) return;
    // Se vuelve a pintar el resumen y los pendientes sin perder el foco del campo
    const activo = document.activeElement, sel = activo?.dataset?.doc ? `[data-doc="${activo.dataset.doc}"]` : activo?.dataset?.docNiv ? `[data-doc-niv="${activo.dataset.docNiv}"]` : activo?.dataset?.docT ? `[data-doc-t="${activo.dataset.docT}"][data-k="${activo.dataset.k}"]` : activo?.dataset?.doc05b ? `[data-doc-05b="${activo.dataset.doc05b}"]` : null;
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
    // «formato-07c», «memoria»… van bajo /documentos; una ruta con «/» va directo bajo el proyecto
    const ruta = btn.dataset.docBajar.includes('/') ? btn.dataset.docBajar : 'documentos/' + btn.dataset.docBajar;
    const q = new URLSearchParams(ctx.nivel ? { nivel: ctx.nivel } : {});
    if ('docCod' in btn.dataset) q.set('cod', document.getElementById('doc-vida-cod')?.value || '');
    if (modoBorrador) q.set('borrador', '1');
    const r = await fetch(`/api/selector-ioarr/proyectos/${ctx.proyecto.id}/${ruta}${q.size ? '?' + q : ''}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error ' + r.status);
    const blob = await r.blob(), cd = r.headers.get('Content-Disposition') || '';
    const nombre = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'documento.docx');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    ctx.toast(nombre.endsWith('.xlsx') ? 'Excel descargado.' : 'Word descargado.');
  } catch (e) { ctx.toast('No se pudo generar: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = txt; }
}

// Eventos delegados sobre el contenedor (se enganchan una vez)
export function enlazarDocumentos(el) {
  const programar = (ms) => { clearTimeout(tGuardar); estado('Cambios sin guardar', 'pend'); tGuardar = setTimeout(() => { tGuardar = null; guardar(); }, ms); };
  el.addEventListener('input', e => { if (e.target.closest('#doc-form') && e.target.tagName !== 'SELECT') programar(900); });
  el.addEventListener('change', e => {
    if (e.target.id === 'doc-borrador') { modoBorrador = e.target.checked; renderDocumentos(ctx); return; }
    if (e.target.closest('#doc-form') && e.target.tagName === 'SELECT') programar(50);
  });
  el.addEventListener('submit', e => { if (e.target.id === 'doc-form') e.preventDefault(); });
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-doc-bajar]'); if (b) bajar(b);
    const z = e.target.closest('[data-doc-zip]');
    const zc = { ...ctx, borrador: modoBorrador };
    if (z && ctx) { if (tGuardar) { clearTimeout(tGuardar); tGuardar = null; guardar().then(() => bajarZip(zc, z)); } else bajarZip(zc, z); }
  });
}
