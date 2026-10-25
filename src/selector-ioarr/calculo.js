// ============================================================================
// src/selector-ioarr/calculo.js — Cálculo de reposición de mobiliario (Selector IOARR)
//
// Parte del prototipo (docs/selector-ioarr/prototipo.html: prep, calc, totals), con la regla de
// reposición corregida: solo se repone lo que está en estado Malo.
// Lo usan el navegador (vía /selector-ioarr/calculo.js, dentro de un Web Worker)
// y el servidor (exportación a Excel), así la pantalla y el Excel dan lo mismo.
//
// Reglas:
//   Existente = Bueno + Regular + Malo
//   A reponer = Malo, por aula. Bueno y Regular solo son diagnóstico.
//   Faltante  = MAX(0, Requerido − Existente), por aula: brecha de dotación, NO reposición.
//               Se muestra aparte y no suma a lo que se repone, al costo ni al Formato 07-C
//               (Lineamientos IOARR 2.4.C: la reposición no puede ampliar la capacidad de la UP).
//   Requerido: mesa y silla por estudiante; escritorio, silla docente y armario por aula.
//   Muebles: P.muebles dice qué tipos entran a la IOARR (por ejemplo, solo mesa y silla);
//            los demás quedan en 0 en todo el cálculo. P.mueblesNivel ({ I: [...], P: [...] })
//            cambia la composición en un nivel: cada aula usa la de su nivel (mueblesDe).
//   Tallas: mesa y silla se costean por talla según el grado del aula (TALLAS, en costos.js).
//   Mesa múltiple = kI puestos (Inicial y Especial) o kPS (Primaria y Secundaria);
//   carpeta bipersonal = carpBip puestos; las carpetas no traen estado (carpEstado).
//
// Esquema de los datos (ver scripts/selector-ioarr/build_national.py):
//   locs[i]  = [codLocal, iDist, iUgel, centroPoblado, rural(0|1), dirección, lat, lon]
//   svcs[i]  = [codModular, nombre, nivel(I|P|S|E), iLocal, convenio(0|1), secciones, alumnos, turno]
//   aulas[i] = [iLocal, iSvc, edificación, piso, número, grado, sección, turno, estudiantes,
//               compartida(0|1), variosServiciosDelNivel(0|1), f0..f19]   (f = índice 11 + j)
//   f: 0-2 mesa unip. B/R/M · 3-5 mesa múltiple B/R/M · 6 carpeta unip. · 7 carpeta bip.
//      8-10 silla B/R/M · 11-13 escritorio · 14-16 silla docente · 17-19 armario/estante
// ============================================================================

export const ITEMS = [
  { k: 'mesa', n: 'Mesa del estudiante', u: 'puestos' }, { k: 'silla', n: 'Silla del estudiante', u: 'unidades' },
  { k: 'esc', n: 'Escritorio docente', u: 'unidades' }, { k: 'sdoc', n: 'Silla docente', u: 'unidades' },
  { k: 'arm', n: 'Armario / estante', u: 'unidades' }];
// Tallas de mesa y silla del estudiante: cada aula toma la de su nivel y grado.
// Un aula multigrado (o sin grado) reparte su mobiliario en partes iguales entre
// las tallas de su nivel. Escritorio, silla docente y armario no tienen talla.
export const TIPOS_TALLA = ['mesa', 'silla'];
export const TALLAS = [
  { k: 'i', nivel: 'I', n: 'Inicial', grados: [] },
  { k: 'p12', nivel: 'P', n: 'Primaria 1.° y 2.°', grados: [1, 2] },
  { k: 'p34', nivel: 'P', n: 'Primaria 3.° y 4.°', grados: [3, 4] },
  { k: 'p56', nivel: 'P', n: 'Primaria 5.° y 6.°', grados: [5, 6] },
  { k: 's12', nivel: 'S', n: 'Secundaria 1.° y 2.°', grados: [1, 2] },
  { k: 's34', nivel: 'S', n: 'Secundaria 3.° y 4.°', grados: [3, 4] },
  { k: 's5', nivel: 'S', n: 'Secundaria 5.°', grados: [5] },
  { k: 'e', nivel: 'E', n: 'Básica Especial', grados: [] }];
