// ============================================================================
// src/selector-ioarr/documento-equivalente.js — Borrador del documento equivalente
// (expediente técnico de la IOARR de mobiliario), a usar después de la buena pro.
//
// Plantillas: templates/documento_equivalente/ (plan de trabajo y tomos I a III),
// con marcadores {{CAMPO}} declarados en su MANIFEST.json. Cada campo tiene fuente:
//   APP      lo da la app (título, entidad, localización, CUI, metas, normas, lugar
//            de entrega, presupuesto y especificaciones); bloquea si falta.
//   PARCIAL  se prellena y queda marcado «[REVISAR]» hasta que el usuario lo revisa.
//   MANUAL   lo completa la empresa o la entidad; mientras falte, el marcador queda
//            visible y resaltado en amarillo.
// Los «[VERIFICAR en bases]» de la plantilla son texto fijo: no se quitan.
//
// Legajo de cotizaciones (Tomo III): por cotización, proveedor, fecha, vigencia,
// si incluye IGV, plazo de entrega, precio por ítem y PDF. El precio unitario de
// cada ítem es el promedio sin IGV de las cotizaciones vigentes (con IGV ÷ 1,18).
// Presupuesto referencial (2.17): cantidades del 07-C × precio promedio = costo
// directo; + gastos generales y utilidad (porcentajes de la ficha, 0 % si las bases
// no los piden) = subtotal; + IGV = total. No puede superar el monto de ejecución
// del convenio ni el costo de los activos del 07-C.
//
// La oferta (uso interno) no entra: este módulo no la recibe ni la lee.
// El Word lo arma word-documento-equivalente.js; las rutas, documento-equivalente-api.js.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { marcadoresDe, fechaValida, formatoMonto, revisarNeutralidad, precargar as precargarBases } from './bases.js';
import { ESPECIFICACIONES, NORMAS_SUGERIDAS } from './bases-especificaciones.js';
import { BIENES_COTIZACION, MIN_PROVEEDORES } from './cotizaciones.js';

const DIR = new URL('../../templates/documento_equivalente/', import.meta.url);
export const MANIFEST = JSON.parse(readFileSync(new URL('MANIFEST.json', DIR), 'utf8'));
export const IGV_PCT = 18;
export const MIN_COTIZACIONES = MIN_PROVEEDORES;   // 3 por ítem
export const MIN_JUSTIFICACION = 30;               // caracteres de la justificación si hay menos de 3
// Secciones que no se pueden quitar: de ellas dependen las validaciones del presupuesto
export const OBLIGATORIAS = ['2.17', '3.4'];
export const BIENES = BIENES_COTIZACION;

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const txt = (v, max = 500) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const parrafo = (v, max = 4000) => String(v ?? '').replace(/\r/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, max);
const numero = (v, min, max) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const monto = v => { const n = numero(v, 0, 1e10); return n == null ? null : r2(n); };
const entero = (v, min, max) => { const n = numero(v, min, max); return n == null ? null : Math.round(n); };
const vacio = v => v == null || v === '';
const lista = xs => xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' y ' + xs.at(-1);

