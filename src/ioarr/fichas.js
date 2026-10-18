// ============================================================================
// src/ioarr/fichas.js — Lectura de PDFs del Banco de Inversiones (Invierte.pe)
//
// El portal del MEF no se consulta desde el servidor (no responde fuera de
// Perú y no publica condiciones para acceso automatizado): el usuario descarga
// el PDF en su navegador y lo sube en la ficha del proyecto. Aquí se lee:
//   - Ficha del Formato 07-C (PDF «Exportación»)  → campos del proyecto
//   - Estructura de costos                        → tabla de bienes y precios
//   - Informe de sustento                         → solo se guarda
//
// Todo es puro (sin Supabase) salvo guardarPrecios(), que recibe el cliente.
// Los PDF exportados traen texto (no escaneado); si no hay texto, se avisa.
// ============================================================================

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { normaliza, parseMonto, limpiaCui } from './ingesta.js';

export const TIPOS_DOCUMENTO = ['ficha_07c', 'estructura_costos', 'informe_sustento', 'otro'];

// Costo unitario final: d = (a + b + c) × FACTOR_D
export const FACTOR_D = 1.15;

// ─── Texto del PDF agrupado en líneas ───────────────────────────────────────
// pdfjs devuelve fragmentos sueltos con su posición; se juntan los que comparten
// altura (±2.5 pt) para reconstruir las filas de las tablas. Cada línea conserva
// sus fragmentos con la coordenada x.
const TOLERANCIA_Y = 2.5;

export async function extraerLineasPdf(buffer) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, verbosity: 0
  }).promise;
  const lineas = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { items } = await page.getTextContent();
    const filas = [];
    for (const it of items) {
      const str = it.str?.trim();
      if (!str) continue;
      const x = it.transform[4], y = it.transform[5];
      let fila = filas.find(f => Math.abs(f.y - y) <= TOLERANCIA_Y);
      if (!fila) filas.push(fila = { y, items: [] });
      fila.items.push({ x, str });
    }
    filas.sort((a, b) => b.y - a.y);
    for (const f of filas) {
      f.items.sort((a, b) => a.x - b.x);
      lineas.push({ pagina: n, texto: f.items.map(i => i.str).join(' ').replace(/\s+/g, ' ') });
    }
    page.cleanup();
  }
  await pdf.destroy();
  return { paginas: pdf.numPages, lineas };
}

// ─── Clasificación ──────────────────────────────────────────────────────────
// Por nombre de archivo cuando es explícito; si es genérico (p. ej. el
// «…_Exportacion.pdf» del Banco de Inversiones, que vale para cualquier
// documento) o no dice nada, por el contenido.
export function clasificarDocumento(nombreArchivo, lineas = []) {
  const n = normaliza(nombreArchivo).replace(/[^A-Z0-9]+/g, ' ');
  if (/SUSTENTO|INFORME/.test(n)) return 'informe_sustento';
  if (/COSTO|PRESUPUESTO|ESTRUCTURA/.test(n)) return 'estructura_costos';
  if (/07 ?C|FORMATO|FICHA/.test(n)) return 'ficha_07c';
  const texto = normaliza(lineas.slice(0, 80).map(l => l.texto).join(' '));
  if (/07 ?-? ?C\b|REGISTRO DE IOARR/.test(texto)) return 'ficha_07c';
  if (leerTablaCostos(lineas).filas.filter(f => f.cuadra).length >= 3) return 'estructura_costos';
  if (/EXPORTACION|REGISTRO/.test(n)) return 'ficha_07c';
  return 'otro';
}

// ─── Formato 07-C ───────────────────────────────────────────────────────────
// Montos con separador de miles o dos decimales (no confunde años ni CUI)
const RE_MONTO = /(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{3})+,\d{1,2}|\d+\.\d{2})(?!\d)/;
const RE_FECHA = /\b(\d{2})\/(\d{2})\/(\d{4})\b/;

