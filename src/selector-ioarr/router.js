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
// Otra inversión vigente o reciente por local: 017_ioarr_selector_duplicidad.sql
//   PUT  /api/selector-ioarr/proyectos/:id/duplicidad/:cod   { estado, codigo?, nota?, excluir? }
//   POST /api/selector-ioarr/proyectos/:id/duplicidad/excluir { excluir } a todos los marcados Sí
// Cuadro de estado situacional: advertencias revisadas, en ioarr_expediente_documentos (015)
//   PUT  /api/selector-ioarr/proyectos/:id/situacional/revisiones  { clave, nota } (nota vacía la quita)
// Generador de bases OxI (fichas, Word y versiones): src/selector-ioarr/bases-api.js, migración 028
// Catálogo de precios referenciales (registros, CSV, PDF, estimación y riesgo): src/selector-ioarr/catalogo-ref-api.js, migración 029
// ============================================================================

import express from 'express';
import compression from 'compression';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { supabase } from '../ioarr/db.js';
import { prep, calc, limpiarParams } from './calculo.js';
import { generarExcel } from './excel.js';
import { generarExcelVisitas } from './excel-visitas.js';
import { agruparVisitas, puntosVisita, limitarPorDia } from './visitas.js';
import { crearApiExpediente, borrarArchivosProyecto } from './expediente.js';
import { crearApiBases } from './bases-api.js';
import { crearApiDocumentoEquivalente } from './documento-equivalente-api.js';
import { crearApiPreciosRef } from './catalogo-ref-api.js';
import { MODOS } from './niveles.js';
import { limpiarDatosDoc } from './documentos.js';
import { leerDuplicidad, limpiarDuplicidad, aFila, deFila, esVacia, separarLocales, AVISO_DUP } from './duplicidad.js';

export const ANIO_DATOS = 2025;
const DIR_DATOS = fileURLToPath(new URL('../public/data/selector-ioarr/', import.meta.url));
const MAX_LOCALES = 50000;
const LOTE = 1000;

const faltaMigracion = (e) => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
const AVISO_MIGRACION = 'Falta ejecutar supabase/migrations/011_ioarr_selector.sql en Supabase';
const AVISO_NIV = 'Falta ejecutar supabase/migrations/018_ioarr_por_nivel.sql en Supabase para elegir entre una IOARR o una por nivel';

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
// Rubros y textos de la estructura de costos (la pantalla del expediente usa las mismas listas)
router.get('/selector-ioarr/costos.js', (_, res) =>
  res.type('application/javascript').set('Cache-Control', 'no-cache')
    .sendFile(fileURLToPath(new URL('./costos.js', import.meta.url))));

// Búsqueda por cercanía (la importa el Web Worker)
router.get('/selector-ioarr/cercania.js', (_, res) =>
  res.type('application/javascript').set('Cache-Control', 'no-cache')
    .sendFile(fileURLToPath(new URL('./cercania.js', import.meta.url))));
// Agrupación por días de visita (la importa el Web Worker)
router.get('/selector-ioarr/visitas.js', (_, res) =>
  res.type('application/javascript').set('Cache-Control', 'no-cache')
    .sendFile(fileURLToPath(new URL('./visitas.js', import.meta.url))));
// Leaflet para el mapa, servido por la app (sin CDN). La versión va en la ruta: caché larga.
export const LEAFLET_VERSION = '1.9.4';
export const RUTA_LEAFLET = `/vendor/leaflet-${LEAFLET_VERSION}`;
const DIR_LEAFLET = path.dirname(createRequire(import.meta.url).resolve('leaflet/dist/leaflet.js'));
router.use(RUTA_LEAFLET, express.static(DIR_LEAFLET, { maxAge: '30d', immutable: true, index: false }));

const api = express.Router();
router.use('/api/selector-ioarr', api);

api.use((req, res, next) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase no configurado' });
  if (!req.usuario?.id) return res.status(401).json({ error: 'Inicia sesión' });
  next();
});

// Configuración del navegador. La llave de Maps Embed queda visible en la página:
// debe estar restringida por referrer HTTP al dominio de la app en Google Cloud.
api.get('/config', (_, res) => res.json({ mapsKey: process.env.GOOGLE_MAPS_EMBED_KEY || null }));

const enviarError =(res, next) => e => faltaMigracion(e) ? res.status(503).json({ error: AVISO_MIGRACION }) : next(e);
const limpiarNombre = n => String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
const codigosValidos = arr => [...new Set((Array.isArray(arr) ? arr : []).map(String).filter(c => /^\d{4,10}$/.test(c)))];
const esUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));

