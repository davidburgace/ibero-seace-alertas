// Prueba de punta a punta del catálogo de precios referenciales con 3 colegios reales de Moquegua y un
// Supabase en memoria (precarga de la migración 029). La corre test/precios-ref-api.test.js en un proceso
// aparte, con --experimental-test-module-mocks (para reemplazar src/ioarr/db.js).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { supabaseMemoria } from '../helpers/supabase-memoria.js';
import { PRECARGA, COLUMNAS_CSV } from '../../src/selector-ioarr/catalogo-ref.js';

const sb = supabaseMemoria();
mock.module(new URL('../../src/ioarr/db.js', import.meta.url).href, { namedExports: { supabase: sb } });
const { default: selectorRouter } = await import('../../src/selector-ioarr/router.js');

const PID = '11111111-2222-3333-4444-555555555555';
Object.assign(sb.tablas, {
  ioarr_selector_proyectos: [{ id: PID, usuario_id: 'u1', nombre: 'Prueba Precios', region: 'Moquegua', anio_datos: 2025, criterios: { muebles: ['mesa', 'silla'] }, ioarr_proyecto_id: null, actualizado_en: '2026-10-25' }],
  ioarr_selector_locales: ['398477', '397642', '398316'].map(c => ({ proyecto_id: PID, codigo_local: c })),
  ioarr_uit: [{ anio: 2026, valor: 5500 }],
  ioarr_expediente_costos: [{ proyecto_id: PID, anio_uit: 2026, estructura: { kit: true, cc_aplica: 'no', precios: { mesa: 180, silla: 90 }, transporte_pieza: 10 } }],
  ioarr_precios_ref: PRECARGA.map(r => ({ ...r, monto: String(r.monto), monto_hasta: r.monto_hasta == null ? null : String(r.monto_hasta) }))
});

const app = express();
app.use(express.json());
app.use((req, _, next) => { req.usuario = { id: 'u1', email: 'f@ejemplo.invalid' }; next(); });
app.use(selectorRouter);
app.use((e, _req, res, _next) => { res.status(e.status || 500).json({ error: e.message, stack: e.stack }); });
const srv = await new Promise(ok => { const s = app.listen(0, () => ok(s)); });
after(() => srv.close());
const API = `http://127.0.0.1:${srv.address().port}/api/selector-ioarr`;
const pedir = async (metodo, ruta, body) => {
  const r = await fetch(API + ruta, { method: metodo, headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null), r };
};
const archivo = (contenido, nombre, tipo) => { const fd = new FormData(); fd.append('archivo', new Blob([contenido], { type: tipo }), nombre); return fd; };

test('catálogo con la precarga: normalizado, estadísticos sin el propio y posición del propio', async () => {
  const { status, json } = await pedir('GET', '/precios-ref');
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.registros.length, 5);
  assert.equal(json.registros.filter(r => r.comparable && !r.propio).length, 1);
  assert.deepEqual(json.estadisticos.map(g => [g.material, g.nivel, g.n, g.mediana, g.pocas]), [['madera', 'por_confirmar', 1, 624, true]]);
  assert.ok('madera' in json.opciones.materiales);
  assert.equal(json.propio.precio_kit_sin_igv, 850);
  assert.match(json.estadisticos[0].propio.texto, /36\.22 % sobre la mediana/);
});

