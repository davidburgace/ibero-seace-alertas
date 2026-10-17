// ============================================================================
// src/ioarr/ia.js — IA sobre los PDF del proyecto (mismo stack que el radar SEACE: OpenAI)
//
// 1. Lectura de respaldo: si la lectura por reglas (fichas.js) no encuentra un
//    dato de la ficha 07-C o la tabla de costos, se le pide a la IA. Lo que
//    devuelve SOLO se acepta si una regla lo valida contra el texto del PDF:
//    el valor tiene que aparecer en el documento y, en los costos, cada fila
//    tiene que cumplir d = (a + b + c) × 1.15. Lo demás se descarta con aviso.
// 2. Chat «Preguntar a los documentos»: el texto de cada PDF se guarda en
//    fragmentos con embedding (ioarr_doc_chunks, migración 009) y la respuesta
//    se arma solo con los fragmentos más parecidos a la pregunta, citando
//    archivo y página.
//
// Sin OPENAI_API_KEY todo esto se omite y la app funciona igual que antes.
// Las funciones puras (validar*, trocear, armar*) no llaman a la API.
// ============================================================================

import { normaliza, parseMonto, limpiaCui } from './ingesta.js';
import { cuadra, dEsperado, FACTOR_D } from './fichas.js';

export const MODELO_LECTURA = process.env.IOARR_IA_MODELO_LECTURA || 'gpt-4o-mini';
export const MODELO_CHAT = process.env.IOARR_IA_MODELO_CHAT || 'gpt-4o';
export const MODELO_EMBEDDING = 'text-embedding-3-small';
const MAX_TEXTO_LECTURA = 60000;   // caracteres que se mandan a la IA para leer un PDF
const TAM_FRAGMENTO = 2000;        // caracteres por fragmento del chat
const FRAGMENTOS_POR_PREGUNTA = 8;

// Cliente de OpenAI perezoso (null si no hay clave)
let clienteCache;
export async function clienteIA() {
  if (clienteCache !== undefined) return clienteCache;
  if (!process.env.OPENAI_API_KEY) return (clienteCache = null);
  const { default: OpenAI } = await import('openai');
  return (clienteCache = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
}
export const iaDisponible = () => !!process.env.OPENAI_API_KEY;

// ─── Texto del PDF ──────────────────────────────────────────────────────────
// Líneas de extraerLineasPdf() → texto con marcas de página
export function textoConPaginas(lineas, max = Infinity) {
  let out = '', pag = null;
  for (const l of lineas) {
    if (l.pagina !== pag) { pag = l.pagina; out += `\n[Página ${pag}]\n`; }
    out += l.texto + '\n';
    if (out.length > max) return out.slice(0, max);
  }
  return out.trim();
}

const compacto = (t) => normaliza(t).replace(/[^A-Z0-9]/g, '');
const digitos = (t) => String(t ?? '').replace(/\D/g, '');

// ¿El texto aparece en el PDF? (sin tildes, mayúsculas, ni espacios o signos)
export function apareceTexto(valor, lineas) {
  const v = compacto(valor);
  if (v.length < 3) return false;
  return compacto(lineas.map(l => l.texto).join(' ')).includes(v);
}
// ¿El monto aparece escrito como cifra en alguna línea del PDF? (1,234.50 / 1.234,50 / 1234.5)
export function apareceMonto(valor, lineas) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return false;
  return lineas.some(l => (l.texto.match(/\d[\d.,]*/g) || []).some(t => {
    const x = parseMonto(t.replace(/[.,]$/, ''));
    return x != null && Math.abs(x - n) < 0.005;
  }));
}

// ─── 1a. Ficha 07-C ─────────────────────────────────────────────────────────
export const CAMPOS_FICHA_IA = ['cui', 'nombre', 'costo_total', 'tipo_ioarr', 'unidad_formuladora', 'uei', 'funcion',
  'modalidad_ejecucion', 'fuente_financiamiento', 'departamento', 'provincia', 'distrito', 'fecha'];
// Si falta alguno de estos tras la lectura por reglas, se intenta con IA
export const CAMPOS_FICHA_CLAVE = ['cui', 'nombre', 'costo_total', 'modalidad_ejecucion', 'fuente_financiamiento'];

export function promptFicha(texto) {
  return `Eres un lector de documentos del sistema Invierte.pe (Perú). Del texto de una ficha del Formato 07-C (registro de IOARR) extrae los datos.
Reglas:
- Copia los textos TAL COMO aparecen en el documento (no resumas, no traduzcas, no corrijas).
- Si un dato no aparece en el texto, usa null. No lo deduzcas ni lo inventes.
- Si la modalidad o la fuente aparecen como lista de opciones, devuelve solo la(s) marcada(s).
- "costo_total": el costo total de la inversión en soles, como número (sin separador de miles).
- "fecha": la fecha de registro en formato AAAA-MM-DD.
Responde SOLO con JSON con estas claves: ${CAMPOS_FICHA_IA.join(', ')}.

TEXTO DE LA FICHA:
${texto}`;
}

