// Pruebas de la estructura de costos del expediente IOARR (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import { prep, calc, totals, filtrar, FILTRO_VACIO, DEF, limpiarParams } from '../src/selector-ioarr/calculo.js';
import { costear, limpiarEstructura, limpiarInventario, censoLocal, factorZona, indiceFactores, tipoDesdeDescripcion, ESTRUCTURA_DEF } from '../src/selector-ioarr/costos.js';
import { generarExcelCostos } from '../src/selector-ioarr/excel-costos.js';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const moquegua = () => prep(JSON.parse(readFileSync(new URL('moquegua.json', DIR), 'utf8')));
const cerca = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

// Precios y estructura de PRUEBA (no son valores reales)
const PRECIOS = { mesa: 101.11, silla: 55.55, esc: 333.33, sdoc: 77.77, arm: 444.44 };
const EST = { transporte_pieza: 12.5, igv: 18, doc_pct: 3, sup_pct: 5, liquidacion: 15000 };
const FACTORES = [{ ambito: 'provincia', codigo: '1801', pct_flete: 20, pct_instalacion: 10 }, { ambito: 'distrito', codigo: '180301', pct_flete: 7, pct_instalacion: 0 },
  { ambito: 'rural', codigo: '18', pct_flete: 15, pct_instalacion: 5 }];

function casoMariscal(P = DEF, extra = {}) {
  const D = moquegua(), C = calc(D, P);
  const list = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
  return { D, C, list, T: totals(D, C, list), R: costear({ D, C, list, precios: PRECIOS, estructura: EST, uit: { anio: 2026, valor: 1000 }, ...extra }) };
}

test('caso de control: Moquegua «mariscal» → 198 bienes a reponer (Malo) y 1,531 de faltante aparte', () => {
  const { T, R } = casoMariscal();
  assert.deepEqual([T.n, T.est, T.aul, T.rep, T.fal], [11, 2085, 104, 198, 1531]);
  assert.deepEqual([R.totales.locales, R.totales.est, R.totales.aul, R.totales.rep, R.totales.fal], [11, 2085, 104, 198, 1531]);
  // Por tipo de bien: reposición = «A reponer» del Selector = Malo; faltante y diagnóstico iguales al Selector
  R.partidas.forEach((p, t) => {
    assert.equal(p.rep, T.t[t].rep); assert.equal(p.rep, T.t[t].m); assert.equal(p.fal, T.t[t].fal);
    assert.deepEqual([p.b, p.r, p.m, p.ex, p.req], [T.t[t].b, T.t[t].r, T.t[t].m, T.t[t].b + T.t[t].r + T.t[t].m, T.t[t].req]);
  });
  // Faltante por distrito: suma el total y no entra al costo
  assert.equal(R.distritos.reduce((a, d) => a + d.fal, 0), 1531);
  assert.equal(R.distritos.reduce((a, d) => a + d.rep, 0), 198);
});

test('el antiguo «% de Regular» guardado en un proyecto no cambia la reposición', () => {
  const a = casoMariscal(DEF).R, b = casoMariscal(limpiarParams({ ...DEF, regPct: 0.5 })).R;
  assert.deepEqual([b.totales.rep, b.totales.fal], [a.totales.rep, a.totales.fal]);
});

test('el faltante no entra al total y se valoriza aparte con aviso', () => {
  const { R } = casoMariscal();
  cerca(R.totales.bienes, R.partidas.reduce((s, p) => s + p.rep * p.pu, 0), 'bienes solo con reposición');
  cerca(R.totales.falValor, R.partidas.reduce((s, p) => s + p.fal * p.pu, 0), 'faltante valorizado');
  assert.ok(R.avisos.some(a => a.tipo === 'faltante'));
});

