// src/selector-ioarr/visitas.js — Agrupa la selección en días de visita (Selector IOARR).
// Lo usan el Web Worker (servido en /selector-ioarr/visitas.js), el Excel del servidor y las pruebas.
//
// Método (aproximado, en línea recta; no incluye carreteras ni tiempos de viaje):
//   1. Armado con capacidad fija: el día 1 empieza en el colegio más cercano al origen (la
//      ubicación del usuario o el centro elegido) y suma los más cercanos al centro del día que
//      se va formando; cada día siguiente empieza cerca de donde terminó el anterior.
//   2. Compactar: se intercambian colegios entre días mientras cada día quede más junto.
//   3. Los días se ordenan desde el origen hacia afuera, y cada día sigue la ruta del vecino
//      más cercano, empezando cerca de donde terminó el anterior.
// Con distancias por carretera (opc.km, Visitas de campo: ver carretera.js), el armado, la distancia
// máxima, el compactado, el orden de visita y los km usan la carretera entre colegios; los pares sin
// dato (o sin ruta) siguen en línea recta y quedan marcados. Sin opc.km, todo es en línea recta.
import { haversine, localConCoord } from './cercania.js';

export const POR_DIA_DEF = 8, POR_DIA_MIN = 1, POR_DIA_MAX = 50;
export const AVISO_VISITAS = 'Agrupación aproximada por cercanía geográfica. Las distancias son en línea recta y no incluyen carreteras ni tiempos de viaje.';
export const AVISO_VISITAS_CARRETERA = 'Agrupación por distancia por carretera entre colegios (OpenRouteService, con el mapa de OpenStreetMap): no incluye tiempos de viaje, y en zonas rurales el mapa puede no tener todas las trochas.';

// Distancia máxima entre dos colegios del mismo día (km). 0 = sin límite
export const MAX_KM_DEF = 10, MAX_KM_MAX = 500;
export function limitarMaxKm(v) {
  if (v === '' || v == null) return MAX_KM_DEF;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return MAX_KM_DEF;
  return n === 0 ? 0 : Math.min(MAX_KM_MAX, Math.max(1, Math.round(n)));
}
const tope = maxKm => (maxKm > 0 ? maxKm : Infinity);

export function limitarPorDia(v) {
  const n = Math.round(Number(v));
  if (v === '' || v == null || !Number.isFinite(n)) return POR_DIA_DEF;
  return Math.min(POR_DIA_MAX, Math.max(POR_DIA_MIN, n));
}

const centroide = ps => ({ lat: ps.reduce((a, p) => a + p.lat, 0) / ps.length, lon: ps.reduce((a, p) => a + p.lon, 0) / ps.length });
const dist = (a, b) => haversine(a.lat, a.lon, b.lat, b.lon);
// Desempate estable por código, para que el resultado no dependa del orden de entrada
const menor = (a, b, da, db) => da < db || (da === db && a.cod < b.cod);

// Distancias entre colegios. km(codA, codB): km por carretera, o null/undefined si no se sabe o no hay
// ruta (entonces, en línea recta). Sin km, todo en línea recta.
function distancias(km) {
  if (!km) return { d: dist, porCarretera: () => false };
  const carr = (a, b) => (a.cod != null && b.cod != null && a.cod !== b.cod ? km(a.cod, b.cod) : null);
  return {
    // Nunca menos que la línea recta: ORS lleva cada colegio a la vía más cercana, y dos colegios vecinos
    // pueden caer en el mismo punto (0 km)
    d: (a, b) => { const v = carr(a, b), l = dist(a, b); return Number.isFinite(v) ? Math.max(v, l) : l; },
    porCarretera: (a, b) => Number.isFinite(carr(a, b))
  };
}
// Promedio de las distancias de x a los colegios de g (sin x ni `sin`); 0 si no queda ninguno
function aGrupo(D, x, g, sin = null) {
  let s = 0, n = 0;
  for (const o of g) if (o !== x && o !== sin) { s += D(x, o); n++; }
  return n ? s / n : 0;
}

