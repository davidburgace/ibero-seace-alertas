// ============================================================================
// src/selector-ioarr/word.js — Word del expediente IOARR (librería docx)
//
//   generar07C(M)      Borrador del Formato 07-C: Registro de IOARR
//   generarMemoria(M)  Memoria descriptiva
//   generarVerificacion(M)  Lista de verificación del expediente
//   generarVidaUtil(M, V, cod?)  Informe técnico de vida útil (consolidado o de un colegio)
//   generar05B(M)      Borrador del Formato 05-B: idea de la inversión con los montos por año
// M es el modelo de armarModelo() (src/selector-ioarr/documentos.js).
// ============================================================================

import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType,
  HeadingLevel, ShadingType, Header, Footer, PageNumber, BorderStyle, PageOrientation
} from 'docx';
import { FUENTES_VIDA_UTIL, AVISO_BORRADOR } from './lineamientos.js';
import { NOTA_FALTANTE } from './costos.js';

const AZUL = '3A63E0', GRIS = 'EEF0F4', AMARILLO = 'FFF3B0', TEXTO = '16181D', TENUE = '5C6270';
const FUENTE = 'Calibri';
const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF = new Intl.NumberFormat('es-PE');
const soles = n => n == null ? '—' : 'S/ ' + NS.format(n);
const ent = n => n == null ? '—' : NF.format(n);
const PEND = 'PENDIENTE';

// ─── Piezas ─────────────────────────────────────────────────────────────────
const run = (t, o = {}) => new TextRun({ text: String(t ?? ''), font: FUENTE, size: o.size ?? 20, bold: o.bold, italics: o.italics, color: o.color ?? TEXTO, highlight: o.highlight });
// Texto con PENDIENTE resaltado en amarillo
const runs = (t, o = {}) => {
  const s = String(t ?? '');
  if (!s) return [run(PEND, { ...o, bold: true, highlight: 'yellow' })];
  return s.split(/(PENDIENTE[^.;]*)/).filter(Boolean).map(x => x.startsWith(PEND) ? run(x, { ...o, bold: true, highlight: 'yellow' }) : run(x, o));
};
const p = (t, o = {}) => new Paragraph({ children: o.plano ? [run(t, o)] : runs(t, o), alignment: o.align, spacing: { after: o.after ?? 120, before: o.before ?? 0 } });
const titulo = (t, nivel = 1) => new Paragraph({
  heading: nivel === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2, spacing: { before: nivel === 1 ? 280 : 200, after: 120 },
  children: [run(t, { bold: true, size: nivel === 1 ? 26 : 22, color: nivel === 1 ? AZUL : TEXTO })]
});
const nota = t => p(t, { italics: true, color: TENUE, size: 17 });
const vinieta = t => new Paragraph({ children: runs(t), bullet: { level: 0 }, spacing: { after: 60 } });

const borde = { style: BorderStyle.SINGLE, size: 4, color: 'C9CED8' };
const BORDES = { top: borde, bottom: borde, left: borde, right: borde };
function celda(valor, o = {}) {
  const v = valor == null || valor === '' ? (o.vacio ?? '') : valor;
  const pend = v === PEND || o.pend;
  return new TableCell({
    borders: BORDES, columnSpan: o.span,
    shading: o.cab ? { type: ShadingType.CLEAR, fill: AZUL, color: 'auto' } : pend ? { type: ShadingType.CLEAR, fill: AMARILLO, color: 'auto' } : o.gris ? { type: ShadingType.CLEAR, fill: GRIS, color: 'auto' } : undefined,
    margins: { top: 50, bottom: 50, left: 80, right: 80 },
    width: o.ancho ? { size: o.ancho, type: WidthType.PERCENTAGE } : undefined,
    children: String(v).split('\n').map(linea => new Paragraph({
      alignment: o.num ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [run(linea, { bold: o.cab || o.bold, color: o.cab ? 'FFFFFF' : TEXTO, size: o.size ?? 18 })]
    }))
  });
}
/** Tabla: cab = títulos; filas = arrays de valores o { v, ...opciones }; num = índices de columnas numéricas */
function tabla(cab, filas, { num = [], anchos, size } = {}) {
  const fila = (vals, esCab) => new TableRow({
    tableHeader: esCab,
    children: vals.map((x, j) => {
      const o = x && typeof x === 'object' && 'v' in x ? x : { v: x };
      return celda(o.v, { ...o, cab: esCab, num: !esCab && num.includes(j), ancho: anchos?.[j], size });
    })
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [...(cab ? [fila(cab, true)] : []), ...filas.map(f => fila(f, false))] });
}
// Tabla de dos columnas: etiqueta | valor
const kv = (filas, anchos = [38, 62]) => tabla(null, filas.map(([k, v, o = {}]) => [{ v: k, gris: true, bold: true }, { v: v == null || v === '' ? PEND : v, ...o }]), { anchos });
const espacio = () => new Paragraph({ children: [], spacing: { after: 80 } });
// De dónde sale la antigüedad: la cargó el usuario o es el promedio del año de adquisición por local
const origenAnt = a => a.antiguedad_origen === 'inventario' && a.antiguedad_inventario
  ? ` (promedio según el año de adquisición en ${a.antiguedad_inventario.con} de ${a.antiguedad_inventario.de} locales${a.antiguedad_inventario.min !== a.antiguedad_inventario.max ? `; de ${a.antiguedad_inventario.min} a ${a.antiguedad_inventario.max} años` : ''}${a.antiguedad_inventario.estimada ? `; estimada por rango en ${a.antiguedad_inventario.estimada} ${a.antiguedad_inventario.estimada === 1 ? 'local' : 'locales'}` : ''})` : '';
// Qué parte de las cantidades está verificada en campo (fichas de verificación)
const notaCantidades = M => M.cantidades?.texto ? [p(M.cantidades.texto, { italics: true, size: 17, color: M.cantidades.verif >= M.cantidades.rep ? TENUE : TEXTO })] : [];
const siNo = v => v === 'si' ? 'Sí' : v === 'no' ? 'No' : PEND;
const trozos = (xs, k) => { const out = []; for (let i = 0; i < xs.length; i += k) out.push([i, xs.slice(i, i + k)]); return out; };

