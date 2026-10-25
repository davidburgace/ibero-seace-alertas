// ============================================================================
// src/selector-ioarr/catalogo-ref.js — Catálogo de precios referenciales de
// mobiliario escolar tomados de IOARR publicadas (07-C, bases, estudios de mercado)
//
// Distinto del catálogo de precios unitarios de Costos (ioarr_precios_catalogo):
// este sirve para comparar y estimar, no cambia la estructura de costos del 07-C.
//
// Reglas:
//   - Todo se normaliza a «precio por kit sin IGV» (IGV 18 %).
//   - Si la unidad no es kit, hace falta la composición del kit (cuántas unidades
//     de cada bien y el precio de las demás); sin ella el registro no es comparable.
//   - Si no se sabe si el monto incluye IGV, el registro no es comparable.
//   - Un rango (monto … monto_hasta) se compara por su punto medio.
//   - El flete se guarda aparte: no se suma al precio del kit.
//   - El precio propio (tipo «propio») no entra a los estadísticos y es de USO
//     INTERNO: no sale en las bases, el 07-C, los Excel ni el ZIP.
//
// Tablas y precarga: supabase/migrations/029_ioarr_catalogo_precios_ref.sql
// Rutas: catalogo-ref-api.js
// ============================================================================

import { descuadre, soles } from './montos.js';

export const IGV = 18;
export const TIPOS_DOC = { '07-C': 'Formato 07-C', bases: 'Bases', estudio_mercado: 'Estudio de mercado', estimado_derivado: 'Estimado derivado (de los montos de un 07-C)',
  propio: 'Precio propio (uso interno)', por_confirmar: 'Por confirmar' };
// Componentes del monto total de una IOARR (07-C o bases): deben sumar exactamente el total declarado
export const COMPONENTES = { ejecucion: 'Ejecución física', doc_equivalente: 'Documento equivalente', sup_doc_equivalente: 'Supervisión del documento equivalente', sup_ejecucion: 'Supervisión de la ejecución física' };
export const NIVELES = { Inicial: 'Inicial', Primaria: 'Primaria', Secundaria: 'Secundaria', por_confirmar: 'Por confirmar' };
export const UNIDADES = { kit: 'Kit (mesa + silla)', mesa: 'Mesa', silla: 'Silla', carpeta: 'Carpeta', pieza: 'Pieza de mobiliario (sin especificar)' };
export const MATERIALES = { madera: 'Madera', 'metal-madera': 'Metal y madera', 'metal-polipropileno': 'Metal y polipropileno', por_confirmar: 'Por confirmar' };
export const CONFIANZAS = { alta: 'Alta', media: 'Media', baja: 'Baja' };
export const MIN_FUENTES = 3;
export const RANGO_MIN = 90, RANGO_MAX = 110;   // propuesta económica válida: 90 %–110 % del monto referencial
// El nivel de una IOARR del Selector (I, P, S) en el catálogo
export const NIVEL_DE = { I: 'Inicial', P: 'Primaria', S: 'Secundaria' };

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const S = n => 'S/ ' + NS.format(n);
export const sinIgv = (monto, igv = IGV) => r2(monto / (1 + igv / 100));
export const conIgv = (monto, igv = IGV) => r2(monto * (1 + igv / 100));

// ─── Validación de un registro ──────────────────────────────────────────────
const texto = (v, max = 300) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const numero = v => { if (v === '' || v == null) return null; const n = typeof v === 'number' ? v : Number(String(v).trim()); return Number.isFinite(n) ? n : NaN; };
const bool = v => v === true || v === false ? v : v == null || v === '' ? null
  : /^(si|sí|true|1|con|con igv|incluye)$/i.test(String(v).trim()) ? true : /^(no|false|0|sin|sin igv|no incluye)$/i.test(String(v).trim()) ? false : undefined;

/**
 * Valida y limpia un registro (formulario o fila de CSV).
 * @returns { r, errores: [texto] } r es null si hay errores
 */
