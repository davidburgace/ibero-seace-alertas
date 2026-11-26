// src/selector-ioarr/carretera.js — Distancias por carretera entre colegios (Visitas de campo).
//
// Las calcula OpenRouteService (matriz de distancias, perfil driving-car, con el mapa de OpenStreetMap)
// y se guardan en Supabase (migración 038, tabla campo_distancias): un par de colegios se pide una sola
// vez, aunque esté en varios proyectos. La app las baja con el proyecto y arma el plan con ellas, también
// sin señal (ver agruparVisitas en visitas.js).
//
// Sin ORS_API_KEY o sin la migración, la app sigue en línea recta. Los pares que ORS no puede unir (un
// colegio lejos de cualquier vía del mapa) se guardan como «sin ruta» (km null) y van en línea recta.
// Si ORS falla a mitad de camino (límite de consultas, caída), se devuelve lo que se tenga y el resto
// se pide la próxima vez.

export const URL_ORS = 'https://api.openrouteservice.org/v2/matrix/driving-car';
export const MAX_COLEGIOS_CARRETERA = 200;   // por pedido (un supervisor rara vez tiene más)
export const BLOQUE = 25;                     // colegios por bloque: dos bloques = 50 lugares = 2 500 celdas (ORS admite 3 500)
export const AVISO_MIGRACION_CARRETERA = 'Falta ejecutar supabase/migrations/038_campo_distancias.sql en Supabase';
const LOTE = 500, TIMEOUT_MS = 25000, MAX_SIN_PUNTO = 8;

// Clave de un par, sin orden: el código menor primero
export const clavePar = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const faltaTabla = e => e?.code === 'PGRST205' || e?.code === '42P01' || /campo_distancias|schema cache|does not exist/i.test(e?.message || '');

/**
 * Matriz de distancias (km) de ORS entre hasta 50 puntos.
 * Si un punto no está cerca de ninguna vía, ORS rechaza todo el pedido (código 6010) y dice cuál es:
 * se saca ese punto y se pide de nuevo. Sus pares quedan en null.
 * @param {Array<{lat, lon}>} puntos
 * @returns {Promise<Array<Array<number|null>>>} m[i][j] = km de i a j (null = sin ruta)
 */
export async function matrizOrs(puntos, { key, fetch: f = globalThis.fetch } = {}) {
  const n = puntos.length, m = Array.from({ length: n }, () => Array(n).fill(null));
  let activos = puntos.map((_, i) => i);
  for (let intento = 0; intento <= MAX_SIN_PUNTO && activos.length > 1; intento++) {
    const r = await f(URL_ORS, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ locations: activos.map(i => [puntos[i].lon, puntos[i].lat]), metrics: ['distance'], units: 'km' }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(j.distances)) {
      activos.forEach((a, x) => activos.forEach((b, y) => { const v = j.distances[x]?.[y]; m[a][b] = Number.isFinite(v) ? v : null; }));
      return m;
    }
    const msg = String(j?.error?.message || j?.error || j?.message || '');
    const sinPunto = (j?.error?.code === 6010 || /routable point|point not found/i.test(msg)) && msg.match(/coordinate (\d+)/i);
    if (sinPunto && activos[+sinPunto[1]] != null) { activos = activos.filter((_, x) => x !== +sinPunto[1]); continue; }
    const e = new Error(`OpenRouteService respondió ${r.status}${msg ? ': ' + msg : ''}`);
    e.status = r.status;
    throw e;
  }
  return m;
}

// Pares guardados entre esos códigos: Map clave → km (null = sin ruta)
async function leerPares(sb, cods) {
  const out = new Map();
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from('campo_distancias').select('cod_a, cod_b, km')
      .in('cod_a', cods).in('cod_b', cods).order('cod_a').order('cod_b').range(i, i + 999);
    if (error) throw error;
    for (const r of data) out.set(clavePar(r.cod_a, r.cod_b), r.km == null ? null : Number(r.km));
    if (data.length < 1000) return out;
  }
}

const enCurso = new Map();   // mismo conjunto de colegios pedido dos veces a la vez: un solo cálculo

/**
 * Distancias por carretera entre todos los pares de esos colegios: las guardadas y, las que falten, de ORS.
 * @param {Array<{cod, lat, lon}>} puntos colegios con coordenadas (hasta MAX_COLEGIOS_CARRETERA)
 * @returns {Promise<{ pares: Object<string, number|null>, incompleto: boolean, error?: string }>}
 */
export function distanciasCarretera(sb, puntos, opc = {}) {
  const clave = puntos.map(p => p.cod).sort().join(',');
  if (!enCurso.has(clave)) enCurso.set(clave, calcular(sb, puntos, opc).finally(() => enCurso.delete(clave)));
  return enCurso.get(clave);
}

async function calcular(sb, puntos, { key, fetch: f } = {}) {
  const ps = [...new Map(puntos.map(p => [p.cod, p])).values()].sort((a, b) => (a.cod < b.cod ? -1 : 1));
  const guardados = await leerPares(sb, ps.map(p => p.cod));
  const nuevos = new Map();
  let incompleto = false, error;
  const falta = (a, b) => a.cod !== b.cod && !guardados.has(clavePar(a.cod, b.cod)) && !nuevos.has(clavePar(a.cod, b.cod));
  const bloques = [];
  for (let i = 0; i < ps.length; i += BLOQUE) bloques.push(ps.slice(i, i + BLOQUE));
  // Cada par de bloques (y cada bloque consigo mismo) en un pedido, solo si le falta algún par
  for (let i = 0; i < bloques.length && !incompleto; i++) {
    for (let k = i; k < bloques.length; k++) {
      const A = bloques[i], B = bloques[k];
      if (!A.some(a => B.some(b => falta(a, b)))) continue;
      const lugares = i === k ? A : [...A, ...B];
      let m;
      try { m = await matrizOrs(lugares, { key, fetch: f }); }
      catch (e) { incompleto = true; error = e.message; break; }
      lugares.forEach((a, x) => lugares.forEach((b, y) => {
        if (y <= x || !falta(a, b)) return;
        // La carretera puede no ser igual de ida y de vuelta (vías de un sentido): se queda la más corta
        const vs = [m[x][y], m[y][x]].filter(Number.isFinite);
        nuevos.set(clavePar(a.cod, b.cod), vs.length ? Math.round(Math.min(...vs) * 1000) / 1000 : null);
      }));
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
