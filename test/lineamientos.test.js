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
  const K = calcularPaquete({ D, P, codigos: CODIGOS, comun: BASE, datosDoc, final, anioRef: 2026 });
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

test('duplicación: entrega reciente sin descontar es riesgo; descontada, se resta de lo que se repone', async () => {
  const { riesgoDuplicacion } = await import('../src/selector-ioarr/lineamientos.js');
  const c = limpiarColegio({ entregas: [{ anio: 2024, cantidad: 30, tipo: 'kit', fuente: 'pronied' }, { anio: 2019, cantidad: 50, tipo: 'mesa', fuente: 'ugel' }] });
  let r = riesgoDuplicacion(c, { anioRef: 2026, niveles: ['P'] });
  assert.equal(r.riesgo, true); assert.match(r.motivos[0], /2024: 30 kit .*Pronied.* sin descontar/i);
  assert.equal(r.recientes.length, 1); assert.equal(r.antiguas.length, 1);   // 2019 queda fuera de la ventana de 3 años
  // Descontada: sin riesgo y con ajuste en su nivel (un solo nivel: no hace falta indicarlo)
  const c2 = limpiarColegio({ entregas: [{ anio: 2023, cantidad: 30, tipo: 'kit', fuente: 'pronied', restar: true }] });
  r = riesgoDuplicacion(c2, { anioRef: 2026, niveles: ['P'] });
  assert.equal(r.riesgo, false); assert.equal(r.ajuste.P.kit, 30);
  // Con varios niveles, sin nivel no se puede descontar
  r = riesgoDuplicacion(c2, { anioRef: 2026, niveles: ['P', 'S'] });
  assert.equal(r.riesgo, true); assert.match(r.motivos[0], /indica el nivel/);
  // Inversión en ejecución y otra inversión «Sí» también son riesgo
  assert.ok(riesgoDuplicacion(limpiarColegio({ inversion_ejecucion: true, inversion_codigo: '2501234' }), { anioRef: 2026 }).motivos[0].includes('2501234'));
  assert.ok(riesgoDuplicacion(null, { anioRef: 2026, dupEstado: 'si' }).riesgo);
  assert.equal(riesgoDuplicacion(null, { anioRef: 2026, dupEstado: 'si', excluido: true }).riesgo, false);
});

test('duplicación en el paquete: se descuenta en la IOARR del nivel, se avisa y sale en el listado de riesgos', async () => {
  const x0 = elegirIoarr(paquete().A, 'P'), l = x0.R.locales.find(y => y.rep[1] > 0), quitar = Math.min(5, l.rep[1]);
  const otro = x0.R.locales.find(y => y.cod !== l.cod);
  const datos = { colegios: { [l.cod]: { entregas: [{ anio: 2025, cantidad: quitar, tipo: 'silla', fuente: 'gore', nivel: 'P', restar: true }] },
    [otro.cod]: { entregas: [{ anio: 2024, cantidad: 10, tipo: 'kit', fuente: 'municipalidad', nivel: 'P' }] } } };
  const { A, M } = paquete(datos), x = elegirIoarr(A, 'P'), l2 = x.R.locales.find(y => y.cod === l.cod);
  assert.equal(l2.rep[1], l.rep[1] - quitar); assert.equal(l2.descuento.tipos[1], quitar);
  assert.equal(x.R.totales.descontado, quitar);
  assert.ok(x.R.avisos.some(a => a.tipo === 'duplicacion' && /Se descuentan? \d+ bien/.test(a.texto)));
  assert.ok(x.R.avisos.some(a => a.tipo === 'duplicacion' && a.alerta && a.texto.includes(otro.cod)));
  // Secundaria no cambia: la entrega es de Primaria
  const s0 = elegirIoarr(paquete().A, 'S'), s1 = elegirIoarr(A, 'S');
  assert.equal(s1.R.totales.rep, s0.R.totales.rep);
  // La ficha de activos sigue cuadrando con el metrado (con una fila de ajuste)
  const MP = M('P');
  assert.equal(MP.fichaActivos.totales.cantidad, x.R.totales.rep);
  assert.ok(MP.faltan.some(t => /Riesgo de duplicación en 1 colegio/.test(t)));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excelL({ ficha: MP.fichaActivos, riesgos: MP.riesgos, anioRef: 2026 }));
  const ws = wb.getWorksheet('Riesgo de duplicación'), filas = [];
  ws.eachRow((r, n) => { if (n > 4) filas.push([r.getCell(1).value, r.getCell(3).value, r.getCell(10).value]); });
  assert.deepEqual(filas.sort(), [[l.cod, 'Entrega reciente descontada', 'Sí'], [otro.cod, 'Riesgo de duplicación', 'No']].sort());
});