export function limpiarRegistro(b = {}) {
  b = b || {};
  const errores = [], err = t => errores.push(t);
  const enumDe = (v, E, nombre, req = true) => { const s = texto(v); if (!s) { if (req) err(`Falta ${nombre}`); return null; } if (!(s in E)) { err(`${nombre} no válido: «${s}» (${Object.keys(E).join(', ')})`); return null; } return s; };
  const r = {};
  r.tipo_documento = enumDe(b.tipo_documento, TIPOS_DOC, 'tipo de documento');
  r.cui = texto(b.cui, 10) || null;
  if (r.cui && !/^\d{5,8}$/.test(r.cui)) err('El CUI debe tener solo dígitos (5 a 8)');
  r.entidad = texto(b.entidad, 200) || null;
  r.region = texto(b.region, 60) || null;
  if (!r.region && r.tipo_documento !== 'propio') err('Falta la región');
  const anio = numero(b.anio);
  if (anio == null) err('Falta el año'); else if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) err('Año no válido');
  r.anio = Number.isInteger(anio) ? anio : null;
  r.url = texto(b.url, 500) || null;
  if (r.url && !/^https?:\/\/\S+$/i.test(r.url)) err('El enlace debe empezar con http:// o https://');
  r.nivel = enumDe(b.nivel, NIVELES, 'nivel');
  r.unidad = enumDe(b.unidad, UNIDADES, 'unidad');
  r.material = enumDe(b.material, MATERIALES, 'material');
  // Componentes del total (07-C o bases): opcionales, pero si se dan deben sumar exactamente el total
  r.componentes = null;
  const cb = b.componentes && typeof b.componentes === 'object' ? b.componentes : null;
  if (cb && [...Object.keys(COMPONENTES), 'total'].some(k => cb[k] !== '' && cb[k] != null)) {
    const c = {};
    for (const [k, et] of [...Object.entries(COMPONENTES), ['total', 'Total declarado']]) {
      const v = numero(cb[k]);
      if (v == null) err(`Componentes: falta «${et}»`); else if (Number.isNaN(v) || v < 0 || v > 1e11) err(`Componentes: «${et}» no válido`); else c[k] = r2(v);
    }
    if (Object.keys(c).length === 5) {
      const d = descuadre(Object.fromEntries(Object.entries(COMPONENTES).map(([k, et]) => [et, c[k]])), c.total);
      if (d) err('Los componentes no suman el total declarado: ' + d); else r.componentes = c;
    }
  }
  // Estimado derivado: el monto sale de una fórmula (ejecución física / cantidad), no se escribe a mano
  const dv = b.derivacion && typeof b.derivacion === 'object' ? b.derivacion : null;
  const div = numero(dv?.divisor), divAlt = numero(dv?.divisor_alternativo);
  r.derivacion = null; r.formula = null; r.monto_alternativo = null;
  if (r.tipo_documento === 'estimado_derivado') {
    if (!cb) err('Estimado derivado: indica los componentes del 07-C (al menos la ejecución física y el total)');
    if (!Number.isInteger(div) || div < 1) err('Estimado derivado: indica la cantidad entre la que se divide la ejecución física');
    if (divAlt != null && (!Number.isInteger(divAlt) || divAlt < 1)) err('Estimado derivado: la cantidad alternativa no es válida');
    if (r.componentes && Number.isInteger(div) && div >= 1) {
      const ej = r.componentes.ejecucion, detalle = texto(dv.detalle, 300) || null;
      r.derivacion = { base: 'ejecucion', divisor: div, divisor_alternativo: Number.isInteger(divAlt) && divAlt >= 1 ? divAlt : null, detalle };
      b = { ...b, monto: r2(ej / div) };
      r.monto_alternativo = r.derivacion.divisor_alternativo ? r2(ej / r.derivacion.divisor_alternativo) : null;
      r.formula = `Ejecución física ${soles(ej)} / ${div.toLocaleString('es-PE')} = ${soles(b.monto)}`
        + (r.monto_alternativo ? `; alternativa: / ${r.derivacion.divisor_alternativo.toLocaleString('es-PE')} = ${soles(r.monto_alternativo)}` : '')
        + (detalle ? ` (${detalle})` : '');
    }
  } else if (dv && (div != null || divAlt != null)) err('La fórmula de derivación solo vale para el tipo «estimado derivado»');
  const monto = numero(b.monto);
  if (monto == null) err('Falta el monto'); else if (Number.isNaN(monto) || monto <= 0 || monto > 1e6) err('Monto no válido (mayor que 0)');
  r.monto = monto > 0 && monto <= 1e6 ? r2(monto) : null;
  const hasta = numero(b.monto_hasta);
  if (Number.isNaN(hasta) || (hasta != null && r.monto != null && hasta < r.monto)) err('El monto «hasta» del rango debe ser mayor o igual que el monto');
  r.monto_hasta = hasta != null && !Number.isNaN(hasta) && r.monto != null && hasta >= r.monto ? r2(hasta) : null;
  const igv = bool(b.incluye_igv);
  if (igv === undefined) err('«Incluye IGV» debe ser sí, no o vacío (por confirmar)');
  r.incluye_igv = igv ?? null;
  // Cotizaciones usadas (opcional): valores y su promedio
  const vals = (Array.isArray(b.cotizaciones?.valores) ? b.cotizaciones.valores : String(b.cotizaciones_valores ?? '').split(/[;|]/)).map(numero).filter(v => v != null);
  if (vals.some(v => Number.isNaN(v) || v <= 0)) err('Cotizaciones: cada valor debe ser un número mayor que 0');
  const nCot = numero(b.cotizaciones?.n ?? b.cotizaciones_n);
  if (Number.isNaN(nCot) || (nCot != null && (!Number.isInteger(nCot) || nCot < 1 || nCot > 100))) err('Número de cotizaciones no válido');
  const valsOk = vals.filter(v => v > 0);
  const promDado = numero(b.cotizaciones?.promedio ?? b.cotizaciones_promedio);
  r.cotizaciones = valsOk.length || nCot || promDado > 0
    ? { valores: valsOk.map(r2), n: valsOk.length || (Number.isInteger(nCot) ? nCot : null), promedio: valsOk.length ? r2(valsOk.reduce((a, v) => a + v, 0) / valsOk.length) : promDado > 0 ? r2(promDado) : null } : null;
  // Composición del kit: [{ unidad, cantidad, precio }]; el precio de la unidad del registro es el monto
  const comp = Array.isArray(b.composicion) ? b.composicion : parsearComposicion(b.composicion);
  if (comp === undefined) err('Composición no válida: usa «unidad:cantidad[:precio]» separados por «;» (ej.: mesa:1;silla:1:150)');
  r.composicion = [];
  for (const x of comp || []) {
    const u = texto(x.unidad), q = numero(x.cantidad), p = numero(x.precio);
    if (!(u in UNIDADES) || u === 'kit') { err(`Composición: unidad no válida «${u}»`); continue; }
    if (!Number.isInteger(q) || q < 1 || q > 100) { err(`Composición: cantidad no válida para ${u}`); continue; }
    if (Number.isNaN(p) || (p != null && p < 0)) { err(`Composición: precio no válido para ${u}`); continue; }
    r.composicion.push({ unidad: u, cantidad: q, precio: p == null ? null : r2(p) });
  }
  if (r.unidad === 'kit' && r.composicion.length) err('Con unidad «kit» no hace falta la composición');
  const flete = numero(b.flete_transporte);
  if (Number.isNaN(flete) || (flete != null && flete < 0)) err('Flete no válido');
  r.flete_transporte = flete != null && flete >= 0 ? r2(flete) : null;
  r.confianza = enumDe(b.confianza, CONFIANZAS, 'confianza');
  r.notas = texto(b.notas, 1000) || null;
  return { r: errores.length ? null : r, errores };
}
// «mesa:1;silla:1:150» → [{ unidad, cantidad, precio }]. Vacío → []. Mal escrito → undefined
export function parsearComposicion(s) {
  const t = String(s ?? '').trim();
  if (!t) return [];
  const out = [];
  for (const parte of t.split(';').map(x => x.trim()).filter(Boolean)) {
    const m = parte.match(/^([a-z]+)\s*:\s*(\d+)\s*(?::\s*([\d.]+))?$/i);
    if (!m) return undefined;
    out.push({ unidad: m[1].toLowerCase(), cantidad: Number(m[2]), precio: m[3] == null ? null : Number(m[3]) });
  }
  return out;
}
export const textoComposicion = c => (c || []).map(x => `${x.unidad}:${x.cantidad}${x.precio != null ? ':' + x.precio : ''}`).join(';');