// ─── Plantillas ─────────────────────────────────────────────────────────────
// «# Tomo», «## [id] Sección»; el texto antes de la primera sección es la introducción del tomo
function leerPlantilla(file) {
  const texto = readFileSync(new URL(file, DIR), 'utf8').replace(/\r/g, '').replace(/^\s*<!--[\s\S]*?-->\s*\n?/, '');
  const lineas = texto.split('\n'), tomo = { file, titulo: '', intro: [], secciones: [] };
  let actual = null;
  for (const l of lineas) {
    const h1 = l.match(/^# (.+)$/), h2 = l.match(/^## \[([A-Z0-9.]+)\] (.+)$/);
    if (h1) { tomo.titulo = h1[1].trim(); continue; }
    if (h2) { actual = { id: h2[1], titulo: h2[2].trim(), lineas: [] }; tomo.secciones.push(actual); continue; }
    (actual ? actual.lineas : tomo.intro).push(l);
  }
  const limpiar = ls => ls.join('\n').replace(/^\n+|\n+$/g, '');
  tomo.intro = limpiar(tomo.intro);
  tomo.secciones = tomo.secciones.map(s => ({ id: s.id, titulo: s.titulo, texto: limpiar(s.lineas) }));
  tomo.id = file.slice(0, 2) === '00' ? 'PT' : ['I', 'II', 'III'][Number(file.slice(0, 2)) - 1];
  return tomo;
}
export const TOMOS = readdirSync(DIR).filter(f => /^\d\d_.*\.md$/.test(f)).sort().map(leerPlantilla);
export const SECCIONES_BASE = TOMOS.flatMap(t => t.secciones.map(s => ({ ...s, tomo: t.id })));
export const HASH_PLANTILLAS = createHash('sha256').update(JSON.stringify(MANIFEST.campos)).update(TOMOS.map(t => JSON.stringify(t)).join('\n')).digest('hex').slice(0, 16);
export const DECLARADOS = new Set(Object.keys(MANIFEST.campos));
export const marcadoresPlantillas = () => [...new Set(TOMOS.flatMap(t => [t.intro, ...t.secciones.map(s => s.texto)]).flatMap(marcadoresDe))];
export const rotuloSeccion = s => /^\d/.test(s.id) ? `${s.id}. ${s.titulo}` : s.titulo;

// Campos que se escriben en la ficha (los de tipo tabla e índice los arma la app)
export const CAMPOS = Object.entries(MANIFEST.campos).filter(([, c]) => !['tabla', 'indice'].includes(c.tipo))
  .map(([k, c]) => ({ k, etiqueta: c.descripcion, fuente: c.fuente, tipo: c.tipo, ayuda: c.ayuda || '' }));
const POR_K = Object.fromEntries(CAMPOS.map(c => [c.k, c]));
export const PARCIALES = CAMPOS.filter(c => c.fuente === 'PARCIAL').map(c => c.k);
export const APP_TEXTO = CAMPOS.filter(c => c.fuente === 'APP').map(c => c.k);
export const etiquetaDe = k => POR_K[k]?.etiqueta || MANIFEST.campos[k]?.descripcion || k;
// Montos y controles de la ficha que no son marcadores de la plantilla
export const CONTROLES = {
  MONTO_CONVENIO_EJECUCION: 'Monto de la ejecución física según el convenio de inversión (S/, con IGV)',
  MONTO_DOC_EQUIVALENTE: 'Documento equivalente (S/)',
  MONTO_SUPERVISION: 'Supervisión: del documento equivalente y de la ejecución (S/)',
  MONTO_TOTAL_DECLARADO: 'Total declarado del presupuesto resumen (S/), opcional',
  GG_PCT: 'Gastos generales (% del costo directo)',
  UTILIDAD_PCT: 'Utilidad (% del costo directo)'
};

// ─── Ficha ──────────────────────────────────────────────────────────────────
function limpiarCotizacion(c) {
  if (!c || typeof c !== 'object') return null;
  const precios = Object.fromEntries(Object.keys(BIENES).map(k => [k, monto(c.precios?.[k])]).filter(([, v]) => v != null && v > 0));
  const x = {
    id: /^[0-9a-f-]{36}$/i.test(String(c.id || '')) ? c.id : randomUUID(),
    proveedor: txt(c.proveedor, 200), ruc: /^\d{11}$/.test(String(c.ruc || '')) ? String(c.ruc) : '',
    fecha: fechaValida(c.fecha) ? c.fecha : null, vigencia_dias: entero(c.vigencia_dias, 1, 3650),
    incluye_igv: c.incluye_igv === true || c.incluye_igv === 'si', plazo_entrega_dias: entero(c.plazo_entrega_dias, 1, 3650),
    precios, archivo_ruta: c.archivo_ruta ? String(c.archivo_ruta).slice(0, 500) : null, archivo_nombre: c.archivo_nombre ? String(c.archivo_nombre).slice(0, 200) : null
  };
  return x;   // una fila recién agregada (vacía) se conserva: recibe su id y luego su PDF
}
export const limpiarCotizaciones = a => (Array.isArray(a) ? a : []).slice(0, 60).map(limpiarCotizacion).filter(Boolean);

function limpiarSecciones(s = {}) {
  const ids = new Set(SECCIONES_BASE.map(x => x.id));
  const quitar = [...new Set((Array.isArray(s.quitar) ? s.quitar : []).filter(id => ids.has(id) && !OBLIGATORIAS.includes(id)))];
  const titulos = Object.fromEntries(Object.entries(s.titulos || {}).filter(([id, t]) => ids.has(id) && txt(t, 200)).map(([id, t]) => [id, txt(t, 200)]));
  const extras = (Array.isArray(s.extras) ? s.extras : []).slice(0, 30).map(e => ({
    id: /^X[0-9a-f]{8}$/.test(String(e?.id || '')) ? e.id : 'X' + randomUUID().slice(0, 8),
    tomo: ['PT', 'I', 'II', 'III'].includes(e?.tomo) ? e.tomo : 'II', titulo: txt(e?.titulo, 200), texto: parrafo(e?.texto)
  })).filter(e => e.titulo);
  return { quitar, titulos, extras };
}

/** Ficha válida: lo desconocido se descarta */
export function limpiarFicha(b = {}) {
  const d = {};
  for (const c of CAMPOS) d[c.k] = c.tipo === 'dias' ? entero(b[c.k], 1, 3650) : c.tipo === 'parrafo' ? (parrafo(b[c.k]) || null) : (txt(b[c.k]) || null);
  for (const k of ['MONTO_CONVENIO_EJECUCION', 'MONTO_DOC_EQUIVALENTE', 'MONTO_SUPERVISION', 'MONTO_TOTAL_DECLARADO']) d[k] = monto(b[k]);
  d.GG_PCT = numero(b.GG_PCT, 0, 100) ?? 0;
  d.UTILIDAD_PCT = numero(b.UTILIDAD_PCT, 0, 100) ?? 0;
  d.normas_verificadas = b.normas_verificadas === true;
  d.revisados = Object.fromEntries(PARCIALES.filter(k => b.revisados?.[k] === true).map(k => [k, true]));
  d.cantidades = Object.fromEntries(Object.keys(BIENES).map(k => [k, entero(b.cantidades?.[k], 0, 1e7)]).filter(([, v]) => v != null));
  d.justificaciones = Object.fromEntries(Object.keys(BIENES).map(k => [k, parrafo(b.justificaciones?.[k], 2000)]).filter(([, v]) => v));
  d.especificaciones = Object.fromEntries(Object.keys(ESPECIFICACIONES).map(k => [k, parrafo(b.especificaciones?.[k], 3000)]).filter(([, v]) => v));
  d.cotizaciones = limpiarCotizaciones(b.cotizaciones);
  d.secciones = limpiarSecciones(b.secciones);
  d.bases_origen = txt(b.bases_origen, 300) || null;
  d.N_PROCESO = txt(b.N_PROCESO, 120) || null;
  d._precarga = b._precarga && typeof b._precarga === 'object' ? b._precarga : {};
  d._precarga_notas = b._precarga_notas && typeof b._precarga_notas === 'object' ? b._precarga_notas : {};
  return d;
}

// ─── Cotizaciones y presupuesto ─────────────────────────────────────────────
const sumarDias = (f, n) => { const [a, m, d] = f.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10); };
/** Vence: fecha + vigencia (días). Sin fecha o sin vigencia no se puede saber: no es vigente */
export const venceDe = c => c.fecha && c.vigencia_dias ? sumarDias(c.fecha, c.vigencia_dias) : null;
export const esVigente = (c, hoy) => { const v = venceDe(c); return !!v && v >= hoy; };
/** Precio sin IGV de una cotización para un ítem (normalizado si la cotización incluye IGV) */
export const precioSinIgv = (c, k, igv = IGV_PCT) => { const p = c.precios?.[k]; return p == null ? null : c.incluye_igv ? r2(p / (1 + igv / 100)) : p; };