// Etiquetas en orden de preferencia (normalizadas: MAYÚSCULAS, sin tildes)
const ETIQUETAS_TEXTO = {
  nombre:              ['NOMBRE DE LA INVERSION', 'NOMBRE DE LA IOARR', 'NOMBRE DEL PROYECTO'],
  tipo_ioarr:          ['TIPO DE IOARR', 'TIPO DE INVERSION', 'NATURALEZA DE LA INTERVENCION'],
  unidad_formuladora:  ['UNIDAD FORMULADORA'],
  uei:                 ['UNIDAD EJECUTORA DE INVERSIONES', 'UNIDAD EJECUTORA DE INVERSION', 'UEI'],
  funcion:             ['FUNCION'],
  modalidad_ejecucion: ['MODALIDAD DE EJECUCION PREVISTA', 'MODALIDAD DE EJECUCION'],
  fuente_financiamiento: ['FUENTE DE FINANCIAMIENTO', 'FUENTES DE FINANCIAMIENTO'],
  departamento:        ['DEPARTAMENTO'],
  provincia:           ['PROVINCIA'],
  distrito:            ['DISTRITO']
};
const ETIQUETAS_COSTO_TOTAL = [
  'COSTO TOTAL DE LA INVERSION', 'COSTO DE INVERSION TOTAL', 'MONTO TOTAL DE LA INVERSION', 'MONTO TOTAL DE INVERSION',
  'COSTO TOTAL DE INVERSION', 'COSTO DE LA INVERSION', 'MONTO DE INVERSION', 'COSTO DE INVERSION'
];
const ETIQUETAS_FECHA = ['FECHA DE REGISTRO', 'FECHA DE APROBACION', 'FECHA DE CREACION', 'FECHA'];

// Resto de la línea tras la etiqueta, o la línea siguiente si la etiqueta va sola.
// La etiqueta se busca en la línea normalizada y el valor se copia de la original
// (con tildes); quitar tildes no cambia la longitud, salvo casos raros como «ß».
function valorTrasEtiqueta(lineas, lineasN, i, etiqueta) {
  const original = (k) => lineas[k].texto.length === lineasN[k].length ? lineas[k].texto : lineasN[k];
  const desde = lineasN[i].indexOf(etiqueta) + etiqueta.length;
  const resto = original(i).slice(desde).replace(/^[\s:.\-–]+/, '').trim();
  if (resto) return resto;
  return i + 1 < lineas.length ? original(i + 1).trim() || null : null;
}

function buscarTexto(lineas, lineasN, etiquetas) {
  for (const et of etiquetas) {
    const re = new RegExp(`(^|[^A-Z])${et}([^A-Z]|$)`);
    const i = lineasN.findIndex(l => re.test(l));
    if (i > -1) {
      const v = valorTrasEtiqueta(lineas, lineasN, i, et);
      if (v) return v.slice(0, 500);
    }
  }
  return null;
}

// Primer monto en la línea de la etiqueta o en las 3 siguientes
function buscarMonto(lineasN, etiquetas) {
  for (const et of etiquetas) {
    for (let i = 0; i < lineasN.length; i++) {
      const k = lineasN[i].indexOf(et);
      if (k < 0) continue;
      const tramo = [lineasN[i].slice(k + et.length), ...lineasN.slice(i + 1, i + 4)];
      for (const t of tramo) {
        const m = RE_MONTO.exec(t);
        if (m) return { valor: parseMonto(m[1]), etiqueta: et };
      }
    }
  }
  return null;
}

// «A ( ) B (X) C ( )» → «B»; un texto sin marcas queda igual; con marcas pero ninguna marcada → null
export function opcionMarcada(texto) {
  if (!texto || !/[(\[]\s*[Xx✓✔]?\s*[)\]]/.test(texto)) return texto;
  const re = /([^()[\]]+?)\s*[(\[]\s*([Xx✓✔]?)\s*[)\]]/g;
  const marcadas = [];
  for (let m; (m = re.exec(texto));) if (m[2]) marcadas.push(m[1].replace(/^[\s,;:\-–]+/, '').trim());
  return marcadas.length ? marcadas.join(', ') : null;
}