test('no aumentar capacidad: lo repuesto no pasa de la matrícula ni de la capacidad de diseño; faltante informativo', async () => {
  const { A } = paquete(), x = elegirIoarr(A, 'P');
  // En «mariscal» hay colegios con más mobiliario que matrícula: se cuentan y se avisa
  assert.ok(A.comparativo.inconsistentes > 0);
  assert.ok(x.R.locales.every(l => l.rep[0] <= l.tope.matricula && l.rep[1] <= l.tope.matricula && l.kits <= l.tope.matricula));
  const inc = x.R.locales.find(l => l.tope.inconsistente);
  if (inc) assert.ok(x.R.avisos.some(a => a.tipo === 'censo' && a.texto.includes(inc.cod)));
  // Con capacidad de diseño menor que la matrícula, el tope es la capacidad
  const l = x.R.locales.find(y => y.rep[1] > 2), cap = Math.floor(l.rep[1] / 2);
  const C2 = paquete({ colegios: { [l.cod]: { capacidad: { P: cap } } } }), l2 = elegirIoarr(C2.A, 'P').R.locales.find(y => y.cod === l.cod);
  assert.equal(l2.tope.capacidad, cap); assert.equal(l2.rep[1], cap); assert.equal(l2.tope.recorte[1], l.rep[1] - cap);
  assert.ok(elegirIoarr(C2.A, 'P').R.avisos.some(a => a.tipo === 'tope' && a.texto.includes(l.cod)));
  // La capacidad de Primaria no toca Secundaria
  assert.equal(elegirIoarr(C2.A, 'S').R.totales.rep, elegirIoarr(A, 'S').R.totales.rep);
  // El faltante nunca entra al monto y lleva la nota
  assert.ok(x.R.totales.fal > 0);
  assert.ok(x.R.avisos.some(a => a.tipo === 'faltante' && a.texto.includes('corresponde a ampliación marginal, no a reposición')));
  const M = C2.M('P');
  assert.ok(M.E.sustento.some(t => t.includes('corresponde a ampliación marginal, no a reposición')));
  // Hoja «Capacidad y censo»
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excelL({ ficha: M.fichaActivos, capacidad: M.capacidad }));
  const ws = wb.getWorksheet('Capacidad y censo');
  assert.match(ws.getCell('A3').value, /\d+ colegios? con datos inconsistentes del censo/);
  let fila = null; ws.eachRow((r, n) => { if (n > 5 && r.getCell(1).value === l.cod) fila = r; });
  assert.equal(fila.getCell(4).value, cap); assert.equal(fila.getCell(12).value, cap);
  ws.eachRow((r, n) => { if (n > 5 && r.getCell(1).value !== l.cod) assert.match(String(r.getCell(4).value), /sin dato/); });
});

test('mobiliario en uso: un colegio inundado o cerrado no entra al monto y se avisa', async () => {
  const base = paquete(), xP = elegirIoarr(base.A, 'P'), l = xP.R.locales.find(y => y.total > 0);
  const { A, M } = paquete({ colegios: { [l.cod]: { uso: 'inundado' }, [CODIGOS.find(c => c !== l.cod)]: { uso: 'operativo' } } });
  const x = elegirIoarr(A, 'P');
  assert.ok(!x.R.locales.some(y => y.cod === l.cod));
  assert.ok(x.R.totales.total < xP.R.totales.total);
  assert.ok(x.R.avisos.some(a => a.tipo === 'uso' && a.alerta && a.texto.includes(`${l.cod} (inundado)`)));
  assert.ok(x.R.avisos.some(a => a.tipo === 'uso' && /no tienen? registrado si el mobiliario está en uso/.test(a.texto)));
  // Fuera de todas las IOARR de sus niveles
  assert.ok(A.ioarrs.every(y => !y.list.some(i => D.locs[i][0] === l.cod)));
  const MP = M('P'), cond = MP.E.condiciones.find(c => /en uso/.test(c.texto));
  assert.equal(cond.estado, 'pendiente'); assert.match(cond.nota, /Colegio operativo en \d+ de \d+/);
  assert.ok(MP.uso.some(u => u.cod === l.cod && !u.entra));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excelL({ ficha: MP.fichaActivos, uso: MP.uso }));
  const vals = []; wb.getWorksheet('Mobiliario en uso').eachRow((r, n) => { if (n > 4) vals.push([r.getCell(1).value, r.getCell(3).value, r.getCell(4).value]); });
  assert.deepEqual(vals.find(v => v[0] === l.cod), [l.cod, 'Inundado', 'No entra: mobiliario sin uso']);
});

