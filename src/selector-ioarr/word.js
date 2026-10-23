// ============================================================================
// src/selector-ioarr/word.js — Word del expediente IOARR (librería docx)
//
//   generar07C(M)      Borrador del Formato 07-C: Registro de IOARR
//   generarMemoria(M)  Memoria descriptiva
//   generarVerificacion(M)  Lista de verificación del expediente
// M es el modelo de armarModelo() (src/selector-ioarr/documentos.js).
// ============================================================================

import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType,
  HeadingLevel, ShadingType, Header, Footer, PageNumber, BorderStyle, PageOrientation
} from 'docx';

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
const aviso = M => [
  p('BORRADOR DE TRABAJO. No reemplaza el registro en el aplicativo del Banco de Inversiones del MEF: sirve para preparar, revisar y sustentar lo que se va a registrar. Lo marcado como «PENDIENTE» (en amarillo) falta completar.', { italics: true, color: TENUE, size: 17, plano: true }),
  ...(M.faltan.length ? [p('Datos pendientes:', { bold: true, size: 18 }), ...M.faltan.map(vinieta)] : [])
];

// ─── Secciones comunes ──────────────────────────────────────────────────────
const notaSinRep = M => M.sinRep.length ? [nota(`No se incluyen como UP ${M.sinRep.length === 1 ? 'el local' : 'los ' + M.sinRep.length + ' locales'} del proyecto sin bienes a reponer: ${M.sinRep.map(x => x.cod + (x.fal ? ` (${ent(x.fal)} faltantes)` : '')).join(', ')}.`)] : []
const notaExcluidos = M => M.excluidos?.length ? [nota(`Se excluyen ${M.excluidos.length === 1 ? 'el local' : 'los ' + M.excluidos.length + ' locales'} con otra inversión vigente o reciente, para evitar duplicidad: ${M.excluidos.map(x => x.cod + (x.codigo ? ` (inversión ${x.codigo})` : '')).join(', ')}.`)] : [];

const tablaUPs = M => tabla(['Código de local (UP)', 'Institución educativa (códigos modulares)', 'Ubicación', 'Coordenadas', 'Estudiantes'],
  M.ups.map(u => [u.cod, `${u.nombre}\n${u.modulares.join(', ')}`, `${u.cp}, ${u.dist}, ${u.prov}, ${u.dpto}`.toLocaleUpperCase('es-PE') + (u.direccion ? '\n' + u.direccion : ''),
    u.lat != null ? `Lat. ${u.lat}\nLong. ${u.lon}` : '', ent(u.est)]), { num: [4], anchos: [12, 33, 30, 14, 11], size: 16 });

const tablaMetas = M => tabla(['Tipo de IOARR', 'Acción', 'Activo', 'Tipo de factor productivo', 'Unidad de medida', 'Cantidad', 'Costo de inversión (S/)', 'Inicio', 'Término'], [
  ...M.F.metas.map(m => ['REPOSICIÓN', 'ADQUISICIÓN', `${m.activo}\n(${m.nombre.toLowerCase()})`, 'MOBILIARIO', m.unidad, { v: ent(m.cantidad) }, { v: NS.format(m.costo) }, M.F.inicio || PEND, M.F.fin || PEND]),
  [{ v: 'EXPEDIENTE TÉCNICO O DOCUMENTO EQUIVALENTE', span: 6, gris: true }, { v: NS.format(M.F.expediente), gris: true }, { v: '', gris: true }, { v: '', gris: true }],
  [{ v: 'SUPERVISIÓN', span: 6, gris: true }, { v: NS.format(M.F.supervision), gris: true }, { v: '', gris: true }, { v: '', gris: true }],
  [{ v: 'LIQUIDACIÓN', span: 6, gris: true }, { v: NS.format(M.F.liquidacion), gris: true }, { v: '', gris: true }, { v: '', gris: true }],
  [{ v: 'TOTAL', span: 6, bold: true }, { v: NS.format(M.F.total), bold: true }, '', '']
], { num: [5, 6], size: 15, anchos: [9, 11, 13, 10, 12, 7, 12, 13, 13] });

