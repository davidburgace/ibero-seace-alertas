// Pruebas de las tallas de mesa y silla y de la elección de muebles de la IOARR (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { prep, calc, filtrar, FILTRO_VACIO, DEF, limpiarParams, tallasDeAula, TALLAS, LINEAS, CLAVES_PRECIO } from '../src/selector-ioarr/calculo.js';
import { costear, repartir } from '../src/selector-ioarr/costos.js';
import { generarExcelCostos } from '../src/selector-ioarr/excel-costos.js';
import { modeloFicha } from '../src/selector-ioarr/ficha.js';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const moquegua = () => prep(JSON.parse(readFileSync(new URL('moquegua.json', DIR), 'utf8')));
const PRECIOS = { mesa: 100, silla: 50, esc: 300, sdoc: 80, arm: 400 };   // de PRUEBA
const sumaDe = (xs, c) => xs.reduce((a, x) => a + x[c], 0);

// Región mínima: un local con Primaria (un aula de 3.° y una multigrado) y Secundaria (un aula de 5.°)
// f: 0-2 mesa unip. B/R/M · 3-5 mesa múltiple · 6-7 carpetas · 8-10 silla B/R/M · 11-13 escritorio · 14-16 silla docente · 17-19 armario
function aula(iSvc, grado, est, f) { const v = new Array(20).fill(0); for (const [j, n] of Object.entries(f)) v[j] = n; return [0, iSvc, 'E1', 1, '1', grado, 'A', 'M', est, 0, 0, ...v]; }
function mini() {
  return prep({
    region: 'Prueba', provs: ['Prov'], ugels: ['UGEL'], dists: [['Dist', '010101', 0]],
    locs: [['000001', 0, 0, 'CP', 0, 'Dir', -12, -77]],
    svcs: [['0000001', 'IE Primaria', 'P', 0, 0, 2, 40, 'M'], ['0000002', 'IE Secundaria', 'S', 0, 0, 1, 20, 'M']],
    aulas: [
      aula(0, '3° Primaria', 20, { 2: 4, 10: 4, 13: 1, 19: 2 }),   // 4 mesas y 4 sillas malas, 1 escritorio, 2 armarios
      aula(0, 'Multigrado', 20, { 2: 3, 10: 3 }),                   // 3 mesas y 3 sillas malas: 1 por talla de Primaria
      aula(1, '5° Secundaria', 20, { 2: 2, 10: 5 })
    ]
  });
}

test('talla del aula según nivel y grado; multigrado y sin grado = todas las tallas del nivel', () => {
  const k = js => js.map(j => TALLAS[j].k);
  assert.deepEqual(k(tallasDeAula('P', '1° Primaria')), ['p12']);
  assert.deepEqual(k(tallasDeAula('P', '4° Primaria')), ['p34']);
  assert.deepEqual(k(tallasDeAula('P', '6° Primaria')), ['p56']);
  assert.deepEqual(k(tallasDeAula('S', '2° Secundaria')), ['s12']);
  assert.deepEqual(k(tallasDeAula('S', '3° Secundaria')), ['s34']);
  assert.deepEqual(k(tallasDeAula('S', '5° Secundaria')), ['s5']);
  assert.deepEqual(k(tallasDeAula('P', 'Multigrado')), ['p12', 'p34', 'p56']);
  assert.deepEqual(k(tallasDeAula('S', '')), ['s12', 's34', 's5']);
  assert.deepEqual(k(tallasDeAula('I', 'Inicial 4 años')), ['i']);
  assert.deepEqual(k(tallasDeAula('E', 'Multigrado')), ['e']);
  // 8 tallas × mesa y silla + escritorio, silla docente y armario
  assert.equal(LINEAS.length, 19);
  assert.ok(CLAVES_PRECIO.includes('mesa') && CLAVES_PRECIO.includes('silla_s5') && !CLAVES_PRECIO.includes('esc_p12'));
});

test('repartir: enteros que suman el total, por mayor resto', () => {
  assert.deepEqual(repartir(3, [1, 1, 1]), [1, 1, 1]);
  assert.deepEqual(repartir(4, [1, 1, 1]), [2, 1, 1]);
  assert.deepEqual(repartir(10, [0.5, 0.25, 0.25]), [5, 3, 2]);
  assert.deepEqual(repartir(5, [0, 0]), [0, 0]);
  assert.deepEqual(repartir(0, [1, 2]), [0, 0]);
});

test('multigrado se reparte en partes iguales entre las tallas de su nivel', () => {
  const D = mini(), C = calc(D, DEF);
  const R = costear({ D, C, list: [0], precios: PRECIOS, rubros: [], factores: [], uit: null });
  const rep = k => R.lineas.find(x => x.k === k)?.rep ?? 0;
  // Sillas: 4 de 3.° + 1 de la multigrado en p34; 1 en p12 y p56; 5 en s5
  assert.deepEqual(['silla_p12', 'silla_p34', 'silla_p56', 'silla_s12', 'silla_s34', 'silla_s5'].map(rep), [1, 5, 1, 0, 0, 5]);
  assert.deepEqual(['mesa_p12', 'mesa_p34', 'mesa_p56', 'mesa_s5'].map(rep), [1, 5, 1, 2]);
  // Las tallas sin nada no aparecen; escritorio y armario van en una sola línea
  assert.ok(!R.lineas.some(x => x.k === 'silla_i' || x.k === 'mesa_e'));
  assert.equal(rep('esc'), 1); assert.equal(rep('arm'), 2);
  // Las tallas suman lo del tipo
  for (const p of R.partidas) assert.equal(sumaDe(R.lineas.filter(x => x.tipo === p.k), 'rep'), p.rep);
});