async function proyectoDelUsuario(req) {
  if (!esUuid(req.params.id)) return null;
  const { data, error } = await supabase.from('ioarr_selector_proyectos')
    .select('*, ioarr:ioarr_proyectos(id, cui, nombre, monto_inversion, estado, etapa_financista)')
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
      .select('id, nombre, region, anio_datos, actualizado_en, ioarr:ioarr_proyectos(id, cui, nombre, monto_inversion, estado, etapa_financista), locales:ioarr_selector_locales(count)')
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
    const [locales, dup, rev] = await Promise.all([leerCodigos(p.id), leerDuplicidad(supabase, p.id), leerRevisiones(p.id)]);
    res.json({ ...p, locales, duplicidad: dup.mapa, sin_migracion_dup: dup.sinMigracion, revisiones_situacional: rev });
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
    // Una IOARR o una por nivel (migración 018)
    if ('modo_ioarr' in req.body) {
      if (!MODOS[req.body.modo_ioarr]) return res.status(400).json({ error: 'Opción no válida: «una» o «por_nivel»' });
      cambios.modo_ioarr = req.body.modo_ioarr;
    }
    if ('ioarr_proyecto_id' in req.body) {
      const v = req.body.ioarr_proyecto_id;
      if (v !== null && !esUuid(v)) return res.status(400).json({ error: 'Registro de Radar IOARR no válido' });
      cambios.ioarr_proyecto_id = v;
    }
    const { data, error } = await supabase.from('ioarr_selector_proyectos').update(cambios)
      .eq('id', p.id).eq('usuario_id', req.usuario.id).select('*, ioarr:ioarr_proyectos(id, cui, nombre, monto_inversion, estado, etapa_financista)').single();
    if (error && 'modo_ioarr' in cambios && /modo_ioarr/.test(error.message || '')) return res.status(503).json({ error: AVISO_NIV });
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

// ─── Otra inversión vigente o reciente (duplicidad) ─────────────────────────
// Solo para locales del proyecto. «Sin verificar» sin código ni nota borra la fila.
api.put('/proyectos/:id/duplicidad/:cod', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const cod = String(req.params.cod);
    if (!(await leerCodigos(p.id)).includes(cod)) return res.status(404).json({ error: 'Ese local no está en el proyecto' });
    let d;
    try { d = limpiarDuplicidad(req.body || {}); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const t = supabase.from('ioarr_selector_duplicidad');
    const { data, error } = esVacia(d)
      ? await t.delete().eq('proyecto_id', p.id).eq('cod_local', cod).then(r => ({ ...r, data: null }))
      : await t.upsert(aFila(p.id, cod, d, req.usuario.id), { onConflict: 'proyecto_id,cod_local' }).select('*').single();
    if (error) return faltaMigracion(error) ? res.status(503).json({ error: AVISO_DUP }) : next(error);
    res.json({ cod, ...(data ? deFila(data) : { estado: 'sin_verificar', codigo: null, nota: null, excluir: false }) });
  } catch (e) { next(e); }
});

// Excluir (o volver a incluir) todos los locales marcados «Sí»
api.post('/proyectos/:id/duplicidad/excluir', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const { error } = await supabase.from('ioarr_selector_duplicidad').update({ excluir: !!req.body?.excluir, actualizado_por: req.usuario.id })
      .eq('proyecto_id', p.id).eq('estado', 'si');
    if (error) return faltaMigracion(error) ? res.status(503).json({ error: AVISO_DUP }) : next(error);
    res.json({ duplicidad: (await leerDuplicidad(supabase, p.id)).mapa });
  } catch (e) { next(e); }
});

// ─── Estado situacional: explicación de las advertencias ────────────────────
async function leerDatosDoc(proyectoId) {
  const { data, error } = await supabase.from('ioarr_expediente_documentos').select('datos').eq('proyecto_id', proyectoId).maybeSingle();
  if (error) { if (faltaMigracion(error)) return null; throw error; }
  return data?.datos || {};
}
async function leerRevisiones(proyectoId) {
  const d = await leerDatosDoc(proyectoId);
  return d ? limpiarDatosDoc(d).situacional.revisiones : {};
}
api.put('/proyectos/:id/situacional/revisiones', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const clave = String(req.body?.clave || '').slice(0, 300), nota = String(req.body?.nota || '').trim();
    if (!clave) return res.status(400).json({ error: 'Falta la advertencia' });
    const actual = await leerDatosDoc(p.id);
    if (actual == null) return res.status(503).json({ error: 'Falta ejecutar supabase/migrations/015_ioarr_expediente_documentos.sql en Supabase para guardar la explicación' });
    const revisiones = { ...(actual.situacional?.revisiones || {}) };
    if (nota) revisiones[clave] = { nota, fecha: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date()) }; else delete revisiones[clave];
    const datos = limpiarDatosDoc({ ...actual, situacional: { revisiones } });
    const { error } = await supabase.from('ioarr_expediente_documentos').upsert({ proyecto_id: p.id, datos, actualizado_en: new Date().toISOString() }, { onConflict: 'proyecto_id' });
    if (error) throw error;
    res.json({ revisiones: datos.situacional.revisiones });
  } catch (e) { next(e); }
});

