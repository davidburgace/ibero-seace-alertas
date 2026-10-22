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
