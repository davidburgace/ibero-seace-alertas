// ============================================================================
// src/selector-ioarr/excel-costos.js — Excel de la estructura de costos (exceljs)
//
// Hojas: Resumen · Parámetros · Partidas · Metrado y costos por local · Por distrito
//        · Inventario verificado (solo si algún local se corrigió con una visita de campo)
// Estructura referencial de adquisición de bienes, SIN gastos generales ni utilidad:
//   Costo directo = bienes + transporte (piezas × transporte por pieza)
//   Monto de inversión = (costo directo + IGV) + documento equivalente + supervisión + liquidación
// Todo lo que se calcula es una fórmula de Excel (con su resultado ya puesto), para
// que el evaluador pueda auditar cada cifra: si cambia un precio, un % o la UIT en
// «Parámetros», el libro se recalcula.
// El metrado (cantidades, kits) va como valor: sale del cálculo por aula del Selector
// (su Excel trae la hoja Aulas con esas fórmulas).
// La oferta (uso interno) no se incluye: este libro no la recibe.
// ============================================================================

import ExcelJS from 'exceljs';
import { ITEMS, TALLAS } from './calculo.js';
import { FUENTES_PRECIO, LIMITE_UIT, TIPOS_ARCHIVO, NOTA_PORCENTAJES, LEYENDA_REFERENCIA, NOTA_FALTANTE } from './costos.js';

