// Selector IOARR — Web Worker: guarda los datos de la región, calcula y filtra.
// La página solo recibe lo que pinta (una página de la tabla, un detalle, un resumen),
// así Lima (32 mil aulas) no congela la pantalla.
import { ITEMS, NIVN, NIVS, NIVB, DEF, prep, calc, totals, filtrar, lv, norm, limpiarParams, totalesPorNivel, estadoSituacional } from '/selector-ioarr/calculo.js';
import { cercanos, centroDistrito, localConCoord, haversine, MAX_PUNTOS } from '/selector-ioarr/cercania.js';
import { agruparVisitas, puntosVisita, repartirZonas } from '/selector-ioarr/visitas.js';

let D = null, C = null, P = { ...DEF }, sel = new Set(), view = [], codIdx = new Map();
let excl = new Set();   // locales excluidos por otra inversión vigente o reciente: siguen seleccionados, fuera de los totales
let dup = {};           // { codLocal: { estado, excluir } } para el cuadro de estado situacional
let km = new Map();     // con búsqueda por cercanía: índice de local → distancia al centro (km)
let centro = null;      // centro de la última consulta por cercanía
let solo = null;        // Visitas de campo: códigos del proyecto elegido (las consultas solo ven esos locales)
let omitir = null;      // Visitas de campo: colegios ya visitados que no se listan («Ocultar visitados»)

const pct = i => C.L.reqTot[i] > 0 ? C.L.repTot[i] / C.L.reqTot[i] : null;
const selIdx = () => [...sel].map(c => codIdx.get(c)).filter(i => i != null);

