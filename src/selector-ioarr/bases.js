// ============================================================================
// src/selector-ioarr/bases.js — Generador de bases de Obras por Impuestos (OxI)
//
// A partir de la ficha de un proyecto arma el borrador de bases del proceso de
// selección con las plantillas estandarizadas de templates/bases/ (copiadas de
// docs/plantillas_bases; origen: bases 015-2026 de San Juan, DS 038-2026-EF).
//
// Reglas:
//   - Las plantillas se unen en el orden de sus archivos (00 a 19). La Sección II
//     y los formatos son texto fijo: solo se sustituyen marcadores. No se agrega
//     ni se quita texto legal.
//   - Marcadores: {{CAMPO}} (MANIFEST.json, clave «campos») y {FECHA_…} con llave
//     simple en el calendario (Anexo 2), que el MANIFEST no declara (CAMPOS_CALENDARIO).
//   - Si falta un dato, el marcador queda visible y el Word lo resalta.
//   - Documento equivalente (Prestación 1) y su supervisión (Prestación 3):
//     SIEMPRE obligatorios. No hay opción para omitirlos.
//     MONTO_TOTAL = documento equivalente + ejecución + supervisión del documento
//     equivalente + supervisión de la ejecución (se calcula; no se escribe a mano).
//   - Una ficha es de una sola IOARR, es decir, de un solo nivel (I, P, S o E).
//   - Neutralidad: las especificaciones no llevan marcas ni referencias a fabricantes.
//
// El Word lo arma src/selector-ioarr/word-bases.js; las rutas, bases-api.js.
// ============================================================================

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ESPECIFICACIONES, NORMAS_SUGERIDAS } from './bases-especificaciones.js';
import { descuadre } from './montos.js';
import { FUENTE_GORE, esEntidadGore } from './entidades-gore.js';

const DIR = new URL('../../templates/bases/', import.meta.url);
export const MANIFEST = JSON.parse(readFileSync(new URL('MANIFEST.json', DIR), 'utf8'));
// En el orden de los archivos (00 a 19)
export const PLANTILLAS = [...MANIFEST.plantillas].sort((a, b) => a.file.localeCompare(b.file))
  .map(t => ({ file: t.file, titulo: t.titulo, texto: readFileSync(new URL(t.file, DIR), 'utf8') }));
// Caracteres de control del PDF (saltos de página \f): no valen en el XML del Word
export const sinControl = s => String(s ?? '').replace(/\f/g, '\n').replace(/[\x00-\x08\x0B\x0E-\x1F\x7F]/g, '');
// Huella de las plantillas: una versión guardada avisa si se regenera con plantillas distintas
export const HASH_PLANTILLAS = createHash('sha256')
  .update(JSON.stringify(MANIFEST.campos)).update(PLANTILLAS.map(t => t.file + '\n' + t.texto).join('\n'))
  .digest('hex').slice(0, 16);

export const REGLAMENTO_PLANTILLAS = 'DS 038-2026-EF';
export const DECLARACION = 'Apoyo técnico brindado por un potencial postor; la entidad es responsable del contenido y su validación legal.';
export const PROPUESTA_MIN = 90, PROPUESTA_MAX = 110;   // Anexo 4-E (texto fijo)
export const REFERENCIA_PLAZO_DE = 'Referencia: San Juan 60 días, Loreto 30 días.';

// ─── Marcadores ─────────────────────────────────────────────────────────────
export const RE_DOBLE = /\{\{([A-Z0-9_]+)\}\}/g;
export const RE_SIMPLE = /(?<!\{)\{([A-Z][A-Z0-9_]*)\}(?!\})/g;
// Marcadores que quedaron sin dato (y avisos que deben verse) en el texto final
export const RE_RESALTAR = /\{\{[A-Z0-9_]+\}\}|(?<!\{)\{[A-Z][A-Z0-9_]*\}(?!\})|\[VERIFICAR[^\]]*\]|\[NO APLICA[^\]]*\]|\[COMPLETAR[^\]]*\]|\[REVISAR[^\]]*\]/g;

// Calendario (Anexo 2): llave simple, no están en el MANIFEST
export const CAMPOS_CALENDARIO = [
  ['FECHA_CONVOCATORIA', 'Convocatoria y publicación de Bases'],
  ['FECHA_EXPRESION_INICIO', 'Expresiones de interés: desde'],
  ['FECHA_EXPRESION_FIN', 'Expresiones de interés: hasta'],
  ['FECHA_CONSULTAS_INICIO', 'Consultas y observaciones: desde'],
  ['FECHA_CONSULTAS_FIN', 'Consultas y observaciones: hasta'],
  ['FECHA_ABSOLUCION_INICIO', 'Absolución de consultas: desde'],
  ['FECHA_ABSOLUCION_FIN', 'Absolución de consultas: hasta'],
  ['FECHA_INTEGRACION', 'Integración de Bases y publicación'],
  ['FECHA_PROPUESTAS', 'Presentación de propuestas (sobres 1, 2 y 3)'],
  ['FECHA_EVALUACION_INICIO', 'Evaluación de propuestas: desde'],
  ['FECHA_EVALUACION_FIN', 'Evaluación de propuestas: hasta'],
  ['FECHA_BUENA_PRO', 'Resultados y otorgamiento de la Buena Pro'],
  ['FECHA_CONSENTIMIENTO', 'Consentimiento de la Buena Pro'],
  ['FECHA_CONVENIO', 'Suscripción del Convenio de Inversión']
];
const K_CAL = CAMPOS_CALENDARIO.map(([k]) => k);
// Orden del calendario: cada par [antes, después] debe cumplir antes ≤ después
export const ORDEN_CALENDARIO = [
  ['FECHA_CONVOCATORIA', 'FECHA_EXPRESION_INICIO'], ['FECHA_EXPRESION_INICIO', 'FECHA_EXPRESION_FIN'],
  ['FECHA_CONVOCATORIA', 'FECHA_CONSULTAS_INICIO'], ['FECHA_CONSULTAS_INICIO', 'FECHA_CONSULTAS_FIN'],
  ['FECHA_CONSULTAS_FIN', 'FECHA_ABSOLUCION_INICIO'], ['FECHA_ABSOLUCION_INICIO', 'FECHA_ABSOLUCION_FIN'],
  ['FECHA_ABSOLUCION_FIN', 'FECHA_INTEGRACION'], ['FECHA_EXPRESION_FIN', 'FECHA_PROPUESTAS'], ['FECHA_INTEGRACION', 'FECHA_PROPUESTAS'],
  ['FECHA_PROPUESTAS', 'FECHA_EVALUACION_INICIO'], ['FECHA_EVALUACION_INICIO', 'FECHA_EVALUACION_FIN'],
  ['FECHA_EVALUACION_FIN', 'FECHA_BUENA_PRO'], ['FECHA_BUENA_PRO', 'FECHA_CONSENTIMIENTO'], ['FECHA_CONSENTIMIENTO', 'FECHA_CONVENIO']
];
// Antecedentes: el orden habitual (solo advertencia)
const ORDEN_ANTECEDENTES = ['FECHA_07C', 'FECHA_PRIORIZACION', 'FECHA_RESOLUCION_COMITE', 'FECHA_BASES', 'FECHA_CONVOCATORIA'];

