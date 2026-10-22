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
//   Fichas de verificación por local (ficha.js, migración 019)
//     GET    /proyectos/:id/fichas                     locales con su estado (Verificado / Solo censo) y % verificado
//     GET    /proyectos/:id/fichas/:cod/excel          ficha para llenar en campo
//     GET    /proyectos/:id/fichas/:cod/pdf            ficha imprimible
//     GET    /proyectos/:id/fichas-zip                 Excel y PDF de todos los locales; con reparto entre supervisores
//                                                      (Visitas de campo), una carpeta por supervisor y «Sin_asignar»
//            ?paquete=<supervisorId>|sin               solo el paquete de ese supervisor (o los sin asignar)
//     POST   /proyectos/:id/fichas/importar            multipart: archivos (uno o varios Excel llenos) → informe
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
import { leerDuplicidad, separarLocales, estadoDe, avisosDuplicidad } from './duplicidad.js';
import { porNivel, inventarioNivel, inventarioUna, modoDe, sinNivel, nivelesDeLocal, vistaNivel, limpiarPorNivel, NOMBRE_NIVEL } from './niveles.js';
import { modeloFicha, generarFichaExcel, generarFichaPdf, leerFicha, procesarFicha, requeridoFicha, ESTADO_VERIF } from './ficha.js';
import archiver from 'archiver';
import { asignacionesProyecto, paquetesFichas } from './campo.js';

