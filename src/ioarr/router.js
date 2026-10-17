// ============================================================================
// src/ioarr/router.js — Módulo Radar IOARR (Fase 1, MVP)
// Seguimiento de IOARR de mobiliario escolar en Obras por Impuestos (OxI)
// desde la perspectiva del FINANCISTA.
//
// Integración en server.js (igual que Radar Infra):
//   import ioarrRouter from './ioarr/router.js';
//   app.use(ioarrRouter);   (antes del middleware de error)
//
// Todas las rutas /api/ioarr/* exigen sesión (Supabase Auth); ver auth.js.
// Información referencial: verificar con la DGPPIP del MEF o un abogado.
// ============================================================================

import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { supabase } from './db.js';
import { requireAuth } from './auth.js';
import { calcularRentabilidad } from './calculadora.js';
import { leerArchivo, detectarMapeo, aplicarMapeoGuardado, filaAProyecto, importarProyectos, normaliza, CAMPOS_MAPEABLES } from './ingesta.js';
import { sendIoarrDigest } from './alertas.js';
import { filaACarga, filtrarFilasPmi, guardarCarga, borrarCarga, obtenerDatosCruce, calcularCruce } from './cruce.js';
import { extraerLineasPdf, clasificarDocumento, leerFicha07C, leerTablaCostos, preciosUnicos, anioDeLineas, guardarPrecios } from './fichas.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
const uploadPdfs = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 10 } });
const BUCKET_DOCS = 'ioarr-docs';
const URL_FIRMADA_SEG = 10 * 60;

const ESTADOS = ['viable', 'priorizada_oxi', 'convenio', 'en_proceso_seleccion', 'en_ejecucion',
  'bienes_entregados', 'ciprl_emitido', 'cerrada', 'descartada'];
const ETAPAS = ['detectada', 'evaluando', 'convenio', 'financiando', 'ciprl_emitido'];
const FUENTES = ['invierte_pe', 'proinversion', 'pmi', 'otro'];
// Campos que se muestran en el mapeo según la fuente (el PMI: CUI, entidad y periodo, más
// función y tipo de inversión para sus filtros)
const CAMPOS_FUENTE = {
  pmi: ['cui', 'entidad', 'periodo', 'funcion', 'tipo_inversion'],
  proinversion: CAMPOS_MAPEABLES.filter(c => !['fuente_financiamiento', 'modalidad_ejecucion', 'pim', 'devengado', 'periodo'].includes(c)),
  invierte_pe: CAMPOS_MAPEABLES.filter(c => c !== 'periodo'),
  otro: CAMPOS_MAPEABLES.filter(c => c !== 'periodo')
};
const faltaMigracion = (e) => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');

// ─── Rutas públicas (sin sesión) ────────────────────────────────────────────
// Datos para que el navegador inicie sesión con Supabase Auth (clave pública)
router.get('/api/ioarr/config', (_, res) => res.json({
  supabaseUrl: process.env.SUPABASE_URL || null,
  supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || null
}));

// La misma calculadora del backend, servida al navegador para el cálculo en vivo
router.get('/ioarr/calculadora.js', (_, res) =>
  res.type('application/javascript').sendFile(fileURLToPath(new URL('./calculadora.js', import.meta.url))));

// ─── Desde aquí, todo exige sesión ──────────────────────────────────────────
router.use('/api/ioarr', requireAuth);

router.get('/api/ioarr/me', (req, res) => res.json(req.usuario));

// Valores para los filtros (regiones y funciones presentes en la base)
router.get('/api/ioarr/filtros', async (_, res, next) => {
  try {
    const { data, error } = await supabase.from('ioarr_proyectos').select('region, funcion').range(0, 19999);
    if (error) throw error;
    const unicos = (k) => [...new Set(data.map(r => r[k]).filter(Boolean))].sort();
    res.json({ regiones: unicos('region'), funciones: unicos('funcion'), estados: ESTADOS, etapas: ETAPAS });
  } catch (e) { next(e); }
});

