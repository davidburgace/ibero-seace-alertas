// Pruebas del Selector IOARR (correr con: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { prep, calc, totals, filtrar, FILTRO_VACIO, DEF, NIVB, norm, limpiarParams, coordValidas, urlGoogleMaps, urlMapaEmbed } from '../src/selector-ioarr/calculo.js';
import { generarExcel, FALTANTE } from '../src/selector-ioarr/excel.js';

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

test('caso de control: Moquegua, «mariscal» → 11 locales, 2,085 estudiantes, 104 aulas, 198 bienes a reponer', () => {
  const D = moquegua(), C = calc(D, DEF);
  const T = totals(D, C, filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' }));
  assert.deepEqual([T.n, T.est, T.aul, T.rep], [11, 2085, 104, 198]);
  // Por tipo: existente, bueno, regular, malo, a reponer, faltante
  assert.deepEqual(T.t.map(o => [o.b + o.r + o.m, o.b, o.r, o.m, o.rep, o.fal]), [
    [3217, 675, 2520, 22, 22, 795], [4018, 1034, 2853, 131, 131, 683], [136, 50, 72, 14, 14, 5], [125, 41, 84, 0, 0, 5], [216, 93, 92, 31, 31, 43]]);
  // El faltante va aparte: 1,531 bienes, que no suman a lo que se repone
  assert.equal(T.fal, 1531);
});

test('a reponer = Malo en cada aula: el faltante y el estado Regular no entran', () => {
  const D = moquegua();
  for (const P of [DEF, { ...DEF, carpEstado: 'm', mesaEst: 2 }]) {
    const C = calc(D, P);
    for (let t = 0; t < 5; t++) assert.deepEqual(C.A.rep[t], C.A.m[t]);
    for (let i = 0; i < C.nL; i++) {
      let rep = 0, fal = 0;
      for (let t = 0; t < 5; t++) { rep += C.L.m[t * C.nL + i]; fal += C.L.fal[t * C.nL + i]; }
      assert.equal(C.L.repTot[i], rep); assert.equal(C.L.falTot[i], fal);
    }
  }
});

test('el cálculo coincide con el prototipo con varios criterios', () => {
  const fabrica = calculoPrototipo();
  const casos = [DEF, { ...DEF, carpEstado: 'm' }, { ...DEF, kI: 6, kPS: 3, carpBip: 3, carpEstado: 'b', mesaEst: 1.5, sillaEst: 0.5, esc: 2, sdoc: 0, arm: 3 }];
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
  // regPct: criterio antiguo («% de Regular que se repone»), guardado en proyectos viejos; se ignora
  const P = limpiarParams({ kI: 99, regPct: 0.5, carpEstado: 'x', arm: 'abc', esc: 2 });
  assert.equal(P.kI, 12); assert.equal('regPct' in P, false); assert.equal(P.carpEstado, 'r'); assert.equal(P.arm, 1); assert.equal(P.esc, 2);
});

test('Excel: hojas, fórmulas y totales iguales a la pantalla', async () => {
  const D = moquegua(), P = { ...DEF, regPct: 0.5 }, C = calc(D, limpiarParams(P));
  const list = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
  const T = totals(D, C, list);
  const { buffer } = await generarExcel(D, C, P, list, { proyecto: 'Prueba', fecha: '2026-10-20', ioarr: null });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Resumen', 'Locales (UP)', 'Por distrito', 'Servicios', 'Aulas', 'Reposición masiva']);

  const res = wb.getWorksheet('Resumen');
  const fila = txt => { let r = null; res.eachRow(row => { if (row.getCell(1).value === txt) r = row; }); return r; };
  const total = fila('Bienes a reponer (estado Malo, suma de los 5 tipos)').getCell(2).value;
  assert.match(total.formula, /^SUM\('Locales \(UP\)'!/);
  assert.equal(total.result, 198);
  assert.equal(fila(FALTANTE + ', solo informativo').getCell(2).value.result, 1531);
  assert.equal(fila('% del estado Regular que se repone'), null);
  // Mobiliario por tipo: Existente, Bueno, Regular, Malo, A reponer, Requerido, Faltante
  const cabT = fila('Mobiliario por tipo');
  assert.deepEqual(cabT.values.slice(1), ['Mobiliario por tipo', 'Unidad', 'Existente', 'Bueno', 'Regular', 'Malo', 'A reponer', 'Requerido', FALTANTE]);
  const silla = res.getRow(cabT.number + 2);
  assert.deepEqual([3, 4, 5, 6, 7, 9].map(c => silla.getCell(c).value.result), [4018, 1034, 2853, 131, 131, 683]);
  assert.equal(silla.getCell(7).value.formula, `F${silla.number}`);
  assert.equal(fila('Locales seleccionados').getCell(2).value.result, 11);
  assert.equal(fila('Estudiantes (padrón)').getCell(2).value.result, T.est);
  assert.equal(fila('Aulas en uso (censo)').getCell(2).value.result, T.aul);
  assert.ok(fila('Limitaciones'));

  // Aulas: una fila por aula, fórmulas coherentes con su resultado
  const au = wb.getWorksheet('Aulas');
  assert.equal(au.rowCount - 1, T.aul);
  let suma = 0;
  let sumaFal = 0;
  au.eachRow((row, n) => {
    if (n === 1) return;
    for (let t = 0; t < 5; t++) {
      const c = 13 + t * 7, v = k => { const x = row.getCell(c + k).value; return x && typeof x === 'object' ? (x.result ?? 0) : x; }; // exceljs relee <v>0</v> como sin resultado
      const [ex, b, r, m, rep, req, fal] = [0, 1, 2, 3, 4, 5, 6].map(v);
      assert.equal(ex, b + r + m); assert.equal(rep, m); assert.equal(fal, Math.max(0, req - ex));
      assert.equal(row.getCell(c + 4).value.formula, `${au.getColumn(c + 3).letter}${n}`);
      suma += rep; sumaFal += fal;
    }
  });
  assert.equal(suma, T.rep); assert.equal(sumaFal, T.fal);

  // Reposición masiva: misma suma (columna A reponer)
  const rm = wb.getWorksheet('Reposición masiva');
  assert.equal(rm.getRow(1).getCell(10).value, 'A reponer');
  let masiva = 0; rm.eachRow((row, n) => { if (n > 1) masiva += row.getCell(10).value.result; });
  assert.equal(masiva, T.rep);

  // Por distrito: suma igual al total, con el faltante aparte
  const pd = wb.getWorksheet('Por distrito'), ult = pd.getRow(pd.rowCount);
  assert.equal(ult.getCell(3).value, 'Total');
  assert.deepEqual([4, 5, 6, 7, 8].map(c => ult.getCell(c).value.result), [11, 2085, 104, 198, 1531]);
  assert.match(pd.getRow(2).getCell(7).value.formula, /^SUMIF\('Locales \(UP\)'!/);
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
