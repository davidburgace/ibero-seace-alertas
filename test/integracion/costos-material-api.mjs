// Prueba de punta a punta: material y muebles de la propuesta en Costos, y su llegada a Bases OxI,
// Oferta (uso interno), documento equivalente y al duplicar el proyecto. 3 colegios reales de Moquegua
// y un Supabase en memoria. La corre test/costos-material-api.test.js con --experimental-test-module-mocks.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import JSZip from 'jszip';
import { supabaseMemoria } from '../helpers/supabase-memoria.js';

const sb = supabaseMemoria();
mock.module(new URL('../../src/ioarr/db.js', import.meta.url).href, { namedExports: { supabase: sb } });
const { default: selectorRouter } = await import('../../src/selector-ioarr/router.js');
const { MARCA_INTERNA } = await import('../../src/selector-ioarr/oferta.js');

const PID = '11111111-2222-3333-4444-555555555555', RADAR = '77777777-2222-3333-4444-555555555555';
const ref = (id, unidad, material, monto, incluye_igv) => ({ id: `c0a7a10e-1111-4000-8000-00000000000${id}`, tipo_documento: 'bases', cui: null, entidad: 'Gobierno Regional X', region: 'X', anio: 2026,
  nivel: 'Primaria', unidad, material, monto, monto_hasta: null, incluye_igv, cotizaciones: null, composicion: [], confianza: 'media', notas: null });