// Índices (en TALLAS) de la talla de un aula, según el nivel y el grado del censo
// («3° Primaria», «Multigrado», «Inicial 4 años»…). Varias si es multigrado.
export function tallasDeAula(nivel, grado) {
  const delNivel = TALLAS.map((x, j) => j).filter(j => TALLAS[j].nivel === nivel);
  const g = /^(\d)\s*°/.exec(String(grado || ''));
  if (g) { const j = delNivel.find(j => TALLAS[j].grados.includes(Number(g[1]))); if (j != null) return [j]; }
  return delNivel;
}
// Líneas de costo: mesa y silla por talla; los demás, una línea por tipo.
// k = clave del precio (tipo_bien): 'mesa_p12', 'silla_s5', 'esc'…
export const LINEAS = ITEMS.flatMap((x, t) => TIPOS_TALLA.includes(x.k)
  ? TALLAS.map((z, j) => ({ k: `${x.k}_${z.k}`, tipo: x.k, t, talla: z.k, j, n: `${x.n} – ${z.n}`, u: x.u }))
  : [{ k: x.k, tipo: x.k, t, talla: null, j: null, n: x.n, u: x.u }]);
export const CLAVES_PRECIO = [...ITEMS.map(x => x.k), ...LINEAS.filter(x => x.talla).map(x => x.k)];

export const NIVN = { I: 'Inicial', P: 'Primaria', S: 'Secundaria', E: 'Básica Especial' };
export const NIVS = { I: 'Inicial', P: 'Primaria', S: 'Secundaria', E: 'Especial' };
export const NIVB = { I: 1, P: 2, S: 4, E: 8 };
export const DEF = { kI: 4, kPS: 2, carpBip: 2, carpEstado: 'r', mesaEst: 1, sillaEst: 1, esc: 1, sdoc: 1, arm: 1, muebles: ITEMS.map(x => x.k),
  escenario: 'malo', capOcup: 30, capPct: 80, pctRegular: 100, pctRegularNivel: {}, pctOrigen: { tipo: 'manual' }, umbralVida: 10, mueblesNivel: {} };
// Niveles que pueden tener su propia composición de muebles
export const NIVELES_MUEBLES = ['I', 'P', 'S', 'E'];
// Muebles que entran a la IOARR en un nivel: los del nivel o, si no tiene, los generales
export const mueblesDe = (P, nivel) => (nivel && P?.mueblesNivel?.[nivel]) || P?.muebles || DEF.muebles;
// Escenarios de cantidad a reponer (se guardan en los criterios del proyecto):
//   malo          lo Malo del censo, por tipo de bien (base)
//   malo_regular  Malo + % de Regular: por aula y tipo de bien,
//                 Regular a reponer = MIN(Regular, redondeo hacia arriba de Regular × % / 100).
//                 % = 0 da lo mismo que «Solo Malo»; % = 100 es la cota superior (Malo + Regular).
//                 El % puede ser distinto por nivel (pctRegularNivel: { I, P, S }); si no, el global.
//                 Con ficha de verificación con antigüedad, en ese local se usa el Regular con
//                 vida útil cumplida (antigüedad ≥ umbralVida años) en lugar del % (costos.js).
//   capacidad     aulas × ocupación × %: método de algunas convocatorias. Solo para
//                 comparar con una convocatoria ya publicada; no es sustento de reposición.
//                 Mesa y silla = round(ocupación × % / 100) por aula; escritorio, silla
//                 docente y armario = lo requerido por aula (no usa el estado del mobiliario).
export const ESCENARIOS = [
  { k: 'malo', n: 'Solo Malo', corto: 'Solo Malo' },
  { k: 'malo_regular', n: 'Malo + % de Regular', corto: 'Malo + % de Regular' },
  { k: 'capacidad', n: 'Por capacidad (método de convocatoria)', corto: 'Por capacidad' }];
