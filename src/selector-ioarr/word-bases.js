// ============================================================================
// src/selector-ioarr/word-bases.js — Word (.docx) del borrador de bases OxI
//
//   generarBasesDocx({ datos, ctx, version, fecha, usuario, vistaPrevia })
//
// Un solo .docx por proceso:
//   1. Hoja de transparencia (primera página, separable: sección aparte).
//   2. Portada y contenido (índice), como en las bases del proceso de origen. El
//      índice es un campo de Word con los títulos ya escritos: Word le pone los
//      números de página al abrir el archivo (pregunta si actualiza los campos).
//      Entran las secciones, los capítulos, los anexos y los numerales 1.1, 1.2…
//      de las secciones I y II; los demás títulos en mayúsculas no.
//   3. Las plantillas 00 a 19 en orden, con los marcadores sustituidos. Cada
//      plantilla empieza en página nueva. El texto no se cambia: solo se le da
//      formato (títulos, tablas, numeración de páginas) y se resalta:
//        amarillo  marcadores sin dato y avisos [VERIFICAR …] / [NO APLICA …]
//        turquesa  texto fijo con datos del proceso de origen (RESIDUOS_ORIGEN)
//   4. Anexo 3-A (lo propio del proyecto): cronograma de prestaciones, cantidades
//      y precios del cálculo de la app, y especificaciones técnicas neutrales.
//
// Las plantillas vienen del texto de un PDF (columnas con espacios): las filas
// con columnas alineadas van en letra monoespaciada, tal cual; las líneas de un
// mismo párrafo se unen. Neutralidad: los metadatos no nombran a ninguna empresa.
// ============================================================================

import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType,
  HeadingLevel, ShadingType, Header, Footer, PageNumber, BorderStyle, TableOfContents
} from 'docx';
import {
  armarTexto, transparencia, cuadroCantidades, especificacionDe, calcularMontos, formatoMonto, esResiduo,
  RE_RESALTAR, DECLARACION, REGLAMENTO_PLANTILLAS
} from './bases.js';
import { ESPECIFICACIONES } from './bases-especificaciones.js';

const FUENTE = 'Arial', MONO = 'Courier New', AZUL = '1F3864', GRIS = 'EEF0F4', TENUE = '5C6270';
const TW_CAR = 70;   // sangría por carácter de la plantilla (twips)

// ─── Piezas ─────────────────────────────────────────────────────────────────
const run = (t, o = {}) => new TextRun({ text: String(t ?? ''), font: o.mono ? MONO : FUENTE, size: o.size ?? (o.mono ? 14 : 20), bold: o.bold, italics: o.italics, color: o.color, highlight: o.highlight });
// Texto con los marcadores sin dato y los avisos resaltados
function runs(t, o = {}) {
  const s = String(t ?? ''), out = [];
  let i = 0;
  for (const m of s.matchAll(new RegExp(RE_RESALTAR.source, 'g'))) {
    if (m.index > i) out.push(run(s.slice(i, m.index), o));
    out.push(run(m[0], { ...o, bold: true, highlight: 'yellow' }));
    i = m.index + m[0].length;
  }
  if (i < s.length || !out.length) out.push(run(s.slice(i), o));
  return out;
}
// **negrita** de las tablas de la Sección I
const runsMd = (t, o = {}) => String(t).split(/(\*\*[^*]+\*\*)/).filter(Boolean).flatMap(x => x.startsWith('**') ? runs(x.slice(2, -2), { ...o, bold: true }) : runs(x, o));
const p = (t, o = {}) => new Paragraph({ children: runs(t, o), alignment: o.align, spacing: { after: o.after ?? 100, before: o.before ?? 0 }, heading: o.heading, indent: o.indent, pageBreakBefore: o.salto, bullet: o.bullet ? { level: 0 } : undefined });
// o.indice: entra al contenido (Título 1 o 2); sin él, solo el formato
const titulo = (t, nivel = 1, o = {}) => new Paragraph({
  heading: o.indice ? (nivel === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2) : undefined, alignment: o.align ?? AlignmentType.CENTER, pageBreakBefore: o.salto,
  spacing: { before: 200, after: 140 }, children: runs(t, { bold: true, size: nivel === 1 ? 24 : 21, color: AZUL })
});
const borde = { style: BorderStyle.SINGLE, size: 4, color: '9AA1AE' };
const BORDES = { top: borde, bottom: borde, left: borde, right: borde };
const celda = (v, o = {}) => new TableCell({
  borders: BORDES, columnSpan: o.span, margins: { top: 40, bottom: 40, left: 80, right: 80 },
  width: o.ancho ? { size: o.ancho, type: WidthType.PERCENTAGE } : undefined,
  shading: o.cab ? { type: ShadingType.CLEAR, fill: AZUL, color: 'auto' } : o.gris ? { type: ShadingType.CLEAR, fill: GRIS, color: 'auto' } : undefined,
  children: String(v ?? '').split('\n').map(l => new Paragraph({ alignment: o.num ? AlignmentType.RIGHT : AlignmentType.LEFT,
    children: runsMd(l, { bold: o.cab || o.bold, color: o.cab ? 'FFFFFF' : undefined, size: o.size ?? 18 }) }))
});
function tabla(cab, filas, { num = [], anchos, size } = {}) {
  const fila = (vals, esCab) => new TableRow({ tableHeader: esCab, children: vals.map((x, j) => {
    const o = x && typeof x === 'object' && 'v' in x ? x : { v: x };
    return celda(o.v, { ...o, cab: esCab, num: !esCab && num.includes(j), ancho: anchos?.[j], size });
  }) });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [...(cab ? [fila(cab, true)] : []), ...filas.map(f => fila(f, false))] });
}
const espacio = () => new Paragraph({ children: [], spacing: { after: 60 } });