/**
 * Promedio de un ítem: solo cotizaciones vigentes a la fecha (hoy, AAAA-MM-DD).
 * @returns { k, filas, vigentes, proveedores, sin_igv, con_igv, min, max }
 */
export function promedioItem(cotizaciones, k, { hoy, igv = IGV_PCT } = {}) {
  const filas = cotizaciones.filter(c => c.precios?.[k] != null).map(c => ({
    id: c.id, proveedor: c.proveedor, original: c.precios[k], incluye_igv: c.incluye_igv, sin: precioSinIgv(c, k, igv),
    con: c.incluye_igv ? c.precios[k] : r2(c.precios[k] * (1 + igv / 100)), vigente: esVigente(c, hoy), vence: venceDe(c)
  }));
  const vig = filas.filter(f => f.vigente);
  const sin = vig.length ? r2(vig.reduce((a, f) => a + f.sin, 0) / vig.length) : null;
  return { k, filas, vigentes: vig.length, proveedores: new Set(vig.map(f => f.proveedor.toLowerCase()).filter(Boolean)).size,
    sin_igv: sin, con_igv: sin == null ? null : r2(sin * (1 + igv / 100)),
    min: vig.length ? Math.min(...vig.map(f => f.sin)) : null, max: vig.length ? Math.max(...vig.map(f => f.sin)) : null };
}

