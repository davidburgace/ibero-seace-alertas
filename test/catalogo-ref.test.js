// Catálogo de precios referenciales: IGV, normalización a kit, estadísticos sin el precio propio,
// estimación del convenio, riesgo, CSV con errores y precarga.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sinIgv, conIgv, limpiarRegistro, normalizar, estadisticos, mediana, posicion, referencia, estimarConvenio, riesgo,
  validarCsv, leerCsv, plantillaCsv, parsearComposicion, PRECARGA, COLUMNAS_CSV
} from '../src/selector-ioarr/catalogo-ref.js';
import { limpiarFicha, cuadroCantidades, validarFicha, transparencia, armarTexto } from '../src/selector-ioarr/bases.js';
import { generarBasesDocx } from '../src/selector-ioarr/word-bases.js';
import { FICHA_PRUEBA, CTX_PRUEBA } from './helpers/ficha-bases.js';
import JSZip from 'jszip';

const base = { tipo_documento: 'bases', region: 'Ejemplo', anio: 2026, nivel: 'Primaria', unidad: 'kit', material: 'metal-madera', monto: 600, incluye_igv: false, confianza: 'alta' };
const reg = (o = {}) => { const { r, errores } = limpiarRegistro({ ...base, ...o }); assert.deepEqual(errores, []); return { id: o.id || Math.random().toString(36), ...r }; };

// ─── IGV ────────────────────────────────────────────────────────────────────
test('IGV 18 %: con IGV se divide entre 1.18; sin IGV queda igual', () => {
  assert.equal(sinIgv(118), 100);
  assert.equal(sinIgv(267.5), 226.69);
  assert.equal(conIgv(850), 1003);
  assert.equal(normalizar(reg({ monto: 708, incluye_igv: true })).precio_kit_sin_igv, 600);
  assert.equal(normalizar(reg({ monto: 600, incluye_igv: false })).precio_kit_sin_igv, 600);
  const x = normalizar(reg({ incluye_igv: null }));
  assert.equal(x.comparable, false);
  assert.match(x.motivo, /IGV/);
  assert.deepEqual(limpiarRegistro({ ...base, incluye_igv: 'quizá' }).errores, ['«Incluye IGV» debe ser sí, no o vacío (por confirmar)']);
  assert.equal(limpiarRegistro({ ...base, incluye_igv: 'Sí' }).r.incluye_igv, true);
});

// ─── Normalización a kit ────────────────────────────────────────────────────
test('normalización a kit: otra unidad exige la composición; sin ella no es comparable', () => {
  const mesa = normalizar(reg({ unidad: 'mesa', monto: 300 }));
  assert.equal(mesa.comparable, false);
  assert.match(mesa.motivo, /falta la composición del kit/);
  // Mesa 300 + silla 150 (sin IGV)
  assert.equal(normalizar(reg({ unidad: 'mesa', monto: 300, composicion: 'mesa:1;silla:1:150' })).precio_kit_sin_igv, 450);
  // Con IGV: (354 + 177) / 1.18 = 450
  assert.equal(normalizar(reg({ unidad: 'mesa', monto: 354, incluye_igv: true, composicion: [{ unidad: 'mesa', cantidad: 1 }, { unidad: 'silla', cantidad: 1, precio: 177 }] })).precio_kit_sin_igv, 450);
  // Falta el precio de la otra pieza
  assert.match(normalizar(reg({ unidad: 'mesa', monto: 300, composicion: 'mesa:1;silla:1' })).motivo, /falta el precio de silla/);
  // La composición no incluye la unidad del registro
  assert.match(normalizar(reg({ unidad: 'silla', monto: 150, composicion: 'mesa:1:300' })).motivo, /no incluye la unidad/);
  // Pieza sin especificar: kit = 2 piezas
  assert.equal(normalizar(reg({ unidad: 'pieza', monto: 267.5, incluye_igv: true, composicion: 'pieza:2' })).precio_kit_sin_igv, 453.39);
  // Rango: punto medio
  assert.equal(normalizar(reg({ monto: 455, monto_hasta: 480 })).precio_kit_sin_igv, 467.5);
  // Kit con composición: error
  assert.ok(limpiarRegistro({ ...base, composicion: 'mesa:1' }).errores.some(e => /no hace falta la composición/.test(e)));
  assert.equal(parsearComposicion('mesa:x'), undefined);
});

