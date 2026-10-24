// Escenario «Malo + % de Regular»: % global y por nivel, redondeo, tope del kit por
// matrícula, Regular por dato verificado (ficha con antigüedad) y lo que declaran los documentos (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prep, calc, totals, limpiarParams, pctRegularDe, regularAReponer, textoEscenario, textoPct, DEF } from '../src/selector-ioarr/calculo.js';
import { costear, preciosEfectivos } from '../src/selector-ioarr/costos.js';
import { armarModelo, limpiarDatosDoc } from '../src/selector-ioarr/documentos.js';
import { porNivel } from '../src/selector-ioarr/niveles.js';
import { generarExcel } from '../src/selector-ioarr/excel.js';
import ExcelJS from 'exceljs';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const region = nombre => prep(JSON.parse(readFileSync(new URL(nombre + '.json', DIR), 'utf8')));
const precios = Object.fromEntries(Object.entries(preciosEfectivos({ precios: { esc: 300, sdoc: 80, arm: 450 } }, {})).map(([k, v]) => [k, v.precio]));
const costo = (D, P, list, extra = {}) => costear({ D, C: calc(D, P), list, precios, estructura: { kit: true }, uit: { anio: 2026, valor: 5500 }, ...extra });
const todos = D => D.locs.map((_, i) => i).filter(i => D.locAul[i].length);

// Región sintética: f = { índice del mobiliario: cantidad } (0-2 mesa unip. B/R/M · 8-10 silla B/R/M)
function sintetica(locales) {
  const D = { region: 'Prueba', dpto: 'PRUEBA', provs: ['Prov'], ugels: ['UGEL'], dists: [['Dist', '010101', 0]], locs: [], svcs: [], aulas: [] };
  locales.forEach((aulas, i) => {
    D.locs.push([String(200001 + i), 0, 0, 'CP', 0, 'Dir', -12, -77]);
    const niveles = [...new Set(aulas.map(a => a.nivel || 'P'))];
    const sv = Object.fromEntries(niveles.map(n => { D.svcs.push([String(2000001 + D.svcs.length), `IE ${i} ${n}`, n, i, 0, 1, 30, 'M']); return [n, D.svcs.length - 1]; }));
    for (const a of aulas) {
      const v = new Array(20).fill(0); for (const [j, q] of Object.entries(a.f)) v[j] = q;
      D.aulas.push([i, sv[a.nivel || 'P'], 'E1', 1, '1', a.grado || '3° Primaria', 'A', 'M', a.est ?? 30, 0, 0, ...v]);
    }
  });
  return prep(D);
}

test('redondeo: el Regular a reponer nunca supera el Regular existente', () => {
  for (let r = 0; r <= 250; r++) for (let pct = 0; pct <= 100; pct++) {
    const q = regularAReponer(r, pct);
    assert.ok(Number.isInteger(q) && q >= 0 && q <= r, `r=${r} pct=${pct} → ${q}`);
    assert.ok(q >= r * pct / 100 - 1e-9, 'redondeo hacia arriba');
    assert.ok(q - r * pct / 100 < 1, 'a lo más una unidad por encima');
  }
  assert.equal(regularAReponer(7, 0), 0);
  assert.equal(regularAReponer(7, 100), 7);
  assert.equal(regularAReponer(3, 34), 2);   // 1.02 → 2
  assert.equal(regularAReponer(10, 30), 3);  // exacto, no sube a 4
});

test('% por nivel y global: se combinan bien y se validan', () => {
  const P = limpiarParams({ escenario: 'malo_regular', pctRegular: 40, pctRegularNivel: { P: 70, S: '', X: 5 } });
  assert.deepEqual([pctRegularDe(P, 'I'), pctRegularDe(P, 'P'), pctRegularDe(P, 'S'), pctRegularDe(P, 'E')], [40, 70, 40, 40]);
  assert.deepEqual(P.pctRegularNivel, { P: 70 });
  // Fuera de rango o decimal: se acota y redondea
  const Q = limpiarParams({ pctRegular: 140, pctRegularNivel: { I: -3, S: 33.6 }, umbralVida: 0 });
  assert.equal(Q.pctRegular, 100); assert.deepEqual(Q.pctRegularNivel, { I: 0, S: 34 }); assert.equal(Q.umbralVida, 1);
  // Por defecto: 100 % (cota superior), umbral 10 años, valor manual
  const R = limpiarParams({});
  assert.equal(R.pctRegular, 100); assert.equal(R.umbralVida, 10); assert.equal(R.pctOrigen.tipo, 'manual');
  assert.equal(textoPct(P, ['I', 'P']), '40 % (Inicial 40 %, Primaria 70 %)');

  // Aula por aula: cada una usa el % de su nivel
  const D = sintetica([[{ nivel: 'I', grado: 'Inicial 4 años', f: { 1: 10, 2: 1, 9: 10 } }, { nivel: 'P', f: { 1: 10, 2: 1, 9: 10 } }, { nivel: 'S', grado: '2° Secundaria', f: { 1: 10, 2: 1, 9: 10 } }]]);
  const C = calc(D, P);
  // mesa: Malo 1 + Regular a reponer (Inicial 40 % → 4, Primaria 70 % → 7, Secundaria 40 % → 4)
  assert.deepEqual([0, 1, 2].map(ai => C.A.rep[0][ai]), [5, 8, 5]);
  assert.deepEqual([0, 1, 2].map(ai => C.A.rep[1][ai]), [4, 7, 4]);
  // Con IOARR por nivel, cada una con su %
  const G = porNivel(D, P, [0]);
  assert.deepEqual(G.map(g => [g.nivel, totals(g.D, g.C, g.list).t[0].rep]), [['I', 5], ['P', 8], ['S', 5]]);
});

