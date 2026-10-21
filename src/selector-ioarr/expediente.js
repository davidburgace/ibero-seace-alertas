// ============================================================================
// src/selector-ioarr/expediente.js — API del expediente IOARR (Etapa 1: costos)
//
// Se monta dentro de /api/selector-ioarr (router.js), detrás de la misma
// protección: sesión y rol proveedor. Tablas: supabase/migrations/012_ioarr_expediente_costos.sql
//
//   Catálogo compartido (todos los proveedores)
//     GET    /catalogo                          precios, UIT y factores por zona
//     POST   /catalogo/precios                  nuevo precio
//     PATCH  /catalogo/precios/:id              editar (vigente: true lo marca como el vigente de su tipo)
//     DELETE /catalogo/precios/:id
//     PUT    /catalogo/uit/:anio                { valor, fuente }
//     DELETE /catalogo/uit/:anio
//     PUT    /catalogo/factores                 alta o cambio por (ámbito, código)
//     DELETE /catalogo/factores/:id
//     GET    /catalogo/referencias?q=           precios leídos de estructuras de costos (Radar IOARR)
//     GET    /ubigeos?region=                   provincias y distritos de una región
//   Costos del proyecto (solo el dueño)
//     GET    /proyectos/:id/costos              parámetros + estructura de costos calculada
//     PATCH  /proyectos/:id/costos              { rubros?, anio_uit? }
//     PUT    /proyectos/:id/costos/precios/:tipo  { precio_id } fija un precio del catálogo
//     DELETE /proyectos/:id/costos/precios/:tipo  vuelve a usar el vigente del catálogo
//     GET    /proyectos/:id/costos/inventario/:cod  censo del local + inventario verificado en campo
//     PUT    /proyectos/:id/costos/inventario/:cod  { bienes, fecha_visita, responsable?, observacion }  (migración 013)
//     DELETE /proyectos/:id/costos/inventario/:cod  vuelve a usar el censo (borra también sus archivos)
//     POST   /proyectos/:id/costos/inventario/:cod/archivos  multipart: archivo, tipo, descripcion  (migración 014)
//     GET    /proyectos/:id/costos/archivos/:archId/url      URL firmada de 10 minutos
//     DELETE /proyectos/:id/costos/archivos/:archId
//     GET    /proyectos/:id/costos/excel
//   Documentos (etapa 2, migración 015)
//     GET    /proyectos/:id/documentos              datos cargados + resumen + pendientes
//     PATCH  /proyectos/:id/documentos              { datos }
//     GET    /proyectos/:id/documentos/formato-07c  Word del borrador del Formato 07-C
//     GET    /proyectos/:id/documentos/memoria      Word de la memoria descriptiva
//     GET    /proyectos/:id/documentos/verificacion Word de la lista de verificación (etapa 3)
//   Entrega (etapa 4)
//     GET    /proyectos/:id/expediente-zip          ZIP con los Word, los Excel y el sustento por local
//   También devuelve api.resumen(p): avance del expediente para Radar IOARR (ficha y kanban)
// ============================================================================

import express from 'express';
import multer from 'multer';
import { escribirZip } from './zip.js';
import { generarExcel } from './excel.js';
import { BUCKET_EXPEDIENTE, MAX_ARCHIVO, MAX_POR_LOCAL, TIPOS_ARCHIVO, mimeDe, nombreUtf8, nombreSeguro } from './archivos.js';
import { supabase } from '../ioarr/db.js';
import { calc, limpiarParams, CRIT } from './calculo.js';
import { costear, limpiarRubros, limpiarInventario, limpiarAdquisicion, censoLocal, TIPOS, FUENTES_PRECIO } from './costos.js';
import { generarExcelCostos } from './excel-costos.js';
import { armarModelo, limpiarDatosDoc, ESTADOS_ACTIVO } from './documentos.js';
import { generar07C, generarMemoria, generarVerificacion } from './word.js';

const AVISO = 'Falta ejecutar supabase/migrations/012_ioarr_expediente_costos.sql en Supabase';
const faltaMigracion = e => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
const AVISO_INV = 'Falta ejecutar supabase/migrations/013_ioarr_expediente_inventario.sql en Supabase';
const AVISO_ADQ = 'Falta ejecutar supabase/migrations/016_ioarr_inventario_antiguedad.sql en Supabase para guardar el año de adquisición';
const AVISO_DOC = 'Falta ejecutar supabase/migrations/015_ioarr_expediente_documentos.sql en Supabase';
const AVISO_ARCH = 'Falta ejecutar supabase/migrations/014_ioarr_expediente_archivos.sql en Supabase';
const URL_FIRMADA_SEG = 600;
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARCHIVO, files: 1 } });
const COLS_ARCH = 'id, cod_local, tipo, nombre_archivo, mime, tamano, descripcion, creado_en';

