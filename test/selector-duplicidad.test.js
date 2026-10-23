// Pruebas de «Otra inversión vigente o reciente» (duplicidad) del Selector IOARR (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { prep, calc, totals, filtrar, FILTRO_VACIO, DEF } from '../src/selector-ioarr/calculo.js';
import { generarExcel } from '../src/selector-ioarr/excel.js';
import { costear } from '../src/selector-ioarr/costos.js';
import { armarModelo, limpiarDatosDoc } from '../src/selector-ioarr/documentos.js';
import { limpiarDuplicidad, separarLocales, avisosDuplicidad, resumenDuplicidad, estadoDe, esVacia, ROTULO_DUP } from '../src/selector-ioarr/duplicidad.js';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const D = prep(JSON.parse(readFileSync(new URL('moquegua.json', DIR), 'utf8')));
const C = calc(D, DEF);
const LISTA = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
const CODS = LISTA.map(i => D.locs[i][0]);
const ICHUNA = '398420';   // 200 / Mariscal Ramón Castilla: 131 sillas en mal estado
const si = (codigo, excluir) => ({ estado: 'si', codigo, nota: null, excluir });
const no = { estado: 'no', codigo: null, nota: null, excluir: false };

test('limpiarDuplicidad: estados válidos y solo se excluye un local marcado «Sí»', () => {
  assert.deepEqual(limpiarDuplicidad({ estado: 'si', codigo: ' 2512345 ', excluir: true, nota: '  ok  ' }), { estado: 'si', codigo: '2512345', nota: 'ok', excluir: true });
  assert.equal(limpiarDuplicidad({ estado: 'no', excluir: true }).excluir, false);
  assert.equal(limpiarDuplicidad({ estado: 'sin_verificar', excluir: true }).excluir, false);
  assert.throws(() => limpiarDuplicidad({ estado: 'quizas' }), /Estado no válido/);
  assert.throws(() => limpiarDuplicidad({ estado: 'si', codigo: '25<script>' }), /Código de inversión no válido/);
  assert.ok(esVacia(limpiarDuplicidad({ estado: 'sin_verificar' })));
  assert.ok(!esVacia(limpiarDuplicidad({ estado: 'sin_verificar', nota: 'pendiente de la OPMI' })));
  assert.equal(estadoDe({}, ICHUNA).estado, 'sin_verificar');
});

test('un local excluido sale de la propuesta; uno marcado «Sí» sin excluir sigue y avisa', () => {
  const sinMarcas = separarLocales(D, CODS, {});
  assert.equal(sinMarcas.list.length, 11); assert.equal(sinMarcas.excluidos.length, 0);

  const mapa = { [ICHUNA]: si('2512345', true) };
  const { list, excluidos } = separarLocales(D, CODS, mapa);
  assert.equal(list.length, 10);
  assert.deepEqual(excluidos.map(i => D.locs[i][0]), [ICHUNA]);
  const T = totals(D, C, list);
  assert.equal(T.rep, 198 - 133);   // Ichuña repone 133 (131 sillas y 2 armarios)
  assert.deepEqual(resumenDuplicidad(mapa, CODS), { si: 1, no: 0, sin_verificar: 10, excluidos: 1, si_incluidos: 0, si_sin_codigo: 0 });
  const av = avisosDuplicidad(mapa, CODS);
  assert.ok(av.some(a => /quedó excluido/.test(a.texto)));
  assert.ok(av.some(a => /10 locales sin verificar/.test(a.texto)));
  assert.ok(!av.some(a => a.alerta));

  // «Sí» sin excluir y sin código: sigue en la propuesta, con alerta y aviso del código
  const sigue = { [ICHUNA]: si(null, false) };
  assert.equal(separarLocales(D, CODS, sigue).list.length, 11);
  const av2 = avisosDuplicidad(sigue, CODS);
  assert.ok(av2.some(a => a.alerta && /riesgo de duplicidad/.test(a.texto)));
  assert.ok(av2.some(a => /Falta el código/.test(a.texto)));
});