function documento(M, nombre, children, { horizontal } = {}) {
  return new Document({
    creator: 'Radar Ibero — Expediente IOARR', title: nombre, description: M.nombre,
    styles: { default: { document: { run: { font: FUENTE, size: 20 } } } },
    sections: [{
      properties: { page: { size: horizontal ? { orientation: PageOrientation.LANDSCAPE } : undefined, margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(`${nombre} · Borrador de trabajo · ${M.fecha}`, { size: 16, color: TENUE })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Página ', PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES], font: FUENTE, size: 16, color: TENUE })] })] }) },
      children
    }]
  });
}
// Colegios con el checklist de inventario y baja incompleto: en el borrador van con aviso; en el final, fuera
const avisoChecklist = M => !M.bloqueados?.length ? [] : M.borrador
  ? [p(`${AVISO_BORRADOR} Colegios con el checklist incompleto (${M.bloqueados.length}): ${M.bloqueados.slice(0, 30).map(b => b.cod).join(', ')}${M.bloqueados.length > 30 ? '…' : ''}.`, { bold: true, size: 18, highlight: 'yellow', plano: true })]
  : [nota(`No se incluyen ${M.bloqueados.length === 1 ? 'el colegio' : 'los ' + M.bloqueados.length + ' colegios'} con el checklist de inventario y baja incompleto (registro en inventario y contabilidad, trámite de baja y documento de respaldo): ${M.bloqueados.slice(0, 30).map(b => b.cod).join(', ')}${M.bloqueados.length > 30 ? '…' : ''}.`)];
const aviso = M => [
  ...avisoChecklist(M),
  p('BORRADOR DE TRABAJO. No reemplaza el registro en el aplicativo del Banco de Inversiones del MEF: sirve para preparar, revisar y sustentar lo que se va a registrar. Lo marcado como «PENDIENTE» (en amarillo) falta completar.', { italics: true, color: TENUE, size: 17, plano: true }),
  // El escenario de cantidad usado, en una línea
  p(M.escenarioTexto + (M.kit ? ' Mesas y sillas presentadas como kit (mesa + silla del estudiante).' : ''), { bold: true, size: 18, plano: true }),
  ...(M.faltan.length ? [p('Datos pendientes:', { bold: true, size: 18 }), ...M.faltan.map(vinieta)] : [])
];

// ─── Secciones comunes ──────────────────────────────────────────────────────
const notaSinRep = M => M.sinRep.length ? [nota(`No se incluyen como UP ${M.sinRep.length === 1 ? 'el local' : 'los ' + M.sinRep.length + ' locales'} del proyecto sin bienes a reponer: ${M.sinRep.map(x => x.cod + (x.fal ? ` (${ent(x.fal)} faltantes)` : '')).join(', ')}.`)] : []
const notaExcluidos = M => M.excluidos?.length ? [nota(`Se excluyen ${M.excluidos.length === 1 ? 'el local' : 'los ' + M.excluidos.length + ' locales'} con otra inversión vigente o reciente, para evitar duplicidad: ${M.excluidos.map(x => x.cod + (x.codigo ? ` (inversión ${x.codigo})` : '')).join(', ')}.`)] : [];

// Lista de UP: por código de local (los que reponen) o por código modular (todas, con o sin bienes a reponer)
const tablaUPs = M => M.upPor === 'modular'
  ? tabla(['Código modular (UP)', 'Institución educativa (código de local)', 'Ubicación', 'Coordenadas', 'Estudiantes', 'Bienes a reponer en el local'],
    (M.upsRegistro || M.ups).map(u => [u.cod, `${u.nombre}\nlocal ${u.cod_local}`, `${u.cp}, ${u.dist}, ${u.prov}, ${u.dpto}`.toLocaleUpperCase('es-PE') + (u.direccion ? '\n' + u.direccion : ''),
      u.lat != null ? `Lat. ${u.lat}\nLong. ${u.lon}` : '', ent(u.est), u.sinBienes ? 'No' : 'Sí']), { num: [4], anchos: [12, 30, 28, 13, 9, 8], size: 16 })
  : tabla(['Código de local (UP)', 'Institución educativa (códigos modulares)', 'Ubicación', 'Coordenadas', 'Estudiantes'],
    M.ups.map(u => [u.cod, `${u.nombre}\n${u.modulares.join(', ')}`, `${u.cp}, ${u.dist}, ${u.prov}, ${u.dpto}`.toLocaleUpperCase('es-PE') + (u.direccion ? '\n' + u.direccion : ''),
      u.lat != null ? `Lat. ${u.lat}\nLong. ${u.lon}` : '', ent(u.est)]), { num: [4], anchos: [12, 33, 30, 14, 11], size: 16 });
const notaUPs = M => M.upPor === 'modular' ? [nota(`UP listadas por código modular: ${ent((M.upsRegistro || []).length)} servicios educativos, incluidos los de locales sin bienes a reponer.`)] : [];
// Activo de una meta: con kit, «MOBILIARIO DE AULA» en una línea
const activoMeta = m => m.k === 'kit' ? m.activo : `${m.activo}\n(${m.nombre.toLowerCase()})`;

// Metas y costo según la Tabla 3.7: A. costo directo (activos), B. otros costos de inversión, C = A + B
const filaCosto = (txt, v, o = {}) => [{ v: txt, span: 6, gris: !o.bold, bold: o.bold }, { v: NS.format(v), gris: !o.bold, bold: o.bold }, { v: '', gris: !o.bold }, { v: '', gris: !o.bold }];
const tablaMetas = M => tabla(['Tipo de IOARR', 'Acción', 'Activo', 'Tipo de factor productivo', 'Unidad de medida', 'Cantidad', 'Costo de inversión (S/)', 'Inicio', 'Término'], [
  ...M.F.metas.map(m => ['REPOSICIÓN', 'ADQUISICIÓN', activoMeta(m), 'MOBILIARIO', m.unidad, { v: ent(m.cantidad) }, { v: NS.format(m.costo) }, M.F.inicio || PEND, M.F.fin || PEND]),
  filaCosto('A. COSTO DIRECTO (activos, con IGV)', M.F.subtotalActivos, { bold: true }),
  filaCosto('EXPEDIENTE TÉCNICO O DOCUMENTO EQUIVALENTE', M.F.expediente),
  filaCosto('SUPERVISIÓN', M.F.supervision),
  filaCosto('LIQUIDACIÓN', M.F.liquidacion),
  ...(M.F.control || /PENDIENTE/.test(M.F.controlTexto || '') ? [filaCosto(M.F.control ? 'CONTROL CONCURRENTE (LEY 31358)' : 'CONTROL CONCURRENTE (LEY 31358): PENDIENTE indicar si corresponde', M.F.control || 0)] : []),
  filaCosto('B. OTROS COSTOS DE INVERSIÓN', M.F.otros ?? (M.F.expediente + M.F.supervision + M.F.liquidacion), { bold: true }),
  filaCosto('C = A + B. COSTO DE INVERSIÓN (TOTAL)', M.F.total, { bold: true })
], { num: [5, 6], size: 15, anchos: [9, 11, 13, 10, 12, 7, 12, 13, 13] });

function cronogramas(M) {
  const C = M.F.cronograma;
  if (!C) return [p('PENDIENTE: fecha prevista de inicio y plazo de ejecución (meses).')];
  const out = [kv([['Fecha prevista de inicio de ejecución', M.F.inicio], ['Plazo de ejecución', M.F.plazo], ['Tipo de período', 'Mensual'], ['Número de períodos', String(M.F.meses)]]), espacio()];
  for (const [i, per] of trozos(C.periodos, 6)) {
    const col = xs => xs.slice(i, i + per.length).map(v => NS.format(v));
    const ultimo = i + per.length >= C.periodos.length;
    out.push(tabla(['Acción sobre el activo', ...per.map((x, j) => `${i + j + 1}. ${x}`), ...(ultimo ? ['Total (S/)'] : [])], [
      ...C.activos.map(a => [`ADQUISICIÓN DE MOBILIARIO DE AULA (${a.nombre.toLowerCase()})`, ...col(a.valores), ...(ultimo ? [NS.format(a.total)] : [])]),
      ['Documento equivalente', ...col(C.expediente.valores), ...(ultimo ? [NS.format(C.expediente.total)] : [])],
      ['Supervisión', ...col(C.supervision.valores), ...(ultimo ? [NS.format(C.supervision.total)] : [])],
      ['Liquidación', ...col(C.liquidacion.valores), ...(ultimo ? [NS.format(C.liquidacion.total)] : [])],
      ...(C.control ? [['Control concurrente (Ley 31358)', ...col(C.control.valores), ...(ultimo ? [NS.format(C.control.total)] : [])]] : []),
      ...(ultimo ? [[{ v: 'TOTAL', bold: true }, ...per.map(() => ''), { v: NS.format(M.F.total), bold: true }]] : [])
    ], { num: Array.from({ length: per.length + 1 }, (_, j) => j + 1), size: 15 }), espacio());
  }
  return out;
}
function cronogramaMetas(M) {
  const C = M.F.cronograma;
  if (!C) return [p('PENDIENTE: plazo de ejecución.')];
  const out = [];
  for (const [i, per] of trozos(C.periodos, 6)) {
    const ultimo = i + per.length >= C.periodos.length;
    out.push(tabla(['Acción sobre el activo', 'Unidad de medida', ...per.map((x, j) => `${i + j + 1}. ${x}`), ...(ultimo ? ['Total'] : [])],
      C.metas.map(m => [`ADQUISICIÓN DE MOBILIARIO DE AULA (${m.nombre.toLowerCase()})`, m.unidad, ...m.valores.slice(i, i + per.length).map(ent), ...(ultimo ? [ent(m.total)] : [])]),
      { num: Array.from({ length: per.length + 1 }, (_, j) => j + 2), size: 15 }), espacio());
  }
  return out;
}
function mantenimiento(M, conInicio = true) {
  const X = M.F.mantenimiento;
  const out = [kv([
    ...(conInicio ? [['Fecha prevista de inicio de operación y mantenimiento', X.inicio ? `${String(X.inicio.getUTCMonth() + 1).padStart(2, '0')}/${X.inicio.getUTCFullYear()}` : null]] : []),
    ['Tipo de período', 'Año'], ['Número de períodos', X.anios ? String(X.anios) : null]
  ]), espacio()];
  if (!X.anios) return [...out, p('PENDIENTE: vida útil y costo anual de mantenimiento del mobiliario nuevo, por tipo.')];
  const años = Array.from({ length: X.anios }, (_, j) => j + 1);
  for (const [i, per] of trozos(años, 10)) {
    out.push(tabla(['Activo', ...per.map(String)], [
      ...X.filas.map(f => [f.nombre, ...(f.anual == null ? per.map(() => PEND) : f.valores.slice(i, i + per.length).map(v => NS.format(v)))]),
      [{ v: 'Total', bold: true }, ...X.totales.slice(i, i + per.length).map(v => ({ v: NS.format(v), bold: true }))]
    ], { num: per.map((_, j) => j + 1), size: 13, anchos: [16, ...per.map(() => 84 / per.length)] }), espacio());
  }
  return out;
}

// Cómo se arma el costo de las metas (estructura referencial de adquisición de bienes)
const NOTA_ESTRUCTURA = 'Desglose de la Tabla 3.7 de los Lineamientos IOARR: A. costo directo = costo de los activos (bienes + transporte) más IGV; B. otros costos de inversión = documento equivalente y supervisión (porcentaje del costo directo sin IGV), liquidación (monto fijo) y, cuando corresponda, el control concurrente (Ley 31358); C = A + B, costo de inversión. Los porcentajes dependen de la entidad convocante. Ver la estructura de costos en Excel.';

// ─── Formato 07-C ───────────────────────────────────────────────────────────
export async function generar07C(M) {
  const c = [];
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [run('FORMATO N° 07-C: REGISTRO DE IOARR', { bold: true, size: 28 })] }));
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [run('(La información registrada en este formato tiene carácter de Declaración Jurada – D.S. N° 284-2018-EF)', { italics: true, size: 17, color: TENUE })] }));
  c.push(...aviso(M));
  c.push(kv([
    ['Nombre de la inversión', M.nombre],
    ['Código único de la inversión', M.cui || 'Se asigna al registrar'],
    ['¿Es una inversión en el marco de un Decreto Supremo?', 'No'],
    ['Tipo de registro', M.masiva ? 'Inversión masiva de reposición (varias UP, activo homogéneo: mobiliario de aula)' : 'IOARR de reposición'],
    ['Monto de inversión y registro', `${soles(M.F.total)}${M.uit?.valor ? ` = ${NS.format(M.uit.enUit)} UIT (UIT ${M.uit.anio}: ${soles(M.uit.valor)})` : ' · PENDIENTE: falta la UIT para expresarlo en UIT'} → ${M.registroRotulo || M.registro}${M.registro === 'completo' ? ', secciones D, E y F' : M.registro === 'abreviado' ? ', sección G' : ''}`]
  ]));

  c.push(titulo('A. Alineamiento a una brecha prioritaria'));
  c.push(kv([['Cadena funcional', M.A.cadena || `${M.A.funcion} / ${M.A.division} / ${M.A.grupos.join('; ')}`], ['Función', M.A.funcion], ['División funcional', M.A.division], ['Grupo funcional', M.A.grupos.join('; ')], ['Sector responsable', M.A.sector],
    ['Servicios públicos con brecha identificada y priorizada', M.A.servicio], ['Tipología de proyecto asociada', M.A.tipologia], ['Tipo de brecha a la que contribuye', M.A.contribucion]]));
  c.push(espacio());
  c.push(tabla(['Tipo', 'Indicador de brecha', 'Unidad de medida', 'Contribución a la brecha del PMI'], M.A.indicadores.map(x => [x.tipo, x.nombre, x.unidad || PEND, { v: x.valor == null ? '' : ent(x.valor) }]), { num: [3], anchos: [12, 52, 18, 18] }));
  c.push(espacio());
  c.push(kv([['Espacio geográfico de la brecha', M.A.espacio]]));
  c.push(nota(`Indicador de brecha y unidad de medida: verifícalos contra el PMI de la entidad.${M.A.propuesto ? ' Servicio, tipología e indicador propuestos según los niveles educativos de los locales.' : ''} La contribución a la brecha queda vacía hasta confirmarla con el PMI.${M.A.sinCodigo.length ? ` Código del grupo funcional de ${M.A.sinCodigo.join(', ').toLowerCase()}: verifícalo contra el PMI.` : ''}`));

  c.push(titulo('B. Institucionalidad'));
  c.push(kv([['OPMI', M.B.opmi], ['Unidad Formuladora (UF)', M.B.uf], ['Responsable de la UF', M.B.uf_responsable], ['Unidad Ejecutora de Inversiones (UEI)', M.B.uei], ['Responsable de la UEI', M.B.uei_responsable]]));

  c.push(titulo('C. Datos generales'));
  c.push(titulo('C.1 Datos de la inversión', 2));
  if (M.masiva) {
    c.push(kv([['Nombre genérico de la UP', M.niveles.map(x => 'INSTITUCIÓN EDUCATIVA DE NIVEL ' + x).join('; ')], ['Ámbito geográfico', M.ambito], ['Número de UP', ent((M.upsRegistro || M.ups).length)],
      ['Las UP se identifican por', M.upPor === 'modular' ? 'Código modular' : 'Código de local']]));
    c.push(nota('La lista de UP con su código, coordenadas y ubicación va en la sección E.5.'));
  } else {
    const u = M.ups[0];
    c.push(kv([['Código de identificación de la UP (código de local)', u.cod], ['Nombre de la UP', `${u.nombre} (códigos modulares: ${u.modulares.join(', ')})`],
      ['Departamento / Provincia / Distrito', `${u.dpto} / ${u.prov} / ${u.dist}`.toLocaleUpperCase('es-PE')], ['Centro poblado', u.cp], ['Dirección', u.direccion],
      ['Coordenadas', u.lat != null ? `Latitud ${u.lat}, Longitud ${u.lon}` : null]]));
  }
  c.push(kv([['Modalidad de ejecución', M.ejecucion.modalidad], ['Fuente de financiamiento', M.ejecucion.fuente], ['Plazo de ejecución', M.ejecucion.plazo]]));
  c.push(titulo('C.2 Tipo de inversión', 2));
  c.push(tabla(['¿Mayor a 75 UIT?', 'Tipo de IOARR', 'Acción', 'Activo', 'Tipo de factor productivo'], [[M.supera == null ? PEND : M.supera ? 'Sí' : 'No', 'REPOSICIÓN', 'ADQUISICIÓN', 'MOBILIARIO DE AULA', 'MOBILIARIO']]));
  c.push(nota('El activo se elige del catálogo del aplicativo. Según los Lineamientos IOARR (2.5, recuadro 14), las mesas y sillas nuevas se clasifican como «mobiliario de aula».'));

  if (M.registro !== 'abreviado') {
    c.push(titulo('D. Datos de inversión (IOARR mayores a 75 UIT)'));
    if (!M.masiva) {
      c.push(titulo('D.1 Estado situacional del activo sujeto a intervención', 2));
      c.push(kv([['Activo', 'MOBILIARIO DE AULA'], ['¿El activo está registrado en el inventario de la entidad pública?', siNo(M.D.inventario)], ['Código del inventario', M.D.codigo_inventario]]));
    }
    c.push(titulo('D.2 Responsable del mantenimiento de los activos', 2));
    c.push(kv([['Entidad responsable del mantenimiento', M.D.mantenimiento], ['Código de la entidad (unidad ejecutora presupuestal)', M.D.mantenimiento_codigo]]));

    c.push(titulo('E. Descripción específica (IOARR mayores a 75 UIT)'));
    c.push(titulo(M.masiva ? 'E.5 Reposición masiva' : 'E.3 Inversiones de reposición', 2));
    c.push(p(M.masiva ? 'Sustento de la necesidad de la reposición masiva:' : 'Sustento de la necesidad de la reposición:', { bold: true }));
    for (const x of M.E.sustento) c.push(p(x));
    c.push(p('La intervención – activos:', { bold: true }));
    c.push(tabla(['Activo a adquirir', 'Descripción técnica'], M.E.intervencion.map(a => [`MOBILIARIO DE AULA (${a.nombre.toLowerCase()})`, a.descripcion]), { anchos: [30, 70] }));
    if (M.masiva) {
      c.push(espacio());
      c.push(kv([['Nombre genérico de la UP', M.niveles.map(x => 'INSTITUCIÓN EDUCATIVA DE NIVEL ' + x).join('; ')], ['Ámbito geográfico', M.ambito]]));
      c.push(p('Las UP y los activos a reponer:', { bold: true, before: 120 }));
      c.push(tablaUPs(M), ...notaUPs(M), ...notaSinRep(M), ...notaExcluidos(M));
    } else {
      for (const a of M.E.activos) {
        c.push(p(a.nombre, { bold: true, before: 120 }));
        c.push(kv([['Antigüedad del mobiliario a reponer (años)', a.antiguedad == null ? null : String(a.antiguedad) + origenAnt(a)], ['Estado actual del mobiliario a reponer', a.estado],
          ['Costo anual de mantenimiento del mobiliario a reponer (S/)', a.mant_actual == null ? null : NS.format(a.mant_actual)],
          ['Expectativa de vida útil del mobiliario nuevo (años)', a.vida_util == null ? null : String(a.vida_util)],
          ['Costo anual de mantenimiento del mobiliario nuevo (S/)', a.mant_nuevo == null ? null : NS.format(a.mant_nuevo)]], [60, 40]));
      }
    }
    c.push(titulo('F. Costos y cronogramas (IOARR mayores a 75 UIT)'));
    c.push(titulo('F.1 Metas físicas, costo y plazo', 2));
    c.push(tablaMetas(M), ...notaCantidades(M));
    c.push(nota(NOTA_ESTRUCTURA));
    c.push(titulo('F.2 Cronograma de inversión (S/)', 2));
    c.push(...cronogramas(M));
    c.push(nota('Distribución mensual uniforme, propuesta. Ajústala al plan de adquisición y entrega. Adjuntar la estructura referencial de costos.'));
    c.push(titulo('F.3 Cronograma de metas físicas', 2));
    c.push(...cronogramaMetas(M));
    c.push(titulo('F.4 Costo de mantenimiento (S/)', 2));
    c.push(...mantenimiento(M));
  }
  if (M.registro !== 'completo') {
    c.push(titulo('G. Registro abreviado (IOARR menores o iguales a 75 UIT)'));
    if (M.registro === 'pendiente') c.push(nota('Falta la UIT: se muestran las dos versiones del registro. Al cargarla, queda solo la que corresponde.'));
    c.push(titulo('G.1 Nombre de la inversión', 2));
    c.push(p(M.nombre));
    c.push(titulo('G.2 Registro abreviado', 2));
    c.push(tablaMetas(M), ...notaCantidades(M));
    c.push(nota(NOTA_ESTRUCTURA));
    c.push(p('Cronograma de ejecución (S/):', { bold: true, before: 120 }));
    c.push(...cronogramas(M));
    if (M.masiva) { c.push(p('Las UP y los activos a reponer:', { bold: true, before: 120 })); c.push(tablaUPs(M), ...notaUPs(M), ...notaSinRep(M), ...notaExcluidos(M)); }
    c.push(titulo('G.3 Costo de mantenimiento (S/)', 2));
    c.push(...mantenimiento(M, false));
  }
  return Packer.toBuffer(documento(M, 'Formato 07-C', c));
}

