// Precios por material, muebles de la propuesta y kit por material (Costos), y lo del catálogo que los alimenta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prep, calc, filtrar, FILTRO_VACIO, DEF, limpiarParams } from '../src/selector-ioarr/calculo.js';
import {
  costear, limpiarEstructura, preciosPropuesta, preciosDeMaterial, validarPropuesta, tiposPropuesta, materialDe, tienePrecio, cuadraTotales, MATERIALES, CLAVES_PRECIO
} from '../src/selector-ioarr/costos.js';
import { calcularPaquete } from '../src/selector-ioarr/paquete.js';
import { quitarMuebles, mueblesCriterio } from '../src/selector-ioarr/expediente.js';
import { normalizar, estadisticos, preciosUnitarios, validarCsv, plantillaCsv, sinIgv, conIgv, PRECARGA, COMPONENTES } from '../src/selector-ioarr/catalogo-ref.js';
import { descuadre } from '../src/selector-ioarr/montos.js';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const moquegua = () => prep(JSON.parse(readFileSync(new URL('moquegua.json', DIR), 'utf8')));
const UIT = { anio: 2026, valor: 1000 };
const reg = o => ({ id: o.id || 'r' + Math.random(), tipo_documento: 'bases', entidad: 'Gobierno Regional X', region: 'X', anio: 2026, nivel: 'Primaria', composicion: [], monto_hasta: null, confianza: 'media', ...o });

// ─── Catálogo: IGV, normalización, estadísticos y CSV ───────────────────────
test('conversión con y sin IGV (18 %); con IGV por confirmar no se calcula y se avisa', () => {
  assert.equal(sinIgv(118), 100);
  assert.equal(conIgv(100), 118);
  assert.equal(normalizar(reg({ unidad: 'kit', material: 'madera', monto: 708, incluye_igv: true })).precio_kit_sin_igv, 600);
  assert.equal(normalizar(reg({ unidad: 'kit', material: 'madera', monto: 600, incluye_igv: false })).precio_kit_sin_igv, 600);
  const pc = normalizar(reg({ unidad: 'kit', material: 'madera', monto: 600, incluye_igv: null }));
  assert.equal(pc.precio_sin_igv, null);
  assert.equal(pc.comparable, false);
  assert.match(pc.motivo, /IGV/);
});

test('normalización a kit: kit directo; mesa con composición se convierte; sin composición, «no comparable»', () => {
  assert.equal(normalizar(reg({ unidad: 'kit', material: 'madera', monto: 500, incluye_igv: false })).precio_kit_sin_igv, 500);
  const mesa = normalizar(reg({ unidad: 'mesa', material: 'madera', monto: 300, incluye_igv: false, composicion: [{ unidad: 'mesa', cantidad: 1 }, { unidad: 'silla', cantidad: 1, precio: 150 }] }));
  assert.deepEqual([mesa.comparable, mesa.precio_kit_sin_igv], [true, 450]);
  const suelta = normalizar(reg({ unidad: 'armario', material: 'madera', monto: 900, incluye_igv: false }));
  assert.equal(suelta.comparable, false);
  assert.match(suelta.motivo, /composición/);
});

test('estadísticos por material y nivel sin el precio propio', () => {
  const rs = [reg({ unidad: 'kit', material: 'madera', monto: 400, incluye_igv: false }), reg({ unidad: 'kit', material: 'madera', monto: 600, incluye_igv: false }),
    reg({ unidad: 'kit', material: 'madera', monto: 9999, incluye_igv: false, tipo_documento: 'propio' })];
  const E = estadisticos(rs);
  assert.deepEqual(E.map(g => [g.material, g.nivel, g.n, g.min, g.mediana, g.max, g.pocas]), [['madera', 'Primaria', 2, 400, 500, 600, true]]);
  // La precarga: el propio (850) no entra
  assert.ok(!estadisticos(PRECARGA).some(g => g.max === 850));
});