// Archivos de sustento de un proyecto (o de un local). Sin la migración 014, lista vacía.
async function leerArchivos(proyectoId, cod) {
  let q = supabase.from('ioarr_expediente_archivos').select(COLS_ARCH + ', ruta').eq('proyecto_id', proyectoId).order('creado_en');
  if (cod) q = q.eq('cod_local', cod);
  const { data, error } = await q;
  if (error) { if (faltaMigracion(error)) return []; throw error; }
  return data;
}
async function borrarDelBucket(rutas) {
  for (let i = 0; i < rutas.length; i += 100) {
    const { error } = await supabase.storage.from(BUCKET_EXPEDIENTE).remove(rutas.slice(i, i + 100));
    if (error) console.error('[EXPEDIENTE] No se pudieron borrar archivos del bucket:', error.message);
  }
}
// Antes de borrar un proyecto: las filas se borran en cascada, los archivos del bucket no
export async function borrarArchivosProyecto(proyectoId) {
  const archivos = await leerArchivos(proyectoId);
  if (archivos.length) await borrarDelBucket(archivos.map(a => a.ruta));
}
const sinRuta = ({ ruta, ...a }) => a;

const esUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));
const texto = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const fechaValida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
const hoyLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const anioLima = () => Number(hoyLima().slice(0, 4));
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proyecto';
const ok = d => { if (d.error) throw d.error; return d.data; };

// Valida un precio del catálogo. parcial = PATCH (solo los campos enviados)
function limpiarPrecio(b, parcial) {
  const out = {}, err = m => { const e = new Error(m); e.status = 400; throw e; };
  const tiene = k => !parcial || k in b;
  if (tiene('tipo_bien')) { if (!TIPOS.includes(b.tipo_bien)) err('Tipo de bien no válido'); out.tipo_bien = b.tipo_bien; }
  if (tiene('descripcion')) { out.descripcion = texto(b.descripcion); if (!out.descripcion) err('Escribe una descripción'); }
  if (tiene('precio')) {
    const p = Number(b.precio);
    if (!Number.isFinite(p) || p < 0 || p > 1e9) err('Precio no válido');
    out.precio = Math.round(p * 100) / 100;
  }
  if (tiene('unidad')) out.unidad = texto(b.unidad, 40) || 'unidad';
  if (tiene('fecha')) { if (!fechaValida(b.fecha)) err('Fecha no válida (AAAA-MM-DD)'); out.fecha = b.fecha; }
  if (tiene('fuente')) { if (!FUENTES_PRECIO[b.fuente]) err('Fuente no válida'); out.fuente = b.fuente; }
  if (tiene('observacion')) out.observacion = texto(b.observacion, 1000) || null;
  return out;
}

async function marcarVigente(id, tipo) {
  // Primero se quita el vigente actual del tipo (índice único parcial)
  ok(await supabase.from('ioarr_precios_catalogo').update({ vigente: false }).eq('tipo_bien', tipo).eq('vigente', true).neq('id', id));
  ok(await supabase.from('ioarr_precios_catalogo').update({ vigente: true }).eq('id', id));
}

/**
 * @param {object} deps funciones de router.js: proyectoDelUsuario(req), leerCodigos(id), cargarRegion(nombre), leerIndice()
 */
