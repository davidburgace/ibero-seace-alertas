// ============================================================================
// src/selector-ioarr/word-documento-equivalente.js — Word (.docx) del borrador
// del documento equivalente
//
//   generarDocumentoEquivalenteDocx({ datos, ctx, version, fecha, usuario, vistaPrevia, hoy })
//
//   1. Portada (IOARR, CUI, entidad, proceso, responsable, de qué bases sale el
//      contenido mínimo y el aviso de la plantilla).
//   2. Plan de trabajo y tomos I a III (plantillas de templates/documento_equivalente/),
//      cada tomo en página nueva. 1.1 es el índice de Word (títulos 1 y 2).
//   3. Las tablas las arma la app: metas, presupuesto resumen, lugar de entrega,
//      presupuesto referencial, precios promedio, plazos de entrega y legajo.
// Resaltado en amarillo: marcadores sin dato, [VERIFICAR …], [COMPLETAR …] y [REVISAR].
// La oferta (uso interno) no entra.
// ============================================================================

import { Document, Packer, Paragraph, AlignmentType, Header, Footer, PageNumber, TextRun, TableOfContents } from 'docx';
import { run, p, titulo, tabla, espacio, FUENTE, AZUL, TENUE } from './word-bases.js';
import { formatoMonto, especificacionDe } from './bases.js';
import { MANIFEST, armarTexto, presupuesto, comparacionCatalogo, rotuloSeccion, venceDe, BIENES, MIN_COTIZACIONES } from './documento-equivalente.js';
import { ESPECIFICACIONES } from './bases-especificaciones.js';

const sol = n => n == null ? '—' : formatoMonto(n);
const fechaPe = f => f ? f.split('-').reverse().join('/') : '—';
const marcador = k => p(`{{${k}}}`, { after: 80 });