test('cada talla con su precio; sin precio propio usa el de su tipo', () => {
  const D = mini(), C = calc(D, DEF);
  const R = costear({ D, C, list: [0], precios: { ...PRECIOS, silla_s5: 70 }, rubros: [], factores: [], uit: null });
  const l = k => R.lineas.find(x => x.k === k);
  assert.equal(l('silla_s5').pu, 70); assert.equal(l('silla_s5').pu_propio, true);
  assert.equal(l('silla_p34').pu, 50); assert.equal(l('silla_p34').pu_propio, false);
  assert.equal(l('silla_s5').parcial, 5 * 70);
  const silla = R.partidas.find(p => p.k === 'silla');
  assert.equal(silla.parcial, 7 * 50 + 5 * 70);
  assert.equal(silla.pu_varia, true);
  assert.equal(R.totales.cd, sumaDe(R.lineas, 'parcial'));
  assert.equal(R.totales.cd, R.locales[0].cd);

  // Solo precios por talla, sin precio general: avisa las tallas que faltan
  const R2 = costear({ D, C, list: [0], precios: { mesa: 100, esc: 300, arm: 400, silla_p34: 60 }, rubros: [], factores: [], uit: null });
  const aviso = R2.avisos.find(a => a.tipo === 'precio').texto;
  assert.match(aviso, /Silla del estudiante – Primaria 1\.° y 2\.°/);
  assert.match(aviso, /Silla del estudiante – Secundaria 5\.°/);
  assert.doesNotMatch(aviso, /Primaria 3\.° y 4\.°/);
  assert.equal(R2.partidas.find(p => p.k === 'silla').pu, null);
});

test('muebles de la IOARR: los que no entran quedan en 0 en el cálculo, el costo y el Excel', async () => {
  assert.deepEqual(limpiarParams({ muebles: ['silla', 'mesa', 'otro'] }).muebles, ['mesa', 'silla']);
  assert.deepEqual(limpiarParams({ muebles: [] }).muebles, DEF.muebles);
  assert.deepEqual(limpiarParams({}).muebles, ['mesa', 'silla', 'esc', 'sdoc', 'arm']);

  const D = moquegua(), P = limpiarParams({ muebles: ['mesa', 'silla'] });
  const Ct = calc(D, DEF), C = calc(D, P);
  const list = filtrar(D, Ct, { ...FILTRO_VACIO(), q: 'mariscal' });
  const Rt = costear({ D, C: Ct, list, precios: PRECIOS, rubros: [], factores: [], uit: null });
  // Inventario verificado con armarios: no vuelve a meterlos
  const cod = D.locs[list[0]][0];
  const inventario = { [cod]: { bienes: { arm: { b: 0, r: 0, m: 9 } }, fecha_visita: '2026-10-01', observacion: 'visita' } };
  const R = costear({ D, C, list, precios: PRECIOS, rubros: [], factores: [], uit: null, inventario });
  for (const k of ['esc', 'sdoc', 'arm']) {
    const p = R.partidas.find(x => x.k === k);
    assert.equal(p.excluido, true); assert.equal(p.rep + p.fal + p.ex + p.parcial, 0);
  }
  assert.ok(R.lineas.every(x => ['mesa', 'silla'].includes(x.tipo)));
  // Mesa y silla no cambian
  for (const k of ['mesa', 'silla']) assert.equal(R.partidas.find(x => x.k === k).rep, Rt.partidas.find(x => x.k === k).rep);
  assert.equal(R.totales.rep, Rt.partidas.filter(p => ['mesa', 'silla'].includes(p.k)).reduce((a, p) => a + p.rep, 0));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await generarExcelCostos(R, { proyecto: 'Prueba', region: 'Moquegua', fecha: '2026-10-23', precios: {} }));
  const cab = wb.getWorksheet('Metrado y costos por local').getRow(1).values.filter(Boolean);
  assert.ok(!cab.some(v => /Escritorio|Armario|Silla docente/.test(v)));
  assert.ok(cab.some(v => /Silla del estudiante – Secundaria 5\.° – reposición/.test(v)));

  // La ficha de verificación solo lista los muebles que entran
  assert.deepEqual(modeloFicha(D, C, list[0]).bienes.map(b => b.k), ['mesa', 'silla']);
  assert.equal(modeloFicha(D, Ct, list[0]).bienes.length, 5);
});

test('Moquegua «mariscal»: el reparto por talla no cambia los totales', () => {
  const D = moquegua(), C = calc(D, DEF);
  const list = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
  const R = costear({ D, C, list, precios: PRECIOS, rubros: [], factores: [], uit: null });
  assert.equal(R.totales.rep, 198);
  for (const p of R.partidas) {
    const ls = R.lineas.filter(x => x.tipo === p.k);
    for (const c of ['rep', 'fal', 'b', 'r', 'm', 'req']) assert.equal(sumaDe(ls, c), p[c], `${p.k}.${c}`);
  }
  // Con un solo precio por tipo, el costo es el mismo que sin tallas
  assert.equal(R.totales.cd, R.partidas.reduce((a, p) => a + p.rep * PRECIOS[p.k], 0));
  for (const l of R.locales) for (const k of ['mesa', 'silla']) {
    const t = ['mesa', 'silla'].indexOf(k);
    assert.equal(LINEAS.reduce((a, x, j) => a + (x.tipo === k ? l.lin.rep[j] : 0), 0), l.rep[t]);
  }
});
