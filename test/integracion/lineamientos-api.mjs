// Prueba de punta a punta de las rutas del expediente con 3 colegios reales de Moquegua y un
// Supabase en memoria. La corre test/lineamientos-api.test.js en un proceso aparte, con
// --experimental-test-module-mocks (para reemplazar src/ioarr/db.js).
//   A 398477  Primaria · completo: checklist, uso, capacidad y ficha de campo con código y antigüedad
//   B 397642  Primaria y Secundaria (dos niveles) · datos faltantes: sin checklist ni uso
//   C 398316  Primaria · riesgo de duplicación: entrega de Pronied en 2025 sin descontar
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { supabaseMemoria } from '../helpers/supabase-memoria.js';

const sb = supabaseMemoria();
mock.module(new URL('../../src/ioarr/db.js', import.meta.url).href, { namedExports: { supabase: sb } });
const { default: selectorRouter } = await import('../../src/selector-ioarr/router.js');
const { prep, calc, limpiarParams } = await import('../../src/selector-ioarr/calculo.js');
const { AVISO_BORRADOR, PENDIENTE_CAMPO } = await import('../../src/selector-ioarr/lineamientos.js');

const A = '398477', B = '397642', C = '398316', PID = '11111111-2222-3333-4444-555555555555';
const CRIT = { muebles: ['mesa', 'silla'] };
const D = prep(JSON.parse(readFileSync(new URL('../../src/public/data/selector-ioarr/2025/moquegua.json', import.meta.url), 'utf8')));
const Cc = calc(D, limpiarParams(CRIT)), iA = D.locs.findIndex(l => l[0] === A);

// Ficha de campo de A: cada aula contada como en el censo, con código patrimonial y 12 años
const aulasA = {}, bienes = { mesa: { b: 0, r: 0, m: 0 }, silla: { b: 0, r: 0, m: 0 } };
D.locAul[iA].forEach((ai, j) => {
  aulasA[j] = { nivel: 'P', est: null, filas: ['mesa', 'silla'].map((k, t) => {
    const q = { b: Cc.A.b[t][ai], r: Cc.A.r[t][ai], m: Cc.A.m[t][ai] };
    for (const c of ['b', 'r', 'm']) bienes[k][c] += q[c];
    return { k, ...q, antig: 12, patrimonial: `PAT-${j}-${k}`, baja: 'en_tramite' };
  }) };
});
const verif = { _: Object.fromEntries(['mesa', 'silla'].map(k => [k, { ...bienes[k], mv: bienes[k].m, mc: 0, aulas_v: D.locAul[iA].length, aulas: D.locAul[iA].length }])) };

Object.assign(sb.tablas, {
  ioarr_selector_proyectos: [{ id: PID, usuario_id: 'u1', nombre: 'Prueba Lineamientos', region: 'Moquegua', anio_datos: 2025, criterios: CRIT, ioarr_proyecto_id: null, actualizado_en: '2026-10-25' }],
  ioarr_selector_locales: [A, B, C].map(c => ({ proyecto_id: PID, codigo_local: c })),
  ioarr_uit: [{ anio: 2026, valor: 5500 }],
  ioarr_expediente_costos: [{ proyecto_id: PID, anio_uit: 2026, estructura: { kit: true, cc_aplica: 'no', precios: { mesa: 180, silla: 90 }, transporte_pieza: 10 } }],
  ioarr_expediente_inventario: [{ proyecto_id: PID, cod_local: A, bienes, adquisicion: {}, por_nivel: {}, fecha_visita: '2026-10-01', responsable: 'Verificador', observacion: 'Ficha de prueba',
    ficha: { version: 1, archivo: 'ficha_A.xlsx', fecha: '2026-10-01', verificador: 'Verificador', aulas: aulasA, verif, adq_estimada: {} } }]
});

