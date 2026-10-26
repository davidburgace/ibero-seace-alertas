// Reglas nuevas del catálogo de precios referenciales (migración 037) y lo que llega a Costos:
// históricos y atípicos fuera de los estadísticos, factores de actualización (1.00 = «sin ajuste»),
// aviso de volumen y de nivel, Huicungo 2026 como referencia por defecto de Metal/Madera (también
// por grado en Costos), componentes con la supervisión en un solo monto, y el origen del precio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  limpiarRegistro, normalizar, enriquecer, estadisticos, referencia, preciosUnitarios, actualizar, avisoVolumen, sinIgv, PRECARGA, UMBRAL_ATIPICO
} from '../src/selector-ioarr/catalogo-ref.js';
import { limpiarFactor } from '../src/selector-ioarr/catalogo-ref-api.js';
import { preciosDeMaterial, limpiarEstructura, validarPropuesta } from '../src/selector-ioarr/costos.js';
import { preciosDeCotizaciones, estadoPrecio } from '../src/selector-ioarr/origen-precio.js';
import { fuentesPrecio, DECLARACION_COTIZACIONES, transparencia, limpiarFicha } from '../src/selector-ioarr/bases.js';

const base = { tipo_documento: 'bases', region: 'Ejemplo', anio: 2026, nivel: 'Primaria', unidad: 'kit', material: 'metal-madera', monto: 600, incluye_igv: false, confianza: 'alta' };
const reg = (o = {}) => { const { r, errores } = limpiarRegistro({ ...base, ...o }); assert.deepEqual(errores, [], JSON.stringify(o)); return { id: o.id || Math.random().toString(36), ...r }; };
const huicungoKit = PRECARGA.find(r => r.id.endsWith('00d'));

test('campos nuevos: fuente, grado, volumen, año del precio, estado y tipo; con valores por defecto', () => {
  const r = reg({ fuente: 'Huicungo 2026', grado: '1-2', unidad: 'mesa', volumen_kits: '455', anio_precio: '2025', estado: 'histórico' });
  assert.deepEqual([r.fuente, r.grado, r.volumen_kits, r.anio_precio, r.estado, r.tipo], ['Huicungo 2026', '1-2', 455, 2025, 'historico', 'publicado']);
  assert.deepEqual([reg().estado, reg().tipo, reg({ tipo_documento: 'estimado_derivado', componentes: { ejecucion: 1000, doc_equivalente: 0, sup_doc_equivalente: 0, sup_ejecucion: 0, total: 1000 }, derivacion: { divisor: 2 } }).tipo], ['vigente', 'publicado', 'derivado']);
  const mal = k => limpiarRegistro({ ...base, ...k }).errores.join(' ');
  assert.match(mal({ grado: '1-2', nivel: 'Inicial', unidad: 'mesa' }), /grado solo va con Primaria o Secundaria/);
  assert.match(mal({ grado: '1-2', unidad: 'armario' }), /grado solo va con mesa, silla/);
  assert.match(mal({ grado: '7-8' }), /grado no válido/);
  assert.match(mal({ volumen_kits: '0' }), /Volumen de kits no válido/);
  assert.match(mal({ estado: 'archivado' }), /estado no válido/);
  assert.match(mal({ tipo: 'propio' }), /tipo «propio» va con el tipo de documento/);
  // Sin tipo de documento: por confirmar; «propio» lo trae del tipo
  assert.equal(reg({ tipo_documento: '' }).tipo_documento, 'por_confirmar');
  assert.deepEqual([reg({ tipo_documento: '', tipo: 'propio', region: '' }).tipo_documento, reg({ tipo_documento: '', tipo: 'propio', region: '' }).tipo], ['propio', 'propio']);
  // IGV «por_confirmar» del CSV del pedido: no se calcula el precio sin IGV y se dice
  const pc = normalizar(reg({ incluye_igv: 'por_confirmar' }));
  assert.deepEqual([pc.precio_sin_igv, pc.comparable], [null, false]);
  assert.match(pc.motivo, /no se calcula el precio sin IGV/);
  // Transporte por pieza: se convierte a sin IGV, pero no es un precio de kit
  const t = normalizar(reg({ unidad: 'transporte', monto: 25, incluye_igv: true }));
  assert.deepEqual([t.precio_sin_igv, t.comparable], [21.19, false]);
  assert.match(t.motivo, /Transporte por pieza/);
});

