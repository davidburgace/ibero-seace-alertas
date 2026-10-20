// ============================================================================
// src/selector-ioarr/excel.js — Libro de Excel del Selector IOARR (exceljs)
//
// Mismas hojas y columnas que exportXlsx del prototipo:
//   Resumen · Locales (UP) · Servicios · Aulas · Reposición masiva
// Las columnas de resultado llevan fórmulas (con su resultado ya calculado)
// para que el estudio sea auditable:
//   Aulas:              Existente = B+R+M · Faltante = MAX(0, Req−Ex) · A reponer = M + ROUND(R×%Reg) + Faltante
//   Reposición masiva:  Existente = B+R+M
//   Locales (UP):       TOTAL a reponer = suma de los 5 tipos
//   Resumen:            totales = SUM de las otras hojas
// Faltante y A reponer por local son sumas por aula (no salen de los totales del
// local), por eso en Locales y Reposición masiva van como valor.
// Se escribe con el writer en streaming: Lima entera son ~1,6 millones de celdas.
// ============================================================================

import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import { ITEMS, NIVN, NIVB, lv, totals, coordValidas, urlGoogleMaps } from './calculo.js';

const ESTADO = { b: 'Bueno', r: 'Regular', m: 'Malo' };
const AZUL = 'FF3A63E0';
const ENTERO = '#,##0';

const letra = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const f = (formula, result) => ({ formula, result });
// Cede el turno cada 2000 filas: con Lima entera el Excel tarda segundos y el servidor debe seguir atendiendo
const respirar = n => n % 2000 === 0 ? new Promise(r => setImmediate(r)) : null;

function encabezado(ws, fila, ancho) {
  const r = ws.getRow(fila);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  r.alignment = { vertical: 'middle', wrapText: true };
  for (let c = 1; c <= ancho; c++) r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
  r.height = 32;
}

function hoja(wb, nombre, cabecera, anchos) {
  const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cabecera.map((h, i) => ({ header: h, width: anchos[i] ?? 11 }));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cabecera.length } };
  encabezado(ws, 1, cabecera.length);
  return ws;
}

/**
 * Genera el .xlsx en memoria.
 * @param {object} D  datos de la región ya pasados por prep()
 * @param {object} C  resultado de calc(D, P)
 * @param {object} P  criterios
 * @param {number[]} list índices de los locales seleccionados
 * @param {object} meta { proyecto, fecha (YYYY-MM-DD), fuente, ioarr: {cui, nombre} | null }
 * @returns {Promise<Buffer>}
 */
