// ============================================================================
// src/selector-ioarr/excel-lineamientos.js — Anexos de los Lineamientos IOARR en Excel (exceljs)
//
// Un libro por IOARR (nivel). Hojas:
//   Ficha de activos   estructura preliminar de costos: un lote por aula, bien y estado a reponer
//   Inventario y baja  checklist por colegio; sin completar, el colegio no entra al 07-C final
//   Riesgo de duplicación  entregas previas de mobiliario (3 años) e inversiones en ejecución
// Las filas «pendiente de verificación en campo» van en amarillo. La oferta (uso interno) no entra.
// ============================================================================

import ExcelJS from 'exceljs';
import { PENDIENTE_CAMPO, DOCS_BAJA, SI_NO, FUENTES_ENTREGA, TIPOS_ENTREGA, VENTANA_DUP } from './lineamientos.js';
import { NIVN } from './calculo.js';

const AZUL = 'FF3A63E0', AMARILLO = 'FFFFF3B0', GRIS = 'FFF1F3F7';
const SOLES = '"S/ "#,##0.00', ENTERO = '#,##0';
const relleno = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function cabecera(ws, fila, ancho) {
  const r = ws.getRow(fila);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  r.alignment = { vertical: 'middle', wrapText: true };
  for (let c = 1; c <= ancho; c++) r.getCell(c).fill = relleno(AZUL);
  r.height = 34;
}
function titulo(ws, texto, sub) {
  ws.getCell('A1').value = texto; ws.getCell('A1').font = { bold: true, size: 14 };
  if (sub) { ws.getCell('A2').value = sub; ws.getCell('A2').font = { italic: true, color: { argb: 'FF5C6270' } }; }
}

// ─── Ficha de activos a reponer ──────────────────────────────────────────────
export const COLS_FICHA = [
  ['N.°', 6], ['Código de local', 11], ['Institución educativa', 34], ['Nivel', 11], ['Ambiente / servicio', 26], ['Grado', 14], ['Sección', 8],
  ['Código patrimonial del activo existente', 20], ['Denominación existente', 30], ['Denominación nueva', 40], ['Antigüedad (años)', 11], ['Origen de la antigüedad', 18],
  ['Estado verificado', 12], ['Origen del dato', 24], ['Cantidad', 10], ['Unidad', 10],
  ['Mant. anual existente (S/, prorrateado)', 15], ['Mant. anual nuevo (S/, prorrateado)', 15], ['Situación', 24], ['Observación', 50]];

function hojaFicha(wb, F, meta) {
  const ws = wb.addWorksheet('Ficha de activos', { views: [{ state: 'frozen', ySplit: 5, xSplit: 3 }] });
  ws.columns = COLS_FICHA.map(([, width]) => ({ width }));
  titulo(ws, `Estructura preliminar de costos: activos a reponer${meta.nombreIoarr ? ' — IOARR ' + meta.nombreIoarr : ''}`,
    `Un lote por aula, bien y estado. Las filas en amarillo están «${PENDIENTE_CAMPO}»: no se inventan códigos ni antigüedades. El mantenimiento anual de cada tipo de bien (Documentos) se prorratea entre sus lotes según la cantidad.`);
  ws.getCell('A3').value = `${F.totales.filas} lotes · ${F.totales.pendientes} pendientes de verificación · ${F.totales.cantidad.toLocaleString('es-PE')} bienes a reponer (igual al metrado del costo)`;
  ws.getCell('A3').font = { bold: true };
  ws.getRow(5).values = COLS_FICHA.map(([t]) => t); cabecera(ws, 5, COLS_FICHA.length);
  F.filas.forEach((f, j) => {
    const r = ws.getRow(6 + j);
    r.values = [j + 1, f.cod, f.colegio, f.nivel, f.ambiente, f.grado, f.seccion, f.patrimonial || '', f.denom_existente, f.denom_nueva,
      f.antiguedad ?? '', f.antig_origen || '', f.estado, f.origen, f.cantidad, f.unidad, f.mant_existente ?? '', f.mant_nuevo ?? '',
      f.ajuste ? 'Ajuste' : f.situacion, [f.motivos?.length ? f.motivos.join('; ') : '', f.obs || ''].filter(Boolean).join(' · ')];
    r.getCell(15).numFmt = ENTERO; r.getCell(17).numFmt = SOLES; r.getCell(18).numFmt = SOLES;
    r.getCell(20).alignment = { wrapText: true, vertical: 'top' };
    if (f.pendiente) for (const c of [8, 11, 13, 19]) r.getCell(c).fill = relleno(AMARILLO);
    if (f.ajuste) for (let c = 1; c <= COLS_FICHA.length; c++) r.getCell(c).fill = relleno(GRIS);
    for (const [c, v] of [[17, f.mant_existente], [18, f.mant_nuevo]]) if (v == null) r.getCell(c).fill = relleno(AMARILLO);
  });
  const tot = ws.getRow(6 + F.filas.length);
  tot.values = ['TOTAL', '', '', '', '', '', '', '', '', '', '', '', '', '',
    { formula: `SUM(O6:O${5 + F.filas.length})`, result: F.totales.cantidad }];
  tot.font = { bold: true }; tot.getCell(15).numFmt = ENTERO;
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: COLS_FICHA.length } };
  if (F.sinMant.length) {
    const r = 8 + F.filas.length;
    ws.getCell(r, 1).value = `Aviso: costo anual de mantenimiento vacío en ${F.sinMant.join(', ')}. Cárgalo en Documentos (puede ser 0).`;
    ws.getCell(r, 1).font = { italic: true, color: { argb: 'FF9A6700' } };
  }
}