test('importación CSV: el CSV del pedido (otras columnas) y filas con errores no importan nada; reporte por fila', () => {
  const delPedido = 'fuente,cui,entidad,region,anio,nivel,unidad,material,precio,incluye_igv,confianza,tipo,notas\nLoreto 2026,,Gobierno Regional Loreto,Loreto,2026,,kit,madera,624.00,false,alta,publicado,Precio por kit sin IGV';
  const r1 = validarCsv(delPedido);
  assert.equal(r1.ok, false);
  assert.match(r1.errores[0].errores[0], /Faltan columnas: tipo_documento, monto/);
  const cab = plantillaCsv().replace(/^\uFEFF/, '').split('\n')[0];   // la plantilla lleva BOM para Excel
  const cols = cab.split(',');
  const fila = o => cols.map(c => o[c] ?? '').join(',');
  const base = { tipo_documento: 'bases', region: 'Loreto', anio: '2026', nivel: 'Primaria', unidad: 'kit', material: 'madera', monto: '624', incluye_igv: 'no', confianza: 'alta' };
  const csv = [cab, fila(base), fila({ ...base, unidad: 'set', monto: '467.5' }), fila({ ...base, material: 'plastico', anio: '2026' })].join('\n');
  const r2 = validarCsv(csv);
  assert.equal(r2.ok, false, 'con una fila con errores no se importa nada');
  assert.deepEqual(r2.errores.map(e => e.fila), [3, 4]);
  assert.match(r2.errores[0].errores.join(' '), /unidad no válido: «set»/);
  assert.match(r2.errores[1].errores.join(' '), /material no válido/);
});

test('precio unitario por material (para Costos): mediana sin IGV de mesa, silla y armario; sin el propio ni IGV por confirmar', () => {
  const rs = [reg({ unidad: 'mesa', material: 'madera', monto: 236, incluye_igv: true }), reg({ unidad: 'mesa', material: 'madera', monto: 220, incluye_igv: false }),
    reg({ unidad: 'silla', material: 'madera', monto: 100, incluye_igv: null }), reg({ unidad: 'armario', material: 'metal-madera', monto: 700, incluye_igv: false }),
    reg({ unidad: 'mesa', material: 'madera', monto: 1, incluye_igv: false, tipo_documento: 'propio' })];
  const U = preciosUnitarios(rs);
  assert.deepEqual(U.madera.mesa.precio, 210, 'mediana de 200 (236 ÷ 1,18) y 220');
  assert.equal(U.madera.mesa.n, 2);
  assert.ok(!U.madera.silla, 'IGV por confirmar: no se usa');
  assert.equal(U['metal-madera'].arm.precio, 700);
  assert.deepEqual(Object.keys(U).sort(), Object.keys(MATERIALES).sort());
});

test('San Juan: mobiliario 739,373.42 + expediente técnico 43,144.10 + supervisión 137,397.87 = 919,915.39', () => {
  const SJ = PRECARGA.find(r => r.cui === '2711098').componentes;
  assert.equal(Math.round((SJ.sup_doc_equivalente + SJ.sup_ejecucion) * 100) / 100, 137397.87);
  assert.equal(Math.round((SJ.ejecucion + SJ.doc_equivalente + SJ.sup_doc_equivalente + SJ.sup_ejecucion) * 100) / 100, 919915.39);
  const partes = Object.fromEntries(Object.keys(COMPONENTES).map(k => [k, SJ[k]]));
  assert.equal(descuadre(partes, SJ.total), null, 'los componentes suman el total declarado');
  assert.ok(descuadre(partes, 919915.40), 'un céntimo de diferencia se detecta');
});

// ─── Material y precios en Costos ───────────────────────────────────────────
const CAT = { madera: { mesa: { precio: 200, n: 1, fuente: 'Fuente A' } }, 'metal-madera': {}, 'metal-polipropileno': {} };
test('precios por material: manual → catálogo → sin precio; los antiguos solo se muestran', () => {
  const E = limpiarEstructura({ material_propuesta: 'madera', precios_material: { madera: { silla: 90 }, 'metal-madera': { mesa: 250, silla: 120 } } });
  const P = preciosPropuesta(E, CAT, { mesa: { precio: 999, origen: 'referencia' } });
  assert.deepEqual([P.mesa.precio, P.mesa.origen, P.mesa.fuente], [200, 'catalogo_ref', 'Fuente A']);
  assert.deepEqual([P.silla.precio, P.silla.origen], [90, 'manual']);
  assert.deepEqual([P.arm.precio, P.arm.origen], [null, null], 'sin precio de referencia');
  assert.deepEqual(P.mesa.antiguo, { precio: 999, origen: 'referencia' });
  // Cambiar el material cambia el precio
  const P2 = preciosPropuesta({ ...E, material_propuesta: 'metal-madera' }, CAT);
  assert.deepEqual([P2.mesa.precio, P2.silla.precio], [250, 120]);
  // Material propio de un tipo
  const P3 = preciosPropuesta({ ...E, materiales: { silla: 'metal-madera' } }, CAT);
  assert.deepEqual([P3.mesa.precio, P3.silla.precio, materialDe({ ...E, materiales: { silla: 'metal-madera' } }, 'silla')], [200, 120, 'metal-madera']);
  // Las tallas no toman el catálogo (solo el tipo): usan el general en costear
  assert.equal(preciosDeMaterial(E, 'madera', CAT).mesa_p12.precio, null);
});