// ─── Memoria descriptiva ────────────────────────────────────────────────────
export async function generarMemoria(M) {
  const c = [], T = M.totales;
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [run('MEMORIA DESCRIPTIVA', { bold: true, size: 30 })] }));
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [run(M.nombre, { bold: true, size: 22 })] }));
  c.push(...aviso(M));

  c.push(titulo('1. Generalidades'));
  c.push(kv([['Nombre de la inversión', M.nombre], ['Código único de inversión', M.cui || 'Se asigna al registrar'],
    ['Tipo de inversión', M.masiva ? 'IOARR de reposición, inversión masiva para varias UP' : 'IOARR de reposición'],
    ['Unidad Formuladora', M.B.uf], ['Unidad Ejecutora de Inversiones', M.B.uei], ['Ámbito', `${M.ambito.toLowerCase()} · ${M.A.espacio}`],
    ['Locales educativos (UP)', ent(M.ups.length)], ['Estudiantes beneficiarios', ent(M.est)], ['Monto de inversión', soles(M.F.total)],
    ['Escenario de cantidad', M.escenarioTexto.replace(/^Escenario de cantidad: /, '')],
    ['Modalidad de ejecución', M.ejecucion.modalidad], ['Fuente de financiamiento', M.ejecucion.fuente],
    ['Plazo de ejecución', M.F.plazo ? `${M.F.plazo}${M.F.inicio ? ` (${M.F.inicio} al ${M.F.fin})` : ''}` : null]]));

  c.push(titulo('2. Antecedentes'));
  if (M.memoria.antecedentes) for (const x of M.memoria.antecedentes.split(/\n+/)) c.push(p(x));
  else c.push(p('PENDIENTE: describe cómo se identificó la necesidad (pedido de los directores, informe de la UGEL, priorización en el PMI, convenio de Obras por Impuestos, etc.).'));

  c.push(titulo('3. Objetivo'));
  c.push(p(M.memoria.objetivo));

  c.push(titulo('4. Ubicación y unidades productoras'));
  c.push(p(`La intervención comprende ${M.ups.length === 1 ? 'un local educativo' : M.ups.length + ' locales educativos'} de nivel ${M.niveles.join(', ').toLowerCase()} de la región ${M.region}${M.ugels.length ? ', bajo ' + (M.ugels.length === 1 ? 'la ' + M.ugels[0] : 'las ' + M.ugels.join(', ')) : ''}.`));
  c.push(tablaUPs(M), ...notaUPs(M), ...notaSinRep(M), ...notaExcluidos(M));

  c.push(titulo('5. Diagnóstico de la situación actual'));
  c.push(p(`${M.ups.length === 1 ? 'El local atiende' : 'Los locales atienden'} a ${ent(M.est)} estudiantes en ${ent(M.aulas)} aulas. Estado del mobiliario por tipo de bien${M.ups.some(u => u.verificado) ? ' (con el inventario verificado en campo donde lo hay)' : ''}. ${{ malo: 'Se repone solo el estado malo', malo_regular: `Se repone el estado malo y ${M.regular?.pct || '100 %'} del regular (${M.regular?.origen || 'valor manual'}; estimación hasta completar la verificación en campo)`, capacidad: 'Las cantidades a adquirir se calculan por capacidad, no por el estado' }[M.escenario] || 'Se repone solo el estado malo'}; el faltante es brecha de dotación y no se repone:`));
  c.push(tabla(['Tipo de bien', 'Unidad', 'Existente', 'Bueno', 'Regular', 'Malo', 'A reponer', 'Requerido', 'Faltante (brecha de dotación, no reposición)'],
    M.partidas.filter(x => !x.excluido).map(x => [x.n, x.u, ...[x.ex, x.b, x.r, x.m, x.rep, x.req, x.fal].map(v => ({ v: ent(v) }))]), { num: [2, 3, 4, 5, 6, 7, 8], size: 16 }));
  const verif = M.ups.filter(u => u.verificado);
  c.push(p(verif.length
    ? `En ${verif.length} ${verif.length === 1 ? 'local' : 'locales'} el inventario del Censo Educativo 2025 se reemplazó por el verificado en campo: ${verif.map(u => `${u.cod} (visita del ${u.verificado.fecha_visita.split('-').reverse().join('/')})`).join('; ')}. En los demás se usa el Censo Educativo 2025, declarado por cada institución.`
    : 'Las cantidades salen del Censo Educativo 2025 (Minedu, local escolar, pregunta 6.1), declarado por cada institución educativa. Deben confirmarse con el inventario patrimonial y una verificación en campo.', { before: 120 }));
  c.push(...notaCantidades(M));

  c.push(titulo('6. Sustento de la reposición'));
  for (const x of M.E.sustento) c.push(p(x));
  c.push(p('Condiciones de los Lineamientos IOARR (MEF, 9.ª versión, junio 2025):', { bold: true, before: 120 }));
  c.push(tabla(['Condición', 'Estado', 'Observación'], M.E.condiciones.map(x => [x.texto, { v: x.estado === 'cumple' ? 'Cumple' : x.estado === 'no' ? 'No cumple' : PEND, pend: x.estado !== 'cumple' }, x.nota]), { anchos: [46, 14, 40] }));
  c.push(p('Antigüedad y vida útil del mobiliario a reponer:', { bold: true, before: 120 }));
  c.push(tabla(['Tipo de bien', 'Antigüedad (años)', 'Vida útil estimada (años)', 'Estado actual', 'Vida útil del nuevo (años)'], M.E.activos.map(a => [a.nombre,
    { v: a.antiguedad == null ? PEND : String(a.antiguedad) + (a.antiguedad_origen === 'inventario' ? '*' : '') },
    { v: a.vida_estimada == null ? '—' : String(a.vida_estimada) }, a.estado || (M.supera && !M.masiva ? PEND : '—'),
    { v: a.vida_util == null ? PEND : String(a.vida_util) }]), { num: [1, 2, 4] }));
  if (M.E.activos.some(a => a.antiguedad_origen === 'inventario')) c.push(nota(`* Promedio ponderado por la cantidad a reponer, según el año de adquisición registrado en cada local (año de referencia ${M.anioRef}).`));
  if (M.informe_vida_util) c.push(nota('Vida útil estimada según: ' + M.informe_vida_util));
  const conAnios = M.ups.filter(u => Object.keys(u.verificado?.adquisicion || {}).length);
  if (conAnios.length) {
    const ks = M.E.activos.map(a => a.k);
    c.push(p('Año de adquisición por local:', { bold: true, before: 120 }));
    c.push(tabla(['Código de local', 'Institución educativa', ...M.E.activos.map(a => a.nombre)], conAnios.map(u => [u.cod, u.nombre,
      ...ks.map(k => u.verificado.adquisicion[k] ? `${u.verificado.adquisicion[k]} (${M.anioRef - u.verificado.adquisicion[k]} años)` : '—')]), { size: 15 }));
  }

  c.push(titulo('7. Descripción de la intervención'));
  c.push(p(`Adquisición, transporte y entrega de ${M.F.metas.map(m => `${ent(m.cantidad)} ${m.plural}`).join(', ')}${M.escenario === 'capacidad' ? '' : ', para reemplazar el mobiliario ' + (M.escenario === 'malo_regular' ? `en estado malo y ${M.regular?.pct || '100 %'} del regular` : 'en mal estado')}. El mobiliario reemplazado se dará de baja conforme a los procedimientos de control patrimonial de la entidad.`));
  c.push(titulo('7.1 Especificaciones técnicas', 2));
  c.push(tabla(['Bien', 'Descripción técnica'], M.E.intervencion.map(a => [a.nombre, a.descripcion]), { anchos: [28, 72] }));
  c.push(titulo('7.2 Metas por local', 2));
  const cantLocal = (u, m) => m.k === 'kit' ? u.kits : u.rep[M.partidas.findIndex(x => x.k === m.k)];
  c.push(tabla(['Código de local', 'Institución educativa', ...M.F.metas.map(m => m.nombre), 'Total (S/)'],
    M.ups.map(u => [u.cod, u.nombre, ...M.F.metas.map(m => ({ v: ent(cantLocal(u, m)) })), { v: NS.format(u.total) }]),
    { num: Array.from({ length: M.F.metas.length + 1 }, (_, j) => j + 2), size: 15 }));

  c.push(titulo('8. Presupuesto'));
  const tp = M.estructura?.params?.transporte_pieza ?? 0;
  c.push(tabla(['Partida', 'Unidad', 'Metrado', 'Precio unitario sin IGV (S/)', 'Parcial (S/)'],
    // Kits por talla (con kit) o mesa y silla por talla, y los demás; después el transporte por pieza
    [...(M.lineas || M.partidas).filter(x => x.rep > 0).map(x => [x.n, x.u, { v: ent(x.rep) }, { v: x.pu == null ? PEND : NS.format(x.pu) }, { v: NS.format(x.parcial) }]),
      ['Transporte', 'piezas', { v: ent(T.piezas) }, { v: NS.format(tp) }, { v: NS.format(T.transporte) }],
      [{ v: 'Costo directo', span: 4, bold: true }, { v: NS.format(T.cd), bold: true }]], { num: [2, 3, 4] }));
  c.push(espacio());
  c.push(tabla(['Estructura de costos', 'Monto (S/)'], (M.estructura?.filas || []).map(f => [{ v: (f.fuerte || f.total ? '' : '   ') + f.nombre, bold: f.fuerte || f.total }, { v: NS.format(f.monto), bold: f.fuerte || f.total }]), { num: [1], anchos: [70, 30] }));
  c.push(nota(NOTA_ESTRUCTURA));
  if (M.faltante.cantidad > 0) c.push(nota(`No se incluyen ${ent(M.faltante.cantidad)} bienes faltantes (matrícula − mobiliario existente), valorizados solo como referencia en ${soles(M.faltante.valor)}: ${NOTA_FALTANTE} No entran al monto (Lineamientos IOARR 2.4.C.c).`));
  if (M.capacidad?.some(f => f.inconsistente)) c.push(nota(`${M.capacidad.filter(f => f.inconsistente).length} colegios tienen datos inconsistentes del censo (más mesas o sillas que matrícula): lo que se repone se limitó a la matrícula y debe verificarse en campo.`));

  c.push(titulo('9. Cronograma de ejecución'));
  c.push(...cronogramas(M));

  c.push(titulo('10. Operación y mantenimiento'));
  c.push(p(`El mantenimiento del mobiliario nuevo estará a cargo de ${M.D.mantenimiento ? M.D.mantenimiento + (M.D.mantenimiento_codigo ? ` (código ${M.D.mantenimiento_codigo})` : ' (PENDIENTE: código)') : 'PENDIENTE: entidad responsable del mantenimiento (nombre y código)'}.`));
  c.push(...mantenimiento(M));

  c.push(titulo('11. Anexos'));
  c.push(vinieta('Estructura de costos en Excel (Selector IOARR → Expediente → Exportar costos a Excel).'));
  c.push(vinieta('Selección de locales y metrado por aula en Excel (Selector IOARR → Exportar a Excel).'));
  c.push(vinieta('Anexo 1: estructura preliminar de costos, activos a reponer (al final de esta memoria y en el Excel de anexos de los Lineamientos).'));
  const archivos = M.ups.flatMap(u => u.archivos.map(a => ({ ...a, cod: u.cod })));
  if (archivos.length) {
    c.push(p('Sustento de la verificación en campo:', { bold: true, before: 120 }));
    c.push(tabla(['Código de local', 'Tipo', 'Archivo', 'Descripción'], archivos.map(a => [a.cod, { acta: 'Acta de verificación', foto: 'Foto', inventario_patrimonial: 'Inventario patrimonial', baja: 'Baja', otro: 'Otro' }[a.tipo] || a.tipo, a.nombre_archivo, a.descripcion || '']), { anchos: [14, 20, 36, 30], size: 15 }));
  } else c.push(vinieta('PENDIENTE: acta de verificación, fotos, inventario patrimonial y sustento de baja de cada local.'));
  c.push(nota('Fuentes: Padrón de ESCALE y Censo Educativo 2025 (Minedu), datos declarados por cada colegio; Lineamientos IOARR del MEF (9.ª versión, junio 2025). Los precios, los porcentajes y la UIT se revisan en la estructura de costos; los porcentajes dependen de la entidad convocante.'));
  c.push(...anexoFichaActivos(M));
  return Packer.toBuffer(documento(M, 'Memoria descriptiva', c));
}

