// ============================================================================
// src/selector-ioarr/costos.js — Estructura de costos del expediente IOARR
//
// Función pura: la usan la API (pantalla) y el Excel, así las dos dan lo mismo.
// No trae precios, UIT ni porcentajes: todo lo carga el usuario.
//
// Metrado por local y tipo de bien (sale de calc() de calculo.js):
//   Reposición = Malo, por aula (Bueno y Regular solo son diagnóstico)
//   Faltante   = MAX(0, Requerido − Existente), por aula: brecha de dotación, no reposición
// Solo la reposición entra al costo de inversión. El faltante amplía la capacidad
// de la UP, y los Lineamientos IOARR del MEF (2.4.C) no admiten sustentar una
// reposición en eso: se valoriza aparte, como referencia, y no suma al total.
//
// Tallas (TALLAS en calculo.js): mesa y silla se costean por talla. Cada aula toma
// la talla de su grado; un aula multigrado reparte en partes iguales entre las
// tallas de su nivel. Con inventario verificado (por local, no por aula), lo
// verificado se reparte entre las tallas en proporción al censo del local
// (o a sus estudiantes, o en partes iguales). Los repartos van en enteros y
// suman lo del tipo. Cada talla usa su precio; sin precio propio, el de su tipo.
//
// Cálculo por local (después se suma):
//   CD        = Σ reposición × precio unitario (sin IGV), por línea (talla)
//   Bienes    transporte, instalación, embalaje: sobre el CD; transporte e
//             instalación × (1 + factor por zona del local)
//   Subtotal  = CD + transporte + instalación + embalaje
//   GG, utilidad: sobre el CD o el subtotal
//   Neto      = subtotal + GG + utilidad
//   IGV       sobre el neto
//   Costo de los bienes = neto + IGV
//   Otros     supervisión, expediente, gestión, imprevistos: sobre el CD, el
//             subtotal o el costo de los bienes
//   Total     = costo de los bienes + otros
// Rubro en %: base del local × %. Rubro en monto fijo: se reparte entre los
// locales en proporción a su base (en partes iguales si la base suma 0).
// ============================================================================

import { ITEMS, TALLAS, TIPOS_TALLA, LINEAS, CLAVES_PRECIO, tallasDeAula } from './calculo.js';
export { TALLAS, LINEAS, CLAVES_PRECIO };

export const TIPOS = ITEMS.map(x => x.k);                       // ['mesa', 'silla', 'esc', 'sdoc', 'arm']
export const FUENTES_PRECIO = { cotizacion: 'Cotización', seace: 'SEACE', historico: 'Histórico propio' };
export const BASES = { cd: 'Costo directo', subtotal: 'Subtotal (CD + transporte, instalación y embalaje)', neto: 'Subtotal + GG + utilidad', bienes: 'Costo de los bienes (con IGV)' };
// Archivos de sustento del inventario verificado (src/selector-ioarr/archivos.js)
export const TIPOS_ARCHIVO = {
  acta: 'Acta de verificación', foto: 'Foto', inventario_patrimonial: 'Inventario patrimonial',
  baja: 'Resolución o trámite de baja', otro: 'Otro'
};
export const LIMITE_UIT = 75;   // registro completo del Formato 07-C si la inversión supera 75 UIT

