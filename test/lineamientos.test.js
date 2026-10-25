// Pruebas de los requisitos de los Lineamientos IOARR por colegio (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { prep, calc, filtrar, FILTRO_VACIO, DEF } from '../src/selector-ioarr/calculo.js';
import { costear } from '../src/selector-ioarr/costos.js';
import { porNivel } from '../src/selector-ioarr/niveles.js';
import { fichaActivos, PENDIENTE_CAMPO } from '../src/selector-ioarr/lineamientos.js';
import { generarExcelLineamientos } from '../src/selector-ioarr/excel-lineamientos.js';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const D = prep(JSON.parse(readFileSync(new URL('moquegua.json', DIR), 'utf8')));
const LISTA = filtrar(D, calc(D, DEF), { ...FILTRO_VACIO(), q: 'mariscal' });
const BASE = { precios: { mesa: 180, silla: 90, esc: 400, sdoc: 120, arm: 650 }, uit: { anio: 2026, valor: 5500 },
  estructura: { transporte_pieza: 10, igv: 18, doc_pct: 3, sup_pct: 5, liquidacion: 9000 } };
// IOARR de un nivel, como la arma el expediente
function ioarr(nivel, inv = {}, P = DEF) {
  const g = porNivel(D, P, LISTA).find(x => x.nivel === nivel);
  const R = costear({ ...BASE, grupos: [{ clave: nivel, D: g.D, C: g.C, list: g.list, inventario: inv }] }).grupos[nivel];
  return { nivel, nombre: g.nombre, D: g.D, C: g.C, list: g.list, R, inv };
}

test('ficha de activos: con solo el censo, todo queda pendiente de verificación y suma el metrado', () => {
  const x = ioarr('P'), F = fichaActivos({ x, P: DEF, datos: {}, anioRef: 2026 });
  assert.equal(F.totales.cantidad, x.R.totales.rep);
  assert.ok(F.filas.length > 0);
  assert.ok(F.filas.filter(f => !f.ajuste).every(f => f.pendiente && f.situacion === PENDIENTE_CAMPO && f.patrimonial === '' && f.antiguedad == null));
  assert.ok(F.filas.every(f => f.nivel === 'Primaria'));
  // Sin mantenimiento cargado: aviso y celdas vacías, sin inventar
  assert.ok(F.sinMant.length && F.filas.every(f => f.mant_existente == null));
  assert.match(F.avisos.map(a => a.texto).join(' '), /mantenimiento vacío/);
  // Denominación nueva con la talla del grado del aula
  assert.ok(F.filas.some(f => /Mesa del estudiante – Primaria \d/.test(f.denom_nueva)));
});

test('ficha de activos: la ficha de campo trae código patrimonial y antigüedad; el mantenimiento se prorratea', () => {
  const x0 = ioarr('P'), l = x0.R.locales.find(y => y.rep[1] > 0), i = D.locs.findIndex(z => z[0] === l.cod);
  const ai = x0.D.locAul[i][0], j = D.locAul[i].indexOf(ai), C = x0.C;
  // Ficha: en la primera aula se contaron 3 sillas malas con código y antigüedad
  const mCenso = l.diag[1].m - C.A.m[1][ai];
  const inv = { [l.cod]: { bienes: { silla: { b: 1, r: 0, m: 3 + mCenso } }, verif: { silla: { mv: 3, mc: mCenso } },
    ficha: { aulas: { [j]: { filas: [{ k: 'silla', b: 1, r: 0, m: 3, antig: 14, patrimonial: '7400-0001 a 0003', obs: 'patas rotas' }] } } } } };
  const x = ioarr('P', inv);
  const F = fichaActivos({ x, P: DEF, datos: { mant_actual: { silla: 100 }, mant_nuevo: { silla: 50 } }, anioRef: 2026 });
  const f = F.filas.find(y => y.cod === l.cod && y.bien === 'silla' && y.origen.startsWith('Verificado'));
  assert.equal(f.cantidad, 3); assert.equal(f.patrimonial, '7400-0001 a 0003'); assert.equal(f.antiguedad, 14);
  assert.equal(f.pendiente, false); assert.equal(f.situacion, 'Completa');
  const sillas = F.filas.filter(y => y.bien === 'silla');
  assert.ok(Math.abs(sillas.reduce((a, y) => a + y.mant_existente, 0) - 100) < 0.05);
  assert.equal(F.totales.cantidad, x.R.totales.rep);
});

test('ficha de activos: una corrección a mano por local va en un lote del local, sin código patrimonial', () => {
  const x0 = ioarr('S'), l = x0.R.locales[0];
  const x = ioarr('S', { [l.cod]: { bienes: { mesa: { b: 5, r: 2, m: 7 } }, adquisicion: { mesa: 2010 } } });
  const F = fichaActivos({ x, P: DEF, datos: {}, anioRef: 2026 });
  const fs = F.filas.filter(y => y.cod === l.cod && y.bien === 'mesa');
  assert.deepEqual(fs.map(y => [y.ambiente.startsWith('Todo el local'), y.cantidad, y.antiguedad]), [[true, 7, 16]]);
  assert.ok(fs[0].pendiente && /código patrimonial/.test(fs[0].motivos.join()));
});

test('Excel de anexos: hoja Ficha de activos con las filas pendientes en amarillo y el total del metrado', async () => {
  const x = ioarr('P'), F = fichaActivos({ x, P: DEF, datos: {}, anioRef: 2026 });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await generarExcelLineamientos({ ficha: F }, { nombreIoarr: 'Primaria' }));
  const ws = wb.getWorksheet('Ficha de activos');
  assert.equal(ws.getCell('H5').value, 'Código patrimonial del activo existente');
  assert.equal(ws.getCell(6, 19).value, PENDIENTE_CAMPO);
  assert.equal(ws.getCell(6, 8).fill.fgColor.argb, 'FFFFF3B0');
  assert.equal(ws.getCell(6 + F.filas.length, 15).value.result, x.R.totales.rep);
});