// Texto fijo con valores del proceso de origen (San Juan) que no tienen marcador.
// No se cambian (texto fijo): se resaltan y se listan en la hoja de transparencia.
export const RESIDUOS_ORIGEN = [
  { file: '18_anexo_6_formato_convenio.md', re: /Doscientos diez \(210\) días calendario/, texto: 'Cláusula 6.2 del convenio: plazo de ejecución del convenio «Doscientos diez (210) días calendario» del proceso de origen.' },
  { file: '18_anexo_6_formato_convenio.md', re: /^\s*\d\s+ELABORACIÓN DE DOC\. EQUIVALENTE\s+\d+\s*$/m, texto: 'Cronograma referencial del convenio (6.2): días del documento equivalente del proceso de origen.' },
  { file: '18_anexo_6_formato_convenio.md', re: /^\s*\d\s+EJECUCIÓN DE EQUIPAMIENTO\s+\d+\s*$/m, texto: 'Cronograma referencial del convenio (6.2): días de ejecución del proceso de origen.' },
  { file: '18_anexo_6_formato_convenio.md', re: /^\s*\d\s+RECEPCIÓN \(\*\)\s+\d+\s*$/m, texto: 'Cronograma referencial del convenio (6.2): días de recepción del proceso de origen.' },
  { file: '18_anexo_6_formato_convenio.md', re: /^\s*\d\s+LIQUIDACIÓN \(\*\)\s+\d+\s*$/m, texto: 'Cronograma referencial del convenio (6.2): días de liquidación del proceso de origen.' },
  { file: '18_anexo_6_formato_convenio.md', re: /^\s*TOTAL\s+210\s*$/m, texto: 'Cronograma referencial del convenio (6.2): total de 210 días del proceso de origen.' }
];
export const esResiduo = linea => RESIDUOS_ORIGEN.some(r => new RegExp(r.re.source).test(linea));

