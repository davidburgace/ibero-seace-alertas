// ============================================================================
// src/selector-ioarr/costos.js — Estructura de costos del expediente IOARR
//
// Función pura: la usan la API (pantalla), el Excel y los documentos, así dan lo mismo.
//
// Metrado por local y tipo de bien (sale de calc() de calculo.js, según el escenario):
//   Solo Malo (base) · Malo + Regular · Por capacidad (solo para comparar)
//   Faltante = MAX(0, Requerido − Existente), por aula: brecha de dotación, no reposición.
// Solo la reposición entra al costo. El faltante se valoriza aparte, como referencia.
//
// Tallas (TALLAS en calculo.js): mesa y silla se costean por talla según el grado del aula.
//
// Kit (mesa + silla del estudiante), opcional:
//   Kits por aula = MAX(mesas, sillas) del escenario; el local suma sus aulas (no se toma
//   el mayor de los totales). Con inventario verificado (por local), MAX del local.
//   En Primaria los kits se reparten entre 1.°-2.°, 3.°-4.° y 5.°-6.° con una distribución
//   editable (por defecto, partes iguales); los demás niveles, según el grado del aula.
//
// Estructura referencial de adquisición de bienes (sin utilidad ni gastos generales):
//   Bienes          = Σ cantidad × precio unitario de mercado (sin IGV), por línea
//   Transporte      = piezas × transporte por pieza (kit = 2 piezas)
//   Costo directo   = bienes + transporte
//   IGV             = costo directo × 18 %
//   Doc. equivalente= costo directo × 3 %      (parámetro)
//   Supervisión     = costo directo × 5 %      (parámetro)
//   Liquidación     = monto fijo (15,000 por defecto)
//   Monto de inversión = (costo directo + IGV) + documento equivalente + supervisión + liquidación
// Los porcentajes dependen de la entidad convocante. La liquidación se reparte entre los
// locales (y entre las IOARR por nivel) según su costo directo.
// ============================================================================

import { ITEMS, TALLAS, TIPOS_TALLA, LINEAS, CLAVES_PRECIO, tallasDeAula, ESCENARIOS } from './calculo.js';
export { TALLAS, LINEAS, CLAVES_PRECIO };

export const TIPOS = ITEMS.map(x => x.k);                       // ['mesa', 'silla', 'esc', 'sdoc', 'arm']
export const FUENTES_PRECIO = { cotizacion: 'Cotización', seace: 'SEACE', historico: 'Histórico propio' };
// Archivos de sustento del inventario verificado (src/selector-ioarr/archivos.js)
export const TIPOS_ARCHIVO = {
  acta: 'Acta de verificación', foto: 'Foto', inventario_patrimonial: 'Inventario patrimonial',
  baja: 'Resolución o trámite de baja', otro: 'Otro'
};
export const LIMITE_UIT = 75;   // registro completo del Formato 07-C si la inversión supera 75 UIT

// ─── Estructura de costos del 07-C ──────────────────────────────────────────
// Precios de referencia (sin IGV) que se precargan si no hay otro: mesa y silla de Primaria
// por grupo de grado, y el transporte por pieza. Son de una convocatoria de Loreto (2026).
export const PRECIOS_REFERENCIA = { mesa_p12: 385, mesa_p34: 393, mesa_p56: 398, silla_p12: 188, silla_p34: 193, silla_p56: 198 };
export const TRANSPORTE_REFERENCIA = 19.5;
export const LEYENDA_REFERENCIA = 'Referencia Loreto 2026; edítalo con tus precios';
export const NOTA_PORCENTAJES = 'Los porcentajes (IGV, documento equivalente, supervisión) y la liquidación dependen de la entidad convocante: revísalos con sus bases.';
// Grupos de grado de Primaria para repartir los kits
export const GRUPOS_PRIMARIA = TALLAS.filter(z => z.nivel === 'P').map(z => z.k);   // ['p12', 'p34', 'p56']
export const ESTRUCTURA_DEF = { igv: 18, doc_pct: 3, sup_pct: 5, liquidacion: 15000, transporte_pieza: TRANSPORTE_REFERENCIA, kit: false, kit_dist: [1, 1, 1], precios: {} };
// Líneas del kit: una por talla (precio = mesa + silla de esa talla)
export const LINEAS_KIT = TALLAS.map((z, j) => ({ k: `kit_${z.k}`, tipo: 'kit', t: null, talla: z.k, j, n: `Kit de mobiliario (mesa + silla del estudiante) – ${z.n}`, u: 'kits' }));

