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
//   - Los registros «histórico» se muestran, pero no entran a los estadísticos ni a Costos.
//   - Más de 10,000 kits = «atípico por volumen»: fuera de la mediana salvo que se pida
//     incluirlos. Si el volumen difiere más de 5 veces del expediente, se avisa.
//   - Factor de actualización por año de origen → año base (2025): 1.00 si no se registró
//     otro; no se inventan índices. Factor 1.00 con otro año = «sin ajuste de precios».
//   - Referencia por defecto de Metal/Madera: Huicungo 2026 (REFERENCIA_DEFECTO).
//
// Tablas y precarga: supabase/migrations/029_ioarr_catalogo_precios_ref.sql (y 030 a 037)
// Rutas: catalogo-ref-api.js
// ============================================================================

import { descuadre, soles } from './montos.js';

export const IGV = 18;
export const TIPOS_DOC = { '07-C': 'Formato 07-C', bases: 'Bases', estudio_mercado: 'Estudio de mercado', estimado_derivado: 'Estimado derivado (de los montos de un 07-C)',
  propio: 'Precio propio (uso interno)', por_confirmar: 'Por confirmar' };
// Componentes del monto total de una IOARR (07-C o bases): deben sumar exactamente el total declarado
export const COMPONENTES = { ejecucion: 'Ejecución física', doc_equivalente: 'Documento equivalente', sup_doc_equivalente: 'Supervisión del documento equivalente', sup_ejecucion: 'Supervisión de la ejecución física' };
// Si el documento da la supervisión en un solo monto (sin separar), va aquí en lugar de las dos de arriba
export const SUPERVISION_JUNTA = { supervision: 'Supervisión (un solo monto)' };
export const NIVELES = { Inicial: 'Inicial', Primaria: 'Primaria', Secundaria: 'Secundaria', por_confirmar: 'Por confirmar' };
export const UNIDADES = { kit: 'Kit (mesa + silla)', mesa: 'Mesa', silla: 'Silla', carpeta: 'Carpeta', armario: 'Armario', transporte: 'Transporte (por pieza)', pieza: 'Pieza de mobiliario (sin especificar)', otro: 'Otro' };
// Grado (grupo de tallas) de mesa y silla; vacío = sin grado
export const GRADOS = { '1-2': '1.° y 2.°', '3-4': '3.° y 4.°', '5-6': '5.° y 6.°' };
// Talla de Costos (calculo.js) de cada nivel y grado. Secundaria tiene solo 5.°: «5-6» es su 5.°
export const TALLA_DE = { Primaria: { '1-2': 'p12', '3-4': 'p34', '5-6': 'p56' }, Secundaria: { '1-2': 's12', '3-4': 's34', '5-6': 's5' } };
export const ESTADOS = { vigente: 'Vigente', historico: 'Histórico' };
export const TIPOS_FUENTE = { publicado: 'Publicado', derivado: 'Derivado', propio: 'Propio (uso interno)' };
export const UMBRAL_ATIPICO = 10000;    // kits: más que esto es atípico por volumen
export const RATIO_VOLUMEN = 5;         // veces: más que esto frente al expediente, no comparable por volumen
export const ANIO_BASE = 2025;
// Fuente (etiqueta «fuente») que es la referencia por defecto de un material
export const REFERENCIA_DEFECTO = { 'metal-madera': 'Huicungo 2026' };
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
const bool = v => v === true || v === false ? v : v == null || v === '' || /^por[ _]confirmar$/i.test(String(v).trim()) ? null
  : /^(si|sí|true|1|con|con igv|incluye)$/i.test(String(v).trim()) ? true : /^(no|false|0|sin|sin igv|no incluye)$/i.test(String(v).trim()) ? false : undefined;
const sinTilde = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** El registro es el precio propio (uso interno) */
export const esPropio = r => r.tipo === 'propio' || r.tipo_documento === 'propio';

/**
 * Valida y limpia un registro (formulario o fila de CSV).
 * @returns { r, errores: [texto] } r es null si hay errores
 */