// Piezas que reusa el Word del documento equivalente (word-documento-equivalente.js)
export { run, runs, p, titulo, tabla, espacio, FUENTE, AZUL, GRIS, TENUE };

// ─── Texto de plantilla → párrafos y tablas ─────────────────────────────────
const RE_ITEM = /^(\s*)((?:\d+(?:\.\d+)*\.?|[a-z]\)|\(\d+\)|\(\*+\)|[•▪]|[ivx]+\)))(\s+)/;
const RE_VINIETA = /^(\s*)- (.*)$/;
const sangria = l => l.match(/^ */)[0].length;
const esMayus = s => { const t = s.trim(); return !/\s:\s/.test(t) && t.length >= 4 && t.length <= 110 && /\p{Lu}.*\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t.replace(/\b(N°|de|del|la|el|y|en)\b/g, '')); };
// Fila con columnas alineadas por espacios (después del número del ítem, si lo hay)
const esFilaColumnas = l => { const m = l.match(RE_ITEM), resto = m ? l.slice(m[0].length) : l.trimStart(); return /\S {4,}\S/.test(resto.trimEnd()); };

// Títulos del contenido. Nivel 1: secciones, capítulos y anexos; nivel 2: numerales 1.1, 2.3… (solo en las secciones)
const RE_ROTULO = /^(SECCIÓN\s+[IVX]+|CAPÍTULO\s+[IVX]+|ANEXO\s+N°\s*\d+(?:-[A-Z])?):$/;   // «SECCIÓN I:» sola: sigue en la línea siguiente
const RE_INDICE_1 = /^(SECCIÓN\s+[IVX]+:|CAPÍTULO\s+(?:[IVX]+:|ÚNICO\b)|ANEXOS$|ANEXO\s+N°\s*\d+(?:-[A-Z])?:)/;
const RE_INDICE_2 = /^\d+\.\d+\.\s/;
export const nivelIndice = (txt, { numerales = false } = {}) => RE_INDICE_1.test(txt) ? 1 : numerales && RE_INDICE_2.test(txt) ? 2 : 0;

/**
 * Convierte el texto de una plantilla (ya sustituido) en elementos del Word.
 * indice: lista donde se anotan los títulos del contenido ({ title, level });
 * numerales: los 1.1, 1.2… también entran (Secciones I y II).
 */