/**
 * Presupuesto referencial (2.17) y resumen (1.9).
 * ctx.metas: [{ k, nombre, unidad, cantidad }] del 07-C. Cantidad: la de la ficha o, si no hay, la del 07-C.
 */
export function presupuesto(d, ctx = {}, { hoy } = {}) {
  const igv = ctx.igv ?? IGV_PCT;
  const items = (ctx.metas || []).map(m => {
    const P = promedioItem(d.cotizaciones || [], m.k, { hoy, igv });
    const cantidad = d.cantidades?.[m.k] ?? m.cantidad;
    return { k: m.k, nombre: m.nombre, unidad: m.unidad, cantidad, cantidad_07c: m.cantidad, pu: P.sin_igv, parcial: P.sin_igv == null || cantidad == null ? null : r2(cantidad * P.sin_igv), promedio: P };
  });
  const completo = items.length > 0 && items.every(x => x.parcial != null);
  const cd = completo ? r2(items.reduce((a, x) => a + x.parcial, 0)) : null;
  const gg = cd == null ? null : r2(cd * (d.GG_PCT || 0) / 100), ut = cd == null ? null : r2(cd * (d.UTILIDAD_PCT || 0) / 100);
  const subtotal = cd == null ? null : r2(cd + gg + ut), igvMonto = subtotal == null ? null : r2(subtotal * igv / 100);
  const total = subtotal == null ? null : r2(subtotal + igvMonto);
  const resumen = { ejecucion: total, doc: d.MONTO_DOC_EQUIVALENTE, supervision: d.MONTO_SUPERVISION };
  resumen.total = [resumen.ejecucion, resumen.doc, resumen.supervision].some(v => v == null) ? null : r2(resumen.ejecucion + resumen.doc + resumen.supervision);
  return { items, completo, cd, gg, ut, subtotal, igv: igvMonto, igv_pct: igv, gg_pct: d.GG_PCT || 0, ut_pct: d.UTILIDAD_PCT || 0, total, resumen };
}

/** Comprobación de sumas (con un margen de 1 céntimo por redondeo) */
export function cuadraPresupuesto(P) {
  const e = [], dif = (a, b) => Math.abs(a - b) > 0.011;
  if (P.cd == null) return e;
  if (dif(P.items.reduce((a, x) => a + x.parcial, 0), P.cd)) e.push('Los parciales por ítem no suman el costo directo.');
  if (dif(P.cd + P.gg + P.ut, P.subtotal)) e.push('Costo directo + gastos generales + utilidad no suma el subtotal.');
  if (dif(P.subtotal + P.igv, P.total)) e.push('Subtotal + IGV no suma el total.');
  const R = P.resumen;
  if (R.total != null && dif(R.ejecucion + R.doc + R.supervision, R.total)) e.push('Los componentes del presupuesto resumen no suman su total.');
  return e;
}

/** Comparación del kit con el catálogo de precios referenciales (precio por kit sin IGV) */
export function comparacionCatalogo(P, ref) {
  const kit = P.items.find(x => x.k === 'kit');
  if (!kit || kit.pu == null || ref?.precio == null) return null;
  return { k: 'kit', promedio: kit.pu, catalogo: ref.precio, n: ref.n ?? null, dif_pct: Math.round((kit.pu - ref.precio) / ref.precio * 1000) / 10 };
}