// ─── Normalización a precio por kit sin IGV ─────────────────────────────────
/**
 * @returns { base, precio_sin_igv, precio_kit_sin_igv, comparable, motivo, propio }
 *   base: el monto (o el punto medio del rango) en la condición de IGV declarada
 */
export function normalizar(r) {
  const propio = r.tipo_documento === 'propio';
  const base = r.monto_hasta != null ? r2((r.monto + r.monto_hasta) / 2) : r.monto;
  const out = { base, precio_sin_igv: null, precio_kit_sin_igv: null, comparable: false, motivo: null, propio };
  if (r.incluye_igv == null) { out.motivo = 'No se sabe si el monto incluye IGV'; return out; }
  const aSinIgv = v => r.incluye_igv ? sinIgv(v) : r2(v);
  out.precio_sin_igv = aSinIgv(base);
  if (r.monto_alternativo != null) out.precio_alternativo_sin_igv = aSinIgv(r.monto_alternativo);
  if (r.unidad === 'kit') { out.precio_kit_sin_igv = out.precio_sin_igv; out.comparable = true; return out; }
  const comp = r.composicion || [];
  if (!comp.length) { out.motivo = `Unidad «${r.unidad}»: falta la composición del kit para convertir`; return out; }
  if (!comp.some(x => x.unidad === r.unidad)) { out.motivo = `La composición del kit no incluye la unidad del registro («${r.unidad}»)`; return out; }
  const sinPrecio = comp.filter(x => x.unidad !== r.unidad && x.precio == null);
  if (sinPrecio.length) { out.motivo = `Composición del kit: falta el precio de ${sinPrecio.map(x => x.unidad).join(', ')}`; return out; }
  // Los precios de la composición están en la misma condición de IGV que el monto
  const kit = comp.reduce((a, x) => a + x.cantidad * (x.unidad === r.unidad ? base : x.precio), 0);
  out.precio_kit_sin_igv = aSinIgv(kit); out.comparable = true;
  return out;
}

