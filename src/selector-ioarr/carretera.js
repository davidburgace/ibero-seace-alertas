// src/selector-ioarr/carretera.js — Distancias por carretera entre colegios (Visitas de campo).
//
// Las calcula OpenRouteService (matriz de distancias, perfil driving-car, con el mapa de OpenStreetMap),
// solo entre colegios a menos de RADIO_KM en línea recta, y se guardan en Supabase (migración 038, tabla campo_distancias): un par de colegios se pide una sola
// vez, aunque esté en varios proyectos. La app las baja con el proyecto y arma el plan con ellas, también
// sin señal (ver agruparVisitas en visitas.js).
//
// Sin ORS_API_KEY o sin la migración, la app sigue en línea recta. Los pares que ORS no puede unir (un
// colegio lejos de cualquier vía del mapa) se guardan como «sin ruta» (km null) y van en línea recta.
// Si ORS falla a mitad de camino (límite de consultas, caída) o se llega a MAX_PEDIDOS_ORS, se devuelve
// lo que se tenga (incompleto) y el resto se pide en la próxima llamada (la app la repite al minuto).

import { haversine } from './cercania.js';

// api.openrouteservice.org se apagó en noviembre de 2026: la API sigue en api.heigit.org/openrouteservice
export const URL_ORS = 'https://api.heigit.org/openrouteservice/v2/matrix/driving-car';
export const MAX_COLEGIOS_CARRETERA = 400;   // por llamada (los de un supervisor)
export const RADIO_KM = 30;                   // solo pares a menos de esto en línea recta
export const BLOQUE = 25;                     // orígenes por pedido a ORS
export const MAX_CELDAS = 3500;               // orígenes × destinos por pedido (lo que admite ORS)
export const MAX_PEDIDOS_ORS = 30;            // pedidos a ORS por llamada (ORS admite 40 por minuto)
export const AVISO_MIGRACION_CARRETERA = 'Falta ejecutar supabase/migrations/038_campo_distancias.sql en Supabase';
const LOTE = 500, TIMEOUT_MS = 25000, MAX_SIN_PUNTO = 8;

// Clave de un par, sin orden: el código menor primero
export const clavePar = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const faltaTabla = e => e?.code === 'PGRST205' || e?.code === '42P01' || /campo_distancias|schema cache|does not exist/i.test(e?.message || '');

/**
 * Matriz de distancias (km) de ORS: de cada origen a cada destino (índices de `lugares`; por defecto, todos).
 * ORS admite hasta 3 500 celdas (orígenes × destinos) por pedido. Un punto lejos de cualquier vía vuelve en null;
 * si ORS rechazara el pedido por ese punto (código 6010, «coordinate N»), se saca y se pide de nuevo.
 * @param {Array<{lat, lon}>} lugares
 * @returns {Promise<Array<Array<number|null>>>} m[i][j] = km de i a j (null = sin ruta o no pedido)
 */
export async function matrizOrs(lugares, { key, fetch: f = globalThis.fetch, origenes, destinos } = {}) {
  const n = lugares.length, m = Array.from({ length: n }, () => Array(n).fill(null));
  let fuera = new Set();
  const todos = lugares.map((_, i) => i);
  for (let intento = 0; intento <= MAX_SIN_PUNTO; intento++) {
    const act = todos.filter(i => !fuera.has(i)), pos = new Map(act.map((i, x) => [i, x]));
    const src = (origenes || todos).filter(i => pos.has(i)), dst = (destinos || todos).filter(i => pos.has(i));
    if (!src.length || !dst.length || act.length < 2) return m;
    const r = await f(URL_ORS, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ locations: act.map(i => [lugares[i].lon, lugares[i].lat]), sources: src.map(i => pos.get(i)), destinations: dst.map(i => pos.get(i)), metrics: ['distance'], units: 'km' }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(j.distances)) {
      src.forEach((a, x) => dst.forEach((b, y) => { const v = j.distances[x]?.[y]; m[a][b] = Number.isFinite(v) ? v : null; }));
      return m;
    }
    const msg = String(j?.error?.message || j?.error || j?.message || '');
    const sinPunto = (j?.error?.code === 6010 || /routable point|point not found/i.test(msg)) && msg.match(/coordinate (\d+)/i);
    if (sinPunto && act[+sinPunto[1]] != null) { fuera.add(act[+sinPunto[1]]); continue; }
    const e = new Error(`OpenRouteService respondió ${r.status}${msg ? ': ' + msg : ''}`);
    e.status = r.status;
    throw e;
  }
  return m;
}

