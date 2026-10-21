// Pruebas de la etapa 2 del expediente IOARR: Formato 07-C y memoria descriptiva (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { prep, calc, filtrar, FILTRO_VACIO, DEF } from '../src/selector-ioarr/calculo.js';
import { costear } from '../src/selector-ioarr/costos.js';
import { armarModelo, limpiarDatosDoc } from '../src/selector-ioarr/documentos.js';
import { generar07C, generarMemoria } from '../src/selector-ioarr/word.js';

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