test('% = 0 es idéntico a «Solo Malo» y % = 100 a «Malo + Regular» (con el kit limitado a la matrícula)', () => {
  for (const nombre of ['moquegua', 'tacna']) {
    const D = region(nombre), list = todos(D);
    const malo = costo(D, limpiarParams({ escenario: 'malo' }), list);
    const p0 = costo(D, limpiarParams({ escenario: 'malo_regular', pctRegular: 0 }), list);
    assert.deepEqual(p0.partidas.map(x => x.rep), malo.partidas.map(x => x.rep), nombre);
    assert.equal(p0.totales.kits, malo.totales.kits); assert.equal(p0.totales.total, malo.totales.total);
    assert.deepEqual(p0.locales.map(l => l.kits), malo.locales.map(l => l.kits));

    // Referencia independiente de «Malo + Regular»: M + R por aula; kit = MIN(matrícula, MAX(mesas, sillas))
    const P100 = limpiarParams({ escenario: 'malo_regular', pctRegular: 100 }), C = calc(D, P100);
    const p100 = costo(D, P100, list);
    const ref = [0, 1, 2, 3, 4].map(t => list.reduce((a, i) => a + D.locAul[i].reduce((s, ai) => s + C.A.m[t][ai] + C.A.r[t][ai], 0), 0));
    assert.deepEqual(p100.partidas.map(x => x.rep), ref, nombre);
    const kits = list.reduce((a, i) => a + D.locAul[i].reduce((s, ai) => s + Math.min(D.aulas[ai][8], Math.max(C.A.m[0][ai] + C.A.r[0][ai], C.A.m[1][ai] + C.A.r[1][ai])), 0), 0);
    assert.equal(p100.totales.kits, kits, nombre);
    // El faltante es el mismo en todos: informativo
    assert.equal(p0.totales.fal, malo.totales.fal); assert.equal(p100.totales.fal, malo.totales.fal);
  }
});

test('kit: no pasa de la matrícula del aula (salvo «Por capacidad»)', () => {
  const D = sintetica([[{ est: 10, f: { 2: 24, 10: 20 } }, { est: 30, f: { 2: 12, 10: 18 } }]]);
  const R = costo(D, limpiarParams({ escenario: 'malo', muebles: ['mesa', 'silla'] }), [0]);
  assert.equal(R.totales.kits, 10 + 18);
  const cap = costo(D, limpiarParams({ escenario: 'capacidad', muebles: ['mesa', 'silla'] }), [0]);
  assert.equal(cap.totales.kits, 24 + 24);
});

// Local con ficha: aula 0 contada con antigüedad, aula 1 sin contar (censo)
function conFicha(antig2) {
  const D = sintetica([[{ f: { 0: 2, 1: 10, 2: 4 } }, { f: { 1: 6, 2: 1 } }], [{ f: { 1: 8, 2: 2 } }]]);
  const filas = [{ k: 'mesa', b: 2, r: 6, m: 4, antig: 12 }, { k: 'mesa', b: 0, r: 4, m: 0, antig: antig2 }];
  const ficha = { aulas: { 0: { nivel: 'P', filas } } };
  // bienes = aula 0 verificada + aula 1 del censo
  const inv = { [D.locs[0][0]]: { bienes: { mesa: { b: 2, r: 16, m: 5 } }, verif: { mesa: { mv: 4, mc: 1 } }, ficha, fecha_visita: '2026-10-01' } };
  return { D, inv };
}