export const AVISO_CAPACIDAD = 'Solo para comparar con una convocatoria ya publicada; no es sustento de reposición.';
export const LIM_CAP = { capOcup: [1, 60], capPct: [1, 100] };
// % de Regular que se repone: global y por nivel (Básica Especial usa el global)
export const NIVELES_PCT = ['I', 'P', 'S'];
export const LIM_UMBRAL = [1, 50];
export const ROTULO_UMBRAL = 'referencial: Directiva 005-2016-EF/51.01';
export const pctRegularDe = (P, nivel) => P?.pctRegularNivel?.[nivel] ?? P?.pctRegular ?? DEF.pctRegular;
// Regular a reponer de un aula (o de un conteo): redondeo hacia arriba, nunca más que el Regular existente
export const regularAReponer = (r, pct) => r > 0 && pct > 0 ? Math.min(r, Math.ceil(r * pct / 100 - 1e-9)) : 0;
// «60 %» o «60 % (Inicial 40 %, Primaria 60 %)» si algún nivel tiene otro
export function textoPct(P, niveles = NIVELES_PCT) {
  const g = P?.pctRegular ?? DEF.pctRegular;
  const otros = niveles.filter(n => P?.pctRegularNivel?.[n] != null && P.pctRegularNivel[n] !== g);
  return `${g} %` + (otros.length ? ` (${niveles.filter(n => NIVELES_PCT.includes(n)).map(n => `${NIVN[n]} ${pctRegularDe(P, n)} %`).join(', ')})` : '');
}
// Origen del %: valor manual u observado en N locales verificados (y, aparte, el dato por local)
export function textoOrigenPct(P, regDato) {
  const o = P?.pctOrigen || {};
  const base = o.tipo === 'observado'
    ? `% observado de Regular con vida útil cumplida en ${o.n} ${o.n === 1 ? 'local verificado' : 'locales verificados'} (umbral ${o.umbral ?? P.umbralVida} años, ${ROTULO_UMBRAL})`
    : 'valor manual';
  const dato = regDato?.n ? `; en ${regDato.n} de ${regDato.de} ${regDato.de === 1 ? 'local' : 'locales'} se usa el dato verificado por local (Regular con antigüedad de ${P.umbralVida} años o más, ${ROTULO_UMBRAL})` : '';
  return base + dato;
}
// Una línea que declara el escenario en los documentos. regDato: { n, de } locales con dato verificado (opcional)
export function textoEscenario(P, regDato) {
  const e = P?.escenario || 'malo';
  if (e === 'malo_regular') return `Escenario de cantidad: Malo + % de Regular: Malo y ${textoPct(P)} del Regular del Censo Educativo 2025, por aula y tipo de bien (origen del %: ${textoOrigenPct(P, regDato)}). La cantidad es una estimación hasta completar la verificación en campo.`;
  if (e === 'capacidad') return `Escenario de cantidad: Por capacidad (método de convocatoria): aulas × ${P.capOcup} estudiantes × ${P.capPct} %. ${AVISO_CAPACIDAD}`;
  return 'Escenario de cantidad: Solo Malo (mobiliario en estado malo del Censo Educativo 2025).';
}
// [clave, etiqueta, mín, máx, paso]
export const CRIT = [['kI', 'Puestos por mesa múltiple (Inicial y Especial)', 1, 12, 1], ['kPS', 'Puestos por mesa múltiple (Primaria y Secundaria)', 1, 12, 1],
  ['carpBip', 'Puestos por carpeta bipersonal', 1, 4, 1],
  ['mesaEst', 'Mesas por estudiante', 0, 2, 0.5], ['sillaEst', 'Sillas por estudiante', 0, 2, 0.5],
  ['esc', 'Escritorios docentes por aula', 0, 3, 1], ['sdoc', 'Sillas docentes por aula', 0, 3, 1], ['arm', 'Armarios o estantes por aula', 0, 5, 1]];

// ─── Ubicación (coordenadas declaradas en el padrón) ────────────────────────
// Válidas si caen en el rango de Perú; el padrón puede traer ceros o valores errados.
export const coordValidas = (lat, lon) => typeof lat === 'number' && typeof lon === 'number'
  && lat >= -19 && lat <= 0 && lon >= -82 && lon <= -68;
// Google Maps en vista satelital (t=k), zoom 18
export const urlGoogleMaps = (lat, lon) => `https://www.google.com/maps?q=${lat},${lon}&t=k&z=18`;
// Iframe: con llave usa la Maps Embed API; sin llave, el embed clásico sin llave
export const urlMapaEmbed = (lat, lon, llave) => llave
  ? `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(llave)}&q=${lat},${lon}&zoom=18&maptype=satellite`
  : `https://maps.google.com/maps?q=${lat},${lon}&t=k&z=18&output=embed`;