const FALTANTE = 'Faltante (brecha de dotación, no reposición)', FALTANTE_MIN = 'faltante (brecha de dotación)';
const AZUL = 'FF3A63E0', AMARILLO = 'FFFFF3B0', GRIS = 'FFF1F3F7';
const SOLES = '"S/ "#,##0.00', ENTERO = '#,##0', PCT = '0.00%';
const letra = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const f = (formula, result) => ({ formula, result });
const HP = 'Parámetros', HM = "'Metrado y costos por local'", HPa = 'Partidas';
const ORIGEN = { editado: 'Editado en el proyecto', catalogo: 'Catálogo', referencia: LEYENDA_REFERENCIA };

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
 * @param {object} meta { proyecto, region, fecha, fuente, criterios: texto, escenario: texto, precios: detalle del catálogo,
 *                      efectivos: { [clave]: { precio, origen } }, inventario: { [codLocal]: fila de ioarr_expediente_inventario } }
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

  const T = R.totales, L = R.locales, n = L.length, E = R.estructura.params, kit = !!R.kit;
  // Líneas de costo: kits por talla (con kit) o mesa y silla por talla, y los demás muebles que entran
  const LS = R.lineas, nLS = LS.length;
  const PL = R.preciosLinea || {};
  // Cantidad de una línea en un local
  const qDe = (l, x) => x.tipo === 'kit' ? l.kitTalla[x.ix] : l.lin.rep[x.ix];
  const cdDe = (l, x) => x.tipo === 'kit' ? l.cdKit[x.ix] : l.cdLinea[x.ix];

  // ── Parámetros ──────────────────────────────────────────────────────────────
  const celPU = [], cel = {}, filaDe = {};
  let celUit, celAnio, celLim;
  {
    const ws = wsPar;
    ws.columns = [44, 12, 20, 40, 26, 12, 40].map(width => ({ width }));
    ws.getCell('A1').value = 'Parámetros de costos'; ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = 'Cambia un valor de la columna C y el libro se recalcula. Las celdas amarillas están sin cargar.';
    ws.getCell('A2').font = { italic: true, color: { argb: 'FF5C6270' } };
    ws.getRow(4).values = ['Bien (talla)', 'Unidad', 'Precio unitario de mercado sin IGV (S/)', 'Descripción', 'Origen del precio', 'Fecha', 'Observación'];
    cabecera(ws, 4, 7);
    let fila = 5;
    const precioFila = (k, nombre, u, valor, pu, obs = '') => {
      const m = meta.precios?.[k] || {}, o = meta.efectivos?.[k];
      ws.getRow(fila).values = [nombre, u, valor, m.descripcion || '', ORIGEN[o?.origen] || (pu == null ? 'Sin precio' : 'Precio del tipo'), m.fecha || '', obs];
      const c = ws.getCell(fila, 3); c.numFmt = SOLES;
      if (pu == null) { resaltar(c, AMARILLO); ws.getCell(fila, 7).value = 'PENDIENTE: sin precio cargado'; }
      filaDe[k] = fila;
      return fila++;
    };
    // Mesa y silla de las tallas que intervienen (con kit, las del kit) y los demás muebles
    const tallasKit = kit ? LS.filter(x => x.tipo === 'kit').map(x => x.talla) : [];
    const lineasPrecio = [
      ...R.lineasTalla.filter(x => x.talla && (!kit || tallasKit.includes(x.talla))),
      ...(kit ? tallasKit.flatMap(z => ['mesa', 'silla'].map(t => `${t}_${z}`)).filter(k => !R.lineasTalla.some(y => y.k === k))
        .map(k => { const [tipo, z] = k.split('_'); const it = ITEMS.find(y => y.k === tipo); return { k, tipo, talla: z, n: `${it.n} – ${TALLAS.find(y => y.k === z).n}`, u: it.u }; }) : [])
    ];
    for (const x of lineasPrecio) precioFila(x.k, x.n, x.u, PL[x.k]?.pu ?? 0, PL[x.k]?.pu ?? null, PL[x.k]?.propio === false ? 'Usa el precio general del tipo' : '');
    for (const x of LS) {
      if (x.tipo === 'kit') {
        const fm = filaDe[`mesa_${x.talla}`], fs = filaDe[`silla_${x.talla}`];
        ws.getRow(fila).values = [x.n, x.u, f(`C${fm}+C${fs}`, x.pu ?? 0), 'Mesa + silla de la talla', '', '', ''];
        ws.getCell(fila, 3).numFmt = SOLES;
        if (x.pu == null) resaltar(ws.getCell(fila, 3), AMARILLO);
        celPU.push(`${HP}!$C$${fila}`); fila++;
      } else if (x.talla) celPU.push(`${HP}!$C$${filaDe[x.k]}`);
      else celPU.push(`${HP}!$C$${precioFila(x.k, x.n, x.u, x.pu ?? 0, x.pu)}`);
    }

    const f0 = fila + 2;
    ws.getRow(f0).values = ['Estructura de costos', 'Unidad', 'Valor', 'Cómo se aplica'];
    cabecera(ws, f0, 4);
    const filas = [
      ['tp', 'Transporte por pieza', 'S/ por pieza', E.transporte_pieza, SOLES, kit ? 'Cada kit cuenta 2 piezas (mesa y silla); escritorio, silla docente y armario, 1 pieza cada uno.' : 'Una pieza por bien (la mesa, por puesto).'],
      ['igv', 'IGV', '%', E.igv / 100, PCT, 'Sobre el costo directo.'],
      ['doc', 'Documento equivalente', '%', E.doc_pct / 100, PCT, 'Sobre el costo directo sin IGV.'],
      ['sup', 'Supervisión', '%', E.sup_pct / 100, PCT, 'Sobre el costo directo sin IGV.'],
      ['liq', 'Liquidación', 'S/', T.liq, SOLES, R.grupos ? 'Monto fijo.' : 'Monto fijo; se reparte entre los locales según su costo directo.']
    ];
    filas.forEach(([k, nombre, u, v, fmt, como], j) => {
      const r = f0 + 1 + j;
      ws.getRow(r).values = [nombre, u, v, como];
      ws.getCell(r, 3).numFmt = fmt;
      cel[k] = `${HP}!$C$${r}`;
    });
    const fn = f0 + filas.length + 2;
    ws.getCell(fn, 1).value = NOTA_PORCENTAJES;
    ws.getCell(fn + 1, 1).value = 'Estructura referencial de adquisición de bienes: costo directo + IGV + documento equivalente + supervisión + liquidación.';
    for (const r of [fn, fn + 1]) ws.getCell(r, 1).font = { italic: true, color: { argb: 'FF5C6270' } };

    const fu = fn + 3;
    ws.getRow(fu).values = ['UIT', 'Valor']; cabecera(ws, fu, 2);
    ws.getRow(fu + 1).values = ['Año de la UIT', R.uit.anio ?? ''];
    ws.getRow(fu + 2).values = ['Valor de la UIT (S/)', R.uit.valor ?? 0];
    ws.getCell(fu + 2, 2).numFmt = SOLES;
    if (!R.uit.valor) resaltar(ws.getCell(fu + 2, 2), AMARILLO);
    ws.getRow(fu + 3).values = ['Límite para el registro abreviado del 07-C (UIT)', LIMITE_UIT];
    celAnio = `${HP}!$B$${fu + 1}`; celUit = `${HP}!$B$${fu + 2}`; celLim = `${HP}!$B$${fu + 3}`;
  }

  // ── Metrado y costos por local ──────────────────────────────────────────────
  const C = {};
  const cab = [];
  const col = (clave, titulo, ancho = 14) => { cab.push({ titulo, ancho }); C[clave] = cab.length; };
  col('cod', 'Código de local', 12); col('nom', 'Instituciones', 40); col('ubigeo', 'Ubigeo', 9); col('prov', 'Provincia', 18); col('dist', 'Distrito', 20);
  col('area', 'Área', 9); col('est', 'Estudiantes (padrón)', 12); col('aul', 'Aulas en uso (censo)', 11);
  col('inv', 'Inventario', 16);
  LS.forEach((x, j) => col('q' + j, `${x.n} – cantidad (${x.u})`, 13));
  LS.forEach((x, j) => col('cd' + j, `${x.n} – bienes (S/)`, 15));
  col('bienes', 'Bienes (S/)', 16);
  col('piezas', 'Piezas', 11);
  col('transporte', 'Transporte (S/)', 15);
  col('cd', 'Costo directo (S/)', 16);
  col('igv', 'IGV (S/)', 15);
  col('doc', 'Documento equivalente (S/)', 15);
  col('sup', 'Supervisión (S/)', 15);
  col('liq', 'Liquidación (S/)', 15);
  col('total', 'MONTO DE INVERSIÓN (S/)', 18);
  const LF = R.lineasTalla;
  LF.forEach((x, j) => col('fq' + j, `${x.n} – ${FALTANTE_MIN} (${x.u}), no incluido`, 15));
  col('fv', 'Faltante valorizado, referencial (S/)', 17);

  const ws = wsM;
  ws.columns = cab.map(c => ({ header: c.titulo, width: c.ancho }));
  cabecera(ws, 1, cab.length);
  const ini = 2, fin = n + 1, TOT = n + 2;
  const A = (k, fila) => letra(C[k]) + fila;
  const totDe = k => `$${letra(C[k])}$${TOT}`;
  const nLoc = `COUNTA($${letra(C.cod)}$${ini}:$${letra(C.cod)}$${fin})`;
  // Columnas de cantidad que cuentan 2 piezas (kits) o 1 (los demás)
  const piezasF = r => LS.length ? LS.map((x, j) => (x.tipo === 'kit' ? '2*' : '') + A('q' + j, r)).join('+') : '0';
  const idxF = LF.map(x => x.ix);

  L.forEach((l, j) => {
    const r = ini + j, v = [];
    v[C.cod] = l.cod; v[C.nom] = l.nom; v[C.ubigeo] = l.ubigeo; v[C.prov] = l.prov; v[C.dist] = l.dist;
    v[C.inv] = l.verificado ? `Verificado en campo ${fechaPe(l.verificado.fecha_visita)}` : 'Censo Educativo';
    v[C.area] = l.rural ? 'Rural' : 'Urbana'; v[C.est] = l.est; v[C.aul] = l.aul;
    LS.forEach((x, j) => { v[C['q' + j]] = qDe(l, x); v[C['cd' + j]] = f(`${A('q' + j, r)}*${celPU[j]}`, cdDe(l, x)); });
    v[C.bienes] = f(nLS ? `SUM(${A('cd0', r)}:${A('cd' + (nLS - 1), r)})` : '0', l.bienes);
    v[C.piezas] = f(piezasF(r), l.piezas);
    v[C.transporte] = f(`${A('piezas', r)}*${cel.tp}`, l.transporte);
    v[C.cd] = f(`${A('bienes', r)}+${A('transporte', r)}`, l.cd);
    v[C.igv] = f(`${A('cd', r)}*${cel.igv}`, l.igv);
    v[C.doc] = f(`${A('cd', r)}*${cel.doc}`, l.doc);
    v[C.sup] = f(`${A('cd', r)}*${cel.sup}`, l.sup);
    v[C.liq] = f(`IF(${totDe('cd')}=0,${cel.liq}/${nLoc},${cel.liq}*${A('cd', r)}/${totDe('cd')})`, l.liq);
    v[C.total] = f(`${A('cd', r)}+${A('igv', r)}+${A('doc', r)}+${A('sup', r)}+${A('liq', r)}`, l.total);
    LF.forEach((x, j) => { v[C['fq' + j]] = l.lin.fal[idxF[j]]; });
    // Faltante × precio: la celda del precio si está en Parámetros; si no (talla sin kit), el valor
    v[C.fv] = f(LF.length ? LF.map((x, j) => `${A('fq' + j, r)}*${filaDe[x.k] ? `${HP}!$C$${filaDe[x.k]}` : (x.pu ?? 0)}`).join('+') : '0', l.falValor);
    ws.getRow(r).values = v;
  });

  // Fila de totales
  {
    const v = []; v[C.cod] = 'TOTAL';
    const sumables = Object.keys(C).filter(k => !['cod', 'nom', 'ubigeo', 'prov', 'dist', 'area', 'inv'].includes(k));
    const resultado = {
      est: T.est, aul: T.aul, bienes: T.bienes, piezas: T.piezas, transporte: T.transporte, cd: T.cd, igv: T.igv, doc: T.doc, sup: T.sup, liq: T.liq, total: T.total, fv: T.falValor,
      ...Object.fromEntries(LS.flatMap((x, j) => [['q' + j, x.rep], ['cd' + j, x.parcial]])),
      ...Object.fromEntries(LF.map((x, j) => ['fq' + j, x.fal]))
    };
    for (const k of sumables) v[C[k]] = f(`SUM(${A(k, ini)}:${A(k, fin)})`, resultado[k]);
    const row = ws.getRow(TOT); row.values = v; row.font = { bold: true };
    for (let c = 1; c <= cab.length; c++) resaltar(row.getCell(c), GRIS);
  }
  for (let r = ini; r <= TOT; r++) {
    const row = ws.getRow(r);
    for (const k of ['est', 'aul', 'piezas', ...LS.map((_, j) => 'q' + j), ...LF.map((_, j) => 'fq' + j)]) row.getCell(C[k]).numFmt = ENTERO;
    for (const k of [...LS.map((_, j) => 'cd' + j), 'bienes', 'transporte', 'cd', 'igv', 'doc', 'sup', 'liq', 'total', 'fv']) row.getCell(C[k]).numFmt = SOLES;
    row.getCell(C.total).font = { bold: true };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cab.length } };
  const MT = k => `${HM}!${totDe(k)}`;

  // ── Partidas ────────────────────────────────────────────────────────────────
  let celCD;
  {
    const ws = wsPa;
    ws.columns = [52, 12, 16, 22, 20].map(width => ({ width }));
    ws.getRow(1).values = ['Partida', 'Unidad', 'Metrado', 'Precio unitario sin IGV (S/)', 'Parcial (S/)'];
    cabecera(ws, 1, 5);
    LS.forEach((x, t) => {
      const r = 2 + t;
      ws.getRow(r).values = [x.n, x.u, f(MT('q' + t), x.rep), f(celPU[t], x.pu ?? 0), f(`C${r}*D${r}`, x.parcial)];
      ws.getCell(r, 3).numFmt = ENTERO;
      for (const c of [4, 5]) ws.getCell(r, c).numFmt = SOLES;
      if (x.pu == null) resaltar(ws.getCell(r, 4), AMARILLO);
    });
    const rb = 2 + nLS, rt = rb + 1, rc = rb + 2;
    ws.getRow(rb).values = ['Bienes', '', '', '', f(nLS ? `SUM(E2:E${rb - 1})` : '0', T.bienes)];
    ws.getRow(rt).values = ['Transporte', 'piezas', f(MT('piezas'), T.piezas), f(cel.tp, E.transporte_pieza), f(`C${rt}*D${rt}`, T.transporte)];
    ws.getRow(rc).values = ['Costo directo', '', '', '', f(`E${rb}+E${rt}`, T.cd)];
    for (const r of [rb, rc]) ws.getRow(r).font = { bold: true };
    ws.getCell(rt, 3).numFmt = ENTERO;
    for (const r of [rb, rt, rc]) { ws.getCell(r, 4).numFmt = SOLES; ws.getCell(r, 5).numFmt = SOLES; }
    ws.getCell(rc + 2, 1).value = 'Control: el costo directo de esta hoja debe ser igual al de la hoja «Metrado y costos por local».';
    ws.getCell(rc + 3, 1).value = 'Diferencia (debe ser 0)';
    ws.getCell(rc + 3, 5).value = f(`ROUND(E${rc}-${MT('cd')},2)`, 0); ws.getCell(rc + 3, 5).numFmt = SOLES;
    celCD = `${HPa}!$E$${rc}`;
  }

  // ── Resumen ─────────────────────────────────────────────────────────────────
  {
    const ws = wsRes;
    ws.columns = [58, 22, 54].map(width => ({ width }));
    const add = (vals, estilo) => { const r = ws.addRow(vals); if (estilo) estilo(r); return r; };
    const sub = r => { r.font = { bold: true, color: { argb: AZUL } }; };
    const soles = r => { r.getCell(2).numFmt = SOLES; };
    add(['Estructura de costos — IOARR de reposición de mobiliario escolar'], r => { r.font = { bold: true, size: 14 }; });
    add([meta.escenario || ''], r => { r.font = { bold: true }; });
    if (kit) add(['Mesas y sillas presentadas como kit (mesa + silla del estudiante): kits por aula = mayor entre mesas y sillas; el local suma sus aulas.']);
    add([]);
    add(['Proyecto', meta.proyecto || '(sin nombre)']);
    add(['Región', meta.region]);
    if (meta.ioarr) add(['Vinculado a Radar IOARR', `CUI ${meta.ioarr.cui} — ${meta.ioarr.nombre}`]);
    add(['Fecha de exportación', meta.fecha]);
    const filaLoc = add(['Locales (unidades productoras)', f(`COUNTA(${HM}!$A$${ini}:$A$${fin})`, T.locales)], r => { r.getCell(2).numFmt = ENTERO; }).number;
    const filaEst = add(['Estudiantes (padrón)', f(MT('est'), T.est)], r => { r.getCell(2).numFmt = ENTERO; }).number;
    add(['Bienes a reponer', T.rep], r => { r.getCell(2).numFmt = ENTERO; });
    if (kit) add(['Kits (mesa + silla del estudiante)', T.kits], r => { r.getCell(2).numFmt = ENTERO; });
    add(['Piezas', f(MT('piezas'), T.piezas)], r => { r.getCell(2).numFmt = ENTERO; });
    add([]);
    const c = add(['Estructura de costos', 'Monto (S/)', 'Cómo se calcula']); cabecera(ws, c.number, 3);
    const linea = (txt, formula, val, como, negrita) => add([txt, f(formula, val), como], r => { soles(r); if (negrita) r.font = { bold: true }; }).number;
    const fB = linea('Bienes (cantidad × precio unitario sin IGV)', MT('bienes'), T.bienes, 'Hoja Partidas');
    const fT = linea('Transporte', MT('transporte'), T.transporte, `Piezas × transporte por pieza`);
    const fCD = linea('Costo directo', `B${fB}+B${fT}`, T.cd, 'Bienes + transporte', true);
    const fI = linea('IGV', MT('igv'), T.igv, `${E.igv} % del costo directo`);
    linea('Costo directo + IGV', `B${fCD}+B${fI}`, T.cdIgv, '', true);
    linea('Documento equivalente', MT('doc'), T.doc, `${E.doc_pct} % del costo directo sin IGV`);
    linea('Supervisión', MT('sup'), T.sup, `${E.sup_pct} % del costo directo sin IGV`);
    linea('Liquidación', MT('liq'), T.liq, 'Monto fijo');
    const filaTot = add(['MONTO DE INVERSIÓN', f(MT('total'), T.total), '(Costo directo + IGV) + documento equivalente + supervisión + liquidación'], r => { soles(r); r.font = { bold: true, size: 12 }; }).number;
    add([NOTA_PORCENTAJES]);
    add(['Estructura referencial de adquisición de bienes: costo directo + IGV + documento equivalente + supervisión + liquidación.']);
    add(['Control: costo directo de la hoja Partidas', f(celCD, T.cd)], soles);
    add(['Costo por estudiante', f(`IFERROR(B${filaTot}/B${filaEst},0)`, T.porEstudiante ?? 0), 'Monto ÷ estudiantes del padrón'], soles);
    add(['Costo por local (promedio)', f(`IFERROR(B${filaTot}/B${filaLoc},0)`, T.locales ? T.total / T.locales : 0), 'Monto ÷ locales'], soles);
    add([]);
    add(['Formato 07-C: registro abreviado o completo'], sub);
    add(['Año de la UIT', f(celAnio, R.uit.anio ?? '')]);
    add(['Valor de la UIT', f(celUit, R.uit.valor ?? 0)], soles);
    add(['Límite: 75 UIT', f(`${celLim}*${celUit}`, R.uit.limite ?? 0)], soles);
    add(['Monto de inversión en UIT', f(`IFERROR(B${filaTot}/${celUit},0)`, R.uit.enUit ?? 0)], r => { r.getCell(2).numFmt = '#,##0.00'; });
    const reg = R.uit.valor ? (R.uit.supera ? 'COMPLETO: supera 75 UIT (secciones D, E y F)' : 'ABREVIADO: hasta 75 UIT (sección G)') : 'PENDIENTE: falta el valor de la UIT';
    add(['Registro que corresponde', f(`IF(${celUit}<=0,"PENDIENTE: falta el valor de la UIT",IF(B${filaTot}>${celLim}*${celUit},"COMPLETO: supera 75 UIT (secciones D, E y F)","ABREVIADO: hasta 75 UIT (sección G)"))`, reg)],
      r => { r.font = { bold: true }; if (R.uit.supera || !R.uit.valor) resaltar(r.getCell(2), AMARILLO); });
    add([]);
    add([FALTANTE + ', no incluido en el total'], sub);
    add(['Faltante valorizado, referencial', f(MT('fv'), T.falValor), 'Bienes por encima de los existentes × precio unitario'], soles);
    add([`El faltante (matrícula − mobiliario existente) ${NOTA_FALTANTE} Es solo informativo: amplía la capacidad de la UP y, según los Lineamientos IOARR del MEF (2.4.C.c), una reposición no puede sustentarse en un incremento de capacidad. Lo que se repone no supera la matrícula ni la capacidad de diseño de cada colegio.`]);
    add([]);
    add(['Criterios del metrado'], sub);
    add([meta.criterios || '']);
    add(['Faltante = Requerido − Existente, mínimo 0 por aula: no entra a la reposición ni al costo.']);
    add([]);
    add(['Fuentes'], sub);
    add([meta.fuente || 'Padrón de ESCALE – Minedu, registros al 29/10/2025']);
    add(['Censo Educativo 2025, Local escolar, pregunta 6.1 (aulas y mobiliario)']);
    add(['Son datos declarados por cada colegio y no están validados.']);
    if (verificados.length) add([`En ${verificados.length === 1 ? '1 local' : verificados.length + ' locales'} el mobiliario se reemplazó por el inventario verificado en campo (hoja «Inventario verificado»).`]);
    add(['Los precios unitarios, los porcentajes y la UIT se revisan en la hoja Parámetros (origen de cada precio en la columna E).']);
  }

  // ── Por distrito ────────────────────────────────────────────────────────────
  {
    const ws = wsD;
    ws.columns = [10, 22, 24, 10, 14, 16, 18, 18, 18, 22].map(width => ({ width }));
    ws.getRow(1).values = ['Ubigeo', 'Provincia', 'Distrito', 'Locales', 'Estudiantes', kit ? 'Kits y otros bienes' : 'Bienes a reponer', 'Costo directo (S/)', 'Monto de inversión (S/)', 'Costo por estudiante (S/)', FALTANTE + ', no incluido'];
    cabecera(ws, 1, 10);
    const rango = k => `${HM}!$${letra(C[k])}$${ini}:$${letra(C[k])}$${fin}`;
    const crit = `${HM}!$${letra(C.ubigeo)}$${ini}:$${letra(C.ubigeo)}$${fin}`;
    R.distritos.forEach((d, j) => {
      const r = 2 + j;
      const cant = L.filter(l => l.ubigeo === d.ubigeo).reduce((a, l) => a + LS.reduce((s, x) => s + qDe(l, x), 0), 0);
      ws.getRow(r).values = [d.ubigeo, d.prov, d.nom,
        f(`COUNTIF(${crit},A${r})`, d.n), f(`SUMIF(${crit},A${r},${rango('est')})`, d.est),
        f(nLS ? LS.map((_, j) => `SUMIF(${crit},A${r},${rango('q' + j)})`).join('+') : '0', cant),
        f(`SUMIF(${crit},A${r},${rango('cd')})`, d.cd), f(`SUMIF(${crit},A${r},${rango('total')})`, d.total),
        f(`IFERROR(H${r}/E${r},0)`, d.porEstudiante ?? 0), f(LF.length ? LF.map((_, j) => `SUMIF(${crit},A${r},${rango('fq' + j)})`).join('+') : '0', d.fal)];
    });
    const r = 2 + R.distritos.length;
    ws.getRow(r).values = ['TOTAL', '', '', f(`SUM(D2:D${r - 1})`, T.locales), f(`SUM(E2:E${r - 1})`, T.est), f(`SUM(F2:F${r - 1})`, LS.reduce((a, x) => a + x.rep, 0)),
      f(`SUM(G2:G${r - 1})`, T.cd), f(`SUM(H2:H${r - 1})`, T.total), f(`IFERROR(H${r}/E${r},0)`, T.porEstudiante ?? 0), f(`SUM(J2:J${r - 1})`, T.fal)];
    ws.getRow(r).font = { bold: true };
    for (let k = 2; k <= r; k++) {
      for (const c of [4, 5, 6, 10]) ws.getCell(k, c).numFmt = ENTERO;
      for (const c of [7, 8, 9]) ws.getCell(k, c).numFmt = SOLES;
    }
  }

  // ── Inventario verificado en campo ──────────────────────────────────────────
  if (wsI) {
    const ws = wsI;
    ws.columns = [12, 36, 22, 9, 9, 9, 9, 9, 9, 11, 12, 11, 12, 22, 50, 50, 12, 12].map(width => ({ width }));
    ws.getCell('A1').value = 'Inventario verificado en campo'; ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = 'Reemplaza lo que reporta el Censo Educativo en estos locales y tipos de bien. Reposición = Malo; faltante (brecha de dotación, no reposición) = Requerido − Existente, por local.';
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