export function leerFicha07C(lineas) {
  const lineasN = lineas.map(l => normaliza(l.texto));
  const textoN = lineasN.join('\n');
  const campos = {};

  // CUI: 7 dígitos tras la etiqueta; si no, el primer número de 7 dígitos del documento
  const mCui = /CODIGO UNICO( DE INVERSION(ES)?)?\s*(N[°O.]*)?\s*:?\s*(\d{7})\b/.exec(textoN) || /\bCUI\s*:?\s*(\d{7})\b/.exec(textoN);
  campos.cui = limpiaCui(mCui ? mCui[mCui.length - 1] : (/\b(\d{7})\b/.exec(textoN)?.[1] ?? null));

  for (const [campo, etiquetas] of Object.entries(ETIQUETAS_TEXTO)) campos[campo] = buscarTexto(lineas, lineasN, etiquetas);
  // Si el formato lista las opciones y marca una («… POR CONTRATA ( ) OBRAS POR IMPUESTOS (X)»), queda la marcada
  for (const k of ['modalidad_ejecucion', 'fuente_financiamiento']) campos[k] = opcionMarcada(campos[k]);

  const costo = buscarMonto(lineasN, ETIQUETAS_COSTO_TOTAL);
  campos.costo_total = costo?.valor ?? null;
  campos.costo_total_etiqueta = costo?.etiqueta ?? null;

  let fecha = null;
  for (const et of ETIQUETAS_FECHA) {
    const i = lineasN.findIndex(l => l.includes(et) && RE_FECHA.test(l.slice(l.indexOf(et))));
    if (i > -1) { fecha = RE_FECHA.exec(lineasN[i].slice(lineasN[i].indexOf(et))); break; }
  }
  fecha = fecha || RE_FECHA.exec(textoN);
  campos.fecha = fecha ? `${fecha[3]}-${fecha[2]}-${fecha[1]}` : null;
  campos.anio = fecha ? Number(fecha[3]) : null;

  const faltan = ['cui', 'nombre', 'costo_total'].filter(k => campos[k] == null);
  const avisos = faltan.length ? [`No se encontró en el PDF: ${faltan.join(', ')}. Revisa el documento a mano.`] : [];
  if (lineas.length === 0) avisos.unshift('El PDF no tiene texto (¿escaneado?). Descarga la «Exportación» del Banco de Inversiones, que trae texto.');
  return { campos, avisos };
}

// ─── Estructura de costos: tabla de bienes ──────────────────────────────────
// Fila = código del bien, descripción y una serie final de números entre los
// que están a, b, c, d y la cantidad. El código puede ser:
//   - numérico SIGA (≥ 6 dígitos, puede llevar un N° de ítem delante), o
//   - alfanumérico de catálogo («SPM-03», «MCOMP-T1»), con los datos del local
//     o la institución educativa delante en la misma línea.
// Las columnas se ubican buscando 4 números seguidos con d = (a+b+c) × 1.15;
// si ninguna combinación cuadra, se asume el orden a, b, c, d, cantidad y la
// fila se marca como «no cuadra». Un «-» en la serie de números vale 0.
const RE_NUM = /^-?(\d{1,3}(,\d{3})+(\.\d+)?|\d{1,3}(\.\d{3})+,\d+|\d+([.,]\d+)?)$/;
const RE_CODIGO = /^\d{6,20}$|^\d{2,}(?:[.\-]\d{2,}){2,}$/;
export const RE_CODIGO_ALFA = /^[A-Z]{2,10}(?:-[A-Z0-9]{1,6})+$/;
const RE_ITEM = /^\d{1,3}(\.\d{1,3})*\.?$/;
const UNIDADES = new Set(['UND', 'UND.', 'UNID', 'UNIDAD', 'UNIDADES', 'U', 'JGO', 'JUEGO', 'MOD', 'MODULO', 'GLB', 'GLOBAL', 'KIT', 'PZA', 'PIEZA', 'SET', 'M2', 'ML', 'M']);
const RE_FIN_TABLA = /^(TOTAL|SUB ?TOTAL|COSTO DIRECTO|NOTA|FUENTE|ELABORAD)/;