// Duplicar: { nombre? }
api.post('/proyectos/:id/duplicar', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const nombre = limpiarNombre(req.body?.nombre) || limpiarNombre(p.nombre + ' (copia)');
    const { data, error } = await supabase.from('ioarr_selector_proyectos').insert({
      usuario_id: req.usuario.id, nombre, region: p.region, anio_datos: p.anio_datos, criterios: p.criterios,
      ioarr_proyecto_id: p.ioarr_proyecto_id, ...('modo_ioarr' in p ? { modo_ioarr: p.modo_ioarr } : {})
    }).select('*, ioarr:ioarr_proyectos(id, cui, nombre, monto_inversion, estado, etapa_financista)').single();
    if (error) throw error;
    const codigos = await leerCodigos(p.id);
    await insertarCodigos(data.id, codigos);
    // La copia conserva lo verificado sobre otras inversiones
    const { mapa } = await leerDuplicidad(supabase, p.id), filas = Object.entries(mapa).map(([c, d]) => aFila(data.id, c, d, req.usuario.id));
    for (let i = 0; i < filas.length; i += LOTE) {
      const { error: e } = await supabase.from('ioarr_selector_duplicidad').insert(filas.slice(i, i + LOTE));
      if (e) throw e;
    }
    res.status(201).json({ ...data, locales: codigos, duplicidad: mapa });
  } catch (e) { enviarError(res, next)(e); }
});

api.delete('/proyectos/:id', async (req, res, next) => {
  try {
    const p = await proyectoDelUsuario(req);
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
    await borrarArchivosProyecto(p.id);   // sustento del expediente en el bucket (las filas caen en cascada)
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
    const [cods, { mapa }, revisiones] = await Promise.all([leerCodigos(p.id), leerDuplicidad(supabase, p.id), leerRevisiones(p.id)]);
    const { list, excluidos } = separarLocales(D, cods, mapa);
    if (!list.length) return res.status(400).json({ error: excluidos.length ? 'Todos los locales del proyecto están excluidos por otra inversión vigente o reciente' : 'El proyecto no tiene locales seleccionados' });
    const P = limpiarParams(p.criterios);
    const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
    const { buffer } = await generarExcel(D, calc(D, P), P, list, {
      proyecto: p.nombre, fecha, fuente: (await leerIndice()).fuente, ioarr: p.ioarr, duplicidad: mapa, excluidos, revisiones
    });
    const archivo = `IOARR_${slug(p.nombre)}_${fecha}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
      'Cache-Control': 'no-store'
    }).send(buffer);
  } catch (e) { enviarError(res, next)(e); }
});

// Plan de visitas en Excel. Sirve también para borradores: recibe la región, los códigos
// (sin los excluidos por otra inversión), los criterios y los locales por día, y agrupa aquí
// con el mismo código que la pantalla.
api.post('/visitas.xlsx', async (req, res, next) => {
  try {
    const { region, codigos, criterios, porDia, proyecto } = req.body || {};
    const D = await cargarRegion(String(region || ''));
    if (!D) return res.status(400).json({ error: 'Región no válida' });
    const cods = codigosValidos(codigos);
    if (!cods.length) return res.status(400).json({ error: 'No hay locales seleccionados' });
    if (cods.length > MAX_LOCALES) return res.status(400).json({ error: 'Demasiados locales' });
    const idx = new Map(D.locs.map((l, i) => [l[0], i]));
    const list = cods.map(c => idx.get(c)).filter(i => i != null);
    if (!list.length) return res.status(400).json({ error: 'Ningún código pertenece a la región ' + region });
    const P = limpiarParams(criterios), n = limitarPorDia(porDia);
    const { puntos, sinCoord } = puntosVisita(D, calc(D, P), list);
    const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
    const nombre = limpiarNombre(proyecto) || 'Borrador';
    const buffer = await generarExcelVisitas(agruparVisitas(puntos, n), sinCoord, { proyecto: nombre, region: D.region || region, porDia: n, fecha });
    const archivo = `Visitas_${slug(nombre)}_${fecha}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
      'Cache-Control': 'no-store'
    }).send(buffer);
  } catch (e) { next(e); }
});