// ─── Estadísticos ───────────────────────────────────────────────────────────
export function mediana(xs) {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : r2((s[n / 2 - 1] + s[n / 2]) / 2);
}
const resumen = xs => ({ n: xs.length, min: xs.length ? Math.min(...xs) : null, mediana: mediana(xs), max: xs.length ? Math.max(...xs) : null });
/** Comparables y sin el precio propio */
export const comparables = registros => registros.map(r => ({ ...r, ...normalizar(r) })).filter(x => x.comparable && !x.propio);
/** Mínimo, mediana, máximo y cantidad de fuentes por material y nivel (sin el precio propio) */
export function estadisticos(registros) {
  const g = new Map();
  for (const x of comparables(registros)) {
    const k = `${x.material}|${x.nivel}`;
    if (!g.has(k)) g.set(k, { material: x.material, nivel: x.nivel, precios: [] });
    g.get(k).precios.push(x.precio_kit_sin_igv);
  }
  return [...g.values()].map(({ precios, ...k }) => ({ ...k, ...resumen(precios), pocas: precios.length < MIN_FUENTES }))
    .sort((a, b) => a.material.localeCompare(b.material) || a.nivel.localeCompare(b.nivel));
}
/** Posición de un precio (el propio) frente a la mediana y al rango de los comparables */
export function posicion(precio, est) {
  if (precio == null || !est?.n) return null;
  const dif = r2((precio / est.mediana - 1) * 100);
  const lugar = precio < est.min ? 'debajo' : precio > est.max ? 'encima' : 'dentro';
  return { precio, dif_mediana_pct: dif, lugar,
    texto: `${dif >= 0 ? dif + ' % sobre' : Math.abs(dif) + ' % bajo'} la mediana (${S(est.mediana)}); ${lugar === 'dentro' ? 'dentro del' : lugar === 'encima' ? 'por encima del' : 'por debajo del'} rango (${S(est.min)} a ${S(est.max)}) de ${est.n} ${est.n === 1 ? 'fuente' : 'fuentes'}.` };
}