export function limpiarRegistro(b = {}) {
  b = b || {};
  const errores = [], err = t => errores.push(t);
  const enumDe = (v, E, nombre, req = true) => { const s = texto(v); if (!s) { if (req) err(`Falta ${nombre}`); return null; } if (!(s in E)) { err(`${nombre} no válido: «${s}» (${Object.keys(E).join(', ')})`); return null; } return s; };
  const r = {};
  // Tipo (publicado, derivado, propio) y tipo de documento: el propio va con los dos.
  // Sin tipo de documento: «por confirmar» (o «propio» si el tipo lo es)
  const tipoDado = enumDe(b.tipo, TIPOS_FUENTE, 'tipo', false);
  r.tipo_documento = texto(b.tipo_documento) ? enumDe(b.tipo_documento, TIPOS_DOC, 'tipo de documento') : tipoDado === 'propio' ? 'propio' : 'por_confirmar';
  if (tipoDado && r.tipo_documento && (tipoDado === 'propio') !== (r.tipo_documento === 'propio')) err('El tipo «propio» va con el tipo de documento «Precio propio» (y al revés)');
  r.tipo = tipoDado || (r.tipo_documento === 'propio' ? 'propio' : r.tipo_documento === 'estimado_derivado' ? 'derivado' : 'publicado');
  r.fuente = texto(b.fuente, 120) || null;
  r.cui = texto(b.cui, 10) || null;
  if (r.cui && !/^\d{5,8}$/.test(r.cui)) err('El CUI debe tener solo dígitos (5 a 8)');
  r.entidad = texto(b.entidad, 200) || null;
  r.region = texto(b.region, 60) || null;
  if (!r.region && r.tipo !== 'propio') err('Falta la región');
  const anio = numero(b.anio);
  if (anio == null) err('Falta el año'); else if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) err('Año no válido');
  r.anio = Number.isInteger(anio) ? anio : null;
  r.url = texto(b.url, 500) || null;
  if (r.url && !/^https?:\/\/\S+$/i.test(r.url)) err('El enlace debe empezar con http:// o https://');
  // Nivel vacío = por confirmar (como el IGV)
  r.nivel = texto(b.nivel) ? enumDe(b.nivel, NIVELES, 'nivel') : 'por_confirmar';
  r.grado = enumDe(b.grado, GRADOS, 'grado', false);
  if (r.grado && r.nivel && !TALLA_DE[r.nivel]) err(`El grado solo va con Primaria o Secundaria (el nivel es ${NIVELES[r.nivel].toLowerCase()})`);
  r.unidad = enumDe(b.unidad, UNIDADES, 'unidad');
  if (r.grado && r.unidad && !['mesa', 'silla', 'carpeta', 'kit'].includes(r.unidad)) err('El grado solo va con mesa, silla, carpeta o kit');
  r.material = enumDe(b.material, MATERIALES, 'material');
  const vol = numero(b.volumen_kits);
  if (vol != null && (!Number.isInteger(vol) || vol < 1 || vol > 1e7)) err('Volumen de kits no válido (un entero mayor que 0)');
  r.volumen_kits = Number.isInteger(vol) && vol >= 1 && vol <= 1e7 ? vol : null;
  const ap = numero(b.anio_precio);
  if (ap != null && (!Number.isInteger(ap) || ap < 2000 || ap > 2100)) err('Año del precio no válido');
  r.anio_precio = Number.isInteger(ap) && ap >= 2000 && ap <= 2100 ? ap : null;
  const est = sinTilde(texto(b.estado)).toLowerCase();
  if (est && !(est in ESTADOS)) err(`estado no válido: «${texto(b.estado)}» (vigente, histórico)`);
  r.estado = est in ESTADOS ? est : 'vigente';
  // Componentes del total (07-C o bases): opcionales, pero si se dan deben sumar exactamente el total
  r.componentes = null;
  const cb = b.componentes && typeof b.componentes === 'object' ? b.componentes : null;
  const dado = k => cb[k] !== '' && cb[k] != null;
  if (cb && [...Object.keys(COMPONENTES), 'supervision', 'total'].some(dado)) {
    // La supervisión va separada (documento equivalente y ejecución) o en un solo monto
    const junta = dado('supervision');
    if (junta && (dado('sup_doc_equivalente') || dado('sup_ejecucion'))) err('Componentes: indica la supervisión separada o en un solo monto, no las dos');
    const partes = Object.entries({ ...COMPONENTES, ...SUPERVISION_JUNTA }).filter(([k]) => junta ? !k.startsWith('sup_') : k !== 'supervision');
    const c = {};
    for (const [k, et] of [...partes, ['total', 'Total declarado']]) {
      const v = numero(cb[k]);
      if (v == null) err(`Componentes: falta «${et}»`); else if (Number.isNaN(v) || v < 0 || v > 1e11) err(`Componentes: «${et}» no válido`); else c[k] = r2(v);
    }
    if (Object.keys(c).length === partes.length + 1) {
      const d = descuadre(Object.fromEntries(partes.map(([k, et]) => [et, c[k]])), c.total);
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
 * @returns { base, precio_sin_igv, precio_kit_sin_igv, comparable, motivo, propio, historico, atipico }
 *   base: el monto (o el punto medio del rango) en la condición de IGV declarada
 */
export function normalizar(r) {
  const propio = esPropio(r), historico = r.estado === 'historico', atipico = (r.volumen_kits ?? 0) > UMBRAL_ATIPICO;
  const base = r.monto_hasta != null ? r2((r.monto + r.monto_hasta) / 2) : r.monto;
  const out = { base, precio_sin_igv: null, precio_kit_sin_igv: null, comparable: false, motivo: null, propio, historico, atipico };
  if (r.incluye_igv == null) { out.motivo = 'No se sabe si el monto incluye IGV: no se calcula el precio sin IGV'; return out; }
  const aSinIgv = v => r.incluye_igv ? sinIgv(v) : r2(v);
  out.precio_sin_igv = aSinIgv(base);
  if (r.monto_alternativo != null) out.precio_alternativo_sin_igv = aSinIgv(r.monto_alternativo);
  if (r.unidad === 'kit') { out.precio_kit_sin_igv = out.precio_sin_igv; out.comparable = true; return out; }
  if (r.unidad === 'transporte') { out.motivo = 'Transporte por pieza: se compara aparte, no es un precio de kit'; return out; }
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

// ─── Opciones de comparación: factores, año base y atípicos ─────────────────
/**
 * factores: filas de ioarr_factores_actualizacion { anio_origen, anio_base, factor, fuente_indice, fecha }
 * comparar: «Comparar a año base» (por defecto sí); atipicos: incluir los de más de 10,000 kits (por defecto no)
 */
export const opcionesDe = (o = {}) => ({ factores: Array.isArray(o.factores) ? o.factores : [], anioBase: Number.isInteger(o.anioBase) ? o.anioBase : ANIO_BASE,
  comparar: o.comparar !== false, atipicos: o.atipicos === true });
/** Factor del año de origen al año base: el registrado o 1.00 */
export function factorDe(anioOrigen, factores = [], anioBase = ANIO_BASE) {
  const f = factores.find(y => Number(y.anio_origen) === anioOrigen && Number(y.anio_base) === anioBase);
  return { factor: f ? Number(f.factor) : 1, fuente: f?.fuente_indice || null, fecha: f?.fecha || null, registrado: !!f };
}
/** Precio original, factor y precio actualizado; precio_cmp es el que se compara (actualizado si se compara al año base) */
export function actualizar(x, opciones = {}) {
  const O = opcionesDe(opciones), anio = x.anio_precio ?? x.anio, F = factorDe(anio, O.factores, O.anioBase);
  const act = v => v == null ? null : r2(v * F.factor);
  const sin_ajuste = F.factor === 1 && anio !== O.anioBase;
  return { anio_origen: anio, anio_base: O.anioBase, factor: F.factor, factor_fuente: F.fuente, factor_fecha: F.fecha, sin_ajuste,
    precio_actualizado: act(x.precio_kit_sin_igv), precio_unit_actualizado: act(x.precio_sin_igv),
    precio_cmp: O.comparar ? act(x.precio_kit_sin_igv) : x.precio_kit_sin_igv, precio_unit_cmp: O.comparar ? act(x.precio_sin_igv) : x.precio_sin_igv };
}
/** Por qué un registro no entra a los estadísticos (null si entra) */
export function exclusion(x, opciones = {}) {
  if (x.propio) return 'Precio propio (uso interno)';
  if (x.historico) return 'Histórico: se muestra, pero no entra a los estadísticos';
  if (x.atipico && !opcionesDe(opciones).atipicos) return `Atípico por volumen (más de ${UMBRAL_ATIPICO.toLocaleString('es-PE')} kits): fuera de la mediana`;
  return null;
}
/** Cada registro con su normalización, su actualización y su exclusión */
export const enriquecer = (registros, opciones = {}) => registros.map(r => {
  const x = { ...r, ...normalizar(r) };
  return { ...x, ...actualizar(x, opciones), excluido: exclusion(x, opciones) };
});
/** Volumen del registro frente al del expediente: aviso si difiere más de 5 veces */
export function avisoVolumen(x, kits) {
  if (!x.volumen_kits || !kits) return null;
  const ratio = Math.max(x.volumen_kits, kits) / Math.min(x.volumen_kits, kits);
  return ratio > RATIO_VOLUMEN ? `No comparable por volumen: ${describir(x)} (${x.volumen_kits.toLocaleString('es-PE')} kits frente a ${kits.toLocaleString('es-PE')} del expediente, ${Math.round(ratio * 10) / 10} veces).` : null;
}

// ─── Estadísticos ───────────────────────────────────────────────────────────
export function mediana(xs) {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : r2((s[n / 2 - 1] + s[n / 2]) / 2);
}
const resumen = xs => ({ n: xs.length, min: xs.length ? Math.min(...xs) : null, mediana: mediana(xs), max: xs.length ? Math.max(...xs) : null });
/** Comparables, sin el precio propio, los históricos ni (por defecto) los atípicos por volumen */
export const comparables = (registros, opciones = {}) => enriquecer(registros, opciones).filter(x => x.comparable && !x.excluido);
/** Mínimo, mediana, máximo y cantidad de fuentes por material y nivel (sin el precio propio ni los excluidos) */
export function estadisticos(registros, opciones = {}) {
  const g = new Map();
  for (const x of comparables(registros, opciones)) {
    const k = `${x.material}|${x.nivel}`;
    if (!g.has(k)) g.set(k, { material: x.material, nivel: x.nivel, precios: [] });
    g.get(k).precios.push(x.precio_cmp);
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
/** Opciones de comparación de la elección de un proyecto */
export const opcionesSel = (sel = {}, factores = []) => opcionesDe({ factores, anioBase: sel.anio_base, comparar: sel.comparar_anio_base !== false, atipicos: sel.incluir_atipicos === true });
/** El kit de la referencia por defecto de un material (comparable, vigente), si lo hay */
export function kitDefecto(xs, material) {
  const f = REFERENCIA_DEFECTO[material];
  return f ? xs.find(x => x.fuente === f && x.material === material && x.unidad === 'kit' && x.comparable && !x.propio && !x.historico) || null : null;
}

/**
 * Precio de referencia elegido para una IOARR.
 * sel: { modo: 'defecto' | 'mediana' | 'registro', registro_id?, material: 'todos' | material, incluir_atipicos?, comparar_anio_base?, anio_base? }
 *   defecto: la referencia por defecto del material (Metal/Madera: Huicungo 2026); si no hay, la mediana.
 *   mediana: los comparables del nivel de la IOARR y los de nivel por confirmar.
 * kits: los del expediente (para el aviso de volumen). factores: los de actualización.
 * @returns { precio, n, min, max, fuente, avisos, registros }
 */
export function referencia(registros, { nivel, sel = {}, kits = null, factores = [] }) {
  const O = opcionesSel(sel, factores), material = sel.material && sel.material !== 'todos' ? sel.material : null, avisos = [];
  const nivelNom = NIVEL_DE[nivel] || nivel, todos = enriquecer(registros, O);
  const avisosDe = xs => {
    for (const x of xs) { const v = avisoVolumen(x, kits); if (v) avisos.push(v); }
    const sinAj = xs.filter(x => x.sin_ajuste);
    if (O.comparar && sinAj.length) avisos.push(`Sin ajuste de precios: ${sinAj.map(x => `${describir(x)} (${x.anio_origen}, factor 1.00)`).join('; ')}; el año base es ${O.anioBase}.`);
  };
  const una = (x, modo) => {
    if (x.nivel !== nivelNom && x.nivel !== 'por_confirmar') avisos.push(`La fuente es de ${x.nivel}; la IOARR es de ${nivelNom}: los precios de un nivel no valen sin revisar para otro.`);
    if (material && x.material !== material) avisos.push(`La fuente elegida es de ${MATERIALES[x.material].toLowerCase()}; el material elegido es ${MATERIALES[material].toLowerCase()}.`);
    if (x.historico) avisos.push('La fuente elegida es histórica.');
    if (x.atipico) avisos.push(`La fuente elegida es atípica por volumen (${x.volumen_kits.toLocaleString('es-PE')} kits).`);
    avisosDe([x]);
    avisos.push('Referencia de una sola fuente: menos de 3 fuentes comparables.');
    return { precio: x.precio_cmp, n: 1, min: x.precio_cmp, max: x.precio_cmp, fuente: describir(x), modo, avisos, registros: [x.id], original: x.precio_kit_sin_igv, factor: x.factor };
  };
  let modo = ['registro', 'mediana', 'defecto'].includes(sel.modo) ? sel.modo : 'defecto';
  if (modo === 'registro') {
    const x = todos.find(y => y.id === sel.registro_id);
    if (!x) return { precio: null, n: 0, fuente: null, avisos: ['La fuente elegida ya no está en el catálogo'], registros: [] };
    if (x.propio) return { precio: null, n: 0, fuente: null, avisos: ['El precio propio no puede ser la referencia'], registros: [] };
    if (!x.comparable) return { precio: null, n: 0, fuente: describir(x), avisos: [`La fuente elegida no es comparable: ${x.motivo}`], registros: [] };
    return una(x, modo);
  }
  if (modo === 'defecto') {
    const x = material ? kitDefecto(todos, material) : null;
    if (x) { avisos.push(`Referencia por defecto de ${MATERIALES[material].toLowerCase()}: ${x.fuente}.`); return una(x, modo); }
    modo = 'mediana';
  }
  const xs = todos.filter(x => x.comparable && !x.excluido && (x.nivel === nivelNom || x.nivel === 'por_confirmar') && (!material || x.material === material));
  const est = resumen(xs.map(x => x.precio_cmp));
  if (est.n < MIN_FUENTES) avisos.push(`Solo ${est.n} ${est.n === 1 ? 'fuente comparable' : 'fuentes comparables'}: se necesitan al menos ${MIN_FUENTES} para una referencia confiable.`);
  if (xs.some(x => x.nivel === 'por_confirmar')) avisos.push('Incluye fuentes con el nivel por confirmar.');
  if (!material && new Set(xs.map(x => x.material)).size > 1) avisos.push('Mezcla materiales distintos.');
  if (xs.some(x => x.material === 'por_confirmar')) avisos.push('Incluye fuentes con el material por confirmar.');
  if (xs.some(x => x.atipico)) avisos.push('Incluye fuentes atípicas por volumen (más de 10,000 kits).');
  const fuera = todos.filter(x => x.comparable && x.atipico && !O.atipicos && !x.propio && !x.historico && (!material || x.material === material) && (x.nivel === nivelNom || x.nivel === 'por_confirmar'));
  if (fuera.length) avisos.push(`Fuera de la mediana por atípicas por volumen: ${fuera.map(describir).join('; ')}.`);
  avisosDe(xs);
  return { ...est, precio: est.mediana, modo, fuente: est.n ? `Mediana de ${est.n} ${est.n === 1 ? 'fuente publicada' : 'fuentes publicadas'} (${xs.map(describir).join('; ')})` : null, avisos, registros: xs.map(x => x.id) };
}
/**
 * Precio unitario de referencia (sin IGV) por material y tipo de bien de Costos, para precargar
 * la tabla de precios por material: mediana de las fuentes con esa unidad y ese material.
 * Con grado (Primaria o Secundaria), el precio va a la talla (mesa_p12…); sin grado, al tipo.
 * Si el material tiene referencia por defecto (Metal/Madera: Huicungo 2026) y esta tiene precios
 * de esa unidad, se usan los de esa fuente. Sin el precio propio, los históricos ni los atípicos;
 * las de IGV por confirmar no entran (no se puede calcular sin IGV). Escritorio y silla docente
 * no tienen unidad en el catálogo. También el transporte por pieza (solo como referencia).
 * @returns { [material]: { [clave]: { precio, n, fuente, igv: 'con'|'sin'|'mixto', niveles } } }
 */
export const UNIDAD_DE_TIPO = { mesa: 'mesa', silla: 'silla', arm: 'armario' };
export function preciosUnitarios(registros, opciones = {}) {
  const out = {}, todos = enriquecer(registros, opciones).filter(x => !x.excluido && x.precio_sin_igv != null);
  const fila = xs => ({ precio: mediana(xs.map(x => x.precio_unit_cmp)), n: xs.length,
    fuente: xs.length === 1 ? describir(xs[0]) : `Mediana de ${xs.length} fuentes (${xs.map(describir).join('; ')})`,
    igv: xs.every(x => x.incluye_igv) ? 'con' : xs.every(x => !x.incluye_igv) ? 'sin' : 'mixto', niveles: [...new Set(xs.map(x => x.nivel))] });
  for (const m of Object.keys(MATERIALES).filter(m => m !== 'por_confirmar')) {
    out[m] = {};
    const delM = todos.filter(x => x.material === m), def = REFERENCIA_DEFECTO[m];
    for (const [t, u] of [...Object.entries(UNIDAD_DE_TIPO), ['transporte', 'transporte']]) {
      let xs = delM.filter(x => x.unidad === u);
      if (def && xs.some(x => x.fuente === def)) xs = xs.filter(x => x.fuente === def);
      const sinGrado = xs.filter(x => !x.grado);
      if (sinGrado.length) out[m][t] = fila(sinGrado);
      if (t === 'transporte') continue;
      const porTalla = new Map();
      for (const x of xs.filter(x => x.grado && TALLA_DE[x.nivel])) {
        const k = `${t}_${TALLA_DE[x.nivel][x.grado]}`;
        if (!porTalla.has(k)) porTalla.set(k, []);
        porTalla.get(k).push(x);
      }
      for (const [k, ys] of porTalla) out[m][k] = fila(ys);
    }
  }
  return out;
}
/**
 * Precio por kit de referencia (sin IGV) por material: la referencia por defecto del material
 * (Metal/Madera: Huicungo 2026) o la mediana de las fuentes comparables de ese material (kit, o
 * mesa/silla con composición), de cualquier nivel; sin el precio propio, los históricos ni los atípicos.
 * Las que no se pueden usar (IGV por confirmar, por pieza sin composición) van en «pendientes», con el motivo.
 * @returns { [material]: { precio, n, fuente, pendientes: [{ fuente, motivo }] } }
 */
export function preciosKit(registros, opciones = {}) {
  const out = {}, todos = enriquecer(registros, opciones);
  for (const m of Object.keys(MATERIALES).filter(m => m !== 'por_confirmar')) {
    const xs = todos.filter(x => !x.excluido && x.material === m);
    const def = kitDefecto(xs, m), ok = def ? [def] : xs.filter(x => x.comparable);
    // Mesa, silla, armario o transporte sueltos sin composición son precios unitarios (preciosUnitarios), no de kit
    const pend = xs.filter(x => !x.comparable && ![...Object.values(UNIDAD_DE_TIPO), 'transporte'].includes(x.unidad));
    out[m] = { precio: ok.length ? mediana(ok.map(x => x.precio_cmp)) : null, n: ok.length, defecto: !!def,
      fuente: !ok.length ? null : def ? `${describir(def)} (referencia por defecto)` : ok.length === 1 ? describir(ok[0]) : `Mediana de ${ok.length} fuentes (${ok.map(describir).join('; ')})`,
      pendientes: pend.map(x => ({ fuente: describir(x), motivo: x.motivo })) };
  }
  return out;
}
export const describir = x => [x.entidad || x.region, x.anio, TIPOS_DOC[x.tipo_documento], x.grado ? `${UNIDADES[x.unidad]?.toLowerCase() || x.unidad} ${GRADOS[x.grado]}` : null, x.cui ? 'CUI ' + x.cui : null].filter(Boolean).join(', ');

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
// Las columnas nuevas (037) van al final: los CSV hechos con la plantilla anterior siguen valiendo
export const COLUMNAS_CSV = ['tipo_documento', 'cui', 'entidad', 'region', 'anio', 'url', 'nivel', 'unidad', 'material', 'monto', 'monto_hasta', 'incluye_igv',
  'cotizaciones_valores', 'cotizaciones_n', 'cotizaciones_promedio', 'composicion', 'flete_transporte', 'confianza', 'notas',
  'fuente', 'grado', 'tipo', 'estado', 'volumen_kits', 'anio_precio'];
// Otros nombres de columna que se aceptan (el CSV del pedido usa «precio»)
export const ALIAS_CSV = { precio: 'monto', flete: 'flete_transporte', cotizaciones_usadas: 'cotizaciones_valores', 'año': 'anio', 'año_precio': 'anio_precio' };
const OBLIGATORIAS_CSV = ['region', 'anio', 'unidad', 'material', 'monto', 'incluye_igv', 'confianza'];
const csvCelda = v => { const s = String(v ?? ''); return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function plantillaCsv() {
  const ej = [
    { fuente: 'Ejemplo 2026', tipo_documento: 'bases', cui: '2512345', entidad: 'Gobierno Regional de Ejemplo', region: 'Ejemplo', anio: 2026, url: 'https://ejemplo.gob.pe/bases.pdf', nivel: 'Primaria', unidad: 'kit', material: 'metal-madera',
      monto: 600, incluye_igv: 'false', tipo: 'publicado', estado: 'vigente', volumen_kits: 800, confianza: 'alta', notas: 'Fila de ejemplo: bórrala' },
    { fuente: 'Ejemplo 2025', tipo_documento: '07-C', entidad: 'Municipalidad de Ejemplo', region: 'Ejemplo', anio: 2025, nivel: 'Primaria', grado: '1-2', unidad: 'mesa', material: 'metal-polipropileno',
      monto: 350, incluye_igv: 'true', tipo: 'publicado', estado: 'vigente', anio_precio: 2025, cotizaciones_valores: '340;350;360', composicion: 'mesa:1;silla:1:200', flete_transporte: 15, confianza: 'media', notas: 'Fila de ejemplo: bórrala' }
  ];
  return '\uFEFF' + [COLUMNAS_CSV, ...ej.map(o => COLUMNAS_CSV.map(c => o[c] ?? ''))].map(f => f.map(csvCelda).join(',')).join('\r\n') + '\r\n';
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
const NUMERICAS = ['anio', 'monto', 'monto_hasta', 'cotizaciones_n', 'cotizaciones_promedio', 'flete_transporte', 'volumen_kits', 'anio_precio'];
/**
 * Valida un CSV completo. Si alguna fila tiene errores, no se importa nada (reporte por fila).
 * @param existentes registros del catálogo (para avisar duplicados)
 * @returns { ok, registros, errores: [{ fila, errores }], total }
 */
export function validarCsv(texto, existentes = []) {
  const { sep, filas } = leerCsv(texto);
  if (!filas.length) return { ok: false, registros: [], errores: [{ fila: 1, errores: ['El archivo está vacío'] }], total: 0 };
  const cab = filas[0].map(c => { const k = c.trim().toLowerCase(); return ALIAS_CSV[k] || k; });
  const faltan = OBLIGATORIAS_CSV.filter(c => !cab.includes(c));
  if (faltan.length) return { ok: false, registros: [], errores: [{ fila: 1, errores: [`Faltan columnas: ${faltan.join(', ')}. Descarga la plantilla.`] }], total: filas.length - 1 };
  const desconocidas = cab.filter(c => c && !COLUMNAS_CSV.includes(c));
  const clave = r => [r.tipo_documento, r.cui || r.entidad || r.region, r.anio, r.nivel, r.grado, r.unidad, r.material, r.monto, r.monto_hasta].join('|');
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

// ─── Precarga (la de la migración 029, con los materiales de la 030, San Juan de la 032, Huánuco 2023 de la 033, los huecos de la 035, el IGV de Huánuco 2025 de la 036 y Huicungo y los campos nuevos de la 037; ids fijos) ──
const HUICUNGO = { fuente: 'Huicungo 2026', estado: 'vigente', volumen_kits: 455, cui: null, entidad: 'Municipalidad Distrital de Huicungo', region: 'San Martín', anio: 2026, nivel: 'Primaria',
  material: 'metal-madera', monto_hasta: null, incluye_igv: true, cotizaciones: null, composicion: [], confianza: 'media' };
export const PRECARGA = [
  { id: 'c0a7a10e-0000-4000-8000-000000000001', fuente: 'Loreto 2026', tipo: 'publicado', estado: 'vigente', tipo_documento: 'por_confirmar', cui: '2717248', entidad: 'Gobierno Regional Loreto', region: 'Loreto', anio: 2026, nivel: 'por_confirmar', unidad: 'kit', material: 'madera', monto: 624, monto_hasta: null, incluye_igv: false, cotizaciones: null, composicion: [], confianza: 'alta', notas: 'Precio por kit sin IGV.' },
  // Huánuco 2023: cuadro comparativo y estructura preliminar de costos (migración 033)
  { id: 'c0a7a10e-0000-4000-8000-000000000002', fuente: 'Huánuco 2023', tipo: 'publicado', estado: 'historico', tipo_documento: 'estudio_mercado', entidad: 'Gobierno Regional Huánuco', region: 'Huánuco', anio: 2023, nivel: 'Primaria', unidad: 'pieza', material: 'metal-madera',
    monto: 267.5, monto_hasta: null, incluye_igv: true, cotizaciones: { valores: [370, 250, 270, 180], n: 4, promedio: 267.5 }, composicion: [], confianza: 'media',
    notas: 'Cuadro comparativo y estructura preliminar de costos (mar. 2023), «Reposición de mobiliario de aulas del nivel primario … 11 provincias de la región Huánuco»; sin CUI. Promedio de 4 cotizaciones con IGV y transporte incluido (ene. 2023): Mobiliarios Yi 370 (polipropileno), Carpintería Garay 250 (madera tornillo), Mobi Edu 270 (polipropileno), Maderera Burgos 180 (madera). 12,310 piezas × 267.50 = S/ 3,292,925.00 con IGV; con expediente 1.19 %, supervisión 0.9 % y liquidación 0.8 %: S/ 3,388,090.53. No comparable hasta indicar la composición del kit.' },
  { id: 'c0a7a10e-0000-4000-8000-000000000003', fuente: 'Huánuco 2025', tipo: 'publicado', estado: 'vigente', tipo_documento: 'por_confirmar', cui: '2586831', entidad: 'Gobierno Regional Huánuco', region: 'Huánuco', anio: 2025, nivel: 'Primaria', unidad: 'kit', material: 'metal-madera', monto: 455, monto_hasta: 480, incluye_igv: false, cotizaciones: null, composicion: [], confianza: 'media', notas: 'Rango 455-480 sin IGV (se compara por su punto medio, 467.50).' },
  // San Juan: precio unitario real de la memoria de costos y presupuestos (migración 032; antes, el estimado de la 031)
  { id: 'c0a7a10e-0000-4000-8000-000000000004', fuente: 'San Juan 2026', tipo: 'publicado', estado: 'vigente', volumen_kits: 1045, tipo_documento: '07-C', cui: '2711098', entidad: 'Gobierno Regional de La Libertad', region: 'La Libertad', anio: 2026, nivel: 'Secundaria', unidad: 'kit', material: 'metal-polipropileno',
    monto: 411.85, monto_hasta: null, incluye_igv: false, flete_transporte: 26.02, cotizaciones: { valores: [], n: 4, promedio: null }, composicion: [], confianza: 'alta',
    componentes: { ejecucion: 739373.42, doc_equivalente: 43144.10, sup_doc_equivalente: 41219.36, sup_ejecucion: 96178.51, total: 919915.39 },
    notas: 'Memoria de costos y presupuestos (dic. 2025): precio del bien sin flete, gastos generales, utilidad ni IGV; promedio de 1,045 kits mesa + silla (rojo 420, verde 420, marrón 205). Flete S/ 13.01 por pieza (S/ 26.02 por kit). Con flete por color: S/ 434.47 / 436.09 / 448.49. Con gastos generales 18.17 % y utilidad 10 %: S/ 561.23 sin IGV.' },

  { id: 'c0a7a10e-0000-4000-8000-000000000005', fuente: 'Propio', tipo: 'propio', estado: 'vigente', tipo_documento: 'propio', entidad: null, region: null, anio: 2026, nivel: 'por_confirmar', unidad: 'kit', material: 'metal-polipropileno', monto: 850, monto_hasta: null, incluye_igv: false, cotizaciones: null, composicion: [], confianza: 'alta', notas: 'Excluir de estadísticos.' },
  // Huicungo 2026 (migración 037): CUI vacío a propósito; material según el usuario (fichas homologadas)
  ...[['6', 'mesa', '1-2', 370], ['7', 'mesa', '3-4', 375], ['8', 'mesa', '5-6', 380], ['9', 'silla', '1-2', 173], ['a', 'silla', '3-4', 178], ['b', 'silla', '5-6', 183]].map(([n, unidad, grado, monto], j) => ({
    id: `c0a7a10e-0000-4000-8000-00000000000${n}`, ...HUICUNGO, tipo_documento: '07-C', tipo: 'publicado', unidad, grado, monto,
    notas: j ? 'Precio unitario del 07-C; material según el usuario' : 'Precio unitario del 07-C; material según el usuario (fichas homologadas)' })),
  { id: 'c0a7a10e-0000-4000-8000-00000000000c', ...HUICUNGO, tipo_documento: 'por_confirmar', tipo: 'publicado', unidad: 'transporte', grado: null, monto: 25, notas: 'Por pieza (S/ 50 por kit)' },
  { id: 'c0a7a10e-0000-4000-8000-00000000000d', ...HUICUNGO, tipo_documento: 'bases', tipo: 'derivado', unidad: 'kit', grado: null, monto: 675.5,
    componentes: { ejecucion: 307333.60, doc_equivalente: 13720.25, supervision: 24696.45, total: 345750.30 },
    notas: 'Ejecución 307333.60 / 455 kits; incluye GG 12% y transporte; bases: monto incluye IGV' },
  // Huánuco 2025 derivado (migración 037): otro dato que el rango de arriba; atípico por volumen
  { id: 'c0a7a10e-0000-4000-8000-00000000000e', fuente: 'Huánuco 2025', tipo: 'derivado', estado: 'vigente', volumen_kits: 12379, tipo_documento: 'bases', cui: '2586831', entidad: 'Gobierno Regional Huánuco', region: 'Huánuco', anio: 2025,
    nivel: 'Secundaria', grado: null, unidad: 'kit', material: 'metal-madera', monto: 479.5, monto_hasta: null, incluye_igv: true, cotizaciones: null, composicion: [], confianza: 'media',
    notas: 'Ejecución 5935849.58 / 12379 mesas (369 II.EE.); bases: monto incluye IGV; atípico por volumen' }
];
