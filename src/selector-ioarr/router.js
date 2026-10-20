// ============================================================================
// src/selector-ioarr/router.js — Módulo Selector IOARR
// Selección de locales escolares para un estudio de reposición de mobiliario
// (IOARR, Formato 07-C) con datos del Padrón ESCALE y el Censo Educativo.
//
// Integración en server.js:
//   import selectorRouter, { datosSelector } from './selector-ioarr/router.js';
//   app.use(datosSelector);     (ANTES de express.static: gzip + caché larga)
//   app.use(selectorRouter);    (antes del middleware de error)
//
// /api/selector-ioarr/* queda bajo crearProteccionApi(): sesión y rol proveedor.
// Proyectos y locales en Supabase: supabase/migrations/011_ioarr_selector.sql
// ============================================================================

import express from 'express';
import compression from 'compression';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { supabase } from '../ioarr/db.js';
import { prep, calc, limpiarParams } from './calculo.js';
import { generarExcel } from './excel.js';

export const ANIO_DATOS = 2025;
const DIR_DATOS = fileURLToPath(new URL('../public/data/selector-ioarr/', import.meta.url));
const MAX_LOCALES = 50000;
const LOTE = 1000;

const faltaMigracion = (e) => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
const AVISO_MIGRACION = 'Falta ejecutar supabase/migrations/011_ioarr_selector.sql en Supabase';

// ─── Datos estáticos: /data/selector-ioarr/<año>/<región>.json ─────────────
// Públicos (datos abiertos de ESCALE). Cambian una vez al año y la carpeta lleva
// el año, así que se cachean como inmutables.
export const datosSelector = express.Router();
datosSelector.use('/data/selector-ioarr', compression(), express.static(DIR_DATOS, {
  immutable: true, maxAge: '365d', index: false
}), (_, res) => res.status(404).json({ error: 'Archivo de datos no encontrado' }));

// ─── Lectura de las regiones en el servidor (para el Excel) ────────────────
let indice = null;
const cacheRegiones = new Map();   // nombre → D (ya con prep); se guardan las últimas 3

async function leerIndice() {
  if (!indice) indice = JSON.parse(await readFile(DIR_DATOS + ANIO_DATOS + '/index.json', 'utf8'));
  return indice;
}
export async function cargarRegion(nombre) {
  if (cacheRegiones.has(nombre)) {
    const D = cacheRegiones.get(nombre); cacheRegiones.delete(nombre); cacheRegiones.set(nombre, D); return D;
  }
  const g = (await leerIndice()).regiones.find(r => r.nombre === nombre);
  if (!g) return null;
  const D = prep(JSON.parse(await readFile(DIR_DATOS + ANIO_DATOS + '/' + g.archivo, 'utf8')));
  cacheRegiones.set(nombre, D);
  if (cacheRegiones.size > 3) cacheRegiones.delete(cacheRegiones.keys().next().value);
  return D;
}

// ─── API ────────────────────────────────────────────────────────────────────
const router = express.Router();

// El mismo cálculo del servidor, servido al navegador (lo importa el Web Worker)
router.get('/selector-ioarr/calculo.js', (_, res) =>
  res.type('application/javascript').set('Cache-Control', 'no-cache')
    .sendFile(fileURLToPath(new URL('./calculo.js', import.meta.url))));

const api = express.Router();
router.use('/api/selector-ioarr', api);

api.use((req, res, next) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase no configurado' });
  if (!req.usuario?.id) return res.status(401).json({ error: 'Inicia sesión' });
  next();
});

const enviarError = (res, next) => e => faltaMigracion(e) ? res.status(503).json({ error: AVISO_MIGRACION }) : next(e);
const limpiarNombre = n => String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
const codigosValidos = arr => [...new Set((Array.isArray(arr) ? arr : []).map(String).filter(c => /^\d{4,10}$/.test(c)))];
const esUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));

async function proyectoDelUsuario(req) {
  if (!esUuid(req.params.id)) return null;
  const { data, error } = await supabase.from('ioarr_selector_proyectos')
    .select('*, ioarr:ioarr_proyectos(id, cui, nombre)')
    .eq('id', req.params.id).eq('usuario_id', req.usuario.id).maybeSingle();
  if (error) throw error;
  return data;
}

async function leerCodigos(proyectoId) {
  const out = [];
  for (let desde = 0; ; desde += LOTE) {
    const { data, error } = await supabase.from('ioarr_selector_locales').select('codigo_local')
      .eq('proyecto_id', proyectoId).order('codigo_local').range(desde, desde + LOTE - 1);
    if (error) throw error;
    out.push(...data.map(r => r.codigo_local));
    if (data.length < LOTE) return out;
  }
}

async function insertarCodigos(proyectoId, codigos) {
  for (let i = 0; i < codigos.length; i += LOTE) {
    const { error } = await supabase.from('ioarr_selector_locales')
      .upsert(codigos.slice(i, i + LOTE).map(c => ({ proyecto_id: proyectoId, codigo_local: c })), { onConflict: 'proyecto_id,codigo_local', ignoreDuplicates: true });
    if (error) throw error;
  }
}

async function borrarCodigos(proyectoId, codigos) {
  for (let i = 0; i < codigos.length; i += 200) {
    const { error } = await supabase.from('ioarr_selector_locales').delete()
      .eq('proyecto_id', proyectoId).in('codigo_local', codigos.slice(i, i + 200));
    if (error) throw error;
  }
}

// Lista de proyectos del usuario, con el número de locales
api.get('/proyectos', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('ioarr_selector_proyectos')
      .select('id, nombre, region, anio_datos, actualizado_en, ioarr:ioarr_proyectos(id, cui, nombre), locales:ioarr_selector_locales(count)')
      .eq('usuario_id', req.usuario.id).order('actualizado_en', { ascending: false });
    if (error) throw error;
    res.json(data.map(({ locales, ...p }) => ({ ...p, n_locales: locales?.[0]?.count ?? 0 })));
  } catch (e) { enviarError(res, next)(e); }
});