export const norm = s =>String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Criterios válidos a partir de lo que venga guardado (ignora claves o valores raros)
export function limpiarParams(p) {
  const P = { ...DEF };
  if (p && typeof p === 'object') {
    for (const [k, , mn, mx] of CRIT) {
      const v = Number(p[k]);
      if (!Number.isFinite(v)) continue;
      P[k] = Math.min(mx, Math.max(mn, v));
    }
    if (['b', 'r', 'm'].includes(p.carpEstado)) P.carpEstado = p.carpEstado;
    if (ESCENARIOS.some(x => x.k === p.escenario)) P.escenario = p.escenario;
    for (const [k, [mn, mx]] of Object.entries(LIM_CAP)) {
      const v = Number(p[k]);
      if (p[k] !== '' && p[k] != null && Number.isFinite(v)) P[k] = Math.min(mx, Math.max(mn, v));
    }
    // % de Regular (0 a 100, entero), por nivel y umbral de vida útil
    const pct = v => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null; };
    if (pct(p.pctRegular) != null) P.pctRegular = pct(p.pctRegular);
    P.pctRegularNivel = {};
    for (const n of NIVELES_PCT) if (pct(p.pctRegularNivel?.[n]) != null) P.pctRegularNivel[n] = pct(p.pctRegularNivel[n]);
    const u = Number(p.umbralVida);
    if (p.umbralVida !== '' && p.umbralVida != null && Number.isFinite(u)) P.umbralVida = Math.min(LIM_UMBRAL[1], Math.max(LIM_UMBRAL[0], Math.round(u)));
    const o = p.pctOrigen;
    P.pctOrigen = o?.tipo === 'observado' && Number.isInteger(o.n) && o.n > 0
      ? { tipo: 'observado', n: o.n, umbral: Number.isInteger(o.umbral) ? o.umbral : P.umbralVida, pct: pct(o.pct) ?? P.pctRegular } : { tipo: 'manual' };
    // Muebles que entran a la IOARR (al menos uno, en el orden de ITEMS)
    if (Array.isArray(p.muebles)) {
      const m = ITEMS.map(x => x.k).filter(k => p.muebles.includes(k));
      if (m.length) P.muebles = m;
    }
    // Composición por nivel (solo si difiere de la general)
    P.mueblesNivel = {};
    for (const n of NIVELES_MUEBLES) {
      const x = p.mueblesNivel?.[n];
      if (!Array.isArray(x)) continue;
      const m = ITEMS.map(y => y.k).filter(k => x.includes(k));
      if (m.length && m.join() !== P.muebles.join()) P.mueblesNivel[n] = m;
    }
  }
  P.muebles = [...P.muebles];
  P.mueblesNivel = Object.fromEntries(Object.entries(P.mueblesNivel || {}).map(([n, m]) => [n, [...m]]));
  P.pctRegularNivel = { ...P.pctRegularNivel }; P.pctOrigen = { ...P.pctOrigen };
  return P;
}

// Índices auxiliares por local (servicios, aulas, estudiantes, niveles, gestión, texto de búsqueda)
export function prep(D) {
  const nL = D.locs.length, nS = D.svcs.length;
  D.locSvc = Array.from({ length: nL }, () => []); D.svcs.forEach((s, i) => D.locSvc[s[3]].push(i));
  D.locAul = Array.from({ length: nL }, () => []); D.svcAulN = new Int32Array(nS);
  D.aulas.forEach((a, i) => { D.locAul[a[0]].push(i); D.svcAulN[a[1]]++; });
  D.locEst = new Int32Array(nL); D.locSec = new Int32Array(nL); D.locNiv = new Uint8Array(nL); D.locGes = new Uint8Array(nL);
  D.locText = new Array(nL); D.locName = new Array(nL);
  for (let i = 0; i < nL; i++) {
    const l = D.locs[i]; let t = l[0] + ' ' + l[3] + ' ' + l[5] + ' ' + D.dists[l[1]][0]; const names = [];
    for (const si of D.locSvc[i]) {
      const s = D.svcs[si];
      D.locEst[i] += s[6]; D.locSec[i] += s[5]; D.locNiv[i] |= NIVB[s[2]]; D.locGes[i] |= 1 << s[4];
      t += ' ' + s[0] + ' ' + s[1]; if (!names.includes(s[1])) names.push(s[1]);
    }
    D.locName[i] = names.join(' / '); D.locText[i] = norm(t);
  }
  return D;
}

