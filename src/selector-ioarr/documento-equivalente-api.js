// ============================================================================
// src/selector-ioarr/documento-equivalente-api.js — API del borrador del documento equivalente
//
// Se monta dentro de /api/selector-ioarr (router.js): sesión y rol proveedor.
// Solo el dueño del proyecto. Tablas: supabase/migrations/034_ioarr_documento_equivalente.sql
//
//   GET    /proyectos/:id/documento-equivalente      fichas, IOARR (niveles) y definición de campos y secciones
//   POST   /proyectos/:id/documento-equivalente      { nivel } ficha nueva, precargada (app y ficha de bases del nivel)
//   GET    /documento-equivalente/:fid               ficha + presupuesto + validación
//   PATCH  /documento-equivalente/:fid               { datos?, nombre? } (se fusiona; el PDF de cada cotización lo pone el servidor)
//   POST   /documento-equivalente/:fid/precargar     vuelve a tomar de la app lo que está vacío
//   DELETE /documento-equivalente/:fid               (borra también los PDF del legajo)
//   POST   /documento-equivalente/:fid/cotizaciones/:cid/archivo   multipart «archivo»: el PDF de la cotización
//   GET    /documento-equivalente/:fid/cotizaciones/:cid/archivo   URL firmada de 10 minutos
//   DELETE /documento-equivalente/:fid/cotizaciones/:cid/archivo
//   GET    /documento-equivalente/:fid/vista-previa  .docx con lo pendiente resaltado (sin versión)
//   POST   /documento-equivalente/:fid/exportar      valida (422 con los errores) → .docx y guarda la versión
//   GET    /documento-equivalente/:fid/versiones     versiones exportadas (número, fecha, usuario)
//   GET    /documento-equivalente/:fid/versiones/:v/docx  el .docx de esa versión, regenerado desde lo guardado
//
// La oferta (uso interno) no se lee aquí.
// ============================================================================

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { supabase } from '../ioarr/db.js';
import {
  limpiarFicha, validarFicha, precargar, contextoDe, TOMOS, CAMPOS, CONTROLES, OBLIGATORIAS, BIENES, MIN_COTIZACIONES, MIN_JUSTIFICACION,
  HASH_PLANTILLAS, MANIFEST, IGV_PCT
} from './documento-equivalente.js';
import { ESPECIFICACIONES } from './bases-especificaciones.js';
import { limpiarFicha as limpiarFichaBases } from './bases.js';
import { generarDocumentoEquivalenteDocx } from './word-documento-equivalente.js';
import { goreDe } from './entidades-gore.js';
import { BUCKET_EXPEDIENTE, MAX_ARCHIVO, mimeDe, nombreUtf8, nombreSeguro } from './archivos.js';

export const AVISO_DE = 'Falta ejecutar supabase/migrations/034_ioarr_documento_equivalente.sql en Supabase para guardar el documento equivalente';
const faltaMigracion = e => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
const esUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));
const NIVELES = ['I', 'P', 'S', 'E'];
const hoyLima = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(d);
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'documento';
const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const error = (status, msg) => Object.assign(new Error(msg), { status });
const TABLA = 'ioarr_de_fichas', VERSIONES = 'ioarr_de_versiones';