const redondea = (n) => Math.round(n * 100) / 100;
export const dEsperado = (a, b, c) => redondea((a + b + c) * FACTOR_D);
// Tolerancia de redondeo: 2 céntimos o 0.01 % del valor
export const cuadra = (a, b, c, d) => Math.abs(d - (a + b + c) * FACTOR_D) <= Math.max(0.02, Math.abs(d) * 1e-4);
// cantidad × d ≈ costo total de la fila (d viene redondeado a céntimos)
const esTotal = (cantidad, d, total) => cantidad > 0 && Math.abs(cantidad * d - total) <= Math.max(0.1, total * 1e-3);
const esNumero = (t) => t === '-' || RE_NUM.test(t);
const numero = (t) => t === '-' ? 0 : parseMonto(t);

// modo 'alfa': el código es alfanumérico y puede ir después de otros datos
function parseFila(tokens, modo = 'num') {
  let t = [...tokens];
  if (modo === 'alfa') {
    const j = t.findIndex(x => RE_CODIGO_ALFA.test(x));
    if (j < 0) return null;
    t = t.slice(j);
  } else {
    if (t.length > 1 && RE_ITEM.test(t[0]) && !RE_CODIGO.test(t[0]) && RE_CODIGO.test(t[1])) t = t.slice(1);
    if (!RE_CODIGO.test(t[0])) return null;
  }
  const codigo = modo === 'alfa' ? t[0] : t[0].replace(/[.\-]/g, '');

  let k = t.length;
  while (k > 1 && esNumero(t[k - 1])) k--;
  const nums = t.slice(k).map(numero);
  if (nums.length < 4 || nums.some(n => n == null)) return null;
  const desc = t.slice(1, k);
  while (desc.length && UNIDADES.has(normaliza(desc[desc.length - 1]))) desc.pop();
  const descripcion = desc.join(' ').trim();
  if (!descripcion) return null;

  for (let i = 0; i + 3 < nums.length; i++) {
    const [a, b, c, d] = nums.slice(i, i + 4);
    if (d > 0 && cuadra(a, b, c, d)) {
      // Cantidad antes de a y costo total después de d: «cant a b c d total»
      const antes = i > 0 ? nums[i - 1] : null, despues = nums[i + 4] ?? null;
      const cantAntes = antes != null && despues != null && esTotal(antes, d, despues);
      const cantidad = cantAntes ? antes : (despues ?? antes);
      // Los números anteriores a esas columnas son parte de la descripción («… TIPO 1»)
      const resto = cantAntes ? t.slice(k, k + i - 1) : [];
      const desc2 = [descripcion, ...resto].join(' ');
      return { codigo_bien: codigo, descripcion: desc2, a, b, c, d, cantidad, cuadra: true };
    }
  }
  const [a, b, c, d, cantidad = null] = nums;
  return { codigo_bien: codigo, descripcion, a, b, c, d, cantidad, cuadra: false };
}

// La tabla usa códigos alfanuméricos si así se leen más filas que con los numéricos
function modoTabla(lineas) {
  let num = 0, alfa = 0;
  for (const l of lineas) {
    const tokens = l.texto.split(' ').filter(Boolean);
    if (!tokens.length) continue;
    if (parseFila(tokens, 'num')?.cuadra) num++;
    if (parseFila(tokens, 'alfa')?.cuadra) alfa++;
  }
  return alfa > num ? 'alfa' : 'num';
}

export function leerTablaCostos(lineas) {
  const modo = modoTabla(lineas);
  const filas = [];
  let ultima = null;
  for (const l of lineas) {
    const tokens = l.texto.split(' ').filter(Boolean);
    const fila = tokens.length ? parseFila(tokens, modo) : null;
    if (fila) { fila.pagina = l.pagina; filas.push(fila); ultima = fila; continue; }
    // Descripción partida en varias líneas: texto sin números justo debajo de una fila.
    // En las tablas con código de catálogo las descripciones son cortas y lo que
    // queda suelto entre filas son nombres de colegios: no se pega.
    const n = normaliza(l.texto);
    if (modo === 'num' && ultima && ultima.pagina === l.pagina && n && !/\d/.test(n) && !RE_FIN_TABLA.test(n) && n.length < 120
        && ultima.descripcion.length < 300) {
      ultima.descripcion += ' ' + l.texto.trim();
    } else {
      ultima = null;
    }
  }

  const avisos = filas.filter(f => !f.cuadra).map(f =>
    `Pág. ${f.pagina}, código ${f.codigo_bien}: d = ${f.d} pero (a+b+c) × ${FACTOR_D} = ${dEsperado(f.a, f.b, f.c)}`);
  return { filas, avisos };
}