// ─── Campos de la ficha, por sección ────────────────────────────────────────
// tipo: texto | parrafo | monto | dias | fecha | confirmacion | si_no | pct | opcion
// calculado: lo arma el sistema · opcional: puede quedar vacío · si: solo cuando ese control es verdadero
const C = (k, o = {}) => ({ k, etiqueta: o.etiqueta || MANIFEST.campos[k] || k, ayuda: o.ayuda ?? (o.etiqueta ? MANIFEST.campos[k] : '') ?? '', tipo: o.tipo || 'texto', ...o });
const NO_NUEVA = '[NO APLICA: el proceso no es una nueva convocatoria; la entidad retira este texto]';
export const AVISOS_VERIFICAR = {
  VERIFICAR_REGLAMENTO_VIGENTE: '[VERIFICAR: confirmar que el Decreto Supremo N° 038-2026-EF es el Reglamento vigente de la Ley N° 29230]',
  VERIFICAR_VIGENCIA: '[VERIFICAR: confirmar con el MEF la vigencia de la RD N° 005-2024-EF/68.01 o si existe una versión más reciente]'
};
export const SECCIONES = [
  { id: 'proceso', titulo: 'Proceso y reglamento', campos: [
    C('N_PROCESO', { ayuda: 'Ej.: 001-2026-CE-GR' }), C('SIGLAS_ENTIDAD'),
    C('reglamento', { etiqueta: 'Reglamento aplicable', ayuda: `Las plantillas citan el ${REGLAMENTO_PLANTILLAS}.` }),
    C('VERIFICAR_REGLAMENTO_VIGENTE', { tipo: 'confirmacion', etiqueta: 'Confirmé que el Reglamento citado es el vigente', ayuda: 'Sin confirmar, el aviso «VERIFICAR» queda visible en el Word.' }),
    C('VERIFICAR_VIGENCIA', { tipo: 'confirmacion', etiqueta: 'Confirmé la vigencia de la RD 005-2024-EF/68.01 (documentos estandarizados)', ayuda: 'Sin confirmar, el aviso «VERIFICAR» queda visible en el Word.' }),
    C('NORMAS_ADICIONALES', { tipo: 'parrafo', ayuda: 'Normas del sector Educación u otras, en una línea de la base legal (1.1).' })
  ] },
  { id: 'entidad', titulo: 'Entidad pública', campos: [
    C('ENTIDAD'), C('ENTIDAD_MAYUS', { calculado: true, ayuda: 'Se arma con el nombre de la entidad.' }),
    C('ENTIDAD_RUC', { ayuda: '11 dígitos' }), C('ENTIDAD_DOMICILIO'), C('ENTIDAD_TELEFONO'), C('ENTIDAD_CORREO_COMITE'),
    C('ENTIDAD_CORREOS_CIPRL'), C('ENTIDAD_DOMICILIO_CIPRL'), C('PEI_ENTIDAD'), C('PMI_PERIODO'),
    C('PROVINCIA_NOTIFICACION'), C('CIUDAD_JURISDICCION'), C('CAMARA_COMERCIO')
  ] },
  { id: 'representante', titulo: 'Representante de la entidad (convenio)', campos: [
    C('NOMBRE_REPRESENTANTE'), C('DNI_REPRESENTANTE', { ayuda: '8 dígitos' }), C('CARGO_REPRESENTANTE'), C('SUSTENTO_FACULTADES')
  ] },
  { id: 'inversion', titulo: 'Inversión (IOARR)', campos: [
    C('NOMBRE_IOARR', { tipo: 'parrafo' }), C('CUI'), C('COMPONENTE'), C('UF_NOMBRE'), C('FECHA_07C', { tipo: 'fecha' })
  ] },
  { id: 'antecedentes', titulo: 'Antecedentes del proceso', campos: [
    C('ACTO_PRIORIZACION'), C('FECHA_PRIORIZACION', { tipo: 'fecha' }),
    C('RESOLUCION_COMITE'), C('FECHA_RESOLUCION_COMITE', { tipo: 'fecha' }), C('AUTORIDAD_DESIGNA_COMITE'),
    C('OFICIO_CGR'), C('FECHA_OFICIO_CGR', { tipo: 'fecha' }), C('INFORME_PREVIO_CGR'),
    C('RESOLUCION_BASES'), C('FECHA_BASES', { tipo: 'fecha' })
  ] },
  { id: 'nueva', titulo: 'Nueva convocatoria (solo si corresponde)', campos: [
    C('nueva_convocatoria', { tipo: 'si_no', etiqueta: '¿Es una nueva convocatoria?', ayuda: 'Si no lo es, esos textos quedan marcados «NO APLICA» para que la entidad los retire.' }),
    C('ANTECEDENTE_NUEVA_CONVOCATORIA', { tipo: 'parrafo', si: 'nueva_convocatoria' }), C('N_PROCESO_ANTERIOR', { si: 'nueva_convocatoria' }),
    C('CIRCULAR_DESIERTO', { si: 'nueva_convocatoria' }), C('FECHA_CIRCULAR_DESIERTO', { tipo: 'fecha', si: 'nueva_convocatoria' }),
    C('MOTIVO_NUEVA_CONVOCATORIA', { si: 'nueva_convocatoria' })
  ] },
  { id: 'montos', titulo: 'Montos y plazos (documento equivalente obligatorio)', campos: [
    C('MONTO_DOC_EQUIVALENTE', { tipo: 'monto', etiqueta: 'Prestación 1: elaboración del documento equivalente (S/)', obligatorioDE: true }),
    C('MONTO_EJECUCION', { tipo: 'monto', etiqueta: 'Prestación 2: ejecución física (S/)' }),
    C('MONTO_SUP_DOC_EQUIVALENTE', { tipo: 'monto', etiqueta: 'Prestación 3: supervisión del documento equivalente (S/)', obligatorioDE: true }),
    C('MONTO_SUP_EJECUCION', { tipo: 'monto', etiqueta: 'Prestación 3: supervisión de la ejecución física (S/)' }),
    C('MONTO_SUPERVISION_TOTAL', { tipo: 'monto', calculado: true, ayuda: 'Supervisión del documento equivalente + supervisión de la ejecución.' }),
    C('MONTO_TOTAL', { tipo: 'monto', calculado: true, ayuda: 'Documento equivalente + ejecución + las dos supervisiones.' }),
    C('MONTO_TOTAL_LETRAS', { calculado: true }),
    C('total_declarado', { tipo: 'monto', opcional: true, etiqueta: 'Monto total declarado (07-C o entidad), opcional',
      ayuda: 'Si lo escribes, las cuatro prestaciones deben sumarlo exactamente: si no cuadran, la ficha no se guarda.' }),
    C('PLAZO_DOC_EQUIVALENTE_DIAS', { tipo: 'dias', etiqueta: 'Plazo del documento equivalente (días calendario)', ayuda: REFERENCIA_PLAZO_DE, obligatorioDE: true }),
    C('PLAZO_EJECUCION_DIAS', { tipo: 'dias', etiqueta: 'Plazo de ejecución física (días calendario)' }),
    C('propuesta_min_pct', { tipo: 'pct', etiqueta: 'Propuesta económica: mínimo (% del monto referencial)', ayuda: `El Anexo 4-E fija ${PROPUESTA_MIN} %.` }),
    C('propuesta_max_pct', { tipo: 'pct', etiqueta: 'Propuesta económica: máximo (% del monto referencial)', ayuda: `El Anexo 4-E fija ${PROPUESTA_MAX} %.` })
  ] },
  { id: 'calendario', titulo: 'Comité especial y calendario (Anexo 2)', campos: [
    C('DIRECCION_COMITE'), C('HORARIO_RECEPCION', { ayuda: 'Ej.: lunes a viernes de 8:00 a 13:00 y de 14:00 a 16:30' }),
    ...CAMPOS_CALENDARIO.map(([k, e]) => C(k, { tipo: 'fecha', etiqueta: e }))
  ] },
  { id: 'tecnico', titulo: 'Cantidades y especificaciones técnicas (Anexo 3-A)', campos: [
    C('metodo_cantidades', { tipo: 'opcion', etiqueta: 'Cantidades', opciones: { app: 'Cálculo de la app (escenario del expediente)', malo_ugel: 'Mobiliario en estado Malo declarado por la UGEL' } }),
    C('precio_kit_origen', { tipo: 'opcion', etiqueta: 'Precio por kit en el Anexo 3-A', opciones: { app: 'Estructura de costos del expediente', catalogo: 'Catálogo de precios referenciales (IOARR publicadas)' },
      ayuda: 'El del catálogo es el precio sin IGV elegido en «Precios referenciales» (mediana o una fuente), sin transporte.' }),
    C('sustento_ugel', { si: 'malo_ugel', etiqueta: 'Documento de la UGEL que declara las cantidades', ayuda: 'Ej.: Oficio N° 123-2026-UGEL-X' }),
    C('normas_tecnicas', { tipo: 'parrafo', etiqueta: 'Normas técnicas aplicables', ayuda: `Ej.: ${NORMAS_SUGERIDAS.join('; ')}. Revísalas antes de exportar.` }),
    C('normas_verificadas', { tipo: 'confirmacion', etiqueta: 'Verifiqué que las normas técnicas están vigentes y aplican a este nivel' })
  ] }
];
export const CAMPOS = SECCIONES.flatMap(s => s.campos.map(c => ({ ...c, seccion: s.id })));
const POR_K = Object.fromEntries(CAMPOS.map(c => [c.k, c]));
export const CAMPOS_FICHA = CAMPOS.map(c => c.k);
export const etiquetaDe = k => POR_K[k]?.etiqueta || k;
// Documento equivalente: sin estos no se genera
export const OBLIGATORIOS_DE = ['MONTO_DOC_EQUIVALENTE', 'MONTO_SUP_DOC_EQUIVALENTE', 'PLAZO_DOC_EQUIVALENTE_DIAS', 'PLAZO_EJECUCION_DIAS'];

