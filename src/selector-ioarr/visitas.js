// src/selector-ioarr/visitas.js — Agrupa la selección en días de visita (Selector IOARR).
// Lo usan el Web Worker (servido en /selector-ioarr/visitas.js), el Excel del servidor y las pruebas.
//
// Método (aproximado, en línea recta; no incluye carreteras ni tiempos de viaje):
//   1. Agrupar con capacidad fija: se toma el local sin asignar más alejado del centro
//      de todos, y se le suman los locales sin asignar más cercanos al centro del grupo
//      que se va formando, hasta llenar el día.
//   2. Ruta de cada día por vecino más cercano: empieza en el extremo del grupo
//      (el local más alejado de su centro) y sigue siempre al más cercano sin visitar.
//   3. Los días se ordenan igual, por vecino más cercano entre sus centros, para que
//      días seguidos queden cerca.
import { haversine, localConCoord } from './cercania.js';

export const POR_DIA_DEF = 8, POR_DIA_MIN = 1, POR_DIA_MAX = 50;
export const AVISO_VISITAS = 'Agrupación aproximada por cercanía geográfica. Las distancias son en línea recta y no incluyen carreteras ni tiempos de viaje.';

export function limitarPorDia(v) {
  const n = Math.round(Number(v));
  if (v === '' || v == null || !Number.isFinite(n)) return POR_DIA_DEF;
  return Math.min(POR_DIA_MAX, Math.max(POR_DIA_MIN, n));
}

const centroide = ps => ({ lat: ps.reduce((a, p) => a + p.lat, 0) / ps.length, lon: ps.reduce((a, p) => a + p.lon, 0) / ps.length });
const dist = (a, b) => haversine(a.lat, a.lon, b.lat, b.lon);
// Desempate estable por código, para que el resultado no dependa del orden de entrada
const menor = (a, b, da, db) => da < db || (da === db && a.cod < b.cod);

// Ruta por vecino más cercano desde `inicio`
function ruta(ps, inicio) {
  const out = [inicio], resto = new Set(ps); resto.delete(inicio);
  let act = inicio;
  while (resto.size) {
    let mejor = null, dm = Infinity;
    for (const p of resto) { const d = dist(act, p); if (!mejor || menor(p, mejor, d, dm)) { mejor = p; dm = d; } }
    out.push(mejor); resto.delete(mejor); act = mejor;
  }
  return out;
}
const largo = ps => ps.reduce((a, p, i) => i ? a + dist(ps[i - 1], p) : 0, 0);

/**
 * @param {Array<{cod:string, lat:number, lon:number}>} puntos locales con coordenadas válidas (pueden traer más campos)
 * @param {number} porDia locales por día
 * @returns {Array<{dia:number, km:number, puntos:Array}>} días en orden; cada punto en orden de visita, con `orden` (1…n)
 */
export function agruparVisitas(puntos, porDia) {
  const cap = limitarPorDia(porDia);
  if (!puntos.length) return [];
  const centro = centroide(puntos);
  const libres = new Set(puntos), grupos = [];
  while (libres.size) {
    // semilla: la más alejada del centro de todos
    let semilla = null, ds = -1;
    for (const p of libres) { const d = dist(centro, p); if (!semilla || d > ds || (d === ds && p.cod < semilla.cod)) { semilla = p; ds = d; } }
    const g = [semilla]; libres.delete(semilla);
    let c = { lat: semilla.lat, lon: semilla.lon };
    while (g.length < cap && libres.size) {
      let mejor = null, dm = Infinity;
      for (const p of libres) { const d = dist(c, p); if (!mejor || menor(p, mejor, d, dm)) { mejor = p; dm = d; } }
      g.push(mejor); libres.delete(mejor);
      c = { lat: c.lat + (mejor.lat - c.lat) / g.length, lon: c.lon + (mejor.lon - c.lon) / g.length };
    }
    grupos.push(g);
  }
  // Ruta dentro de cada grupo
  const conRuta = grupos.map(g => {
    const c = centroide(g);
    let ini = g[0], di = -1;
    for (const p of g) { const d = dist(c, p); if (d > di || (d === di && p.cod < ini.cod)) { ini = p; di = d; } }
    const r = ruta(g, ini);
    return { centro: centroide(r), puntos: r, km: largo(r) };
  });
  // Orden de los días: vecino más cercano entre centros, desde el primer grupo formado
  const cs = conRuta.map((g, i) => ({ ...g.centro, cod: String(i).padStart(6, '0'), g }));
  return ruta(cs, cs[0]).map(o => o.g).map((g, i) => ({ dia: i + 1, km: g.km, puntos: g.puntos.map((p, j) => ({ ...p, orden: j + 1 })) }));
}

