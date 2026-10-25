// San Juan (CUI 2711098): montos corregidos con el Formato 07-C (el OCR de las bases daba valores erróneos),
// precio derivado del catálogo y validación general «los componentes deben sumar el total».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRECARGA, IGV, sinIgv, limpiarRegistro, normalizar, COMPONENTES } from '../src/selector-ioarr/catalogo-ref.js';
import { limpiarFicha, validarFicha, descuadreFicha } from '../src/selector-ioarr/bases.js';
import { descuadre, centimos } from '../src/selector-ioarr/montos.js';
import { FICHA_PRUEBA, CTX_PRUEBA } from './helpers/ficha-bases.js';

const SJ = PRECARGA.find(r => r.id === 'c0a7a10e-0000-4000-8000-000000000004');
const C = SJ.componentes;
// El estimado derivado de la 031 (antes de la memoria de costos): sigue sirviendo para probar ese tipo de registro
const ESTIMADO_031 = { ...SJ, tipo_documento: 'estimado_derivado', nivel: 'por_confirmar', monto: 707.53, incluye_igv: true, flete_transporte: null, cotizaciones: null, confianza: 'media',
  derivacion: { divisor: 1045, divisor_alternativo: 1087, detalle: '1,045 mesas y 1,045 sillas de alumno (420 + 420 + 205); alternativa con 42 escritorios: 1,087' },
  notas: 'Estimado a partir del 07-C; el precio unitario real está en la memoria de costos, pendiente' };

test('San Juan: los componentes del 07-C suman exactamente S/ 919,915.39', () => {
  assert.deepEqual(C, { ejecucion: 739373.42, doc_equivalente: 43144.10, sup_doc_equivalente: 41219.36, sup_ejecucion: 96178.51, total: 919915.39 });
  // En céntimos enteros: sin errores de coma flotante
  assert.equal(centimos(C.ejecucion) + centimos(C.doc_equivalente) + centimos(C.sup_doc_equivalente) + centimos(C.sup_ejecucion), 91991539);
  // Supervisión total = documento equivalente + ejecución
  assert.equal(centimos(C.sup_doc_equivalente) + centimos(C.sup_ejecucion), centimos(137397.87));
  assert.equal(descuadre({ a: C.ejecucion, b: C.doc_equivalente, c: 137397.87 }, C.total), null);
  assert.deepEqual(Object.keys(COMPONENTES), ['ejecucion', 'doc_equivalente', 'sup_doc_equivalente', 'sup_ejecucion']);
});

test('estimado derivado (San Juan antes de la memoria): precio por kit del 07-C y conversión sin IGV con 18 %', () => {
  assert.equal(IGV, 18);
  const { r, errores } = limpiarRegistro(ESTIMADO_031);
  assert.deepEqual(errores, []);
  assert.equal(r.tipo_documento, 'estimado_derivado');
  assert.equal(r.cui, '2711098');
  assert.equal(r.incluye_igv, true);
  assert.equal(r.confianza, 'media');
  assert.equal(r.notas, 'Estimado a partir del 07-C; el precio unitario real está en la memoria de costos, pendiente');
  // Kit de alumno: 739,373.42 / 1,045 = 707.53 con IGV → / 1.18 = 599.60 sin IGV
  assert.equal(r.monto, Math.round(739373.42 / 1045 * 100) / 100);
  assert.equal(r.monto, 707.53);
  const N = normalizar(r);
  assert.equal(N.precio_kit_sin_igv, Math.round(707.53 / 1.18 * 100) / 100);
  assert.equal(N.precio_kit_sin_igv, 599.6);
  assert.equal(sinIgv(707.53), 599.6);
  // Alternativa: / 1,087 = 680.20 con IGV → 576.44 sin IGV
  assert.equal(r.monto_alternativo, 680.2);
  assert.equal(N.precio_alternativo_sin_igv, 576.44);
  assert.match(r.formula, /Ejecución física S\/ 739,373\.42 \/ 1,045 = S\/ 707\.53; alternativa: \/ 1,087 = S\/ 680\.20/);
  assert.ok(N.comparable);
  // El monto lo pone la fórmula, aunque se mande otro
  assert.equal(limpiarRegistro({ ...ESTIMADO_031, monto: 700 }).r.monto, 707.53);
});

