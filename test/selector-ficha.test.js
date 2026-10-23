// Pruebas de la ficha de verificación por local (npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { prep, calc, filtrar, FILTRO_VACIO, DEF } from '../src/selector-ioarr/calculo.js';
import { costear } from '../src/selector-ioarr/costos.js';
import { armarModelo } from '../src/selector-ioarr/documentos.js';
import { generar07C } from '../src/selector-ioarr/word.js';
import { porNivel, inventarioNivel, inventarioUna, nivelesDeLocal } from '../src/selector-ioarr/niveles.js';
import { modeloFicha, generarFichaExcel, generarFichaPdf, leerFicha, procesarFicha, verifFicha, requeridoFicha, leerAntiguedad, CAB_C } from '../src/selector-ioarr/ficha.js';

const D = prep(JSON.parse(readFileSync(new URL('../src/public/data/selector-ioarr/2025/moquegua.json', import.meta.url), 'utf8')));
const C = calc(D, DEF);
const LISTA = filtrar(D, C, { ...FILTRO_VACIO(), q: 'mariscal' });
const ICHUNA = '398420', iI = D.locs.findIndex(l => l[0] === ICHUNA);   // Inicial, Primaria y Secundaria, 31 aulas
const iU = LISTA.find(i => nivelesDeLocal(D, i).length === 1 && D.locAul[i].length >= 2);   // un solo nivel
const COD_U = D.locs[iU][0];
const CODIGOS = new Set(LISTA.map(i => D.locs[i][0]));
const META = { proyecto: { id: 'p-1', nombre: 'mariscal' }, anio: 2025, fecha: '2026-10-21' };
const CTX = { D, C, P: DEF, codigos: CODIGOS, proyectoId: 'p-1', anioDatos: 2025, hoy: '2026-10-21', archivo: 'ficha.xlsx' };
const BASE = { precios: { mesa: 180, silla: 90, esc: 400, sdoc: 120, arm: 650 }, uit: { anio: 2026, valor: 5500 } };

// Genera la ficha de un local y la llena: llenar(ws, filaDe) escribe en el libro
async function fichaLlena(i, llenar, meta = META) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await generarFichaExcel(modeloFicha(D, C, i, meta)));
  const ws = wb.getWorksheet('Ficha');
  const filas = [];
  ws.eachRow((row, n) => filas.push({ n, clave: row.getCell(13).value }));
  // n-ésima fila con esa clave (para ITEM|k, la del aula j)
  const filaDe = (clave, j = 0) => filas.filter(f => f.clave === clave)[j]?.n;
  llenar(ws, filaDe);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const poner = (ws, n, vals) => Object.entries(vals).forEach(([c, v]) => { ws.getCell(n, Number(c)).value = v; });
const conFecha = (ws, filaDe) => { ws.getCell(filaDe('A|fecha'), 2).value = new Date(Date.UTC(2026, 9, 15)); ws.getCell(filaDe('A|verificador'), 2).value = 'Ana Pérez, UGEL, DNI 12345678'; };
const importar = async (buf, ctx = {}) => procesarFicha(await leerFicha(buf), { ...CTX, ...ctx });
// Lo que quedaría guardado en ioarr_expediente_inventario
const filaGuardada = r => ({ cod_local: r.cod, ...r.fila, archivos: [] });