// ─── Reparto entre supervisores (Visitas de campo) ──────────────────────────
// n colegios entre k supervisores en partes casi iguales: 200 entre 3 → [67, 67, 66]
export function cuotasIguales(n, k) {
  if (!(k > 0)) return [];
  const base = Math.floor(n / k), resto = n - base * k;
  return Array.from({ length: k }, (_, i) => base + (i < resto ? 1 : 0));
}

// Zonas con la capacidad de cada cupo, en ese orden: cada zona empieza en el colegio libre más
// alejado del centro de todos y suma los libres más cercanos al centro de la zona que se va formando
function zonasEnOrden(puntos, cupos, centro) {
  const libres = new Set(puntos);
  return cupos.map(cupo => {
    if (!(cupo > 0) || !libres.size) return [];
    let semilla = null, ds = -1;
    for (const p of libres) { const d = dist(centro, p); if (!semilla || d > ds || (d === ds && p.cod < semilla.cod)) { semilla = p; ds = d; } }
    const g = [semilla]; libres.delete(semilla);
    let c = { lat: semilla.lat, lon: semilla.lon };
    while (g.length < cupo && libres.size) {
      let mejor = null, dm = Infinity;
      for (const p of libres) { const d = dist(c, p); if (!mejor || menor(p, mejor, d, dm)) { mejor = p; dm = d; } }
      g.push(mejor); libres.delete(mejor);
      c = { lat: c.lat + (mejor.lat - c.lat) / g.length, lon: c.lon + (mejor.lon - c.lon) / g.length };
    }
    return g;
  });
}
// Qué tan dispersas quedan: suma de las distancias de cada colegio al centro de su zona
const dispersion = zonas => zonas.reduce((a, z) => { if (!z.length) return a; const c = centroide(z); return a + z.reduce((b, p) => b + dist(c, p), 0); }, 0);
function permutaciones(n) {
  if (n <= 1) return [[...Array(n).keys()]];
  return permutaciones(n - 1).flatMap(p => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)]));
}
const MAX_TRABAJO = 4e7;   // tope de cálculo para probar órdenes (n² por cada orden)

/**
 * Divide los colegios en zonas cercanas, una por supervisor, con la cantidad pedida a cada uno.
 * Qué zona le toca a quién depende del orden en que se forman: se prueban los órdenes posibles
 * de las cantidades (los distintos, mientras el cálculo no sea muy grande) y se queda el más compacto.
 * @param {Array<{cod, lat, lon}>} puntos colegios con coordenadas válidas
 * @param {number[]} cuotas colegios para cada supervisor, en orden (si suman menos, sobran sin asignar)
 * @param {string[]} sinCoord códigos sin coordenadas: completan las zonas que quedaron con lugar, en orden
 * @returns {{ zonas: string[][], sobran: string[] }} códigos de cada zona (en el orden de cuotas) y los que no entraron
 */
export function repartirZonas(puntos, cuotas, sinCoord = []) {
  const k = cuotas.length, n = puntos.length;
  let mejor = null;
  if (n && k) {
    const centro = centroide(puntos);
    const todas = k <= 6 ? permutaciones(k) : [[...Array(k).keys()]];
    const vistas = new Set(), ordenes = [];
    // la primera, el orden pedido; después de mayor a menor; después el resto (sin repetir secuencias de cantidades)
    for (const o of [[...Array(k).keys()], [...Array(k).keys()].sort((a, b) => cuotas[b] - cuotas[a] || a - b), ...todas]) {
      const clave = o.map(i => cuotas[i]).join(',');
      if (!vistas.has(clave)) { vistas.add(clave); ordenes.push(o); }
    }
    const tope = Math.max(1, Math.floor(MAX_TRABAJO / Math.max(1, n * n)));
    for (const o of ordenes.slice(0, tope)) {
      const zs = zonasEnOrden(puntos, o.map(i => cuotas[i]), centro);
      const d = dispersion(zs);
      if (!mejor || d < mejor.d - 1e-9) { const zonas = Array(k); o.forEach((i, j) => { zonas[i] = zs[j]; }); mejor = { d, zonas }; }
    }
  }
  const zonas = mejor ? mejor.zonas.map(z => z.map(p => p.cod)) : cuotas.map(() => []);
  const usados = new Set(zonas.flat());
  const sobran = puntos.filter(p => !usados.has(p.cod)).map(p => p.cod).sort();
  for (const cod of [...sinCoord].sort()) {
    const z = zonas.findIndex((zona, i) => zona.length < (cuotas[i] || 0));
    if (z >= 0) zonas[z].push(cod); else sobran.push(cod);
  }
  return { zonas, sobran };
}

