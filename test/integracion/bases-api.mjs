// Prueba de punta a punta de las rutas del generador de bases OxI con 3 colegios reales de Moquegua
// y un Supabase en memoria. La corre test/bases-api.test.js en un proceso aparte, con
// --experimental-test-module-mocks (para reemplazar src/ioarr/db.js).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import JSZip from 'jszip';
import { supabaseMemoria } from '../helpers/supabase-memoria.js';
import { FICHA_PRUEBA } from '../helpers/ficha-bases.js';

const sb = supabaseMemoria();
mock.module(new URL('../../src/ioarr/db.js', import.meta.url).href, { namedExports: { supabase: sb } });
const { default: selectorRouter } = await import('../../src/selector-ioarr/router.js');

const PID = '11111111-2222-3333-4444-555555555555', OTRO = '99999999-2222-3333-4444-555555555555', RADAR = '77777777-2222-3333-4444-555555555555';
Object.assign(sb.tablas, {
  ioarr_selector_proyectos: [
    { id: PID, usuario_id: 'u1', nombre: 'Prueba Bases', region: 'Moquegua', anio_datos: 2025, criterios: { muebles: ['mesa', 'silla'] }, ioarr_proyecto_id: RADAR, actualizado_en: '2026-10-25' },
    { id: OTRO, usuario_id: 'u2', nombre: 'De otro usuario', region: 'Moquegua', anio_datos: 2025, criterios: {}, ioarr_proyecto_id: null, actualizado_en: '2026-10-25' }],
  ioarr_selector_locales: ['398477', '397642', '398316'].map(c => ({ proyecto_id: PID, codigo_local: c })),
  ioarr_proyectos: [{ id: RADAR, cui: '2700001', nombre: 'IOARR de Radar', entidad: 'Gobierno Regional de Moquegua' }],
  ioarr_uit: [{ anio: 2026, valor: 5500 }],
  ioarr_expediente_costos: [{ proyecto_id: PID, anio_uit: 2026, estructura: { kit: true, cc_aplica: 'no', precios: { mesa: 180, silla: 90 }, transporte_pieza: 10 } }],
  ioarr_expediente_documentos: [{ proyecto_id: PID, datos: { uf: 'Unidad Formuladora de Moquegua', por_nivel: { P: { nombre_inversion: 'ADQUISICIÓN DE MOBILIARIO DE AULA PRIMARIA MOQUEGUA', cui: '2700001' } } } }]
});

