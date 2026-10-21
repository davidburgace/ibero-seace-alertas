// Pruebas del cuadro de estado situacional por UGEL y nivel (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { prep, calc, filtrar, FILTRO_VACIO, DEF, estadoSituacional, piTexto } from '../src/selector-ioarr/calculo.js';
import { generarExcel } from '../src/selector-ioarr/excel.js';
import { limpiarDatosDoc } from '../src/selector-ioarr/documentos.js';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const leer = r => JSON.parse(readFileSync(new URL(r + '.json', DIR), 'utf8'));
const D = prep(leer('moquegua')), C = calc(D, DEF);
const LISTA = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });

test('caso de control: subtotales por nivel y total de Moquegua «mariscal»', () => {
  const E = estadoSituacional(D, C, LISTA, c => c === '398420' ? 'si' : 'no');
  assert.deepEqual(E.niveles.map(x => [x.nivel, x.filas.length, x.subtotal.n, x.subtotal.est, x.subtotal.aul, x.subtotal.m]), [['I', 2, 6, 280, 15, 17], ['P', 3, 4, 1056, 40, 101], ['S', 4, 4, 749, 49, 80]]);
  assert.deepEqual([E.total.est, E.total.aul, E.total.b, E.total.r, E.total.m], [2085, 104, 1893, 5621, 198]);
  assert.deepEqual(E.advertencias, []);
  // Cuenta con proyecto de inversión: Sí si algún local de la fila tiene otra inversión
  const ichuna = E.niveles[0].filas.find(f => /Ichuña/i.test(f.ugel));
  assert.equal(piTexto(ichuna.pi), 'Sí');
  assert.equal(piTexto(E.niveles[0].filas.find(f => /Mariscal Nieto/.test(f.ugel)).pi), 'No');
  assert.equal(piTexto(estadoSituacional(D, C, LISTA).total.pi), 'Sin verificar');
  // Por UGEL, sumado por nivel = contado por local
  assert.ok(E.porUgel.every(u => u.ok));
  assert.equal(E.porUgel.find(u => /Mariscal Nieto/.test(u.ugel)).est, 902);
  // Listas por UGEL: una fila por servicio, con centro poblado, distrito y UGEL
  const L = E.listas.find(l => /Ichuña/i.test(l.ugel));
  assert.deepEqual(L.filas.map(x => [x.cod, x.nivel, x.est]), [['398420', 'I', 47], ['398420', 'P', 106], ['398420', 'S', 101]]);
  assert.ok(L.filas.every(x => x.cp && x.dist && x.ugel && x.inst));
});

test('las comprobaciones pasan en regiones completas (Lima y Moquegua)', () => {
  for (const r of ['moquegua', 'lima']) {
    const Dr = prep(leer(r)), Cr = calc(Dr, DEF), E = estadoSituacional(Dr, Cr, Dr.locs.map((_, i) => i));
    assert.ok(!E.advertencias.some(a => a.tipo === 'suma'), r);
    assert.equal(E.porUgel.length, Dr.ugels.length, r);
  }
});

// Copia de un local en otra UGEL: dos UGEL con cifras idénticas
function conCopia() {
  const J = leer('moquegua'), cod = '398081', i = J.locs.findIndex(l => l[0] === cod), ilo = J.ugels.indexOf('UGEL Ilo');
  const nuevo = J.locs.length;
  J.locs.push([...J.locs[i].slice(0, 2), ilo, ...J.locs[i].slice(3)].map((v, k) => k === 0 ? '999999' : v));
  const mapaSvc = new Map();
  J.svcs.forEach((s, si) => { if (s[3] === i) { mapaSvc.set(si, J.svcs.length); J.svcs.push(s.map((v, k) => k === 3 ? nuevo : k === 0 ? '9' + v : v)); } });
  J.aulas.filter(a => a[0] === i).forEach(a => J.aulas.push(a.map((v, k) => k === 0 ? nuevo : k === 1 ? mapaSvc.get(v) : v)));
  const Dc = prep(J), Cc = calc(Dc, DEF);
  return { Dc, Cc, list: [i, nuevo] };
}

test('dos UGEL con cifras idénticas: advertencia en el total y en el nivel', () => {
  const { Dc, Cc, list } = conCopia(), E = estadoSituacional(Dc, Cc, list);
  assert.deepEqual(E.advertencias.map(a => a.clave).sort(), ['iguales|S|UGEL General Sánchez Cerro = UGEL Ilo', 'iguales|total|UGEL General Sánchez Cerro = UGEL Ilo']);
  assert.match(E.advertencias[0].texto, /cifras idénticas/);
});

test('Excel: hojas «Estado situacional» y «Locales por UGEL», con la explicación de la advertencia', async () => {
  const { Dc, Cc, list } = conCopia();
  const revisiones = limpiarDatosDoc({ situacional: { revisiones: { 'iguales|total|UGEL General Sánchez Cerro = UGEL Ilo': { nota: 'Local de prueba copiado', fecha: '2026-10-21' } } } }).situacional.revisiones;
  const { buffer } = await generarExcel(Dc, Cc, DEF, list, { proyecto: 'Prueba', fecha: '2026-10-21', ioarr: null, revisiones });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Estado situacional'), textos = [];
  ws.eachRow(r => textos.push(String(r.getCell(1).value ?? '')));
  assert.ok(textos.includes('TOTAL'));
  assert.ok(textos.some(t => /Revisado el 21\/10\/2026: Local de prueba copiado/.test(t)));
  assert.ok(textos.some(t => /^PENDIENTE: sin explicación/.test(t)));   // la del nivel Secundaria sigue sin explicar
  const tot = ws.getRow(textos.indexOf('TOTAL') + 1);
  assert.equal(tot.getCell(4).value.result, 410);
  assert.match(tot.getCell(4).value.formula, /^D\d+$/);
  const wl = wb.getWorksheet('Locales por UGEL');
  assert.deepEqual(wl.getRow(1).values.slice(1), ['Código de local', 'Código modular', 'Institución educativa', 'Población', 'Nivel', 'Centro poblado', 'Distrito', 'UGEL']);
});

test('limpiarDatosDoc: las explicaciones vacías se descartan', () => {
  const r = limpiarDatosDoc({ situacional: { revisiones: { a: { nota: '  ok  ', fecha: '2026-10-21' }, b: { nota: '' }, c: { nota: 'x', fecha: 'mal' } } } }).situacional.revisiones;
  assert.deepEqual(r, { a: { nota: 'ok', fecha: '2026-10-21' }, c: { nota: 'x', fecha: null } });
});