test('alta manual con validaciones, edición y PDF fuente', async () => {
  const mal = await pedir('POST', '/precios-ref', { tipo_documento: 'bases', anio: 2026, nivel: 'Primaria', unidad: 'mesa', material: 'metal-madera', monto: 0, confianza: 'alta' });
  assert.equal(mal.status, 400);
  assert.ok(mal.json.errores.length >= 2);
  const ok = await pedir('POST', '/precios-ref', { tipo_documento: 'bases', cui: '2600001', entidad: 'GR Ejemplo', region: 'Moquegua', anio: 2026, nivel: 'Primaria', unidad: 'mesa', material: 'metal-madera', monto: 354, incluye_igv: 'si', composicion: [{ unidad: 'mesa', cantidad: 1 }, { unidad: 'silla', cantidad: 1, precio: 177 }], confianza: 'alta' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.precio_kit_sin_igv, 450);
  // Confirmar el IGV de Huánuco 2025 lo vuelve comparable (punto medio 467.50)
  const h = await pedir('PATCH', '/precios-ref/c0a7a10e-0000-4000-8000-000000000003', { incluye_igv: false });
  assert.equal(h.status, 200, JSON.stringify(h.json));
  assert.equal(h.json.precio_kit_sin_igv, 467.5);
  assert.equal((await pedir('PATCH', '/precios-ref/c0a7a10e-0000-4000-8000-000000000003', { monto_hasta: 1 })).status, 400);
  // PDF: solo PDF
  assert.equal((await pedir('POST', `/precios-ref/${ok.json.id}/archivo`, archivo('hola', 'a.txt', 'text/plain'))).status, 400);
  const pdf = await pedir('POST', `/precios-ref/${ok.json.id}/archivo`, archivo('%PDF-1.4\n%prueba\n', 'bases.pdf', 'application/pdf'));
  assert.equal(pdf.status, 201, JSON.stringify(pdf.json));
  assert.match((await pedir('GET', `/precios-ref/${ok.json.id}/archivo`)).json.url, /catalogo-ref\//);
  assert.ok((await pedir('GET', '/precios-ref')).json.registros.find(r => r.id === ok.json.id).tiene_archivo);
});

test('importar CSV: reporte por fila sin importar nada; luego revisar e importar', async () => {
  const malo = [COLUMNAS_CSV.join(','), 'bases,,GR,Tacna,2026,,Primaria,kit,metal-madera,600,,no,,,,,,alta,', 'bases,,GR,Tacna,2026,,Primaria,silla,metal-madera,150,,no,,,,,,altísima,'].join('\n');
  const r1 = await pedir('POST', '/precios-ref/importar?confirmar=1', archivo(malo, 'p.csv', 'text/csv'));
  assert.equal(r1.status, 422);
  assert.deepEqual(r1.json.errores.map(e => e.fila), [3]);
  assert.equal(r1.json.importados, 0);
  const antes = (await pedir('GET', '/precios-ref')).json.registros.length;
  const bueno = [COLUMNAS_CSV.join(','), 'bases,,GR,Tacna,2026,,Primaria,kit,metal-madera,600,,no,,,,,,alta,', 'estudio_mercado,,GR,Puno,2025,,Primaria,kit,metal-madera,700,,no,,,,,,media,'].join('\n');
  const rev = await pedir('POST', '/precios-ref/importar', archivo(bueno, 'p.csv', 'text/csv'));
  assert.equal(rev.status, 200);
  assert.equal(rev.json.importados, 0, 'revisar no guarda');
  const imp = await pedir('POST', '/precios-ref/importar?confirmar=1', archivo(bueno, 'p.csv', 'text/csv'));
  assert.equal(imp.status, 201);
  assert.equal(imp.json.importados, 2);
  assert.equal((await pedir('GET', '/precios-ref')).json.registros.length, antes + 2);
  const pl = await fetch(API + '/precios-ref/plantilla.csv');
  const bytes = Buffer.from(await pl.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM: Excel abre bien las tildes');
  assert.match(bytes.toString('utf8', 3), /^tipo_documento,cui,entidad/);
});

test('proyecto: referencia (mediana), monto del convenio estimado y riesgo del precio propio', async () => {
  const { status, json } = await pedir('GET', `/proyectos/${PID}/precios-ref`);
  assert.equal(status, 200, JSON.stringify(json));
  assert.deepEqual(json.seleccion, { modo: 'mediana', registro_id: null, material: 'todos' });
  const P = json.ioarrs.find(x => x.nivel === 'P');
  // Primaria: Loreto 624, Huánuco 2025 467.50 (nivel por confirmar), mesa 450, Tacna 600, Puno 700
  assert.deepEqual(P.referencia.registros.length, 5);
  assert.equal(P.referencia.precio, 600);
  assert.ok(P.estimado.convenio > 0 && P.propio.convenio > P.estimado.convenio);
  assert.equal(P.riesgo.fuera, 'encima');
  assert.match(P.riesgo.texto, /supera el 110 %/);
  // Una fuente específica; el propio no se puede elegir
  assert.equal((await pedir('PUT', `/proyectos/${PID}/precios-ref`, { modo: 'registro', registro_id: 'c0a7a10e-0000-4000-8000-000000000005' })).status, 400);
  assert.equal((await pedir('PUT', `/proyectos/${PID}/precios-ref`, { modo: 'registro', registro_id: 'c0a7a10e-0000-4000-8000-000000000004' })).status, 400, 'no comparable');
  // Loreto es de madera: no se puede guardar como fuente de metal y madera
  const m = await pedir('PUT', `/proyectos/${PID}/precios-ref`, { modo: 'registro', registro_id: 'c0a7a10e-0000-4000-8000-000000000001', material: 'metal-madera' });
  assert.equal(m.status, 400);
  assert.match(m.json.error, /es de madera, no de metal y madera/);
  // Mediana de metal y madera: mesa 450, Huánuco 2025 467.50 (IGV confirmado arriba), Tacna 600 y Puno 700 (CSV)
  const mm = await pedir('PUT', `/proyectos/${PID}/precios-ref`, { modo: 'mediana', material: 'metal-madera' });
  assert.equal(mm.json.ioarrs.find(x => x.nivel === 'P').referencia.precio, 533.75);
  const u = await pedir('PUT', `/proyectos/${PID}/precios-ref`, { modo: 'registro', registro_id: 'c0a7a10e-0000-4000-8000-000000000001', material: 'madera' });
  assert.equal(u.status, 200);
  assert.equal(u.json.ioarrs.find(x => x.nivel === 'P').referencia.precio, 624);
});

test('la ficha de bases toma el precio del catálogo con su fuente (nunca el propio)', async () => {
  const c = await pedir('POST', `/proyectos/${PID}/bases`, { nivel: 'P' });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(c.json.app.precio_ref.precio, 624);
  assert.match(c.json.app.precio_ref.fuente, /Loreto, 2026/);
  const g = await pedir('PATCH', `/bases/${c.json.ficha.id}`, { datos: { precio_kit_origen: 'catalogo' } });
  const kit = g.json.cantidades.filas.find(f => f.k === 'kit');
  assert.equal(kit.pu, 736.32);
  assert.ok(kit.catalogo);
  assert.doesNotMatch(JSON.stringify(g.json), /850|propio/i);
});