// ─── Validación ─────────────────────────────────────────────────────────────
/**
 * Errores (bloquean la exportación) y advertencias.
 * ctx: contexto de la app (metas del 07-C, total de activos, colegios, precio del catálogo)
 */
export function validarFicha(d, ctx = {}, { hoy } = {}) {
  const errores = [], advertencias = [];
  const err = (k, texto) => errores.push({ k, texto }), adv = (k, texto) => advertencias.push({ k, texto });
  // Campos APP
  for (const k of APP_TEXTO) if (vacio(d[k])) err(k, `Falta un dato que da la app: ${etiquetaDe(k)}.`);
  if (d.CUI && !/^\d{5,8}$/.test(d.CUI)) err('CUI', 'El CUI debe tener solo dígitos (5 a 8).');
  if (d.NORMAS_TECNICAS && !d.normas_verificadas) err('normas_verificadas', 'Confirma que las normas técnicas están vigentes y aplican a este nivel.');
  if (!(ctx.metas || []).length) err('metas', 'La IOARR no tiene metas en el Formato 07-C: revisa los costos del expediente.');
  if (!(ctx.locales || []).length) err('locales', 'No hay colegios para el lugar de entrega (2.9).');
  if (d.MONTO_DOC_EQUIVALENTE == null) err('MONTO_DOC_EQUIVALENTE', `Falta: ${CONTROLES.MONTO_DOC_EQUIVALENTE}.`);
  if (d.MONTO_SUPERVISION == null) err('MONTO_SUPERVISION', `Falta: ${CONTROLES.MONTO_SUPERVISION}.`);
  for (const m of ctx.metas || []) {
    const e = d.especificaciones?.[m.k] || ESPECIFICACIONES[m.k]?.texto;
    if (!e) err('especificaciones', `Falta la especificación técnica de ${m.nombre}.`);
    else if (revisarNeutralidad(e).prohibido.length) err('especificaciones', `${m.nombre}: la especificación nombra marcas o fabricantes (${revisarNeutralidad(e).prohibido.join(', ')}).`);
  }
  // Cantidades iguales al 07-C
  for (const m of ctx.metas || []) {
    const c = d.cantidades?.[m.k];
    if (c != null && c !== m.cantidad) err('cantidades', `${m.nombre}: la cantidad (${c}) no es la del Formato 07-C (${m.cantidad}).`);
  }
  for (const k of Object.keys(d.cantidades || {})) if (!(ctx.metas || []).some(m => m.k === k)) err('cantidades', `${BIENES[k]}: no es una meta del Formato 07-C.`);
  // Cotizaciones: al menos 3 vigentes por ítem (proveedores distintos) o justificación escrita
  const P = presupuesto(d, ctx, { hoy });
  for (const x of P.items) {
    const q = x.promedio, just = (d.justificaciones?.[x.k] || '').trim();
    if (q.vigentes === 0) err('cotizaciones', `${x.nombre}: no hay cotizaciones vigentes con precio; sin ellas no se calcula el precio unitario.`);
    else if (q.proveedores < MIN_COTIZACIONES && just.length < MIN_JUSTIFICACION)
      err('justificaciones', `${x.nombre}: ${q.proveedores} ${q.proveedores === 1 ? 'proveedor vigente' : 'proveedores vigentes'}; se piden ${MIN_COTIZACIONES} o una justificación escrita (al menos ${MIN_JUSTIFICACION} caracteres).`);
    for (const f of q.filas.filter(f => !f.vigente)) adv('cotizaciones', `${x.nombre} · ${f.proveedor || 'sin proveedor'}: ${f.vence ? `venció el ${f.vence}` : 'sin fecha o sin vigencia'}; no entra al promedio.`);
  }
  const nombres = cs => lista(cs.map(c => c.proveedor || 'sin proveedor'));
  const sinPdf = (d.cotizaciones || []).filter(c => !c.archivo_ruta), sinPlazo = (d.cotizaciones || []).filter(c => !c.plazo_entrega_dias);
  if (sinPdf.length) adv('cotizaciones', `Falta el PDF de la cotización firmada: ${nombres(sinPdf)}.`);
  if (sinPlazo.length) adv('cotizaciones', `Falta el plazo de entrega (3.2): ${nombres(sinPlazo)}.`);
  // Sumas y topes
  for (const t of cuadraPresupuesto(P)) err('presupuesto', t);
  if (d.MONTO_TOTAL_DECLARADO != null && P.resumen.total != null && Math.abs(d.MONTO_TOTAL_DECLARADO - P.resumen.total) > 0.011)
    err('MONTO_TOTAL_DECLARADO', `La suma de los componentes (S/ ${formatoMonto(P.resumen.total)}) no es el total declarado (S/ ${formatoMonto(d.MONTO_TOTAL_DECLARADO)}).`);
  if (d.MONTO_CONVENIO_EJECUCION == null) err('MONTO_CONVENIO_EJECUCION', `Falta: ${CONTROLES.MONTO_CONVENIO_EJECUCION}; sin él no se puede comprobar el tope.`);
  else if (P.total != null && P.total > d.MONTO_CONVENIO_EJECUCION + 0.005)
    err('MONTO_CONVENIO_EJECUCION', `El presupuesto referencial (S/ ${formatoMonto(P.total)}) supera el monto de ejecución del convenio (S/ ${formatoMonto(d.MONTO_CONVENIO_EJECUCION)}).`);
  if (P.total != null && ctx.total_activos != null && P.total > ctx.total_activos + 0.005)
    err('presupuesto', `El presupuesto referencial (S/ ${formatoMonto(P.total)}) supera el costo de los activos del Formato 07-C (S/ ${formatoMonto(ctx.total_activos)}).`);
  // Advertencias
  const sinRevisar = PARCIALES.filter(k => !vacio(d[k]) && !d.revisados?.[k]);
  if (sinRevisar.length) adv('revisar', `${sinRevisar.length} ${sinRevisar.length === 1 ? 'texto prellenado sale' : 'textos prellenados salen'} con «[REVISAR]» hasta que marques «Revisado»: ${sinRevisar.map(etiquetaDe).join('; ')}.`);
  const manualFalta = CAMPOS.filter(c => c.fuente !== 'APP' && vacio(d[c.k]) && seccionIncluida(d, c.k)).map(c => c.etiqueta);
  if (manualFalta.length) adv('manual', `Quedan ${manualFalta.length} datos por completar (salen resaltados en amarillo): ${manualFalta.slice(0, 6).join('; ')}${manualFalta.length > 6 ? '…' : ''}.`);
  const cmp = comparacionCatalogo(P, ctx.precio_ref);
  if (cmp && Math.abs(cmp.dif_pct) >= 20) adv('catalogo', `El precio promedio del kit (S/ ${formatoMonto(cmp.promedio)} sin IGV) está ${cmp.dif_pct > 0 ? 'por encima' : 'por debajo'} del catálogo de precios referenciales en ${Math.abs(cmp.dif_pct)} %.`);
  if (!d.bases_origen) adv('bases_origen', 'Registra de qué bases proviene el contenido mínimo (proceso y numeral).');
  return { ok: !errores.length, errores, advertencias, presupuesto: P, catalogo: cmp };
}