// Mobiliario por aula (A) y acumulado por local (L), según los criterios P.
// Con nivel (I, P, S o E), solo cuentan las aulas de los servicios de ese nivel.
// Los muebles que no entran a la IOARR (mueblesDe del nivel del aula) quedan en 0. incl[t] dice si
// el tipo t entra: en el nivel pedido o, sin nivel, en alguno de los niveles.
// A reponer según P.escenario (ver ESCENARIOS): Malo, Malo + % de Regular o por capacidad.
// El faltante (Requerido − Existente) es siempre informativo y no entra a lo que se repone.
export function calc(D, P, nivel = null) {
  const nA = D.aulas.length, nL = D.locs.length;
  const inclNiv = Object.fromEntries(NIVELES_MUEBLES.map(n => [n, ITEMS.map(x => mueblesDe(P, n).includes(x.k))]));
  const incl = nivel ? inclNiv[nivel] : ITEMS.map((_, t) => NIVELES_MUEBLES.some(n => inclNiv[n][t]));
  const L = { b: new Float64Array(5 * nL), r: new Float64Array(5 * nL), m: new Float64Array(5 * nL), req: new Float64Array(5 * nL),
    fal: new Float64Array(5 * nL), rep: new Float64Array(5 * nL), repTot: new Float64Array(nL), falTot: new Float64Array(nL), reqTot: new Float64Array(nL) };
  const A = { b: [], r: [], m: [], req: [], fal: [], rep: [] };
  for (const k in A) for (let t = 0; t < 5; t++) A[k].push(new Int32Array(nA));
  const esc = P.escenario || 'malo', cap = Math.round((P.capOcup ?? DEF.capOcup) * (P.capPct ?? DEF.capPct) / 100);
  const pctNiv = { I: pctRegularDe(P, 'I'), P: pctRegularDe(P, 'P'), S: pctRegularDe(P, 'S'), E: pctRegularDe(P, 'E') };
  for (let i = 0; i < nA; i++) {
    if (nivel && D.svcs[D.aulas[i][1]][2] !== nivel) continue;
    const a = D.aulas[i], niv = D.svcs[a[1]][2], k = (niv === 'I' || niv === 'E') ? P.kI : P.kPS, f = j => a[11 + j], loc = a[0];
    const carp = f(6) + f(7) * P.carpBip;
    let mb = f(0) + k * f(3), mr = f(1) + k * f(4), mm = f(2) + k * f(5), sb = f(8), sr = f(9), sm = f(10);
    if (P.carpEstado === 'b') { mb += carp; sb += carp; } else if (P.carpEstado === 'm') { mm += carp; sm += carp; } else { mr += carp; sr += carp; }
    const trip = [[mb, mr, mm], [sb, sr, sm], [f(11), f(12), f(13)], [f(14), f(15), f(16)], [f(17), f(18), f(19)]];
    const req = [Math.round(a[8] * P.mesaEst), Math.round(a[8] * P.sillaEst), P.esc, P.sdoc, P.arm];
    for (let t = 0; t < 5; t++) {
      if (!inclNiv[niv][t]) continue;
      const [b, r, m] = trip[t], ex = b + r + m, fal = Math.max(0, req[t] - ex), rep = repDe(esc, t, b, r, m, req[t], cap, pctNiv[niv]);
      A.b[t][i] = b; A.r[t][i] = r; A.m[t][i] = m; A.req[t][i] = req[t]; A.fal[t][i] = fal; A.rep[t][i] = rep;
      const o = t * nL + loc; L.b[o] += b; L.r[o] += r; L.m[o] += m; L.req[o] += req[t]; L.fal[o] += fal; L.rep[o] += rep;
      L.repTot[loc] += rep; L.falTot[loc] += fal; L.reqTot[loc] += req[t];
    }
  }
  return { A, L, nL, incl, escenario: esc, capOcup: P.capOcup ?? DEF.capOcup, capPct: P.capPct ?? DEF.capPct,
    pctRegular: P.pctRegular ?? DEF.pctRegular, pctRegularNivel: { ...(P.pctRegularNivel || {}) }, pctNiv, pctOrigen: { ...(P.pctOrigen || DEF.pctOrigen) }, umbralVida: P.umbralVida ?? DEF.umbralVida };
}
// A reponer en un aula, según el escenario (t: 0 mesa, 1 silla, 2-4 docente y armario)
function repDe(esc, t, b, r, m, req, cap, pct) {
  if (esc === 'malo_regular') return m + regularAReponer(r, pct);
  if (esc === 'capacidad') return t < 2 ? cap : req;
  return m;
}

