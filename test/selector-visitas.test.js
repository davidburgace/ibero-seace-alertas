// Selector IOARR — agrupación por días de visita, Excel y KML
// La ruta exige un cliente de Supabase configurado: se crea con valores de prueba (nunca se conecta)
process.env.SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.SUPABASE_SECRET_KEY ||= 'clave-de-prueba';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import ExcelJS from 'exceljs';
import { prep, calc, filtrar, FILTRO_VACIO, DEF } from '../src/selector-ioarr/calculo.js';
import { cercanos, centroDistrito, haversine } from '../src/selector-ioarr/cercania.js';
import { agruparVisitas, puntosVisita, limitarPorDia, generarKML, colorDia, COLORES_DIA, GRIS_DIA, AVISO_VISITAS } from '../src/selector-ioarr/visitas.js';
import { generarExcelVisitas, COLUMNAS_VISITAS } from '../src/selector-ioarr/excel-visitas.js';

const D = prep(JSON.parse(readFileSync(new URL('../src/public/data/selector-ioarr/2025/moquegua.json', import.meta.url), 'utf8')));
const C = calc(D, DEF);
// Los 20 más cercanos al distrito de Moquegua (el mismo caso de la búsqueda por cercanía)
const veinte = cercanos(D, filtrar(D, C, FILTRO_VACIO()), centroDistrito(D, D.dists.findIndex(d => d[0] === 'Moquegua')), 20).idx;

test('limitarPorDia: por defecto 8, entre 1 y 50', () => {
  assert.equal(limitarPorDia(''), 8); assert.equal(limitarPorDia('x'), 8);
  assert.equal(limitarPorDia(0), 1); assert.equal(limitarPorDia(60), 50); assert.equal(limitarPorDia('12'), 12);
});

test('20 locales de a 8 por día: 3 días (8, 8, 4), cada local una sola vez y en orden', () => {
  const { puntos } = puntosVisita(D, C, veinte);
  const dias = agruparVisitas(puntos, 8);
  assert.deepEqual(dias.map(d => d.puntos.length).sort((a, b) => b - a), [8, 8, 4]);
  assert.deepEqual(dias.map(d => d.dia), [1, 2, 3]);
  const cods = dias.flatMap(d => d.puntos.map(p => p.cod));
  assert.equal(new Set(cods).size, 20);
  assert.deepEqual(new Set(cods), new Set(veinte.map(i => D.locs[i][0])));
  for (const d of dias) assert.deepEqual(d.puntos.map(p => p.orden), d.puntos.map((_, j) => j + 1));
});

test('la ruta de cada día sigue al vecino más cercano y su largo es la suma de los tramos', () => {
  const dias = agruparVisitas(puntosVisita(D, C, veinte).puntos, 8);
  for (const d of dias) {
    const ps = d.puntos;
    for (let j = 1; j < ps.length; j++) {
      const desde = ps[j - 1], dElegido = haversine(desde.lat, desde.lon, ps[j].lat, ps[j].lon);
      for (const otro of ps.slice(j + 1)) assert.ok(dElegido <= haversine(desde.lat, desde.lon, otro.lat, otro.lon) + 1e-9);
    }
    const suma = ps.reduce((a, p, j) => j ? a + haversine(ps[j - 1].lat, ps[j - 1].lon, p.lat, p.lon) : 0, 0);
    assert.ok(Math.abs(suma - d.km) < 1e-9);
  }
});

test('el resultado no depende del orden en que llega la selección', () => {
  const { puntos } = puntosVisita(D, C, veinte);
  const a = agruparVisitas(puntos, 6), b = agruparVisitas([...puntos].reverse(), 6);
  assert.deepEqual(a.map(d => d.puntos.map(p => p.cod)), b.map(d => d.puntos.map(p => p.cod)));
});

test('dos zonas lejanas quedan en días distintos', () => {
  const zona = (pref, lat, lon) => Array.from({ length: 5 }, (_, k) => ({ cod: pref + k, lat: lat + k * 0.003, lon: lon + k * 0.002 }));
  const lima = zona('L', -12.05, -77.04), areq = zona('A', -16.40, -71.53);
  const dias = agruparVisitas([...areq.slice(0, 2), ...lima, ...areq.slice(2)], 5);
  assert.equal(dias.length, 2);
  for (const d of dias) assert.equal(new Set(d.puntos.map(p => p.cod[0])).size, 1, 'cada día en una sola zona');
});

test('casos borde: sin puntos, un punto y un local por día', () => {
  assert.deepEqual(agruparVisitas([], 8), []);
  const uno = agruparVisitas([{ cod: '1', lat: -12, lon: -77 }], 8);
  assert.equal(uno.length, 1); assert.equal(uno[0].km, 0); assert.equal(uno[0].puntos[0].orden, 1);
  assert.equal(agruparVisitas(puntosVisita(D, C, veinte).puntos, 1).length, 20);
});

test('puntosVisita separa los locales sin coordenadas y trae los datos del Excel', () => {
  const Dp = { locs: [['111', 0, 0, 'CP A', 0, 'Jr. Uno 1', -17.2, -70.9], ['222', 0, 0, 'CP B', 1, '', 0, 0]], dists: [['Moquegua']],
    locName: ['IE UNO', 'IE DOS'], locEst: [10, 20] };
  const { puntos, sinCoord } = puntosVisita(Dp, { L: { repTot: [5, 7] } }, [0, 1]);
  assert.deepEqual(puntos.map(p => [p.cod, p.nom, p.dist, p.cp, p.dir, p.rep]), [['111', 'IE UNO', 'Moquegua', 'CP A', 'Jr. Uno 1', 5]]);
  assert.deepEqual(sinCoord.map(p => p.cod), ['222']);
});