// Pares guardados entre esos códigos: Map clave → km (null = sin ruta). Por tramos de códigos, para que
// la consulta no tenga una URL demasiado larga
async function leerPares(sb, cods) {
  const out = new Map(), T = 150;
  for (let x = 0; x < cods.length; x += T) for (let y = x; y < cods.length; y += T) {
    const A = cods.slice(x, x + T), B = cods.slice(y, y + T);
    for (const [ca, cb] of x === y ? [[A, A]] : [[A, B], [B, A]]) {
      for (let i = 0; ; i += 1000) {
        const { data, error } = await sb.from('campo_distancias').select('cod_a, cod_b, km')
          .in('cod_a', ca).in('cod_b', cb).order('cod_a').order('cod_b').range(i, i + 999);
        if (error) throw error;
        for (const r of data) out.set(clavePar(r.cod_a, r.cod_b), r.km == null ? null : Number(r.km));
        if (data.length < 1000) break;
      }
    }
  }
  return out;
}

const enCurso = new Map();   // mismo conjunto de colegios pedido dos veces a la vez: un solo cálculo

/**
 * Distancias por carretera entre los pares de esos colegios que están a menos de RADIO_KM en línea recta
 * (los más lejanos nunca entran al mismo día: por carretera nunca están más cerca): las guardadas y, las
 * que falten, de ORS, hasta MAX_PEDIDOS_ORS pedidos por llamada (el resto, en la próxima: incompleto).
 * @param {Array<{cod, lat, lon}>} puntos colegios con coordenadas (hasta MAX_COLEGIOS_CARRETERA)
 * @returns {Promise<{ pares: Object<string, number|null>, incompleto: boolean, error?: string }>}
 */
export function distanciasCarretera(sb, puntos, opc = {}) {
  const clave = puntos.map(p => p.cod).sort().join(',');
  if (!enCurso.has(clave)) enCurso.set(clave, calcular(sb, puntos, opc).finally(() => enCurso.delete(clave)));
  return enCurso.get(clave);
}

// Orden por cercanía para armar los bloques: franjas de ~11 km de latitud, de oeste a este (en zigzag)
function ordenEspacial(ps) {
  const fr = p => Math.floor(p.lat * 10);
  return [...ps].sort((a, b) => fr(a) - fr(b) || (fr(a) % 2 ? b.lon - a.lon : a.lon - b.lon) || (a.cod < b.cod ? -1 : 1));
}

