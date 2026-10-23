// Pruebas de «Una IOARR o una IOARR por nivel» (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { prep, calc, totals, filtrar, FILTRO_VACIO, DEF, totalesPorNivel } from '../src/selector-ioarr/calculo.js';
import { costear, censoLocal } from '../src/selector-ioarr/costos.js';
import { armarModelo, limpiarDatosDoc } from '../src/selector-ioarr/documentos.js';
import { generarExcel } from '../src/selector-ioarr/excel.js';
import { escribirZip } from '../src/selector-ioarr/zip.js';
import { porNivel, vistaNivel, nivelesDeLocal, inventarioNivel, inventarioUna, sinNivel, modoDe } from '../src/selector-ioarr/niveles.js';

const DIR = new URL('../src/public/data/selector-ioarr/2025/', import.meta.url);
const D = prep(JSON.parse(readFileSync(new URL('moquegua.json', DIR), 'utf8')));
const C = calc(D, DEF);
const LISTA = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
const ICHUNA = '398420', iI = D.locs.findIndex(l => l[0] === ICHUNA);   // Inicial, Primaria y Secundaria
const cerca = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg}: ${a} ≠ ${b}`);
const BASE = {
  precios: { mesa: 180, silla: 90, esc: 400, sdoc: 120, arm: 650 }, uit: { anio: 2026, valor: 5500 },
  estructura: { transporte_pieza: 10, igv: 18, doc_pct: 3, sup_pct: 5, liquidacion: 9000 }
};

test('por defecto el proyecto es una IOARR por nivel', () => {
  assert.equal(modoDe({}), 'por_nivel'); assert.equal(modoDe({ modo_ioarr: 'una' }), 'una'); assert.equal(modoDe({ modo_ioarr: 'otro' }), 'por_nivel');
});

test('caso de control por nivel: Inicial, Primaria y Secundaria suman lo mismo que la IOARR única', () => {
  const G = porNivel(D, DEF, LISTA);
  assert.deepEqual(G.map(g => [g.nivel, g.list.length]), [['I', 6], ['P', 4], ['S', 4]]);
  const T = G.map(g => totals(g.D, g.C, g.list));
  assert.deepEqual(T.map(t => t.rep), [17, 101, 80]);
  assert.equal(T.reduce((a, t) => a + t.rep, 0), 198);
  assert.equal(T.reduce((a, t) => a + t.fal, 0), 1531);
  assert.equal(T.reduce((a, t) => a + t.est, 0), 2085);
  assert.equal(T.reduce((a, t) => a + t.aul, 0), 104);
  // Un local con tres niveles entra en las tres, cada una con lo suyo
  assert.deepEqual(nivelesDeLocal(D, iI), ['I', 'P', 'S']);
  assert.deepEqual(G.map(g => g.D.locEst[iI]), [47, 106, 101]);
  assert.deepEqual(G.map(g => totals(g.D, g.C, [iI]).rep), [16 + 0, 51 + 0, 64 + 2]);
  // Los totales por nivel del Selector dan lo mismo
  assert.deepEqual(totalesPorNivel(D, C, LISTA).map(o => [o.nivel, o.n, o.est, o.aul, o.rep, o.fal]), G.map((g, j) => [g.nivel, g.list.length, T[j].est, T[j].aul, T[j].rep, T[j].fal]));
});

test('costos por nivel: cada IOARR con su total; la liquidación se reparte y la suma es el total único', () => {
  const G = porNivel(D, DEF, LISTA);
  const U = costear({ D, C, list: LISTA, ...BASE });
  const N = costear({ ...BASE, grupos: G.map(g => ({ clave: g.nivel, D: g.D, C: g.C, list: g.list })) });
  cerca(N.totales.total, U.totales.total, 'suma de las IOARR = IOARR única');
  const tot = ['I', 'P', 'S'].map(n => N.grupos[n].totales.total);
  cerca(tot.reduce((a, b) => a + b, 0), U.totales.total, 'suma de los grupos');
  // La liquidación (monto fijo) se reparte según el costo directo; los % no cambian
  cerca(['I', 'P', 'S'].reduce((a, n) => a + N.grupos[n].totales.liq, 0), 9000, 'las partes suman la liquidación');
  assert.equal(N.grupos.P.estructura.params.igv, 18);
  // Cada IOARR evalúa su propio límite de 75 UIT
  assert.ok(['I', 'P', 'S'].every(n => N.grupos[n].uit.limite === 75 * 5500));
  assert.deepEqual(['I', 'P', 'S'].map(n => N.grupos[n].totales.rep), [17, 101, 80]);
});

test('inventario por nivel: cada IOARR usa lo suyo y la IOARR única suma campo y censo', () => {
  const G = porNivel(D, DEF, LISTA), Cn = Object.fromEntries(G.map(g => [g.nivel, g.C]));
  const fila = { cod_local: ICHUNA, bienes: {}, adquisicion: {}, fecha_visita: '2026-10-20', observacion: 'Acta', archivos: [],
    por_nivel: { P: { bienes: { silla: { b: 100, r: 120, m: 70 } }, adquisicion: { silla: 2006 } } } };
  const inv = { [ICHUNA]: fila };
  assert.deepEqual(inventarioNivel(inv, D, 'P')[ICHUNA].bienes, { silla: { b: 100, r: 120, m: 70 } });
  assert.deepEqual(inventarioNivel(inv, D, 'S')[ICHUNA].bienes, {});
  const N = costear({ ...BASE, grupos: G.map(g => ({ clave: g.nivel, D: g.D, C: g.C, list: g.list, inventario: inventarioNivel(inv, D, g.nivel) })) });
  const sillaP = N.grupos.P.locales.find(l => l.cod === ICHUNA).rep[1], sillaS = N.grupos.S.locales.find(l => l.cod === ICHUNA).rep[1];
  assert.deepEqual([sillaP, sillaS], [70, 64]);   // Primaria: campo; Secundaria: censo

  // IOARR única: silla = campo en Primaria + censo en Inicial y Secundaria
  const u = inventarioUna(inv, D, Cn)[ICHUNA];
  const cI = censoLocal(Cn.I, iI).silla, cS = censoLocal(Cn.S, iI).silla;
  assert.deepEqual(u.bienes.silla, { b: 100 + cI.b + cS.b, r: 120 + cI.r + cS.r, m: 70 + cI.m + cS.m });
  assert.equal(u.adquisicion.silla, 2006);
  const U = costear({ D, C, list: LISTA, ...BASE, inventario: inventarioUna(inv, D, Cn) });
  assert.equal(U.totales.rep, N.totales.rep);
  cerca(U.totales.total, N.totales.total, 'con inventario, la suma sigue cuadrando');

  // Lo cargado antes sin nivel en un local con varios niveles
  assert.ok(sinNivel({ bienes: { mesa: { b: 0, r: 0, m: 5 } } }, ['I', 'P']));
  assert.ok(!sinNivel({ bienes: { mesa: { b: 0, r: 0, m: 5 } } }, ['P']));
  assert.ok(!sinNivel(fila, ['I', 'P', 'S']));
  // En un local de un solo nivel vale lo de bienes
  const unNivel = LISTA.find(i => nivelesDeLocal(D, i).length === 1), cod = D.locs[unNivel][0], n = nivelesDeLocal(D, unNivel)[0];
  assert.deepEqual(inventarioNivel({ [cod]: { bienes: { mesa: { b: 1, r: 2, m: 3 } } } }, D, n)[cod].bienes, { mesa: { b: 1, r: 2, m: 3 } });
});

// Modelo de documentos de una IOARR por nivel (como modeloDe de expediente.js)
function modelos() {
  const G = porNivel(D, DEF, LISTA);
  const N = costear({ ...BASE, grupos: G.map(g => ({ clave: g.nivel, D: g.D, C: g.C, list: g.list })) });
  const datos = limpiarDatosDoc({ por_nivel: { P: { nombre_inversion: 'REPOSICIÓN PRIMARIA', cui: '2600001' } } });
  return G.map(g => {
    const dn = datos.por_nivel[g.nivel] || {};
    const M = armarModelo({ R: N.grupos[g.nivel], D: g.D, list: g.list, proyecto: { nombre: `Mariscal — IOARR ${g.nombre}`, region: 'Moquegua' },
      datos: { ...datos, nombre_inversion: dn.nombre_inversion || '', cui: dn.cui || '' }, precios: {}, fecha: '2026-10-21' });
    return Object.assign(M, { nivel: g.nivel, nombreIoarr: g.nombre });
  });
}

test('documentos por nivel: cada IOARR con sus UP, su nombre y su CUI', () => {
  const [I, P, S] = modelos();
  assert.match(I.nombreSugerido, /NIVEL INICIAL/); assert.doesNotMatch(I.nombreSugerido, /PRIMARIA/);
  assert.equal(P.nombre, 'REPOSICIÓN PRIMARIA'); assert.equal(P.cui, '2600001');
  assert.equal(S.cui, '');
  assert.ok(P.ups.every(u => u.niveles.length === 1 && u.niveles[0] === 'P'));
  assert.equal(P.ups.find(u => u.cod === ICHUNA).est, 106);
  assert.deepEqual(limpiarDatosDoc({ por_nivel: { P: { cui: 'abc', nombre_inversion: ' x ' }, X: { cui: '1234567' } } }).por_nivel, { P: { nombre_inversion: 'x', cui: '' } });
});

test('Excel del Selector: hoja «Por nivel»', async () => {
  const { buffer } = await generarExcel(D, C, DEF, LISTA, { proyecto: 'Prueba', fecha: '2026-10-21', ioarr: null });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Por nivel');
  assert.deepEqual([2, 3, 4].map(r => [ws.getRow(r).getCell(1).value, ws.getRow(r).getCell(8).value]), [['Inicial', 17], ['Primaria', 101], ['Secundaria', 80]]);
  const tot = ws.getRow(5);
  assert.equal(tot.getCell(1).value, 'Total');
  assert.deepEqual([3, 4, 8, 10].map(c => tot.getCell(c).value.result), [2085, 104, 198, 1531]);
  // Con la vista de un nivel, el Excel trae solo ese nivel
  const V = vistaNivel(D, 'P'), Cp = calc(V, DEF, 'P'), lp = LISTA.filter(i => V.locSvc[i].length);
  const x = await generarExcel(V, Cp, DEF, lp, { proyecto: 'Prueba — IOARR Primaria', fecha: '2026-10-21', ioarr: null });
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(x.buffer);
  const res = wb2.getWorksheet('Resumen'); let rep = null;
  res.eachRow(r => { if (r.getCell(1).value === 'Bienes a reponer (estado Malo, suma de los muebles de la IOARR)') rep = r.getCell(2).value.result; });
  assert.equal(rep, 101);
  assert.equal(wb2.getWorksheet('Locales (UP)').rowCount - 1, 4);
});

test('ZIP por nivel: una carpeta por IOARR y un índice común', async () => {
  const Ms = modelos(), partes = [], salida = new PassThrough();
  salida.on('data', c => partes.push(c));
  const fin = new Promise(ok => salida.on('end', ok));
  const piezas = Ms.flatMap((M, j) => [{ nombre: `0${j + 1}_IOARR_${M.nombreIoarr}/01_Formato_07C_borrador.docx`, contenido: Buffer.from('x') }]);
  await escribirZip(salida, { base: 'Exp', archivos: [], descargar: async () => Buffer.from(''), modelos: Ms, autor: 'yo@x.pe', proyecto: 'Mariscal', piezas });
  await fin;
  const z = await JSZip.loadAsync(Buffer.concat(partes));
  assert.deepEqual(Object.keys(z.files).filter(n => !z.files[n].dir).sort(),
    ['Exp/00_LEEME.txt', 'Exp/01_IOARR_Inicial/01_Formato_07C_borrador.docx', 'Exp/02_IOARR_Primaria/01_Formato_07C_borrador.docx', 'Exp/03_IOARR_Secundaria/01_Formato_07C_borrador.docx']);
  const leeme = await z.file('Exp/00_LEEME.txt').async('string');
  for (const s of ['Una IOARR por nivel: 3 IOARR', 'IOARR INICIAL', 'IOARR PRIMARIA', 'CUI: 2600001', 'confirmar con la OPMI']) assert.ok(leeme.includes(s), s);
});
