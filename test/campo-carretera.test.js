// Visitas de campo: distancias por carretera (OpenRouteService) y plan de visitas con ellas
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matrizOrs, distanciasCarretera, carreteraProyecto, clavePar, URL_ORS, MAX_COLEGIOS_CARRETERA, AVISO_MIGRACION_CARRETERA } from '../src/selector-ioarr/carretera.js';
import { agruparVisitas, conDesvio } from '../src/selector-ioarr/visitas.js';
import { haversine } from '../src/selector-ioarr/cercania.js';
import { crearApiCampo } from '../src/selector-ioarr/campo.js';
import { supabaseMemoria } from './helpers/supabase-memoria.js';

// Puntos en una línea, a ~1,1 km uno del otro
const fila = (n, pre = 'C') => Array.from({ length: n }, (_, i) => ({ cod: `${pre}${String(i).padStart(3, '0')}`, lat: -17.1 - i * 0.01, lon: -70.9 }));

// ORS simulado: distancia = 1,5 × línea recta; `sinVia`: puntos que no están cerca de ninguna vía (error 6010)
function orsFalso({ sinVia = [], fallaDesde = Infinity, factor = 1.5 } = {}) {
  const pedidos = [];
  const f = async (url, opts) => {
    assert.equal(url, URL_ORS);
    assert.equal(opts.headers.Authorization, 'clave-ors');
    const b = JSON.parse(opts.body);
    pedidos.push(b);
    assert.deepEqual(b.metrics, ['distance']); assert.equal(b.units, 'km');
    assert.ok(b.locations.length <= 50, 'hasta 50 lugares por pedido');
    if (pedidos.length > fallaDesde) return { ok: false, status: 429, json: async () => ({ error: 'Rate Limit Exceeded' }) };
    const malo = b.locations.findIndex(([lon, lat]) => sinVia.some(p => p.lat === lat && p.lon === lon));
    if (malo >= 0) return { ok: false, status: 404, json: async () => ({ error: { code: 6010, message: `Could not find routable point within a radius of 350.0 meters of specified coordinate ${malo}: ${b.locations[malo].join(' ')}.` } }) };
    const distances = b.locations.map(([o1, a1]) => b.locations.map(([o2, a2]) => haversine(a1, o1, a2, o2) * factor));
    return { ok: true, status: 200, json: async () => ({ distances }) };
  };
  return { f, pedidos };
}

test('matrizOrs: un colegio lejos de cualquier vía se saca y sus pares quedan sin ruta', async () => {
  const ps = fila(4), ors = orsFalso({ sinVia: [ps[2]] });
  const m = await matrizOrs(ps, { key: 'clave-ors', fetch: ors.f });
  assert.equal(ors.pedidos.length, 2);
  assert.equal(ors.pedidos[1].locations.length, 3);
  assert.equal(m[0][2], null); assert.equal(m[2][3], null);
  assert.ok(Math.abs(m[0][3] - 1.5 * haversine(ps[0].lat, ps[0].lon, ps[3].lat, ps[3].lon)) < 1e-9);
  assert.equal(m[1][1], 0);
});

test('matrizOrs: la API real responde 200 con null para el punto que no está cerca de ninguna vía', async () => {
  // Respuesta real de api.heigit.org (26/11/2026) con un punto en el lago Titicaca en el medio
  const f = async () => ({ ok: true, status: 200, json: async () => ({ destinations: [{ snapped_distance: 1.66 }, null, { snapped_distance: 5.5 }],
    distances: [[0, null, 56.79], [null, null, null], [56.79, null, 0]] }) });
  const m = await matrizOrs(fila(3), { key: 'k', fetch: f });
  assert.deepEqual(m, [[0, null, 56.79], [null, null, null], [56.79, null, 0]]);
});

test('matrizOrs: otro error (límite de consultas) se lanza con el estado', async () => {
  const ors = orsFalso({ fallaDesde: 0 });
  await assert.rejects(matrizOrs(fila(3), { key: 'clave-ors', fetch: ors.f }), e => e.status === 429 && /429/.test(e.message));
});

