// Pruebas de la calculadora de rentabilidad (correr con: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularRentabilidad } from '../src/ioarr/calculadora.js';

test('sin descuento, sin otros costos ni tasa: resultado neto 0', () => {
  const r = calcularRentabilidad({ monto_inversion: 1_000_000, costos_gestion: 20_000, costo_supervision: 30_000 });
  assert.equal(r.desembolso_total, 1_050_000);
  assert.equal(r.ciprl_reconocido, 1_050_000);
  assert.equal(r.ingreso_ciprl, 1_050_000);
  assert.equal(r.costo_capital, 0);
  assert.equal(r.resultado_neto, 0);
  assert.equal(r.rentabilidad_pct, 0);
});

test('"otros costos" se desembolsan pero no entran al CIPRL', () => {
  const r = calcularRentabilidad({ monto_inversion: 100_000, otros_costos: 5_000 });
  assert.equal(r.desembolso_total, 105_000);
  assert.equal(r.ciprl_reconocido, 100_000);
  assert.equal(r.resultado_neto, -5_000);
});

test('descuento por negociación del CIPRL reduce el ingreso', () => {
  const r = calcularRentabilidad({ monto_inversion: 100_000, descuento_negociacion_ciprl_pct: 4 });
  assert.equal(r.ingreso_ciprl, 96_000);
  assert.equal(r.resultado_neto, -4_000);
  assert.equal(r.rentabilidad_pct, -4);
});

test('costo de capital interno: 12 meses al 10 % anual', () => {
  const r = calcularRentabilidad({ monto_inversion: 100_000, meses_hasta_cobro: 12, tasa_costo_capital_anual: 10 });
  assert.equal(r.costo_capital, 10_000);
  assert.equal(r.resultado_neto, -10_000);
});

test('costo de capital compuesto para 6 meses', () => {
  const r = calcularRentabilidad({ monto_inversion: 100_000, meses_hasta_cobro: 6, tasa_costo_capital_anual: 21 });
  assert.equal(r.costo_capital, 10_000); // (1.21^0.5 − 1) = 0.10
});

test('beneficio adicional suma al resultado neto y a la rentabilidad', () => {
  const r = calcularRentabilidad({
    monto_inversion: 100_000, descuento_negociacion_ciprl_pct: 2,
    meses_hasta_cobro: 12, tasa_costo_capital_anual: 10, beneficio_adicional: 15_000
  });
  // −2 000 (descuento) − 10 000 (capital) + 15 000 (beneficio)
  assert.equal(r.resultado_neto, 3_000);
  assert.equal(r.rentabilidad_pct, 3);
  assert.equal(r.ciprl_reconocido, 100_000); // no altera el CIPRL
  assert.equal(r.desembolso_total, 100_000); // ni el desembolso
});

test('beneficio adicional vacío equivale a 0', () => {
  const r = calcularRentabilidad({ monto_inversion: 100_000, beneficio_adicional: '' });
  assert.equal(r.beneficio_adicional, 0);
  assert.equal(r.resultado_neto, 0);
});

test('acepta strings numéricos y vacíos', () => {
  const r = calcularRentabilidad({ monto_inversion: '50000', costos_gestion: '', otros_costos: null });
  assert.equal(r.desembolso_total, 50_000);
});

test('valida entradas', () => {
  assert.throws(() => calcularRentabilidad({ monto_inversion: 0 }), /mayor que 0/);
  assert.throws(() => calcularRentabilidad({ monto_inversion: 100, costos_gestion: -1 }), /inválido/);
  assert.throws(() => calcularRentabilidad({ monto_inversion: 100, costos_gestion: 'abc' }), /inválido/);
  assert.throws(() => calcularRentabilidad({ monto_inversion: 100, descuento_negociacion_ciprl_pct: 120 }), /100/);
  assert.throws(() => calcularRentabilidad({ monto_inversion: 100, beneficio_adicional: -5 }), /inválido/);
});
