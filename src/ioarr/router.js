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

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

const ESTADOS = ['viable', 'priorizada_oxi', 'convenio', 'en_proceso_seleccion', 'en_ejecucion',
  'bienes_entregados', 'ciprl_emitido', 'cerrada', 'descartada'];
const ETAPAS = ['detectada', 'evaluando', 'convenio', 'financiando', 'ciprl_emitido'];
const FUENTES = ['invierte_pe', 'proinversion', 'otro'];

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

// Ficha: proyecto + eventos + evaluaciones + contrapartes
router.get('/api/ioarr/proyectos/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const [p, ev, eva, cp] = await Promise.all([
      supabase.from('ioarr_proyectos').select('*').eq('id', id).maybeSingle(),
      supabase.from('ioarr_eventos').select('*').eq('proyecto_id', id).order('fecha', { ascending: false }),
      supabase.from('ioarr_evaluaciones').select('*').eq('proyecto_id', id).order('creado_en', { ascending: false }),
      supabase.from('ioarr_proyecto_contrapartes').select('contraparte:ioarr_contrapartes(*)').eq('proyecto_id', id)
    ]);
    for (const r of [p, ev, eva, cp]) if (r.error) throw r.error;
    if (!p.data) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json({ proyecto: p.data, eventos: ev.data, evaluaciones: eva.data, contrapartes: cp.data.map(x => x.contraparte) });
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
    const { headers, rows, fila_encabezado, hoja } = leido;
    const fuente = FUENTES.includes(req.body.fuente) ? req.body.fuente : 'otro';
    const guardado = await mapeoGuardado(fuente);
    const mapeo = aplicarMapeoGuardado(headers, detectarMapeo(headers), guardado);
    res.json({
      headers, mapeo, muestra: rows.slice(0, 5), total_filas: rows.length, campos: CAMPOS_MAPEABLES,
      fila_encabezado, hoja, usa_mapeo_guardado: !!guardado
    });
  } catch (e) { next(e); }
});

// Paso 2: importar con el mapeo confirmado (campos multipart: file, fuente, mapeo JSON, solo_ioarr)
router.post('/api/ioarr/importar', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Adjunta un archivo Excel o CSV' });
    const fuente = FUENTES.includes(req.body.fuente) ? req.body.fuente : 'otro';
    let mapeo;
    try { mapeo = JSON.parse(req.body.mapeo || '{}'); } catch { return res.status(400).json({ error: 'Mapeo inválido' }); }
    if (!mapeo.cui || !mapeo.nombre) return res.status(400).json({ error: 'Debes mapear al menos CUI y nombre' });

    const { rows } = leerArchivo(req.file.buffer);
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
    console.log(`[IOARR] Importación ${fuente} por ${req.usuario.email}:`, resumen);
    res.json({ ...resumen, filas_archivo: rows.length, filas_sin_cui_o_nombre: descartadas, filas_no_ioarr: noIoarr });
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