test('la ficha sale con las secciones del documento, el censo por aula y las claves para importarla', async () => {
  const F = modeloFicha(D, C, iI, META);
  assert.equal(F.aulas.length, 31);
  assert.deepEqual(F.servicios.map(s => [s.modular, s.nivel, s.est]), [['0225128', 'I', 47], ['0286799', 'P', 106], ['0591099', 'S', 101]]);
  // El censo de la ficha es el del cálculo: sumado da lo del local
  for (const [t, k] of ['mesa', 'silla', 'esc', 'sdoc', 'arm'].entries()) {
    const m = F.aulas.reduce((a, x) => a + x.censo[k].m, 0);
    assert.equal(m, C.L.m[t * C.nL + iI], `${k}: malo del censo`);
  }
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await generarFichaExcel(F));
  const ws = wb.getWorksheet('Ficha'), app = wb.getWorksheet('_app');
  assert.equal(app.state, 'veryHidden');
  assert.equal(app.getCell('B3').value, ICHUNA);
  assert.ok(ws.getColumn(13).hidden);
  const textos = []; ws.eachRow(r => r.eachCell(c => { if (typeof c.value === 'string') textos.push(c.value); }));
  for (const t of ['A. Datos del local educativo', 'B. Servicios educativos del local', 'C. Verificación del mobiliario por aula', 'D. Mobiliario fuera de aulas y panel fotográfico', 'E. Observaciones y conformidad', 'Criterios de estado y reglas de llenado'])
    assert.ok(textos.includes(t), 'falta la sección ' + t);
  for (const t of ['Censo Bueno', 'Censo Regular', 'Censo Malo', 'Verificado Bueno', 'Verificado Regular', 'Verificado Malo']) assert.ok(CAB_C.includes(t) && textos.includes(t));
  assert.ok(textos.some(t => /B = Bueno, R = Regular, M = Malo/.test(t)), 'nota de las siglas');
  const claves = []; ws.eachRow(r => { const v = r.getCell(13).value; if (v) claves.push(v); });
  assert.equal(claves.filter(c => String(c).startsWith('AULA|')).length, 31);
  assert.equal(claves.filter(c => String(c).startsWith('ITEM|')).length, 31 * 5);
  assert.equal(claves.filter(c => String(c).startsWith('FIRMA|')).length, 3);
});

test('el PDF imprimible se genera', async () => {
  const pdf = await generarFichaPdf(modeloFicha(D, C, iI, META));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 20000);
});