test('cambio de material cambia el costo; desmarcar un mueble lo saca del costo, del kit y de las cantidades', () => {
  const D = moquegua(), list0 = P => filtrar(D, calc(D, P), { ...FILTRO_VACIO(), q: 'mariscal' });
  const Pc = limpiarParams({ muebles: ['mesa', 'silla', 'arm'] });
  const precios = m => Object.fromEntries(CLAVES_PRECIO.map(k => [k, preciosDeMaterial(limpiarEstructura({ precios_material: {
    madera: { mesa: 200, silla: 100, arm: 600 }, 'metal-madera': { mesa: 260, silla: 130, arm: 800 } } }), m, {})[k].precio]));
  const correr = (P, m) => costear({ D, C: calc(D, P), list: list0(Pc), precios: precios(m), estructura: {}, uit: UIT });
  const Rm = correr(Pc, 'madera'), Rmm = correr(Pc, 'metal-madera');
  assert.ok(Rmm.totales.total > Rm.totales.total, 'metal/madera es más caro con estos precios');
  assert.ok(cuadraTotales(Rm.totales) && cuadraTotales(Rmm.totales), 'los componentes suman el total');
  // Sin el armario: menos costo y el armario ya no tiene cantidades
  const sinArm = correr(quitarMuebles(Pc, ['arm']), 'madera');
  const armAntes = Rm.partidas.find(p => p.k === 'arm');
  assert.ok(armAntes.rep > 0);
  assert.ok(sinArm.totales.total < Rm.totales.total);
  assert.equal(Math.round(Rm.totales.bienes - sinArm.totales.bienes), Math.round(armAntes.parcial), 'baja exactamente lo del armario');
  assert.ok(sinArm.partidas.find(p => p.k === 'arm').excluido);
  assert.deepEqual(mueblesCriterio(quitarMuebles(Pc, ['arm'])), ['mesa', 'silla']);
});

test('validación de la propuesta: al menos un mueble; cada incluido con material y precio; kit del mismo material', () => {
  const base = { material_propuesta: 'madera', precios_material: { madera: { mesa: 200, silla: 100, arm: 600 } } };
  const muebles = ['mesa', 'silla', 'arm'], niveles = ['P'];
  assert.deepEqual(validarPropuesta(limpiarEstructura(base), { muebles, niveles }), []);
  assert.match(validarPropuesta(limpiarEstructura({ ...base, incluir: { mesa: false, silla: false, arm: false } }), { muebles, niveles })[0], /al menos un mueble/);
  assert.match(validarPropuesta(limpiarEstructura({ ...base, material_propuesta: 'metal-madera' }), { muebles, niveles }).join(' '), /Mesa del estudiante \(Metal\/Madera\): sin precio/);
  // Excluir el que no tiene precio la deja válida
  assert.deepEqual(validarPropuesta(limpiarEstructura({ ...base, precios_material: { madera: { mesa: 200, silla: 100 } }, incluir: { arm: false } }), { muebles, niveles }), []);
  // Mesa por tallas: vale si todas las tallas del nivel tienen precio
  const tallas = { mesa_p12: 1, mesa_p34: 1, mesa_p56: 1, silla: 100, arm: 600 };
  assert.ok(tienePrecio(preciosPropuesta(limpiarEstructura({ material_propuesta: 'madera', precios_material: { madera: tallas } })), 'mesa', ['P']));
  assert.ok(!tienePrecio(preciosPropuesta(limpiarEstructura({ material_propuesta: 'madera', precios_material: { madera: tallas } })), 'mesa', ['P', 'S']));
  // Kit: mesa y silla del mismo material
  const E = limpiarEstructura({ ...base, kit: true, materiales: { silla: 'metal-madera' }, precios_material: { ...base.precios_material, 'metal-madera': { silla: 130 } } });
  assert.ok(validarPropuesta(E, { muebles, niveles }).some(t => /mismo material/.test(t)));
  // Sin material (precios antiguos) no se valida por material
  assert.deepEqual(validarPropuesta(limpiarEstructura({}), { muebles, niveles }), []);
  assert.deepEqual(tiposPropuesta(limpiarEstructura({ incluir: { esc: false } }), ['mesa', 'esc']), ['mesa']);
});