let usuario = { id: 'u1', email: 'formulador@ejemplo.invalid' };
const app = express();
app.use(express.json());
app.use((req, _, next) => { req.usuario = usuario; next(); });
app.use(selectorRouter);
app.use((e, _req, res, _next) => { res.status(e.status || 500).json({ error: e.message, stack: e.stack }); });
const srv = await new Promise(ok => { const s = app.listen(0, () => ok(s)); });
after(() => srv.close());
const API = `http://127.0.0.1:${srv.address().port}/api/selector-ioarr`;
const pedir = async (metodo, ruta, body, { binario } = {}) => {
  const r = await fetch(API + ruta, { method: metodo, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (binario && r.ok) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
  return { status: r.status, json: await r.json() };
};
const textoDocx = async buf => (await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
const { _precarga, _precarga_notas, NOMBRE_IOARR, CUI, MONTO_DOC_EQUIVALENTE, MONTO_EJECUCION, MONTO_SUP_EJECUCION, ENTIDAD, ...RESTO } = FICHA_PRUEBA;

let fid, fichaP;
test('el proyecto lista sus IOARR por nivel y crea una ficha precargada (una por nivel)', async () => {
  const r = await pedir('GET', `/proyectos/${PID}/bases`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.niveles.map(n => n.nivel), ['P', 'S']);
  assert.deepEqual(r.json.fichas, []);
  assert.ok(r.json.campos.some(s => s.id === 'montos'));
  assert.equal((await pedir('POST', `/proyectos/${PID}/bases`, { nivel: 'I' })).status, 400, 'nivel sin IOARR');
  assert.equal((await pedir('POST', `/proyectos/${PID}/bases`, {})).status, 400, 'sin nivel');
  const c = await pedir('POST', `/proyectos/${PID}/bases`, { nivel: 'P' });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  fid = c.json.ficha.id; fichaP = c.json;
  const d = c.json.datos;
  assert.equal(c.json.ficha.nivel, 'P');
  assert.equal(d.NOMBRE_IOARR, 'ADQUISICIÓN DE MOBILIARIO DE AULA PRIMARIA MOQUEGUA');
  assert.equal(d.CUI, '2700001');
  assert.equal(d.ENTIDAD, 'Gobierno Regional de Moquegua');
  assert.equal(d.UF_NOMBRE, 'Unidad Formuladora de Moquegua');
  assert.ok(d.MONTO_EJECUCION > 0 && d.MONTO_DOC_EQUIVALENTE > 0 && d.MONTO_SUP_EJECUCION > 0);
  assert.equal(d.MONTO_SUP_DOC_EQUIVALENTE, null, 'no se inventa');
  assert.equal(d._precarga.MONTO_EJECUCION, d.MONTO_EJECUCION);
  assert.ok(c.json.cantidades.filas.length > 0, 'cantidades del cálculo de la app');
  assert.equal(c.json.app.nivel_nombre, 'Primaria');
  assert.ok(!c.json.validacion.ok);
  assert.ok(c.json.validacion.errores.some(e => e.k === 'MONTO_SUP_DOC_EQUIVALENTE' && /Documento equivalente/.test(e.texto)));
});

test('exportar bloquea con errores (422) y la vista previa sí sale', async () => {
  const r = await pedir('POST', `/bases/${fid}/exportar`);
  assert.equal(r.status, 422);
  assert.ok(r.json.errores.length > 10);
  const v = await pedir('GET', `/bases/${fid}/vista-previa`, null, { binario: true });
  assert.equal(v.status, 200);
  const texto = await textoDocx(v.buf);
  assert.match(texto, /\{\{ENTIDAD_TELEFONO\}\}/, "lo que falta queda marcado");
  assert.match(texto, /RUC N° : 20519752604/, "el RUC del Gobierno Regional de Moquegua se precarga");
  assert.equal((await pedir('GET', `/bases/${fid}/versiones`)).json.length, 0, 'la vista previa no guarda versión');
});

test('completar la ficha, exportar versión 1 y 2, y comparar', async () => {
  const g = await pedir('PATCH', `/bases/${fid}`, { datos: { ...RESTO, MONTO_SUP_DOC_EQUIVALENTE: 1000.25, _precarga: { ENTIDAD: 'trampa' } } });
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.validacion.errores, []);
  assert.notEqual(g.json.datos._precarga.ENTIDAD, 'trampa', 'lo precargado no lo cambia el navegador');
  const M = g.json.calculados;
  assert.equal(M.MONTO_TOTAL, Math.round((g.json.datos.MONTO_DOC_EQUIVALENTE + g.json.datos.MONTO_EJECUCION + 1000.25 + g.json.datos.MONTO_SUP_EJECUCION) * 100) / 100);
  const e1 = await pedir('POST', `/bases/${fid}/exportar`, null, { binario: true });
  assert.equal(e1.status, 200);
  assert.equal(e1.headers.get('x-bases-version'), '1');
  const t = await textoDocx(e1.buf);
  assert.match(t, /HOJA DE TRANSPARENCIA/);
  assert.match(t, /Versión 1 · \d{4}-\d{2}-\d{2} · preparada por formulador@ejemplo\.invalid/);
  assert.match(t, /Gobierno Regional de Moquegua/);
  assert.match(t, /Prestación N° 1: Elaboración de documento equivalente/);
  await pedir('PATCH', `/bases/${fid}`, { datos: { PLAZO_DOC_EQUIVALENTE_DIAS: 60 } });
  const e2 = await pedir('POST', `/bases/${fid}/exportar`, null, { binario: true });
  assert.equal(e2.headers.get('x-bases-version'), '2');
  const vs = (await pedir('GET', `/bases/${fid}/versiones`)).json;
  assert.deepEqual(vs.map(v => [v.version, v.usuario]), [[2, 'formulador@ejemplo.invalid'], [1, 'formulador@ejemplo.invalid']]);
  const c = (await pedir('GET', `/bases/${fid}/comparar?a=1&b=2`)).json;
  assert.deepEqual(c.cambios.map(x => [x.k, x.antes, x.despues]), [['PLAZO_DOC_EQUIVALENTE_DIAS', '30', '60']]);
  // El .docx de una versión vieja sale de lo guardado, no de la ficha actual
  const v1 = await pedir('GET', `/bases/${fid}/versiones/1/docx`, null, { binario: true });
  assert.match(await textoDocx(v1.buf), /Plazo de elaboración del documento equivalente: 30 días calendario/);
  assert.equal(v1.headers.get('x-plantillas-cambiaron'), null);
  assert.equal((await pedir('GET', `/bases/${fid}/versiones/9/docx`)).status, 404);
});

test('duplicar: en el mismo nivel copia todo; a otro nivel vuelve a tomar lo propio del nivel', async () => {
  const a = await pedir('POST', `/bases/${fid}/duplicar`, {});
  assert.equal(a.status, 201);
  assert.equal(a.json.ficha.nombre, 'Bases Primaria (copia)');
  assert.equal(a.json.datos.N_PROCESO, FICHA_PRUEBA.N_PROCESO);
  assert.equal(a.json.datos.MONTO_SUP_DOC_EQUIVALENTE, 1000.25);
  assert.equal(a.json.versiones, 0, 'las versiones no se copian');
  const s = await pedir('POST', `/bases/${fid}/duplicar`, { nivel: 'S' });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.equal(s.json.ficha.nivel, 'S');
  assert.equal(s.json.datos.N_PROCESO, FICHA_PRUEBA.N_PROCESO, 'lo común se copia');
  assert.equal(s.json.datos.MONTO_SUP_DOC_EQUIVALENTE, null, 'lo propio del nivel no');
  assert.notEqual(s.json.datos.MONTO_EJECUCION, fichaP.datos.MONTO_EJECUCION);
  assert.equal(s.json.app.nivel_nombre, 'Secundaria');
  assert.equal((await pedir('GET', `/proyectos/${PID}/bases`)).json.fichas.length, 3);
});

test('precargar: solo llena lo vacío', async () => {
  await pedir('PATCH', `/bases/${fid}`, { datos: { ENTIDAD: 'Escrita a mano', UF_NOMBRE: '' } });
  const r = await pedir('POST', `/bases/${fid}/precargar`);
  assert.equal(r.json.datos.ENTIDAD, 'Escrita a mano');
  assert.equal(r.json.datos.UF_NOMBRE, 'Unidad Formuladora de Moquegua');
  assert.deepEqual(r.json.llenados, ['UF_NOMBRE']);
});

test('total declarado: si las prestaciones no lo suman, no se guarda', async () => {
  const antes = (await pedir('GET', `/bases/${fid}`)).json.datos;
  const r = await pedir('PATCH', `/bases/${fid}`, { datos: { total_declarado: 1, N_PROCESO: 'NO-DEBE-GUARDARSE' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /^No se guardó: Las cuatro prestaciones suman S\/ [\d,.]+ y el total declarado es S\/ 1\.00/);
  const despues = (await pedir('GET', `/bases/${fid}`)).json.datos;
  assert.equal(despues.N_PROCESO, antes.N_PROCESO);
  assert.equal(despues.total_declarado, null);
  const M = (await pedir('GET', `/bases/${fid}`)).json.calculados.MONTO_TOTAL;
  assert.equal((await pedir('PATCH', `/bases/${fid}`, { datos: { total_declarado: M } })).status, 200);
});

test('solo el dueño del proyecto', async () => {
  usuario = { id: 'u2', email: 'otro@ejemplo.invalid' };
  try {
    assert.equal((await pedir('GET', `/bases/${fid}`)).status, 404);
    assert.equal((await pedir('POST', `/bases/${fid}/exportar`)).status, 404);
    assert.equal((await pedir('GET', `/proyectos/${PID}/bases`)).status, 404);
    assert.equal((await pedir('POST', `/bases/${fid}/duplicar`, { proyecto_id: OTRO })).status, 404);
  } finally { usuario = { id: 'u1', email: 'formulador@ejemplo.invalid' }; }
  assert.equal((await pedir('DELETE', `/bases/${fid}`)).status, 200);
  assert.equal((await pedir('GET', `/bases/${fid}`)).status, 404);
});