const acciones = {
  async cargar({ url, params }) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('No se pudo descargar la región (' + r.status + ')');
    D = prep(await r.json());
    codIdx = new Map(D.locs.map((l, i) => [l[0], i]));
    P = limpiarParams(params); C = calc(D, P); sel = new Set(); view = []; solo = null;
    return { region: D.region, provs: D.provs, ugels: D.ugels, dists: D.dists.map(d => [d[0], d[2]]), codigos: D.locs.length };
  },
  params({ params }) { P = limpiarParams(params); if (D) C = calc(D, P); return P; },
  // Fija la selección; devuelve los códigos que existen en la región
  sel({ codigos }) { sel = new Set(codigos.filter(c => codIdx.has(c))); return [...sel]; },
  // Limita las consultas a estos códigos (null = toda la región). Devuelve cuántos hay en la región y cuántos no
  limitar({ codigos }) {
    if (!codigos) { solo = null; return { n: 0, fuera: 0 }; }
    solo = new Set(codigos.filter(c => codIdx.has(c)));
    return { n: solo.size, fuera: new Set(codigos).size - solo.size };
  },
  // Visitas de campo: deja fuera de las consultas estos códigos (null = ninguno). No se borra al cambiar de región
  omitir({ codigos }) { omitir = codigos?.length ? new Set(codigos) : null; return omitir?.size || 0; },
  // Visitas de campo: reparte estos códigos en zonas cercanas, una por supervisor (cuotas = cantidad de cada uno).
  // Los que no están en el padrón de la región no se pueden ubicar: van en sobran
  repartir({ codigos, cuotas }) {
    const idx = codigos.map(c => codIdx.get(c)).filter(i => i != null);
    const { puntos, sinCoord } = puntosVisita(D, C, idx);
    const r = repartirZonas(puntos, cuotas, sinCoord.map(p => p.cod));
    const enRegion = new Set(idx.map(i => D.locs[i][0]));
    return { zonas: r.zonas, sobran: r.sobran, fuera: codigos.filter(c => !enRegion.has(c)) };
  },
  // Otra inversión vigente o reciente por local: { codLocal: { estado, codigo, excluir } }
  duplicidad({ mapa }) {
    dup = mapa || {};
    excl = new Set(Object.entries(dup).filter(([, d]) => d.estado === 'si' && d.excluir).map(([c]) => c));
    return excl.size;
  },

  // near = { lat, lon, n }: los n más cercanos entre los filtrados, en orden de distancia
  consulta({ f, sort, page, size, near }) {
    view = filtrar(D, C, f);
    if (solo) view = view.filter(i => solo.has(D.locs[i][0]));
    if (omitir) view = view.filter(i => !omitir.has(D.locs[i][0]));
    let cerca = null;
    if (near) {
      const r = cercanos(D, view, near, near.n);
      view = r.idx; km = new Map(r.idx.map((i, j) => [i, r.km[j]])); centro = { lat: near.lat, lon: near.lon };
      cerca = { n: view.length, max: r.km.length ? r.km[r.km.length - 1] : 0, omitidos: r.omitidos };
    } else {
      km = new Map(); centro = null;
      const k = sort.key, d = sort.dir;
      const val = { cod: i => D.locs[i][0], nom: i => norm(D.locName[i]), dist: i => norm(D.dists[D.locs[i][1]][0]), est: i => D.locEst[i],
        aul: i => D.locAul[i].length, rep: i => C.L.repTot[i], pct: i => pct(i) == null ? -1 : pct(i) }[k] || (i => C.L.repTot[i]);
      const vals = new Map(view.map(i => [i, val(i)]));
      view.sort((a, b) => { const x = vals.get(a), y = vals.get(b); return (x < y ? -1 : x > y ? 1 : 0) * d || D.locs[a][0].localeCompare(D.locs[b][0]); });
    }
    let est = 0, aul = 0, nsel = 0;
    for (const i of view) { est += D.locEst[i]; aul += D.locAul[i].length; if (sel.has(D.locs[i][0])) nsel++; }
    const pages = Math.max(1, Math.ceil(view.length / size)), pg = Math.min(page, pages - 1);
    const filas = view.slice(pg * size, pg * size + size).map(i => {
      const l = D.locs[i];
      return { i, cod: l[0], nom: D.locName[i], dist: D.dists[l[1]][0], cp: l[3], rural: l[4], est: D.locEst[i], aul: D.locAul[i].length,
        rep: C.L.repTot[i], pct: pct(i), niv: Object.keys(NIVN).filter(n => D.locNiv[i] & NIVB[n]).map(n => NIVS[n]), conv: !!(D.locGes[i] & 2),
        coord: localConCoord(l), km: km.has(i) ? km.get(i) : null };
    });
    return { total: view.length, est, aul, nsel, page: pg, pages, filas, cerca };
  },
  // Centro de búsqueda: { dist } (promedio de sus locales con coordenadas), { cod } (un local)
  // o { proyecto } (promedio de los locales del proyecto con coordenadas)
  centro({ dist, cod, proyecto }) {
    if (proyecto) {
      let lat = 0, lon = 0, n = 0;
      for (const c of solo || []) { const l = D.locs[codIdx.get(c)]; if (localConCoord(l)) { lat += l[6]; lon += l[7]; n++; } }
      if (!n) return { error: 'Ningún colegio del proyecto tiene coordenadas válidas en el padrón.' };
      return { lat: lat / n, lon: lon / n, label: `centro del proyecto «${proyecto}»` };
    }
    if (cod != null) {
      const i = codIdx.get(String(cod).trim());
      if (i == null) return { error: 'Ese código de local no está en esta región.' };
      const l = D.locs[i];
      if (!localConCoord(l)) return { error: `El local ${l[0]} no tiene coordenadas válidas en el padrón.` };
      return { lat: l[6], lon: l[7], label: `local ${l[0]}` };
    }
    const c = centroDistrito(D, dist);
    if (!c) return { error: 'Ese distrito no tiene locales con coordenadas válidas.' };
    return { lat: c.lat, lon: c.lon, label: `distrito de ${D.dists[dist][0]}` };
  },
  // Listado con direcciones de la vista actual, en su orden (con cercanía: de más cerca a más lejos)
  listado({ max = MAX_PUNTOS } = {}) {
    return view.slice(0, max).map((i, j) => {
      const l = D.locs[i];
      return { n: j + 1, cod: l[0], nom: D.locName[i], dist: D.dists[l[1]][0], cp: l[3] || '', dir: l[5] || '', rural: !!l[4],
        lat: l[6], lon: l[7], coord: localConCoord(l), est: D.locEst[i], rep: C.L.repTot[i], sel: sel.has(l[0]),
        niv: Object.keys(NIVN).filter(n => D.locNiv[i] & NIVB[n]).map(n => NIVS[n]), km: km.has(i) ? km.get(i) : null };
    });
  },
  // Puntos del mapa: los primeros MAX_PUNTOS de la vista actual con coordenadas válidas
  puntos() {
    const out = [];
    for (const i of view) {
      if (out.length >= MAX_PUNTOS) break;
      const l = D.locs[i];
      if (!localConCoord(l)) continue;
      out.push({ cod: l[0], nom: D.locName[i], dist: D.dists[l[1]][0], lat: l[6], lon: l[7], est: D.locEst[i], rep: C.L.repTot[i],
        sel: sel.has(l[0]), km: km.has(i) ? km.get(i) : centro ? haversine(centro.lat, centro.lon, l[6], l[7]) : null });
    }
    const conCoord = view.reduce((a, i) => a + (localConCoord(D.locs[i]) ? 1 : 0), 0);
    return { puntos: out, total: view.length, conCoord, recortado: conCoord > out.length, centro };
  },
  // Códigos de todo lo filtrado (para «Seleccionar / Quitar los filtrados»)
  codigosVista() { return view.map(i => D.locs[i][0]); },

  detalle({ i }) {
    const A = C.A, l = D.locs[i];
    return {
      cod: l[0], lat: l[6], lon: l[7],
      servicios: D.locSvc[i].map(si => { const s = D.svcs[si]; return { mod: s[0], niv: NIVN[s[2]], nom: s[1], conv: !!s[4], est: s[6], sec: s[5], aulas: D.svcAulN[si], tur: s[7] }; }),
      aulas: D.locAul[i].map(ai => {
        const a = D.aulas[ai];
        return { aula: a[4], edif: a[2], piso: a[3], grado: a[5], secc: a[6], tur: a[7], comp: !!a[9], est: a[8],
          t: [0, 1, 2, 3, 4].map(t => ({ b: A.b[t][ai], r: A.r[t][ai], m: A.m[t][ai], rep: A.rep[t][ai], fal: A.fal[t][ai] })) };
      })
    };
  },

  // Días de visita de la selección (sin los excluidos por otra inversión)
  visitas({ porDia }) {
    const todos = selIdx(), list = todos.filter(i => !excl.has(D.locs[i][0]));
    const { puntos, sinCoord } = puntosVisita(D, C, list);
    const sinI = ({ i, ...p }) => p;
    return { dias: agruparVisitas(puntos, porDia).map(d => ({ ...d, puntos: d.puntos.map(sinI) })), sinCoord: sinCoord.map(sinI),
      nExcl: todos.length - list.length, codigos: list.map(i => D.locs[i][0]) };
  },

  // Totales de la selección (barra inferior) y, con completo, el resumen de «Mi selección»
  resumen({ completo }) {
    const todos = selIdx(), list = todos.filter(i => !excl.has(D.locs[i][0])), T = totals(D, C, list);
    const base = { n: T.n, est: T.est, aul: T.aul, rep: T.rep, fal: T.fal, nExcl: todos.length - list.length };
    if (!completo) return base;
    const byD = new Map();
    for (const i of list) { const d = D.locs[i][1]; if (!byD.has(d)) byD.set(d, []); byD.get(d).push(i); }
    const distritos = [...byD.entries()].map(([d, ls]) => { const t = totals(D, C, ls); return { nom: D.dists[d][0], n: ls.length, est: t.est, aul: t.aul, rep: t.rep, fal: t.fal }; })
      .sort((a, b) => b.rep - a.rep);
    const locales = todos.slice().sort((a, b) => excl.has(D.locs[a][0]) - excl.has(D.locs[b][0]) || C.L.repTot[b] - C.L.repTot[a] || D.locs[a][0].localeCompare(D.locs[b][0])).map(i => {
      const l = D.locs[i];
      return { i, cod: l[0], excl: excl.has(l[0]), nom: D.locName[i], dist: D.dists[l[1]][0], lat: l[6], lon: l[7], est: D.locEst[i], aul: D.locAul[i].length, rep: C.L.repTot[i], fal: C.L.falTot[i],
        t: [0, 1, 2, 3, 4].map(t => lv(C, 'rep', t, i)) };
    });
    return { ...base, tipos: ITEMS.map((x, t) => ({ ...x, ...T.t[t] })), distritos, locales, niveles: totalesPorNivel(D, C, list),
      situacional: estadoSituacional(D, C, list, cod => dup[cod]?.estado) };
  }
};

self.onmessage = async ({ data: { id, tipo, ...args } }) => {
  try { self.postMessage({ id, ok: true, r: await acciones[tipo](args) }); }
  catch (e) { self.postMessage({ id, ok: false, error: e.message || String(e) }); }
};
