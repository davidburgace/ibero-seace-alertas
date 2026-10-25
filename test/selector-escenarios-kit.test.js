// Escenarios de cantidad, kit mesa + silla, estructura de costos sin utilidad, correcciones
// del 07-C y oferta interna que no se exporta (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { prep, calc, filtrar, totals, FILTRO_VACIO, DEF, limpiarParams, textoEscenario, TALLAS } from '../src/selector-ioarr/calculo.js';
import { costear, preciosEfectivos, limpiarEstructura, PRECIOS_REFERENCIA, LINEAS_KIT } from '../src/selector-ioarr/costos.js';
import { armarModelo, limpiarDatosDoc } from '../src/selector-ioarr/documentos.js';
import { generar07C, generarMemoria, generarVerificacion } from '../src/selector-ioarr/word.js';
import { generarExcelCostos } from '../src/selector-ioarr/excel-costos.js';
import { generarExcel } from '../src/selector-ioarr/excel.js';
import { escribirZip } from '../src/selector-ioarr/zip.js';
import { piezasExpediente } from '../src/selector-ioarr/expediente.js';
import { limpiarOferta, calcularOferta, MARCA_INTERNA } from '../src/selector-ioarr/oferta.js';
import { modeloFicha, generarFichaExcel } from '../src/selector-ioarr/ficha.js';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const moquegua = () => prep(JSON.parse(readFileSync(new URL('moquegua.json', DIR), 'utf8')));
const precioNum = (est = {}, det = {}) => Object.fromEntries(Object.entries(preciosEfectivos(est, det)).map(([k, v]) => [k, v.precio]));
async function textoDocx(buf) {
  const z = await JSZip.loadAsync(buf);
  return (await z.file('word/document.xml').async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
}
async function textoXlsx(buf) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const out = [];
  wb.eachSheet(ws => { out.push(ws.name); ws.eachRow(r => r.eachCell(c => { const v = c.value; out.push(v && typeof v === 'object' ? (v.formula ? `=${v.formula} ${v.result}` : v.text || JSON.stringify(v)) : String(v)); })); });
  return out.join('\n');
}

// Región sintética: locales de Primaria con aulas de 24 mesas y 24 sillas en mal estado
// f: 0-2 mesa unip. B/R/M · 8-10 silla B/R/M · 11-13 escritorio · 14-16 silla docente · 17-19 armario
function aula(iLoc, iSvc, grado, f, est = 24) { const v = new Array(20).fill(0); for (const [j, n] of Object.entries(f)) v[j] = n; return [iLoc, iSvc, 'E1', 1, '1', grado, 'A', 'M', est, 0, 0, ...v]; }
function region(locales) {
  const D = { region: 'Prueba', dpto: 'PRUEBA', provs: ['Prov'], ugels: ['UGEL Prueba'], dists: [['Dist', '010101', 0]], locs: [], svcs: [], aulas: [] };
  locales.forEach((aulas, i) => {
    D.locs.push([String(100001 + i), 0, 0, 'CP', 0, 'Dir', -12, -77]);
    D.svcs.push([String(1000001 + i), `IE ${i + 1}`, 'P', i, 0, aulas.length, aulas.length * 24, 'M']);
    for (const f of aulas) D.aulas.push(aula(i, i, f.grado || 'Multigrado', f.f));
  });
  return prep(D);
}

// ─── 3. Estructura de costos: caso de control ───────────────────────────────
// 6,168 kits (2,056 por grupo de grado) con los precios de referencia → S/ 4,864,528.32
function casoControl() {
  const grados = ['1° Primaria', '4° Primaria', '6° Primaria', 'Multigrado'];
  const loc = n => Array.from({ length: n }, (_, j) => ({ grado: grados[j % grados.length], f: { 2: 24, 10: 24 } }));
  const D = region([loc(100), loc(100), loc(57)]);   // 257 aulas × 24 = 6,168 kits
  const P = limpiarParams({ muebles: ['mesa', 'silla'] }), C = calc(D, P), list = [0, 1, 2];
  const R = costear({ D, C, list, precios: precioNum(), estructura: { kit: true }, uit: { anio: 2026, valor: 5500 } });
  return { D, P, C, list, R };
}