export function elementosDeTexto(texto, { salto = false, indice = null, numerales = false } = {}) {
  const lineas = texto.replace(/\r/g, '').split('\n');
  const col = lineas.map(l => !!l.trim() && !/^\s*\|/.test(l) && esFilaColumnas(l));
  // Ancho típico de una línea de párrafo (percentil 80): una línea así de larga sigue en la siguiente
  const largos = lineas.filter((l, i) => l.trim() && !col[i]).map(l => l.trimEnd().length).sort((a, b) => a - b);
  const ancho = Math.max(50, largos[Math.floor(largos.length * 0.8)] || 0);
  const out = [];
  let par = null, tablaMd = null;
  const conSalto = () => { const s = salto && !out.length; return s; };
  const cerrar = () => {
    if (!par) return;
    const txt = par.lineas.join(' ');
    // Los títulos que no van al contenido quedan como Título 3 (fuera del índice)
    const nivel = par.titulo ? nivelIndice(txt, { numerales }) : 0;
    const heading = !par.titulo ? undefined : nivel === 1 ? HeadingLevel.HEADING_1 : nivel === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
    if (nivel && indice) indice.push({ title: txt, level: nivel });
    const indent = par.titulo && par.centrado ? undefined : { left: Math.min(par.cont, 40) * TW_CAR, hanging: Math.max(0, Math.min(par.cont, 40) - par.ini) * TW_CAR };
    out.push(new Paragraph({
      heading, pageBreakBefore: conSalto(), indent, alignment: par.centrado ? AlignmentType.CENTER : par.titulo ? AlignmentType.LEFT : AlignmentType.JUSTIFIED,
      spacing: { after: par.titulo ? 120 : 80, before: par.titulo ? 120 : 0 },
      children: runs(txt, { bold: par.titulo, color: par.titulo ? AZUL : undefined, size: par.titulo ? 21 : 20, highlight: par.residuo ? 'cyan' : undefined })
    }));
    par = null;
  };
  const cerrarTabla = () => {
    if (!tablaMd) return;
    const filas = tablaMd.filter(f => !/^\|\s*-{3,}/.test(f)).map(f => f.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
    if (conSalto()) out.push(new Paragraph({ children: [], pageBreakBefore: true }));
    out.push(tabla(filas[0], filas.slice(1), { num: [1, 2], size: 17 }), espacio());
    tablaMd = null;
  };
  let previa = '';
  lineas.forEach((l, i) => {
    if (/^\s*\|/.test(l)) { cerrar(); (tablaMd ??= []).push(l); previa = l; return; }
    cerrarTabla();
    if (!l.trim()) { cerrar(); previa = ''; return; }
    const residuo = esResiduo(l);
    // Filas con columnas (y su cabecera en mayúsculas): tal cual, en letra monoespaciada
    const vecina = j => { while (j >= 0 && j < lineas.length && !lineas[j].trim()) j += j < i ? -1 : 1; return col[j]; };
    if (col[i] || (esMayus(l) && l.trim().length <= 30 && (vecina(i - 1) || vecina(i + 1)))) {
      cerrar();
      out.push(new Paragraph({ pageBreakBefore: conSalto(), spacing: { after: 0 }, children: [run(l.trimEnd(), { mono: true, highlight: residuo ? 'cyan' : undefined, bold: esMayus(l) })] }));
      previa = l; return;
    }
    const v = l.match(RE_VINIETA);
    if (v) { cerrar(); out.push(new Paragraph({ pageBreakBefore: conSalto(), bullet: { level: 0 }, spacing: { after: 60 }, children: runsMd(v[2], { highlight: residuo ? 'cyan' : undefined }) })); previa = l; return; }
    const item = l.match(RE_ITEM), ini = sangria(l), textoIni = item ? item[0].length : ini;
    // Una línea sigue el párrafo si la anterior llegó al ancho típico sin cerrar la oración,
    // aunque esté en mayúsculas («LA EMPRESA PRIVADA (O EL CONSORCIO)…»)
    const largaPrevia = previa.trimEnd().length >= ancho * 0.85 && !/[.:;]$/.test(previa.trimEnd());
    const sigue = par && !par.titulo && !item && largaPrevia && Math.abs(ini - par.cont) <= 4;
    const titulo = !sigue && esMayus(l);
    if (sigue) { par.lineas.push(l.trim()); par.residuo ||= residuo; }
    else if (par && par.titulo && titulo && !item && (
      (par.lineas.length === 1 && RE_ROTULO.test(par.lineas[0]))                                              // «ANEXO N° 1:» + su nombre
      || (!par.numerado && !/[.:;]$/.test(previa.trimEnd()) && Math.abs(ini - par.ini) <= 30)                 // título en dos líneas
      || (par.numerado && par.lineas.length === 1 && nivelIndice(par.lineas[0], { numerales }) === 2 && !/[.:;]$/.test(previa.trimEnd()) && Math.abs(ini - par.cont) <= 2))) { par.lineas.push(l.trim()); }   // numeral largo: la 2.ª línea se alinea con su texto
    else {
      cerrar();
      par = { lineas: [item ? (item[2] + ' ' + l.slice(item[0].length).trim()) : l.trim()], ini, cont: textoIni, titulo, numerado: !!item, residuo,
        centrado: titulo && !item && ini >= 12 };
    }
    previa = l;
  });
  cerrar(); cerrarTabla();
  return out;
}

// ─── Hoja de transparencia ──────────────────────────────────────────────────
function hojaTransparencia(d, ctx, armado, { version, fecha, usuario, vistaPrevia }) {
  const T = transparencia(d, ctx, armado);
  return [
    titulo('HOJA DE TRANSPARENCIA'),
    p('Página separable: no forma parte de las bases. Acompaña al borrador para que la entidad sepa qué datos se tomaron de la aplicación, qué se supuso y qué falta.', { italics: true, color: TENUE, size: 18, align: AlignmentType.CENTER }),
    tabla(null, [[{ v: DECLARACION, bold: true, gris: true, size: 20 }]]),
    espacio(),
    tabla(null, [
      [{ v: 'Proceso', gris: true, bold: true }, d.N_PROCESO || '{{N_PROCESO}}'],
      [{ v: 'IOARR', gris: true, bold: true }, `${d.NOMBRE_IOARR || '{{NOMBRE_IOARR}}'} (CUI ${d.CUI || '{{CUI}}'})`],
      [{ v: 'Nivel', gris: true, bold: true }, ctx.nivel_nombre || '—'],
      [{ v: 'Reglamento aplicable', gris: true, bold: true }, d.reglamento || '—'],
      [{ v: 'Versión', gris: true, bold: true }, vistaPrevia ? 'Vista previa (sin versión: no válida para publicar)' : `Versión ${version} · ${fecha}${usuario ? ' · preparada por ' + usuario : ''}`]
    ], { anchos: [28, 72] }),
    titulo('Datos tomados de la aplicación', 2, { align: AlignmentType.LEFT }),
    T.app.length ? tabla(['Campo', 'Valor', 'Fuente'], T.app.map(x => [x.campo, x.valor, x.fuente]), { anchos: [28, 34, 38], size: 16 }) : p('Ninguno: todos los datos los escribió el usuario.'),
    titulo('Supuestos', 2, { align: AlignmentType.LEFT }),
    ...T.supuestos.map(t => p(t, { bullet: true, size: 16, after: 20 })),
    titulo('Campos pendientes y revisiones de la entidad', 2, { align: AlignmentType.LEFT }),
    ...T.pendientes.map(t => p(t, { bullet: true, size: 16, after: 20 })),
    p('Contenido: los números de página los pone Word al abrir el archivo (acepta «actualizar los campos», o clic derecho en el contenido › Actualizar campos).', { bullet: true, size: 16, after: 20 }),
    titulo('Neutralidad', 2, { align: AlignmentType.LEFT }),
    p('Las especificaciones técnicas no indican marcas, modelos ni fabricantes, y remiten a las normas técnicas aplicables. La entidad debe verificar que ningún requisito favorezca a un postor antes de aprobar las bases.', { size: 16 })
  ];
}

// ─── Portada y contenido ────────────────────────────────────────────────────
// Texto de la portada de las bases del proceso de origen (015-2026, San Juan)
const PORTADA_LEY = 'PARA EL FINANCIAMIENTO Y EJECUCIÓN DE INVERSIONES O ACTIVIDADES DE OPERACIÓN Y MANTENIMIENTO EN EL MARCO DE LA LEY N° 29230, LEY QUE IMPULSA LA INVERSIÓN PÚBLICA REGIONAL Y LOCAL CON PARTICIPACIÓN DEL SECTOR PRIVADO Y POR EL REGLAMENTO DE LA LEY N° 29230, APROBADO POR DECRETO SUPREMO N° 038-2026-EF, LEY QUE IMPULSA LA INVERSIÓN PÚBLICA REGIONAL Y LOCAL CON PARTICIPACIÓN DEL SECTOR PRIVADO.';
const TITULO_3A = 'ANEXO N° 3-A: TÉRMINOS DE REFERENCIA – ELEMENTOS DEL PROYECTO';
function portada(d) {
  const c = (t, o = {}) => p(t, { align: AlignmentType.CENTER, bold: true, color: AZUL, ...o });
  return [
    c('BASES DEL PROCESO DE SELECCIÓN DE LA EMPRESA PRIVADA', { size: 26, before: 1800, after: 240 }),
    c(PORTADA_LEY, { size: 20, after: 360 }),
    c(`PROCESO DE SELECCIÓN N° ${d.N_PROCESO || '{{N_PROCESO}}'}`, { size: 22, after: 720 }),
    c('CONTRATACIÓN DE LA EJECUCIÓN Y FINANCIAMIENTO DE LA IOARR:', { size: 22, after: 240 }),
    c(`“${d.NOMBRE_IOARR || '{{NOMBRE_IOARR}}'}” CON CÓDIGO ÚNICO DE INVERSIÓN N° ${d.CUI || '{{CUI}}'}`, { size: 22, after: 1800 }),
    p('[Firmas de los miembros titulares del Comité Especial]', { align: AlignmentType.CENTER, italics: true, color: TENUE, size: 18 })
  ];
}
// Contenido: campo de índice de Word (títulos 1 y 2) con las entradas ya escritas, sin página
function contenido(entradas) {
  return [
    titulo('CONTENIDO', 1, { salto: true }),
    new TableOfContents('Contenido', { hyperlink: true, headingStyleRange: '1-2', cachedEntries: entradas })
  ];
}

// ─── Anexo 3-A (lo propio del proyecto) ─────────────────────────────────────
function anexo3A(d, ctx) {
  const M = calcularMontos(d), Q = cuadroCantidades(d, ctx), de = d.PLAZO_DOC_EQUIVALENTE_DIAS, ej = d.PLAZO_EJECUCION_DIAS;
  const sol = n => n == null ? '' : formatoMonto(n);
  const bienes = [...new Set(Q.filas.map(f => f.k))];
  return [
    titulo(TITULO_3A, 1, { salto: true, indice: true }),
    p('[COMPLETAR POR LA ENTIDAD: este anexo reúne solo el cronograma, las cantidades y las especificaciones técnicas del proyecto. Los requisitos habilitantes, los entregables, el perfil del personal y las demás condiciones de los términos de referencia los define la entidad.]', { size: 18 }),
    titulo('1. Objeto', 2, { align: AlignmentType.LEFT }),
    p(`Financiamiento y ejecución de la IOARR «${d.NOMBRE_IOARR || '{{NOMBRE_IOARR}}'}», CUI N° ${d.CUI || '{{CUI}}'}, nivel ${ctx.nivel_nombre || '—'}, componente ${d.COMPONENTE || '{{COMPONENTE}}'}, y financiamiento de su supervisión, en el marco de la Ley N° 29230 y su Reglamento.`),
    titulo('2. Prestaciones y cronograma', 2, { align: AlignmentType.LEFT }),
    tabla(['Prestación', 'Descripción', 'Plazo (días calendario)', 'Monto referencial (S/)'], [
      ['N° 1', 'Elaboración del documento equivalente (obligatorio)', de ?? '{{PLAZO_DOC_EQUIVALENTE_DIAS}}', sol(M.doc) || '{{MONTO_DOC_EQUIVALENTE}}'],
      ['N° 2', `Ejecución física de la inversión – componente ${d.COMPONENTE || '{{COMPONENTE}}'}`, ej ?? '{{PLAZO_EJECUCION_DIAS}}', sol(M.ej) || '{{MONTO_EJECUCION}}'],
      ['N° 3', 'Financiamiento de la supervisión del documento equivalente (obligatorio)', 'Durante la Prestación N° 1', sol(M.supDoc) || '{{MONTO_SUP_DOC_EQUIVALENTE}}'],
      ['N° 3', 'Financiamiento de la supervisión de la ejecución física', 'Durante la Prestación N° 2, la recepción y la liquidación', sol(M.supEj) || '{{MONTO_SUP_EJECUCION}}'],
      [{ v: 'Total', bold: true }, '', { v: de != null && ej != null ? String(de + ej) : '', bold: true }, { v: sol(M.total) || '{{MONTO_TOTAL}}', bold: true }]
    ], { num: [2, 3], anchos: [12, 46, 20, 22], size: 17 }),
    p('El plazo total no incluye la recepción ni la liquidación, ni los plazos de revisión de la entidad, que se rigen por el Reglamento y el convenio. La ejecución física inicia con la aprobación del documento equivalente. [VERIFICAR plazos con el Reglamento vigente y la entidad]', { size: 18, italics: true }),
    titulo('3. Cantidades y precios referenciales', 2, { align: AlignmentType.LEFT }),
    p(Q.texto, { size: 18 }),
    Q.filas.length ? tabla(['Bien', 'Unidad', 'Cantidad', 'Precio unitario referencial con IGV (S/)', 'Parcial (S/)'], [
      ...Q.filas.map(f => [f.nombre, f.unidad, f.cantidad == null ? '[COMPLETAR cantidad]' : f.cantidad.toLocaleString('es-PE'), sol(f.pu), sol(f.parcial)]),
      [{ v: 'Total de bienes', bold: true, span: 4 }, { v: sol(Q.total), bold: true }]
    ], { num: [2, 3, 4], anchos: [36, 16, 12, 20, 16], size: 17 }) : p('[COMPLETAR: el proyecto no tiene bienes calculados para este nivel]'),
    p(Q.precio_catalogo ? 'Precios referenciales con IGV: el kit, del catálogo de precios de IOARR publicadas (sin transporte); los demás bienes, de la estructura de costos del expediente. No son el precio de ningún postor.'
      : 'Precios referenciales de la estructura de costos del expediente (costo puesto en la institución educativa, con IGV). No son el precio de ningún postor.', { size: 16, italics: true, color: TENUE }),
    titulo('4. Especificaciones técnicas', 2, { align: AlignmentType.LEFT }),
    p(`Normas técnicas aplicables: ${d.normas_tecnicas || '[COMPLETAR normas técnicas]'}${d.normas_verificadas ? ' (verificadas por el usuario)' : ' [VERIFICAR normas técnicas]'}.`, { bold: true, size: 19 }),
    ...(bienes.length ? bienes : Object.keys(ESPECIFICACIONES).filter(k => k !== 'kit')).flatMap(k => [
      p(ESPECIFICACIONES[k]?.nombre || k, { bold: true, after: 40 }),
      p(especificacionDe(d, k))
    ])
  ];
}

// ─── Documento ──────────────────────────────────────────────────────────────
/**
 * @param datos    ficha limpia (limpiarFicha)
 * @param ctx      contextoApp(): nivel, metas (cantidades y costos), escenario…
 * @param version  número de versión (null en vista previa)
 * @returns Buffer del .docx
 */
export async function generarBasesDocx({ datos: d, ctx = {}, version = null, fecha = '', usuario = '', vistaPrevia = false }) {
  const armado = armarTexto(d), indice = [];
  // Secciones I y II (plantillas 00 a 03): sus numerales 1.1, 1.2… van al contenido
  const cuerpo = armado.bloques.flatMap(b => elementosDeTexto(b.texto, { salto: true, indice, numerales: /^0[0-3]_/.test(b.file) }));
  indice.push({ title: TITULO_3A, level: 1 });
  const rotulo = vistaPrevia ? 'VISTA PREVIA CON DATOS PENDIENTES – NO PUBLICAR' : `Borrador de bases · Proceso N° ${d.N_PROCESO || '—'} · Versión ${version} · ${fecha}`;
  const pie = () => new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Página ', PageNumber.CURRENT], font: FUENTE, size: 16, color: TENUE })] })] });
  const cab = t => new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(t, { size: 16, color: vistaPrevia ? 'C00000' : TENUE, bold: vistaPrevia })] })] });
  const margen = { top: 1134, bottom: 1134, left: 1134, right: 1134 };   // 2 cm
  const doc = new Document({
    creator: 'Generador de bases OxI (borrador)', lastModifiedBy: 'Generador de bases OxI (borrador)',
    title: `Bases – Proceso ${d.N_PROCESO || ''}`.trim(), description: `Borrador de bases. ${REGLAMENTO_PLANTILLAS}.`,
    styles: { default: { document: { run: { font: FUENTE, size: 20 } } },
      // Líneas del contenido: los numerales (nivel 2) con sangría
      paragraphStyles: [1, 2].map(n => ({ id: `TOC${n}`, name: `toc ${n}`, basedOn: 'Normal', next: 'Normal', run: { size: 17, bold: n === 1 },
        paragraph: { indent: { left: (n - 1) * 360 }, spacing: { before: 0, after: 0, line: 240 } } })) },
    features: { updateFields: true },   // Word pone las páginas del contenido al abrir
    sections: [
      { properties: { page: { margin: margen } }, headers: { default: cab('Hoja de transparencia (separable)') }, footers: { default: pie() },
        children: hojaTransparencia(d, ctx, armado, { version, fecha, usuario, vistaPrevia }) },
      { properties: { page: { margin: margen, pageNumbers: { start: 1 } } }, headers: { default: cab(rotulo) }, footers: { default: pie() },
        children: [...portada(d), ...contenido(indice), ...cuerpo, ...anexo3A(d, ctx)] }
    ]
  });
  return Packer.toBuffer(doc);
}