const num = (v, mn, mx, def) => { if (v === '' || v == null) return def; const n = Number(v); return Number.isFinite(n) ? Math.min(mx, Math.max(mn, n)) : def; };
// Parámetros válidos de la estructura (lo desconocido se descarta)
export function limpiarEstructura(e) {
  const x = e && typeof e === 'object' ? e : {}, D = ESTRUCTURA_DEF;
  const dist = Array.isArray(x.kit_dist) && x.kit_dist.length === 3 ? x.kit_dist.map(v => num(v, 0, 1000, 0)) : D.kit_dist;
  const precios = {};
  for (const k of CLAVES_PRECIO) {
    const v = x.precios?.[k];
    if (v === '' || v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 1e9) precios[k] = Math.round(n * 100) / 100;
  }
  return {
    igv: num(x.igv, 0, 100, D.igv), doc_pct: num(x.doc_pct, 0, 100, D.doc_pct), sup_pct: num(x.sup_pct, 0, 100, D.sup_pct),
    liquidacion: Math.round(num(x.liquidacion, 0, 1e10, D.liquidacion) * 100) / 100,
    transporte_pieza: Math.round(num(x.transporte_pieza, 0, 1e6, D.transporte_pieza) * 100) / 100,
    kit: x.kit === true, kit_dist: dist.some(v => v > 0) ? dist : D.kit_dist, precios
  };
}

/**
 * Precio unitario de cada clave (tipo y talla), con su origen:
 *   editado (en la tabla del proyecto) → catálogo (fijado en el proyecto o vigente) →
 *   referencia (PRECIOS_REFERENCIA) → sin precio. Una talla sin precio usa el de su tipo (costear).
 * @param detalle { [clave]: { precio, origen } } del catálogo (expediente.js)
 */