test('estructura de costos: caso de control S/ 4,864,528.32 (6,168 kits, 2,056 por grupo de grado)', () => {
  const { R } = casoControl(), T = R.totales;
  assert.equal(T.kits, 6168);
  assert.deepEqual(R.lineasKit.map(x => [x.talla, x.rep]), [['p12', 2056], ['p34', 2056], ['p56', 2056]]);
  // Precio del kit = mesa + silla de su talla (referencia Loreto 2026)
  assert.deepEqual(R.lineasKit.map(x => x.pu), [385 + 188, 393 + 193, 398 + 198]);
  assert.equal(T.bienes, 3608280);
  assert.equal(T.piezas, 12336);
  assert.equal(T.transporte, 240552);
  assert.equal(T.cd, 3848832.00);
  assert.equal(T.igv, 692789.76);
  assert.equal(T.doc, 115464.96);
  assert.equal(T.sup, 192441.60);
  assert.equal(T.liq, 15000.00);
  assert.equal(T.total, 4864528.32);
  // Una sola meta: el kit
  assert.deepEqual(R.metas.map(m => [m.k, m.u, m.cantidad]), [['kit', 'Kit de mobiliario', 6168]]);
  // Kits de Primaria asignados a cada local en enteros: las filas suman los kits del local y las columnas, lo del grupo
  for (const l of R.locales) assert.equal(l.kitTalla.reduce((a, b) => a + b, 0), l.kits);
  const js = ['p12', 'p34', 'p56'].map(k => TALLAS.findIndex(z => z.k === k));
  assert.deepEqual(js.map(j => R.locales.reduce((a, l) => a + l.kitTalla[j], 0)), [2056, 2056, 2056]);
});

