// ============================================================================
// src/selector-ioarr/origen-precio.js — Origen del precio del expediente (Costos)
//
//   catálogo      precios del catálogo de precios referenciales (o escritos a mano):
//                 el costo del 07-C es una «estimación preliminar».
//   cotizaciones  el precio de cada ítem es el promedio sin IGV de las cotizaciones
//                 vigentes del legajo (pestaña «Documento equivalente», el del nivel);
//                 un ítem sin cotizaciones vigentes sigue con el del catálogo (y la
//                 IOARR sigue siendo preliminar).
//
// 07-C definitivo: solo con origen «cotizaciones» y, por cada meta del 07-C, al menos
// 3 cotizaciones vigentes de proveedores distintos o una justificación escrita
// (la del legajo, mínimo 30 caracteres). Si no, solo se exporta el borrador.
// ============================================================================

import { promedioItem, MIN_COTIZACIONES, MIN_JUSTIFICACION, IGV_PCT } from './documento-equivalente.js';
import { BIENES_COTIZACION } from './cotizaciones.js';
import { CLAVES_PRECIO } from './calculo.js';

export const ETIQUETA_PRELIMINAR = 'Estimación preliminar';
export const TEXTO_PRELIMINAR = 'ESTIMACIÓN PRELIMINAR: los precios unitarios salen del catálogo de precios referenciales (o se escribieron a mano), no de cotizaciones. No vale como Formato 07-C definitivo.';

/**
 * Precios de un nivel con el promedio de las cotizaciones vigentes del legajo.
 * Mesa y silla cotizadas valen para todas sus tallas; con mesa y silla cotizadas y el kit
 * sin cotizar, el kit es mesa + silla (no el del catálogo).
 * @returns { precios, usados: { [bien]: promedioItem() } }
 */
export function preciosDeCotizaciones(precios = {}, cotizaciones = [], { hoy, igv = IGV_PCT } = {}) {
  const out = { ...precios }, usados = {};
  for (const k of Object.keys(BIENES_COTIZACION)) {
    const P = promedioItem(cotizaciones, k, { hoy, igv });
    if (P.sin_igv == null) continue;
    usados[k] = P;
    out[k] = P.sin_igv;
    if (k === 'mesa' || k === 'silla') for (const c of CLAVES_PRECIO) if (c.startsWith(k + '_')) delete out[c];
  }
  if (!usados.kit && usados.mesa && usados.silla) delete out.kit;
  return { precios: out, usados };
}

/**
 * Estado del precio de una IOARR.
 * @param metas  las del 07-C: [{ k, nombre }]
 * @param ficha  datos del legajo del nivel ({ cotizaciones, justificaciones }) o null si no hay
 * @returns { origen, preliminar, etiqueta, items, bloqueos, definitivo }
 */
export function estadoPrecio({ origen = 'catalogo', metas = [], ficha = null, hoy, igv = IGV_PCT }) {
  const cot = ficha?.cotizaciones || [];
  const items = metas.map(m => {
    const P = promedioItem(cot, m.k, { hoy, igv }), just = String(ficha?.justificaciones?.[m.k] || '').trim();
    const justificado = P.vigentes > 0 && just.length >= MIN_JUSTIFICACION;
    return { k: m.k, nombre: m.nombre || BIENES_COTIZACION[m.k] || m.k, vigentes: P.vigentes, proveedores: P.proveedores, promedio: P.sin_igv,
      justificado, ok: P.proveedores >= MIN_COTIZACIONES || justificado };
  });
  const bloqueos = [];
  if (origen !== 'cotizaciones') bloqueos.push('El origen del precio es el catálogo: el costo del 07-C es una estimación preliminar. Cambia el origen a «cotizaciones» en Costos cuando tengas el legajo.');
  else if (!ficha) bloqueos.push('No hay legajo de cotizaciones de este nivel: cárgalo en «Documento equivalente».');
  if (origen === 'cotizaciones') for (const x of items.filter(y => !y.ok))
    bloqueos.push(`${x.nombre}: ${x.proveedores} ${x.proveedores === 1 ? 'cotización vigente' : 'cotizaciones vigentes'} de proveedores distintos; se piden ${MIN_COTIZACIONES} o una justificación escrita (al menos ${MIN_JUSTIFICACION} caracteres) en el legajo.`);
  if (!metas.length) bloqueos.push('La IOARR no tiene metas en el Formato 07-C.');
  const preliminar = origen !== 'cotizaciones' || items.some(x => x.promedio == null);
  return { origen, preliminar, etiqueta: preliminar ? ETIQUETA_PRELIMINAR : 'Precio de cotizaciones', items, bloqueos, definitivo: !bloqueos.length,
    min_cotizaciones: MIN_COTIZACIONES, min_justificacion: MIN_JUSTIFICACION };
}
