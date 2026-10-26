// ============================================================================
// src/selector-ioarr/catalogo-ref-api.js — API del catálogo de precios referenciales
//
// Se monta dentro de /api/selector-ioarr (router.js): sesión y rol proveedor.
// El catálogo es compartido entre proveedores; la elección de referencia, por proyecto.
// Tablas: supabase/migrations/029_ioarr_catalogo_precios_ref.sql
//
//   GET    /precios-ref                    registros (con el precio por kit sin IGV), estadísticos y posición del propio
//                                          ?atipicos=1 incluye los atípicos por volumen; ?comparar=0 sin llevar al año base;
//                                          ?anio_base=2025
//   POST   /precios-ref                    alta manual (validada)
//   PATCH  /precios-ref/:id                cambios (se valida el registro completo)
//   DELETE /precios-ref/:id                (borra también su PDF)
//   POST   /precios-ref/:id/archivo        multipart «archivo»: el PDF fuente
//   GET    /precios-ref/:id/archivo        URL firmada de 10 minutos
//   DELETE /precios-ref/:id/archivo
//   GET    /precios-ref/plantilla.csv      plantilla para importar
//   POST   /precios-ref/importar           multipart «archivo» (CSV), ?confirmar=1 para guardar.
//                                          Con una sola fila con errores no se importa nada.
//   GET    /precios-ref/factores           factores de actualización (año de origen → año base)
//   PUT    /precios-ref/factores           { anio_origen, anio_base?, factor, fuente_indice?, fecha? } alta o cambio
//   DELETE /precios-ref/factores/:id       (vuelve a 1.00)
//   GET    /proyectos/:id/precios-ref      por IOARR: referencia elegida, monto del convenio estimado y riesgo del precio propio
//   PUT    /proyectos/:id/precios-ref      { modo: 'defecto'|'mediana'|'registro', registro_id?, material, incluir_atipicos?, comparar_anio_base?, anio_base? }
//
// El precio propio es de uso interno: solo lo ven estas rutas (no sale en ningún exportable).
// ============================================================================

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { supabase } from '../ioarr/db.js';
import { BUCKET_EXPEDIENTE, mimeDe, nombreUtf8, nombreSeguro } from './archivos.js';
import {
  limpiarRegistro, normalizar, enriquecer, estadisticos, posicion, referencia, estimarConvenio, riesgo, validarCsv, plantillaCsv, opcionesDe, opcionesSel, avisoVolumen,
  TIPOS_DOC, NIVELES, UNIDADES, MATERIALES, CONFIANZAS, COMPONENTES, SUPERVISION_JUNTA, MIN_FUENTES, RANGO_MIN, RANGO_MAX, IGV, NIVEL_DE,
  GRADOS, ESTADOS, TIPOS_FUENTE, UMBRAL_ATIPICO, RATIO_VOLUMEN, ANIO_BASE, REFERENCIA_DEFECTO
} from './catalogo-ref.js';

export const AVISO_REF = 'Faltan migraciones del catálogo de precios referenciales en Supabase (029 a 037: supabase/migrations/)';
export const AVISO_FACTORES = 'Falta ejecutar supabase/migrations/037_ioarr_precios_ref_fuentes.sql en Supabase para guardar factores de actualización';
export const SELECCION_DEF = { modo: 'defecto', registro_id: null, material: 'todos', incluir_atipicos: false, comparar_anio_base: true, anio_base: ANIO_BASE };
/** Factor de actualización válido (el que escribe el usuario: no se inventan índices) */
export function limpiarFactor(b = {}) {
  const errores = [], ent = v => v === '' || v == null ? null : Number(v);
  const anio_origen = ent(b.anio_origen), anio_base = ent(b.anio_base) ?? ANIO_BASE, factor = ent(b.factor) ?? 1;
  if (!Number.isInteger(anio_origen) || anio_origen < 2000 || anio_origen > 2100) errores.push('Año de origen no válido');
  if (!Number.isInteger(anio_base) || anio_base < 2000 || anio_base > 2100) errores.push('Año base no válido');
  if (!Number.isFinite(factor) || factor <= 0 || factor > 10) errores.push('Factor no válido (mayor que 0, hasta 10)');
  const fuente_indice = String(b.fuente_indice ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || '')) ? b.fecha : null;
  if (b.fecha && !fecha) errores.push('Fecha no válida (AAAA-MM-DD)');
  // Un factor distinto de 1.00 tiene que decir de dónde sale
  if (Number.isFinite(factor) && factor !== 1 && (!fuente_indice || !fecha)) errores.push('Un factor distinto de 1.00 necesita la fuente del índice y su fecha');
  return { f: errores.length ? null : { anio_origen, anio_base, factor: Math.round(factor * 10000) / 10000, fuente_indice, fecha }, errores };
}
const faltaMigracion = e => e?.code === 'PGRST204' || e?.code === 'PGRST205' || e?.code === '42P01' || /schema cache|does not exist/i.test(e?.message || '');
const esUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));
const error = (status, msg, extra) => Object.assign(new Error(msg), { status, extra });
const MAX_PDF = 15 * 1024 * 1024, MAX_CSV = 2 * 1024 * 1024;
const subida = (max) => multer({ storage: multer.memoryStorage(), limits: { fileSize: max, files: 1 } });
const num = v => v == null ? null : Number(v);
// numeric de Postgres llega como texto. La ruta del PDF y quién lo creó no salen al navegador.
// Sin la 037, los campos nuevos quedan con su valor por defecto.
const deFila = ({ archivo_ruta: _r, creado_por: _c, ...f }) => ({ ...f, monto: num(f.monto), monto_hasta: num(f.monto_hasta), flete_transporte: num(f.flete_transporte), monto_alternativo: num(f.monto_alternativo),
  composicion: f.composicion || [], tiene_archivo: !!f.archivo_nombre, fuente: f.fuente ?? null, grado: f.grado ?? null, volumen_kits: f.volumen_kits ?? null, anio_precio: f.anio_precio ?? null,
  estado: f.estado || 'vigente', tipo: f.tipo || (f.tipo_documento === 'propio' ? 'propio' : f.tipo_documento === 'estimado_derivado' ? 'derivado' : 'publicado') });