// Ruta por vecino más cercano desde `inicio`
function ruta(ps, inicio, D = dist) {
  const out = [inicio], resto = new Set(ps); resto.delete(inicio);
  let act = inicio;
  while (resto.size) {
    let mejor = null, dm = Infinity;
    for (const p of resto) { const d = D(act, p); if (!mejor || menor(p, mejor, d, dm)) { mejor = p; dm = d; } }
    out.push(mejor); resto.delete(mejor); act = mejor;
  }
  return out;
}

// Compactar: intercambia colegios entre días mientras baje la suma de las distancias de cada
// colegio al centro de su día (cada día conserva su cantidad). Corrige los colegios sueltos
// que el armado deja para los últimos días.
const MAX_PASADAS = 40, MAX_PARES = 6e7;
// Con carretera (porMiembros), «el centro del día» no existe: se usa el promedio de la distancia a los
// demás colegios del día.
function compactar(grupos, maxKm = Infinity, D = dist, porMiembros = false) {
  // ¿q puede entrar al día g en lugar de p sin pasar la distancia máxima?
  const cabe = (q, g, p) => maxKm === Infinity || g.every(o => o === p || D(o, q) <= maxKm);
  const cs = grupos.map(centroide);
  const dueño = new Map(); grupos.forEach((g, k) => g.forEach(p => dueño.set(p, k)));
  const todos = grupos.flat(), n = todos.length;
  const pasadas = Math.max(1, Math.min(MAX_PASADAS, Math.floor(MAX_PARES / Math.max(1, n * n))));
  const recalc = k => { cs[k] = centroide(grupos[k]); };
  for (let pas = 0; pas < pasadas; pas++) {
    let mejoro = false;
    for (let a = 0; a < n; a++) {
      const p = todos[a], A = dueño.get(p);
      for (let b = a + 1; b < n; b++) {
        const q = todos[b], B = dueño.get(q);
        if (A === B) continue;
        const delta = porMiembros
          ? aGrupo(D, p, grupos[B], q) + aGrupo(D, q, grupos[A], p) - aGrupo(D, p, grupos[A]) - aGrupo(D, q, grupos[B])
          : dist(p, cs[B]) + dist(q, cs[A]) - dist(p, cs[A]) - dist(q, cs[B]);
        if (delta < -1e-6 && cabe(q, grupos[A], p) && cabe(p, grupos[B], q)) {
          grupos[A][grupos[A].indexOf(p)] = q; grupos[B][grupos[B].indexOf(q)] = p;
          dueño.set(p, B); dueño.set(q, A); recalc(A); recalc(B);
          mejoro = true; break;   // p cambió de día: sigue con el próximo colegio
        }
      }
    }
    if (!mejoro) break;
  }
  return grupos;
}

/**
 * @param {Array<{cod:string, lat:number, lon:number}>} puntos locales con coordenadas válidas (pueden traer más campos)
 * @param {number} porDia locales por día
 * @param {{ origen?: {lat:number, lon:number}, maxKm?: number }} [opc] origen: desde dónde se sale (la ubicación o el centro elegido):
 *        el día 1 empieza en el colegio más cercano al origen y los días siguientes se van alejando.
 *        Sin origen, se empieza en el colegio más alejado del centro de todos (un extremo de la zona).
 *        maxKm: distancia máxima entre dos colegios del mismo día (0 = sin límite); con ella, «porDia» es
 *        un máximo y un día puede cerrarse con menos colegios.
 *        km(codA, codB): km por carretera entre dos colegios (null/undefined = sin dato: en línea recta).
 * @returns {Array<{dia, km, carretera, aprox, puntos}>} días en orden. km: largo de la ruta del día; carretera: se
 *          usaron distancias por carretera; aprox: algún tramo va en línea recta. Cada punto en orden de visita, con
 *          `orden` (1…n), `kmSig` (km al siguiente; null en el último), `lineaSig` (lo mismo en línea recta) y
 *          `carrSig` (kmSig es por carretera).
 */