/**
 * Precio de referencia elegido para una IOARR.
 * sel: { modo: 'mediana' | 'registro', registro_id?, material: 'todos' | material }
 * Con «mediana», entran los comparables del nivel de la IOARR y los de nivel por confirmar.
 * @returns { precio, n, min, max, fuente, avisos, registros }
 */
export function referencia(registros, { nivel, sel = {} }) {
  const modo = sel.modo === 'registro' ? 'registro' : 'mediana', material = sel.material && sel.material !== 'todos' ? sel.material : null, avisos = [];
  const nivelNom = NIVEL_DE[nivel] || nivel;
  if (modo === 'registro') {
    const r = registros.find(x => x.id === sel.registro_id);
    if (!r) return { precio: null, n: 0, fuente: null, avisos: ['La fuente elegida ya no está en el catálogo'], registros: [] };
    const x = { ...r, ...normalizar(r) };
    if (x.propio) return { precio: null, n: 0, fuente: null, avisos: ['El precio propio no puede ser la referencia'], registros: [] };
    if (!x.comparable) return { precio: null, n: 0, fuente: describir(x), avisos: [`La fuente elegida no es comparable: ${x.motivo}`], registros: [] };
    if (x.nivel !== nivelNom && x.nivel !== 'por_confirmar') avisos.push(`La fuente elegida es de ${x.nivel}; la IOARR es de ${nivelNom}.`);
    if (material && x.material !== material) avisos.push(`La fuente elegida es de ${MATERIALES[x.material].toLowerCase()}; el material elegido es ${MATERIALES[material].toLowerCase()}.`);
    avisos.push('Referencia de una sola fuente: menos de 3 fuentes comparables.');
    return { precio: x.precio_kit_sin_igv, n: 1, min: x.precio_kit_sin_igv, max: x.precio_kit_sin_igv, fuente: describir(x), modo, avisos, registros: [x.id] };
  }
  const xs = comparables(registros).filter(x => (x.nivel === nivelNom || x.nivel === 'por_confirmar') && (!material || x.material === material));
  const est = resumen(xs.map(x => x.precio_kit_sin_igv));
  if (est.n < MIN_FUENTES) avisos.push(`Solo ${est.n} ${est.n === 1 ? 'fuente comparable' : 'fuentes comparables'}: se necesitan al menos ${MIN_FUENTES} para una referencia confiable.`);
  if (xs.some(x => x.nivel === 'por_confirmar')) avisos.push('Incluye fuentes con el nivel por confirmar.');
  if (!material && new Set(xs.map(x => x.material)).size > 1) avisos.push('Mezcla materiales distintos.');
  if (xs.some(x => x.material === 'por_confirmar')) avisos.push('Incluye fuentes con el material por confirmar.');
  return { ...est, precio: est.mediana, modo, fuente: est.n ? `Mediana de ${est.n} ${est.n === 1 ? 'fuente publicada' : 'fuentes publicadas'} (${xs.map(describir).join('; ')})` : null, avisos, registros: xs.map(x => x.id) };
}
export const describir = x => [x.entidad || x.region, x.anio, TIPOS_DOC[x.tipo_documento], x.cui ? 'CUI ' + x.cui : null].filter(Boolean).join(', ');

