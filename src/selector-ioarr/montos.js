// ============================================================================
// src/selector-ioarr/montos.js — Suma exacta de componentes frente a un total declarado
//
// La usan la ficha de bases (bases.js / bases-api.js) y el catálogo de precios
// referenciales (catalogo-ref.js): si los componentes no suman el total declarado,
// no se guarda. Se compara en céntimos enteros (sin errores de coma flotante).
// ============================================================================

const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const soles = n => 'S/ ' + NS.format(n);
export const centimos = n => Math.round(Number(n) * 100);

/**
 * @param partes { etiqueta: monto } (todos números)
 * @param total  total declarado
 * @returns null si cuadra; si no, el mensaje con la suma, el total y la diferencia
 */
export function descuadre(partes, total, { que = 'Los componentes' } = {}) {
  const suma = Object.values(partes).reduce((a, v) => a + centimos(v), 0), t = centimos(total);
  if (suma === t) return null;
  const dif = (suma - t) / 100;
  return `${que} suman ${soles(suma / 100)} y el total declarado es ${soles(t / 100)} (diferencia ${dif > 0 ? '+' : '−'}${soles(Math.abs(dif))}). `
    + `Revisa: ${Object.entries(partes).map(([k, v]) => `${k} ${soles(v)}`).join(' + ')}.`;
}