export function preciosEfectivos(estructura, detalle = {}) {
  const E = limpiarEstructura(estructura), out = {};
  for (const k of CLAVES_PRECIO) {
    const cat = detalle[k]?.precio != null ? Number(detalle[k].precio) : null;
    if (E.precios[k] != null) out[k] = { precio: E.precios[k], origen: 'editado' };
    else if (cat != null) out[k] = { precio: cat, origen: 'catalogo', catalogo: detalle[k].origen };
    else if (PRECIOS_REFERENCIA[k] != null) out[k] = { precio: PRECIOS_REFERENCIA[k], origen: 'referencia' };
    else out[k] = { precio: null, origen: null };
  }
  return out;
}

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
// { b, r, m, rep, req, fal, est, aul } → arreglos del largo de TALLAS. Un aula multigrado
// suma en partes iguales a las tallas de su nivel. 'niv' marca las tallas de los
// niveles del local (último recurso para repartir). W.kit: kits por talla, con
// MAX(mesas, sillas) a reponer en cada aula; W.kits: el total de kits del local.
export function pesosTalla(D, C, i) {
  const nT = TALLAS.length, vacio = () => new Array(nT).fill(0);
  const W = [0, 1].map(() => ({ b: vacio(), r: vacio(), m: vacio(), rep: vacio(), req: vacio(), fal: vacio(), est: vacio(), aul: vacio(), niv: vacio() }));
  W.kit = vacio(); W.kits = 0;
  for (const si of D.locSvc[i]) for (const w of W) TALLAS.forEach((z, j) => { if (z.nivel === D.svcs[si][2]) w.niv[j] = 1; });
  for (const ai of D.locAul[i]) {
    const a = D.aulas[ai], js = tallasDeAula(D.svcs[a[1]][2], a[5]), parte = 1 / js.length;
    const kit = Math.max(C.A.rep[0][ai], C.A.rep[1][ai]);
    W.kits += kit;
    for (const j of js) W.kit[j] += kit * parte;
    for (const t of [0, 1]) {
      const w = W[t];
      for (const j of js) {
        w.b[j] += C.A.b[t][ai] * parte; w.r[j] += C.A.r[t][ai] * parte; w.m[j] += C.A.m[t][ai] * parte; w.rep[j] += C.A.rep[t][ai] * parte;
        w.req[j] += C.A.req[t][ai] * parte; w.fal[j] += C.A.fal[t][ai] * parte;
        w.est[j] += a[8] * parte; w.aul[j] += parte;
      }
    }
  }
  return W;
}
// Reparte total con el primer peso que no sea todo 0
export const repartirCon = (total, ...pesos) => {
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
 *   D, C, list   datos de la región (prep), cálculo (calc, con el escenario) e índices de los locales
 *   precios      { [clave]: number | null } precio unitario sin IGV por tipo y talla (preciosEfectivos)
 *   estructura   limpiarEstructura(): kit, distribución de kits, transporte por pieza, %, liquidación
 *   uit          { anio, valor } | null
 *   inventario   { [codLocal]: { bienes: { mesa: { b, r, m } }, fecha_visita, observacion } } verificado en campo
 *   grupos       opcional: [{ clave, D, C, list, inventario }] varias IOARR que se costean juntas
 *                (una por nivel, ver niveles.js). Reemplaza a D, C, list e inventario.
 *
 * Con inventario verificado, en ese local y tipo se reemplaza el censo:
 *   Faltante = MAX(0, Requerido − (B + R + M)); A reponer = M (Solo Malo) o M + R (Malo + Regular).
 *   Por capacidad no usa el estado del mobiliario: lo verificado solo cambia el diagnóstico.
 * repVerif es la parte de lo que se repone verificada en campo, para el porcentaje del 07-C.
 *
 * Con grupos, los % se aplican igual en cada IOARR y la liquidación se reparte entre
 * todos los locales de todas, según su costo directo: la suma de las IOARR es el total.
 */
export function costear({ D, C, list, precios, estructura, uit, inventario, grupos }) {
  const E = limpiarEstructura(estructura);
  const val = k => precios?.[k] != null && Number(precios[k]) >= 0 ? Number(precios[k]) : null;
  // Precio por línea: el de la talla o, si no tiene, el de su tipo
  const pu = LINEAS.map(x => (x.talla ? val(x.k) : null) ?? val(x.tipo));
  const puGeneral = TIPOS.map(val);
  const propio = LINEAS.map(x => !!x.talla && val(x.k) != null);   // la talla tiene precio propio
  // Kit por talla = mesa + silla de esa talla (null si falta alguno)
  const puKit = TALLAS.map(z => {
    const m = pu[LINEAS.findIndex(x => x.k === `mesa_${z.k}`)], s = pu[LINEAS.findIndex(x => x.k === `silla_${z.k}`)];
    return m == null || s == null ? null : m + s;
  });
  const fuentes = grupos || [{ clave: null, D, C, list, inventario }];
  const incl = fuentes[0]?.C?.incl || TIPOS.map(() => true);
  const escenario = fuentes[0]?.C?.escenario || 'malo';
  // El kit necesita mesa y silla en la IOARR
  const kit = E.kit && incl[0] && incl[1];

  // ── Por local: metrado, kits y costo directo ──────────────────────────────
  const locales = [];
  for (const g of fuentes) {
    const ls = g.list.map(i => localDe(g, i));
    if (kit) repartirPrimaria(ls, E.kit_dist);
    for (const l of ls) costoLocal(l, { kit, pu, puKit, E });
    locales.push(...ls);
  }
  // IGV, documento equivalente, supervisión y liquidación por local (la liquidación, según el CD)
  const cdTodos = locales.reduce((a, l) => a + l.cd, 0), n = locales.length;
  for (const l of locales) {
    l.igv = l.cd * E.igv / 100; l.doc = l.cd * E.doc_pct / 100; l.sup = l.cd * E.sup_pct / 100;
    l.liq = cdTodos ? E.liquidacion * l.cd / cdTodos : E.liquidacion / (n || 1);
    l.total = l.cd + l.igv + l.doc + l.sup + l.liq;
  }

  const P = { pu, puGeneral, propio, incl, puKit, kit, E, escenario };
  const res = resumir(locales, P, uit);
  if (grupos) res.grupos = Object.fromEntries(grupos.map(g => [g.clave, resumir(locales.filter(l => l.grupo === g.clave), P, uit)]));
  return res;
}

function localDe(g, i) {
  const { D, C, inventario } = g, nL = C.nL, incl = C.incl || TIPOS.map(() => true), esc = C.escenario || 'malo';
  const l = D.locs[i], d = D.dists[l[1]];
  const rep = TIPOS.map((_, t) => C.L.rep[t * nL + i]);
  const fal = TIPOS.map((_, t) => C.L.fal[t * nL + i]);
  // Diagnóstico (bueno, regular, malo) y requerido: se muestran siempre
  const diag = TIPOS.map((_, t) => ({ b: C.L.b[t * nL + i], r: C.L.r[t * nL + i], m: C.L.m[t * nL + i], req: C.L.req[t * nL + i] }));
  const inv = inventario?.[l[0]];
  // Parte de lo que se repone que está verificada en campo (el resto sale del censo)
  const repVerif = TIPOS.map(() => 0);
  let verificado = null, kitLocal = false;
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
      diag[t] = { ...diag[t], b: x.b, r: x.r, m: x.m };
      tipos.push(k);
      if (esc === 'capacidad') return;   // por capacidad no usa el estado del mobiliario
      rep[t] = esc === 'malo_regular' ? x.m + x.r : x.m;
      if (t < 2) kitLocal = true;
      // Con ficha, solo las aulas contadas (Malo verificado frente al Malo del censo); corregido a mano, todo el tipo
      const v = inv.verif?.[k];
      repVerif[t] = !v ? rep[t] : esc === 'malo_regular' ? Math.round(rep[t] * (v.mv + v.mc ? v.mv / (v.mv + v.mc) : 1)) : v.mv;
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
      rep: repartirCon(rep[t], w.rep, w.m, w.est, w.aul, w.niv), fal: repartirCon(fal[t], w.fal, w.req, w.est, w.aul, w.niv),
      b: repartirCon(dg.b, w.b, w.est, w.aul, w.niv), r: repartirCon(dg.r, w.r, w.est, w.aul, w.niv), m: repartirCon(dg.m, w.m, w.est, w.aul, w.niv),
      req: repartirCon(dg.req, w.req, w.est, w.aul, w.niv)
    };
  });
  for (const x of LINEAS) {
    const pt = x.talla ? porTalla[x.tipo] : null;
    for (const c of ['rep', 'fal']) lin[c].push(pt ? pt[c][x.j] : (c === 'rep' ? rep : fal)[x.t]);
    for (const c of ['b', 'r', 'm', 'req']) lin[c].push(pt ? pt[c][x.j] : diag[x.t][c]);
  }
  // Kits: MAX(mesas, sillas) por aula, sumado en el local. Con inventario verificado de mesa
  // o silla (que es por local), MAX del local, repartido entre tallas como los kits del censo.
  const kits = !incl[0] || !incl[1] ? 0 : kitLocal ? Math.max(rep[0], rep[1]) : W.kits;
  const w0 = W[0];
  const kitTalla = repartirCon(kits, W.kit, w0.est, w0.aul, w0.niv);
  return {
    i, grupo: g.clave, cod: l[0], nom: D.locName[i], dist: d[0], prov: D.provs[d[2]], ubigeo: d[1], rural: !!l[4],
    est: D.locEst[i], aul: D.locAul[i].length, rep, repVerif, fal, diag, verificado, lin, kits, kitTalla, kitPorLocal: kitLocal
  };
}