test('Regular por dato verificado: con antigüedad se usa el Regular con vida útil cumplida en lugar del %', () => {
  const { D, inv } = conFicha(5);
  const P = limpiarParams({ escenario: 'malo_regular', pctRegular: 50, umbralVida: 10, muebles: ['mesa'] });
  const R = costo(D, P, [0, 1], { inventario: inv });
  const [l0, l1] = R.locales;
  // Aula 0: dato → 6 (antigüedad 12 ≥ 10) + 0 (antigüedad 5); aula 1: censo 6 × 50 % = 3. Malo 5.
  assert.equal(l0.rep[0], 5 + 6 + 3);
  assert.equal(l0.repVerif[0], 4 + 6);
  // El local tiene Regular sin antigüedad (aula 1): estimación, con dato parcial
  assert.equal(l0.regular.origen, 'estimacion'); assert.ok(l0.regular.parcial);
  // El otro local, sin ficha: Malo 2 + 8 × 50 % = 4
  assert.equal(l1.rep[0], 6); assert.equal(l1.regular.origen, 'estimacion'); assert.ok(!l1.regular.parcial);
  // Muestra: 10 regulares con antigüedad, 6 con vida útil cumplida → 60 %
  assert.deepEqual([R.regularCampo.conDato, R.regularCampo.conocido, R.regularCampo.vida, R.regularCampo.observado], [1, 10, 6, 60]);
  // Umbral editable: con 4 años, los dos cumplen
  const R4 = costo(D, { ...P, umbralVida: 4 }, [0, 1], { inventario: inv });
  assert.equal(R4.locales[0].rep[0], 5 + 10 + 3); assert.equal(R4.regularCampo.observado, 100);
  // Solo Malo no cambia con la antigüedad
  const M = costo(D, limpiarParams({ escenario: 'malo', muebles: ['mesa'] }), [0, 1], { inventario: inv });
  assert.equal(M.locales[0].rep[0], 5);
});

test('Regular por dato verificado: local con todo su Regular con antigüedad', () => {
  const D = sintetica([[{ f: { 1: 10, 2: 4 } }]]);
  const ficha = { aulas: { 0: { nivel: 'P', filas: [{ k: 'mesa', b: 0, r: 10, m: 4, antig: 15 }] } } };
  const inv = { [D.locs[0][0]]: { bienes: { mesa: { b: 0, r: 10, m: 4 } }, verif: { mesa: { mv: 4, mc: 0 } }, ficha, fecha_visita: '2026-10-01' } };
  const P = limpiarParams({ escenario: 'malo_regular', pctRegular: 0, muebles: ['mesa'] });
  const R = costo(D, P, [0], { inventario: inv });
  assert.equal(R.locales[0].regular.origen, 'dato');
  assert.equal(R.locales[0].rep[0], 14);   // el dato verificado reemplaza al 0 %
  assert.equal(R.regularCampo.completos, 1);
});

test('documentos: el 07-C y el resumen declaran el %, su origen y que es una estimación', () => {
  const { D, inv } = conFicha(15);
  const P = limpiarParams({ escenario: 'malo_regular', pctRegular: 60, pctOrigen: { tipo: 'observado', n: 3, umbral: 10 }, muebles: ['mesa'] });
  const R = costo(D, P, [0, 1], { inventario: inv });
  const M = armarModelo({ R, D, list: [0, 1], proyecto: { nombre: 'x', region: 'Prueba' }, datos: limpiarDatosDoc({}), precios: {}, P, fecha: '2026-10-24' });
  const s = M.E.sustento[0];
  assert.match(s, /Malo \+ % de Regular/);
  assert.match(s, /60 %/);
  assert.match(s, /% observado de Regular con vida útil cumplida en 3 locales verificados/);
  assert.match(s, /estimación hasta completar la verificación/);
  assert.match(s, /Directiva 005-2016-EF\/51\.01/);
  assert.match(M.escenarioTexto, /^Escenario de cantidad: Malo \+ % de Regular: Malo y 60 % del Regular/);
  assert.match(M.escenarioTexto, /estimación hasta completar la verificación/);
  // Faltantes: siguen fuera del metrado
  assert.ok(M.E.sustento.some(x => /faltantes|no incluye bienes faltantes/.test(x)));
  assert.match(textoEscenario(limpiarParams({ escenario: 'malo_regular' })), /origen del %: valor manual/);
  assert.equal(DEF.pctRegular, 100);
});

test('Excel del Selector: con % < 100, «A reponer» por aula = M + MIN(R, REDONDEAR.MAS(R × %))', async () => {
  const D = region('moquegua'), list = todos(D).slice(0, 5);
  const P = limpiarParams({ escenario: 'malo_regular', pctRegular: 50, pctRegularNivel: { S: 30 } }), C = calc(D, P);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await generarExcel(D, C, P, list, { proyecto: 'x', fecha: '2026-10-24' })).buffer);
  const au = wb.getWorksheet('Aulas'), col = au.getRow(1).values.findIndex(v => v === 'Mesa del estudiante – A reponer');
  const niv = au.getRow(1).values.findIndex(v => v === 'Nivel');
  for (let n = 2; n <= au.rowCount; n++) {
    const c = au.getRow(n).getCell(col).value, pct = au.getRow(n).getCell(niv).value === 'Secundaria' ? 30 : 50;
    assert.match(c.formula, new RegExp(`^[A-Z]+${n}\\+MIN\\([A-Z]+${n},ROUNDUP\\([A-Z]+${n}\\*${pct}/100,0\\)\\)$`));
  }
});
