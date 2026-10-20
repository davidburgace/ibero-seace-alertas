// ============================================================================
// src/selector-ioarr/calculo.js — Cálculo de reposición de mobiliario (Selector IOARR)
//
// Copia fiel del prototipo (docs/selector-ioarr/prototipo.html: prep, calc, totals).
// Lo usan el navegador (vía /selector-ioarr/calculo.js, dentro de un Web Worker)
// y el servidor (exportación a Excel), así la pantalla y el Excel dan lo mismo.
//
// Reglas:
//   Existente = Bueno + Regular + Malo
//   Faltante  = MAX(0, Requerido − Existente), por aula
//   A reponer = Malo + Faltante + ROUND(Regular × % de Regular), por aula
//   Requerido: mesa y silla por estudiante; escritorio, silla docente y armario por aula.
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
export const NIVN = { I: 'Inicial', P: 'Primaria', S: 'Secundaria', E: 'Básica Especial' };
export const NIVS = { I: 'Inicial', P: 'Primaria', S: 'Secundaria', E: 'Especial' };
export const NIVB = { I: 1, P: 2, S: 4, E: 8 };
export const DEF = { kI: 4, kPS: 2, carpBip: 2, carpEstado: 'r', regPct: 0, mesaEst: 1, sillaEst: 1, esc: 1, sdoc: 1, arm: 1 };
// [clave, etiqueta, mín, máx, paso]  (regPct se edita en %, se guarda como fracción)
export const CRIT = [['kI', 'Puestos por mesa múltiple (Inicial y Especial)', 1, 12, 1], ['kPS', 'Puestos por mesa múltiple (Primaria y Secundaria)', 1, 12, 1],
  ['carpBip', 'Puestos por carpeta bipersonal', 1, 4, 1], ['regPct', '% del estado Regular que se repone', 0, 100, 5],
  ['mesaEst', 'Mesas por estudiante', 0, 2, 0.5], ['sillaEst', 'Sillas por estudiante', 0, 2, 0.5],
  ['esc', 'Escritorios docentes por aula', 0, 3, 1], ['sdoc', 'Sillas docentes por aula', 0, 3, 1], ['arm', 'Armarios o estantes por aula', 0, 5, 1]];

export const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Criterios válidos a partir de lo que venga guardado (ignora claves o valores raros)
export function limpiarParams(p) {
  const P = { ...DEF };
  if (p && typeof p === 'object') {
    for (const [k, , mn, mx] of CRIT) {
      const v = Number(p[k]);
      if (!Number.isFinite(v)) continue;
      P[k] = k === 'regPct' ? Math.min(1, Math.max(0, v)) : Math.min(mx, Math.max(mn, v));
    }
    if (['b', 'r', 'm'].includes(p.carpEstado)) P.carpEstado = p.carpEstado;
  }
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

// Mobiliario por aula (A) y acumulado por local (L), según los criterios P
export function calc(D, P) {
  const nA = D.aulas.length, nL = D.locs.length;
  const L = { b: new Float64Array(5 * nL), r: new Float64Array(5 * nL), m: new Float64Array(5 * nL), req: new Float64Array(5 * nL),
    fal: new Float64Array(5 * nL), rep: new Float64Array(5 * nL), repTot: new Float64Array(nL), reqTot: new Float64Array(nL) };
  const A = { b: [], r: [], m: [], req: [], fal: [], rep: [] };
  for (const k in A) for (let t = 0; t < 5; t++) A[k].push(new Int32Array(nA));
  for (let i = 0; i < nA; i++) {
    const a = D.aulas[i], niv = D.svcs[a[1]][2], k = (niv === 'I' || niv === 'E') ? P.kI : P.kPS, f = j => a[11 + j], loc = a[0];
    const carp = f(6) + f(7) * P.carpBip;
    let mb = f(0) + k * f(3), mr = f(1) + k * f(4), mm = f(2) + k * f(5), sb = f(8), sr = f(9), sm = f(10);
    if (P.carpEstado === 'b') { mb += carp; sb += carp; } else if (P.carpEstado === 'm') { mm += carp; sm += carp; } else { mr += carp; sr += carp; }
    const trip = [[mb, mr, mm], [sb, sr, sm], [f(11), f(12), f(13)], [f(14), f(15), f(16)], [f(17), f(18), f(19)]];
    const req = [Math.round(a[8] * P.mesaEst), Math.round(a[8] * P.sillaEst), P.esc, P.sdoc, P.arm];
    for (let t = 0; t < 5; t++) {
      const [b, r, m] = trip[t], ex = b + r + m, fal = Math.max(0, req[t] - ex), rep = m + Math.round(r * P.regPct) + fal;
      A.b[t][i] = b; A.r[t][i] = r; A.m[t][i] = m; A.req[t][i] = req[t]; A.fal[t][i] = fal; A.rep[t][i] = rep;
      const o = t * nL + loc; L.b[o] += b; L.r[o] += r; L.m[o] += m; L.req[o] += req[t]; L.fal[o] += fal; L.rep[o] += rep;
      L.repTot[loc] += rep; L.reqTot[loc] += req[t];
    }
  }
  return { A, L, nL };
}

export const lv = (C, m, t, i) => C.L[m][t * C.nL + i];

export function totals(D, C, list) {
  const T = { n: list.length, est: 0, aul: 0, sec: 0, rep: 0, req: 0, t: ITEMS.map(() => ({ b: 0, r: 0, m: 0, req: 0, fal: 0, rep: 0 })) };
  for (const i of list) {
    T.est += D.locEst[i]; T.aul += D.locAul[i].length; T.sec += D.locSec[i]; T.rep += C.L.repTot[i]; T.req += C.L.reqTot[i];
    for (let t = 0; t < 5; t++) {
      const o = T.t[t]; o.b += lv(C, 'b', t, i); o.r += lv(C, 'r', t, i); o.m += lv(C, 'm', t, i);
      o.req += lv(C, 'req', t, i); o.fal += lv(C, 'fal', t, i); o.rep += lv(C, 'rep', t, i);
    }
  }
  return T;
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

export const FILTRO_VACIO = () => ({ q: '', prov: -1, dist: -1, ugel: -1, area: -1, ges: -1, niv: 0, rep: 0, est: 0, censo: false });
