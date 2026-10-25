// ============================================================================
// src/selector-ioarr/catalogo-ref-api.js — API del catálogo de precios referenciales
//
// Se monta dentro de /api/selector-ioarr (router.js): sesión y rol proveedor.
// El catálogo es compartido entre proveedores; la elección de referencia, por proyecto.
// Tablas: supabase/migrations/029_ioarr_catalogo_precios_ref.sql
//
//   GET    /precios-ref                    registros (con el precio por kit sin IGV), estadísticos y posición del propio
//   POST   /precios-ref                    alta manual (validada)
//   PATCH  /precios-ref/:id                cambios (se valida el registro completo)
//   DELETE /precios-ref/:id                (borra también su PDF)
//   POST   /precios-ref/:id/archivo        multipart «archivo»: el PDF fuente
//   GET    /precios-ref/:id/archivo        URL firmada de 10 minutos
//   DELETE /precios-ref/:id/archivo
//   GET    /precios-ref/plantilla.csv      plantilla para importar
//   POST   /precios-ref/importar           multipart «archivo» (CSV), ?confirmar=1 para guardar.
//                                          Con una sola fila con errores no se importa nada.
//   GET    /proyectos/:id/precios-ref      por IOARR: referencia elegida, monto del convenio estimado y riesgo del precio propio
//   PUT    /proyectos/:id/precios-ref      { modo: 'mediana'|'registro', registro_id?, material }
//
// El precio propio es de uso interno: solo lo ven estas rutas (no sale en ningún exportable).
// ============================================================================

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { supabase } from '../ioarr/db.js';
import { BUCKET_EXPEDIENTE, mimeDe, nombreUtf8, nombreSeguro } from './archivos.js';
import {
  limpiarRegistro, normalizar, estadisticos, posicion, referencia, estimarConvenio, riesgo, validarCsv, plantillaCsv,
  TIPOS_DOC, NIVELES, UNIDADES, MATERIALES, CONFIANZAS, MIN_FUENTES, RANGO_MIN, RANGO_MAX, IGV, NIVEL_DE
} from './catalogo-ref.js';

export const AVISO_REF = 'Falta ejecutar supabase/migrations/029_ioarr_catalogo_precios_ref.sql en Supabase para el catálogo de precios referenciales';
const faltaMigracion = e => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
const esUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));
const error = (status, msg, extra) => Object.assign(new Error(msg), { status, extra });
const MAX_PDF = 15 * 1024 * 1024, MAX_CSV = 2 * 1024 * 1024;
const subida = (max) => multer({ storage: multer.memoryStorage(), limits: { fileSize: max, files: 1 } });
const COLS = 'id, tipo_documento, cui, entidad, region, anio, url, archivo_nombre, nivel, unidad, material, monto, monto_hasta, incluye_igv, cotizaciones, composicion, flete_transporte, confianza, notas, creado_en, actualizado_en';
const num = v => v == null ? null : Number(v);
// numeric de Postgres llega como texto
const deFila = f => ({ ...f, monto: num(f.monto), monto_hasta: num(f.monto_hasta), flete_transporte: num(f.flete_transporte), composicion: f.composicion || [], tiene_archivo: !!f.archivo_nombre });

/**
 * Referencia, estimación y riesgo de cada IOARR del proyecto.
 * Lo usan esta API y el generador de bases (sin el precio propio).
 */
export function referenciasProyecto(registros, costos, sel) {
  const propio = registros.map(r => ({ ...r, ...normalizar(r) })).find(x => x.propio && x.comparable) || null;
  return costos.map(c => {
    const ref = referencia(registros, { nivel: c.nivel, sel });
    const avisos = [...ref.avisos];
    if (!c.kit) avisos.push('Activa «kit» en Costos para estimar con el precio por kit.');
    const estRef = c.kit ? estimarConvenio(c, ref.precio) : null, estPropio = c.kit && propio ? estimarConvenio(c, propio.precio_kit_sin_igv) : null;
    return { nivel: c.nivel, nombre: c.nombre, kits: c.kits, referencia: ref, estimado: estRef, propio: estPropio, riesgo: riesgo(estRef, estPropio), avisos,
      actual: { convenio: Math.round((c.T.doc + c.T.cdIgv + c.T.sup) * 100) / 100, total: c.T.total } };
  });
}

