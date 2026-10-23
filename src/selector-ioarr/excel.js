// ============================================================================
// src/selector-ioarr/excel.js — Libro de Excel del Selector IOARR (exceljs)
//
// Mismas hojas y columnas que exportXlsx del prototipo:
//   Resumen · Locales (UP) · Por distrito · Por nivel · Servicios · Aulas · Reposición masiva
//   · Estado situacional · Locales por UGEL (formato del expediente de Huánuco)
//   · Excluidos por duplicidad (solo si algún local con otra inversión se excluyó)
// Las columnas de resultado llevan fórmulas (con su resultado ya calculado)
// para que el estudio sea auditable:
//   Aulas:              Existente = B+R+M · A reponer = M · Faltante = MAX(0, Req−Ex)
//   Locales (UP):       Existente = B+R+M · A reponer = M · totales = suma de los 5 tipos
//   Reposición masiva:  Existente = B+R+M · A reponer = M
//   Resumen y Por distrito: SUM y SUMIF de las otras hojas
// Se repone solo lo Malo. El faltante es brecha de dotación, no reposición: va
// aparte y no suma a lo que se repone. Por local es suma por aula (no sale de
// los totales del local), por eso en Locales y Reposición masiva va como valor.
// Se escribe con el writer en streaming: Lima entera son ~1,6 millones de celdas.
// ============================================================================

import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import { ITEMS, NIVN, NIVB, lv, totals, coordValidas, urlGoogleMaps, totalesPorNivel, estadoSituacional, piTexto } from './calculo.js';
import { ROTULO_DUP, ESTADOS_DUP, estadoDe } from './duplicidad.js';