// Kits de Primaria: el total del grupo (IOARR) se reparte entre 1.°-2.°, 3.°-4.° y 5.°-6.°
// según la distribución (por defecto, partes iguales). Después se asigna a cada local en
// enteros: las filas suman los kits de Primaria del local y las columnas, lo del grupo.
function repartirPrimaria(locales, dist) {
  const js = GRUPOS_PRIMARIA.map(k => TALLAS.findIndex(z => z.k === k));
  const deLocal = locales.map(l => js.reduce((a, j) => a + l.kitTalla[j], 0));
  const K = deLocal.reduce((a, b) => a + b, 0);
  if (!K) return;
  const rem = repartir(K, dist);
  locales.forEach((l, q) => {
    const x = deLocal[q] ? repartir(deLocal[q], rem) : js.map(() => 0);
    js.forEach((j, c) => { l.kitTalla[j] = x[c]; rem[c] -= x[c]; });
  });
}

// Costo directo del local: líneas (kit por talla o mesa y silla por talla, y los demás),
// piezas y transporte
function costoLocal(l, { kit, pu, puKit, E }) {
  const cdLinea = l.lin.rep.map((q, j) => q * (pu[j] ?? 0));
  const piezasLinea = LINEAS.map((x, j) => kit && x.talla ? 0 : l.lin.rep[j]);
  const cdKit = l.kitTalla.map((q, j) => kit ? q * (puKit[j] ?? 0) : 0);
  l.cdLinea = cdLinea; l.cdKit = cdKit;
  l.piezas = (kit ? 2 * l.kits : 0) + piezasLinea.reduce((a, b) => a + b, 0);
  // Bienes por tipo (sin transporte); con kit, mesa y silla van en el kit
  l.cdTipo = TIPOS.map((_, t) => kit && t < 2 ? 0 : LINEAS.reduce((a, x, j) => a + (x.t === t ? cdLinea[j] : 0), 0));
  l.bienesKit = cdKit.reduce((a, b) => a + b, 0);
  l.bienes = l.cdTipo.reduce((a, b) => a + b, 0) + l.bienesKit;
  l.transporte = l.piezas * E.transporte_pieza;
  l.cd = l.bienes + l.transporte;
  l.falValor = l.lin.fal.reduce((a, q, j) => a + q * (pu[j] ?? 0), 0);
}

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Totales, partidas, metas, distritos, UIT y avisos de un conjunto de locales ya costeados
function resumir(locales, { pu, puGeneral, propio, incl, puKit, kit, E, escenario }, uit) {
  const n = locales.length;
  const sum = f => locales.reduce((a, loc) => a + f(loc), 0);
  const T = {
    locales: n, est: sum(l => l.est), aul: sum(l => l.aul),
    bienes: sum(l => l.bienes), piezas: sum(l => l.piezas), cd: sum(l => l.cd),
    rep: sum(l => l.rep.reduce((a, b) => a + b, 0)), repVerif: sum(l => l.repVerif.reduce((a, b) => a + b, 0)), fal: sum(l => l.fal.reduce((a, b) => a + b, 0)), falValor: sum(l => l.falValor),
    kits: sum(l => l.kits)
  };
  T.transporte = r2(T.piezas * E.transporte_pieza);
  T.bienes = r2(T.bienes); T.cd = r2(T.bienes + T.transporte);
  T.igv = r2(T.cd * E.igv / 100); T.doc = r2(T.cd * E.doc_pct / 100); T.sup = r2(T.cd * E.sup_pct / 100); T.liq = r2(sum(l => l.liq));
  T.cdIgv = r2(T.cd + T.igv);
  T.total = r2(T.cdIgv + T.doc + T.sup + T.liq);
  T.porEstudiante = T.est ? T.total / T.est : null;

  // Líneas de mesa y silla por talla y de los demás (diagnóstico y, sin kit, costo)
  const lineasTalla = LINEAS.map((x, j) => {
    const [rep, fal, b, r, m, req] = ['rep', 'fal', 'b', 'r', 'm', 'req'].map(c => sum(l => l.lin[c][j]));
    return { k: x.k, ix: j, tipo: x.tipo, t: x.t, talla: x.talla, n: x.n, u: x.u, b, r, m, ex: b + r + m, req, rep, fal,
      pu: pu[j], pu_propio: propio[j], parcial: sum(l => l.cdLinea[j]), falValor: fal * (pu[j] ?? 0) };
  }).filter(x => incl[x.t] && (!x.talla || x.rep || x.fal || x.ex || x.req));
  // Kits por talla (solo las que tienen kits)
  const lineasKit = LINEAS_KIT.map((x, j) => ({ ...x, ix: j, rep: sum(l => l.kitTalla[j]), pu: puKit[j], parcial: sum(l => l.cdKit[j]) })).filter(x => x.rep > 0);
  // Líneas de costo: con kit, los kits y luego escritorio, silla docente y armario
  const lineas = kit ? [...lineasKit, ...lineasTalla.filter(x => x.t >= 2)] : lineasTalla;
  // Partidas por tipo de bien (suma de sus tallas). pu: null si a alguna talla que se repone
  // le falta precio; si las tallas tienen precios distintos, el promedio (pu_varia)
  const partidas = ITEMS.map((x, t) => {
    const rep = sum(l => l.rep[t]), fal = sum(l => l.fal[t]), repVerif = sum(l => l.repVerif[t]);
    const [b, r, m, req] = ['b', 'r', 'm', 'req'].map(k => sum(l => l.diag[t][k]));
    const ls = lineasTalla.filter(y => y.t === t), conRep = ls.filter(y => y.rep > 0);
    const parcial = ls.reduce((a, y) => a + y.parcial, 0), falValor = ls.reduce((a, y) => a + y.falValor, 0);
    const precios = [...new Set(conRep.map(y => y.pu))];
    const p = !conRep.length ? (ls.length === 1 && !ls[0].talla ? ls[0].pu : puGeneral[t])
      : precios.includes(null) ? null : precios.length === 1 ? precios[0] : parcial / rep;
    return { k: x.k, n: x.n, u: x.u, b, r, m, ex: b + r + m, req, rep, repVerif, fal, pu: p, pu_varia: precios.length > 1 && !precios.includes(null), pu_general: puGeneral[t],
      parcial, falValor, excluido: !incl[t], tallas: ls.filter(y => y.talla) };
  });

  // Metas del 07-C: el kit (o mesa y silla) y los demás, con su costo directo (bienes + transporte)
  const tp = E.transporte_pieza;
  const metas = [];
  if (kit && T.kits > 0) {
    const bienes = lineasKit.reduce((a, y) => a + y.parcial, 0);
    metas.push({ k: 'kit', n: 'Kit de mobiliario (mesa + silla del estudiante)', u: 'Kit de mobiliario', cantidad: T.kits, piezas: 2 * T.kits, bienes, transporte: 2 * T.kits * tp,
      porTalla: lineasKit.map(y => ({ talla: y.talla, n: TALLAS.find(z => z.k === y.talla).n, cantidad: y.rep })) });
  }
  partidas.forEach((p, t) => {
    if (p.excluido || !p.rep || (kit && t < 2)) return;
    metas.push({ k: p.k, n: p.n, u: p.u, cantidad: p.rep, piezas: p.rep, bienes: p.parcial, transporte: p.rep * tp,
      porTalla: p.tallas.filter(y => y.rep > 0).map(y => ({ talla: y.talla, n: TALLAS.find(z => z.k === y.talla).n, cantidad: y.rep })) });
  });
  for (const m of metas) m.cd = m.bienes + m.transporte;

  const estructura = {
    kit, escenario, params: { igv: E.igv, doc_pct: E.doc_pct, sup_pct: E.sup_pct, liquidacion: E.liquidacion, transporte_pieza: E.transporte_pieza, kit_dist: E.kit_dist },
    filas: [
      { clave: 'bienes', nombre: 'Bienes (cantidad × precio unitario sin IGV)', monto: T.bienes },
      { clave: 'transporte', nombre: `Transporte (${T.piezas.toLocaleString('es-PE')} piezas × S/ ${tp.toFixed(2)})`, monto: T.transporte },
      { clave: 'cd', nombre: 'Costo directo', monto: T.cd, fuerte: true },
      { clave: 'igv', nombre: `IGV (${E.igv} %)`, monto: T.igv },
      { clave: 'cdIgv', nombre: 'Costo directo + IGV', monto: T.cdIgv, fuerte: true },
      { clave: 'doc', nombre: `Documento equivalente (${E.doc_pct} % del costo directo sin IGV)`, monto: T.doc },
      { clave: 'sup', nombre: `Supervisión (${E.sup_pct} % del costo directo sin IGV)`, monto: T.sup },
      { clave: 'liq', nombre: 'Liquidación (monto fijo)', monto: T.liq },
      { clave: 'total', nombre: 'MONTO DE INVERSIÓN', monto: T.total, total: true }]
  };

  // ── Por distrito ──────────────────────────────────────────────────────────
  const porDist = new Map();
  for (const l of locales) {
    const o = porDist.get(l.ubigeo) || { ubigeo: l.ubigeo, nom: l.dist, prov: l.prov, n: 0, est: 0, rep: 0, kits: 0, fal: 0, falValor: 0, cd: 0, total: 0 };
    o.n++; o.est += l.est; o.rep += l.rep.reduce((a, b) => a + b, 0); o.kits += l.kits; o.fal += l.fal.reduce((a, b) => a + b, 0); o.falValor += l.falValor; o.cd += l.cd; o.total += l.total;
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
  if (escenario === 'capacidad') avisos.push({ tipo: 'escenario', alerta: true, texto: 'Escenario «Por capacidad (método de convocatoria)»: solo para comparar con una convocatoria ya publicada; no es sustento de reposición. Las cantidades no usan el estado del mobiliario.' });
  else if (escenario === 'malo_regular') avisos.push({ tipo: 'escenario', texto: 'Escenario «Malo + Regular»: cota superior. El mobiliario regular todavía se puede usar: sustenta con la verificación en campo por qué se repone.' });
  // Sin precio: las líneas con algo que reponer
  const sinPrecio = lineas.filter(y => y.rep > 0 && y.pu == null).map(y => y.n);
  if (sinPrecio.length) avisos.push({ tipo: 'precio', texto: `Falta el precio unitario de: ${sinPrecio.join(', ')}. Se calcula con 0 hasta que lo cargues.` });
  if (E.kit && !kit) avisos.push({ tipo: 'kit', texto: 'Para presentar como kit, la mesa y la silla del estudiante deben entrar a la IOARR (criterios del Selector).' });
  if (T.fal > 0) avisos.push({ tipo: 'faltante', texto: 'El faltante (brecha de dotación, no reposición) es lo que falta para llegar a lo requerido. No entra a lo que se repone, al costo de inversión ni al Formato 07-C: amplía la capacidad de la UP y una IOARR de reposición no se puede sustentar en eso (Lineamientos IOARR del MEF, 2.4.C). Se muestra valorizado aparte, como referencia.' });
  if (!valorUit) avisos.push({ tipo: 'uit', texto: `Carga el valor de la UIT${U.anio ? ' de ' + U.anio : ''} para saber si el registro del Formato 07-C es abreviado o completo.` });
  else if (U.supera) avisos.push({ tipo: 'uit75', texto: `El monto de inversión supera las ${LIMITE_UIT} UIT (UIT ${U.anio}): corresponde el registro completo del Formato 07-C (secciones D, E y F).` });
  const verif = locales.filter(l => l.verificado?.tipos.length);
  if (verif.length) avisos.push({ tipo: 'inventario', texto: `${verif.length === 1 ? '1 local usa' : verif.length + ' locales usan'} inventario verificado en campo en lugar del Censo Educativo (${verif.map(l => l.cod).join(', ')}). Adjunta al expediente el sustento de la visita (acta, fotos, firma del director).` });

  // Precio por línea (con el respaldo del tipo) y del kit por talla, para el Excel
  const preciosLinea = Object.fromEntries([...LINEAS.map((x, j) => [x.k, { pu: pu[j], propio: propio[j] }]), ...LINEAS_KIT.map((x, j) => [x.k, { pu: puKit[j] }])]);
  return { partidas, lineas, lineasTalla, lineasKit, metas, estructura, totales: T, locales, distritos, uit: U, avisos, escenario, kit, preciosLinea };
}

// Nombre corto del escenario
export const nombreEscenario = k => (ESCENARIOS.find(x => x.k === k) || ESCENARIOS[0]).n;