test('Tabla 3.7: A costo directo, B otros costos (con control concurrente si corresponde), C = A + B; masiva = registro completo', async () => {
  const cerca = (a, b, m) => assert.ok(Math.abs(a - b) < 0.011, `${m}: ${a} ≠ ${b}`);
  const conCC = (estructura) => {
    const datosDoc = limpiarDatosDoc({ fecha_inicio: '2027-03', meses: 4 });
    const K = calcularPaquete({ D, P: DEF, codigos: CODIGOS, comun: { ...BASE, estructura: { ...BASE.estructura, ...estructura } }, datosDoc, anioRef: 2026 });
    const A = { ...K, detalle: {}, efectivos: preciosEfectivos({}, {}) };
    return { A, M: modeloIoarr(A, elegirIoarr(A, 'P'), datosDoc, { nombre: 'Prueba', region: 'Moquegua' }, '2026-10-25') };
  };
  const sin = conCC({}), si = conCC({ cc_aplica: 'si', cc_pct: 2 }), umbral = conCC({ cc_umbral: 1 }), no = conCC({ cc_aplica: 'no' });
  const T = si.M.totales;
  cerca(T.a, T.cdIgv, 'A = costo directo con IGV');
  cerca(T.cc, (T.cdIgv + T.doc + T.sup + T.liq) * 0.02, 'control concurrente 2 %');
  cerca(T.b, T.doc + T.sup + T.liq + T.cc, 'B'); cerca(T.total, T.a + T.b, 'C = A + B');
  cerca(T.total, sin.M.totales.total * 1.02, 'el control concurrente suma 2 % al monto');
  assert.equal(sin.M.totales.cc, 0); assert.equal(no.M.totales.cc, 0);
  // Sin indicar si corresponde: pendiente y aviso; con umbral superado pero sin %, alerta
  assert.ok(sin.M.faltan.some(t => /Control concurrente \(Ley 31358\)/.test(t)));
  assert.ok(!no.M.faltan.some(t => /Control concurrente/.test(t)));
  assert.ok(elegirIoarr(umbral.A, 'P').R.avisos.some(a => a.tipo === 'control_concurrente' && a.alerta));
  // Filas de la estructura con A, B y C
  assert.deepEqual(si.M.estructura.filas.filter(f => f.fuerte || f.total).map(f => f.clave), ['cdIgv', 'b', 'total']);
  // El cronograma suma el total, con la fila del control concurrente
  const Cr = si.M.F.cronograma, suma = [...Cr.activos, Cr.expediente, Cr.supervision, Cr.liquidacion, Cr.control].reduce((a, x) => a + x.total, 0);
  cerca(suma, si.M.F.total, 'cronograma');
  // Masiva: siempre «Registro completo (masiva)» y el monto en UIT
  assert.equal(si.M.masiva, true); assert.equal(si.M.registro, 'completo');
  const t = await textoDocx(await generar07C(si.M));
  assert.match(t, /UIT \(UIT 2026: S\/ 5,500\.00\) → Registro completo \(masiva\), secciones D, E y F/);
  assert.match(t, /A\. COSTO DIRECTO \(activos, con IGV\)/); assert.match(t, /CONTROL CONCURRENTE \(LEY 31358\)/);
  assert.match(t, /B\. OTROS COSTOS DE INVERSIÓN/); assert.match(t, /C = A \+ B\. COSTO DE INVERSIÓN \(TOTAL\)/);
});