export function agruparVisitas(puntos, porDia, { origen = null, maxKm = 0, km = null } = {}) {
  const cap = limitarPorDia(porDia), lim = tope(maxKm);
  const { d: D, porCarretera } = distancias(km), conCarretera = !!km;
  if (!puntos.length) return [];
  // Orden fijo por código: el resultado no depende del orden de entrada
  const ps = [...puntos].sort((a, b) => (a.cod < b.cod ? -1 : a.cod > b.cod ? 1 : 0));
  const centro = centroide(ps);
  const cercano = (ref, conj) => { let m = null, dm = Infinity; for (const p of conj) { const d = dist(ref, p); if (!m || menor(p, m, d, dm)) { m = p; dm = d; } } return m; };
  let ini = origen && Number.isFinite(origen.lat) && Number.isFinite(origen.lon) ? origen : null;
  if (!ini) { let e = null, de = -1; for (const p of ps) { const d = dist(centro, p); if (d > de || (d === de && p.cod < e.cod)) { e = p; de = d; } } ini = e; }
  // 1. Armado: cada día empieza en el colegio libre más cercano a donde terminó el anterior (el
  //    primero, al origen) y suma los libres más cercanos al centro del día que se va formando.
  const libres = new Set(ps), grupos = [];
  let ref = ini;
  while (libres.size) {
    const semilla = cercano(ref, libres);
    const g = [semilla]; libres.delete(semilla);
    let c = { lat: semilla.lat, lon: semilla.lon };
    while (g.length < cap && libres.size) {
      // Sin carretera: el libre más cercano al centro del día; con carretera, el de menor distancia
      // promedio a los colegios del día
      let m = null;
      if (conCarretera) { let dm = Infinity; for (const p of libres) { const d = aGrupo(D, p, g); if (!m || menor(p, m, d, dm)) { m = p; dm = d; } } }
      else m = cercano(c, libres);
      // el día se cierra antes si el colegio más cercano lo separaría demasiado
      if (g.some(p => D(p, m) > lim)) break;
      g.push(m); libres.delete(m);
      c = { lat: c.lat + (m.lat - c.lat) / g.length, lon: c.lon + (m.lon - c.lon) / g.length };
    }
    grupos.push(g); ref = c;
  }
  // 2. Compactar (intercambios entre días)
  compactar(grupos, lim, D, conCarretera);
  // 3. Orden de los días: el primero, el que tiene el colegio más cercano al origen; después, siempre
  //    el día pendiente más cercano al centro del anterior (así se va alejando).
  const pend = new Set(grupos.map((g, k) => k)), orden = [];
  let k0 = 0, d0 = Infinity;
  for (const k of pend) for (const p of grupos[k]) { const d = dist(ini, p); if (d < d0) { d0 = d; k0 = k; } }
  orden.push(k0); pend.delete(k0);
  while (pend.size) {
    const c = centroide(grupos[orden.at(-1)]);
    let km = null, dm = Infinity;
    for (const k of pend) { const d = dist(c, centroide(grupos[k])); if (d < dm) { dm = d; km = k; } }
    orden.push(km); pend.delete(km);
  }
  // 4. Ruta de cada día por vecino más cercano: el día 1 empieza en el colegio más cercano al origen;
  //    los demás, en el más cercano a donde terminó el día anterior.
  let desde = ini;
  return orden.map((k, i) => {
    const r = ruta(grupos[k], desde.cod != null ? cercanoCon(D, desde, grupos[k]) : cercano(desde, grupos[k]), D);
    desde = r.at(-1);
    let total = 0, aprox = false;
    const pts = r.map((p, j) => {
      const s = r[j + 1];
      if (!s) return { ...p, orden: j + 1, kmSig: null, lineaSig: null, carrSig: false };
      const kmSig = D(p, s), carrSig = porCarretera(p, s);
      total += kmSig; if (!carrSig) aprox = true;
      return { ...p, orden: j + 1, kmSig, lineaSig: dist(p, s), carrSig };
    });
    return { dia: i + 1, km: total, carretera: conCarretera, aprox: conCarretera && aprox, puntos: pts };
  });
}

function cercanoCon(D, ref, conj) {
  let m = null, dm = Infinity;
  for (const p of conj) { const d = D(ref, p); if (!m || menor(p, m, d, dm)) { m = p; dm = d; } }
  return m;
}

// Tramo «con desvío»: por carretera es mucho más largo que en línea recta (más del doble y 5 km más, o más)
export const conDesvio = (kmCarretera, kmLinea) => Number.isFinite(kmCarretera) && Number.isFinite(kmLinea)
  && kmCarretera > 2 * kmLinea && kmCarretera - kmLinea >= 5;

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