// ─── Tablas de la app ───────────────────────────────────────────────────────
function tablas(d, ctx, P, hoy) {
  const cot = d.cotizaciones || [];
  const cmp = comparacionCatalogo(P, ctx.precio_ref);
  return {
    TABLA_METAS: () => (ctx.metas || []).length ? [tabla(['Meta', 'Unidad', 'Cantidad (Formato 07-C)'],
      ctx.metas.map(m => [m.nombre, m.unidad, m.cantidad.toLocaleString('es-PE')]), { num: [2], anchos: [50, 30, 20], size: 18 }), espacio()] : [marcador('TABLA_METAS')],
    TABLA_PRESUPUESTO_RESUMEN: () => [tabla(['Componente', 'Monto (S/)'], [
      ['Ejecución física (presupuesto referencial 2.17, con IGV)', P.resumen.ejecucion == null ? '{{TABLA_PRESUPUESTO}}' : sol(P.resumen.ejecucion)],
      ['Documento equivalente', d.MONTO_DOC_EQUIVALENTE == null ? '[COMPLETAR monto]' : sol(d.MONTO_DOC_EQUIVALENTE)],
      ['Supervisión (documento equivalente y ejecución)', d.MONTO_SUPERVISION == null ? '[COMPLETAR monto]' : sol(d.MONTO_SUPERVISION)],
      [{ v: 'Total', bold: true }, { v: P.resumen.total == null ? '—' : sol(P.resumen.total), bold: true }]
    ], { num: [1], anchos: [70, 30], size: 18 }), espacio()],
    TABLA_LUGAR_ENTREGA: () => (ctx.locales || []).length ? [tabla(['Código de local', 'Institución educativa', 'Dirección', 'Distrito', 'Provincia'],
      ctx.locales.map(u => [u.cod, u.nombre, u.direccion || '—', u.dist, u.prov]), { anchos: [14, 30, 26, 15, 15], size: 16 }), espacio()] : [marcador('TABLA_LUGAR_ENTREGA')],
    TABLA_PRESUPUESTO: () => P.cd == null
      ? [tabla(['Ítem', 'Unidad', 'Cantidad', 'Precio unitario sin IGV (S/)', 'Parcial (S/)'], P.items.map(x => [x.nombre, x.unidad, x.cantidad ?? '—', x.pu == null ? '[COMPLETAR: cotizaciones del legajo]' : sol(x.pu), x.parcial == null ? '—' : sol(x.parcial)]),
        { num: [2, 3, 4], anchos: [34, 18, 12, 20, 16], size: 17 }), espacio()]
      : [tabla(['Ítem', 'Unidad', 'Cantidad', 'Precio unitario sin IGV (S/)', 'Parcial (S/)'], [
        ...P.items.map(x => [x.nombre, x.unidad, x.cantidad.toLocaleString('es-PE'), sol(x.pu), sol(x.parcial)]),
        [{ v: 'Costo directo', bold: true, span: 4 }, { v: sol(P.cd), bold: true }],
        [{ v: `Gastos generales (${P.gg_pct} % del costo directo)`, span: 4 }, sol(P.gg)],
        [{ v: `Utilidad (${P.ut_pct} % del costo directo)`, span: 4 }, sol(P.ut)],
        [{ v: 'Subtotal', bold: true, span: 4 }, { v: sol(P.subtotal), bold: true }],
        [{ v: `IGV (${P.igv_pct} %)`, span: 4 }, sol(P.igv)],
        [{ v: 'Total del presupuesto referencial', bold: true, span: 4 }, { v: sol(P.total), bold: true }]
      ], { num: [2, 3, 4], anchos: [34, 18, 12, 20, 16], size: 17 }),
      ...(P.gg_pct === 0 && P.ut_pct === 0 ? [p('Gastos generales y utilidad en 0 %: la estructura de costos del expediente es de adquisición de bienes. [VERIFICAR en bases]', { size: 16, italics: true, color: TENUE })] : []),
      espacio()],
    ESPECIFICACIONES: () => (ctx.metas || []).length ? (ctx.metas).flatMap(m => [
      p(ESPECIFICACIONES[m.k]?.nombre || m.nombre, { bold: true, after: 40 }), p(especificacionDe(d, m.k) || '[COMPLETAR especificación]')
    ]) : [marcador('ESPECIFICACIONES')],
    TABLA_PRECIOS_PROMEDIO: () => [
      tabla(['Ítem', 'Cotizaciones vigentes', 'Mínimo sin IGV (S/)', 'Máximo sin IGV (S/)', 'Promedio sin IGV (S/)', 'Promedio con IGV (S/)'],
        P.items.map(x => [x.nombre, String(x.promedio.vigentes), sol(x.promedio.min), sol(x.promedio.max), sol(x.promedio.sin_igv), sol(x.promedio.con_igv)]),
        { num: [1, 2, 3, 4, 5], anchos: [30, 14, 14, 14, 14, 14], size: 16 }),
      ...(cmp ? [p(`Catálogo de precios referenciales de IOARR publicadas: S/ ${sol(cmp.catalogo)} por kit sin IGV. El promedio de las cotizaciones (S/ ${sol(cmp.promedio)}) ${cmp.dif_pct === 0 ? 'es igual' : `está ${Math.abs(cmp.dif_pct)} % ${cmp.dif_pct > 0 ? 'por encima' : 'por debajo'}`}.`, { size: 18, before: 80 })] : []),
      ...P.items.filter(x => x.promedio.proveedores < MIN_COTIZACIONES && d.justificaciones?.[x.k])
        .map(x => p(`Justificación (${x.nombre}: ${x.promedio.proveedores} ${x.promedio.proveedores === 1 ? 'cotización vigente' : 'cotizaciones vigentes'}): ${d.justificaciones[x.k]}`, { size: 18 })),
      espacio()],
    TABLA_PLAZOS_ENTREGA: () => cot.length ? [tabla(['Proveedor', 'Plazo de entrega (días calendario)'],
      cot.map(c => [c.proveedor || '—', c.plazo_entrega_dias ? String(c.plazo_entrega_dias) : '[COMPLETAR plazo]']), { num: [1], anchos: [65, 35], size: 17 }), espacio()] : [marcador('TABLA_PLAZOS_ENTREGA')],
    TABLA_COTIZACIONES: () => cot.length ? [tabla(['N°', 'Proveedor', 'Fecha', 'Vigente hasta', 'Precios', 'Plazo de entrega', 'PDF'],
      cot.map((c, i) => [String(i + 1), c.proveedor + (c.ruc ? `\nRUC ${c.ruc}` : ''), fechaPe(c.fecha), venceDe(c) ? fechaPe(venceDe(c)) + (venceDe(c) < hoy ? '\n(vencida)' : '') : '[COMPLETAR vigencia]',
        Object.entries(c.precios).map(([k, v]) => `${BIENES[k]}: S/ ${sol(v)}`).join('\n') + `\n(${c.incluye_igv ? 'incluye IGV' : 'sin IGV'})`,
        c.plazo_entrega_dias ? `${c.plazo_entrega_dias} días` : '—', c.archivo_nombre ? 'Adjunto' : '[COMPLETAR: PDF firmado]']),
      { anchos: [5, 24, 11, 13, 25, 12, 10], size: 15 }), espacio()] : [marcador('TABLA_COTIZACIONES')]
  };
}

// ─── Texto de una sección → párrafos ────────────────────────────────────────
function cuerpo(texto, T, indice) {
  const out = [];
  let par = [];
  const cerrar = () => { if (par.length) { out.push(p(par.join(' '), { align: AlignmentType.JUSTIFIED })); par = []; } };
  for (const l of String(texto || '').split('\n')) {
    const t = l.trim(), m = t.match(/^\{\{([A-Z0-9_]+)\}\}$/);
    if (!t) { cerrar(); continue; }
    if (m && m[1] === 'INDICE') { cerrar(); out.push(new TableOfContents('Índice general', { hyperlink: true, headingStyleRange: '1-2', cachedEntries: indice })); continue; }
    if (m && T[m[1]]) { cerrar(); out.push(...T[m[1]]()); continue; }
    if (t.startsWith('- ')) { cerrar(); out.push(p(t.slice(2), { bullet: true, after: 40 })); continue; }
    // Una línea con un solo párrafo de varias líneas (texto escrito por el usuario): cada línea es un párrafo
    cerrar(); par.push(t);
  }
  cerrar();
  return out;
}