// ─── Anexo: estructura preliminar de costos (activos a reponer) ────────────
// Con muchos lotes, el detalle va solo en el Excel y aquí un resumen por local y bien
const MAX_LOTES_WORD = 800;
function anexoFichaActivos(M) {
  const F = M.fichaActivos;
  if (!F) return [];
  const out = [titulo('Anexo 1. Estructura preliminar de costos: activos a reponer')];
  out.push(p(`Lotes de activos a reponer por ambiente (aula), bien y estado verificado: ${ent(F.totales.filas)} lotes, ${ent(F.totales.cantidad)} bienes (igual al metrado de la estructura de costos). ${F.totales.pendientes ? `${ent(F.totales.pendientes)} lotes están «PENDIENTE de verificación en campo»: no tienen el estado contado en campo, el código patrimonial o la antigüedad, y no se completan con valores supuestos.` : 'Todos los lotes tienen el dato de campo.'}`));
  if (F.sinMant.length) out.push(p(`PENDIENTE: costo anual de mantenimiento de ${F.sinMant.join(', ')}.`));
  if (F.filas.length <= MAX_LOTES_WORD) {
    out.push(tabla(['Local', 'Ambiente', 'Bien existente → nuevo', 'Cód. patrimonial', 'Antig. (años)', 'Estado', 'Cant.', 'Mant. anual exist. / nuevo (S/)', 'Situación'],
      F.filas.map(f => [f.cod, `${f.ambiente}${f.grado ? '\n' + f.grado + (f.seccion ? ' ' + f.seccion : '') : ''}`, `${f.denom_existente}\n→ ${f.denom_nueva}`,
        { v: f.patrimonial || (f.ajuste ? '' : PEND) }, { v: f.antiguedad == null ? (f.ajuste ? '' : PEND) : String(f.antiguedad) }, f.estado ? `${f.estado}\n${f.origen}` : f.origen,
        { v: ent(f.cantidad) }, `${f.mant_existente == null ? '—' : NS.format(f.mant_existente)} / ${f.mant_nuevo == null ? '—' : NS.format(f.mant_nuevo)}`,
        { v: f.ajuste ? 'Ajuste' : f.pendiente ? 'PENDIENTE de verificación en campo' : 'Completa', pend: f.pendiente }]),
      { num: [6], size: 13, anchos: [8, 15, 22, 11, 7, 12, 6, 10, 9] }));
  } else {
    const g = new Map();
    for (const f of F.filas) { const k = f.cod + '|' + f.bien; const o = g.get(k) || { cod: f.cod, colegio: f.colegio, bien: f.denom_existente.split(' (')[0], q: 0, lotes: 0, pend: 0 }; o.q += f.cantidad; o.lotes += f.ajuste ? 0 : 1; o.pend += f.pendiente ? 1 : 0; g.set(k, o); }
    out.push(nota(`Son ${ent(F.filas.length)} lotes: aquí va el resumen por local y bien; el detalle por aula, con el código patrimonial y la antigüedad, va en el Excel de anexos de los Lineamientos (hoja «Ficha de activos»).`));
    out.push(tabla(['Local', 'Institución educativa', 'Bien', 'Cantidad a reponer', 'Lotes', 'Pendientes de verificación'],
      [...g.values()].map(o => [o.cod, o.colegio, o.bien, { v: ent(o.q) }, { v: ent(o.lotes) }, { v: ent(o.pend), pend: o.pend > 0 }]), { num: [3, 4, 5], size: 15 }));
  }
  out.push(nota('El costo anual de mantenimiento de cada tipo de bien (Documentos) se prorratea entre sus lotes según la cantidad. Denominación nueva: el mobiliario de aula según el grupo de grado.'));
  return out;
}

