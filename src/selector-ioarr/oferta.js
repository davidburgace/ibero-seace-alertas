// ============================================================================
// src/selector-ioarr/oferta.js — Análisis interno de la oferta (USO INTERNO: NO SE EXPORTA)
//
// Costo propio de fabricar y poner el mobiliario en cada colegio, frente al monto de
// la estructura de costos del 07-C (o a un monto referencial escrito a mano, para una
// convocatoria ya publicada). Se guarda aparte (ioarr_expediente_oferta) y ningún
// exportador lo lee: no entra al 07-C, a las fichas, a la memoria, a los Excel ni al ZIP.
//
//   Costo en el colegio = Σ cantidad × costo de fabricación (por tipo de bien)
//                       + piezas × (embalaje + transporte puesto en colegio + instalación o entrega)
//   Gastos generales propios: % sobre ese costo o monto fijo (repartido según el costo)
//   Margen = precio − costo. Se calcula como diferencia: nunca se suma encima de un precio.
// Todos los montos sin IGV, salvo que la referencia elegida lo incluya (se avisa).
// ============================================================================

import { ITEMS } from './calculo.js';
import { factorZona, indiceFactores } from './costos.js';

export const MARCA_INTERNA = 'Uso interno: no se exporta';
export const REFERENCIAS = {
  monto_inversion: 'Monto de inversión de la estructura de costos (con IGV, documento equivalente, supervisión y liquidación)',
  cd_igv: 'Costo directo + IGV de la estructura de costos',
  cd: 'Costo directo sin IGV de la estructura de costos',
  manual: 'Monto referencial escrito a mano (convocatoria ya publicada)'
};
export const NOTA_MARGEN = 'El margen es la diferencia entre el precio de referencia y tu costo (precio − costo). No se suma encima de ningún precio.';
const TIPOS = ITEMS.map(x => x.k);

const num = (v, mn, mx) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= mn && n <= mx ? Math.round(n * 100) / 100 : null; };

/** Entradas válidas de la oferta (lo desconocido se descarta; lo vacío queda en null) */
export function limpiarOferta(b = {}) {
  const x = b && typeof b === 'object' ? b : {};
  const porDistrito = {};
  for (const [u, v] of Object.entries(x.transporte_distrito || {}).slice(0, 2000)) {
    const n = num(v, 0, 1e6);
    if (/^\d{6}$/.test(u) && n != null) porDistrito[u] = n;
  }
  return {
    fabricacion: Object.fromEntries(TIPOS.map(k => [k, num(x.fabricacion?.[k], 0, 1e7)])),
    embalaje: num(x.embalaje, 0, 1e6),
    transporte_base: num(x.transporte_base, 0, 1e6),
    usar_factor_zona: x.usar_factor_zona === true,
    transporte_distrito: porDistrito,
    instalacion: num(x.instalacion, 0, 1e6),
    gg_modo: x.gg_modo === 'monto' ? 'monto' : 'pct',
    gg_valor: num(x.gg_valor, 0, x.gg_modo === 'monto' ? 1e10 : 1000),
    referencia: REFERENCIAS[x.referencia] ? x.referencia : 'monto_inversion',
    monto_manual: num(x.monto_manual, 0, 1e11)
  };
}

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * @param R      resultado de costear() del proyecto (escenario y kit elegidos)
 * @param o      limpiarOferta()
 * @param extra  { factores } filas de ioarr_factores_zona (opcional: transporte × (1 + flete de la zona))
 */