// ─── Estimación del monto del convenio ──────────────────────────────────────
/**
 * Recalcula la estructura de costos de una IOARR con otro precio por kit (sin IGV),
 * igual que costos.js: costo directo = bienes + transporte; IGV, documento equivalente
 * y supervisión en % del costo directo; liquidación (monto o %); control concurrente.
 * El transporte por pieza y los demás bienes quedan como en Costos.
 * Monto del convenio = documento equivalente + ejecución (costo directo con IGV) + supervisión
 * (la supervisión del documento equivalente no está en la estructura de costos).
 * @param base { T: totales de costear, params: estructura.params, kitBienes: bienes de los kits, kits }
 */
export function estimarConvenio({ T, params: E, kitBienes, kits }, precioKit) {
  if (!kits || precioKit == null) return null;
  const cd = r2(T.cd - kitBienes + kits * precioKit);
  const igv = r2(cd * E.igv / 100), doc = r2(cd * E.doc_pct / 100), sup = r2(cd * E.sup_pct / 100);
  const liq = E.liq_modo === 'pct' ? r2(cd * E.liq_pct / 100) : T.liq;
  const cdIgv = r2(cd + igv);
  const cc = T.cc > 0 && E.cc_pct != null ? r2((cdIgv + doc + sup + liq) * E.cc_pct / 100) : 0;
  return { precio_kit: precioKit, kits, cd, cdIgv, doc, sup, liq, cc, total: r2(cdIgv + doc + sup + liq + cc), convenio: r2(doc + cdIgv + sup) };
}
/** Riesgo: el monto con el precio propio frente al referencial (fuera de 90 %–110 %) */
export function riesgo(referencial, propio) {
  if (!referencial || !propio) return null;
  const pct = r2(propio.convenio / referencial.convenio * 100);
  const fuera = pct > RANGO_MAX ? 'encima' : pct < RANGO_MIN ? 'debajo' : null;
  return { pct, fuera, limite_max: r2(referencial.convenio * RANGO_MAX / 100), limite_min: r2(referencial.convenio * RANGO_MIN / 100),
    texto: fuera === 'encima' ? `Con el precio propio, el monto (${S(propio.convenio)}) sería el ${pct} % del referencial calculado: supera el ${RANGO_MAX} % y la propuesta quedaría fuera de rango.`
      : fuera === 'debajo' ? `Con el precio propio, el monto sería el ${pct} % del referencial: por debajo del ${RANGO_MIN} %, la propuesta quedaría fuera de rango.`
      : `Con el precio propio, el monto sería el ${pct} % del referencial: dentro del rango de ${RANGO_MIN} %–${RANGO_MAX} %.` };
}

// ─── CSV ────────────────────────────────────────────────────────────────────
export const COLUMNAS_CSV = ['tipo_documento', 'cui', 'entidad', 'region', 'anio', 'url', 'nivel', 'unidad', 'material', 'monto', 'monto_hasta', 'incluye_igv',
  'cotizaciones_valores', 'cotizaciones_n', 'cotizaciones_promedio', 'composicion', 'flete_transporte', 'confianza', 'notas'];
