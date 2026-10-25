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
//     PATCH  /proyectos/:id/costos              { estructura?, anio_uit? }  (estructura: migración 027)
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
//   Lineamientos IOARR (lineamientos.js)
//     GET    /proyectos/:id/lineamientos/anexos      Excel: ficha de activos a reponer…
//     GET    /proyectos/:id/documentos/vida-util     Word del informe técnico de vida útil (?cod= un colegio)
//     GET    /proyectos/:id/documentos/formato-05b   Word del borrador del Formato 05-B (idea, montos t, t+1, t+2)
//     GET    /proyectos/:id/paquete/up-activos       Excel: listado de UP y activos, consolidado por UGEL y nivel
//     GET    /proyectos/:id/documentos/sustento      Word del informe de sustento de la inversión masiva
//     GET    /proyectos/:id/documentos/cartas        Word de modelos de carta (?tipo=opinion|compromiso|oficio, ?por=ugel|colegio)
//     GET    /proyectos/:id/colegios                 por colegio: checklist de inventario y baja… y su costo
//     PUT    /proyectos/:id/colegios/:cod            { datos } (en ioarr_expediente_documentos.datos.colegios)
//   Documentos, anexos y ZIP salen en versión final: solo los colegios con el checklist completo.
//   Con ?borrador=1, todos (con aviso).
//   Oferta (uso interno, migración 027): NO entra al 07-C, a las fichas, a los Excel ni al ZIP
//     GET    /proyectos/:id/oferta                  entradas guardadas + costo puesto en colegio y margen
//     PUT    /proyectos/:id/oferta                  { datos }
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
//   Fichas llenadas en la app por el supervisor (Visitas de campo, ficha-digital.js, migración 023)
//     GET    /proyectos/:id/fichas/:cod/digital          lo llenado, el padrón y censo del local y la validación
//     POST   /proyectos/:id/fichas/:cod/digital/aprobar  pasa la ficha enviada al inventario verificado (como importar el Excel)
//     POST   /proyectos/:id/fichas/:cod/digital/observar { nota } la devuelve al supervisor para que la corrija
//     GET    /proyectos/:id/fichas/:cod/digital/fotos/:fotoId  una foto de la ficha (?mini=1 la miniatura; migración 024).
//            Al aprobar, las fotos se copian al sustento del local (ioarr_expediente_archivos, tipo «foto»)
//     GET    /proyectos/:id/fichas/:cod/digital/firmas/:cargo  una firma en pantalla (migración 025)
//     GET    /proyectos/:id/fichas/:cod/digital/pdf      la ficha llena en PDF, con fotos y firmas. Al aprobar, este
//            PDF queda en el sustento del local como acta de verificación (tipo «acta»)
//   También devuelve api.resumen(p): avance del expediente para Radar IOARR (ficha y kanban)
// ============================================================================

import express from 'express';
import multer from 'multer';
import { escribirZip } from './zip.js';
import { generarExcel } from './excel.js';
import { BUCKET_EXPEDIENTE, MAX_ARCHIVO, MAX_POR_LOCAL, TIPOS_ARCHIVO, mimeDe, nombreUtf8, nombreSeguro } from './archivos.js';
import { supabase } from '../ioarr/db.js';
import { calc, limpiarParams, CRIT, ITEMS, textoEscenario } from './calculo.js';
// Locales con el Regular verificado por antigüedad (para declarar el origen del % de Regular)
const regDato = R => ({ n: R?.regularCampo?.completos || 0, de: R?.locales?.length || 0 });
import { limpiarEstructura, preciosEfectivos, limpiarInventario, limpiarAdquisicion, censoLocal, FUENTES_PRECIO, CLAVES_PRECIO, PRECIOS_REFERENCIA, LEYENDA_REFERENCIA, NOTA_PORCENTAJES,
  MATERIALES, TIPOS, preciosPropuesta, preciosDeMaterial, validarPropuesta, tiposPropuesta, incluido, materialDe, tienePrecio, cuadraTotales } from './costos.js';
import { preciosUnitarios, referencia as referenciaCatalogo } from './catalogo-ref.js';
import { limpiarOferta, calcularOferta } from './oferta.js';
import { cuadroCotizaciones, viabilidadCotizaciones, BIENES_COTIZACION, MIN_PROVEEDORES } from './cotizaciones.js';
import { generarExcelCostos } from './excel-costos.js';
import { armarModelo, limpiarDatosDoc, ESTADOS_ACTIVO, MODALIDADES, FUENTES_FIN, CODIGOS_FUNCIONALES } from './documentos.js';
import { generar07C, generarMemoria, generarVerificacion, generarVidaUtil, generar05B, generarSustento, generarCartas, TIPOS_CARTA } from './word.js';
import { leerDuplicidad, separarLocales } from './duplicidad.js';
import { fichaActivos, modeloVidaUtil, FUENTES_VIDA_UTIL, limpiarColegio, colegioVacio, colegioDe, checklistColegio, DOCS_BAJA, FUENTES_ENTREGA, TIPOS_ENTREGA, VENTANA_DUP, ESTADOS_USO } from './lineamientos.js';
import { generarExcelLineamientos } from './excel-lineamientos.js';
import { generarExcelPaquete } from './excel-paquete.js';
import { calcularPaquete, modeloIoarr, elegirIoarr } from './paquete.js';
import { porNivel, modoDe, sinNivel, nivelesDeLocal, vistaNivel, limpiarPorNivel, NOMBRE_NIVEL } from './niveles.js';
import { modeloFicha, generarFichaExcel, generarFichaPdf, leerFicha, procesarFicha, requeridoFicha, ESTADO_VERIF } from './ficha.js';
import archiver from 'archiver';
import { asignacionesProyecto, paquetesFichas } from './campo.js';
import { fichaDesdeFormulario, leerFichaDigital, estadosFichas, guardarFichaDigital, origenDigital, AVISO_MIGRACION_FICHAS,
  fotosFicha, leerFotos, avisosFotos, lugarFoto, esUuid as esUuidFoto, faltaMigracion as faltaMigracionFichas,
  firmasFicha, leerFirmas, avisosFirmas, pdfFichaLlena, nombrePdfLlena } from './ficha-digital.js';
import { descargarFoto } from './campo.js';

const AVISO = 'Falta ejecutar supabase/migrations/012_ioarr_expediente_costos.sql en Supabase';
const faltaMigracion = e => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
const AVISO_INV = 'Falta ejecutar supabase/migrations/013_ioarr_expediente_inventario.sql en Supabase';
const AVISO_ADQ = 'Falta ejecutar supabase/migrations/016_ioarr_inventario_antiguedad.sql en Supabase para guardar el año de adquisición';
const AVISO_DOC = 'Falta ejecutar supabase/migrations/015_ioarr_expediente_documentos.sql en Supabase';
const AVISO_NIV = 'Falta ejecutar supabase/migrations/018_ioarr_por_nivel.sql en Supabase para cargar el inventario por nivel';
const AVISO_ARCH = 'Falta ejecutar supabase/migrations/014_ioarr_expediente_archivos.sql en Supabase';
const AVISO_TALLA = 'Falta ejecutar supabase/migrations/026_ioarr_precios_por_talla.sql en Supabase para guardar precios por talla';
// Como ok(), pero si la base aún no acepta tallas en tipo_bien (sin la 026) avisa qué migración falta
const okPrecio = d => {
  if (d.error?.code === '23514' && /tipo_bien/.test(d.error.message || '')) throw Object.assign(new Error(AVISO_TALLA), { status: 503 });
  return ok(d);
};
const AVISO_EST = 'Falta ejecutar supabase/migrations/027_ioarr_estructura_oferta.sql en Supabase para guardar la estructura de costos, el kit y la oferta';
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
  // Fotos de las fichas llenadas en la app (migración 024)
  const { data: fotos, error } = await supabase.from('campo_fichas_fotos').select('ruta, ruta_mini').eq('proyecto_id', proyectoId);
  if (error) { if (!faltaMigracion(error)) console.error('[EXPEDIENTE] Fotos de campo del proyecto:', error.message); return; }
  if (fotos.length) await borrarDelBucket(fotos.flatMap(f => [f.ruta, f.ruta_mini]).filter(Boolean));
  // Firmas en pantalla (migración 025)
  const { data: firmas, error: eF } = await supabase.from('campo_fichas_firmas').select('ruta').eq('proyecto_id', proyectoId);
  if (eF) { if (!faltaMigracion(eF)) console.error('[EXPEDIENTE] Firmas de campo del proyecto:', eF.message); return; }
  if (firmas.length) await borrarDelBucket(firmas.map(f => f.ruta));
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
  // tipo_bien: el tipo (precio general) o una talla de mesa o silla ('mesa_p12'…, migración 026)
  if (tiene('tipo_bien')) { if (!CLAVES_PRECIO.includes(b.tipo_bien)) err('Tipo de bien no válido'); out.tipo_bien = b.tipo_bien; }
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

