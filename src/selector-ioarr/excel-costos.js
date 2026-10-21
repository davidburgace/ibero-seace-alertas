// ============================================================================
// src/selector-ioarr/excel-costos.js — Excel de la estructura de costos (exceljs)
//
// Hojas: Resumen · Parámetros · Partidas · Metrado y costos por local · Por distrito
//        · Inventario verificado (solo si algún local se corrigió con una visita de campo)
// Todo lo que se calcula es una fórmula de Excel (con su resultado ya puesto),
// para que el evaluador pueda auditar cada cifra:
//   - Parámetros: precios unitarios, rubros (modo, valor, base) y UIT. Si se
//     cambia un precio, un % o la UIT ahí, todo el libro se recalcula.
//   - Metrado y costos por local: una fila por local con la reposición por tipo
//     de bien, el costo directo y cada rubro; la última fila suma.
//   - Partidas, Resumen y Por distrito leen esas sumas.
// El metrado (cantidades) va como valor: sale del cálculo por aula del Selector
// (su Excel trae la hoja Aulas con esas fórmulas).
// ============================================================================

import ExcelJS from 'exceljs';
import { ITEMS } from './calculo.js';
import { RUBROS, BASES, FUENTES_PRECIO, LIMITE_UIT, TIPOS_ARCHIVO } from './costos.js';

const AZUL = 'FF3A63E0', AMARILLO = 'FFFFF3B0', GRIS = 'FFF1F3F7';
const SOLES = '"S/ "#,##0.00', ENTERO = '#,##0', PCT = '0.00%';
const letra = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const f = (formula, result) => ({ formula, result });
const HP = 'Parámetros', HM = "'Metrado y costos por local'", HPa = 'Partidas';

function cabecera(ws, fila, ancho) {
  const r = ws.getRow(fila);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  r.alignment = { vertical: 'middle', wrapText: true };
  for (let c = 1; c <= ancho; c++) r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
  r.height = 34;
}
const fechaPe = s => s ? String(s).split('-').reverse().join('/') : '';
const resaltar = (cell, argb) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; };

/**
 * @param {object} R    resultado de costear()
 * @param {object} meta { proyecto, region, fecha, fuente, criterios: texto, precios: {mesa: {descripcion, fuente, fecha, observacion}},
 *                      inventario: { [codLocal]: fila de ioarr_expediente_inventario } }
 * @returns {Promise<Buffer>}
 */