test('estructura sin utilidad: bienes + transporte, IGV, documento equivalente, supervisión y liquidación', () => {
  const { R } = casoMariscal(), T = R.totales;
  cerca(T.transporte, T.piezas * 12.5, 'transporte por pieza');
  assert.equal(T.piezas, T.rep);   // sin kit, una pieza por bien
  cerca(T.cd, T.bienes + T.transporte, 'costo directo');
  cerca(T.igv, Math.round(T.cd * 18) / 100, 'IGV sobre el CD');
  cerca(T.doc, Math.round(T.cd * 3) / 100, 'documento equivalente sobre el CD sin IGV');
  cerca(T.sup, Math.round(T.cd * 5) / 100, 'supervisión sobre el CD sin IGV');
  cerca(T.liq, 15000, 'liquidación fija');
  cerca(T.total, T.cd + T.igv + T.doc + T.sup + T.liq, 'monto de inversión');
  cerca(Math.round(R.locales.reduce((s, l) => s + l.total, 0) * 100) / 100, T.total, 'total = suma de locales');
  cerca(Math.round(R.distritos.reduce((s, d) => s + d.total, 0) * 100) / 100, T.total, 'total = suma de distritos');
  cerca(T.porEstudiante, T.total / 2085, 'costo por estudiante');
  // Ninguna línea de gastos generales, utilidad, gestión ni imprevistos
  const nombres = R.estructura.filas.map(f => f.nombre).join(' | ');
  assert.doesNotMatch(nombres, /utilidad|gastos generales|gestión|imprevistos/i);
});

test('factor por zona (para el transporte de la oferta interna): distrito antes que provincia, y rural se suma', () => {
  const idx = indiceFactores(FACTORES);
  assert.deepEqual(factorZona('180101', 0, idx), { flete: 0.20, instalacion: 0.10 });       // provincia 1801
  assert.deepEqual(factorZona('180301', 0, idx), { flete: 0.07, instalacion: 0 });          // distrito propio
  const r = factorZona('180101', 1, idx); cerca(r.flete, 0.35, 'rural flete'); cerca(r.instalacion, 0.15, 'rural instalación');
  assert.deepEqual(factorZona('180204', 0, idx), { flete: 0, instalacion: 0 });
  // Transporte de cada local = CD × 5 % × (1 + factor)
});

test('aviso de 75 UIT', () => {
  const bajo = casoMariscal(DEF, { uit: { anio: 2026, valor: 100000 } }).R;
  assert.equal(bajo.uit.supera, false);
  // «mariscal» es una inversión masiva: siempre registro completo, aunque no supere 75 UIT
  assert.equal(bajo.uit.masiva, true); assert.equal(bajo.uit.registro, 'completo');
  assert.ok(bajo.avisos.some(a => a.tipo === 'uit75' && /Registro completo \(masiva\)/.test(a.texto)));
  const alto = casoMariscal(DEF, { uit: { anio: 2026, valor: 100 } }).R;
  assert.equal(alto.uit.supera, true);
  assert.equal(alto.uit.limite, 7500);
  assert.ok(alto.avisos.some(a => a.tipo === 'uit75'));
  const sin = casoMariscal(DEF, { uit: { anio: 2026, valor: null } }).R;
  assert.equal(sin.uit.supera, null);
  assert.ok(sin.avisos.some(a => a.tipo === 'uit'));
});

test('sin precios: bienes en 0 y avisos (no se inventan precios dentro del cálculo)', () => {
  const D = moquegua(), C = calc(D, DEF), list = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
  const R = costear({ D, C, list, precios: {}, estructura: {}, uit: null });
  assert.equal(R.totales.bienes, 0);
  assert.ok(R.partidas.every(p => p.pu === null));
  // «censo»: en «mariscal» hay colegios con más mesas o sillas que matrícula (no aumentar capacidad)
  assert.deepEqual(R.avisos.map(a => a.tipo).sort(), ['censo', 'control_concurrente', 'faltante', 'precio', 'uit']);
  // La estructura por defecto: transporte 19.50 por pieza, IGV 18 %, 3 %, 5 % y 15,000
  // Control concurrente (Ley 31358): vacío por defecto, no se inventa si corresponde ni su %
  assert.deepEqual(R.estructura.params, { igv: 18, doc_pct: 3, sup_pct: 5, liquidacion: 15000, transporte_pieza: 19.5, kit_dist: [1, 1, 1], cc_aplica: '', cc_pct: null, cc_umbral: null, cc_corresponde: false });
  assert.equal(R.totales.cc, 0);
});

test('limpiarEstructura: valores válidos y lo desconocido se descarta', () => {
  const e = limpiarEstructura({ igv: -5, doc_pct: 200, liquidacion: 'x', kit: 'si', kit_dist: [0, 0, 0], precios: { mesa_p12: 400, otro: 3, silla: -1 }, utilidad: 10 });
  assert.deepEqual(e, { ...ESTRUCTURA_DEF, igv: 0, doc_pct: 100, kit: false, precios: { mesa_p12: 400 } });
  assert.ok(!('utilidad' in e));
});

// ─── Excel ───────────────────────────────────────────────────────────────────
const meta = { proyecto: 'PRUEBA Mariscal', region: 'Moquegua', fecha: '2026-10-20', criterios: 'por defecto' };