test('registro del catálogo: si los componentes no suman el total, no se guarda', () => {
  // El error del OCR: 41,219.36 como supervisión de la ejecución
  const malo = limpiarRegistro({ ...ESTIMADO_031, componentes: { ...C, sup_ejecucion: 41219.36 } });
  assert.equal(malo.r, null);
  assert.match(malo.errores[0], /no suman el total declarado: Los componentes suman S\/ 864,956\.24 y el total declarado es S\/ 919,915\.39 \(diferencia −S\/ 54,959\.15\)/);
  assert.ok(!limpiarRegistro({ ...ESTIMADO_031, componentes: { ...C, ejecucion: 789878.42 } }).r);
  assert.ok(limpiarRegistro({ ...ESTIMADO_031, componentes: { ...C, total: '' } }).errores.some(e => /falta «Total declarado»/.test(e)));
  // Estimado derivado sin componentes ni cantidad
  assert.ok(limpiarRegistro({ ...ESTIMADO_031, componentes: null }).errores.some(e => /indica los componentes/.test(e)));
  assert.ok(limpiarRegistro({ ...ESTIMADO_031, derivacion: null }).errores.some(e => /indica la cantidad/.test(e)));
  // La fórmula solo vale para estimado derivado
  assert.ok(limpiarRegistro({ ...ESTIMADO_031, tipo_documento: 'bases' }).errores.some(e => /solo vale para el tipo «estimado derivado»/.test(e)));
  // El registro actual (07-C, memoria de costos) también exige que los componentes cuadren
  assert.ok(!limpiarRegistro({ ...SJ, componentes: { ...C, ejecucion: 789878.42 } }).r);
});

test('ficha de bases: con un total declarado que no cuadra, no se guarda ni se exporta', () => {
  const ok = limpiarFicha({ ...FICHA_PRUEBA, total_declarado: 83300.15 });
  assert.equal(descuadreFicha(ok), null);
  assert.ok(validarFicha(ok, CTX_PRUEBA).ok);
  const mal = limpiarFicha({ ...FICHA_PRUEBA, total_declarado: 83300.16 });
  assert.match(descuadreFicha(mal), /Las cuatro prestaciones suman S\/ 83,300\.15 y el total declarado es S\/ 83,300\.16 \(diferencia −S\/ 0\.01\)/);
  assert.ok(validarFicha(mal, CTX_PRUEBA).errores.some(e => e.k === 'total_declarado'));
  // San Juan en una ficha: las cuatro prestaciones del 07-C
  const sj = limpiarFicha({ ...FICHA_PRUEBA, MONTO_DOC_EQUIVALENTE: 43144.10, MONTO_EJECUCION: 739373.42, MONTO_SUP_DOC_EQUIVALENTE: 41219.36, MONTO_SUP_EJECUCION: 96178.51, total_declarado: 919915.39 });
  assert.equal(descuadreFicha(sj), null);
  assert.ok(descuadreFicha({ ...sj, MONTO_SUP_EJECUCION: 41219.36 }));
  // Sin total declarado no se exige nada (es opcional)
  assert.equal(descuadreFicha(limpiarFicha(FICHA_PRUEBA)), null);
});

// Partidas del presupuesto de la memoria de costos (costo unitario + flete, sin IGV) y el promedio con IGV de las 4 cotizaciones
const PARTIDAS = [
  { n: 'Mesa rojo', q: 420, parcial: 90720.61, cot: 239.53 }, { n: 'Mesa verde', q: 420, parcial: 90958.20, cot: 240.20 }, { n: 'Mesa marrón', q: 205, parcial: 49349.56, cot: 268.71 },
  { n: 'Silla rojo', q: 420, parcial: 91756.38, cot: 242.44 }, { n: 'Silla verde', q: 420, parcial: 92201.29, cot: 243.69 }, { n: 'Silla marrón', q: 205, parcial: 42591.51, cot: 229.81 },
  { n: 'Escritorio con cajonera', q: 42, parcial: 25580.40, cot: 703.33 }, { n: 'Silla docente', q: 42, parcial: 5707.52, cot: 145.00 }];