// Puntos de visita a partir de índices de locales. D: prep(); C: calc() (bienes a reponer).
// Devuelve { puntos (con coordenadas válidas), sinCoord (sin coordenadas: no se pueden agrupar) }
export function puntosVisita(D, C, indices) {
  const puntos = [], sinCoord = [];
  for (const i of indices) {
    const l = D.locs[i];
    const p = { i, cod: l[0], nom: D.locName[i], dist: D.dists[l[1]][0], cp: l[3] || '', dir: l[5] || '', lat: l[6], lon: l[7], est: D.locEst[i], rep: C.L.repTot[i] };
    (localConCoord(l) ? puntos : sinCoord).push(p);
  }
  return { puntos, sinCoord };
}

// Color por día: paleta categórica validada, en orden fijo (nunca se repite).
// Con más de 8 días no hay color por día: todos van en gris y se distinguen por el número.
export const COLORES_DIA = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const GRIS_DIA = '#5c6270';
export const colorDia = (dia, total) => total <= COLORES_DIA.length ? COLORES_DIA[dia - 1] : GRIS_DIA;

const xml = s => String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
// KML usa aabbggrr
const kmlColor = (hex, alfa = 'ff') => alfa + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3);

/**
 * KML para Google Earth o Google My Maps: una carpeta por día, con los locales en orden
 * de visita y la ruta aproximada (línea recta entre paradas).
 * @param {Array} dias resultado de agruparVisitas()  @param {object} meta { proyecto, region, porDia }
 */
export function generarKML(dias, meta = {}) {
  const estilos = dias.map(d => {
    const c = colorDia(d.dia, dias.length);
    return `<Style id="dia${d.dia}"><IconStyle><color>${kmlColor(c)}</color><scale>1.1</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LineStyle><color>${kmlColor(c, 'cc')}</color><width>3</width></LineStyle></Style>`;
  }).join('\n');
  const carpetas = dias.map(d => {
    const marcas = d.puntos.map(p => `<Placemark><name>${xml(`Día ${d.dia} · ${p.orden}. ${p.nom}`)}</name><styleUrl>#dia${d.dia}</styleUrl>
<description>${xml(`Local ${p.cod} · ${p.dist}${p.cp ? ' · ' + p.cp : ''}${p.dir ? '\n' + p.dir : ''}\n${p.rep} bienes a reponer`)}</description>
<ExtendedData><Data name="Grupo"><value>Día ${d.dia}</value></Data><Data name="Orden"><value>${p.orden}</value></Data><Data name="Código de local"><value>${xml(p.cod)}</value></Data><Data name="Bienes a reponer"><value>${p.rep}</value></Data></ExtendedData>
<Point><coordinates>${p.lon},${p.lat},0</coordinates></Point></Placemark>`).join('\n');
    const linea = d.puntos.length > 1 ? `<Placemark><name>${xml(`Ruta aproximada del día ${d.dia} (${d.km.toFixed(1)} km en línea recta)`)}</name><styleUrl>#dia${d.dia}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${d.puntos.map(p => `${p.lon},${p.lat},0`).join(' ')}</coordinates></LineString></Placemark>` : '';
    return `<Folder><name>${xml(`Día ${d.dia} — ${d.puntos.length} local${d.puntos.length === 1 ? '' : 'es'}`)}</name>\n${marcas}\n${linea}</Folder>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>${xml(`Plan de visitas — ${meta.proyecto || 'Borrador'} (${meta.region || ''})`)}</name>
<description>${xml(`${meta.porDia || ''} locales por día. ${AVISO_VISITAS}`)}</description>
${estilos}
${carpetas}
</Document></kml>
`;
}

// Ruta de un día en Google Maps, parando en cada local en orden de visita.
// Sale de la ubicación de quien abre el enlace (sin origen) y admite hasta 9 paradas
// intermedias más el destino: con más de 10 locales, el día se parte en tramos y
// cada tramo se abre al terminar el anterior.
export const PARADAS_POR_TRAMO = 10;
export function tramosRutaDia(puntos, max = PARADAS_POR_TRAMO) {
  const ps = puntos.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const coord = p => `${p.lat},${p.lon}`, tramos = [];
  for (let i = 0; i < ps.length; i += max) {
    const t = ps.slice(i, i + max), dest = t[t.length - 1], medio = t.slice(0, -1);
    const url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(coord(dest))
      + (medio.length ? '&waypoints=' + encodeURIComponent(medio.map(coord).join('|')) : '');
    tramos.push({ desde: i + 1, hasta: i + t.length, url });
  }
  return tramos;
}
