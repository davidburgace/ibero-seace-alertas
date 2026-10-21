// Pruebas de la etapa 2 del expediente IOARR: Formato 07-C y memoria descriptiva (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { prep, calc, filtrar, FILTRO_VACIO, DEF } from '../src/selector-ioarr/calculo.js';
import { costear, limpiarAdquisicion, censoLocal } from '../src/selector-ioarr/costos.js';
import { armarModelo, limpiarDatosDoc, VERIF_MANUAL } from '../src/selector-ioarr/documentos.js';
import { generar07C, generarMemoria, generarVerificacion } from '../src/selector-ioarr/word.js';
import { generarExcelCostos } from '../src/selector-ioarr/excel-costos.js';
import ExcelJS from 'exceljs';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const region = n => prep(JSON.parse(readFileSync(new URL(n + '.json', DIR), 'utf8')));
const cerca = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg}: ${a} ≠ ${b}`);

// Valores de PRUEBA (no son reales)
const PRECIOS = { mesa: 180, silla: 90, esc: 400, sdoc: 120, arm: 650 };
const DESC = Object.fromEntries(Object.keys(PRECIOS).map(k => [k, { descripcion: 'Descripción de prueba de ' + k }]));
const RUB = [{ clave: 'transporte', valor: 5 }, { clave: 'instalacion', valor: 2 }, { clave: 'gg', valor: 10 }, { clave: 'utilidad', valor: 8 }, { clave: 'igv', valor: 18 },
  { clave: 'expediente', modo: 'monto', valor: 5000 }, { clave: 'supervision', valor: 3 }, { clave: 'gestion', valor: 1 }, { clave: 'imprevistos', valor: 1 }];
const COMPLETOS = { uf: 'UF de prueba', uei: 'UEI de prueba', opmi: 'OPMI de prueba', fecha_inicio: '2027-03', meses: 5, en_uso: 'si', inventario_registrado: 'si',
  servicio_brecha: 'S', tipologia: 'T', indicador_brecha: 'I', ue_mantenimiento: 'UGEL de prueba',
  vida_util: { mesa: 10, silla: 10, esc: 10, sdoc: 10, arm: 12 }, mant_nuevo: { mesa: 2000, silla: 800, esc: 300, sdoc: 100, arm: 500 },
  antiguedad: { mesa: 15, silla: 15, esc: 15, sdoc: 15, arm: 15 }, estado_actual: { mesa: 'MALO', silla: 'MALO', esc: 'MALO', sdoc: 'MALO', arm: 'MALO' } };

function chiclayo(uit = 5500, datos = {}) {
  const D = region('lambayeque'), C = calc(D, DEF), list = [D.locs.findIndex(l => l[0] === '276008')];
  const inv = { '276008': { bienes: { mesa: { b: 0, r: 0, m: 569 } }, fecha_visita: '2026-10-20', observacion: 'Acta', archivos: [{ tipo: 'acta', nombre_archivo: 'acta.pdf' }] } };
  const R = costear({ D, C, list, precios: PRECIOS, rubros: RUB, factores: [], uit: { anio: 2026, valor: uit }, inventario: inv });
  return { R, M: armarModelo({ R, D, list, proyecto: { nombre: 'Chiclayo', region: 'Lambayeque' }, datos: limpiarDatosDoc(datos), precios: DESC, inv, fecha: '2026-10-21' }) };
}
function mariscal(uit = 500, datos = COMPLETOS) {
  const D = region('moquegua'), C = calc(D, DEF), list = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
  const R = costear({ D, C, list, precios: PRECIOS, rubros: RUB, factores: [], uit: { anio: 2026, valor: uit } });
  return { R, M: armarModelo({ R, D, list, proyecto: { nombre: 'Mariscal', region: 'Moquegua' }, datos: limpiarDatosDoc(datos), precios: DESC, fecha: '2026-10-21' }) };
}
async function textoDocx(buf) {
  const z = await JSZip.loadAsync(buf);
  return (await z.file('word/document.xml').async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
}

test('limpiarDatosDoc: valida, descarta lo desconocido y no inventa valores', () => {
  const d = limpiarDatosDoc({ cui: '12a', fecha_inicio: '2027-13', meses: 99, vida_util: { mesa: '10', otro: 5, silla: -1 }, estado_actual: { mesa: 'MALO', silla: 'roto' },
    inventario_registrado: 'quizá', uf: '  UF   X  ', raro: 'x' });
  assert.equal(d.cui, ''); assert.equal(d.fecha_inicio, null); assert.equal(d.meses, null);
  assert.deepEqual(d.vida_util, { mesa: 10 }); assert.deepEqual(d.estado_actual, { mesa: 'MALO' });
  assert.equal(d.inventario_registrado, ''); assert.equal(d.uf, 'UF X'); assert.ok(!('raro' in d));
  assert.deepEqual(limpiarDatosDoc({}).mant_nuevo, {});
});

test('Chiclayo 11124: IOARR individual, registro abreviado, el costo del 07-C cuadra con la estructura', () => {
  const { R, M } = chiclayo();
  assert.equal(M.masiva, false); assert.equal(M.registro, 'abreviado'); assert.equal(M.ups.length, 1);
  assert.match(M.nombre, /^ADQUISICIÓN DE MOBILIARIO DE AULA; EN EL\(LA\) IE 11124 NUESTRA SEÑORA DE LA PAZ .*DISTRITO DE CHICLAYO/);
  assert.deepEqual(M.F.metas.map(m => [m.k, m.cantidad]), [['mesa', 569], ['silla', 189]]);
  cerca(M.F.total, R.totales.total, 'total del 07-C = total de la estructura');
  cerca(M.F.subtotalActivos + M.F.expediente + M.F.supervision, R.totales.total, 'activos + expediente + supervisión');
  // Sin los datos del usuario, se listan como pendientes y no se inventan
  for (const t of [/Institucionalidad/, /inicio y plazo/, /mantenimiento y vida útil/, /inventario de la entidad/]) assert.ok(M.faltan.some(x => t.test(x)), t);
  assert.equal(M.F.cronograma, null);
  assert.equal(M.E.condiciones.find(c => /acta/.test(c.texto)).estado, 'cumple');
});

test('sin UIT el registro queda pendiente; con UIT baja pasa a completo', () => {
  assert.equal(chiclayo(null).M.registro, 'pendiente');
  assert.equal(chiclayo(1000).M.registro, 'completo');
});

test('Moquegua «mariscal»: inversión masiva, cronogramas que suman exacto y sin pendientes', () => {
  const { R, M } = mariscal();
  const conRep = R.locales.filter(l => l.rep.some(q => q > 0));
  assert.equal(M.masiva, conRep.length > 1);
  assert.equal(M.ups.length + M.sinRep.length, R.locales.length);
  assert.equal(M.registro, 'completo');
  cerca(M.F.total, R.totales.total, 'total');
  const C = M.F.cronograma;
  assert.equal(C.periodos.length, 5); assert.equal(C.periodos[0], 'marzo 2027');
  for (const a of C.activos) cerca(a.valores.reduce((x, y) => x + y, 0), a.total, 'cronograma de ' + a.nombre);
  for (const m of C.metas) assert.equal(m.valores.reduce((x, y) => x + y, 0), m.total);
  assert.equal(M.F.inicio, '01/03/2027'); assert.equal(M.F.fin, '31/07/2027');
  assert.equal(M.F.mantenimiento.anios, 12);
  assert.ok(!M.faltan.length, 'pendientes: ' + M.faltan.join(' | '));
});

test('Word del 07-C: secciones según el registro (completo masivo / abreviado individual)', async () => {
  const completo = await textoDocx(await generar07C(mariscal().M));
  for (const s of ['FORMATO N° 07-C: REGISTRO DE IOARR', 'BORRADOR DE TRABAJO', 'A. Alineamiento', 'B. Institucionalidad', 'C.2 Tipo de inversión', 'D.2 Responsable', 'E.5 Reposición masiva', 'F.1 Metas físicas', 'F.4 Costo de mantenimiento'])
    assert.ok(completo.includes(s), s);
  assert.ok(!completo.includes('G.2 Registro abreviado'));
  const abreviado = await textoDocx(await generar07C(chiclayo().M));
  for (const s of ['G.1 Nombre de la inversión', 'G.2 Registro abreviado', 'G.3 Costo de mantenimiento', 'PENDIENTE']) assert.ok(abreviado.includes(s), s);
  assert.ok(!abreviado.includes('F.1 Metas físicas'));
});

test('Word de la memoria descriptiva: capítulos, condiciones y anexos', async () => {
  const t = await textoDocx(await generarMemoria(chiclayo().M));
  for (const s of ['MEMORIA DESCRIPTIVA', '1. Generalidades', '5. Diagnóstico', '6. Sustento de la reposición', 'Condiciones de los Lineamientos IOARR', '8. Presupuesto', '11. Anexos', 'acta.pdf', '569 mesas del estudiante'])
    assert.ok(t.includes(s), s);
});

// LibreOffice con Writer: los Word abren y se convierten sin error
const writer = (() => {
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); } catch { return false; }
  return ['/usr/lib/libreoffice/program/libswlo.so', '/usr/lib/libreoffice/program/swriter'].some(existsSync);
})();
test('los Word abren en LibreOffice Writer', { skip: !writer && 'LibreOffice Writer no está instalado' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-'));
  try {
    writeFileSync(join(dir, 'f07c.docx'), await generar07C(mariscal().M));
    writeFileSync(join(dir, 'memoria.docx'), await generarMemoria(chiclayo().M));
    execFileSync('soffice', [`-env:UserInstallation=file://${join(dir, 'perfil')}`, '--headless', '--convert-to', 'txt:Text (encoded):UTF8', '--outdir', join(dir, 'out'),
      join(dir, 'f07c.docx'), join(dir, 'memoria.docx')], { stdio: 'ignore', timeout: 180000 });
    assert.match(readFileSync(join(dir, 'out', 'f07c.txt'), 'utf8'), /E\.5 Reposición masiva/);
    assert.match(readFileSync(join(dir, 'out', 'memoria.txt'), 'utf8'), /MEMORIA DESCRIPTIVA/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── Etapa 3: antigüedad y lista de verificación ────────────────────────────
// Moquegua «mariscal» con año de adquisición en dos locales y % de Regular
function mariscalAnios({ regPct = 0, datos = {} } = {}) {
  const D = region('moquegua'), P = { ...DEF, regPct }, C = calc(D, P), list = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
  const base = costear({ D, C, list, precios: PRECIOS, rubros: RUB, factores: [], uit: { anio: 2026, valor: 500 } });
  const ups = base.locales.filter(l => l.rep[4] > 0).slice(0, 2);   // dos locales con armarios a reponer
  const inv = Object.fromEntries(ups.map((l, j) => [l.cod, { bienes: {}, adquisicion: { arm: j === 0 ? 2006 : 2016 }, fecha_visita: '2026-10-20', observacion: 'Visita', archivos: j === 0 ? [{ tipo: 'acta', nombre_archivo: 'a.pdf' }, { tipo: 'foto', nombre_archivo: 'f.jpg' }] : [] }]));
  const R = costear({ D, C, list, precios: PRECIOS, rubros: RUB, factores: [], uit: { anio: 2026, valor: 500 }, inventario: inv, regPct });
  const M = armarModelo({ R, D, list, proyecto: { nombre: 'Mariscal', region: 'Moquegua' }, datos: limpiarDatosDoc({ ...COMPLETOS, antiguedad: {}, ...datos }), precios: DESC, inv, fecha: '2026-10-21', regPct });
  return { base, R, M, ups };
}

test('año de adquisición sin corregir cantidades: el censo sigue valiendo y no hay aviso de inventario', () => {
  const { base, R } = mariscalAnios();
  assert.deepEqual(R.partidas.map(p => [p.rep, p.fal]), base.partidas.map(p => [p.rep, p.fal]));
  cerca(R.totales.total, base.totales.total, 'mismo total');
  assert.ok(R.locales.some(l => l.verificado && !l.verificado.tipos.length && l.verificado.adquisicion.arm));
  assert.ok(!R.avisos.some(a => a.tipo === 'inventario'));
});

test('antigüedad: promedio ponderado por lo que se repone, y lo cargado a mano tiene prioridad', () => {
  const { M, ups } = mariscalAnios();
  const mesa = M.E.activos.find(a => a.k === 'arm'), [a, b] = ups;
  const esperado = (20 * a.rep[4] + 10 * b.rep[4]) / (a.rep[4] + b.rep[4]);
  assert.equal(mesa.antiguedad_origen, 'inventario');
  assert.equal(mesa.antiguedad_inventario.con, 2); assert.equal(mesa.antiguedad_inventario.min, 10); assert.equal(mesa.antiguedad_inventario.max, 20);
  cerca(mesa.antiguedad_inventario.promedio, Math.round(esperado * 10) / 10, 'promedio');
  assert.equal(mesa.antiguedad, Math.round(Math.round(esperado * 10) / 10));
  const manual = mariscalAnios({ datos: { antiguedad: { arm: 25 } } }).M.E.activos.find(x => x.k === 'arm');
  assert.deepEqual([manual.antiguedad, manual.antiguedad_origen], [25, 'usuario']);
});

test('vida útil (2.4.C.b): sin % de Regular basta el estado malo; con % de Regular exige antigüedad ≥ vida útil e informe', () => {
  const cond = M => M.E.condiciones.find(c => /Vida útil/.test(c.texto));
  assert.equal(cond(mariscalAnios().M).estado, 'cumple');
  const antig = { mesa: 20, silla: 20, esc: 20, sdoc: 20, arm: 20 };
  const pend = mariscalAnios({ regPct: 0.5, datos: { antiguedad: antig } }).M;
  assert.equal(cond(pend).estado, 'pendiente');
  assert.ok(pend.faltan.some(x => /2\.4\.C\.b/.test(x)));
  const vida = v => ({ mesa: v, silla: v, esc: v, sdoc: v, arm: v });
  assert.equal(cond(mariscalAnios({ regPct: 0.5, datos: { antiguedad: antig, vida_util_estimada: vida(25), informe_vida_util: 'Informe 1' } }).M).estado, 'no');
  const ok = mariscalAnios({ regPct: 0.5, datos: { antiguedad: antig, vida_util_estimada: vida(10), informe_vida_util: 'Informe 1' } }).M;
  assert.equal(cond(ok).estado, 'cumple');
  assert.ok(!ok.faltan.some(x => /2\.4\.C\.b/.test(x)));
});

test('limpiarAdquisicion: años entre 1950 y el año actual', () => {
  assert.deepEqual(limpiarAdquisicion({ mesa: '2008', silla: '', otro: 2000 }, 2026), { mesa: 2008 });
  assert.throws(() => limpiarAdquisicion({ mesa: 2030 }, 2026), /entre 1950 y 2026/);
  assert.throws(() => limpiarAdquisicion({ mesa: 1900 }, 2026));
});

test('lista de verificación: automático por local, marcas manuales y conteo', () => {
  const sinMarcas = mariscalAnios().M.verificacion;
  const manual = sinMarcas.secciones.find(s => s.items.some(x => x.manual));
  assert.equal(manual.items.length, VERIF_MANUAL.length);
  assert.ok(manual.items.every(x => x.estado === 'pendiente'));
  const loc = sinMarcas.locales;
  assert.equal(loc.filter(u => u.visita).length, 2); assert.equal(loc.filter(u => u.acta).length, 1); assert.equal(loc.filter(u => u.fotos).length, 1);
  const acta = sinMarcas.secciones[1].items.find(x => /Acta/.test(x.texto));
  assert.equal(acta.estado, 'pendiente'); assert.equal(acta.nota, `1 de ${loc.length} locales`);
  const V = mariscalAnios({ datos: { verificacion: { cotizaciones: { ok: true, nota: '3 cotizaciones' }, pmi: { ok: false, nota: 'en trámite' }, raro: { ok: true } } } }).M.verificacion;
  const items = V.secciones.flatMap(s => s.items);
  assert.equal(items.find(x => x.id === 'cotizaciones').estado, 'ok');
  assert.equal(items.find(x => x.id === 'pmi').nota, 'en trámite');
  assert.equal(V.hechos, sinMarcas.hechos + 1);
  assert.equal(V.total, items.length);
});

test('Word de la lista de verificación y antigüedad en el 07-C y la memoria', async () => {
  const { M } = mariscalAnios();
  const v = await textoDocx(await generarVerificacion(M));
  for (const s of ['LISTA DE VERIFICACIÓN DEL EXPEDIENTE IOARR', 'Costos', 'Locales: visita y sustento', 'Condiciones de los Lineamientos IOARR', 'Documentos y coordinaciones', 'Sustento por local', 'Cotizaciones'])
    assert.ok(v.includes(s), s);
  const m = await textoDocx(await generarMemoria(M));
  assert.ok(m.includes('Año de adquisición por local')); assert.ok(m.includes('2006 (20 años)'));
  const D = region('lambayeque'), C = calc(D, DEF), i = D.locs.findIndex(l => l[0] === '276008');
  const inv = { '276008': { bienes: { mesa: { b: 0, r: 0, m: 569 } }, adquisicion: { mesa: 2010 }, fecha_visita: '2026-10-20', observacion: 'Acta', archivos: [] } };
  const R = costear({ D, C, list: [i], precios: PRECIOS, rubros: RUB, factores: [], uit: { anio: 2026, valor: 1000 }, inventario: inv });
  const M2 = armarModelo({ R, D, list: [i], proyecto: { nombre: 'Chiclayo', region: 'Lambayeque' }, datos: limpiarDatosDoc({}), precios: DESC, inv, fecha: '2026-10-21' });
  const f = await textoDocx(await generar07C(M2));
  assert.match(f, /16 \(promedio según el año de adquisición en 1 de 1 locales\)/);
});

test('Excel: la hoja «Inventario verificado» trae año de adquisición y antigüedad, también sin corregir cantidades', async () => {
  const D = region('lambayeque'), C = calc(D, DEF), i = D.locs.findIndex(l => l[0] === '276008');
  const fila = { cod_local: '276008', bienes: {}, adquisicion: { silla: 2012 }, censo: censoLocal(C, i), fecha_visita: '2026-10-20', observacion: 'Visita', archivos: [] };
  const R = costear({ D, C, list: [i], precios: PRECIOS, rubros: RUB, factores: [], uit: { anio: 2026, valor: 1000 }, inventario: { '276008': fila } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await generarExcelCostos(R, { proyecto: 'P', region: 'Lambayeque', fecha: '2026-10-21', criterios: '', precios: {}, inventario: { '276008': fila } }));
  const row = wb.getWorksheet('Inventario verificado').getRow(4);
  assert.equal(row.getCell(3).value, 'Silla del estudiante');
  assert.equal(row.getCell(7).value, 'censo');
  assert.equal(row.getCell(17).value, 2012);
  assert.equal(row.getCell(18).value.result, 14);
});
