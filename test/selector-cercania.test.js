// Selector IOARR — búsqueda por cercanía, mapa y CSP de la página
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prep, calc, filtrar, totals, FILTRO_VACIO, DEF } from '../src/selector-ioarr/calculo.js';
import { haversine, limitarN, cercanos, centroDistrito, radioPunto, N_DEF, N_MAX } from '../src/selector-ioarr/cercania.js';
import { politicaSelector, cspSelector, ORIGENES_MAPA } from '../src/selector-ioarr/csp.js';
import { LEAFLET_VERSION, RUTA_LEAFLET } from '../src/selector-ioarr/router.js';

const region = r => prep(JSON.parse(readFileSync(new URL(`../src/public/data/selector-ioarr/2025/${r}.json`, import.meta.url), 'utf8')));
const D = region('moquegua'), C = calc(D, DEF);
const iDist = nombre => D.dists.findIndex(d => d[0] === nombre);

test('haversine: distancias conocidas en línea recta', () => {
  assert.equal(haversine(-12, -77, -12, -77), 0);
  // 1 grado de latitud ≈ 111.2 km
  assert.ok(Math.abs(haversine(-12, -77, -13, -77) - 111.19) < 0.05);
  // Lima (Plaza de Armas) → Arequipa (Plaza de Armas) ≈ 765 km en línea recta
  assert.ok(Math.abs(haversine(-12.0464, -77.0428, -16.3988, -71.5369) - 765) < 5);
});

test('limitarN: por defecto 20, entre 1 y 200', () => {
  assert.equal(limitarN(''), N_DEF); assert.equal(limitarN(null), N_DEF); assert.equal(limitarN('abc'), N_DEF);
  assert.equal(limitarN(0), 1); assert.equal(limitarN(-5), 1); assert.equal(limitarN(1), 1);
  assert.equal(limitarN(12.6), 13); assert.equal(limitarN(500), N_MAX); assert.equal(limitarN('200'), 200);
});

test('Moquegua: 20 más cercanos al distrito de Moquegua, ~1.2 km y 7,373 estudiantes', () => {
  const c = centroDistrito(D, iDist('Moquegua'));
  assert.ok(c && c.n > 0);
  const r = cercanos(D, filtrar(D, C, FILTRO_VACIO()), c, 20);
  assert.equal(r.idx.length, 20);
  for (let j = 1; j < r.km.length; j++) assert.ok(r.km[j] >= r.km[j - 1], 'distancias en orden ascendente');
  assert.ok(Math.abs(r.km[19] - 1.2) < 0.05, `el más lejano a ${r.km[19]} km`);
  assert.equal(r.omitidos, 0);
  assert.equal(totals(D, C, r.idx).est, 7373);
});

test('el centro de un distrito es el promedio de sus locales con coordenadas', () => {
  const di = iDist('Moquegua'), ls = D.locs.filter(l => l[1] === di);
  const c = centroDistrito(D, di);
  assert.equal(c.n, ls.length);
  assert.ok(Math.abs(c.lat - ls.reduce((a, l) => a + l[6], 0) / ls.length) < 1e-9);
  assert.ok(Math.abs(c.lon - ls.reduce((a, l) => a + l[7], 0) / ls.length) < 1e-9);
});

test('centro en un local: ese local sale primero a 0 km', () => {
  const l = D.locs[0];
  const r = cercanos(D, filtrar(D, C, FILTRO_VACIO()), { lat: l[6], lon: l[7] }, 5);
  assert.equal(D.locs[r.idx[0]][0], l[0]);
  assert.equal(r.km[0], 0);
});

test('la cercanía se aplica sobre los locales que pasan los filtros', () => {
  const c = centroDistrito(D, iDist('Moquegua'));
  const f = { ...FILTRO_VACIO(), niv: 4 /* Secundaria */, area: 0, est: 100 };
  const filtrados = filtrar(D, C, f);
  const r = cercanos(D, filtrados, c, 200);
  assert.equal(r.idx.length, Math.min(200, filtrados.length));
  const pasan = new Set(filtrados);
  assert.ok(r.idx.every(i => pasan.has(i)));
  assert.ok(r.idx.every(i => D.locEst[i] >= 100 && D.locs[i][4] === 0));
  // con un filtro de texto que no existe, no hay resultados
  assert.equal(cercanos(D, filtrar(D, C, { ...FILTRO_VACIO(), q: 'zzzz-no-existe' }), c, 20).idx.length, 0);
});