/**
 * Referencia, estimación y riesgo de cada IOARR del proyecto.
 * Lo usan esta API y el generador de bases (sin el precio propio).
 */
export function referenciasProyecto(registros, costos, sel, factores = []) {
  const propio = enriquecer(registros, opcionesSel(sel, factores)).find(x => x.propio && x.comparable) || null;
  return costos.map(c => {
    const ref = referencia(registros, { nivel: c.nivel, sel, kits: c.kits || null, factores });
    const avisos = [...ref.avisos];
    if (!c.kit) avisos.push('Activa «kit» en Costos para estimar con el precio por kit.');
    const estRef = c.kit ? estimarConvenio(c, ref.precio) : null, estPropio = c.kit && propio ? estimarConvenio(c, propio.precio_cmp) : null;
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

  const leerTodos = async () => ok(await supabase.from('ioarr_precios_ref').select('*').order('anio', { ascending: false })).map(deFila);
  // Sin la 037 no hay factores: todos valen 1.00
  async function leerFactores() {
    const { data, error: e } = await supabase.from('ioarr_factores_actualizacion').select('id, anio_origen, anio_base, factor, fuente_indice, fecha').order('anio_origen');
    if (e) { if (faltaMigracion(e)) return []; throw e; }
    return (data || []).map(f => ({ ...f, factor: Number(f.factor) }));
  }
  const opcionesQuery = (q, factores) => opcionesDe({ factores, anioBase: q.anio_base ? Number(q.anio_base) : ANIO_BASE, comparar: q.comparar !== '0', atipicos: q.atipicos === '1' });
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

  api.get('/precios-ref', responder(async (req, res) => {
    const [registros, factores] = await Promise.all([leerTodos(), leerFactores()]);
    const O = opcionesQuery(req.query || {}, factores);
    const est = estadisticos(registros, O), xs = enriquecer(registros, O);
    const propio = xs.find(x => x.propio && x.comparable) || null;
    res.json({
      registros: xs,
      estadisticos: est.map(g => ({ ...g, propio: propio ? posicion(propio.precio_cmp, g) : null })),
      propio: propio ? { id: propio.id, precio_kit_sin_igv: propio.precio_kit_sin_igv, precio_cmp: propio.precio_cmp } : null,
      factores, comparacion: { anio_base: O.anioBase, comparar: O.comparar, atipicos: O.atipicos },
      opciones: { tipos: TIPOS_DOC, niveles: NIVELES, unidades: UNIDADES, materiales: MATERIALES, confianzas: CONFIANZAS, grados: GRADOS, estados: ESTADOS, tipos_fuente: TIPOS_FUENTE },
      componentes: COMPONENTES, supervision_junta: SUPERVISION_JUNTA, min_fuentes: MIN_FUENTES, igv: IGV,
      umbral_atipico: UMBRAL_ATIPICO, ratio_volumen: RATIO_VOLUMEN, referencia_defecto: REFERENCIA_DEFECTO
    });
  }));

  // ─── Factores de actualización ────────────────────────────────────────────
  api.get('/precios-ref/factores', responder(async (_, res) => res.json({ factores: await leerFactores(), anio_base: ANIO_BASE })));
  api.put('/precios-ref/factores', responder(async (req, res) => {
    const { f, errores } = limpiarFactor(req.body || {});
    if (!f) throw error(400, errores[0], { errores });
    const { error: e } = await supabase.from('ioarr_factores_actualizacion').upsert({ ...f, creado_por: req.usuario.id }, { onConflict: 'anio_origen,anio_base' });
    if (e) { if (faltaMigracion(e)) throw error(503, AVISO_FACTORES); throw e; }
    res.json({ factores: await leerFactores() });
  }));
  api.delete('/precios-ref/factores/:id', responder(async (req, res) => {
    if (!esUuid(req.params.id)) throw error(404, 'Factor no encontrado');
    const { error: e } = await supabase.from('ioarr_factores_actualizacion').delete().eq('id', req.params.id);
    if (e) { if (faltaMigracion(e)) throw error(503, AVISO_FACTORES); throw e; }
    res.json({ factores: await leerFactores() });
  }));

  api.post('/precios-ref', responder(async (req, res) => {
    const { r, errores } = limpiarRegistro(req.body || {});
    if (!r) throw error(400, errores[0], { errores });
    const f = ok(await supabase.from('ioarr_precios_ref').insert({ id: randomUUID(), ...r, creado_por: req.usuario.id }).select('*').single());
    res.status(201).json({ ...deFila(f), ...normalizar(deFila(f)) });
  }));

  api.patch('/precios-ref/:id', responder(async (req, res) => {
    const actual = deFila(await uno(req.params.id));
    const { id: _, archivo_ruta: _r, archivo_nombre: _n, creado_por: _c, formula: _f, monto_alternativo: _m, ...cambios } = req.body || {};   // fórmula y alternativo los calcula el servidor
    const { r, errores } = limpiarRegistro({ ...actual, ...cambios });
    if (!r) throw error(400, errores[0], { errores });
    const f = ok(await supabase.from('ioarr_precios_ref').update(r).eq('id', actual.id).select('*').single());
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
    let r = await supabase.from('ioarr_precios_ref_proyecto').select('modo, registro_id, material, incluir_atipicos, comparar_anio_base, anio_base').eq('proyecto_id', p.id).maybeSingle();
    // Sin la 037: solo lo de antes (las opciones nuevas, por defecto)
    if (r.error && faltaMigracion(r.error)) r = await supabase.from('ioarr_precios_ref_proyecto').select('modo, registro_id, material').eq('proyecto_id', p.id).maybeSingle();
    if (r.error) throw r.error;
    const sel = { ...SELECCION_DEF, ...(r.data || {}) };
    // Con material de la propuesta (Costos), la referencia es de ese material
    const mp = await expediente.materialPropuesta?.(p);
    return mp ? { ...sel, material: mp, material_propuesta: mp } : sel;
  }
  const vistaProyecto = async p => {
    const [registros, costos, sel, factores] = await Promise.all([leerTodos(), expediente.costosPorNivel(p), seleccion(p), leerFactores()]);
    const ioarrs = referenciasProyecto(registros, costos, sel, factores);
    // Por registro: aviso de volumen frente a cada IOARR del proyecto (para la tabla)
    const volumen = Object.fromEntries(registros.map(r => [r.id, costos.map(c => avisoVolumen(r, c.kits)).filter(Boolean)]).filter(([, v]) => v.length));
    return { seleccion: sel, ioarrs, volumen, rango: { min: RANGO_MIN, max: RANGO_MAX }, niveles: NIVEL_DE, referencia_defecto: REFERENCIA_DEFECTO };
  };
  api.get('/proyectos/:id/precios-ref', responder(async (req, res) => res.json(await vistaProyecto(await proyecto(req)))));
  api.put('/proyectos/:id/precios-ref', responder(async (req, res) => {
    const p = await proyecto(req), b = req.body || {};
    const modo = ['registro', 'mediana', 'defecto'].includes(b.modo) ? b.modo : 'defecto';
    const material = ['todos', ...Object.keys(MATERIALES)].includes(b.material) ? b.material : 'todos';
    let registro_id = null;
    if (modo === 'registro') {
      const r = deFila(await uno(b.registro_id));
      if (normalizar(r).propio) throw error(400, 'El precio propio no puede ser la referencia');
      if (!normalizar(r).comparable) throw error(400, 'Esa fuente no es comparable: ' + normalizar(r).motivo);
      if (material !== 'todos' && r.material !== material) throw error(400, `Esa fuente es de ${MATERIALES[r.material].toLowerCase()}, no de ${MATERIALES[material].toLowerCase()}`);
      registro_id = r.id;
    }
    const anio = Number(b.anio_base);
    const opciones = { incluir_atipicos: b.incluir_atipicos === true, comparar_anio_base: b.comparar_anio_base !== false, anio_base: Number.isInteger(anio) && anio >= 2000 && anio <= 2100 ? anio : ANIO_BASE };
    const fila = { proyecto_id: p.id, modo, registro_id, material, ...opciones, actualizado_en: new Date().toISOString() };
    const { error: e } = await supabase.from('ioarr_precios_ref_proyecto').upsert(fila, { onConflict: 'proyecto_id' });
    // Sin la 037 no se guardan el modo «defecto» ni las opciones nuevas
    if (e) { if (faltaMigracion(e) || e.code === '23514') throw error(503, AVISO_REF); throw e; }
    res.json(await vistaProyecto(p));
  }));

  // Para el generador de bases: la referencia del nivel (sin el precio propio). null si falta la migración.
  api.referenciaBases = async (p, nivel) => {
    try {
      const [registros, sel, factores] = await Promise.all([leerTodos(), seleccion(p), leerFactores()]);
      const r = referencia(registros, { nivel, sel, factores });
      return { precio: r.precio, n: r.n, modo: r.modo, material: sel.material, fuente: r.fuente, avisos: r.avisos };
    } catch (e) { if (faltaMigracion(e)) return null; throw e; }
  };
  return api;
}