// Expediente IOARR (costos): supabase/migrations/012_ioarr_expediente_costos.sql
const expediente = crearApiExpediente({ proyectoDelUsuario, leerCodigos, cargarRegion, leerIndice });
api.use(expediente);
// Generador de bases OxI (bases-api.js): supabase/migrations/028_ioarr_bases_oxi.sql
// Catálogo de precios referenciales de IOARR publicadas (catalogo-ref-api.js): migración 029
const preciosRef = crearApiPreciosRef({ expediente, proyectoDelUsuario });
api.use(preciosRef);
api.use(crearApiBases({ expediente, preciosRef }));
api.use(crearApiDocumentoEquivalente({ expediente, preciosRef }));

// Visitas de campo (src/selector-ioarr/campo.js): el ZIP de fichas de un proyecto, sin validar al dueño
// (campo.js ya validó que el supervisor tiene colegios asignados o que el proveedor es el dueño)
async function proyectoPorId(id) {
  const { data, error } = await supabase.from('ioarr_selector_proyectos').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
export async function fichasZipProyecto(res, proyectoId, paquete) {
  const p = await proyectoPorId(proyectoId);
  if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
  return expediente.fichasZip(res, p, paquete);
}
// La ficha llenada en la app (campo.js ya validó el acceso al colegio): el modelo para el formulario y la validación
const sinProyecto = () => Object.assign(new Error('Proyecto no encontrado'), { status: 404 });
export const fichasCampo = {
  async modelo(proyectoId, cod) {
    const p = await proyectoPorId(proyectoId); if (!p) throw sinProyecto();
    return expediente.fichaLocal(p, cod);
  },
  async modelos(proyectoId, cods) {
    const p = await proyectoPorId(proyectoId); if (!p) throw sinProyecto();
    return expediente.fichasLocales(p, cods);
  },
  async validar(proyectoId, cod, datos, origen) {
    const p = await proyectoPorId(proyectoId); if (!p) throw sinProyecto();
    return expediente.validarFichaDigital(p, cod, datos, origen);
  }
};

// ─── Para Radar IOARR (src/ioarr/router.js): expedientes vinculados a un CUI ──
// Lee con la clave secreta: lo usa el servidor solo para usuarios proveedores.
const COLS_VINC = 'id, nombre, region, usuario_id, actualizado_en, ioarr_proyecto_id, criterios, ioarr:ioarr_proyectos(id, cui, nombre, monto_inversion, estado, etapa_financista)';
// { [ioarr_proyecto_id]: número de expedientes } para las tarjetas del kanban
export async function conteoExpedientes() {
  if (!supabase) return {};
  const { data, error } = await supabase.from('ioarr_selector_proyectos').select('ioarr_proyecto_id').not('ioarr_proyecto_id', 'is', null);
  if (error) { console.warn('[SELECTOR] conteoExpedientes:', error.message); return {}; }
  const out = {};
  for (const r of data) out[r.ioarr_proyecto_id] = (out[r.ioarr_proyecto_id] || 0) + 1;
  return out;
}
// Expedientes de un CUI con su avance; «mio» = el usuario puede abrirlo en el Selector
export async function expedientesDeIoarr(ioarrId, usuarioId) {
  if (!supabase) return [];
  const { data, error } = await supabase.from('ioarr_selector_proyectos').select(COLS_VINC).eq('ioarr_proyecto_id', ioarrId).order('actualizado_en', { ascending: false });
  if (error) { console.warn('[SELECTOR] expedientesDeIoarr:', error.message); return []; }
  const duenios = await supabase.from('perfiles').select('id, email').in('id', [...new Set(data.map(p => p.usuario_id))]);
  const email = Object.fromEntries((duenios.data || []).map(x => [x.id, x.email]));
  return Promise.all(data.map(async p => {
    let resumen = null;
    try { resumen = await expediente.resumen(p); } catch (e) { console.warn('[SELECTOR] resumen de expediente:', e.message); }
    return { id: p.id, nombre: p.nombre, region: p.region, actualizado_en: p.actualizado_en, mio: p.usuario_id === usuarioId, duenio: email[p.usuario_id] || null, resumen };
  }));
}

const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proyecto';

export default router;