// ─── Secciones del documento ────────────────────────────────────────────────
/** Secciones finales por tomo: sin las quitadas, con los títulos editados y las secciones agregadas al final de su tomo */
export function seccionesDe(d) {
  const S = d.secciones || { quitar: [], titulos: {}, extras: [] };
  return TOMOS.map(t => ({
    id: t.id, titulo: t.titulo, intro: t.intro,
    secciones: [
      ...t.secciones.filter(s => !S.quitar.includes(s.id)).map(s => ({ ...s, titulo: S.titulos[s.id] || s.titulo })),
      ...S.extras.filter(e => e.tomo === t.id).map(e => ({ id: e.id, titulo: e.titulo, texto: e.texto || `[COMPLETAR: ${e.titulo}]`, extra: true }))
    ]
  }));
}
function seccionIncluida(d, k) {
  const quitar = d.secciones?.quitar || [];
  const en = SECCIONES_BASE.filter(s => s.texto.includes(`{{${k}}}`)).map(s => s.id);
  return !en.length || en.some(id => !quitar.includes(id));
}

/**
 * Valores de los marcadores de texto. Los PARCIALES sin revisar llevan «[REVISAR]».
 * Las tablas y el índice no están aquí: los arma el Word (tablas = null).
 */
export function valoresMarcadores(d) {
  const v = {};
  for (const c of CAMPOS) {
    const x = d[c.k];
    if (vacio(x)) continue;
    v[c.k] = String(x) + (c.fuente === 'PARCIAL' && !d.revisados?.[c.k] ? ' [REVISAR]' : '');
  }
  return v;
}

