// ============================================================================
// src/selector-ioarr/niveles.js — Una IOARR o una IOARR por nivel educativo
//
// La norma permite una reposición masiva en varias UP si los activos son
// homogéneos y el servicio y la entidad son los mismos, pero no aclara si
// Inicial, Primaria y Secundaria cuentan como un mismo servicio (pendiente de
// confirmar con la OPMI). Un expediente de Huánuco (2023) presentó tres IOARR,
// una por nivel. Por eso el proyecto elige:
//   'por_nivel' (por defecto) · una IOARR por nivel, cada una con sus locales,
//                               su metrado y su total
//   'una'                     · una sola IOARR con todos los niveles
//
// Un local con varios niveles entra en cada IOARR solo con lo de ese nivel:
// sus estudiantes (padrón) y sus aulas (censo) de los servicios de ese nivel.
//
// Inventario verificado (ioarr_expediente_inventario): una fila por local con la
// visita, el sustento y los archivos. En un local con un solo nivel, las
// cantidades van en bienes / adquisicion. En uno con varios niveles, van por
// nivel en por_nivel: { P: { bienes, adquisicion }, S: { … } } (migración 018).
// Lo que se cargó antes sin nivel en un local con varios niveles se marca
// «sin nivel»: vale para la IOARR única, no para las IOARR por nivel.
// ============================================================================

import { NIVN, calc } from './calculo.js';
import { TIPOS, censoLocal } from './costos.js';

export const MODOS = { por_nivel: 'Una IOARR por nivel', una: 'Una IOARR' };
export const MODO_DEF = 'por_nivel';
export const ORDEN = ['I', 'P', 'S', 'E'];
export const NOMBRE_NIVEL = NIVN;   // { I: 'Inicial', P: 'Primaria', S: 'Secundaria', E: 'Básica Especial' }
export const modoDe = p => p?.modo_ioarr === 'una' ? 'una' : MODO_DEF;
export const ordenar = ns => [...new Set(ns)].sort((a, b) => ORDEN.indexOf(a) - ORDEN.indexOf(b));

// Niveles de un local (según sus servicios en el padrón)
export const nivelesDeLocal = (D, i) => ordenar(D.locSvc[i].map(si => D.svcs[si][2]));

// Vista del padrón con solo los servicios y las aulas de un nivel. Se usa en lugar
// de D en calc (con el mismo nivel), costear, armarModelo y los Excel.
export function vistaNivel(D, nivel) {
  D._vistas ??= {};
  if (D._vistas[nivel]) return D._vistas[nivel];
  const V = Object.create(D), nL = D.locs.length;
  V.nivel = nivel;
  V.locSvc = D.locSvc.map(ss => ss.filter(si => D.svcs[si][2] === nivel));
  V.locAul = D.locAul.map(as => as.filter(ai => D.svcs[D.aulas[ai][1]][2] === nivel));
  V.locEst = new Int32Array(nL); V.locSec = new Int32Array(nL); V.locNiv = new Uint8Array(nL); V.locGes = new Uint8Array(nL);
  V.locName = new Array(nL);
  for (let i = 0; i < nL; i++) {
    const names = [];
    for (const si of V.locSvc[i]) {
      const s = D.svcs[si];
      V.locEst[i] += s[6]; V.locSec[i] += s[5]; V.locNiv[i] = D.locNiv[i] & ({ I: 1, P: 2, S: 4, E: 8 }[nivel]); V.locGes[i] |= 1 << s[4];
      if (!names.includes(s[1])) names.push(s[1]);
    }
    V.locName[i] = names.join(' / ') || D.locName[i];
  }
  D._vistas[nivel] = V;
  return V;
}

// Niveles presentes en una lista de locales, con la vista, el cálculo y los locales de cada uno
export function porNivel(D, P, list) {
  const ns = ordenar(list.flatMap(i => nivelesDeLocal(D, i)));
  return ns.map(n => {
    const V = vistaNivel(D, n);
    return { nivel: n, nombre: NOMBRE_NIVEL[n], D: V, C: calc(V, P, n), list: list.filter(i => V.locSvc[i].length) };
  });
}

