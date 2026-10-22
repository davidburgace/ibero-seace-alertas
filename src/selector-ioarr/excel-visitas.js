// src/selector-ioarr/excel-visitas.js — Excel del plan de visitas (Selector IOARR).
// Hojas: «Visitas» (una fila por local, en orden de visita) y «Resumen por día».
import ExcelJS from 'exceljs';
import { AVISO_VISITAS } from './visitas.js';

const AZUL = 'FF3A63E0';
const ENTERO = '#,##0';
export const COLUMNAS_VISITAS = ['Grupo (día)', 'Orden', 'Código de local', 'Institución', 'Distrito', 'Centro poblado', 'Dirección', 'Latitud', 'Longitud', 'Bienes a reponer'];

function encabezado(ws, fila, ancho) {
  const r = ws.getRow(fila);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  r.alignment = { vertical: 'middle', wrapText: true };
  for (let c = 1; c <= ancho; c++) r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
  r.height = 30;
}

/**
 * @param {Array} dias      resultado de agruparVisitas()
 * @param {Array} sinCoord  locales sin coordenadas válidas (van al final, sin grupo)
 * @param {object} meta     { proyecto, region, porDia, fecha }
 * @returns {Promise<Buffer>}
 */
export async function generarExcelVisitas(dias, sinCoord, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Radar Ibero — Selector IOARR';

  const ws = wb.addWorksheet('Visitas', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNAS_VISITAS.map((h, i) => ({ header: h, width: [11, 8, 13, 46, 20, 24, 36, 12, 12, 12][i] }));
  encabezado(ws, 1, COLUMNAS_VISITAS.length);
  for (const d of dias) for (const p of d.puntos)
    ws.addRow([`Día ${d.dia}`, p.orden, p.cod, p.nom, p.dist, p.cp, p.dir, p.lat, p.lon, p.rep]);
  for (const p of sinCoord) ws.addRow(['Sin coordenadas', null, p.cod, p.nom, p.dist, p.cp, p.dir, null, null, p.rep]);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNAS_VISITAS.length } };
  ws.getColumn(8).numFmt = '0.000000'; ws.getColumn(9).numFmt = '0.000000'; ws.getColumn(10).numFmt = ENTERO;
  ws.getColumn(4).alignment = { wrapText: true, vertical: 'top' };
  ws.getColumn(7).alignment = { wrapText: true, vertical: 'top' };

  const rs = wb.addWorksheet('Resumen por día');
  rs.columns = [{ width: 16 }, { width: 10 }, { width: 16 }, { width: 22 }];
  rs.addRow([`Plan de visitas — ${meta.proyecto || 'Borrador'}`]).font = { bold: true, size: 13 };
  rs.addRow([`Región: ${meta.region} · ${meta.porDia} locales por día · generado el ${meta.fecha}`]);
  rs.addRow([AVISO_VISITAS]).font = { italic: true, color: { argb: 'FF8A3A14' } };
  rs.mergeCells(3, 1, 3, 6); rs.getRow(3).alignment = { wrapText: true }; rs.getRow(3).height = 32;
  rs.addRow([]);
  const cab = rs.addRow(['Día', 'Locales', 'Bienes a reponer', 'Recorrido aprox. (km, línea recta)']);
  encabezado(rs, cab.number, 4);
  for (const d of dias) rs.addRow([`Día ${d.dia}`, d.puntos.length, d.puntos.reduce((a, p) => a + p.rep, 0), Math.round(d.km * 10) / 10]);
  const ini = cab.number + 1, fin = cab.number + dias.length;
  if (dias.length) {
    const t = rs.addRow(['Total',
      { formula: `SUM(B${ini}:B${fin})`, result: dias.reduce((a, d) => a + d.puntos.length, 0) },
      { formula: `SUM(C${ini}:C${fin})`, result: dias.reduce((a, d) => a + d.puntos.reduce((b, p) => b + p.rep, 0), 0) },
      { formula: `SUM(D${ini}:D${fin})`, result: Math.round(dias.reduce((a, d) => a + d.km, 0) * 10) / 10 }]);
    t.font = { bold: true };
  }
  rs.getColumn(3).numFmt = ENTERO; rs.getColumn(4).numFmt = '0.0';
  if (sinCoord.length) {
    rs.addRow([]);
    rs.addRow([`${sinCoord.length} local${sinCoord.length === 1 ? '' : 'es'} sin coordenadas válidas no se agruparon; van al final de la hoja «Visitas».`]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