const r2 = n => Math.round(n * 100) / 100;
test('San Juan con la memoria de costos: S/ 411.85 por kit sin IGV (sin flete, gastos generales ni utilidad) y flete aparte', () => {
  // La memoria cuadra: costo directo + GG + utilidad + IGV = ejecución del 07-C
  const cd = PARTIDAS.reduce((a, p) => a + centimos(p.parcial), 0);
  assert.equal(cd, centimos(488865.47));
  assert.equal(cd + centimos(88835.62) + centimos(48886.55), centimos(626587.64));
  assert.equal(centimos(626587.64) + centimos(112785.78), centimos(C.ejecucion));
  assert.equal(r2(626587.64 * IGV / 100), 112785.78);
  // Cada precio unitario = cotización promedio con IGV / 1.18 + S/ 13.01 de flete
  for (const p of PARTIDAS.slice(0, 6)) assert.equal(r2(p.cot / 1.18 + 13.01), r2(p.parcial / p.q), p.n);
  // Kit = mesa + silla de los 1,045 kits, menos el flete de 2 piezas
  const kitsConFlete = PARTIDAS.slice(0, 6).reduce((a, p) => a + p.parcial, 0);
  assert.equal(r2(kitsConFlete / 1045), 437.87);
  assert.equal(r2((kitsConFlete - 2 * 1045 * 13.01) / 1045), 411.85);
  const { r, errores } = limpiarRegistro(SJ);
  assert.deepEqual(errores, []);
  assert.deepEqual([r.tipo_documento, r.nivel, r.monto, r.incluye_igv, r.flete_transporte, r.confianza, r.formula, r.derivacion], ['07-C', 'Secundaria', 411.85, false, 26.02, 'alta', null, null]);
  assert.equal(normalizar(r).precio_kit_sin_igv, 411.85);   // sin IGV: no se divide entre 1.18
  assert.equal(r.cotizaciones.n, 4);
});

test('la migración 032 deja San Juan con el precio de la memoria de costos', () => {
  const sql = readFileSync(new URL('../supabase/migrations/032_ioarr_san_juan_memoria_costos.sql', import.meta.url), 'utf8');
  for (const v of ["tipo_documento = '07-C'", "nivel = 'Secundaria'", 'monto = 411.85', 'incluye_igv = false', 'flete_transporte = 26.02', "confianza = 'alta'", 'derivacion = null', '919915.39'])
    assert.ok(sql.includes(v), v);
  assert.match(sql, /where id = 'c0a7a10e-0000-4000-8000-000000000004'/);
});

test('la migración 031 deja San Juan con los valores del 07-C', () => {
  const sql = readFileSync(new URL('../supabase/migrations/031_ioarr_montos_san_juan.sql', import.meta.url), 'utf8');
  for (const v of ['739373.42', '43144.10', '41219.36', '96178.51', '919915.39', 'monto = 707.53', 'monto_alternativo = 680.20', "'2711098'", "'estimado_derivado'", 'incluye_igv = true', "confianza = 'media'"])
    assert.ok(sql.includes(v), v);
  assert.match(sql, /where id = 'c0a7a10e-0000-4000-8000-000000000004'/);
});

test('no quedan los valores erróneos del OCR en el código, las plantillas ni los textos', () => {
  const raiz = fileURLToPath(new URL('..', import.meta.url));
  const malos = [/789,?878\.42/, /887,?397\.87/, /aprox\.? S\/ ?700/i];
  const hallados = [];
  const recorrer = dir => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n), rel = path.relative(raiz, p);
      if (['node_modules', '.git', 'data'].includes(n) || /^supabase\/migrations\/0(29|30)_/.test(rel) || rel === 'test/montos-san-juan.test.js') continue;   // 029 y 030 ya se ejecutaron: los corrige la 031
      const st = statSync(p);
      if (st.isDirectory()) recorrer(p);
      else if (/\.(js|mjs|json|md|sql|html|css|csv)$/.test(n)) { const t = readFileSync(p, 'utf8'); for (const re of malos) if (re.test(t)) hallados.push(`${rel}: ${re}`); }
    }
  };
  recorrer(raiz);
  assert.deepEqual(hallados, []);
});
