// Pruebas de los requisitos de los Lineamientos IOARR por colegio (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { prep, calc, filtrar, FILTRO_VACIO, DEF } from '../src/selector-ioarr/calculo.js';
import { costear } from '../src/selector-ioarr/costos.js';
import { porNivel } from '../src/selector-ioarr/niveles.js';
import { fichaActivos, modeloVidaUtil, PENDIENTE_CAMPO } from '../src/selector-ioarr/lineamientos.js';
import { limpiarParams } from '../src/selector-ioarr/calculo.js';
import { generarVidaUtil } from '../src/selector-ioarr/word.js';
import JSZip from 'jszip';
const textoDocx = async b => (await (await JSZip.loadAsync(b)).file('word/document.xml').async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
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

test('vida útil: el Regular solo se sustenta con antigüedad o daño documentado; 10 años es referencial', async () => {
  const P = limpiarParams({ escenario: 'malo_regular', pctRegular: 100 });
  const x0 = ioarr('P', {}, P), l = x0.R.locales.find(y => y.diag[1].r > 0), i = D.locs.findIndex(z => z[0] === l.cod);
  const ai = x0.D.locAul[i].find(a => x0.C.A.r[1][a] > 0), j = D.locAul[i].indexOf(ai);
  // En el aula se cuentan 4 sillas regulares de 12 años y 2 sin antigüedad pero con daño anotado
  const filas = [{ k: 'silla', b: 0, r: 4, m: 0, antig: 12, patrimonial: 'P-1' }, { k: 'silla', b: 0, r: 2, m: 0, patrimonial: 'P-2', obs: 'respaldar partido' }];
  const resto = l.diag[1].r - x0.C.A.r[1][ai], mResto = l.diag[1].m - x0.C.A.m[1][ai];
  const inv = { [l.cod]: { bienes: { silla: { b: 0, r: 6 + resto, m: mResto } }, verif: { silla: { mv: 0, mc: mResto } }, ficha: { aulas: { [j]: { filas } } } } };
  const x = ioarr('P', inv, P);
  const F = fichaActivos({ x, P, datos: {}, anioRef: 2026 });
  const V = modeloVidaUtil({ ficha: F, datos: { vida_util_estimada: { silla: 10 } }, umbral: 10, nombreIoarr: 'Primaria' });
  const c = V.colegios.find(y => y.cod === l.cod), lotes = c.lotes.filter(f => f.bien === 'silla' && f.estado === 'Regular' && /^Verificado/.test(f.origen));
  // Un lote por fila de la ficha: 4 por antigüedad (12 ≥ 10) y 2 por daño documentado
  assert.deepEqual(lotes.map(f => [f.cantidad, f.patrimonial, f.sustento.ok]), [[4, 'P-1', true], [2, 'P-2', true]]);
  assert.match(lotes[0].sustento.motivo, /Antigüedad 12 años ≥ vida útil 10/); assert.match(lotes[1].sustento.motivo, /Daño documentado/);
  assert.equal(F.totales.cantidad, x.R.totales.rep);
  // El Regular del censo (sin antigüedad ni daño) no se sustenta
  assert.ok(V.regularSin > 0);
  assert.ok(V.faltan.some(t => /Fuente de la vida útil/.test(t)) && V.faltan.some(t => /control patrimonial/.test(t)));
  assert.ok(V.faltan.some(t => /Regular sin antigüedad ni daño documentado/.test(t)));
  const M = { nombre: 'IOARR de prueba', fecha: '2026-10-25' };
  const todo = await textoDocx(await generarVidaUtil(M, { ...V, fuentes: ['control_patrimonial'] }));
  assert.match(todo, /Directiva N\.° 005-2016-EF\/51\.01/); assert.match(todo, /\[X\] Información de la oficina de control patrimonial/);
  assert.match(todo, /10 años es un valor referencial: no se aplica en forma automática/);
  assert.match(todo, /Firma y sello del responsable de control patrimonial/); assert.match(todo, /Visto bueno/);
  const uno = await textoDocx(await generarVidaUtil(M, V, l.cod));
  assert.match(uno, new RegExp(`código de local ${l.cod}`)); assert.match(uno, /Lotes del local/); assert.match(uno, /Daño documentado/);
});

// ─── Paquete completo (el mismo armado que la API, sin Supabase) ────────────
import { calcularPaquete, modeloIoarr, elegirIoarr } from '../src/selector-ioarr/paquete.js';
import { limpiarDatosDoc } from '../src/selector-ioarr/documentos.js';
import { generar07C } from '../src/selector-ioarr/word.js';
import { checklistColegio, limpiarColegio, AVISO_BORRADOR } from '../src/selector-ioarr/lineamientos.js';
import { preciosEfectivos } from '../src/selector-ioarr/costos.js';
import { generarExcelLineamientos as excelL } from '../src/selector-ioarr/excel-lineamientos.js';
export const CHECK_OK = { inventario: { registrado: 'si', contabilidad: 'si', baja: 'si', doc_tipo: 'resolucion', doc_numero: 'RD 001-2026', doc_fecha: '2026-09-15' } };
const CODIGOS = LISTA.map(i => D.locs[i][0]);
export function paquete(datos = {}, { final = false, P = DEF } = {}) {
  const datosDoc = limpiarDatosDoc(datos);
  const K = calcularPaquete({ D, P, codigos: CODIGOS, comun: BASE, datosDoc, final });
  const A = { ...K, detalle: {}, efectivos: preciosEfectivos({}, {}) };
  return { A, datosDoc, M: nivel => modeloIoarr(A, elegirIoarr(A, nivel), datosDoc, { nombre: 'Prueba', region: 'Moquegua' }, '2026-10-25') };
}

test('checklist de inventario y baja: valida, y sin completar no entra al 07-C final', () => {
  const c = limpiarColegio({ inventario: { registrado: 'si', contabilidad: 'quizá', doc_tipo: 'otro', doc_fecha: '2026-13-01' }, raro: 1 });
  assert.deepEqual(c.inventario, { registrado: 'si', contabilidad: '', baja: '', doc_tipo: '', doc_numero: '', doc_fecha: null });
  assert.equal(checklistColegio(c).completo, false);
  assert.deepEqual(checklistColegio(c).faltan, ['registro en la contabilidad', 'trámite de baja iniciado', 'documento de respaldo (acta, resolución o compromiso)', 'fecha del documento de respaldo']);
  assert.ok(checklistColegio(limpiarColegio(CHECK_OK)).completo);
  // El sí del proyecto vale por defecto para el registro en el inventario
  assert.ok(!checklistColegio(limpiarColegio({ inventario: { ...CHECK_OK.inventario, registrado: '' } })).completo);
  assert.ok(checklistColegio(limpiarColegio({ inventario: { ...CHECK_OK.inventario, registrado: '' } }), { registrado: 'si' }).completo);
  assert.match(checklistColegio(limpiarColegio({ inventario: { ...CHECK_OK.inventario, registrado: 'no' } })).faltan[0], /no está registrado/);
});

test('07-C final: solo los colegios con el checklist completo; el borrador trae todos con aviso', async () => {
  const ok = CODIGOS.slice(0, 5);
  const datos = { colegios: Object.fromEntries(ok.map(c => [c, CHECK_OK])) };
  const B = paquete(datos), F = paquete(datos, { final: true });
  assert.equal(B.A.list.length, LISTA.length); assert.equal(F.A.list.length, 5);
  assert.equal(B.A.bloqueados.length, LISTA.length - 5);
  // Los niveles se mantienen aunque queden vacíos en el final
  assert.deepEqual(F.A.ioarrs.map(x => x.nivel), B.A.ioarrs.map(x => x.nivel));
  const xB = elegirIoarr(B.A, 'P'), xF = elegirIoarr(F.A, 'P');
  assert.ok(xB.R.avisos.some(a => a.tipo === 'checklist' && /no entrarán? al Formato 07-C final/.test(a.texto)));
  assert.ok(xF.R.avisos.some(a => a.tipo === 'checklist' && /No entran? al Formato 07-C/.test(a.texto)));
  assert.ok(xF.R.locales.every(l => ok.includes(l.cod)));
  assert.ok(xF.R.totales.locales < xB.R.totales.locales);
  // Word: el borrador lo dice arriba; el final lista los que no entran
  const tB = await textoDocx(await generar07C(B.M('P'))), tF = await textoDocx(await generar07C(F.M('P')));
  assert.ok(tB.includes(AVISO_BORRADOR)); assert.ok(!tF.includes(AVISO_BORRADOR));
  assert.match(tF, /No se incluyen (el colegio|los \d+ colegios) con el checklist de inventario y baja incompleto/);
  // Excel de anexos: hoja con el checklist, también de los bloqueados
  const MF = F.M('P'), wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excelL({ ficha: MF.fichaActivos, checklist: MF.checklist }));
  const ws = wb.getWorksheet('Inventario y baja'), vals = [];
  ws.eachRow((r, n) => { if (n > 4) vals.push([r.getCell(1).value, r.getCell(9).value]); });
  assert.equal(vals.length, xB.list.length);
  assert.ok(vals.some(([, e]) => e === 'Entra') && vals.some(([, e]) => /Bloqueado/.test(e)));
});
