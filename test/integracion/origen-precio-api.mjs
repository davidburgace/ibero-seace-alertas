// Prueba de punta a punta del origen del precio (catálogo o cotizaciones) y del 07-C definitivo, con
// 3 colegios reales de Moquegua y un Supabase en memoria. La corre test/origen-precio-api.test.js
// con --experimental-test-module-mocks.
//   - Con el catálogo, el 07-C es una «estimación preliminar»: el definitivo queda bloqueado (422).
//   - Con cotizaciones: menos de 3 vigentes por ítem bloquea, salvo justificación escrita; con 3, se exporta.
//   - El precio del kit pasa a ser el promedio sin IGV de las cotizaciones vigentes del legajo.
//   - La hoja de transparencia de las bases dice las fuentes del precio, sin nombres de proveedores.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import JSZip from 'jszip';
import { supabaseMemoria } from '../helpers/supabase-memoria.js';

const sb = supabaseMemoria();
mock.module(new URL('../../src/ioarr/db.js', import.meta.url).href, { namedExports: { supabase: sb } });
const { default: selectorRouter } = await import('../../src/selector-ioarr/router.js');
const { DECLARACION_COTIZACIONES } = await import('../../src/selector-ioarr/bases.js');
const { TEXTO_PRELIMINAR } = await import('../../src/selector-ioarr/origen-precio.js');

const PID = '11111111-2222-3333-4444-555555555555', FID = '99999999-2222-3333-4444-555555555555';
const COLEGIOS = ['398477', '397642', '398316'];
const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const CHECK = { registrado: 'si', contabilidad: 'si', baja: 'si', doc_tipo: 'resolucion', doc_numero: 'RD 010-2026', doc_fecha: '2026-09-30' };
const cot = (n, kit, o = {}) => ({ id: `aaaaaaaa-0000-4000-8000-00000000000${n}`, proveedor: `Proveedor ${n}`, fecha: hoy, vigencia_dias: 30, incluye_igv: true, plazo_entrega_dias: 30, precios: { kit }, ...o });
Object.assign(sb.tablas, {
  ioarr_selector_proyectos: [{ id: PID, usuario_id: 'u1', nombre: 'Prueba origen', region: 'Moquegua', anio_datos: 2025, criterios: { muebles: ['mesa', 'silla'] }, ioarr_proyecto_id: null, actualizado_en: '2026-10-25' }],
  ioarr_selector_locales: COLEGIOS.map(c => ({ proyecto_id: PID, codigo_local: c })),
  ioarr_uit: [{ anio: 2026, valor: 5500 }],
  ioarr_expediente_costos: [{ proyecto_id: PID, anio_uit: 2026, estructura: { kit: true, cc_aplica: 'no', transporte_pieza: 10, material_propuesta: 'madera', precios_material: { madera: { kit: 600 } } } }],
  ioarr_expediente_documentos: [{ proyecto_id: PID, datos: { uf: 'UF de Moquegua' } }],
  ioarr_precios_ref: [],
  // Legajo de Primaria: 2 cotizaciones vigentes (590 y 708 con IGV → 500 y 600 sin IGV) y una vencida
  ioarr_de_fichas: [{ id: FID, proyecto_id: PID, nivel: 'P', nombre: 'DE Primaria', actualizado_en: '2026-10-25', datos: {
    cotizaciones: [cot(1, 590), cot(2, 708), cot(3, 944, { fecha: '2025-01-01' })] } }]
});

const app = express();
app.use(express.json());
app.use((req, _, next) => { req.usuario = { id: 'u1', email: 'f@ejemplo.invalid' }; next(); });
app.use(selectorRouter);
app.use((e, _req, res, _next) => { res.status(e.status || 500).json({ error: e.message, stack: e.stack }); });
const srv = await new Promise(ok => { const s = app.listen(0, () => ok(s)); });
after(() => srv.close());
const API = `http://127.0.0.1:${srv.address().port}/api/selector-ioarr`;
const pedir = async (metodo, ruta, body, { binario } = {}) => {
  const r = await fetch(API + ruta, { method: metodo, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (binario && r.ok) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), nombre: decodeURIComponent((r.headers.get('content-disposition').match(/filename\*=UTF-8''([^;]+)/) || [])[1] || '') };
  return { status: r.status, json: await r.json() };
};
const docx = async buf => (await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
const costos = body => pedir(body ? 'PATCH' : 'GET', `/proyectos/${PID}/costos?nivel=P`, body ? { estructura: body } : undefined);
const f07c = q => pedir('GET', `/proyectos/${PID}/documentos/formato-07c?nivel=P${q ? '&' + q : ''}`, null, { binario: true });
const legajo = datos => { const f = sb.tablas.ioarr_de_fichas.find(x => x.id === FID); f.datos = { ...f.datos, ...datos }; };

test('con el catálogo: estimación preliminar y el 07-C definitivo bloqueado', async () => {
  for (const c of COLEGIOS) assert.equal((await pedir('PUT', `/proyectos/${PID}/colegios/${c}`, { datos: { uso: 'operativo', inventario: CHECK } })).status, 200);
  const r = await costos();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.origen_precio.origen, 'catalogo');
  assert.equal(r.json.origen_precio.estado.preliminar, true);
  assert.ok(r.json.avisos.some(a => a.tipo === 'origen_precio' && /Estimación preliminar/.test(a.texto)));
  assert.equal(r.json.lineasKit[0].pu, 600, 'el kit escrito para madera');
  const d = await f07c('definitivo=1');
  assert.equal(d.status, 422);
  assert.match(d.json.error, /estimación preliminar/);
  // El borrador sí sale, con la etiqueta
  const b = await f07c();
  assert.equal(b.status, 200);
  assert.match(b.nombre, /^Formato_07C_borrador_/);
  assert.ok((await docx(b.buf)).includes(TEXTO_PRELIMINAR));
});