// ─── Limpieza de la ficha ───────────────────────────────────────────────────
// Sin llaves: un valor nunca crea un marcador nuevo
const sinLlaves = s => sinControl(s).replace(/[{}]/g, '');
const texto = (v, max = 500) => sinLlaves(v).replace(/[ \t]+/g, ' ').trim().slice(0, max);
const parrafo = (v, max = 3000) => sinLlaves(v).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const numero = (v, min, max) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
export const fechaValida = v => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
function limpiarValor(c, v) {
  switch (c.tipo) {
    case 'monto': { const n = numero(v, 0, 1e11); return n == null ? null : r2(n); }
    case 'dias': { const n = numero(v, 1, 3650); return n == null ? null : Math.round(n); }
    case 'pct': return numero(v, 0, 200);
    case 'fecha': return fechaValida(v) ? v : '';
    case 'confirmacion': return v === true;
    case 'si_no': return v === true || v === 'si';
    case 'opcion': return Object.keys(c.opciones).includes(v) ? v : Object.keys(c.opciones)[0];
    case 'parrafo': return parrafo(v);
    default: return texto(v);
  }
}
const TIPOS_BIEN = Object.keys(ESPECIFICACIONES);
/** Valida lo que guarda el formulario. Lo desconocido se descarta; lo calculado se recalcula. */
export function limpiarFicha(b = {}) {
  const out = {};
  for (const c of CAMPOS) if (!c.calculado) out[c.k] = limpiarValor(c, b[c.k]);
  if (b.propuesta_min_pct == null || b.propuesta_min_pct === '') out.propuesta_min_pct = PROPUESTA_MIN;
  if (b.propuesta_max_pct == null || b.propuesta_max_pct === '') out.propuesta_max_pct = PROPUESTA_MAX;
  if (!out.reglamento) out.reglamento = b.reglamento === '' ? '' : REGLAMENTO_PLANTILLAS;
  // Cantidades declaradas por la UGEL, por tipo de bien (enteros)
  out.cantidades_ugel = Object.fromEntries(TIPOS_BIEN.map(k => [k, numero(b.cantidades_ugel?.[k], 0, 1e7)]).filter(([, v]) => v != null).map(([k, v]) => [k, Math.round(v)]));
  // Especificación técnica editada por tipo de bien (vacía = la de la biblioteca neutral)
  out.especificaciones = Object.fromEntries(TIPOS_BIEN.map(k => [k, parrafo(b.especificaciones?.[k], 3000)]).filter(([, v]) => v));
  // Lo que precargó la app (para la hoja de transparencia: qué se tomó de la app)
  out._precarga = Object.fromEntries(Object.entries(b._precarga || {}).filter(([k]) => POR_K[k] && !POR_K[k].calculado).map(([k, v]) => [k, limpiarValor(POR_K[k], v)]));
  out._precarga_notas = Object.fromEntries(Object.entries(b._precarga_notas || {}).filter(([k]) => POR_K[k]).map(([k, v]) => [k, texto(v, 300)]));
  return out;
}

// ─── Montos ─────────────────────────────────────────────────────────────────
/** Total referencial: documento equivalente + ejecución + supervisión del documento equivalente + supervisión de la ejecución */
export function calcularMontos(d) {
  const v = k => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? d[k] : null);
  const doc = v('MONTO_DOC_EQUIVALENTE'), ej = v('MONTO_EJECUCION'), supDoc = v('MONTO_SUP_DOC_EQUIVALENTE'), supEj = v('MONTO_SUP_EJECUCION');
  const supervision = supDoc != null && supEj != null ? r2(supDoc + supEj) : null;
  const total = doc != null && ej != null && supervision != null ? r2(doc + ej + supDoc + supEj) : null;
  // Porcentaje del total en céntimos enteros (sin errores de coma flotante)
  const pct = q => total == null ? null : Math.round(Math.round(total * 100) * q / 100) / 100;
  return { doc, ej, supDoc, supEj, supervision, total,
    min: pct(d.propuesta_min_pct ?? PROPUESTA_MIN), max: pct(d.propuesta_max_pct ?? PROPUESTA_MAX),
    min_bases: pct(PROPUESTA_MIN), max_bases: pct(PROPUESTA_MAX) };
}

