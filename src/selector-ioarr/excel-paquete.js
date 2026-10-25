// ============================================================================
// src/selector-ioarr/excel-paquete.js — Listado de UP y activos, y consolidado por UGEL y nivel
// (paquete de adjuntos tipo IOARR masiva aprobada, Huánuco 2023). Un libro por IOARR (nivel).
//
// Hojas:
//   UP y activos               código de local, nombre, ubigeo, centro poblado, coordenadas, activo,
//                              metas del local y UGEL responsable del mantenimiento
//   Consolidado UGEL y nivel   población, aulas, mobiliario Bueno / Regular / Malo y colegios con y
//                              sin proyecto de inversión (columna de duplicación)
// La oferta (uso interno) no entra.
// ============================================================================

import ExcelJS from 'exceljs';

const AZUL = 'FF3A63E0', GRIS = 'FFF1F3F7', AMARILLO = 'FFFFF3B0', ENTERO = '#,##0';
const relleno = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
function cabecera(ws, fila, ancho) {
  const r = ws.getRow(fila);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } }; r.alignment = { vertical: 'middle', wrapText: true }; r.height = 34;
  for (let c = 1; c <= ancho; c++) r.getCell(c).fill = relleno(AZUL);
}
const titulo = (ws, t, sub) => {
  ws.getCell('A1').value = t; ws.getCell('A1').font = { bold: true, size: 14 };
  if (sub) { ws.getCell('A2').value = sub; ws.getCell('A2').font = { italic: true, color: { argb: 'FF5C6270' } }; }
};

/**
 * @param P  { ups: [fila], metas: [{ k, nombre, unidad }], consolidado: { filas, total } }  (modeloIoarr: M.paquete)
 * @param meta { proyecto, nombreIoarr, fecha }
 */
export async function generarExcelPaquete(P, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Radar Ibero — Expediente IOARR'; wb.created = new Date();

  // ── UP y activos ──
  {
    const ws = wb.addWorksheet('UP y activos', { views: [{ state: 'frozen', ySplit: 4, xSplit: 2 }] });
    const cols = [['Código de local', 11], ['Institución educativa', 36], ['Ubigeo', 9], ['Departamento', 14], ['Provincia', 18], ['Distrito', 20], ['Centro poblado', 22],
      ['Latitud', 11], ['Longitud', 11], ['Activo', 20], ...P.metas.map(m => [`${m.nombre} (${m.unidad})`, 14]), ['UGEL responsable del mantenimiento', 32]];
    ws.columns = cols.map(([, width]) => ({ width }));
    titulo(ws, `Listado de unidades productoras y activos${meta.nombreIoarr ? ' — IOARR ' + meta.nombreIoarr : ''}`,
      'Unidades productoras (locales educativos) con bienes a reponer. Coordenadas del padrón de ESCALE; vacías si el padrón no trae coordenadas válidas.');
    ws.getRow(4).values = cols.map(([t]) => t); cabecera(ws, 4, cols.length);
    P.ups.forEach((u, j) => {
      const r = ws.getRow(5 + j);
      r.values = [u.cod, u.nombre, u.ubigeo, u.dpto, u.prov, u.dist, u.cp, u.lat ?? '', u.lon ?? '', 'MOBILIARIO DE AULA', ...P.metas.map(m => u.metas[m.k] ?? 0), u.ugel || ''];
      P.metas.forEach((_, k) => { r.getCell(11 + k).numFmt = ENTERO; });
      if (u.lat == null) for (const c of [8, 9]) r.getCell(c).fill = relleno(AMARILLO);
    });
    const t = ws.getRow(5 + P.ups.length);
    t.values = ['TOTAL', `${P.ups.length} UP`, '', '', '', '', '', '', '', '', ...P.metas.map((_, k) => {
      const c = String.fromCharCode(75 + k); return { formula: `SUM(${c}5:${c}${4 + P.ups.length})`, result: P.ups.reduce((a, u) => a + (u.metas[P.metas[k].k] ?? 0), 0) };
    })];
    t.font = { bold: true }; P.metas.forEach((_, k) => { t.getCell(11 + k).numFmt = ENTERO; });
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
  }

  // ── Consolidado por UGEL y nivel ──
  {
    const ws = wb.addWorksheet('Consolidado UGEL y nivel', { views: [{ state: 'frozen', ySplit: 4 }] });
    const cols = [['Nivel', 14], ['UGEL', 32], ['Colegios', 10], ['Población (padrón)', 13], ['N.° de aulas', 11], ['Mobiliario Bueno', 12], ['Mobiliario Regular', 12], ['Mobiliario Malo', 12],
      ['Colegios con proyecto de inversión', 14], ['Colegios sin proyecto de inversión', 14], ['Sin verificar', 11]];
    ws.columns = cols.map(([, width]) => ({ width }));
    titulo(ws, 'Consolidado del mobiliario escolar por UGEL y nivel',
      'Población: matrícula del padrón de ESCALE. Mobiliario: Censo Educativo (mesa en puestos). «Con proyecto de inversión»: otra inversión vigente o reciente, inversión en ejecución o entrega de mobiliario de los últimos 3 años.');
    ws.getRow(4).values = cols.map(([t]) => t); cabecera(ws, 4, cols.length);
    const fila = (r, nivel, ugel, o, bold) => {
      const row = ws.getRow(r);
      row.values = [nivel, ugel, o.n, o.est, o.aul, o.b, o.r, o.m, o.pi.si, o.pi.no, o.pi.sin_verificar];
      for (let c = 3; c <= 11; c++) row.getCell(c).numFmt = ENTERO;
      if (bold) { row.font = { bold: true }; for (let c = 1; c <= 11; c++) row.getCell(c).fill = relleno(GRIS); }
    };
    let r = 5;
    for (const x of P.consolidado.niveles) {
      for (const f of x.filas) fila(r++, x.nombre, f.ugel, f);
      fila(r++, `Subtotal ${x.nombre}`, '', x.subtotal, true);
    }
    fila(r, 'TOTAL', '', P.consolidado.total, true);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