test('colores: paleta fija hasta 8 días; con más, gris (sin repetir colores)', () => {
  assert.deepEqual([1, 2, 3].map(d => colorDia(d, 3)), COLORES_DIA.slice(0, 3));
  assert.equal(colorDia(8, 8), COLORES_DIA[7]);
  assert.equal(colorDia(1, 9), GRIS_DIA); assert.equal(colorDia(9, 9), GRIS_DIA);
});

test('KML: una carpeta por día, un punto por local, la ruta y el texto escapado', () => {
  const dias = agruparVisitas([...puntosVisita(D, C, veinte).puntos, { cod: '9', nom: 'IE <A & B>', dist: 'X', cp: '', dir: '', lat: -17.19, lon: -70.93, rep: 1 }], 8);
  const kml = generarKML(dias, { proyecto: 'Prueba "1"', region: 'Moquegua', porDia: 8 });
  assert.match(kml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<kml xmlns="http:\/\/www.opengis.net\/kml\/2.2">/);
  assert.equal((kml.match(/<Folder>/g) || []).length, dias.length);
  assert.equal((kml.match(/<Point>/g) || []).length, 21);
  assert.equal((kml.match(/<LineString>/g) || []).length, dias.filter(d => d.puntos.length > 1).length);
  assert.ok(kml.includes('IE &lt;A &amp; B&gt;') && !kml.includes('<A & B>'));
  assert.ok(kml.includes('Prueba &quot;1&quot;'));
  assert.ok(kml.includes('<color>ffd6782a</color>'), 'azul #2a78d6 en aabbggrr');
  assert.ok(kml.includes(AVISO_VISITAS));
  const p = dias[0].puntos[0];
  assert.ok(kml.includes(`<coordinates>${p.lon},${p.lat},0</coordinates>`), 'longitud primero');
});

test('Excel: columnas pedidas, orden de visita, sin coordenadas al final y resumen por día', async () => {
  const { puntos } = puntosVisita(D, C, veinte);
  const dias = agruparVisitas(puntos, 8);
  const sinCoord = [{ cod: '0000001', nom: 'IE SIN GPS', dist: 'Moquegua', cp: 'CP', dir: '', rep: 3 }];
  const buf = await generarExcelVisitas(dias, sinCoord, { proyecto: 'Prueba', region: 'Moquegua', porDia: 8, fecha: '2026-10-22' });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Visitas');
  assert.deepEqual(ws.getRow(1).values.slice(1), COLUMNAS_VISITAS);
  assert.deepEqual(COLUMNAS_VISITAS, ['Grupo (día)', 'Orden', 'Código de local', 'Institución', 'Distrito', 'Centro poblado', 'Dirección', 'Latitud', 'Longitud', 'Bienes a reponer']);
  assert.equal(ws.rowCount, 1 + 20 + 1);
  const p = dias[0].puntos[0];
  assert.deepEqual(ws.getRow(2).values.slice(1), ['Día 1', 1, p.cod, p.nom, p.dist, p.cp, p.dir, p.lat, p.lon, p.rep]);
  assert.equal(ws.getRow(22).getCell(1).value, 'Sin coordenadas');
  const rs = wb.getWorksheet('Resumen por día');
  const filas = []; rs.eachRow(r => filas.push(r.values.slice(1)));
  assert.ok(filas.some(f => f[0] === AVISO_VISITAS));
  const total = filas.find(f => f[0] === 'Total');
  assert.equal(total[1].result, 20);
  assert.equal(total[2].result, dias.reduce((a, d) => a + d.puntos.reduce((b, x) => b + x.rep, 0), 0));
});

test('ruta POST /api/selector-ioarr/visitas.xlsx (también para borradores)', async () => {
  const { default: router } = await import('../src/selector-ioarr/router.js');
  const app = express(); app.use(express.json());
  app.use((req, _, next) => { if (req.headers['x-usuario']) req.usuario = { id: req.headers['x-usuario'] }; next(); });
  app.use(router);
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/api/selector-ioarr/visitas.xlsx`;
  const post = (body, usuario = 'u1') => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(usuario ? { 'x-usuario': usuario } : {}) }, body: JSON.stringify(body) });
  try {
    const cods = veinte.map(i => D.locs[i][0]);
    assert.equal((await post({ region: 'Moquegua', codigos: cods }, null)).status, 401, 'exige sesión');
    assert.equal((await post({ region: 'Atlántida', codigos: cods })).status, 400);
    assert.equal((await post({ region: 'Moquegua', codigos: [] })).status, 400);
    assert.equal((await post({ region: 'Moquegua', codigos: ['99999999'] })).status, 400);
    const r = await post({ region: 'Moquegua', codigos: cods, criterios: DEF, porDia: 8, proyecto: 'Visitas Ilo / Moquegua' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /spreadsheetml/);
    assert.match(r.headers.get('content-disposition'), /Visitas_.*_\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const ws = wb.getWorksheet('Visitas');
    assert.equal(ws.rowCount, 21);
    // el servidor agrupa igual que la pantalla
    const esperado = agruparVisitas(puntosVisita(D, C, veinte).puntos, 8);
    const servidor = []; ws.eachRow((row, n) => { if (n > 1) servidor.push([row.getCell(1).value, row.getCell(2).value, row.getCell(3).value]); });
    assert.deepEqual(servidor, esperado.flatMap(d => d.puntos.map(p => [`Día ${d.dia}`, p.orden, p.cod])));
  } finally { srv.close(); }
});