test('Huicungo: ejecución 307,333.60 + documento equivalente 13,720.25 + supervisión 24,696.45 = 345,750.30', () => {
  assert.deepEqual(limpiarRegistro(huicungoKit).errores, []);
  assert.deepEqual(limpiarRegistro(huicungoKit).r.componentes, { ejecucion: 307333.60, doc_equivalente: 13720.25, supervision: 24696.45, total: 345750.30 });
  const mal = c => limpiarRegistro({ ...huicungoKit, componentes: { ...huicungoKit.componentes, ...c } }).errores.join(' ');
  assert.match(mal({ total: 345750.31 }), /no suman el total declarado/);
  assert.match(mal({ sup_ejecucion: 1 }), /separada o en un solo monto, no las dos/);
  // 675.50 con IGV → 572.46 sin IGV
  assert.equal(normalizar(huicungoKit).precio_kit_sin_igv, sinIgv(675.5));
});

test('estadísticos sin el precio propio, los históricos ni los atípicos por volumen (salvo que se incluyan)', () => {
  const rs = [reg({ id: 'a', monto: 500 }), reg({ id: 'b', monto: 600 }), reg({ id: 'c', monto: 700, estado: 'historico' }),
    reg({ id: 'd', monto: 300, volumen_kits: UMBRAL_ATIPICO + 1 }), reg({ id: 'e', monto: 900, tipo_documento: 'propio', region: '' })];
  const E = estadisticos(rs);
  assert.deepEqual(E.map(g => [g.n, g.min, g.mediana, g.max]), [[2, 500, 550, 600]]);
  assert.deepEqual(estadisticos(rs, { atipicos: true }).map(g => [g.n, g.mediana]), [[3, 500]], 'con el interruptor, el atípico entra');
  const x = enriquecer(rs);
  assert.match(x.find(y => y.id === 'c').excluido, /Histórico/);
  assert.match(x.find(y => y.id === 'd').excluido, /Atípico por volumen/);
  assert.equal(x.find(y => y.id === 'a').excluido, null);
  // 10,000 kits justos no es atípico
  assert.equal(enriquecer([reg({ volumen_kits: UMBRAL_ATIPICO })])[0].atipico, false);
});

test('factor de actualización: 1.00 por defecto con aviso «sin ajuste»; otro factor cambia el precio comparado', () => {
  const r = reg({ id: 'x', monto: 500, anio: 2023 }), r2 = reg({ id: 'y', monto: 600, anio: 2025 });
  const a = actualizar({ ...r, ...normalizar(r) });
  assert.deepEqual([a.anio_origen, a.anio_base, a.factor, a.precio_actualizado, a.sin_ajuste], [2023, 2025, 1, 500, true]);
  assert.equal(actualizar({ ...r2, ...normalizar(r2) }).sin_ajuste, false, 'mismo año que el base');
  const ref = referencia([r, r2], { nivel: 'P', sel: { modo: 'mediana' } });
  assert.ok(ref.avisos.some(t => /Sin ajuste de precios: .*2023, factor 1\.00/.test(t)));
  // Factor registrado 1.10 para 2023 → 550; la mediana usa el precio actualizado
  const factores = [{ anio_origen: 2023, anio_base: 2025, factor: 1.1 }];
  const con = referencia([r, r2], { nivel: 'P', sel: { modo: 'mediana' }, factores });
  assert.equal(con.precio, 575);
  assert.ok(!con.avisos.some(t => /Sin ajuste/.test(t)));
  // «Comparar a año base» apagado: precios originales
  assert.equal(referencia([r, r2], { nivel: 'P', sel: { modo: 'mediana', comparar_anio_base: false }, factores }).precio, 550);
  // El año del precio manda sobre el año del documento
  const r3 = reg({ monto: 500, anio: 2026, anio_precio: 2023 });
  assert.equal(actualizar({ ...r3, ...normalizar(r3) }, { factores }).precio_actualizado, 550);
  // No se inventan índices: un factor distinto de 1.00 necesita fuente y fecha
  assert.match(limpiarFactor({ anio_origen: 2023, factor: 1.05 }).errores.join(' '), /fuente del índice y su fecha/);
  assert.deepEqual(limpiarFactor({ anio_origen: 2023 }).f, { anio_origen: 2023, anio_base: 2025, factor: 1, fuente_indice: null, fecha: null });
  assert.deepEqual(limpiarFactor({ anio_origen: 2023, factor: '1.05', fuente_indice: 'Índice escrito por el usuario', fecha: '2026-01-31' }).errores, []);
});