// Propone el tipo de bien a partir de la descripción (al copiar un precio de Radar IOARR).
// Devuelve null si no se reconoce: el usuario lo elige a mano.
export function tipoDesdeDescripcion(desc) {
  const t = String(desc || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const docente = /docente|profesor|maestr/.test(t);
  if (/armario|estante|anaquel|repisa|locker|casillero/.test(t)) return 'arm';
  if (/escritorio/.test(t) || (/mesa/.test(t) && docente)) return 'esc';
  if (/silla|asiento/.test(t)) return docente ? 'sdoc' : 'silla';
  if (/mesa|carpeta|pupitre/.test(t)) return 'mesa';
  return null;
}

// grupo: orden de cálculo. zona: qué factor por zona se le aplica.
export const RUBROS = [
  { clave: 'transporte', nombre: 'Transporte (flete)', grupo: 'bienes', bases: ['cd'], zona: 'flete' },
  { clave: 'instalacion', nombre: 'Instalación o armado', grupo: 'bienes', bases: ['cd'], zona: 'instalacion' },
  { clave: 'embalaje', nombre: 'Embalaje', grupo: 'bienes', bases: ['cd'] },
  { clave: 'gg', nombre: 'Gastos generales', grupo: 'contrato', bases: ['subtotal', 'cd'] },
  { clave: 'utilidad', nombre: 'Utilidad', grupo: 'contrato', bases: ['subtotal', 'cd'] },
  { clave: 'igv', nombre: 'IGV', grupo: 'igv', bases: ['neto'] },
  { clave: 'supervision', nombre: 'Supervisión', grupo: 'otros', bases: ['bienes', 'subtotal', 'cd'] },
  { clave: 'expediente', nombre: 'Elaboración de expediente o ficha', grupo: 'otros', bases: ['bienes', 'subtotal', 'cd'] },
  { clave: 'gestion', nombre: 'Gestión del proyecto', grupo: 'otros', bases: ['bienes', 'subtotal', 'cd'] },
  { clave: 'imprevistos', nombre: 'Imprevistos', grupo: 'otros', bases: ['cd', 'subtotal', 'bienes'] }
];
const RUBRO = Object.fromEntries(RUBROS.map(r => [r.clave, r]));
const DEL_GRUPO = g => RUBROS.filter(r => r.grupo === g);

// Rubros válidos a partir de lo guardado: todos presentes, en su orden, valor 0 por defecto
export function limpiarRubros(arr) {
  const guardado = new Map((Array.isArray(arr) ? arr : []).filter(r => r && RUBRO[r.clave]).map(r => [r.clave, r]));
  return RUBROS.map(def => {
    const g = guardado.get(def.clave) || {};
    const modo = g.modo === 'monto' ? 'monto' : 'pct';
    let valor = Number(g.valor);
    if (!Number.isFinite(valor) || valor < 0) valor = 0;
    if (modo === 'pct') valor = Math.min(valor, 1000);
    valor = Math.min(valor, 1e12);
    return { clave: def.clave, modo, valor, base: def.bases.includes(g.base) ? g.base : def.bases[0] };
  });
}

// Factor por zona de un local (en fracción): distrito o, si no hay, provincia; + rural del departamento
export function factorZona(ubigeo, rural, idx) {
  const u = String(ubigeo || '');
  const z = idx.distrito.get(u) || idx.provincia.get(u.slice(0, 4)) || { f: 0, i: 0 };
  const r = rural ? idx.rural.get(u.slice(0, 2)) || { f: 0, i: 0 } : { f: 0, i: 0 };
  return { flete: (z.f + r.f) / 100, instalacion: (z.i + r.i) / 100 };
}
export function indiceFactores(factores) {
  const idx = { provincia: new Map(), distrito: new Map(), rural: new Map() };
  for (const x of factores || []) {
    if (!idx[x.ambito]) continue;
    idx[x.ambito].set(String(x.codigo), { f: Number(x.pct_flete) || 0, i: Number(x.pct_instalacion) || 0 });
  }
  return idx;
}

// Reparte un entero (total) según pesos, en enteros que suman total (mayor resto).
// Sin pesos (todos 0) devuelve todo 0; quien llama decide otro reparto.
export function repartir(total, pesos) {
  const s = pesos.reduce((a, b) => a + b, 0), out = pesos.map(() => 0);
  const T = Math.round(total);
  if (!s || !T) return out;
  const ex = pesos.map(w => T * w / s);
  let resto = T;
  ex.forEach((v, j) => { out[j] = Math.floor(v); resto -= out[j]; });
  const orden = ex.map((v, j) => [v - Math.floor(v), j]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let q = 0; q < resto; q++) out[orden[q % orden.length][1]]++;
  return out;
}

// Pesos por talla de mesa (0) y silla (1) en el local i, sumando sus aulas del censo:
// { b, r, m, req, fal, est, aul } → arreglos del largo de TALLAS. Un aula multigrado
// suma en partes iguales a las tallas de su nivel. 'niv' marca las tallas de los
// niveles del local (último recurso para repartir).
export function pesosTalla(D, C, i) {
  const nT = TALLAS.length, vacio = () => new Array(nT).fill(0);
  const W = [0, 1].map(() => ({ b: vacio(), r: vacio(), m: vacio(), req: vacio(), fal: vacio(), est: vacio(), aul: vacio(), niv: vacio() }));
  for (const si of D.locSvc[i]) for (const w of W) TALLAS.forEach((z, j) => { if (z.nivel === D.svcs[si][2]) w.niv[j] = 1; });
  for (const ai of D.locAul[i]) {
    const a = D.aulas[ai], js = tallasDeAula(D.svcs[a[1]][2], a[5]), parte = 1 / js.length;
    for (const t of [0, 1]) {
      const w = W[t];
      for (const j of js) {
        w.b[j] += C.A.b[t][ai] * parte; w.r[j] += C.A.r[t][ai] * parte; w.m[j] += C.A.m[t][ai] * parte;
        w.req[j] += C.A.req[t][ai] * parte; w.fal[j] += C.A.fal[t][ai] * parte;
        w.est[j] += a[8] * parte; w.aul[j] += parte;
      }
    }
  }
  return W;
}
// Reparte total con el primer peso que no sea todo 0
const repartirCon = (total, ...pesos) => {
  for (const w of pesos) if (w.some(x => x > 0)) return repartir(total, w);
  return repartir(total, pesos[pesos.length - 1].map(() => 1));
};

// Mobiliario que el censo reporta en el local i: { mesa: { b, r, m, req }, ... }
export function censoLocal(C, i) {
  return Object.fromEntries(TIPOS.map((k, t) => { const o = t * C.nL + i; return [k, { b: C.L.b[o], r: C.L.r[o], m: C.L.m[o], req: C.L.req[o] }]; }));
}

// Valida el inventario verificado en campo: { mesa: { b, r, m }, ... }, solo tipos conocidos
export function limpiarInventario(bienes) {
  const out = {};
  for (const k of TIPOS) {
    const x = bienes?.[k];
    if (!x || typeof x !== 'object') continue;
    const v = ['b', 'r', 'm'].map(c => Number(x[c] ?? 0));
    if (v.some(n => !Number.isInteger(n) || n < 0 || n > 1e6)) throw Object.assign(new Error('Cantidades no válidas: usa enteros de 0 o más'), { status: 400 });
    out[k] = { b: v[0], r: v[1], m: v[2] };
  }
  return out;
}

// Año de adquisición por tipo de bien: { mesa: 2008 }. Solo años entre 1950 y anioMax.
export function limpiarAdquisicion(obj, anioMax) {
  const out = {};
  for (const k of TIPOS) {
    const v = obj?.[k];
    if (v === '' || v == null) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1950 || n > anioMax) throw Object.assign(new Error(`Año de adquisición no válido: usa un año entre 1950 y ${anioMax}`), { status: 400 });
    out[k] = n;
  }
  return out;
}