// Listado con filtros: region, estado, funcion, mobiliario=1, sin_priorizar=1, min, max, q
router.get('/api/ioarr/proyectos', async (req, res, next) => {
  try {
    const { region, estado, funcion, mobiliario, sin_priorizar, min, max, q } = req.query;
    let query = supabase.from('ioarr_proyectos').select('*');
    if (region) query = query.eq('region', normaliza(region));
    if (estado) query = query.eq('estado', estado);
    if (funcion) query = query.eq('funcion', funcion);
    if (mobiliario === '1') query = query.eq('es_mobiliario', true);
    if (sin_priorizar === '1') query = query.eq('estado', 'viable');
    if (min) query = query.gte('monto_inversion', Number(min));
    if (max) query = query.lte('monto_inversion', Number(max));
    if (q) {
      const limpio = String(q).replace(/[,()%*\\]/g, ' ').trim();
      if (limpio) query = query.or(`cui.ilike.%${limpio}%,nombre.ilike.%${limpio}%`);
    }
    const { data, error } = await query.order('actualizado_en', { ascending: false }).limit(2000);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Ficha: proyecto + eventos + evaluaciones + contrapartes + documentos
router.get('/api/ioarr/proyectos/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const [p, ev, eva, cp, docs] = await Promise.all([
      supabase.from('ioarr_proyectos').select('*').eq('id', id).maybeSingle(),
      supabase.from('ioarr_eventos').select('*').eq('proyecto_id', id).order('fecha', { ascending: false }),
      supabase.from('ioarr_evaluaciones').select('*').eq('proyecto_id', id).order('creado_en', { ascending: false }),
      supabase.from('ioarr_proyecto_contrapartes').select('contraparte:ioarr_contrapartes(*)').eq('proyecto_id', id),
      supabase.from('ioarr_documentos').select('id, tipo, nombre_archivo, tamano, paginas, campos, avisos, creado_en')
        .eq('proyecto_id', id).order('creado_en', { ascending: false })
    ]);
    for (const r of [p, ev, eva, cp]) if (r.error) throw r.error;
    if (!p.data) return res.status(404).json({ error: 'Proyecto no encontrado' });
    // Sin la migración 004 la ficha sigue funcionando, solo sin documentos
    if (docs.error) console.warn('[IOARR] No se pudieron leer los documentos:', docs.error.message);
    res.json({
      proyecto: p.data, eventos: ev.data, evaluaciones: eva.data, contrapartes: cp.data.map(x => x.contraparte),
      documentos: docs.data || [], documentos_error: docs.error ? 'Falta ejecutar supabase/migrations/004_ioarr_documentos.sql' : null
    });
  } catch (e) { next(e); }
});

// Edición manual (estado oficial, etapa del kanban, notas, etc.). Registra eventos.
router.patch('/api/ioarr/proyectos/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    const { data: actual, error: e0 } = await supabase.from('ioarr_proyectos').select('*').eq('id', id).maybeSingle();
    if (e0) throw e0;
    if (!actual) return res.status(404).json({ error: 'Proyecto no encontrado' });

    const patch = {};
    if (b.estado !== undefined) {
      if (!ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Estado inválido' });
      patch.estado = b.estado;
    }
    if (b.etapa_financista !== undefined) {
      if (!ETAPAS.includes(b.etapa_financista)) return res.status(400).json({ error: 'Etapa inválida' });
      patch.etapa_financista = b.etapa_financista;
    }
    if (b.entidad_tipo !== undefined) {
      if (b.entidad_tipo && !['GORE', 'GL', 'GN'].includes(b.entidad_tipo)) return res.status(400).json({ error: 'Tipo de entidad inválido' });
      patch.entidad_tipo = b.entidad_tipo || null;
    }
    if (b.notas !== undefined) patch.notas = b.notas || null;
    if (b.url_fuente !== undefined) patch.url_fuente = b.url_fuente || null;
    if (b.es_mobiliario !== undefined) patch.es_mobiliario = !!b.es_mobiliario;
    if (!Object.keys(patch).length) return res.json(actual);

    const { data, error } = await supabase.from('ioarr_proyectos').update(patch).eq('id', id).select().single();
    if (error) throw error;

    const quien = req.usuario.email;
    const eventos = [];
    if (patch.estado && patch.estado !== actual.estado)
      eventos.push({ proyecto_id: id, tipo: 'cambio_estado', detalle: `${actual.estado} → ${patch.estado} (manual, ${quien})` });
    if (patch.etapa_financista && patch.etapa_financista !== actual.etapa_financista)
      eventos.push({ proyecto_id: id, tipo: 'hito', detalle: `Etapa financista: ${actual.etapa_financista} → ${patch.etapa_financista} (${quien})` });
    if (eventos.length) await supabase.from('ioarr_eventos').insert(eventos);
    res.json(data);
  } catch (e) { next(e); }
});