const ESTADO = { b: 'Bueno', r: 'Regular', m: 'Malo' };
const AZUL = 'FF3A63E0';
const ENTERO = '#,##0';
export const FALTANTE = 'Faltante (brecha de dotación, no reposición)';

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
 * @param {object} meta { proyecto, fecha (YYYY-MM-DD), fuente, ioarr: {cui, nombre} | null,
 *                     duplicidad: { [codLocal]: { estado, codigo, nota, excluir } }, excluidos: índices fuera de la propuesta,
 *                     revisiones: { [clave de advertencia]: { nota, fecha } } del cuadro de estado situacional }
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
    'Enlace Google Maps', 'Códigos modulares', 'Instituciones', 'Niveles', 'Gestión', 'Estudiantes (padrón)', 'Secciones (padrón)', 'Aulas en uso (censo)',
    ROTULO_DUP, 'Código de la otra inversión'];
  const colL = h => lBase.indexOf(h) + 1;
  const L_EST = colL('Estudiantes (padrón)'), L_AUL = colL('Aulas en uso (censo)'), L_COD = colL('Código de local');
  const L_LAT = colL('Latitud'), L_LON = colL('Longitud'), L_MAPA = colL('Enlace Google Maps');
  const lEst = ['Existente', 'Bueno', 'Regular', 'Malo', 'A reponer', 'Requerido', 'Faltante'];
  const nE = lEst.length;
  const lCol = (t, k) => lBase.length + 1 + t * nE + lEst.indexOf(k);          // número de columna
  const L_TOT = lBase.length + 5 * nE + 1, L_FAL = L_TOT + 1;
  const ultL = nLoc + 1;
  const sumL = col => `SUM(${HL}!${letra(col)}2:${letra(col)}${ultL})`;

  // ── Resumen ─────────────────────────────────────────────────────────────────
  {
    const ws = wb.addWorksheet('Resumen');
    ws.columns = [48, 22, 12, 12, 12, 12, 12, 12, 16].map(width => ({ width }));
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
    if (meta.excluidos?.length) add(['Locales excluidos por otra inversión vigente o reciente', meta.excluidos.length, 'Ver la hoja «Excluidos por duplicidad»'], fmtN);
    const cuenta = e => list.filter(i => estadoDe(meta.duplicidad, D.locs[i][0]).estado === e).length;
    add([ROTULO_DUP + ' (sí / no / sin verificar)', `${cuenta('si')} / ${cuenta('no')} / ${cuenta('sin_verificar')}`]);
    add(['Estudiantes (padrón)', f(sumL(L_EST), T.est)], fmtN);
    add(['Aulas en uso (censo)', f(sumL(L_AUL), T.aul)], fmtN);
    add(['Bienes a reponer (estado Malo, suma de los muebles de la IOARR)', f(sumL(L_TOT), T.rep)], r => { fmtN(r); r.font = { bold: true }; });
    add([FALTANTE + ', solo informativo', f(sumL(L_FAL), T.fal)], fmtN);
    add([]);
    const cab = add(['Mobiliario por tipo', 'Unidad', 'Existente', 'Bueno', 'Regular', 'Malo', 'A reponer', 'Requerido', FALTANTE]);
    encabezado(ws, cab.number, 9);
    ITEMS.forEach((x, t) => {
      const o = T.t[t], n = cab.number + 1 + t;
      add([x.n, x.u, f(`D${n}+E${n}+F${n}`, o.b + o.r + o.m), f(sumL(lCol(t, 'Bueno')), o.b), f(sumL(lCol(t, 'Regular')), o.r),
        f(sumL(lCol(t, 'Malo')), o.m), f(`F${n}`, o.rep), f(sumL(lCol(t, 'Requerido')), o.req),
        f(sumL(lCol(t, 'Faltante')), o.fal)], r => { for (let c = 3; c <= 9; c++) r.getCell(c).numFmt = ENTERO; r.getCell(7).font = { bold: true }; r.getCell(9).font = { italic: true }; });
    });
    add([]);
    add(['Criterios de cálculo'], sub);
    add(['Muebles de la IOARR', ITEMS.filter(x => !P.muebles || P.muebles.includes(x.k)).map(x => x.n).join(', ') + (P.muebles && P.muebles.length < ITEMS.length ? ' (los demás quedan en 0)' : '')]);
    add(['Puestos por mesa múltiple (Inicial y Básica Especial)', P.kI]);
    add(['Puestos por mesa múltiple (Primaria y Secundaria)', P.kPS]);
    add(['Puestos por carpeta bipersonal', P.carpBip]);
    add(['Estado asignado a las carpetas (vienen sin estado)', ESTADO[P.carpEstado]]);
    add(['Mesas por estudiante', P.mesaEst]);
    add(['Sillas por estudiante', P.sillaEst]);
    add(['Escritorios docentes por aula', P.esc]);
    add(['Sillas docentes por aula', P.sdoc]);
    add(['Armarios o estantes por aula', P.arm]);
    add(['Existente', 'Bueno + Regular + Malo']);
    add(['A reponer', 'Malo. Se repone solo el mobiliario en estado malo; Bueno y Regular se muestran como diagnóstico.']);
    add([FALTANTE, 'Requerido menos Existente, mínimo 0 por aula. No suma a lo que se repone, al costo ni al Formato 07-C: ampliar la dotación no es reposición (Lineamientos IOARR, 2.4.C).']);
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
  }

  // ── Locales (UP) ────────────────────────────────────────────────────────────
  {
    const cab = [...lBase]; ITEMS.forEach(x => lEst.forEach(s => cab.push(x.n + ' – ' + (s === 'Faltante' ? FALTANTE : s)))); cab.push('TOTAL a reponer', 'TOTAL ' + FALTANTE);
    const ws = hoja(wb, 'Locales (UP)', cab, [9, 13, 14, 20, 22, 22, 9, 11, 34, 10, 10, 18, 22, 36, 24, 18, 12, 12, 12, 16, 16]);
    const L_DUP = colL(ROTULO_DUP);
    const repCols = ITEMS.map((_, t) => letra(lCol(t, 'A reponer'))), falCols = ITEMS.map((_, t) => letra(lCol(t, 'Faltante')));
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
      const dup = estadoDe(meta.duplicidad, l[0]);
      r.push(ESTADOS_DUP[dup.estado], dup.codigo || '');
      for (let t = 0; t < 5; t++) {
        const [B, Rg, M] = ['Bueno', 'Regular', 'Malo'].map(k => letra(lCol(t, k)) + n), b = lv(C, 'b', t, i), rg = lv(C, 'r', t, i), m = lv(C, 'm', t, i);
        r.push(f(`${B}+${Rg}+${M}`, b + rg + m), b, rg, m, f(M, lv(C, 'rep', t, i)), lv(C, 'req', t, i), lv(C, 'fal', t, i));
      }
      r.push(f(repCols.map(c => c + n).join('+'), C.L.repTot[i]), f(falCols.map(c => c + n).join('+'), C.L.falTot[i]));
      const row = ws.addRow(r);
      row.getCell(L_TOT).font = { bold: true }; row.getCell(L_FAL).font = { italic: true };
      row.getCell(L_LAT).numFmt = row.getCell(L_LON).numFmt = '0.0000';
      if (url) row.getCell(L_MAPA).font = { color: { argb: AZUL }, underline: true };
      if (dup.estado === 'si') row.getCell(L_DUP).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE2E0' } };
      row.commit();
    }
    ws.commit();
  }

  // ── Por distrito (SUMIF sobre Locales por ubigeo) ─────────────────────────
  {
    const ws = hoja(wb, 'Por distrito', ['Ubigeo', 'Provincia', 'Distrito', 'Locales', 'Estudiantes (padrón)', 'Aulas en uso (censo)', 'Bienes a reponer (Malo)', 'TOTAL ' + FALTANTE],
      [9, 16, 24, 10, 12, 12, 14, 22]);
    const porD = new Map();
    for (const i of list) { const d = D.locs[i][1]; if (!porD.has(d)) porD.set(d, []); porD.get(d).push(i); }
    const rango = col => `${HL}!$${letra(col)}$2:$${letra(col)}$${ultL}`, U = rango(1);
    const sumIf = (col, n, v) => f(`SUMIF(${U},A${n},${rango(col)})`, v);
    let n = 1;
    for (const [d, ls] of [...porD.entries()].sort((a, b) => D.dists[a[0]][1].localeCompare(D.dists[b[0]][1]))) {
      n++;
      const t = totals(D, C, ls), dd = D.dists[d];
      ws.addRow([dd[1], D.provs[dd[2]], dd[0], f(`COUNTIF(${U},A${n})`, ls.length), sumIf(L_EST, n, t.est), sumIf(L_AUL, n, t.aul), sumIf(L_TOT, n, t.rep), sumIf(L_FAL, n, t.fal)]).commit();
    }
    if (n > 1) {
      const tot = (c, v) => f(`SUM(${c}2:${c}${n})`, v);
      const r = ws.addRow(['', '', 'Total', tot('D', T.n), tot('E', T.est), tot('F', T.aul), tot('G', T.rep), tot('H', T.fal)]);
      r.font = { bold: true }; r.commit();
    }
    ws.commit();
  }

  // ── Por nivel (valores: un local con varios niveles cuenta en cada uno) ────
  {
    const ws = hoja(wb, 'Por nivel', ['Nivel', 'Locales', 'Estudiantes (padrón)', 'Aulas en uso (censo)', 'Bueno', 'Regular', 'Malo', 'A reponer (Malo)', 'Requerido', FALTANTE],
      [18, 10, 12, 12, 11, 11, 11, 14, 12, 22]);
    const filas = totalesPorNivel(D, C, list);
    for (const o of filas) ws.addRow([o.nombre, o.n, o.est, o.aul, o.b, o.r, o.m, o.rep, o.req, o.fal]).commit();
    if (filas.length) {
      const n = filas.length + 1, suma = x => filas.reduce((a, o) => a + o[x], 0);
      const r = ws.addRow(['Total', '', ...['est', 'aul', 'b', 'r', 'm', 'rep', 'req', 'fal'].map((x, k) => { const c = letra(3 + k); return f(`SUM(${c}2:${c}${n})`, suma(x)); })]);
      r.font = { bold: true }; r.commit();
    }
    ws.addRow([]).commit();
    ws.addRow(['Un local con varios niveles se cuenta en cada nivel con sus estudiantes y aulas de ese nivel: la columna Locales no suma el total de locales. Con «Una IOARR por nivel», cada fila es una IOARR.']).commit();
    ws.commit();
  }

  // ── Estado situacional (por UGEL y nivel) y locales por UGEL ──────────────
  {
    const E = estadoSituacional(D, C, list, cod => estadoDe(meta.duplicidad, cod).estado);
    const ws = wb.addWorksheet('Estado situacional', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.columns = [16, 34, 10, 14, 12, 12, 12, 12, 18, 14].map(width => ({ width }));
    ws.getCell('A1').value = 'Cuadro de estado situacional del mobiliario escolar por UGEL y nivel'; ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = 'Población: matrícula del padrón de ESCALE. Mobiliario: Censo Educativo 2025, los cinco tipos (mesa en puestos). Un local con varios niveles cuenta en cada nivel.';
    ws.getCell('A2').font = { italic: true, color: { argb: 'FF5C6270' } };
    const cab = ['Nivel', 'UGEL', 'Locales', 'Población de estudiantes', 'N.° de aulas', 'Mobiliario Bueno', 'Mobiliario Regular', 'Mobiliario Malo', 'Cuenta con proyecto de inversión', 'Locales con otra inversión'];
    ws.getRow(3).values = cab; encabezado(ws, 3, cab.length);
    const COLS = ['C', 'D', 'E', 'F', 'G', 'H', 'J'], VAL = o => [o.n, o.est, o.aul, o.b, o.r, o.m];
    let r = 4; const subt = [];
    for (const x of E.niveles) {
      const desde = r;
      for (const f of x.filas) { ws.getRow(r).values = [x.nombre, f.ugel, ...VAL(f), piTexto(f.pi), f.pi.si]; r++; }
      const fr = ws.getRow(r);
      fr.values = [`Subtotal ${x.nombre}`, '', ...COLS.slice(0, 6).map((c, k) => f(`SUM(${c}${desde}:${c}${r - 1})`, VAL(x.subtotal)[k])), piTexto(x.subtotal.pi), f(`SUM(J${desde}:J${r - 1})`, x.subtotal.pi.si)];
      fr.font = { bold: true }; for (let c = 1; c <= 10; c++) fr.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F3F7' } };
      subt.push(r); r++;
    }
    const tr = ws.getRow(r);
    tr.values = ['TOTAL', '', ...COLS.slice(0, 6).map((c, k) => f(subt.map(n => c + n).join('+') || '0', VAL(E.total)[k])), piTexto(E.total.pi), f(subt.map(n => 'J' + n).join('+') || '0', E.total.pi.si)];
    tr.font = { bold: true };
    const filaTotal = r;
    for (let k = 4; k <= r; k++) for (let c = 3; c <= 10; c++) if (c !== 9) ws.getCell(k, c).numFmt = ENTERO;
    r += 2;
    // Comprobación: por UGEL, la suma de sus filas (SUMIF) contra lo contado por local
    ws.getCell(r, 1).value = 'Comprobación por UGEL'; ws.getCell(r, 1).font = { bold: true, color: { argb: AZUL } }; r++;
    ws.getRow(r).values = ['', 'UGEL', 'Locales', 'Población (suma por nivel)', 'Aulas (suma por nivel)', 'Bueno', 'Regular', 'Malo', '¿Coincide con lo contado por local?']; encabezado(ws, r, 9); r++;
    const rango = c => `$${c}$4:$${c}$${filaTotal - 1}`;
    for (const u of E.porUgel) {
      ws.getRow(r).values = ['', u.ugel, u.locales, ...['D', 'E', 'F', 'G', 'H'].map((c, k) => f(`SUMIF(${rango('B')},B${r},${rango(c)})`, [u.est, u.aul, u.b, u.r, u.m][k])), u.ok ? 'Sí' : 'NO'];
      if (!u.ok) ws.getCell(r, 9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3B0' } };
      for (let c = 3; c <= 8; c++) ws.getCell(r, c).numFmt = ENTERO;
      r++;
    }
    r++;
    ws.getCell(r, 1).value = 'Advertencias'; ws.getCell(r, 1).font = { bold: true, color: { argb: AZUL } }; r++;
    if (!E.advertencias.length) { ws.getCell(r, 1).value = 'Sin advertencias: los totales por UGEL suman los totales por nivel y no hay dos UGEL con cifras idénticas.'; r++; }
    for (const a of E.advertencias) {
      const rev = meta.revisiones?.[a.clave];
      ws.getCell(r, 1).value = a.texto;
      ws.getCell(r + 1, 1).value = rev ? `Revisado el ${rev.fecha ? rev.fecha.split('-').reverse().join('/') : '—'}: ${rev.nota}` : 'PENDIENTE: sin explicación.';
      ws.getCell(r + 1, 1).font = { italic: true };
      if (!rev) ws.getCell(r + 1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3B0' } };
      r += 2;
    }
    await ws.commit();

    const wl = wb.addWorksheet('Locales por UGEL', { views: [{ state: 'frozen', ySplit: 1 }] });
    const cabL = ['Código de local', 'Código modular', 'Institución educativa', 'Población', 'Nivel', 'Centro poblado', 'Distrito', 'UGEL'];
    wl.columns = cabL.map((header, k) => ({ header, width: [12, 12, 40, 11, 16, 24, 22, 32][k] }));
    encabezado(wl, 1, cabL.length);
    let n = 1;
    for (const L of E.listas) {
      n++; const h = wl.addRow([L.ugel]); h.font = { bold: true, color: { argb: AZUL } }; h.commit();
      const desde = n + 1;
      for (const x of L.filas) { n++; wl.addRow([x.cod, x.modular, x.inst, x.est, x.nombreNivel, x.cp, x.dist, x.ugel]).commit(); }
      n++; const st = wl.addRow(['', '', `Subtotal ${L.ugel} · ${((n) => n === 1 ? '1 local' : n + ' locales')(new Set(L.filas.map(x => x.cod)).size)}`, f(`SUM(D${desde}:D${n - 1})`, L.filas.reduce((a, x) => a + x.est, 0))]);
      st.font = { bold: true }; st.commit();
    }
    wl.commit();
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
    const cab = [...base]; ITEMS.forEach(x => lEst.forEach(s => cab.push(x.n + ' – ' + (s === 'Faltante' ? FALTANTE : s)))); cab.push('Observaciones');
    const ws = hoja(wb, HA, cab, [11, 11, 30, 14, 10, 6, 8, 16, 8, 14, 11, 10]);
    let n = 1;
    for (const i of list) for (const ai of D.locAul[i]) {
      n++; await respirar(n);
      const a = D.aulas[ai], s = D.svcs[a[1]];
      const r = [D.locs[i][0], s[0], s[1], NIVN[s[2]], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9] ? 'Sí' : 'No'];
      for (let t = 0; t < 5; t++) {
        const c0 = base.length + 1 + t * nE, [EX, B, R, M, , RQ] = [0, 1, 2, 3, 4, 5].map(k => letra(c0 + k) + n);
        const b = A.b[t][ai], rg = A.r[t][ai], m = A.m[t][ai];
        r.push(f(`${B}+${R}+${M}`, b + rg + m), b, rg, m, f(M, A.rep[t][ai]), A.req[t][ai], f(`MAX(0,${RQ}-${EX})`, A.fal[t][ai]));
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
    const ws = hoja(wb, 'Reposición masiva', ['Código de local', 'Instituciones', 'Distrito', 'Tipo de activo', 'Unidad', 'Existente', 'Bueno', 'Regular', 'Malo', 'A reponer', 'Requerido', FALTANTE],
      [12, 40, 22, 24, 10, 10, 10, 10, 10, 10, 10, 22]);
    let n = 1;
    for (const i of list) for (let t = 0; t < 5; t++) {
      const rep = lv(C, 'rep', t, i); if (rep <= 0) continue;
      n++; await respirar(n);
      const b = lv(C, 'b', t, i), rg = lv(C, 'r', t, i), m = lv(C, 'm', t, i);
      const row = ws.addRow([D.locs[i][0], D.locName[i], D.dists[D.locs[i][1]][0], ITEMS[t].n, ITEMS[t].u,
        f(`G${n}+H${n}+I${n}`, b + rg + m), b, rg, m, f(`I${n}`, rep), lv(C, 'req', t, i), lv(C, 'fal', t, i)]);
      row.getCell(10).font = { bold: true }; row.getCell(12).font = { italic: true };
      row.commit();
    }
    ws.commit();
  }

  // ── Excluidos por duplicidad: con otra inversión vigente o reciente ─────────
  if (meta.excluidos?.length) {
    const ws = hoja(wb, 'Excluidos por duplicidad', ['Código de local', 'Instituciones', 'Distrito', 'Estudiantes (padrón)', 'Aulas en uso (censo)', 'Bienes en estado malo (no incluidos)', 'Código de la otra inversión', 'Nota'],
      [12, 40, 22, 12, 12, 16, 18, 50]);
    for (const i of meta.excluidos) {
      const l = D.locs[i], dup = estadoDe(meta.duplicidad, l[0]);
      ws.addRow([l[0], D.locName[i], D.dists[l[1]][0], D.locEst[i], D.locAul[i].length, C.L.repTot[i], dup.codigo || '', dup.nota || '']).commit();
    }
    ws.addRow([]).commit();
    ws.addRow([`Locales con ${ROTULO_DUP.toLowerCase()}, excluidos de la propuesta para evitar duplicidad. No entran en las otras hojas.`]).commit();
    ws.commit();
  }

  await wb.commit();
  await terminado;
  return { buffer: Buffer.concat(partes), totales: T, aulas: nAul };
}