/**
 * Estructura de costos.
 * @param {object} p
 *   D, C, list   datos de la región (prep), cálculo (calc) e índices de los locales elegidos
 *   precios      { mesa: number | null, ... } precio unitario sin IGV por tipo
 *   rubros       lista de limpiarRubros()
 *   factores     filas de ioarr_factores_zona
 *   uit          { anio, valor } | null
 *   inventario   { [codLocal]: { bienes: { mesa: { b, r, m } }, fecha_visita, observacion } } verificado en campo
 *   grupos       opcional: [{ clave, D, C, list, inventario }] varias IOARR que se costean juntas
 *                (una por nivel, ver niveles.js). Reemplaza a D, C, list e inventario.
 *
 * Con inventario verificado, en ese local y tipo se reemplaza el censo:
 *   Faltante = MAX(0, Requerido − (B + R + M)), Reposición = M, por local.
 * Con la ficha de verificación (ficha.js), el inventario trae además verif
 * ({ k: { mv, mc } }: Malo contado en campo y Malo del censo en las aulas sin
 * verificar) y req (requerido con los estudiantes verificados). repVerif es la
 * parte de la reposición verificada en campo, para el porcentaje del 07-C.
 *
 * Con grupos, los rubros en % se aplican igual en cada IOARR y los montos fijos
 * se reparten entre todos los locales de todas, según su base: así la suma de
 * las IOARR es el total del proyecto. Devuelve el resultado del conjunto y, en
 * grupos[clave], el de cada IOARR (sus rubros en monto fijo traen la parte que
 * le toca en valor, y el monto del proyecto en valor_proyecto).
 */
