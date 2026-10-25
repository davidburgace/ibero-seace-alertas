// Prueba de punta a punta de las rutas del documento equivalente con 3 colegios reales de Moquegua
// y un Supabase en memoria. La corre test/documento-equivalente-api.test.js en un proceso aparte,
// con --experimental-test-module-mocks (para reemplazar src/ioarr/db.js).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import JSZip from 'jszip';
import { supabaseMemoria } from '../helpers/supabase-memoria.js';

const sb = supabaseMemoria();
mock.module(new URL('../../src/ioarr/db.js', import.meta.url).href, { namedExports: { supabase: sb } });
const { default: selectorRouter } = await import('../../src/selector-ioarr/router.js');

const PID = '11111111-2222-3333-4444-555555555555', OTRO = '99999999-2222-3333-4444-555555555555', RADAR = '77777777-2222-3333-4444-555555555555';
Object.assign(sb.tablas, {
  ioarr_selector_proyectos: [
    { id: PID, usuario_id: 'u1', nombre: 'Prueba DE', region: 'Moquegua', anio_datos: 2025, criterios: { muebles: ['mesa', 'silla'] }, ioarr_proyecto_id: RADAR, actualizado_en: '2026-10-25' },
    { id: OTRO, usuario_id: 'u2', nombre: 'De otro usuario', region: 'Moquegua', anio_datos: 2025, criterios: {}, ioarr_proyecto_id: null, actualizado_en: '2026-10-25' }],
  ioarr_selector_locales: ['398477', '397642', '398316'].map(c => ({ proyecto_id: PID, codigo_local: c })),
  ioarr_proyectos: [{ id: RADAR, cui: '2700001', nombre: 'IOARR de Radar', entidad: 'Gobierno Regional de Moquegua' }],
  ioarr_uit: [{ anio: 2026, valor: 5500 }],
  ioarr_expediente_costos: [{ proyecto_id: PID, anio_uit: 2026, estructura: { kit: true, cc_aplica: 'no', precios: { mesa: 180, silla: 90 }, transporte_pieza: 10 } }],
  ioarr_expediente_documentos: [{ proyecto_id: PID, datos: { uf: 'Unidad Formuladora de Moquegua', por_nivel: { P: { nombre_inversion: 'ADQUISICIÓN DE MOBILIARIO DE AULA PRIMARIA MOQUEGUA', cui: '2700001' } } } }],
  // Ficha de bases del mismo nivel: la precarga toma de aquí lo que el usuario ya revisó
  ioarr_bases_fichas: [{ id: '33333333-2222-3333-4444-555555555555', proyecto_id: PID, nivel: 'P', nombre: 'Bases Primaria', actualizado_en: '2026-10-20',
    datos: { N_PROCESO: '001-2026-CE-PRUEBA', PLAZO_EJECUCION_DIAS: 60, normas_tecnicas: 'RVM N° 331-2021-MINEDU', MONTO_SUP_DOC_EQUIVALENTE: 300, MONTO_SUP_EJECUCION: 900 } }]
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
const pedir = async (metodo, ruta, body, { binario, form } = {}) => {
  const r = await fetch(API + ruta, { method: metodo, headers: body && !form ? { 'Content-Type': 'application/json' } : {}, body: form || (body ? JSON.stringify(body) : undefined) });
  if (binario && r.ok) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
  return { status: r.status, json: await r.json() };
};
const textoDocx = async buf => (await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const pdf = (nombre, contenido = '%PDF-1.4\n%prueba\n') => { const f = new FormData(); f.append('archivo', new Blob([contenido], { type: 'application/pdf' }), nombre); return f; };

let fid, metas, cots;
test('lista las IOARR por nivel y crea una ficha precargada con la app y la ficha de bases', async () => {
  const r = await pedir('GET', `/proyectos/${PID}/documento-equivalente`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.niveles.map(n => n.nivel), ['P', 'S']);
  assert.deepEqual(r.json.tomos.map(t => t.id), ['PT', 'I', 'II', 'III']);
  assert.equal((await pedir('POST', `/proyectos/${PID}/documento-equivalente`, { nivel: 'I' })).status, 400, 'nivel sin IOARR');
  const c = await pedir('POST', `/proyectos/${PID}/documento-equivalente`, { nivel: 'P' });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  fid = c.json.ficha.id; metas = c.json.app.metas;
  const d = c.json.datos;
  assert.equal(d.NOMBRE_IOARR, 'ADQUISICIÓN DE MOBILIARIO DE AULA PRIMARIA MOQUEGUA');
  assert.equal(d.CUI, '2700001');
  assert.equal(d.ENTIDAD, 'Gobierno Regional de Moquegua');
  assert.equal(d.PLAZO_EJECUCION_DIAS, 60, 'de la ficha de bases');
  assert.equal(d.NORMAS_TECNICAS, 'RVM N° 331-2021-MINEDU');
  assert.equal(d.MONTO_SUPERVISION, 1200, 'las dos supervisiones de la ficha de bases');
  assert.equal(d.bases_origen, 'Bases del Proceso de Selección N° 001-2026-CE-PRUEBA');
  assert.match(d.LOCALIZACION, /MOQUEGUA/);
  assert.ok(d.MONTO_DOC_EQUIVALENTE > 0);
  assert.ok(metas.length > 0 && c.json.app.locales === 3);
  assert.ok(!c.json.validacion.ok);
  assert.ok(c.json.validacion.errores.some(e => e.k === 'MONTO_CONVENIO_EJECUCION'));
  assert.ok(c.json.validacion.errores.some(e => e.k === 'cotizaciones'));
});

test('sin cotizaciones ni convenio no se exporta (422); la vista previa sí sale', async () => {
  const r = await pedir('POST', `/documento-equivalente/${fid}/exportar`);
  assert.equal(r.status, 422);
  assert.ok(r.json.errores.length >= 2);
  const v = await pedir('GET', `/documento-equivalente/${fid}/vista-previa`, null, { binario: true });
  assert.equal(v.status, 200);
  assert.match(await textoDocx(v.buf), /\{\{TABLA_COTIZACIONES\}\}/);
  assert.equal((await pedir('GET', `/documento-equivalente/${fid}/versiones`)).json.length, 0, 'la vista previa no guarda versión');
});

test('legajo: 3 cotizaciones vigentes por ítem; el PDF lo controla el servidor', async () => {
  const cotizaciones = ['Proveedor A', 'Proveedor B', 'Proveedor C'].map((proveedor, i) => ({
    proveedor, fecha: hoy, vigencia_dias: 30, incluye_igv: i === 2, plazo_entrega_dias: 40,
    precios: Object.fromEntries(metas.map(m => [m.k, i === 2 ? 118 : 100])), archivo_ruta: 'trampa/otro.pdf', archivo_nombre: 'trampa.pdf'
  }));
  const g = await pedir('PATCH', `/documento-equivalente/${fid}`, { datos: { cotizaciones, normas_verificadas: true, MONTO_CONVENIO_EJECUCION: 1e6 } });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  cots = g.json.datos.cotizaciones;
  assert.equal(cots.length, 3);
  assert.ok(cots.every(c => c.archivo_ruta === null), 'la ruta del PDF no la pone el navegador');
  assert.ok(g.json.presupuesto.items.every(x => x.pu === 100), 'promedio sin IGV: 100, 100 y 118 ÷ 1,18');
  assert.deepEqual(g.json.validacion.errores, []);
  // PDF: solo PDF; se guarda en el bucket y se abre con URL firmada
  assert.equal((await pedir('POST', `/documento-equivalente/${fid}/cotizaciones/${cots[0].id}/archivo`, null, { form: pdf('no.pdf', 'no es un pdf') })).status, 400);
  const s = await pedir('POST', `/documento-equivalente/${fid}/cotizaciones/${cots[0].id}/archivo`, null, { form: pdf('Cotización A.pdf') });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  const c0 = s.json.datos.cotizaciones[0];
  assert.equal(c0.archivo_nombre, 'Cotización A.pdf');
  assert.ok(sb.bucket.has(c0.archivo_ruta) && c0.archivo_ruta.startsWith(`de/${fid}/${c0.id}/`));
  assert.match((await pedir('GET', `/documento-equivalente/${fid}/cotizaciones/${c0.id}/archivo`)).json.url, /^https:\/\/ejemplo\.invalid\/de\//);
  // Editar la cotización desde el navegador no pierde su PDF
  const e = await pedir('PATCH', `/documento-equivalente/${fid}`, { datos: { cotizaciones: s.json.datos.cotizaciones.map(c => ({ ...c, archivo_ruta: null, plazo_entrega_dias: 35 })) } });
  assert.equal(e.json.datos.cotizaciones[0].archivo_ruta, c0.archivo_ruta);
  cots = e.json.datos.cotizaciones;
});

test('el presupuesto no puede superar el convenio: bloquea y avisa', async () => {
  const g = await pedir('PATCH', `/documento-equivalente/${fid}`, { datos: { MONTO_CONVENIO_EJECUCION: 10 } });
  assert.ok(g.json.validacion.errores.some(e => e.k === 'MONTO_CONVENIO_EJECUCION' && /supera/.test(e.texto)));
  assert.equal((await pedir('POST', `/documento-equivalente/${fid}/exportar`)).status, 422);
  await pedir('PATCH', `/documento-equivalente/${fid}`, { datos: { MONTO_CONVENIO_EJECUCION: 1e6 } });
});

test('exportar: versión 1 y 2, con fecha y usuario; se vuelven a descargar', async () => {
  const e1 = await pedir('POST', `/documento-equivalente/${fid}/exportar`, null, { binario: true });
  assert.equal(e1.status, 200);
  assert.equal(e1.headers.get('x-de-version'), '1');
  const t = await textoDocx(e1.buf);
  assert.match(t, /Documento equivalente \(borrador\) · Versión 1|DOCUMENTO EQUIVALENTE/);
  assert.match(t, /Proveedor A/);
  const e2 = await pedir('POST', `/documento-equivalente/${fid}/exportar`, null, { binario: true });
  assert.equal(e2.headers.get('x-de-version'), '2');
  const vs = (await pedir('GET', `/documento-equivalente/${fid}/versiones`)).json;
  assert.deepEqual(vs.map(v => v.version), [2, 1]);
  assert.equal(vs[0].usuario, 'formulador@ejemplo.invalid');
  assert.ok(vs[0].total > 0);
  assert.equal(sb.tablas.ioarr_de_versiones.find(v => v.version === 1).datos.cotizaciones.length, 3, 'la versión guarda el legajo');
  const d1 = await pedir('GET', `/documento-equivalente/${fid}/versiones/1/docx`, null, { binario: true });
  assert.equal(d1.status, 200);
  assert.equal((await pedir('GET', `/documento-equivalente/${fid}/versiones/9/docx`)).status, 404);
});

test('quitar una cotización borra su PDF; otro usuario no ve la ficha; borrar la ficha', async () => {
  const ruta = cots[0].archivo_ruta;
  const g = await pedir('PATCH', `/documento-equivalente/${fid}`, { datos: { cotizaciones: cots.slice(1) } });
  assert.equal(g.json.datos.cotizaciones.length, 2);
  assert.ok(!sb.bucket.has(ruta), 'el PDF de la cotización quitada se borra');
  assert.ok(g.json.validacion.errores.some(e => e.k === 'justificaciones'), 'con 2 cotizaciones pide justificación');
  usuario = { id: 'u2', email: 'otro@ejemplo.invalid' };
  assert.equal((await pedir('GET', `/documento-equivalente/${fid}`)).status, 404);
  assert.equal((await pedir('GET', `/proyectos/${PID}/documento-equivalente`)).status, 404);
  usuario = { id: 'u1', email: 'formulador@ejemplo.invalid' };
  assert.equal((await pedir('DELETE', `/documento-equivalente/${fid}`)).status, 200);
  assert.equal((await pedir('GET', `/documento-equivalente/${fid}`)).status, 404);
});