test('05-B: idea con tipo de IOARR + UP genérica + ámbito, y montos t, t+1, t+2 editables; 07-C con alineamiento y Recuadro 14', async () => {
  const { generar05B, generarMemoria } = await import('../src/selector-ioarr/word.js');
  const { M } = paquete();
  const MP = M('P');
  // «mariscal» toma colegios de varias provincias: el ámbito es departamental
  assert.equal(MP.ambito, 'DEPARTAMENTAL');
  assert.equal(MP.B05.idea, 'Inversiones de reposición de mobiliario escolar de las IE de Educación Primaria en el departamento de Moquegua');
  // Sin montos cargados: todo en el año t, marcado como propuesto
  assert.equal(MP.B05.propuesto, true); assert.deepEqual(MP.B05.programacion.map(x => x.rotulo), ['t', 't+1', 't+2']);
  assert.equal(MP.B05.programacion[0].monto, MP.F.total); assert.ok(MP.B05.cuadra);
  // Con montos por año (de esta IOARR) que no suman el total: aviso
  const C2 = paquete({ anio_t: 2027, por_nivel: { P: { montos_05b: { t: 100000, t1: 50000 } } } }), M2 = C2.M('P');
  assert.deepEqual(M2.B05.programacion.map(x => [x.anio, x.monto]), [[2027, 100000], [2028, 50000], [2029, 0]]);
  assert.equal(M2.B05.propuesto, false); assert.equal(M2.B05.cuadra, false);
  const t05 = await textoDocx(await generar05B(M2));
  assert.match(t05, /FORMATO N° 05-B/); assert.match(t05, /Inversiones de reposición de mobiliario escolar de las IE de Educación Primaria/);
  assert.match(t05, /PENDIENTE: la programación suma/);
  // Secundaria tiene su propia idea y sus montos
  assert.match(C2.M('S').B05.idea, /Educación Secundaria/); assert.equal(C2.M('S').B05.propuesto, true);
  // 07-C: cadena funcional, servicio con brecha, indicador y contribución a calidad (no cobertura)
  const t07 = await textoDocx(await generar07C(MP));
  assert.match(t07, /Cadena funcional/); assert.match(t07, /Servicios públicos con brecha identificada y priorizada/);
  assert.match(t07, /no contribuye al cierre de la brecha de cobertura/);
  // Justificación de la masiva: Recuadro 14 / Aplicación 6 y mejor tecnología o norma técnica vigente
  assert.match(t07, /Recuadro 14 y Aplicación 6\): donde se reemplaza una carpeta .*se da de baja la carpeta y la mesa y la silla nuevas se registran en el inventario como «mobiliario de aula»/);
  assert.match(t07, /mejor tecnología o conformes a la norma técnica vigente/);
  assert.match(await textoDocx(await generarMemoria(MP)), /Recuadro 14 y Aplicación 6/);
});

test('memoria: anexo «Consultas a la OPMI» con las dos preguntas, sin responder', async () => {
  const { generarMemoria } = await import('../src/selector-ioarr/word.js');
  const t = await textoDocx(await generarMemoria(paquete().M('P')));
  const a = t.slice(t.indexOf('Anexo 2. Consultas a la OPMI'));
  assert.ok(a.length > 30);
  assert.match(a, /una IOARR masiva por nivel educativo/); assert.match(a, /programada en la cartera del PMI .* Obras por Impuestos/);
  assert.equal((a.match(/\nPENDIENTE\n/g) || []).length, 2);   // ninguna respondida
});

test('sección A: 22 / 047, grupo por nivel (Secundaria 0105; los demás editables), indicador departamental', () => {
  const S = paquete().M('S'), P = paquete({ grupo_funcional: { P: '9999' } }).M('P');
  assert.deepEqual(S.A.grupos, ['0105 EDUCACIÓN SECUNDARIA']); assert.ok(!S.faltan.some(x => /grupo funcional/.test(x)));
  assert.deepEqual(P.A.grupos, ['9999 EDUCACIÓN PRIMARIA']);
  assert.ok(paquete().M('P').faltan.some(x => /Código del grupo funcional de primaria/.test(x)));
  assert.equal(S.A.indicadores[0].nombre, 'PORCENTAJE DE INSTALACIONES EDUCATIVAS QUE BRINDAN EL SERVICIO EN CONDICIONES INADECUADAS');
  assert.equal(S.A.espacio, 'DEPARTAMENTO DE MOQUEGUA');
  assert.deepEqual(limpiarDatosDoc({ grupo_funcional: { P: '01x4', S: ' 0105 ', X: '1' } }).grupo_funcional, { S: '0105' });
});