const AVISO = 'Falta ejecutar supabase/migrations/012_ioarr_expediente_costos.sql en Supabase';
const faltaMigracion = e => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
const AVISO_INV = 'Falta ejecutar supabase/migrations/013_ioarr_expediente_inventario.sql en Supabase';
const AVISO_ADQ = 'Falta ejecutar supabase/migrations/016_ioarr_inventario_antiguedad.sql en Supabase para guardar el año de adquisición';
const AVISO_DOC = 'Falta ejecutar supabase/migrations/015_ioarr_expediente_documentos.sql en Supabase';
const AVISO_NIV = 'Falta ejecutar supabase/migrations/018_ioarr_por_nivel.sql en Supabase para cargar el inventario por nivel';
const AVISO_ARCH = 'Falta ejecutar supabase/migrations/014_ioarr_expediente_archivos.sql en Supabase';
const AVISO_FICHA = 'Falta ejecutar supabase/migrations/019_ioarr_ficha_verificacion.sql en Supabase para importar las fichas de verificación';
const MAX_FICHAS = 50, MAX_FICHA_MB = 10;
const subidaFichas = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FICHA_MB * 1024 * 1024, files: MAX_FICHAS } });
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
    const [fila, fijados, vigentes, factores, D, codigos, inventario, archivos, dup] = await Promise.all([
      supabase.from('ioarr_expediente_costos').select('*').eq('proyecto_id', p.id).maybeSingle().then(ok),
      supabase.from('ioarr_expediente_precios').select('*').eq('proyecto_id', p.id).then(ok),
      supabase.from('ioarr_precios_catalogo').select('*').eq('vigente', true).then(ok),
      supabase.from('ioarr_factores_zona').select('*').then(ok),
      cargarRegion(p.region),
      leerCodigos(p.id),
      leerInventario(p),
      leerArchivos(p.id),
      leerDuplicidad(supabase, p.id)
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

    // Los locales con otra inversión vigente o reciente que se excluyeron no entran a la propuesta
    const { list, excluidos } = separarLocales(D, codigos, dup.mapa);
    const P = limpiarParams(p.criterios);
    const C = calc(D, P);
    const idxCod = new Map(D.locs.map((l, i) => [l[0], i]));
    // Con ficha de verificación: requerido con los estudiantes verificados (solo cambia el faltante)
    const inv = Object.fromEntries(inventario.map(x => [x.cod_local, { ...x,
      req_ficha: x.ficha && idxCod.has(x.cod_local) ? requeridoFicha(x, D, P, idxCod.get(x.cod_local)) : null,
      archivos: archivos.filter(a => a.cod_local === x.cod_local).map(sinRuta) }]));
    const comun = { precios, rubros: fila?.rubros, factores, uit: { anio: anioUit, valor: uit?.valor ?? null } };

    // Una IOARR (todos los niveles) y una por nivel: se calculan las dos para compararlas
    const G = porNivel(D, P, list), Cn = Object.fromEntries(G.map(g => [g.nivel, g.C]));
    const Runa = costear({ D, C, list, ...comun, inventario: inventarioUna(inv, D, Cn) });
    const Rniv = costear({ ...comun, grupos: G.map(g => ({ clave: g.nivel, D: g.D, C: g.C, list: g.list, inventario: inventarioNivel(inv, D, g.nivel) })) });
    const modo = modoDe(p);
    // Sin locales no hay niveles: se muestra la IOARR única (vacía)
    const ioarrs = modo === 'una' || !G.length
      ? [{ nivel: null, nombre: 'Todos los niveles', R: Runa, D, C, list, inv: inventarioUna(inv, D, Cn) }]
      : G.map(g => ({ nivel: g.nivel, nombre: g.nombre, R: Rniv.grupos[g.nivel], D: g.D, C: g.C, list: g.list, inv: inventarioNivel(inv, D, g.nivel) }));

    // Locales de varios niveles con inventario cargado sin nivel (antes de la 018): no valen por nivel
    const sinNiv = modo === 'por_nivel' ? Object.entries(inv).filter(([cod, f]) => { const i = D.locs.findIndex(l => l[0] === cod); return i >= 0 && list.includes(i) && sinNivel(f, nivelesDeLocal(D, i)); }).map(([c]) => c) : [];
    for (const x of ioarrs) {
      const R = x.R;
      for (const l of R.locales) l.duplicidad = estadoDe(dup.mapa, l.cod);
      const fuera = x.nivel ? excluidos.filter(i => x.D.locSvc[i].length) : excluidos;
      R.excluidos = fuera.map(i => ({ cod: D.locs[i][0], nom: x.D.locName[i], dist: D.dists[D.locs[i][1]][0], rep: x.C.L.repTot[i], ...estadoDe(dup.mapa, D.locs[i][0]) }));
      R.avisos.push(...avisosDuplicidad(dup.mapa, codigos));
      // Sustento: cada local corregido debería tener al menos el acta de la visita
      const sinActa = R.locales.filter(l => l.verificado && !inv[l.cod].archivos.some(a => a.tipo === 'acta')).map(l => l.cod);
      if (sinActa.length) R.avisos.push({ tipo: 'sustento', texto: `Falta adjuntar el acta de verificación de: ${sinActa.join(', ')}. Súbela en «Corregir inventario» del local, con las fotos y el inventario patrimonial.` });
      const sn = sinNiv.filter(c => R.locales.some(l => l.cod === c));
      if (sn.length) R.avisos.push({ tipo: 'inventario', alerta: true, texto: `El inventario verificado de ${sn.length === 1 ? 'el local' : 'los locales'} ${sn.join(', ')} se cargó sin nivel y el local tiene varios niveles: en esta IOARR se usa el censo. Vuelve a cargarlo por nivel en «Corregir inventario».` });
    }
    const fila_ = R => ({ total: R.totales.total, rep: R.totales.rep, locales: R.totales.locales, est: R.totales.est, en_uit: R.uit.enUit, supera: R.uit.supera, registro: R.uit.valor == null ? null : R.uit.supera ? 'completo' : 'abreviado' });
    const comparativo = {
      modo, uit: Runa.uit.valor ? { anio: Runa.uit.anio, valor: Runa.uit.valor, limite: Runa.uit.limite } : null,
      una: fila_(Runa), niveles: G.map(g => ({ nivel: g.nivel, nombre: g.nombre, ...fila_(Rniv.grupos[g.nivel]) })), suma: Rniv.totales.total
    };
    return { modo, ioarrs, comparativo, Runa, P, detalle, anioUit, uit, D, C, list, inv, dup: dup.mapa, excluidos };
  }
  // La IOARR pedida (?nivel=P); sin nivel o con una sola IOARR, la primera
  const elegir = (A, nivel) => A.ioarrs.find(x => x.nivel === nivel) || A.ioarrs[0];

  const vista = (A, nivel) => { const x = elegir(A, nivel); return vistaDe({ ...A, R: x.R }, x, A); };
  const vistaDe = ({ R, detalle, anioUit, uit, inv }, x, A) => ({
    modo: A.modo, nivel: x.nivel, nombre_ioarr: x.nombre, ioarrs: A.ioarrs.map(y => ({ nivel: y.nivel, nombre: y.nombre, total: y.R.totales.total })), comparativo: A.comparativo,
    anio_uit: anioUit, uit: uit || null, precios: detalle,
    rubros: R.rubros, partidas: R.partidas, totales: R.totales, distritos: R.distritos, uitCalc: R.uit, avisos: R.avisos, excluidos: R.excluidos,
    locales: R.locales.map(l => ({ cod: l.cod, nom: l.nom, dist: l.dist, prov: l.prov, rural: l.rural, est: l.est, zona: l.zona,
      rep: l.rep.reduce((a, b) => a + b, 0), fal: l.fal.reduce((a, b) => a + b, 0), cd: l.cd, total: l.total,
      verificado: l.verificado ? { tipos: l.verificado.tipos, fecha_visita: l.verificado.fecha_visita, ficha: !!l.verificado.ficha } : null,
      archivos: inv?.[l.cod]?.archivos.length || 0, duplicidad: l.duplicidad }))
  });

  api.get('/proyectos/:id/costos', responder(async (req, res) => {
    res.json(vista(await armar(await proyecto(req)), req.query.nivel));
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
    res.json(vista(await armar(p), req.query.nivel));
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
    res.json(vista(await armar(p), req.query.nivel));
  }));

  api.delete('/proyectos/:id/costos/precios/:tipo', responder(async (req, res) => {
    const p = await proyecto(req);
    ok(await supabase.from('ioarr_expediente_precios').delete().eq('proyecto_id', p.id).eq('tipo_bien', req.params.tipo));
    res.json(vista(await armar(p), req.query.nivel));
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

  // Censo del local y, si tiene varios niveles, el de cada nivel (para cargar el inventario por nivel)
  function censoConNiveles(D, P, i) {
    const niveles = nivelesDeLocal(D, i), C = calc(D, P);
    const porNiv = niveles.length > 1 ? Object.fromEntries(niveles.map(n => [n, censoLocal(calc(vistaNivel(D, n), P, n), i)])) : null;
    return { niveles, censo: censoLocal(C, i), porNiv };
  }

  api.get('/proyectos/:id/costos/inventario/:cod', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    const { D, i } = await localDelProyecto(p, cod);
    const { niveles, censo, porNiv } = censoConNiveles(D, limpiarParams(p.criterios), i);
    const { data, error } = await supabase.from('ioarr_expediente_inventario').select('*').eq('proyecto_id', p.id).eq('cod_local', cod).maybeSingle();
    if (error && !faltaMigracion(error)) throw error;
    const archivos = data ? (await leerArchivos(p.id, cod)).map(sinRuta) : [];
    res.json({
      cod, nom: D.locName[i], censo, verificado: data || null, archivos, sin_migracion: !!error,
      // Con varios niveles, las cantidades y el año se cargan por nivel (migración 018)
      niveles: niveles.map(n => ({ nivel: n, nombre: NOMBRE_NIVEL[n], censo: porNiv?.[n] || censo })),
      por_nivel: niveles.length > 1, sin_nivel: !!data && sinNivel(data, niveles), sin_migracion_niveles: !!data && !('por_nivel' in data)
    });
  }));

  api.put('/proyectos/:id/costos/inventario/:cod', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod), b = req.body || {};
    const { D, i } = await localDelProyecto(p, cod);
    const P = limpiarParams(p.criterios), { niveles, censo, porNiv } = censoConNiveles(D, P, i);
    // Un solo nivel: bienes y adquisicion. Varios niveles: por nivel (lo cargado sin nivel se reemplaza)
    const varios = niveles.length > 1;
    const porNivelLimpio = varios ? limpiarPorNivel(b.por_nivel, niveles, limpiarInventario, limpiarAdquisicion, anioLima()) : {};
    const bienes = varios ? {} : limpiarInventario(b.bienes), adquisicion = varios ? {} : limpiarAdquisicion(b.adquisicion, anioLima());
    if (!Object.keys(bienes).length && !Object.keys(adquisicion).length && !Object.keys(porNivelLimpio).length) return res.status(400).json({ error: 'Corrige al menos un tipo de bien o indica un año de adquisición' });
    if (!fechaValida(b.fecha_visita)) return res.status(400).json({ error: 'Indica la fecha de la visita' });
    if (b.fecha_visita > hoyLima()) return res.status(400).json({ error: 'La fecha de la visita no puede ser futura' });
    const observacion = texto(b.observacion, 1000);
    if (!observacion) return res.status(400).json({ error: 'Describe el sustento de la visita (acta, fotos, quién la hizo)' });
    const fila = {
      proyecto_id: p.id, cod_local: cod, bienes, adquisicion, por_nivel: porNivelLimpio,
      censo: porNiv ? { ...censo, _niveles: porNiv } : censo, fecha_visita: b.fecha_visita,
      responsable: texto(b.responsable, 200) || null, observacion, creado_por: req.usuario.id, actualizado_en: new Date().toISOString()
    };
    const guardar = f => supabase.from('ioarr_expediente_inventario').upsert(f, { onConflict: 'proyecto_id,cod_local' });
    let { error } = await guardar(fila);
    // Sin la 018 no existe por_nivel; sin la 016, adquisicion. Si no se usan, se guarda sin ellas
    if (error && /por_nivel/.test(error.message || '')) {
      if (varios) return res.status(503).json({ error: AVISO_NIV });
      const { por_nivel: _, ...sinNiv } = fila;
      ({ error } = await guardar(sinNiv));
      if (!error) delete fila.por_nivel;
    }
    if (error && /adquisicion/.test(error.message || '')) {
      if (Object.keys(adquisicion).length) return res.status(503).json({ error: AVISO_ADQ });
      const { adquisicion: _, por_nivel: __, ...sinAdq } = fila;
      ({ error } = await guardar('por_nivel' in fila ? { ...sinAdq, por_nivel: fila.por_nivel } : sinAdq));
    }
    if (error) { if (faltaMigracion(error)) return res.status(503).json({ error: AVISO_INV }); throw error; }
    res.json(vista(await armar(p), req.query.nivel));
  }));

  api.delete('/proyectos/:id/costos/inventario/:cod', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    const archivos = await leerArchivos(p.id, cod);
    if (archivos.length) await borrarDelBucket(archivos.map(a => a.ruta));
    const { error } = await supabase.from('ioarr_expediente_inventario').delete().eq('proyecto_id', p.id).eq('cod_local', cod);
    if (error && !faltaMigracion(error)) throw error;
    res.json(vista(await armar(p), req.query.nivel));
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

  // ─── Fichas de verificación por local ─────────────────────────────────────
  // Locales de la propuesta (sin los excluidos por duplicidad), con su estado
  const fichaDe = f => f?.ficha ? { archivo: f.ficha.archivo, importado_en: f.ficha.importado_en, fecha: f.ficha.fecha, verificador: f.ficha.verificador, filas: f.ficha.filas } : null;
  async function sinMigracionFicha() {
    const { error } = await supabase.from('ioarr_expediente_inventario').select('ficha').limit(1);
    return !!error && (faltaMigracion(error) || /ficha/.test(error.message || ''));
  }
  async function vistaFichas(p) {
    const [A, sinMig, R] = await Promise.all([armar(p), sinMigracionFicha(), asignacionesProyecto(supabase, p.id)]);
    const est = new Map(A.Runa.locales.map(l => [l.cod, l]));
    const pct = R => R.totales.rep ? Math.round((R.totales.repVerif || 0) / R.totales.rep * 1000) / 10 : 0;
    const locales = A.list.map(i => {
      const cod = A.D.locs[i][0], l = est.get(cod), f = A.inv[cod];
      const estado = l?.verificado?.tipos.length ? 'verificado' : 'solo_censo';
      return { cod, nom: A.D.locName[i], dist: A.D.dists[A.D.locs[i][1]][0], niveles: nivelesDeLocal(A.D, i).map(n => NOMBRE_NIVEL[n]), aulas: A.D.locAul[i].length,
        rep: l ? l.rep.reduce((a, b) => a + b, 0) : 0, rep_verif: l ? l.repVerif.reduce((a, b) => a + b, 0) : 0,
        estado, estado_texto: ESTADO_VERIF[estado], visita: f?.fecha_visita || null, ficha: fichaDe(f),
        supervisor: R.asignaciones?.[cod] ? (R.supervisores[R.asignaciones[cod]] || 'supervisor') : null };
    });
    const paquetes = paquetesFichas(locales.map(l => l.cod), R.asignaciones, R.supervisores)
      .filter(x => x.clave !== 'todos').map(x => ({ clave: x.clave, email: x.email, n: x.codigos.length }));
    return {
      sin_migracion: sinMig, locales, excluidos: A.excluidos.length, paquetes,
      resumen: { locales: locales.length, verificados: locales.filter(l => l.estado === 'verificado').length, con_ficha: locales.filter(l => l.ficha).length,
        rep: A.Runa.totales.rep, rep_verif: A.Runa.totales.repVerif || 0, pct: pct(A.Runa),
        ioarrs: A.modo === 'por_nivel' ? A.ioarrs.filter(x => x.nivel).map(x => ({ nivel: x.nivel, nombre: x.nombre, rep: x.R.totales.rep, rep_verif: x.R.totales.repVerif || 0, pct: pct(x.R) })) : [] }
    };
  }
  api.get('/proyectos/:id/fichas', responder(async (req, res) => {
    res.json(await vistaFichas(await proyecto(req)));
  }));

  // Ficha de un local (padrón y censo con los criterios del proyecto)
  async function fichaLocal(p, cod) {
    const { D, i } = await localDelProyecto(p, cod);
    const C = calc(D, limpiarParams(p.criterios));
    const R = await asignacionesProyecto(supabase, p.id), sup = R.asignaciones?.[cod];
    return modeloFicha(D, C, i, { proyecto: { id: p.id, nombre: p.nombre }, anio: p.anio_datos, fecha: hoyLima(), supervisor: sup ? R.supervisores[sup] || '' : '' });
  }
  const nombreFicha = (F, ext) => `Ficha_verificacion_${F.local.cod}_${slug(F.local.nombre).slice(0, 40)}.${ext}`;
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const enviar = (res, buffer, archivo, tipo) => res.set({
    'Content-Type': tipo, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`
  }).send(buffer);
  api.get('/proyectos/:id/fichas/:cod/excel', responder(async (req, res) => {
    const F = await fichaLocal(await proyecto(req), String(req.params.cod));
    enviar(res, await generarFichaExcel(F), nombreFicha(F, 'xlsx'), XLSX);
  }));
  api.get('/proyectos/:id/fichas/:cod/pdf', responder(async (req, res) => {
    const F = await fichaLocal(await proyecto(req), String(req.params.cod));
    enviar(res, await generarFichaPdf(F), nombreFicha(F, 'pdf'), 'application/pdf');
  }));

  // Todas las fichas (Excel y PDF) en un ZIP, en flujo: se genera una ficha a la vez
  api.get('/proyectos/:id/fichas-zip', responder(async (req, res) => {
    await fichasZip(res, await proyecto(req), req.query.paquete ? String(req.query.paquete) : null);
  }));
  // p: fila de ioarr_selector_proyectos (quien llama ya validó el acceso). pedido: id de un supervisor,
  // 'sin' o null (todos). También lo usa Visitas de campo: el supervisor baja sus fichas (src/selector-ioarr/campo.js)
  async function fichasZip(res, p, pedido) {
    const [D, codigos, dup, R] = await Promise.all([cargarRegion(p.region), leerCodigos(p.id), leerDuplicidad(supabase, p.id), asignacionesProyecto(supabase, p.id)]);
    if (!D) return res.status(400).json({ error: 'No hay datos para la región ' + p.region });
    const { list } = separarLocales(D, codigos, dup.mapa);
    if (!list.length) return res.status(400).json({ error: 'El proyecto no tiene locales en la propuesta' });
    // Un paquete por supervisor según el reparto de Visitas de campo (sin reparto, uno solo)
    const idxDe = new Map(list.map(i => [D.locs[i][0], i]));
    let paquetes = paquetesFichas([...idxDe.keys()], R.asignaciones, R.supervisores);
    if (pedido) {
      paquetes = paquetes.filter(x => x.clave === pedido);
      if (!paquetes.length) return res.status(404).json({ error: 'Ese supervisor no tiene locales en la propuesta del proyecto' });
    }
    const C = calc(D, limpiarParams(p.criterios)), fecha = hoyLima();
    const solo = pedido ? paquetes[0] : null;
    const base = `Fichas_verificacion_${slug(p.nombre)}${solo?.carpeta ? '_' + solo.carpeta : ''}_${fecha}`;
    res.set({ 'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${base}.zip"; filename*=UTF-8''${encodeURIComponent(base + '.zip')}` });
    const zip = archiver('zip', { zlib: { level: 6 } });
    const fallo = new Promise((_, mal) => zip.on('error', mal));
    zip.pipe(res);
    const agregar = (contenido, name) => Promise.race([fallo, new Promise(ok => { zip.once('entry', ok); zip.append(contenido, { name: `${base}/${name}` }); })]);
    try {
      const varios = paquetes.length > 1 || !!paquetes[0].carpeta;
      const n = paquetes.reduce((a, x) => a + x.codigos.length, 0);
      await agregar(Buffer.from(LEEME_FICHAS(p.nombre, n, fecha, varios && !solo ? paquetes : null), 'utf8'), '00_LEEME.txt');
      for (const paq of paquetes) {
        // con un solo paquete pedido, sin subcarpeta (el ZIP ya es de ese supervisor)
        const dir = paq.carpeta && !solo ? paq.carpeta + '/' : '';
        if (dir) await agregar(Buffer.from(LEEME_PAQUETE(p.nombre, paq, D, idxDe), 'utf8'), dir + '00_LOCALES.txt');
        for (const cod of paq.codigos) {
          const F = modeloFicha(D, C, idxDe.get(cod), { proyecto: { id: p.id, nombre: p.nombre }, anio: p.anio_datos, fecha, supervisor: paq.email });
          await agregar(await generarFichaExcel(F), dir + 'Excel/' + nombreFicha(F, 'xlsx'));
          await agregar(await generarFichaPdf(F), dir + 'PDF/' + nombreFicha(F, 'pdf'));
        }
        if (solo && paq.carpeta) await agregar(Buffer.from(LEEME_PAQUETE(p.nombre, paq, D, idxDe), 'utf8'), '00_LOCALES.txt');
      }
      await zip.finalize();
    } catch (e) { console.error('[EXPEDIENTE][FICHAS]', e.message); res.destroy(e); }
  }
  api.fichasZip = fichasZip;

  // Importar una o varias fichas llenas. Cada archivo se valida y se guarda por separado:
  // un archivo rechazado no impide importar los demás; dentro de un archivo, las filas
  // con errores no se importan y el resto sí.
  const recibirFichas = (req, res, next) => subidaFichas.array('archivos', MAX_FICHAS)(req, res, err => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Algún archivo pasa de ${MAX_FICHA_MB} MB` : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Máximo ${MAX_FICHAS} archivos por vez` : 'No se pudieron recibir los archivos: ' + err.message;
    res.status(400).json({ error: msg });
  });
  api.post('/proyectos/:id/fichas/importar', recibirFichas, responder(async (req, res) => {
    const p = await proyecto(req), archivos = req.files || [];
    if (!archivos.length) return res.status(400).json({ error: 'Elige uno o varios Excel de fichas llenas' });
    if (await sinMigracionFicha()) return res.status(503).json({ error: AVISO_FICHA });
    const [D, codigos, dup, inventario] = await Promise.all([cargarRegion(p.region), leerCodigos(p.id), leerDuplicidad(supabase, p.id), leerInventario(p)]);
    if (!D) return res.status(400).json({ error: 'No hay datos para la región ' + p.region });
    const P = limpiarParams(p.criterios), C = calc(D, P), hoy = hoyLima();
    // Solo los locales de la propuesta: un excluido por otra inversión no se verifica
    const { list } = separarLocales(D, codigos, dup.mapa), enPropuesta = new Set(list.map(i => D.locs[i][0]));
    const previas = Object.fromEntries(inventario.map(x => [x.cod_local, x])), vistos = new Map();
    const resultados = [];
    for (const a of archivos) {
      const nombre = nombreUtf8(a.originalname || 'ficha.xlsx').slice(-200);
      const x = await leerFicha(a.buffer);
      const cod = x.meta?.cod_local;
      let r;
      if (cod && codigos.includes(cod) && !enPropuesta.has(cod)) r = { cod, errores: [{ hoja: '—', fila: null, motivo: `El local ${cod} está excluido de la propuesta por otra inversión vigente o reciente. Vuelve a incluirlo en Mi selección si corresponde.` }], avisos: [], rechazada: true, filas: { ok: 0, rechazadas: 0 } };
      else r = procesarFicha(x, { D, C, P, codigos: new Set(codigos), proyectoId: p.id, anioDatos: p.anio_datos, hoy, archivo: nombre, filaPrevia: previas[cod] });
      if (!r.rechazada) {
        if (vistos.has(r.cod)) r.avisos.unshift({ hoja: '—', fila: null, motivo: `Otra ficha del mismo local (${vistos.get(r.cod)}) se importó antes en esta carga: queda esta, que es la última.` });
        const { censo, porNiv } = censoConNiveles(D, P, r.i);
        const fila = { proyecto_id: p.id, cod_local: r.cod, ...r.fila, censo: porNiv ? { ...censo, _niveles: porNiv } : censo, creado_por: req.usuario.id, actualizado_en: new Date().toISOString() };
        const { error } = await supabase.from('ioarr_expediente_inventario').upsert(fila, { onConflict: 'proyecto_id,cod_local' });
        if (error) {
          if (faltaMigracion(error) && !/ficha|por_nivel|adquisicion/.test(error.message || '')) return res.status(503).json({ error: AVISO_INV });
          if (/ficha/.test(error.message || '')) return res.status(503).json({ error: AVISO_FICHA });
          if (/por_nivel/.test(error.message || '')) return res.status(503).json({ error: AVISO_NIV });
          if (/adquisicion/.test(error.message || '')) return res.status(503).json({ error: AVISO_ADQ });
          throw error;
        }
        vistos.set(r.cod, nombre); previas[r.cod] = fila;
      }
      const i = r.cod ? D.locs.findIndex(l => l[0] === r.cod) : -1;
      resultados.push({ archivo: nombre, cod: r.cod || null, nom: i >= 0 ? D.locName[i] : null, estado: r.rechazada ? 'rechazada' : 'importada', filas: r.filas, errores: r.errores, avisos: r.avisos });
    }
    res.json({ resultados, fichas: await vistaFichas(p) });
  }));

  // ─── Documentos: Formato 07-C y memoria descriptiva ───────────────────────
  async function leerDatosDoc(p) {
    const { data, error } = await supabase.from('ioarr_expediente_documentos').select('datos').eq('proyecto_id', p.id).maybeSingle();
    if (error) { if (faltaMigracion(error)) return { datos: limpiarDatosDoc({}), sinMigracion: true }; throw error; }
    return { datos: limpiarDatosDoc(data?.datos || {}), sinMigracion: false };
  }
  // Modelo de los documentos de una IOARR. Con una por nivel, cada una tiene su nombre y su CUI
  // (datos.por_nivel), y el vínculo con Radar IOARR vale para la IOARR que tiene ese CUI.
  function modeloDe(A, x, datos, p) {
    const porNiv = A.modo === 'por_nivel';
    const dn = porNiv ? datos.por_nivel?.[x.nivel] || {} : null;
    const datosX = porNiv ? { ...datos, nombre_inversion: dn.nombre_inversion || '', cui: dn.cui || '' } : datos;
    const proyectoX = porNiv ? { ...p, nombre: `${p.nombre} — IOARR ${x.nombre}`, ioarr: p.ioarr && dn.cui && dn.cui === p.ioarr.cui ? p.ioarr : null } : p;
    const M = armarModelo({ R: x.R, D: x.D, list: x.list, proyecto: proyectoX, datos: datosX, precios: A.detalle, inv: A.inv, fecha: hoyLima() });
    return Object.assign(M, { nivel: x.nivel, nombreIoarr: x.nombre });
  }
  async function modelo(p, nivel) {
    const [A, { datos, sinMigracion }] = await Promise.all([armar(p), leerDatosDoc(p)]);
    const x = elegir(A, nivel);
    return { M: modeloDe(A, x, datos, p), datos, sinMigracion, A, x };
  }
  // Todas las IOARR del proyecto (ZIP y Radar)
  async function modelos(p) {
    const [A, { datos }] = await Promise.all([armar(p), leerDatosDoc(p)]);
    return { A, datos, lista: A.ioarrs.map(x => ({ x, M: modeloDe(A, x, datos, p) })) };
  }
  // Lo que necesita el formulario: datos guardados, lo que se propone y lo que falta
  const vistaDoc = ({ M, datos, sinMigracion, A, x }, p) => ({
    modo: A.modo, nivel: x.nivel, nombre_ioarr: x.nombre, ioarrs: A.ioarrs.map(y => ({ nivel: y.nivel, nombre: y.nombre })), comparativo: A.comparativo,
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
    res.json(vistaDoc(await modelo(p, req.query.nivel), p));
  }));

  api.patch('/proyectos/:id/documentos', responder(async (req, res) => {
    const p = await proyecto(req);
    // Se fusiona con lo guardado: Documentos y Verificación mandan solo lo suyo
    const { datos: actual } = await leerDatosDoc(p);
    const datos = limpiarDatosDoc({ ...actual, ...(req.body?.datos || {}) });
    const { error } = await supabase.from('ioarr_expediente_documentos').upsert({ proyecto_id: p.id, datos, actualizado_en: new Date().toISOString() }, { onConflict: 'proyecto_id' });
    if (error) { if (faltaMigracion(error)) return res.status(503).json({ error: AVISO_DOC }); throw error; }
    res.json(vistaDoc(await modelo(p, req.query.nivel), p));
  }));

  const sufijo = M => M.nivel ? '_' + slug(M.nombreIoarr) : '';
  const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const enviarWord = (res, buffer, archivo) => res.set({
    'Content-Type': WORD, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`
  }).send(buffer);

  api.get('/proyectos/:id/documentos/formato-07c', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel);
    if (!M.ups.length) return res.status(400).json({ error: 'Ningún local del proyecto tiene bienes a reponer' });
    enviarWord(res, await generar07C(M), `Formato_07C_borrador_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.docx`);
  }));

  api.get('/proyectos/:id/documentos/memoria', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel);
    if (!M.ups.length) return res.status(400).json({ error: 'Ningún local del proyecto tiene bienes a reponer' });
    enviarWord(res, await generarMemoria(M), `Memoria_descriptiva_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.docx`);
  }));

  api.get('/proyectos/:id/documentos/verificacion', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel);
    if (!M.ups.length) return res.status(400).json({ error: 'Ningún local del proyecto tiene bienes a reponer' });
    enviarWord(res, await generarVerificacion(M), `Lista_verificacion_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.docx`);
  }));

  api.get('/proyectos/:id/costos/excel', responder(async (req, res) => {
    const p = await proyecto(req), A = await armar(p), x = elegir(A, req.query.nivel);
    if (!x?.R.locales.length) return res.status(400).json({ error: 'El proyecto no tiene locales seleccionados' });
    const fecha = hoyLima();
    const buffer = await generarExcelCostos(x.R, {
      proyecto: x.nivel ? `${p.nombre} — IOARR ${x.nombre}` : p.nombre, region: p.region, fecha, ioarr: p.ioarr, fuente: (await leerIndice()).fuente,
      criterios: textoCriterios(A.P), precios: A.detalle, inventario: x.inv
    });
    const archivo = `Costos_IOARR_${slug(p.nombre)}${x.nivel ? '_' + slug(x.nombre) : ''}_${fecha}.xlsx`;
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
    const p = await proyecto(req), { A, datos, lista: todas } = await modelos(p);
    // Solo las IOARR con algo que reponer
    const lista = todas.filter(y => y.M.ups.length);
    if (!lista.length) return res.status(400).json({ error: 'Ningún local del proyecto tiene bienes a reponer' });
    const fecha = lista[0].M.fecha, base = `Expediente_IOARR_${slug(p.nombre)}_${fecha}`;
    const meta = { region: p.region, fecha, ioarr: p.ioarr, fuente: (await leerIndice()).fuente };
    const porNiv = A.modo === 'por_nivel';
    // Todo lo que puede fallar se genera antes de empezar a enviar
    const [piezas, archivos] = await Promise.all([
      Promise.all(lista.map(async ({ x, M }, j) => {
        const carpeta = porNiv ? `${String(j + 1).padStart(2, '0')}_IOARR_${nombreSeguro(x.nombre)}/` : '';
        const m = { ...meta, proyecto: porNiv ? `${p.nombre} — IOARR ${x.nombre}` : p.nombre };
        const fuera = x.nivel ? A.excluidos.filter(i => x.D.locSvc[i].length) : A.excluidos;
        const [f07c, memoria, verificacion, costos, { buffer: seleccion }] = await Promise.all([
          generar07C(M), generarMemoria(M), generarVerificacion(M),
          generarExcelCostos(x.R, { ...m, criterios: textoCriterios(A.P), precios: A.detalle, inventario: x.inv }),
          generarExcel(x.D, x.C, A.P, x.list, { ...m, duplicidad: A.dup, excluidos: fuera, revisiones: datos.situacional?.revisiones })
        ]);
        return [
          { nombre: carpeta + '01_Formato_07C_borrador.docx', contenido: f07c, descripcion: 'borrador del Formato 07-C' },
          { nombre: carpeta + '02_Memoria_descriptiva.docx', contenido: memoria },
          { nombre: carpeta + '03_Lista_de_verificacion.docx', contenido: verificacion },
          { nombre: carpeta + '04_Estructura_de_costos.xlsx', contenido: costos, descripcion: 'con fórmulas' },
          { nombre: carpeta + '05_Seleccion_de_locales_y_metrado.xlsx', contenido: seleccion, descripcion: 'metrado por aula del Selector' }
        ];
      })).then(xs => xs.flat()),
      leerArchivos(p.id)
    ]);
    const nombreLocal = Object.fromEntries(A.Runa.locales.map(l => [l.cod, l.nom]));
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
      await escribirZip(res, { base, archivos, nombreLocal, descargar, modelos: lista.map(y => y.M), autor: req.usuario.email, proyecto: p.nombre, piezas });
    } catch (e) { console.error('[EXPEDIENTE][ZIP]', e.message); res.destroy(e); return; }

    // Hito en la línea de tiempo del CUI vinculado en Radar IOARR (no bloquea la descarga)
    if (p.ioarr?.id) {
      const S2 = n => n.toLocaleString('es-PE', { minimumFractionDigits: 2 });
      const r = resumenDe(lista.map(y => y.M), A.modo);
      const detalle = `Expediente exportado (ZIP) desde Selector IOARR «${p.nombre}»: S/ ${S2(r.total)}, ${porNiv ? `${lista.length} IOARR por nivel (${lista.map(y => `${y.x.nombre} ${y.M.registro}`).join(', ')})` : 'registro ' + r.registro}, verificación ${r.hechos}/${r.puntos} — ${req.usuario.email}`;
      supabase.from('ioarr_eventos').insert({ proyecto_id: p.ioarr.id, tipo: 'hito', detalle })
        .then(({ error }) => { if (error) console.warn('[EXPEDIENTE] No se pudo registrar el hito:', error.message); });
    }
  }));

  // Avance del expediente de un proyecto, para Radar IOARR (ficha y kanban).
  // Con una IOARR por nivel, suma las IOARR y lista cada una en ioarrs.
  function resumenDe(Ms, modo) {
    const sum = f => Ms.reduce((a, M) => a + f(M), 0);
    const una = Ms.length === 1 && modo !== 'por_nivel';
    return {
      total: sum(M => M.F.total), registro: una ? Ms[0].registro : 'por nivel', masiva: Ms.some(M => M.masiva), ups: sum(M => M.ups.length),
      hechos: sum(M => M.verificacion.hechos), puntos: sum(M => M.verificacion.total), bloqueos: sum(M => M.verificacion.bloqueos), pendientes: sum(M => M.faltan.length),
      modo: modo || 'una', ioarrs: Ms.map(M => ({ nivel: M.nivel, nombre: M.nombreIoarr, total: M.F.total, registro: M.registro, ups: M.ups.length }))
    };
  }
  api.resumen = async (p) => {
    const { A, lista } = await modelos(p);
    const conUps = lista.filter(y => y.M.ups.length).map(y => y.M);
    return resumenDe(conUps.length ? conUps : [lista[0].M], A.modo);
  };

  return api;
}

const plLocal = n => `${n} ${n === 1 ? 'local' : 'locales'}`;
const LEEME_FICHAS = (proyecto, n, fecha, paquetes = null) => [
  `Fichas de verificación de mobiliario escolar — proyecto «${proyecto}» (${plLocal(n)}), generadas el ${fecha}.`,
  '',
  ...(paquetes ? [
    'Un paquete (carpeta) por supervisor de campo, según el reparto de Visitas de campo:',
    ...paquetes.map(x => `  ${x.carpeta}/  ${x.email || 'colegios sin supervisor asignado'} · ${plLocal(x.codigos.length)}`),
    '',
    'Dentro de cada carpeta:'
  ] : []),
  'Excel/  una ficha por local, para llenar en campo y devolver. Es la que se importa en la app.',
  'PDF/    la misma ficha para imprimir y firmar.',
  ...(paquetes ? ['00_LOCALES.txt  la lista de locales del paquete.'] : []),
  '',
  'Cómo se llena:',
  '- Lo gris lo llenó la app con el Padrón ESCALE y el Censo Educativo; lo amarillo se llena en campo.',
  '- Si llenas un estado verificado, llena los tres (Bueno, Regular y Malo; 0 si no hay).',
  '- Las mesas múltiples y las carpetas se cuentan por unidad, con sus puestos por unidad.',
  '- La fecha de la verificación es obligatoria para importar.',
  '- No cambies las celdas grises ni borres filas.',
  '',
  'Para cargarlas: Selector IOARR → Expediente → Fichas → Importar fichas llenas (uno o varios Excel a la vez).'
].join('\r\n');

// Lista de locales de un paquete (00_LOCALES.txt)
const LEEME_PAQUETE = (proyecto, paq, D, idxDe) => [
  `Proyecto «${proyecto}» — ${paq.clave === 'sin' ? 'locales sin supervisor asignado' : 'supervisor de campo: ' + (paq.email || '(sin correo)')} · ${plLocal(paq.codigos.length)}`,
  '',
  ...paq.codigos.map((c, j) => { const i = idxDe.get(c); return `${String(j + 1).padStart(3, ' ')}. ${c} · ${D.locName[i]} · ${D.dists[D.locs[i][1]][0]}`; })
].join('\r\n');

export function textoCriterios(P) {
  const est = { b: 'Bueno', r: 'Regular', m: 'Malo' }[P.carpEstado];
  return CRIT.map(([k, l]) => `${l}: ${P[k]}`).join(' · ') + ` · Estado asignado a las carpetas: ${est} · Se repone solo el estado Malo`;
}