// ─── Lista de verificación ──────────────────────────────────────────────────
export async function generarVerificacion(M) {
  const V = M.verificacion, c = [];
  const ESTADO = { ok: 'Listo', pendiente: PEND, no: 'No cumple' };
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [run('LISTA DE VERIFICACIÓN DEL EXPEDIENTE IOARR', { bold: true, size: 28 })] }));
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [run(M.nombre, { bold: true, size: 20 })] }));
  c.push(kv([['Proyecto', M.proyecto], ['Tipo', M.masiva ? `Inversión masiva de reposición · ${(M.upsRegistro || M.ups).length} UP` : 'IOARR de reposición · 1 UP'], ['Escenario de cantidad', M.escenarioTexto.replace(/^Escenario de cantidad: /, '')],
    ['Registro', M.registro === 'pendiente' ? null : M.registroRotulo || (M.registro === 'completo' ? 'Completo (más de 75 UIT)' : 'Abreviado (hasta 75 UIT)')], ['Monto', `${soles(M.F.total)}${M.uit?.enUit != null ? ` = ${NS.format(M.uit.enUit)} UIT` : ''}`],
    ['Avance', `${V.hechos} de ${V.total} puntos listos${V.bloqueos ? ` · ${V.bloqueos} no cumple${V.bloqueos === 1 ? '' : 'n'}` : ''}`], ['Fecha', M.fecha]]));
  for (const sec of V.secciones) {
    c.push(titulo(sec.titulo));
    c.push(tabla(['Punto', 'Estado', 'Observación'], sec.items.map(x => [x.texto, { v: ESTADO[x.estado], pend: x.estado !== 'ok', bold: x.estado === 'no' }, x.nota]), { anchos: [54, 14, 32], size: 17 }));
    if (sec.titulo.startsWith('Formato 07-C') && M.faltan.length) { c.push(p('Pendientes:', { bold: true, before: 120 })); M.faltan.forEach(x => c.push(vinieta(x))); }
  }
  c.push(titulo('Sustento por local'));
  const sn = v => v ? 'Sí' : PEND;
  c.push(tabla(['Código de local', 'Institución educativa', 'Visita', 'Acta', 'Fotos', 'Inventario patrimonial', 'Baja', 'Año de adquisición'],
    V.locales.map(u => [u.cod, u.nombre, u.visita ? u.visita.split('-').reverse().join('/') : PEND, sn(u.acta), u.fotos ? String(u.fotos) : PEND, sn(u.inventario), sn(u.baja), sn(u.anio)]), { size: 15, anchos: [11, 31, 12, 8, 8, 12, 8, 10] }));
  c.push(nota('Los puntos de «Documentos y coordinaciones» se marcan a mano en Selector IOARR → Expediente → Verificación. Esta lista no reemplaza la revisión de la UF ni la de la OPMI.'));
  return Packer.toBuffer(documento(M, 'Lista de verificación', c));
}