test('validaciones del registro', () => {
  const { errores } = limpiarRegistro({ tipo_documento: 'otro', anio: 1990, nivel: 'Universidad', unidad: 'kit', material: 'metal-madera', monto: -1, confianza: 'alta', cui: 'abc', url: 'ftp://x', monto_hasta: 1 });
  for (const re of [/tipo de documento no válido/, /CUI/, /Falta la región/, /Año no válido/, /nivel no válido/, /Monto no válido/, /enlace/]) assert.ok(errores.some(e => re.test(e)), String(re));
  // El precio propio no necesita región
  assert.deepEqual(limpiarRegistro({ ...base, tipo_documento: 'propio', region: '' }).errores, []);
  // Cotizaciones: promedio calculado
  assert.deepEqual(limpiarRegistro({ ...base, cotizaciones_valores: '340;350;360' }).r.cotizaciones, { valores: [340, 350, 360], n: 3, promedio: 350 });
});

// ─── Estadísticos ───────────────────────────────────────────────────────────
test('estadísticos por material y nivel, sin el precio propio ni los no comparables', () => {
  const R = [reg({ monto: 500 }), reg({ monto: 600 }), reg({ monto: 700 }), reg({ monto: 800 }),
    reg({ tipo_documento: 'propio', monto: 2000 }), reg({ incluye_igv: null, monto: 10 }), reg({ material: 'metal-polipropileno', monto: 400 })];
  const E = estadisticos(R);
  const mm = E.find(g => g.material === 'metal-madera' && g.nivel === 'Primaria');
  assert.deepEqual([mm.n, mm.min, mm.mediana, mm.max, mm.pocas], [4, 500, 650, 800, false]);
  const mp = E.find(g => g.material === 'metal-polipropileno');
  assert.deepEqual([mp.n, mp.pocas], [1, true]);
  assert.equal(mediana([3, 1, 2]), 2);
  assert.equal(mediana([]), null);
  // Posición del propio
  const P = posicion(850, mm);
  assert.equal(P.dif_mediana_pct, 30.77);
  assert.equal(P.lugar, 'encima');
});

test('referencia: mediana del nivel (con los de nivel por confirmar), aviso con menos de 3 fuentes, nunca el propio', () => {
  const R = [reg({ id: 'a', monto: 500 }), reg({ id: 'b', monto: 700, nivel: 'por_confirmar' }), reg({ id: 'c', monto: 900, nivel: 'Secundaria' }), reg({ id: 'p', tipo_documento: 'propio', monto: 100 })];
  const r = referencia(R, { nivel: 'P', sel: { modo: 'mediana', material: 'todos' } });
  assert.deepEqual([r.precio, r.n, r.registros], [600, 2, ['a', 'b']]);
  assert.ok(r.avisos.some(a => /Solo 2 fuentes comparables/.test(a)));
  assert.ok(r.avisos.some(a => /nivel por confirmar/.test(a)));
  assert.equal(referencia(R, { nivel: 'P', sel: { modo: 'registro', registro_id: 'p' } }).precio, null);
  assert.equal(referencia(R, { nivel: 'P', sel: { modo: 'registro', registro_id: 'c' } }).precio, 900);
  assert.equal(referencia(R, { nivel: 'P', sel: { material: 'metal-polipropileno' } }).n, 0);
});