export function crearApiPreciosRef({ expediente, proyectoDelUsuario }) {
  const api = express.Router();
  const responder = fn => async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) {
      if (faltaMigracion(e)) return res.status(503).json({ error: AVISO_REF });
      if (e.status) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
      next(e);
    }
  };
  const ok = ({ data, error: e }) => { if (e) throw e; return data; };
  const recibir = (max, nombre) => (req, res, next) => subida(max).single('archivo')(req, res, err => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `El ${nombre} pasa de ${max / 1024 / 1024} MB` : 'No se pudo recibir el archivo: ' + err.message });
  });

  const leerTodos = async () => ok(await supabase.from('ioarr_precios_ref').select(COLS).order('anio', { ascending: false })).map(deFila);
  async function uno(id) {
    if (!esUuid(id)) throw error(404, 'Registro no encontrado');
    const r = ok(await supabase.from('ioarr_precios_ref').select('*').eq('id', id).maybeSingle());
    if (!r) throw error(404, 'Registro no encontrado');
    return r;
  }

  // ─── Catálogo ─────────────────────────────────────────────────────────────
  api.get('/precios-ref/plantilla.csv', (_, res) => res.set({
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="plantilla_precios_referenciales.csv"', 'Cache-Control': 'no-store'
  }).send(plantillaCsv()));

  api.get('/precios-ref', responder(async (_, res) => {
    const registros = await leerTodos();
    const est = estadisticos(registros);
    const propio = registros.map(r => ({ ...r, ...normalizar(r) })).find(x => x.propio && x.comparable) || null;
    res.json({
      registros: registros.map(r => ({ ...r, ...normalizar(r) })),
      estadisticos: est.map(g => ({ ...g, propio: propio ? posicion(propio.precio_kit_sin_igv, g) : null })),
      propio: propio ? { id: propio.id, precio_kit_sin_igv: propio.precio_kit_sin_igv } : null,
      opciones: { tipos: TIPOS_DOC, niveles: NIVELES, unidades: UNIDADES, materiales: MATERIALES, confianzas: CONFIANZAS },
      min_fuentes: MIN_FUENTES, igv: IGV
    });
  }));

  api.post('/precios-ref', responder(async (req, res) => {
    const { r, errores } = limpiarRegistro(req.body || {});
    if (!r) throw error(400, errores[0], { errores });
    const f = ok(await supabase.from('ioarr_precios_ref').insert({ id: randomUUID(), ...r, creado_por: req.usuario.id }).select(COLS).single());
    res.status(201).json({ ...deFila(f), ...normalizar(deFila(f)) });
  }));

  api.patch('/precios-ref/:id', responder(async (req, res) => {
    const actual = deFila(await uno(req.params.id));
    const { id: _, archivo_ruta: _r, archivo_nombre: _n, creado_por: _c, ...cambios } = req.body || {};
    const { r, errores } = limpiarRegistro({ ...actual, ...cambios });
    if (!r) throw error(400, errores[0], { errores });
    const f = ok(await supabase.from('ioarr_precios_ref').update(r).eq('id', actual.id).select(COLS).single());
    res.json({ ...deFila(f), ...normalizar(deFila(f)) });
  }));

  api.delete('/precios-ref/:id', responder(async (req, res) => {
    const r = await uno(req.params.id);
    if (r.archivo_ruta) await supabase.storage.from(BUCKET_EXPEDIENTE).remove([r.archivo_ruta]);
    ok(await supabase.from('ioarr_precios_ref').delete().eq('id', r.id));
    res.json({ ok: true });
  }));

  // ─── PDF fuente ───────────────────────────────────────────────────────────
  api.post('/precios-ref/:id/archivo', recibir(MAX_PDF, 'PDF'), responder(async (req, res) => {
    const r = await uno(req.params.id), a = req.file;
    if (!a) throw error(400, 'Elige el PDF fuente');
    if (mimeDe(a.buffer) !== 'application/pdf') throw error(400, 'Solo se acepta PDF');
    const nombre = nombreUtf8(a.originalname || 'fuente.pdf').slice(-200);
    const ruta = `catalogo-ref/${r.id}/${Date.now()}_${nombreSeguro(nombre)}`;
    const { error: eUp } = await supabase.storage.from(BUCKET_EXPEDIENTE).upload(ruta, a.buffer, { contentType: 'application/pdf' });
    if (eUp) throw error(500, 'No se pudo guardar el PDF: ' + eUp.message);
    ok(await supabase.from('ioarr_precios_ref').update({ archivo_ruta: ruta, archivo_nombre: nombre }).eq('id', r.id));
    if (r.archivo_ruta) await supabase.storage.from(BUCKET_EXPEDIENTE).remove([r.archivo_ruta]);
    res.status(201).json({ archivo_nombre: nombre });
  }));
  api.get('/precios-ref/:id/archivo', responder(async (req, res) => {
    const r = await uno(req.params.id);
    if (!r.archivo_ruta) throw error(404, 'Este registro no tiene PDF');
    const { data, error: e } = await supabase.storage.from(BUCKET_EXPEDIENTE).createSignedUrl(r.archivo_ruta, 600, { download: r.archivo_nombre });
    if (e) throw e;
    res.json({ url: data.signedUrl });
  }));
  api.delete('/precios-ref/:id/archivo', responder(async (req, res) => {
    const r = await uno(req.params.id);
    if (r.archivo_ruta) await supabase.storage.from(BUCKET_EXPEDIENTE).remove([r.archivo_ruta]);
    ok(await supabase.from('ioarr_precios_ref').update({ archivo_ruta: null, archivo_nombre: null }).eq('id', r.id));
    res.json({ ok: true });
  }));

  // ─── Importar CSV ─────────────────────────────────────────────────────────
  api.post('/precios-ref/importar', recibir(MAX_CSV, 'CSV'), responder(async (req, res) => {
    if (!req.file) throw error(400, 'Elige el archivo CSV');
    const v = validarCsv(req.file.buffer.toString('utf8'), await leerTodos());
    if (!v.ok || req.query.confirmar !== '1') return res.status(v.ok ? 200 : 422).json({ ...v, importados: 0 });
    ok(await supabase.from('ioarr_precios_ref').insert(v.registros.map(r => ({ id: randomUUID(), ...r, creado_por: req.usuario.id }))));
    res.status(201).json({ ...v, importados: v.registros.length });
  }));

  // ─── Proyecto: referencia elegida, estimación y riesgo ────────────────────
  async function proyecto(req) {
    const p = await proyectoDelUsuario(req);
    if (!p) throw error(404, 'Proyecto no encontrado');
    return p;
  }
  async function seleccion(p) {
    const r = await supabase.from('ioarr_precios_ref_proyecto').select('modo, registro_id, material').eq('proyecto_id', p.id).maybeSingle();
    if (r.error) throw r.error;
    return r.data || { modo: 'mediana', registro_id: null, material: 'todos' };
  }
  const vistaProyecto = async p => {
    const [registros, costos, sel] = await Promise.all([leerTodos(), expediente.costosPorNivel(p), seleccion(p)]);
    return { seleccion: sel, ioarrs: referenciasProyecto(registros, costos, sel), rango: { min: RANGO_MIN, max: RANGO_MAX }, niveles: NIVEL_DE };
  };
  api.get('/proyectos/:id/precios-ref', responder(async (req, res) => res.json(await vistaProyecto(await proyecto(req)))));
  api.put('/proyectos/:id/precios-ref', responder(async (req, res) => {
    const p = await proyecto(req), b = req.body || {};
    const modo = b.modo === 'registro' ? 'registro' : 'mediana';
    const material = ['todos', ...Object.keys(MATERIALES)].includes(b.material) ? b.material : 'todos';
    let registro_id = null;
    if (modo === 'registro') {
      const r = deFila(await uno(b.registro_id));
      if (r.tipo_documento === 'propio') throw error(400, 'El precio propio no puede ser la referencia');
      if (!normalizar(r).comparable) throw error(400, 'Esa fuente no es comparable: ' + normalizar(r).motivo);
      registro_id = r.id;
    }
    ok(await supabase.from('ioarr_precios_ref_proyecto').upsert({ proyecto_id: p.id, modo, registro_id, material, actualizado_en: new Date().toISOString() }, { onConflict: 'proyecto_id' }));
    res.json(await vistaProyecto(p));
  }));

  // Para el generador de bases: la referencia del nivel (sin el precio propio). null si falta la migración.
  api.referenciaBases = async (p, nivel) => {
    try {
      const [registros, sel] = await Promise.all([leerTodos(), seleccion(p)]);
      const r = referencia(registros, { nivel, sel });
      return { precio: r.precio, n: r.n, modo: r.modo, material: sel.material, fuente: r.fuente, avisos: r.avisos };
    } catch (e) { if (faltaMigracion(e)) return null; throw e; }
  };
  return api;
}
