// Caso de control del escenario «Malo + % de Regular»: cantidades con % = 0, 25, 50 y 100
// (y «Solo Malo» y «Malo + Regular» para comparar), solo con el Censo Educativo 2025.
// No usa el inventario verificado ni la base de datos.
//
//   node scripts/selector-ioarr/control-pct-regular.mjs <region> <nivel> [provincia] [archivo-con-códigos]
//   node scripts/selector-ioarr/control-pct-regular.mjs loreto P Maynas codigos.txt
//
// Sin archivo de códigos toma todos los locales del nivel en la provincia. El archivo puede
// traer códigos de local (6 dígitos) o modulares (7), separados por lo que sea.
import { readFileSync } from 'node:fs';
import { prep, limpiarParams, buscarCodigos } from '../../src/selector-ioarr/calculo.js';
import { costear, preciosEfectivos } from '../../src/selector-ioarr/costos.js';
import { porNivel } from '../../src/selector-ioarr/niveles.js';

const [region = 'loreto', nivel = 'P', provincia, archivo] = process.argv.slice(2);
const D = prep(JSON.parse(readFileSync(new URL(`../../src/public/data/selector-ioarr/2025/${region}.json`, import.meta.url), 'utf8')));
const iProv = provincia ? D.provs.findIndex(p => p.toLowerCase() === provincia.toLowerCase()) : -1;
if (provincia && iProv < 0) { console.error(`Provincia no encontrada: ${provincia}. Hay: ${D.provs.join(', ')}`); process.exit(1); }
let list;
if (archivo) {
  const b = buscarCodigos(D, readFileSync(archivo, 'utf8'));
  if (b.noEncontrados.length) console.log(`No están en ${D.region}: ${b.noEncontrados.join(', ')}`);
  list = b.idx;
} else list = D.locs.map((_, i) => i).filter(i => (iProv < 0 || D.dists[D.locs[i][1]][2] === iProv) && D.locSvc[i].some(si => D.svcs[si][2] === nivel));
const precios = Object.fromEntries(Object.entries(preciosEfectivos({}, {})).map(([k, v]) => [k, v.precio]));

const filas = [['Solo Malo', { escenario: 'malo' }], ...[0, 25, 50, 100].map(p => [`Malo + ${p} % de Regular`, { escenario: 'malo_regular', pctRegular: p }])].map(([n, c]) => {
  const P = limpiarParams({ ...c, muebles: ['mesa', 'silla'] });
  const g = porNivel(D, P, list).find(x => x.nivel === nivel);
  const R = costear({ D: g.D, C: g.C, list: g.list, precios, estructura: { kit: true }, uit: null });
  return { n, locales: R.totales.locales, mesa: R.partidas[0].rep, silla: R.partidas[1].rep, kits: R.totales.kits, total: R.totales.total };
});
const f = n => n.toLocaleString('es-PE', { maximumFractionDigits: 2 });
console.log(`${D.region} · ${provincia || 'todas las provincias'} · nivel ${nivel} · ${filas[0].locales} locales · mesa y silla, kit, precios de referencia Loreto 2026`);
console.log(['Escenario', 'Mesas (puestos)', 'Sillas', 'Kits', 'Monto (S/)'].join(' | '));
for (const x of filas) console.log([x.n, f(x.mesa), f(x.silla), f(x.kits), f(x.total)].join(' | '));