// ─── Informe técnico de vida útil ────────────────────────────────────────────
// V = modeloVidaUtil() (lineamientos.js). Con cod, solo ese colegio.
const lineaFirma = t => [new Paragraph({ spacing: { before: 600, after: 40 }, children: [run('_______________________________________', { color: TENUE })] }), p(t, { size: 18, after: 40 })];
const tablaTipos = (tipos, umbral) => tabla(['Tipo de bien', 'A reponer: Malo', 'A reponer: Regular', 'Regular sin sustento', 'Antigüedad promedio (años)', 'Rango (años)', 'Vida útil estimada (años)'],
  tipos.map(t => [t.nombre, { v: ent(t.malo) }, { v: ent(t.regular) }, { v: ent(t.regularSin), pend: t.regularSin > 0 }, { v: t.antiguedad == null ? PEND : NS.format(t.antiguedad) },
    t.antMin == null ? '—' : t.antMin === t.antMax ? String(t.antMin) : `${t.antMin} a ${t.antMax}`, { v: t.vida == null ? `${PEND} (referencial ${umbral})` : String(t.vida) }]),
  { num: [1, 2, 3, 4, 6], size: 16 });
export async function generarVidaUtil(M, V, cod = null) {
  const c = [], cols = cod ? V.colegios.filter(x => x.cod === cod) : V.colegios;
  const uno = cols.length === 1 && cod;
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [run('INFORME TÉCNICO DE VIDA ÚTIL DEL MOBILIARIO ESCOLAR A REPONER', { bold: true, size: 26 })] }));
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [run(uno ? `${cols[0].colegio} (código de local ${cols[0].cod})` : `${M.nombre}${V.nombreIoarr ? ' — IOARR ' + V.nombreIoarr : ''}`, { bold: true, size: 20 })] }));
  c.push(...avisoChecklist(M));
  c.push(p('BORRADOR DE TRABAJO para revisión y firma de la oficina de control patrimonial. Lo marcado «PENDIENTE» falta completar.', { italics: true, color: TENUE, size: 17, plano: true }));
  if (V.faltan.length) { c.push(p('Datos pendientes:', { bold: true, size: 18 })); V.faltan.forEach(x => c.push(vinieta(x))); }
  c.push(titulo('1. Objeto'));
  c.push(p(`Sustentar la vida útil del mobiliario escolar que se propone reponer mediante la IOARR${V.nombreIoarr ? ' de ' + V.nombreIoarr : ''} «${M.nombre}», en ${uno ? 'el local educativo ' + cols[0].cod : `${ent(cols.length)} locales educativos`}, conforme a los Lineamientos IOARR del MEF (9.ª versión, junio 2025, 2.4.B.e y 2.4.C.b).`));
  c.push(titulo('2. Base normativa y fuentes de la vida útil'));
  c.push(p('La Directiva N.° 005-2016-EF/51.01 admite como fuentes para estimar la vida útil de los activos:'));
  for (const [k, t] of Object.entries(FUENTES_VIDA_UTIL)) c.push(vinieta(`${V.fuentes.includes(k) ? '[X]' : '[  ]'} ${t}.`));
  if (!V.fuentes.length) c.push(p('PENDIENTE: marca la fuente usada en Documentos.'));
  if (V.documento) c.push(p('Documento de sustento: ' + V.documento));
  c.push(p(`Para el mobiliario, ${V.referencial} años es un valor referencial: no se aplica en forma automática. La vida útil de cada tipo de bien la fija la entidad con alguna de las fuentes anteriores.`));
  c.push(titulo('3. Criterio de inclusión'));
  c.push(vinieta('Estado Malo: el mobiliario ya no es útil ni operativo y no se recupera con mantenimiento correctivo (vida útil efectiva). Lo que sale del censo debe confirmarse en campo.'));
  c.push(vinieta(`Estado Regular: solo entra si tiene antigüedad documentada mayor o igual a su vida útil estimada (o ${V.umbral} años si aún no se fijó) o un daño documentado en la ficha de verificación. Sin eso, no se sustenta su reposición.`));
  c.push(titulo(uno ? '4. Resultado del local' : '4. Consolidado por tipo de bien'));
  c.push(tablaTipos(uno ? cols[0].tipos : V.tipos, V.umbral));
  if (!uno) {
    c.push(titulo('5. Detalle por colegio'));
    for (const x of cols) {
      c.push(p(`${x.cod} — ${x.colegio}`, { bold: true, before: 160 }));
      c.push(tablaTipos(x.tipos, V.umbral));
    }
  } else {
    c.push(titulo('5. Lotes del local'));
    c.push(tabla(['Ambiente', 'Bien', 'Cód. patrimonial', 'Estado', 'Cant.', 'Antig. (años)', 'Sustento'], cols[0].lotes.map(f => [f.ambiente + (f.grado ? ' · ' + f.grado : ''), f.denom_existente,
      { v: f.patrimonial || PEND }, `${f.estado}\n${f.origen}`, { v: ent(f.cantidad) }, { v: f.antiguedad == null ? PEND : String(f.antiguedad) },
      { v: f.sustento.motivo, pend: !f.sustento.ok }]), { num: [4], size: 15, anchos: [18, 18, 13, 15, 7, 8, 21] }));
  }
  c.push(titulo('6. Conclusión'));
  const regSin = uno ? cols[0].tipos.reduce((a, t) => a + t.regularSin, 0) : V.regularSin;
  c.push(p(`El mobiliario en estado Malo cumplió su vida útil efectiva.${regSin ? ` ${ent(regSin)} bienes en estado Regular no tienen antigüedad ni daño documentado: PENDIENTE documentarlos en campo; mientras tanto no se sustenta su reposición.` : ' El mobiliario en estado Regular que se repone tiene antigüedad o daño documentado.'} Las cantidades por lote están en el anexo de la memoria y en el Excel de anexos de los Lineamientos (hoja «Ficha de activos»).`));
  c.push(titulo('7. Firmas'));
  c.push(kv([['Responsable de control patrimonial', V.responsable.nombre || null], ['Cargo', V.responsable.cargo || null], ['Fecha', null]]));
  c.push(...lineaFirma('Firma y sello del responsable de control patrimonial'));
  c.push(...lineaFirma('Visto bueno: responsable de la Unidad Formuladora (nombre, firma y fecha)'));
  return Packer.toBuffer(documento(M, 'Informe de vida útil', c));
}