export async function generarExcel(D, C, P, list, meta) {
  const salida = new PassThrough(), partes = [];
  salida.on('data', c => partes.push(c));
  const terminado = new Promise((ok, mal) => { salida.on('end', ok); salida.on('error', mal); });

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: salida, useStyles: true, useSharedStrings: true });
  wb.creator = 'Radar Ibero — Selector IOARR';
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };

  const A = C.A, T = totals(D, C, list);
  const HL = "'Locales (UP)'", HA = 'Aulas';
  const nLoc = list.length;
  let nAul = 0; for (const i of list) nAul += D.locAul[i].length;

  // ── Columnas de Locales (UP): 19 fijas + 5 tipos × 6 + total ────────────────
  const lBase = ['Ubigeo', 'Departamento', 'Provincia', 'Distrito', 'UGEL', 'Centro poblado', 'Área', 'Código de local', 'Dirección', 'Latitud', 'Longitud',
    'Enlace Google Maps', 'Códigos modulares', 'Instituciones', 'Niveles', 'Gestión', 'Estudiantes (padrón)', 'Secciones (padrón)', 'Aulas en uso (censo)'];
  const colL = h => lBase.indexOf(h) + 1;
  const L_EST = colL('Estudiantes (padrón)'), L_AUL = colL('Aulas en uso (censo)'), L_COD = colL('Código de local');
  const L_LAT = colL('Latitud'), L_LON = colL('Longitud'), L_MAPA = colL('Enlace Google Maps');
  const lEst = ['Bueno', 'Regular', 'Malo', 'Requerido', 'Faltante', 'A reponer'];
  const lCol = (t, k) => lBase.length + 1 + t * 6 + lEst.indexOf(k);          // número de columna
  const L_TOT = lBase.length + 5 * 6 + 1;
  const ultL = nLoc + 1;
  const sumL = col => `SUM(${HL}!${letra(col)}2:${letra(col)}${ultL})`;

  let PCT;   // celda del «% de Regular» en Resumen, la usan las fórmulas de Aulas
  // ── Resumen ─────────────────────────────────────────────────────────────────
  {
    const ws = wb.addWorksheet('Resumen');
    ws.columns = [48, 22, 14, 12, 12, 12, 12, 12, 12].map(width => ({ width }));
    const add = (vals, estilo) => { const r = ws.addRow(vals); if (estilo) estilo(r); return r; };
    const titulo = r => { r.font = { bold: true, size: 14 }; };
    const sub = r => { r.font = { bold: true, color: { argb: AZUL } }; };
    add(['Proyecto IOARR de reposición de mobiliario escolar'], titulo);
    add([]);
    add(['Proyecto', meta.proyecto || '(sin nombre)']);
    add(['Región', D.region]);
    if (meta.ioarr) add(['Vinculado a Radar IOARR', `CUI ${meta.ioarr.cui} — ${meta.ioarr.nombre}`]);
    add(['Fecha de exportación', meta.fecha]);
    const fmtN = r => { r.getCell(2).numFmt = ENTERO; r.getCell(2).alignment = { horizontal: 'left' }; };
    add(['Locales seleccionados', f(`COUNTA(${HL}!${letra(L_COD)}2:${letra(L_COD)}${ultL})`, T.n)], fmtN);
    add(['Estudiantes (padrón)', f(sumL(L_EST), T.est)], fmtN);
    add(['Aulas en uso (censo)', f(sumL(L_AUL), T.aul)], fmtN);
    add(['Bienes a reponer (suma de los 5 tipos)', f(sumL(L_TOT), T.rep)], r => { fmtN(r); r.font = { bold: true }; });
    add([]);
    const cab = add(['Mobiliario por tipo', 'Unidad', 'Requerido', 'Bueno', 'Regular', 'Malo', 'Existente', 'Faltante', 'A reponer']);
    encabezado(ws, cab.number, 9);
    ITEMS.forEach((x, t) => {
      const o = T.t[t], n = cab.number + 1 + t;
      add([x.n, x.u, f(sumL(lCol(t, 'Requerido')), o.req), f(sumL(lCol(t, 'Bueno')), o.b), f(sumL(lCol(t, 'Regular')), o.r),
        f(sumL(lCol(t, 'Malo')), o.m), f(`D${n}+E${n}+F${n}`, o.b + o.r + o.m), f(sumL(lCol(t, 'Faltante')), o.fal),
        f(sumL(lCol(t, 'A reponer')), o.rep)], r => { for (let c = 3; c <= 9; c++) r.getCell(c).numFmt = ENTERO; r.getCell(9).font = { bold: true }; });
    });
    add([]);
    add(['Criterios de cálculo'], sub);
    add(['Puestos por mesa múltiple (Inicial y Básica Especial)', P.kI]);
    add(['Puestos por mesa múltiple (Primaria y Secundaria)', P.kPS]);
    add(['Puestos por carpeta bipersonal', P.carpBip]);
    add(['Estado asignado a las carpetas (vienen sin estado)', ESTADO[P.carpEstado]]);
    // La hoja Aulas usa esta celda en la fórmula de «A reponer»
    const filaPct = add(['% del estado Regular que se repone', P.regPct], r => { r.getCell(2).numFmt = '0%'; r.getCell(2).alignment = { horizontal: 'left' }; }).number;
    add(['Mesas por estudiante', P.mesaEst]);
    add(['Sillas por estudiante', P.sillaEst]);
    add(['Escritorios docentes por aula', P.esc]);
    add(['Sillas docentes por aula', P.sdoc]);
    add(['Armarios o estantes por aula', P.arm]);
    add(['Existente', 'Bueno + Regular + Malo']);
    add(['Faltante', 'Requerido menos Existente, mínimo 0 por aula']);
    add(['A reponer', 'Malo + Faltante + el porcentaje indicado del estado Regular (redondeado por aula)']);
    add(['Requerido', 'Mesa y silla: estudiantes del aula × criterio. Escritorio, silla docente y armario: por aula.']);
    add(['Mesa del estudiante', 'Se cuenta en puestos: mesa unipersonal = 1; mesa múltiple y carpetas según los criterios.']);
    add([]);
    add(['Fuentes'], sub);
    add([meta.fuente || 'Padrón de ESCALE – Minedu, registros al 29/10/2025']);
    add(['Censo Educativo 2025, Local escolar, pregunta 6.1 (aulas y mobiliario)']);
    add([]);
    add(['Limitaciones'], sub);
    add(['Los datos del censo son declarados por cada colegio y no están validados.']);
    add(['Un aula usada por dos niveles o turnos se registra una sola vez, bajo el servicio con más estudiantes; sus estudiantes son el mayor de los turnos.']);
    add(['El censo no informa antigüedad ni costos del mobiliario, que el Formato 07-C pide para reposición.']);
    add(['Alcance: servicios públicos escolarizados de Inicial, Primaria, Secundaria y Básica Especial.']);
    ws.commit();
    PCT = `Resumen!$B$${filaPct}`;
  }

  // ── Locales (UP) ────────────────────────────────────────────────────────────
  {
    const cab = [...lBase]; ITEMS.forEach(x => lEst.forEach(s => cab.push(x.n + ' – ' + s))); cab.push('TOTAL a reponer');
    const ws = hoja(wb, 'Locales (UP)', cab, [9, 13, 14, 20, 22, 22, 9, 11, 34, 10, 10, 18, 22, 36, 24, 18, 12, 12, 12]);
    const repCols = ITEMS.map((_, t) => letra(lCol(t, 'A reponer')));
    let n = 1;
    for (const i of list) {
      n++; await respirar(n);
      const l = D.locs[i], d = D.dists[l[1]], sv = D.locSvc[i].map(si => D.svcs[si]);
      const niv = Object.keys(NIVN).filter(k => D.locNiv[i] & NIVB[k]).map(k => NIVN[k]).join(', ');
      const ges = D.locGes[i] === 3 ? 'Directa y convenio' : D.locGes[i] === 2 ? 'Por convenio' : 'Directa';
      const ok = coordValidas(l[6], l[7]), url = ok ? urlGoogleMaps(l[6], l[7]) : null;
      const r = [d[1], D.region, D.provs[d[2]], d[0], D.ugels[l[2]], l[3], l[4] ? 'Rural' : 'Urbana', l[0], l[5],
        ok ? l[6] : null, ok ? l[7] : null, url ? { text: url, hyperlink: url } : 'Sin coordenadas válidas',
        sv.map(s => s[0]).join(', '), D.locName[i], niv, ges, D.locEst[i], D.locSec[i], D.locAul[i].length];
      for (let t = 0; t < 5; t++) r.push(lv(C, 'b', t, i), lv(C, 'r', t, i), lv(C, 'm', t, i), lv(C, 'req', t, i), lv(C, 'fal', t, i), lv(C, 'rep', t, i));
      r.push(f(repCols.map(c => c + n).join('+'), C.L.repTot[i]));
      const row = ws.addRow(r);
      row.getCell(L_TOT).font = { bold: true };
      row.getCell(L_LAT).numFmt = row.getCell(L_LON).numFmt = '0.0000';
      if (url) row.getCell(L_MAPA).font = { color: { argb: AZUL }, underline: true };
      row.commit();
    }
    ws.commit();
  }

  // ── Servicios ───────────────────────────────────────────────────────────────
  {
    const ws = hoja(wb, 'Servicios', ['Código modular', 'Institución', 'Nivel', 'Código de local', 'Gestión', 'Secciones (padrón)', 'Estudiantes (padrón)', 'Turno (padrón)', 'Aulas (censo)'],
      [12, 36, 16, 12, 14, 12, 12, 14, 12]);
    let n = 1;
    for (const i of list) for (const si of D.locSvc[i]) {
      n++; await respirar(n);
      const s = D.svcs[si];
      ws.addRow([s[0], s[1], NIVN[s[2]], D.locs[i][0], s[4] ? 'Por convenio' : 'Directa', s[5], s[6], s[7], D.svcAulN[si]]).commit();
    }
    ws.commit();
  }

  // ── Aulas (fórmulas por aula) ───────────────────────────────────────────────
  {
    const base = ['Código de local', 'Código modular', 'Institución', 'Nivel', 'Edificación', 'Piso', 'Aula N°', 'Grado', 'Sección', 'Turno', 'Estudiantes', 'Aula compartida'];
    const est = ['Bueno', 'Regular', 'Malo', 'Existente', 'Requerido', 'Faltante', 'A reponer'];
    const cab = [...base]; ITEMS.forEach(x => est.forEach(s => cab.push(x.n + ' – ' + s))); cab.push('Observaciones');
    const ws = hoja(wb, HA, cab, [11, 11, 30, 14, 10, 6, 8, 16, 8, 14, 11, 10]);
    let n = 1;
    for (const i of list) for (const ai of D.locAul[i]) {
      n++; await respirar(n);
      const a = D.aulas[ai], s = D.svcs[a[1]];
      const r = [D.locs[i][0], s[0], s[1], NIVN[s[2]], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9] ? 'Sí' : 'No'];
      for (let t = 0; t < 5; t++) {
        const c0 = base.length + 1 + t * 7, [B, R, M, EX, RQ, FA] = [0, 1, 2, 3, 4, 5].map(k => letra(c0 + k) + n);
        const b = A.b[t][ai], rg = A.r[t][ai], m = A.m[t][ai];
        r.push(b, rg, m, f(`${B}+${R}+${M}`, b + rg + m), A.req[t][ai], f(`MAX(0,${RQ}-${EX})`, A.fal[t][ai]),
          f(`${M}+ROUND(${R}*${PCT},0)+${FA}`, A.rep[t][ai]));
      }
      const ob = [];
      // Prototipo corregido: miraba a[22] (escritorios en buen estado) en vez de las mesas múltiples
      const mm = a[14] + a[15] + a[16];
      if (mm > 0) ob.push(`Mesas múltiples: ${mm} (×${(s[2] === 'I' || s[2] === 'E') ? P.kI : P.kPS} puestos)`);
      if (a[17] + a[18] > 0) ob.push(`Carpetas: ${a[17]} unip., ${a[18]} bip.`);
      if (a[10]) ob.push('Local con más de un servicio de este nivel');
      r.push(ob.join(' | '));
      ws.addRow(r).commit();
    }
    ws.commit();
  }

  // ── Reposición masiva (una fila por local y tipo de bien) ───────────────────
  {
    const ws = hoja(wb, 'Reposición masiva', ['Código de local', 'Instituciones', 'Distrito', 'Tipo de activo', 'Unidad', 'Existente', 'Bueno', 'Regular', 'Malo', 'Requerido', 'Faltante', 'A reponer'],
      [12, 40, 22, 24, 10, 10, 10, 10, 10, 10, 10, 10]);
    let n = 1;
    for (const i of list) for (let t = 0; t < 5; t++) {
      const rep = lv(C, 'rep', t, i); if (rep <= 0) continue;
      n++; await respirar(n);
      const b = lv(C, 'b', t, i), rg = lv(C, 'r', t, i), m = lv(C, 'm', t, i);
      const row = ws.addRow([D.locs[i][0], D.locName[i], D.dists[D.locs[i][1]][0], ITEMS[t].n, ITEMS[t].u,
        f(`G${n}+H${n}+I${n}`, b + rg + m), b, rg, m, lv(C, 'req', t, i), lv(C, 'fal', t, i), rep]);
      row.getCell(12).font = { bold: true };
      row.commit();
    }
    ws.commit();
  }

  await wb.commit();
  await terminado;
  return { buffer: Buffer.concat(partes), totales: T, aulas: nAul };
}