export const lv = (C, m, t, i) => C.L[m][t * C.nL + i];

export function totals(D, C, list) {
  const T = { n: list.length, est: 0, aul: 0, sec: 0, rep: 0, fal: 0, req: 0, t: ITEMS.map(() => ({ b: 0, r: 0, m: 0, req: 0, fal: 0, rep: 0 })) };
  for (const i of list) {
    T.est += D.locEst[i]; T.aul += D.locAul[i].length; T.sec += D.locSec[i]; T.rep += C.L.repTot[i]; T.fal += C.L.falTot[i]; T.req += C.L.reqTot[i];
    for (let t = 0; t < 5; t++) {
      const o = T.t[t]; o.b += lv(C, 'b', t, i); o.r += lv(C, 'r', t, i); o.m += lv(C, 'm', t, i);
      o.req += lv(C, 'req', t, i); o.fal += lv(C, 'fal', t, i); o.rep += lv(C, 'rep', t, i);
    }
  }
  return T;
}

// Totales por nivel educativo de una lista de locales: un local con varios niveles
// cuenta en cada uno con sus estudiantes (padrón) y sus aulas (censo) de ese nivel.
// [{ nivel, nombre, n, est, aul, b, r, m, rep, fal, req }] en orden I, P, S, E
export function totalesPorNivel(D, C, list) {
  const out = {};
  const de = n => out[n] ??= { nivel: n, nombre: NIVN[n], n: 0, est: 0, aul: 0, b: 0, r: 0, m: 0, rep: 0, fal: 0, req: 0 };
  for (const i of list) {
    const vistos = new Set();
    for (const si of D.locSvc[i]) { const s = D.svcs[si], o = de(s[2]); o.est += s[6]; if (!vistos.has(s[2])) { vistos.add(s[2]); o.n++; } }
    for (const ai of D.locAul[i]) {
      const o = de(D.svcs[D.aulas[ai][1]][2]); o.aul++;
      for (let t = 0; t < 5; t++) { o.b += C.A.b[t][ai]; o.r += C.A.r[t][ai]; o.m += C.A.m[t][ai]; o.rep += C.A.rep[t][ai]; o.fal += C.A.fal[t][ai]; o.req += C.A.req[t][ai]; }
    }
  }
  return ['I', 'P', 'S', 'E'].filter(n => out[n]).map(n => out[n]);
}

// ─── Cuadro de estado situacional (formato del expediente de Huánuco, 2023) ────
// Por UGEL y nivel: locales, población (matrícula del padrón), aulas (censo),
// mobiliario Bueno, Regular y Malo (los cinco tipos; mesa en puestos) y si los
// locales cuentan con otra inversión. Subtotal por nivel y total.
// Listas por UGEL: una fila por servicio educativo (código modular).
// Comprobaciones, para no repetir un error visto en un expediente real:
//   suma     · lo de cada UGEL sumado por nivel = lo de la UGEL contado directo;
//              los subtotales por nivel suman el total
//   iguales  · dos UGEL con cifras idénticas (en total o en un mismo nivel)
// dupDe(cod) → 'si' | 'no' | 'sin_verificar' (otra inversión vigente o reciente)
export const CLAVES_SIT = ['n', 'est', 'aul', 'b', 'r', 'm'];
const vacioSit = () => ({ n: 0, est: 0, aul: 0, b: 0, r: 0, m: 0, pi: { si: 0, no: 0, sin_verificar: 0 } });
const sumarSit = (o, x) => { for (const k of CLAVES_SIT) o[k] += x[k]; for (const k in o.pi) o.pi[k] += x.pi[k]; return o; };
export const piTexto = pi => pi.si ? 'Sí' : pi.sin_verificar ? 'Sin verificar' : 'No';