function portada(d, ctx, { version, fecha, vistaPrevia }) {
  const c = (t, o = {}) => p(t, { align: AlignmentType.CENTER, bold: true, color: AZUL, ...o });
  return [
    c('DOCUMENTO EQUIVALENTE', { size: 30, before: 1600, after: 240 }),
    c('IOARR:', { size: 22, after: 120 }),
    c(`“${d.NOMBRE_IOARR || '{{NOMBRE_IOARR}}'}” CON CÓDIGO ÚNICO DE INVERSIÓN N° ${d.CUI || '{{CUI}}'}`, { size: 22, after: 480 }),
    c(`Entidad: ${d.ENTIDAD || '{{ENTIDAD}}'}`, { size: 20, bold: false, after: 80 }),
    c(`Nivel: ${ctx.nivel_nombre || '—'}`, { size: 20, bold: false, after: 80 }),
    ...(d.N_PROCESO ? [c(`Proceso de selección N° ${d.N_PROCESO}`, { size: 20, bold: false, after: 80 })] : []),
    c(`Elaborado por: ${d.RESPONSABLE_ELABORACION || '{{RESPONSABLE_ELABORACION}}'}`, { size: 20, bold: false, after: 480 }),
    c(vistaPrevia ? 'Vista previa: sin versión' : `Versión ${version} · ${fechaPe(fecha)}`, { size: 18, bold: false, color: TENUE, after: 720 }),
    p(`Contenido mínimo según: ${d.bases_origen || '[COMPLETAR: bases del proceso (número y numeral)]'}`, { align: AlignmentType.CENTER, size: 18 }),
    p(MANIFEST.aviso, { align: AlignmentType.CENTER, italics: true, color: TENUE, size: 16, before: 120 })
  ];
}

/**
 * @param datos  ficha limpia (limpiarFicha)
 * @param ctx    contextoDe(): metas del 07-C, colegios, IGV, catálogo
 * @param hoy    fecha para la vigencia de las cotizaciones (AAAA-MM-DD)
 * @returns Buffer del .docx
 */
export async function generarDocumentoEquivalenteDocx({ datos: d, ctx = {}, version = null, fecha = '', usuario = '', vistaPrevia = false, hoy = fecha }) {
  const A = armarTexto(d), P = presupuesto(d, ctx, { hoy }), T = tablas(d, ctx, P, hoy);
  // Títulos del índice: tomos (nivel 1) y secciones (nivel 2)
  const indice = A.tomos.flatMap(t => [{ title: t.titulo, level: 1 }, ...t.secciones.map(s => ({ title: rotuloSeccion(s), level: 2 }))]);
  const hijos = A.tomos.flatMap(t => [
    titulo(t.titulo, 1, { salto: true, indice: true }),
    ...(t.intro ? cuerpo(t.intro, T, indice) : []),
    ...t.secciones.flatMap(s => [titulo(rotuloSeccion(s), 2, { align: AlignmentType.LEFT, indice: true }), ...cuerpo(s.texto, T, indice)])
  ]);
  const rotulo = vistaPrevia ? 'VISTA PREVIA CON DATOS PENDIENTES – NO PRESENTAR' : `Documento equivalente (borrador) · Versión ${version} · ${fechaPe(fecha)}${usuario ? ' · ' + usuario : ''}`;
  const cab = new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(rotulo, { size: 16, color: vistaPrevia ? 'C00000' : TENUE, bold: vistaPrevia })] })] });
  const pie = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Página ', PageNumber.CURRENT], font: FUENTE, size: 16, color: TENUE })] })] });
  const doc = new Document({
    creator: 'Generador de documento equivalente (borrador)', lastModifiedBy: 'Generador de documento equivalente (borrador)',
    title: `Documento equivalente – CUI ${d.CUI || ''}`.trim(), description: 'Borrador del documento equivalente de una IOARR de mobiliario escolar.',
    styles: { default: { document: { run: { font: FUENTE, size: 20 } } },
      paragraphStyles: [1, 2].map(n => ({ id: `TOC${n}`, name: `toc ${n}`, basedOn: 'Normal', next: 'Normal', run: { size: 17, bold: n === 1 },
        paragraph: { indent: { left: (n - 1) * 360 }, spacing: { before: 0, after: 0, line: 240 } } })) },
    features: { updateFields: true },   // Word pone las páginas del índice al abrir
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 }, pageNumbers: { start: 1 } } }, headers: { default: cab }, footers: { default: pie },
      children: [...portada(d, ctx, { version, fecha, vistaPrevia }), ...hijos] }]
  });
  return Packer.toBuffer(doc);
}