export async function generarExcelCostos(R, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Radar Ibero — Expediente IOARR';
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };

  const wsRes = wb.addWorksheet('Resumen');
  const wsPar = wb.addWorksheet(HP);
  const wsPa = wb.addWorksheet(HPa);
  const wsM = wb.addWorksheet('Metrado y costos por local', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  const wsD = wb.addWorksheet('Por distrito', { views: [{ state: 'frozen', ySplit: 1 }] });
  const verificados = R.locales.filter(l => l.verificado);
  const anioExport = Number(String(meta.fecha || '').slice(0, 4)) || new Date().getFullYear();
  const wsI = verificados.length ? wb.addWorksheet('Inventario verificado', { views: [{ state: 'frozen', ySplit: 3 }] }) : null;

  const T = R.totales, L = R.locales, n = L.length;

  // ── Parámetros ──────────────────────────────────────────────────────────────
  const celPU = [], celRub = {};
  let celUit, celAnio, celLim;
  {
    const ws = wsPar;
    ws.columns = [34, 16, 20, 40, 18, 12, 40].map(width => ({ width }));
    ws.getCell('A1').value = 'Parámetros de costos'; ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = 'Cambia un valor de la columna C y el libro se recalcula. Las celdas amarillas están sin cargar.';
    ws.getCell('A2').font = { italic: true, color: { argb: 'FF5C6270' } };
    ws.getRow(4).values = ['Tipo de bien', 'Unidad', 'Precio unitario sin IGV (S/)', 'Descripción', 'Fuente', 'Fecha', 'Observación'];
    cabecera(ws, 4, 7);
    ITEMS.forEach((x, t) => {
      const fila = 5 + t, p = R.partidas[t], m = meta.precios?.[x.k] || {};
      ws.getRow(fila).values = [x.n, x.u, p.pu ?? 0, m.descripcion || '', FUENTES_PRECIO[m.fuente] || m.fuente || '', m.fecha || '', m.observacion || ''];
      const c = ws.getCell(fila, 3); c.numFmt = SOLES;
      if (p.pu == null) { resaltar(c, AMARILLO); ws.getCell(fila, 7).value = 'PENDIENTE: sin precio cargado'; }
      celPU.push(`${HP}!$C$${fila}`);
    });

    const f0 = 12;
    ws.getRow(f0).values = ['Rubro', 'Modo', 'Valor', 'Base de cálculo', 'Factor por zona'];
    cabecera(ws, f0, 5);
    R.rubros.forEach((x, j) => {
      const fila = f0 + 1 + j, def = RUBROS.find(r => r.clave === x.clave);
      ws.getRow(fila).values = [x.nombre, x.modo === 'pct' ? 'Porcentaje' : 'Monto fijo', x.modo === 'pct' ? x.valor / 100 : x.valor,
        BASES[x.base], def.zona === 'flete' ? 'Sí, % de flete' : def.zona === 'instalacion' ? 'Sí, % de instalación' : 'No'];
      ws.getCell(fila, 3).numFmt = x.modo === 'pct' ? PCT : SOLES;
      celRub[x.clave] = { modo: `${HP}!$B$${fila}`, valor: `${HP}!$C$${fila}` };
    });
    const fn = f0 + R.rubros.length + 2;
    ws.getCell(fn, 1).value = 'Modo: «Porcentaje» aplica el % sobre la base de cada local; «Monto fijo» reparte el monto entre los locales en proporción a su base. Cambiar la base requiere volver a exportar.';
    ws.getCell(fn, 1).font = { italic: true, color: { argb: 'FF5C6270' } };

    const fu = fn + 2;
    ws.getRow(fu).values = ['UIT', 'Valor']; cabecera(ws, fu, 2);
    ws.getRow(fu + 1).values = ['Año de la UIT', R.uit.anio ?? ''];
    ws.getRow(fu + 2).values = ['Valor de la UIT (S/)', R.uit.valor ?? 0];
    ws.getCell(fu + 2, 2).numFmt = SOLES;
    if (!R.uit.valor) resaltar(ws.getCell(fu + 2, 2), AMARILLO);
    ws.getRow(fu + 3).values = ['Límite para el registro abreviado del 07-C (UIT)', LIMITE_UIT];
    celAnio = `${HP}!$B$${fu + 1}`; celUit = `${HP}!$B$${fu + 2}`; celLim = `${HP}!$B$${fu + 3}`;
  }

  // ── Metrado y costos por local ──────────────────────────────────────────────
  // Columnas
  const C = {};
  const cab = [];
  const col = (clave, titulo, ancho = 14) => { cab.push({ titulo, ancho }); C[clave] = cab.length; };
  col('cod', 'Código de local', 12); col('nom', 'Instituciones', 40); col('ubigeo', 'Ubigeo', 9); col('prov', 'Provincia', 18); col('dist', 'Distrito', 20);
  col('area', 'Área', 9); col('est', 'Estudiantes (padrón)', 12); col('aul', 'Aulas en uso (censo)', 11);
  col('inv', 'Inventario', 16);
  col('zf', 'Factor de zona: flete', 11); col('zi', 'Factor de zona: instalación', 12);
  ITEMS.forEach((x, t) => col('q' + t, `${x.n} – reposición (${x.u})`, 13));
  ITEMS.forEach((x, t) => col('cd' + t, `${x.n} – costo directo (S/)`, 15));
  col('cd', 'Costo directo (S/)', 16);
  const rub = k => R.rubros.find(r => r.clave === k);
  for (const k of ['transporte', 'instalacion', 'embalaje']) col(k, rub(k).nombre + ' (S/)', 15);
  col('subtotal', 'Subtotal (S/)', 16);
  for (const k of ['gg', 'utilidad']) col(k, rub(k).nombre + ' (S/)', 15);
  col('neto', 'Subtotal + GG + utilidad (S/)', 16);
  col('igv', 'IGV (S/)', 15);
  col('bienes', 'Costo de los bienes con IGV (S/)', 17);
  for (const k of ['supervision', 'expediente', 'gestion', 'imprevistos']) col(k, rub(k).nombre + ' (S/)', 15);
  col('total', 'TOTAL INVERSIÓN (S/)', 18);
  ITEMS.forEach((x, t) => col('fq' + t, `${x.n} – faltante (${x.u}), no incluido`, 13));
  col('fv', 'Faltante valorizado, referencial (S/)', 17);

  const ws = wsM;
  ws.columns = cab.map(c => ({ header: c.titulo, width: c.ancho }));
  cabecera(ws, 1, cab.length);
  const ini = 2, fin = n + 1, TOT = n + 2;
  const A = (k, fila) => letra(C[k]) + fila;
  const totDe = k => `$${letra(C[k])}$${TOT}`;
  const baseCol = { cd: 'cd', subtotal: 'subtotal', neto: 'neto', bienes: 'bienes' };
  const nLoc = `COUNTA($${letra(C.cod)}$${ini}:$${letra(C.cod)}$${fin})`;

  // Fórmula de un rubro en la fila r
  const fRubro = (k, r, zona) => {
    const x = rub(k), b = A(baseCol[x.base], r), cr = celRub[k];
    const core = `IF(${cr.modo}="Porcentaje",${b}*${cr.valor},IF(${totDe(baseCol[x.base])}=0,${cr.valor}/${nLoc},${cr.valor}*${b}/${totDe(baseCol[x.base])}))`;
    return zona ? `${core}*(1+${A(zona, r)})` : core;
  };

  L.forEach((l, j) => {
    const r = ini + j, v = [];
    v[C.cod] = l.cod; v[C.nom] = l.nom; v[C.ubigeo] = l.ubigeo; v[C.prov] = l.prov; v[C.dist] = l.dist;
    v[C.inv] = l.verificado ? `Verificado en campo ${fechaPe(l.verificado.fecha_visita)}` : 'Censo Educativo';
    v[C.area] = l.rural ? 'Rural' : 'Urbana'; v[C.est] = l.est; v[C.aul] = l.aul; v[C.zf] = l.zona.flete; v[C.zi] = l.zona.instalacion;
    ITEMS.forEach((_, t) => { v[C['q' + t]] = l.rep[t]; v[C['cd' + t]] = f(`${A('q' + t, r)}*${celPU[t]}`, l.cdTipo[t]); });
    v[C.cd] = f(`SUM(${A('cd0', r)}:${A('cd4', r)})`, l.cd);
    v[C.transporte] = f(fRubro('transporte', r, 'zf'), l.r.transporte);
    v[C.instalacion] = f(fRubro('instalacion', r, 'zi'), l.r.instalacion);
    v[C.embalaje] = f(fRubro('embalaje', r), l.r.embalaje);
    v[C.subtotal] = f(`${A('cd', r)}+${A('transporte', r)}+${A('instalacion', r)}+${A('embalaje', r)}`, l.subtotal);
    v[C.gg] = f(fRubro('gg', r), l.r.gg);
    v[C.utilidad] = f(fRubro('utilidad', r), l.r.utilidad);
    v[C.neto] = f(`${A('subtotal', r)}+${A('gg', r)}+${A('utilidad', r)}`, l.neto);
    v[C.igv] = f(fRubro('igv', r), l.r.igv);
    v[C.bienes] = f(`${A('neto', r)}+${A('igv', r)}`, l.bienes);
    for (const k of ['supervision', 'expediente', 'gestion', 'imprevistos']) v[C[k]] = f(fRubro(k, r), l.r[k]);
    v[C.total] = f(`${A('bienes', r)}+${A('supervision', r)}+${A('expediente', r)}+${A('gestion', r)}+${A('imprevistos', r)}`, l.total);
    ITEMS.forEach((_, t) => { v[C['fq' + t]] = l.fal[t]; });
    v[C.fv] = f(ITEMS.map((_, t) => `${A('fq' + t, r)}*${celPU[t]}`).join('+'), l.falValor);
    ws.getRow(r).values = v;
  });

  // Fila de totales
  {
    const v = []; v[C.cod] = 'TOTAL';
    const sumables = Object.keys(C).filter(k => !['cod', 'nom', 'ubigeo', 'prov', 'dist', 'area', 'inv', 'zf', 'zi'].includes(k));
    const resultado = {
      est: T.est, aul: T.aul, cd: T.cd, subtotal: T.subtotal, neto: T.neto, bienes: T.bienes, total: T.total, fv: T.falValor,
      ...Object.fromEntries(R.rubros.map(x => [x.clave, x.monto])),
      ...Object.fromEntries(ITEMS.flatMap((_, t) => [['q' + t, R.partidas[t].rep], ['cd' + t, R.partidas[t].parcial], ['fq' + t, R.partidas[t].fal]]))
    };
    for (const k of sumables) v[C[k]] = f(`SUM(${A(k, ini)}:${A(k, fin)})`, resultado[k]);
    const row = ws.getRow(TOT); row.values = v; row.font = { bold: true };
    for (let c = 1; c <= cab.length; c++) resaltar(row.getCell(c), GRIS);
  }
  // Formatos por columna
  for (let r = ini; r <= TOT; r++) {
    const row = ws.getRow(r);
    for (const k of ['est', 'aul', ...ITEMS.flatMap((_, t) => ['q' + t, 'fq' + t])]) row.getCell(C[k]).numFmt = ENTERO;
    for (const k of ['zf', 'zi']) row.getCell(C[k]).numFmt = PCT;
    for (let c = C.cd0; c <= C.total; c++) row.getCell(c).numFmt = SOLES;
    row.getCell(C.fv).numFmt = SOLES;
    row.getCell(C.total).font = { bold: true };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cab.length } };
  const MT = k => `${HM}!${totDe(k)}`;

  // ── Partidas ────────────────────────────────────────────────────────────────
  let celCD, celFal;
  {
    const ws = wsPa;
    ws.columns = [32, 12, 16, 20, 20, 4, 16, 22].map(width => ({ width }));
    ws.getRow(1).values = ['Partida', 'Unidad', 'Metrado (reposición)', 'Precio unitario sin IGV (S/)', 'Parcial (S/)', '', 'Faltante, no incluido', 'Faltante valorizado, referencial (S/)'];
    cabecera(ws, 1, 8);
    R.partidas.forEach((p, t) => {
      const r = 2 + t;
      ws.getRow(r).values = [p.n, p.u, f(MT('q' + t), p.rep), f(celPU[t], p.pu ?? 0), f(`C${r}*D${r}`, p.parcial), '', f(MT('fq' + t), p.fal), f(`G${r}*D${r}`, p.falValor)];
      for (const c of [3, 7]) ws.getCell(r, c).numFmt = ENTERO;
      for (const c of [4, 5, 8]) ws.getCell(r, c).numFmt = SOLES;
      if (p.pu == null) resaltar(ws.getCell(r, 4), AMARILLO);
    });
    const r = 2 + ITEMS.length;
    ws.getRow(r).values = ['Costo directo', '', f(`SUM(C2:C${r - 1})`, T.rep), '', f(`SUM(E2:E${r - 1})`, T.cd), '', f(`SUM(G2:G${r - 1})`, T.fal), f(`SUM(H2:H${r - 1})`, T.falValor)];
    ws.getRow(r).font = { bold: true };
    for (const c of [3, 7]) ws.getCell(r, c).numFmt = ENTERO;
    for (const c of [5, 8]) ws.getCell(r, c).numFmt = SOLES;
    ws.getCell(r + 2, 1).value = 'Control: el costo directo de esta hoja debe ser igual al de la hoja «Metrado y costos por local».';
    ws.getCell(r + 3, 1).value = 'Diferencia (debe ser 0)';
    ws.getCell(r + 3, 5).value = f(`ROUND(E${r}-${MT('cd')},2)`, 0); ws.getCell(r + 3, 5).numFmt = SOLES;
    celCD = `${HPa}!$E$${r}`; celFal = `${HPa}!$H$${r}`;
  }

  // ── Resumen ─────────────────────────────────────────────────────────────────
  {
    const ws = wsRes;
    ws.columns = [54, 22, 50].map(width => ({ width }));
    const add = (vals, estilo) => { const r = ws.addRow(vals); if (estilo) estilo(r); return r; };
    const sub = r => { r.font = { bold: true, color: { argb: AZUL } }; };
    const soles = r => { r.getCell(2).numFmt = SOLES; };
    add(['Estructura de costos — IOARR de reposición de mobiliario escolar'], r => { r.font = { bold: true, size: 14 }; });
    add([]);
    add(['Proyecto', meta.proyecto || '(sin nombre)']);
    add(['Región', meta.region]);
    if (meta.ioarr) add(['Vinculado a Radar IOARR', `CUI ${meta.ioarr.cui} — ${meta.ioarr.nombre}`]);
    add(['Fecha de exportación', meta.fecha]);
    const filaLoc = add(['Locales (unidades productoras)', f(`COUNTA(${HM}!$A$${ini}:$A$${fin})`, T.locales)], r => { r.getCell(2).numFmt = ENTERO; }).number;
    const filaEst = add(['Estudiantes (padrón)', f(MT('est'), T.est)], r => { r.getCell(2).numFmt = ENTERO; }).number;
    add(['Bienes a reponer (reposición, 5 tipos)', f(`SUM(${HPa}!C2:C${1 + ITEMS.length})`, T.rep)], r => { r.getCell(2).numFmt = ENTERO; });
    add([]);
    const c = add(['Estructura de costos', 'Monto (S/)', 'Cómo se calcula']); cabecera(ws, c.number, 3);
    const minus = s => s[0].toLowerCase() + s.slice(1);
    const desc = x => x.modo === 'pct' ? `${x.valor.toLocaleString('es-PE')} % sobre ${minus(BASES[x.base])}` : `Monto fijo, repartido en proporción al ${minus(BASES[x.base])}`;
    const linea = (txt, formula, val, como, negrita) => add([txt, f(formula, val), como], r => { soles(r); if (negrita) r.font = { bold: true }; });
    linea('Costo directo (bienes a reponer × precio unitario)', celCD, T.cd, 'Hoja Partidas', true);
    for (const k of ['transporte', 'instalacion', 'embalaje']) { const x = rub(k); linea('  ' + x.nombre, MT(k), x.monto, desc(x) + (k !== 'embalaje' ? ', × (1 + factor de zona)' : '')); }
    linea('Subtotal', MT('subtotal'), T.subtotal, 'CD + transporte + instalación + embalaje', true);
    for (const k of ['gg', 'utilidad']) { const x = rub(k); linea('  ' + x.nombre, MT(k), x.monto, desc(x)); }
    linea('Subtotal + gastos generales + utilidad', MT('neto'), T.neto, '', true);
    { const x = rub('igv'); linea('  IGV', MT('igv'), x.monto, desc(x)); }
    linea('Costo de los bienes (con IGV)', MT('bienes'), T.bienes, '', true);
    for (const k of ['supervision', 'expediente', 'gestion', 'imprevistos']) { const x = rub(k); linea('  ' + x.nombre, MT(k), x.monto, desc(x)); }
    const filaTot = add(['TOTAL DE INVERSIÓN', f(MT('total'), T.total), 'Costo de los bienes + supervisión + expediente + gestión + imprevistos'], r => { soles(r); r.font = { bold: true, size: 12 }; }).number;
    add(['Costo por estudiante', f(`IFERROR(B${filaTot}/B${filaEst},0)`, T.porEstudiante ?? 0), 'Total ÷ estudiantes del padrón'], soles);
    add(['Costo por local (promedio)', f(`IFERROR(B${filaTot}/B${filaLoc},0)`, T.locales ? T.total / T.locales : 0), 'Total ÷ locales'], soles);
    add([]);
    add(['Formato 07-C: registro abreviado o completo'], sub);
    add(['Año de la UIT', f(celAnio, R.uit.anio ?? '')]);
    add(['Valor de la UIT', f(celUit, R.uit.valor ?? 0)], soles);
    add(['Límite: 75 UIT', f(`${celLim}*${celUit}`, R.uit.limite ?? 0)], soles);
    add(['Total de inversión en UIT', f(`IFERROR(B${filaTot}/${celUit},0)`, R.uit.enUit ?? 0)], r => { r.getCell(2).numFmt = '#,##0.00'; });
    const reg = R.uit.valor ? (R.uit.supera ? 'COMPLETO: supera 75 UIT (secciones D, E y F)' : 'ABREVIADO: hasta 75 UIT (sección G)') : 'PENDIENTE: falta el valor de la UIT';
    add(['Registro que corresponde', f(`IF(${celUit}<=0,"PENDIENTE: falta el valor de la UIT",IF(B${filaTot}>${celLim}*${celUit},"COMPLETO: supera 75 UIT (secciones D, E y F)","ABREVIADO: hasta 75 UIT (sección G)"))`, reg)],
      r => { r.font = { bold: true }; if (R.uit.supera || !R.uit.valor) resaltar(r.getCell(2), AMARILLO); });
    add([]);
    add(['Faltante (no incluido en el total)'], sub);
    add(['Faltante valorizado, referencial', f(celFal, T.falValor), 'Bienes por encima de los existentes × precio unitario'], soles);
    add(['El faltante amplía la capacidad de la UP. Según los Lineamientos IOARR del MEF (2.4.C), una reposición no puede sustentarse en un incremento de capacidad: corresponde evaluarlo como ampliación marginal.']);
    add([]);
    add(['Criterios del metrado'], sub);
    add([meta.criterios || '']);
    add(['Reposición = Malo + el % indicado del estado Regular (redondeado por aula). Faltante = Requerido − Existente, mínimo 0 por aula.']);
    add([]);
    add(['Fuentes'], sub);
    add([meta.fuente || 'Padrón de ESCALE – Minedu, registros al 29/10/2025']);
    add(['Censo Educativo 2025, Local escolar, pregunta 6.1 (aulas y mobiliario)']);
    add(['Son datos declarados por cada colegio y no están validados.']);
    if (verificados.length) add([`En ${verificados.length === 1 ? '1 local' : verificados.length + ' locales'} el mobiliario se reemplazó por el inventario verificado en campo (hoja «Inventario verificado»).`]);
    add(['Los precios unitarios, los porcentajes de los rubros y la UIT los cargó el usuario (hoja Parámetros).']);
  }

  // ── Por distrito ────────────────────────────────────────────────────────────
  {
    const ws = wsD;
    ws.columns = [10, 22, 24, 10, 14, 16, 18, 18, 18].map(width => ({ width }));
    ws.getRow(1).values = ['Ubigeo', 'Provincia', 'Distrito', 'Locales', 'Estudiantes', 'Bienes a reponer', 'Costo directo (S/)', 'Total de inversión (S/)', 'Costo por estudiante (S/)'];
    cabecera(ws, 1, 9);
    const rango = k => `${HM}!$${letra(C[k])}$${ini}:$${letra(C[k])}$${fin}`;
    const crit = `${HM}!$${letra(C.ubigeo)}$${ini}:$${letra(C.ubigeo)}$${fin}`;
    R.distritos.forEach((d, j) => {
      const r = 2 + j;
      ws.getRow(r).values = [d.ubigeo, d.prov, d.nom,
        f(`COUNTIF(${crit},A${r})`, d.n), f(`SUMIF(${crit},A${r},${rango('est')})`, d.est),
        f(ITEMS.map((_, t) => `SUMIF(${crit},A${r},${rango('q' + t)})`).join('+'), d.rep),
        f(`SUMIF(${crit},A${r},${rango('cd')})`, d.cd), f(`SUMIF(${crit},A${r},${rango('total')})`, d.total),
        f(`IFERROR(H${r}/E${r},0)`, d.porEstudiante ?? 0)];
    });
    const r = 2 + R.distritos.length;
    ws.getRow(r).values = ['TOTAL', '', '', f(`SUM(D2:D${r - 1})`, T.locales), f(`SUM(E2:E${r - 1})`, T.est), f(`SUM(F2:F${r - 1})`, T.rep),
      f(`SUM(G2:G${r - 1})`, T.cd), f(`SUM(H2:H${r - 1})`, T.total), f(`IFERROR(H${r}/E${r},0)`, T.porEstudiante ?? 0)];
    ws.getRow(r).font = { bold: true };
    for (let k = 2; k <= r; k++) {
      for (const c of [4, 5, 6]) ws.getCell(k, c).numFmt = ENTERO;
      for (const c of [7, 8, 9]) ws.getCell(k, c).numFmt = SOLES;
    }
  }

  // ── Inventario verificado en campo ──────────────────────────────────────────
  if (wsI) {
    const ws = wsI;
    ws.columns = [12, 36, 22, 9, 9, 9, 9, 9, 9, 11, 12, 11, 12, 22, 50, 50, 12, 12].map(width => ({ width }));
    ws.getCell('A1').value = 'Inventario verificado en campo'; ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = 'Reemplaza lo que reporta el Censo Educativo en estos locales y tipos de bien. Reposición = Malo + % de Regular; faltante = Requerido − Existente, por local.';
    ws.getCell('A2').font = { italic: true, color: { argb: 'FF5C6270' } };
    ws.getRow(3).values = ['Código de local', 'Instituciones', 'Tipo de bien', 'Censo: bueno', 'Censo: regular', 'Censo: malo',
      'Campo: bueno', 'Campo: regular', 'Campo: malo', 'Requerido', 'Reposición', 'Faltante', 'Fecha de visita', 'Responsable', 'Sustento', 'Archivos adjuntos', 'Año de adquisición', 'Antigüedad (años)'];
    cabecera(ws, 3, 18);
    let r = 4;
    for (const l of verificados) {
      const inv = meta.inventario?.[l.cod] || {};
      const arch = inv.archivos || [];
      const resumen = arch.length ? Object.entries(TIPOS_ARCHIVO).map(([k, n]) => [n, arch.filter(a => a.tipo === k)]).filter(([, xs]) => xs.length)
        .map(([n, xs]) => `${n} (${xs.length}): ${xs.map(a => a.nombre_archivo).join(', ')}`).join(' · ') : 'PENDIENTE: sin archivos adjuntos';
      const adq = l.verificado.adquisicion || {};
      // Tipos corregidos en campo y tipos con año de adquisición (en estos, las cantidades siguen siendo las del censo)
      const tiposFila = ITEMS.map(x => x.k).filter(k => l.verificado.tipos.includes(k) || adq[k]);
      for (const k of tiposFila) {
        const t = ITEMS.findIndex(x => x.k === k), c = inv.censo?.[k] || {}, corr = l.verificado.tipos.includes(k), v = corr ? inv.bienes?.[k] || {} : {};
        ws.getRow(r).values = [l.cod, l.nom, ITEMS[t].n, c.b ?? '', c.r ?? '', c.m ?? '', corr ? v.b : 'censo', corr ? v.r : 'censo', corr ? v.m : 'censo', c.req ?? '',
          l.rep[t], l.fal[t], fechaPe(l.verificado.fecha_visita), l.verificado.responsable || '', l.verificado.observacion, resumen,
          adq[k] || '', adq[k] ? f(`IF(Q${r}="","",${anioExport}-Q${r})`, anioExport - adq[k]) : ''];
        for (let k2 = 4; k2 <= 12; k2++) ws.getCell(r, k2).numFmt = ENTERO;
        for (const k2 of [7, 8, 9]) resaltar(ws.getCell(r, k2), GRIS);
        for (const k2 of [15, 16]) ws.getCell(r, k2).alignment = { wrapText: true, vertical: 'top' };
        if (!arch.some(a => a.tipo === 'acta')) resaltar(ws.getCell(r, 16), AMARILLO);
        r++;
      }
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