export function estadoSituacional(D, C, list, dupDe = () => 'sin_verificar') {
  const celdas = new Map();   // nivel|ugel → totales
  const listas = new Map();   // ugel → filas
  const directo = new Map();  // ugel → contado por local, sin pasar por el nivel
  for (const i of list) {
    const l = D.locs[i], ugel = D.ugels[l[2]] || '(sin UGEL)', cod = l[0], dup = dupDe(cod) || 'sin_verificar';
    const porNiv = {};
    const de = n => porNiv[n] ??= vacioSit();
    for (const si of D.locSvc[i]) {
      const s = D.svcs[si];
      de(s[2]).est += s[6];
      if (!listas.has(ugel)) listas.set(ugel, []);
      listas.get(ugel).push({ cod, modular: s[0], inst: s[1], est: s[6], nivel: s[2], nombreNivel: NIVN[s[2]], cp: l[3], dist: D.dists[l[1]][0], ugel });
    }
    for (const ai of D.locAul[i]) {
      const o = de(D.svcs[D.aulas[ai][1]][2]); o.aul++;
      for (let t = 0; t < 5; t++) { o.b += C.A.b[t][ai]; o.r += C.A.r[t][ai]; o.m += C.A.m[t][ai]; }
    }
    for (const [n, o] of Object.entries(porNiv)) {
      o.n = 1; o.pi[dup] = 1;
      const k = n + '|' + ugel;
      celdas.set(k, sumarSit(celdas.get(k) || Object.assign(vacioSit(), { nivel: n, nombre: NIVN[n], ugel }), o));
    }
    // Directo por local (para la comprobación)
    const d = directo.get(ugel) || Object.assign(vacioSit(), { ugel });
    d.n++; d.est += D.locEst[i]; d.aul += D.locAul[i].length; d.pi[dup]++;
    for (let t = 0; t < 5; t++) { d.b += C.L.b[t * C.nL + i]; d.r += C.L.r[t * C.nL + i]; d.m += C.L.m[t * C.nL + i]; }
    directo.set(ugel, d);
  }
  const ORD = ['I', 'P', 'S', 'E'], cmpU = (a, b) => a.localeCompare(b, 'es');
  const filas = [...celdas.values()].sort((a, b) => ORD.indexOf(a.nivel) - ORD.indexOf(b.nivel) || cmpU(a.ugel, b.ugel));
  const niveles = ORD.filter(n => filas.some(f => f.nivel === n)).map(n => ({
    nivel: n, nombre: NIVN[n], filas: filas.filter(f => f.nivel === n),
    subtotal: filas.filter(f => f.nivel === n).reduce(sumarSit, vacioSit())
  }));
  const total = niveles.reduce((a, x) => sumarSit(a, x.subtotal), vacioSit());
  const ugels = [...directo.keys()].sort(cmpU);

  // ── Comprobaciones ──
  const advertencias = [], fmt = n => n.toLocaleString('es-PE'), cif = o => `${fmt(o.est)} estudiantes, ${fmt(o.aul)} aulas, ${fmt(o.b)} B, ${fmt(o.r)} R, ${fmt(o.m)} M`;
  // Locales: en el cuadro cuenta una vez por nivel; directo, una vez. Se comparan las cifras, no el conteo.
  const CIF = ['est', 'aul', 'b', 'r', 'm'];
  const porUgel = ugels.map(u => {
    const suma = filas.filter(f => f.ugel === u).reduce(sumarSit, vacioSit()), d = directo.get(u);
    const ok = CIF.every(k => suma[k] === d[k]);
    if (!ok) advertencias.push({ tipo: 'suma', clave: 'suma|' + u, texto: `${u}: la suma por nivel (${cif(suma)}) no coincide con lo contado por local (${cif(d)}).` });
    return { ugel: u, ...suma, pi: suma.pi, locales: d.n, directo: d, ok };
  });
  const T = list.length ? totals(D, C, list) : null;
  if (T) {
    const tb = T.t.reduce((a, o) => ({ b: a.b + o.b, r: a.r + o.r, m: a.m + o.m }), { b: 0, r: 0, m: 0 });
    const esperado = { est: T.est, aul: T.aul, ...tb };
    if (!CIF.every(k => total[k] === esperado[k]))
      advertencias.push({ tipo: 'suma', clave: 'suma|total', texto: `Los subtotales por nivel (${cif(total)}) no suman el total de la selección (${cif(esperado)}).` });
  }
  // Dos UGEL con cifras idénticas: en el total de la UGEL o en un mismo nivel
  const firma = o => CIF.map(k => o[k]).join('|');
  const parejas = (grupo, etiqueta, claveDe) => {
    const vistos = new Map();
    for (const o of grupo) {
      if (!o.est && !o.aul) continue;
      const f = firma(o);
      if (vistos.has(f)) {
        const a = vistos.get(f);
        advertencias.push({ tipo: 'iguales', clave: claveDe(a.ugel, o.ugel), texto: `${a.ugel} y ${o.ugel} tienen cifras idénticas${etiqueta} (${cif(o)}). Revisa si es un error de copia o explícalo.` });
      } else vistos.set(f, o);
    }
  };
  const par = (a, b) => [a, b].sort(cmpU).join(' = ');
  if (ugels.length > 1) {
    parejas(porUgel, ' en su total', (a, b) => 'iguales|total|' + par(a, b));
    for (const x of niveles) parejas(x.filas, ` en ${x.nombre}`, (a, b) => `iguales|${x.nivel}|` + par(a, b));
  }
  return {
    niveles, total, porUgel, advertencias,
    listas: ugels.map(u => ({ ugel: u, filas: (listas.get(u) || []).sort((a, b) => a.cod.localeCompare(b.cod) || ORD.indexOf(a.nivel) - ORD.indexOf(b.nivel)) }))
  };
}