test('Excel del Selector: columnas de duplicidad y hoja de excluidos', async () => {
  const mapa = { [ICHUNA]: { ...si('2512345', true), nota: 'Inversión de 2025 con mobiliario' }, '399759': no };
  const { list, excluidos } = separarLocales(D, CODS, mapa);
  const { buffer } = await generarExcel(D, C, DEF, list, { proyecto: 'Prueba', fecha: '2026-10-21', ioarr: null, duplicidad: mapa, excluidos });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
  assert.ok(wb.getWorksheet('Excluidos por duplicidad'));

  const res = wb.getWorksheet('Resumen');
  const fila = txt => { let r = null; res.eachRow(row => { if (row.getCell(1).value === txt) r = row; }); return r; };
  assert.equal(fila('Bienes a reponer (estado Malo, suma de los muebles de la IOARR)').getCell(2).value.result, 65);
  assert.equal(fila('Locales excluidos por otra inversión vigente o reciente').getCell(2).value, 1);
  assert.equal(fila(ROTULO_DUP + ' (sí / no / sin verificar)').getCell(2).value, '0 / 1 / 9');

  const lo = wb.getWorksheet('Locales (UP)'), cab = lo.getRow(1).values;
  const cDup = cab.indexOf(ROTULO_DUP), cCod = cab.indexOf('Código de local');
  assert.ok(cDup > 0);
  assert.equal(lo.rowCount - 1, 10);
  const estados = {}; lo.eachRow((r, n) => { if (n > 1) estados[r.getCell(cCod).value] = r.getCell(cDup).value; });
  assert.equal(estados['399759'], 'No'); assert.equal(estados['397005'], 'Sin verificar'); assert.equal(estados[ICHUNA], undefined);

  const ex = wb.getWorksheet('Excluidos por duplicidad').getRow(2).values;
  assert.deepEqual([ex[1], ex[6], ex[7], ex[8]], [ICHUNA, 133, '2512345', 'Inversión de 2025 con mobiliario']);

  // Sin excluidos no aparece la hoja
  const otro = await generarExcel(D, C, DEF, LISTA, { proyecto: 'Prueba', fecha: '2026-10-21', ioarr: null });
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(otro.buffer);
  assert.equal(wb2.getWorksheet('Excluidos por duplicidad'), undefined);
});

// Igual que armar() de expediente.js: separa, costea y marca cada local
function modelo(mapa) {
  const { list, excluidos } = separarLocales(D, CODS, mapa);
  const R = costear({ D, C, list, precios: { mesa: 180, silla: 90, esc: 400, sdoc: 120, arm: 650 }, rubros: [], factores: [], uit: { anio: 2026, valor: 5500 } });
  for (const l of R.locales) l.duplicidad = estadoDe(mapa, l.cod);
  R.excluidos = excluidos.map(i => ({ cod: D.locs[i][0], ...estadoDe(mapa, D.locs[i][0]) }));
  return armarModelo({ R, D, list, proyecto: { nombre: 'Mariscal', region: 'Moquegua' }, datos: limpiarDatosDoc({}), precios: {}, fecha: '2026-10-21' });
}
const itemDup = M => M.verificacion.secciones.flatMap(s => s.items).find(x => /Otra inversión vigente o reciente descartada/.test(x.texto));

test('lista de verificación: «No» en todos = cumple; «Sí» sin excluir = bloquea; excluidos en la memoria', () => {
  assert.equal(itemDup(modelo({})).estado, 'pendiente');
  const todosNo = Object.fromEntries(CODS.map(c => [c, no]));
  assert.equal(itemDup(modelo(todosNo)).estado, 'ok');

  const conSi = { ...todosNo, [ICHUNA]: si('2512345', false) };
  const M = modelo(conSi);
  assert.equal(itemDup(M).estado, 'no');
  assert.match(itemDup(M).nota, /398420 \(2512345\)/);
  assert.ok(M.verificacion.bloqueos >= 1);

  const M2 = modelo({ ...todosNo, [ICHUNA]: si('2512345', true) });
  assert.equal(itemDup(M2).estado, 'ok');
  assert.match(itemDup(M2).nota, /1 local excluido/);
  assert.deepEqual(M2.excluidos.map(x => x.cod), [ICHUNA]);
  assert.ok(!M2.ups.some(u => u.cod === ICHUNA));
});