// ─── Formato 05-B: idea de la IOARR (programación en el PMI) ────────────────
export async function generar05B(M) {
  const B = M.B05, c = [];
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [run('FORMATO N° 05-B: REGISTRO DE LA IDEA DE IOARR', { bold: true, size: 28 })] }));
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [run('Borrador para la programación en la cartera del PMI', { italics: true, size: 17, color: TENUE })] }));
  c.push(...avisoChecklist(M));
  c.push(p('BORRADOR DE TRABAJO. El registro de la idea se hace en el aplicativo del Banco de Inversiones; este documento sirve para prepararlo. Lo marcado «PENDIENTE» falta completar.', { italics: true, color: TENUE, size: 17, plano: true }));
  c.push(titulo('1. Idea de la inversión'));
  c.push(kv([['Nombre de la idea (tipo de IOARR + nombre genérico de las UP + ámbito geográfico)', B.idea], ['Tipo de IOARR', B.tipo], ['Nombre genérico de las UP', B.upGenerica],
    ['Ámbito geográfico', `${B.ambito.toLowerCase()} · ${B.lugar.replace(/^en (el|la) /, '')}`], ['Número de UP', ent(B.nUp)], ['Activo', 'MOBILIARIO DE AULA']], [45, 55]));
  c.push(titulo('2. Alineamiento a una brecha prioritaria'));
  c.push(kv([['Cadena funcional', M.A.cadena || `${M.A.funcion} / ${M.A.division} / ${M.A.grupos.join('; ')}`], ['Servicio con brecha', M.A.servicio],
    ['Indicador de brecha', M.A.indicadores.map(x => x.nombre).join('; ')], ['Tipo de brecha a la que contribuye', M.A.contribucion]]));
  c.push(titulo('3. Monto y programación'));
  c.push(kv([['Monto de inversión estimado (S/)', `${soles(B.monto)}${M.uit?.enUit != null ? ` = ${NS.format(M.uit.enUit)} UIT` : ''}`], ['Registro del Formato 07-C', M.registroRotulo || M.registro]]));
  c.push(espacio());
  c.push(tabla(['Año', 'Período', 'Monto programado (S/)'], [...B.programacion.map(x => [String(x.anio), x.rotulo, { v: NS.format(x.monto) }]),
    [{ v: 'Total', bold: true }, '', { v: NS.format(B.suma), bold: true, pend: !B.cuadra }]], { num: [2], anchos: [25, 25, 50] }));
  if (B.propuesto) c.push(nota('PENDIENTE: montos por año propuestos (todo en el año t). Edítalos en Documentos según la programación de la entidad.'));
  if (!B.cuadra) c.push(p(`PENDIENTE: la programación suma ${soles(B.suma)} y el monto de inversión es ${soles(B.monto)}.`));
  c.push(titulo('4. Institucionalidad'));
  c.push(kv([['OPMI', M.B.opmi], ['Unidad Formuladora (UF)', M.B.uf], ['Unidad Ejecutora de Inversiones (UEI)', M.B.uei]]));
  c.push(nota('Una idea por nivel educativo (una IOARR masiva por nivel). Ver el anexo «Consultas a la OPMI» de la memoria descriptiva.'));
  return Packer.toBuffer(documento(M, 'Formato 05-B', c));
}