// Valida lo que propuso la IA contra el PDF. Devuelve los campos aceptados y avisos.
export function validarFichaIA(propuesta, lineas) {
  const aceptados = {}, descartados = [];
  for (const k of CAMPOS_FICHA_IA) {
    let v = propuesta?.[k];
    if (v == null || v === '') continue;
    let ok;
    if (k === 'cui') { v = limpiaCui(v); ok = /^\d{7}$/.test(v || '') && lineas.some(l => new RegExp(`(^|\\D)${v}(\\D|$)`).test(l.texto)); }
    else if (k === 'costo_total') { v = typeof v === 'number' ? v : parseMonto(v); ok = apareceMonto(v, lineas); }
    else if (k === 'fecha') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
      ok = !!m && lineas.some(l => l.texto.includes(`${m[3]}/${m[2]}/${m[1]}`));
    } else { v = String(v).replace(/\s+/g, ' ').trim().slice(0, 500); ok = apareceTexto(v, lineas); }
    if (ok) aceptados[k] = v; else descartados.push(k);
  }
  return { aceptados, descartados };
}

// Completa con lo aceptado de la IA solo los campos que las reglas no encontraron
export function completarFicha(campos, aceptados) {
  const out = { ...campos }, usados = [];
  for (const [k, v] of Object.entries(aceptados)) {
    if (out[k] == null || out[k] === '') { out[k] = v; usados.push(k); }
  }
  if (usados.includes('fecha')) out.anio = Number(out.fecha.slice(0, 4));
  if (usados.includes('costo_total')) out.costo_total_etiqueta = 'leído con IA';
  if (usados.length) out.leido_con_ia = usados;
  return { campos: out, usados };
}

const ETIQUETA_CAMPO = {
  cui: 'CUI', nombre: 'nombre', costo_total: 'costo total', tipo_ioarr: 'tipo', unidad_formuladora: 'unidad formuladora', uei: 'UEI',
  funcion: 'función', modalidad_ejecucion: 'modalidad de ejecución', fuente_financiamiento: 'fuente de financiamiento',
  departamento: 'departamento', provincia: 'provincia', distrito: 'distrito', fecha: 'fecha'
};
export const etiquetasCampos = (ks) => ks.map(k => ETIQUETA_CAMPO[k] || k).join(', ');

async function pedirJson(ia, prompt) {
  const r = await ia.chat.completions.create({
    model: MODELO_LECTURA, temperature: 0, response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }]
  });
  return JSON.parse(r.choices[0].message.content);
}

// Lectura de respaldo de la ficha: devuelve { campos, avisos } (los avisos se suman a los de las reglas)
export async function respaldoFicha(campos, lineas, ia) {
  const faltan = CAMPOS_FICHA_CLAVE.filter(k => campos[k] == null || campos[k] === '');
  if (!faltan.length || !lineas.length || !ia) return { campos, avisos: [] };
  let propuesta;
  try { propuesta = await pedirJson(ia, promptFicha(textoConPaginas(lineas, MAX_TEXTO_LECTURA))); }
  catch (e) { return { campos, avisos: [`No se pudo leer con IA: ${e.message}`] }; }
  const { aceptados, descartados } = validarFichaIA(propuesta, lineas);
  const { campos: completos, usados } = completarFicha(campos, aceptados);
  const avisos = [];
  if (usados.length) avisos.push(`🤖 Leído con IA y verificado en el texto del PDF: ${etiquetasCampos(usados)}. Revísalo.`);
  const descartadosQueFaltaban = descartados.filter(k => completos[k] == null);
  if (descartadosQueFaltaban.length)
    avisos.push(`🤖 La IA propuso ${etiquetasCampos(descartadosQueFaltaban)}, pero no aparece así en el PDF: se descartó.`);
  return { campos: completos, avisos };
}

// ─── 1b. Estructura de costos ───────────────────────────────────────────────
export function promptCostos(texto) {
  return `Eres un lector de documentos del sistema Invierte.pe (Perú). Del texto de una estructura de costos extrae la tabla de bienes.
Cada bien tiene: código del bien (número largo), descripción, los costos unitarios a, b, c, el costo final d y la cantidad.
Reglas:
- Copia el código y la descripción TAL COMO aparecen; los números sin separador de miles.
- Una fila por cada fila de la tabla (si un código se repite, repítela). No incluyas totales ni subtotales.
- Si un valor no aparece, usa null. No inventes filas.
Responde SOLO con JSON: {"filas": [{"codigo_bien": "...", "descripcion": "...", "a": 0, "b": 0, "c": 0, "d": 0, "cantidad": 0, "pagina": 1}]}

TEXTO:
${texto}`;
}