test('Excel de costos: hojas, fórmulas y total igual a la pantalla', async () => {
  const { R } = casoMariscal();
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await generarExcelCostos(R, meta));
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Resumen', 'Parámetros', 'Partidas', 'Metrado y costos por local', 'Por distrito']);
  const res = wb.getWorksheet('Resumen');
  // Tabla 3.7: C = A + B, y una fila de control con el total de la hoja de metrado
  let total = null, control = null;
  res.eachRow(row => { if (row.getCell(1).value === 'C = A + B. COSTO DE INVERSIÓN (MONTO DE INVERSIÓN)') total = row.getCell(2).value; if (/^Control: monto/.test(row.getCell(1).value || '')) control = row.getCell(2).value; });
  assert.match(total.formula, /^B\d+\+B\d+$/);
  cerca(total.result, R.totales.total, 'total del Excel');
  assert.match(control.formula, /^'Metrado y costos por local'!/);
  const m = wb.getWorksheet('Metrado y costos por local');
  assert.equal(m.rowCount, 11 + 2);  // cabecera + 11 locales + totales
  // Las cantidades de reposición del Excel suman lo mismo que la pantalla
  // (mesa y silla, una columna por talla)
  const cols = m.getRow(1).values.map((v, c) => /– cantidad/.test(v || '') ? c : null).filter(c => c != null);
  assert.equal(cols.length, R.lineas.length);
  let suma = 0; for (let r = 2; r <= 12; r++) for (const c of cols) suma += m.getRow(r).getCell(c).value;
  assert.equal(suma, R.totales.rep);
});