// Crear: { nombre, region, criterios?, locales? }
api.post('/proyectos', async (req, res, next) => {
  try {
    const nombre = limpiarNombre(req.body?.nombre);
    const region = String(req.body?.region || '');
    if (!nombre) return res.status(400).json({ error: 'Escribe un nombre para el proyecto' });
    if (!(await leerIndice()).regiones.some(r => r.nombre === region)) return res.status(400).json({ error: 'Región no válida' });
    const codigos = codigosValidos(req.body?.locales);
    if (codigos.length > MAX_LOCALES) return res.status(400).json({ error: 'Demasiados locales' });
    const { data, error } = await supabase.from('ioarr_selector_proyectos').insert({
      usuario_id: req.usuario.id, nombre, region, anio_datos: ANIO_DATOS, criterios: limpiarParams(req.body?.criterios)
    }).select('*').single();
    if (error) throw error;
    await insertarCodigos(data.id, codigos);
    res.status(201).json({ ...data, ioarr: null, locales: codigos });
  } catch (e) { enviarError(res, next)(e); }
});

// Abrir: proyecto + códigos de local
api.get('/proyectos/:id', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json({ ...p, locales: await leerCodigos(p.id) });
  } catch (e) { enviarError(res, next)(e); }
});

// Cambiar nombre, criterios o vínculo con Radar IOARR
api.patch('/proyectos/:id', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const cambios = {};
    if ('nombre' in req.body) {
      cambios.nombre = limpiarNombre(req.body.nombre);
      if (!cambios.nombre) return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
    }
    if ('criterios' in req.body) cambios.criterios = limpiarParams(req.body.criterios);
    if ('ioarr_proyecto_id' in req.body) {
      const v = req.body.ioarr_proyecto_id;
      if (v !== null && !esUuid(v)) return res.status(400).json({ error: 'Registro de Radar IOARR no válido' });
      cambios.ioarr_proyecto_id = v;
    }
    const { data, error } = await supabase.from('ioarr_selector_proyectos').update(cambios)
      .eq('id', p.id).eq('usuario_id', req.usuario.id).select('*, ioarr:ioarr_proyectos(id, cui, nombre)').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { enviarError(res, next)(e); }
});

// Guardar la selección completa: { locales: [códigos] } (se aplica la diferencia)
api.put('/proyectos/:id/locales', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const nuevos = codigosValidos(req.body?.locales);
    if (nuevos.length > MAX_LOCALES) return res.status(400).json({ error: 'Demasiados locales' });
    const antes = new Set(await leerCodigos(p.id)), ahora = new Set(nuevos);
    await borrarCodigos(p.id, [...antes].filter(c => !ahora.has(c)));
    await insertarCodigos(p.id, nuevos.filter(c => !antes.has(c)));
    await supabase.from('ioarr_selector_proyectos').update({ actualizado_en: new Date().toISOString() }).eq('id', p.id);
    res.json({ ok: true, n_locales: ahora.size });
  } catch (e) { enviarError(res, next)(e); }
});

// Duplicar: { nombre? }
api.post('/proyectos/:id/duplicar', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const nombre = limpiarNombre(req.body?.nombre) || limpiarNombre(p.nombre + ' (copia)');
    const { data, error } = await supabase.from('ioarr_selector_proyectos').insert({
      usuario_id: req.usuario.id, nombre, region: p.region, anio_datos: p.anio_datos, criterios: p.criterios,
      ioarr_proyecto_id: p.ioarr_proyecto_id
    }).select('*, ioarr:ioarr_proyectos(id, cui, nombre)').single();
    if (error) throw error;
    const codigos = await leerCodigos(p.id);
    await insertarCodigos(data.id, codigos);
    res.status(201).json({ ...data, locales: codigos });
  } catch (e) { enviarError(res, next)(e); }
});

api.delete('/proyectos/:id', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const { error } = await supabase.from('ioarr_selector_proyectos').delete().eq('id', p.id).eq('usuario_id', req.usuario.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { enviarError(res, next)(e); }
});

// Buscar registros de Radar IOARR para vincular (por CUI o nombre)
api.get('/ioarr', async (req, res, next) => {
  try {
    const limpio = String(req.query.q || '').replace(/[,()%*\\]/g, ' ').trim();
    let q = supabase.from('ioarr_proyectos').select('id, cui, nombre, region').order('actualizado_en', { ascending: false }).limit(20);
    if (limpio) q = q.or(`cui.ilike.%${limpio}%,nombre.ilike.%${limpio}%`);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Excel del proyecto guardado (criterios y locales tal como están en la base)
api.get('/proyectos/:id/excel', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const D = await cargarRegion(p.region);
    if (!D) return res.status(400).json({ error: 'No hay datos para la región ' + p.region });
    const codigos = new Set(await leerCodigos(p.id));
    const list = []; D.locs.forEach((l, i) => { if (codigos.has(l[0])) list.push(i); });
    if (!list.length) return res.status(400).json({ error: 'El proyecto no tiene locales seleccionados' });
    const P = limpiarParams(p.criterios);
    const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
    const { buffer } = await generarExcel(D, calc(D, P), P, list, {
      proyecto: p.nombre, fecha, fuente: (await leerIndice()).fuente, ioarr: p.ioarr
    });
    const archivo = `IOARR_${slug(p.nombre)}_${fecha}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
      'Cache-Control': 'no-store'
    }).send(buffer);
  } catch (e) { enviarError(res, next)(e); }
});

const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proyecto';

export default router;