export function costear({ D, C, list, precios, rubros, factores, uit, inventario, grupos }) {
  const R = limpiarRubros(rubros);
  const val = k => precios?.[k] != null && Number(precios[k]) >= 0 ? Number(precios[k]) : null;
  // Precio por línea: el de la talla o, si no tiene, el de su tipo
  const pu = LINEAS.map(x => (x.talla ? val(x.k) : null) ?? val(x.tipo));
  const puGeneral = TIPOS.map(val);
  const propio = LINEAS.map(x => !!x.talla && val(x.k) != null);   // la talla tiene precio propio
  const idx = indiceFactores(factores);
  const fuentes = grupos || [{ clave: null, D, C, list, inventario }];

  // ── Por local: metrado, CD y factores ─────────────────────────────────────
  const locales = fuentes.flatMap(g => g.list.map(i => localDe(g, i, pu, idx)));
  const n = locales.length;

  // Aplica un grupo de rubros: base(local) → monto del rubro en cada local
  const aplicar = (grupo, baseDe) => {
    for (const def of DEL_GRUPO(grupo)) {
      const x = R.find(r => r.clave === def.clave);
      const base = loc => baseDe(loc, x.base);
      const suma = locales.reduce((a, loc) => a + base(loc), 0);
      for (const loc of locales) {
        const m = x.modo === 'pct' ? base(loc) * x.valor / 100
          : (suma ? x.valor * base(loc) / suma : x.valor / (n || 1));
        loc.rf[def.clave] = m;   // antes del factor por zona: la parte del monto fijo
        loc.r[def.clave] = def.zona ? m * (1 + loc.zona[def.zona]) : m;
      }
    }
  };
  const sumaR = (loc, g) => DEL_GRUPO(g).reduce((a, def) => a + loc.r[def.clave], 0);
  const elegir = (loc, b) => b === 'cd' ? loc.cd : b === 'subtotal' ? loc.subtotal : b === 'neto' ? loc.neto : loc.bienes;

  aplicar('bienes', loc => loc.cd);
  for (const loc of locales) loc.subtotal = loc.cd + sumaR(loc, 'bienes');
  aplicar('contrato', elegir);
  for (const loc of locales) loc.neto = loc.subtotal + sumaR(loc, 'contrato');
  aplicar('igv', elegir);
  for (const loc of locales) loc.bienes = loc.neto + loc.r.igv;
  aplicar('otros', elegir);
  for (const loc of locales) loc.total = loc.bienes + sumaR(loc, 'otros');

  const incl = fuentes[0]?.C?.incl || TIPOS.map(() => true);
  const P = { pu, puGeneral, propio, incl };
  const res = resumir(locales, R, P, uit, false);
  if (grupos) res.grupos = Object.fromEntries(grupos.map(g => [g.clave, resumir(locales.filter(l => l.grupo === g.clave), R, P, uit, true)]));
  return res;
}

