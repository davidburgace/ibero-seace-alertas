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
// Cálculo por local (después se suma):
//   CD        = Σ reposición × precio unitario (sin IGV)
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

import { ITEMS } from './calculo.js';

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
 *
 * Con inventario verificado, en ese local y tipo se reemplaza el censo:
 *   Faltante = MAX(0, Requerido − (B + R + M)), Reposición = M, por local.
 */
export function costear({ D, C, list, precios, rubros, factores, uit, inventario }) {
  const R = limpiarRubros(rubros);
  const pu = TIPOS.map(k => Number(precios?.[k]) >= 0 && precios?.[k] != null ? Number(precios[k]) : null);
  const idx = indiceFactores(factores);
  const nL = C.nL, n = list.length;

  // ── Por local: metrado, CD y factores ─────────────────────────────────────
  const locales = list.map(i => {
    const l = D.locs[i], d = D.dists[l[1]];
    const rep = TIPOS.map((_, t) => C.L.rep[t * nL + i]);
    const fal = TIPOS.map((_, t) => C.L.fal[t * nL + i]);
    // Diagnóstico (bueno, regular, malo) y requerido: se muestran siempre, aunque solo Malo se reponga
    const diag = TIPOS.map((_, t) => ({ b: C.L.b[t * nL + i], r: C.L.r[t * nL + i], m: C.L.m[t * nL + i], req: C.L.req[t * nL + i] }));
    const inv = inventario?.[l[0]];
    let verificado = null;
    if (inv) {
      const tipos = [];
      TIPOS.forEach((k, t) => {
        const x = inv.bienes?.[k];
        if (!x) return;
        fal[t] = Math.max(0, C.L.req[t * nL + i] - (x.b + x.r + x.m));
        rep[t] = x.m;
        diag[t] = { ...diag[t], b: x.b, r: x.r, m: x.m };
        tipos.push(k);
      });
      // Visita registrada: puede corregir cantidades (tipos) o solo traer el año de adquisición
      verificado = { tipos, adquisicion: inv.adquisicion || {}, fecha_visita: inv.fecha_visita, responsable: inv.responsable || null, observacion: inv.observacion };
    }
    const cdTipo = rep.map((q, t) => q * (pu[t] ?? 0));
    const z = factorZona(d[1], l[4], idx);
    return {
      i, cod: l[0], nom: D.locName[i], dist: d[0], prov: D.provs[d[2]], ubigeo: d[1], rural: !!l[4],
      est: D.locEst[i], aul: D.locAul[i].length, zona: z, rep, fal, diag, cdTipo, verificado,
      cd: cdTipo.reduce((a, b) => a + b, 0), falValor: fal.reduce((a, q, t) => a + q * (pu[t] ?? 0), 0), r: {}
    };
  });

  // Aplica un grupo de rubros: base(local) → monto del rubro en cada local
  const aplicar = (grupo, baseDe) => {
    for (const def of DEL_GRUPO(grupo)) {
      const x = R.find(r => r.clave === def.clave);
      const base = loc => baseDe(loc, x.base);
      const suma = locales.reduce((a, loc) => a + base(loc), 0);
      for (const loc of locales) {
        let m = x.modo === 'pct' ? base(loc) * x.valor / 100
          : (suma ? x.valor * base(loc) / suma : x.valor / (n || 1));
        if (def.zona) m *= 1 + loc.zona[def.zona];
        loc.r[def.clave] = m;
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

  // ── Totales ───────────────────────────────────────────────────────────────
  const sum = f => locales.reduce((a, loc) => a + f(loc), 0);
  const T = {
    locales: n, est: sum(l => l.est), aul: sum(l => l.aul),
    cd: sum(l => l.cd), subtotal: sum(l => l.subtotal), neto: sum(l => l.neto), bienes: sum(l => l.bienes), total: sum(l => l.total),
    rep: sum(l => l.rep.reduce((a, b) => a + b, 0)), fal: sum(l => l.fal.reduce((a, b) => a + b, 0)), falValor: sum(l => l.falValor)
  };
  T.porEstudiante = T.est ? T.total / T.est : null;

  const partidas = ITEMS.map((x, t) => {
    const rep = sum(l => l.rep[t]), fal = sum(l => l.fal[t]);
    const [b, r, m, req] = ['b', 'r', 'm', 'req'].map(k => sum(l => l.diag[t][k]));
    return { k: x.k, n: x.n, u: x.u, b, r, m, ex: b + r + m, req, rep, fal, pu: pu[t], parcial: rep * (pu[t] ?? 0), falValor: fal * (pu[t] ?? 0) };
  });
  const rubrosOut = R.map(x => ({ ...x, nombre: RUBRO[x.clave].nombre, grupo: RUBRO[x.clave].grupo, monto: sum(l => l.r[x.clave]) }));

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
  const sinPrecio = partidas.filter(p => p.pu == null && (p.rep > 0 || p.fal > 0)).map(p => p.n);
  if (sinPrecio.length) avisos.push({ tipo: 'precio', texto: `Falta el precio unitario de: ${sinPrecio.join(', ')}. Se calcula con 0 hasta que lo cargues.` });
  if (T.fal > 0) avisos.push({ tipo: 'faltante', texto: 'El faltante (brecha de dotación, no reposición) es lo que falta para llegar a lo requerido. No entra a lo que se repone, al costo de inversión ni al Formato 07-C: amplía la capacidad de la UP y una IOARR de reposición no se puede sustentar en eso (Lineamientos IOARR del MEF, 2.4.C). Se muestra valorizado aparte, como referencia; corresponde evaluarlo como ampliación marginal.' });
  if (!valorUit) avisos.push({ tipo: 'uit', texto: `Carga el valor de la UIT${U.anio ? ' de ' + U.anio : ''} para saber si el registro del Formato 07-C es abreviado o completo.` });
  else if (U.supera) avisos.push({ tipo: 'uit75', texto: `El total supera las ${LIMITE_UIT} UIT (UIT ${U.anio}): corresponde el registro completo del Formato 07-C (secciones D, E y F).` });
  const verif = locales.filter(l => l.verificado?.tipos.length);
  if (verif.length) avisos.push({ tipo: 'inventario', texto: `${verif.length === 1 ? '1 local usa' : verif.length + ' locales usan'} inventario verificado en campo en lugar del Censo Educativo (${verif.map(l => l.cod).join(', ')}). Adjunta al expediente el sustento de la visita (acta, fotos, firma del director).` });
  if (R.every(r => r.valor === 0)) avisos.push({ tipo: 'rubros', texto: 'Todos los rubros están en 0. Ingresa los porcentajes o montos de transporte, gastos generales, utilidad, IGV y demás.' });

  return { partidas, rubros: rubrosOut, totales: T, locales, distritos, uit: U, avisos };
}