const csvCelda = v => { const s = String(v ?? ''); return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function plantillaCsv() {
  const ej = [
    ['bases', '2512345', 'Gobierno Regional de Ejemplo', 'Ejemplo', 2026, 'https://ejemplo.gob.pe/bases.pdf', 'Primaria', 'kit', 'metal-madera', 600, '', 'no', '', '', '', '', '', 'alta', 'Fila de ejemplo: bórrala'],
    ['estudio_mercado', '', 'Municipalidad de Ejemplo', 'Ejemplo', 2025, '', 'Secundaria', 'mesa', 'metal-polipropileno', 350, '', 'si', '340;350;360', '', '', 'mesa:1;silla:1:200', 15, 'media', 'Fila de ejemplo: bórrala']
  ];
  return '\uFEFF' + [COLUMNAS_CSV, ...ej].map(f => f.map(csvCelda).join(',')).join('\r\n') + '\r\n';
}
/** CSV (RFC 4180) con coma o punto y coma; con «;» acepta coma decimal */
export function leerCsv(texto) {
  const t = String(texto || '').replace(/^\uFEFF/, '');
  const primera = t.split(/\r?\n/)[0] || '';
  const sep = (primera.match(/;/g) || []).length > (primera.match(/,/g) || []).length ? ';' : ',';
  const filas = []; let fila = [], celda = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { celda += '"'; i++; } else q = false; } else celda += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { fila.push(celda); celda = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; fila.push(celda); filas.push(fila); fila = []; celda = ''; }
    else celda += c;
  }
  if (celda || fila.length) { fila.push(celda); filas.push(fila); }
  return { sep, filas: filas.filter(f => f.some(c => c.trim())) };
}
const NUMERICAS = ['anio', 'monto', 'monto_hasta', 'cotizaciones_n', 'cotizaciones_promedio', 'flete_transporte'];
/**
 * Valida un CSV completo. Si alguna fila tiene errores, no se importa nada (reporte por fila).
 * @param existentes registros del catálogo (para avisar duplicados)
 * @returns { ok, registros, errores: [{ fila, errores }], total }
 */
export function validarCsv(texto, existentes = []) {
  const { sep, filas } = leerCsv(texto);
  if (!filas.length) return { ok: false, registros: [], errores: [{ fila: 1, errores: ['El archivo está vacío'] }], total: 0 };
  const cab = filas[0].map(c => c.trim().toLowerCase());
  const faltan = COLUMNAS_CSV.filter(c => ['tipo_documento', 'region', 'anio', 'nivel', 'unidad', 'material', 'monto', 'incluye_igv', 'confianza'].includes(c) && !cab.includes(c));
  if (faltan.length) return { ok: false, registros: [], errores: [{ fila: 1, errores: [`Faltan columnas: ${faltan.join(', ')}. Descarga la plantilla.`] }], total: filas.length - 1 };
  const desconocidas = cab.filter(c => c && !COLUMNAS_CSV.includes(c));
  const clave = r => [r.tipo_documento, r.cui || r.entidad || r.region, r.anio, r.nivel, r.unidad, r.material, r.monto, r.monto_hasta].join('|');
  const vistos = new Map(existentes.map(r => [clave(r), 'el catálogo']));
  const registros = [], errores = [];
  filas.slice(1).forEach((f, i) => {
    const n = i + 2, b = {};
    cab.forEach((c, j) => { if (COLUMNAS_CSV.includes(c)) b[c] = (f[j] ?? '').trim(); });
    if (sep === ';') for (const c of NUMERICAS) if (/^\d{1,3}(\.\d{3})*,\d+$|^\d+,\d+$/.test(b[c] || '')) b[c] = b[c].replace(/\./g, '').replace(',', '.');
    if (sep === ';' && b.cotizaciones_valores) b.cotizaciones_valores = b.cotizaciones_valores.replace(/(\d),(\d)/g, '$1.$2');
    const { r, errores: e } = limpiarRegistro(b);
    if (r) {
      const k = clave(r);
      if (vistos.has(k)) e.push(`Duplicado de ${vistos.get(k) === 'el catálogo' ? 'un registro del catálogo' : 'la fila ' + vistos.get(k)}`);
      else vistos.set(k, n);
    }
    if (e.length) errores.push({ fila: n, errores: e }); else registros.push(r);
  });
  return { ok: !errores.length && registros.length > 0, registros, errores, total: filas.length - 1, columnas_ignoradas: desconocidas };
}