test('distanciasCarretera: por bloques de 25, se guarda en Supabase y no se vuelve a pedir', async () => {
  const sb = supabaseMemoria({ campo_distancias: [] }), ps = fila(30), ors = orsFalso();
  const r = await distanciasCarretera(sb, ps, { key: 'clave-ors', fetch: ors.f });
  assert.equal(r.incompleto, false);
  assert.equal(Object.keys(r.pares).length, 30 * 29 / 2);
  // bloques [0-24] y [25-29]: el primero consigo mismo y los dos juntos (que ya trae los pares del segundo)
  assert.equal(ors.pedidos.length, 2);
  const fila0 = sb.from('campo_distancias');
  const { data } = await fila0.select('*');
  assert.equal(data.length, 435);
  assert.ok(data.every(d => d.cod_a < d.cod_b), 'el código menor primero');
  // otra vez, con uno nuevo: solo se piden sus pares
  const r2 = await distanciasCarretera(sb, [...ps, { cod: 'Z999', lat: -17.5, lon: -70.9 }], { key: 'clave-ors', fetch: ors.f });
  assert.equal(Object.keys(r2.pares).length, 31 * 30 / 2);
  assert.equal(ors.pedidos.length, 3, 'solo los bloques con pares nuevos: un pedido más');
  assert.ok(r2.pares[clavePar('Z999', 'C000')] > 0);
});

test('distanciasCarretera: el colegio sin vía queda «sin ruta» (null); si ORS se corta, devuelve lo que tiene', async () => {
  const ps = fila(4), sb = supabaseMemoria({ campo_distancias: [] });
  const r = await distanciasCarretera(sb, ps, { key: 'clave-ors', fetch: orsFalso({ sinVia: [ps[1]] }).f });
  assert.equal(r.pares[clavePar('C000', 'C001')], null);
  assert.ok(r.pares[clavePar('C000', 'C002')] > 0);
  // 30 colegios y ORS falla en el segundo pedido: incompleto, con el primer bloque guardado
  const sb2 = supabaseMemoria({ campo_distancias: [] });
  const r2 = await distanciasCarretera(sb2, fila(30), { key: 'clave-ors', fetch: orsFalso({ fallaDesde: 1 }).f });
  assert.equal(r2.incompleto, true); assert.match(r2.error, /429/);
  assert.equal(Object.keys(r2.pares).length, 25 * 24 / 2);
});