test('kit para los tres materiales: mismo kit (mesa + silla), precios distintos; sin precio completo no se calcula', () => {
  const D = moquegua(), P = limpiarParams({ muebles: ['mesa', 'silla'] });
  const C = calc(D, P), list = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
  const codigos = list.map(i => D.locs[i][0]);
  const E = limpiarEstructura({ kit: true, precios_material: { madera: { mesa: 200, silla: 100 }, 'metal-madera': { mesa: 260, silla: 130 }, 'metal-polipropileno': { mesa: 300 } } });
  const preciosMaterial = Object.fromEntries(Object.keys(MATERIALES).map(m => [m, Object.fromEntries(Object.entries(preciosDeMaterial(E, m, {})).map(([k, x]) => [k, x.precio]))]));
  const K = calcularPaquete({ D, P, codigos, comun: { precios: preciosMaterial.madera, estructura: E, uit: UIT }, propuesta: { Pcompleto: P, excluidos: [], preciosMaterial } });
  const x = K.ioarrs.find(y => y.nivel === 'P') || K.ioarrs[0];
  assert.deepEqual(Object.keys(x.porMaterial).sort(), Object.keys(MATERIALES).sort());
  assert.ok(x.porMaterial.madera.kits > 0);
  assert.equal(x.porMaterial.madera.kits, x.porMaterial['metal-madera'].kits, 'la misma composición en los dos');
  assert.equal(x.porMaterial.madera.kit_sin_igv, 300, 'mesa 200 + silla 100');
  assert.equal(x.porMaterial['metal-madera'].kit_sin_igv, 390);
  assert.equal(x.porMaterial.madera.kit_con_igv, 354);
  assert.ok(x.porMaterial['metal-madera'].total > x.porMaterial.madera.total);
  // Metal/Polipropileno sin precio de silla: el kit no se completa con otro material
  assert.ok(!tienePrecio(preciosDeMaterial(E, 'metal-polipropileno', {}), 'silla', ['P']));
  // El total de la IOARR con madera es el mismo que el cálculo normal con los precios de madera
  assert.equal(x.porMaterial.madera.total, x.R.totales.total);
});

test('kit por nivel: se puede apagar en un nivel (los demás siguen con kit)', () => {
  const D = moquegua(), P = limpiarParams({ muebles: ['mesa', 'silla'] });
  const list = filtrar(D, calc(D, P), { ...FILTRO_VACIO(), q: 'mariscal' }), codigos = list.map(i => D.locs[i][0]);
  const precios = { mesa: 200, silla: 100 };
  const con = calcularPaquete({ D, P, codigos, comun: { precios, estructura: limpiarEstructura({ kit: true }), uit: UIT } });
  const sinP = calcularPaquete({ D, P, codigos, comun: { precios, estructura: limpiarEstructura({ kit: true, kit_niveles: { P: false } }), uit: UIT } });
  const R = (K, n) => K.ioarrs.find(y => y.nivel === n)?.R;
  const enKit = R => (R.lineasKit || []).reduce((a, y) => a + y.parcial, 0);
  assert.ok(R(con, 'P').kit && enKit(R(con, 'P')) > 0);
  assert.equal(R(sinP, 'P').kit, false, 'Primaria sin kit');
  assert.equal(enKit(R(sinP, 'P')), 0, 'mesa y silla sueltas');
  if (R(con, 'S')) { assert.ok(R(sinP, 'S').kit, 'Secundaria sigue con kit'); assert.equal(enKit(R(sinP, 'S')), enKit(R(con, 'S'))); }
});
