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

test('San Juan: los componentes del 07-C suman exactamente S/ 919,915.39', () => {
  assert.deepEqual(C, { ejecucion: 739373.42, doc_equivalente: 43144.10, sup_doc_equivalente: 41219.36, sup_ejecucion: 96178.51, total: 919915.39 });
  // En céntimos enteros: sin errores de coma flotante
  assert.equal(centimos(C.ejecucion) + centimos(C.doc_equivalente) + centimos(C.sup_doc_equivalente) + centimos(C.sup_ejecucion), 91991539);
  // Supervisión total = documento equivalente + ejecución
  assert.equal(centimos(C.sup_doc_equivalente) + centimos(C.sup_ejecucion), centimos(137397.87));
  assert.equal(descuadre({ a: C.ejecucion, b: C.doc_equivalente, c: 137397.87 }, C.total), null);
  assert.deepEqual(Object.keys(COMPONENTES), ['ejecucion', 'doc_equivalente', 'sup_doc_equivalente', 'sup_ejecucion']);
});

test('San Juan: precio por kit derivado del 07-C y conversión sin IGV con 18 %', () => {
  assert.equal(IGV, 18);
  const { r, errores } = limpiarRegistro(SJ);
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
  assert.equal(limpiarRegistro({ ...SJ, monto: 700 }).r.monto, 707.53);
});

test('registro del catálogo: si los componentes no suman el total, no se guarda', () => {
  // El error del OCR: 41,219.36 como supervisión de la ejecución
  const malo = limpiarRegistro({ ...SJ, componentes: { ...C, sup_ejecucion: 41219.36 } });
  assert.equal(malo.r, null);
  assert.match(malo.errores[0], /no suman el total declarado: Los componentes suman S\/ 864,956\.24 y el total declarado es S\/ 919,915\.39 \(diferencia −S\/ 54,959\.15\)/);
  assert.ok(!limpiarRegistro({ ...SJ, componentes: { ...C, ejecucion: 789878.42 } }).r);
  assert.ok(limpiarRegistro({ ...SJ, componentes: { ...C, total: '' } }).errores.some(e => /falta «Total declarado»/.test(e)));
  // Estimado derivado sin componentes ni cantidad
  assert.ok(limpiarRegistro({ ...SJ, componentes: null }).errores.some(e => /indica los componentes/.test(e)));
  assert.ok(limpiarRegistro({ ...SJ, derivacion: null }).errores.some(e => /indica la cantidad/.test(e)));
  // La fórmula solo vale para estimado derivado
  assert.ok(limpiarRegistro({ ...SJ, tipo_documento: 'bases' }).errores.some(e => /solo vale para el tipo «estimado derivado»/.test(e)));
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