// Recalcula el libro con LibreOffice (si está instalado) para comprobar que las fórmulas son correctas y están vivas
const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
function recalcular(buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'costos-'));
  try {
    const perfil = join(dir, 'perfil', 'user'); execFileSync('mkdir', ['-p', perfil]);
    writeFileSync(join(perfil, 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item></oor:items>`);
    writeFileSync(join(dir, 'c.xlsx'), buffer);
    execFileSync('soffice', [`-env:UserInstallation=file://${join(dir, 'perfil')}`, '--headless', '--calc', '--convert-to',
      'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1', '--outdir', join(dir, 'out'), join(dir, 'c.xlsx')], { stdio: 'ignore', timeout: 120000 });
    const hojas = {};
    for (const f of readdirSync(join(dir, 'out'))) hojas[f.replace(/^c-|\.csv$/g, '')] = readFileSync(join(dir, 'out', f), 'utf8');
    return hojas;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const valorResumen = (csv, etiqueta) => Number(csv.split('\n').find(l => l.startsWith(etiqueta + ',')).split(',')[1]);

test('Excel recalculado con LibreOffice: mismo total, y cambia al editar un parámetro', { skip: !soffice && 'LibreOffice no está instalado' }, async () => {
  const { R } = casoMariscal();
  const buf = await generarExcelCostos(R, meta);
  const h1 = recalcular(buf);
  cerca(Math.round(valorResumen(h1.Resumen, 'C = A + B. COSTO DE INVERSIÓN (MONTO DE INVERSIÓN)') * 100), Math.round(R.totales.total * 100), 'total recalculado');
  assert.match(h1.Partidas, /Diferencia \(debe ser 0\),,,,0(,|\n)/);

  // Cambia el precio del escritorio y la UIT en el Excel, sin tocar los resultados guardados
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const p = wb.getWorksheet('Parámetros');
  let cambiadas = 0;
  p.eachRow(row => { if (row.getCell(1).value === 'Escritorio docente') { row.getCell(3).value = 200; cambiadas++; } });
  assert.equal(cambiadas, 1);
  let filaUit; p.eachRow((row, n) => { if (row.getCell(1).value === 'Valor de la UIT (S/)') filaUit = n; });
  p.getCell(filaUit, 2).value = 500;
  const h2 = recalcular(Buffer.from(await wb.xlsx.writeBuffer()));
  const D = moquegua(), C = calc(D, DEF), list = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
  const R2 = costear({ D, C, list, precios: { ...PRECIOS, esc: 200 }, estructura: EST, uit: { anio: 2026, valor: 500 } });
  cerca(Math.round(valorResumen(h2.Resumen, 'C = A + B. COSTO DE INVERSIÓN (MONTO DE INVERSIÓN)') * 100), Math.round(R2.totales.total * 100), 'total tras cambiar el precio');
  assert.equal(R2.uit.supera, true);
  assert.match(h2.Resumen, /Registro que corresponde,"REGISTRO COMPLETO \(MASIVA\)/);   // «mariscal» es masiva
});

test('Excel con control concurrente (Ley 31358): A + B = C y LibreOffice da el mismo total', { skip: !soffice && 'LibreOffice no está instalado' }, async () => {
  const D = moquegua(), C = calc(D, DEF), list = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
  const R = costear({ D, C, list, precios: PRECIOS, estructura: { ...EST, cc_aplica: 'si', cc_pct: 2 }, uit: { anio: 2026, valor: 5500 } });
  assert.ok(R.totales.cc > 0);
  const h = recalcular(await generarExcelCostos(R, meta));
  const T = 'C = A + B. COSTO DE INVERSIÓN (MONTO DE INVERSIÓN)';
  cerca(Math.round(valorResumen(h.Resumen, T) * 100), Math.round(R.totales.total * 100), 'total con control concurrente');
  cerca(Math.round(valorResumen(h.Resumen, 'Control concurrente (Ley 31358)') * 100), Math.round(R.totales.cc * 100), 'control concurrente');
  cerca(Math.round(valorResumen(h.Resumen, 'B. OTROS COSTOS DE INVERSIÓN') * 100), Math.round(R.totales.b * 100), 'B');
});

test('copiar de Radar IOARR: el tipo de bien se propone por la descripción', () => {
  const casos = {
    'MESA UNIPERSONAL PARA ESTUDIANTE DE PRIMARIA': 'mesa', 'Carpeta bipersonal': 'mesa', 'PUPITRE': 'mesa',
    'SILLA PARA ESTUDIANTE': 'silla', 'Silla de profesor': 'sdoc', 'SILLA PARA DOCENTE': 'sdoc',
    'ESCRITORIO': 'esc', 'MESA PARA DOCENTE': 'esc', 'Armario de melamina': 'arm', 'ESTANTE METÁLICO': 'arm',
    'PIZARRA ACRÍLICA': null, '': null
  };
  for (const [d, t] of Object.entries(casos)) assert.equal(tipoDesdeDescripcion(d), t, d);
});

test('inventario verificado: las mesas que el censo no reporta pasan de faltante a reposición (Chiclayo, 11124)', () => {
  const D = prep(JSON.parse(readFileSync(new URL('lambayeque.json', DIR), 'utf8'))), C = calc(D, DEF);
  const i = D.locs.findIndex(l => l[0] === '276008'), list = [i];
  const base = { D, C, list, precios: PRECIOS, estructura: EST, uit: { anio: 2026, valor: 1000 } };
  const censo = censoLocal(C, i);
  assert.deepEqual(censo.mesa, { b: 0, r: 0, m: 0, req: 569 });
  const a = costear(base);
  assert.deepEqual([a.partidas[0].rep, a.partidas[0].fal, a.partidas[1].rep], [0, 569, 189]);

  // Visita: las 569 mesas existen y están en mal estado; las sillas no se tocan
  const inventario = { '276008': { bienes: limpiarInventario({ mesa: { b: 0, r: 0, m: 569 } }), fecha_visita: '2026-10-20', observacion: 'Acta de visita' } };
  const b = costear({ ...base, inventario });
  assert.deepEqual([b.partidas[0].rep, b.partidas[0].fal, b.partidas[1].rep, b.partidas[1].fal], [569, 0, 189, 0]);
  cerca(b.totales.bienes, 569 * PRECIOS.mesa + 189 * PRECIOS.silla, 'bienes con las mesas');
  assert.deepEqual(b.locales[0].verificado.tipos, ['mesa']);
  assert.ok(b.avisos.some(x => x.tipo === 'inventario'));
  assert.ok(!b.avisos.some(x => x.tipo === 'faltante'));

  // Menos de lo requerido: reposición = M (el regular no se repone), faltante = req − existente
  const c = costear({ ...base, inventario: { '276008': { bienes: { mesa: { b: 100, r: 101, m: 300 } }, fecha_visita: '2026-10-20', observacion: 'x' } } });
  assert.deepEqual([c.partidas[0].rep, c.partidas[0].fal, c.partidas[0].b, c.partidas[0].r, c.partidas[0].m], [300, 569 - 501, 100, 101, 300]);

  assert.throws(() => limpiarInventario({ mesa: { b: -1, r: 0, m: 0 } }), /no válidas/);
  assert.deepEqual(limpiarInventario({ mesa: { m: 3 }, otro: { m: 1 } }), { mesa: { b: 0, r: 0, m: 3 } });
});

test('Excel de costos: hoja «Inventario verificado» y columna Inventario', async () => {
  const D = prep(JSON.parse(readFileSync(new URL('lambayeque.json', DIR), 'utf8'))), C = calc(D, DEF);
  const i = D.locs.findIndex(l => l[0] === '276008');
  const fila = { cod_local: '276008', bienes: { mesa: { b: 0, r: 0, m: 569 } }, censo: censoLocal(C, i), fecha_visita: '2026-10-20', responsable: 'Equipo Ibero', observacion: 'Acta firmada por el director' };
  const R = costear({ D, C, list: [i], precios: PRECIOS, estructura: EST, uit: { anio: 2026, valor: 1000 }, inventario: { '276008': fila } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await generarExcelCostos(R, { proyecto: 'Prueba', region: 'Lambayeque', fecha: '2026-10-21', criterios: '', precios: {}, inventario: { '276008': fila } }));
  const ws = wb.getWorksheet('Inventario verificado');
  assert.ok(ws);
  assert.deepEqual(ws.getRow(4).values.slice(1, 13), ['276008', R.locales[0].nom, 'Mesa del estudiante', 0, 0, 0, 0, 0, 569, 569, 569, 0]);
  const wm = wb.getWorksheet('Metrado y costos por local');
  const col = wm.getRow(1).values.indexOf('Inventario');
  assert.equal(wm.getRow(2).getCell(col).value, 'Verificado en campo 20/10/2026');
});

test('sustento: el tipo real del archivo se reconoce por su contenido', async () => {
  const { mimeDe, nombreSeguro } = await import('../src/selector-ioarr/archivos.js');
  const b = (...x) => Buffer.concat([Buffer.from(x), Buffer.alloc(12)]);
  assert.equal(mimeDe(Buffer.from('%PDF-1.7\n%âãÏÓ\n')), 'application/pdf');
  assert.equal(mimeDe(b(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(mimeDe(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)), 'image/png');
  assert.equal(mimeDe(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(mimeDe(Buffer.from('\0\0\0\x18ftypheic\0\0')), 'image/heic');
  assert.equal(mimeDe(Buffer.from('\0\0\0\x18ftypmif1\0\0')), 'image/heif');
  assert.equal(mimeDe(Buffer.from('MZ ejecutable disfrazado.pdf')), null);
  assert.equal(mimeDe(Buffer.from('<html><script>')), null);
  assert.equal(nombreSeguro('Acta de visita – 11124 Ñaña.pdf'), 'Acta_de_visita_11124_Nana.pdf');
  assert.equal(nombreSeguro('../../etc/passwd'), '.._.._etc_passwd');
});

test('Excel: la hoja «Inventario verificado» lista los archivos y marca si falta el acta', async () => {
  const D = prep(JSON.parse(readFileSync(new URL('lambayeque.json', DIR), 'utf8'))), C = calc(D, DEF);
  const i = D.locs.findIndex(l => l[0] === '276008');
  const base = { cod_local: '276008', bienes: { mesa: { b: 0, r: 0, m: 569 } }, censo: censoLocal(C, i), fecha_visita: '2026-10-20', observacion: 'Visita' };
  const leer = async archivos => {
    const fila = { ...base, archivos };
    const R = costear({ D, C, list: [i], precios: PRECIOS, estructura: EST, uit: { anio: 2026, valor: 1000 }, inventario: { '276008': fila } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await generarExcelCostos(R, { proyecto: 'P', region: 'Lambayeque', fecha: '2026-10-21', criterios: '', precios: {}, inventario: { '276008': fila } }));
    return wb.getWorksheet('Inventario verificado').getCell(4, 16);
  };
  const sin = await leer([]);
  assert.match(sin.value, /PENDIENTE/);
  assert.equal(sin.fill?.fgColor?.argb, 'FFFFF3B0');
  const con = await leer([{ tipo: 'acta', nombre_archivo: 'acta.pdf' }, { tipo: 'foto', nombre_archivo: 'a.jpg' }, { tipo: 'foto', nombre_archivo: 'b.jpg' }]);
  assert.equal(con.value, 'Acta de verificación (1): acta.pdf · Foto (2): a.jpg, b.jpg');
  assert.notEqual(con.fill?.fgColor?.argb, 'FFFFF3B0');
});
