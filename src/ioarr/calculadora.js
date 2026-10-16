// ============================================================================
// src/ioarr/calculadora.js — Calculadora de rentabilidad del financista (OxI)
//
// Módulo PURO (sin dependencias): lo usa el backend para guardar evaluaciones
// y el navegador (servido en /ioarr/calculadora.js) para el cálculo en vivo.
//
// AVISO: el reglamento (D.S. 038-2026-EF) NO reconoce intereses de
// financiamiento; solo costos de gestión. La "tasa de costo de capital" es un
// criterio INTERNO del financista para medir su costo de oportunidad, NO un
// monto que el Estado reconozca en el CIPRL. Resultado referencial: verificar
// con la DGPPIP del MEF o un abogado.
//
// Fórmula:
//   desembolso_total = inversión + gestión + supervisión + otros
//   ciprl_reconocido = inversión + gestión + supervisión   ("otros" no se reconoce)
//   ingreso_ciprl    = ciprl_reconocido × (1 − descuento%)  (0 % = uso propio contra IR)
//   costo_capital    = desembolso_total × ((1 + tasa%)^(meses/12) − 1)
//   resultado_neto   = ingreso_ciprl − desembolso_total − costo_capital
//   rentabilidad_pct = resultado_neto / desembolso_total × 100
// ============================================================================

export const AVISO_CALCULADORA =
  'El D.S. 038-2026-EF no reconoce intereses de financiamiento; solo costos de gestión. ' +
  'La tasa de costo de capital es un criterio interno, no un reconocimiento del Estado. ' +
  'Resultado referencial: verifíquelo con la DGPPIP del MEF o un abogado.';

const CAMPOS = [
  'monto_inversion', 'costos_gestion', 'costo_supervision', 'otros_costos',
  'descuento_negociacion_ciprl_pct', 'meses_hasta_cobro', 'tasa_costo_capital_anual'
];

const redondea = (n) => Math.round(n * 100) / 100;

// Convierte un valor de entrada a número ≥ 0 (vacío = 0). Lanza error si no es válido.
function numero(input, campo) {
  const bruto = input?.[campo];
  if (bruto === undefined || bruto === null || bruto === '') return 0;
  const v = Number(bruto);
  if (!Number.isFinite(v) || v < 0) throw new Error(`Valor inválido para ${campo}: ${bruto}`);
  return v;
}

export function calcularRentabilidad(input) {
  const e = Object.fromEntries(CAMPOS.map(c => [c, numero(input, c)]));

  if (e.monto_inversion <= 0) throw new Error('El monto de inversión debe ser mayor que 0');
  if (e.descuento_negociacion_ciprl_pct > 100) throw new Error('El descuento no puede superar 100 %');

  const desembolso_total = e.monto_inversion + e.costos_gestion + e.costo_supervision + e.otros_costos;
  const ciprl_reconocido = e.monto_inversion + e.costos_gestion + e.costo_supervision;
  const ingreso_ciprl = ciprl_reconocido * (1 - e.descuento_negociacion_ciprl_pct / 100);
  const costo_capital = desembolso_total *
    (Math.pow(1 + e.tasa_costo_capital_anual / 100, e.meses_hasta_cobro / 12) - 1);
  const resultado_neto = ingreso_ciprl - desembolso_total - costo_capital;
  const rentabilidad_pct = (resultado_neto / desembolso_total) * 100;

  return {
    ...e,
    desembolso_total: redondea(desembolso_total),
    ciprl_reconocido: redondea(ciprl_reconocido),
    ingreso_ciprl: redondea(ingreso_ciprl),
    costo_capital: redondea(costo_capital),
    resultado_neto: redondea(resultado_neto),
    rentabilidad_pct: Math.round(rentabilidad_pct * 1000) / 1000
  };
}