function localDe(g, i, pu, idx) {
  const { D, C, inventario } = g, nL = C.nL, incl = C.incl || TIPOS.map(() => true);
  const l = D.locs[i], d = D.dists[l[1]];
  const rep = TIPOS.map((_, t) => C.L.rep[t * nL + i]);
  const fal = TIPOS.map((_, t) => C.L.fal[t * nL + i]);
  // Diagnóstico (bueno, regular, malo) y requerido: se muestran siempre, aunque solo Malo se reponga
  const diag = TIPOS.map((_, t) => ({ b: C.L.b[t * nL + i], r: C.L.r[t * nL + i], m: C.L.m[t * nL + i], req: C.L.req[t * nL + i] }));
  const inv = inventario?.[l[0]];
  // Parte de lo que se repone que está verificada en campo (el resto sale del censo)
  const repVerif = TIPOS.map(() => 0);
  let verificado = null;
  if (inv) {
    const tipos = [];
    TIPOS.forEach((k, t) => {
      if (!incl[t]) return;   // mueble que no entra a la IOARR
      const x = inv.bienes?.[k];
      // Requerido con los estudiantes verificados en la ficha (solo mesas y sillas; cambia el faltante)
      const req = inv.req?.[k] ?? null;
      if (req != null) diag[t] = { ...diag[t], req };
      if (!x) {
        if (req != null) fal[t] = Math.max(0, req - (diag[t].b + diag[t].r + diag[t].m));
        return;
      }
      fal[t] = Math.max(0, (req ?? C.L.req[t * nL + i]) - (x.b + x.r + x.m));
      rep[t] = x.m;
      // Con ficha, solo las aulas contadas; corregido a mano, todo el tipo
      repVerif[t] = inv.verif?.[k] ? inv.verif[k].mv : x.m;
      diag[t] = { ...diag[t], b: x.b, r: x.r, m: x.m };
      tipos.push(k);
    });
    // Visita registrada: puede corregir cantidades (tipos) o solo traer el año de adquisición
    verificado = { tipos, adquisicion: inv.adquisicion || {}, adq_estimada: inv.adq_estimada || [], fecha_visita: inv.fecha_visita, responsable: inv.responsable || null, observacion: inv.observacion,
      ficha: inv.ficha ? { archivo: inv.ficha.archivo, importado_en: inv.ficha.importado_en, verificador: inv.ficha.verificador } : null };
  }
  // Por línea (talla): mesa y silla repartidas según las aulas del censo
  const W = pesosTalla(D, C, i);
  const lin = { rep: [], fal: [], b: [], r: [], m: [], req: [] };
  const porTalla = {};
  TIPOS_TALLA.forEach(k => {
    const t = TIPOS.indexOf(k), w = W[t], dg = diag[t];
    porTalla[k] = {
      rep: repartirCon(rep[t], w.m, w.est, w.aul, w.niv), fal: repartirCon(fal[t], w.fal, w.req, w.est, w.aul, w.niv),
      b: repartirCon(dg.b, w.b, w.est, w.aul, w.niv), r: repartirCon(dg.r, w.r, w.est, w.aul, w.niv), m: repartirCon(dg.m, w.m, w.est, w.aul, w.niv),
      req: repartirCon(dg.req, w.req, w.est, w.aul, w.niv)
    };
  });
  for (const x of LINEAS) {
    const pt = x.talla ? porTalla[x.tipo] : null;
    for (const c of ['rep', 'fal']) lin[c].push(pt ? pt[c][x.j] : (c === 'rep' ? rep : fal)[x.t]);
    for (const c of ['b', 'r', 'm', 'req']) lin[c].push(pt ? pt[c][x.j] : diag[x.t][c]);
  }
  const cdLinea = lin.rep.map((q, j) => q * (pu[j] ?? 0));
  const cdTipo = TIPOS.map((_, t) => LINEAS.reduce((a, x, j) => a + (x.t === t ? cdLinea[j] : 0), 0));
  const z = factorZona(d[1], l[4], idx);
  return {
    i, grupo: g.clave, cod: l[0], nom: D.locName[i], dist: d[0], prov: D.provs[d[2]], ubigeo: d[1], rural: !!l[4],
    est: D.locEst[i], aul: D.locAul[i].length, zona: z, rep, repVerif, fal, diag, cdTipo, verificado,
    lin, cdLinea,
    cd: cdTipo.reduce((a, b) => a + b, 0), falValor: lin.fal.reduce((a, q, j) => a + q * (pu[j] ?? 0), 0), r: {}, rf: {}
  };
}