test('avisos de volumen (más de 5 veces) y de nivel distinto', () => {
  const r = reg({ volumen_kits: 455 });
  assert.equal(avisoVolumen(r, 455 * 5), null);
  assert.match(avisoVolumen(r, 455 * 5 + 1), /No comparable por volumen: .*455 kits frente a 2,276/);
  assert.match(avisoVolumen(r, 80), /5\.7 veces/);
  // Huicungo (Primaria) como referencia de una IOARR de Secundaria
  const s = referencia(PRECARGA, { nivel: 'S', sel: { modo: 'defecto', material: 'metal-madera' } });
  assert.equal(s.precio, 572.46);
  assert.ok(s.avisos.some(t => /es de Primaria; la IOARR es de Secundaria/.test(t)));
});

test('Huicungo es el default de Metal/Madera: kit en «Precios referenciales» y mesas y sillas por grado en Costos', () => {
  const ref = referencia(PRECARGA, { nivel: 'P', sel: { modo: 'defecto', material: 'metal-madera' } });
  assert.deepEqual([ref.precio, ref.modo, ref.registros], [572.46, 'defecto', [huicungoKit.id]]);
  // Otro material sin referencia por defecto: la mediana
  assert.equal(referencia(PRECARGA, { nivel: 'S', sel: { modo: 'defecto', material: 'metal-polipropileno' } }).modo, 'mediana');
  // Costos: mesa y silla de Metal/Madera por talla de Primaria (con IGV en la fuente → ÷ 1.18)
  const U = preciosUnitarios(PRECARGA);
  assert.deepEqual(['mesa_p12', 'mesa_p34', 'mesa_p56', 'silla_p12', 'silla_p34', 'silla_p56'].map(k => U['metal-madera'][k].precio), [313.56, 317.8, 322.03, 146.61, 150.85, 155.08]);
  assert.equal(U['metal-madera'].mesa, undefined, 'sin precio general: las fuentes tienen grado');
  assert.deepEqual([U['metal-madera'].transporte.precio, U['metal-madera'].mesa_p12.igv], [21.19, 'con']);
  const catalogo = { 'metal-madera': { ...U['metal-madera'], kit: { precio: 572.46 } } };
  const E = limpiarEstructura({ kit: true, material_propuesta: 'metal-madera' });
  const P = preciosDeMaterial(E, 'metal-madera', catalogo);
  assert.deepEqual([P.mesa_p12.precio, P.mesa_p12.origen, P.mesa_p12.igv], [313.56, 'catalogo_ref', 'con']);
  assert.equal(P.kit.origen, 'mesa_silla', 'con mesa y silla por talla, el kit es mesa + silla');
  // Primaria tiene todos sus precios; Secundaria no (sin grado de Secundaria en el catálogo): no se guarda
  assert.deepEqual(validarPropuesta({ ...E, kit: false }, { catalogo, muebles: ['mesa', 'silla'], niveles: ['P'] }), []);
  assert.ok(validarPropuesta({ ...E, kit: false }, { catalogo, muebles: ['mesa', 'silla'], niveles: ['S'] }).some(t => /sin precio/.test(t)));
});