// Acepta una fila de la IA si su código y su d aparecen en el PDF; marca si cuadra d = (a+b+c)×1.15
export function validarCostosIA(propuesta, lineas) {
  const filas = [], descartadas = [];
  const textoCodigos = lineas.map(l => digitos(l.texto)).join(' ');
  for (const f of propuesta?.filas || []) {
    const codigo = digitos(f.codigo_bien);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(k => typeof f[k] === 'number' ? f[k] : parseMonto(f[k]));
    const desc = String(f.descripcion || '').replace(/\s+/g, ' ').trim();
    if (codigo.length < 6 || !textoCodigos.includes(codigo) || ![a, b, c, d].every(Number.isFinite) || !desc || !apareceMonto(d, lineas)) {
      descartadas.push(codigo || '¿sin código?'); continue;
    }
    const cantidad = f.cantidad == null ? null : (typeof f.cantidad === 'number' ? f.cantidad : parseMonto(f.cantidad));
    filas.push({ codigo_bien: codigo, descripcion: desc.slice(0, 500), a, b, c, d, cantidad, cuadra: cuadra(a, b, c, d),
      pagina: Number.isInteger(f.pagina) ? f.pagina : null, leido_con_ia: true });
  }
  const avisos = filas.filter(f => !f.cuadra).map(f =>
    `🤖 Código ${f.codigo_bien} (leído con IA): d = ${f.d} pero (a+b+c) × ${FACTOR_D} = ${dEsperado(f.a, f.b, f.c)}`);
  return { filas, descartadas, avisos };
}

// Si las reglas no leyeron la tabla (o la mayoría no cuadra), se intenta con IA y
// se queda la lectura con más filas que cuadran.
export async function respaldoCostos(tabla, lineas, ia) {
  const cuadranReglas = tabla.filas.filter(f => f.cuadra).length;
  const necesita = lineas.length && (tabla.filas.length === 0 || cuadranReglas < tabla.filas.length / 2);
  if (!necesita || !ia) return { tabla, usada: false, avisos: [] };
  let propuesta;
  try { propuesta = await pedirJson(ia, promptCostos(textoConPaginas(lineas, MAX_TEXTO_LECTURA))); }
  catch (e) { return { tabla, usada: false, avisos: [`No se pudo leer con IA: ${e.message}`] }; }
  const v = validarCostosIA(propuesta, lineas);
  const cuadranIA = v.filas.filter(f => f.cuadra).length;
  if (cuadranIA <= cuadranReglas)
    return { tabla, usada: false, avisos: v.filas.length ? ['🤖 Se probó leer la tabla con IA, pero no mejoró la lectura por reglas.'] : [] };
  const avisos = [`🤖 Tabla leída con IA: ${v.filas.length} filas verificadas en el PDF (${cuadranIA} cuadran con d = (a+b+c) × ${FACTOR_D}). Revísala.`, ...v.avisos];
  if (v.descartadas.length) avisos.push(`🤖 Se descartaron ${v.descartadas.length} filas que la IA propuso y no aparecen en el PDF.`);
  return { tabla: { filas: v.filas, avisos: [] }, usada: true, avisos };
}

// ─── 2. Chat sobre los documentos ───────────────────────────────────────────
// Fragmentos de ~2000 caracteres que no cortan líneas, con la página de inicio
// y fin; cada uno repite la última línea del anterior para no perder contexto.
export function trocear(lineas, tam = TAM_FRAGMENTO) {
  const out = [];
  let actual = null;
  const cerrar = () => { if (actual && actual.content.trim()) out.push(actual); };
  for (const l of lineas) {
    const texto = l.texto.trim();
    if (!texto) continue;
    if (!actual) actual = { content: '', pagina_desde: l.pagina, pagina_hasta: l.pagina, ultima: '' };
    if (actual.content.length + texto.length + 1 > tam && actual.content) {
      const solape = actual.ultima;
      cerrar();
      actual = { content: solape ? solape + '\n' : '', pagina_desde: l.pagina, pagina_hasta: l.pagina, ultima: '' };
    }
    if (l.pagina !== actual.pagina_hasta || !actual.content) actual.content += `[Página ${l.pagina}] `;
    actual.content += texto + '\n';
    actual.pagina_hasta = l.pagina;
    actual.ultima = texto;
  }
  cerrar();
  return out.map(({ ultima, ...f }, i) => ({ ...f, chunk_index: i, content: f.content.trim() }));
}