export function calcularOferta(R, o, { factores = [] } = {}) {
  const O = limpiarOferta(o), kit = !!R.kit, idx = indiceFactores(factores);
  const v = x => x ?? 0;
  const faltan = [];
  TIPOS.forEach((k, t) => { if (R.partidas[t] && !R.partidas[t].excluido && R.partidas[t].rep > 0 && O.fabricacion[k] == null) faltan.push(`Costo de fabricación: ${ITEMS[t].n.toLowerCase()}`); });
  if (O.embalaje == null) faltan.push('Embalaje por pieza');
  if (O.transporte_base == null && !Object.keys(O.transporte_distrito).length) faltan.push('Transporte puesto en colegio');
  if (O.instalacion == null) faltan.push('Instalación o entrega por pieza');

  // Por local: cantidades (con kit, mesa y silla = kits), piezas y costo
  const locales = R.locales.map(l => {
    const q = TIPOS.map((_, t) => kit && t < 2 ? l.kits : l.rep[t]);
    const piezas = l.piezas ?? q.reduce((a, b) => a + b, 0);
    const zona = factorZona(l.ubigeo, l.rural, idx);
    const tr = O.transporte_distrito[l.ubigeo] ?? (O.transporte_base == null ? null : O.transporte_base * (O.usar_factor_zona ? 1 + zona.flete : 1));
    const fabricacion = q.reduce((a, n, t) => a + n * v(O.fabricacion[TIPOS[t]]), 0);
    const embalaje = piezas * v(O.embalaje), transporte = piezas * v(tr), instalacion = piezas * v(O.instalacion);
    return { cod: l.cod, nom: l.nom, dist: l.dist, ubigeo: l.ubigeo, kits: l.kits, piezas, transporte_pieza: tr, fabricacion, embalaje, transporte, instalacion,
      directo: fabricacion + embalaje + transporte + instalacion, precio_inversion: l.total, cd: l.cd, igv: l.igv };
  });
  const directo = locales.reduce((a, l) => a + l.directo, 0);
  const gg = O.gg_modo === 'monto' ? v(O.gg_valor) : directo * v(O.gg_valor) / 100;
  for (const l of locales) {
    l.gg = O.gg_modo === 'monto' ? (directo ? gg * l.directo / directo : gg / (locales.length || 1)) : l.directo * v(O.gg_valor) / 100;
    l.costo = l.directo + l.gg;
  }
  const costo = directo + gg, T = R.totales;

  // Precio de referencia y su reparto por local
  const refTotal = O.referencia === 'manual' ? O.monto_manual : O.referencia === 'cd' ? T.cd : O.referencia === 'cd_igv' ? T.cdIgv : T.total;
  const pesoDe = l => O.referencia === 'cd' ? l.cd : O.referencia === 'cd_igv' ? l.cd + l.igv : l.precio_inversion;
  const pesoTot = locales.reduce((a, l) => a + pesoDe(l), 0);
  for (const l of locales) {
    l.referencia = refTotal == null ? null : pesoTot ? refTotal * pesoDe(l) / pesoTot : refTotal / (locales.length || 1);
    l.margen = l.referencia == null ? null : l.referencia - l.costo;
    l.margen_pct = l.referencia ? l.margen / l.referencia : null;
  }
  const margen = refTotal == null ? null : refTotal - costo;
  const kits = T.kits || 0;
  const avisos = [];
  if (refTotal == null) avisos.push({ alerta: false, texto: 'Escribe el monto referencial de la convocatoria para comparar.' });
  else if (costo > refTotal) avisos.push({ alerta: true, texto: `Tu costo (S/ ${r2(costo).toLocaleString('es-PE')}) supera el monto referencial (S/ ${r2(refTotal).toLocaleString('es-PE')}): la oferta da pérdida.` });
  const sobre = locales.filter(l => l.referencia != null && l.costo > l.referencia);
  if (refTotal != null && costo <= refTotal && sobre.length) avisos.push({ alerta: false, texto: `En ${sobre.length === 1 ? '1 colegio' : sobre.length + ' colegios'} el costo puesto en el colegio supera su parte del monto referencial.` });
  if (O.referencia === 'monto_inversion') avisos.push({ alerta: false, texto: 'El monto de inversión incluye IGV, documento equivalente, supervisión y liquidación, que no son ingreso del proveedor. Para un margen comparable con costos sin IGV, compara contra el costo directo.' });
  if (faltan.length) avisos.push({ alerta: false, texto: 'Faltan entradas (se calculan con 0): ' + faltan.join(', ') + '.' });

  return {
    marca: MARCA_INTERNA, nota: NOTA_MARGEN, referencia: { clave: O.referencia, nombre: REFERENCIAS[O.referencia], monto: refTotal },
    totales: { directo: r2(directo), gg: r2(gg), costo: r2(costo), referencia: refTotal == null ? null : r2(refTotal), margen: margen == null ? null : r2(margen),
      margen_pct: refTotal ? margen / refTotal : null, kits, piezas: locales.reduce((a, l) => a + l.piezas, 0),
      por_kit: kits ? { costo: costo / kits, referencia: refTotal == null ? null : refTotal / kits, margen: margen == null ? null : margen / kits } : null,
      supera: refTotal != null && costo > refTotal },
    locales, faltan, avisos, kit
  };
}