export function crearApiDocumentoEquivalente({ expediente, preciosRef = null }) {
  const api = express.Router();
  const responder = fn => async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) {
      if (faltaMigracion(e)) return res.status(503).json({ error: AVISO_DE });
      if (e.status) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
      if (e.code === '23505') return res.status(409).json({ error: 'Otra exportación guardó esa versión al mismo tiempo; vuelve a intentarlo' });
      next(e);
    }
  };
  const ok = ({ data, error: e }) => { if (e) throw e; return data; };
  const recibir = (req, res, next) => multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARCHIVO, files: 1 } }).single('archivo')(req, res, err => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `El PDF pasa de ${MAX_ARCHIVO / 1024 / 1024} MB` : 'No se pudo recibir el archivo: ' + err.message });
  });

  async function proyectoDe(id, usuarioId) {
    if (!esUuid(id)) return null;
    return ok(await supabase.from('ioarr_selector_proyectos').select('*').eq('id', id).eq('usuario_id', usuarioId).maybeSingle());
  }
  async function fichaDe(req) {
    if (!esUuid(req.params.fid)) throw error(404, 'Ficha no encontrada');
    const f = ok(await supabase.from(TABLA).select('*').eq('id', req.params.fid).maybeSingle());
    const p = f && await proyectoDe(f.proyecto_id, req.usuario.id);
    if (!f || !p) throw error(404, 'Ficha no encontrada');
    return { f, p };
  }
  async function entidadRadar(p) {
    if (!p.ioarr_proyecto_id) return null;
    const { data } = await supabase.from('ioarr_proyectos').select('id, cui, nombre, entidad').eq('id', p.ioarr_proyecto_id).maybeSingle();
    return data || null;
  }
  // Ficha de bases más reciente del mismo nivel (si la tabla no existe todavía, ninguna)
  async function fichaBases(p, nivel) {
    const { data, error: e } = await supabase.from('ioarr_bases_fichas').select('datos, actualizado_en').eq('proyecto_id', p.id).eq('nivel', nivel).order('actualizado_en', { ascending: false });
    if (e) { if (faltaMigracion(e)) return null; throw e; }
    return data?.[0] ? limpiarFichaBases(data[0].datos) : null;
  }
  // Lo que la app sabe de la IOARR de ese nivel. Sin locales o sin cálculo: contexto vacío con aviso.
  async function appDe(p, nivel) {
    try {
      const r = await expediente.modeloBases(p, nivel);
      const ref = preciosRef ? await preciosRef.referenciaBases(p, r.nivel) : null;
      return { r, ctx: contextoDe(r.M, r.nivel, r.nombre, ref), aviso: null };
    } catch (e) {
      if (e.status && e.status < 500) return { r: null, ctx: { nivel, metas: [], locales: [], igv: IGV_PCT }, aviso: e.message };
      throw e;
    }
  }
  async function precargaDe(p, nivel) {
    const [{ r, ctx, aviso }, radar, bases] = await Promise.all([appDe(p, nivel), entidadRadar(p), fichaBases(p, nivel)]);
    return { ...precargar({ M: r?.M || null, ctx, bases, radar, gore: goreDe(p.region), datosDoc: r?.datos || {} }), ctx, aviso };
  }
  const numVersiones = async fid => ok(await supabase.from(VERSIONES).select('version').eq('ficha_id', fid)).length;

  async function vista(f, p, extra = {}) {
    const d = limpiarFicha(f.datos), hoy = hoyLima();
    const { ctx, aviso } = extra.app || await appDe(p, f.nivel);
    const V = validarFicha(d, ctx, { hoy });
    return {
      ficha: { id: f.id, proyecto_id: f.proyecto_id, nivel: f.nivel, nombre: f.nombre, actualizado_en: f.actualizado_en },
      datos: d, hoy,
      validacion: { ok: V.ok, errores: V.errores, advertencias: V.advertencias },
      presupuesto: V.presupuesto, catalogo: V.catalogo,
      app: { nivel_nombre: ctx.nivel_nombre || null, metas: ctx.metas || [], locales: (ctx.locales || []).length, total_activos: ctx.total_activos ?? null,
        precio_ref: ctx.precio_ref || null, borrador: !!ctx.borrador, aviso },
      versiones: await numVersiones(f.id),
      ...extra.respuesta
    };
  }

  // Los PDF y los ids de las cotizaciones los controla el servidor: del navegador solo llegan los datos
  function fusionarCotizaciones(previas = [], nuevas) {
    if (!Array.isArray(nuevas)) return previas;
    const porId = new Map(previas.map(c => [c.id, c]));
    return nuevas.map(c => {
      const prev = porId.get(c?.id);
      return { ...c, id: prev ? prev.id : randomUUID(), archivo_ruta: prev?.archivo_ruta || null, archivo_nombre: prev?.archivo_nombre || null };
    });
  }
  const rutasDe = cs => (cs || []).map(c => c.archivo_ruta).filter(Boolean);
  const quitarArchivos = async rutas => { if (rutas.length) await supabase.storage.from(BUCKET_EXPEDIENTE).remove(rutas); };

  // ─── Fichas del proyecto ──────────────────────────────────────────────────
  api.get('/proyectos/:id/documento-equivalente', responder(async (req, res) => {
    const p = await proyectoDe(req.params.id, req.usuario.id);
    if (!p) throw error(404, 'Proyecto no encontrado');
    let fichas = [], sinMigracion = false;
    const r = await supabase.from(TABLA).select('id, nivel, nombre, actualizado_en').eq('proyecto_id', p.id).order('creado_en');
    if (r.error) { if (!faltaMigracion(r.error)) throw r.error; sinMigracion = true; } else fichas = r.data;
    let niveles = [];
    try { niveles = await expediente.ioarrsBases(p); } catch (e) { if (!e.status) throw e; }
    res.json({ fichas, niveles, sin_migracion: sinMigracion, campos: CAMPOS, controles: CONTROLES, fuentes: MANIFEST.fuentes, aviso: MANIFEST.aviso,
      tomos: TOMOS.map(t => ({ id: t.id, titulo: t.titulo, secciones: t.secciones.map(s => ({ id: s.id, titulo: s.titulo, campos: [...s.texto.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(m => m[1]) })) })),
      obligatorias: OBLIGATORIAS, bienes: BIENES, especificaciones: ESPECIFICACIONES, min_cotizaciones: MIN_COTIZACIONES, min_justificacion: MIN_JUSTIFICACION });
  }));

  api.post('/proyectos/:id/documento-equivalente', responder(async (req, res) => {
    const p = await proyectoDe(req.params.id, req.usuario.id);
    if (!p) throw error(404, 'Proyecto no encontrado');
    const nivel = String(req.body?.nivel || '');
    if (!NIVELES.includes(nivel)) throw error(400, 'Elige el nivel de la IOARR: Inicial, Primaria, Secundaria o Básica Especial (un documento por nivel)');
    const niveles = await expediente.ioarrsBases(p);
    if (!niveles.some(x => x.nivel === nivel)) throw error(400, 'El proyecto no tiene una IOARR de ese nivel');
    const pre = await precargaDe(p, nivel);
    const datos = limpiarFicha({ ...pre.datos, _precarga: pre.datos, _precarga_notas: pre.notas });
    const nombre = String(req.body?.nombre || '').trim().slice(0, 200) || `Documento equivalente ${niveles.find(x => x.nivel === nivel).nombre}`;
    const f = ok(await supabase.from(TABLA).insert({ id: randomUUID(), proyecto_id: p.id, nivel, nombre, datos, creado_por: req.usuario.id }).select('*').single());
    res.status(201).json(await vista(f, p, { app: pre }));
  }));

  // ─── Una ficha ────────────────────────────────────────────────────────────
  api.get('/documento-equivalente/:fid', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    res.json(await vista(f, p));
  }));

  api.patch('/documento-equivalente/:fid', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    const cambios = {}, actual = limpiarFicha(f.datos);
    let quitados = [];
    if (req.body?.datos && typeof req.body.datos === 'object') {
      const { _precarga, _precarga_notas, ...nuevos } = req.body.datos;   // lo precargado solo lo cambia el servidor
      if ('cotizaciones' in nuevos) nuevos.cotizaciones = fusionarCotizaciones(actual.cotizaciones, nuevos.cotizaciones);
      cambios.datos = limpiarFicha({ ...actual, ...nuevos, _precarga: actual._precarga, _precarga_notas: actual._precarga_notas });
      // Cotizaciones quitadas: su PDF también se borra
      const quedan = new Set(cambios.datos.cotizaciones.map(c => c.id));
      quitados = actual.cotizaciones.filter(c => !quedan.has(c.id));
    }
    if ('nombre' in (req.body || {})) {
      cambios.nombre = String(req.body.nombre || '').trim().slice(0, 200);
      if (!cambios.nombre) throw error(400, 'El nombre no puede quedar vacío');
    }
    const g = ok(await supabase.from(TABLA).update(cambios).eq('id', f.id).select('*').single());
    await quitarArchivos(rutasDe(quitados));
    res.json(await vista(g, p));
  }));

  // Vuelve a tomar de la app: solo llena lo vacío (no pisa lo que escribió el usuario)
  api.post('/documento-equivalente/:fid/precargar', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    const pre = await precargaDe(p, f.nivel), actual = limpiarFicha(f.datos), llenados = [];
    const datos = { ...actual };
    for (const [k, v] of Object.entries(pre.datos)) if (actual[k] == null || actual[k] === '') { datos[k] = v; llenados.push(k); }
    datos._precarga = { ...actual._precarga, ...Object.fromEntries(llenados.map(k => [k, pre.datos[k]])) };
    datos._precarga_notas = { ...actual._precarga_notas, ...Object.fromEntries(llenados.map(k => [k, pre.notas[k]])) };
    const g = ok(await supabase.from(TABLA).update({ datos: limpiarFicha(datos) }).eq('id', f.id).select('*').single());
    res.json(await vista(g, p, { app: pre, respuesta: { llenados } }));
  }));

  api.delete('/documento-equivalente/:fid', responder(async (req, res) => {
    const { f } = await fichaDe(req);
    ok(await supabase.from(TABLA).delete().eq('id', f.id));
    await quitarArchivos(rutasDe(limpiarFicha(f.datos).cotizaciones));
    res.json({ ok: true });
  }));

  // ─── PDF de una cotización ────────────────────────────────────────────────
  const cotizacionDe = (f, cid) => {
    const d = limpiarFicha(f.datos), c = d.cotizaciones.find(x => x.id === cid);
    if (!c) throw error(404, 'Cotización no encontrada: guarda la cotización antes de adjuntar su PDF');
    return { d, c };
  };
  async function guardarCotizacion(f, d, c, cambios) {
    const datos = limpiarFicha({ ...d, cotizaciones: d.cotizaciones.map(x => x.id === c.id ? { ...x, ...cambios } : x) });
    return ok(await supabase.from(TABLA).update({ datos }).eq('id', f.id).select('*').single());
  }
  api.post('/documento-equivalente/:fid/cotizaciones/:cid/archivo', recibir, responder(async (req, res) => {
    const { f, p } = await fichaDe(req), { d, c } = cotizacionDe(f, req.params.cid), a = req.file;
    if (!a) throw error(400, 'Elige el PDF de la cotización');
    if (mimeDe(a.buffer) !== 'application/pdf') throw error(400, 'Solo se acepta PDF');
    const nombre = nombreUtf8(a.originalname || 'cotizacion.pdf').slice(-200);
    const ruta = `de/${f.id}/${c.id}/${Date.now()}_${nombreSeguro(nombre)}`;
    const { error: eUp } = await supabase.storage.from(BUCKET_EXPEDIENTE).upload(ruta, a.buffer, { contentType: 'application/pdf' });
    if (eUp) throw error(500, 'No se pudo guardar el PDF: ' + eUp.message);
    const g = await guardarCotizacion(f, d, c, { archivo_ruta: ruta, archivo_nombre: nombre });
    if (c.archivo_ruta) await quitarArchivos([c.archivo_ruta]);
    res.status(201).json(await vista(g, p));
  }));
  api.get('/documento-equivalente/:fid/cotizaciones/:cid/archivo', responder(async (req, res) => {
    const { f } = await fichaDe(req), { c } = cotizacionDe(f, req.params.cid);
    if (!c.archivo_ruta) throw error(404, 'Esta cotización no tiene PDF');
    const { data, error: e } = await supabase.storage.from(BUCKET_EXPEDIENTE).createSignedUrl(c.archivo_ruta, 600, { download: c.archivo_nombre });
    if (e) throw error(500, 'No se pudo abrir el PDF: ' + e.message);
    res.json({ url: data.signedUrl });
  }));
  api.delete('/documento-equivalente/:fid/cotizaciones/:cid/archivo', responder(async (req, res) => {
    const { f, p } = await fichaDe(req), { d, c } = cotizacionDe(f, req.params.cid);
    const g = await guardarCotizacion(f, d, c, { archivo_ruta: null, archivo_nombre: null });
    if (c.archivo_ruta) await quitarArchivos([c.archivo_ruta]);
    res.json(await vista(g, p));
  }));

  // ─── Word ─────────────────────────────────────────────────────────────────
  const enviarWord = (res, buf, archivo, cabeceras = {}) => res.set({
    'Content-Type': WORD, 'Cache-Control': 'no-store', ...cabeceras,
    'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`
  }).send(buf);
  const nombreArchivo = (d, f, v, fecha) => `Documento_equivalente_${slug(d.CUI || f.nombre)}_${f.nivel}_${v ? 'v' + v : 'VISTA_PREVIA'}_${fecha}.docx`;

  api.get('/documento-equivalente/:fid/vista-previa', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    const d = limpiarFicha(f.datos), { ctx } = await appDe(p, f.nivel), fecha = hoyLima();
    enviarWord(res, await generarDocumentoEquivalenteDocx({ datos: d, ctx, vistaPrevia: true, fecha, hoy: fecha }), nombreArchivo(d, f, null, fecha));
  }));

  api.post('/documento-equivalente/:fid/exportar', responder(async (req, res) => {
    const { f, p } = await fichaDe(req);
    const d = limpiarFicha(f.datos), { ctx } = await appDe(p, f.nivel), fecha = hoyLima();
    const V = validarFicha(d, ctx, { hoy: fecha });
    if (!V.ok) throw Object.assign(error(422, `No se puede exportar: ${V.errores.length} ${V.errores.length === 1 ? 'problema' : 'problemas'} por resolver`), { extra: { errores: V.errores } });
    const previas = ok(await supabase.from(VERSIONES).select('version').eq('ficha_id', f.id));
    const version = Math.max(0, ...previas.map(v => v.version)) + 1, usuario = req.usuario.email || '';
    const buf = await generarDocumentoEquivalenteDocx({ datos: d, ctx, version, fecha, usuario, hoy: fecha });
    const archivo = nombreArchivo(d, f, version, fecha);
    ok(await supabase.from(VERSIONES).insert({
      ficha_id: f.id, version, datos: d, contexto: ctx, plantillas_hash: HASH_PLANTILLAS, archivo,
      resumen: { total: V.presupuesto.total, resumen: V.presupuesto.resumen, advertencias: V.advertencias.map(a => a.texto) }, usuario_id: req.usuario.id, usuario_email: usuario || null
    }));
    enviarWord(res, buf, archivo, { 'X-DE-Version': String(version) });
  }));

  api.get('/documento-equivalente/:fid/versiones', responder(async (req, res) => {
    const { f } = await fichaDe(req);
    const vs = ok(await supabase.from(VERSIONES).select('version, creado_en, usuario_email, archivo, plantillas_hash, resumen').eq('ficha_id', f.id).order('version', { ascending: false }));
    res.json(vs.map(v => ({ version: v.version, fecha: v.creado_en, usuario: v.usuario_email, archivo: v.archivo, total: v.resumen?.total ?? null, plantillas_cambiaron: v.plantillas_hash !== HASH_PLANTILLAS })));
  }));

  api.get('/documento-equivalente/:fid/versiones/:v/docx', responder(async (req, res) => {
    const { f } = await fichaDe(req);
    const v = ok(await supabase.from(VERSIONES).select('*').eq('ficha_id', f.id).eq('version', Number(req.params.v)).maybeSingle());
    if (!v) throw error(404, `No existe la versión ${req.params.v}`);
    const fecha = hoyLima(new Date(v.creado_en));
    // Se regenera con la fecha de esa versión (la vigencia de las cotizaciones se mide a esa fecha)
    const buf = await generarDocumentoEquivalenteDocx({ datos: limpiarFicha(v.datos), ctx: v.contexto || {}, version: v.version, fecha, usuario: v.usuario_email || '', hoy: fecha });
    enviarWord(res, buf, v.archivo, v.plantillas_hash !== HASH_PLANTILLAS ? { 'X-Plantillas-Cambiaron': '1' } : {});
  }));

  return api;
}