async function embeddings(ia, textos) {
  const out = [];
  for (let i = 0; i < textos.length; i += 100) {
    const r = await ia.embeddings.create({ model: MODELO_EMBEDDING, input: textos.slice(i, i + 100).map(t => t.slice(0, 8000)) });
    out.push(...r.data.map(d => d.embedding));
  }
  return out;
}

// Guarda los fragmentos de un documento con su embedding y marca el documento
// como indexado (aunque no tenga texto, para no reintentar). Devuelve cuántos.
export async function indexarDocumento(supabase, ia, { documento_id, proyecto_id, lineas }) {
  const fragmentos = trocear(lineas);
  await supabase.from('ioarr_doc_chunks').delete().eq('documento_id', documento_id);
  if (fragmentos.length) {
    const vectores = await embeddings(ia, fragmentos.map(f => f.content));
    const filas = fragmentos.map((f, i) => ({ ...f, documento_id, proyecto_id, embedding: vectores[i] }));
    for (let i = 0; i < filas.length; i += 200) {
      const { error } = await supabase.from('ioarr_doc_chunks').insert(filas.slice(i, i + 200));
      if (error) throw error;
    }
  }
  const { error } = await supabase.from('ioarr_documentos')
    .update({ indexado_en: new Date().toISOString(), fragmentos: fragmentos.length }).eq('id', documento_id);
  if (error) throw error;
  return fragmentos.length;
}

const soles = (n) => n == null ? 'sin dato' : 'S/ ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function promptChat(proyecto, fragmentos, pregunta, nombres) {
  const f = proyecto.ficha_07c || {};
  const datos = [
    `CUI: ${proyecto.cui}`, `Nombre: ${proyecto.nombre}`, `Entidad: ${proyecto.entidad || 'sin dato'}`,
    `Ubicación: ${[proyecto.region, proyecto.provincia, proyecto.distrito].filter(Boolean).join(' / ') || 'sin dato'}`,
    `Monto de inversión: ${soles(proyecto.monto_inversion)}`, `Estado en el radar: ${proyecto.estado}`,
    proyecto.modalidad_ejecucion && `Modalidad de ejecución: ${proyecto.modalidad_ejecucion}`,
    proyecto.fuente_financiamiento && `Fuente de financiamiento: ${proyecto.fuente_financiamiento}`,
    f.costo_total != null && `Costo total según la ficha 07-C: ${soles(f.costo_total)}`
  ].filter(Boolean).join('\n');
  const contexto = fragmentos.map((c, i) => {
    const pags = c.pagina_desde === c.pagina_hasta ? `pág. ${c.pagina_desde}` : `págs. ${c.pagina_desde}–${c.pagina_hasta}`;
    return `[${i + 1}] ${nombres.get(c.documento_id) || 'documento'}, ${pags}\n${c.content}`;
  }).join('\n\n---\n\n');
  return `Eres un asistente de Grupo Ibero Perú (fabricante de mobiliario escolar) que evalúa inversiones IOARR para financiarlas por Obras por Impuestos.
Responde en español la pregunta sobre este proyecto usando SOLO los fragmentos de sus documentos (fichas del Banco de Inversiones, estructuras de costos, informes).
Reglas:
- Cita cada dato con el número del fragmento entre corchetes, p. ej. [2].
- Si la respuesta no está en los fragmentos, dilo claramente («No aparece en los documentos subidos») y no la deduzcas.
- Para cantidades y montos, copia las cifras del documento; si sumas o calculas algo, muestra la operación.
- Sé breve y práctico.

DATOS DEL PROYECTO (del radar):
${datos}

FRAGMENTOS DE LOS DOCUMENTOS:
${contexto || '(ninguno)'}

PREGUNTA: ${pregunta}`;
}

export async function preguntar(supabase, ia, { proyecto, pregunta, documentos }) {
  const [vector] = await embeddings(ia, [pregunta]);
  const { data: fragmentos, error } = await supabase.rpc('ioarr_match_chunks', {
    query_embedding: vector, p_proyecto_id: proyecto.id, match_count: FRAGMENTOS_POR_PREGUNTA
  });
  if (error) throw error;
  const nombres = new Map(documentos.map(d => [d.id, d.nombre_archivo]));
  const r = await ia.chat.completions.create({
    model: MODELO_CHAT, temperature: 0.2, max_tokens: 1500,
    messages: [{ role: 'user', content: promptChat(proyecto, fragmentos || [], pregunta, nombres) }]
  });
  const fuentes = (fragmentos || []).map((c, i) => ({
    n: i + 1, documento_id: c.documento_id, nombre_archivo: nombres.get(c.documento_id) || null,
    pagina_desde: c.pagina_desde, pagina_hasta: c.pagina_hasta, similitud: Math.round(c.similitud * 1000) / 1000
  }));
  return { respuesta: r.choices[0].message.content, fuentes, modelo: MODELO_CHAT };
}