// ─── Inventario verificado ───────────────────────────────────────────────────
// Lo cargado para un nivel en una fila (por_nivel tiene prioridad; en un local
// de un solo nivel también vale lo de bienes / adquisicion)
function delNivel(fila, nivel, unSoloNivel) {
  const pn = fila.por_nivel?.[nivel] || {};
  if (unSoloNivel) return { bienes: { ...(fila.bienes || {}), ...(pn.bienes || {}) }, adquisicion: { ...(fila.adquisicion || {}), ...(pn.adquisicion || {}) } };
  return { bienes: pn.bienes || {}, adquisicion: { ...(fila.adquisicion || {}), ...(pn.adquisicion || {}) } };
}
const tieneNiveles = fila => Object.values(fila.por_nivel || {}).some(x => Object.keys(x?.bienes || {}).length || Object.keys(x?.adquisicion || {}).length);
// Local con varios niveles y cantidades cargadas sin nivel (antes de la migración 018)
export const sinNivel = (fila, niveles) => niveles.length > 1 && Object.keys(fila.bienes || {}).length > 0 && !tieneNiveles(fila);

/**
 * Inventario para costear() de una IOARR de un nivel: { [codLocal]: { ...fila, bienes, adquisicion } }
 * @param inv   { [codLocal]: fila } (con archivos)
 */
export function inventarioNivel(inv, D, nivel) {
  const out = {}, idx = new Map(D.locs.map((l, i) => [l[0], i]));
  for (const [cod, fila] of Object.entries(inv || {})) {
    const i = idx.get(cod); if (i == null) continue;
    const ns = nivelesDeLocal(D, i); if (!ns.includes(nivel)) continue;
    const x = delNivel(fila, nivel, ns.length === 1);
    // El censo copiado al guardar: el del nivel (en un local de un solo nivel, el del local)
    out[cod] = { ...fila, bienes: x.bienes, adquisicion: x.adquisicion, censo: ns.length === 1 ? fila.censo : fila.censo?._niveles?.[nivel] || null };
  }
  return out;
}

/**
 * Inventario para la IOARR única. En un local con varios niveles cargado por nivel,
 * cada tipo corregido suma lo de campo en los niveles cargados y el censo en los demás;
 * el año de adquisición se promedia según el mobiliario en mal estado de cada nivel.
 * @param Cn  { [nivel]: calc(vistaNivel(D, nivel), P, nivel) }
 */
export function inventarioUna(inv, D, Cn) {
  const out = {}, idx = new Map(D.locs.map((l, i) => [l[0], i]));
  for (const [cod, fila] of Object.entries(inv || {})) {
    const i = idx.get(cod); if (i == null) continue;
    const ns = nivelesDeLocal(D, i);
    if (ns.length < 2 || !tieneNiveles(fila)) { out[cod] = fila; continue; }
    const bienes = {}, adquisicion = {};
    for (const k of TIPOS) {
      const cargados = ns.filter(n => fila.por_nivel?.[n]?.bienes?.[k]);
      if (cargados.length) {
        const s = { b: 0, r: 0, m: 0 };
        for (const n of ns) {
          const v = fila.por_nivel?.[n]?.bienes?.[k] || (Cn[n] ? censoLocal(Cn[n], i)[k] : { b: 0, r: 0, m: 0 });
          s.b += v.b; s.r += v.r; s.m += v.m;
        }
        bienes[k] = s;
      }
      // Año: promedio ponderado por lo que está en mal estado (o simple si no hay)
      const anios = ns.map(n => ({ a: fila.por_nivel?.[n]?.adquisicion?.[k] ?? fila.adquisicion?.[k], m: fila.por_nivel?.[n]?.bienes?.[k]?.m ?? (Cn[n] ? censoLocal(Cn[n], i)[k].m : 0) })).filter(x => x.a);
      if (anios.length) {
        const peso = anios.reduce((a, x) => a + x.m, 0);
        adquisicion[k] = Math.round(peso ? anios.reduce((a, x) => a + x.a * x.m, 0) / peso : anios.reduce((a, x) => a + x.a, 0) / anios.length);
      }
    }
    out[cod] = { ...fila, bienes, adquisicion };
  }
  return out;
}

// Valida por_nivel al guardar: { P: { bienes, adquisicion } } solo con los niveles del local
export function limpiarPorNivel(b, niveles, limpiarInventario, limpiarAdquisicion, anioMax) {
  const out = {};
  for (const n of niveles) {
    const x = b?.[n]; if (!x || typeof x !== 'object') continue;
    const bienes = limpiarInventario(x.bienes), adquisicion = limpiarAdquisicion(x.adquisicion, anioMax);
    if (Object.keys(bienes).length || Object.keys(adquisicion).length) out[n] = { bienes, adquisicion };
  }
  return out;
}