async function calcular(sb, puntos, { key, fetch: f, radioKm = RADIO_KM, maxPedidos = MAX_PEDIDOS_ORS } = {}) {
  const ps = ordenEspacial([...new Map(puntos.map(p => [p.cod, p])).values()]);
  const guardados = await leerPares(sb, ps.map(p => p.cod).sort());
  const nuevos = new Map();
  let incompleto = false, error, pedidos = 0;
  const falta = (a, b) => a.cod !== b.cod && haversine(a.lat, a.lon, b.lat, b.lon) <= radioKm
    && !guardados.has(clavePar(a.cod, b.cod)) && !nuevos.has(clavePar(a.cod, b.cod));
  // Por cada bloque de colegios vecinos: un pedido con el bloque como orígenes y, como destinos, los colegios
  // a los que les falta algún par con él (en tramos, para no pasar de 3 500 celdas)
  for (let i = 0; i < ps.length && !incompleto; i += BLOQUE) {
    const A = ps.slice(i, i + BLOQUE);
    const dest = ps.filter(p => A.some(a => falta(a, p)));
    const porPedido = Math.floor(MAX_CELDAS / A.length);
    for (let k = 0; k < dest.length; k += porPedido) {
      if (pedidos >= maxPedidos) { incompleto = true; break; }
      const B = dest.slice(k, k + porPedido);
      const lugares = [...new Map([...A, ...B].map(p => [p.cod, p])).values()], idx = new Map(lugares.map((p, x) => [p.cod, x]));
      let m;
      try { pedidos++; m = await matrizOrs(lugares, { key, fetch: f, origenes: A.map(p => idx.get(p.cod)), destinos: B.map(p => idx.get(p.cod)) }); }
      catch (e) { incompleto = true; error = e.message; break; }
      for (const a of A) for (const b of B) {
        if (!falta(a, b)) continue;
        // La carretera puede no ser igual de ida y de vuelta (vías de un sentido): se queda la más corta que se tenga
        const vs = [m[idx.get(a.cod)][idx.get(b.cod)], m[idx.get(b.cod)][idx.get(a.cod)]].filter(Number.isFinite);
        nuevos.set(clavePar(a.cod, b.cod), vs.length ? Math.round(Math.min(...vs) * 1000) / 1000 : null);
      }
    }
  }
  if (nuevos.size) {
    const filas = [...nuevos].map(([c, km]) => { const [cod_a, cod_b] = c.split('|'); return { cod_a, cod_b, km }; });
    for (let i = 0; i < filas.length; i += LOTE) {
      const { error: e } = await sb.from('campo_distancias').upsert(filas.slice(i, i + LOTE), { onConflict: 'cod_a,cod_b' });
      if (e) throw e;
    }
  }
  return { pares: Object.fromEntries([...guardados, ...nuevos]), incompleto, ...(error ? { error } : {}) };
}

/**
 * GET /api/campo/proyectos/:id/carretera?codigos=a,b  (sin codigos: todos los del proyecto que ve el usuario;
 * al supervisor, solo los suyos). Devuelve { disponible, pares, incompleto, error?, aviso? }.
 * deps.ubicaciones(region, codigos) → [{ cod, lat, lon }] los que tienen coordenadas válidas.
 */
export async function carreteraProyecto(sb, usuario, proyectoId, codigos, { proyectoCampo, ubicaciones, key, fetch: f }) {
  if (!key) return { status: 200, body: { disponible: false, pares: {}, aviso: 'Distancias por carretera no configuradas (falta ORS_API_KEY en el servidor).' } };
  const p = await proyectoCampo(sb, usuario, proyectoId);
  if (!p) return { status: 404, body: { error: 'Proyecto no encontrado' } };
  const delProyecto = new Set(p.locales);
  const pedidos = codigos == null || codigos === '' ? p.locales : String(codigos).split(',').map(s => s.trim()).filter(c => delProyecto.has(c));
  const cods = [...new Set(pedidos)];
  if (cods.length > MAX_COLEGIOS_CARRETERA) return { status: 400, body: { error: `Se calculan por carretera hasta ${MAX_COLEGIOS_CARRETERA} colegios a la vez (pediste ${cods.length}).` } };
  const puntos = cods.length > 1 ? await ubicaciones(p.region, cods) : [];
  if (puntos.length < 2) return { status: 200, body: { disponible: true, pares: {}, incompleto: false } };
  try {
    const r = await distanciasCarretera(sb, puntos, { key, fetch: f });
    return { status: 200, body: { disponible: true, ...r } };
  } catch (e) {
    if (faltaTabla(e)) return { status: 200, body: { disponible: false, pares: {}, aviso: AVISO_MIGRACION_CARRETERA } };
    throw e;
  }
}