const app = express();
app.use(express.json());
app.use((req, _, next) => { req.usuario = { id: 'u1', email: 'prueba@ejemplo.invalid' }; next(); });
app.use(selectorRouter);
app.use((e, _req, res, _next) => { res.status(e.status || 500).json({ error: e.message, stack: e.stack }); });
const srv = await new Promise(ok => { const s = app.listen(0, () => ok(s)); });
const BASE = `http://127.0.0.1:${srv.address().port}/api/selector-ioarr/proyectos/${PID}`;
const get = async (ruta, { binario } = {}) => {
  const r = await fetch(BASE + ruta);
  if (binario && r.ok) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), nombre: decodeURIComponent((r.headers.get('content-disposition') || '').match(/filename\*=UTF-8''([^;]+)/)?.[1] || '') };
  return { status: r.status, json: await r.json() };
};
const put = async (ruta, body) => { const r = await fetch(BASE + ruta, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const docx = async buf => (await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
const CHECK = { registrado: 'si', contabilidad: 'si', baja: 'si', doc_tipo: 'resolucion', doc_numero: 'RD 010-2026', doc_fecha: '2026-09-30' };

test.after(() => srv.close());

test('1. sin datos por colegio: los 3 bloqueados para el 07-C final; el borrador sale con aviso', async () => {
  const v = await get('/colegios');
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.deepEqual(v.json.filas.map(f => f.cod).sort(), [A, B, C].sort());
  assert.equal(v.json.resumen.bloqueados, 3);
  assert.deepEqual(v.json.filas.find(f => f.cod === B).niveles, ['Primaria', 'Secundaria']);
  const f = await get('/documentos/formato-07c?nivel=P');
  assert.equal(f.status, 400); assert.match(f.json.error, /checklist de inventario y baja/);
  const b = await get('/documentos/formato-07c?nivel=P&borrador=1', { binario: true });
  assert.equal(b.status, 200); assert.match(b.nombre, /_BORRADOR_/);
  assert.ok((await docx(b.buf)).includes(AVISO_BORRADOR));
});

test('2. se cargan A (completo) y C (con entrega reciente); B queda con datos faltantes', async () => {
  let r = await put(`/colegios/${A}`, { datos: { uso: 'operativo', inventario: CHECK, capacidad: { P: 200 } } });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.checklist.completo, true);
  r = await put(`/colegios/${C}`, { datos: { uso: 'operativo', inventario: CHECK, entregas: [{ anio: 2025, cantidad: 5, tipo: 'kit', fuente: 'pronied' }] } });
  assert.equal(r.status, 200);
  assert.equal((await put('/colegios/999999', { datos: {} })).status, 404);   // un local que no es del proyecto
  const v = (await get('/colegios')).json, fila = c => v.filas.find(f => f.cod === c);
  assert.equal(v.resumen.bloqueados, 1); assert.equal(v.resumen.riesgo, 1);
  assert.ok(fila(A).checklist.completo && !fila(A).riesgo.riesgo);
  assert.ok(fila(C).riesgo.riesgo && /2025: 5 kit/.test(fila(C).riesgo.motivos[0]));
  assert.ok(!fila(B).checklist.completo && !fila(B).datos.uso);
  assert.equal(fila(B).costo.niveles.length, 2);   // una IOARR por nivel
});

test('3. avisos en Costos y Documentos: checklist, riesgo de duplicación y uso sin registrar', async () => {
  const c = await get('/costos?nivel=P');
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const t = c.json.avisos.map(a => a.tipo);
  for (const x of ['checklist', 'duplicacion', 'uso']) assert.ok(t.includes(x), x);
  assert.ok(c.json.avisos.some(a => a.tipo === 'checklist' && a.texto.includes(B)));
  assert.ok(c.json.avisos.some(a => a.tipo === 'duplicacion' && a.texto.includes(C)));
  assert.deepEqual(c.json.ioarrs.map(x => x.nivel), ['P', 'S']);
  assert.equal(c.json.comparativo.colegios, 3);
  const d = await get('/documentos?nivel=P');
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.deepEqual(d.json.bloqueados.map(x => x.cod), [B]);
  assert.ok(d.json.faltan.some(x => /Riesgo de duplicación en 1 colegio/.test(x)));
});

test('4. 07-C final de Primaria: entran A y C, no B; Secundaria (solo B) queda bloqueada', async () => {
  const f = await get('/documentos/formato-07c?nivel=P', { binario: true });
  assert.equal(f.status, 200);
  const t = await docx(f.buf);
  assert.ok(!t.includes(AVISO_BORRADOR));
  assert.match(t, new RegExp(`No se incluyen el colegio con el checklist de inventario y baja incompleto.*${B}`));
  assert.match(t, /Registro completo \(masiva\)/);
  assert.match(t, /C = A \+ B\. COSTO DE INVERSIÓN/);
  const s = await get('/documentos/formato-07c?nivel=S');
  assert.equal(s.status, 400); assert.match(s.json.error, /checklist de inventario y baja/);
});

test('5. 05-B, informe de vida útil y anexos de Primaria', async () => {
  const b5 = await get('/documentos/formato-05b?nivel=P', { binario: true });
  assert.equal(b5.status, 200);
  assert.match(await docx(b5.buf), /Inversiones de reposición de mobiliario escolar de las IE de Educación Primaria en la provincia de General Sanchez Cerro, departamento de Moquegua/);
  const v = await get(`/documentos/vida-util?nivel=P&cod=${A}`, { binario: true });
  assert.equal(v.status, 200);
  const tv = await docx(v.buf);
  assert.match(tv, /Lotes del local/); assert.match(tv, /PAT-0-mesa/);   // A repone mesas (su Malo)
  assert.match(tv, /Firma y sello del responsable de control patrimonial/);
  assert.equal((await get(`/documentos/vida-util?nivel=P&cod=${B}`)).status, 404);   // B no entra al final
  const x = await get('/lineamientos/anexos?nivel=P', { binario: true });
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.buf);
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Ficha de activos', 'Inventario y baja', 'Riesgo de duplicación', 'Capacidad y censo', 'Mobiliario en uso']);
  const filas = []; wb.getWorksheet('Ficha de activos').eachRow((r, n) => { if (n > 5 && r.getCell(2).value) filas.push({ cod: r.getCell(2).value, pat: r.getCell(8).value, sit: r.getCell(19).value }); });
  // A: lotes completos (ficha con código y antigüedad) y una fila de ajuste, porque tiene 26 mesas malas
  // y 18 de matrícula: el tope recorta 8 (no aumentar capacidad)
  const deA = filas.filter(f => f.cod === A);
  assert.ok(deA.filter(f => f.sit !== 'Ajuste').every(f => f.sit === 'Completa' && /^PAT-/.test(f.pat)));
  assert.equal(deA.filter(f => f.sit === 'Ajuste').length, 1);
  const cap = []; wb.getWorksheet('Capacidad y censo').eachRow((r, n) => { if (n > 5 && r.getCell(1).value === A) cap.push([r.getCell(3).value, r.getCell(8).value, r.getCell(10).value, r.getCell(11).value]); });
  assert.deepEqual(cap, [[18, 26, 8, 18]]);   // matrícula, mesas antes del tope, recortado, mesas a reponer
  assert.ok(filas.filter(f => f.cod === C).every(f => f.sit === PENDIENTE_CAMPO || f.sit === 'Ajuste'));
  const chk = []; wb.getWorksheet('Inventario y baja').eachRow((r, n) => { if (n > 4) chk.push([r.getCell(1).value, r.getCell(9).value]); });
  assert.deepEqual(chk.sort(), [[A, 'Entra'], [B, 'Bloqueado: no entra al final'], [C, 'Entra']].sort());
  const rs = []; wb.getWorksheet('Riesgo de duplicación').eachRow((r, n) => { if (n > 4) rs.push([r.getCell(1).value, r.getCell(3).value]); });
  assert.deepEqual(rs, [[C, 'Riesgo de duplicación']]);
});

test('6. ZIP final y borrador', async () => {
  const leer = async q => { const z = await get('/expediente-zip' + q, { binario: true }); assert.equal(z.status, 200); return JSZip.loadAsync(z.buf); };
  const fin = await leer(''), nombres = Object.keys(fin.files);
  assert.ok(nombres.some(n => /01_IOARR_Primaria\/00_Formato_05B_idea\.docx$/.test(n)));
  assert.ok(nombres.some(n => /01_IOARR_Primaria\/07_Informes_vida_util_por_colegio\/Informe_vida_util_398477\.docx$/.test(n)));
  assert.ok(!nombres.some(n => /IOARR_Secundaria/.test(n)));   // Secundaria: su único colegio está bloqueado
  const bor = await leer('?borrador=1');
  assert.ok(Object.keys(bor.files).some(n => /IOARR_Secundaria\/01_Formato_07C_borrador\.docx$/.test(n)));
});

test('7. descontar la entrega de C quita el riesgo y baja los kits; B cerrado sale del monto', async () => {
  const antes = (await get('/costos?nivel=P')).json;
  const kC = antes.locales.find(l => l.cod === C).kits;
  await put(`/colegios/${C}`, { datos: { uso: 'operativo', inventario: CHECK, entregas: [{ anio: 2025, cantidad: 5, tipo: 'kit', fuente: 'pronied', restar: true }] } });
  const desp = (await get('/costos?nivel=P')).json;
  assert.equal(desp.locales.find(l => l.cod === C).kits, Math.max(0, kC - 5));
  assert.ok(!desp.avisos.some(a => a.tipo === 'duplicacion' && a.alerta));
  assert.ok(desp.avisos.some(a => a.tipo === 'duplicacion' && /Se descuentan? \d+ bien/.test(a.texto)));
  await put(`/colegios/${B}`, { datos: { uso: 'cerrado' } });
  const v = (await get('/colegios')).json;
  assert.equal(v.resumen.sin_uso, 1); assert.ok(v.filas.find(f => f.cod === B).sin_uso);
  const c = (await get('/costos?nivel=P')).json;
  assert.ok(!c.locales.some(l => l.cod === B));
  assert.ok(c.avisos.some(a => a.tipo === 'uso' && a.alerta && a.texto.includes(`${B} (cerrado)`)));
  assert.deepEqual(c.ioarrs.map(x => x.nivel), ['P']);   // B era el único de Secundaria
});