Object.assign(sb.tablas, {
  ioarr_selector_proyectos: [{ id: PID, usuario_id: 'u1', nombre: 'Prueba materiales', region: 'Moquegua', anio_datos: 2025, criterios: { muebles: ['mesa', 'silla', 'arm'] }, ioarr_proyecto_id: RADAR, actualizado_en: '2026-10-25' }],
  ioarr_selector_locales: ['398477', '397642', '398316'].map(c => ({ proyecto_id: PID, codigo_local: c })),
  ioarr_proyectos: [{ id: RADAR, cui: '2700001', nombre: 'IOARR de Radar', entidad: 'Gobierno Regional de Moquegua' }],
  ioarr_uit: [{ anio: 2026, valor: 5500 }],
  // Precios antiguos (sin material): no deben usarse con material
  ioarr_expediente_costos: [{ proyecto_id: PID, anio_uit: 2026, estructura: { kit: true, cc_aplica: 'no', precios: { mesa: 999, silla: 999, arm: 999 }, transporte_pieza: 10 } }],
  ioarr_expediente_documentos: [{ proyecto_id: PID, datos: { uf: 'UF de Moquegua', por_nivel: { P: { nombre_inversion: 'ADQUISICIÓN DE MOBILIARIO DE AULA PRIMARIA MOQUEGUA', cui: '2700001' } } } }],
  // Catálogo referencial: mesa de madera 236 con IGV (200 sin IGV) y silla de madera 100 sin IGV
  ioarr_precios_ref: [ref(1, 'mesa', 'madera', 236, true), ref(2, 'silla', 'madera', 100, false)]
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
  if (binario && r.ok) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  return { status: r.status, json: await r.json() };
};
const textoDocx = async buf => (await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
const costos = (body, nivel = 'P') => pedir(body ? 'PATCH' : 'GET', `/proyectos/${PID}/costos?nivel=${nivel}`, body ? { estructura: body } : undefined);

let legado;
test('sin material: precios antiguos; el comparativo ya muestra los tres materiales', async () => {
  const r = await costos();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  legado = r.json;
  assert.equal(legado.propuesta.material, null);
  assert.deepEqual(legado.propuesta.muebles_criterio, ['mesa', 'silla', 'arm']);
  assert.deepEqual(legado.propuesta.por_material.map(y => y.material), ['madera', 'metal-madera', 'metal-polipropileno']);
  const mad = legado.propuesta.por_material[0];
  assert.equal(mad.precios.mesa.precio, 200, 'catálogo: 236 con IGV → 200 sin IGV');
  assert.equal(mad.precios.mesa.origen, 'catalogo_ref');
  assert.equal(mad.completo, false, 'falta el armario de madera');
  assert.ok(legado.propuesta.cuadra);
  assert.ok(legado.partidas.find(p => p.k === 'arm').pu === 999, 'sin material siguen los precios de antes');
});

test('elegir un material sin todos sus precios no se guarda; con los precios, sí, y no usa los antiguos', async () => {
  const no = await costos({ material_propuesta: 'madera' });
  assert.equal(no.status, 400);
  assert.match(no.json.error, /Armario.*\(Madera\): sin precio/);
  assert.equal((await costos({ precios_material: { madera: { arm: 600 } } })).status, 200, 'los precios se guardan aunque la propuesta no tenga material');
  const si = await costos({ material_propuesta: 'madera' });
  assert.equal(si.status, 200, JSON.stringify(si.json));
  const P = si.json.propuesta;
  assert.equal(P.material, 'madera');
  assert.deepEqual([P.precios.mesa.precio, P.precios.mesa.origen, P.precios.arm.precio, P.precios.arm.origen], [200, 'catalogo_ref', 600, 'manual']);
  assert.deepEqual(P.precios.mesa.antiguo, { precio: 999, origen: 'editado' }, 'el antiguo se muestra, no se usa');
  assert.equal(si.json.partidas.find(p => p.k === 'arm').pu, 600);
  assert.ok(si.json.totales.total < legado.totales.total);
  const mad = P.por_material[0];
  assert.ok(mad.completo);
  assert.equal(mad.kit_sin_igv, 300, 'kit = mesa 200 + silla 100');
  assert.equal(mad.total, si.json.totales.total, 'el comparativo de madera es el total de la propuesta');
  assert.equal(mad.dif_pct, 0);
  assert.ok(P.cuadra);
  // Cambiar de material: el precio cambia
  await costos({ precios_material: { 'metal-madera': { mesa: 260, silla: 130, arm: 800 } } });
  const mm = await costos({ material_propuesta: 'metal-madera' });
  assert.equal(mm.status, 200);
  assert.equal(mm.json.partidas.find(p => p.k === 'arm').pu, 800);
  assert.ok(mm.json.totales.total > si.json.totales.total);
  assert.ok(mm.json.propuesta.por_material[1].dif_pct > 0, 'diferencia frente al más económico (madera)');
  // Borrar un precio de un mueble incluido deja la propuesta sin precio: no se guarda
  const borra = await costos({ precios_material: { 'metal-madera': { arm: null } } });
  assert.equal(borra.status, 400);
  await costos({ material_propuesta: 'madera' });
});

test('desmarcar un mueble: no suma, no tiene cantidades y se ve aparte; sin muebles no se guarda; kit incompleto avisa', async () => {
  const antes = (await costos()).json;
  const r = await costos({ incluir: { arm: false } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.totales.total < antes.totales.total);
  assert.ok(r.json.partidas.find(p => p.k === 'arm').excluido, 'el armario no tiene cantidades en la propuesta');
  const ex = r.json.propuesta.excluidos.find(x => x.k === 'arm');
  assert.ok(ex && ex.rep > 0 && Math.abs(ex.parcial - ex.rep * 600) < 0.01, 'monto excluido (en gris)');
  assert.equal(r.json.propuesta.incluir.arm, false);
  // Todos fuera: no se guarda
  const todos = await costos({ incluir: { mesa: false, silla: false, arm: false } });
  assert.equal(todos.status, 400);
  assert.match(todos.json.error, /al menos un mueble/);
  // Sin la silla, el kit queda incompleto
  const k = await costos({ incluir: { silla: false } });
  assert.equal(k.status, 200);
  assert.ok(k.json.avisos.some(a => a.tipo === 'kit' && /kit queda incompleto/.test(a.texto)));
  assert.equal(k.json.estructura.kit, false, 'sin silla no hay kit');
  await costos({ incluir: { silla: true } });
});

test('la selección y el material llegan a Bases OxI y al documento equivalente; la oferta no se filtra', async () => {
  // Oferta (uso interno): ve el material y lo excluido
  const o = await pedir('GET', `/proyectos/${PID}/oferta`);
  assert.equal(o.status, 200, JSON.stringify(o.json));
  assert.deepEqual(o.json.material, { k: 'madera', nombre: 'Madera' });
  assert.deepEqual(o.json.muebles_excluidos, ['Armario / estante']);
  // Bases: sin armario en las cantidades, kit de madera, y el material en la hoja de transparencia
  const b = await pedir('POST', `/proyectos/${PID}/bases`, { nivel: 'P' });
  assert.equal(b.status, 201, JSON.stringify(b.json));
  assert.ok(!b.json.cantidades.filas.some(f => f.k === 'arm'), 'el armario excluido no aparece');
  const kit = b.json.cantidades.filas.find(f => f.k === 'kit');
  assert.ok(kit, 'kit en el Anexo 3-A');
  const v = await pedir('GET', `/bases/${b.json.ficha.id}/vista-previa`, null, { binario: true });
  const t = await textoDocx(v.buf);
  assert.match(t, /Material del mobiliario considerado en los costos\nMadera/);
  assert.doesNotMatch(t, new RegExp(MARCA_INTERNA), 'nada de la oferta en las bases');
  assert.doesNotMatch(t, /Armario/);
  // Catálogo: la referencia de las bases es del material de la propuesta
  const pr = await pedir('GET', `/proyectos/${PID}/precios-ref`);
  assert.equal(pr.json.seleccion.material, 'madera');
  // Documento equivalente: el material en el presupuesto
  const de = await pedir('POST', `/proyectos/${PID}/documento-equivalente`, { nivel: 'P' });
  assert.equal(de.status, 201, JSON.stringify(de.json));
  assert.ok(!de.json.app.metas.some(m => m.k === 'arm'));
  const dv = await textoDocx((await pedir('GET', `/documento-equivalente/${de.json.ficha.id}/vista-previa`, null, { binario: true })).buf);
  assert.match(dv, /Material del mobiliario: Madera/);
  assert.doesNotMatch(dv, new RegExp(MARCA_INTERNA));
});

test('duplicar el proyecto copia el material, la selección y los precios por material', async () => {
  const d = await pedir('POST', `/proyectos/${PID}/duplicar`, { nombre: 'Copia materiales' });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  // (el Supabase en memoria no genera UUID: se revisa la fila copiada)
  const fila = sb.tablas.ioarr_expediente_costos.find(f => f.proyecto_id === d.json.id);
  assert.ok(fila, 'la copia tiene su estructura de costos');
  assert.equal(fila.estructura.material_propuesta, 'madera');
  assert.equal(fila.estructura.incluir.arm, false);
  assert.equal(fila.estructura.precios_material['metal-madera'].mesa, 260);
  assert.equal(fila.anio_uit, 2026);
});