// Totales, partidas, rubros, distritos, UIT y avisos de un conjunto de locales ya costeados
function resumir(locales, R, { pu, puGeneral, propio, incl }, uit, esGrupo) {
  const n = locales.length;
  const sum = f => locales.reduce((a, loc) => a + f(loc), 0);
  const T = {
    locales: n, est: sum(l => l.est), aul: sum(l => l.aul),
    cd: sum(l => l.cd), subtotal: sum(l => l.subtotal), neto: sum(l => l.neto), bienes: sum(l => l.bienes), total: sum(l => l.total),
    rep: sum(l => l.rep.reduce((a, b) => a + b, 0)), repVerif: sum(l => l.repVerif.reduce((a, b) => a + b, 0)), fal: sum(l => l.fal.reduce((a, b) => a + b, 0)), falValor: sum(l => l.falValor)
  };
  T.porEstudiante = T.est ? T.total / T.est : null;

  // Líneas de costo (una por talla en mesa y silla): solo de los muebles que entran,
  // y de las tallas, solo las que tienen algo
  const lineas = LINEAS.map((x, j) => {
    const [rep, fal, b, r, m, req] = ['rep', 'fal', 'b', 'r', 'm', 'req'].map(c => sum(l => l.lin[c][j]));
    return { k: x.k, ix: j, tipo: x.tipo, t: x.t, talla: x.talla, n: x.n, u: x.u, b, r, m, ex: b + r + m, req, rep, fal,
      pu: pu[j], pu_propio: propio[j], parcial: sum(l => l.cdLinea[j]), falValor: fal * (pu[j] ?? 0) };
  }).filter(x => incl[x.t] && (!x.talla || x.rep || x.fal || x.ex || x.req));
  // Partidas por tipo de bien (suma de sus tallas). pu: null si a alguna talla que se repone
  // le falta precio; si las tallas tienen precios distintos, el promedio (pu_varia)
  const partidas = ITEMS.map((x, t) => {
    const rep = sum(l => l.rep[t]), fal = sum(l => l.fal[t]), repVerif = sum(l => l.repVerif[t]);
    const [b, r, m, req] = ['b', 'r', 'm', 'req'].map(k => sum(l => l.diag[t][k]));
    const ls = lineas.filter(y => y.t === t), conRep = ls.filter(y => y.rep > 0);
    const parcial = ls.reduce((a, y) => a + y.parcial, 0), falValor = ls.reduce((a, y) => a + y.falValor, 0);
    const precios = [...new Set(conRep.map(y => y.pu))];
    const p = !conRep.length ? (ls.length === 1 && !ls[0].talla ? ls[0].pu : puGeneral[t])
      : precios.includes(null) ? null : precios.length === 1 ? precios[0] : parcial / rep;
    return { k: x.k, n: x.n, u: x.u, b, r, m, ex: b + r + m, req, rep, repVerif, fal, pu: p, pu_varia: precios.length > 1 && !precios.includes(null), pu_general: puGeneral[t],
      parcial, falValor, excluido: !incl[t], tallas: ls.filter(y => y.talla) };
  });
  const rubrosOut = R.map(x => ({
    ...x, nombre: RUBRO[x.clave].nombre, grupo: RUBRO[x.clave].grupo, monto: sum(l => l.r[x.clave]),
    ...(esGrupo && x.modo === 'monto' ? { valor: sum(l => l.rf[x.clave]), valor_proyecto: x.valor } : {})
  }));

  // ── Por distrito ──────────────────────────────────────────────────────────
  const porDist = new Map();
  for (const l of locales) {
    const o = porDist.get(l.ubigeo) || { ubigeo: l.ubigeo, nom: l.dist, prov: l.prov, n: 0, est: 0, rep: 0, fal: 0, falValor: 0, cd: 0, total: 0 };
    o.n++; o.est += l.est; o.rep += l.rep.reduce((a, b) => a + b, 0); o.fal += l.fal.reduce((a, b) => a + b, 0); o.falValor += l.falValor; o.cd += l.cd; o.total += l.total;
    porDist.set(l.ubigeo, o);
  }
  const distritos = [...porDist.values()].map(o => ({ ...o, porEstudiante: o.est ? o.total / o.est : null }))
    .sort((a, b) => b.total - a.total || a.nom.localeCompare(b.nom, 'es'));

  // ── UIT y avisos ──────────────────────────────────────────────────────────
  const valorUit = Number(uit?.valor) > 0 ? Number(uit.valor) : null;
  const U = { anio: uit?.anio ?? null, valor: valorUit, limite: valorUit ? LIMITE_UIT * valorUit : null };
  U.supera = U.limite != null ? T.total > U.limite : null;
  U.enUit = valorUit ? T.total / valorUit : null;

  const avisos = [];
  // Sin precio: el tipo entero si a todas sus líneas les falta; si no, las tallas que faltan
  const sinPrecio = partidas.filter(p => !p.excluido).flatMap(p => {
    const ls = lineas.filter(y => y.tipo === p.k && (y.rep > 0 || y.fal > 0)), faltan = ls.filter(y => y.pu == null);
    return !faltan.length ? [] : faltan.length === ls.length || !p.tallas.length ? [p.n] : faltan.map(y => y.n);
  });
  if (sinPrecio.length) avisos.push({ tipo: 'precio', texto: `Falta el precio unitario de: ${sinPrecio.join(', ')}. Se calcula con 0 hasta que lo cargues.` });
  if (T.fal > 0) avisos.push({ tipo: 'faltante', texto: 'El faltante (brecha de dotación, no reposición) es lo que falta para llegar a lo requerido. No entra a lo que se repone, al costo de inversión ni al Formato 07-C: amplía la capacidad de la UP y una IOARR de reposición no se puede sustentar en eso (Lineamientos IOARR del MEF, 2.4.C). Se muestra valorizado aparte, como referencia; corresponde evaluarlo como ampliación marginal.' });
  if (!valorUit) avisos.push({ tipo: 'uit', texto: `Carga el valor de la UIT${U.anio ? ' de ' + U.anio : ''} para saber si el registro del Formato 07-C es abreviado o completo.` });
  else if (U.supera) avisos.push({ tipo: 'uit75', texto: `El total supera las ${LIMITE_UIT} UIT (UIT ${U.anio}): corresponde el registro completo del Formato 07-C (secciones D, E y F).` });
  const verif = locales.filter(l => l.verificado?.tipos.length);
  if (verif.length) avisos.push({ tipo: 'inventario', texto: `${verif.length === 1 ? '1 local usa' : verif.length + ' locales usan'} inventario verificado en campo en lugar del Censo Educativo (${verif.map(l => l.cod).join(', ')}). Adjunta al expediente el sustento de la visita (acta, fotos, firma del director).` });
  if (R.every(r => r.valor === 0)) avisos.push({ tipo: 'rubros', texto: 'Todos los rubros están en 0. Ingresa los porcentajes o montos de transporte, gastos generales, utilidad, IGV y demás.' });

  return { partidas, lineas, rubros: rubrosOut, totales: T, locales, distritos, uit: U, avisos };
}