test('origen del precio: cotizaciones vigentes promediadas sin IGV; menos de 3 bloquea el 07-C definitivo salvo justificación', () => {
  const hoy = '2026-10-25';
  const c = (n, precios, o = {}) => ({ proveedor: 'P' + n, fecha: '2026-10-01', vigencia_dias: 60, incluye_igv: true, precios, ...o });
  const cots = [c(1, { kit: 590, mesa: 236 }), c(2, { kit: 708 }), c(3, { kit: 1180 }, { fecha: '2025-01-01' })];
  const { precios, usados } = preciosDeCotizaciones({ kit: 999, mesa_p12: 100, mesa: 50 }, cots, { hoy });
  assert.deepEqual([precios.kit, precios.mesa, precios.mesa_p12], [550, 200, undefined], 'la mesa cotizada vale para todas las tallas');
  assert.equal(usados.kit.vigentes, 2);
  // Con mesa y silla cotizadas y el kit sin cotizar, el kit es mesa + silla (no el del catálogo)
  assert.equal(preciosDeCotizaciones({ kit: 999 }, [c(1, { mesa: 236, silla: 118 })], { hoy }).precios.kit, undefined);
  const metas = [{ k: 'kit', nombre: 'Kit' }];
  const cat = estadoPrecio({ origen: 'catalogo', metas, ficha: { cotizaciones: cots }, hoy });
  assert.deepEqual([cat.preliminar, cat.definitivo, cat.etiqueta], [true, false, 'Estimación preliminar']);
  const dos = estadoPrecio({ origen: 'cotizaciones', metas, ficha: { cotizaciones: cots }, hoy });
  assert.deepEqual([dos.preliminar, dos.definitivo], [false, false]);
  assert.match(dos.bloqueos[0], /Kit: 2 cotizaciones vigentes/);
  const just = estadoPrecio({ origen: 'cotizaciones', metas, ficha: { cotizaciones: cots, justificaciones: { kit: 'x'.repeat(30) } }, hoy });
  assert.equal(just.definitivo, true);
  assert.equal(estadoPrecio({ origen: 'cotizaciones', metas, ficha: { cotizaciones: [...cots, c(4, { kit: 649 })] }, hoy }).definitivo, true);
  assert.match(estadoPrecio({ origen: 'cotizaciones', metas, ficha: null, hoy }).bloqueos[0], /No hay legajo/);
  // Sin precio de cotización en un ítem: sigue siendo preliminar
  assert.equal(estadoPrecio({ origen: 'cotizaciones', metas: [...metas, { k: 'arm', nombre: 'Armario' }], ficha: { cotizaciones: cots }, hoy }).preliminar, true);
  assert.equal(limpiarEstructura({}).origen_precio, 'catalogo');
  assert.equal(limpiarEstructura({ origen_precio: 'otro' }).origen_precio, 'catalogo');
});

test('hoja de transparencia: fuentes del precio y la declaración; nunca el precio propio', () => {
  const pre = fuentesPrecio({ origen_precio: { origen: 'catalogo', preliminar: true, items: [] } });
  assert.match(pre[0], /estimación preliminar con el catálogo/);
  const cot = fuentesPrecio({ origen_precio: { origen: 'cotizaciones', preliminar: false, items: [{ nombre: 'Kit', proveedores: 2, justificado: true, promedio: true }] } });
  assert.match(cot.join(' '), /Kit: 2 proveedores con cotización vigente \(menos de 3: con justificación escrita\)/);
  const T = transparencia(limpiarFicha({}), { origen_precio: { origen: 'catalogo', preliminar: true, items: [] }, precio_ref: { precio: 850, modo: 'defecto', n: 1 } });
  assert.equal(T.declaracion_cotizaciones, DECLARACION_COTIZACIONES);
  assert.equal(DECLARACION_COTIZACIONES, 'Apoyo técnico brindado por un potencial postor; la entidad es responsable de obtener y validar las cotizaciones');
  assert.doesNotMatch(JSON.stringify(T.fuentes_precio), /propio|850/i);
});