// Filtro del prototipo (applyFilter, sin el orden). F: {q, prov, dist, ugel, area, ges, niv, rep, est, censo}
export function filtrar(D, C, F) {
  const out = [], q = norm(F.q).split(/\s+/).filter(Boolean);
  for (let i = 0; i < D.locs.length; i++) {
    const l = D.locs[i], dist = l[1];
    if (F.prov >= 0 && D.dists[dist][2] !== F.prov) continue;
    if (F.dist >= 0 && dist !== F.dist) continue;
    if (F.ugel >= 0 && l[2] !== F.ugel) continue;
    if (F.area >= 0 && l[4] !== F.area) continue;
    if (F.niv && !(D.locNiv[i] & F.niv)) continue;
    if (F.ges >= 0 && !(D.locGes[i] & (1 << F.ges))) continue;
    if (F.est && D.locEst[i] < F.est) continue;
    if (F.rep && C.L.repTot[i] < F.rep) continue;
    if (F.censo && !D.locAul[i].length) continue;
    if (q.length) { const t = D.locText[i]; let ok = true; for (const w of q) if (!t.includes(w)) { ok = false; break; } if (!ok) continue; }
    out.push(i);
  }
  return out;
}

// Selección por lista pegada: busca cada número del texto como código de local (6 dígitos)
// o código modular (7 dígitos). Si Excel borró los ceros de la izquierda, los repone.
// Devuelve los índices de local (sin repetir), los números que no están en la región
// y cuántos se encontraron por código modular.
export function buscarCodigos(D, texto) {
  if (!D.codLoc) {
    D.codLoc = new Map(D.locs.map((l, i) => [l[0], i]));
    D.codMod = new Map(D.svcs.map(s => [s[0], s[3]]));
  }
  const nums = [...new Set(String(texto || '').match(/\d+/g) || [])];
  const idx = new Set(), noEncontrados = [];
  let porModular = 0;
  for (const n of nums) {
    let i = D.codLoc.get(n);
    if (i == null && D.codMod.has(n)) { i = D.codMod.get(n); porModular++; }
    if (i == null && n.length < 6) i = D.codLoc.get(n.padStart(6, '0'));
    if (i == null && n.length < 7 && D.codMod.has(n.padStart(7, '0'))) { i = D.codMod.get(n.padStart(7, '0')); porModular++; }
    if (i == null) noEncontrados.push(n); else idx.add(i);
  }
  return { idx: [...idx], noEncontrados, porModular, leidos: nums.length };
}

export const FILTRO_VACIO = () => ({ q: '', prov: -1, dist: -1, ugel: -1, area: -1, ges: -1, niv: 0, rep: 0, est: 0, censo: false });