test('con cotizaciones: el kit es el promedio sin IGV de las vigentes; menos de 3 bloquea el definitivo', async () => {
  const r = await costos({ origen_precio: 'cotizaciones' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // (590 + 708) / 1.18 / 2 = 550; la vencida (944) no entra
  assert.equal(r.json.lineasKit[0].pu, 550);
  const E = r.json.origen_precio.estado;
  assert.deepEqual(E.items.map(x => [x.k, x.proveedores, x.promedio, x.ok]), [['kit', 2, 550, false]]);
  assert.equal(E.preliminar, false);
  assert.equal(E.definitivo, false);
  const d = await f07c('definitivo=1');
  assert.equal(d.status, 422);
  assert.match(d.json.error, /2 cotizaciones vigentes.*se piden 3 o una justificación/);
  assert.equal((await f07c('definitivo=1&borrador=1')).status, 400, 'el definitivo no puede ser borrador');
});

test('con justificación escrita (o con 3 vigentes) se exporta el 07-C definitivo', async () => {
  legajo({ justificaciones: { kit: 'Solo corto' } });
  assert.equal((await f07c('definitivo=1')).status, 422, 'la justificación debe tener al menos 30 caracteres');
  legajo({ justificaciones: { kit: 'En la región solo dos proveedores fabrican el kit con las especificaciones de la norma.' } });
  const ok = await f07c('definitivo=1');
  assert.equal(ok.status, 200);
  assert.match(ok.nombre, /^Formato_07C_definitivo_/);
  const t = await docx(ok.buf);
  assert.ok(!t.includes(TEXTO_PRELIMINAR));
  assert.match(t, /promedio sin IGV de las cotizaciones vigentes \(kit de mobiliario \(mesa \+ silla del estudiante\): 2\)/i);
  // Sin justificación, pero con 3 vigentes: también
  legajo({ justificaciones: {}, cotizaciones: [cot(1, 590), cot(2, 708), cot(3, 649)] });
  assert.equal((await f07c('definitivo=1')).status, 200);
  assert.equal((await costos()).json.lineasKit[0].pu, 550, '(500 + 600 + 550) / 3');
});

test('hoja de transparencia de las bases: fuentes del precio y la declaración, sin nombres de proveedores', async () => {
  const b = await pedir('POST', `/proyectos/${PID}/bases`, { nivel: 'P' });
  assert.equal(b.status, 201, JSON.stringify(b.json));
  const t = await docx((await pedir('GET', `/bases/${b.json.ficha.id}/vista-previa`, null, { binario: true })).buf);
  assert.match(t, /Fuentes del precio/);
  assert.ok(t.includes(DECLARACION_COTIZACIONES));
  assert.match(t, /promedio sin IGV de las cotizaciones vigentes del legajo/);
  assert.match(t, /3 proveedores con cotización vigente/);
  assert.doesNotMatch(t, /Proveedor 1/);
});

test('duplicar el proyecto copia la referencia elegida en «Precios referenciales»', async () => {
  sb.tablas.ioarr_precios_ref_proyecto = [{ proyecto_id: PID, modo: 'mediana', registro_id: null, material: 'madera', incluir_atipicos: true, comparar_anio_base: false, anio_base: 2025 }];
  const d = await pedir('POST', `/proyectos/${PID}/duplicar`, { nombre: 'Copia origen' });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  const copia = sb.tablas.ioarr_precios_ref_proyecto.find(f => f.proyecto_id === d.json.id);
  assert.deepEqual([copia?.modo, copia?.material, copia?.incluir_atipicos, copia?.comparar_anio_base], ['mediana', 'madera', true, false]);
  assert.equal(sb.tablas.ioarr_expediente_costos.find(f => f.proyecto_id === d.json.id).estructura.origen_precio, 'cotizaciones');
});