// Monto en letras: «UN MILLÓN DOSCIENTOS TREINTA Y CUATRO MIL QUINIENTOS SESENTA Y SIETE CON 89/100 SOLES»
const UNI = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
const DIEZ_29 = ['DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE',
  'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
const DECENAS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CIENTOS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
const dec99 = n => n < 10 ? UNI[n] : n < 30 ? DIEZ_29[n - 10] : DECENAS[Math.floor(n / 10)] + (n % 10 ? ' Y ' + UNI[n % 10] : '');
const cen999 = n => n === 100 ? 'CIEN' : [CIENTOS[Math.floor(n / 100)], dec99(n % 100)].filter(Boolean).join(' ');
const apocope = s => s.replace(/VEINTIUNO$/, 'VEINTIÚN').replace(/UNO$/, 'UN');
export function enteroEnLetras(n) {
  if (n === 0) return 'CERO';
  const millones = Math.floor(n / 1e6), miles = Math.floor((n % 1e6) / 1000), resto = n % 1000, partes = [];
  if (millones) partes.push(millones === 1 ? 'UN MILLÓN' : apocope(enteroEnLetras(millones)) + ' MILLONES');
  if (miles) partes.push(miles === 1 ? 'MIL' : apocope(cen999(miles)) + ' MIL');
  if (resto) partes.push(cen999(resto));
  return partes.join(' ');
}
export function montoEnLetras(m) {
  if (m == null || !Number.isFinite(m) || m < 0) return null;
  const cent = Math.round(m * 100), ent = Math.floor(cent / 100), dec = cent % 100;
  return `${enteroEnLetras(ent)} CON ${String(dec).padStart(2, '0')}/100 SOLES`;
}

// ─── Formatos ───────────────────────────────────────────────────────────────
const NS = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatoMonto = n => n == null ? '' : NS.format(n);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const fechaLarga = v => { if (!fechaValida(v)) return ''; const [a, m, d] = v.split('-').map(Number); return `${d} de ${MESES[m - 1]} de ${a}`; };
export const fechaCorta = v => fechaValida(v) ? v.split('-').reverse().join('/') : '';
const diaSemana = v => new Date(v + 'T00:00:00Z').getUTCDay();   // 0 domingo, 6 sábado

/**
 * Valor de cada marcador para sustituir. null = falta el dato (el marcador queda visible).
 */
export function valoresMarcadores(d) {
  const M = calcularMontos(d), out = {};
  for (const k of Object.keys(MANIFEST.campos)) {
    const c = POR_K[k], v = d[k];
    if (c?.tipo === 'monto') out[k] = v == null ? null : formatoMonto(v);
    else if (c?.tipo === 'fecha') out[k] = fechaLarga(v) || null;
    else if (c?.tipo === 'dias') out[k] = v == null ? null : String(v);
    else out[k] = v == null || v === '' ? null : String(v);
  }
  for (const k of K_CAL) out[k] = fechaCorta(d[k]) || null;
  out.ENTIDAD_MAYUS = d.ENTIDAD ? d.ENTIDAD.toLocaleUpperCase('es-PE') : null;
  out.MONTO_SUPERVISION_TOTAL = M.supervision == null ? null : formatoMonto(M.supervision);
  out.MONTO_TOTAL = M.total == null ? null : formatoMonto(M.total);
  out.MONTO_TOTAL_LETRAS = montoEnLetras(M.total);
  for (const [k, aviso] of Object.entries(AVISOS_VERIFICAR)) out[k] = d[k] === true ? '' : aviso;
  if (!d.nueva_convocatoria) for (const c of CAMPOS.filter(c => c.si === 'nueva_convocatoria')) out[c.k] = NO_NUEVA;
  return out;
}

/** Sustituye {{CAMPO}} y {FECHA_…}. Lo que no tiene valor queda tal cual (visible). */
export function sustituir(texto, valores) {
  const faltan = new Set();
  const rep = (m, k) => { const v = valores[k]; if (v == null) { faltan.add(k); return m; } return v; };
  return { texto: texto.replace(RE_DOBLE, rep).replace(RE_SIMPLE, rep), faltan };
}
/** Marcadores de un texto ({{X}} y {X}) */
export const marcadoresDe = t => [...new Set([...t.matchAll(RE_DOBLE), ...t.matchAll(RE_SIMPLE)].map(m => m[1]))];
// Declarados: los del MANIFEST y los del calendario
export const DECLARADOS = new Set([...Object.keys(MANIFEST.campos), ...K_CAL]);

// Quita el comentario inicial de la plantilla (<!-- PLANTILLA … -->)
export const sinComentario = t => sinControl(t).replace(/^\s*<!--[\s\S]*?-->\s*\n?/, '');

// ─── Cantidades y precios (Anexo 3-A) ───────────────────────────────────────
/**
 * Cuadro de cantidades con los precios del cálculo de la app.
 * ctx.metas: [{ k, nombre, unidad, cantidad, costo }] (costo con IGV, de la estructura de costos)
 * Con «Malo declarado por la UGEL», la cantidad es la de la UGEL y el precio unitario el de la app.
 */
export function cuadroCantidades(d, ctx = {}) {
  const ugel = d.metodo_cantidades === 'malo_ugel';
  // Kit con el precio del catálogo de precios referenciales (sin IGV → con IGV, sin transporte)
  const cat = d.precio_kit_origen === 'catalogo', ref = ctx.precio_ref;
  const filas = (ctx.metas || []).map(m => {
    const desdeCat = cat && m.k === 'kit';
    const pu = desdeCat ? (ref?.precio != null ? r2(ref.precio * 1.18) : null) : m.cantidad > 0 ? r2(m.costo / m.cantidad) : null;
    const cantidad = ugel ? (d.cantidades_ugel?.[m.k] ?? null) : m.cantidad;
    return { k: m.k, nombre: m.nombre, unidad: m.unidad, cantidad, cantidad_app: m.cantidad, pu, catalogo: desdeCat,
      parcial: cantidad != null && pu != null ? (ugel || desdeCat ? r2(cantidad * pu) : r2(m.costo)) : null };
  });
  const total = filas.every(f => f.parcial != null) ? r2(filas.reduce((a, f) => a + f.parcial, 0)) : null;
  const textoCat = cat && filas.some(f => f.catalogo) ? ` Kit: precio del catálogo de precios referenciales de IOARR publicadas (${ref?.precio != null ? `S/ ${formatoMonto(ref.precio)} sin IGV, ${ref.modo === 'registro' ? 'una fuente' : `mediana de ${ref.n} ${ref.n === 1 ? 'fuente' : 'fuentes'}`}` : 'sin referencia comparable'}), con IGV y sin transporte.` : '';
  return { metodo: ugel ? 'malo_ugel' : 'app', filas, total, precio_catalogo: cat,
    texto: (ugel ? `Cantidades: mobiliario en estado Malo declarado por la UGEL${d.sustento_ugel ? ' (' + d.sustento_ugel + ')' : ''}. Precio unitario referencial con IGV de la estructura de costos de la app.`
      : `Cantidades del cálculo de la app. ${ctx.escenario_texto || ''}`.trim()) + textoCat };
}
export const especificacionDe = (d, k) => d.especificaciones?.[k] || ESPECIFICACIONES[k]?.texto || '';

// ─── Neutralidad ────────────────────────────────────────────────────────────
// Nada que favorezca a un postor: sin marcas, sin el nombre de la empresa, sin «o similar»
const PROHIBIDO = [/®/, /™/, /\bibero\b/i];
const DUDOSO = [/\bmarca\b/i, /\bo similar\b/i, /\bo equivalente\b/i, /\bfabricante\b/i];
export function revisarNeutralidad(t) {
  const s = String(t || '');
  return { prohibido: PROHIBIDO.filter(r => r.test(s)).map(r => s.match(r)[0]), dudoso: DUDOSO.filter(r => r.test(s)).map(r => s.match(r)[0]) };
}

// ─── Validación ─────────────────────────────────────────────────────────────
const vacio = v => v == null || v === '' || v === false;
const correoValido = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const aplica = (c, d) => !c.si || (c.si === 'malo_ugel' ? d.metodo_cantidades === 'malo_ugel' : !!d[c.si]);
/**
 * Errores (bloquean la exportación), advertencias y pendientes.
 * ctx: { metas, total_07c, residuos } del cálculo de la app (opcional)
 */
export function validarFicha(d, ctx = {}) {
  const errores = [], advertencias = [], pendientes = [];
  const err = (k, t) => errores.push({ k, texto: t }), adv = (k, t) => advertencias.push({ k, texto: t });

  // 1. Obligatorios completos (todo lo que aplica, salvo confirmaciones y opciones)
  for (const c of CAMPOS) {
    if (c.calculado || c.opcional || ['confirmacion', 'si_no', 'opcion', 'pct'].includes(c.tipo) || !aplica(c, d)) continue;
    if (vacio(d[c.k])) {
      pendientes.push(c.k);
      err(c.k, OBLIGATORIOS_DE.includes(c.k) ? `Documento equivalente (obligatorio): falta «${c.etiqueta}».` : `Falta «${c.etiqueta}».`);
    }
  }
  // 2. Documento equivalente y montos coherentes
  const M = calcularMontos(d);
  for (const k of ['MONTO_DOC_EQUIVALENTE', 'MONTO_EJECUCION', 'MONTO_SUP_DOC_EQUIVALENTE', 'MONTO_SUP_EJECUCION'])
    if (d[k] === 0) err(k, `«${etiquetaDe(k)}» debe ser mayor que cero${OBLIGATORIOS_DE.includes(k) ? ': el documento equivalente y su supervisión son obligatorios' : ''}.`);
  if (M.total != null && !verificarTotal(d)) err('MONTO_TOTAL', 'El monto total no es la suma de las cuatro prestaciones.');
  const dTotal = descuadreFicha(d);
  if (dTotal) err('total_declarado', dTotal);
  if (M.total != null && M.doc + M.supDoc >= M.total) err('MONTO_TOTAL', 'El documento equivalente y su supervisión no pueden ser todo el monto: falta la ejecución física.');
  // 3. Propuesta económica entre 90 % y 110 % (texto fijo del Anexo 4-E): solo se advierte si la ficha dice otra cosa
  if ((d.propuesta_min_pct ?? PROPUESTA_MIN) !== PROPUESTA_MIN || (d.propuesta_max_pct ?? PROPUESTA_MAX) !== PROPUESTA_MAX)
    adv('propuesta_min_pct', `La ficha indica una propuesta entre ${d.propuesta_min_pct} % y ${d.propuesta_max_pct} %, pero el Anexo 4-E (texto fijo) establece entre ${PROPUESTA_MIN} % y ${PROPUESTA_MAX} % del monto referencial. Las bases mantienen ${PROPUESTA_MIN} %–${PROPUESTA_MAX} %.`);
  if ((d.propuesta_min_pct ?? PROPUESTA_MIN) > (d.propuesta_max_pct ?? PROPUESTA_MAX)) adv('propuesta_min_pct', 'El mínimo de la propuesta económica es mayor que el máximo.');
  // 4. Fechas del calendario en orden
  for (const [a, b] of ORDEN_CALENDARIO)
    if (fechaValida(d[a]) && fechaValida(d[b]) && d[a] > d[b]) err(b, `Calendario fuera de orden: «${etiquetaDe(b)}» (${fechaCorta(d[b])}) es antes que «${etiquetaDe(a)}» (${fechaCorta(d[a])}).`);
  const finde = K_CAL.filter(k => fechaValida(d[k]) && [0, 6].includes(diaSemana(d[k])));
  if (finde.length) adv(finde[0], `Fechas del calendario en sábado o domingo (los plazos son en días hábiles): ${finde.map(k => `${etiquetaDe(k)} ${fechaCorta(d[k])}`).join('; ')}.`);
  const ant = ORDEN_ANTECEDENTES.filter(k => fechaValida(d[k]));
  for (let i = 1; i < ant.length; i++) if (d[ant[i - 1]] > d[ant[i]]) adv(ant[i], `Antecedentes: «${etiquetaDe(ant[i])}» (${fechaCorta(d[ant[i]])}) es antes que «${etiquetaDe(ant[i - 1])}» (${fechaCorta(d[ant[i - 1]])}). Revisa el orden.`);
  // 5. Reglamento aplicable y avisos «verificar»
  if (!d.reglamento) err('reglamento', 'Indica el Reglamento aplicable (por ejemplo, DS 038-2026-EF).');
  else if (normalizarDs(d.reglamento) !== normalizarDs(REGLAMENTO_PLANTILLAS))
    err('reglamento', `Las plantillas citan el ${REGLAMENTO_PLANTILLAS} en su texto fijo. Con otro reglamento («${d.reglamento}») hay que revisar primero las plantillas: no se genera para no citar un reglamento distinto.`);
  for (const k of Object.keys(AVISOS_VERIFICAR)) if (d[k] !== true) adv(k, `Sin confirmar: el Word muestra «${AVISOS_VERIFICAR[k]}».`);
  // 6. Datos con formato
  if (d.ENTIDAD_RUC && !/^\d{11}$/.test(d.ENTIDAD_RUC)) err('ENTIDAD_RUC', 'El RUC debe tener 11 dígitos.');
  if (d.DNI_REPRESENTANTE && !/^\d{8}$/.test(d.DNI_REPRESENTANTE)) err('DNI_REPRESENTANTE', 'El DNI debe tener 8 dígitos.');
  if (d.CUI && !/^\d{5,8}$/.test(d.CUI)) err('CUI', 'El CUI debe tener solo dígitos (5 a 8).');
  if (d.ENTIDAD_CORREO_COMITE && !correoValido(d.ENTIDAD_CORREO_COMITE)) err('ENTIDAD_CORREO_COMITE', 'El correo del Comité Especial no es válido.');
  // 7. Cantidades, normas técnicas y neutralidad
  if (d.metodo_cantidades === 'malo_ugel') {
    const Q = cuadroCantidades(d, ctx);
    if (!Q.filas.length) err('metodo_cantidades', 'No hay bienes en el cálculo de la app para tomar los precios unitarios.');
    else if (Q.filas.some(f => f.cantidad == null)) err('metodo_cantidades', 'Con «Malo declarado por la UGEL», escribe la cantidad de cada bien.');
  }
  if (d.precio_kit_origen === 'catalogo') {
    if (!(ctx.metas || []).some(m => m.k === 'kit')) err('precio_kit_origen', 'El precio del catálogo es por kit: activa «kit» en Costos o usa la estructura de costos.');
    else if (ctx.precio_ref?.precio == null) err('precio_kit_origen', 'No hay precio de referencia comparable en el catálogo para este nivel: elige otra referencia en «Precios referenciales» o usa la estructura de costos.');
    else for (const a of ctx.precio_ref.avisos || []) adv('precio_kit_origen', `Precio del catálogo: ${a}`);
  }
  if (!d.normas_verificadas) err('normas_verificadas', 'Verifica las normas técnicas aplicables y marca la confirmación.');
  for (const k of TIPOS_BIEN.filter(k => d.especificaciones?.[k]).concat('normas_tecnicas')) {
    const t = k === 'normas_tecnicas' ? d.normas_tecnicas : d.especificaciones[k], n = revisarNeutralidad(t), nom = k === 'normas_tecnicas' ? 'Normas técnicas' : `Especificación de ${ESPECIFICACIONES[k].nombre.toLowerCase()}`;
    if (n.prohibido.length) err(k === 'normas_tecnicas' ? k : 'especificaciones', `${nom}: quita «${n.prohibido.join('», «')}» (sin marcas ni referencias a un postor o fabricante).`);
    if (n.dudoso.length) adv(k === 'normas_tecnicas' ? k : 'especificaciones', `${nom}: revisa «${n.dudoso.join('», «')}»; las especificaciones deben ser neutrales.`);
  }
  for (const c of CAMPOS.filter(c => ['texto', 'parrafo'].includes(c.tipo) && typeof d[c.k] === 'string')) {
    const n = revisarNeutralidad(d[c.k]);
    if (n.prohibido.length) err(c.k, `«${c.etiqueta}»: quita «${n.prohibido.join('», «')}» (neutralidad).`);
  }
  // 8. Comparación con el cálculo de la app (solo advertencias)
  if (M.total != null && ctx.total_07c != null && Math.abs(M.total - ctx.total_07c) >= 1)
    adv('MONTO_TOTAL', `El total de las bases (S/ ${formatoMonto(M.total)}) difiere del costo de inversión del expediente (S/ ${formatoMonto(ctx.total_07c)}). La tabla 1.5 no tiene filas para liquidación ni control concurrente: confírmalo con la entidad.`);
  const Q = cuadroCantidades(d, ctx);
  if (Q.total != null && d.MONTO_EJECUCION != null && Math.abs(Q.total - d.MONTO_EJECUCION) >= 1)
    adv('MONTO_EJECUCION', `La ejecución física (S/ ${formatoMonto(d.MONTO_EJECUCION)}) difiere del cuadro de cantidades del Anexo 3-A (S/ ${formatoMonto(Q.total)}).`);
  for (const r of RESIDUOS_ORIGEN.filter((r, i, a) => a.findIndex(x => x.texto.split(':')[0] === r.texto.split(':')[0]) === i))
    adv(null, `Texto fijo con datos del proceso de origen (resaltado en el Word): ${r.texto.split(':')[0]}. La entidad debe ajustarlo a esta IOARR (documento equivalente ${d.PLAZO_DOC_EQUIVALENTE_DIAS ?? '—'} días, ejecución ${d.PLAZO_EJECUCION_DIAS ?? '—'} días).`);

  return { ok: !errores.length, errores, advertencias, pendientes, montos: M };
}
/**
 * Si la ficha declara un total (07-C o entidad), las cuatro prestaciones deben sumarlo exactamente.
 * @returns null si cuadra o si falta algún dato; si no, el mensaje (bloquea el guardado)
 */
export function descuadreFicha(d) {
  const k = ['MONTO_DOC_EQUIVALENTE', 'MONTO_EJECUCION', 'MONTO_SUP_DOC_EQUIVALENTE', 'MONTO_SUP_EJECUCION'];
  if (d.total_declarado == null || k.some(x => d[x] == null)) return null;
  return descuadre({ 'Documento equivalente': d.MONTO_DOC_EQUIVALENTE, 'Ejecución física': d.MONTO_EJECUCION,
    'Supervisión del documento equivalente': d.MONTO_SUP_DOC_EQUIVALENTE, 'Supervisión de la ejecución': d.MONTO_SUP_EJECUCION }, d.total_declarado, { que: 'Las cuatro prestaciones' });
}
const normalizarDs = s => String(s || '').toUpperCase().replace(/DECRETO\s+SUPREMO/g, 'DS').replace(/N[°º.]?\s*/g, '').replace(/[^A-Z0-9-]/g, '');
/** El total es exactamente la suma de las cuatro prestaciones (al céntimo) */
export function verificarTotal(d) {
  const M = calcularMontos(d);
  if (M.total == null) return false;
  return Math.round(M.total * 100) === Math.round(M.doc * 100) + Math.round(M.ej * 100) + Math.round(M.supDoc * 100) + Math.round(M.supEj * 100);
}

// ─── Armado del texto ───────────────────────────────────────────────────────
/**
 * Une las plantillas en orden y sustituye los marcadores.
 * @returns { bloques: [{ file, titulo, texto }], faltan: [marcador], residuos: [texto] }
 */
export function armarTexto(d) {
  const valores = valoresMarcadores(d), faltan = new Set();
  const bloques = PLANTILLAS.map(t => {
    const s = sustituir(sinComentario(t.texto), valores);
    s.faltan.forEach(k => faltan.add(k));
    return { file: t.file, titulo: t.titulo, texto: s.texto };
  });
  const todo = bloques.map(b => b.texto).join('\n');
  return { bloques, valores, faltan: [...faltan], residuos: RESIDUOS_ORIGEN.filter(r => r.re.test(todo)).map(r => r.texto) };
}

// ─── Precarga desde la app ──────────────────────────────────────────────────
/**
 * Lo que la app ya conoce. M: modelo del expediente de la IOARR (documentos.js / paquete.js);
 * radar: registro de Radar IOARR (entidad); datosDoc: datos de Documentos;
 * gore: Gobierno Regional de la región del proyecto (entidades-gore.js).
 * @returns { datos, notas } notas = de dónde sale cada valor
 */
export function precargar({ M, radar = null, datosDoc = {}, gore = null }) {
  const datos = {}, notas = {};
  const poner = (k, v, nota) => { if (v != null && v !== '') { datos[k] = v; notas[k] = nota; } };
  poner('NOMBRE_IOARR', M?.nombre, 'Nombre de la IOARR del expediente (Documentos o nombre propuesto).');
  poner('CUI', M?.cui, 'CUI de la IOARR (Documentos o Radar IOARR).');
  // Gobierno Regional de la región del proyecto, salvo que Radar diga que la entidad es otra (p. ej. una municipalidad)
  if (gore && esEntidadGore(radar?.entidad)) {
    const lima = gore.region === 'Lima' ? ' Ojo: los colegios de Lima Metropolitana (UGEL 01 a 07) no dependen del Gobierno Regional de Lima.' : '';
    poner('ENTIDAD', gore.entidad, `Gobierno Regional de la región del proyecto.${lima}`);
    poner('ENTIDAD_RUC', gore.ruc, `${FUENTE_GORE} (sede central, ${gore.estado.toLowerCase()} y ${gore.condicion.toLowerCase()}). Verifícalo en SUNAT antes de exportar.`);
    poner('ENTIDAD_DOMICILIO', gore.domicilio, gore.fuente ? `Domicilio legal publicado por la entidad (${gore.fuente}). Confirma que sigue vigente.`
      : `Domicilio fiscal de la sede central (${FUENTE_GORE}). Confirma que es el domicilio legal que usa la entidad.`);
    poner('ENTIDAD_TELEFONO', gore.telefono, `Teléfono publicado por la entidad (${gore.fuente}). Confirma que sigue vigente.`);
    poner('PROVINCIA_NOTIFICACION', gore.provincia, 'Provincia de la sede del Gobierno Regional.');
    poner('CIUDAD_JURISDICCION', gore.ciudad, 'Ciudad de la sede del Gobierno Regional.');
  }
  poner('ENTIDAD', radar?.entidad, 'Entidad del registro de Radar IOARR vinculado.');
  poner('UF_NOMBRE', datosDoc?.uf, 'Unidad Formuladora (Documentos).');
  poner('COMPONENTE', 'Equipamiento', 'Supuesto: la reposición de mobiliario es del componente Equipamiento.');
  if (M?.F) {
    poner('MONTO_DOC_EQUIVALENTE', M.F.expediente || null, 'Documento equivalente de la estructura de costos del expediente.');
    poner('MONTO_EJECUCION', M.F.subtotalActivos || null, 'Costo directo con IGV (activos) de la estructura de costos.');
    poner('MONTO_SUP_EJECUCION', M.F.supervision || null, 'Supervisión de la estructura de costos (se asume que es la de la ejecución física).');
  }
  if (datosDoc?.plazo_unidad === 'dias' && datosDoc?.dias) poner('PLAZO_EJECUCION_DIAS', datosDoc.dias, 'Plazo de ejecución en días (Documentos).');
  return { datos, notas };
}
/** Lo del cálculo de la app que entra a las bases (se guarda con cada versión) */
export function contextoApp(M, nivel, nombreNivel) {
  return {
    nivel, nivel_nombre: nombreNivel, region: M?.region || '', escenario_texto: M?.escenarioTexto || '', kit: !!M?.kit,
    metas: (M?.F?.metas || []).map(m => ({ k: m.k, nombre: m.nombre, unidad: m.unidad, cantidad: m.cantidad, costo: m.costo })),
    total_07c: M?.F?.total ?? null, liquidacion: M?.F?.liquidacion ?? null, control: M?.F?.control ?? null,
    colegios: M?.ups?.length ?? 0, ugels: M?.ugels || [], borrador: !!(M?.borrador && M?.bloqueados?.length)
  };
}

// ─── Hoja de transparencia ──────────────────────────────────────────────────
/** Datos tomados de la app, supuestos y pendientes, para la primera página */
export function transparencia(d, ctx = {}, armado = armarTexto(d)) {
  const app = Object.entries(d._precarga || {}).filter(([k, v]) => !vacio(v) && d[k] === v)
    .map(([k, v]) => ({ campo: etiquetaDe(k), valor: POR_K[k]?.tipo === 'monto' ? 'S/ ' + formatoMonto(v) : String(v), fuente: d._precarga_notas?.[k] || 'Cálculo de la app' }));
  const Q = cuadroCantidades(d, ctx);
  if (Q.precio_catalogo && ctx.precio_ref?.precio != null)
    app.push({ campo: 'Precio por kit (Anexo 3-A)', valor: `S/ ${formatoMonto(ctx.precio_ref.precio)} sin IGV`,
      fuente: `Catálogo de precios referenciales de IOARR publicadas: ${ctx.precio_ref.modo === 'registro' ? 'una fuente' : `mediana de ${ctx.precio_ref.n} ${ctx.precio_ref.n === 1 ? 'fuente' : 'fuentes'}`}.` });
  if (Q.filas.length) app.push({ campo: 'Cantidades y precios unitarios (Anexo 3-A)', valor: Q.filas.map(f => `${f.nombre}: ${f.cantidad ?? '—'}`).join('; '), fuente: Q.texto });
  const supuestos = [
    `Las plantillas provienen de las bases del proceso 015-2026 (I.E. San Juan, La Libertad) y aplican el ${REGLAMENTO_PLANTILLAS}. Deben revisarse contra el documento original antes de publicar.`,
    'La Sección II, el Anexo 1 y los formatos son texto fijo: solo se sustituyeron los marcadores.',
    'El documento equivalente (Prestación 1) y su supervisión (Prestación 3) son obligatorios en esta IOARR.',
    `Una IOARR por nivel: estas bases corresponden al nivel ${ctx.nivel_nombre || '—'}.`,
    'El monto total es la suma del documento equivalente, la ejecución física y las dos supervisiones.',
    `La propuesta económica válida está entre ${PROPUESTA_MIN} % y ${PROPUESTA_MAX} % del monto referencial (Anexo 4-E)${armado.valores.MONTO_TOTAL ? `: de S/ ${formatoMonto(calcularMontos(d).min_bases)} a S/ ${formatoMonto(calcularMontos(d).max_bases)}` : ''}.`,
    'Las especificaciones técnicas salen de una biblioteca neutral: sin marcas ni referencias a un fabricante. Las normas técnicas las indicó y verificó el usuario.',
    'El Anexo 3-A se arma con los datos del proyecto (cronograma, cantidades y especificaciones); los demás términos de referencia los completa la entidad.',
    ...(ctx.total_07c != null && calcularMontos(d).total != null && Math.abs(calcularMontos(d).total - ctx.total_07c) >= 1
      ? [`El costo de inversión del expediente (S/ ${formatoMonto(ctx.total_07c)}) incluye conceptos sin fila en la tabla 1.5 (liquidación${ctx.control ? ', control concurrente' : ''}).`] : []),
    ...(ctx.borrador ? ['Las cantidades incluyen colegios con el checklist de inventario y baja incompleto (borrador del expediente).'] : []),
    ...(!d.nueva_convocatoria ? ['No es una nueva convocatoria: los textos de nueva convocatoria quedan marcados «NO APLICA».'] : [])
  ];
  const pendientes = [
    ...armado.faltan.map(k => `Dato sin completar: ${etiquetaDe(k)} ({{${k}}}).`),
    ...Object.keys(AVISOS_VERIFICAR).filter(k => d[k] !== true).map(k => `Sin confirmar: ${etiquetaDe(k).replace(/^Confirmé/, 'confirmar')}.`),
    'Revisar los avisos «[VERIFICAR …]» del texto con el Reglamento vigente y la entidad.',
    ...(armado.residuos.length ? [`Texto fijo con datos del proceso de origen (resaltado en turquesa): cláusula 6.2 del convenio, plazo de 210 días y cronograma referencial. Ajustarlo a esta IOARR (documento equivalente ${d.PLAZO_DOC_EQUIVALENTE_DIAS ?? '—'} días, ejecución ${d.PLAZO_EJECUCION_DIAS ?? '—'} días).`] : []),
    'Anexo 3-A: requisitos habilitantes, entregables y perfil del personal (los completa la entidad).',
    'Los campos entre corchetes de los formatos ([INDICAR …], [CONSIGNAR …]) los llena cada postor.'
  ];
  return { declaracion: DECLARACION, app, supuestos, pendientes };
}

// ─── Comparar dos versiones de la ficha ─────────────────────────────────────
const mostrar = (k, v) => {
  if (vacio(v) && v !== false) return '—';
  const c = POR_K[k];
  if (c?.tipo === 'monto') return 'S/ ' + formatoMonto(v);
  if (c?.tipo === 'fecha') return fechaCorta(v);
  if (c?.tipo === 'confirmacion' || c?.tipo === 'si_no') return v ? 'Sí' : 'No';
  if (c?.tipo === 'opcion') return c.opciones[v] || v;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};
/** Diferencias campo por campo (más montos calculados, cantidades UGEL y especificaciones) */
export function compararFichas(a = {}, b = {}) {
  const out = [];
  const conCalc = d => ({ ...d, MONTO_SUPERVISION_TOTAL: calcularMontos(d).supervision, MONTO_TOTAL: calcularMontos(d).total });
  const A = conCalc(a), B = conCalc(b);
  for (const c of CAMPOS) {
    if (JSON.stringify(A[c.k] ?? null) !== JSON.stringify(B[c.k] ?? null)) out.push({ k: c.k, campo: c.etiqueta, antes: mostrar(c.k, A[c.k]), despues: mostrar(c.k, B[c.k]) });
  }
  for (const k of TIPOS_BIEN) {
    const x = a.cantidades_ugel?.[k], y = b.cantidades_ugel?.[k];
    if ((x ?? null) !== (y ?? null)) out.push({ k: 'cantidades_ugel.' + k, campo: `Cantidad UGEL: ${ESPECIFICACIONES[k].nombre}`, antes: x ?? '—', despues: y ?? '—' });
    const s = a.especificaciones?.[k] || '', t = b.especificaciones?.[k] || '';
    if (s !== t) out.push({ k: 'especificaciones.' + k, campo: `Especificación: ${ESPECIFICACIONES[k].nombre}`, antes: s || '(biblioteca)', despues: t || '(biblioteca)' });
  }
  return out;
}