function cronogramas(M) {
  const C = M.F.cronograma;
  if (!C) return [p('PENDIENTE: fecha prevista de inicio y plazo de ejecución (meses).')];
  const out = [kv([['Fecha prevista de inicio de ejecución', M.F.inicio], ['Tipo de período', 'Mensual'], ['Número de períodos', String(M.F.meses)]]), espacio()];
  for (const [i, per] of trozos(C.periodos, 6)) {
    const col = xs => xs.slice(i, i + per.length).map(v => NS.format(v));
    const ultimo = i + per.length >= C.periodos.length;
    out.push(tabla(['Acción sobre el activo', ...per.map((x, j) => `${i + j + 1}. ${x}`), ...(ultimo ? ['Total (S/)'] : [])], [
      ...C.activos.map(a => [`ADQUISICIÓN DE MOBILIARIO DE AULA (${a.nombre.toLowerCase()})`, ...col(a.valores), ...(ultimo ? [NS.format(a.total)] : [])]),
      ['Expediente técnico', ...col(C.expediente.valores), ...(ultimo ? [NS.format(C.expediente.total)] : [])],
      ['Supervisión', ...col(C.supervision.valores), ...(ultimo ? [NS.format(C.supervision.total)] : [])],
      ['Liquidación', ...col(C.liquidacion.valores), ...(ultimo ? [NS.format(C.liquidacion.total)] : [])],
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
    ['Monto total y registro', M.registro === 'pendiente' ? 'PENDIENTE: falta la UIT' : `${soles(M.F.total)} = ${NS.format(M.uit.enUit)} UIT (UIT ${M.uit.anio}: ${soles(M.uit.valor)}) → registro ${M.registro === 'completo' ? 'completo, secciones D, E y F' : 'abreviado, sección G'}`]
  ]));

  c.push(titulo('A. Alineamiento a una brecha prioritaria'));
  c.push(kv([['Función', M.A.funcion], ['División funcional', M.A.division], ['Grupo funcional', M.A.grupos.join('; ')], ['Sector responsable', M.A.sector],
    ['Servicios públicos con brecha identificada y priorizada', M.A.servicio], ['Tipología de proyecto asociada', M.A.tipologia]]));
  c.push(espacio());
  c.push(tabla(['Tipo', 'Indicador de brecha', 'Unidad de medida', 'Contribución a la brecha del PMI'], M.A.indicadores.map(x => [x.tipo, x.nombre, x.unidad, { v: ent(x.valor) }]), { num: [3], anchos: [12, 52, 18, 18] }));
  c.push(espacio());
  c.push(kv([['Espacio geográfico de la brecha', M.A.espacio]]));
  if (M.A.propuesto) c.push(nota('Servicio, tipología e indicadores propuestos según los niveles educativos de los locales. Verifícalos contra el PMI de la entidad y el catálogo de indicadores de brecha del sector Educación.'));

  c.push(titulo('B. Institucionalidad'));
  c.push(kv([['OPMI', M.B.opmi], ['Unidad Formuladora (UF)', M.B.uf], ['Responsable de la UF', M.B.uf_responsable], ['Unidad Ejecutora de Inversiones (UEI)', M.B.uei], ['Responsable de la UEI', M.B.uei_responsable]]));

  c.push(titulo('C. Datos generales'));
  c.push(titulo('C.1 Datos de la inversión', 2));
  if (M.masiva) {
    c.push(kv([['Nombre genérico de la UP', M.niveles.map(x => 'INSTITUCIÓN EDUCATIVA DE NIVEL ' + x).join('; ')], ['Ámbito geográfico', M.ambito], ['Número de UP', ent(M.ups.length)]]));
    c.push(nota('La lista de UP con su código, coordenadas y ubicación va en la sección E.5.'));
  } else {
    const u = M.ups[0];
    c.push(kv([['Código de identificación de la UP (código de local)', u.cod], ['Nombre de la UP', `${u.nombre} (códigos modulares: ${u.modulares.join(', ')})`],
      ['Departamento / Provincia / Distrito', `${u.dpto} / ${u.prov} / ${u.dist}`.toLocaleUpperCase('es-PE')], ['Centro poblado', u.cp], ['Dirección', u.direccion],
      ['Coordenadas', u.lat != null ? `Latitud ${u.lat}, Longitud ${u.lon}` : null]]));
  }
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
    c.push(kv([['Unidad Ejecutora Presupuestal que asumirá el financiamiento del mantenimiento', M.D.mantenimiento]]));

    c.push(titulo('E. Descripción específica (IOARR mayores a 75 UIT)'));
    c.push(titulo(M.masiva ? 'E.5 Reposición masiva' : 'E.3 Inversiones de reposición', 2));
    c.push(p(M.masiva ? 'Sustento de la necesidad de la reposición masiva:' : 'Sustento de la necesidad de la reposición:', { bold: true }));
    for (const x of M.E.sustento) c.push(p(x));
    c.push(p('La intervención – activos:', { bold: true }));
    c.push(tabla(['Activo a adquirir', 'Descripción técnica'], M.E.activos.map(a => [`MOBILIARIO DE AULA (${a.nombre.toLowerCase()})`, a.descripcion || PEND]), { anchos: [30, 70] }));
    if (M.masiva) {
      c.push(espacio());
      c.push(kv([['Nombre genérico de la UP', M.niveles.map(x => 'INSTITUCIÓN EDUCATIVA DE NIVEL ' + x).join('; ')], ['Ámbito geográfico', M.ambito]]));
      c.push(p('Las UP y los activos a reponer:', { bold: true, before: 120 }));
      c.push(tablaUPs(M), ...notaSinRep(M), ...notaExcluidos(M));
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
    c.push(nota('El costo de cada tipo de bien incluye su parte de transporte, instalación, embalaje, gastos generales, utilidad, IGV, gestión e imprevistos, repartidos en cada local según su costo directo. Ver la estructura de costos en Excel.'));
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
    c.push(p('Cronograma de ejecución (S/):', { bold: true, before: 120 }));
    c.push(...cronogramas(M));
    if (M.masiva) { c.push(p('Las UP y los activos a reponer:', { bold: true, before: 120 })); c.push(tablaUPs(M), ...notaSinRep(M), ...notaExcluidos(M)); }
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
    ['Plazo de ejecución', M.F.meses ? `${M.F.meses} meses (${M.F.inicio} al ${M.F.fin})` : null]]));

  c.push(titulo('2. Antecedentes'));
  if (M.memoria.antecedentes) for (const x of M.memoria.antecedentes.split(/\n+/)) c.push(p(x));
  else c.push(p('PENDIENTE: describe cómo se identificó la necesidad (pedido de los directores, informe de la UGEL, priorización en el PMI, convenio de Obras por Impuestos, etc.).'));

  c.push(titulo('3. Objetivo'));
  c.push(p(M.memoria.objetivo));

  c.push(titulo('4. Ubicación y unidades productoras'));
  c.push(p(`La intervención comprende ${M.ups.length === 1 ? 'un local educativo' : M.ups.length + ' locales educativos'} de nivel ${M.niveles.join(', ').toLowerCase()} de la región ${M.region}${M.ugels.length ? ', bajo ' + (M.ugels.length === 1 ? 'la ' + M.ugels[0] : 'las ' + M.ugels.join(', ')) : ''}.`));
  c.push(tablaUPs(M), ...notaSinRep(M), ...notaExcluidos(M));

  c.push(titulo('5. Diagnóstico de la situación actual'));
  c.push(p(`${M.ups.length === 1 ? 'El local atiende' : 'Los locales atienden'} a ${ent(M.est)} estudiantes en ${ent(M.aulas)} aulas. Estado del mobiliario por tipo de bien${M.ups.some(u => u.verificado) ? ' (con el inventario verificado en campo donde lo hay)' : ''}. Se repone solo el estado malo; el faltante es brecha de dotación y no se repone:`));
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
  c.push(p(`Adquisición, transporte, instalación y entrega de ${M.F.metas.map(m => `${ent(m.cantidad)} ${m.plural}`).join(', ')}, para reemplazar el mobiliario en mal estado. El mobiliario reemplazado se dará de baja conforme a los procedimientos de control patrimonial de la entidad.`));
  c.push(titulo('7.1 Especificaciones técnicas', 2));
  c.push(tabla(['Tipo de bien', 'Descripción técnica'], M.E.activos.map(a => [a.nombre, a.descripcion || PEND]), { anchos: [28, 72] }));
  c.push(titulo('7.2 Metas por local', 2));
  c.push(tabla(['Código de local', 'Institución educativa', ...M.F.metas.map(m => m.nombre), 'Total (S/)'],
    M.ups.map(u => [u.cod, u.nombre, ...M.F.metas.map(m => ({ v: ent(u.rep[M.partidas.findIndex(x => x.k === m.k)]) })), { v: NS.format(u.total) }]),
    { num: Array.from({ length: M.F.metas.length + 1 }, (_, j) => j + 2), size: 15 }));

  c.push(titulo('8. Presupuesto'));
  c.push(tabla(['Partida', 'Unidad', 'Metrado', 'Precio unitario sin IGV (S/)', 'Parcial (S/)'],
    // Una línea por talla en mesa y silla (cada talla con su precio)
    [...(M.lineas || M.partidas).filter(x => x.rep > 0).map(x => [x.n, x.u, { v: ent(x.rep) }, { v: x.pu == null ? PEND : NS.format(x.pu) }, { v: NS.format(x.parcial) }]),
      [{ v: 'Costo directo', span: 4, bold: true }, { v: NS.format(T.cd), bold: true }]], { num: [2, 3, 4] }));
  c.push(espacio());
  const R = Object.fromEntries(M.rubros.map(r => [r.clave, r]));
  const lin = (t, v, bold) => [{ v: t, bold }, { v: NS.format(v), bold }];
  c.push(tabla(['Estructura de costos', 'Monto (S/)'], [
    lin('Costo directo', T.cd, true), ...['transporte', 'instalacion', 'embalaje'].map(k => lin('   ' + R[k].nombre, R[k].monto)),
    lin('Subtotal', T.subtotal, true), ...['gg', 'utilidad'].map(k => lin('   ' + R[k].nombre, R[k].monto)),
    lin('Subtotal + gastos generales + utilidad', T.neto, true), lin('   IGV', R.igv.monto),
    lin('Costo de los bienes (con IGV)', T.bienes, true), ...['supervision', 'expediente', 'gestion', 'imprevistos'].map(k => lin('   ' + R[k].nombre, R[k].monto)),
    lin('TOTAL DE INVERSIÓN', T.total, true)
  ], { num: [1], anchos: [70, 30] }));
  if (M.faltante.cantidad > 0) c.push(nota(`No se incluyen ${ent(M.faltante.cantidad)} bienes faltantes, valorizados como referencia en ${soles(M.faltante.valor)}: corresponde evaluarlos como ampliación marginal (Lineamientos IOARR 2.4.C.c).`));

  c.push(titulo('9. Cronograma de ejecución'));
  c.push(...cronogramas(M));

  c.push(titulo('10. Operación y mantenimiento'));
  c.push(p(`El mantenimiento del mobiliario nuevo estará a cargo de ${M.D.mantenimiento || 'PENDIENTE: unidad ejecutora responsable del mantenimiento'}.`));
  c.push(...mantenimiento(M));

  c.push(titulo('11. Anexos'));
  c.push(vinieta('Estructura de costos en Excel (Selector IOARR → Expediente → Exportar costos a Excel).'));
  c.push(vinieta('Selección de locales y metrado por aula en Excel (Selector IOARR → Exportar a Excel).'));
  const archivos = M.ups.flatMap(u => u.archivos.map(a => ({ ...a, cod: u.cod })));
  if (archivos.length) {
    c.push(p('Sustento de la verificación en campo:', { bold: true, before: 120 }));
    c.push(tabla(['Código de local', 'Tipo', 'Archivo', 'Descripción'], archivos.map(a => [a.cod, { acta: 'Acta de verificación', foto: 'Foto', inventario_patrimonial: 'Inventario patrimonial', baja: 'Baja', otro: 'Otro' }[a.tipo] || a.tipo, a.nombre_archivo, a.descripcion || '']), { anchos: [14, 20, 36, 30], size: 15 }));
  } else c.push(vinieta('PENDIENTE: acta de verificación, fotos, inventario patrimonial y sustento de baja de cada local.'));
  c.push(nota('Fuentes: Padrón de ESCALE y Censo Educativo 2025 (Minedu), datos declarados por cada colegio; Lineamientos IOARR del MEF (9.ª versión, junio 2025). Los precios, porcentajes y la UIT los cargó el equipo.'));
  return Packer.toBuffer(documento(M, 'Memoria descriptiva', c));
}

// ─── Lista de verificación ──────────────────────────────────────────────────
export async function generarVerificacion(M) {
  const V = M.verificacion, c = [];
  const ESTADO = { ok: 'Listo', pendiente: PEND, no: 'No cumple' };
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [run('LISTA DE VERIFICACIÓN DEL EXPEDIENTE IOARR', { bold: true, size: 28 })] }));
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [run(M.nombre, { bold: true, size: 20 })] }));
  c.push(kv([['Proyecto', M.proyecto], ['Tipo', M.masiva ? `Inversión masiva de reposición · ${M.ups.length} UP` : 'IOARR de reposición · 1 UP'],
    ['Registro', M.registro === 'pendiente' ? null : M.registro === 'completo' ? 'Completo (más de 75 UIT)' : 'Abreviado (hasta 75 UIT)'], ['Monto', soles(M.F.total)],
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