test('los locales sin coordenadas válidas no entran y se cuentan como omitidos', () => {
  const Dp = { locs: [
    ['A', 0, 0, '', 0, '', -17.2, -70.9],
    ['B', 0, 0, '', 0, '', 0, 0],              // ceros del padrón: fuera de Perú
    ['C', 0, 0, '', 0, '', null, null],        // sin dato
    ['D', 0, 0, '', 0, '', -17.21, -70.91],
    ['E', 0, 0, '', 0, '', -25, -70.9],        // latitud fuera del rango
    ['F', 1, 0, '', 0, '', -17.3, -66]         // longitud fuera del rango
  ] };
  const r = cercanos(Dp, [0, 1, 2, 3, 4, 5], { lat: -17.2, lon: -70.9 }, 20);
  assert.deepEqual(r.idx.map(i => Dp.locs[i][0]), ['A', 'D']);
  assert.equal(r.omitidos, 4);
  assert.equal(centroDistrito(Dp, 1), null, 'distrito sin coordenadas válidas');
});

test('Lima, la región más grande: 200 más cercanos en poco tiempo', () => {
  const L = region('lima'), CL = calc(L, DEF);
  const t0 = performance.now();
  const r = cercanos(L, filtrar(L, CL, FILTRO_VACIO()), { lat: -12.0464, lon: -77.0428 }, 200);
  const ms = performance.now() - t0;
  assert.equal(r.idx.length, 200);
  assert.ok(ms < 500, `tardó ${ms.toFixed(0)} ms`);
});

test('radio del punto según los bienes a reponer, entre 6 y 15 px', () => {
  assert.equal(radioPunto(0), 6); assert.equal(radioPunto(undefined), 6);
  assert.equal(radioPunto(16), 9); assert.equal(radioPunto(10000), 15);
});

test('CSP del Selector: permite las imágenes del mapa sin relajar otras directivas', () => {
  const p = politicaSelector('https://abc.supabase.co/');
  const dir = Object.fromEntries(p.split('; ').map(d => { const [k, ...v] = d.split(' '); return [k, v]; }));
  assert.deepEqual(dir['default-src'], ["'self'"]);
  assert.deepEqual(dir['script-src'], ["'self'", 'https://cdn.jsdelivr.net']);
  assert.ok(!p.includes("'unsafe-eval'"));
  assert.ok(!dir['script-src'].includes("'unsafe-inline'"));
  for (const o of ORIGENES_MAPA) assert.ok(dir['img-src'].includes(o));
  assert.ok(dir['connect-src'].includes('https://abc.supabase.co'));
  assert.deepEqual(dir['object-src'], ["'none'"]);
  // sin SUPABASE_URL (o inválida) no se cuela nada raro
  assert.match(politicaSelector('no es url'), /connect-src 'self';/);
});

test('CSP: solo en la página del Selector', () => {
  const correr = ruta => { const h = {}; cspSelector({ path: ruta }, { set: (k, v) => { h[k] = v; } }, () => {}); return h; };
  assert.ok(correr('/selector-ioarr.html')['Content-Security-Policy']);
  for (const r of ['/index.html', '/ioarr.html', '/seguimiento.html', '/selector-ioarr-precios.html', '/api/health'])
    assert.equal(correr(r)['Content-Security-Policy'], undefined, r);
});

test('Leaflet se sirve desde la app con la versión instalada', () => {
  const pkg = JSON.parse(readFileSync(new URL('../node_modules/leaflet/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, LEAFLET_VERSION);
  const cliente = readFileSync(new URL('../src/public/selector-ioarr-mapa.js', import.meta.url), 'utf8');
  assert.ok(cliente.includes(`'${RUTA_LEAFLET}'`), 'la ruta del cliente coincide con la del servidor');
  assert.ok(!/unpkg|jsdelivr|cdnjs/.test(cliente), 'sin CDN para Leaflet');
});