// ─── Checklist de inventario y baja ──────────────────────────────────────────
function hojaChecklist(wb, filas, borrador) {
  const ws = wb.addWorksheet('Inventario y baja', { views: [{ state: 'frozen', ySplit: 4 }] });
  const cols = [['Código de local', 11], ['Institución educativa', 36], ['Registrado en el inventario', 13], ['Registrado en la contabilidad', 13], ['Trámite de baja iniciado', 12],
    ['Documento de respaldo', 14], ['N.° del documento', 20], ['Fecha del documento', 12], ['Formato 07-C', 22], ['Falta', 60]];
  ws.columns = cols.map(([, width]) => ({ width }));
  titulo(ws, 'Checklist de inventario y baja por colegio (Lineamientos IOARR 2.4.C.e y 2.4.C.f)',
    `Un colegio sin el checklist completo no entra al Formato 07-C final${borrador ? '; este libro es un BORRADOR con todos los colegios' : ''}.`);
  ws.getRow(4).values = cols.map(([t]) => t); cabecera(ws, 4, cols.length);
  filas.forEach((f, j) => {
    const r = ws.getRow(5 + j);
    r.values = [f.cod, f.nombre, SI_NO[f.registrado] || '', SI_NO[f.contabilidad] || '', SI_NO[f.baja] || '', DOCS_BAJA[f.doc_tipo] || '', f.doc_numero || '',
      f.doc_fecha ? f.doc_fecha.split('-').reverse().join('/') : '', f.completo ? 'Entra' : 'Bloqueado: no entra al final', f.faltan.join('; ')];
    if (!f.completo) for (const c of [9, 10]) r.getCell(c).fill = relleno(AMARILLO);
    for (const [c, v] of [[3, f.registrado], [4, f.contabilidad], [5, f.baja], [6, f.doc_tipo], [8, f.doc_fecha]]) if (!v || v === 'no') r.getCell(c).fill = relleno(AMARILLO);
    r.getCell(10).alignment = { wrapText: true, vertical: 'top' };
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
}

// ─── Riesgo de duplicación ──────────────────────────────────────────────────
function hojaRiesgos(wb, riesgos, anioRef) {
  const ws = wb.addWorksheet('Riesgo de duplicación', { views: [{ state: 'frozen', ySplit: 4 }] });
  const cols = [['Código de local', 11], ['Institución educativa', 34], ['Situación', 22], ['Año de la entrega', 10], ['Cantidad', 10], ['Tipo', 20], ['Fuente', 16], ['Nivel', 11],
    ['¿Reciente? (últimos 3 años)', 12], ['¿Se descuenta?', 12], ['Motivo del riesgo', 60]];
  ws.columns = cols.map(([, width]) => ({ width }));
  titulo(ws, 'Chequeo de duplicación: entregas previas de mobiliario e inversiones en ejecución',
    `Una entrega de mobiliario desde ${anioRef - VENTANA_DUP} (últimos ${VENTANA_DUP} años) se descuenta de lo que se repone o deja el colegio en «Riesgo de duplicación». Fuentes: Pronied, Minedu, gobierno regional, UGEL, municipalidad.`);
  ws.getRow(4).values = cols.map(([t]) => t); cabecera(ws, 4, cols.length);
  let r = 5;
  for (const x of riesgos) {
    const situacion = x.riesgo ? 'Riesgo de duplicación' : x.recientes.length ? 'Entrega reciente descontada' : 'Sin riesgo (entregas antiguas)';
    const entregas = [...x.recientes, ...x.antiguas];
    const filas = entregas.length ? entregas : [null];
    for (const e of filas) {
      const reciente = e && e.anio >= anioRef - VENTANA_DUP;
      ws.getRow(r).values = [x.cod, x.nombre, situacion, e?.anio ?? '', e?.cantidad ?? '', e ? TIPOS_ENTREGA[e.tipo] : '', e ? FUENTES_ENTREGA[e.fuente] : '', e?.nivel ? NIVN[e.nivel] : '',
        e ? (reciente ? 'Sí' : 'No') : '', e ? (reciente && e.restar ? 'Sí' : 'No') : '', x.motivos.join('; ')];
      ws.getCell(r, 5).numFmt = ENTERO;
      ws.getCell(r, 11).alignment = { wrapText: true, vertical: 'top' };
      if (x.riesgo) for (const c of [3, 11]) ws.getCell(r, c).fill = relleno(AMARILLO);
      r++;
    }
  }
  if (!riesgos.length) ws.getCell(5, 1).value = 'Ningún colegio de esta IOARR tiene entregas previas registradas ni inversión en ejecución.';
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
}

/**
 * @param {object} L  { ficha: fichaActivos(), checklist: [filas], riesgos: [filas], anioRef, borrador }
 * @param {object} meta { proyecto, nombreIoarr, region, fecha }
 * @returns {Promise<Buffer>}
 */
export async function generarExcelLineamientos(L, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Radar Ibero — Expediente IOARR';
  wb.created = new Date();
  hojaFicha(wb, L.ficha, meta);
  if (L.checklist) hojaChecklist(wb, L.checklist, L.borrador);
  if (L.riesgos) hojaRiesgos(wb, L.riesgos, L.anioRef || new Date().getFullYear());
  return Buffer.from(await wb.xlsx.writeBuffer());
}