// Nota o hito manual en la línea de tiempo
router.post('/api/ioarr/proyectos/:id/eventos', async (req, res, next) => {
  try {
    const { tipo = 'nota', detalle } = req.body || {};
    if (!['nota', 'hito'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    if (!detalle?.trim()) return res.status(400).json({ error: 'Escribe el detalle' });
    const { data, error } = await supabase.from('ioarr_eventos')
      .insert({ proyecto_id: req.params.id, tipo, detalle: `${detalle.trim()} — ${req.usuario.email}` }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Calcula y guarda una evaluación de rentabilidad
router.post('/api/ioarr/proyectos/:id/evaluaciones', async (req, res, next) => {
  try {
    let r;
    try { r = calcularRentabilidad(req.body || {}); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    const { data, error } = await supabase.from('ioarr_evaluaciones')
      .insert({ ...r, proyecto_id: req.params.id, creado_por: req.usuario.id }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Vincula una contraparte (se reutiliza por RUC si ya existe)
router.post('/api/ioarr/proyectos/:id/contrapartes', async (req, res, next) => {
  try {
    const { ruc, nombre, tipo, riesgo_notas, historial } = req.body || {};
    if (!nombre?.trim()) return res.status(400).json({ error: 'Falta el nombre' });
    if (!['entidad', 'ejecutora', 'supervisora'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    const fila = { ruc: ruc?.trim() || null, nombre: nombre.trim(), tipo, riesgo_notas: riesgo_notas || null, historial: historial || null };
    const { data: cp, error } = fila.ruc
      ? await supabase.from('ioarr_contrapartes').upsert(fila, { onConflict: 'ruc' }).select().single()
      : await supabase.from('ioarr_contrapartes').insert(fila).select().single();
    if (error) throw error;
    const { error: e2 } = await supabase.from('ioarr_proyecto_contrapartes')
      .upsert({ proyecto_id: req.params.id, contraparte_id: cp.id }, { onConflict: 'proyecto_id,contraparte_id' });
    if (e2) throw e2;
    res.json(cp);
  } catch (e) { next(e); }
});

router.delete('/api/ioarr/proyectos/:id/contrapartes/:cid', async (req, res, next) => {
  try {
    const { error } = await supabase.from('ioarr_proyecto_contrapartes')
      .delete().eq('proyecto_id', req.params.id).eq('contraparte_id', req.params.cid);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─── Documentos del Banco de Inversiones (PDF subidos a mano) ───────────────
// El servidor NO consulta el portal del MEF: el usuario abre la consulta en su
// navegador, descarga el PDF y lo suelta en la ficha. Ver src/ioarr/fichas.js.

// multer 1.x entrega el nombre en latin1; los nombres con tildes llegan rotos
const nombreUtf8 = (n) => { try { return Buffer.from(n, 'latin1').toString('utf8'); } catch { return n; } };
const nombreSeguro = (n) => n.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-120);
const esPdf = (buf) => buf.subarray(0, 5).toString('latin1') === '%PDF-';
const ETIQUETA_TIPO = { ficha_07c: 'Ficha 07-C', estructura_costos: 'Estructura de costos', informe_sustento: 'Informe de sustento', otro: 'Otro' };
const fmtSoles = (n) => 'S/ ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Lee el PDF (puro, sin guardar nada): tipo, campos y avisos
async function analizarPdf(archivo, proyecto) {
  const nombre = nombreUtf8(archivo.originalname);
  if (!esPdf(archivo.buffer)) return { nombre, error: 'No es un PDF' };
  let leido;
  try { leido = await extraerLineasPdf(archivo.buffer); }
  catch (e) { return { nombre, error: 'No se pudo leer el PDF: ' + e.message }; }
  const { lineas, paginas } = leido;
  const tipo = clasificarDocumento(nombre, lineas);
  const r = { nombre, tipo, paginas, lineas, avisos: [], campos: null };

  if (tipo === 'ficha_07c') {
    const { campos, avisos } = leerFicha07C(lineas);
    r.campos = campos; r.avisos.push(...avisos);
    if (campos.cui && campos.cui !== proyecto.cui) {
      r.cuiDistinto = true;
      r.avisos.push(`La ficha es del CUI ${campos.cui} y este proyecto es el ${proyecto.cui}: se guardó el PDF pero no se actualizaron los datos.`);
    }
  } else if (tipo === 'estructura_costos') {
    const tabla = leerTablaCostos(lineas);
    const unicos = preciosUnicos(tabla.filas);
    r.precios = unicos.precios;
    r.campos = { filas: tabla.filas.length, precios_unicos: unicos.precios.length, filas_no_cuadran: tabla.filas.filter(f => !f.cuadra).length };
    if (!tabla.filas.length) r.avisos.push('No se reconoció la tabla de bienes (código, descripción, a, b, c, d, cantidad).');
    r.avisos.push(...tabla.avisos, ...unicos.avisos);
  }
  if (!lineas.length && tipo !== 'ficha_07c') r.avisos.push('El PDF no tiene texto (¿escaneado?): se guardó sin leer campos.');
  return r;
}

// Datos de la ficha 07-C → proyecto: completa los campos vacíos y guarda lo leído
async function aplicarFicha(proyecto, campos, documento_id) {
  const patch = { ficha_07c: { ...campos, documento_id, leido_en: new Date().toISOString() } };
  const vacio = (k) => proyecto[k] == null || proyecto[k] === '';
  if (vacio('monto_inversion') && campos.costo_total != null) patch.monto_inversion = campos.costo_total;
  if (vacio('funcion') && campos.funcion) patch.funcion = campos.funcion;
  if (vacio('entidad') && campos.uei) patch.entidad = campos.uei;
  for (const k of ['fuente_financiamiento', 'modalidad_ejecucion']) if (vacio(k) && campos[k]) patch[k] = campos[k];
  for (const [k, c] of [['region', 'departamento'], ['provincia', 'provincia'], ['distrito', 'distrito']])
    if (vacio(k) && campos[c]) patch[k] = normaliza(campos[c]);
  const { data, error } = await supabase.from('ioarr_proyectos').update(patch).eq('id', proyecto.id).select().single();
  if (error) throw error;
  return data;
}

// Sube uno o varios PDF (campo «files»), los clasifica por nombre y los lee.
// La ficha 07-C se procesa primero para que su año sirva a los precios.
const recibirPdfs = (req, res, next) => uploadPdfs.array('files', 10)(req, res, err => {
  if (!err) return next();
  const msg = { LIMIT_FILE_SIZE: 'Cada PDF puede pesar como máximo 40 MB', LIMIT_FILE_COUNT: 'Máximo 10 PDF por vez', LIMIT_UNEXPECTED_FILE: 'Máximo 10 PDF por vez' }[err.code];
  res.status(400).json({ error: msg || err.message });
});

router.post('/api/ioarr/proyectos/:id/documentos', recibirPdfs, async (req, res, next) => {
  try {
    const archivos = req.files || [];
    if (!archivos.length) return res.status(400).json({ error: 'Suelta al menos un PDF' });
    let { data: proyecto, error: e0 } = await supabase.from('ioarr_proyectos').select('*').eq('id', req.params.id).maybeSingle();
    if (e0) throw e0;
    if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado' });

    const analizados = await Promise.all(archivos.map(a => analizarPdf(a, proyecto).then(r => ({ ...r, archivo: a }))));
    const orden = { ficha_07c: 0, estructura_costos: 1 };
    analizados.sort((x, y) => (orden[x.tipo] ?? 2) - (orden[y.tipo] ?? 2));

    const resultados = [];
    for (const r of analizados) {
      const { archivo, lineas, precios, cuiDistinto, ...salida } = r;
      if (r.error) { resultados.push(salida); continue; }

      const ruta = `${proyecto.id}/${Date.now()}_${nombreSeguro(r.nombre)}`;
      const { error: eUp } = await supabase.storage.from(BUCKET_DOCS).upload(ruta, archivo.buffer, { contentType: 'application/pdf' });
      if (eUp) {
        resultados.push({ ...salida, error: `No se pudo guardar el PDF (${eUp.message}). ¿Se ejecutó supabase/migrations/004_ioarr_documentos.sql?` });
        continue;
      }

      let anio = null;
      if (r.tipo === 'estructura_costos') {
        anio = proyecto.ficha_07c?.anio ?? anioDeLineas(lineas);
        r.campos.anio = anio;
      }
      const costoFicha = r.tipo === 'ficha_07c' && !cuiDistinto ? r.campos.costo_total : null;
      if (costoFicha != null && proyecto.monto_inversion != null && Math.abs(Number(proyecto.monto_inversion) - costoFicha) > 0.01)
        r.avisos.push(`El monto del proyecto (${fmtSoles(proyecto.monto_inversion)}) difiere del costo total de la ficha (${fmtSoles(costoFicha)}); se mantiene el del proyecto.`);
      if (r.tipo === 'ficha_07c' && !cuiDistinto)
        for (const [k, nombre] of [['fuente_financiamiento', 'La fuente de financiamiento'], ['modalidad_ejecucion', 'La modalidad de ejecución']])
          if (r.campos[k] && proyecto[k] && normaliza(r.campos[k]) !== normaliza(proyecto[k]))
            r.avisos.push(`${nombre} del proyecto («${proyecto[k]}») difiere de la ficha («${r.campos[k]}»); se mantiene la del proyecto.`);
      const { data: doc, error: eDoc } = await supabase.from('ioarr_documentos').insert({
        proyecto_id: proyecto.id, tipo: r.tipo, nombre_archivo: r.nombre, ruta, tamano: archivo.size,
        paginas: r.paginas, campos: r.campos, avisos: r.avisos, subido_por: req.usuario.id
      }).select('id, tipo, nombre_archivo, tamano, paginas, campos, avisos, creado_en').single();
      if (eDoc) {
        await supabase.storage.from(BUCKET_DOCS).remove([ruta]);
        throw eDoc;
      }

      let detalle = `Documento subido: ${r.nombre} (${ETIQUETA_TIPO[r.tipo]})`;
      if (r.tipo === 'ficha_07c' && !cuiDistinto) {
        proyecto = await aplicarFicha(proyecto, r.campos, doc.id);
        if (r.campos.costo_total != null) detalle += ` · costo total ${fmtSoles(r.campos.costo_total)}`;
      }
      if (r.tipo === 'estructura_costos' && precios.length) {
        await guardarPrecios(supabase, precios, { cui_origen: proyecto.cui, anio_ficha: anio, documento_id: doc.id, fuente: r.nombre });
        detalle += ` · ${precios.length} precios de referencia` + (r.campos.filas_no_cuadran ? `, ${r.campos.filas_no_cuadran} filas no cuadran` : '');
      }
      await supabase.from('ioarr_eventos').insert({ proyecto_id: proyecto.id, tipo: 'hito', detalle: `${detalle} — ${req.usuario.email}` });
      resultados.push({ ...salida, documento: doc });
    }
    console.log(`[IOARR] ${archivos.length} PDF subidos al proyecto ${proyecto.cui} por ${req.usuario.email}`);
    res.json({ resultados });
  } catch (e) { next(e); }
});

// URL firmada de 10 minutos para abrir un documento del bucket privado
router.get('/api/ioarr/documentos/:docId/url', async (req, res, next) => {
  try {
    const { data: doc, error } = await supabase.from('ioarr_documentos').select('ruta').eq('id', req.params.docId).maybeSingle();
    if (error) throw error;
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
    const { data, error: e2 } = await supabase.storage.from(BUCKET_DOCS).createSignedUrl(doc.ruta, URL_FIRMADA_SEG);
    if (e2) throw e2;
    res.json({ url: data.signedUrl, expira_en_seg: URL_FIRMADA_SEG });
  } catch (e) { next(e); }
});

// Precios de referencia (de las estructuras de costos subidas); q = código o descripción
router.get('/api/ioarr/precios', async (req, res, next) => {
  try {
    let query = supabase.from('ioarr_precios_referencia').select('*');
    const limpio = String(req.query.q || '').replace(/[,()%*\\]/g, ' ').trim();
    if (limpio) query = query.or(`codigo_bien.ilike.%${limpio}%,descripcion.ilike.%${limpio}%,cui_origen.ilike.%${limpio}%`);
    const { data, error } = await query.order('codigo_bien').order('anio_ficha', { ascending: false }).limit(2000);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// ─── Importación (Excel/CSV) ────────────────────────────────────────────────
// Mapeo confirmado en la última importación de cada fuente (tabla ioarr_mapeos,
// migración 003). Si la tabla aún no existe, se sigue solo con el mapeo automático.
async function mapeoGuardado(fuente) {
  const { data, error } = await supabase.from('ioarr_mapeos').select('mapeo').eq('fuente', fuente).maybeSingle();
  if (error) { console.warn('[IOARR] No se pudo leer el mapeo guardado:', error.message); return null; }
  return data?.mapeo || null;
}

async function guardarMapeo(fuente, mapeo, usuario) {
  const { error } = await supabase.from('ioarr_mapeos')
    .upsert({ fuente, mapeo, actualizado_por: usuario.id, actualizado_en: new Date().toISOString() }, { onConflict: 'fuente' });
  if (error) console.warn('[IOARR] No se pudo guardar el mapeo:', error.message);
}

// Paso 1: previsualizar → encabezados, mapeo propuesto (automático + el recordado
// para la fuente) y primeras filas
router.post('/api/ioarr/importar/preview', upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Adjunta un archivo Excel o CSV' });
  let leido;
  try { leido = leerArchivo(req.file.buffer); }
  catch (e) { return res.status(400).json({ error: 'No se pudo leer el archivo: ' + e.message }); }
  try {
    const { headers, rows, fila_encabezado, hoja, opmi_detectada, periodo_detectado } = leido;
    const fuente = FUENTES.includes(req.body.fuente) ? req.body.fuente : 'otro';
    const guardado = await mapeoGuardado(fuente);
    const mapeo = aplicarMapeoGuardado(headers, detectarMapeo(headers), guardado);
    res.json({
      headers, mapeo, muestra: rows.slice(0, 5), total_filas: rows.length, campos: CAMPOS_FUENTE[fuente],
      fila_encabezado, hoja, usa_mapeo_guardado: !!guardado,
      ...(fuente === 'pmi' ? { opmi_detectada: opmiDelArchivo(leido, mapeo), periodo_detectado } : {})
    });
  } catch (e) { next(e); }
});

// OPMI de un archivo del PMI: la del encabezado o, si el archivo tiene columna de
// entidad con un único valor, ese valor
function opmiDelArchivo({ rows, opmi_detectada }, mapeo) {
  if (opmi_detectada) return opmi_detectada;
  if (!mapeo?.entidad) return null;
  const valores = [...new Set(rows.map(r => r[mapeo.entidad]).filter(v => v != null && String(v).trim()).map(v => String(v).trim()))];
  return valores.length === 1 ? valores[0] : null;
}
const MIGRACIONES_CRUCE = 'supabase/migrations/005_ioarr_cruce_fuentes.sql, 006_ioarr_filtros_carga.sql y 007_ioarr_pmi_opmi.sql';

// Paso 2: importar con el mapeo confirmado (campos multipart: file, fuente, mapeo JSON, solo_ioarr; PMI: opmi)
// Banco y Proinversión: actualizan los proyectos Y quedan como carga para el cruce.
// PMI: solo se guarda como carga (tabla ioarr_pmi); no crea proyectos.
router.post('/api/ioarr/importar', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Adjunta un archivo Excel o CSV' });
    const fuente = FUENTES.includes(req.body.fuente) ? req.body.fuente : 'otro';
    let mapeo;
    try { mapeo = JSON.parse(req.body.mapeo || '{}'); } catch { return res.status(400).json({ error: 'Mapeo inválido' }); }
    const nombreArchivo = nombreUtf8(req.file.originalname);

    if (fuente === 'pmi') {
      if (!mapeo.cui) return res.status(400).json({ error: 'Debes mapear al menos la columna de CUI' });
      const leido = leerArchivo(req.file.buffer);
      const { rows, hoja } = leido;
      // La OPMI dice de qué entidades es este PMI: sin ella no se puede decir que un proyecto está fuera
      const opmi = String(req.body.opmi || '').replace(/\s+/g, ' ').trim() || opmiDelArchivo(leido, mapeo);
      if (!opmi && !mapeo.entidad) return res.status(400).json({ error: 'Indica la OPMI de este PMI (p. ej. «OPMI DEL GOBIERNO REGIONAL LAMBAYEQUE»): no se encontró en el encabezado del archivo.' });
      // Se guardan en la carga para que el cruce sepa qué proyectos pudo contener
      const filtros = { solo_educacion: req.body.solo_educacion === '1', solo_ioarr: req.body.solo_ioarr === '1' };
      let filas, resumen;
      try {
        ({ filas, resumen } = filtrarFilasPmi(rows, mapeo, { soloEducacion: filtros.solo_educacion, soloIoarr: filtros.solo_ioarr, periodo: leido.periodo_detectado }));
      } catch (e) { return res.status(400).json({ error: e.message }); }
      if (!resumen.leidas || resumen.sin_cui === resumen.leidas)
        return res.status(400).json({ error: 'El archivo no tiene filas con CUI. Si no puedes importarlo, marca el PMI a mano en la pestaña Cruce.' });
      if (!filas.length) return res.status(400).json({ resumen, error: `Ninguna fila pasó los filtros y no se guardó nada: ${resumen.leidas} leídas, ` +
        `${resumen.sin_cui} sin CUI, ${resumen.no_educacion} no son Educación, ${resumen.no_ioarr} no son IOARR. Revisa el mapeo de Función / Tipo de inversión.` });
      let r;
      try { r = await guardarCarga(supabase, { fuente, filas, filtros, opmi, nombre_archivo: nombreArchivo, hoja, usuario_id: req.usuario.id }); }
      catch (e) {
        if (faltaMigracion(e)) return res.status(500).json({ error: `Falta ejecutar ${MIGRACIONES_CRUCE}` });
        throw e;
      }
      await guardarMapeo(fuente, mapeo, req.usuario);
      console.log(`[IOARR] Carga PMI «${opmi || 'por entidad de cada fila'}» por ${req.usuario.email}: ${r.filas} CUI (${JSON.stringify(resumen)})`);
      return res.json({ fuente, carga: r.carga, opmi, resumen, cuis: r.filas, filas_repetidas: r.filas_repetidas });
    }

    if (!mapeo.cui || !mapeo.nombre) return res.status(400).json({ error: 'Debes mapear al menos CUI y nombre' });

    const { rows, hoja } = leerArchivo(req.file.buffer);
    let proyectos = rows.map(r => filaAProyecto(r, mapeo, { fuente })).filter(Boolean);
    const descartadas = rows.length - proyectos.length;
    let noIoarr = 0;
    if (req.body.solo_ioarr === '1' && mapeo.tipo_inversion) {
      const antes = proyectos.length;
      proyectos = proyectos.filter(p => p.tipo_inversion === 'IOARR');
      noIoarr = antes - proyectos.length;
    }
    let resumen;
    try { resumen = await importarProyectos(supabase, proyectos, { fuente }); }
    catch (e) {
      // PGRST204: la base no tiene una columna que el código envía (falta aplicar una migración)
      if (e?.code === 'PGRST204' || /schema cache/i.test(e?.message || ''))
        return res.status(500).json({ error: `La base de datos no está actualizada (${e.message}). Ejecuta las migraciones de supabase/migrations.` });
      throw e;
    }
    await guardarMapeo(fuente, mapeo, req.usuario);

    // Carga para el cruce: el archivo completo (sin el filtro de IOARR), para
    // poder saber después qué CUI desaparecieron de una carga a otra
    let carga = null, carga_error = null;
    if (fuente === 'invierte_pe' || fuente === 'proinversion') {
      try {
        const r = await guardarCarga(supabase, { fuente, filas: rows.map(x => filaACarga(x, mapeo)).filter(Boolean),
          nombre_archivo: nombreArchivo, hoja, usuario_id: req.usuario.id });
        carga = { ...r.carga, filas_repetidas: r.filas_repetidas };
      } catch (e) {
        carga_error = faltaMigracion(e) ? 'No se guardó la carga para el cruce: falta ejecutar supabase/migrations/005_ioarr_cruce_fuentes.sql' : e.message;
        console.warn('[IOARR] No se pudo guardar la carga:', e.message);
      }
    }
    console.log(`[IOARR] Importación ${fuente} por ${req.usuario.email}:`, resumen);
    res.json({ ...resumen, filas_archivo: rows.length, filas_sin_cui_o_nombre: descartadas, filas_no_ioarr: noIoarr, carga, carga_error });
  } catch (e) { next(e); }
});

// ─── Cruce de fuentes ───────────────────────────────────────────────────────
// Calcula al vuelo la situación de cada CUI; no guarda ni cambia nada.
router.get('/api/ioarr/cruce', async (_, res, next) => {
  try {
    let datos;
    try { datos = await obtenerDatosCruce(supabase); }
    catch (e) {
      if (faltaMigracion(e)) return res.status(500).json({ error: `Falta ejecutar ${MIGRACIONES_CRUCE}` });
      throw e;
    }
    res.json({ ...calcularCruce(datos), generado_en: new Date().toISOString() });
  } catch (e) { next(e); }
});

// Borra una carga equivocada (y sus filas). Los proyectos que esa importación
// creó o actualizó no se tocan.
router.delete('/api/ioarr/cargas/:id', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Carga inválida' });
    const carga = await borrarCarga(supabase, req.params.id);
    if (!carga) return res.status(404).json({ error: 'La carga no existe (¿ya se borró?)' });
    console.log(`[IOARR] Carga ${carga.fuente} «${carga.nombre_archivo}» del ${carga.fecha_carga} borrada por ${req.usuario.email}`);
    res.json({ ok: true, carga });
  } catch (e) { next(e); }
});

// Marca manual del PMI (cuando el archivo no se pudo importar)
router.put('/api/ioarr/cruce/pmi/:cui', async (req, res, next) => {
  try {
    const { en_pmi, nota } = req.body || {};
    if (!['si', 'no', 'sin_verificar'].includes(en_pmi)) return res.status(400).json({ error: 'en_pmi debe ser si, no o sin_verificar' });
    const cui = String(req.params.cui).trim();
    if (!cui) return res.status(400).json({ error: 'Falta el CUI' });
    const { data, error } = await supabase.from('ioarr_pmi_manual').upsert({
      cui, en_pmi, nota: nota?.trim() || null, revisado_en: new Date().toISOString(), revisado_por: req.usuario.id
    }, { onConflict: 'cui' }).select().single();
    if (error) {
      if (faltaMigracion(error)) return res.status(500).json({ error: 'Falta ejecutar supabase/migrations/005_ioarr_cruce_fuentes.sql' });
      throw error;
    }
    res.json(data);
  } catch (e) { next(e); }
});

// ─── Alertas ────────────────────────────────────────────────────────────────
router.get('/api/ioarr/alertas/config', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('ioarr_alertas_config').select('*').eq('user_id', req.usuario.id).maybeSingle();
    if (error) throw error;
    res.json(data || { email: req.usuario.email, regiones: ['LAMBAYEQUE'], solo_mobiliario: false, activo: false });
  } catch (e) { next(e); }
});

router.put('/api/ioarr/alertas/config', async (req, res, next) => {
  try {
    const { email, regiones, solo_mobiliario, activo } = req.body || {};
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Correo inválido' });
    const fila = {
      user_id: req.usuario.id, email: email.trim(),
      regiones: (Array.isArray(regiones) ? regiones : []).map(normaliza).filter(Boolean),
      solo_mobiliario: !!solo_mobiliario, activo: !!activo
    };
    if (!fila.regiones.length) return res.status(400).json({ error: 'Marca al menos una región' });
    const { data, error } = await supabase.from('ioarr_alertas_config').upsert(fila, { onConflict: 'user_id' }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Envía ahora el resumen del usuario actual (prueba)
router.post('/api/ioarr/alertas/enviar', async (req, res, next) => {
  try { res.json(await sendIoarrDigest({ userId: req.usuario.id })); } catch (e) { next(e); }
});

export { sendIoarrDigest };
export default router;