/** Texto de cada sección con los marcadores de texto sustituidos; lo que falta queda visible */
export function armarTexto(d) {
  const valores = valoresMarcadores(d), faltan = new Set();
  const sust = t => t.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
    const c = MANIFEST.campos[k];
    if (c && ['tabla', 'indice'].includes(c.tipo)) return m;   // la tabla la pone el Word
    if (valores[k] == null) { faltan.add(k); return m; }
    return valores[k];
  });
  const tomos = seccionesDe(d).map(t => ({ ...t, intro: sust(t.intro), secciones: t.secciones.map(s => ({ ...s, texto: sust(s.texto) })) }));
  return { tomos, faltan: [...faltan], valores };
}

// ─── Precarga desde la app ──────────────────────────────────────────────────
/**
 * Lo que la app ya conoce. M: modelo del expediente (documentos.js); ctx: contextoDe();
 * bases: ficha de bases del mismo nivel (si hay); radar y gore: como en las bases.
 * @returns { datos, notas } notas = de dónde sale cada valor
 */
export function precargar({ M = null, ctx = {}, bases = null, radar = null, gore = null, datosDoc = {} }) {
  const datos = {}, notas = {};
  const poner = (k, v, nota) => { if (!vacio(v) && vacio(datos[k])) { datos[k] = v; notas[k] = nota; } };
  const B = bases || {};
  // De la ficha de bases del mismo nivel (lo que el usuario ya revisó ahí)
  poner('NOMBRE_IOARR', B.NOMBRE_IOARR, 'Ficha de bases del mismo nivel.');
  poner('CUI', B.CUI, 'Ficha de bases del mismo nivel.');
  poner('ENTIDAD', B.ENTIDAD, 'Ficha de bases del mismo nivel.');
  poner('PLAZO_EJECUCION_DIAS', B.PLAZO_EJECUCION_DIAS, 'Ficha de bases del mismo nivel.');
  poner('NORMAS_TECNICAS', B.normas_tecnicas, 'Ficha de bases del mismo nivel.');
  poner('N_PROCESO', B.N_PROCESO, 'Ficha de bases del mismo nivel.');
  if (B.N_PROCESO) poner('bases_origen', `Bases del Proceso de Selección N° ${B.N_PROCESO}`, 'Ficha de bases del mismo nivel.');
  poner('MONTO_DOC_EQUIVALENTE', B.MONTO_DOC_EQUIVALENTE, 'Ficha de bases del mismo nivel (Prestación 1).');
  if (B.MONTO_SUP_DOC_EQUIVALENTE != null && B.MONTO_SUP_EJECUCION != null)
    poner('MONTO_SUPERVISION', r2(B.MONTO_SUP_DOC_EQUIVALENTE + B.MONTO_SUP_EJECUCION), 'Ficha de bases del mismo nivel (Prestación 3: las dos supervisiones).');
  // Del expediente (lo mismo que precargan las bases: nombre, CUI, entidad, montos)
  const pb = precargarBases({ M, radar, datosDoc, gore });
  for (const k of ['NOMBRE_IOARR', 'CUI', 'ENTIDAD', 'PLAZO_EJECUCION_DIAS', 'MONTO_DOC_EQUIVALENTE']) poner(k, pb.datos[k], pb.notas[k]);
  poner('MONTO_SUPERVISION', M?.F?.supervision || null, 'Supervisión de la estructura de costos del expediente.');
  poner('NORMAS_TECNICAS', NORMAS_SUGERIDAS.join('; '), 'Normas sugeridas por la app: confirma cuáles aplican y si están vigentes.');
  poner('NIVEL', ctx.nivel_nombre, 'Nivel de la IOARR.');
  const L = ctx.locales || [];
  const dists = [...new Set(L.map(u => `${u.dist} (${u.prov})`))];
  if (L.length) poner('LOCALIZACION', `Departamento de ${L[0].dpto}; ${dists.length === 1 ? 'distrito de' : 'distritos de'} ${lista(dists)}`, 'Ubicación de los colegios de la IOARR (padrón).');
  // PARCIALES: base para revisar (texto de la plantilla y datos del expediente)
  const ie = L.length === 1 ? `la I.E. ${L[0].nombre}` : `${L.length} instituciones educativas`;
  if (L.length && ctx.nivel_nombre) poner('BREVE_DESCRIPCION', `Reposición de mobiliario de aula del nivel ${ctx.nivel_nombre.toLowerCase()} en ${ie}.`, 'Plantilla, con el nivel y los colegios de la IOARR.');
  poner('OBJETIVOS', 'Mejorar la calidad del servicio educativo con mobiliario adecuado.', 'Texto de la plantilla.');
  poner('OBJETIVO_PRINCIPAL', M?.memoria?.objetivo, 'Objetivo de la memoria del expediente (Documentos).');
  if (L.length) poner('CONDICIONES_AMBIENTALES', `Colegios ubicados en ${lista(dists.map(x => 'el distrito de ' + x))}, departamento de ${L[0].dpto}`
    + `${L.some(u => u.rural) ? `; ${L.filter(u => u.rural).length} de ${L.length} en zona rural` : ''}. Región natural, altitud y clima: [COMPLETAR].`, 'Ubicación de los colegios (padrón); falta la región natural, la altitud y el clima.');
  poner('CRONOGRAMA_ENTREGABLES', 'Plan de trabajo a los 3 días calendario del inicio del plazo; entregables parciales y versión final del documento equivalente.', 'Texto de la plantilla.');
  poner('SUSTENTO_TECNICO', 'Fichas técnicas, ensayos y certificados del proveedor que acrediten el cumplimiento de las especificaciones técnicas (2.21) y de las normas técnicas (2.4).', 'Texto de la plantilla.');
  poner('CRONOGRAMA_EJECUCION', `Fabricación, control de calidad, transporte y entrega${datos.PLAZO_EJECUCION_DIAS ? `, dentro del plazo de ejecución de ${datos.PLAZO_EJECUCION_DIAS} días calendario` : ''}.`, 'Texto de la plantilla.');
  poner('CRITERIOS_COSTOS', 'Precio unitario: promedio de las cotizaciones vigentes del legajo (3.4), sin IGV (las que lo incluyen se dividen entre 1,18). Cantidades: las del Formato 07-C aprobado, sin cambios. El precio del kit se compara con el catálogo de precios referenciales de IOARR publicadas.', 'Reglas de cálculo de la plantilla.');
  return { datos, notas };
}

/** Lo del cálculo de la app que entra al documento (se guarda con cada versión) */
export function contextoDe(M, nivel, nombreNivel, precioRef = null) {
  return {
    nivel, nivel_nombre: nombreNivel, igv: M?.estructura?.params?.igv ?? IGV_PCT,
    metas: (M?.F?.metas || []).map(m => ({ k: m.k, nombre: m.nombre, unidad: m.unidad, cantidad: m.cantidad, costo: m.costo })),
    total_activos: M?.F?.subtotalActivos ?? null, total_07c: M?.F?.total ?? null,
    locales: (M?.ups || []).map(u => ({ cod: u.cod, nombre: u.nombre, direccion: u.direccion || '', dist: u.dist, prov: u.prov, dpto: u.dpto, cp: u.cp || '', rural: !!u.rural, ugel: u.ugel || '' })),
    precio_ref: precioRef ? { precio: precioRef.precio ?? null, n: precioRef.n ?? null, modo: precioRef.modo || null } : null,
    borrador: !!(M?.borrador && M?.bloqueados?.length)
  };
}