// ─── Precarga ───────────────────────────────────────────────────────────────
test('precarga: 5 registros, material por confirmar y confianza media; solo Loreto es comparable', () => {
  assert.equal(PRECARGA.length, 5);
  for (const r of PRECARGA) {
    assert.equal(r.material, 'por_confirmar'); assert.equal(r.confianza, 'media');
    assert.deepEqual(limpiarRegistro(r).errores, [], r.id);
  }
  const N = PRECARGA.map(r => ({ id: r.id, ...normalizar(r) }));
  assert.deepEqual(N.filter(x => x.comparable && !x.propio).map(x => x.precio_kit_sin_igv), [624]);
  assert.equal(N.find(x => x.propio).precio_kit_sin_igv, 850);
  assert.match(N[1].motivo, /composición/);   // Huánuco 2023: por mobiliario
  assert.match(N[2].motivo, /IGV/);           // Huánuco 2025: rango sin IGV declarado
  const E = estadisticos(PRECARGA);
  assert.deepEqual(E.map(g => [g.n, g.mediana, g.pocas]), [[1, 624, true]]);
  // La migración tiene los mismos ids y montos
  const sql = readFileSync(new URL('../supabase/migrations/029_ioarr_catalogo_precios_ref.sql', import.meta.url), 'utf8');
  for (const r of PRECARGA) assert.match(sql, new RegExp(`'${r.id}', '${r.tipo_documento}'[^\\n]*${r.monto.toFixed(2).replace('.', '\\.')}`));
});

// ─── Estimación y riesgo ────────────────────────────────────────────────────
const C = { T: { cd: 10000, liq: 1000, cc: 0, cdIgv: 11800, doc: 300, sup: 500, total: 13600 }, params: { igv: 18, doc_pct: 3, sup_pct: 5, liq_modo: 'monto', liq_pct: 1, cc_pct: null }, kitBienes: 8000, kits: 10 };
test('estimación del convenio con otro precio por kit, igual que la estructura de costos', () => {
  const e = estimarConvenio(C, 800);   // mismo precio: mismo resultado
  assert.deepEqual([e.cd, e.cdIgv, e.doc, e.sup, e.total, e.convenio], [10000, 11800, 300, 500, 13600, 12600]);
  const f = estimarConvenio(C, 600);   // cd = 10000 − 8000 + 6000
  assert.deepEqual([f.cd, f.cdIgv, f.doc, f.sup, f.convenio], [8000, 9440, 240, 400, 10080]);
  assert.equal(estimarConvenio({ ...C, kits: 0 }, 600), null);
});
test('riesgo: el precio propio fuera del 110 % del monto referencial', () => {
  const ref = estimarConvenio(C, 624), pro = estimarConvenio(C, 850);
  const r = riesgo(ref, pro);
  assert.equal(r.fuera, 'encima');
  assert.ok(r.pct > 110);
  assert.match(r.texto, /supera el 110 %/);
  assert.equal(riesgo(ref, estimarConvenio(C, 650)).fuera, null);
  assert.equal(riesgo(ref, estimarConvenio(C, 400)).fuera, 'debajo');
});

