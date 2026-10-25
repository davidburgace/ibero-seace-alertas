// ============================================================================
// src/selector-ioarr/cotizaciones.js — Cuadro comparativo de cotizaciones (sustento de precios)
//
// Por nivel (una IOARR por nivel) y bien: proveedor, precio con y sin IGV, material, especificación
// técnica, transporte incluido y fecha. Mínimo 3 proveedores por nivel y bien.
//   Precio sin IGV = el escrito o, si no hay, con IGV ÷ (1 + IGV); con IGV, al revés.
//   Precio referencial = promedio sin IGV de los proveedores del bien.
// La alerta de viabilidad (precio referencial por debajo de nuestro costo) es de USO INTERNO: la
// calcula oferta.js con el costo propio y solo se muestra en la pestaña Oferta; no se exporta.
// Se guarda en los datos de Documentos (datos.cotizaciones), sin migración nueva.
// ============================================================================

export const BIENES_COTIZACION = { kit: 'Kit (mesa + silla del estudiante)', mesa: 'Mesa del estudiante', silla: 'Silla del estudiante', esc: 'Escritorio docente', sdoc: 'Silla docente', arm: 'Armario / estante' };
export const MIN_PROVEEDORES = 3;
const NIVELES = ['I', 'P', 'S', 'E'];
const txt = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = v => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1e7 ? Math.round(n * 100) / 100 : null; };
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

function limpiarFila(f) {
  if (!f || typeof f !== 'object') return null;
  const x = {
    proveedor: txt(f.proveedor, 150), bien: BIENES_COTIZACION[f.bien] ? f.bien : 'kit',
    precio_con_igv: num(f.precio_con_igv), precio_sin_igv: num(f.precio_sin_igv),
    material: txt(f.material, 150), especificacion: txt(f.especificacion, 500),
    transporte_incluido: f.transporte_incluido === true || f.transporte_incluido === 'si',
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(f.fecha || '')) ? f.fecha : null
  };
  return x.proveedor || x.precio_con_igv != null || x.precio_sin_igv != null ? x : null;
}
/** { [nivel]: [fila] } válido; lo desconocido se descarta */
export function limpiarCotizaciones(b) {
  const out = {};
  for (const n of NIVELES) {
    const fs = (Array.isArray(b?.[n]) ? b[n] : []).slice(0, 100).map(limpiarFila).filter(Boolean);
    if (fs.length) out[n] = fs;
  }
  return out;
}

/**
 * Cuadro comparativo de un nivel: precios con y sin IGV, promedio por bien y lo que falta.
 * @returns { bienes: [{ k, nombre, filas, proveedores, promedio_sin_igv, promedio_con_igv, min, max, suficiente }], avisos }
 */
export function cuadroCotizaciones(filas = [], igvPct = 18) {
  const f = 1 + igvPct / 100, g = new Map();
  for (const x of filas) {
    const sin = x.precio_sin_igv ?? (x.precio_con_igv != null ? r2(x.precio_con_igv / f) : null);
    const con = x.precio_con_igv ?? (x.precio_sin_igv != null ? r2(x.precio_sin_igv * f) : null);
    if (!g.has(x.bien)) g.set(x.bien, []);
    g.get(x.bien).push({ ...x, sin, con, sin_calculado: x.precio_sin_igv == null && sin != null });
  }
  const bienes = Object.keys(BIENES_COTIZACION).filter(k => g.has(k)).map(k => {
    const fs = g.get(k), con = fs.filter(x => x.sin != null), prov = new Set(con.map(x => x.proveedor.toLowerCase()).filter(Boolean)).size;
    const prom = con.length ? r2(con.reduce((a, x) => a + x.sin, 0) / con.length) : null;
    return { k, nombre: BIENES_COTIZACION[k], filas: fs, proveedores: prov, promedio_sin_igv: prom, promedio_con_igv: prom == null ? null : r2(prom * f),
      min: con.length ? Math.min(...con.map(x => x.sin)) : null, max: con.length ? Math.max(...con.map(x => x.sin)) : null, suficiente: prov >= MIN_PROVEEDORES };
  });
  const avisos = bienes.filter(b => !b.suficiente).map(b => ({ tipo: 'cotizaciones', texto: `${b.nombre}: ${b.proveedores} ${b.proveedores === 1 ? 'proveedor' : 'proveedores'}; se piden al menos ${MIN_PROVEEDORES} cotizaciones por nivel.` }));
  for (const b of bienes) for (const x of b.filas) if (!x.fecha || !x.especificacion) avisos.push({ tipo: 'cotizaciones', texto: `${b.nombre} · ${x.proveedor || 'sin proveedor'}: falta ${[!x.fecha && 'la fecha', !x.especificacion && 'la especificación técnica'].filter(Boolean).join(' y ')}.` });
  return { bienes, avisos };
}

/**
 * USO INTERNO (pestaña Oferta): el precio referencial de cada bien frente a nuestro costo unitario
 * (fabricación + embalaje + transporte + instalación por pieza; el kit son 2 piezas).
 * @param cuadro  cuadroCotizaciones()
 * @param oferta  limpiarOferta()
 */
export function viabilidadCotizaciones(cuadro, oferta) {
  const porPieza = (oferta.embalaje ?? 0) + (oferta.transporte_base ?? 0) + (oferta.instalacion ?? 0);
  const fab = oferta.fabricacion || {};
  return cuadro.bienes.map(b => {
    const costo = b.k === 'kit' ? (fab.mesa == null || fab.silla == null ? null : fab.mesa + fab.silla + 2 * porPieza) : fab[b.k] == null ? null : fab[b.k] + porPieza;
    const bajo = costo != null && b.promedio_sin_igv != null && b.promedio_sin_igv < costo;
    return { k: b.k, nombre: b.nombre, referencial: b.promedio_sin_igv, costo: costo == null ? null : r2(costo), bajo,
      texto: costo == null ? `${b.nombre}: falta el costo de fabricación para comparar.` : b.promedio_sin_igv == null ? `${b.nombre}: sin precios cotizados.`
        : bajo ? `ALERTA de viabilidad: ${b.nombre}, el precio referencial (S/ ${b.promedio_sin_igv.toFixed(2)} sin IGV) queda por debajo de nuestro costo (S/ ${costo.toFixed(2)}).`
          : `${b.nombre}: el precio referencial (S/ ${b.promedio_sin_igv.toFixed(2)}) cubre nuestro costo (S/ ${costo.toFixed(2)}).` };
  });
}