// Precios únicos por código. Si un código aparece con precios distintos se
// queda el más repetido (el primero, si empatan) y se avisa; la cantidad se suma.
export function preciosUnicos(filas) {
  const grupos = new Map();
  for (const f of filas) {
    if (!grupos.has(f.codigo_bien)) grupos.set(f.codigo_bien, []);
    grupos.get(f.codigo_bien).push(f);
  }
  const precios = [], avisos = [];
  for (const [codigo, g] of grupos) {
    const firma = (f) => [f.a, f.b, f.c, f.d].join('|');
    const conteo = new Map();
    g.forEach(f => conteo.set(firma(f), (conteo.get(firma(f)) || 0) + 1));
    const elegida = [...conteo.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const base = g.find(f => firma(f) === elegida);
    if (conteo.size > 1) avisos.push(`Código ${codigo} aparece con ${conteo.size} precios distintos; se guardó d = ${base.d} (el más repetido).`);
    const cantidades = g.map(f => f.cantidad).filter(n => n != null);
    precios.push({
      codigo_bien: codigo, descripcion: base.descripcion, a: base.a, b: base.b, c: base.c, d: base.d,
      cantidad: cantidades.length ? redondea(cantidades.reduce((s, n) => s + n, 0)) : null,
      cuadra: base.cuadra
    });
  }
  return { precios, avisos };
}

// Año del documento: primera fecha dd/mm/aaaa del texto
export function anioDeLineas(lineas) {
  for (const l of lineas.slice(0, 200)) {
    const m = RE_FECHA.exec(l.texto);
    if (m) return Number(m[3]);
  }
  return null;
}

// ─── Persistencia ───────────────────────────────────────────────────────────
// Upsert por (cui_origen, codigo_bien): volver a subir el mismo PDF actualiza.
export async function guardarPrecios(supabase, precios, { cui_origen, anio_ficha, documento_id, fuente }) {
  const filas = precios.map(p => ({ ...p, cui_origen, anio_ficha, documento_id, fuente, actualizado_en: new Date().toISOString() }));
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await supabase.from('ioarr_precios_referencia')
      .upsert(filas.slice(i, i + 500), { onConflict: 'cui_origen,codigo_bien' });
    if (error) throw error;
  }
  return filas.length;
}

// Borra un documento subido: los precios de referencia que aún vienen de él, la
// ficha 07-C leída de él, sus fragmentos del chat (on delete cascade) y el PDF
// del bucket. Los campos del proyecto que la ficha completó (monto, función…)
// no se deshacen. Devuelve null si el documento no existe.
export async function borrarDocumento(supabase, id, bucket) {
  const { data: doc, error } = await supabase.from('ioarr_documentos')
    .select('id, proyecto_id, tipo, nombre_archivo, ruta').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!doc) return null;

  const { data: precios, error: e1 } = await supabase.from('ioarr_precios_referencia').delete().eq('documento_id', id).select('id');
  if (e1) throw e1;
  const { data: proyecto, error: e2 } = await supabase.from('ioarr_proyectos').select('id, ficha_07c').eq('id', doc.proyecto_id).maybeSingle();
  if (e2) throw e2;
  const fichaQuitada = proyecto?.ficha_07c?.documento_id === id;
  if (fichaQuitada) {
    const { error: e3 } = await supabase.from('ioarr_proyectos').update({ ficha_07c: null }).eq('id', proyecto.id);
    if (e3) throw e3;
  }
  const { error: e4 } = await supabase.from('ioarr_documentos').delete().eq('id', id);
  if (e4) throw e4;
  // El PDF al final: si falla, queda suelto en el bucket pero la ficha ya está limpia
  const { error: e5 } = await supabase.storage.from(bucket).remove([doc.ruta]);
  return { ...doc, precios_borrados: precios?.length ?? 0, ficha_quitada: fichaQuitada, error_pdf: e5?.message ?? null };
}
