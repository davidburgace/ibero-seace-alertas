// Pruebas del Selector IOARR (correr con: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { prep, calc, totals, filtrar, FILTRO_VACIO, DEF, NIVB, norm, limpiarParams, coordValidas, urlGoogleMaps, urlMapaEmbed } from '../src/selector-ioarr/calculo.js';
import { generarExcel } from '../src/selector-ioarr/excel.js';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const leer = r => JSON.parse(readFileSync(new URL(r + '.json', DIR), 'utf8'));
const moquegua = () => prep(leer('moquegua'));

// prep y calc tal cual están en el prototipo, para comparar resultados
function calculoPrototipo() {
  const html = readFileSync(new URL('../docs/selector-ioarr/prototipo.html', import.meta.url), 'utf8');
  const codigo = html.slice(html.indexOf('function prep(D){'), html.indexOf('const lv=(m,t,i)'));
  return new Function('S', 'norm', 'NIVB', codigo + '\nreturn { prep, calc };');
}

test('Moquegua: 312 locales, 411 servicios, 1,686 aulas', () => {
  const D = moquegua();
  assert.equal(D.locs.length, 312);
  assert.equal(D.svcs.length, 411);
  assert.equal(D.aulas.length, 1686);
});

test('caso de control: Moquegua, «mariscal» → 11 locales, 2,085 estudiantes, 104 aulas, 1,729 bienes', () => {
  const D = moquegua(), C = calc(D, DEF);
  const T = totals(D, C, filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' }));
  assert.deepEqual([T.n, T.est, T.aul, T.rep], [11, 2085, 104, 1729]);
});

test('el cálculo coincide con el prototipo con varios criterios', () => {
  const fabrica = calculoPrototipo();
  const casos = [DEF, { ...DEF, regPct: 0.35, carpEstado: 'm' }, { ...DEF, kI: 6, kPS: 3, carpBip: 3, carpEstado: 'b', mesaEst: 1.5, sillaEst: 0.5, esc: 2, sdoc: 0, arm: 3 }];
  for (const region of ['moquegua', 'tumbes']) {
    for (const P of casos) {
      const S = { params: P };
      const proto = fabrica(S, norm, NIVB);
      const Dp = leer(region); proto.prep(Dp); S.D = Dp; proto.calc();   // el prototipo lee S.D y S.params, deja S.C
      const D = prep(leer(region)), C = calc(D, P);
      for (const k of ['b', 'r', 'm', 'req', 'fal', 'rep', 'repTot', 'reqTot']) assert.deepEqual(C.L[k], S.C.L[k], `${region} ${k}`);
    }
  }
});

test('limpiarParams descarta valores fuera de rango', () => {
  const P = limpiarParams({ kI: 99, regPct: 5, carpEstado: 'x', arm: 'abc', esc: 2 });
  assert.equal(P.kI, 12); assert.equal(P.regPct, 1); assert.equal(P.carpEstado, 'r'); assert.equal(P.arm, 1); assert.equal(P.esc, 2);
});

test('Excel: hojas, fórmulas y totales iguales a la pantalla', async () => {
  const D = moquegua(), P = { ...DEF, regPct: 0.5 }, C = calc(D, P);
  const list = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
  const T = totals(D, C, list);
  const { buffer } = await generarExcel(D, C, P, list, { proyecto: 'Prueba', fecha: '2026-10-20', ioarr: null });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Resumen', 'Locales (UP)', 'Servicios', 'Aulas', 'Reposición masiva']);

  const res = wb.getWorksheet('Resumen');
  const fila = txt => { let r = null; res.eachRow(row => { if (row.getCell(1).value === txt) r = row; }); return r; };
  const total = fila('Bienes a reponer (suma de los 5 tipos)').getCell(2).value;
  assert.match(total.formula, /^SUM\('Locales \(UP\)'!/);
  assert.equal(total.result, T.rep);
  assert.equal(fila('Locales seleccionados').getCell(2).value.result, 11);
  assert.equal(fila('Estudiantes (padrón)').getCell(2).value.result, T.est);
  assert.equal(fila('Aulas en uso (censo)').getCell(2).value.result, T.aul);
  assert.ok(fila('Limitaciones'));

  // Aulas: una fila por aula, fórmulas coherentes con su resultado
  const au = wb.getWorksheet('Aulas');
  assert.equal(au.rowCount - 1, T.aul);
  let suma = 0;
  const pctFila = fila('% del estado Regular que se repone').number;
  au.eachRow((row, n) => {
    if (n === 1) return;
    for (let t = 0; t < 5; t++) {
      const c = 13 + t * 7, v = k => { const x = row.getCell(c + k).value; return x && typeof x === 'object' ? (x.result ?? 0) : x; }; // exceljs relee <v>0</v> como sin resultado
      const [b, r, m, ex, req, fal, rep] = [0, 1, 2, 3, 4, 5, 6].map(v);
      assert.equal(ex, b + r + m); assert.equal(fal, Math.max(0, req - ex)); assert.equal(rep, m + Math.round(r * 0.5) + fal);
      assert.equal(row.getCell(c + 6).value.formula, `${au.getColumn(c + 2).letter}${n}+ROUND(${au.getColumn(c + 1).letter}${n}*Resumen!$B$${pctFila},0)+${au.getColumn(c + 5).letter}${n}`);
      suma += rep;
    }
  });
  assert.equal(suma, T.rep);

  // Reposición masiva: misma suma
  let masiva = 0; wb.getWorksheet('Reposición masiva').eachRow((row, n) => { if (n > 1) masiva += row.getCell(12).value; });
  assert.equal(masiva, T.rep);
  assert.equal(wb.getWorksheet('Locales (UP)').rowCount - 1, 11);

  // Locales (UP): latitud y longitud numéricas, enlace satelital a Google Maps
  const lo = wb.getWorksheet('Locales (UP)'), cab = lo.getRow(1).values;
  const [cLat, cLon, cMapa] = ['Latitud', 'Longitud', 'Enlace Google Maps'].map(h => cab.indexOf(h));
  assert.equal(cMapa, cLon + 1);
  lo.eachRow((row, n) => {
    if (n === 1) return;
    const lat = row.getCell(cLat).value, lon = row.getCell(cLon).value, url = row.getCell(cMapa).value;
    assert.equal(typeof lat, 'number'); assert.equal(typeof lon, 'number');
    assert.equal(url.hyperlink, urlGoogleMaps(lat, lon));
  });
  // Las fórmulas del Resumen siguen apuntando a las columnas correctas tras la columna nueva
  const letraDe = h => lo.getColumn(cab.indexOf(h)).letter;
  assert.match(fila('Estudiantes (padrón)').getCell(2).value.formula, new RegExp(`!${letraDe('Estudiantes (padrón)')}2:`));
  assert.match(fila('Aulas en uso (censo)').getCell(2).value.formula, new RegExp(`!${letraDe('Aulas en uso (censo)')}2:`));
  assert.match(fila('Locales seleccionados').getCell(2).value.formula, new RegExp(`!${letraDe('Código de local')}2:`));
});

test('coordenadas: rango de Perú y URLs de Google Maps', () => {
  assert.ok(coordValidas(-6.8882, -79.4997));
  for (const [lat, lon] of [[0.5, -75], [-19.1, -70], [-10, -82.1], [-10, -67.9], [null, -75], ['-6', '-79'], [NaN, NaN]]) assert.ok(!coordValidas(lat, lon), `${lat},${lon}`);
  assert.equal(urlGoogleMaps(-6.88, -79.5), 'https://www.google.com/maps?q=-6.88,-79.5&t=k&z=18');
  assert.equal(urlMapaEmbed(-6.88, -79.5, 'AB C'), 'https://www.google.com/maps/embed/v1/place?key=AB%20C&q=-6.88,-79.5&zoom=18&maptype=satellite');
  assert.equal(urlMapaEmbed(-6.88, -79.5, null), 'https://maps.google.com/maps?q=-6.88,-79.5&t=k&z=18&output=embed');
});

test('Lima: carga y cálculo en tiempo razonable', () => {
  const t0 = Date.now();
  const D = prep(leer('lima')), C = calc(D, DEF);
  const ms = Date.now() - t0;
  assert.equal(D.aulas.length > 30000, true);
  assert.ok(ms < 3000, `tardó ${ms} ms`);
  assert.ok(totals(D, C, D.locs.map((_, i) => i)).rep > 0);
});