export function crearApiExpediente({ proyectoDelUsuario, leerCodigos, cargarRegion, leerIndice }) {
  const api = express.Router();
  const responder = (fn) => async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) {
      if (faltaMigracion(e)) return res.status(503).json({ error: AVISO });
      if (e.status) return res.status(e.status).json({ error: e.message });
      if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un registro con esos datos' });
      next(e);
    }
  };

  // ─── Catálogo ─────────────────────────────────────────────────────────────
  api.get('/catalogo', responder(async (_, res) => {
    const [precios, uit, factores] = await Promise.all([
      supabase.from('ioarr_precios_catalogo').select('*').order('tipo_bien').order('vigente', { ascending: false }).order('fecha', { ascending: false }),
      supabase.from('ioarr_uit').select('*').order('anio', { ascending: false }),
      supabase.from('ioarr_factores_zona').select('*').order('ambito').order('codigo')
    ]);
    res.json({ precios: ok(precios), uit: ok(uit), factores: ok(factores) });
  }));

  api.post('/catalogo/precios', responder(async (req, res) => {
    const fila = limpiarPrecio(req.body || {}, false);
    const data = ok(await supabase.from('ioarr_precios_catalogo').insert({ ...fila, moneda: 'PEN', vigente: false, creado_por: req.usuario.id }).select('*').single());
    if (req.body?.vigente) await marcarVigente(data.id, data.tipo_bien);
    res.status(201).json({ ...data, vigente: !!req.body?.vigente });
  }));

  api.patch('/catalogo/precios/:id', responder(async (req, res) => {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Precio no encontrado' });
    const cambios = limpiarPrecio(req.body || {}, true);
    const actual = ok(await supabase.from('ioarr_precios_catalogo').select('*').eq('id', req.params.id).maybeSingle());
    if (!actual) return res.status(404).json({ error: 'Precio no encontrado' });
    const tipo = cambios.tipo_bien || actual.tipo_bien;
    // Si cambia de tipo, deja de ser el vigente del tipo anterior
    if (cambios.tipo_bien && cambios.tipo_bien !== actual.tipo_bien) cambios.vigente = false;
    if (req.body?.vigente === false) cambios.vigente = false;
    if (Object.keys(cambios).length) ok(await supabase.from('ioarr_precios_catalogo').update(cambios).eq('id', actual.id));
    if (req.body?.vigente === true) await marcarVigente(actual.id, tipo);
    res.json(ok(await supabase.from('ioarr_precios_catalogo').select('*').eq('id', actual.id).single()));
  }));

  api.delete('/catalogo/precios/:id', responder(async (req, res) => {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Precio no encontrado' });
    ok(await supabase.from('ioarr_precios_catalogo').delete().eq('id', req.params.id));
    res.json({ ok: true });
  }));

  api.put('/catalogo/uit/:anio', responder(async (req, res) => {
    const anio = Number(req.params.anio), valor = Number(req.body?.valor);
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) return res.status(400).json({ error: 'Año no válido' });
    if (!Number.isFinite(valor) || valor <= 0 || valor > 1e6) return res.status(400).json({ error: 'Valor de la UIT no válido' });
    res.json(ok(await supabase.from('ioarr_uit').upsert({ anio, valor: Math.round(valor * 100) / 100, fuente: texto(req.body?.fuente) || null }, { onConflict: 'anio' }).select('*').single()));
  }));

  api.delete('/catalogo/uit/:anio', responder(async (req, res) => {
    ok(await supabase.from('ioarr_uit').delete().eq('anio', Number(req.params.anio)));
    res.json({ ok: true });
  }));

  api.put('/catalogo/factores', responder(async (req, res) => {
    const b = req.body || {}, largo = { provincia: 4, distrito: 6, rural: 2 }[b.ambito];
    const codigo = String(b.codigo || '');
    if (!largo) return res.status(400).json({ error: 'Ámbito no válido' });
    if (!new RegExp(`^\\d{${largo}}$`).test(codigo)) return res.status(400).json({ error: `El código debe ser un ubigeo de ${largo} dígitos` });
    const pct = v => { const n = Number(v ?? 0); if (!Number.isFinite(n) || n < 0 || n > 500) { const e = new Error('Porcentaje no válido (0 a 500)'); e.status = 400; throw e; } return n; };
    res.json(ok(await supabase.from('ioarr_factores_zona').upsert({
      ambito: b.ambito, codigo, nombre: texto(b.nombre, 120) || null,
      pct_flete: pct(b.pct_flete), pct_instalacion: pct(b.pct_instalacion), observacion: texto(b.observacion, 500) || null
    }, { onConflict: 'ambito,codigo' }).select('*').single()));
  }));

  api.delete('/catalogo/factores/:id', responder(async (req, res) => {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Factor no encontrado' });
    ok(await supabase.from('ioarr_factores_zona').delete().eq('id', req.params.id));
    res.json({ ok: true });
  }));

  // Precios leídos de las estructuras de costos del Banco de Inversiones (Radar IOARR)
  api.get('/catalogo/referencias', responder(async (req, res) => {
    const q = String(req.query.q || '').replace(/[,()%*\\]/g, ' ').trim();
    let c = supabase.from('ioarr_precios_referencia').select('id, cui_origen, codigo_bien, descripcion, a, b, c, d, anio_ficha, fuente, cuadra')
      .order('anio_ficha', { ascending: false, nullsFirst: false }).limit(50);
    if (q) c = c.or(`descripcion.ilike.%${q}%,codigo_bien.ilike.%${q}%,cui_origen.ilike.%${q}%`);
    const { data, error } = await c;
    if (error) { if (faltaMigracion(error)) return res.json([]); throw error; }
    res.json(data);
  }));

  api.get('/ubigeos', responder(async (req, res) => {
    const D = await cargarRegion(String(req.query.region || ''));
    if (!D) return res.status(404).json({ error: 'Región no encontrada' });
    const provs = new Map();
    const distritos = D.dists.map(([nombre, ubigeo, ip]) => {
      provs.set(ubigeo.slice(0, 4), D.provs[ip]);
      return { codigo: ubigeo, nombre, provincia: D.provs[ip] };
    }).sort((a, b) => a.provincia.localeCompare(b.provincia, 'es') || a.nombre.localeCompare(b.nombre, 'es'));
    res.json({
      region: D.region, departamento: D.dists[0]?.[1].slice(0, 2) || null,
      provincias: [...provs].map(([codigo, nombre]) => ({ codigo, nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
      distritos
    });
  }));

  // ─── Costos del proyecto ──────────────────────────────────────────────────
  async function proyecto(req) {
    const p = await proyectoDelUsuario(req);
    if (!p) { const e = new Error('Proyecto no encontrado'); e.status = 404; throw e; }
    return p;
  }

  // Inventario verificado del proyecto. Sin la migración 013 se calcula con el censo.
  async function leerInventario(p) {
    const { data, error } = await supabase.from('ioarr_expediente_inventario').select('*').eq('proyecto_id', p.id);
    if (error) { if (faltaMigracion(error)) return []; throw error; }
    return data;
  }

  // Junta todo y calcula. Devuelve también lo necesario para el Excel.
  async function armar(p) {
    const [fila, fijados, vigentes, factores, D, codigos, inventario, archivos] = await Promise.all([
      supabase.from('ioarr_expediente_costos').select('*').eq('proyecto_id', p.id).maybeSingle().then(ok),
      supabase.from('ioarr_expediente_precios').select('*').eq('proyecto_id', p.id).then(ok),
      supabase.from('ioarr_precios_catalogo').select('*').eq('vigente', true).then(ok),
      supabase.from('ioarr_factores_zona').select('*').then(ok),
      cargarRegion(p.region),
      leerCodigos(p.id),
      leerInventario(p),
      leerArchivos(p.id)
    ]);
    if (!D) { const e = new Error('No hay datos para la región ' + p.region); e.status = 400; throw e; }
    const anioUit = fila?.anio_uit || anioLima();
    const uit = ok(await supabase.from('ioarr_uit').select('*').eq('anio', anioUit).maybeSingle());

    // Precio de cada tipo: el fijado en el proyecto o, si no hay, el vigente del catálogo
    const vig = Object.fromEntries(vigentes.map(v => [v.tipo_bien, v]));
    const fij = Object.fromEntries(fijados.map(v => [v.tipo_bien, v]));
    const precios = {}, detalle = {};
    for (const t of TIPOS) {
      const f = fij[t], v = vig[t];
      if (f) {
        detalle[t] = { origen: 'proyecto', precio_id: f.precio_id, precio: Number(f.precio_unitario), descripcion: f.descripcion, fuente: f.fuente, fecha: f.fecha,
          // Aviso si el catálogo tiene otro vigente o si cambió el precio de origen
          vigente_distinto: v && (v.id !== f.precio_id || Number(v.precio) !== Number(f.precio_unitario)) ? { id: v.id, precio: Number(v.precio), descripcion: v.descripcion } : null };
      } else if (v) {
        detalle[t] = { origen: 'vigente', precio_id: v.id, precio: Number(v.precio), descripcion: v.descripcion, fuente: v.fuente, fecha: v.fecha, observacion: v.observacion };
      } else detalle[t] = { origen: null, precio: null };
      precios[t] = detalle[t].precio;
    }

    const cod = new Set(codigos), list = [];
    D.locs.forEach((l, i) => { if (cod.has(l[0])) list.push(i); });
    const P = limpiarParams(p.criterios);
    const C = calc(D, P);
    const inv = Object.fromEntries(inventario.map(x => [x.cod_local, { ...x, archivos: archivos.filter(a => a.cod_local === x.cod_local).map(sinRuta) }]));
    const R = costear({ D, C, list, precios, rubros: fila?.rubros, factores, uit: { anio: anioUit, valor: uit?.valor ?? null }, inventario: inv });
    // Sustento: cada local corregido debería tener al menos el acta de la visita
    const sinActa = R.locales.filter(l => l.verificado && !inv[l.cod].archivos.some(a => a.tipo === 'acta')).map(l => l.cod);
    if (sinActa.length) R.avisos.push({ tipo: 'sustento', texto: `Falta adjuntar el acta de verificación de: ${sinActa.join(', ')}. Súbela en «Corregir inventario» del local, con las fotos y el inventario patrimonial.` });
    return { R, P, detalle, anioUit, uit, D, C, list, inv };
  }

  const vista = ({ R, detalle, anioUit, uit, inv }) => ({
    anio_uit: anioUit, uit: uit || null, precios: detalle,
    rubros: R.rubros, partidas: R.partidas, totales: R.totales, distritos: R.distritos, uitCalc: R.uit, avisos: R.avisos,
    locales: R.locales.map(l => ({ cod: l.cod, nom: l.nom, dist: l.dist, prov: l.prov, rural: l.rural, est: l.est, zona: l.zona,
      rep: l.rep.reduce((a, b) => a + b, 0), fal: l.fal.reduce((a, b) => a + b, 0), cd: l.cd, total: l.total,
      verificado: l.verificado ? { tipos: l.verificado.tipos, fecha_visita: l.verificado.fecha_visita } : null,
      archivos: inv?.[l.cod]?.archivos.length || 0 }))
  });

  api.get('/proyectos/:id/costos', responder(async (req, res) => {
    res.json(vista(await armar(await proyecto(req))));
  }));

  api.patch('/proyectos/:id/costos', responder(async (req, res) => {
    const p = await proyecto(req), b = req.body || {}, fila = { proyecto_id: p.id };
    if ('rubros' in b) fila.rubros = limpiarRubros(b.rubros);
    if ('anio_uit' in b) {
      const a = Number(b.anio_uit);
      if (!Number.isInteger(a) || a < 2000 || a > 2100) return res.status(400).json({ error: 'Año de la UIT no válido' });
      fila.anio_uit = a;
    }
    ok(await supabase.from('ioarr_expediente_costos').upsert(fila, { onConflict: 'proyecto_id' }));
    res.json(vista(await armar(p)));
  }));

  api.put('/proyectos/:id/costos/precios/:tipo', responder(async (req, res) => {
    const p = await proyecto(req), tipo = req.params.tipo;
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de bien no válido' });
    if (!esUuid(req.body?.precio_id)) return res.status(400).json({ error: 'Elige un precio del catálogo' });
    const c = ok(await supabase.from('ioarr_precios_catalogo').select('*').eq('id', req.body.precio_id).maybeSingle());
    if (!c || c.tipo_bien !== tipo) return res.status(400).json({ error: 'Ese precio no es de este tipo de bien' });
    ok(await supabase.from('ioarr_expediente_precios').upsert({
      proyecto_id: p.id, tipo_bien: tipo, precio_id: c.id, precio_unitario: c.precio, descripcion: c.descripcion, fuente: c.fuente, fecha: c.fecha,
      actualizado_en: new Date().toISOString()
    }, { onConflict: 'proyecto_id,tipo_bien' }));
    res.json(vista(await armar(p)));
  }));

  api.delete('/proyectos/:id/costos/precios/:tipo', responder(async (req, res) => {
    const p = await proyecto(req);
    ok(await supabase.from('ioarr_expediente_precios').delete().eq('proyecto_id', p.id).eq('tipo_bien', req.params.tipo));
    res.json(vista(await armar(p)));
  }));

  // ─── Inventario verificado en campo ───────────────────────────────────────
  // Índice del local en la región, solo si está en el proyecto
  async function localDelProyecto(p, cod) {
    const codigos = new Set(await leerCodigos(p.id));
    if (!codigos.has(cod)) { const e = new Error('Ese local no está en el proyecto'); e.status = 404; throw e; }
    const D = await cargarRegion(p.region);
    const i = D?.locs.findIndex(l => l[0] === cod) ?? -1;
    if (i < 0) { const e = new Error('Local no encontrado en los datos de la región'); e.status = 404; throw e; }
    return { D, i };
  }

  api.get('/proyectos/:id/costos/inventario/:cod', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    const { D, i } = await localDelProyecto(p, cod);
    const C = calc(D, limpiarParams(p.criterios));
    const { data, error } = await supabase.from('ioarr_expediente_inventario').select('*').eq('proyecto_id', p.id).eq('cod_local', cod).maybeSingle();
    if (error && !faltaMigracion(error)) throw error;
    const archivos = data ? (await leerArchivos(p.id, cod)).map(sinRuta) : [];
    res.json({ cod, nom: D.locName[i], censo: censoLocal(C, i), verificado: data || null, archivos, sin_migracion: !!error });
  }));

  api.put('/proyectos/:id/costos/inventario/:cod', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod), b = req.body || {};
    const { D, i } = await localDelProyecto(p, cod);
    const bienes = limpiarInventario(b.bienes), adquisicion = limpiarAdquisicion(b.adquisicion, anioLima());
    if (!Object.keys(bienes).length && !Object.keys(adquisicion).length) return res.status(400).json({ error: 'Corrige al menos un tipo de bien o indica un año de adquisición' });
    if (!fechaValida(b.fecha_visita)) return res.status(400).json({ error: 'Indica la fecha de la visita' });
    if (b.fecha_visita > hoyLima()) return res.status(400).json({ error: 'La fecha de la visita no puede ser futura' });
    const observacion = texto(b.observacion, 1000);
    if (!observacion) return res.status(400).json({ error: 'Describe el sustento de la visita (acta, fotos, quién la hizo)' });
    const C = calc(D, limpiarParams(p.criterios));
    const fila = {
      proyecto_id: p.id, cod_local: cod, bienes, adquisicion, censo: censoLocal(C, i), fecha_visita: b.fecha_visita,
      responsable: texto(b.responsable, 200) || null, observacion, creado_por: req.usuario.id, actualizado_en: new Date().toISOString()
    };
    const guardar = f => supabase.from('ioarr_expediente_inventario').upsert(f, { onConflict: 'proyecto_id,cod_local' });
    let { error } = await guardar(fila);
    // Sin la 016 no existe la columna adquisicion: si no se cargó ningún año, se guarda sin ella
    if (error && /adquisicion/.test(error.message || '')) {
      if (Object.keys(adquisicion).length) return res.status(503).json({ error: AVISO_ADQ });
      const { adquisicion: _, ...sinAdq } = fila;
      ({ error } = await guardar(sinAdq));
    }
    if (error) { if (faltaMigracion(error)) return res.status(503).json({ error: AVISO_INV }); throw error; }
    res.json(vista(await armar(p)));
  }));

  api.delete('/proyectos/:id/costos/inventario/:cod', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    const archivos = await leerArchivos(p.id, cod);
    if (archivos.length) await borrarDelBucket(archivos.map(a => a.ruta));
    const { error } = await supabase.from('ioarr_expediente_inventario').delete().eq('proyecto_id', p.id).eq('cod_local', cod);
    if (error && !faltaMigracion(error)) throw error;
    res.json(vista(await armar(p)));
  }));

  // ─── Archivos de sustento ─────────────────────────────────────────────────
  const recibir = (req, res, next) => subida.single('archivo')(req, res, err => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `El archivo pasa de ${MAX_ARCHIVO / 1024 / 1024} MB` : 'No se pudo recibir el archivo: ' + err.message;
    res.status(400).json({ error: msg });
  });

  api.post('/proyectos/:id/costos/inventario/:cod/archivos', recibir, responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod), a = req.file;
    if (!a) return res.status(400).json({ error: 'Elige un archivo' });
    const tipo = String(req.body?.tipo || '');
    if (!TIPOS_ARCHIVO[tipo]) return res.status(400).json({ error: 'Tipo de archivo no válido' });
    const mime = mimeDe(a.buffer);
    if (!mime) return res.status(400).json({ error: 'Solo se aceptan PDF o fotos (JPG, PNG, WEBP o HEIC)' });
    const { data: inv, error: eInv } = await supabase.from('ioarr_expediente_inventario').select('cod_local').eq('proyecto_id', p.id).eq('cod_local', cod).maybeSingle();
    if (eInv) { if (faltaMigracion(eInv)) return res.status(503).json({ error: AVISO_INV }); throw eInv; }
    if (!inv) return res.status(409).json({ error: 'Guarda primero el inventario verificado de este local' });
    const { count, error: eCnt } = await supabase.from('ioarr_expediente_archivos').select('id', { count: 'exact', head: true }).eq('proyecto_id', p.id).eq('cod_local', cod);
    if (eCnt) { if (faltaMigracion(eCnt)) return res.status(503).json({ error: AVISO_ARCH }); throw eCnt; }
    if (count >= MAX_POR_LOCAL) return res.status(400).json({ error: `Máximo ${MAX_POR_LOCAL} archivos por local` });

    const nombre = nombreUtf8(a.originalname || 'archivo').slice(-200);
    const ruta = `${p.id}/${nombreSeguro(cod)}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${nombreSeguro(nombre)}`;
    const { error: eUp } = await supabase.storage.from(BUCKET_EXPEDIENTE).upload(ruta, a.buffer, { contentType: mime });
    if (eUp) return res.status(/bucket not found/i.test(eUp.message) ? 503 : 500).json({ error: /bucket not found/i.test(eUp.message) ? AVISO_ARCH : 'No se pudo guardar el archivo: ' + eUp.message });
    const { data, error } = await supabase.from('ioarr_expediente_archivos').insert({
      proyecto_id: p.id, cod_local: cod, tipo, nombre_archivo: nombre, ruta, mime, tamano: a.size,
      descripcion: texto(req.body?.descripcion, 300) || null, subido_por: req.usuario.id
    }).select(COLS_ARCH).single();
    if (error) {
      await borrarDelBucket([ruta]);
      if (faltaMigracion(error)) return res.status(503).json({ error: AVISO_ARCH });
      throw error;
    }
    res.status(201).json(data);
  }));

  async function archivoDelProyecto(req) {
    const p = await proyecto(req);
    if (!esUuid(req.params.archId)) { const e = new Error('Archivo no encontrado'); e.status = 404; throw e; }
    const { data, error } = await supabase.from('ioarr_expediente_archivos').select('*').eq('id', req.params.archId).eq('proyecto_id', p.id).maybeSingle();
    if (error) throw error;
    if (!data) { const e = new Error('Archivo no encontrado'); e.status = 404; throw e; }
    return data;
  }

  api.get('/proyectos/:id/costos/archivos/:archId/url', responder(async (req, res) => {
    const a = await archivoDelProyecto(req);
    const { data, error } = await supabase.storage.from(BUCKET_EXPEDIENTE).createSignedUrl(a.ruta, URL_FIRMADA_SEG, req.query.descargar ? { download: a.nombre_archivo } : undefined);
    if (error) throw error;
    res.json({ url: data.signedUrl, expira_en_seg: URL_FIRMADA_SEG });
  }));

  api.delete('/proyectos/:id/costos/archivos/:archId', responder(async (req, res) => {
    const a = await archivoDelProyecto(req);
    ok(await supabase.from('ioarr_expediente_archivos').delete().eq('id', a.id));
    await borrarDelBucket([a.ruta]);
    res.json({ ok: true });
  }));

  // ─── Documentos: Formato 07-C y memoria descriptiva ───────────────────────
  async function leerDatosDoc(p) {
    const { data, error } = await supabase.from('ioarr_expediente_documentos').select('datos').eq('proyecto_id', p.id).maybeSingle();
    if (error) { if (faltaMigracion(error)) return { datos: limpiarDatosDoc({}), sinMigracion: true }; throw error; }
    return { datos: limpiarDatosDoc(data?.datos || {}), sinMigracion: false };
  }
  async function modelo(p) {
    const [A, { datos, sinMigracion }] = await Promise.all([armar(p), leerDatosDoc(p)]);
    const M = armarModelo({ R: A.R, D: A.D, list: A.list, proyecto: p, datos, precios: A.detalle, inv: A.inv, fecha: hoyLima() });
    return { M, datos, sinMigracion, A };
  }
  // Lo que necesita el formulario: datos guardados, lo que se propone y lo que falta
  const vistaDoc = ({ M, datos, sinMigracion }, p) => ({
    datos, sin_migracion: sinMigracion, estados: ESTADOS_ACTIVO, verificacion: M.verificacion, ioarr: p?.ioarr || null,
    resumen: {
      nombre: M.nombre, nombre_sugerido: M.nombreSugerido, cui: M.cui, masiva: M.masiva, registro: M.registro,
      total: M.F.total, en_uit: M.uit.enUit, uit: M.uit.valor ? { anio: M.uit.anio, valor: M.uit.valor } : null,
      ups: M.ups.length, sin_rep: M.sinRep.map(x => x.cod), ugels: M.ugels, mantenimiento_sugerido: M.D.mantenimiento,
      tipos: M.E.activos.map(a => ({ k: a.k, nombre: a.nombre, cantidad: a.cantidad, descripcion: a.descripcion, antiguedad_inventario: a.antiguedad_inventario })),
      alineamiento: { servicio: M.A.servicio, tipologia: M.A.tipologia, indicadores: M.A.indicadores },
      inicio: M.F.inicio, fin: M.F.fin, condiciones: M.E.condiciones
    },
    faltan: M.faltan
  });

  api.get('/proyectos/:id/documentos', responder(async (req, res) => {
    const p = await proyecto(req);
    res.json(vistaDoc(await modelo(p), p));
  }));

  api.patch('/proyectos/:id/documentos', responder(async (req, res) => {
    const p = await proyecto(req);
    // Se fusiona con lo guardado: Documentos y Verificación mandan solo lo suyo
    const { datos: actual } = await leerDatosDoc(p);
    const datos = limpiarDatosDoc({ ...actual, ...(req.body?.datos || {}) });
    const { error } = await supabase.from('ioarr_expediente_documentos').upsert({ proyecto_id: p.id, datos, actualizado_en: new Date().toISOString() }, { onConflict: 'proyecto_id' });
    if (error) { if (faltaMigracion(error)) return res.status(503).json({ error: AVISO_DOC }); throw error; }
    res.json(vistaDoc(await modelo(p), p));
  }));

  const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const enviarWord = (res, buffer, archivo) => res.set({
    'Content-Type': WORD, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`
  }).send(buffer);

  api.get('/proyectos/:id/documentos/formato-07c', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p);
    if (!M.ups.length) return res.status(400).json({ error: 'Ningún local del proyecto tiene bienes a reponer' });
    enviarWord(res, await generar07C(M), `Formato_07C_borrador_${slug(p.nombre)}_${M.fecha}.docx`);
  }));

  api.get('/proyectos/:id/documentos/memoria', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p);
    if (!M.ups.length) return res.status(400).json({ error: 'Ningún local del proyecto tiene bienes a reponer' });
    enviarWord(res, await generarMemoria(M), `Memoria_descriptiva_${slug(p.nombre)}_${M.fecha}.docx`);
  }));

  api.get('/proyectos/:id/documentos/verificacion', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p);
    if (!M.ups.length) return res.status(400).json({ error: 'Ningún local del proyecto tiene bienes a reponer' });
    enviarWord(res, await generarVerificacion(M), `Lista_verificacion_${slug(p.nombre)}_${M.fecha}.docx`);
  }));

  api.get('/proyectos/:id/costos/excel', responder(async (req, res) => {
    const p = await proyecto(req), A = await armar(p);
    if (!A.R.locales.length) return res.status(400).json({ error: 'El proyecto no tiene locales seleccionados' });
    const fecha = hoyLima();
    const buffer = await generarExcelCostos(A.R, {
      proyecto: p.nombre, region: p.region, fecha, ioarr: p.ioarr, fuente: (await leerIndice()).fuente,
      criterios: textoCriterios(A.P), precios: A.detalle, inventario: A.inv
    });
    const archivo = `Costos_IOARR_${slug(p.nombre)}_${fecha}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
      'Cache-Control': 'no-store'
    }).send(buffer);
  }));

  // ─── Etapa 4: ZIP del expediente ──────────────────────────────────────────
  // Se arma en flujo (archiver): los archivos del bucket se agregan de a uno, así
  // la memoria no crece con el número de fotos.
  api.get('/proyectos/:id/expediente-zip', responder(async (req, res) => {
    const p = await proyecto(req), { M, A } = await modelo(p);
    if (!M.ups.length) return res.status(400).json({ error: 'Ningún local del proyecto tiene bienes a reponer' });
    const fecha = M.fecha, base = `Expediente_IOARR_${slug(p.nombre)}_${fecha}`;
    const meta = { proyecto: p.nombre, region: p.region, fecha, ioarr: p.ioarr, fuente: (await leerIndice()).fuente };
    // Todo lo que puede fallar se genera antes de empezar a enviar
    const [f07c, memoria, verificacion, costos, { buffer: seleccion }, archivos] = await Promise.all([
      generar07C(M), generarMemoria(M), generarVerificacion(M),
      generarExcelCostos(A.R, { ...meta, criterios: textoCriterios(A.P), precios: A.detalle, inventario: A.inv }),
      generarExcel(A.D, A.C, A.P, A.list, meta),
      leerArchivos(p.id)
    ]);
    const nombreLocal = Object.fromEntries(A.R.locales.map(l => [l.cod, l.nom]));
    res.set({
      'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${base}.zip"; filename*=UTF-8''${encodeURIComponent(base + '.zip')}`
    });
    const descargar = async ruta => {
      const { data, error } = await supabase.storage.from(BUCKET_EXPEDIENTE).download(ruta);
      if (error || !data) throw new Error(error?.message || 'sin datos');
      return Buffer.from(await data.arrayBuffer());
    };
    try {
      await escribirZip(res, {
        base, archivos, nombreLocal, descargar, M, autor: req.usuario.email, proyecto: p.nombre,
        piezas: [
          { nombre: '01_Formato_07C_borrador.docx', contenido: f07c, descripcion: 'borrador del Formato 07-C' },
          { nombre: '02_Memoria_descriptiva.docx', contenido: memoria },
          { nombre: '03_Lista_de_verificacion.docx', contenido: verificacion },
          { nombre: '04_Estructura_de_costos.xlsx', contenido: costos, descripcion: 'con fórmulas' },
          { nombre: '05_Seleccion_de_locales_y_metrado.xlsx', contenido: seleccion, descripcion: 'metrado por aula del Selector' }
        ]
      });
    } catch (e) { console.error('[EXPEDIENTE][ZIP]', e.message); res.destroy(e); return; }
    const V = M.verificacion;

    // Hito en la línea de tiempo del CUI vinculado en Radar IOARR (no bloquea la descarga)
    if (p.ioarr?.id) {
      const detalle = `Expediente exportado (ZIP) desde Selector IOARR «${p.nombre}»: S/ ${M.F.total.toLocaleString('es-PE', { minimumFractionDigits: 2 })}, registro ${M.registro}, verificación ${V.hechos}/${V.total} — ${req.usuario.email}`;
      supabase.from('ioarr_eventos').insert({ proyecto_id: p.ioarr.id, tipo: 'hito', detalle })
        .then(({ error }) => { if (error) console.warn('[EXPEDIENTE] No se pudo registrar el hito:', error.message); });
    }
  }));

  // Avance del expediente de un proyecto, para Radar IOARR (ficha y kanban)
  api.resumen = async (p) => {
    const { M } = await modelo(p);
    const V = M.verificacion;
    return { total: M.F.total, registro: M.registro, masiva: M.masiva, ups: M.ups.length, hechos: V.hechos, puntos: V.total, bloqueos: V.bloqueos, pendientes: M.faltan.length };
  };

  return api;
}

export function textoCriterios(P) {
  const est = { b: 'Bueno', r: 'Regular', m: 'Malo' }[P.carpEstado];
  return CRIT.map(([k, l]) => `${l}: ${P[k]}`).join(' · ') + ` · Estado asignado a las carpetas: ${est} · Se repone solo el estado Malo`;
}