test('importar: filas completas, mesas en puestos, fila de mesa agregada y aviso del 15 %', async () => {
  const buf = await fichaLlena(iI, (ws, filaDe) => {
    conFecha(ws, filaDe);
    // Aula 1 (Inicial): 3 mesas múltiples de 4 puestos y 1 unipersonal mala, en dos filas
    poner(ws, filaDe('ITEM|mesa', 0), { 5: 1, 6: 1, 7: 1, 8: 4, 9: 'De 5 a 10', 12: 'Mesas hexagonales' });
    // Silla del aula 1: censo 0/13/11 → contado 2/10/12, con código patrimonial y baja
    poner(ws, filaDe('ITEM|silla', 0), { 5: 2, 6: 10, 7: 12, 9: 6, 10: '74089500-0001', 11: 'En trámite' });
    // Aula 3 (Primaria): silla con censo 0/53/3; se cuentan 0/20/20 sin observación → aviso
    poner(ws, filaDe('ITEM|silla', 2), { 5: 0, 6: 20, 7: 20, 9: 'más de 10' });
  });
  // Fila agregada a mano debajo de la mesa del aula 1 (sin clave): se reconoce por el nombre
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Ficha'); let nMesa = null;
  ws.eachRow((r, n) => { if (nMesa == null && r.getCell(13).value === 'ITEM|mesa') nMesa = n; });
  ws.spliceRows(nMesa + 1, 0, ['Mesa del estudiante (unipersonal)', null, null, null, 0, 0, 1, null, 10, null, 'No', 'Pata rota']);
  const r = await importar(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(r.rechazada, false, JSON.stringify(r.errores));
  assert.deepEqual(r.errores, []);
  assert.deepEqual(r.filas, { ok: 4, rechazadas: 0 });
  const a0 = r.fila.ficha.aulas[0];
  assert.deepEqual(a0.filas.filter(f => f.k === 'mesa').map(f => [f.b, f.r, f.m, f.puestos]), [[4, 4, 4, 4], [0, 0, 1, 1]]);
  assert.equal(a0.filas.find(f => f.k === 'silla').baja, 'en_tramite');
  assert.equal(a0.filas.find(f => f.k === 'silla').patrimonial, '74089500-0001');
  // Avisos del 15 %: la mesa del aula 1 (13 puestos frente a 24) tiene observación; la silla del aula 3, no
  assert.equal(r.avisos.length, 1, JSON.stringify(r.avisos));
  assert.match(r.avisos[0].motivo, /Silla del estudiante \(aula 3\).*más de 15 %/);
  // Por nivel: Inicial con mesa y silla; Primaria con silla (aula verificada + censo del resto)
  const pn = r.fila.por_nivel;
  assert.deepEqual(Object.keys(r.fila.bienes), []);
  const iMesa = 0, cens = (t, aulasNivel, quitar) => aulasNivel.filter(j => !quitar.includes(j)).reduce((a, j) => a + C.A.m[t][D.locAul[iI][j]], 0);
  const aulasP = D.locAul[iI].map((ai, j) => [j, D.svcs[D.aulas[ai][1]][2]]).filter(([, n]) => n === 'P').map(([j]) => j);
  assert.equal(pn.I.bienes.mesa.m, 4 + 1 + cens(iMesa, [1], []));
  assert.equal(pn.P.bienes.silla.m, 20 + cens(1, aulasP, [2]));
  assert.ok(!pn.S, 'Secundaria sin nada verificado');
  // Antigüedad: año de la visita menos los años; el rango queda como estimado
  assert.equal(pn.P.adquisicion.silla, 2026 - 12);
  assert.deepEqual(r.fila.ficha.adq_estimada, { I: ['mesa'], P: ['silla'] });
  assert.equal(r.fila.fecha_visita, '2026-10-15');
  assert.equal(r.fila.responsable, 'Ana Pérez, UGEL, DNI 12345678');
});

test('importar: rechaza filas a medias, negativas o con decimales, y archivos de otro local', async () => {
  const buf = await fichaLlena(iI, (ws, filaDe) => {
    conFecha(ws, filaDe);
    poner(ws, filaDe('ITEM|mesa', 0), { 5: 1, 6: 2 });                     // a medias
    poner(ws, filaDe('ITEM|silla', 0), { 5: -1, 6: 0, 7: 3 });             // negativa
    poner(ws, filaDe('ITEM|esc', 0), { 5: 0, 6: 0.5, 7: 1 });              // decimal
    poner(ws, filaDe('ITEM|arm', 0), { 5: 0, 6: 1, 7: 0, 11: 'Quizás' });  // baja no válida
    poner(ws, filaDe('ITEM|mesa', 1), { 5: 0, 6: 0, 7: 2, 8: 20 });        // puestos fuera de rango
    poner(ws, filaDe('ITEM|sdoc', 1), { 5: 1, 6: 0, 7: 0, 9: 'viejo' });   // antigüedad no válida
    poner(ws, filaDe('ITEM|silla', 1), { 5: 0, 6: 4, 7: 5, 12: 'Igual al censo' });   // válida
  });
  const r = await importar(buf);
  assert.equal(r.rechazada, false);
  assert.deepEqual(r.filas, { ok: 1, rechazadas: 6 });
  assert.equal(r.errores.length, 6);
  assert.ok(r.errores.every(e => e.hoja === 'Ficha' && Number.isInteger(e.fila) && /La fila no se importa/.test(e.motivo)));
  assert.match(r.errores[0].motivo, /llena los tres estados/);
  assert.match(r.errores[1].motivo, /enteros de 0 o más/);
  assert.match(r.errores[3].motivo, /estado de baja no válido/);
  assert.match(r.errores[4].motivo, /puestos por unidad/);
  assert.match(r.errores[5].motivo, /antigüedad no válida/i);

  // Código de local que no está en el proyecto: se rechaza el archivo
  const otro = await importar(buf, { codigos: new Set([COD_U]) });
  assert.equal(otro.rechazada, true);
  assert.match(otro.errores.at(-1).motivo, /no está en el proyecto/);
  // Sin fecha de la verificación
  const sinFecha = await importar(await fichaLlena(iI, (ws, filaDe) => poner(ws, filaDe('ITEM|silla', 0), { 5: 0, 6: 0, 7: 1 })));
  assert.equal(sinFecha.rechazada, true);
  assert.match(sinFecha.errores.at(-1).motivo, /Falta la fecha/);
  // Sin ninguna cantidad
  const vacia = await importar(await fichaLlena(iI, conFecha));
  assert.equal(vacia.rechazada, true);
  // Generada con otro censo, o un Excel que no es ficha
  assert.equal((await importar(buf, { anioDatos: 2026 })).rechazada, true);
  const wb = new ExcelJS.Workbook(); wb.addWorksheet('Hoja1').getCell('A1').value = 'x';
  const noFicha = await importar(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(noFicha.rechazada, true);
  assert.match(noFicha.errores[0].motivo, /No es una ficha/);
});

test('antigüedad: años o rango', () => {
  assert.deepEqual(leerAntiguedad(7), { anios: 7, estimada: false, texto: '7' });
  assert.equal(leerAntiguedad('Menos de 5').estimada, true);
  assert.equal(leerAntiguedad('de 5 a 10 años').anios, 8);
  assert.equal(leerAntiguedad('> 10').anios, 12);
  assert.ok(leerAntiguedad('mucho').error);
  assert.equal(leerAntiguedad(''), null);
});

test('lo verificado reemplaza al censo en los costos y el 07-C indica el porcentaje verificado', async () => {
  // Local de un solo nivel: todas sus aulas con la silla contada, 3 más en mal estado que el censo
  const aulas = D.locAul[iU], tS = 1;
  const r = await importar(await fichaLlena(iU, (ws, filaDe) => {
    conFecha(ws, filaDe);
    aulas.forEach((ai, j) => poner(ws, filaDe('ITEM|silla', j), { 5: C.A.b[tS][ai], 6: C.A.r[tS][ai], 7: C.A.m[tS][ai] + (j === 0 ? 3 : 0), 12: 'Contado' }));
  }));
  assert.equal(r.rechazada, false, JSON.stringify(r.errores));
  const mSilla = C.L.m[tS * C.nL + iU];
  assert.deepEqual(Object.keys(r.fila.bienes), ['silla']);
  assert.equal(r.fila.bienes.silla.m, mSilla + 3);
  assert.deepEqual(verifFicha(r.fila, '_', r.fila.bienes), { silla: { mv: mSilla + 3, mc: 0 } });

  // IOARR única del caso de control con este local verificado
  const inv = { [COD_U]: filaGuardada(r) };
  const Gn = porNivel(D, DEF, LISTA), Cn = Object.fromEntries(Gn.map(g => [g.nivel, g.C]));
  const R = costear({ D, C, list: LISTA, ...BASE, inventario: inventarioUna(inv, D, Cn) });
  assert.equal(R.totales.rep, 198 + 3);
  assert.equal(R.totales.repVerif, mSilla + 3);
  const loc = R.locales.find(l => l.cod === COD_U);
  assert.deepEqual(loc.verificado.tipos, ['silla']);
  const M = armarModelo({ R, D, list: LISTA, proyecto: { nombre: 'mariscal', region: 'Moquegua' }, datos: {}, precios: {}, inv, fecha: '2026-10-21' });
  const pct = Math.round((mSilla + 3) / 201 * 1000) / 10;
  assert.equal(M.cantidades.pct, pct);
  assert.match(M.cantidades.texto, new RegExp(`verificadas en campo: ${pct.toLocaleString('es-PE')} %`));
  const item = M.verificacion.secciones.flatMap(s => s.items).find(x => /verificadas en campo/.test(x.texto));
  assert.equal(item.estado, 'pendiente');
  const xml = await (await JSZip.loadAsync(await generar07C(M))).file('word/document.xml').async('string');
  assert.ok(xml.includes('Cantidades a reponer verificadas en campo'), 'el 07-C lleva el porcentaje verificado');

  // Si después se corrige a mano, ese tipo cuenta como verificado en su totalidad
  const aMano = { ...filaGuardada(r), bienes: { silla: { ...r.fila.bienes.silla, m: r.fila.bienes.silla.m + 1 } } };
  assert.deepEqual(verifFicha(aMano, '_', aMano.bienes), {});
  const R2 = costear({ D, C, list: LISTA, ...BASE, inventario: inventarioUna({ [COD_U]: aMano }, D, Cn) });
  assert.equal(R2.totales.repVerif, mSilla + 4);
});

test('por nivel: cada IOARR cuenta solo lo verificado de su nivel', async () => {
  const r = await importar(await fichaLlena(iI, (ws, filaDe) => {
    conFecha(ws, filaDe);
    poner(ws, filaDe('ITEM|silla', 0), { 5: 0, 6: 13, 7: 11 });   // Inicial, igual al censo
    poner(ws, filaDe('ITEM|silla', 2), { 5: 0, 6: 50, 7: 6 });    // Primaria: 6 malas (censo 3)
  }));
  const inv = { [ICHUNA]: filaGuardada(r) };
  const G = porNivel(D, DEF, LISTA);
  const N = costear({ ...BASE, grupos: G.map(g => ({ clave: g.nivel, D: g.D, C: g.C, list: g.list, inventario: inventarioNivel(inv, D, g.nivel) })) });
  assert.equal(N.grupos.I.totales.repVerif, 11);
  assert.equal(N.grupos.P.totales.repVerif, 6);
  assert.equal(N.grupos.S.totales.repVerif, 0);
  assert.equal(N.grupos.P.totales.rep, 101 + 3);
  // La IOARR única suma lo mismo
  const Cn = Object.fromEntries(G.map(g => [g.nivel, g.C]));
  const U = costear({ D, C, list: LISTA, ...BASE, inventario: inventarioUna(inv, D, Cn) });
  assert.equal(U.totales.rep, 198 + 3);
  assert.equal(U.totales.repVerif, 17);
});

test('los estudiantes verificados cambian el requerido y el faltante, no lo que se repone', async () => {
  const r = await importar(await fichaLlena(iU, (ws, filaDe) => {
    conFecha(ws, filaDe);
    ws.getCell(filaDe('AULA|0'), 12).value = D.aulas[D.locAul[iU][0]][8] + 10;
    poner(ws, filaDe('ITEM|arm', 0), { 5: 1, 6: 0, 7: 0 });
  }));
  const fila = filaGuardada(r);
  fila.req_ficha = requeridoFicha(fila, D, DEF, iU);
  const reqCenso = C.L.req[0 * C.nL + iU];
  assert.equal(fila.req_ficha._.mesa, reqCenso + 10);
  const Cn = Object.fromEntries(porNivel(D, DEF, [iU]).map(g => [g.nivel, g.C]));
  const sin = costear({ D, C, list: [iU], ...BASE }), con = costear({ D, C, list: [iU], ...BASE, inventario: inventarioUna({ [COD_U]: fila }, D, Cn) });
  assert.equal(con.partidas[0].req, reqCenso + 10);
  assert.equal(con.partidas[0].rep, sin.partidas[0].rep);
});

// ─── Fichas por supervisor (reparto de Visitas de campo) ─────────────────────
test('la ficha dice el supervisor asignado y se sigue importando igual', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await generarFichaExcel(modeloFicha(D, C, iU, { ...META, supervisor: 'ana@ibero.pe' })));
  let texto = '';
  wb.getWorksheet('Ficha').eachRow(row => row.eachCell(c => { texto += ' ' + (c.value ?? ''); }));
  assert.match(texto, /Supervisor asignado: ana@ibero\.pe/);
  const sin = new ExcelJS.Workbook();
  await sin.xlsx.load(await generarFichaExcel(modeloFicha(D, C, iU, META)));
  let t2 = ''; sin.getWorksheet('Ficha').eachRow(row => row.eachCell(c => { t2 += ' ' + (c.value ?? ''); }));
  assert.doesNotMatch(t2, /Supervisor asignado/);
  const r = await importar(await fichaLlena(iU, (ws, filaDe) => { conFecha(ws, filaDe); poner(ws, filaDe('ITEM|silla', 0), { 5: 0, 6: 0, 7: 1 }); }, { ...META, supervisor: 'ana@ibero.pe' }));
  assert.equal(r.rechazada, false);
  assert.ok((await generarFichaPdf(modeloFicha(D, C, iU, { ...META, supervisor: 'ana@ibero.pe' }))).length > 1000);
});

test('las reglas explican «Puestos por unidad» y su fila del Excel tiene alto para el texto completo', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await generarFichaExcel(modeloFicha(D, C, iU, META)));
  const ws = wb.getWorksheet('Ficha');
  let fila = null;
  ws.eachRow(row => { if (/^• «Puestos por unidad»/.test(String(row.getCell(1).value || ''))) fila = row; });
  assert.ok(fila, 'la regla está en la hoja');
  assert.match(fila.getCell(1).value, /carpeta bipersonal = 2/);
  assert.match(fila.getCell(1).value, /Ejemplo: 12 carpetas bipersonales/);
  assert.ok(fila.height >= 56, `alto ${fila.height}`);
  const pdf = (await generarFichaPdf(modeloFicha(D, C, iU, META))).length;
  assert.ok(pdf > 1000);
});
