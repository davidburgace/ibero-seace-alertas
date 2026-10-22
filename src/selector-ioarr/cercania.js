// src/selector-ioarr/cercania.js — Búsqueda de locales por cercanía (Selector IOARR).
// Lo usan el Web Worker del navegador (servido en /selector-ioarr/cercania.js) y las pruebas.
// Distancias en línea recta (Haversine): no son distancias ni tiempos por carretera.
import { coordValidas } from './calculo.js';

export const N_DEF = 20, N_MIN = 1, N_MAX = 200;
export const MAX_PUNTOS = 500;            // puntos que se dibujan en el mapa como máximo

// Cantidad pedida, entre 1 y 200; vacío o inválido vuelve a 20
export function limitarN(v) {
  const n = Math.round(Number(v));
  if (v === '' || v == null || !Number.isFinite(n)) return N_DEF;
  return Math.min(N_MAX, Math.max(N_MIN, n));
}

const RAD = Math.PI / 180, R_TIERRA = 6371;
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_TIERRA * Math.asin(Math.min(1, Math.sqrt(h)));
}

// locs[i] = [codLocal, iDist, iUgel, centroPoblado, rural, dirección, lat, lon]
export const localConCoord = l => coordValidas(l[6], l[7]);

// Centro de un distrito: promedio de las coordenadas válidas de sus locales (null si no tiene)
export function centroDistrito(D, iDist) {
  let lat = 0, lon = 0, n = 0;
  for (const l of D.locs) if (l[1] === iDist && localConCoord(l)) { lat += l[6]; lon += l[7]; n++; }
  return n ? { lat: lat / n, lon: lon / n, n } : null;
}

// Los n locales más cercanos al centro entre los índices dados (ya filtrados).
// Devuelve { idx, km, omitidos }: idx y km en orden de distancia; omitidos = sin coordenadas válidas.
export function cercanos(D, indices, centro, n) {
  const ds = [];
  for (const i of indices) {
    const l = D.locs[i];
    if (localConCoord(l)) ds.push([haversine(centro.lat, centro.lon, l[6], l[7]), i]);
  }
  ds.sort((a, b) => a[0] - b[0] || D.locs[a[1]][0].localeCompare(D.locs[b[1]][0]));
  const top = ds.slice(0, limitarN(n));
  return { idx: top.map(x => x[1]), km: top.map(x => x[0]), omitidos: indices.length - ds.length };
}

// Radio del punto en el mapa según los bienes a reponer (6 a 15 px)
export const radioPunto = rep => Math.max(6, Math.min(15, 5 + Math.sqrt(Math.max(0, rep || 0))));