test('caso de control en el 07-C, el Excel y el ZIP: sin gastos generales ni utilidad', async () => {
  const { D, P, list, R } = casoControl();
  const M = armarModelo({ R, D, list, proyecto: { nombre: 'Control', region: 'Prueba' }, datos: limpiarDatosDoc({}), precios: {}, efectivos: preciosEfectivos({}, {}), P, fecha: '2026-10-23' });
  assert.equal(M.F.total, 4864528.32);
  assert.equal(M.F.subtotalActivos, 3848832.00 + 692789.76);
  assert.deepEqual([M.F.expediente, M.F.supervision, M.F.liquidacion], [115464.96, 192441.60, 15000]);
  assert.equal(M.F.metas.length, 1);
  assert.equal(M.F.metas[0].unidad, 'Kit de mobiliario');
  assert.equal(M.F.metas[0].costo, 4541621.76);
  const t07 = await textoDocx(await generar07C(M)), tMem = await textoDocx(await generarMemoria(M));
  for (const t of [t07, tMem]) {
    assert.doesNotMatch(t, /utilidad|gastos generales|imprevistos|gestión del proyecto/i);
    assert.match(t, /4\.864\.528,32|4,864,528\.32/);
  }
  assert.match(t07, /Kit de mobiliario/);
  const x = await textoXlsx(await generarExcelCostos(R, { proyecto: 'Control', region: 'Prueba', fecha: '2026-10-23', escenario: M.escenarioTexto, efectivos: preciosEfectivos({}, {}) }));
  assert.match(x, /MONTO DE INVERSIÓN/);
  assert.match(x, /4864528\.32/);
  assert.doesNotMatch(x, /utilidad|gastos generales|imprevistos|gestión del proyecto/i);
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('caso de control: el Excel recalculado con LibreOffice da S/ 4,864,528.32', { skip: !soffice && 'LibreOffice no está instalado' }, async () => {
  const { R } = casoControl();
  const dir = mkdtempSync(join(tmpdir(), 'control-'));
  try {
    const perfil = join(dir, 'perfil', 'user'); execFileSync('mkdir', ['-p', perfil]);
    writeFileSync(join(perfil, 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item></oor:items>`);
    writeFileSync(join(dir, 'c.xlsx'), await generarExcelCostos(R, { proyecto: 'Control', region: 'Prueba', fecha: '2026-10-23' }));
    execFileSync('soffice', [`-env:UserInstallation=file://${join(dir, 'perfil')}`, '--headless', '--calc', '--convert-to',
      'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1', '--outdir', join(dir, 'out'), join(dir, 'c.xlsx')], { stdio: 'ignore', timeout: 120000 });
    const res = readFileSync(join(dir, 'out', readdirSync(join(dir, 'out')).find(f => /Resumen/.test(f))), 'utf8');
    const val = e => Number(res.split('\n').find(l => l.startsWith(e + ',')).split(',')[1]);
    assert.equal(Math.round(val('C = A + B. COSTO DE INVERSIÓN (MONTO DE INVERSIÓN)') * 100), 486452832);
    assert.equal(Math.round(val('Costo directo sin IGV') * 100), 384883200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── 2. Kit por aula ────────────────────────────────────────────────────────
test('kit por aula: el mayor entre mesas y sillas en cada aula, sumado en el local (no el mayor de los totales)', () => {
  // Aula A: 10 mesas y 2 sillas malas; aula B: 1 mesa y 8 sillas malas
  const D = region([[{ grado: '2° Primaria', f: { 2: 10, 10: 2, 13: 1 } }, { grado: '5° Primaria', f: { 2: 1, 10: 8, 19: 1 } }]]);
  const C = calc(D, DEF);
  const R = costear({ D, C, list: [0], precios: precioNum({ precios: { esc: 300, arm: 400 } }), estructura: { kit: true }, uit: null });
  assert.equal(R.totales.kits, 10 + 8);
  assert.notEqual(R.totales.kits, Math.max(11, 10));   // el mayor de los totales daría 11
  // El kit va a la talla de cada aula y luego se reparte Primaria según la distribución (partes iguales)
  assert.deepEqual(R.lineasKit.map(x => [x.talla, x.rep]), [['p12', 6], ['p34', 6], ['p56', 6]]);
  // Escritorio y armario siguen como líneas aparte; la silla docente no entra (nada que reponer)
  assert.deepEqual(R.metas.map(m => [m.k, m.cantidad]), [['kit', 18], ['esc', 1], ['arm', 1]]);
  // Piezas: 2 por kit + 1 por cada otro bien
  assert.equal(R.totales.piezas, 2 * 18 + 2);
  // Distribución editable de los kits de Primaria
  const R2 = costear({ D, C, list: [0], precios: precioNum(), estructura: { kit: true, kit_dist: [50, 25, 25] }, uit: null });
  assert.deepEqual(R2.lineasKit.map(x => x.rep), [9, 5, 4]);
  // Sin kit, mesa y silla van por separado
  const R3 = costear({ D, C, list: [0], precios: precioNum(), estructura: {}, uit: null });
  assert.deepEqual(R3.metas.map(m => [m.k, m.cantidad]), [['mesa', 11], ['silla', 10], ['esc', 1], ['arm', 1]]);
  // Con inventario verificado (por local), el mayor del local
  const inv = { '100001': { bienes: { mesa: { b: 0, r: 0, m: 7 } }, fecha_visita: '2026-10-01', observacion: 'x' } };
  assert.equal(costear({ D, C, list: [0], precios: precioNum(), estructura: { kit: true }, uit: null, inventario: inv }).totales.kits, 10);
});

test('kit en el 07-C: una línea «MOBILIARIO DE AULA» con unidad «Kit de mobiliario»; los demás aparte', async () => {
  const D = region([[{ grado: '2° Primaria', f: { 2: 10, 10: 2, 13: 1 } }, { grado: '5° Primaria', f: { 2: 1, 10: 8, 19: 1 } }]]);
  const C = calc(D, DEF), R = costear({ D, C, list: [0], precios: precioNum({ precios: { esc: 300, arm: 400 } }), estructura: { kit: true }, uit: { anio: 2026, valor: 1 } });
  const M = armarModelo({ R, D, list: [0], proyecto: { nombre: 'Kit', region: 'Prueba' }, datos: limpiarDatosDoc({}), precios: {}, P: DEF, fecha: '2026-10-23' });
  const t = await textoDocx(await generar07C(M));
  assert.match(t, /MOBILIARIO DE AULA\nMOBILIARIO\nKit de mobiliario\n18\n/);
  assert.match(t, /MOBILIARIO DE AULA\n\(escritorio docente\)/);
  assert.match(t, /MOBILIARIO DE AULA\n\(armario \/ estante\)/);
  assert.doesNotMatch(t, /\(silla docente\)/);
});

// ─── 1. Escenarios ──────────────────────────────────────────────────────────
test('escenarios: Solo Malo (base), Malo + Regular y Por capacidad; el faltante nunca entra', () => {
  assert.equal(limpiarParams({}).escenario, 'malo');
  assert.equal(limpiarParams({ escenario: 'otro' }).escenario, 'malo');
  assert.deepEqual([limpiarParams({}).capOcup, limpiarParams({}).capPct], [30, 80]);
  assert.deepEqual([limpiarParams({ capOcup: 99, capPct: 0 }).capOcup, limpiarParams({ capOcup: 99, capPct: 0 }).capPct], [60, 1]);
  const D = moquegua();
  const res = Object.fromEntries(['malo', 'malo_regular', 'capacidad'].map(e => {
    const P = limpiarParams({ escenario: e }), C = calc(D, P), list = filtrar(D, calc(D, DEF), { ...FILTRO_VACIO(), q: 'mariscal' });
    return [e, { T: totals(D, C, list), list }];
  }));
  const M = res.malo.T, MR = res.malo_regular.T, CAP = res.capacidad.T;
  assert.equal(M.rep, 198);
  M.t.forEach((o, t) => { assert.equal(o.rep, o.m); assert.equal(MR.t[t].rep, o.m + o.r); });
  // Por capacidad: aulas × 30 × 80 % = 24 por aula en mesa y silla; lo requerido por aula en los demás
  assert.equal(CAP.t[0].rep, 104 * 24); assert.equal(CAP.t[1].rep, 104 * 24);
  assert.equal(CAP.t[2].rep, 104);
  // El faltante es el mismo en los tres: informativo
  assert.equal(MR.fal, M.fal); assert.equal(CAP.fal, M.fal);
  // Cada documento lo declara en una línea
  assert.match(textoEscenario(limpiarParams({})), /^Escenario de cantidad: Solo Malo/);
  assert.match(textoEscenario(limpiarParams({ escenario: 'capacidad' })), /solo para comparar con una convocatoria ya publicada; no es sustento de reposición/i);
});

test('escenarios en los documentos: sustento según el método, Excel del Selector y ficha', async () => {
  const D = moquegua();
  const doc = esc => {
    const P = limpiarParams({ escenario: esc }), C = calc(D, P), list = filtrar(D, calc(D, DEF), { ...FILTRO_VACIO(), q: 'mariscal' });
    const R = costear({ D, C, list, precios: precioNum({ precios: { mesa: 300, silla: 150, esc: 300, sdoc: 80, arm: 450 } }), estructura: {}, uit: { anio: 2026, valor: 1 } });
    return { P, C, list, R, M: armarModelo({ R, D, list, proyecto: { nombre: esc, region: 'Moquegua' }, datos: limpiarDatosDoc({}), precios: {}, P, fecha: '2026-10-23' }) };
  };
  const malo = doc('malo'), cap = doc('capacidad'), mr = doc('malo_regular');
  assert.ok(malo.M.E.sustento[0].includes('Se repone el mobiliario en estado malo del Censo Educativo 2025; debe confirmarse con el inventario patrimonial y la verificación en campo'));
  assert.match(cap.M.E.sustento[0], /no usa el estado del mobiliario/);
  assert.ok(cap.M.E.condiciones.some(c => c.estado === 'no' && /capacidad de la UP/.test(c.texto)));
  // Ningún escenario presenta el faltante como reposición
  for (const x of [malo, cap, mr]) assert.ok(x.M.E.sustento.some(s => /faltantes .*corresponde a ampliación marginal, no a reposición/.test(s)));
  // Los Word declaran el escenario
  assert.match(await textoDocx(await generar07C(mr.M)), /Escenario de cantidad: Malo \+ % de Regular/);
  assert.match(await textoDocx(await generarMemoria(cap.M)), /Por capacidad/);
  // Excel del Selector: «A reponer» = Regular + Malo en Malo + Regular; valor por capacidad
  const leerAulas = async x => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await generarExcel(D, x.C, x.P, x.list, { proyecto: 'x', fecha: '2026-10-23' })).buffer); return wb; };
  const wbMR = await leerAulas(mr), au = wbMR.getWorksheet('Aulas');
  const col = au.getRow(1).values.findIndex(v => v === 'Mesa del estudiante – A reponer');
  assert.match(au.getRow(2).getCell(col).value.formula, /^[A-Z]+2\+[A-Z]+2$/);
  assert.match((await textoXlsx((await generarExcel(D, cap.C, cap.P, cap.list, { proyecto: 'x', fecha: '2026-10-23' })).buffer)), /Escenario de cantidad: Por capacidad/);
  // La ficha de verificación declara el escenario y qué estados entran a reponer
  const F = modeloFicha(D, mr.C, mr.list[0], {});
  assert.match(F.escenarioTexto, /Malo \+ % de Regular/);
  assert.match(await textoXlsx(await generarFichaExcel(F)), /escenario Malo \+ % de Regular\)/);
});

// ─── 5. Correcciones al 07-C ────────────────────────────────────────────────
test('07-C: descripción por nivel y grupo de grado, referencia técnica, códigos, UP por código modular y datos de ejecución', async () => {
  const D = region([[{ grado: '1° Primaria', f: { 2: 5, 10: 5 } }, { grado: '6° Primaria', f: { 2: 3, 10: 3 } }], [{ grado: '3° Primaria', f: {} }]]);
  const C = calc(D, DEF), R = costear({ D, C, list: [0, 1], precios: precioNum(), estructura: { kit: true }, uit: { anio: 2026, valor: 1 } });
  // Un precio de catálogo con una descripción de otro nivel no se copia a la descripción técnica
  const precios = { mesa: { descripcion: 'MESA PARA 5° SECUNDARIA' }, silla: { descripcion: 'SILLA 5° SECUNDARIA' } };
  const datos = { up_por: 'modular', ref_tecnica: 'Ficha técnica de la entidad', modalidad: 'Administración indirecta – Obras por Impuestos', fuente_financiamiento: 'Recursos Determinados',
    ue_mantenimiento: 'UGEL Prueba', ue_mantenimiento_codigo: '1234', plazo_unidad: 'dias', dias: 75, fecha_inicio: '2027-01', mant_nuevo: { kit: 0 }, vida_util: { kit: 10 }, unidad_indicador: 'LOCAL EDUCATIVO' };
  const M = armarModelo({ R, D, list: [0, 1], proyecto: { nombre: 'X', region: 'Prueba' }, datos: limpiarDatosDoc(datos), precios, P: DEF, fecha: '2026-10-23' });
  const desc = M.E.intervencion[0].descripcion;
  assert.doesNotMatch(desc, /SECUNDARIA/i);
  assert.match(desc, /Educación Primaria, 1\.° y 2\.° grado/);
  assert.match(desc, /El material debe respetar la ficha técnica aplicable; la entidad convocante puede exigir madera\./);
  assert.match(desc, /Referencia técnica aplicable: Ficha técnica de la entidad\./);
  assert.match(armarModelo({ R, D, list: [0, 1], proyecto: { nombre: 'X', region: 'Prueba' }, datos: limpiarDatosDoc({}), precios, P: DEF, fecha: '2026-10-23' }).E.intervencion[0].descripcion, /Referencia técnica aplicable: PENDIENTE/);
  // Códigos de la clasificación funcional; contribución a la brecha vacía por defecto
  assert.equal(M.A.funcion, '22 EDUCACIÓN'); assert.equal(M.A.division, '047 EDUCACIÓN BÁSICA'); assert.deepEqual(M.A.grupos, ['PENDIENTE (código) EDUCACIÓN PRIMARIA']);
  // No se propone un código que no se conoce: Primaria queda pendiente; Secundaria es 0105; lo escrito manda
  assert.ok(M.faltan.some(x => /Código del grupo funcional de primaria/.test(x)));
  assert.equal(M.A.indicadores[0].nombre, 'PORCENTAJE DE INSTALACIONES EDUCATIVAS QUE BRINDAN EL SERVICIO EN CONDICIONES INADECUADAS');
  assert.match(M.A.espacio, /^DEPARTAMENTO DE /);
  assert.equal(M.A.indicadores[0].valor, null);
  // Por código modular: todas las UP, también el local sin bienes a reponer
  assert.equal(M.ups.length, 1);
  assert.deepEqual(M.upsRegistro.map(u => [u.cod, u.sinBienes]), [['1000001', false], ['1000002', true]]);
  // Plazo en días → cronograma mensual; mantenimiento en 0 no queda pendiente
  assert.equal(M.F.meses, 3); assert.equal(M.F.cronograma.periodos.length, 3);
  assert.ok(!M.faltan.some(x => /mantenimiento \(puede ser 0\)|Modalidad|Fuente de financiamiento|Referencia técnica|mantenimiento: nombre/.test(x)), M.faltan.join(' | '));
  const t = await textoDocx(await generar07C(M));
  for (const s of ['22 EDUCACIÓN', '047 EDUCACIÓN BÁSICA', 'PENDIENTE (código) EDUCACIÓN PRIMARIA', 'verifícalos contra el PMI', 'Código modular (UP)', 'Administración indirecta – Obras por Impuestos', 'Recursos Determinados', '75 días'])
    assert.ok(t.includes(s), s);
  // Sin datos no se inventan valores por defecto
  const V = armarModelo({ R, D, list: [0, 1], proyecto: { nombre: 'X', region: 'Prueba' }, datos: limpiarDatosDoc({}), precios, P: DEF, fecha: '2026-10-23' });
  assert.deepEqual([V.ejecucion.modalidad, V.ejecucion.fuente, V.D.mantenimiento, V.D.mantenimiento_codigo], ['', '', '', '']);
});

// ─── 4. Oferta interna ──────────────────────────────────────────────────────
test('oferta: costo puesto en colegio y margen como diferencia (precio − costo), con alerta', () => {
  const { R } = casoControl();
  const O = calcularOferta(R, { fabricacion: { mesa: 200, silla: 100 }, embalaje: 2, transporte_base: 10, instalacion: 3, gg_modo: 'pct', gg_valor: 10, referencia: 'manual', monto_manual: 3000000 });
  // 6,168 kits: fabricación 6,168 × 300; piezas 12,336 × (2 + 10 + 3)
  const directo = 6168 * 300 + 12336 * 15;
  assert.equal(O.totales.directo, directo);
  assert.equal(O.totales.costo, Math.round(directo * 1.1 * 100) / 100);
  assert.equal(O.totales.margen, Math.round((3000000 - directo * 1.1) * 100) / 100);
  assert.equal(O.totales.supera, false);
  assert.match(O.nota, /precio − costo/);
  const caro = calcularOferta(R, { fabricacion: { mesa: 900, silla: 900 }, referencia: 'manual', monto_manual: 1000 });
  assert.equal(caro.totales.supera, true);
  assert.ok(caro.avisos.some(a => a.alerta && /supera el monto referencial/.test(a.texto)));
  assert.equal(O.locales.reduce((a, l) => a + l.costo, 0).toFixed(2), O.totales.costo.toFixed(2));
});

test('la pestaña interna de oferta no sale en ninguna exportación (07-C, memoria, verificación, Excel, ficha, ZIP)', async () => {
  const { D, P, C, list, R } = casoControl();
  // Valores únicos para buscarlos en lo exportado
  const oferta = limpiarOferta({ fabricacion: { mesa: 13579.24, silla: 24680.13 }, embalaje: 97.31, transporte_base: 86.42, instalacion: 75.53, gg_valor: 64.64, referencia: 'manual', monto_manual: 97531.86 });
  const O = calcularOferta(R, oferta);
  // Aunque alguien intente colarla en Documentos o en la estructura, se descarta
  const datos = limpiarDatosDoc({ oferta, margen: 1, ref_tecnica: 'Ref' });
  assert.ok(!('oferta' in datos) && !('margen' in datos));
  assert.ok(!('oferta' in limpiarEstructura({ oferta, kit: true })));
  const M = armarModelo({ R, D, list, proyecto: { nombre: 'Control', region: 'Prueba' }, datos, precios: {}, P, fecha: '2026-10-23' });
  const A = { modo: 'una', P, detalle: {}, efectivos: preciosEfectivos({}, {}), excluidos: [], dup: {} };
  const x = { nivel: null, nombre: 'Todos los niveles', D, C, list, R, inv: {} };
  const piezas = await piezasExpediente({ A, datos, lista: [{ x, M }], meta: { region: 'Prueba', fecha: '2026-10-23' }, nombre: 'Control' });
  assert.deepEqual(piezas.filter(p => !p.oculto).map(p => p.nombre), ['00_Formato_05B_idea.docx', '01_Formato_07C_borrador.docx', '02_Memoria_descriptiva.docx', '03_Lista_de_verificacion.docx', '04_Estructura_de_costos.xlsx', '05_Seleccion_de_locales_y_metrado.xlsx', '06_Anexos_Lineamientos.xlsx', '07_Informe_vida_util.docx']);
  // Un informe de vida útil por colegio con bienes a reponer
  assert.ok(piezas.filter(p => p.oculto).every(p => /^07_Informes_vida_util_por_colegio\/Informe_vida_util_\d+\.docx$/.test(p.nombre)));
  assert.equal(piezas.filter(p => p.oculto).length, M.ups.length);
  // ZIP completo
  const salida = new PassThrough(), partes = []; salida.on('data', c => partes.push(c));
  const fin = new Promise(ok => salida.on('end', ok));
  await escribirZip(salida, { base: 'Exp', piezas, archivos: [], descargar: async () => Buffer.alloc(0), M, proyecto: 'Control' });
  await fin;
  const z = await JSZip.loadAsync(Buffer.concat(partes));
  const textos = [];
  for (const [n, f] of Object.entries(z.files)) {
    if (f.dir) continue;
    const b = await f.async('nodebuffer');
    textos.push(n, n.endsWith('.docx') ? await textoDocx(b) : n.endsWith('.xlsx') ? await textoXlsx(b) : b.toString('utf8'));
  }
  textos.push(await textoXlsx(await generarFichaExcel(modeloFicha(D, C, 0, {}))));
  const todo = textos.join('\n');
  const prohibido = [MARCA_INTERNA, 'Oferta', 'oferta', 'margen', 'Margen', 'fabricación', 'Fabricación', '13579', '13.579', '24680', '97531', '97.531', '86.42', '86,42', String(O.totales.costo)];
  for (const s of prohibido) assert.ok(!todo.includes(s), `«${s}» aparece en una exportación`);
  // Tampoco hay líneas de gastos generales, utilidad, gestión ni imprevistos en el expediente
  assert.doesNotMatch(todo, /utilidad|gastos generales|imprevistos|gestión del proyecto/i);
  // Y en el código: ningún exportador importa oferta.js ni la ruta del ZIP la lee
  const src = f => readFileSync(new URL('../src/selector-ioarr/' + f, import.meta.url), 'utf8');
  for (const f of ['word.js', 'excel-costos.js', 'excel.js', 'zip.js', 'documentos.js', 'ficha.js', 'ficha-digital.js', 'lineamientos.js', 'excel-lineamientos.js']) assert.doesNotMatch(src(f), /oferta\.js|leerOferta|calcularOferta/, f);
  const exp = src('expediente.js');
  const rutas = ['/documentos/formato-07c', '/documentos/memoria', '/documentos/verificacion', '/costos/excel', '/expediente-zip', '/fichas-zip', '/lineamientos/anexos', '/documentos/vida-util', '/documentos/formato-05b'];
  for (const r of rutas) {
    const i = exp.indexOf(`'/proyectos/:id${r}'`), cuerpo = exp.slice(i, exp.indexOf('\n  }));', i));
    assert.ok(i > 0, r); assert.doesNotMatch(cuerpo, /leerOferta|calcularOferta|ioarr_expediente_oferta/, r);
  }
  assert.doesNotMatch(src('router.js'), /oferta/i);   // el Excel del proyecto y el duplicado no la tocan
});

test('precios: editado → catálogo → referencia Loreto 2026', () => {
  const ef = preciosEfectivos({ precios: { mesa_p34: 400 } }, { silla_p12: { precio: 170, origen: 'vigente' } });
  assert.deepEqual([ef.mesa_p12.precio, ef.mesa_p12.origen], [PRECIOS_REFERENCIA.mesa_p12, 'referencia']);
  assert.deepEqual([ef.mesa_p34.precio, ef.mesa_p34.origen], [400, 'editado']);
  assert.deepEqual([ef.silla_p12.precio, ef.silla_p12.origen], [170, 'catalogo']);
  assert.deepEqual([ef.esc.precio, ef.esc.origen], [null, null]);
  assert.equal(LINEAS_KIT.length, TALLAS.length);
});