// ─── Precarga (la de la migración 029, con los materiales de la 030, San Juan de la 032 y Huánuco 2023 de la 033; ids fijos) ──
export const PRECARGA = [
  { id: 'c0a7a10e-0000-4000-8000-000000000001', tipo_documento: 'por_confirmar', entidad: null, region: 'Loreto', anio: 2026, nivel: 'por_confirmar', unidad: 'kit', material: 'madera', monto: 624, monto_hasta: null, incluye_igv: false, cotizaciones: null, composicion: [], confianza: 'media' },
  // Huánuco 2023: cuadro comparativo y estructura preliminar de costos (migración 033)
  { id: 'c0a7a10e-0000-4000-8000-000000000002', tipo_documento: 'estudio_mercado', entidad: 'Gobierno Regional Huánuco', region: 'Huánuco', anio: 2023, nivel: 'Primaria', unidad: 'pieza', material: 'metal-madera',
    monto: 267.5, monto_hasta: null, incluye_igv: true, cotizaciones: { valores: [370, 250, 270, 180], n: 4, promedio: 267.5 }, composicion: [], confianza: 'media',
    notas: 'Cuadro comparativo y estructura preliminar de costos (mar. 2023), «Reposición de mobiliario de aulas del nivel primario … 11 provincias de la región Huánuco»; sin CUI. Promedio de 4 cotizaciones con IGV y transporte incluido (ene. 2023): Mobiliarios Yi 370 (polipropileno), Carpintería Garay 250 (madera tornillo), Mobi Edu 270 (polipropileno), Maderera Burgos 180 (madera). 12,310 piezas × 267.50 = S/ 3,292,925.00 con IGV; con expediente 1.19 %, supervisión 0.9 % y liquidación 0.8 %: S/ 3,388,090.53. No comparable hasta indicar la composición del kit.' },
  { id: 'c0a7a10e-0000-4000-8000-000000000003', tipo_documento: 'por_confirmar', entidad: null, region: 'Huánuco', anio: 2025, nivel: 'por_confirmar', unidad: 'kit', material: 'metal-madera', monto: 455, monto_hasta: 480, incluye_igv: null, cotizaciones: null, composicion: [], confianza: 'media' },
  // San Juan: precio unitario real de la memoria de costos y presupuestos (migración 032; antes, el estimado de la 031)
  { id: 'c0a7a10e-0000-4000-8000-000000000004', tipo_documento: '07-C', cui: '2711098', entidad: 'Gobierno Regional de La Libertad', region: 'La Libertad', anio: 2026, nivel: 'Secundaria', unidad: 'kit', material: 'metal-polipropileno',
    monto: 411.85, monto_hasta: null, incluye_igv: false, flete_transporte: 26.02, cotizaciones: { valores: [], n: 4, promedio: null }, composicion: [], confianza: 'alta',
    componentes: { ejecucion: 739373.42, doc_equivalente: 43144.10, sup_doc_equivalente: 41219.36, sup_ejecucion: 96178.51, total: 919915.39 },
    notas: 'Memoria de costos y presupuestos (dic. 2025): precio del bien sin flete, gastos generales, utilidad ni IGV; promedio de 1,045 kits mesa + silla (rojo 420, verde 420, marrón 205). Flete S/ 13.01 por pieza (S/ 26.02 por kit). Con flete por color: S/ 434.47 / 436.09 / 448.49. Con gastos generales 18.17 % y utilidad 10 %: S/ 561.23 sin IGV.' },

  { id: 'c0a7a10e-0000-4000-8000-000000000005', tipo_documento: 'propio', entidad: null, region: null, anio: 2026, nivel: 'por_confirmar', unidad: 'kit', material: 'por_confirmar', monto: 850, monto_hasta: null, incluye_igv: false, cotizaciones: null, composicion: [], confianza: 'media' }
];