// ─── CSV ────────────────────────────────────────────────────────────────────
test('CSV: la plantilla se valida; con errores no se importa nada y se reporta por fila', () => {
  const p = validarCsv(plantillaCsv());
  assert.ok(p.ok, JSON.stringify(p.errores));
  assert.equal(p.registros.length, 2);
  assert.equal(normalizar(p.registros[1]).precio_kit_sin_igv, sinIgv(350 + 200));
  const csv = [COLUMNAS_CSV.join(','),
    'bases,2512345,GR Ejemplo,Ejemplo,2026,,Primaria,kit,metal-madera,600,,no,,,,,,alta,ok',
    'bases,,GR Ejemplo,Ejemplo,20x6,,Primaria,kit,madera,600,,no,,,,,,alta,mal',
    'bases,2512345,GR Ejemplo,Ejemplo,2026,,Primaria,kit,metal-madera,600,,no,,,,,,alta,duplicada',
    '"07-C",,"Entidad, con coma",Ejemplo,2025,,Inicial,mesa,metal-madera,300,,si,,,,"mesa:1;silla:1:150",,media,"nota con ""comillas"""'].join('\n');
  const v = validarCsv(csv);
  assert.equal(v.ok, false);
  assert.equal(v.total, 4);
  assert.deepEqual(v.errores.map(e => e.fila), [3, 4]);
  assert.ok(v.errores[0].errores.some(e => /Año/.test(e)) && v.errores[0].errores.some(e => /material no válido/.test(e)));
  assert.match(v.errores[1].errores[0], /Duplicado de la fila 2/);
  assert.equal(v.registros[1].entidad, 'Entidad, con coma');
  assert.equal(v.registros[1].notas, 'nota con "comillas"');
  // Duplicado de lo que ya está en el catálogo
  assert.match(validarCsv([COLUMNAS_CSV.join(','), 'bases,2512345,GR Ejemplo,Ejemplo,2026,,Primaria,kit,metal-madera,600,,no,,,,,,alta,x'].join('\n'), [v.registros[0]]).errores[0].errores[0], /Duplicado de un registro del catálogo/);
  // Faltan columnas
  assert.match(validarCsv('a,b\n1,2').errores[0].errores[0], /Faltan columnas/);
});
test('CSV con punto y coma y coma decimal (Excel en español)', () => {
  const t = [COLUMNAS_CSV.join(';'), 'bases;;GR;Ejemplo;2026;;Primaria;kit;metal-madera;1.234,50;;no;;;;;;alta;'].join('\r\n');
  assert.equal(leerCsv(t).sep, ';');
  const v = validarCsv(t);
  assert.ok(v.ok, JSON.stringify(v.errores));
  assert.equal(v.registros[0].monto, 1234.5);
});

// ─── Generador de bases ─────────────────────────────────────────────────────
test('bases: con «catálogo», el kit toma el precio de referencia y la hoja de transparencia dice su fuente sin nombres', async () => {
  const ref = { precio: 624, n: 3, modo: 'mediana', fuente: 'Mediana de 3 fuentes publicadas (Gobierno Regional de Loreto, 2026, …)', avisos: [] };
  const ctx = { ...CTX_PRUEBA, precio_ref: ref };
  const d = limpiarFicha({ ...FICHA_PRUEBA, precio_kit_origen: 'catalogo' });
  const Q = cuadroCantidades(d, ctx);
  const kit = Q.filas.find(f => f.k === 'kit');
  assert.deepEqual([kit.pu, kit.parcial, kit.catalogo], [736.32, 88358.4, true]);
  assert.equal(Q.filas.find(f => f.k === 'esc').pu, 700, 'los demás bienes, de la estructura de costos');
  // Por defecto, la estructura de costos
  assert.equal(limpiarFicha(FICHA_PRUEBA).precio_kit_origen, 'app');
  assert.equal(cuadroCantidades(limpiarFicha(FICHA_PRUEBA), ctx).filas[0].pu, 600);
  // Sin referencia comparable: bloquea
  assert.ok(validarFicha(d, { ...CTX_PRUEBA, precio_ref: { precio: null, avisos: [] } }).errores.some(e => e.k === 'precio_kit_origen'));
  // Avisos de la referencia → advertencias
  assert.ok(validarFicha(d, { ...ctx, precio_ref: { ...ref, avisos: ['Solo 2 fuentes comparables'] } }).advertencias.some(a => /Solo 2 fuentes/.test(a.texto)));
  const T = transparencia(d, ctx, armarTexto(d));
  const fila = T.app.find(x => x.campo === 'Precio por kit (Anexo 3-A)');
  assert.equal(fila.valor, 'S/ 624.00 sin IGV');
  assert.doesNotMatch(fila.fuente, /Loreto/);
  // En el Word no aparecen nombres de las fuentes ni el precio propio
  const buf = await generarBasesDocx({ datos: d, ctx, version: 1, fecha: '2026-10-25' });
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  assert.doesNotMatch(xml, /Loreto|850\.00|1,003\.00/);
  assert.match(xml, /catálogo de precios de IOARR publicadas/);
});