test('carreteraProyecto: sin clave, sin proyecto, demasiados colegios, sin la migración', async () => {
  const ps = fila(5), sb = supabaseMemoria({ campo_distancias: [] });
  const deps = {
    key: 'clave-ors', fetch: orsFalso().f,
    proyectoCampo: async (_, u, id) => id === 'p1' ? { id: 'p1', region: 'Moquegua', locales: u.rol === 'supervisor' ? ['C000', 'C001', 'C002'] : ps.map(p => p.cod) } : null,
    ubicaciones: async (region, cods) => { assert.equal(region, 'Moquegua'); return ps.filter(p => cods.includes(p.cod)); }
  };
  const sinClave = await carreteraProyecto(sb, { rol: 'supervisor' }, 'p1', null, { ...deps, key: '' });
  assert.equal(sinClave.body.disponible, false); assert.match(sinClave.body.aviso, /ORS_API_KEY/);
  assert.equal((await carreteraProyecto(sb, { rol: 'supervisor' }, 'otro', null, deps)).status, 404);
  // el supervisor: solo sus colegios, aunque pida otros
  const sup = await carreteraProyecto(sb, { rol: 'supervisor' }, 'p1', 'C000,C003,C004', deps);
  assert.deepEqual(Object.keys(sup.body.pares), []);
  const sup2 = await carreteraProyecto(sb, { rol: 'supervisor' }, 'p1', null, deps);
  assert.deepEqual(Object.keys(sup2.body.pares).sort(), ['C000|C001', 'C000|C002', 'C001|C002']);
  // el proveedor, los que pida del proyecto
  const prov = await carreteraProyecto(sb, { rol: 'proveedor' }, 'p1', 'C003,C004,X1', deps);
  assert.deepEqual(Object.keys(prov.body.pares), ['C003|C004']);
  const muchos = Array.from({ length: MAX_COLEGIOS_CARRETERA + 1 }, (_, i) => 'M' + i);
  const grande = await carreteraProyecto(sb, { rol: 'proveedor' }, 'p1', null, { ...deps, proyectoCampo: async () => ({ id: 'p1', region: 'Moquegua', locales: muchos }) });
  assert.equal(grande.status, 400);
  const sinTabla = { from: () => { const q = { select: () => q, in: () => q, order: () => q, range: () => Promise.resolve({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.campo_distancias'" } }) }; return q; } };
  const r = await carreteraProyecto(sinTabla, { rol: 'proveedor' }, 'p1', 'C000,C001', deps);
  assert.equal(r.body.disponible, false); assert.equal(r.body.aviso, AVISO_MIGRACION_CARRETERA);
});

test('API: GET /proyectos/:id/carretera está y, sin ORS_API_KEY, responde que no hay carretera', async () => {
  const api = crearApiCampo(supabaseMemoria({}), { ubicaciones: async () => [], orsKey: '' });
  const capa = api.stack.find(l => l.route?.path === '/proyectos/:id/carretera' && l.route.methods.get);
  assert.ok(capa);
  const body = await new Promise((ok, mal) => {
    const res = { status() { return res; }, json: ok };
    capa.route.stack[0].handle({ usuario: { id: 'u', rol: 'supervisor' }, params: { id: 'p1' }, query: {} }, res, mal);
  });
  assert.equal(body.disponible, false);
});

// ─── Plan con distancias por carretera ──────────────────────────────────────
test('agrupar con carretera: el colegio cercano en línea recta pero lejos por carretera no entra al día', async () => {
  // A1-A4 juntos; C está a ~7 km en línea recta de ellos, pero a 40 km por carretera (hay un cerro)
  const A = [0, 1, 2, 3].map(i => ({ cod: 'A' + i, lat: -17.0 - i * 0.005, lon: -70.9 }));
  const C = { cod: 'C', lat: -17.0, lon: -70.835 };
  assert.ok(haversine(A[0].lat, A[0].lon, C.lat, C.lon) < 8);
  const km = (a, b) => (a === 'C' || b === 'C') ? 40 : haversine(...[a, b].map(c => A.find(p => p.cod === c)).flatMap(p => [p.lat, p.lon])) * 1.2;
  const linea = agruparVisitas([...A, C], 8, { maxKm: 10 });
  assert.equal(linea.length, 1, 'en línea recta, C entra al día');
  assert.equal(linea[0].carretera, false);
  const carr = agruparVisitas([...A, C], 8, { maxKm: 10, km });
  assert.equal(carr.length, 2, 'por carretera, C va a otro día');
  const dia = carr.find(d => d.puntos.some(p => p.cod === 'A0'));
  assert.deepEqual(dia.puntos.map(p => p.cod).sort(), ['A0', 'A1', 'A2', 'A3']);
  assert.equal(dia.carretera, true); assert.equal(dia.aprox, false);
  // km del día y de cada tramo, por carretera
  const tramos = dia.puntos.slice(0, -1).map(p => p.kmSig);
  assert.ok(Math.abs(dia.km - tramos.reduce((a, b) => a + b, 0)) < 1e-9);
  assert.ok(dia.puntos.slice(0, -1).every(p => p.carrSig && p.kmSig > p.lineaSig));
  assert.equal(dia.puntos.at(-1).kmSig, null);
});

test('agrupar con carretera: los pares sin dato van en línea recta y el día queda «aprox»', () => {
  const ps = fila(3);
  const km = (a, b) => (a === 'C002' || b === 'C002') ? null : 1.5;
  const [d] = agruparVisitas(ps, 8, { km });
  assert.equal(d.carretera, true); assert.equal(d.aprox, true);
  const sin = d.puntos.find(p => p.kmSig != null && !p.carrSig);
  assert.ok(sin); assert.ok(Math.abs(sin.kmSig - sin.lineaSig) < 1e-9);
});

test('agrupar sin carretera: el mismo resultado que antes, con los km de cada tramo en línea recta', () => {
  const ps = fila(12);
  const a = agruparVisitas(ps, 5, { maxKm: 10 }), b = agruparVisitas(ps, 5, { maxKm: 10, km: () => undefined });
  assert.deepEqual(a.map(d => d.puntos.map(p => p.cod)), b.map(d => d.puntos.map(p => p.cod)));
  for (const d of a) {
    assert.equal(d.carretera, false); assert.equal(d.aprox, false);
    d.puntos.slice(0, -1).forEach((p, j) => assert.ok(Math.abs(p.kmSig - haversine(p.lat, p.lon, d.puntos[j + 1].lat, d.puntos[j + 1].lon)) < 1e-9));
  }
});

test('conDesvio: más del doble y al menos 5 km más', () => {
  assert.equal(conDesvio(40, 7), true);
  assert.equal(conDesvio(8, 3), true);
  assert.equal(conDesvio(7, 3), false, 'más del doble, pero solo 4 km más');
  assert.equal(conDesvio(13, 7), false);
  assert.equal(conDesvio(null, 7), false);
});

test('campo: la página pide la carretera, la guarda en el equipo y la pasa al worker', () => {
  const js = readFileSync(new URL('../src/public/campo.js', import.meta.url), 'utf8');
  assert.match(js, /\/carretera\$\{q\}/);
  assert.match(js, /store\(claveCarretera\(\), \{ pares \}\)/);
  assert.match(js, /w\('carretera', \{ pares \}\)/);
  const wk = readFileSync(new URL('../src/public/selector-ioarr-worker.js', import.meta.url), 'utf8');
  assert.match(wk, /km: carretera \? kmCarretera : null/);
  const sql = readFileSync(new URL('../supabase/migrations/038_campo_distancias.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.campo_distancias/);
  assert.match(sql, /enable row level security/);
});