// Tipos de mueble de los criterios del proyecto (en algún nivel)
export const mueblesCriterio = P => TIPOS.filter(t => P.muebles.includes(t) || Object.values(P.mueblesNivel || {}).some(m => m.includes(t)));
// Criterios sin los muebles excluidos de la propuesta: no entran al cálculo, al kit ni a los documentos
export function quitarMuebles(P, excluidos) {
  const f = m => m.filter(t => !excluidos.includes(t));
  return { ...P, muebles: f(P.muebles), mueblesNivel: Object.fromEntries(Object.entries(P.mueblesNivel || {}).map(([n, m]) => [n, f(m)])) };
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
    const data = okPrecio(await supabase.from('ioarr_precios_catalogo').insert({ ...fila, moneda: 'PEN', vigente: false, creado_por: req.usuario.id }).select('*').single());
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
    if (Object.keys(cambios).length) okPrecio(await supabase.from('ioarr_precios_catalogo').update(cambios).eq('id', actual.id));
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
  // final: solo los colegios con el checklist de inventario y baja completo (el 07-C final y sus anexos).
  // Sin final (Costos, borrador): todos, con aviso de los que no entrarían.
  // Catálogo de precios referenciales (029): sin la migración, vacío
  async function leerCatalogoRef() {
    const { data, error } = await supabase.from('ioarr_precios_ref').select('*');
    if (error) { if (faltaMigracion(error)) return []; throw error; }
    const n = v => v == null || v === '' ? null : Number(v);
    return (data || []).map(r => ({ ...r, monto: n(r.monto), monto_hasta: n(r.monto_hasta), monto_alternativo: n(r.monto_alternativo), composicion: r.composicion || [] }));
  }
  // Niveles de los locales del proyecto (para saber qué tallas necesitan precio)
  async function nivelesProyecto(p) {
    const [D, codigos] = await Promise.all([cargarRegion(p.region), leerCodigos(p.id)]);
    if (!D) return [];
    const idx = new Map(D.locs.map((l, i) => [l[0], i]));
    return [...new Set(codigos.filter(c => idx.has(c)).flatMap(c => nivelesDeLocal(D, idx.get(c))))];
  }

  async function armar(p, { final = false } = {}) {
    const [fila, fijados, vigentes, factores, D, codigos, inventario, archivos, dup, { datos: datosDoc }] = await Promise.all([
      supabase.from('ioarr_expediente_costos').select('*').eq('proyecto_id', p.id).maybeSingle().then(ok),
      supabase.from('ioarr_expediente_precios').select('*').eq('proyecto_id', p.id).then(ok),
      supabase.from('ioarr_precios_catalogo').select('*').eq('vigente', true).then(ok),
      supabase.from('ioarr_factores_zona').select('*').then(ok),   // solo para la oferta interna (transporte por zona)
      cargarRegion(p.region),
      leerCodigos(p.id),
      leerInventario(p),
      leerArchivos(p.id),
      leerDuplicidad(supabase, p.id),
      leerDatosDoc(p)
    ]);
    if (!D) { const e = new Error('No hay datos para la región ' + p.region); e.status = 400; throw e; }
    const registrosRef = await leerCatalogoRef();
    const anioUit = fila?.anio_uit || anioLima();
    const uit = ok(await supabase.from('ioarr_uit').select('*').eq('anio', anioUit).maybeSingle());

    // Precio de cada tipo y de cada talla de mesa y silla: el fijado en el proyecto o, si no
    // hay, el vigente del catálogo. Una talla sin precio usa el de su tipo (costos.js).
    const vig = Object.fromEntries(vigentes.map(v => [v.tipo_bien, v]));
    const fij = Object.fromEntries(fijados.map(v => [v.tipo_bien, v]));
    const precios = {}, detalle = {};
    for (const t of CLAVES_PRECIO) {
      const f = fij[t], v = vig[t];
      if (f) {
        detalle[t] = { origen: 'proyecto', precio_id: f.precio_id, precio: Number(f.precio_unitario), descripcion: f.descripcion, fuente: f.fuente, fecha: f.fecha,
          // Aviso si el catálogo tiene otro vigente o si cambió el precio de origen
          vigente_distinto: v && (v.id !== f.precio_id || Number(v.precio) !== Number(f.precio_unitario)) ? { id: v.id, precio: Number(v.precio), descripcion: v.descripcion } : null };
      } else if (v) {
        detalle[t] = { origen: 'vigente', precio_id: v.id, precio: Number(v.precio), descripcion: v.descripcion, fuente: v.fuente, fecha: v.fecha, observacion: v.observacion };
      } else detalle[t] = { origen: null, precio: null };
    }
    // Precio de mercado de cada clave: editado en el proyecto → catálogo → referencia (costos.js)
    const estructura = limpiarEstructura(fila?.estructura);
    const efectivos = preciosEfectivos(estructura, detalle);
    // Con material de la propuesta: precios por material (escrito o catálogo referencial); los antiguos no se usan
    const catalogoRef = preciosUnitarios(registrosRef);
    const propuestaPrecios = estructura.material_propuesta ? preciosPropuesta(estructura, catalogoRef, efectivos) : null;
    for (const t of CLAVES_PRECIO) precios[t] = propuestaPrecios ? propuestaPrecios[t].precio : efectivos[t].precio;

    // Muebles de la propuesta: los de los criterios menos los excluidos en Costos (no suman en nada)
    const Pcompleto = limpiarParams(p.criterios), excluidos = mueblesCriterio(Pcompleto).filter(t => !incluido(estructura, t));
    const P = excluidos.length ? quitarMuebles(Pcompleto, excluidos) : Pcompleto;
    const idxCod = new Map(D.locs.map((l, i) => [l[0], i]));
    // Con ficha de verificación: requerido con los estudiantes verificados (solo cambia el faltante)
    const inv = Object.fromEntries(inventario.map(x => [x.cod_local, { ...x,
      req_ficha: x.ficha && idxCod.has(x.cod_local) ? requeridoFicha(x, D, P, idxCod.get(x.cod_local)) : null,
      archivos: archivos.filter(a => a.cod_local === x.cod_local).map(sinRuta) }]));
    const comun = { precios, estructura, uit: { anio: anioUit, valor: uit?.valor ?? null } };
    const preciosMaterial = Object.fromEntries(Object.keys(MATERIALES).map(m => [m, Object.fromEntries(Object.entries(preciosDeMaterial(estructura, m, catalogoRef)).map(([k, x]) => [k, x.precio]))]));
    const K = calcularPaquete({ D, P, codigos, dup: dup.mapa, inv, comun, datosDoc, final, modo: modoDe(p), anioRef: anioLima(), propuesta: { Pcompleto, excluidos, preciosMaterial } });
    // Kit incompleto: se pidió kit y la mesa o la silla del estudiante quedó fuera de la propuesta
    const fueraKit = excluidos.filter(t => t === 'mesa' || t === 'silla');
    if (estructura.kit && fueraKit.length) for (const x of K.ioarrs) x.R.avisos.push({ tipo: 'kit', alerta: true,
      texto: `El kit queda incompleto: ${fueraKit.map(t => ITEMS.find(y => y.k === t).n.toLowerCase()).join(' y ')} no ${fueraKit.length === 1 ? 'entra' : 'entran'} a la propuesta, así que no hay kit; lo demás se costea suelto.` });
    return { ...K, datosDoc, detalle, efectivos, estructura, factores, anioUit, uit, sinMigracionEst: !!fila && !('estructura' in fila),
      Pcompleto, excluidosPropuesta: excluidos, catalogoRef, registrosRef, propuestaPrecios };
  }
  // La IOARR pedida (?nivel=P); sin nivel o con una sola IOARR, la primera
  const elegir = elegirIoarr;

  // Material y muebles de la propuesta de una IOARR: precios, comparativo de materiales y validación
  function vistaPropuesta(A, x) {
    const E = A.estructura, muebles = mueblesCriterio(A.Pcompleto), niv = x.nivel ? [x.nivel] : A.niveles;
    const incl = tiposPropuesta(E, muebles);
    const porMaterial = Object.keys(MATERIALES).map(m => {
      const pr = preciosDeMaterial(E, m, A.catalogoRef), r = x.porMaterial?.[m];
      const completo = incl.length > 0 && incl.every(t => tienePrecio(pr, t, niv));
      const ref = x.nivel ? referenciaCatalogo(A.registrosRef, { nivel: x.nivel, sel: { modo: 'mediana', material: m } }) : null;
      return { material: m, nombre: MATERIALES[m], completo, precios: Object.fromEntries(TIPOS.map(t => [t, pr[t]])),
        kit_sin_igv: completo ? r?.kit_sin_igv ?? null : null, kit_igv: completo ? r?.kit_igv ?? null : null, kit_con_igv: completo ? r?.kit_con_igv ?? null : null,
        total: completo ? r?.total ?? null : null, mediana: ref?.n ? { precio: ref.precio, n: ref.n } : null };
    });
    const min = Math.min(...porMaterial.filter(y => y.total != null).map(y => y.total));
    for (const y of porMaterial) y.dif_pct = y.total != null && Number.isFinite(min) && min > 0 ? Math.round((y.total / min - 1) * 1000) / 10 : null;
    return {
      material: E.material_propuesta || null, materiales: Object.fromEntries(TIPOS.map(t => [t, materialDe(E, t)])), materiales_propios: E.materiales,
      incluir: Object.fromEntries(TIPOS.map(t => [t, incluido(E, t)])), muebles_criterio: muebles, kit: E.kit, kit_niveles: E.kit_niveles, niveles: A.niveles,
      precios: A.propuestaPrecios, por_material: porMaterial, excluidos: x.excluidosMuebles || [],
      errores: [...(incl.length ? [] : ['Incluye al menos un mueble en la propuesta.']), ...validarPropuesta(E, { catalogo: A.catalogoRef, muebles, niveles: A.niveles }).filter(t => incl.length || !/al menos un mueble/.test(t))],
      cuadra: cuadraTotales(x.R.totales)
    };
  }

  const vista = (A, nivel) => { const x = elegir(A, nivel); return vistaDe({ ...A, R: x.R }, x, A); };
  const vistaDe = ({ R, detalle, anioUit, uit, inv }, x, A) => ({
    modo: A.modo, nivel: x.nivel, nombre_ioarr: x.nombre, ioarrs: A.ioarrs.map(y => ({ nivel: y.nivel, nombre: y.nombre, total: y.R.totales.total })), comparativo: A.comparativo,
    anio_uit: anioUit, uit: uit || null, precios: A.efectivos, catalogo_precios: detalle, referencia: { precios: PRECIOS_REFERENCIA, leyenda: LEYENDA_REFERENCIA, nota_porcentajes: NOTA_PORCENTAJES },
    escenario: { k: A.P.escenario, capOcup: A.P.capOcup, capPct: A.P.capPct, pctRegular: A.P.pctRegular, pctRegularNivel: A.P.pctRegularNivel, pctOrigen: A.P.pctOrigen,
      umbralVida: A.P.umbralVida, niveles: A.niveles, texto: textoEscenario(A.P, regDato(R)), campo: A.Runa.regularCampo }, escenarios: A.escenarios,
    estructura: { ...R.estructura, guardada: A.estructura }, sin_migracion_estructura: A.sinMigracionEst,
    propuesta: vistaPropuesta(A, x),
    metas: R.metas, lineasKit: R.lineasKit, lineasTalla: R.lineasTalla,
    partidas: R.partidas, lineas: R.lineas, muebles: A.P.muebles, totales: R.totales, distritos: R.distritos, uitCalc: R.uit, avisos: R.avisos, excluidos: R.excluidos,
    locales: R.locales.map(l => ({ cod: l.cod, nom: l.nom, dist: l.dist, prov: l.prov, rural: l.rural, est: l.est, kits: l.kits,
      rep: l.rep.reduce((a, b) => a + b, 0), fal: l.fal.reduce((a, b) => a + b, 0), cd: l.cd, total: l.total,
      verificado: l.verificado ? { tipos: l.verificado.tipos, fecha_visita: l.verificado.fecha_visita, ficha: !!l.verificado.ficha } : null,
      regular: l.regular ? { origen: l.regular.origen, parcial: !!l.regular.parcial, pct: l.regular.pct } : null,
      archivos: inv?.[l.cod]?.archivos.length || 0, duplicidad: l.duplicidad }))
  });

  api.get('/proyectos/:id/costos', responder(async (req, res) => {
    res.json(vista(await armar(await proyecto(req)), req.query.nivel));
  }));

  api.patch('/proyectos/:id/costos', responder(async (req, res) => {
    const p = await proyecto(req), b = req.body || {}, fila = { proyecto_id: p.id };
    if (b.estructura && typeof b.estructura === 'object') {
      // Se fusiona con lo guardado; un precio en null vuelve al del catálogo o la referencia
      const { data: actual, error: eAct } = await supabase.from('ioarr_expediente_costos').select('*').eq('proyecto_id', p.id).maybeSingle();
      if (eAct) throw eAct;
      if (actual && !('estructura' in actual)) return res.status(503).json({ error: AVISO_EST });
      const g = limpiarEstructura(actual?.estructura), n = b.estructura;
      const precios = { ...g.precios };
      for (const [k, v] of Object.entries(n.precios || {})) { if (v === null || v === '') delete precios[k]; else precios[k] = v; }
      // Precios por material: se fusionan por material y clave (null borra)
      const precios_material = Object.fromEntries(Object.entries(g.precios_material).map(([m, o]) => [m, { ...o }]));
      for (const [m, o] of Object.entries(n.precios_material || {})) for (const [k, v] of Object.entries(o || {})) {
        precios_material[m] ??= {};
        if (v === null || v === '') delete precios_material[m][k]; else precios_material[m][k] = v;
      }
      const fusion = k => ({ ...g[k], ...(n[k] && typeof n[k] === 'object' ? n[k] : {}) });
      const materiales = fusion('materiales');
      for (const [t, v] of Object.entries(n.materiales || {})) if (v === null || v === '') delete materiales[t];
      fila.estructura = limpiarEstructura({ ...g, ...n, precios, precios_material, materiales, incluir: fusion('incluir'), kit_niveles: fusion('kit_niveles') });
      // La propuesta debe quedar válida: al menos un mueble; con material, cada mueble incluido con material y precio
      const E = fila.estructura, muebles = mueblesCriterio(limpiarParams(p.criterios));
      const [registros, niveles] = await Promise.all([leerCatalogoRef(), nivelesProyecto(p)]);
      const errores = [...(tiposPropuesta(E, muebles).length ? [] : ['Incluye al menos un mueble en la propuesta.']),
        ...validarPropuesta(E, { catalogo: preciosUnitarios(registros), muebles, niveles }).filter(t => !/al menos un mueble/.test(t))];
      if (errores.length) return res.status(400).json({ error: 'No se guardó: ' + errores.join(' '), errores });
    }
    if ('anio_uit' in b) {
      const a = Number(b.anio_uit);
      if (!Number.isInteger(a) || a < 2000 || a > 2100) return res.status(400).json({ error: 'Año de la UIT no válido' });
      fila.anio_uit = a;
    }
    const { error: eUp } = await supabase.from('ioarr_expediente_costos').upsert(fila, { onConflict: 'proyecto_id' });
    if (eUp) { if (/estructura/.test(eUp.message || '')) return res.status(503).json({ error: AVISO_EST }); throw eUp; }
    res.json(vista(await armar(p), req.query.nivel));
  }));

  // ─── Oferta (uso interno) ─────────────────────────────────────────────────
  // Tabla aparte (ioarr_expediente_oferta): ningún exportador la lee. No entra al 07-C,
  // a las fichas, a la memoria, a los Excel ni al ZIP del expediente.
  async function leerOferta(p) {
    const { data, error } = await supabase.from('ioarr_expediente_oferta').select('datos').eq('proyecto_id', p.id).maybeSingle();
    if (error) { if (faltaMigracion(error)) return { datos: limpiarOferta({}), sinMigracion: true }; throw error; }
    return { datos: limpiarOferta(data?.datos || {}), sinMigracion: false };
  }
  // Viabilidad (uso interno): precio referencial de las cotizaciones de cada nivel frente a nuestro costo
  const viabilidadDe = (A, o) => A.ioarrs.filter(x => x.nivel).map(x => ({ nivel: x.nivel, nombre: x.nombre,
    items: viabilidadCotizaciones(cuadroCotizaciones(A.datosDoc?.cotizaciones?.[x.nivel] || [], A.estructura?.igv ?? 18), o.datos) })).filter(v => v.items.length);
  const vistaOferta = (A, o) => ({ datos: o.datos, sin_migracion: o.sinMigracion, escenario: textoEscenario(A.P, regDato(A.Runa)),
    material: A.estructura.material_propuesta ? { k: A.estructura.material_propuesta, nombre: MATERIALES[A.estructura.material_propuesta] } : null,
    muebles_excluidos: A.excluidosPropuesta.map(t => ITEMS.find(y => y.k === t).n),
    ...calcularOferta(A.Runa, o.datos, { factores: A.factores }), viabilidad: viabilidadDe(A, o) });
  api.get('/proyectos/:id/oferta', responder(async (req, res) => {
    const p = await proyecto(req);
    const [A, o] = await Promise.all([armar(p), leerOferta(p)]);
    res.json(vistaOferta(A, o));
  }));
  api.put('/proyectos/:id/oferta', responder(async (req, res) => {
    const p = await proyecto(req), datos = limpiarOferta(req.body?.datos || {});
    const { error } = await supabase.from('ioarr_expediente_oferta').upsert({ proyecto_id: p.id, datos, actualizado_en: new Date().toISOString() }, { onConflict: 'proyecto_id' });
    if (error) { if (faltaMigracion(error)) return res.status(503).json({ error: AVISO_EST }); throw error; }
    res.json(vistaOferta(await armar(p), { datos, sinMigracion: false }));
  }));

  api.put('/proyectos/:id/costos/precios/:tipo', responder(async (req, res) => {
    const p = await proyecto(req), tipo = req.params.tipo;
    if (!CLAVES_PRECIO.includes(tipo)) return res.status(400).json({ error: 'Tipo de bien no válido' });
    if (!esUuid(req.body?.precio_id)) return res.status(400).json({ error: 'Elige un precio del catálogo' });
    const c = ok(await supabase.from('ioarr_precios_catalogo').select('*').eq('id', req.body.precio_id).maybeSingle());
    if (!c || c.tipo_bien !== tipo) return res.status(400).json({ error: 'Ese precio no es de este tipo de bien' });
    okPrecio(await supabase.from('ioarr_expediente_precios').upsert({
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
  const digitalDe = f => ({ estado: f.estado, estado_texto: f.estado_texto, por: f.por, enviada_en: f.enviada_en, revisada_en: f.revisada_en, nota: f.nota });
  async function vistaFichas(p) {
    const [A, sinMig, R, dig] = await Promise.all([armar(p), sinMigracionFicha(), asignacionesProyecto(supabase, p.id), estadosFichas(supabase, p.id)]);
    const est = new Map(A.Runa.locales.map(l => [l.cod, l]));
    const pct = R => R.totales.rep ? Math.round((R.totales.repVerif || 0) / R.totales.rep * 1000) / 10 : 0;
    const locales = A.list.map(i => {
      const cod = A.D.locs[i][0], l = est.get(cod), f = A.inv[cod];
      const estado = l?.verificado?.tipos.length ? 'verificado' : 'solo_censo';
      return { cod, nom: A.D.locName[i], dist: A.D.dists[A.D.locs[i][1]][0], niveles: nivelesDeLocal(A.D, i).map(n => NOMBRE_NIVEL[n]), aulas: A.D.locAul[i].length,
        rep: l ? l.rep.reduce((a, b) => a + b, 0) : 0, rep_verif: l ? l.repVerif.reduce((a, b) => a + b, 0) : 0,
        estado, estado_texto: ESTADO_VERIF[estado], visita: f?.fecha_visita || null, ficha: fichaDe(f),
        supervisor: R.asignaciones?.[cod] ? (R.supervisores[R.asignaciones[cod]] || 'supervisor') : null,
        digital: dig?.[cod] ? digitalDe(dig[cod]) : null };
    });
    const paquetes = paquetesFichas(locales.map(l => l.cod), R.asignaciones, R.supervisores)
      .filter(x => x.clave !== 'todos').map(x => ({ clave: x.clave, email: x.email, n: x.codigos.length }));
    return {
      sin_migracion: sinMig, sin_migracion_digital: !dig, locales, excluidos: A.excluidos.length, paquetes,
      resumen: { locales: locales.length, por_revisar: locales.filter(l => l.digital?.estado === 'enviada').length, verificados: locales.filter(l => l.estado === 'verificado').length, con_ficha: locales.filter(l => l.ficha).length,
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
  // Lo que hace falta para validar fichas del proyecto (Excel o la app) y guardarlas en el inventario
  async function contextoFichas(p) {
    const [D, codigos, dup, inventario] = await Promise.all([cargarRegion(p.region), leerCodigos(p.id), leerDuplicidad(supabase, p.id), leerInventario(p)]);
    if (!D) { const e = new Error('No hay datos para la región ' + p.region); e.status = 400; throw e; }
    const P = limpiarParams(p.criterios);
    // Solo los locales de la propuesta: un excluido por otra inversión no se verifica
    const { list } = separarLocales(D, codigos, dup.mapa);
    return { p, D, P, C: calc(D, P), hoy: hoyLima(), codigos: new Set(codigos), enPropuesta: new Set(list.map(i => D.locs[i][0])),
      previas: Object.fromEntries(inventario.map(x => [x.cod_local, x])) };
  }
  // x: estructura de leerFicha() (o fichaDesdeFormulario()); origen: nombre del archivo o «Ficha digital de …»
  function validarFicha(K, x, origen) {
    const cod = x.meta?.cod_local;
    if (cod && K.codigos.has(cod) && !K.enPropuesta.has(cod)) return { cod, errores: [{ hoja: '—', fila: null, motivo: `El local ${cod} está excluido de la propuesta por otra inversión vigente o reciente. Vuelve a incluirlo en Mi selección si corresponde.` }], avisos: [], rechazada: true, filas: { ok: 0, rechazadas: 0 } };
    return procesarFicha(x, { D: K.D, C: K.C, P: K.P, codigos: K.codigos, proyectoId: K.p.id, anioDatos: K.p.anio_datos, hoy: K.hoy, archivo: origen, filaPrevia: K.previas[cod] });
  }
  const error503 = msg => Object.assign(new Error(msg), { status: 503 });
  // Guarda una ficha validada (no rechazada) en el inventario verificado del local
  async function guardarFichaInventario(K, r, usuarioId) {
    const { censo, porNiv } = censoConNiveles(K.D, K.P, r.i);
    const fila = { proyecto_id: K.p.id, cod_local: r.cod, ...r.fila, censo: porNiv ? { ...censo, _niveles: porNiv } : censo, creado_por: usuarioId, actualizado_en: new Date().toISOString() };
    const { error } = await supabase.from('ioarr_expediente_inventario').upsert(fila, { onConflict: 'proyecto_id,cod_local' });
    if (error) {
      if (faltaMigracion(error) && !/ficha|por_nivel|adquisicion/.test(error.message || '')) throw error503(AVISO_INV);
      if (/ficha/.test(error.message || '')) throw error503(AVISO_FICHA);
      if (/por_nivel/.test(error.message || '')) throw error503(AVISO_NIV);
      if (/adquisicion/.test(error.message || '')) throw error503(AVISO_ADQ);
      throw error;
    }
    K.previas[r.cod] = fila;
  }

  api.post('/proyectos/:id/fichas/importar', recibirFichas, responder(async (req, res) => {
    const p = await proyecto(req), archivos = req.files || [];
    if (!archivos.length) return res.status(400).json({ error: 'Elige uno o varios Excel de fichas llenas' });
    if (await sinMigracionFicha()) return res.status(503).json({ error: AVISO_FICHA });
    const K = await contextoFichas(p), vistos = new Map();
    const resultados = [];
    for (const a of archivos) {
      const nombre = nombreUtf8(a.originalname || 'ficha.xlsx').slice(-200);
      const r = validarFicha(K, await leerFicha(a.buffer), nombre);
      if (!r.rechazada) {
        if (vistos.has(r.cod)) r.avisos.unshift({ hoja: '—', fila: null, motivo: `Otra ficha del mismo local (${vistos.get(r.cod)}) se importó antes en esta carga: queda esta, que es la última.` });
        await guardarFichaInventario(K, r, req.usuario.id);
        vistos.set(r.cod, nombre);
      }
      const i = r.cod ? K.D.locs.findIndex(l => l[0] === r.cod) : -1;
      resultados.push({ archivo: nombre, cod: r.cod || null, nom: i >= 0 ? K.D.locName[i] : null, estado: r.rechazada ? 'rechazada' : 'importada', filas: r.filas, errores: r.errores, avisos: r.avisos });
    }
    res.json({ resultados, fichas: await vistaFichas(p) });
  }));

  // ─── Fichas llenadas en la app (Visitas de campo) ─────────────────────────
  // Lo que el supervisor llenó, validado con el contexto actual del proyecto
  const validarFormulario = (K, cod, datos, origen, fotos, firmas) => {
    const r = validarFicha(K, fichaDesdeFormulario(datos, { proyectoId: K.p.id, cod, region: K.p.region, fotos }), origen);
    if (fotos) r.avisos = [...r.avisos, ...avisosFotos(datos, fotos)];
    if (firmas) r.avisos = [...r.avisos, ...avisosFirmas(datos, firmas, fotos)];
    return r;
  };
  async function fichaDigitalDe(p, cod) {
    let f;
    try { f = await leerFichaDigital(supabase, p.id, cod); }
    catch (e) { if (faltaMigracion(e)) throw error503(AVISO_MIGRACION_FICHAS); throw e; }
    if (!f) { const e = new Error('Este local no tiene ficha llenada en la app'); e.status = 404; throw e; }
    return f;
  }
  const revision = r => ({ rechazada: r.rechazada, errores: r.errores, avisos: r.avisos, filas: r.filas });
  api.get('/proyectos/:id/fichas/:cod/digital', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    const f = await fichaDigitalDe(p, cod);
    const [modelo, K, fotos, firmas] = await Promise.all([fichaLocal(p, cod), contextoFichas(p), fotosFicha(supabase, p.id, cod), firmasFicha(supabase, p.id, cod)]);
    const { por_id, ...ficha } = f;
    res.json({ ficha, modelo, fotos, firmas, revision: revision(validarFormulario(K, cod, f.datos, origenDigital(f.por), fotos, firmas)) });
  }));
  api.post('/proyectos/:id/fichas/:cod/digital/aprobar', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    if (await sinMigracionFicha()) return res.status(503).json({ error: AVISO_FICHA });
    const f = await fichaDigitalDe(p, cod);
    if (f.estado !== 'enviada') return res.status(409).json({ error: f.estado === 'aprobada' ? 'La ficha ya está aprobada' : 'El supervisor aún no envía esta ficha a revisión' });
    const [K, fotos, firmas] = await Promise.all([contextoFichas(p), leerFotosOVacio(p.id, cod), firmasFicha(supabase, p.id, cod)]);
    const r = validarFormulario(K, cod, f.datos, origenDigital(f.por), fotos, firmas);
    if (r.rechazada || r.errores.length) return res.status(422).json({ error: 'La ficha tiene errores: devuélvela al supervisor para que la corrija.', revision: revision(r) });
    await guardarFichaInventario(K, r, req.usuario.id);
    await guardarFichaDigital(supabase, p.id, cod, { estado: 'aprobada', revisado_por: req.usuario.id, revisada_en: new Date().toISOString(), nota_revision: null });
    const copia = await copiarFotosAlSustento(p, cod, fotos, f.datos?.a?.fecha);
    const acta = await guardarActaPdf(p, cod, { ...f, estado: 'aprobada', revisada_en: new Date().toISOString() });
    res.json({ fichas: await vistaFichas(p), fotos: copia, acta });
  }));
  api.post('/proyectos/:id/fichas/:cod/digital/observar', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    const nota = texto(req.body?.nota, 1000);
    if (!nota) return res.status(400).json({ error: 'Escribe qué debe corregir el supervisor' });
    const f = await fichaDigitalDe(p, cod);
    if (f.estado !== 'enviada') return res.status(409).json({ error: f.estado === 'aprobada' ? 'La ficha ya está aprobada' : 'Solo se devuelve una ficha enviada a revisión' });
    await guardarFichaDigital(supabase, p.id, cod, { estado: 'observada', revisado_por: req.usuario.id, revisada_en: new Date().toISOString(), nota_revision: nota });
    res.json({ fichas: await vistaFichas(p) });
  }));
  async function leerFotosOVacio(proyectoId, cod) {
    try { return await leerFotos(supabase, proyectoId, cod); }
    catch (e) { if (faltaMigracionFichas(e)) return []; throw e; }
  }
  // Copia las fotos de la ficha aprobada al sustento del local (así salen en el expediente y su ZIP).
  // Una foto que no se puede copiar no frena la aprobación: se cuenta y se informa.
  async function copiarFotosAlSustento(p, cod, fotos, fecha) {
    const out = { copiadas: 0, fallidas: 0 };
    const bucket = supabase.storage.from(BUCKET_EXPEDIENTE);
    for (const [n, f] of fotos.entries()) {
      const ext = f.ruta.split('.').pop(), destino = `${p.id}/${nombreSeguro(cod)}/${Date.now()}_campo_${f.id}.${ext}`;
      const { error: eCp } = await bucket.copy(f.ruta, destino);
      if (eCp) { console.error('[EXPEDIENTE] Foto de campo no copiada:', eCp.message); out.fallidas++; continue; }
      const lugar = lugarFoto(f), detalle = [f.aula == null ? null : f.muestra, f.tomada_en ? 'tomada el ' + String(f.tomada_en).slice(0, 10).split('-').reverse().join('/') : null,
        f.lat != null ? `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}` : null, f.subido_por_email].filter(Boolean).join(' · ');
      const { error } = await supabase.from('ioarr_expediente_archivos').insert({
        proyecto_id: p.id, cod_local: cod, tipo: 'foto', nombre_archivo: `Foto ${n + 1} - ${nombreSeguro(lugar)}.${ext}`, ruta: destino, mime: f.mime, tamano: f.tamano,
        descripcion: texto(`Ficha en la app: ${lugar}${detalle ? ' · ' + detalle : ''}`, 300), subido_por: null
      });
      if (error) { console.error('[EXPEDIENTE] Foto de campo no registrada:', error.message); await borrarDelBucket([destino]); out.fallidas++; continue; }
      out.copiadas++;
    }
    return out;
  }
  // El PDF de la ficha aprobada queda en el sustento del local como acta de verificación
  async function guardarActaPdf(p, cod, ficha) {
    try {
      const F = await fichaLocal(p, cod);
      const buffer = await pdfFichaLlena(supabase, p.id, cod, F, ficha);
      const nombre = nombrePdfLlena(F), ruta = `${p.id}/${nombreSeguro(cod)}/${Date.now()}_${nombre}`;
      const { error: eUp } = await supabase.storage.from(BUCKET_EXPEDIENTE).upload(ruta, buffer, { contentType: 'application/pdf' });
      if (eUp) throw eUp;
      const { error } = await supabase.from('ioarr_expediente_archivos').insert({ proyecto_id: p.id, cod_local: cod, tipo: 'acta', nombre_archivo: nombre, ruta, mime: 'application/pdf', tamano: buffer.length,
        descripcion: texto(`Ficha de verificación llenada en la app${ficha.por ? ' por ' + ficha.por : ''}, con fotos y firmas en pantalla`, 300), subido_por: null });
      if (error) { await borrarDelBucket([ruta]); throw error; }
      return true;
    } catch (e) { console.error('[EXPEDIENTE] Acta PDF de la ficha no guardada:', e.message); return false; }
  }
  api.get('/proyectos/:id/fichas/:cod/digital/pdf', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    const f = await fichaDigitalDe(p, cod), F = await fichaLocal(p, cod);
    const nombre = nombrePdfLlena(F);
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${nombre}"` })
      .send(await pdfFichaLlena(supabase, p.id, cod, F, f));
  }));
  api.get('/proyectos/:id/fichas/:cod/digital/firmas/:cargo', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    let firmas;
    try { firmas = await leerFirmas(supabase, p.id, cod); } catch (e) { if (faltaMigracionFichas(e)) firmas = []; else throw e; }
    const f = firmas.find(x => x.cargo === req.params.cargo);
    if (!f) return res.status(404).json({ error: 'Sin firma' });
    const r = await descargarFoto(supabase, f);
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.set({ 'Content-Type': r.mime, 'Cache-Control': 'private, no-cache' }).send(r.buffer);
  }));
  // Una foto de la ficha, para la revisión
  api.get('/proyectos/:id/fichas/:cod/digital/fotos/:fotoId', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    if (!esUuidFoto(req.params.fotoId)) return res.status(404).json({ error: 'Foto no encontrada' });
    const { data: f, error } = await supabase.from('campo_fichas_fotos').select('ruta, ruta_mini').eq('id', req.params.fotoId).eq('proyecto_id', p.id).eq('codigo_local', cod).maybeSingle();
    if (error) throw error;
    if (!f) return res.status(404).json({ error: 'Foto no encontrada' });
    const r = await descargarFoto(supabase, f, !!req.query.mini);
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.set({ 'Content-Type': r.mime, 'Cache-Control': 'private, max-age=86400' }).send(r.buffer);
  }));

  // Para Visitas de campo (src/selector-ioarr/campo.js, por router.js): el proyecto ya viene validado
  api.fichaLocal = fichaLocal;
  // Varias fichas de una vez (para llevarlas al equipo sin señal): una sola carga de la región y del reparto
  api.fichasLocales = async (p, cods) => {
    const [D, codigos, R] = await Promise.all([cargarRegion(p.region), leerCodigos(p.id), asignacionesProyecto(supabase, p.id)]);
    if (!D) { const e = new Error('No hay datos para la región ' + p.region); e.status = 400; throw e; }
    const C = calc(D, limpiarParams(p.criterios)), del = new Set(codigos), fecha = hoyLima(), out = {};
    const idx = new Map(D.locs.map((l, i) => [l[0], i]));
    for (const cod of cods) {
      if (!del.has(cod) || !idx.has(cod)) continue;
      const sup = R.asignaciones?.[cod];
      out[cod] = modeloFicha(D, C, idx.get(cod), { proyecto: { id: p.id, nombre: p.nombre }, anio: p.anio_datos, fecha, supervisor: sup ? R.supervisores[sup] || '' : '' });
    }
    return out;
  };
  api.validarFichaDigital = async (p, cod, datos, origen) => validarFicha(await contextoFichas(p), fichaDesdeFormulario(datos, { proyectoId: p.id, cod, region: p.region }), origen);

  // ─── Documentos: Formato 07-C y memoria descriptiva ───────────────────────
  async function leerDatosDoc(p) {
    const { data, error } = await supabase.from('ioarr_expediente_documentos').select('datos').eq('proyecto_id', p.id).maybeSingle();
    if (error) { if (faltaMigracion(error)) return { datos: limpiarDatosDoc({}), sinMigracion: true }; throw error; }
    return { datos: limpiarDatosDoc(data?.datos || {}), sinMigracion: false };
  }
  const modeloDe = (A, x, datos, p) => modeloIoarr(A, x, datos, p, hoyLima());
  async function modelo(p, nivel, opciones) {
    const [A, { datos, sinMigracion }] = await Promise.all([armar(p, opciones), leerDatosDoc(p)]);
    const x = elegir(A, nivel);
    return { M: modeloDe(A, x, datos, p), datos, sinMigracion, A, x };
  }
  // Todas las IOARR del proyecto (ZIP y Radar)
  async function modelos(p, opciones) {
    const [A, { datos }] = await Promise.all([armar(p, opciones), leerDatosDoc(p)]);
    return { A, datos, lista: A.ioarrs.map(x => ({ x, M: modeloDe(A, x, datos, p) })) };
  }
  // Lo que necesita el formulario: datos guardados, lo que se propone y lo que falta
  const vistaDoc = ({ M, datos, sinMigracion, A, x }, p) => ({
    modo: A.modo, nivel: x.nivel, nombre_ioarr: x.nombre, ioarrs: A.ioarrs.map(y => ({ nivel: y.nivel, nombre: y.nombre })), comparativo: A.comparativo,
    datos: { ...datos, colegios: undefined }, sin_migracion: sinMigracion, estados: ESTADOS_ACTIVO, verificacion: M.verificacion, ioarr: p?.ioarr || null,
    borrador: M.borrador, bloqueados: M.bloqueados.map(b => ({ cod: b.cod, nom: b.nom })),
    modalidades: MODALIDADES, fuentes: FUENTES_FIN, fuentes_vida_util: FUENTES_VIDA_UTIL, escenario: M.escenarioTexto, kit: M.kit,
    vida_util: { colegios: M.vidaUtil.colegios.map(x => ({ cod: x.cod, colegio: x.colegio })), regular_sin: M.vidaUtil.regularSin, faltan: M.vidaUtil.faltan },
    resumen: {
      nombre: M.nombre, nombre_sugerido: M.nombreSugerido, cui: M.cui, masiva: M.masiva, registro: M.registro,
      total: M.F.total, en_uit: M.uit.enUit, uit: M.uit.valor ? { anio: M.uit.anio, valor: M.uit.valor } : null,
      ups: M.upsRegistro.length, up_por: M.upPor, locales_con_bienes: M.ups.length, sin_rep: M.sinRep.map(x => x.cod), ugels: M.ugels, mantenimiento_sugerido: M.ugels.join(', '),
      metas: M.F.metas.map(m => ({ k: m.k, nombre: m.nombre, cantidad: m.cantidad, unidad: m.unidad })), grupos: M.A.grupos, funcion: M.A.funcion, division: M.A.division, plazo: M.F.plazo,
      tipos: M.E.activos.map(a => ({ k: a.k, nombre: a.nombre, cantidad: a.cantidad, descripcion: a.descripcion, antiguedad_inventario: a.antiguedad_inventario })),
      alineamiento: { servicio: M.A.servicio, tipologia: M.A.tipologia, indicadores: M.A.indicadores, cadena: `${M.A.funcion} / ${M.A.division} / ${M.A.grupos.join('; ')}`, contribucion: M.A.contribucion },
      b05: M.B05,
      cotizaciones: M.cotizaciones, bienes_cotizacion: BIENES_COTIZACION, min_proveedores: MIN_PROVEEDORES,
      niveles_k: M.nivel ? [M.nivel] : [], nombres_nivel: NOMBRE_NIVEL, grupos_conocidos: CODIGOS_FUNCIONALES.grupo,
      inicio: M.F.inicio, fin: M.F.fin, condiciones: M.E.condiciones
    },
    faltan: M.faltan
  });

  // ─── Por colegio: datos de los Lineamientos (checklist de inventario y baja…) ─
  // Se guardan en ioarr_expediente_documentos.datos.colegios (migración 015).
  function vistaColegios(A) {
    const { D } = A, porCod = {};
    for (const x of A.ioarrs) for (const l of x.R.locales) {
      const o = porCod[l.cod] ??= { rep: 0, kits: 0, total: 0, niveles: [], inconsistente: false, recortado: 0, faltante: 0 };
      o.rep += l.rep.reduce((a, b) => a + b, 0); o.kits += l.kits; o.total += l.total; if (x.nivel) o.niveles.push({ nivel: x.nivel, nombre: x.nombre, total: l.total, matricula: l.tope?.matricula ?? l.est, capacidad: l.tope?.capacidad ?? null });
      o.inconsistente ||= !!l.tope?.inconsistente; o.recortado += (l.tope?.recorte[0] || 0) + (l.tope?.recorte[1] || 0) + (l.tope?.kits || 0); o.faltante += l.fal[0] + l.fal[1];
    }
    const fila = (i, excluido) => {
      const cod = D.locs[i][0], c = colegioDe(A.colegios, cod);
      return { cod, nombre: D.locName[i], dist: D.dists[D.locs[i][1]][0], niveles: nivelesDeLocal(D, i).map(n => NOMBRE_NIVEL[n]), est: D.locEst[i], aulas: D.locAul[i].length,
        datos: c, checklist: A.checklist[cod] || checklistColegio(c), riesgo: A.riesgos?.[cod] ? { riesgo: A.riesgos[cod].riesgo, motivos: A.riesgos[cod].motivos } : null,
        niveles_k: nivelesDeLocal(D, i), excluido_dup: excluido, costo: porCod[cod] || null };
    };
    const filas = [...A.list.map(i => fila(i, false)), ...(A.fueraUso || []).map(i => ({ ...fila(i, false), sin_uso: true })), ...A.excluidos.map(i => fila(i, true))];
    return {
      filas, docs_baja: DOCS_BAJA, estados_uso: ESTADOS_USO, fuentes_entrega: FUENTES_ENTREGA, tipos_entrega: TIPOS_ENTREGA, ventana: VENTANA_DUP, anio: A.anioRef,
      resumen: { colegios: A.list.length, bloqueados: A.bloqueados.length, completos: A.list.length - A.bloqueados.length, excluidos_dup: A.excluidos.length,
        riesgo: Object.values(A.riesgos || {}).filter(r => r.riesgo).length, inconsistentes: A.comparativo.inconsistentes, sin_uso: (A.fueraUso || []).length },
      comparativo: A.comparativo
    };
  }
  api.get('/proyectos/:id/colegios', responder(async (req, res) => {
    res.json(vistaColegios(await armar(await proyecto(req))));
  }));
  api.put('/proyectos/:id/colegios/:cod', responder(async (req, res) => {
    const p = await proyecto(req), cod = String(req.params.cod);
    if (!(await leerCodigos(p.id)).includes(cod)) return res.status(404).json({ error: 'Ese local no está en el proyecto' });
    const { datos, sinMigracion } = await leerDatosDoc(p);
    if (sinMigracion) return res.status(503).json({ error: AVISO_DOC });
    const c = limpiarColegio(req.body?.datos || {}), colegios = { ...datos.colegios };
    if (colegioVacio(c)) delete colegios[cod]; else colegios[cod] = c;
    const { error } = await supabase.from('ioarr_expediente_documentos').upsert({ proyecto_id: p.id, datos: { ...datos, colegios }, actualizado_en: new Date().toISOString() }, { onConflict: 'proyecto_id' });
    if (error) throw error;
    res.json({ cod, datos: colegioDe(colegios, cod), checklist: checklistColegio(colegioDe(colegios, cod), { registrado: datos.inventario_registrado }) });
  }));

  api.get('/proyectos/:id/documentos', responder(async (req, res) => {
    const p = await proyecto(req);
    res.json(vistaDoc(await modelo(p, req.query.nivel, opcionesDe(req)), p));
  }));

  api.patch('/proyectos/:id/documentos', responder(async (req, res) => {
    const p = await proyecto(req);
    // Se fusiona con lo guardado: Documentos y Verificación mandan solo lo suyo
    const { datos: actual } = await leerDatosDoc(p);
    const { colegios: _, ...cambios } = req.body?.datos || {};   // los colegios se guardan con PUT /colegios/:cod
    const datos = limpiarDatosDoc({ ...actual, ...cambios });
    const { error } = await supabase.from('ioarr_expediente_documentos').upsert({ proyecto_id: p.id, datos, actualizado_en: new Date().toISOString() }, { onConflict: 'proyecto_id' });
    if (error) { if (faltaMigracion(error)) return res.status(503).json({ error: AVISO_DOC }); throw error; }
    res.json(vistaDoc(await modelo(p, req.query.nivel, opcionesDe(req)), p));
  }));

  const sufijo = M => (M.nivel ? '_' + slug(M.nombreIoarr) : '') + (M.borrador && M.bloqueados?.length ? '_BORRADOR' : '');
  // ?borrador=1: todos los colegios; sin eso, solo los que tienen el checklist de inventario y baja completo
  const opcionesDe = req => ({ final: req.query.borrador !== '1' });
  const sinUps = M => M.bloqueados?.length
    ? `Ningún colegio de esta IOARR con bienes a reponer tiene completo el checklist de inventario y baja (${M.bloqueados.length} ${M.bloqueados.length === 1 ? 'bloqueado' : 'bloqueados'}). Complétalo en «Por colegio» o descarga el borrador.`
    : 'Ningún local del proyecto tiene bienes a reponer';
  const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const enviarWord = (res, buffer, archivo) => res.set({
    'Content-Type': WORD, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`
  }).send(buffer);

  api.get('/proyectos/:id/documentos/formato-07c', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel, opcionesDe(req));
    if (!M.ups.length) return res.status(400).json({ error: sinUps(M) });
    enviarWord(res, await generar07C(M), `Formato_07C_borrador_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.docx`);
  }));

  api.get('/proyectos/:id/documentos/memoria', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel, opcionesDe(req));
    if (!M.ups.length) return res.status(400).json({ error: sinUps(M) });
    enviarWord(res, await generarMemoria(M), `Memoria_descriptiva_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.docx`);
  }));

  api.get('/proyectos/:id/documentos/verificacion', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel, opcionesDe(req));
    if (!M.ups.length) return res.status(400).json({ error: sinUps(M) });
    enviarWord(res, await generarVerificacion(M), `Lista_verificacion_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.docx`);
  }));

  // Informe de sustento de la inversión masiva (con el consolidado por UGEL y nivel)
  api.get('/proyectos/:id/documentos/sustento', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel, opcionesDe(req));
    if (!M.ups.length) return res.status(400).json({ error: sinUps(M) });
    enviarWord(res, await generarSustento(M), `Informe_sustento_masiva_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.docx`);
  }));

  // Modelos de carta: ?tipo=opinion|compromiso|oficio, ?por=ugel|colegio (solo la opinión favorable)
  api.get('/proyectos/:id/documentos/cartas', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel, opcionesDe(req));
    if (!M.ups.length) return res.status(400).json({ error: sinUps(M) });
    const tipo = TIPOS_CARTA[req.query.tipo] ? req.query.tipo : 'opinion', por = req.query.por === 'colegio' ? 'colegio' : 'ugel';
    enviarWord(res, await generarCartas(M, tipo, por), `Modelo_${tipo}_${tipo === 'opinion' ? por : 'ugel'}_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.docx`);
  }));

  // Formato 05-B: idea de la IOARR del nivel, con los montos por año
  api.get('/proyectos/:id/documentos/formato-05b', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel, opcionesDe(req));
    if (!M.ups.length) return res.status(400).json({ error: sinUps(M) });
    enviarWord(res, await generar05B(M), `Formato_05B_idea_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.docx`);
  }));

  // Informe técnico de vida útil: consolidado de la IOARR o de un colegio (?cod=)
  api.get('/proyectos/:id/documentos/vida-util', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel, opcionesDe(req));
    if (!M.ups.length) return res.status(400).json({ error: sinUps(M) });
    const cod = req.query.cod ? String(req.query.cod) : null;
    if (cod && !M.vidaUtil.colegios.some(x => x.cod === cod)) return res.status(404).json({ error: 'Ese colegio no tiene bienes a reponer en esta IOARR' });
    enviarWord(res, await generarVidaUtil(M, M.vidaUtil, cod), `Informe_vida_util_${slug(p.nombre)}${sufijo(M)}${cod ? '_' + cod : ''}_${M.fecha}.docx`);
  }));

  api.get('/proyectos/:id/costos/excel', responder(async (req, res) => {
    const p = await proyecto(req), A = await armar(p), x = elegir(A, req.query.nivel);
    if (!x?.R.locales.length) return res.status(400).json({ error: 'El proyecto no tiene locales seleccionados' });
    const fecha = hoyLima();
    const buffer = await generarExcelCostos(x.R, {
      proyecto: x.nivel ? `${p.nombre} — IOARR ${x.nombre}` : p.nombre, region: p.region, fecha, ioarr: p.ioarr, fuente: (await leerIndice()).fuente,
      criterios: textoCriterios(A.P), escenario: textoEscenario(A.P, regDato(x.R)), precios: A.detalle, efectivos: A.efectivos, inventario: x.inv,
      cotizaciones: cuadroCotizaciones(A.datosDoc?.cotizaciones?.[x.nivel] || [], A.estructura?.igv ?? 18)
    });
    const archivo = `Costos_IOARR_${slug(p.nombre)}${x.nivel ? '_' + slug(x.nombre) : ''}_${fecha}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
      'Cache-Control': 'no-store'
    }).send(buffer);
  }));

  // Anexos de los Lineamientos IOARR (ficha de activos a reponer…), por IOARR
  api.get('/proyectos/:id/lineamientos/anexos', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel, opcionesDe(req));
    if (!M.ups.length) return res.status(400).json({ error: sinUps(M) });
    const buffer = await generarExcelLineamientos(anexosDe(M), { proyecto: p.nombre, nombreIoarr: M.nombreIoarr, region: p.region, fecha: M.fecha });
    const archivo = `Anexos_Lineamientos_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
      'Cache-Control': 'no-store'
    }).send(buffer);
  }));

  // Listado de UP y activos, y consolidado por UGEL y nivel (paquete tipo Huánuco), por IOARR
  api.get('/proyectos/:id/paquete/up-activos', responder(async (req, res) => {
    const p = await proyecto(req), { M } = await modelo(p, req.query.nivel, opcionesDe(req));
    if (!M.ups.length) return res.status(400).json({ error: sinUps(M) });
    const archivo = `Listado_UP_y_consolidado_${slug(p.nombre)}${sufijo(M)}_${M.fecha}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
      'Cache-Control': 'no-store'
    }).send(await generarExcelPaquete(M.paquete, { proyecto: p.nombre, nombreIoarr: M.nombreIoarr, fecha: M.fecha }));
  }));

  // ─── Etapa 4: ZIP del expediente ──────────────────────────────────────────
  // Se arma en flujo (archiver): los archivos del bucket se agregan de a uno, así
  // la memoria no crece con el número de fotos. La oferta (uso interno) no se lee aquí:
  // queda fuera del ZIP a propósito.
  api.get('/proyectos/:id/expediente-zip', responder(async (req, res) => {
    const p = await proyecto(req), { A, datos, lista: todas } = await modelos(p, opcionesDe(req));
    // Solo las IOARR con algo que reponer
    const lista = todas.filter(y => y.M.ups.length);
    if (!lista.length) return res.status(400).json({ error: sinUps(todas[0]?.M || { bloqueados: [] }) });
    const fecha = lista[0].M.fecha, base = `Expediente_IOARR_${slug(p.nombre)}_${fecha}`;
    const meta = { region: p.region, fecha, ioarr: p.ioarr, fuente: (await leerIndice()).fuente };
    const porNiv = A.modo === 'por_nivel';
    // Todo lo que puede fallar se genera antes de empezar a enviar. La oferta (uso interno) no se pasa.
    const [piezas, archivos] = await Promise.all([
      piezasExpediente({ A, datos, lista, meta, nombre: p.nombre }),
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
  // Generador de bases OxI (bases-api.js): las IOARR del proyecto y el modelo de una (por nivel).
  // Toma los colegios del 07-C final; si ninguno tiene el checklist completo, los del borrador.
  api.ioarrsBases = async (p) => (await armar(p)).ioarrs.map(x => ({ nivel: x.nivel, nombre: x.nombre }));
  // Material de la propuesta (Costos): lo usa el catálogo de precios referenciales para la referencia de las bases
  api.materialPropuesta = async (p) => {
    const { data, error } = await supabase.from('ioarr_expediente_costos').select('estructura').eq('proyecto_id', p.id).maybeSingle();
    if (error) { if (faltaMigracion(error) || /estructura/.test(error.message || '')) return null; throw error; }
    return limpiarEstructura(data?.estructura).material_propuesta || null;
  };
  // Catálogo de precios referenciales (catalogo-ref-api.js): lo necesario para recalcular cada IOARR con otro precio por kit
  api.costosPorNivel = async (p) => (await armar(p)).ioarrs.map(x => ({
    nivel: x.nivel, nombre: x.nombre, kit: !!x.R.kit, T: x.R.totales, params: x.R.estructura.params,
    kits: x.R.kit ? x.R.totales.kits : 0, kitBienes: (x.R.lineasKit || []).reduce((a, y) => a + y.parcial, 0)
  }));
  api.modeloBases = async (p, nivel) => {
    let r = await modelo(p, nivel, { final: true });
    if (!r.M.ups.length) r = await modelo(p, nivel, { final: false });
    if (nivel && r.x.nivel !== nivel) { const e = new Error('Ese nivel no tiene IOARR en el proyecto'); e.status = 400; throw e; }
    return { M: r.M, nivel: r.x.nivel, nombre: r.x.nombre, datos: r.datos };
  };

  return api;
}

/**
 * Documentos del ZIP del expediente (Word y Excel), una carpeta por IOARR si son por nivel.
 * Solo recibe lo exportable: el cálculo, los datos de Documentos y la meta. La oferta
 * (uso interno, ioarr_expediente_oferta) no entra: este armado no la recibe ni la lee.
 * @param A      resultado de armar() (modo, P, detalle, efectivos, excluidos, dup)
 * @param lista  [{ x: IOARR (nivel, nombre, D, C, list, R, inv), M: modelo de armarModelo }]
 */
export async function piezasExpediente({ A, datos, lista, meta, nombre }) {
  const porNiv = A.modo === 'por_nivel';
  const xs = await Promise.all(lista.map(async ({ x, M }, j) => {
    M.fichaActivos ??= fichaActivos({ x, P: A.P, datos, anioRef: M.anioRef });
    M.vidaUtil ??= modeloVidaUtil({ ficha: M.fichaActivos, datos, umbral: A.P.umbralVida, nombreIoarr: x.nombre });
    const carpeta = porNiv ? `${String(j + 1).padStart(2, '0')}_IOARR_${nombreSeguro(x.nombre)}/` : '';
    const m = { ...meta, proyecto: porNiv ? `${nombre} — IOARR ${x.nombre}` : nombre };
    // Informe de vida útil: consolidado y uno por colegio
    const vidaPorColegio = await Promise.all(M.vidaUtil.colegios.map(async y => ({ nombre: `${carpeta}07_Informes_vida_util_por_colegio/Informe_vida_util_${y.cod}.docx`, contenido: await generarVidaUtil(M, M.vidaUtil, y.cod), oculto: true })));

    const fuera = x.nivel ? (A.excluidos || []).filter(i => x.D.locSvc[i].length) : (A.excluidos || []);
    const [f07c, memoria, verificacion, costos, { buffer: seleccion }, anexos, vida, f05b, upActivos, sustento, cOpinion, cCompromiso, cOficio] = await Promise.all([
      generar07C(M), generarMemoria(M), generarVerificacion(M),
      generarExcelCostos(x.R, { ...m, criterios: textoCriterios(A.P), escenario: textoEscenario(A.P, regDato(x.R)), precios: A.detalle, efectivos: A.efectivos, inventario: x.inv, cotizaciones: M.cotizaciones }),
      generarExcel(x.D, x.C, A.P, x.list, { ...m, duplicidad: A.dup, excluidos: fuera, revisiones: datos.situacional?.revisiones }),
      generarExcelLineamientos(anexosDe(M), { ...m, nombreIoarr: M.nombreIoarr }),
      generarVidaUtil(M, M.vidaUtil),
      generar05B(M),
      M.paquete ? generarExcelPaquete(M.paquete, { ...m, nombreIoarr: M.nombreIoarr }) : null,
      generarSustento(M),
      generarCartas(M, 'opinion', 'ugel'), generarCartas(M, 'compromiso'), generarCartas(M, 'oficio')
    ]);
    return [
      { nombre: carpeta + '00_Formato_05B_idea.docx', contenido: f05b, descripcion: 'idea de la IOARR con los montos por año' },
      { nombre: carpeta + '01_Formato_07C_borrador.docx', contenido: f07c, descripcion: 'borrador del Formato 07-C' },
      { nombre: carpeta + '02_Memoria_descriptiva.docx', contenido: memoria },
      { nombre: carpeta + '03_Lista_de_verificacion.docx', contenido: verificacion },
      { nombre: carpeta + '04_Estructura_de_costos.xlsx', contenido: costos, descripcion: 'con fórmulas' },
      { nombre: carpeta + '05_Seleccion_de_locales_y_metrado.xlsx', contenido: seleccion, descripcion: 'metrado por aula del Selector' },
      { nombre: carpeta + '06_Anexos_Lineamientos.xlsx', contenido: anexos, descripcion: 'ficha de activos a reponer' },
      { nombre: carpeta + '07_Informe_vida_util.docx', contenido: vida, descripcion: 'consolidado; uno por colegio en la carpeta 07' },
      ...vidaPorColegio,
      { nombre: carpeta + '10_Informe_sustento_masiva.docx', contenido: sustento, descripcion: 'con el consolidado por UGEL y nivel' },
      { nombre: carpeta + '11_Cartas/Carta_opinion_favorable_por_UGEL.docx', contenido: cOpinion, descripcion: 'modelo, una por UGEL' },
      { nombre: carpeta + '11_Cartas/Carta_compromiso_O_y_M_por_UGEL.docx', contenido: cCompromiso, descripcion: 'modelo, una por UGEL' },
      { nombre: carpeta + '11_Cartas/Oficio_remision_por_UGEL.docx', contenido: cOficio, descripcion: 'modelo, uno por UGEL' },
      ...(upActivos ? [{ nombre: carpeta + '08_Listado_UP_y_consolidado.xlsx', contenido: upActivos, descripcion: 'UP y activos; consolidado por UGEL y nivel' }] : [])
    ];
  }));
  return xs.flat();
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

// Lo que va al Excel de anexos de los Lineamientos, desde el modelo de una IOARR
export const anexosDe = M => ({ ficha: M.fichaActivos, checklist: M.checklist || [], riesgos: M.riesgos || [], capacidad: M.capacidad || [], uso: M.uso || [], anioRef: M.anioRef, borrador: !!M.borrador });

export function textoCriterios(P) {
  const est = { b: 'Bueno', r: 'Regular', m: 'Malo' }[P.carpEstado];
  const muebles = ITEMS.filter(x => !P.muebles || P.muebles.includes(x.k)).map(x => x.n.toLowerCase()).join(', ');
  const porNivel = Object.entries(P.mueblesNivel || {}).map(([n, m]) => `${NOMBRE_NIVEL[n]}: ${ITEMS.filter(x => m.includes(x.k)).map(x => x.n.toLowerCase()).join(', ')}`);
  return `${textoEscenario(P)} · Muebles de la IOARR: ${muebles}${porNivel.length ? ` (composición propia en ${porNivel.join('; ')})` : ''} · ` + CRIT.map(([k, l]) => `${l}: ${P[k]}`).join(' · ') + ` · Estado asignado a las carpetas: ${est}`
    + ' · Mesa y silla por talla según el grado del aula (multigrado: en partes iguales entre las tallas del nivel)';
}

